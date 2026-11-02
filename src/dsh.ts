/**
 * 接真 DSH：Router 和 Worker 都变成 `dsh headless --session-id` 的会话。
 *
 * 这一步之前，harness 里的 Worker 是 `await sleep(200ms)`——调度形状对，但不会干活。
 * 接上 DSH 之后，Worker 是真的在跑一个 agent 循环：读文件、改代码、跑命令。
 *
 * 三个关键用法（都来自 `dsh headless --help`，不是我猜的）：
 *
 *   --session-id <id>   收养/恢复一个持久会话。同一个 id 反复喂，它记得前面每一轮。
 *                       **Worker 的连续性靠这个，不是我拼上下文。**
 *   --json              输出机器可读的事件流（想看 token/工具调用时用）。
 *   默认输出最终消息到 stdout，诊断到 stderr。
 *
 * Router 的分派协议：让它输出一段 JSON（{action, task, reply}），我们解析。
 * 这比"让 Router 调一个 dispatch 工具"脆弱——模型可能吐出坏 JSON——但后者要写 DSH 插件，
 * 而这一版是 CLI-only。这个取舍记在 DECISIONS，也是之后和官方原型对照的一个点。
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

import type { RouterDecision, RouterSession, WorkerSession } from './supervisor.ts'

/**
 * DSH 的家目录（profiles 在那下面）。
 *
 * **必须是项目自己的，不能借 deepwork 那个。** 这是实测撞出来的最贵的一条：
 * `deepwork/.dsh-home-ui/profiles/headless` 挂了 7 个插件（ontology、external、
 * session-query、lsp、test-runner、role、test-mode），于是**每个 Worker 启动时
 * 都是一个完整的企业原型**——它先去连飞书，撞上 Windows CNG 的 DPoP 签名失败
 * （`key signer is unavailable`），一堆重试之后任务超时。
 *
 * 同一个任务（读一个文件、给一句结论）两个 home 的实测：
 *   deepwork home  → 20 秒超时，一句结论都没有，日志全是飞书报错
 *   干净的 home    → **7.8 秒**，真的读了文件，结论是对的
 *
 * 教训：**Worker 带什么插件是设计决定，不是继承来的默认值。**
 * 隔离不只是"独立会话"，还包括"独立能力集"——多带的每一个插件都是一次
 * 它不该做的尝试，以及一个它会踩到的坑。
 *
 * 这个 home 不用手工建：DSH 第一次跑会自动铺一个最小 headless profile。
 * `SAM_DSH_HOME` 可以覆盖（比如想临时换回带工具的完整环境）。
 */
const DSH_HOME = process.env['SAM_DSH_HOME'] ?? join(process.cwd(), '.dsh-home')

/**
 * dsh 的入口脚本，按这个顺序找：
 *
 *   1. `SAM_DSH_BIN` —— 显式指定（上云时就是它）
 *   2. 项目自己的 `node_modules/@deepseek-ai/dsh/lib/bin.js` —— `npm i` 之后就有
 *   3. deepwork 开发目录 —— 本机开发时图省事用的兜底
 *
 * 为什么要这么绕：**绝对路径写死过，是个部署杀手**。原来这里直接是
 * `D:/projects/deepwork/node_modules/...`，换一台机器、换一个系统就找不到文件。
 * 但本机开发又不想为了跑一次去装一份 DSH，所以保留兜底、打印一条提示，
 * 让"我在用兜底"这件事可见——而不是悄悄用一个别处的版本。
 */
const DSH_BIN = findDshBin()

