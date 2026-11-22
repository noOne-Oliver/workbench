# 桌面外壳（方案 2）

## 是什么

`apps/macshell/` 是一个 Swift + AppKit + WKWebView 写的 macOS 应用壳，把已有的工作台**装进一个窗口，并且把内核一起打包进 app**：

- 窗口里加载的就是 `http://127.0.0.1:<WB_PORT>/` 那个三栏审阅收件箱（`web/index.html`），交互逻辑一行没改；
- **内核随包**：打包的 node、内核代码（`src/`）、前端（`web/`）都在 `Contents/Resources/kernel/` 里。app 拷到 `/tmp`、拷到 `/Applications` 都能直接跑，不需要仓库、也不需要本机装 node；
- **两个子进程**：`server`（HTTP + 静态页面）和 `worker`（常驻任务循环）。**只起 server 任务会永远排队**，所以外壳两个都起；
- 启动时先探端口：已经有一个工作台内核在跑（比如你开着 `npm run serve`）就**纯 attach**——不动别人的进程，也不再起 worker（避免两个 worker 抢同一个任务）；
- 内核起不来、或 15 秒没就绪，窗口里显示可读的错误页（含日志尾部与排查命令），而不是只有一个 `NSLog`。

## bundle 布局

```
Workbench.app/
  Contents/
    Info.plist
    MacOS/Workbench                 # swiftc 编译出来的外壳
    Resources/kernel/
      node                          # 打包用的 node 二进制（cp -L 复制真实文件，chmod +x）
      libnode.127.dylib             # 只有 homebrew 的动态链接版 node 需要（见下）
      package.json
      src/                          # 内核：server / runner / core
      web/                          # 三栏收件箱
```

**不带** `data/` `worktrees/` `.git/` `tests/` `scripts/` `.oc/` `.bench/` `.demo/` —— 那些是仓库里的开发产物，不属于运行所需。`build.sh` 会断言这一点，打包错了当场炸，而不是等用户双击。

> 为什么多一个 `libnode.*.dylib`：homebrew 的 `node` 不是自包含的，它依赖 `@rpath/libnode.NN.dylib`（不在 `/usr/lib` 里）。node 的 `LC_RPATH` 含 `@loader_path`，所以把这个 dylib 拷到 `kernel/` 里、和 node 同目录，就正好命中。不拷的话第一次离仓运行会直接 `dyld: Library not loaded: @rpath/libnode.127.dylib`。
> 官方 nodejs.org 的静态构建没有这个依赖，用 `WB_NODE=/path/to/static/node` 构建时这一步会自动跳过（脚本按 `otool -L` 结果判断）。

## 构建

```bash
bash apps/macshell/build.sh
```

零第三方依赖，只要有 Command Line Tools 里的 `swiftc`（本机实测 Swift 6.4.2，不需要完整 Xcode）和任意一个 `node >= 22.5`（打包用，`WB_NODE` 可指定）：

1. 检查工具链（`swiftc` / `xcrun --show-sdk-path` / `node`）
2. 清理并准备 `dist/Workbench.app`
3. `swiftc -O -parse-as-library -target arm64-apple-macos13.0 -sdk <SDK> -framework AppKit -framework WebKit`
4. 把内核打进 `Contents/Resources/kernel`（`cp -L` node + 它的 `@rpath` 依赖、`cp -R` `src/` `web/`、`package.json`），并断言该在的在、不该带的一个没带
5. 写 `Info.plist`（版本 0.2.0，**不再写仓库路径**）
6. `codesign --force --sign - ` 并 `codesign --verify` 自校验

可重复执行，任何一步失败都非零退出。`dist/` 已进 `.gitignore`。

## 工作区怎么选

内核代码在 app 里，**数据在用户自己的工作区里**（账本、worktree、起始仓库 `demo/`）。决定顺序：

1. 环境变量 `WB_WORKSPACE=/path/to/ws`
2. `UserDefaults` 的 `workspace` 键（上次在面板里选的目录）
3. `~/Workbench`

目标是「目录不存在」时（首次启动、或上次选的目录被删了）弹 `NSAlert` + `NSOpenPanel`（只能选目录、可新建），选择存进 `UserDefaults`；**用户取消就退回 `~/Workbench`**，不会卡在启动。

无头模式（`WB_SHELL_SMOKE=1` / `WB_SHELL_SHOT=...`）**绝不弹面板**，免得自动化卡在模态框上。

启动前外壳会跑一次幂等的

```bash
"<kernel>/node" "<kernel>/src/cli.mjs" workspace --dir "<ws>"
```

