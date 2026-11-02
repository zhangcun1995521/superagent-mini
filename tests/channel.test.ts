/**
 * 信道规范的纯函数测试：发到 IM 的话，形状由代码保证。
 *
 * 这里不测 Router 说了什么（那是模型的事），只测"不管它说什么，
 * 出门的那一句一定满足这几条"。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { IM_LIMIT, shapeReply } from '../src/channel.ts'

test('短话原样通过', () => {
  const shaped = shapeReply('干完了，两个文件的边界都补上了。')
  assert.equal(shaped.text, '干完了，两个文件的边界都补上了。')
  assert.equal(shaped.archivePath, undefined, '没截断就不该存档')
})

test('内部信封被剥掉——用户不需要知道"worker 还是 feishu"', () => {
  const shaped = shapeReply('[worker] w-fb76ce2b: 执行者报错：找不到文件')
  assert.equal(shaped.text, '执行者报错：找不到文件')

  const incoming = shapeReply('[feishu] ou_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx: 在的，什么事')
  assert.equal(incoming.text, '在的，什么事')
})

test('空白被压平：行尾空格、三行以上的空行', () => {
  const shaped = shapeReply('第一行   \n\n\n\n第二行\t\n')
  assert.equal(shaped.text, '第一行\n\n第二行')
})

test('空话压完是空串——调用方必须据此不发', () => {
  assert.equal(shapeReply('   \n\n\t  ').text, '')
  assert.equal(shapeReply('[worker] w-abc12345:   ').text, '')
})

test('超长就截断，全文存档，消息里带上路径和字数', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sam-channel-'))
  try {
    // 造一段有自然分段的超长报告。
    const long = Array.from({ length: 40 }, (_, i) => `## 第 ${i + 1} 段\n这一段说的是第 ${i + 1} 个问题。`).join('\n')
    assert.ok(long.length > IM_LIMIT)

    const shaped = shapeReply(long, { archiveDir: dir })
    assert.ok(shaped.text.length < long.length, '发出去的必须比原文短')
    assert.match(shaped.text, /已截断/)
    assert.match(shaped.text, new RegExp(`共 ${long.length} 字`))

    assert.ok(shaped.archivePath !== undefined, '超长必须存档')
    assert.equal(readFileSync(String(shaped.archivePath), 'utf8'), long, '存档的必须是全文，不是截断版')

    // 截断点落在换行上：不该把一句话切成两半。
    const head = shaped.text.split('\n\n（共')[0] ?? ''
    assert.ok(long.startsWith(head), '截断后剩下的必须是原文的前缀')
    assert.ok(head.endsWith('。'), `截断点应落在句末，实际结尾是：${JSON.stringify(head.slice(-10))}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('存档目录不可写时不假装存下来了', () => {
  const long = 'x'.repeat(IM_LIMIT + 50)
  // 用一个不存在的盘符当目录：写不了。
  const shaped = shapeReply(long, { archiveDir: 'Z:/definitely-not-a-dir/replies' })
  assert.match(shaped.text, /未存档/)
  assert.equal(shaped.archivePath, undefined)
})

test('句子中间的worker id也要清掉——模型会在主语位置复述它', () => {
  const shaped = shapeReply('w-d2 报告已给 IM_LIMIT 加环境变量配置，但门禁未检测到任何改动。')
  assert.equal(shaped.text, '执行者 报告已给 IM_LIMIT 加环境变量配置，但门禁未检测到任何改动。')
  assert.doesNotMatch(shaped.text, /w-d2/)
})

test('会话名（worker-w-xxx-yyy）也不该露出去', () => {
  const shaped = shapeReply('worker-w-fb76ce2b-ee23e68b 超时了')
  assert.equal(shaped.text, '执行者 超时了')
})
