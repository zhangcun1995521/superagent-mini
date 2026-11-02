/**
 * 状态与持久化：所有状态在内存，每次变更追加一行 jsonl。
 *
 * 为什么 append-only 而不是覆写一个 JSON：
 *   1. 崩溃时最坏丢最后一行，不会毁掉整个状态——"持久"的第一要求
 *   2. 历史可回放：三个月后能回答"这个 Thread 当时怎么分配的"
 *   3. 两个进程同时写不会互相覆盖成半份
 *
 * 重放（replay）就是：按顺序读每一行，遇到 set/subscribe/unsubscribe/append 就照做。
 * 这和 gitloop 的账本、DeepWork 的审计是同一个形状——状态外置到文件，进程随时可杀。
 */

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Evidence, SupervisorState, Thread, Trigger, Worker } from './model.ts'

/** 一行事件。五种，别的都不许进来。 */
type Event =
  | { event: 'trigger'; trigger: Trigger }
  | { event: 'thread'; thread: Thread }
  | { event: 'subscribe'; threadKey: string; workerId: string }
  | { event: 'unsubscribe'; threadKey: string; workerId: string }
  | { event: 'worker'; worker: Worker }
  | { event: 'evidence'; evidence: Evidence }

/** 去重表的上限。超过就丢最老的——Trigger 无限涨会让内存和重放都变慢。 */
const SEEN_LIMIT = 5000

/** 新建一份空状态。 */
export function emptyState(): SupervisorState {
  return {
    seenTriggerIds: [],
    threads: new Map(),
    workers: new Map(),
    evidence: [],
  }
}

/**
 * 从 jsonl 重放状态。
 *
 * @param path - 状态文件路径。
 * @returns 恢复后的状态。文件不存在就是空状态（第一次启动的正常情况）。
 */
export function replay(path: string): SupervisorState {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    const code = (error as { code?: unknown }).code
    if (code === 'ENOENT') return emptyState()
    throw error
  }

  const state = emptyState()
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue
    let event: Event
    try {
      event = JSON.parse(line) as Event
    } catch {
      // 半行是崩溃留下的。丢一行事件，不丢整个状态。
      continue
    }
    // JSON 里 Set 变成了数组，读回来必须还原成 Set——否则下一次 .add() 就炸。
    // 这是持久化最容易漏的一步：写的时候记得展开，读的时候忘了还原。
    if (event.event === 'thread') {
      event.thread.subscribers = new Set([...(event.thread.subscribers as unknown as Iterable<string>)])
    }
    if (event.event === 'worker') {
      event.worker.threads = new Set([...(event.worker.threads as unknown as Iterable<string>)])
    }
    apply(state, event)
  }
  return state
}

/** 把一条事件施加到状态上。replay 和实时写共用这一个函数——否则两边会漂移。 */
function apply(state: SupervisorState, event: Event): void {
  switch (event.event) {
    case 'trigger': {
      // 去重。重复的 Trigger 只计数不重复入队——这是"幂等"的实现。
      if (!state.seenTriggerIds.includes(event.trigger.id)) {
        state.seenTriggerIds.push(event.trigger.id)
        if (state.seenTriggerIds.length > SEEN_LIMIT) state.seenTriggerIds.shift()
      }
      break
    }
    case 'thread': {
      // Set 序列化成数组存，读回来还原。
      state.threads.set(event.thread.key, event.thread)
      break
    }
    case 'subscribe': {
      const thread = state.threads.get(event.threadKey)
      if (thread !== undefined) thread.subscribers.add(event.workerId)
      break
    }
    case 'unsubscribe': {
      const thread = state.threads.get(event.threadKey)
      if (thread !== undefined) thread.subscribers.delete(event.workerId)
      break
    }
    case 'worker': {
      state.workers.set(event.worker.id, event.worker)
      break
    }
    case 'evidence': {
      state.evidence.push(event.evidence)
      break
    }
  }
}

/** 状态仓库：写内存 + 追加文件，读直接看内存。 */
export interface Store {
  /** 当前状态（可变引用，读它就是读现在）。 */
  readonly state: SupervisorState
  /** 记一条 Trigger（去重后返回 false 表示重复，调用方不处理）。 */
  recordTrigger(trigger: Trigger): boolean
  /** 建或更新一个 Thread。 */
  putThread(thread: Thread): void
  /** 订阅 / 取消订阅。 */
  subscribe(threadKey: string, workerId: string): void
  unsubscribe(threadKey: string, workerId: string): void
  /** 建或更新一个 Worker。 */
  putWorker(worker: Worker): void
  /** 追加一条证据。 */
  appendEvidence(evidence: Evidence): void
}

/**
 * 打开一个状态仓库。
 *
 * @param dir - 状态目录（state/）。文件是 dir/state.jsonl。
 * @param fresh - 测试用：true 则不读旧文件，从空开始。
 */
export function openStore(dir: string, fresh = false): Store {
  const path = join(dir, 'state.jsonl')
  const state = fresh ? emptyState() : replay(path)
  mkdirSync(dir, { recursive: true })

  const write = (event: Event): void => {
    appendFileSync(path, `${JSON.stringify(serialize(event))}\n`, 'utf8')
    apply(state, event)
  }

  /**
   * Set 在 JSON.stringify 里变成 {}。序列化前要展开成数组，反序列化时再还原——
   * 两头都要做，漏了任何一头，重放出来的就不是同一个状态。
   */
  const serialize = (event: Event): Record<string, unknown> => {
    if (event.event === 'thread') {
      return { ...event, thread: { ...event.thread, subscribers: [...event.thread.subscribers] } }
    }
    if (event.event === 'worker') {
      return { ...event, worker: { ...event.worker, threads: [...event.worker.threads] } }
    }
    return event as unknown as Record<string, unknown>
  }

  return {
    state,
    recordTrigger(trigger) {
      if (state.seenTriggerIds.includes(trigger.id)) return false
      state.seenTriggerIds.push(trigger.id)
      if (state.seenTriggerIds.length > SEEN_LIMIT) state.seenTriggerIds.shift()
      write({ event: 'trigger', trigger })
      return true
    },
    putThread(thread) {
      write({ event: 'thread', thread })
    },
    subscribe(threadKey, workerId) {
      write({ event: 'subscribe', threadKey, workerId })
    },
    unsubscribe(threadKey, workerId) {
      write({ event: 'unsubscribe', threadKey, workerId })
    },
    putWorker(worker) {
      write({ event: 'worker', worker })
    },
    appendEvidence(evidence) {
      write({ event: 'evidence', evidence })
    },
  }
}
