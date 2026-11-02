/**
 * supervisor 的验收用例。
 *
 * 四个数字各验一条：
 *   fastPathBlocked   —— Fast Path 真的在拦（没花模型的钱）
 *   routerDecisions   —— 只有新 Thread 才过 Router
 *   directDeliveries  —— 同一 Thread 的后续事件直通，Router 决策数不涨
 *   workersSpawned    —— 两个不同 Thread 派两个 Worker
 *
 * 第四条是全篇中心论点的微缩版：**去直通（方案 C）后 routerDecisions 应该显著增加**。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import type { Trigger } from '../src/model.ts'
import type { RouterDecision, RouterSession, TriggerSource, WorkerSession } from '../src/supervisor.ts'
import { runSupervisor, type RunStats } from '../src/supervisor.ts'

/** 每个 tick 只吐一条事件的源。 */
function queued(events: readonly Trigger[]): TriggerSource {
  let index = 0
  return {
    name: 'queued',
    poll: () => Promise.resolve(index < events.length ? [events[index++] as Trigger] : []),
  }
}

const RULES = {
  ignoredActors: ['bot-itself'],
  alwaysRespondActors: ['owner'],
  bySource: { 'ci:result': 'ignore' as const },
}

/** 一个 Trigger 的工厂。 */
const trig = (id: string, threadKey: string, payload: string, actor = 'someone'): Trigger => ({
  id,
  source: 'feishu',
  threadKey,
  kind: 'message',
  payload,
  at: '2026-11-01T10:00:00Z',
  actor,
})

/** 每次 Router 调用带了几条候选——批处理的证据。 */
let batchedContexts: number[] = []
let routerCalls = 0

/**
 * 一次完整跑。
 *
 * @param triggers - 事件。
 * @param perTick - true 时每个 tick 只喂一条（这样才能观察到"Worker 已存在 → 后续事件直通"）；
 *   false 时一个 tick 全喂进去（这样才能观察到批处理）。
 *
 * 这个参数本身说明了架构里的一个时序事实：**直通的前提是 Worker 已存在，
 * 而同一 tick 里的事件都早于 Worker 创建**——所以"直通"只可能跨 tick 发生。
 */
