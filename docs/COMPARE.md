# 源码级对比：我们 vs 官方原型

对象：`deepseek-ai/dsh-superagent-prototype`（`src/` 15,205 行 / 216 个文件，MIT）。
本地副本：`git clone --depth 1` 到任意目录（`git clone --depth 1`）。

**怎么读的**：先按文章做净室实现、跑出数字，然后才 clone 它读源码。
下面每一条差异都是真的分歧，不是事后照着它改出来的说法。

**读了什么**（诚实清单）：`core/engine.ts`、`core/ports.ts`、`core/model.ts`（类型索引）、
`core/memory.ts`、`app/passes.ts`、`app/effects.ts`（检索）、`app/cards.ts`（检索）、
`sources/poll.ts`、`sources/feishu-loops.ts`、`executor/dsh.ts`（检索）、`policy.ts`、
`docs/002-authorization.md`、`README.md`。**不是全读**——15,205 行里我读了大概两千行，
挑的是"读错就会把判断搞错"的地方。

---

## 0. 先说三个被推翻的判断

我上一版 `COMPARE.md` 是只读 Web 端文件写的，有三处判断错了，这里先纠正。

### ① "只能轮询，不能订阅事件" —— 错

我当初选轮询，理由是"一个飞书 app 只能挂一个事件总线"。他们用的是**真事件订阅**：

```ts
// src/sources/feishu-loops.ts:71
const child = spawn(bot(ctx).cli, ['event', 'consume', 'im.message.receive_v1', '--as', 'bot'], …)
stdout.on('line', line => { chain = chain.then(async () => { … await receive(ctx, trigger) }) })
```

`lark-cli event consume` 起一个长连接子进程，NDJSON 一行一个事件。顺带他们把这套东西的
**运维细节**都做了：45 秒没 ready 就杀掉重来、1 MiB 行上限、坏了之后 1 秒或指数退避
（跑满一分钟就重置）、以及用一条 `chain` promise 串行处理避免并发。

**所以"轮询 vs 订阅"不是架构必然，是我那个环境里的局部约束。** 这个区别值得记住：
把局部约束当成架构结论，是最容易在面试里说错的一类话。

现在他们的轮询只剩一个用途：**已订阅的线程补历史**（`pollThreads` + `cursorAt`），
而且游标会**主动回退 5 秒**去兜迟到的远端事件，靠确定性 trigger id 去重。这个"宁可重放几秒，
不要漏一条"和我做水位线时的判断完全一致——但他们在另一个位置。

### ② "Inline & Spill 大概率在他们应用层" —— 错，但只是名字错了

他们整个仓库里 **`spill` 这个词出现 0 次**。同一个思想在 `src/app/cards.ts` 第一行：

> Compact, bounded model-facing projections of triggers, tickets, threads, and decisions;
> **full texts stay behind readable resources.**

翻译：模型看到的永远是有界投影，全文放在一个"可读资源路径"后面，模型自己去取。

**和我们的 inline+spill 是同一个东西**：窗口里放摘要 + 一个指针。差别在彻底程度——
我们是"长的才 spill"（≤500 字直接内联），他们是**所有模型可见的东西都是投影**。
后者更一致：没有"这个够短所以可以随便塞"的例外，就没有那种"到底谁在占窗口"的糊涂账。

### ③ "空汇报/找不到要停" 靠提示词 —— 他们不用提示词，用状态字段

我给 Worker 加了一段执行纪律，教它"找不到就停、别造替代实现"。他们的做法更硬：

```ts
// src/core/model.ts:216
export type ReportState = 'progress' | 'waiting' | 'ready' | 'blocked' | 'failed' | 'dropped'
```

**"我卡住了""我失败了""我在等"是一个结构化字段**，不是一段自然语言。代码读这个字段决定
下一步（`blocked`/`failed` 会挡住自动输入，等一条人发的消息）。而且：

```ts
// src/core/engine.ts:234-235
· a `ready` report ends it: `completed` without followed Threads, else with the `followsDone` outcome
```

"干完了"必须是一个 report 状态，而不是模型说一句"我干完了"。**这一条他们明显更好**，
而且是我们前面折腾了三轮才勉强做到的事（教它说真话 + 事后对账）。

