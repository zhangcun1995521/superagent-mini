/**
 * 信道规范：**发到 IM 的话，形状由代码保证，不靠提示词求模型。**
 *
 * 起因是真实日志里两件事：
 *
 * 1. Worker 的结论经常是几千字（它真的读了代码、列了问题）。群里塞不下，
 *    也不该塞——IM 是"叫你一声"的通道，不是放报告的通道。
 * 2. 我们把自己的信封原样往外发：`[worker] w-fb76ce2b: …` 里那个 id 是内部调度用的，
 *    用户既不认识也不需要。
 *
 * 所以这里做三件事，全是确定性的、可测的：
 *   - **剥掉内部代号**：`[worker] w-ab12cd34: ...` 是我们给他看的信封，不是内容
 *   - **压成一段**：连续空行、行尾空格，在 IM 里全是噪音
 *   - **超长就截断，全文另行存档**：截断处尽量落在换行或句号上，别把话切一半
 *
 * 提示词里也会说"简短"，但那是一次建议；这里是拒绝——两件事都要有。
 *
 * **这个文件不管"话是怎么生成的"。** 另一类问题——把「20000ms 未返回」这种实现细节
 * 说给用户——源头是喂给模型的输入里就有毫秒数和会话 id，那个修在 `supervisor.ts`
 * 的失败分支（给模型人话，细节进日志）。"形状"和"内容"分开修，别指望一层能同时管两件。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** IM 一条消息的字数上限。文章的说法是"IM 侧重低打扰，单次回复不超过 100 词"。 */
export const IM_LIMIT = 400

/** 整形后的回话。 */
export interface ShapedReply {
  /** 要发到 IM 的文本。**空串表示"这条不该发"**——调用方必须处理，不能发个空消息出去。 */
  text: string
  /** 被截断时，完整内容存到了这里（方便人去看，不是给模型读的）。 */
  archivePath?: string
}

/**
 * 把一段模型生成的文本整形为"可以发到 IM 的一句话"。
 *
 * @param raw - Router 给的回话原文。
 * @param options - 上限、存档目录、当前时间（都可注入，为了能测）。
 */
export function shapeReply(
  raw: string,
  options: { limit?: number; archiveDir?: string; now?: Date } = {},
): ShapedReply {
  const limit = options.limit ?? IM_LIMIT
  const text = normalize(raw)
  if (text.length === 0) return { text: '' }
  if (text.length <= limit) return { text }

  const head = cutPoint(text, limit)
  const archivePath = archive(text, options.archiveDir, options.now ?? new Date())
  const note = `\n\n（共 ${text.length} 字，已截断；全文：${archivePath ?? '未存档'}）`
  return { text: `${head}${note}`, ...(archivePath === undefined ? {} : { archivePath }) }
}

/**
 * 剥信封、去掉内部 id、压空白。
 *
 * 信封长这样：`[worker] w-fb76ce2b: 执行者报错：…`——方括号是来源，冒号前是主体 id。
 * 这是我们内部的说法，用户不需要知道"worker 还是 feishu"。
 *
 * **光剥开头的信封不够**：实测发现模型会在句子中间复述它，比如
 * "w-d2 报告已给 IM_LIMIT 加环境变量配置，但门禁未检测到任何改动"——
 * 开头的信封早就没了，id 还留在主语位置上。所以这里按形状把内部 id 也清掉：
 * `w-` 加一串十六进制是 worker 的，`worker-w-…` 是它的会话名，两者都不是人话。
 */
function normalize(raw: string): string {
  const withoutEnvelope = raw.replace(/^\[[^\]]*\]\s*[^\s:]*:\s*/, '')
  return withoutEnvelope
    .replace(/\bworker-w-[0-9a-z-]+/gi, '执行者') // 会话名：worker-w-ab12cd34-ee23
    .replace(/\bw-[0-9a-f]{2,12}\b/gi, '执行者') // worker id：w-fb76ce2b / w-d2
    .replace(/执行者\s*执行者/g, '执行者') // 清完可能重复
    .replace(/\r\n/g, '\n') // Windows 换行统一
    .replace(/[ \t]+$/gm, '') // 行尾空格
    .replace(/\n{3,}/g, '\n\n') // 三行以上的空行压成一行空行
    .trim()
}

/**
 * 找截断点。
 *
 * 硬切会把一句话切成两半，读起来像掉帧。所以先看 `limit` 以内最后一个换行或句号，
 * 只要它没退到太前面（超过 60%）就用它；否则老实硬切。
 */
function cutPoint(text: string, limit: number): string {
  const window = text.slice(0, limit)
  const floor = Math.floor(limit * 0.6)
  for (const marker of ['\n', '。', '！', '？', '. ']) {
    const at = window.lastIndexOf(marker)
    if (at > floor) return window.slice(0, at).trimEnd()
  }
  return window.trimEnd()
}

/**
 * 全文存档。
 *
 * 存成 `.md` 而不是 JSON：这份东西的读者是人（回去看"它当时到底说了什么"），
 * 不是模型。和 Inline & Spill 那份 spill 是两回事——那是给 Worker 读的上下文，
 * 这是给人看的话。生命周期和读者都不一样，所以不共用一套。
 */
function archive(text: string, dir: string | undefined, now: Date): string | undefined {
  if (dir === undefined) return undefined
  try {
    mkdirSync(dir, { recursive: true })
    const name = `reply-${now.toISOString().replace(/[:.]/g, '-')}.md`
    const path = join(dir, name)
    writeFileSync(path, text, 'utf8')
    return path
  } catch {
    // 存档失败不能让回话失败。上面的 note 会写"未存档"，人至少知道全文没留下。
    return undefined
  }
}
