/**
 * 治理层在真实主循环里的行为。
 *
 * 判据只有两条，都很硬：
 *   1. 不可逆的动作**没有派 Worker**，而是先问人
 *   2. Worker 回来后，工作区的事实进了证据，且和它的自述对得上
 *
 * 这两条不成立的话，前面所有"它会诚实汇报"的努力都只是它的自我陈述。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import type { Trigger } from '../src/model.ts'
import { type RouterDecision, type RouterSession, type TriggerSource, type WorkerSession, runSupervisor } from '../src/supervisor.ts'

const trig = (id: string, threadKey: string, payload: string): Trigger => ({
  id,
  source: 'feishu',
  threadKey,
  kind: 'message',
  payload,
  at: '2026-11-02T10:00:00Z',
  actor: 'ou_zhangcun',
})

/** 一个按脚本回答的 Router。脚本用完之后一律 reply_only。 */
function scripted(steps: readonly RouterDecision[]): RouterSession {
  let index = 0
  return {
    decide: (contexts) =>
      Promise.resolve(
        contexts.map(() => {
          const step = steps[index]
          index += 1
          return step ?? { action: 'reply_only', reply: '（脚本用完了）' }
        }),
      ),
  }
}

test('不可逆的动作不派 Worker，先问人；回了「确认」才真的动手', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sam-gov-'))
  try {
    const said: string[] = []
    const dispatched: string[] = []

    // 一轮一事件：第一条是删除请求，第二条是确认。
    let fired = 0
    const source: TriggerSource = {
      name: 'scripted-chat',
      poll: () => {
        fired += 1
        if (fired === 1) return Promise.resolve([trig('t1', 'k1', '把那个测试文件删了')])
        if (fired === 2) return Promise.resolve([trig('t2', 'k1', '确认')])
        return Promise.resolve([])
      },
    }

    const stats = await runSupervisor({
      stateDir: dir,
      filterRules: {},
      // 第一次判成"不可逆、要删东西"，第二次（确认那条）判成要干活。
      createRouter: () =>
        scripted([
          { action: 'dispatch', task: '删掉 src/filter.test.ts', risk: 'irreversible' },
          { action: 'dispatch', task: '删掉 src/filter.test.ts', risk: 'irreversible' },
        ]),
      createWorker: (id): WorkerSession => ({
        id,
        threads: new Set<string>(),
        step: (instruction) => {
          dispatched.push(instruction)
          return Promise.resolve('删好了')
        },
      }),
      sources: [source],
      onReply: (_threadKey, text) => {
        said.push(text)
      },
      maxTicks: 12,
      intervalMs: 1,
    })

    // 第一条消息之后：问了，但没派活。
    const askedAt = said.findIndex((text) => text.includes('不可逆'))
    assert.ok(askedAt >= 0, '不可逆的动作必须先问人')
    assert.match(said[askedAt] ?? '', /src\/filter\.test\.ts/, '要让人认出删的是哪个文件')

    // 整个过程中 Worker 只该被派一次，而且是确认之后。
    assert.equal(stats.workersSpawned, 1, '只有确认之后才派 Worker，不是一次请求派一次')
    assert.equal(dispatched.length, 1)
    assert.ok(said.some((text) => text.includes('收到确认')), '确认要有回应')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('没人回「确认」就一直不派——到点作废，不会悄悄执行', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sam-gov-'))
  try {
    const said: string[] = []
    let fired = 0
    const source: TriggerSource = {
      name: 'quiet',
      poll: () => {
        fired += 1
        // 只有第一条是请求，之后再没人说话。
        return Promise.resolve(fired === 1 ? [trig('t1', 'k1', '把 build 目录整个删掉')] : [])
      },
    }

    const stats = await runSupervisor({
      stateDir: dir,
      filterRules: {},
      createRouter: () => scripted([{ action: 'dispatch', task: 'rm -rf build', risk: 'irreversible' }]),
      createWorker: (id) => ({ id, threads: new Set<string>(), step: () => Promise.resolve('删了') }),
      sources: [source],
      onReply: (_threadKey, text) => {
        said.push(text)
      },
      maxTicks: 8,
      intervalMs: 1,
    })

    assert.equal(stats.workersSpawned, 0, '没有确认就一个 Worker 都不能派')
    assert.ok(said.some((text) => text.includes('不可逆')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Worker 回来后，工作区的事实进证据——这就是对账', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sam-gov-'))
  try {
    const changed = ['src/filter.ts']
    await runSupervisor({
      stateDir: dir,
      filterRules: {},
      createRouter: () =>
        scripted([
          { action: 'dispatch', task: '给 fastPath 补一个边界', risk: 'write' },
          { action: 'reply_only', reply: '做完了' },
        ]),
      createWorker: (id) => ({
        id,
        threads: new Set<string>(),
        // 关键：它**自称**没改任何文件。工作区其实变了。
        step: () => Promise.resolve('whyEmpty 不在这个仓库里，我没有改任何文件。'),
      }),
      sources: [],
      inject: [trig('t1', 'k1', '给 fastPath 补一个边界')],
      workspace: { snapshot: () => Promise.resolve(changed) },
      onReply: () => undefined,
      maxTicks: 8,
      intervalMs: 1,
    })

    // 证据落在 state.jsonl 里，用重放把它读回来——不读内部变量，
    // 读的是"重启之后还能看到的东西"，那才是证据。
    const { replay } = await import('../src/store.ts')
    const state = replay(join(dir, 'state.jsonl'))
    const report = state.evidence.find((item) => item.action === 'report')

    assert.ok(report !== undefined, 'Worker 落地必须留一条证据')
    assert.deepEqual(report.changed, changed, '工作区里变了的文件要如实记下')
    assert.match(String(report.suspectContradiction), /没有改动/, '它说没改，但确实改了——必须标出来')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('给不出工作区快照时，就老实不写对账，不假装没改动', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sam-gov-'))
  try {
    await runSupervisor({
      stateDir: dir,
      filterRules: {},
      createRouter: () => scripted([{ action: 'dispatch', task: '改点东西' }, { action: 'reply_only', reply: '好了' }]),
      createWorker: (id) => ({ id, threads: new Set<string>(), step: () => Promise.resolve('改好了') }),
      sources: [],
      inject: [trig('t1', 'k1', '改点东西')],
      // 不给 workspace
      onReply: () => undefined,
      maxTicks: 8,
      intervalMs: 1,
    })

    const { replay } = await import('../src/store.ts')
    const report = replay(join(dir, 'state.jsonl')).evidence.find((item) => item.action === 'report')
    assert.ok(report !== undefined)
    assert.equal(report.changed, undefined, '不知道就不写，不要写个空数组冒充"确认没改"')
    assert.equal(report.suspectContradiction, undefined, '没有事实就没有矛盾可判')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
