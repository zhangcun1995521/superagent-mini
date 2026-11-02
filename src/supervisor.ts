/**
 * Supervisor：主循环。它是整个系统里唯一一个"常驻"的东西。
 *
 * 形状（文章第 2-3 节的落地）：
 *
 *   for (;;) {
 *     1. 拉事件（源适配器）
 *     2. Fast Path 过滤
 *     3. 有订阅者？→ 直通 Worker（不过 Router）
 *        没订阅者？→ Router 会话判断（Slow Path）
 *     4. Router 决定派活 → 建 Worker（DSH headless 子进程）
 *     5. Worker 汇报 → Router 汇总 → 按信道规范对外回话
 *     6. 落盘（状态 + 证据）
 *   }
 *
 * supervisor 本身不调模型——它只做确定性的事（过滤、路由、调度、落盘）。
 * 模型的判断在 Router 会话和 Worker 会话里，那两个都是 DSH headless 进程。
 * 这就是"计算与状态分离"在本机的形状：supervisor 可随时杀掉重开，状态在 jsonl 里。
 */

import { assembleContext, SpillStore } from './context.ts'
import type { FilterRules } from './filter.ts'
import { fastPath } from './filter.ts'
import {
  APPROVAL_TTL_MS,
  gate,
  isConfirmation,
  normalizeRisk,
  suspectContradiction,
} from './policy.ts'

import type { Trigger } from './model.ts'
import type { Store } from './store.ts'
import { openStore } from './store.ts'

/** 一个事件源的接口：实现它就能接入飞书/GitHub/合成。 */
export interface TriggerSource {
  name: string
  /** 拉一批新事件。返回空数组表示"没有新东西"。 */
  poll(): Promise<Trigger[]>
}

/**
 * Router 会话的接口：supervisor 通过它调模型，但不知道 DSH 的存在。
 *
 * **批量而不是单条**——这是文章 2.1 节的核心机制：上一轮推理期间到达的事件会积压，
 * 下一轮一并处理，形成 batch。实测代价很大：一条一调时，每个新 Thread 要等一次模型往返（200ms），
 * 主循环被堵，后面的工作请求全部推迟（我们的 p50 从 812ms 涨到 2107ms）。
 */
export interface RouterSession {
  /**
   * 让 Router 一次判断一批候选事件。
   * @param contexts - 每个候选事件的上下文（已组装）。
   * @returns 与输入等长的决定数组。
   */
  decide(contexts: readonly string[]): Promise<RouterDecision[]>
}

/** Router 的决定。 */
export interface RouterDecision {
  /** respond：这条要理，派活；ignore：不理；reply_only：只回话不派活（如纯问答）。 */
  action: 'dispatch' | 'ignore' | 'reply_only'
  /** 派活时的任务描述（给 Worker 的指令）。 */
  task?: string
  /** 对外回话（按信道规范，短）。 */
  reply?: string
  /**
   * 这个任务的风险档，由模型判断（见 `policy.ts` 的分工说明）。
   *
   * 缺省按 `write` 处理——**不是**因为 write 最安全，而是因为"模型漏了一次标注"
   * 和"这活要写东西"在统计上更接近。真不可逆的那些，模型有理由标出来。
   */
  risk?: 'read' | 'write' | 'irreversible'
}

/** Worker 的接口。 */
export interface WorkerSession {
  id: string
  /** 给 Worker 喂一轮。返回它的汇报。 */
  step(instruction: string): Promise<string>
  /** 它订阅的 Thread。 */
  threads: Set<string>
}

/** 供测试注入的 Worker 工厂。 */
export type WorkerFactory = (id: string) => WorkerSession

/** 门禁的判定结果。由部署层提供（这里调用外部验证工具），内核只负责把它说成人话。 */
export interface VerifyReport {
  /** PASS / FAIL / NO-CHANGES / NO-TESTS。用字符串而不是枚举，是因为验证工具可能加新结论。 */
  verdict: string
  /** 跑了几个测试文件。 */
  tests: number
  passed?: number
  failed?: number
  /** 失败的用例名。 */
  failures?: readonly string[]
}

