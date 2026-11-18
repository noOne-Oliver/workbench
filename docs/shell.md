# 桌面外壳（方案 2，第一步）

## 是什么

`apps/macshell/` 是一个 Swift + AppKit + WKWebView 写的 macOS 应用壳，把已有的工作台**原样装进一个窗口**：

- 窗口里加载的就是 `http://127.0.0.1:7317/` 那个三栏审阅收件箱（`web/index.html`），交互逻辑一行没改；
- 壳负责**内核生命周期**：启动时先探端口，已经在跑就直接 attach（不抢端口、不动别人的进程）；没在跑就用 `node src/server/index.mjs` 起一个，就绪后再加载页面，退出时只收自己起的那个子进程；
- 内核起不来、或 15 秒没就绪，窗口里显示可读的错误页（含日志尾部与排查命令），而不是只有一个 `NSLog`。

所以它现在是 **launcher / 本机开发者外壳**，不是可分发安装包 —— 见文末「边界」。

## 构建

```bash
bash apps/macshell/build.sh
```

零第三方依赖，只要有 Command Line Tools 里的 `swiftc`（本机实测 Swift 6.4.2，不需要完整 Xcode）：

- `swiftc -O -parse-as-library -target arm64-apple-macos13.0 -sdk <SDK> -framework AppKit -framework WebKit`
- 组装 `dist/Workbench.app`（`Contents/MacOS/Workbench` + `Info.plist`，`WBRepoRoot` 构建时自动写入仓库根）
- ad-hoc 签名（`codesign --force --sign - `），最后打印产物路径

可重复执行，任何一步失败都非零退出。`dist/` 已进 `.gitignore`。

## 怎么用

```bash
open -a "$PWD/dist/Workbench.app"
```

- **内核已经在跑**（比如你开着 `npm run serve`）：外壳直接 attach，关掉外壳不会动它。
- **内核没在跑**：外壳自己起一个，日志写 `~/Library/Logs/Workbench/kernel.log`；⌘Q 时先 `terminate`，3 秒还在就 `kill -9`。
- `WB_PORT` / `WB_TOKEN` 会透传给内核，外壳也只在这个端口上探测；例如 `WB_PORT=7400` 会起在 7400。

菜单：

| 快捷键 | 动作 |
| --- | --- |
| ⌘R | 刷新页面（重载收件箱） |
| ⌘O | 在 Finder 里打开仓库的数据目录（`data/`） |
| ⌘Q | 退出（先收尾自己起的子进程） |

窗口默认 1200×800、最小 900×640，位置和大小会被记住。

## 仓库定位

按顺序找「含 `src/server/index.mjs` 的目录」：

1. 环境变量 `WB_REPO=/path/to/Deepseek`
2. `Info.plist` 里的 `WBRepoRoot`（`build.sh` 构建时自动写入）
3. 从可执行文件路径向上最多 16 层查找（把 `.app` 放在仓库内的 `dist/` 时天然命中）

都失败会弹原生对话框，列出已尝试的路径和这三种配法。

## 无头自检（WB_SHELL_SMOKE=1）

不建窗口，只做「定位仓库 → attach 或起内核 → 请求 `/api/tasks`」：

```bash
# attach 到已在跑的 7317
WB_SHELL_SMOKE=1 dist/Workbench.app/Contents/MacOS/Workbench
# kernel=ok tasks=3 mode=attach port=7317

# 自己起一个（换端口，顺带验证退出时没有孤儿进程）
WB_PORT=7401 WB_SHELL_SMOKE=1 dist/Workbench.app/Contents/MacOS/Workbench
# kernel=ok tasks=3 mode=spawn port=7401 pid=44898
```

成功打印 `kernel=ok ...` 并 exit 0；失败打印 `kernel=fail <原因>` + 日志路径并 exit 2。
典型失败是端口被别的服务占着（`python3 -m http.server 7399`）：

```
kernel=fail 端口 7399 已被其他服务占用，但它不是工作台内核（GET /api/tasks → HTTP 404：响应不是工作台内核的 JSON ...）
```

## 环境变量

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `WB_REPO` | 空 | 仓库根目录（不给就靠 Info.plist / 向上查找） |
| `WB_PORT` | `7317` | 内核端口，外壳据此 attach/探测 |
| `WB_TOKEN` | 空 | 设了会把 token 带进页面 query，交给 `web/app.js` |
| `WB_NODE` | 空 | 指定 node 可执行文件（默认 PATH、/opt/homebrew/bin、nvm、volta 等） |
| `WB_SHELL_SMOKE` | 空 | `1` = 无头自检模式 |

内核侧由外壳固定注入：`WB_ROOT=<仓库根>`、`WB_DB=<仓库根>/data/ledger.db`（和 CLI 默认一致）。

## 日志

子进程 stdout + stderr 都写 `~/Library/Logs/Workbench/kernel.log`。
若该目录不可写（家目录只读、或在外层沙箱里跑自检），自动退到 `$TMPDIR/Workbench/kernel.log`，并在日志开头注明实际路径。

## 边界（现在故意没做的）

- **需要本机装 node**：内核没被打包进 `.app`，外壳仍然执行 `node src/server/index.mjs`，所以是「本机开发者的 launcher」，不是可分发安装包。要变成安装包，下一步是把 node + 内核塞进 `Contents/Resources`（或用 SEA 打包），并在 app 内定位内核。
- **ad-hoc 签名**：只能本机跑；拷到别的 Mac 会被 Gatekeeper 拦截（可以 `xattr -d com.apple.quarantine` 绕过，但没做公证）。
- **没有公证、没有 Updater、没有 App Sandbox**，也没有 App Store 打包。
- **没做**多窗口、Dock 菜单、崩溃上报、自动更新。
- 内核的 `data/`、worktree 仍在仓库里，没迁移到 `~/Library/Application Support`。
- 只用 `WKWebView` 装页面，没加任何原生 UI；所以「审阅」的体验和浏览器里完全一样（这是刻意的：不重写已有界面）。
