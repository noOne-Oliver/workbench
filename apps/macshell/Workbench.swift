// Workbench.swift — 工作台 macOS 桌面外壳
// 单一 AppKit 窗口 + WKWebView 装已有的三栏审阅收件箱，并托管内核（node src/server/index.mjs）的生命周期。
// 目标：零第三方依赖 —— 只要 swiftc + 系统框架 + 本机 node。

import AppKit
import Darwin
import Foundation
import WebKit

// MARK: - 常量

enum ShellConst {
    static let defaultPort = 7317
    static let probeTimeout: TimeInterval = 1.0
    static let probeInterval: TimeInterval = 0.15
    static let bootDeadline: TimeInterval = 15.0
    static let defaultWidth: CGFloat = 1200
    static let defaultHeight: CGFloat = 800
    static let minWidth: CGFloat = 900
    static let minHeight: CGFloat = 640
    static let autosaveName = "WorkbenchShellWindow"
}

// 兜底：外壳被 SIGTERM/SIGINT 杀掉时，也把自己起的子进程带走，绝不留孤儿。
var gChildPid: pid_t = 0

func shellSignalHandler(_ sig: Int32) {
    if gChildPid > 0 {
        kill(gChildPid, SIGKILL)
    }
    exit(128 + sig)
}

func installSignalHandlers() {
    for sig in [SIGTERM, SIGINT, SIGHUP] {
        signal(sig, shellSignalHandler)
    }
}

func envValue(_ key: String) -> String? {
    guard let raw = ProcessInfo.processInfo.environment[key] else { return nil }
    let v = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    return v.isEmpty ? nil : v
}

func isoNow() -> String {
    let f = ISO8601DateFormatter()
    f.timeZone = TimeZone.current
    return f.string(from: Date())
}

// MARK: - 仓库定位

enum RepoLocator {
    static func looksLikeRepo(_ dir: URL) -> Bool {
        FileManager.default.fileExists(atPath: dir.appendingPathComponent("src/server/index.mjs").path)
    }

    /// 顺序：WB_REPO → Info.plist 的 WBRepoRoot → 从可执行文件向上找含 src/server/index.mjs 的目录。
    static func resolve() -> (root: URL?, source: String, tried: [String]) {
        var tried: [String] = []

        if let p = envValue("WB_REPO") {
            let u = URL(fileURLWithPath: (p as NSString).expandingTildeInPath).standardizedFileURL
            tried.append("WB_REPO=\(u.path)")
            if looksLikeRepo(u) { return (u, "WB_REPO", tried) }
        }

        if let p = Bundle.main.object(forInfoDictionaryKey: "WBRepoRoot") as? String,
           !p.trimmingCharacters(in: .whitespaces).isEmpty {
            let u = URL(fileURLWithPath: (p as NSString).expandingTildeInPath).standardizedFileURL
            tried.append("Info.plist WBRepoRoot=\(u.path)")
            if looksLikeRepo(u) { return (u, "Info.plist WBRepoRoot", tried) }
        }

        let exe = Bundle.main.executableURL ?? URL(fileURLWithPath: CommandLine.arguments[0])
        var dir = exe.resolvingSymlinksInPath().deletingLastPathComponent()
        for _ in 0..<16 {
            tried.append("向上查找: \(dir.path)")
            if looksLikeRepo(dir) { return (dir, "可执行文件向上查找", tried) }
            let parent = dir.deletingLastPathComponent()
            if parent.path == dir.path { break }
            dir = parent
        }
        return (nil, "未定位", tried)
    }
}

// MARK: - node 定位（GUI 由 LaunchServices 启动时 PATH 很稀薄，得自己找）