---

## 1. 根本差异：集成层

这一条决定了后面所有差异。

| | 我们 | 他们 |
|---|---|---|
| 形态 | 一个独立的 Node 程序 | DSH 的一个 bundle（跑在宿主进程里） |
| 怎么起 Worker | `spawn node bin.js headless "<prompt>"`，一次一进程 | `import '@deepseek-ai/dsh-session'`，进程内会话 |
| 拿到什么 | 一次调用的最终文本 | `agent/status`、`agent/inbox/claimed`、`session/event`、`agent/error` 四路事件 |
| 能不能插话 | 不能，一轮一个 prompt | 能：`sessions.prompt(sessionId, inputId, text, 'steer', live)` |
| 知道"它在干嘛" | 不知道 | `context.agents.get(sessionId)?.status === 'running'` |
| 会话标识 | `worker-w-<triggerId>-<随机8位>`，随机 | `worker-<ticketId>`，可逆、可枚举、可重建 |

```ts
// src/executor/dsh.ts:24
export const workerSessionId = (ticketId: string): string => `worker-${ticketId}`
// src/executor/dsh.ts:342
await this.host.sessions.prompt(workerSessionId(ticket.id), input.id, text, 'steer', live)
```

**这一条解释了我们大部分的坑**：182 秒阻塞、看不到工具调用、没法"插话"、没法知道
Worker 到底是卡住了还是在想。这些不是我们代码写得糙，是**集成层选低了**。

我们当时的选择是合理的：子进程能独立跑、能净室实现、不依赖 DSH 内部 API。
但它是天花板。他们的选择代价是紧密耦合——必须装在 DSH 里，不可能单独跑。

> 一句话：**我们用可达性换了能力，他们用能力换了可达性。** 没有谁错，
> 但如果目标是"企业级常驻"，我们这个集成层不够。

## 2. 循环形状：从"一个大 while"到"同步领域 + 排队 IO"

他们的：

```ts
// src/app/passes.ts:56-68  （合并并发 pass，只跑一次跟进）
async pump() {
  if (!this.host.configured() || this.host.closing()) return
  if (!this.pumping) return this.pumping = this.pumpOnce().finally(…)
  const next = () => { this.pumpAgain = undefined; return this.pump() }
  return this.pumpAgain ??= this.pumping.then(next, next)
}
private async pumpOnce() { this.host.effects.kick(); this.host.engine.evaluateDue() }
```

- 一个 **2 秒定时器** + **收到事件立刻 `request()`**（`passes.ts:37`）
- 一次 pass 只做两件事：跑到期的 effect、推进到期的 Eval
- 并发请求**合并**成"最多一次跟进 pass"

而 `Effects`（`app/effects.ts:46`）是一张**持久化的排队表**：

```ts
enqueue(kind, key, payload)                       // 入队（落库）
setHandler(kind, run, { limit, retry, ordered })  // 按 kind 注册，带并发上限和退避
throw new Later('…')                              // "现在不是时候"，不算失败、不加计数
```

**我们是一个 while 循环里既判断又干活。** 他们划了一条很清楚的线：

```
领域逻辑（同步、事务、可重放）  ←→  IO（异步、排队、可重试、持久）
```

`repo.atomic(() => …)` 把每个命令包成同步事务（`core/ports.ts:107`）；所有 IO 都只是
"入队一个 effect"，由宿主稍后执行。这样他们的领域层可以在内存里跑测试
（`core/memory.ts` 的 `MemoryRepositories` 用快照回滚实现 `atomic`），而且**语义和生产一致**。

我们做不到这一点：领域判断和 `execFile` 缠在一起，所以每次要验证一个判断，就得连 IO 一起造。

## 3. 逐项差异表

