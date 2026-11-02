#!/usr/bin/env node
/**
 * 一条命令的端到端演示：一句话进去，Router 判断，Worker 真干活，回一句话出来。
 *
 *   node src/demo.ts "看看 gl-demo 里 calc.ts 的 div 有没有边界问题"
 *
 * 与 harness 的区别：harness 里的 Worker 是 sleep，这里是真 DSH 会话。
 * 跑一次大约 1–2 分钟（两次模型往返：Router 一次、Worker 一次）。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { dshRouter, dshWorker } from './dsh.ts'
import { runSupervisor } from './supervisor.ts'
import type { Trigger } from './model.ts'

const request = process.argv.slice(2).join(' ').trim()
if (request.length === 0) {
  console.error('用法: node src/demo.ts "<一句话请求>"')
  process.exit(2)
}

const now = new Date().toISOString()
const trigger: Trigger = {
  id: `demo-${Date.now()}`,
  source: 'feishu',
  threadKey: 'feishu:chat:demo',
  kind: 'message',
  payload: request,
  at: now,
  actor: 'ou_zhangcun',
}

const dir = mkdtempSync(join(tmpdir(), 'sam-demo-'))
console.log(`\n=== 输入 ===\n[${trigger.source}] ${trigger.actor}: ${request}\n`)
console.log('=== 开始 ===')

try {
  const stats = await runSupervisor({
    stateDir: dir,
    // 让 demo 必须过 Router：把白名单留空，走 Slow Path——这样能看到 Router 的判断。
    filterRules: {},
    createRouter: () => dshRouter('router-demo'),
    createWorker: (id) => {
      const worker = dshWorker(id)
      return {
        id: worker.id,
        threads: worker.threads,
        async step(instruction) {
          console.log(`\n--- Worker ${worker.id} 接到任务 ---\n${instruction.slice(0, 400)}`)
          const report = await worker.step(instruction)
          console.log(`\n--- Worker 汇报 ---\n${report.slice(0, 1200)}`)
          return report
        },
      }
    },
    sources: [],
    inject: [trigger],
    onReply: (threadKey, text) => console.log(`\n=== 回给 ${threadKey} ===\n${text}\n`),
    // 多轮：第 1 轮派活，Worker 落地后报告进队，第 2 轮 Router 汇总回话。
    maxTicks: 20,
    intervalMs: 400,
  })
  console.log(
    `\n=== 统计 ===\nRouter 决策 ${stats.routerDecisions} 条 / 模型调用 ${stats.routerCalls} 次 / ` +
      `派 Worker ${stats.workersSpawned} 个 / 直通 ${stats.directDeliveries} 次`,
  )
} finally {
  rmSync(dir, { recursive: true, force: true })
}