enum NodeLocator {
    static func find() -> String? {
        let fm = FileManager.default
        if let p = envValue("WB_NODE"), fm.isExecutableFile(atPath: p) { return p }

        var candidates: [String] = [
            "/opt/homebrew/bin/node",
            "/opt/homebrew/opt/node@22/bin/node",
            "/opt/homebrew/opt/node/bin/node",
            "/usr/local/bin/node",
            "/usr/bin/node",
            "/opt/local/bin/node",
        ]
        if let path = ProcessInfo.processInfo.environment["PATH"] {
            for dir in path.split(separator: ":") where !dir.isEmpty {
                candidates.append(String(dir) + "/node")
            }
        }
        for c in candidates where fm.isExecutableFile(atPath: c) { return c }

        // nvm / volta / asdf / 本地安装
        let home = fm.homeDirectoryForCurrentUser
        let nvmRoot = home.appendingPathComponent(".nvm/versions/node", isDirectory: true)
        if let versions = try? fm.contentsOfDirectory(atPath: nvmRoot.path) {
            for v in versions.sorted(by: >) {
                let candidate = nvmRoot.appendingPathComponent(v).appendingPathComponent("bin/node").path
                if fm.isExecutableFile(atPath: candidate) { return candidate }
            }
        }
        for rel in [".volta/bin/node", ".asdf/shims/node", ".local/bin/node", "bin/node"] {
            let candidate = home.appendingPathComponent(rel).path
            if fm.isExecutableFile(atPath: candidate) { return candidate }
        }
        return nil
    }
}

// MARK: - 内核

enum KernelError: LocalizedError {
    case nodeNotFound
    case logNotWritable(String)
    case spawnFailed(String)

    var errorDescription: String? {
        switch self {
        case .nodeNotFound:
            return "找不到 node 可执行文件（试过 PATH、/opt/homebrew/bin、nvm、volta 等）。可用 WB_NODE=/path/to/node 指定。"
        case .logNotWritable(let p):
            return "日志文件不可写：\(p)"
        case .spawnFailed(let detail):
            return "node 子进程启动失败：\(detail)"
        }
    }
}

enum ProbeResult {
    case kernel(tasks: Int)
    case occupied(status: Int, detail: String)
    case down(detail: String)

    var isKernel: Bool {
        if case .kernel = self { return true }
        return false
    }

    var summary: String {
        switch self {
        case .kernel(let n):
            return "内核在线，tasks=\(n)"
        case .occupied(let status, let detail):
            return "GET /api/tasks → HTTP \(status)：\(detail)"
        case .down(let detail):
            return "端口没有响应：\(detail)"
        }
    }
}

enum ProbeTransport {
    static func classify(status: Int?, data: Data?, error: Error?) -> ProbeResult {
        if let error {
            let ns = error as NSError
            if ns.domain == NSURLErrorDomain && ns.code == NSURLErrorCannotConnectToHost {
                return .down(detail: "连接被拒绝（端口没在监听）")
            }
            return .down(detail: ns.localizedDescription)
        }
        guard let status else { return .down(detail: "没有拿到 HTTP 响应") }

        let obj = data.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any]
        if status == 401 {
            return .occupied(status: status, detail: "服务要求 token（检查 WB_TOKEN 是否与服务一致）")
        }
        if let obj, let tasks = obj["tasks"] as? [Any] {
            return .kernel(tasks: tasks.count)
        }
        if let obj, let err = obj["error"] as? String {
            return .occupied(status: status, detail: "返回 error=\(err)")
        }
        let head = (data.map { String(decoding: $0.prefix(80), as: UTF8.self) } ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return .occupied(status: status, detail: "响应不是工作台内核的 JSON（开头：\(head)）")
    }

    static func request(url: URL, token: String?, timeout: TimeInterval) -> URLRequest {
        var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
        if let token, !token.isEmpty {
            req.setValue(token, forHTTPHeaderField: "X-WB-Token")
        }
        return req
    }