把 `data/ worktrees/ .oc/ demo/` 补齐（已有就只补缺，绝不覆盖账本），然后才起子进程。

## 两个子进程

| 名字 | 命令 | 环境 |
| --- | --- | --- |
| `server` | `<kernel>/node <kernel>/src/server/index.mjs` | `WB_ROOT=<ws>` `WB_CODE=<kernel>` `WB_DB=<ws>/data/ledger.db` `WB_PORT=<port>` + 继承（`WB_ENGINE` / `WB_TOKEN` / `WB_MOCK_SCENARIO`…） |
| `worker` | `<kernel>/node <kernel>/src/cli.mjs run` | 同上（不含 `WB_PORT`） |

- 两个都**只在 attach 未命中时**启动；attach 命中就一个都不起。
- 退出时按 `SIGTERM` → 等 3 秒 → `SIGKILL`，**worker 先收、server 后收**；只收自己起的进程。
- 外壳被 `SIGTERM/SIGINT/SIGHUP` 杀掉时，信号处理器兜底 `SIGKILL` 掉两个子进程，不留孤儿。
- `PATH` 里会前置 `<kernel>` 和 `<kernel>/bin`，所以护栏退回的 `node --test` 也能直接用包里的 node —— **打包环境不需要 npm**。

## 怎么用

```bash
open -a "$PWD/dist/Workbench.app"
```

| 快捷键 | 动作 |
| --- | --- |
| ⌘R | 刷新页面（启动失败后按 = 收掉残留子进程、重新 attach/spawn） |
| ⌘O | 在 Finder 里打开工作区的数据目录（`<ws>/data`） |
| ⌘Q | 退出（先收尾自己起的子进程） |

窗口默认 1200×800、最小 900×640，位置和大小会被记住。

## 离仓运行（真的会把 app 挪走）

```bash
cp -R dist/Workbench.app /tmp/pkgtest/Workbench.app
cd /tmp
WB_WORKSPACE=/tmp/wb-pkg-ws WB_PORT=7601 WB_SHELL_SMOKE=1 \
  /tmp/pkgtest/Workbench.app/Contents/MacOS/Workbench
```

## 无头自检（WB_SHELL_SMOKE=1）

不建窗口，只做「定位内核 → 解析/准备工作区 → attach 或起 server+worker → 请求 `/api/tasks` 与 `/api/workspace`」：

```bash
# 一条命令跑完「提交任务 → 自动执行 → 到待裁决 → 退出无孤儿」，不用看窗口
node scripts/verify-package.mjs --port 7641
# app=.../dist/Workbench.app
# workspace={"root":"/tmp/wb-pkg-.../ws","code":".../Contents/Resources/kernel",...}
# states=queued → verifying → awaiting_human
# PASS 离仓可运行 / 工作区正确 / worker 真跑 / 退出无孤儿
```

```bash
# attach 到已在跑的 7317
WB_SHELL_SMOKE=1 dist/Workbench.app/Contents/MacOS/Workbench
# workspace=/Users/liujie/Workbench workspaceSource=默认 ~/Workbench starterRepo=/Users/liujie/Workbench/demo
# kernel=ok tasks=3 mode=attach port=7317 workspace=/Users/liujie/Workbench code=/.../Resources/kernel engine=mock

# 自己起一个（换端口，顺带验证退出时没有孤儿进程）
WB_WORKSPACE=/tmp/wb-pkg-ws WB_PORT=7601 WB_SHELL_SMOKE=1 dist/Workbench.app/Contents/MacOS/Workbench
# kernel=ok tasks=0 mode=spawn port=7601 workspace=/tmp/wb-pkg-ws code=.../Resources/kernel engine=mock server=41935 worker=41936 log=.../kernel.log
```

输出字段：

| 字段 | 含义 |
| --- | --- |
| `kernel=ok` / `kernel=fail ...` | 内核是否就绪（fail 走 exit 2 并带日志尾巴） |
| `mode=attach` / `mode=spawn` | 接管已有内核，还是自己起的 |
| `workspace=` | 内核自报的数据根（`GET /api/workspace` 的 `root`） |
| `code=` | 内核代码根（`code`）——离仓运行时应指向 `.../Workbench.app/Contents/Resources/kernel` |
| `engine=` | 内核自报的引擎（默认 `mock`） |
| `server=` / `worker=` | 两个子进程的 pid（attach 模式没有） |
| `log=` | 实际写入的内核日志路径 |

典型失败是端口被别的服务占着（`python3 -m http.server 7399`）：

```
kernel=fail 端口 7399 已被其他服务占用，但它不是工作台内核（GET /api/tasks → HTTP 404：响应不是工作台内核的 JSON ...）
```

