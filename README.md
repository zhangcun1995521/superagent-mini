# superagent-mini

**A resident super-agent on DSH.** Events arrive, threads get routed, workers stay isolated, and every
decision leaves a trace you can check afterwards.

> Not a framework. Not a product. A working reference for one set of claims about how a resident agent
> should be built — plus the measurements that made us revise four of those claims.

[中文说明](README.zh.md)

```
Event (Feishu message / CI result / PR comment)
   │
   ▼
Supervisor ── the only long-lived thing. Deterministic work only:
   │          pull events, filter, route, dispatch, persist.
   │
   ├─ Fast path (code, costs nothing): the bot's own messages, configured noise → dropped
   │
   ├─ Thread already has a subscriber? ──yes──▶ deliver straight to the worker (no model call)
   │
   └─ no ──▶ Router (one DSH session, no execution tools)
   │           one batch per turn — one model call, not N
   │           may only answer: dispatch / ignore / reply_only
   │           also labels the risk: read / write / irreversible
   ▼
Worker (one DSH session per task, its own workspace and capability set)
   │      runs without blocking the supervisor
   ▼
report → back into the queue as a new trigger → Router → one short reply to the user
         plus: workspace reconciliation and a real verification gate
```

## Numbers

Synthetic load: 20 work requests across 4 threads, plus 200 noise events. A "work" item is three
simulated calls of 200 ms. Reproduce with `node src/harness.ts` (~4 min).

| Variant | p50 | p95 | Router decisions | Model calls | Bypassed | tokens | wall clock |
|---|---|---|---|---|---|---|---|
| A — single session, serial | 827 ms | 839 ms | 220 | 220 | 0 | 267,920 | 182.2 s |
| B — two-tier + bypass | 633 ms | 3,237 ms | **7** | **7** | 193 | 269,953 | **5.5 s** |
| C — two-tier, no bypass | 638 ms | 34,506 ms | 200 | 200 | 0 | 273,620 | 44.9 s |

**B vs C: 200 decisions → 7, wall clock 44.9 s → 5.5 s.** The gain scales with how much of the
stream is repeat traffic. Our load is 200 noise : 20 work, so we see 28×; the original article
reports +30% under its own load. **Quote your own numbers, never theirs.**

**A beats B on p95** (839 ms vs 3,237 ms). That is a trade-off, not a bug: in the two-tier design the
Router is a global serialization point, so a slow Router slows everything. To fix p95 you make the
Router cheaper, or you batch earlier — you do not add more tiers.

## What real runs changed

Synthetic workers are `sleep(200ms)`. None of the following appears until you wire a real chat source
and a real model. Each is a claim we held that turned out to be wrong.

| We assumed | It measured | What we changed |
|---|---|---|
| async calls are concurrent | a synchronous `execFileSync` inside dispatch froze the whole loop: **182 s** between spawning a worker and the next log line | `execFile` + `Promise`; same spot now **3 s** |
| more plugins means more capable | the worker inherited a 7-plugin profile, tried to reach Feishu on boot, and died on a platform signing error: **20 s timeout** | project-local `.dsh-home` with a minimal profile: **7.8 s**, correct answer |
| told to stop, it stops | asked for a symbol that did not exist, it searched for **120 s** and timed out rather than saying "not found" | execution discipline shipped with every task: **14.6 s**, honest report |
| idle means idle | a polling source re-delivers seen events, so "no new events" never fired: busy-loop, timers starved, worker reports never arrived | idleness keyed on *deduplicated* new events |

The four numbers above are worth more than the benchmark table, because they cannot be copied — you
have to hit the wall yourself first. Nine such findings, with root causes, are in
[`docs/RESULTS.md`](docs/RESULTS.md).

## Quick start

Requires **Node 24+** (runs `.ts` directly, uses top-level `await`).

```bash
npm test                 # 46 tests, no external services
node src/harness.ts      # the benchmark table above, ~4 min
```

**With a real model, no chat source** — one sentence in, one answer out:

```bash
npm i
node src/demo.ts "look at src/filter.ts and check the empty-actor edge case"
```

**As a resident agent on Feishu** — needs a Feishu app and the bot in a chat:

