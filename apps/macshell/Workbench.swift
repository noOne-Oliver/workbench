// Workbench.swift — 工作台 macOS 桌面外壳
// 单一 AppKit 窗口 + WKWebView 装已有的三栏审阅收件箱。
// 内核（node + src/ + web/）随 app 打包在 Contents/Resources/kernel 里，脱离仓库也能启动；
// 数据（账本、worktree、起始仓库）写在用户选择的工作区，卸载 app 不会带走。
// 子进程有两个：server（HTTP + 静态页面）与 worker（常驻任务循环，不启动它任务永远排队）。

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
    static let stopGrace: TimeInterval = 3.0
    static let defaultWidth: CGFloat = 1200
    static let defaultHeight: CGFloat = 800
    static let minWidth: CGFloat = 900
    static let minHeight: CGFloat = 640
    static let autosaveName = "WorkbenchShellWindow"
    static let workspaceDefaultsKey = "workspace"
    static let defaultWorkspaceName = "Workbench"
    static let kernelEnvKey = "WB_KERNEL"
}

// 兜底：外壳被 SIGTERM/SIGINT 杀掉时，也把自己起的子进程（server + worker）带走，绝不留孤儿。
// 信号处理器里只碰整数：不能加锁、不能分配内存。
var gServerPid: pid_t = 0
var gWorkerPid: pid_t = 0

func shellSignalHandler(_ sig: Int32) {
    if gServerPid > 0 { kill(gServerPid, SIGKILL) }
    if gWorkerPid > 0 { kill(gWorkerPid, SIGKILL) }
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

func expandPath(_ raw: String) -> URL {
    URL(fileURLWithPath: (raw as NSString).expandingTildeInPath).standardizedFileURL
}

func isoNow() -> String {
    let f = ISO8601DateFormatter()
    f.timeZone = TimeZone.current
    return f.string(from: Date())
}

// MARK: - 内核定位（app 包内）

struct KernelPaths {
    let root: URL
    let node: URL
    let serverEntry: URL
    let cliEntry: URL
    /// 内核目录是怎么定下来的（Resources/kernel 或 WB_KERNEL），只用于日志。
    let source: String

    var serverCommand: String { "\"\(node.path)\" \"\(serverEntry.path)\"" }
    var workerCommand: String { "\"\(node.path)\" \"\(cliEntry.path)\" run" }
}

enum KernelLocator {
    /// 内核跑起来必需的文件；少一个就说明 app 没打全。
    static let requiredFiles = [
        "src/server/index.mjs",
        "src/cli.mjs",
        "src/core/workspace.mjs",
        "web/index.html",
        "package.json",
    ]

    /// 顺序：WB_KERNEL（开发期指到仓库）→ Bundle.main.resourcePath/kernel（打包后的唯一形态）。
    static func resolve() -> (paths: KernelPaths?, error: String, tried: [String]) {
        let fm = FileManager.default
        var roots: [(URL, String)] = []
        if let p = envValue(ShellConst.kernelEnvKey) {
            roots.append((expandPath(p), ShellConst.kernelEnvKey))
        }
        if let res = Bundle.main.resourcePath {
            roots.append((URL(fileURLWithPath: res, isDirectory: true).appendingPathComponent("kernel", isDirectory: true),
                          "Bundle Resources/kernel"))
        }

        var tried: [String] = []
        for (root, source) in roots {
            tried.append("\(source) = \(root.path)")
            guard fm.fileExists(atPath: root.path) else { continue }
            let missing = requiredFiles.filter { !fm.fileExists(atPath: root.appendingPathComponent($0).path) }
            guard missing.isEmpty else {
                tried.append("  缺少文件: \(missing.joined(separator: ", "))")
                continue
            }
            let nodeURL: URL
            if let n = envValue("WB_NODE") {
                nodeURL = expandPath(n)
            } else {
                nodeURL = root.appendingPathComponent("node")
            }
            guard fm.isExecutableFile(atPath: nodeURL.path) else {
                tried.append("  node 不可执行: \(nodeURL.path)")
                continue
            }
            let paths = KernelPaths(
                root: root,
                node: nodeURL,
                serverEntry: root.appendingPathComponent("src/server/index.mjs"),
                cliEntry: root.appendingPathComponent("src/cli.mjs"),
                source: source
            )
            return (paths, "", tried)
        }

        return (nil,
                "找不到随 app 打包的内核（需要 \(requiredFiles.joined(separator: ", "))）。"
                    + "请用 bash apps/macshell/build.sh 重新构建；开发期也可用 \(ShellConst.kernelEnvKey)=/path/to/kernel 指定。",
                tried)
    }
}

// MARK: - 工作区定位

enum WorkspaceLocator {
    static func defaultWorkspace() -> URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(ShellConst.defaultWorkspaceName, isDirectory: true)
    }

    static func isDirectory(_ u: URL) -> Bool {
        var isDir: ObjCBool = false
        return FileManager.default.fileExists(atPath: u.path, isDirectory: &isDir) && isDir.boolValue
    }

    /// 顺序：WB_WORKSPACE → UserDefaults "workspace" → ~/Workbench。
    /// 目标是"目录不存在"时（首次启动、或保存的目录被删了）弹原生面板让用户选；取消则退回 ~/Workbench。
    /// interactive=false（无头自检 / 截图）时绝不弹面板，免得自动化卡在模态框上。
    static func resolve(interactive: Bool) -> (url: URL, source: String, prompted: Bool) {
        if let p = envValue("WB_WORKSPACE") {
            return (expandPath(p), "WB_WORKSPACE", false)
        }

        let defaults = UserDefaults.standard
        if let saved = defaults.string(forKey: ShellConst.workspaceDefaultsKey),
           !saved.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            let u = expandPath(saved)
            if isDirectory(u) { return (u, "UserDefaults workspace", false) }
            if interactive, let picked = prompt(initial: u) {
                return (picked, "NSOpenPanel（保存的工作区不存在，已重选）", true)
            }
            return (defaultWorkspace(), "fallback（保存的工作区不存在）", false)
        }

        let fallback = defaultWorkspace()
        if isDirectory(fallback) { return (fallback, "默认 ~/\(ShellConst.defaultWorkspaceName)", false) }
        if interactive, let picked = prompt(initial: fallback) {
            return (picked, "NSOpenPanel", true)
        }
        return (fallback, "默认 ~/\(ShellConst.defaultWorkspaceName)（未选择）", false)
    }

    /// 首次启动：NSAlert 说明 + NSOpenPanel 选目录（可新建）。返回 nil = 用户取消。
    static func prompt(initial: URL) -> URL? {
        let alert = NSAlert()
        alert.messageText = "选择工作区目录"
        alert.informativeText = """
        工作台把账本、worktree 和起始仓库写在「工作区」里；内核代码在 app 内部，两者分开。
        默认是 ~/\(ShellConst.defaultWorkspaceName)（不存在会自动创建），也可以选一个已有目录，或在这里新建。

        当前：\(initial.path)
        """
        alert.alertStyle = .informational
        alert.addButton(withTitle: "选择目录…")
        alert.addButton(withTitle: "用 ~/\(ShellConst.defaultWorkspaceName)")
        guard alert.runModal() == .alertFirstButtonReturn else { return nil }

        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.canCreateDirectories = true
        panel.allowsMultipleSelection = false
        panel.prompt = "选择工作区"
        panel.message = "工作台会在这里创建 data/、worktrees/ 和 demo/ 起始仓库"
        panel.directoryURL = isDirectory(initial) ? initial : FileManager.default.homeDirectoryForCurrentUser
        guard panel.runModal() == .OK, let url = panel.url else { return nil }

        let picked = url.standardizedFileURL
        UserDefaults.standard.set(picked.path, forKey: ShellConst.workspaceDefaultsKey)
        return picked
    }
}