    /// 同步探测：给 WB_SHELL_SMOKE 用（旋转 run loop，等 dataTask 回调）。
    static func probeSync(url: URL, token: String?, timeout: TimeInterval) -> ProbeResult {
        let lock = NSLock()
        var status: Int?
        var data: Data?
        var error: Error?
        var done = false

        let cfg = URLSessionConfiguration.ephemeral
        cfg.timeoutIntervalForRequest = timeout
        cfg.timeoutIntervalForResource = timeout
        cfg.waitsForConnectivity = false
        let session = URLSession(configuration: cfg)
        let task = session.dataTask(with: request(url: url, token: token, timeout: timeout)) { d, resp, e in
            lock.lock()
            status = (resp as? HTTPURLResponse)?.statusCode
            data = d
            error = e
            done = true
            lock.unlock()
        }
        task.resume()

        let deadline = Date().addingTimeInterval(timeout + 1.5)
        while Date() < deadline {
            lock.lock()
            let finished = done
            lock.unlock()
            if finished { break }
            RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.02))
        }
        lock.lock()
        let finished = done
        let s = status
        let d = data
        let e = error
        lock.unlock()

        if !finished {
            task.cancel()
            session.invalidateAndCancel()
            return .down(detail: "探测超时（\(Int(timeout)) 秒）")
        }
        session.finishTasksAndInvalidate()
        return classify(status: s, data: d, error: e)
    }

    /// 异步探测：给 GUI 用，回调固定在主线程。
    static func probeAsync(url: URL, token: String?, timeout: TimeInterval, completion: @escaping (ProbeResult) -> Void) {
        let cfg = URLSessionConfiguration.ephemeral
        cfg.timeoutIntervalForRequest = timeout
        cfg.waitsForConnectivity = false
        let session = URLSession(configuration: cfg)
        let task = session.dataTask(with: request(url: url, token: token, timeout: timeout)) { d, resp, e in
            let result = classify(status: (resp as? HTTPURLResponse)?.statusCode, data: d, error: e)
            session.finishTasksAndInvalidate()
            DispatchQueue.main.async { completion(result) }
        }
        task.resume()
    }
}

final class Kernel {
    let repoRoot: URL
    let port: Int
    let token: String?
    /// 实际使用的日志路径；首选目标不可写时会降级到临时目录。
    private(set) var logURL: URL

    private(set) var child: Process?
    private(set) var ownsChild = false
    var onUnexpectedExit: ((Int32) -> Void)?

    private var pipe: Pipe?
    private var logHandle: FileHandle?
    private var stopping = false
    private let logLock = NSLock()

    init(repoRoot: URL, port: Int, token: String?, logURL: URL) {
        self.repoRoot = repoRoot
        self.port = port
        self.token = token
        self.logURL = logURL
    }

    static func logFileURL() -> URL { preferredLogURL() }

