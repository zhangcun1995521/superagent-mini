/**
 * 治理策略的纯函数测试。
 *
 * 这里只测"判断该怎么处理"，不测 IO。真正跑起来的验证在 supervisor 的测试里。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { gate, isConfirmation, normalizeRisk, summarizeTask, suspectContradiction } from '../src/policy.ts'

test('只有不可逆的才拦——什么都问等于没问', () => {
  assert.equal(gate('read', '看看这个文件').kind, 'go')
  assert.equal(gate('write', '修一下这个 bug').kind, 'go')

  const irreversible = gate('irreversible', '删掉 src/filter.test.ts')
  assert.equal(irreversible.kind, 'confirm')
  if (irreversible.kind === 'confirm') {
    assert.match(irreversible.question, /不可逆/)
    assert.match(irreversible.question, /确认/)
    assert.match(irreversible.question, /删掉 src\/filter\.test\.ts/, '确认提示里要让人认出是什么活')
  }
})

test('模型给了看不懂的风险值，退回默认档，不猜', () => {
  assert.equal(normalizeRisk('read'), 'read')
  assert.equal(normalizeRisk('irreversible'), 'irreversible')
  // 缺省和非法都按 write：漏标一次的风险，比把可逆的错判成可逆更小。
  assert.equal(normalizeRisk(undefined), 'write')
  assert.equal(normalizeRisk('dangerous'), 'write')
  assert.equal(normalizeRisk(42), 'write')
})

test('确认只认"确认"两个字，随口一句不算', () => {
  assert.equal(isConfirmation('确认'), true)
  assert.equal(isConfirmation('  确认。 '), true)
  assert.equal(isConfirmation('确认一下'), false, '带别的字就不是纯确认')
  assert.equal(isConfirmation('我确认过了吧'), false, '聊天里随口一句不能变成执行指令')
  assert.equal(isConfirmation('好的'), false)
  assert.equal(isConfirmation(''), false)
})

test('确认提示里的任务摘要不能太长', () => {
  const long =
    '把这个目录下所有三个月前的临时文件都删掉，包括那些名字里带 tmp 的、以及 logs 目录下以 .bak 结尾的旧备份文件，删之前先确认没有别的进程在写它们，删完把结果列出来'
  assert.ok(long.length > 80, '样例本身要够长才有意义')
  const summary = summarizeTask(long)
  assert.ok(summary.length <= 81, `摘要太长：${summary.length}`)
  assert.ok(summary.endsWith('…'))
})

test('汇报说没改、工作区却在变——这是要挑出来给人看的那种', () => {
  const changed = ['src/filter.ts', 'tests/filter.test.ts']

  const contradiction = suspectContradiction('whyEmpty 不在当前工作目录，我没有创建任何替代函数、没有改任何文件。', changed)
  assert.ok(contradiction !== undefined, '说了没改但确实改了，必须标出来')
  assert.match(String(contradiction), /疑似|称没有改动/)
  assert.match(String(contradiction), /src\/filter\.ts/)

  // 没改就没矛盾
  assert.equal(suspectContradiction('我没有改任何文件。', []), undefined)
  // 改了就直说，不算矛盾
  assert.equal(suspectContradiction('改了 2 个文件，补了边界。', changed), undefined)
})

test('汇报说不确定（不是断言没改）时不要冤枉它', () => {
  // 这是有意放松的：只抓"明确声称没动过"。说是猜测的一律不标。
  const changed = ['src/a.ts']
  assert.equal(suspectContradiction('不确定有没有改到，你看一下 diff', changed), undefined)
})
