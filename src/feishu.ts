/**
 * 飞书事件源：把群里的消息变成 Trigger。
 *
 * 之前 supervisor 的事件只能靠 `node src/demo.ts "..."` 手动喂（options.inject）。
 * 接上这个文件之后，事件是**别人在群里说话**——循环才算真的转起来。
 *
 * 三个刻意的选择：
 *
 * 1. **源是无状态的**。每轮都重新拉「最新 N 条」，不管处理过没有。
 *    为什么可以这么笨：去重做在消费端（store.seenTriggerIds，而且落盘）。
 *    如果改成在源里记 cursor（"上次处理到哪条"），重启就丢 cursor → 重复执行任务。
 *    做在消费端，重启不丢。**幂等放在消费端，源端就可以无脑重放。**
 *
 * 2. **源只报告事实，不执行政策**。sender_type==='user' 是 API 给的字段（事实），
 *    所以这里过滤掉机器人自己的消息——否则机器人回话又触发自己，死循环。
 *    但"谁的话才值得理"是政策，留在 filterRules 里。两者混在一起，规则就查不清了。
 *
 * 3. **轮询而不是事件订阅**。这个飞书 app 已经有别的事件总线连着（一个 app 只有一个），
 *    轮询只要出站网络。区别要能说清：订阅是平台推、实时；轮询是自己拉、有延迟但部署简单。
 */

import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Trigger } from './model.ts'
import type { TriggerSource } from './supervisor.ts'

/**
 * lark-cli 可执行文件。
 *
 * Windows 上 npm 全局装的是 `lark-cli.cmd` 包装，**必须带 `shell: true` 才能 spawn**；
 * Linux 上就是 PATH 里的 `lark-cli`，不需要 shell。所以这里默认不写死，
 * 交给 `SAM_LARK_BIN` 覆盖——上云时第一件要改的就是它。
 */
const LARK = process.env['SAM_LARK_BIN'] ?? (process.platform === 'win32' ? 'lark-cli.cmd' : 'lark-cli')

/**
 * 飞书时间字符串的时区基准。
 *
 * 国内版飞书给的是东八区本地时间。写死成常量而不是取"本机时区"，
 * 是为了让同一份代码在 UTC 服务器上解析结果完全一样（详见 `isoOf`）。
 */
const FEISHU_UTC_OFFSET = '+08:00'

/** 一次拉多少条。50 是接口给的默认页大小，5 秒一轮根本用不完。 */
const PAGE_SIZE = 50

/** 飞书返回的原始消息形状（只列我们读的字段）。 */
export interface RawMessage {
  message_id?: string
  chat_id?: string
  msg_type?: string
  content?: string
  /** 形如 "2026-10-29 23:07"，**没有时区**，且只到分钟。 */
  create_time?: string
  deleted?: boolean
  sender?: {
    id?: string
    id_type?: string
    sender_type?: string
    name?: string
  }
}

/** 群消息源。 */
export interface FeishuSourceOptions {
  chatId: string
  /**
   * 只产出这个时间点之后的消息（ISO）。
   *
   * 为什么需要它：**去重解决的是"重复处理"，不是"首次全量历史"。**
   * 一个群里有 50 条历史消息，第一次启动如果全放进来，就会对着
   * "哈喽在吗"这种半年前的话派 Worker——每条都是一次真金白银的模型往返。
   * 所以首次启动要画一条水位线：此刻之前的，当作"已经发生过的历史"，不回溯。
   *
   * 不传 = 不设水位线（测试和补数据时用）。
   */
  since?: string
}

/**
 * 轮询一个群，把用户发的消息变成 Trigger。
 *
 * @param options - 群 id。
 * @returns 一个 TriggerSource，直接塞给 runSupervisor 的 sources。
 */