## 证据截图（WB_SHELL_SHOT=/path/out.png）

人到底看到什么，是这套东西最容易被糊弄的一环（"窗口开了"≠"页面画出来了"）。所以外壳自带一条截图通道：

```bash
WB_SHELL_SHOT=docs/shell-shot.png dist/Workbench.app/Contents/MacOS/Workbench
# dom={"cards":1,"nodes":104,"text":"评审收件箱\n我是 \n更新于 12:35:25\n待我裁决\n离仓验收：..."}
# shot=ok path=/tmp/wb-shot.png bytes=128445 size=1446x894
```

- 先 `evaluateJavaScript` 拿一条 **DOM 断言**（卡片数 / 节点数 / 正文前 160 字），这是可以进 CI 的东西；
- 再 `WKWebView.takeSnapshot` 存 PNG，用 `NSBitmapImageRep` 编码，不需要系统录屏权限（TCC）；
- 退出码 0 = 页面真渲染了；2 = 截图或写盘失败，并打印原因；
- 这不抢焦点（`orderFrontRegardless`，不激活 app），所以能在自动化里跑。

## 环境变量

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `WB_WORKSPACE` | 空 | 工作区目录（不给就看 UserDefaults，再退回 `~/Workbench`） |
| `WB_PORT` | `7317` | 内核端口，外壳据此 attach/探测 |
| `WB_TOKEN` | 空 | 设了会把 token 带进页面 query，交给 `web/app.js` |
| `WB_KERNEL` | 空 | 覆盖内核目录（开发期指到仓库；默认 `Bundle.main.resourcePath/kernel`） |
| `WB_NODE` | 空 | 覆盖内核的 node 可执行文件（默认 `<kernel>/node`） |
| `WB_ENGINE` | 空 | 透传给内核（默认 `mock`；真引擎会烧 token） |
| `WB_SHELL_SMOKE` | 空 | `1` = 无头自检模式 |
| `WB_SHELL_SHOT` | 空 | 设成 PNG 路径 = 加载页面后截图并存盘，然后退出 |

内核侧由外壳固定注入：`WB_ROOT=<ws>`、`WB_CODE=<kernel>`、`WB_DB=<ws>/data/ledger.db`。

## 日志

两个子进程的 stdout + stderr 都写 `~/Library/Logs/Workbench/kernel.log`，**每行加 `[server]` / `[worker]` 前缀**（按行切分，不会把两个进程的输出搅在一起）：

```
==== 2026-11-22T12:35:05+08:00 shell spawn ====
==== workspace: root=/tmp/wb-pkg-ws db=/tmp/wb-pkg-ws/data/ledger.db starter=/tmp/wb-pkg-ws/demo created=[worktrees,.oc] starterCreated=true（来源：WB_WORKSPACE） ====
==== server: ".../kernel/node" ".../kernel/src/server/index.mjs" ====
==== worker: ".../kernel/node" ".../kernel/src/cli.mjs" run ====
==== server pid=42117 args=.../src/server/index.mjs ====
==== worker pid=42118 args=.../src/cli.mjs run ====
[server] (node:42117) ExperimentalWarning: SQLite is an experimental feature ...
[server] [server] http://127.0.0.1:7601
[worker] (node:42118) ExperimentalWarning: SQLite is an experimental feature ...
==== 2026-11-22T12:35:05+08:00 ready mode=spawn tasks=0 port=7601 workspace=/tmp/wb-pkg-ws code=.../Resources/kernel engine=mock ====
```

若该目录不可写（家目录只读、或在外层沙箱里跑自检），自动退到 `$TMPDIR/Workbench/kernel.log`，并在日志里注明实际路径。

## 边界（现在故意没做的）

- **ad-hoc 签名**：只能本机跑；拷到别的 Mac 会被 Gatekeeper 拦截（可以 `xattr -d com.apple.quarantine` 绕过，但没做公证）。
- **不跨 homebrew 版本**：`kernel/node` 是 homebrew 的动态链接版，除了 `libnode` 还依赖同机 `/opt/homebrew/opt/*` 下的 libuv / icu4c / openssl 等绝对路径。换机器（或 `brew upgrade node` 之后）要重新 `build.sh`。要做成真正的单文件分发，得换官方静态 node 或 `node --experimental-sea-config` 的 SEA。
- 没有公证、没有 Updater、没有 App Sandbox，也没有 App Store 打包。
- 没做多窗口、Dock 菜单、崩溃上报、自动更新。
- 只用 `WKWebView` 装页面，没加任何原生 UI；所以「审阅」的体验和浏览器里完全一样（这是刻意的：不重写已有界面）。