function findDshBin(): string {
  const override = process.env['SAM_DSH_BIN']
  if (override !== undefined && override.length > 0) return override

  const local = join(process.cwd(), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (existsSync(local)) return local

  const fallback = 'D:/projects/deepwork/node_modules/@deepseek-ai/dsh/lib/bin.js'
  console.warn(`[dsh] 没找到项目内的 DSH（${local}），退回开发目录：${fallback}`)
  console.warn('[dsh] 部署时请 `npm i @deepseek-ai/dsh` 或用 SAM_DSH_BIN 指定。')
  return fallback
}
/** 用哪个 profile 起会话。Worker 需要工具，所以用带工具的 headless。 */
const PROFILE = 'headless'

/** Router 的提示词。只要它做一件事：判断这条事件要不要干活。 */
const ROUTER_PROMPT = `你是调度层（Router），不是执行者。你不能自己干活，只能做一件事：判断下面这条消息要不要派给执行者。

只输出**一个 JSON 对象**，不要解释、不要 markdown 代码块：
{"action":"dispatch"|"ignore"|"reply_only","task":"派给执行者时的任务描述","reply":"要回给用户的一句话","risk":"read"|"write"|"irreversible"}

判断规则：
- **如果消息来源是 worker**（形如「[worker] w-xxxx: ...」），那是执行者干完活的汇报。
  你的工作是把它整理成一句给用户的话（群里要短，不超过 100 字），action 必须是 **reply_only**，
  绝不能再 dispatch——否则就成"派活→汇报→又派活"的死循环。
- 有人明确提出要你做事（修 bug、查问题、写东西）→ dispatch，task 写清楚要干什么
- 纯闲聊、通知、别人之间的对话 → ignore
- 问你能做什么、或者需要你直接回答一两句 → reply_only
- 不确定的时候选 dispatch：漏掉一件真事的代价，比多派一次活高得多

risk 怎么标（只在 dispatch 时有意义）：
- **read**：只是看、只是查、只是答，不改任何文件
- **write**：会改文件，但改坏了能改回来（改代码、加测试、写文档）
- **irreversible**：删东西、重置、强推、覆盖别人还没提交的改动——**做错了回不来**

risk 只写这三个词之一。拿不准就写 write，别写 irreversible。
把 risk 标低了会有后果：不可逆的动作会被直接执行，没人再问你一遍。

消息：
`

/**
 * 我们会话标签 → DSH 真实 session id。
 *
 * 为什么需要这张表：`--session-id` **不能用来创建会话**，它只认已存在的 id
 * （"session does not exist; omit --session-id to start a new Session"）。
 * 所以第一轮不传 id、从 `--json` 的第一行里拿它分配的真实 id，之后才用这个 id 续。
 */
const sessionIds = new Map<string, string>()

/** Worker 的默认时限：3 分钟，`DSH_WORKER_TIMEOUT_MS` 可覆盖。 */
function workerTimeout(): number {
  const raw = process.env['DSH_WORKER_TIMEOUT_MS']
  const parsed = raw === undefined ? Number.NaN : Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 180_000
}

/** 一轮的结果。 */
export interface TurnResult {
  text: string
  /** DSH 分配的真实 session id——第一次调用后才有。 */
  sessionId?: string
  /** token 用量，`--json` 里带的。做真实成本测量时要用。 */
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number }
}

/**
 * 调一轮 dsh headless。
 *
 * **必须异步（`execFile` 而不是 `execFileSync`）。** 这是实测撞出来的：
 * 同步调用看着没问题——测试里的 Worker 是假 sleep，并发像是成立的；
 * 接上真 DSH 后，`dispatch()` 里 `worker.step()` 一调就把整个进程钉住数分钟
 * （日志实证：`+ Worker` 到下一行 `→` 之间 182 秒），期间不轮询、不派活、不收新事件。
 * "Worker 并发执行"这条架构主张因此变成假的——它退化成严格串行。
 *
 * **还得自己再加一层看门狗。** `execFile` 的 `timeout` 在 Windows 上不保证 promise 落地：
 * 它 kill 的是直接子进程，而 `dsh` 自己会再派生子进程/持有管道，管道不关，
 * 回调就一直不触发。实测：`timeout: 180000`，等了 6 分钟回调没来，
 * 那个 Worker 的 promise 永远悬着——`await Promise.all(pending)` 于是永久挂住。
 * 所以这里 `setTimeout` 自己兜：到点就 kill + reject，不再指望平台行为。
 *
 * @param label - 我们自己的会话名（router-main / worker-x）。第一次用它会新建 DSH 会话，
 *   之后都用那个真实 id 续上——**连续性就是这么来的**。
 * @param prompt - 这一轮要说的话。
 * @param timeoutMs - 超时。默认 3 分钟。
 * @returns 最终文本 + 会话 id + 用量。
 */
