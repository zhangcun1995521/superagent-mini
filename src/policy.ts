/**
 * 治理策略：**模型判断风险，代码执行策略。**
 *
 * 分工的理由很实际：
 *   - 判断"这个任务危不危险"是语义问题（"帮我看看删除逻辑对不对"不是在删东西），
 *     关键词匹配一定会误判，而模型擅长这个。
 *   - 判断之后"允不允许动手"是策略问题。策略不能交给模型——它能被一句话说服。
 *
 * 所以这个文件是纯函数：输入模型的判断，输出内核该怎么做。没有 IO、没有状态，能一条条断言。
 */

/** 一次任务的风险档。 */
export type Risk = 'read' | 'write' | 'irreversible'

/** 内核该拿这个决定怎么办。 */
export type Gate =
  /** 直接派活。 */
  | { kind: 'go' }
  /** 不派活，先找人确认；把任务挂起来等人回话。 */
  | { kind: 'confirm'; question: string }

/** 模型没标风险时按哪档处理。 */
export const DEFAULT_RISK: Risk = 'write'

/** 把模型给的风险值收成合法值。给了看不懂的东西就退回默认档——**不猜它想说什么**。 */
export function normalizeRisk(value: unknown): Risk {
  return value === 'read' || value === 'write' || value === 'irreversible' ? value : DEFAULT_RISK
}

/**
 * 一句话说清要干什么，给确认提示用。
 *
 * 只要前 80 个字：确认提示是让人**认得出这是什么活**，不是让他重读一遍需求。
 */
export function summarizeTask(task: string): string {
  const flat = task.replace(/\s+/g, ' ').trim()
  return flat.length <= 80 ? flat : `${flat.slice(0, 80)}…`
}

/**
 * 风险 → 策略。
 *
 * 只有不可逆的才拦。**这一条不能宽**：什么都要确认的 Agent 没人会用，
 * 最后人就会一路点"确认"，那时候确认等于没有——这是安全设计里最常见的死法。
 *
 * @param risk - 已经 `normalizeRisk` 过的档。
 * @param task - 任务原文，用来生成确认提示。
 */
export function gate(risk: Risk, task: string): Gate {
  if (risk !== 'irreversible') return { kind: 'go' }
  return {
    kind: 'confirm',
    question: `这个动作不可逆：${summarizeTask(task)}\n\n确认吗？回「确认」我就动手；回别的就当没这回事。`,
  }
}

/**
 * 这条消息是不是一个确认。
 *
 * **只认"确认"两个字（允许带句号、感叹号）。** 早先我还允许 `确认: xxx` 这种形式，
 * 结果 `确认一下` 也被判成确认——一个请求澄清的话变成了执行指令，而这类误触发的代价
 * 是不可逆的。所以收窄到最窄：宁可让人多打两个字，不要让他后悔一次。
 */
export function isConfirmation(text: string): boolean {
  return /^\s*确认[，,。.!！\s]*$/.test(text)
}

/** 确认的有效期。过了就作废——三天后一句"确认"不该触发一个陈旧动作。 */
export const APPROVAL_TTL_MS = 10 * 60 * 1000

/**
 * 汇报与事实对不上吗？
 *
 * 文本启发式：汇报里说"没改 / 没找到 / 未创建"，但工作区里确实有文件变了。
 * **只是疑似**，用来把可疑的挑出来给人看。判错的代价由人担，那就该由人判。
 *
 * @returns 有矛盾时返回一句人话，否则 undefined。
 */
export function suspectContradiction(report: string, changed: readonly string[]): string | undefined {
  if (changed.length === 0) return undefined
  // `(?<!有)` 是必须的：没有它，"**有没有**改到"里的"没有改"会被当成"没有改"（否定）。
  // 一个老实说"我不确定"的汇报，不该被这套机制冤枉——那是另一种不诚实。
  const claimsNoChange =
    /(?<!有)(没有|没|未)(做任何)?(修改|改动|创建|改|动)|什么都没改|not modified|no changes/i.test(report)
  if (!claimsNoChange) return undefined
  return `汇报称没有改动，但工作区里有 ${changed.length} 个文件变了：${changed.slice(0, 5).join('、')}`
}
