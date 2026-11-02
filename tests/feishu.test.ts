/**
 * 飞书源的纯逻辑：哪些消息进来、字段怎么映射。
 *
 * 不测网络（lark-cli 是子进程，测它是测 CLI 不是测我们）；
 * 测的是「一条原始消息 → 一个 Trigger」这条映射，以及从它派生的三个边界。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { chatIdOf, toTrigger } from '../src/feishu.ts'

const CHAT = 'oc_demo_chat_0000000000000000'

/** 一条张存发的普通文本消息（形状照抄真实返回）。 */
function userMessage(overrides: Record<string, unknown> = {}): Parameters<typeof toTrigger>[0] {
  return {
    message_id: 'om_x100b6101b04998a4dd5bb52aec4c202',
    chat_id: CHAT,
    content: '/task 给 whyEmpty 加一个边界',
    create_time: '2026-10-29 22:58',
    deleted: false,
    msg_type: 'text',
    sender: { id: 'ou_demo_user_0000000000000000', id_type: 'open_id', sender_type: 'user', name: '张存' },
    ...overrides,
  }
}

test('用户消息映射成 Trigger：id 带源前缀、threadKey 到群', () => {
  const trigger = toTrigger(userMessage(), CHAT)
  assert.equal(trigger?.id, 'feishu:om_x100b6101b04998a4dd5bb52aec4c202')
  assert.equal(trigger?.source, 'feishu')
  assert.equal(trigger?.threadKey, `feishu:chat:${CHAT}`)
  assert.equal(trigger?.kind, 'message')
  assert.equal(trigger?.actor, 'ou_demo_user_0000000000000000')
  assert.equal(trigger?.payload, '/task 给 whyEmpty 加一个边界')
})

test('机器人自己的消息不进内核——否则回话会触发回话', () => {
  const bot = userMessage({ sender: { id: 'cli_aa9ac177bf389cd9', sender_type: 'app', name: 'Vex' } })
  assert.equal(toTrigger(bot, CHAT), undefined)
})

test('删掉的消息、没有 id 的消息都不进内核', () => {
  assert.equal(toTrigger(userMessage({ deleted: true }), CHAT), undefined)
  assert.equal(toTrigger(userMessage({ message_id: '' }), CHAT), undefined)
})

test('create_time 没有时区，按本地时间解析；解析不了就用现在', () => {
  const trigger = toTrigger(userMessage({ create_time: '2026-10-29 22:58' }), CHAT)
  const at = new Date(String(trigger?.at))
  // 本地时间构造 → 这几个字段必须原样回来。如果按 UTC 解析，小时数会偏 8。
  assert.equal(at.getFullYear(), 2026)
  assert.equal(at.getMonth(), 9)
  assert.equal(at.getDate(), 29)
  assert.equal(at.getHours(), 22)
  assert.equal(at.getMinutes(), 58)

  const broken = toTrigger(userMessage({ create_time: '不知道' }), CHAT)
  assert.ok(Number.isFinite(Date.parse(String(broken?.at))))
})

test('非文本消息不丢也不假装是文本', () => {
  const file = userMessage({ msg_type: 'file', content: '<file key="file_v3_0012h_1fa4d3ec" />' })
  const trigger = toTrigger(file, CHAT)
  assert.equal(trigger?.kind, 'file')
  assert.match(String(trigger?.payload), /未解析/)
  assert.match(String(trigger?.payload), /file_v3_0012h_1fa4d3ec/)
})

test('threadKey 反解出 chatId；不是飞书的不硬猜', () => {
  assert.equal(chatIdOf(`feishu:chat:${CHAT}`), CHAT)
  assert.equal(chatIdOf('github:pr:owner/repo:42'), undefined)
  assert.equal(chatIdOf('feishu:chat:'), undefined)
})
