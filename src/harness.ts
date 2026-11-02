#!/usr/bin/env node
/**
 * 三个方案的对照实验：单会话 / 双层+直通 / 双层无直通。
 *
 * 这是整个项目的**判决点**：文章说双层 + 直通更好，我们用自己的实现复现一次。
 *
 * 三个变量、五个数：
 *   变量：A 单会话串行 / B 双层+直通 / C 双层但后续事件也过 Router
 *   数：p50、p95 完成时间 · Router 决策数 · **模型调用数** · 直通次数 · token
 *
 * 两个关于"怎么测才有效"的坑，都是踩出来的：
 *
 * 1. **事件必须按时间滴入**。第一版把 220 条事件塞进一个 tick，结果 B 和 C 的数字一模一样——
 *    因为"直通"的前提是 Worker 已经存在，而同一 tick 里的事件都早于 Worker 创建。
 *    一个测不出差异的负载，会让人误以为架构没用。
 * 2. **到达时间要在事件进入系统时记录**，不能在启动前一次性写死。否则排队等待会被算进完成时间，
 *    而那段等待恰好是"系统忙不过来"的证据，必须归到它该归的地方。
 *
 *   node src/harness.ts
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Trigger } from './model.ts'
import type { RouterDecision, RouterSession, TriggerSource, WorkerSession } from './supervisor.ts'
import { runSupervisor } from './supervisor.ts'

/** 一次模拟调用的耗时。 */
const CALL_MS = 200
/** 一个"工作"要做几次调用。 */
const CALLS_PER_JOB = 3
/** Router 判断一次的耗时（模型往返）。 */
const ROUTER_MS = 200
/** 工作请求数。 */
const JOBS = 20
/** 噪音事件数。 */
const NOISE = 200
/** 事件滴入间隔。 */
const DROP_MS = 10

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

interface Result {
  mode: string
  p50: number
  p95: number
  decisions: number
  calls: number
  direct: number
  tokens: number
  wallMs: number
}

/** 造负载：JOBS 个工作请求分在 4 个 Thread（模拟同一 PR 的多轮），外加 NOISE 条噪音。 */
function load(): Trigger[] {
  const mixed: Trigger[] = []
  for (let index = 0; index < JOBS; index += 1) {
    mixed.push({
      id: `w-${index}`,
      source: 'github',
      threadKey: `pr-${index % 4}`,
      kind: 'comment',
      payload: `第 ${index} 个：请处理这个 PR 的超时问题 ${'x'.repeat(120)}`,
      at: new Date().toISOString(),
      actor: 'owner',
    })
    // 每个工作请求之间夹一批噪音。
    for (let noiseIndex = 0; noiseIndex < NOISE / JOBS; noiseIndex += 1) {
      const n = index * (NOISE / JOBS) + noiseIndex
      mixed.push({
        id: `n-${n}`,
        source: 'feishu',
        threadKey: `chat-${n % 7}`,
        kind: 'message',
        payload: `闲聊 ${n}`,
        at: new Date().toISOString(),
        actor: 'someone',
      })
    }
  }
  return mixed
}

/** 百分位。 */
function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return Math.round(sorted[index] ?? 0)
}

/**
 * 按时间滴入的事件源：每个 poll 吐一条，并在**此刻**记录到达时间。
 *
 * @param events - 事件序列（会被复制，调用方可以复用）。
 * @param arrivals - 到达时间表，poll 时写入。
 */
function timedSource(events: readonly Trigger[], arrivals: Map<string, number>): TriggerSource {
  const queue = [...events]
  return {
    name: 'timed',
    poll: async () => {
      const next = queue.shift()
      if (next === undefined) return []
      arrivals.set(next.id, Date.now())
      await sleep(DROP_MS)
      return [next]
    },
  }
}

