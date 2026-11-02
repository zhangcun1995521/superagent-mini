#!/usr/bin/env node
/**
 * 常驻入口：真的转起来。
 *
 *   node src/run.ts
 *
 * 和 demo.ts 的区别：
 *   demo     —— 一个人在命令行里说一句话，跑完就退出（结构验证）
 *   run.ts   —— 事件来自飞书群里真人在说话，进程不退出（形态验证）
 *
 * 三件事在这一层才定下来，因为它们都是**部署决定**，不该进内核：
 *   1. 事件从哪来（sources）——飞书群
 *   2. 状态存在哪（stateDir）——磁盘，重启接着跑
 *   3. 话往哪回（onReply）——同一个群
 *
 * 内核（supervisor）对这些一无所知，它只认 Trigger 和 threadKey。
 * 这就是"计算与状态分离"再往外一层：**内核与部署分离**。
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { dshRouter, dshWorker } from './dsh.ts'
import { shapeReply } from './channel.ts'
import { chatIdOf, feishuReply, feishuSource } from './feishu.ts'
import type { FilterRules } from './filter.ts'
import { runSupervisor, type VerifyReport } from './supervisor.ts'

/**
 * 部署配置：**全部走环境变量，改机器不改代码**。
 *
 * 这几项都是"换一台机器就得变"的东西，写死在源码里，上云第一件事就是改代码，
 * 而改了源码就等于部署的是一个跟仓库不一样的版本——以后排查没人分得清。
 */
const CHAT_ID = required('SAM_CHAT_ID', '要盯的飞书群 id（oc_xxx）')

/**
 * 过滤规则。
 *
 * 两处留空是有意的：
 *   - ignoredActors 空：机器人自己的消息已经在源里按 sender_type 滤掉了，
 *     这里再列一遍是在两个地方写同一条规则，改的时候容易只改一处。
 *   - alwaysRespondActors 空：**这就是这套架构的重点**——主人说的话也不豁免，
 *     要不要干活交给 Router 判断。设成白名单就等于绕过 Router，
 *     "双层"立刻退化成"单层+一堆 Worker"。
 */
const FILTER_RULES: FilterRules = {}

/** 轮询间隔。必须大于一次 lark-cli 调用的耗时（实测 3–6 秒），否则上一轮还没回来就下一轮。 */
const INTERVAL_MS = Number(process.env['SAM_INTERVAL_MS'] ?? 5000)

/**
 * 状态目录：不写 tmp，重启要能用。
 * 云上一般指到 `/var/lib/superagent` 这类地方，容器里就挂一个卷。
 */
const STATE_DIR = process.env['SAM_STATE_DIR'] ?? 'state'

/**
 * Worker 在哪个目录里干活。
 *
 * **这就是"接进客户仓库"的那一个参数。** 不给就是 agent 自己的目录——那 Worker 只能改
 * agent 的源码，演示不了任何真实场景。
 */
const WORKSPACE = process.env['SAM_WORKSPACE'] ?? process.cwd()

/**
 * 门禁工具的位置。
 *
 * **不给就是没有门禁。** 公开仓里不该写死某台机器的路径；而且"没配门禁"必须能被看见——
 * 悄悄跳过会让人以为验证过了，那比没有更糟。
 */
const VERIFY_BIN = process.env['SAM_VERIFY_BIN'] ?? ''

/**
 * 门禁跑什么命令。
 *
 * 不设就是默认（TS/JS 仓：`node --test` 跑受影响的测试文件）。
 * **Python 仓必须设**（`python -m pytest -q`）：影响面分析目前只认 TS/JS 的 import 图，
 * 硬算会得到"0 个测试受影响"，然后误判成"不能合"。所以给了命令就跑全量。
 */
const VERIFY_COMMAND = process.env['SAM_VERIFY_COMMAND'] ?? ''

/** 读一个必须存在的环境变量。缺了就直接退出——常驻进程不该带着半个配置跑起来。 */
function required(name: string, what: string): string {
  const value = process.env[name]
  if (value === undefined || value.length === 0) {
    console.error(`缺环境变量 ${name}（${what}）。`)
    console.error('例如：SAM_CHAT_ID=oc_xxx node src/run.ts')
    process.exit(2)
  }
  return value
}