export function runTurn(label: string, prompt: string, timeoutMs = 180_000, cwd?: string): Promise<TurnResult> {
  const known = sessionIds.get(label)
  const args = [DSH_BIN, '--profile', PROFILE, 'headless', '--json']
  if (known !== undefined) args.push('--session-id', known)
  args.push(prompt)

  return new Promise((resolve, reject) => {
    let settled = false
    /** 只结算一次。看门狗和回调都可能到，先到的赢。 */
    const settle = (outcome: { ok: true; result: TurnResult } | { ok: false; reason: Error }): void => {
      if (settled) return
      settled = true
      clearTimeout(watchdog)
      if (outcome.ok) resolve(outcome.result)
      else reject(outcome.reason)
    }

    // 平台无关的兜底：不管 execFile 的回调来不来，到点就走人。
    // 留 2 秒余量给正常路径先跑，避免两边同时结算时日志里出现莫名的超时。
    const watchdog = setTimeout(() => {
      child.kill('SIGKILL')
      settle({ ok: false, reason: new Error(`dsh headless 超时（${timeoutMs}ms，看门狗）：${label}`) })
    }, timeoutMs + 2000)

    const child = execFile(
      process.execPath,
      args,
      {
        encoding: 'utf8',
        timeout: timeoutMs,
        maxBuffer: 32 * 1024 * 1024,
        env: { ...process.env, DSH_HOME },
        // Worker 在**哪个目录**里干活，是这一轮的决定，不是进程的默认值。
        // 不给就继承 supervisor 的 cwd——那正是"agent 只能改自己的代码"那个缺口。
        ...(cwd === undefined ? {} : { cwd }),
      },
      (error, stdout, stderr) => {
        if (error === null) {
          try {
            settle({ ok: true, result: parseTurn(stdout, label) })
          } catch (parseError) {
            settle({ ok: false, reason: parseError as Error })
          }
          return
        }
        if ((error as { killed?: boolean }).killed === true) {
          settle({ ok: false, reason: new Error(`dsh headless 超时（${timeoutMs}ms）：${label}`) })
          return
        }
        const detail = `${stdout ?? ''}${stderr ?? ''}`.trim() || error.message || 'unknown'
        settle({ ok: false, reason: new Error(`dsh headless 失败（${label}）：${detail.slice(-600)}`) })
      },
    )
  })
}

/** 解析 `--json` 的 ndjson 输出。 */
export function parseTurn(raw: string, label: string): TurnResult {
  let sessionId: string | undefined
  let final: string | undefined
  let usage: TurnResult['usage']

  for (const line of raw.split(/\r?\n/)) {
    if (line.trim().length === 0) continue
    let event: Record<string, unknown>
    try {
      event = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    if (event['type'] === 'session' && typeof event['sessionId'] === 'string') {
      sessionId = event['sessionId']
    }
    if (event['type'] === 'final' && typeof event['text'] === 'string') {
      final = event['text']
    }
    const usageEvent = event['usage']
    if (typeof usageEvent === 'object' && usageEvent !== null) {
      const record = usageEvent as Record<string, unknown>
      if (typeof record['inputTokens'] === 'number' && typeof record['outputTokens'] === 'number') {
        usage = {
          inputTokens: record['inputTokens'],
          outputTokens: record['outputTokens'],
          totalTokens: typeof record['totalTokens'] === 'number' ? record['totalTokens'] : 0,
        }
      }
    }
  }

  if (sessionId !== undefined) sessionIds.set(label, sessionId)
  return { text: final ?? '', ...(sessionId === undefined ? {} : { sessionId }), ...(usage === undefined ? {} : { usage }) }
}

/**
 * 从模型输出里抠出 JSON。
 *
 * 模型经常在 JSON 前后加解释或 markdown 代码块，所以找第一个 "{" 到最后一个 "}" 之间的内容。
 * 抠不出来就返回 undefined——调用方必须处理这个情况，不能假定总是好的。
 */
export function extractDecision(text: string): RouterDecision | undefined {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return undefined
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as Partial<RouterDecision>
    if (parsed.action !== 'dispatch' && parsed.action !== 'ignore' && parsed.action !== 'reply_only') return undefined
    return {
      action: parsed.action,
      ...(typeof parsed.task === 'string' ? { task: parsed.task } : {}),
      ...(typeof parsed.reply === 'string' ? { reply: parsed.reply } : {}),
      // risk 不在这里兜底：模型给的值合法就用，不合法由 policy.normalizeRisk 收。
      // 两处都兜底会掩盖"模型没按格式输出"这件事。
      ...(parsed.risk === 'read' || parsed.risk === 'write' || parsed.risk === 'irreversible'
        ? { risk: parsed.risk }
        : {}),
    }
  } catch {
    return undefined
  }
}