    /// 首选：~/Library/Logs/Workbench/kernel.log
    static func preferredLogURL() -> URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Logs/Workbench", isDirectory: true)
            .appendingPathComponent("kernel.log")
    }

    /// 降级：$TMPDIR/Workbench/kernel.log（家目录只读、沙箱内跑自检时用）
    static func fallbackLogURL() -> URL {
        FileManager.default.temporaryDirectory
            .appendingPathComponent("Workbench", isDirectory: true)
            .appendingPathComponent("kernel.log")
    }

    /// 按候选顺序打开第一个可写的日志文件，并把实际路径记到 logURL。
    private func openLogHandle() throws -> FileHandle {
        let fm = FileManager.default
        let candidates = [Kernel.preferredLogURL(), Kernel.fallbackLogURL()]
        for candidate in candidates {
            let dir = candidate.deletingLastPathComponent()
            try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
            if !fm.fileExists(atPath: candidate.path) {
                _ = fm.createFile(atPath: candidate.path, contents: nil)
            }
            guard let handle = try? FileHandle(forWritingTo: candidate) else { continue }
            logURL = candidate
            _ = handle.seekToEndOfFile()
            return handle
        }
        throw KernelError.logNotWritable(candidates.map { $0.path }.joined(separator: " 或 "))
    }

    var baseURL: URL { URL(string: "http://127.0.0.1:\(port)/")! }

    var apiTasksURL: URL { URL(string: "http://127.0.0.1:\(port)/api/tasks")! }

    /// 页面地址；设了 WB_TOKEN 时把 token 带进 query，和 web/app.js 的约定一致。
    var pageURL: URL {
        var comps = URLComponents(string: "http://127.0.0.1:\(port)/")!
        if let token, !token.isEmpty {
            comps.queryItems = [URLQueryItem(name: "token", value: token)]
        }
        return comps.url!
    }

    var dataDir: URL { repoRoot.appendingPathComponent("data", isDirectory: true) }

    var dbPath: String { dataDir.appendingPathComponent("ledger.db").path }

    // MARK: 日志

    private func writeLogData(_ data: Data) {
        guard !data.isEmpty else { return }
        logLock.lock()
        defer { logLock.unlock() }
        guard let h = logHandle else { return }
        try? h.write(contentsOf: data)
    }

    func writeLog(_ line: String) {
        writeLogData(Data((line + "\n").utf8))
    }

    func logTail(maxLines: Int) -> String {
        guard let h = try? FileHandle(forReadingFrom: logURL) else { return "(日志文件还没生成：\(logURL.path))" }
        defer { try? h.close() }
        let size = (try? h.seekToEnd()) ?? 0
        let readSize = min(size, UInt64(16 * 1024))
        if readSize == 0 { return "(日志为空：\(logURL.path))" }
        try? h.seek(toOffset: size - readSize)
        let data = (try? h.read(upToCount: Int(readSize))) ?? Data()
        let text = String(decoding: data, as: UTF8.self)
        let lines = text.split(separator: "\n", omittingEmptySubsequences: false).suffix(maxLines)
        return lines.joined(separator: "\n")
    }

    // MARK: 探测

    func probeSync() -> ProbeResult {
        ProbeTransport.probeSync(url: apiTasksURL, token: token, timeout: ShellConst.probeTimeout)
    }

    func probeAsync(_ completion: @escaping (ProbeResult) -> Void) {
        ProbeTransport.probeAsync(url: apiTasksURL, token: token, timeout: ShellConst.probeTimeout, completion: completion)
    }

    // MARK: 起内核

    func spawn() throws {
        if child != nil { return }
        guard let node = NodeLocator.find() else { throw KernelError.nodeNotFound }

        logHandle = try openLogHandle()
        stopping = false

        if logURL.path != Kernel.preferredLogURL().path {
            writeLog("==== 提示：\(Kernel.preferredLogURL().path) 不可写，日志退到 \(logURL.path) ====")
        }
        writeLog("==== \(isoNow()) shell spawn node=\(node) port=\(port) repo=\(repoRoot.path) ====")

        let p = Process()
        p.executableURL = URL(fileURLWithPath: node)
        p.arguments = ["src/server/index.mjs"]
        p.currentDirectoryURL = repoRoot

        var environment = ProcessInfo.processInfo.environment
        environment["WB_ROOT"] = repoRoot.path
        environment["WB_DB"] = dbPath
        environment["WB_PORT"] = String(port)
        let nodeDir = (node as NSString).deletingLastPathComponent
        environment["PATH"] = nodeDir + ":" + (environment["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin")
        p.environment = environment

        let outPipe = Pipe()
        p.standardOutput = outPipe
        p.standardError = outPipe
        outPipe.fileHandleForReading.readabilityHandler = { [weak self] fh in
            let data = fh.availableData
            if data.isEmpty { return }
            self?.writeLogData(data)
        }
        p.terminationHandler = { [weak self] proc in
            let status = proc.terminationStatus
            DispatchQueue.main.async { self?.childExited(code: status) }
        }

        do {
            try p.run()
        } catch {
            try? logHandle?.close()
            logHandle = nil
            throw KernelError.spawnFailed(String(describing: error))
        }

        child = p
        ownsChild = true
        pipe = outPipe
        gChildPid = p.processIdentifier
        writeLog("==== shell child pid=\(p.processIdentifier) ====")
    }

    private func childExited(code: Int32) {
        writeLog("==== \(isoNow()) shell child exited code=\(code) ====")
        pipe?.fileHandleForReading.readabilityHandler = nil
        if let fh = pipe?.fileHandleForReading {
            let rest = fh.availableData
            if !rest.isEmpty { writeLogData(rest) }
        }
        let wasOwned = ownsChild
        let intentional = stopping
        ownsChild = false
        child = nil
        gChildPid = 0
        if wasOwned && !intentional {
            onUnexpectedExit?(code)
        }
        if intentional {
            logLock.lock()
            try? logHandle?.close()
            logHandle = nil
            logLock.unlock()
        }
    }

    /// 只终止自己起的子进程：SIGTERM → 等 3 秒 → SIGKILL。attach 模式下 ownsChild=false，什么都不做。
    func stopChild(reason: String) {
        guard let p = child, ownsChild else { return }
        stopping = true
        let pid = p.processIdentifier
        writeLog("==== \(isoNow()) shell stop child pid=\(pid) reason=\(reason) ====")
        if p.isRunning { p.terminate() }
        let deadline = Date().addingTimeInterval(3)
        while p.isRunning && Date() < deadline {
            usleep(50_000)
        }
        if p.isRunning {
            kill(pid, SIGKILL)
            writeLog("==== shell child still alive after 3s, sent SIGKILL ====")
            let hard = Date().addingTimeInterval(1)
            while p.isRunning && Date() < hard {
                usleep(20_000)
            }
        }
        pipe?.fileHandleForReading.readabilityHandler = nil
        child = nil
        ownsChild = false
        gChildPid = 0
        logLock.lock()
        try? logHandle?.close()
        logHandle = nil
        logLock.unlock()
    }
}


