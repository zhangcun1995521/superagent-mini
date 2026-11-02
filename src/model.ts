/**
 * 数据模型：四个对象，全部可序列化到 jsonl。
 *
 * 为什么先写这个文件：架构里所有"模块"都是围绕这四个对象转的——
 *   事件过滤是 Trigger 的闸门
 *   订阅直通是 Thread 的路由表
 *   双层是 Router 和 Worker 的分工
 *   治理是 Evidence 的义务
 * 对象清楚了，其余都是流程。
 */

/** 一次环境事件。飞书消息、GitHub 评论、CI 结果，进来都是这个形状。 */
export interface Trigger {
  /** 全局唯一，由源保证（飞书 message_id / GitHub event id）。重复的直接丢——这就是幂等。 */
  id: string
  /** 事件来自哪：feishu / github / ci / synthetic。 */
  source: string
  /** 属于哪个 Thread。由源适配器给，内核不猜边界。 */
  threadKey: string
  /** 事件的种类：message / pr_comment / ci_result / conflict。 */
  kind: string
  /** 正文。长内容会在注入时被 Spill，这里始终存全量。 */
  payload: string
  /** ISO 时间。 */
  at: string
  /** 是谁触发的（飞书 open_id / GitHub login）。Router 判断"要不要理"要看这个。 */
  actor?: string
}

/** 一个话题的事件流。同一个 PR、同一个群话题 = 一个 Thread。 */
export interface Thread {
  /** 如 feishu:chat:oc_xxx 或 github:pr:owner/repo:42。 */
  key: string
  /** 当前订阅了这个 Thread 的 Worker。直通的依据。 */
  subscribers: Set<string>
  /** 最近一次事件时间。长期无事件的 Thread 可以休眠。 */
  lastActiveAt: string
}

/** 一个 Worker：一个隔离的 DSH 会话，干一件任务。 */
export interface Worker {
  id: string
  /** DSH 的 --session-id。会话持久化由 DSH 管，我们只记名字。 */
  sessionId: string
  /** 这个 Worker 订阅的 Thread。 */
  threads: Set<string>
  /** idle：在等事件；running：在干活；done：任务结束，可回收。 */
  status: 'idle' | 'running' | 'done'
  startedAt: string
  /** 它汇报过的结论（Router 汇总后对外说）。 */
  reports: string[]
}

/** 一条证据：每个有后果的动作留一条。文章没有这层，我们补的。 */
export interface Evidence {
  id: string
  /** 谁干的（worker id）。 */
  workerId: string
  /** 干了什么（工具名 + 摘要）。 */
  action: string
  /** 凭什么（依据的 Trigger / spill 引用）。 */
  basis: string[]
  /** 结论。 */
  verdict: string
  at: string
  /**
   * Worker 落地后，工作区里相对路径发生了变化的文件。
   *
   * **这是唯一能验证"它说的和做的一致"的东西。** 提示词能教它说"我没改任何文件"，
   * 但只有 git 状态能证明这句话是真的。没有它，前面所有的"诚实汇报"都只是自我陈述。
   */
  changed?: string[]
  /**
   * 门禁结论：这次改动能不能合，以及依据。
   *
   * **对账回答"动了什么"，门禁回答"能不能合"。** 两条都要有：只有对账，你不知道改得对不对；
   * 只有门禁，你不知道它是不是偷偷动了别的地方。
   */
  gate?: string
  /**
   * 疑似"说的和做的不一致"。
   *
   * 注意用词：**疑似**。这是文本启发式（汇报里说"没改/没找到"但工作区有变化），
   * 用来把可疑的那几条挑出来给人看，不是判定谁撒谎。治理层该做的是"标记可疑"，
   * 不是"下判决"——判错的代价由人来担，那就该由人来看。
   */
  suspectContradiction?: string
}

/** 状态目录里存什么的形状。 */
export interface SupervisorState {
  /** 见过的 Trigger id，去重用。超过上限丢最老的。 */
  seenTriggerIds: string[]
  /** threadKey → Thread。 */
  threads: Map<string, Thread>
  /** workerId → Worker。 */
  workers: Map<string, Worker>
  /** 全部证据，append-only。 */
  evidence: Evidence[]
}
