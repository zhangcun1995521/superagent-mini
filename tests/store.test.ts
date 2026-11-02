/**
 * 状态仓库的验收用例。
 *
 * 核心是两条：
 *   1. 写进去的，重放后原样回来（Set 也是 Set，不是数组）
 *   2. 进程死了（我们模拟：关掉 store 重开），状态还在
 *
 * 第二条就是"持久"的全部含义：不是云，是"杀不死的部分已经在文件里了"。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { openStore, replay } from '../src/store.ts'
import type { Trigger } from '../src/model.ts'

const TRIGGER: Trigger = {
  id: 'msg-001',
  source: 'feishu',
  threadKey: 'feishu:chat:oc_1',
  kind: 'message',
  payload: '帮我修超时问题',
  at: '2026-11-01T10:00:00Z',
  actor: 'ou_user1',
}

test('写进去的，重放后原样回来（Set 也是 Set）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sam-'))
  try {
    const store = openStore(dir, true)
    store.recordTrigger(TRIGGER)
    store.putThread({ key: 'feishu:chat:oc_1', subscribers: new Set(), lastActiveAt: TRIGGER.at })
    store.putWorker({ id: 'w1', sessionId: 'worker-001', threads: new Set(['feishu:chat:oc_1']), status: 'idle', startedAt: TRIGGER.at, reports: [] })
    store.subscribe('feishu:chat:oc_1', 'w1')
    store.appendEvidence({ id: 'e1', workerId: 'w1', action: 'push', basis: ['msg-001'], verdict: 'PASS', at: TRIGGER.at })

    // 关掉（模拟进程死），重开
    const reopened = replay(join(dir, 'state.jsonl'))
    assert.equal(reopened.seenTriggerIds.length, 1)
    assert.ok(reopened.threads.get('feishu:chat:oc_1')?.subscribers instanceof Set, 'subscribers 必须是 Set，不能是数组')
    assert.ok(reopened.threads.get('feishu:chat:oc_1')?.subscribers.has('w1'), '订阅关系要活过来')
    assert.ok(reopened.workers.get('w1')?.threads instanceof Set, 'threads 必须是 Set')
    assert.equal(reopened.evidence.length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('重复 Trigger 被去重，不重复入队', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sam-'))
  try {
    const store = openStore(dir, true)
    assert.equal(store.recordTrigger(TRIGGER), true, '第一次要进')
    assert.equal(store.recordTrigger(TRIGGER), false, '重复的要拒')
    assert.equal(store.recordTrigger({ ...TRIGGER, id: 'msg-002' }), true, '不同 id 要进')
    assert.equal(store.state.seenTriggerIds.length, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('崩溃留下的半行不毁掉整个状态', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sam-'))
  try {
    const store = openStore(dir, true)
    store.recordTrigger(TRIGGER)
    // 模拟崩溃：手动追加半行 JSON
    appendFileSync(join(dir, 'state.jsonl'), '{"event":"trig', 'utf8')
    const reopened = replay(join(dir, 'state.jsonl'))
    assert.equal(reopened.seenTriggerIds.length, 1, '好行保留，坏行丢弃')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