/** Supervisor 的配置。 */
export interface SupervisorOptions {
  stateDir: string
  filterRules: FilterRules
  /** 轮询间隔，毫秒。 */
  intervalMs?: number
  /** 最多跑几轮（测试用）。默认无限。 */
  maxTicks?: number
  /** Router 会话怎么创建。 */
  createRouter: () => RouterSession
  /** Worker 会话怎么创建。 */
  createWorker: WorkerFactory
  /**
   * 门禁：Worker 落地后，跑一遍真实验证，给一条"能不能合"的判定。
   *
   * **这一条是"AI 说它改好了"和"它真的改好了"之间的缝。** 不给就只信它的自述——
   * 那正是所有 coding agent demo 的通病。给了之后，用户看到的是被跑过的结论。
   *
   * 由部署层提供（调用哪个验证工具是部署决定），内核只负责把结论说成人话。
   */
  verify?: () => Promise<VerifyReport>
  /** 事件源。 */
  sources: readonly TriggerSource[]
  /**
   * 工作区快照：Worker 落地后，用来核对"它到底动了哪些文件"。
   *
   * 不给就没有对账——**那就只是听它自己说**。所以生产环境应该给，
   * 测试里给假的（这个接口存在的意义就是能注入一个确定的东西）。
   */
  workspace?: { snapshot(): Promise<string[]> }
  /**
   * 对外回话的通道（飞书卡片 / 控制台）。
   *
   * 可以返回 Promise。**返回值会被排队等，但不等在事件循环上**——
   * 见 `runSupervisor` 里的 `say()`：单队列串行发，保证同一个 Thread 上
   * "先 ack 后结论"的顺序不变，同时不拖住收事件。
   */
  onReply: (threadKey: string, text: string) => void | Promise<void>
  /** 事件泵注入（测试用）：不接真源，直接喂。 */
  inject?: readonly Trigger[]
  /**
   * 关掉订阅直通（用于对照实验 C）。
   *
   * 打开时：即使 Thread 有订阅者，也先过 Router——这正是"没有直通"的形态，
   * 也是文章消融实验里 Router 决策数 +30% 的那个变量。
   */
  disableDirect?: boolean
}

/** 一次运行的统计。基准测试读这些数。 */
export interface RunStats {
  /** Router 判断了几条事件（Slow Path 的决策数）。 */
  routerDecisions: number
  /** Router 调了几次模型。批处理的效果就看它和 routerDecisions 的比值。 */
  routerCalls: number
  /** 直通了几次（没过 Router）。 */
  directDeliveries: number
  /** Fast Path 拦截了几条。 */
  fastPathBlocked: number
  /** 派了几个 Worker。 */
  workersSpawned: number
}

/**
 * 每个 Worker 拿到任务时都会看到的一段执行纪律。
 *
 * 这不是"提示词工程"，是实测撞出来的：群里回放的那条任务是"给 whyEmpty 加边界"，
 * 而 whyEmpty 在 Worker 的工作目录里根本不存在（那是另一个仓库的符号）。
 * Worker 的应对方式是**花 120 秒到处找，然后超时**——它宁可耗死也不肯说"没找到"。
 *
 * 所以这条必须写进给 Worker 的指令里，而不是指望它自觉：
 * 找不到就停、说清楚找过哪里、不要造一个替代实现来交差。
 * "造一个替代实现"是最坏的失败形态——它有产出，看起来像干成了。
 */
const WORKER_DISCIPLINE = `

执行纪律（这三条比任务本身优先）：
1. 只在当前工作目录内查找和修改。任务里提到的对象如果不在这里，就是不在。
2. 找不到时立刻停下，说明你查过哪些路径和关键字。不要继续扩大搜索范围猜。
3. **绝不要为了"完成任务"造一个替代实现**——找不到原对象就报告找不到，这比凭空写一个更有价值。`

/**
 * 跑 supervisor。
 *
 * @returns 统计数据。maxTicks 用完或注入的事件处理完就返回。
 */
