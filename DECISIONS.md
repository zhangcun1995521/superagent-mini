# 决策记录

> 每条决策三栏：**选择 / 理由 / 文章依据**。文章没说的地方标「空白，自定」。
> 做完对照官方原型时，逐条看我们和它差在哪——差异处就是判断力所在。

## 0. 目标

给作者本人做一个**常驻的 agent**：飞书说一句"帮我修 X"，Router 派活，Worker 在隔离环境干活，结论回到飞书。事件驱动、并发、可恢复。

## 1. 数据模型

| 对象 | 字段 | 说明 |
|---|---|---|
| `Trigger` | id, source, threadKey, kind, payload, at | 一次环境事件。id 由源保证唯一（飞书 message_id / GitHub event id），**重复 id 直接丢**（幂等） |
| `Thread` | key, subscribers:Set, lastActiveAt | 一个话题的事件流。key 由源适配器给（`feishu:chat:<id>` / `github:pr:<repo>:<num>`），内核不猜 |
| `Worker` | id, sessionId, threads:Set, status, startedAt | 一个隔离会话。sessionId 是 DSH 的 `--session-id`，持久化由 DSH 管 |
| `Evidence` | id, workerId, action, basis, verdict | 每个有后果的动作留一条。谁干的、凭什么、结论 |

## 2. 九条决策

| # | 问题 | 选择 | 理由 |
|---|---|---|---|
| 1 | Router 是谁 | 一个 DSH headless 会话，`--session-id router-main`，**无执行工具的 profile** | 文章："Router 甚至可以不配备 Bash 工具"。用 profile 差异实现，不写运行时拦截 |
| 2 | Worker 是谁 | 每个任务一个 DSH headless 会话，全工具 profile，跑完保留（可续） | 文章：Worker 隔离并发。DSH 的 session 持久化正好是 Worker 的生命周期 |
| 3 | Thread 边界 | 源适配器给 threadKey，内核不猜 | 空白，自定：让最懂源的人定边界 |
| 4 | 订阅存哪 | 内存 Map + 每次变更落 `state/subscriptions.jsonl`（append-only） | 崩溃后重放恢复。文章空白，自定 |
| 5 | Inline 预算 | 每轮注入：当前 Trigger 全文 + Thread 摘要（≤500 字）+ 引用 ID。超预算的内容 Spill 到 `state/spill/<id>.json`，消息里留 `ref` | 文章："从最少信息开始，利用局部性逐步 Inline，超上限则 Spill" |
| 6 | Spill 读取 | 给 Worker 一个工具 `read_spill(ref)`，返回内容 + 下一跳 ID | 文章：链式召回——"每次召回的对象内联下一跳关联对象的 ID" |
| 7 | 冲突检测 | 同一 Thread 有 ≥2 订阅者且各自要执行写动作时，Router 收到 `conflict` Trigger | 文章："多个 Worker 都订阅同一 Thread 就有机会自行发现冲突"——我们把"有机会"变成"一定会被告知" |
| 8 | Router 回话 | 一轮事件最多回一条；无实质进展不回 | 文章："IM 侧重低打扰，单次回复不超过 100 词" |
| 9 | 治理放哪 | 分三层：**能力面**由 profile 决定（选 profile = 选能力）；**事前**由 `policy.ts` 按风险档执行（只有不可逆的才拦）；**事后**用工作区快照对账，矛盾只标"疑似"不下判决 | 文章 8.4 空白——我们补。借 DeepWork 的 tool_grants 思想，但**只借它的分工，不搬它的机制**：它管到"某次工具调用的某个参数"（在 DSH 插件层），我们只到"任务级"，因为 Worker 是黑箱子进程 |

## 3. 不做（和为什么）

| 不做 | 因为 |
|---|---|
| 端侧 daemon / 存算分离 | 单机部署下计算与环境同地，daemon 不解决任何问题。跑命令封装成 `runCommand()` 接口，留迁移路 |
| Watchdog 常驻壳 | 合成/短任务没有卡死场景。但做 `judgeProgress(history)` 纯函数（判"有无实质进展"），可测 |
| GitHub 真接入（第一版） | 先用合成事件源验架构。第二步接飞书（代码已有），第三步接 GitHub |
| Web 面板 | CLI + 飞书卡片够看。他们 27k 行里 UI 占近一半，我们不碰 |

## 4. 基准（harness）

合成负载：20 条工作请求 + 200 条噪音，工作 = 3 次模拟调用（各 200ms）。

```
A：单会话（所有事件进同一个 DSH 会话，串行）
B：双层 + 订阅直通
C：双层但去掉直通（后续事件也过 Router）
```

出三个数：**p50 / p95 完成时间、Router 决策数、输入 token 总量**。
预期：B 的 p95 显著低于 A；C 与 B 完成时间接近但决策数/token 明显更高（文章：决策 +30%、token +37%）。

## 5. 对照计划

本仓做完、跑出数之后，再去读 `deepseek-ai/dsh-superagent-prototype`，逐模块写 `docs/COMPARE.md`：

```
文章说 ｜ 我们做 ｜ 他们做 ｜ 差异的原因（谁的选择更好）
```

重点对照四处理论上最容易分歧的地方：Thread 边界怎么定、订阅存哪、Spill 的预算怎么分、治理层放不放。

---

## 6. 实测后补的决策（都是撞出来的）

| # | 撞到什么 | 定下来的规则 | 为什么值得记 |
|---|---|---|---|
| 1 | `--session-id` 报 "session does not exist" | 第一轮不传 id，从 `dsh --json` 的第一行拿 DSH 分配的 id，之后才续 | 它**不能用来创建会话**，只能续已存在的。这一条决定了"Worker 的 id 谁生成" |
| 2 | Worker 的汇报被直通投回**它自己**，形成自激循环 | **`source === 'worker'` 的 Trigger 一律过 Router，绝不直通** | 汇报的 threadKey 与原任务相同，而订阅者正是发出汇报的 Worker。死循环在路由层，不在模型层——所以规则写在代码里，不是提示词里 |
| 3 | 模型偶尔把汇报判成 dispatch（又想派活） | 候选处理里加第二层防线：worker 来源的 dispatch 强制降级成回话 | 与守卫同一思路：提示词是一次建议，代码是拒绝 |
| 4 | 模板字符串里写了反引号，整段提示词被截断 | 提示词里用「」代替 ` | 一次语法错误，表现是"文件解析失败"，根因是字符串边界 |
| 5 | 一个最简单的往返要 **14,470 tokens** | Worker 不能像基准里那样随便派（基准里的 200 个 Worker 是虚构） | 真实成本约束会改变调度策略——这是合成负载测不出来的 |