// MARK: - 工作区初始化（<kernel>/node <kernel>/src/cli.mjs workspace --dir <ws>）

struct WorkspaceInfo {
    let root: String
    let db: String
    let starterRepo: String
    let summary: String
}

enum WorkspaceError: LocalizedError {
    case failed(exit: Int32, output: String, command: String)
    case badOutput(String, command: String)

    var errorDescription: String? {
        switch self {
        case .failed(let code, let output, let command):
            let tail = output.trimmingCharacters(in: .whitespacesAndNewlines)
            return "工作区初始化失败（exit \(code)）：\(command)\n\(tail.isEmpty ? "(没有输出)" : tail)"
        case .badOutput(let output, let command):
            let tail = output.trimmingCharacters(in: .whitespacesAndNewlines)
            return "工作区初始化没有返回 JSON：\(command)\n\(tail.isEmpty ? "(没有输出)" : tail)"
        }
    }
}

enum WorkspaceProvisioner {
    /// 幂等：建 data/ worktrees/ .oc/ 和 demo/ 起始仓库（已有就只补缺，绝不覆盖账本）。
    /// 用打包的 node 跑打包的 cli，所以不再依赖本机 PATH 里的 node；npm 缺失时护栏会退回 node --test。
    static func ensure(paths: KernelPaths, workspace: URL) throws -> WorkspaceInfo {
        let command = "\"\(paths.node.path)\" \"\(paths.cliEntry.path)\" workspace --dir \"\(workspace.path)\""
        let p = Process()
        p.executableURL = paths.node
        p.arguments = [paths.cliEntry.path, "workspace", "--dir", workspace.path]
        p.currentDirectoryURL = paths.root
        p.environment = childEnvironment(paths: paths, workspace: workspace, extra: [:])

        let out = Pipe()
        p.standardOutput = out
        p.standardError = out
        do {
            try p.run()
        } catch {
            throw WorkspaceError.failed(exit: -1, output: String(describing: error), command: command)
        }
        // 先读到 EOF 再等退出：输出很小，不会写满管道。
        let data = out.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        let raw = String(decoding: data, as: UTF8.self)

        guard p.terminationStatus == 0 else {
            throw WorkspaceError.failed(exit: p.terminationStatus, output: raw, command: command)
        }
        guard let line = raw.split(separator: "\n").map(String.init).last(where: { $0.trimmingCharacters(in: .whitespaces).hasPrefix("{") }),
              let jsonData = line.data(using: .utf8),
              let obj = (try? JSONSerialization.jsonObject(with: jsonData)) as? [String: Any] else {
            throw WorkspaceError.badOutput(raw, command: command)
        }

        let root = (obj["root"] as? String) ?? workspace.path
        let db = (obj["db"] as? String) ?? (root as NSString).appendingPathComponent("data/ledger.db")
        let starter = (obj["starterRepo"] as? String) ?? (root as NSString).appendingPathComponent("demo")

        var summary = "root=\(root) db=\(db) starter=\(starter)"
        if let created = obj["created"] as? [String], !created.isEmpty {
            summary += " created=[\(created.joined(separator: ","))]"
        }
        if let starterCreated = obj["starterCreated"] as? Bool {
            summary += " starterCreated=\(starterCreated)"
        }
        if let err = obj["starterError"] as? String {
            summary += " starterError=\(err)"
        }
        return WorkspaceInfo(root: root, db: db, starterRepo: starter, summary: summary)
    }