export async function runSupervisor(options: SupervisorOptions): Promise<RunStats> {
  const store: Store = openStore(options.stateDir)
  /** 长内容落盘的地方。Worker 用它自己的文件工具读这些文件。 */
  const spills = new SpillStore(options.stateDir)
  /** 每个 Thread 最近的 payload（新的在前）。只放在内存里：
   *  它是"组装上下文的方便"，不是事实——重启后历史摘要没了，但任务本身没丢。 */
  const recent = new Map<string, string[]>()
  /** 一轮喂给 Worker 的上下文最多这么长；超出靠 Spill 兜。 */
  const INLINE_BUDGET = 4000
  const stats: RunStats = { routerDecisions: 0, routerCalls: 0, directDeliveries: 0, fastPathBlocked: 0, workersSpawned: 0 }
  const router = options.createRouter()
  const workers = new Map<string, WorkerSession>()
  const injected = options.inject === undefined ? [] : [...options.inject]
  /** 等 Worker 回报的队列。Worker 一落地，报告作为一条新 Trigger 回到这里。 */
  const reportQueue: Trigger[] = []
  /**
   * 挂着等人确认的不可逆任务：threadKey → 要干什么。
   *
   * 只放在内存里，而且**故意不持久化**：重启之后那些"确认"应该失效，
   * 而不是重启完突然执行一个十分钟前挂起的删除动作。
   */
  const approvals = new Map<string, { task: string; at: number }>()
  /**
   * 所有在飞的任务。Worker 并发执行是这套架构的核心，所以这里必须不阻塞。
   *
   * 用 Set 而不是数组、并且**落地就自己删**，因为主循环不再等它们了：
   * 原来靠 `pending.length = 0` 一次性清空，现在没有那个时点了，
   * 数组会一直涨。Set + 自删是"活干完了自己走人"，不需要谁来清。
   */
  const inflight = new Set<Promise<unknown>>()

  /** 把一件事挂进"在飞"清单，并保证它的失败不会变成无人处理的 rejection。 */
  function track(task: Promise<unknown>): void {
    // 兜一层 catch：不再有 `await Promise.all()` 替我们接住拒绝了，
    // 一个 Worker 崩掉会直接带走常驻进程。这和"失败也要回队"是同一件事的两面。
    const guarded = task.catch((error: unknown) => {
      console.error(`[supervisor] 在飞任务失败：${(error as Error).message?.slice(0, 300) ?? String(error)}`)
    })
    inflight.add(guarded)
    void guarded.finally(() => inflight.delete(guarded))
  }

  /**
   * 对外说话的出站队列。
   *
   * **一句话：不回话阻塞主循环，但保证顺序。**
   *
   * 为什么不直接 `void options.onReply(...)`：一个 Thread 上会先后产生两句话——
   * 派活时的 ack（"收到，已派给执行者"）和 Worker 落地后的结论。并发发出去，
   * 顺序可能反：用户先看到结论，再看到"收到"。这比慢更难查。
   *
   * 为什么不 `await options.onReply(...)`：飞书一次回话 3–6 秒，等它就是把
   * 刚拆掉的同步 IO 换个地方装回来。
   *
   * 所以：串成一条 Promise 链。链上的等待只影响下一条回话，不影响收事件。
   */
  let outbox: Promise<void> = Promise.resolve()

  function say(threadKey: string, text: string): void {
    outbox = outbox.then(async () => {
      try {
        await options.onReply(threadKey, text)
      } catch (error) {
        // 回话失败不能让常驻进程死，但也不能静默——任务跑完了话没送到，
        // 是最难查的一类问题：日志里一切正常，用户那头什么都没有。
        console.error(`[supervisor] 回话失败（${threadKey}）：${(error as Error).message?.slice(0, 300) ?? ''}`)
      }
    })
  }

  let ticks = 0

  const maxTicks = options.maxTicks ?? Number.POSITIVE_INFINITY
  while (ticks < maxTicks) {
    ticks += 1

    // 1) 拉事件。优先级：Worker 报告 > 测试注入 > 各源轮询。
    //    报告排在最前，因为它是"上一轮派出去的活回来了"——闭环比新事件更急。
    let batch: Trigger[] = reportQueue.splice(0, reportQueue.length)
    if (injected.length > 0) {
      batch.push(...injected.splice(0, injected.length))
    } else if (batch.length === 0) {
      for (const source of options.sources) {
        batch.push(...(await source.poll()))
      }
    }

    /** 本轮要交给 Router 判断的候选。批处理的关键：一轮只调一次模型。 */
    const candidates: Trigger[] = []

    /** 本轮真正"新的"事件数（过了去重才算）。**空闲的判断必须用它，不能用 batch.length。** */
    let fresh = 0

    for (const trigger of batch) {
      // 2) 去重（幂等）。
      if (!store.recordTrigger(trigger)) continue
      fresh += 1

      // 3) Fast Path。
      const verdict = fastPath(trigger, options.filterRules)
      if (verdict.admission === 'ignore') {
        stats.fastPathBlocked += 1
        continue
      }
      if (verdict.admission === 'respond') {
        // 白名单直通：不过 Router，直接派。
        dispatch(trigger, `直接处理：${trigger.payload}`)
        continue
      }

      // 4) **Worker 的汇报一律过 Router，绝不直通。**
      //
      // 这条是踩出来的：汇报的 threadKey 和原任务相同，而那个 Thread 的订阅者正是**发出汇报的
      // 那个 Worker**——直通会把汇报投回给它自己，它于是又干一轮，形成自激循环。
      // 死循环不是模型判断错，是路由错：所以规则必须在这里，而不是在提示词里。
      if (trigger.source === 'worker') {
        candidates.push(trigger)
        continue
      }

      // 5) 已有订阅者？→ 直通（不过 Router）。除非对照实验要求关掉直通。
      const thread = store.state.threads.get(trigger.threadKey)
      if (options.disableDirect !== true && thread !== undefined && thread.subscribers.size > 0) {
        for (const workerId of thread.subscribers) {
          const worker = workers.get(workerId)
          if (worker === undefined) continue
          stats.directDeliveries += 1
          // 不 await：Worker 并发跑，supervisor 继续收事件。这是"高效"的实现。
          track(worker.step(contextFor(trigger)))
        }
        continue
      }

      // 6) 没订阅者（或关掉了直通）→ 攒进本轮候选，稍后批量交给 Router。
      candidates.push(trigger)
    }

    // 6) 本轮候选一次性交给 Router。**一次模型调用，不是 N 次**——这就是批处理。
    if (candidates.length > 0) {
      stats.routerDecisions += candidates.length
      stats.routerCalls += 1
      // Router 只需要"要判断什么"，所以给它同一套组装结果——但 Router 的会话会自己压缩。
      const contexts = candidates.map((trigger) => contextFor(trigger))
      const decisions = await router.decide(contexts)
      for (const [index, trigger] of candidates.entries()) {
        const decision = decisions[index]
        if (decision === undefined || decision.action === 'ignore') continue

        // 汇报只可能变成"一句话回给用户"。模型偶尔会把它判成 dispatch（那就又派活了），
        // 这里强制纠回来——第二层防线，和守卫的做法一样：规则写在代码里。
        //
        // **注意这里不能拿 `decision.task` 当回话。** task 是"给执行者的指令"，
        // 不是"对用户说的话"——把指令原样念给用户，是这套系统最容易出的怪话。
        // 没有 reply 就老实说一句，不猜。
        if (trigger.source === 'worker' && decision.action === 'dispatch') {
          say(trigger.threadKey, decision.reply ?? '执行者回来了，但这次没整理出可读的结论。')
          continue
        }

        if (decision.action === 'reply_only') {
          say(trigger.threadKey, decision.reply ?? '(Router 没给回话)')
          continue
        }

        // ── 治理：派活之前先过门禁 ───────────────────────────────────────
        //
        // 两件事在这里发生，顺序不能反：
        //   1. 这条消息是不是一个"确认"？是就把挂着的任务放行（并且只放行一次）。
        //   2. 否则按风险档决定：不可逆的先问，不直接派。
        const pending = approvals.get(trigger.threadKey)
        if (pending !== undefined) {
          const expired = Date.now() - pending.at > APPROVAL_TTL_MS
          if (expired) {
            approvals.delete(trigger.threadKey)
            say(trigger.threadKey, '那个确认过期了。要做的话再说一遍。')
            continue
          }
          if (isConfirmation(trigger.payload)) {
            approvals.delete(trigger.threadKey)
            say(trigger.threadKey, '收到确认，开始动手。')
            dispatch(trigger, pending.task)
            continue
          }
          // 不是确认：说明人改主意了或者说了别的。作废，按新消息正常处理。
          approvals.delete(trigger.threadKey)
        }

        const risk = normalizeRisk(decision.risk)
        const verdict = gate(risk, decision.task ?? trigger.payload)
        if (verdict.kind === 'confirm') {
          // **不派活**，先问。这才是治理：不是事后记账，是事前不让他动手。
          approvals.set(trigger.threadKey, {
            task: decision.task ?? trigger.payload,
            at: Date.now(),
          })
          say(trigger.threadKey, verdict.question)
          continue
        }

        // 决定派活：已有订阅者就投给它（不重复建 Worker），否则新建。
        const thread = store.state.threads.get(trigger.threadKey)
        const existingWorker = thread === undefined ? undefined : [...thread.subscribers][0]
        if (existingWorker !== undefined && workers.has(existingWorker)) {
          track(workers.get(existingWorker)?.step(decision.task ?? trigger.payload) ?? Promise.resolve())
        } else {
          dispatch(trigger, decision.task ?? trigger.payload)
        }
        if (decision.reply !== undefined) say(trigger.threadKey, decision.reply)
      }
    }

    // 7) 空闲判定。**看的是 `fresh`（过了去重的新事件数），不是 `batch.length`。**
    //
    // 这一条是实测撞出来的，而且撞得很隐蔽：接上飞书源之后，每一轮轮询都会把
    // "最近 50 条"原样返回，去重之后 fresh 是 0，但 batch.length 一直是 1。
    // 于是"没新事件"这个分支永远进不去 —— 不 await Worker、不 sleep、不歇，
    // 变成一个 4 秒一圈的忙轮询。更糟的是这个忙轮询每一圈都在 `execFileSync`
    // 里阻塞一下、然后靠微任务续上，macrotask（定时器）被饿死：
    // Worker 的看门狗 setTimeout 到点也没机会跑，那个 promise 永远悬着。
    //
    // 教训 1：**"有没有新东西"必须用"去重后"的口径，不能用"拿到多少"的口径。**
    // 轮询源天生会重复投递，把重复计数当成活动，就等于把心跳当成干活。
    //
    // 教训 2（这一版才改）：**空闲时不等于"等活干完"。**
    // 原来这里 `await Promise.all(pending)`，理由是"派出去就不管了怎么办"。
    // 但那个担心是多余的：Worker 落地后汇报会变成一条 Trigger 进 `reportQueue`，
    // 下一轮自然就被捡起来，不需要谁在这里等。
    // 等着的代价很具体：一个 3 分钟的任务，3 分钟内不收任何事件——
    // 群里那 3 分钟说的话它全听不见（不丢，但要等它闲下来才补上）。
    // **空闲就睡一下，然后继续收。**
    if (fresh === 0) {
      // 有活在飞的时候不要提前收尾：**maxTicks 用完不等于"任务都完了"**。
      // 原来这里 `await Promise.all(pending)` 顺带起了一个作用——让出事件循环，
      // 使 Worker 的汇报有机会落地。现在不等了，所以收尾条件要明说：
      // 没活干、也没活在飞，才算真的跑完。
      if (options.maxTicks !== undefined && inflight.size === 0) break
      await sleep(options.intervalMs ?? 5000)
      continue
    }
  }

  // 收尾：等所有在飞的任务落地、等出站队列把话说完。
  // 它们的报告已经进队，但循环结束了就不再处理——这是 maxTicks 的语义（测试用），
  // 真实运行没有上限。
  await Promise.all([...inflight])
  await outbox
  return stats

  /**
   * 为一条 Trigger 组装窗口内容（Inline & Spill）。
   *
   * 三件事：把当前消息按预算内联、把该 Thread 最近几条做成摘要并落盘、
   * 记账（这一条成为"历史"供下一条用）。
   *
   * 预算的作用：Worker 的窗口是有限的，塞满就没地方放工具返回。**浪费窗口就是浪费智能**
   * （文章原话），所以长内容一律 Spill，窗口里只留摘要 + 落盘路径。
   */
  function contextFor(trigger: Trigger): string {
    const history = recent.get(trigger.threadKey) ?? []
    const assembled = assembleContext(trigger, history, spills)
    // 记进历史（新的在前，只留 5 条）。
    recent.set(trigger.threadKey, [trigger.payload, ...history].slice(0, 5))

    if (assembled.inline.length <= INLINE_BUDGET) return assembled.inline
    // 兜底：组装结果仍然超预算（说明历史摘要也长了），截断并指向 spill 文件。
    const head = assembled.inline.slice(0, INLINE_BUDGET)
    return `${head}

（已截断；完整内容见：${assembled.spillFiles.join('、') || '无'}）`
  }

  /** 派活：建 Worker、订阅 Thread、把第一步塞进并发队列。 */
  function dispatch(trigger: Trigger, task: string): void {
    const workerId = `w-${trigger.id.slice(-8)}`
    const worker = options.createWorker(workerId)
    workers.set(workerId, worker)
    stats.workersSpawned += 1

    // Thread 不存在就建。
    if (!store.state.threads.has(trigger.threadKey)) {
      store.putThread({ key: trigger.threadKey, subscribers: new Set(), lastActiveAt: trigger.at })
    }
    store.subscribe(trigger.threadKey, workerId)
    worker.threads.add(trigger.threadKey)

    // 第一步：交给它，但不阻塞 supervisor。**落地后把汇报变成一条 Trigger 回队**——
    // 这一步是"闭环"的全部：没有它，Worker 干完的结论只会留在某个变量里被丢掉。
    //
    // 三个"不省"的地方，都是实测撞出来的：
    // 1. **空汇报也要回队。** 原来 `if (text.length === 0) return` —— Worker 什么都没说，
    //    这件事就静默消失了，用户永远等不到回应。空输出本身是一个结论：
    //    "它没干出东西"，必须让人知道。
    // 2. **失败也要回队。** `.then` 不接 `.catch`，Worker 抛错（dsh 超时/崩溃）就变成
    //    无人处理的 rejection，最后在收尾的 `Promise.all` 那里把常驻进程带走。
    //    一个 Worker 的死不该是 supervisor 的死。
    // 3. **一定要挂进 `inflight`**，哪怕它已经失败——它是"还有活在飞"的账本。
    //
    // 4. **失败的话术不能原样喂给模型。** 这条是看真实日志才发现的：
    //    我们抛的是 `dsh headless 超时（20000ms）：worker-w-fb76ce2b-49dd219e`，
    //    里面有毫秒数、有 worker 会话 id——都是实现细节。Router 拿到它去"转述成一句话"，
    //    转出来的自然是"派发的任务执行超时了（20000ms 未返回）"。
    //    **模型只会说出它看到的东西**，所以这里给它人话，细节留给运维看日志。
    track(
      worker
        .step(`${contextFor(trigger)}

任务：${task}${WORKER_DISCIPLINE}`)
        .then((report) => (typeof report === 'string' ? report.trim() : ''))
        .catch((error: unknown) => {
          const detail = (error as Error).message ?? String(error)
          console.error(`[supervisor] Worker ${workerId} 失败（细节留在这里）：${detail.slice(0, 300)}`)
          return detail.includes('超时') ? '执行没有完成：超时了。' : '执行没有完成：中途出错。'
        })
        .then(async (text) => {
          // ── 治理：对账 ────────────────────────────────────────────────
          //
          // Worker 说什么是一回事，工作区里变了什么是另一回事。这里把后一件记下来，
          // 并且**拿它去核对前一件**——这是整晚唯一能验证"它没骗你"的东西。
          //
          // 注意：并发跑的多个 Worker 会看到彼此的改动（它们共用一个工作区）。
          // 这一版不做区分：宁可多记，不可漏记。
          const changed = options.workspace === undefined ? [] : await options.workspace.snapshot()
          const contradiction = suspectContradiction(text, changed)

          // 门禁：不问"你觉得行吗"，自己跑一遍。
          // 这一步和上面的对账是互补的：对账回答"动了什么"，门禁回答"能不能合"。
          let gateLine = ''
          let verifyReport: VerifyReport | undefined
          if (options.verify !== undefined) {
            try {
              verifyReport = await options.verify()
              gateLine = `\n\n门禁：${describeVerify(verifyReport)}`
            } catch (error) {
              // 门禁自己挂了，不能当成"通过"——也不能当成"改动有问题"。
              // 老实说一句"没验成"，让人自己判断，这是唯一不撒谎的选择。
              gateLine = `\n\n门禁：没跑成（${(error as Error).message?.slice(0, 120) ?? '未知原因'}）`
            }
          }

          store.appendEvidence({
            id: `ev-report-${workerId}-${Date.now()}`,
            workerId,
            action: 'report',
            basis: [trigger.id],
            verdict: (text.length === 0 ? '（空汇报）' : text).slice(0, 200),
            at: new Date().toISOString(),
            ...(changed.length === 0 ? {} : { changed }),
            ...(contradiction === undefined ? {} : { suspectContradiction: contradiction }),
            ...(verifyReport === undefined ? {} : { gate: describeVerify(verifyReport) }),
          })

          reportQueue.push({
            id: `report-${workerId}-${Date.now()}`,
            source: 'worker',
            threadKey: trigger.threadKey,
            kind: 'report',
            payload:
              (text.length === 0 ? '执行者没有产出任何结论（空输出）。' : text) + gateLine,
            at: new Date().toISOString(),
            actor: workerId,
          })
        }),
    )

    // 留证据：这次派活的依据是哪个 Trigger、结论是什么。
    store.appendEvidence({
      id: `ev-${trigger.id}`,
      workerId,
      action: 'dispatch',
      basis: [trigger.id],
      verdict: task.slice(0, 80),
      at: new Date().toISOString(),
    })
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 把门禁结论说成一句人话。
 *
 * 为什么要在这里格式化，而不是让验证工具自己输出：**给用户看的话由内核定形状**，
 * 和 `channel.ts` 一个道理。验证工具换一个（gitloop / CI / 客户的平台），
 * 用户看到的那句话不该变。
 */
export function describeVerify(report: VerifyReport): string {
  // tests 是"受影响的测试文件数"。给了自定义命令时（Python 仓就是跑全量），
  // 这个数会是 0 但确实跑了测试——所以要看 passed 有没有值，不能只看 tests。
  const what =
    report.tests === 0
      ? report.passed === undefined
        ? '没有测试被波及'
        : '跑了全量测试'
      : `跑了 ${report.tests} 个测试文件`
  const detail =
    report.passed === undefined
      ? ''
      : `，通过 ${report.passed}${report.failed === undefined ? '' : ` / 失败 ${report.failed}`}`
  const failures =
    report.failures === undefined || report.failures.length === 0
      ? ''
      : `。失败：${report.failures.slice(0, 3).join('、')}`

  switch (report.verdict) {
    case 'PASS':
      return `可以合——${what}${detail}`
    case 'FAIL':
      return `不能合——${what}${detail}${failures}`
    case 'NO-CHANGES':
      return '没检测到任何改动（它可能什么都没做，也可能改完又还原了）'
    case 'NO-TESTS':
      return `不能合——${what}，没有任何测试能证明这次改动是安全的`
    default:
      return `${report.verdict}——${what}${detail}${failures}`
  }
}