/**
 * 首次启动的水位线。
 *
 * 状态文件不存在 = 第一次跑。这时群里的历史消息会被当成"新事件"全放进来，
 * 于是对着半年前的"哈喽在吗"派 Worker。所以第一次启动只处理**此刻之后**的话。
 *
 * 对齐到分钟是有意的：`create_time` 只精确到分钟，如果水位线带秒，
 * 和它同一分钟里刚发的那条会被 "15:07:00 < 15:07:30" 判成旧的而漏掉。
 * **宁可重放一分钟，不要漏一条。**
 *
 * 环境变量 `FEISHU_SINCE` 可以强设水位线，两个用途：
 *   1. 回放验证：指到一个真实历史消息之前，让整条链路真跑一遍
 *   2. 补数据：进程停了一段时间，想让漏掉的这段时间的话也处理掉
 * 显式指定的水位线**永远优先**——否则状态文件一存在它就被忽略了，这个开关就成了摆设。
 */
function firstRunWatermark(): string | undefined {
  const forced = process.env['FEISHU_SINCE']
  if (forced !== undefined && forced.length > 0) return forced
  if (existsSync(join(STATE_DIR, 'state.jsonl'))) return undefined
  const now = new Date()
  now.setSeconds(0, 0)
  return now.toISOString()
}

function stamp(): string {
  return new Date().toISOString().slice(11, 19)
}

function log(message: string): void {
  console.log(`[${stamp()}] ${message}`)
}

/**
 * 工作区里有哪些文件被改动过（相对路径）。
 *
 * 两个刻意的选择：
 * 1. **异步**。`execFileSync` 在这里等于每次对账把常驻进程冻一下——和我们刚清掉的那批
 *    同步 IO 是同一个问题。
 * 2. **失败返回空数组，不抛。** 对账是"最好有"，不是"必须有"：工作区不是 git 仓库、
 *    或者 git 不在，不该让整次任务失败。但要把原因打出来——静默返回空和真的没改动
 *    长得一模一样，那是自欺。
 */
async function changedPaths(dir: string): Promise<string[]> {
  return new Promise((resolve) => {
    execFile('git', ['status', '--porcelain=v1'], { cwd: dir, encoding: 'utf8', timeout: 10_000 }, (error, stdout) => {
      if (error !== null) {
        console.error(`[${stamp()}] 对账失败（当作没有改动）：${error.message.slice(0, 200)}`)
        resolve([])
        return
      }
      resolve(
        stdout
          .split('\n')
          .map((line) => line.slice(3).trim()) // 前两列是状态码，第三列起是路径
          .filter((path) => path.length > 0),
      )
    })
  })
}

const watermark = firstRunWatermark()

log(`启动。群 ${CHAT_ID}，状态目录 ${STATE_DIR}/，轮询 ${INTERVAL_MS}ms`)
if (watermark === undefined) {
  log('状态已存在，接着上一轮跑（已处理过的事件靠状态文件去重）。')
} else {
  log(`首次启动：只处理 ${watermark} 之后的消息，群里的历史不回溯。`)
}
log('在群里说话就会触发。Ctrl-C 停。')
if (VERIFY_BIN.length === 0) {
  log('⚠ 没配 SAM_VERIFY_BIN：Worker 改完不会有人验，"能不能合"只剩它自己的说法。')
} else {
  log(`门禁：${VERIFY_BIN}${VERIFY_COMMAND.length === 0 ? '' : `（测试命令：${VERIFY_COMMAND}）`}`)
}