    /// 两个子进程共用：WB_ROOT/WB_CODE/WB_DB 固定注入，其余环境（WB_ENGINE、WB_MOCK_SCENARIO…）原样继承。
    static func childEnvironment(paths: KernelPaths, workspace: URL, extra: [String: String]) -> [String: String] {
        var env = ProcessInfo.processInfo.environment
        env["WB_ROOT"] = workspace.path
        env["WB_CODE"] = paths.root.path
        env["WB_DB"] = workspace.appendingPathComponent("data/ledger.db").path
        // 子进程看门狗：app 被 kill -9 时没人通知它们退出，内核靠 ppid 变化自己收工（src/core/orphan.mjs）。
        env["WB_PARENT_PID"] = String(ProcessInfo.processInfo.processIdentifier)
        // 真引擎的凭据/配置属于工作区，不属于 app 包：显式指过去（外部已设 WB_OC_HOME 时听外部的）。
        if env["WB_OC_HOME"] == nil || env["WB_OC_HOME"]!.isEmpty {
            env["WB_OC_HOME"] = workspace.appendingPathComponent(".oc").path
        }

        // 打包的 node 在 kernel/ 里：放进 PATH，护栏退回的 node --test 才能直接找到它。
        var parts = [paths.root.path, paths.node.deletingLastPathComponent().path]
        if let existing = env["PATH"], !existing.isEmpty {
            parts.append(existing)
        } else {
            parts.append("/usr/bin:/bin:/usr/sbin:/sbin")
        }
        env["PATH"] = parts.joined(separator: ":")
        for (k, v) in extra { env[k] = v }
        return env
    }
}

// MARK: - 日志（按子进程加前缀，行级切分）

final class PrefixedLogWriter {
    private let prefix: String
    private let sink: (String) -> Void
    private var buffer = Data()
    private let lock = NSLock()

    init(prefix: String, sink: @escaping (String) -> Void) {
        self.prefix = prefix
        self.sink = sink
    }

    func consume(_ data: Data) {
        guard !data.isEmpty else { return }
        lock.lock()
        buffer.append(data)
        var lines: [String] = []
        while let idx = buffer.firstIndex(of: UInt8(ascii: "\n")) {
            let line = buffer[buffer.startIndex..<idx]
            lines.append(String(decoding: line, as: UTF8.self))
            buffer.removeSubrange(buffer.startIndex...idx)
        }
        lock.unlock()
        for line in lines { sink(prefix + " " + line) }
    }

    /// 进程退出时把没换行的最后半行也写出去。
    func flush() {
        lock.lock()
        let rest = buffer
        buffer.removeAll()
        lock.unlock()
        guard !rest.isEmpty else { return }
        sink(prefix + " " + String(decoding: rest, as: UTF8.self))
    }
}

// MARK: - 探测

enum KernelError: LocalizedError {
    case logNotWritable(String)
    case spawnFailed(String)

    var errorDescription: String? {
        switch self {
        case .logNotWritable(let p):
            return "日志文件不可写：\(p)"
        case .spawnFailed(let detail):
            return "子进程启动失败：\(detail)"
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
            return n < 0 ? "内核在线（登录墙内，未取任务数）" : "内核在线，tasks=\(n)"
        case .occupied(let status, let detail):
            return "GET /api/tasks → HTTP \(status)：\(detail)"
        case .down(let detail):
            return "端口没有响应：\(detail)"
        }
    }
}

