// sheet.swift — contact sheets of numbered frames (e.g. a burst.sh run), for reviewing a
// tap sequence at a glance: 6 per row, 12 per sheet, each labelled with its frame number.
// Dependency-free (AppKit only) — replaces sheet.py, which needed Pillow.
//
// qa-toolkit 0.8.1 — copy into the project repo; compare with the plugin copy before trusting an old one.
//
// Prerequisites: macOS with Xcode command-line tools.
// Usage:  swift sheet.swift <prefix> [--width 430] [--cols 6] [--per-sheet 12]
//         (or the compiled binary build.sh makes: build/sheet <prefix> …)
//         reads <prefix>-NNN.png (e.g. out/frame -> out/frame-000.png …, 4+ digits too),
//         writes <prefix>-sheet0.jpg, -sheet1.jpg, … and prints their paths.
import AppKit

func fail(_ msg: String, _ code: Int32 = 1) -> Never {
    FileHandle.standardError.write((msg + "\n").data(using: .utf8)!)
    exit(code)
}

var positional: [String] = []
var width = 430, cols = 6, perSheet = 12
var it = CommandLine.arguments.dropFirst().makeIterator()
while let a = it.next() {
    switch a {
    case "--width", "--cols", "--per-sheet":
        guard let v = it.next(), let n = Int(v), n > 0 else { fail("\(a) needs a positive number", 64) }
        if a == "--width" { width = n } else if a == "--cols" { cols = n } else { perSheet = n }
    case "-h", "--help":
        print("usage: sheet.swift <prefix> [--width 430] [--cols 6] [--per-sheet 12]"); exit(0)
    default: positional.append(a)
    }
}
guard positional.count == 1 else { fail("usage: sheet.swift <prefix> [--width 430] [--cols 6] [--per-sheet 12]", 64) }
let prefix = positional[0]

// <prefix>-<digits>.png, sorted by frame number
let dir = (prefix as NSString).deletingLastPathComponent
let base = (prefix as NSString).lastPathComponent + "-"
let names = (try? FileManager.default.contentsOfDirectory(atPath: dir.isEmpty ? "." : dir)) ?? []
let frames: [(n: Int, label: String, path: String)] = names.compactMap { name in
    guard name.hasPrefix(base), name.hasSuffix(".png") else { return nil }
    let digits = String(name.dropFirst(base.count).dropLast(4))
    guard digits.count >= 3, digits.allSatisfy({ $0.isASCII && $0.isNumber }), let n = Int(digits) else { return nil }
    return (n, digits, dir.isEmpty ? name : (dir as NSString).appendingPathComponent(name))
}.sorted { $0.n < $1.n }
guard !frames.isEmpty else { fail("no frames matching \(prefix)-NNN.png") }

let labelH: CGFloat = 40
let font = NSFont.systemFont(ofSize: 32)
let w = CGFloat(width)

for (sheetIndex, start) in stride(from: 0, to: frames.count, by: perSheet).enumerated() {
    let part = Array(frames[start..<min(start + perSheet, frames.count)])
    let images: [(label: String, img: NSImage?)] = part.map { ($0.label, NSImage(contentsOfFile: $0.path)) }
    func thumbHeight(_ img: NSImage?) -> CGFloat {
        guard let s = img?.size, s.width > 0 else { return w }
        return (s.height * w / s.width).rounded()
    }
    let cellH = images.map { thumbHeight($0.img) }.max() ?? w
    let rows = (images.count + cols - 1) / cols
    let W = Int(w) * cols, H = Int((cellH + labelH) * CGFloat(rows))
    guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: W, pixelsHigh: H, bitsPerSample: 8,
                                     samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                     colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else { fail("cannot allocate sheet") }
    rep.size = NSSize(width: W, height: H)  // 1 point = 1 pixel
    NSGraphicsContext.saveGraphicsState()
    let ctx = NSGraphicsContext(bitmapImageRep: rep)
    ctx?.imageInterpolation = .high
    NSGraphicsContext.current = ctx
    NSColor.white.setFill()
    NSRect(x: 0, y: 0, width: W, height: H).fill()
    for (i, item) in images.enumerated() {
        let x = CGFloat(i % cols) * w
        let top = CGFloat(i / cols) * (cellH + labelH)  // distance from the top edge
        let th = thumbHeight(item.img)
        // AppKit's origin is bottom-left: convert from top-based layout.
        (item.label as NSString).draw(at: NSPoint(x: x + 10, y: CGFloat(H) - top - labelH + 2),
                                      withAttributes: [.font: font, .foregroundColor: NSColor.red])
        if let img = item.img {
            img.draw(in: NSRect(x: x, y: CGFloat(H) - top - labelH - th, width: w, height: th))
        } else {
            ("unreadable" as NSString).draw(at: NSPoint(x: x + 10, y: CGFloat(H) - top - labelH - 40),
                                            withAttributes: [.font: font, .foregroundColor: NSColor.gray])
        }
    }
    NSGraphicsContext.restoreGraphicsState()
    let out = "\(prefix)-sheet\(sheetIndex).jpg"
    guard let jpg = rep.representation(using: .jpeg, properties: [.compressionFactor: 0.8]) else { fail("cannot encode \(out)") }
    do { try jpg.write(to: URL(fileURLWithPath: out)) } catch { fail("cannot write \(out): \(error)") }
    print(out)
}