async function run(
  triggers: readonly Trigger[],
  perTick = false,
): Promise<{ stats: RunStats; batches: number[]; calls: number }> {
  const dir = mkdtempSync(join(tmpdir(), 'sam-'))
  try {
    routerCalls = 0
    batchedContexts = []
    const router: RouterSession = {
      decide(contexts) {
        // 批处理：一次调用判断一批，返回等长数组。
        routerCalls += 1
        batchedContexts.push(contexts.length)
        return Promise.resolve(
          contexts.map((): RouterDecision => ({ action: 'dispatch', task: 'do the thing', reply: 'on it' })),
        )
      },
    }
    const workers: WorkerSession[] = []
    const replies: string[] = []
    const stats = await runSupervisor({
      stateDir: dir,
      filterRules: RULES,
      createRouter: () => router,
      createWorker: (id) => {
        const worker: WorkerSession = {
          id,
          threads: new Set<string>(),
          step: (instruction) => {
            void instruction
            // 默认不产报告：这些用例测的是路由与直通，回流另有专门的用例。
            return Promise.resolve('')
          },
        }
        workers.push(worker)
        return worker
      },
      sources: perTick ? [queued(triggers)] : [],
      ...(perTick ? {} : { inject: triggers }),
      onReply: (_threadKey, text) => {
        replies.push(text)
      },
      maxTicks: perTick ? triggers.length : 1,
    })
    return { stats, batches: [...batchedContexts], calls: routerCalls }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('Fast Path 拦截 CI 结果和机器人自己的消息，不花模型的钱', async () => {
  const { stats } = await run([
    { ...trig('t1', 'k1', 'CI run #42 finished', 'ci-bot'), source: 'ci', kind: 'result' },
    trig('t2', 'k1', '随便什么', 'bot-itself'),
  ])
  assert.equal(stats.fastPathBlocked, 2, '两条都被拦')
  assert.equal(stats.routerDecisions, 0, '一次模型都没调')
  assert.equal(stats.workersSpawned, 0)
})

test('白名单的人直接派活，不过 Router', async () => {
  const { stats } = await run([trig('t1', 'k1', '帮我修超时', 'owner')])
  assert.equal(stats.routerDecisions, 0, '没过 Router')
  assert.equal(stats.workersSpawned, 1, '但活派了')
})

test('同一 Thread 的后续事件直通，Router 决策数不涨（中心论点）', async () => {
  const { stats } = await run(
    [
      trig('t1', 'pr-42', '帮我修 PR 里的超时'),
      trig('t2', 'pr-42', '改用方案 B'),
      trig('t3', 'pr-42', '测试跑过了'),
    ],
    true,
  )
  assert.equal(stats.routerDecisions, 1, '只有第一条过 Router')
  assert.equal(stats.directDeliveries, 2, '后两条直通')
  assert.equal(stats.workersSpawned, 1, '同一个 Worker 接着处理')
})

test('两个不同 Thread 派两个 Worker', async () => {
  const { stats } = await run([
    trig('t1', 'pr-42', '修超时'),
    trig('t2', 'pr-43', '另一个问题'),
  ])
  assert.equal(stats.routerDecisions, 2)
  assert.equal(stats.workersSpawned, 2)
})

test('不同 id 的重复内容不去重（内容一样但确实是两次不同的说话）', async () => {
  const { stats } = await run(
    [
      trig('t1', 'k1', '再说一遍'),
      trig('t2', 'k1', '再说一遍'),
    ],
    true,
  )
  // id 不同所以两条都进了，但同一 Thread 第二条直通。
  assert.equal(stats.routerDecisions, 1)
  assert.equal(stats.directDeliveries, 1)
})

test('一轮里的多条候选只调一次模型（批处理）', async () => {
  const { stats, batches, calls } = await run([
    trig('t1', 'pr-1', '第一个问题'),
    trig('t2', 'pr-2', '第二个问题'),
    trig('t3', 'pr-3', '第三个问题'),
  ])
  assert.equal(stats.routerDecisions, 3, '三条都判断了')
  assert.equal(calls, 1, '但只调了一次模型——这就是批处理')
  assert.deepEqual(batches, [3], '一次调用里带了三条候选')
  assert.equal(stats.workersSpawned, 3, '三个不同 Thread 派三个 Worker')
})

test('Worker 的汇报回到 Router 汇总，且不会投回它自己（防自激循环）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sam-'))
  try {
    const replies: string[] = []
    const router: RouterSession = {
      decide(contexts) {
        return Promise.resolve(
          contexts.map((context): RouterDecision => {
            // 来源是 worker 就是汇报：整理成一句话。否则派活。（真实 Router 的行为）
            return context.includes('[worker]')
              ? { action: 'reply_only', reply: '整理后的一句话结论' }
              : { action: 'dispatch', task: '去数一下目录' }
          }),
        )
      },
    }
    const worker = (id: string): WorkerSession => ({
      id,
      threads: new Set<string>(),
      // Worker 干完返回一段很长的汇报。
      step: () => Promise.resolve('数完了：14 个目录，前三个是 agents、analyses、connection_patterns'),
    })

    const stats = await runSupervisor({
      stateDir: dir,
      filterRules: {},
      createRouter: () => router,
      createWorker: worker,
      sources: [],
      inject: [trig('t1', 'k1', '数一下目录')],
      onReply: (_threadKey, text) => {
        replies.push(text)
      },
      maxTicks: 5,
      intervalMs: 1,
    })

    // 两轮 Router：一次派活，一次汇总汇报。
    assert.equal(stats.routerDecisions, 2, '派活 1 次 + 汇总 1 次')
    assert.equal(stats.directDeliveries, 0, '汇报绝不能直通——直通会投回发出汇报的那个 Worker')
    assert.ok(replies.includes('整理后的一句话结论'), '最终回话来自汇总')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('轮询源反复投递旧事件时，主循环也不能忙转——广播报要能穿过', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sam-'))
  try {
    const seen: string[] = []
    const router: RouterSession = {
      decide(contexts) {
        return Promise.resolve(
          contexts.map((context): RouterDecision =>
            context.includes('[worker]')
              ? { action: 'reply_only', reply: '数出来 3 个' }
              : { action: 'dispatch', task: '去数一下' },
          ),
        )
      },
    }
    // 这就是真实轮询源的样子：每一轮都返回"最近 N 条"，不管处理过没有。
    // 原来主循环用 `batch.length === 0` 判断空闲，于是这个源让它永远不空闲：
    // 不 await Worker、不 sleep，Worker 的汇报也永远等不到。
    const sameOld = trig('t1', 'k1', '数一下')
    const source: TriggerSource = { name: 'echo', poll: () => Promise.resolve([sameOld]) }

    const stats = await runSupervisor({
      stateDir: dir,
      filterRules: {},
      createRouter: () => router,
      createWorker: (id) => ({ id, threads: new Set<string>(), step: () => Promise.resolve('数完了：3 个') }),
      sources: [source],
      onReply: (_threadKey, text) => {
        seen.push(text)
      },
      maxTicks: 6,
      intervalMs: 1,
    })

    assert.equal(stats.workersSpawned, 1, '同一条事件只派一次活')
    assert.ok(seen.includes('数出来 3 个'), '汇报必须能穿过忙轮询，回到用户')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('派给 Worker 的第一条指令必须带执行纪律——找不到就停，不许造替代实现', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sam-'))
  try {
    const instructions: string[] = []
    const router: RouterSession = {
      decide: (contexts) =>
        Promise.resolve(contexts.map((): RouterDecision => ({ action: 'dispatch', task: '给 whyEmpty 加边界' }))),
    }
    await runSupervisor({
      stateDir: dir,
      filterRules: {},
      createRouter: () => router,
      createWorker: (id) => ({
        id,
        threads: new Set<string>(),
        step: (instruction) => {
          instructions.push(instruction)
          return Promise.resolve('没找到')
        },
      }),
      sources: [],
      inject: [trig('t1', 'k1', '给 whyEmpty 加边界')],
      onReply: () => undefined,
      maxTicks: 4,
      intervalMs: 1,
    })

    const first = instructions[0] ?? ''
    assert.match(first, /任务：给 whyEmpty 加边界/, '任务原文要在')
    assert.match(first, /执行纪律/, '纪律必须随任务一起到位')
    assert.match(first, /找不到时立刻停下/, '找不到要停，不能靠它自觉')
    assert.match(first, /绝不要为了/, '"造一个替代实现来交差"是最坏的失败形态')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Worker 还在跑的时候，新事件照常被收——主循环不为它停下', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sam-'))
  try {
    /** Worker 正在干活吗？Router 判断事件时要能看到这个状态。 */
    let workerBusy = false
    /** 有没有哪一次 Router 判断，是在 Worker 还在跑的时候发生的。 */
    let decidedWhileBusy = false
    const router: RouterSession = {
      decide: (contexts) => {
        if (workerBusy) decidedWhileBusy = true
        return Promise.resolve(contexts.map((): RouterDecision => ({ action: 'dispatch', task: '去干活' })))
      },
    }

    // 关键：前几轮**没有新事件**。这正是"Worker 在跑、群里还没人说话"的那一刻——
    // 也是主循环唯一会走到空闲分支的时刻。改之前它会在这里 await 到 Worker 落地。
    let polls = 0
    const source: TriggerSource = {
      name: 'quiet-then-talk',
      poll: () => {
        polls += 1
        return Promise.resolve(polls === 5 ? [trig('t2', 'k2', '现在说一句')] : [])
      },
    }

    await runSupervisor({
      stateDir: dir,
      filterRules: {},
      createRouter: () => router,
      createWorker: (id) => ({
        id,
        threads: new Set<string>(),
        step: () => {
          workerBusy = true
          // 80ms 的活，比"第 5 次轮询"晚得多。
          return new Promise((resolve) =>
            setTimeout(() => {
              workerBusy = false
              resolve('干完了')
            }, 80),
          )
        },
      }),
      sources: [source],
      onReply: () => undefined,
      inject: [trig('t1', 'k1', '先给我派个活')],
      maxTicks: 20,
      intervalMs: 1,
    })

    // 这一条就是这次改动的全部意义。
    // 改之前：空闲分支 `await Promise.all(inflight)`，Worker 忙的 80ms 里主循环停着，
    // 那段时间不会有任何判断发生——第 5 次轮询要等 Worker 落地之后才轮到。
    assert.equal(decidedWhileBusy, true, 'Worker 跑的时候，新事件必须还能进来')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('回话串行发出：先 ack 后结论，慢的那条不能把后面的插到前面', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sam-'))
  try {
    const order: string[] = []
    const router: RouterSession = {
      decide: (contexts) =>
        Promise.resolve(
          contexts.map((context): RouterDecision =>
            context.includes('[worker]')
              ? { action: 'reply_only', reply: '结论' }
              : { action: 'dispatch', task: '去干活', reply: 'ack' },
          ),
        ),
    }

    await runSupervisor({
      stateDir: dir,
      filterRules: {},
      createRouter: () => router,
      createWorker: (id) => ({ id, threads: new Set<string>(), step: () => Promise.resolve('干完了') }),
      sources: [],
      inject: [trig('t1', 'k1', '帮我干个活')],
      onReply: async (_threadKey, text) => {
        // **ack 故意比结论慢**。不排队、并发发的话，结论会先到——
        // 用户先看到结果再看到"收到"，比慢更难查。
        await new Promise((resolve) => setTimeout(resolve, text === 'ack' ? 30 : 1))
        order.push(text)
      },
      maxTicks: 8,
      intervalMs: 1,
    })

    assert.deepEqual(order, ['ack', '结论'], '同一个 Thread 上，说的顺序必须和想的一致')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('一次回话失败不能带走常驻进程，后面的话还得能发出去', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sam-'))
  try {
    const delivered: string[] = []
    const router: RouterSession = {
      decide: (contexts) =>
        Promise.resolve(contexts.map((): RouterDecision => ({ action: 'reply_only', reply: '一句话' }))),
    }

    await runSupervisor({
      stateDir: dir,
      filterRules: {},
      createRouter: () => router,
      createWorker: (id) => ({ id, threads: new Set<string>(), step: () => Promise.resolve('') }),
      sources: [],
      inject: [trig('t1', 'k1', '第一句'), trig('t2', 'k2', '第二句')],
      onReply: (threadKey, text) => {
        if (threadKey === 'k1') throw new Error('飞书挂了')
        delivered.push(text)
      },
      maxTicks: 6,
      intervalMs: 1,
    })

    // k1 的回话抛错了，k2 的必须照常送到——出站队列不能因为一条失败就断掉。
    assert.deepEqual(delivered, ['一句话'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Worker 失败时喂给模型的是人话——毫秒数和会话 id 不能流到用户那里', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sam-'))
  try {
    /** 攒下 Router 看到的每一段上下文，看里面有没有我们自己的实现细节。 */
    const seenByRouter: string[] = []
    const router: RouterSession = {
      decide: (contexts) => {
        seenByRouter.push(...contexts)
        return Promise.resolve(
          contexts.map((context): RouterDecision =>
            context.includes('[worker]') ? { action: 'reply_only', reply: '没干成' } : { action: 'dispatch', task: '去干' },
          ),
        )
      },
    }

    await runSupervisor({
      stateDir: dir,
      filterRules: {},
      createRouter: () => router,
      createWorker: (id) => ({
        id,
        threads: new Set<string>(),
        // 这是 dsh 抛出来的真实形状：毫秒数 + 会话 id，全是我们自己的实现细节。
        step: () => Promise.reject(new Error('dsh headless 超时（20000ms）：worker-w-ab12cd34-deadbeef')),
      }),
      sources: [],
      inject: [trig('t1', 'k1', '帮我干个活')],
      onReply: () => undefined,
      maxTicks: 8,
      intervalMs: 1,
    })

    const reportContext = seenByRouter.find((context) => context.includes('执行没有完成'))
    assert.ok(reportContext !== undefined, '失败必须回报给 Router，不能静默')
    assert.doesNotMatch(reportContext, /20000/, '毫秒数不能进模型，否则它一定会转述给用户')
    assert.doesNotMatch(reportContext, /worker-w-/, 'worker 会话 id 同理')
    assert.match(reportContext, /超时/, '但"超时"这件事要说，不然这句汇报没有信息量')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('汇报被误判成 dispatch 时，绝不把"给执行者的指令"念给用户', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sam-'))
  try {
    const said: string[] = []
    const router: RouterSession = {
      decide: (contexts) =>
        Promise.resolve(
          contexts.map(
            (context): RouterDecision =>
              // 汇报本该 reply_only，这里故意判成 dispatch——模拟模型犯错。
              // 关键是它同时带了一句 task（给执行者的指令），那句绝不能被当成回话发出去。
              context.includes('[worker]')
                ? { action: 'dispatch', task: '去仓库里再找一遍 whyEmpty 的实现并补边界' }
                : { action: 'dispatch', task: '去干活' },
          ),
        ),
    }

    await runSupervisor({
      stateDir: dir,
      filterRules: {},
      createRouter: () => router,
      createWorker: (id) => ({ id, threads: new Set<string>(), step: () => Promise.resolve('干完了') }),
      sources: [],
      inject: [trig('t1', 'k1', '帮我干个活')],
      onReply: (_threadKey, text) => {
        said.push(text)
      },
      maxTicks: 8,
      intervalMs: 1,
    })

    assert.ok(said.length > 0, '总得说点什么，不能一声不响')
    for (const text of said) {
      assert.doesNotMatch(text, /再找一遍/, 'task 是指令，不是对用户说的话')
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Worker 什么都没说，用户也必须收到一句话', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sam-'))
  try {
    const seen: string[] = []
    const router: RouterSession = {
      decide(contexts) {
        return Promise.resolve(
          contexts.map((context): RouterDecision =>
            context.includes('[worker]')
              ? { action: 'reply_only', reply: '执行者没给出结论' }
              : { action: 'dispatch', task: '去干点什么' },
          ),
        )
      },
    }
    await runSupervisor({
      stateDir: dir,
      filterRules: {},
      createRouter: () => router,
      // 空汇报。原来这条会被 `if (text.length === 0) return` 静默吞掉，
      // 于是用户永远等不到第二句话——任务看着"跑完了"，其实是蒸发了。
      createWorker: (id) => ({ id, threads: new Set<string>(), step: () => Promise.resolve('  ') }),
      sources: [],
      inject: [trig('t1', 'k1', '去干点什么')],
      onReply: (_threadKey, text) => {
        seen.push(text)
      },
      maxTicks: 5,
      intervalMs: 1,
    })
    assert.ok(seen.length > 0, '空汇报也必须走完"回话"这一步')
    assert.ok(seen.some((text) => text.length > 0), '回的话不能是空的')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Worker 抛错不能带走 supervisor——错也要变成一句回话', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sam-'))
  try {
    const seen: string[] = []
    const router: RouterSession = {
      decide(contexts) {
        return Promise.resolve(
          contexts.map((context): RouterDecision =>
            context.includes('[worker]')
              ? { action: 'reply_only', reply: '执行失败，已记录' }
              : { action: 'dispatch', task: '去干点什么' },
          ),
        )
      },
    }
    // 关键：这里不抛。原来 `.then` 没接 `.catch`，一个 Worker 崩了会把
    // `Promise.all(pending)` 一起 reject，常驻进程直接死。
    const stats = await runSupervisor({
      stateDir: dir,
      filterRules: {},
      createRouter: () => router,
      createWorker: (id) => ({
        id,
        threads: new Set<string>(),
        step: () => Promise.reject(new Error('dsh headless 超时（180000ms）：worker-x')),
      }),
      sources: [],
      inject: [trig('t1', 'k1', '去干点什么')],
      onReply: (_threadKey, text) => {
        seen.push(text)
      },
      maxTicks: 5,
      intervalMs: 1,
    })
    assert.equal(stats.workersSpawned, 1)
    assert.ok(seen.includes('执行失败，已记录'), '失败要被汇报成一句话，而不是静默崩掉')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