struct WorkspaceSnapshot {
    let root: String?
    let code: String?
    let engine: String?
    let starterRepo: String?
}

struct SyncHTTPResult {
    let status: Int?
    let data: Data?
    let error: Error?
    let timedOut: Bool
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
            // 401 = 内核在，只是要登录（新工作区默认会建 lead 账号 + 一次性口令）。
            // 早期版本把 401 当成"端口被别的服务占了"，于是每个新用户第一次启动都被挡住。
            return .kernel(tasks: -1)
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

    static func snapshot(from data: Data?) -> WorkspaceSnapshot? {
        guard let data,
              let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return nil }
        return WorkspaceSnapshot(root: obj["root"] as? String,
                                 code: obj["code"] as? String,
                                 engine: obj["engine"] as? String,
                                 starterRepo: obj["starterRepo"] as? String)
    }

    static func request(url: URL, token: String?, timeout: TimeInterval) -> URLRequest {
        var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
        if let token, !token.isEmpty {
            req.setValue(token, forHTTPHeaderField: "X-WB-Token")
        }
        return req
    }

    /// 同步 GET：给 WB_SHELL_SMOKE 用（旋转 run loop，等 dataTask 回调）。
    static func getSync(url: URL, token: String?, timeout: TimeInterval) -> SyncHTTPResult {
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
            return SyncHTTPResult(status: nil, data: nil, error: nil, timedOut: true)
        }
        session.finishTasksAndInvalidate()
        return SyncHTTPResult(status: s, data: d, error: e, timedOut: false)
    }

    static func probeSync(url: URL, token: String?, timeout: TimeInterval) -> ProbeResult {
        let r = getSync(url: url, token: token, timeout: timeout)
        if r.timedOut { return .down(detail: "探测超时（\(Int(timeout)) 秒）") }
        return classify(status: r.status, data: r.data, error: r.error)
    }

    /// 异步 GET：给 GUI 用，回调固定在主线程。
    static func getAsync(url: URL, token: String?, timeout: TimeInterval,
                         completion: @escaping (SyncHTTPResult) -> Void) {
        let cfg = URLSessionConfiguration.ephemeral
        cfg.timeoutIntervalForRequest = timeout
        cfg.waitsForConnectivity = false
        let session = URLSession(configuration: cfg)
        let task = session.dataTask(with: request(url: url, token: token, timeout: timeout)) { d, resp, e in
            let r = SyncHTTPResult(status: (resp as? HTTPURLResponse)?.statusCode, data: d, error: e, timedOut: false)
            session.finishTasksAndInvalidate()
            DispatchQueue.main.async { completion(r) }
        }
        task.resume()
    }

    static func probeAsync(url: URL, token: String?, timeout: TimeInterval,
                           completion: @escaping (ProbeResult) -> Void) {
        getAsync(url: url, token: token, timeout: timeout) { r in
            completion(classify(status: r.status, data: r.data, error: r.error))
        }
    }
}

// MARK: - 子进程

final class ShellChild {
    let name: String          // "server" | "worker"
    let process: Process
    let pipe: Pipe
    let writer: PrefixedLogWriter

    init(name: String, process: Process, pipe: Pipe, writer: PrefixedLogWriter) {
        self.name = name
        self.process = process
        self.pipe = pipe
        self.writer = writer
    }
}

final class Kernel {
    let paths: KernelPaths
    let workspace: URL
    let workspaceSource: String
    let info: WorkspaceInfo
    let port: Int
    let token: String?
    /// 实际使用的日志路径；首选目标不可写时会降级到临时目录。
    private(set) var logURL: URL

    private(set) var children: [ShellChild] = []
    var onUnexpectedExit: ((String, Int32) -> Void)?

    private var logHandle: FileHandle?
    private var stopping = false
    private let logLock = NSLock()

    init(paths: KernelPaths, workspace: URL, workspaceSource: String, info: WorkspaceInfo,
         port: Int, token: String?, logURL: URL) {
        self.paths = paths
        self.workspace = workspace
        self.workspaceSource = workspaceSource
        self.info = info
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
    var apiWorkspaceURL: URL { URL(string: "http://127.0.0.1:\(port)/api/workspace")! }

    /// 页面地址；设了 WB_TOKEN 时把 token 带进 query，和 web/app.js 的约定一致。
    var pageURL: URL {
        var comps = URLComponents(string: "http://127.0.0.1:\(port)/")!
        if let token, !token.isEmpty {
            comps.queryItems = [URLQueryItem(name: "token", value: token)]
        }
        return comps.url!
    }

    var dataDir: URL { workspace.appendingPathComponent("data", isDirectory: true) }
    /// 现在只有一个子进程：cli.mjs up（它自己看护 worker，崩了自动拉起）。
    /// 名字还叫 serverChild 是因为外壳用它判断"内核还在不在"、以及 ⌘R 重启。
    var serverChild: ShellChild? { children.first { $0.name == "kernel" } }
    var workerChild: ShellChild? { nil }

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
        let readSize = min(size, UInt64(32 * 1024))
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
        ProbeTransport.probeAsync(url: apiTasksURL, token: token, timeout: ShellConst.probeTimeout,
                                  completion: completion)
    }