// MARK: - 静态页面（启动占位 / 失败页）

enum ShellHTML {
    static func esc(_ s: String) -> String {
        s.replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
            .replacingOccurrences(of: "\"", with: "&quot;")
    }

    static func wrap(_ title: String, _ body: String) -> String {
        return """
        <!doctype html>
        <html lang="zh-CN"><head><meta charset="utf-8">
        <title>\(esc(title))</title>
        <style>
          :root { color-scheme: light dark; }
          body { font: 14px/1.6 -apple-system, "PingFang SC", Helvetica, Arial, sans-serif;
                 margin: 0; padding: 48px 56px; max-width: 900px; color: #1f2328; background: #fbfbfa; }
          @media (prefers-color-scheme: dark) { body { color: #e6e6e6; background: #1c1c1e; } }
          h1 { font-size: 20px; margin: 0 0 8px; }
          h2 { font-size: 15px; margin: 28px 0 8px; }
          p { margin: 8px 0; }
          ul { margin: 8px 0 8px 20px; padding: 0; }
          li { margin: 4px 0; }
          .muted { color: #6a737d; }
          .reason { padding: 12px 14px; border-left: 3px solid #d1242f; background: #fff5f5;
                    border-radius: 4px; white-space: pre-wrap; word-break: break-word; }
          @media (prefers-color-scheme: dark) { .reason { background: #2a1818; } }
          dl { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; margin: 16px 0; }
          dt { color: #6a737d; }
          dd { margin: 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px;
               word-break: break-all; }
          pre.log { margin: 8px 0; padding: 12px; background: #f2f2f0; border-radius: 6px; overflow: auto;
                    max-height: 320px; font-size: 12px; line-height: 1.5; }
          @media (prefers-color-scheme: dark) { pre.log { background: #232325; } }
          kbd { border: 1px solid #d0d7de; border-bottom-width: 2px; border-radius: 4px; padding: 0 5px;
                font: 12px ui-monospace, Menlo, monospace; }
          .spin { color: #6a737d; }
        </style></head>
        <body>
        \(body)
        </body></html>
        """
    }

    static func placeholder(port: Int, repo: String, logPath: String) -> String {
        let body = """
        <h1>工作台</h1>
        <p class="spin">正在连接内核…</p>
        <dl>
          <dt>端口</dt><dd>127.0.0.1:\(port)</dd>
          <dt>仓库</dt><dd>\(esc(repo))</dd>
          <dt>内核日志</dt><dd>\(esc(logPath))</dd>
        </dl>
        <p class="muted">已在跑就直接接管；没在跑就由外壳拉起 node src/server/index.mjs，最多等 15 秒。</p>
        """
        return wrap("工作台 · 启动中", body)
    }

    static func errorPage(reason: String, port: Int, repo: String, logPath: String, tail: String) -> String {
        let safeTail = esc(tail.isEmpty ? "(日志为空)" : tail)
        let body = """
        <h1>内核没有起来</h1>
        <p class="reason">\(esc(reason))</p>
        <dl>
          <dt>端口</dt><dd>127.0.0.1:\(port)</dd>
          <dt>仓库</dt><dd>\(esc(repo))</dd>
          <dt>内核日志</dt><dd>\(esc(logPath))</dd>
        </dl>
        <h2>怎么排查</h2>
        <ul>
          <li>看日志：<code>tail -n 80 "\(esc(logPath))"</code></li>
          <li>手动试一次：<code>WB_ROOT="\(esc(repo))" WB_DB="\(esc(repo))/data/ledger.db" node src/server/index.mjs</code></li>
          <li>端口被别的服务占着就换一个：重启外壳前设 <code>WB_PORT=7401</code></li>
          <li>按 <kbd>⌘R</kbd> 重试，<kbd>⌘O</kbd> 打开数据目录，<kbd>⌘Q</kbd> 退出</li>
        </ul>
        <h2>日志末尾</h2>
        <pre class="log">\(safeTail)</pre>
        """
        return wrap("工作台 · 内核未就绪", body)
    }
}