/** 真 Router：一个常驻会话，一轮判断一批。 */
export function dshRouter(sessionId = 'router-main'): RouterSession {
  return {
    async decide(contexts) {
      // 批处理：多条候选合成一次调用。这就是文章 2.1 的 batching，也是我们基准里
      // "决策 200 次但只调 7 次模型"的来源。
      if (contexts.length === 1) {
        const output = (await runTurn(sessionId, ROUTER_PROMPT + (contexts[0] ?? ''))).text
        const decision = extractDecision(output)
        if (decision !== undefined) return [decision]
        // 解析失败：不派活，把原文回给人。**坏输出不能变成副作用。**
        return [{ action: 'reply_only', reply: `（Router 输出无法解析，原文）${output.slice(0, 300)}` }]
      }

      const numbered = contexts.map((context, index) => `${index + 1}. ${context}`).join('\n')
      const output = (
        await runTurn(
          sessionId,
          `${ROUTER_PROMPT.replace('只输出**一个 JSON 对象**', '按顺序为每一条输出一个 JSON 对象，组成 JSON 数组')}\n` +
            `下面是 ${contexts.length} 条消息，请返回长度为 ${contexts.length} 的数组：\n${numbered}`,
        )
      ).text
      const parsed = extractArray(output)
      return contexts.map((_, index) => parsed[index] ?? { action: 'ignore' })
    },
  }
}

/** 从输出里抠出 JSON 数组（Router 批量判断用）。 */
function extractArray(text: string): RouterDecision[] {
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start === -1 || end === -1 || end <= start) return []
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as Array<Partial<RouterDecision>>
    return parsed
      .filter((item) => item.action === 'dispatch' || item.action === 'ignore' || item.action === 'reply_only')
      .map((item) => ({
        action: item.action as RouterDecision['action'],
        ...(typeof item.task === 'string' ? { task: item.task } : {}),
        ...(typeof item.reply === 'string' ? { reply: item.reply } : {}),
        ...(item.risk === 'read' || item.risk === 'write' || item.risk === 'irreversible'
          ? { risk: item.risk }
          : {}),
      }))
  } catch {
    return []
  }
}

/**
 * 真 Worker：一个持久会话，第一次喂任务，后续事件接着喂同一个 session。
 *
 * @param id - Worker id（也用作 session id 后缀）。
 * @param timeoutMs - 单个任务最多跑多久。默认 3 分钟，`DSH_WORKER_TIMEOUT_MS` 可覆盖。
 * @param cwd - **在哪个目录里干活。** 不给就继承 supervisor 的 cwd——那意味着 Worker 只能改
 *   agent 自己的代码。真实场景里活是在**别人的仓库**里干的，所以这个参数是必需的，
 *   不是可选的优化。
 */
export function dshWorker(id: string, timeoutMs = workerTimeout(), cwd?: string): WorkerSession {
  const sessionId = `worker-${id}-${randomUUID().slice(0, 8)}`
  return {
    id,
    threads: new Set<string>(),
    async step(instruction) {
      return (await runTurn(sessionId, instruction, timeoutMs, cwd)).text
    },
  }
}
