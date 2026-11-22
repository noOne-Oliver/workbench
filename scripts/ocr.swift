import Foundation
import Vision
import AppKit

// 检查截图里有没有本机痕迹（用户名/家目录路径）。Vision 的 OCR 够用：
// 我们只关心"图里是否出现某几个字符串"，不需要高精度排版还原。
//
// 注意：在受限沙箱里跑不起来（Vision 的 XPC 被挡，报 TextRecognition.CRImageReaderError.unknownError），
// 普通终端里可用：
//   swift scripts/ocr.swift docs/shell-shot.png liujie /Users/
// 命中返回 1，干净返回 0。截图脚本本身也有 DOM 断言，这里只是事后复核老图。
guard CommandLine.arguments.count > 1 else {
    FileHandle.standardError.write("用法: ocr.swift <png> [needle...]\n".data(using: .utf8)!)
    exit(2)
}
let path = CommandLine.arguments[1]
let needles = Array(CommandLine.arguments.dropFirst(2))
guard let img = NSImage(contentsOfFile: path), let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    FileHandle.standardError.write("读不到图: \(path)\n".data(using: .utf8)!)
    exit(3)
}
let req = VNRecognizeTextRequest()
req.recognitionLevel = .accurate
req.recognitionLanguages = ["zh-Hans", "en-US"]
req.usesLanguageCorrection = false
let handler = VNImageRequestHandler(cgImage: cg, options: [:])
try handler.perform([req])
let lines = (req.results ?? []).compactMap { $0.topCandidates(1).first?.string }
if needles.isEmpty {
    print(lines.joined(separator: " | "))
} else {
    let hits = needles.filter { n in lines.contains { $0.contains(n) } }
    print(hits.isEmpty ? "OK" : "HIT " + hits.joined(separator: ","))
}