    func workspaceSnapshotSync() -> WorkspaceSnapshot? {
        let r = ProbeTransport.getSync(url: apiWorkspaceURL, token: token, timeout: ShellConst.probeTimeout)
        guard r.status == 200 else { return nil }
        return ProbeTransport.snapshot(from: r.data)
    }

    func workspaceSnapshotAsync(_ completion: @escaping (WorkspaceSnapshot?) -> Void) {
        ProbeTransport.getAsync(url: apiWorkspaceURL, token: token, timeout: ShellConst.probeTimeout) { r in
            completion(r.status == 200 ? ProbeTransport.snapshot(from: r.data) : nil)
        }
    }

    /// 就绪后把内核自报的 workspace/code/engine 记进日志（attach 到别人起的内核时尤其有用）。
    func logRuntimeInfo(attached: Bool, tasks: Int) {
        workspaceSnapshotAsync { [weak self] snap in
            guard let self else { return }
            self.writeLog("==== \(isoNow()) ready mode=\(attached ? "attach" : "spawn") tasks=\(tasks < 0 ? "?" : String(tasks)) "
                + "port=\(self.port) workspace=\(snap?.root ?? self.workspace.path) "
                + "code=\(snap?.code ?? self.paths.root.path) engine=\(snap?.engine ?? "?") ====")
        }
    }

    // MARK: 起子进程

    /// 只在 attach 未命中时调用：server（HTTP + 静态页）+ worker（常驻任务循环）。
    func spawn() throws {
        guard children.isEmpty else { return }
        logHandle = try openLogHandle()
        stopping = false

        if logURL.path != Kernel.preferredLogURL().path {
            writeLog("==== 提示：\(Kernel.preferredLogURL().path) 不可写，日志退到 \(logURL.path) ====")
        }
        writeLog("==== \(isoNow()) shell spawn ====")
        writeLog("==== workspace: \(info.summary)（来源：\(workspaceSource)） ====")
        writeLog("==== kernel: \(paths.root.path)（\(paths.source)）node=\(paths.node.path) ====")
        writeLog("==== kernel: \(paths.node.path) \(paths.cliEntry.path) up ====")

        // 一个进程搞定：up 里起 server + worker，并且看护 worker（崩了退避重启）。
        // 外壳不再负责"发现 worker 死了" —— 这件事交给更懂进程的看护者，外壳只管窗口。
        let kernel = try spawnChild(name: "kernel",
                                    arguments: [paths.cliEntry.path, "up"],
                                    extra: ["WB_PORT": String(port)])
        children = [kernel]
        gServerPid = kernel.process.processIdentifier
    }

    private func spawnChild(name: String, arguments: [String], extra: [String: String]) throws -> ShellChild {
        let p = Process()
        p.executableURL = paths.node
        p.arguments = arguments
        p.currentDirectoryURL = paths.root
        p.environment = WorkspaceProvisioner.childEnvironment(paths: paths, workspace: workspace, extra: extra)

        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = pipe

        let writer = PrefixedLogWriter(prefix: "[\(name)]") { [weak self] line in
            self?.writeLog(line)
        }
        pipe.fileHandleForReading.readabilityHandler = { fh in
            let data = fh.availableData
            if data.isEmpty { return }
            writer.consume(data)
        }
        p.terminationHandler = { [weak self] proc in
            let code = proc.terminationStatus
            DispatchQueue.main.async { self?.childExited(name: name, code: code, writer: writer, pipe: pipe) }
        }

        do {
            try p.run()
        } catch {
            pipe.fileHandleForReading.readabilityHandler = nil
            throw KernelError.spawnFailed("\(name): \(error.localizedDescription)")
        }
        writeLog("==== \(name) pid=\(p.processIdentifier) args=\(arguments.joined(separator: " ")) ====")
        return ShellChild(name: name, process: p, pipe: pipe, writer: writer)
    }

