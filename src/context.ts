/**
 * Inline & Spill：把上下文窗口当 cache 管。
 *
 * 文章（3.3 节）："浪费上下文窗口，就是浪费模型的智能。"
 *
 * 两个操作：
 *   Inline——近期很可能用到的信息直接放进窗口（省一次工具调用）
 *   Spill ——超预算或低频的留在窗口外，窗口里只放 ref + 摘要
 *
 * 我们的实现：
 *   assembleContext(trigger, thread) 返回一个 { inline, spills } 结构：
 *   - inline：要直接放进本轮消息的文本（当前 Trigger 全文 + Thread 里最近 N 条的摘要）
 *   - spills：被 Spill 掉的内容，落盘到 state/spill/<id>.json，窗口里留一行 ref
 *
 * "链式召回"的实现：每个 spill 条目里带 nextRef（指向关联对象的 spill id）。
 * Worker 需要完整内容时调 read_spill(ref) 工具，拿到的内容又带下一跳的 ref——
 * 模型就能顺着引用图一跳一跳地找回来，而不是一次全量塞入。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Trigger } from './model.ts'

/** 一份被 Spill 掉的内容。 */
export interface SpillEntry {
  /** 全局唯一 ref，窗口里用这个指代。 */
  ref: string
  /** 完整内容。 */
  content: string
  /** 摘要——窗口里显示这一行。 */
  summary: string
  /** 下一跳：关联对象的 ref。链式召回的实现。 */
  nextRefs: string[]
}

/** 组装好的上下文。 */
export interface AssembledContext {
  /** 直接放进本轮窗口的文本。 */
  inline: string
  /** 被 Spill 的条目（已落盘），窗口里各留一行引用。 */
  spillLines: string[]
  /** 落盘文件的绝对路径，按顺序。Worker 用**它自己的**文件读取工具打开这些。 */
  spillFiles: string[]
}

/** 预算：超过这个字数的 payload 不全量 Inline，Spill 后只留摘要。 */
const INLINE_CHAR_LIMIT = 500

/** Thread 摘要里最多保留几条历史。 */
const THREAD_HISTORY = 5

/**
 * 组装一轮的上下文。
 *
 * @param trigger - 当前要处理的 Trigger。
 * @param recentPayloads - 同一 Thread 最近的 payload（不含当前），新的在前。
 * @returns 窗口内容 + spill 引用。
 */
export function assembleContext(
  trigger: Trigger,
  recentPayloads: readonly string[],
  spills?: SpillStore,
): AssembledContext {
  const parts: string[] = []
  const spillLines: string[] = []
  const spillFiles: string[] = []

  // 1) 当前 Trigger：短的全量，长的 Spill。
  if (trigger.payload.length <= INLINE_CHAR_LIMIT) {
    parts.push(`[${trigger.source}] ${trigger.actor ?? 'unknown'}: ${trigger.payload}`)
  } else {
    // 长的当前消息：窗口里只留摘要，全文落盘，给 Worker 一个路径。
    // **为什么要落盘而不是截断丢掉**：截断会让模型以为原文只有这么长；
    // 留一个路径，它可以自己决定要不要读全文——这就是 Inline & Spill 里的 Spill。
    const ref = `trigger:${trigger.id}`
    if (spills !== undefined) {
      spills.put({ ref, content: trigger.payload, summary: summarize(trigger.payload), nextRefs: [trigger.threadKey] })
      const file = spills.pathOf(ref)
      spillFiles.push(file)
      spillLines.push(`(当前消息过长，完整内容：${file})`)
    } else {
      spillLines.push(`(当前消息过长，完整内容见 spill:${ref})`)
    }
    parts.push(`[${trigger.source}] ${trigger.actor ?? 'unknown'}: ${summarize(trigger.payload)}`)
  }

  // 2) Thread 最近几条的摘要。全量 Spill，窗口里只留一行摘要——
  //    它们是"背景"，不是"当前要处理的"，所以不该占 Inline 的预算。
  if (recentPayloads.length > 0) {
    parts.push('', '--- 本话题最近的讨论 ---')
    for (const payload of recentPayloads.slice(0, THREAD_HISTORY)) {
      parts.push(summarize(payload))
    }
    const ref = `thread:${trigger.threadKey}`
    if (spills !== undefined) {
      // 历史全文也落盘：窗口里只留每条的摘要，要细节就让 Worker 自己去读。
      spills.put({
        ref,
        content: recentPayloads.join('\n\n---\n\n'),
        summary: summarize(recentPayloads.join(' / '), 200),
        nextRefs: [trigger.threadKey],
      })
      const file = spills.pathOf(ref)
      spillFiles.push(file)
      spillLines.push(`(本话题历史全文：${file})`)
    } else {
      spillLines.push(`(历史完整内容见 spill:${ref})`)
    }
  }

  // 窗口里除了 inline，还要带上"去哪儿读全文"的指引——否则模型不知道该拉哪份。
  const withRefs = spillLines.length === 0 ? parts.join('\n') : `${parts.join('\n')}\n\n${spillLines.join('\n')}`
  return { inline: withRefs, spillLines, spillFiles }
}

/** 摘要：取首尾各一半预算，中间用省略号——首尾通常比中间信息密度高。 */
function summarize(text: string, limit = 80): string {
  if (text.length <= limit) return text
  const half = Math.floor(limit / 2) - 1
  return `${text.slice(0, half)}…${text.slice(-half)}`
}

/**
 * ref → 文件名。
 *
 * 只保留字母数字和 `_-`。**冒号必须换掉**：ref 里用冒号分层（`trigger:t1` / `thread:feishu:chat:1`），
 * 而 Windows 上冒号是 NTFS 的备用数据流分隔符，不是合法文件名字符——
 * 写出来的"文件"看不见，读的时候 ENOENT。这个坑只有在 Windows 上跑才会撞到。
 */
function fileNameFor(ref: string): string {
  return `${ref.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`
}

/** Spill 仓库：落盘到文件，read_spill 工具读它。 */
export class SpillStore {
  private readonly dir: string

  constructor(stateDir: string) {
    this.dir = join(stateDir, 'spill')
    mkdirSync(this.dir, { recursive: true })
  }

  /** 某个 ref 对应的文件绝对路径。 */
  pathOf(ref: string): string {
    return join(this.dir, fileNameFor(ref))
  }

  /** 存一份，返回 ref。 */
  put(entry: SpillEntry): string {
    const file = join(this.dir, fileNameFor(entry.ref))
    writeFileSync(file, JSON.stringify(entry, null, 2), 'utf8')
    return entry.ref
  }

  /**
   * 读一份。返回的内容里带下一跳 ref——这就是"链式召回"：
   * 模型每次拿到一跳，需要更多就再调一次 read_spill。
   */
  read(ref: string): SpillEntry | undefined {
    const file = join(this.dir, fileNameFor(ref))
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as SpillEntry
    } catch {
      return undefined
    }
  }
}