export function feishuSource(options: FeishuSourceOptions): TriggerSource {
  return {
    name: `feishu:${options.chatId}`,
    async poll() {
      let data: { data?: { messages?: RawMessage[] } }
      try {
        data = (await runLark([
          'im',
          '+chat-messages-list',
          '--as',
          'bot',
          '--chat-id',
          options.chatId,
          '--order',
          'desc',
        ])) as { data?: { messages?: RawMessage[] } }
      } catch (error) {
        // **轮询失败不能杀掉常驻进程**：网络抖一下、CLI 慢一次，都只是"这一轮没拿到"。
        // 但必须打出来——静默吞掉的话，看起来像"没人说话"，实际是收不到。
        // 这和 gitloop 里"不吞错"的原则不冲突：不吞 = 留下痕迹，不是 = 必须崩。
        console.error(`[feishu] 轮询失败，本轮当作空：${(error as Error).message.slice(0, 300)}`)
        return []
      }

      const triggers: Trigger[] = []
      for (const message of data.data?.messages ?? []) {
        const trigger = toTrigger(message, options.chatId)
        if (trigger === undefined) continue
        if (options.since !== undefined && trigger.at < options.since) continue
        triggers.push(trigger)
      }

      // 倒序 → 正序。接口给的是最新在前；按发生顺序喂给 Router，
      // 它读历史才是顺着时间的（"刚才说了 A，现在说 B"）。
      return triggers.reverse()
    },
  }
}

/**
 * 一条原始消息 → 一个 Trigger。返回 undefined 表示"这条不该进内核"。
 *
 * **纯函数，单独拎出来是为了能测**：网络调用（lark-cli）不好测，
 * 但"哪些消息该进来、字段怎么映射"是可以一条条断言的事实。
 * 把纯逻辑和 IO 分开，测的部分就不需要 mock 子进程。
 */
export function toTrigger(message: RawMessage, chatId: string): Trigger | undefined {
  if (message.deleted === true) return undefined
  // 事实层面的过滤：机器人自己的消息不进来。这不是"政策"——
  // app 发的消息进来必然导致"回话→触发→回话"，和过滤规则配得好不好无关。
  if (message.sender?.sender_type !== 'user') return undefined

  const id = message.message_id
  if (id === undefined || id.length === 0) return undefined

  return {
    // 加前缀是为了全局唯一：别的源也可能用 message_id 这种命名。
    id: `feishu:${id}`,
    source: 'feishu',
    // 粒度是「群」，不是「话题」。话题群要把 root_id 拼进来，现在没做——
    // 代价是同一群里两个不相干的话题会被当成一个 Thread（会互相带进上下文）。
    threadKey: `feishu:chat:${chatId}`,
    kind: message.msg_type === undefined ? 'message' : KIND_OF[message.msg_type] ?? message.msg_type,
    payload: textOf(message),
    at: isoOf(message.create_time),
    ...(message.sender?.id === undefined ? {} : { actor: message.sender.id }),
  }
}

/** 消息类型 → Trigger 的 kind。没列的用原始 msg_type。 */
const KIND_OF: Record<string, string> = {
  text: 'message',
  post: 'message',
}

/**
 * 取出正文。
 *
 * lark-cli 已经把 text/post 的 JSON 拆成了纯文本（实测：post 消息拿到的就是 markdown）。
 * 非文本消息（图片、文件）拿到的是个标记串，比如 `<file key="file_v3_..." />`——
 * 不假装它是文本，但也不能丢：有人发个日志文件，Router 至少要知道"有人发了东西"。
 */
function textOf(message: RawMessage): string {
  const content = message.content ?? ''
  if (message.msg_type === 'text' || message.msg_type === 'post' || message.msg_type === 'interactive') return content
  return `[用户发了一条 ${message.msg_type ?? '未知'} 消息，未解析] ${content.slice(0, 200)}`
}

/**
 * "2026-10-29 23:07" → ISO。
 *
 * 三个坑写在这里，免得下次又踩：
 * 1. **没有时区**。飞书给的是本地时间字符串，不带偏移。
 * 2. **不能用"本机时区"去补这个偏移**——这条是准备上云时才想明白的：
 *    本机是 UTC+8，所以按本地时间构造一直是对的；服务器默认 UTC，
 *    同一条消息会被解析成 8 小时前，水位线 `since` 一比较就把所有消息当旧的滤掉。
 *    **部署上去看着完全正常，但永远收不到消息**——最难查的那类故障。
 *    所以显式按 `+08:00` 构造（国内版飞书的时间基准），和机器在哪台、什么时区无关。
 * 3. **只到分钟**。同一分钟的多条消息 at 相同。不影响正确性（去重靠 id）。
 */
