/**
 * 事件过滤：两级，Fast Path 在这，Slow Path 在 Router 会话里。
 *
 * 文章的判断（3.1 节）："接入真实群聊后，事件流呈高噪音、低触发率。对每个事件都调大模型，
 * 延迟和算力成本都难以承受。"
 *
 * 所以第一级是**确定性代码**（Fast Path），把"明确不用理"的在调模型之前筛掉：
 *   - 来源规则：哪个源、哪种事件、哪些人，各配「响应 / 候选 / 忽略」
 *   - 同一人连续刷屏：合并为一条候选
 * 第二级（Slow Path）不在本文件——过了 Fast Path 的候选交给 Router 会话用模型判断。
 *
 * 关键取舍：**规则越简单越好**。Fast Path 的每条规则都是"我们确定永远不用理"的——
 * 不确定的一律放给模型（放错方向的代价不对称：漏掉一条工作请求比多花一次模型调用贵得多）。
 */

import type { Trigger } from './model.ts'

/** 一个源、一种事件、一个角色各自的准入级别。 */
export type Admission = 'respond' | 'candidate' | 'ignore'

/** 过滤规则。deployment 配置，不写死在代码里。 */
export interface FilterRules {
  /** 按源+种类：ci → ignore / candidate / respond。 */
  bySource?: Record<string, Admission>
  /** 这些 actor 一律忽略（机器人自己的消息不能触发自己，否则死循环）。 */
  ignoredActors?: string[]
  /** 这些 actor 的消息直接响应，不过模型判断（白名单：如主人本人）。 */
  alwaysRespondActors?: string[]
}

/** 过滤结果。 */
export interface FilterVerdict {
  admission: Admission
  /** 为什么这么判——写给人看，也写给日志。 */
  reason: string
}

/** Fast Path：确定性判断，不调模型。 */
export function fastPath(trigger: Trigger, rules: FilterRules): FilterVerdict {
  // 自己的消息不能触发自己。这条必须最先判：否则"回复→触发→回复"就死循环了。
  if (rules.ignoredActors?.includes(trigger.actor ?? '') === true) {
    return { admission: 'ignore', reason: `actor ${trigger.actor} is on the ignore list (likely the bot itself)` }
  }

  // 白名单：主人直说的事不用再过模型。
  if (rules.alwaysRespondActors?.includes(trigger.actor ?? '') === true) {
    return { admission: 'respond', reason: `actor ${trigger.actor} is on the always-respond list` }
  }

  // 按源+种类。没配的默认 candidate——不确定的交给模型，Fast Path 只筛"确定的"。
  const key = `${trigger.source}:${trigger.kind}`
  const admission = rules.bySource?.[key] ?? 'candidate'
  const reason =
    admission === 'ignore'
      ? `${key} is configured to ignore`
      : admission === 'respond'
        ? `${key} is configured to respond`
        : `${key} has no rule, defaulting to candidate (uncertainty goes to the model, not away)`
  return { admission, reason }
}