```bash
export SAM_CHAT_ID=oc_xxxxxxxxxxxx        # required
export SAM_WORKSPACE=/path/to/target/repo # where workers run; defaults to cwd
export SAM_VERIFY_BIN=/path/to/verifier   # the gate; omit and nothing is verified (warned at boot)
export SAM_VERIFY_COMMAND="npm test"      # what the gate runs; omit for JS/TS defaults
node src/run.ts
```

Other knobs: `SAM_STATE_DIR`, `SAM_INTERVAL_MS`, `SAM_LARK_BIN`, `SAM_DSH_BIN`, `SAM_DSH_HOME`,
`DSH_WORKER_TIMEOUT_MS`. On first boot the agent draws a watermark and only handles messages after
it; replay history explicitly with `FEISHU_SINCE=<iso>`.

Deploying to a Linux box (systemd, permissions, credentials): [`docs/DEPLOY.md`](docs/DEPLOY.md).

## Design decisions that are not obvious

**The Router has no execution tools.** It is a DSH session whose profile simply lacks a shell.
Capability is enforced by what the profile contains, not by asking the model to refrain.

**Worker reports never take the bypass.** A report carries the same `threadKey` as its origin task,
and that thread's subscriber *is the worker that produced it* — bypassing would deliver the report back
to itself and spin. The loop lives in routing, not in the model, so the rule lives in code.

**An empty report is still a result.** The worker having nothing to say must reach the user. The
original `if (text.length === 0) return` made the task evaporate silently.

**Nothing said to the user is shaped by the model.** The kernel decides the *shape* of an outbound
message (strip internal envelopes and ids, collapse whitespace, cap length, archive the overflow) and
decides the *content policy* too: implementation details never reach the model in the first place,
because a model can only leak what it was shown.

**The gate runs outside the worker.** Verification runs in the supervisor process, not the sandbox —
a sandbox cannot spawn test processes, and more importantly, **the thing being judged should not run
the judgement**.

**Risk is judged by the model; policy is executed by code.** The Router labels each task
`read` / `write` / `irreversible`. Code decides what that means: only the irreversible one stops and
asks a human. Gating everything means gating nothing — people click through, and consent becomes
theatre.

**Reconciliation, because self-report is not evidence.** After a worker finishes we read the workspace
(`git status`) and confront it with what the worker said. Mismatches are marked *suspected*, never
adjudicated: the cost of a wrong verdict belongs to a person, so a person should see it.

**Configuration lives in the environment, never in source.** Paths, chat ids, verifier commands.
Editing source to deploy means production runs something that is not the repository.

## Known limitations

Stated plainly, because a README that hides them is worth less than one that does not.

- **Thread granularity is the chat, not the topic.** Two unrelated topics in one chat share context.
- **Impact analysis covers TypeScript/JavaScript only.** For other languages the gate runs the full
  suite (fast for small repos, wrong for large ones); wire your own CI through `SAM_VERIFY_COMMAND`.
- **One workspace, one task at a time conceptually.** Concurrent workers see each other's changes.
- **`recent` context is in-memory.** Restarts lose the assembled history; tasks do not.
- **The outbound queue is not durable.** Process death drops queued messages. The reference
  implementation persists receipts and retries — see [`docs/COMPARE.md`](docs/COMPARE.md) §2.
- **~14,470 tokens for the simplest round trip.** "Spawn many workers" only holds under synthetic
  load; real cost changes the scheduling policy.

## Documentation

- [`docs/RESULTS.md`](docs/RESULTS.md) — benchmark numbers and the nine findings from real runs
- [`docs/COMPARE.md`](docs/COMPARE.md) — module-by-module comparison with the reference implementation
- [`docs/DEPLOY.md`](docs/DEPLOY.md) — running it on a Linux host
- [`DECISIONS.md`](DECISIONS.md) — every choice, its reason, and what we decided *not* to build

## What this repository argues

Not one claim in the source material could be settled by reading it. The difference between 182 seconds
and 3 seconds, between "the worker says it found nothing" and "the worker says it did nothing" — those
only show up when you run it.

So the value here is not what it implements. It is that it records **which claims had to be revised
once reality got a vote.**