// MARK: - 主界面

enum ShellApp {
    static let delegate = AppDelegate()
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var kernel: Kernel?
    private var bootTimer: Timer?
    private var bootStartedAt = Date()
    private var probing = false
    private var loaded = false

    // MARK: 生命周期

    func applicationDidFinishLaunching(_ notification: Notification) {
        installSignalHandlers()

        let located = RepoLocator.resolve()
        guard let root = located.root else {
            showRepoAlert(located)
            return
        }

        let port = Int(envValue("WB_PORT") ?? "") ?? ShellConst.defaultPort
        let k = Kernel(repoRoot: root, port: port, token: envValue("WB_TOKEN"), logURL: Kernel.logFileURL())
        k.onUnexpectedExit = { [weak self] code in
            guard let self, self.loaded else { return }
            self.fail(reason: "内核进程意外退出（exit=\(code)）。可以按 ⌘R 重新拉起。")
        }
        kernel = k

        buildMenu()
        buildWindow()
        startBoot()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return true
    }

    func applicationWillTerminate(_ notification: Notification) {
        bootTimer?.invalidate()
        bootTimer = nil
        kernel?.stopChild(reason: "app quit")
    }

    // MARK: 窗口 / 菜单

    private func buildWindow() {
        let rect = NSRect(x: 0, y: 0, width: ShellConst.defaultWidth, height: ShellConst.defaultHeight)
        window = NSWindow(contentRect: rect,
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered,
                          defer: false)
        window.title = "工作台 · Workbench"
        window.minSize = NSSize(width: ShellConst.minWidth, height: ShellConst.minHeight)
        window.isReleasedWhenClosed = false
        window.tabbingMode = .disallowed

        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        webView = WKWebView(frame: rect, configuration: config)
        webView.autoresizingMask = [.width, .height]
        webView.navigationDelegate = self
        window.contentView = webView

        // 记住窗口位置：上次的 frame 存在 UserDefaults 里，下次启动自动恢复。
        let restored = window.setFrameUsingName(ShellConst.autosaveName)
        window.setFrameAutosaveName(ShellConst.autosaveName)
        if !restored { window.center() }

        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func buildMenu() {
        let mainMenu = NSMenu()

        let appItem = NSMenuItem()
        mainMenu.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "关于 工作台",
                        action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)),
                        keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "退出 工作台",
                        action: #selector(NSApplication.terminate(_:)),
                        keyEquivalent: "q")
        appItem.submenu = appMenu

        // 编辑菜单不是摆设：WKWebView 里的文本框（比如驳回理由）靠标准编辑菜单才能用 ⌘C/⌘V。
        let editItem = NSMenuItem()
        mainMenu.addItem(editItem)
        let editMenu = NSMenu(title: "编辑")
        editMenu.addItem(withTitle: "撤销", action: Selector(("undo:")), keyEquivalent: "z")
        editMenu.addItem(withTitle: "重做", action: Selector(("redo:")), keyEquivalent: "Z")
        editMenu.addItem(.separator())
        editMenu.addItem(withTitle: "剪切", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "拷贝", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "粘贴", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "全选", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = editMenu

        let viewItem = NSMenuItem()
        mainMenu.addItem(viewItem)
        let viewMenu = NSMenu(title: "视图")
        let reload = NSMenuItem(title: "刷新页面", action: #selector(reloadPage(_:)), keyEquivalent: "r")
        reload.target = self
        viewMenu.addItem(reload)
        let openData = NSMenuItem(title: "打开数据目录", action: #selector(openDataDir(_:)), keyEquivalent: "o")
        openData.target = self
        viewMenu.addItem(openData)
        viewItem.submenu = viewMenu

        let windowItem = NSMenuItem()
        mainMenu.addItem(windowItem)
        let windowMenu = NSMenu(title: "窗口")
        windowMenu.addItem(withTitle: "最小化", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "缩放", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        windowItem.submenu = windowMenu
        NSApp.windowsMenu = windowMenu

        NSApp.mainMenu = mainMenu
    }

    @objc private func reloadPage(_ sender: Any?) {
        if loaded {
            webView.reload()
            return
        }
        // 启动失败后再按 ⌘R：收掉残留子进程，重新走一遍 attach / spawn。
        bootTimer?.invalidate()
        bootTimer = nil
        kernel?.stopChild(reason: "manual retry")
        startBoot()
    }

    @objc private func openDataDir(_ sender: Any?) {
        guard let kernel else { return }
        let fm = FileManager.default
        if !fm.fileExists(atPath: kernel.dataDir.path) {
            try? fm.createDirectory(at: kernel.dataDir, withIntermediateDirectories: true)
        }
        NSWorkspace.shared.open(kernel.dataDir)
    }

    // MARK: 启动流程

    private func startBoot() {
        guard let kernel else { return }
        loaded = false
        probing = false
        showPlaceholder()

        kernel.probeAsync { [weak self] result in
            guard let self, let kernel = self.kernel else { return }
            switch result {
            case .kernel(let n):
                self.ready(tasks: n, attached: true)
            case .occupied:
                self.fail(reason: "端口 \(kernel.port) 已被其他服务占用，但它不是工作台内核（\(result.summary)）。"
                    + "请先关掉占用该端口的进程，或用 WB_PORT 换一个端口再启动。")
            case .down:
                self.spawnKernel()
            }
        }
    }

    private func spawnKernel() {
        guard let kernel else { return }
        do {
            try kernel.spawn()
        } catch {
            fail(reason: "启动内核失败：\(error.localizedDescription)")
            return
        }
        bootStartedAt = Date()
        bootTimer?.invalidate()
        bootTimer = Timer.scheduledTimer(withTimeInterval: ShellConst.probeInterval, repeats: true) { [weak self] _ in
            self?.tick()
        }
    }

    private func tick() {
        guard let kernel else { return }
        if Date().timeIntervalSince(bootStartedAt) > ShellConst.bootDeadline {
            fail(reason: "内核 \(Int(ShellConst.bootDeadline)) 秒内没有就绪（端口 \(kernel.port) 一直没有响应）。")
            return
        }
        if let p = kernel.child, !p.isRunning {
            fail(reason: "内核子进程已退出，端口 \(kernel.port) 没起来。")
            return
        }
        if probing { return }
        probing = true
        kernel.probeAsync { [weak self] result in
            guard let self else { return }
            self.probing = false
            if case .kernel(let n) = result {
                self.ready(tasks: n, attached: false)
            }
        }
    }

    private func ready(tasks: Int, attached: Bool) {
        bootTimer?.invalidate()
        bootTimer = nil
        probing = false
        loaded = true
        guard let kernel else { return }
        window.title = "工作台 · Workbench（:\(kernel.port)）"
        webView.load(URLRequest(url: kernel.pageURL))
        NSLog("workbench shell ready: tasks=%d mode=%@ port=%d",
              tasks, attached ? "attach" : "spawn", kernel.port)
    }

    private func fail(reason: String) {
        bootTimer?.invalidate()
        bootTimer = nil
        probing = false
        loaded = false
        guard let kernel else { return }
        kernel.stopChild(reason: "boot failed")
        let html = ShellHTML.errorPage(reason: reason,
                                       port: kernel.port,
                                       repo: kernel.repoRoot.path,
                                       logPath: kernel.logURL.path,
                                       tail: kernel.logTail(maxLines: 30))
        webView.loadHTMLString(html, baseURL: nil)
        window.title = "工作台 · 内核未就绪"
        NSLog("workbench shell failed: %@", reason)
    }

    private func showPlaceholder() {
        guard let kernel else { return }
        webView.loadHTMLString(ShellHTML.placeholder(port: kernel.port,
                                                     repo: kernel.repoRoot.path,
                                                     logPath: kernel.logURL.path),
                               baseURL: nil)
    }

    private func showRepoAlert(_ located: (root: URL?, source: String, tried: [String])) {
        let alert = NSAlert()
        alert.messageText = "找不到工作台仓库"
        alert.informativeText = """
        外壳需要仓库根目录（含 src/server/index.mjs 的目录）才能起内核。

        三种配置方式，任选其一：
        1) 启动时设环境变量 WB_REPO=/path/to/Deepseek
        2) 在 Info.plist 里写 WBRepoRoot（build.sh 会自动写入仓库根）
        3) 把 .app 放在仓库目录下（例如 dist/），外壳会从可执行文件向上查找

        已尝试：
        \(located.tried.suffix(8).joined(separator: "\n"))
        """
        alert.alertStyle = .critical
        alert.addButton(withTitle: "退出")
        alert.runModal()
        exit(2)
    }

    // MARK: WKNavigationDelegate

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        guard loaded else { return }
        fail(reason: "页面加载失败：\(error.localizedDescription)")
    }
}

// MARK: - 无头自检（WB_SHELL_SMOKE=1）

enum SmokeCheck {
    static func run() -> Never {
        installSignalHandlers()

        let located = RepoLocator.resolve()
        guard let root = located.root else {
            fail("仓库未定位（找不到含 src/server/index.mjs 的目录）。已尝试："
                + located.tried.joined(separator: " | ")
                + "；用 WB_REPO=/path/to/repo 指定。",
                logPath: Kernel.logFileURL().path)
        }

        let port = Int(envValue("WB_PORT") ?? "") ?? ShellConst.defaultPort
        let kernel = Kernel(repoRoot: root, port: port, token: envValue("WB_TOKEN"), logURL: Kernel.logFileURL())

        // 1) 已经在跑 → attach，不碰别人的进程
        switch kernel.probeSync() {
        case .kernel(let n):
            print("kernel=ok tasks=\(n) mode=attach port=\(port)")
            exit(0)
        case .occupied(let status, let detail):
            fail("端口 \(port) 已被其他服务占用，但它不是工作台内核（GET /api/tasks → HTTP \(status)：\(detail)）。"
                + "请先释放该端口，或用 WB_PORT 换一个端口。",
                logPath: kernel.logURL.path)
        case .down:
            break
        }

        // 2) 没在跑 → 自己起一个，每 150ms 探一次，最多 15 秒
        do {
            try kernel.spawn()
        } catch {
            fail("启动内核失败：\(error.localizedDescription)", logPath: kernel.logURL.path)
        }

        let deadline = Date().addingTimeInterval(ShellConst.bootDeadline)
        while Date() < deadline {
            usleep(useconds_t(ShellConst.probeInterval * 1_000_000))

            if case .kernel(let n) = kernel.probeSync() {
                print("kernel=ok tasks=\(n) mode=spawn port=\(port) pid=\(kernel.child?.processIdentifier ?? -1)")
                kernel.stopChild(reason: "smoke done")
                exit(0)
            }

            if let p = kernel.child, !p.isRunning {
                let status = p.terminationStatus
                kernel.stopChild(reason: "child exited early")
                fail("内核子进程提前退出（exit=\(status)），端口 \(port) 没就绪。最近日志：\n"
                    + kernel.logTail(maxLines: 20),
                    logPath: kernel.logURL.path)
            }
        }

        kernel.stopChild(reason: "boot timeout")
        fail("内核 \(Int(ShellConst.bootDeadline)) 秒内没有就绪（端口 \(port)）。最近日志：\n"
            + kernel.logTail(maxLines: 20),
            logPath: kernel.logURL.path)
    }

    private static func fail(_ reason: String, logPath: String) -> Never {
        print("kernel=fail \(reason)")
        if FileManager.default.fileExists(atPath: logPath) {
            print("日志：\(logPath)")
        } else {
            print("日志：\(logPath)（本次没有起内核，日志未生成）")
        }
        exit(2)
    }
}

// MARK: - 入口

@main
struct WorkbenchShellMain {
    static func main() {
        installSignalHandlers()

        if envValue("WB_SHELL_SMOKE") == "1" {
            SmokeCheck.run()
        }

        let app = NSApplication.shared
        app.setActivationPolicy(.regular)
        app.delegate = ShellApp.delegate
        app.run()
    }
}
