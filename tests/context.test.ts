/**
 * Inline & Spill 的验收用例。
 *
 * 两条核心主张，各验一条：
 *   1. **窗口里的东西有上限**——长内容不会原样塞进去（浪费窗口就是浪费智能）
 *   2. **Spill 掉的内容仍然可读**——落盘文件存在、内容完整、路径出现在窗口里
 *      （否则"省了窗口"就变成"丢了信息"）
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { SpillStore, assembleContext } from '../src/context.ts'
import type { Trigger } from '../src/model.ts'

const trigger = (payload: string, id = 't1'): Trigger => ({
  id,
  source: 'feishu',
  threadKey: 'feishu:chat:1',
  kind: 'message',
  payload,
  at: '2026-11-01T10:00:00Z',
  actor: 'ou_user',
})

test('短消息直接内联，不产生 spill', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sam-ctx-'))
  try {
    const spills = new SpillStore(dir)
    const assembled = assembleContext(trigger('帮我看看这个超时'), [], spills)
    assert.match(assembled.inline, /帮我看看这个超时/)
    assert.equal(assembled.spillFiles.length, 0, '短消息没有溢出')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('长消息只内联摘要，全文落盘且路径出现在窗口里', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sam-ctx-'))
  try {
    const spills = new SpillStore(dir)
    const long = `开头标记\n${'中间内容'.repeat(200)}\n结尾标记`
    const assembled = assembleContext(trigger(long), [], spills)

    // 1) 窗口里有上限：原文长度远大于窗口里那段
    assert.ok(assembled.inline.length < long.length / 2, '窗口内容必须明显短于原文')
    assert.ok(!assembled.inline.includes('中间内容'.repeat(50)), '正文不该整段出现在窗口里')

    // 2) 但信息没丢：文件在、路径在窗口里、内容完整
    assert.equal(assembled.spillFiles.length, 1)
    const file = assembled.spillFiles[0] ?? ''
    assert.ok(existsSync(file), '落盘文件必须存在')
    assert.match(assembled.inline, /完整内容：/, '窗口里要告诉模型去哪儿读')
    const stored = JSON.parse(readFileSync(file, 'utf8')) as { content: string }
    assert.equal(stored.content, long, '落盘的是全文，一个字不少')
    assert.ok(stored.content.includes('开头标记') && stored.content.includes('结尾标记'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Thread 历史：窗口只留摘要，全文另存一份，并带下一跳引用', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sam-ctx-'))
  try {
    const spills = new SpillStore(dir)
    const history = ['第一条很长的历史'.repeat(30), '第二条历史'.repeat(30)]
    const assembled = assembleContext(trigger('现在这条'), history, spills)

    assert.match(assembled.inline, /本话题最近的讨论/)
    assert.ok(assembled.spillFiles.length >= 1, '历史全文要落盘')
    const threadFile = assembled.spillFiles.find((file) => file.includes('thread'))
    assert.ok(threadFile !== undefined, '应该有一份 Thread 全文')
    const stored = JSON.parse(readFileSync(threadFile, 'utf8')) as { content: string; nextRefs: string[] }
    assert.ok(stored.content.includes('第一条'), '历史全文完整')
    // 链式召回：条目里带下一跳，模型可以顺着引用图一跳一跳找回去。
    assert.deepEqual(stored.nextRefs, ['feishu:chat:1'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
