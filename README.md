# 工作台 (Workbench) v0

一个「AI 团队分工写代码、人只负责 review」的后台执行器。
你提交任务 → 后台自动 规划/实现/验收/复核 → 卡在 `awaiting_human` 等你看一眼 → 你说合或不合。

人只回答一个问题：**要不要合**。其余全部自动重试、自动升级、自动归档。

## 30 秒跑起来

```bash
npm run init                 # 建账本 + 初始化 demo 仓库
npm run enqueue -- --title "实现 calc 四则运算" --repo ./sandbox/demo
npm run worker               # 另一个终端：后台一直跑（也可 --once 跑一轮）
npm run serve                # 打开 http://127.0.0.1:7317 审阅
```

默认引擎是 `mock`（确定性假引擎，用来验证流水线与护栏），不需要任何 API key、不花钱。

![评审收件箱](docs/screenshot.png)

## 它凭什么能无人值守

四个「不信任模型」的设计，缺一个就会退化成值班员：

| 机制 | 解决的问题 | 落点 |
| --- | --- | --- |
| **事件账本**（events 唯一真源，tasks 是物化投影） | 重启失忆、状态对不上 | `src/core/ledger.mjs` 的 `rebuild()`，kill -9 后从事件重放 |
| **租约**（单条 CAS UPDATE + pid 存活探测） | 两个 worker 抢同一个任务、死进程占着不放 | `src/core/lease.mjs` |
| **确定性护栏**（跑真测试、比对测试用例/断言数、diff 规模） | agent 改测试刷绿、空断言、顺手重构半个仓库 | `src/runner/guards.mjs` |
| **角色分离**（Verifier 拿不到 coder 的内心独白，只给 diff+真实测试输出+护栏结论） | 自己批自己的作业 | `src/runner/sop.mjs` |

「测试跑绿 ≠ 改对了」这件事，是护栏里的 `no_test_weakening` 兜住的，不是模型自评。
伪绿会被自动打回重做，重试到上限才升级给人。

## 状态机

```
queued → planning → implementing → verifying → reviewing → awaiting_human → merging → done
              ↑           │            │            │              │           │
              └───────────┴────────────┴────────────┘              │           │
                         （自动重试，最多 3 轮）        blocked ←────┘           │
                                                          └── failed ───────────┘
```

- 只有 `awaiting_human` 会停住等人，且只有任务的 `owner` 能裁决（多人协作时防止「以为别人在看」）。
- `blocked` 是「机器认输了」：重试耗尽或预算超限，等人捞。

## 命令

```bash
node src/cli.mjs init                              # 建库 + 建 demo 仓库
node src/cli.mjs enqueue --title "..." --repo <dir> [--owner <name>] [--budget 200000]
node src/cli.mjs status [--id <task>]              # 看任务与事件流
node src/cli.mjs rebuild                           # 从事件全量重建投影（自愈）
node src/cli.mjs run [--once] [--worker host:pid]  # 跑 worker
node src/cli.mjs serve [--port 7317]               # 起审阅服务
npm run demo:reset                                 # 把 sandbox/demo 恢复到种子状态
npm test                                           # 内核测试（状态机/账本/租约/预算/护栏）
```

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `WB_ENGINE` | `mock` | `mock` 假引擎；`opencode` 真引擎（调本机 opencode CLI） |
| `WB_DB` | `data/ledger.db` | 账本路径 |
| `WB_TOKEN` | 空 | 设了就要带 `Authorization: Bearer <token>` |
| `WB_PORT` / `WB_HOST` | `7317` / `127.0.0.1` | 服务监听（多人用时改 `0.0.0.0`） |
| `WB_MAX_ATTEMPTS` | `3` | 自动重试上限，超过转 `blocked` |
| `WB_MOCK_DELAY` | `0` | mock 每步延迟，用来模拟慢任务/演示并发 |
| `WB_MOCK_SCENARIO` | `fakegreen` | mock 场景：`fakegreen` 第一轮故意刷绿、`good` 一次过 |
| `WB_MODEL` | 空 | opencode 用的模型 |

## 五条验收怎么复现

1. **人工决策中位耗时 < 5 分钟** —— 卡片上直接给 diff / 护栏明细 / Verifier 结论 / 上抛问题，`review_seconds` 落库统计。
2. **照妖镜**：`npm test` 里「护栏：伪绿…」用例即此项；真管线里第一轮会被 `no_test_weakening` 打回。
3. **kill -9 自愈**：跑 `npm run worker` 中途 `kill -9`，再跑 `node src/cli.mjs run --once`，任务从断点续跑且不重复烧重试额度（事件流会出现 `attempt.resumed`）。
4. **并发**：两个 worker 起在同一账本上，同一个任务只会有一次 `lease.acquired`；不同任务各自独立 git worktree。
5. **预算熔断**：`--budget 10` 入队，跑一轮即 `blocked`，不会再花 token。

## v0 不做什么（故意的）

- 不做多人实时协作（多租户 = 5 倍工作量）；多人场景先用「一台 Mac 当 runner + 内网 + 单 token」，owner 绑唯一 reviewer。
- 不做苹果签名/上架（无法自动化，闭环终点是测试通过 + 可归档产物）。
- 不做富 UI 编辑，不做代码内联批注，只有「合 / 不合 + 一句话理由」。

## 目录

```
src/core/     账本、事件、状态机、租约
src/runner/   worker 循环、SOP 提示词、护栏、worktree、引擎 provider
src/server/   HTTP + 静态审阅界面
web/          审阅收件箱（三栏：待裁决 / 后台在跑 / 归档）
sandbox/demo/ 演示用目标仓库（有真测试，能真跑）
tests/        内核测试
scripts/      demo 重置
```