| 维度 | 我们（superagent-mini） | 他们（官方原型） |
|---|---|---|
| 入站 | 每 5 秒拉整个群 50 条，靠去重 | 事件订阅为主；轮询只补历史，带 5 秒回退和 14 天 horizon |
| 状态 | append-only `state.jsonl` + replay | SQLite（`effect` 表带 `due`）+ 内存实现用于测试 |
| 判断 | 模型自由输出 `{action, task, reply, risk}` | 模型**逐条填规则**：每条 enabled rule 必须给 `matched` + `reason`，代码校验"一条不落" |
| 开工门禁 | 风险档：只有 `irreversible` 才拦 | 授权：`Eval` / `Mandate` / ownership / handback / `admission` 表 / `direction` 门禁 |
| 会话 | 每任务新 spawn，随机 id | 每 ticket 一个持久 session，id 可从 ticket 推回来 |
| 并发 | 无上限 | `WorkerSlots` + `settings.executor.maxWorkers` |
| 出站 | 内存 promise 链，失败记日志 | 回执落盘 + `retry [5000, 300_000]` + 终态 `sent/channelIgnored/channelGone` |
| 窗口 | 短的直接内联，长的 spill 到文件 | 一律 `cards` 有界投影，全文在 resource 后面 |
| "没干成" | 自然语言 + 事后 git 对账 | `ReportState` 结构化字段 |

### 最值得抄的一条：让模型填表，别让模型表态

他们的评估（`src/policy.ts:45`）要求：**每一条启用的规则都必须被评估一次，并且给出理由**，
代码校验"数量对得上、id 不重不漏"，否则直接抛错：

```ts
if (judged.length !== enabled.length || ids.size !== judged.length || enabled.some(rule => !ids.has(rule.id))) {
  throw new Error('Exactly one assessment for every enabled rule is required; …')
}
```

还有一道 `direction` 门禁（`policy.ts:26`）：

```ts
implementation_requested && target_basis !== 'undetermined' && !requires_design_decision
```

意思是：**要能说清"要改什么、改成什么、还有没有待决的设计问题"，否则不许开工。**

我们的是模型随便输出一段 JSON，能解析就行——"它到底按什么判断的"没有结构，
所以也没法评测。他们的 `tests/policy.spec.ts` 有 45 KB，就是靠这个结构测出来的。

## 4. 我们做对或做细了的地方

不是全盘不如，这四条我认为我们更合适：

**① 每个数字能单独量出来。** 直通把 Router 决策从 200 降到 7、总时长 44.9s → 5.5s，
`node src/harness.ts` 四分钟出。在 15,205 行的体量里，这条曲线没人能单独量——变量太多。

**② 干净 profile 那条发现（20 秒超时 → 7.8 秒）。** 他们没这个问题，因为不走子进程。
**我们的坑是集成层选择的直接后果**——这反而是个能讲清楚的判断。

**③ 工作区对账。** 他们的交付物是 PR，diff 天然在那里，不需要对账。
我们的 Worker 直接改工作区，没有 PR 兜底，所以必须自己对账（`git status` + 汇报对质）。
**这是"选择低集成层"必须付出的监理成本**，也恰好是治理最实的一块。

**④ 失败话术与实现细节分离。** 他们没这个问题（错误信息本来不进模型）。
我们是在踩了之后才想明白"模型只会说出它看到的东西"。

## 5. 如果只改三件事

按收益排：

**① 把 Worker 从子进程换成进程内会话。** 一个人就能消掉四个坑：阻塞、看不到工具调用、
没法插话、不知道它卡在哪。代价是必须跑在 DSH 里，`README` 里"一键跑起来"那条要改写。
这是"要不要从骨架变成一个产品"的分水岭，不该我一个人决定。

**② 判断从"自由 JSON"改成"逐条填规则 + 方向门禁"。** 这条不需要改集成层，今天就能做。
判据也现成：能不能对一次判断给出"命中了哪条规则、凭什么"，以及"目标说清楚了没有"。

**③ 出站做持久回执。** 已经在 `RESULTS.md` 里记了。这条最便宜。

## 6. 一句话总结

**他们是产品，我们是骨架。但真正拉开距离的不是代码量，是集成层。**

我们用子进程换来"谁都能跑起来"，代价是看不见、插不进、停不下；
他们用进程内会话换来全部可见性，代价是只能活在 DSH 里。

前面那九个坑，有一半是这个选择的后坐力。这件事讲清楚，比多写一千行有用。