function isoOf(createTime: string | undefined): string {
  const matched = createTime === undefined ? null : /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/.exec(createTime)
  if (matched === null) return new Date().toISOString()
  const [, year, month, day, hour, minute] = matched
  // 写成带偏移的字符串交给 Date 解析：`...T23:07:00+08:00`。
  // 这样"飞书的时间基准"是代码里写死的常量，不随部署机器漂移。
  const local = new Date(`${year}-${month}-${day}T${hour}:${minute}:00${FEISHU_UTC_OFFSET}`)
  return local.toISOString()
}

/**
 * 从 threadKey 反解 chatId。
 *
 * onReply 只给 threadKey（内核不知道飞书长什么样），所以通道要自己拆回来。
 * 拆不出来返回 undefined——调用方必须处理，不能假定 threadKey 一定是飞书的。
 */
export function chatIdOf(threadKey: string): string | undefined {
  const prefix = 'feishu:chat:'
  if (!threadKey.startsWith(prefix)) return undefined
  const chatId = threadKey.slice(prefix.length)
  return chatId.length === 0 ? undefined : chatId
}

/**
 * 回一条 markdown 到群里。
 *
 * **必须走 `@文件`，不能把正文当参数传。** 实测踩到的坑：Windows 上 spawn 一个 `.cmd` 必须带
 * `shell: true`，而 shell 会把参数按空格重新拼接——一段带空格和换行的 markdown 到了 CLI 那里
 * 就变成了好几个位置参数，报 `positional arguments are not supported`。
 * 结果是最关键的一步（把结论送回去）静默失败，而任务本身已经跑完了。
 */
export async function feishuReply(chatId: string, markdown: string): Promise<void> {
  const dir = tmpdir()
  const file = 'superagent-reply.md'
  writeFileSync(join(dir, file), markdown, 'utf8')
  const answer = (await runLark(
    ['im', '+messages-send', '--as', 'bot', '--chat-id', chatId, '--markdown', `@${file}`],
    dir,
  )) as { ok?: boolean; error?: { message?: string } }
  if (answer.ok !== true) throw new Error(`发消息失败：${answer.error?.message ?? '未知原因'}`)
}

/** lark-cli 单次调用的上限。正常 3–6 秒，超过这个数基本就是挂住了。 */
const LARK_TIMEOUT_MS = 30_000

/**
 * 调 lark-cli，返回解析后的 JSON。失败抛错，不吞。
 *
 * **异步 + 自己带看门狗**，两个都是有理由的：
 *
 * 1. 异步：原来是 `execFileSync`，一次 3–6 秒，这期间整个进程冻住——不轮询、不收 Worker 汇报、
 *    定时器也不跑。常驻进程里任何同步 IO 都是一次全局停顿，不管它多短。
 * 2. 看门狗：`execFile` 的 `timeout` 在 Windows 上不保证回调落地（子进程再派生进程、管道不关，
 *    回调就一直不来——`dsh` 那边踩过一次，这里是同一个坑）。不自己兜底，某一次轮询挂住
 *    就是永久挂住：主循环 `await` 在它上面，之后再也不会有下一轮。
 */
function runLark(args: readonly string[], cwd?: string, timeoutMs = LARK_TIMEOUT_MS): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let settled = false
    const settle = (outcome: { ok: true; value: unknown } | { ok: false; reason: Error }): void => {
      if (settled) return
      settled = true
      clearTimeout(watchdog)
      if (outcome.ok) resolve(outcome.value)
      else reject(outcome.reason)
    }

    const watchdog = setTimeout(() => {
      child.kill('SIGKILL')
      settle({ ok: false, reason: new Error(`lark-cli 超时（${timeoutMs}ms）：${args.slice(0, 2).join(' ')}`) })
    }, timeoutMs + 1000)

    const child = execFile(
      LARK,
      args,
      { encoding: 'utf8', shell: true, maxBuffer: 16 * 1024 * 1024, ...(cwd === undefined ? {} : { cwd }) },
      (error, stdout) => {
        if (error !== null) {
          settle({ ok: false, reason: new Error(`lark-cli 失败：${error.message.slice(0, 300)}`) })
          return
        }
        try {
          settle({ ok: true, value: JSON.parse(stdout) })
        } catch (parseError) {
          settle({ ok: false, reason: parseError as Error })
        }
      },
    )
  })
}