    private func childExited(name: String, code: Int32, writer: PrefixedLogWriter, pipe: Pipe) {
        pipe.fileHandleForReading.readabilityHandler = nil
        let rest = pipe.fileHandleForReading.availableData
        if !rest.isEmpty { writer.consume(rest) }
        writer.flush()
        writeLog("==== \(isoNow()) \(name) exited code=\(code) ====")
        if name == "kernel" { gServerPid = 0 } else { gWorkerPid = 0 }

        let intentional = stopping
        children.removeAll { $0.name == name }
        if intentional { return }

        // 内核整棵退出才需要外壳介入；worker 崩了由 up 自己拉起（退避 1s→2s→4s…封顶 30s）。
        writeLog("==== 警告：内核意外退出（exit=\(code)）；⌘R 可重启 ====")
        onUnexpectedExit?(name, code)
    }

    /// 只终止自己起的子进程：worker 先收、server 后收，每个 SIGTERM → 等 3 秒 → SIGKILL。
    /// attach 模式下 children 为空，什么都不做。
    func stopChildren(reason: String) {
        guard !children.isEmpty else { return }
        stopping = true
        let snapshot = children
        for child in snapshot.reversed() {
            let pid = child.process.processIdentifier
            writeLog("==== \(isoNow()) shell stop \(child.name) pid=\(pid) reason=\(reason) ====")
            if child.process.isRunning { child.process.terminate() }
            let deadline = Date().addingTimeInterval(ShellConst.stopGrace)
            while child.process.isRunning && Date() < deadline {
                usleep(50_000)
            }
            if child.process.isRunning {
                kill(pid, SIGKILL)
                writeLog("==== \(child.name) 3 秒后仍在，已 SIGKILL ====")
                let hard = Date().addingTimeInterval(1.0)
                while child.process.isRunning && Date() < hard {
                    usleep(20_000)
                }
            }
            child.pipe.fileHandleForReading.readabilityHandler = nil
            child.writer.flush()
        }
        children = []
        gServerPid = 0
        gWorkerPid = 0
        writeLog("==== \(isoNow()) shell children stopped（\(snapshot.map { $0.name }.joined(separator: ", "))） ====")

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

    static func placeholder(port: Int, workspace: String, kernel: String, logPath: String) -> String {
        let body = """
        <h1>工作台</h1>
        <p class="spin">正在连接内核…</p>
        <dl>
          <dt>端口</dt><dd>127.0.0.1:\(port)</dd>
          <dt>工作区</dt><dd>\(esc(workspace))</dd>
          <dt>内核</dt><dd>\(esc(kernel))</dd>
          <dt>内核日志</dt><dd>\(esc(logPath))</dd>
        </dl>
        <p class="muted">已在跑就直接接管；没在跑就由外壳拉起 server 与 worker，最多等 15 秒。</p>
        """
        return wrap("工作台 · 启动中", body)
    }

    static func errorPage(reason: String, port: Int, workspace: String, kernel: String,
                          logPath: String, tail: String) -> String {
        let safeTail = esc(tail.isEmpty ? "(日志为空)" : tail)
        let body = """
        <h1>内核没有起来</h1>
        <p class="reason">\(esc(reason))</p>
        <dl>
          <dt>端口</dt><dd>127.0.0.1:\(port)</dd>
          <dt>工作区</dt><dd>\(esc(workspace))</dd>
          <dt>内核</dt><dd>\(esc(kernel))</dd>
          <dt>内核日志</dt><dd>\(esc(logPath))</dd>
        </dl>
        <h2>怎么排查</h2>
        <ul>
          <li>看日志：<code>tail -n 80 "\(esc(logPath))"</code></li>
          <li>手动起 server：<code>WB_ROOT="\(esc(workspace))" WB_CODE="\(esc(kernel))" "\(esc(kernel))/node" "\(esc(kernel))/src/server/index.mjs"</code></li>
          <li>手动起 worker：<code>WB_ROOT="\(esc(workspace))" WB_CODE="\(esc(kernel))" "\(esc(kernel))/node" "\(esc(kernel))/src/cli.mjs" run</code></li>
          <li>只起 server 任务会永远排队 —— 两个进程缺一不可</li>
          <li>端口被别的服务占着就换一个：重启外壳前设 <code>WB_PORT=7401</code></li>
          <li>按 <kbd>⌘R</kbd> 重试，<kbd>⌘O</kbd> 打开工作区数据目录，<kbd>⌘Q</kbd> 退出</li>
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
    private var shotOK = false

    // MARK: 生命周期

    func applicationDidFinishLaunching(_ notification: Notification) {
        installSignalHandlers()

        // 1) 内核：只在 app 包里找（WB_KERNEL 是开发期后门）
        let located = KernelLocator.resolve()
        guard let paths = located.paths else {
            showFatalAlert(title: "找不到 app 内置内核",
                           message: located.error + "\n\n已尝试：\n" + located.tried.joined(separator: "\n"))
        }

        // 2) 工作区：WB_WORKSPACE → UserDefaults → ~/Workbench；不存在时弹面板选
        let interactive = envValue("WB_SHELL_SMOKE") != "1" && envValue("WB_SHELL_SHOT") == nil
        let ws = WorkspaceLocator.resolve(interactive: interactive)

        // 3) 启动前把目录结构与起始仓库补齐（幂等）
        let info: WorkspaceInfo
        do {
            info = try WorkspaceProvisioner.ensure(paths: paths, workspace: ws.url)
        } catch {
            showFatalAlert(title: "工作区初始化失败",
                           message: error.localizedDescription + "\n\n工作区：\(ws.url.path)")
        }

        let port = Int(envValue("WB_PORT") ?? "") ?? ShellConst.defaultPort
        let k = Kernel(paths: paths, workspace: ws.url, workspaceSource: ws.source, info: info,
                       port: port, token: envValue("WB_TOKEN"), logURL: Kernel.logFileURL())
        k.onUnexpectedExit = { [weak self] name, code in
            guard let self, self.loaded else { return }
            self.fail(reason: "\(name) 进程意外退出（exit=\(code)）。可以按 ⌘R 重新拉起。")
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
        kernel?.stopChildren(reason: "app quit")
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

        if envValue("WB_SHELL_SHOT") != nil {
            // 截图模式：只要窗口被渲染，不抢焦点、不激活，自动化跑的时候不打扰人。
            window.orderFrontRegardless()
        } else {
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
        }
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
        let openData = NSMenuItem(title: "打开工作区数据目录", action: #selector(openDataDir(_:)), keyEquivalent: "o")
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
        kernel?.stopChildren(reason: "manual retry")
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
                // 已有内核在跑：纯 attach，不再起 worker（避免两个 worker 抢同一个任务）
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
        if let server = kernel.serverChild, !server.process.isRunning {
            fail(reason: "server 子进程已退出（exit=\(server.process.terminationStatus)），端口 \(kernel.port) 没起来。")
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
        kernel.logRuntimeInfo(attached: attached, tasks: tasks)
        let mode = attached ? "attach" : "spawn"
        print("ready mode=\(mode) port=\(kernel.port) workspace=\(kernel.workspace.path) "
            + "code=\(kernel.paths.root.path) tasks=\(tasks < 0 ? "?" : String(tasks)) log=\(kernel.logURL.path)")
        NSLog("workbench shell ready: tasks=%d mode=%@ port=%d workspace=%@ code=%@",
              tasks, mode, kernel.port, kernel.workspace.path, kernel.paths.root.path)
    }

    private func fail(reason: String) {
        bootTimer?.invalidate()
        bootTimer = nil
        probing = false
        loaded = false
        guard let kernel else { return }
        kernel.stopChildren(reason: "boot failed")
        let html = ShellHTML.errorPage(reason: reason,
                                       port: kernel.port,
                                       workspace: kernel.workspace.path,
                                       kernel: kernel.paths.root.path,
                                       logPath: kernel.logURL.path,
                                       tail: kernel.logTail(maxLines: 30))
        webView.loadHTMLString(html, baseURL: nil)
        window.title = "工作台 · 内核未就绪"
        NSLog("workbench shell failed: %@", reason)
    }

    private func showPlaceholder() {
        guard let kernel else { return }
        webView.loadHTMLString(ShellHTML.placeholder(port: kernel.port,
                                                     workspace: kernel.workspace.path,
                                                     kernel: kernel.paths.root.path,
                                                     logPath: kernel.logURL.path),
                               baseURL: nil)
    }

    private func showFatalAlert(title: String, message: String) -> Never {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        alert.alertStyle = .critical
        alert.addButton(withTitle: "退出")
        alert.runModal()
        exit(2)
    }

    // MARK: WKNavigationDelegate

    /// WB_SHELL_SHOT=/path/out.png：加载完页面后截图存档再退出。
    /// 这是"人到底看到什么"的证据通道 —— 不依赖系统录屏权限，也不需要肉眼看窗口。
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard loaded, let shotPath = envValue("WB_SHELL_SHOT") else { return }
        // 前端是 fetch 完再渲染的，给它一点时间把卡片画出来
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
            self?.captureScreenshot(to: shotPath)
        }
    }

    private func captureScreenshot(to path: String) {
        // 先问一句"页面到底画出来没有"：DOM 是可断言的，像素只能靠人眼。
        let probe = "JSON.stringify({cards:document.querySelectorAll('.card').length, nodes:document.querySelectorAll('*').length, text:(document.body.innerText||'').slice(0,160)})"
        webView.evaluateJavaScript(probe) { [weak self] result, error in
            guard let self else { return }
            if let error {
                print("dom=fail \(error.localizedDescription)")
            } else {
                print("dom=\(result ?? "nil")")
            }
            self.snapshotTo(path: path)
        }
    }

    private func snapshotTo(path: String) {
        let cfg = WKSnapshotConfiguration()
        cfg.rect = webView.bounds
        webView.takeSnapshot(with: cfg) { [weak self] image, error in
            guard let self else { return }
            let finish: (Int32) -> Never = { code in
                self.kernel?.stopChildren(reason: "screenshot done")
                exit(code)
            }
            if let error {
                print("shot=fail \(error.localizedDescription)")
                finish(2)
            }
            guard let image, let tiff = image.tiffRepresentation,
                  let rep = NSBitmapImageRep(data: tiff),
                  let png = rep.representation(using: .png, properties: [:]) else {
                print("shot=fail 截图无法编码为 PNG")
                finish(2)
            }
            let url = URL(fileURLWithPath: (path as NSString).expandingTildeInPath)
            do {
                try FileManager.default.createDirectory(at: url.deletingLastPathComponent(),
                                                        withIntermediateDirectories: true)
                try png.write(to: url)
                self.shotOK = true
                print("shot=ok path=\(url.path) bytes=\(png.count) size=\(Int(image.size.width))x\(Int(image.size.height))")
                finish(0)
            } catch {
                print("shot=fail 写入失败：\(error.localizedDescription)")
                finish(2)
            }
        }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        guard loaded else { return }
        fail(reason: "页面加载失败：\(error.localizedDescription)")
    }
}

// MARK: - 无头自检（WB_SHELL_SMOKE=1）

enum SmokeCheck {
    static func run() -> Never {
        installSignalHandlers()

        let located = KernelLocator.resolve()
        guard let paths = located.paths else {
            fail("找不到 app 内置内核：\(located.error)\n已尝试：\(located.tried.joined(separator: " | "))",
                 logPath: Kernel.logFileURL().path)
        }

        // 自检绝不弹面板：给了 WB_WORKSPACE 就用，没给就落到 ~/Workbench
        let ws = WorkspaceLocator.resolve(interactive: false)
        let info: WorkspaceInfo
        do {
            info = try WorkspaceProvisioner.ensure(paths: paths, workspace: ws.url)
        } catch {
            fail("工作区初始化失败：\(error.localizedDescription)", logPath: Kernel.logFileURL().path)
        }

        let port = Int(envValue("WB_PORT") ?? "") ?? ShellConst.defaultPort
        let kernel = Kernel(paths: paths, workspace: ws.url, workspaceSource: ws.source, info: info,
                            port: port, token: envValue("WB_TOKEN"), logURL: Kernel.logFileURL())
        print("workspace=\(info.root) workspaceSource=\(ws.source) starterRepo=\(info.starterRepo)")

        // 1) 已经在跑 → attach，不碰别人的进程
        switch kernel.probeSync() {
        case .kernel(let n):
            let snap = kernel.workspaceSnapshotSync()
            print("kernel=ok tasks=\(n < 0 ? "?" : String(n)) mode=attach port=\(port) "
                + "workspace=\(snap?.root ?? info.root) code=\(snap?.code ?? paths.root.path) "
                + "engine=\(snap?.engine ?? "?")")
            exit(0)
        case .occupied(let status, let detail):
            fail("端口 \(port) 已被其他服务占用，但它不是工作台内核（GET /api/tasks → HTTP \(status)：\(detail)）。"
                + "请先释放该端口，或用 WB_PORT 换一个端口。",
                logPath: kernel.logURL.path)
        case .down:
            break
        }

        // 2) 没在跑 → 自己起 server + worker，每 150ms 探一次，最多 15 秒
        do {
            try kernel.spawn()
        } catch {
            fail("启动内核失败：\(error.localizedDescription)", logPath: kernel.logURL.path)
        }

        let deadline = Date().addingTimeInterval(ShellConst.bootDeadline)
        while Date() < deadline {
            usleep(useconds_t(ShellConst.probeInterval * 1_000_000))

            if case .kernel(let n) = kernel.probeSync() {
                let snap = kernel.workspaceSnapshotSync()
                print("kernel=ok tasks=\(n < 0 ? "?" : String(n)) mode=spawn port=\(port) "
                    + "workspace=\(snap?.root ?? info.root) code=\(snap?.code ?? paths.root.path) "
                    + "engine=\(snap?.engine ?? "?") "
                    + "server=\(kernel.serverChild?.process.processIdentifier ?? -1) "
                    + "worker=\(kernel.workerChild?.process.processIdentifier ?? -1) log=\(kernel.logURL.path)")
                kernel.stopChildren(reason: "smoke done")
                exit(0)
            }

            if let server = kernel.serverChild, !server.process.isRunning {
                let status = server.process.terminationStatus
                kernel.stopChildren(reason: "server exited early")
                fail("server 子进程提前退出（exit=\(status)），端口 \(port) 没就绪。最近日志：\n"
                    + kernel.logTail(maxLines: 20),
                    logPath: kernel.logURL.path)
            }
        }

        kernel.stopChildren(reason: "boot timeout")
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