const stats = await runSupervisor({
  stateDir: STATE_DIR,
  filterRules: FILTER_RULES,
  intervalMs: INTERVAL_MS,
  sources: [feishuSource({ chatId: CHAT_ID, ...(watermark === undefined ? {} : { since: watermark }) })],
  // 对账：Worker 落地后看工作区变了哪些文件。**没有它，我们只有 Worker 的自述。**
  workspace: { snapshot: () => changedPaths(WORKSPACE) },
  // 门禁：Worker 落地后跑一遍真实验证，给一条"能不能合"的判定。
  // 跑在 supervisor 进程里（不是 Worker 沙箱里）——沙箱跑不了测试子进程，而且
  // **判定本来就不该由被判定的人执行**。
  // 没配 `SAM_VERIFY_BIN` 就没有门禁，并且会打一条警告：悄悄跳过比没有更糟。
  ...(VERIFY_BIN.length === 0 ? {} : { verify: () => runGitloop(WORKSPACE) }),
  createRouter: () => dshRouter('router-main'),
  createWorker: (id) => {
    const worker = dshWorker(id, undefined, WORKSPACE)
    log(`+ Worker ${id} 起了一个 DSH 会话（工作目录 ${WORKSPACE}）`)
    return worker
  },
  // 回话：现在是 async 的，而且**不用再自己 try/catch**——
  // 内核的出站队列会串行发、并接住异常（打日志，不让常驻进程死）。
  // 这里只负责"怎么发"，不负责"发失败了怎么办"：那是内核的事，写在代码里。
  onReply: async (threadKey, text) => {
    const chatId = chatIdOf(threadKey)
    if (chatId === undefined) {
      // 内核给了个不是飞书的 threadKey。不猜，打出来——静默丢掉会让人以为"它没回我"。
      console.error(`[${stamp()}] 不知道怎么回 ${threadKey}，内容：${text.slice(0, 200)}`)
      return
    }
    // 信道规范在这里生效：剥内部代号、压空白、超长截断并全文存档。
    // 模型说什么是一件事，"出门的那一句长什么样"是另一件事——后者由代码保证。
    const shaped = shapeReply(text, { archiveDir: join(STATE_DIR, 'replies') })
    if (shaped.text.length === 0) {
      // 压完是空的：不发言。发一条空白消息比不发更糟——用户会以为出故障了。
      log(`（掐掉一条空回话，原文 ${text.length} 字）`)
      return
    }
    await feishuReply(chatId, shaped.text)
    log(`→ ${chatId}: ${shaped.text.replace(/\s+/g, ' ').slice(0, 120)}`)
  },
})

/**
 * 跑门禁：调 gitloop 拿一条"能不能合"的判定。
 *
 * 为什么是外部进程而不是 import 过来：**判定不该由被判定的人执行**，也不该和它共用一个进程。
 * 而且这样换一个验证器（客户的 CI、他们自己的平台）只要换这条命令，内核一行不用改。
 *
 * `SAM_VERIFY_CMD` 可以换掉它。给空字符串意思是"不验"——那就回到只信 Worker 自述，
 * 这是明确的选择，不是默认。
 */
async function runGitloop(workspace: string): Promise<VerifyReport> {
  const json = await execJson(
    process.execPath,
    [
      VERIFY_BIN,
      '--repo',
      workspace,
      '--base',
      'HEAD',
      '--json',
      ...(VERIFY_COMMAND.length === 0 ? [] : ['--command', VERIFY_COMMAND]),
    ],
    workspace,
  )
  const report = json as {
    outcome?: { verdict?: string; passed?: number; failed?: number; failures?: string[] }
    impact?: { tests?: string[] }
  }
  const outcome = report.outcome ?? {}
  return {
    verdict: outcome.verdict ?? 'UNKNOWN',
    tests: report.impact?.tests?.length ?? 0,
    ...(typeof outcome.passed === 'number' ? { passed: outcome.passed } : {}),
    ...(typeof outcome.failed === 'number' ? { failed: outcome.failed } : {}),
    ...(Array.isArray(outcome.failures) ? { failures: outcome.failures } : {}),
  }
}

/** 跑一条命令并解析 JSON。非零退出码是正常的（gitloop 用退出码表达"不能合"）。 */
function execJson(command: string, args: readonly string[], cwd: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    execFile(command, [...args], { cwd, encoding: 'utf8', timeout: 300_000, maxBuffer: 32 * 1024 * 1024 }, (error, stdout) => {
      if (stdout !== undefined && stdout.trim().length > 0) {
        try {
          resolve(JSON.parse(stdout))
          return
        } catch {
          // 掉到下面统一报错
        }
      }
      reject(new Error(error?.message?.slice(0, 200) ?? '验证器没有输出'))
    })
  })
}

// 正常情况到不了这里（没有 maxTicks，循环是无限的）。
// 到了就说明循环退出了——把数打出来，别静默结束。
log(
  `循环结束：Router 决策 ${stats.routerDecisions} 条 / 模型调用 ${stats.routerCalls} 次 / ` +
    `派 Worker ${stats.workersSpawned} 个 / 直通 ${stats.directDeliveries} 次 / ` +
    `Fast Path 拦了 ${stats.fastPathBlocked} 条`,
)
