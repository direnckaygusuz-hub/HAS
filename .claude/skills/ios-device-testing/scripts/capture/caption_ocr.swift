// caption_ocr.swift — OCR a strip of each captured frame with Vision. Made for the VoiceOver
// Caption Panel (Settings > Accessibility > VoiceOver > Caption Panel): it prints what
// VoiceOver speaks in a strip at the bottom of the screen, so a burst.sh run while the user
// swipes through a screen becomes a transcript of what was spoken, in order.
//
// qa-toolkit 0.8.1 — copy into the project repo; compare with the plugin copy before trusting an old one.
//
// Prerequisites: macOS with Xcode command-line tools (Vision is built in). Frames from the
// USB capture (grab.sh / burst.sh) are upright in landscape too; driver screenshots are not.
// Usage:  swift caption_ocr.swift [--strip 0.05] [--top] [--lang en-US,nl-NL] [--changes] <png>...
//         (or the compiled binary build.sh makes: build/caption_ocr …)
//   --strip F   fraction of the frame height to read (default 0.05 = the Caption Panel)
//   --top       read the top strip instead of the bottom one; --strip 1 reads the whole frame
//   --lang L    recognition languages, comma-separated (default: Vision's automatic choice)
//   --changes   print a line only when the text differs from the previous frame's
// Output: one line per frame, "<file name>\t<text>" ("<file name>\tERR …" if unreadable).
import AppKit
import Foundation
import Vision

func fail(_ msg: String, _ code: Int32 = 64) -> Never {
    FileHandle.standardError.write((msg + "\n").data(using: .utf8)!)
    exit(code)
}

var strip = 0.05, top = false, changesOnly = false
var langs: [String] = []
var files: [String] = []
var it = CommandLine.arguments.dropFirst().makeIterator()
while let a = it.next() {
    switch a {
    case "--strip":
        guard let v = it.next(), let f = Double(v), f > 0, f <= 1 else { fail("--strip needs a fraction in (0, 1]") }
        strip = f
    case "--top": top = true
    case "--changes": changesOnly = true
    case "--lang":
        guard let v = it.next() else { fail("--lang needs a value") }
        langs = v.split(separator: ",").map(String.init)
    case "-h", "--help":
        print("usage: caption_ocr.swift [--strip 0.05] [--top] [--lang en-US] [--changes] <png>..."); exit(0)
    default: files.append(a)
    }
}
guard !files.isEmpty else { fail("usage: caption_ocr.swift [--strip 0.05] [--top] [--lang en-US] [--changes] <png>...") }

var previous: String? = nil
for path in files {
    let name = (path as NSString).lastPathComponent
    guard let img = NSImage(contentsOfFile: path),
          let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
        print("\(name)\tERR unreadable"); continue
    }
    let h = cg.height, w = cg.width
    let sh = max(1, Int(Double(h) * strip))
    // CGImage cropping uses a top-left origin.
    let rect = CGRect(x: 0, y: top ? 0 : h - sh, width: w, height: sh)
    guard let crop = cg.cropping(to: rect) else { print("\(name)\tERR crop"); continue }
    let req = VNRecognizeTextRequest()
    req.recognitionLevel = .accurate
    req.usesLanguageCorrection = false
    if !langs.isEmpty { req.recognitionLanguages = langs }
    do { try VNImageRequestHandler(cgImage: crop).perform([req]) } catch {
        print("\(name)\tERR \(error.localizedDescription)"); continue
    }
    // Reading order: top to bottom, then left to right (Vision's boxes have a bottom-left origin).
    let obs = (req.results ?? []).sorted {
        abs($0.boundingBox.midY - $1.boundingBox.midY) > 0.02 ? $0.boundingBox.midY > $1.boundingBox.midY
                                                              : $0.boundingBox.minX < $1.boundingBox.minX
    }
    let text = obs.compactMap { $0.topCandidates(1).first?.string }.joined(separator: " ")
    if changesOnly && text == previous { continue }
    previous = text
    print("\(name)\t\(text)")
}