/** 方案 A：单会话串行——一条一条来，下一条必须等上一条干完。 */
async function modeA(events: readonly Trigger[]): Promise<Result> {
  const started = Date.now()
  const arrivals = new Map<string, number>()
  const source = timedSource(events, arrivals)
  const samples: number[] = []
  let tokens = 0
  let decisions = 0

  for (;;) {
    const batch = await source.poll()
    if (batch.length === 0) break
    const trigger = batch[0] as Trigger
    decisions += 1
    tokens += trigger.payload.length
    await sleep(ROUTER_MS)
    for (let call = 0; call < CALLS_PER_JOB; call += 1) {
      tokens += 400
      await sleep(CALL_MS)
    }
    const arrived = arrivals.get(trigger.id)
    if (arrived !== undefined && trigger.actor === 'owner') samples.push(Date.now() - arrived)
  }

  return {
    mode: 'A 单会话串行',
    p50: percentile(samples, 50),
    p95: percentile(samples, 95),
    decisions,
    calls: decisions,
    direct: 0,
    tokens,
    wallMs: Date.now() - started,
  }
}

/** 方案 B / C：走 supervisor。B 开直通，C 关直通。 */
async function modeTwoTier(events: readonly Trigger[], disableDirect: boolean): Promise<Result> {
  const dir = mkdtempSync(join(tmpdir(), 'sam-bench-'))
  const started = Date.now()
  const arrivals = new Map<string, number>()
  const source = timedSource(events, arrivals)
  const samples: number[] = []
  let tokens = 0
  let calls = 0

  const router: RouterSession = {
    async decide(contexts) {
      calls += 1
      for (const context of contexts) tokens += context.length
      await sleep(ROUTER_MS)
      // 一次调用处理一批，返回等长数组——文章 2.1 的 batching。
      return contexts.map((): RouterDecision => ({ action: 'dispatch', task: 'do the job' }))
    },
  }

  const createWorker = (id: string): WorkerSession => ({
    id,
    threads: new Set<string>(),
    async step(instruction: string) {
      // Worker 的每一步都按"读码+改+验证"三次调用计。
      tokens += instruction.length
      for (let call = 0; call < CALLS_PER_JOB; call += 1) {
        tokens += 400
        await sleep(CALL_MS)
      }
      // 只有工作请求计入完成时间；噪音不计。
      for (const [id2, at] of arrivals) {
        if (instruction.includes(`第 ${id2.slice(2)} 个`)) samples.push(Date.now() - at)
      }
      // 基准里的 Worker 不产报告：它只模拟耗时，汇报回流不该混进调度测量。
      return ''
    },
  })

  const stats = await runSupervisor({
    stateDir: dir,
    filterRules: { alwaysRespondActors: ['owner'] },
    createRouter: () => router,
    createWorker,
    sources: [source],
    onReply: () => {},
    intervalMs: 2,
    maxTicks: events.length + 2,
    disableDirect,
  })
  rmSync(dir, { recursive: true, force: true })

  return {
    mode: disableDirect ? 'C 双层无直通' : 'B 双层+直通',
    p50: percentile(samples, 50),
    p95: percentile(samples, 95),
    decisions: stats.routerDecisions,
    calls,
    direct: stats.directDeliveries,
    tokens,
    wallMs: Date.now() - started,
  }
}

/** 打印一张表。 */
function print(results: readonly Result[]): void {
  const pad = (text: string | number, width: number): string => String(text).padEnd(width)
  console.log('')
  console.log(
    pad('方案', 16),
    pad('p50', 8),
    pad('p95', 8),
    pad('决策', 6),
    pad('模型调用', 9),
    pad('直通', 6),
    pad('token', 9),
    '总耗时',
  )
  console.log('-'.repeat(84))
  for (const result of results) {
    console.log(
      pad(result.mode, 16),
      pad(`${result.p50}ms`, 8),
      pad(`${result.p95}ms`, 8),
      pad(result.decisions, 6),
      pad(result.calls, 9),
      pad(result.direct, 6),
      pad(result.tokens, 9),
      `${(result.wallMs / 1000).toFixed(1)}s`,
    )
  }
  console.log('')
}

const events = load()
console.log(
  `负载：${JOBS} 个工作请求（4 个 Thread）+ ${NOISE} 条噪音，按时间滴入（每条间隔 ${DROP_MS}ms）；` +
    `每次工作 = ${CALLS_PER_JOB} × ${CALL_MS}ms，Router 判断 ${ROUTER_MS}ms`,
)

const results: Result[] = []
results.push(await modeA(events))
results.push(await modeTwoTier(events, false))
results.push(await modeTwoTier(events, true))
print(results)
