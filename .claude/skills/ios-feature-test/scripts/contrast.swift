// contrast.swift — WCAG contrast measured on a screenshot. Scans one pixel row (or a rectangle),
// splits it into colour runs, and prints each run's colour, width in px and pt, and the contrast
// ratio between adjacent runs, flagged against 4.5:1 (WCAG 1.4.3 normal text) and 3:1 (large text,
// and WCAG 1.4.11 non-text: borders, focus rings, icons, control boundaries).
//
// qa-toolkit 0.9.0 — copy into the project repo; compare with the plugin copy before trusting an old one.
//
// Derive --y from the element's frame in the accessibility tree × scale, e.g. the middle of a field
// border: y_px = (frame.Y + frame.Height / 2) × 3, or frame.Y × 3 + 1 for its top edge. Derive it
// again for every screenshot — layouts shift between light and dark mode (and with text size), so a
// row that crossed the border in one mode can miss it in the other.
//
// Prerequisites: macOS, Swift toolchain (AppKit/CoreGraphics only, no packages).
// Usage:
//   swift contrast.swift <image.png> --y PX [--x0 PX] [--x1 PX] [--scale 3] [--min-run 2] [--merge 6]
//   swift contrast.swift <image.png> --rect x,y,w,h [--top 6] [--merge 24]
//   swift contrast.swift --colors '#RRGGBB' '#RRGGBB'
//   --y        pixel row to scan (origin top-left); --x0/--x1 limit it (default the whole row)
//   --scale    px per pt for the pt column (default 3; 2 on 2x devices)
//   --min-run  hide runs narrower than this many px (anti-aliasing) before pairing (default 2;
//              use 1 for hairlines)
//   --merge    a pixel starts a new run when |ΔR|+|ΔG|+|ΔB| from the run's first pixel exceeds this
//   --rect     instead of a row: the most frequent colours in the rectangle (the first is taken as
//              the background) and each one's contrast against it — useful for text on a fill
//   --colors   just the ratio between two colours (e.g. two theme values)
// Anti-aliased text edges give in-between colours: for text, read the darkest/lightest run (or the
// rect mode's second colour), not the edge pixels. Pixels are read in sRGB; alpha is ignored.
// Exit code: 0, or 1 on bad arguments / unreadable image.
import AppKit
import Foundation

typealias RGB = (Int, Int, Int)

func fail(_ msg: String) -> Never {
  FileHandle.standardError.write((msg + "\n").data(using: .utf8)!)
  exit(1)
}

func lum(_ c: RGB) -> Double {
  func ch(_ v: Int) -> Double { let s = Double(v) / 255; return s <= 0.04045 ? s / 12.92 : pow((s + 0.055) / 1.055, 2.4) }
  return 0.2126 * ch(c.0) + 0.7152 * ch(c.1) + 0.0722 * ch(c.2)
}
func ratio(_ a: RGB, _ b: RGB) -> Double {
  let l1 = lum(a), l2 = lum(b)
  return (max(l1, l2) + 0.05) / (min(l1, l2) + 0.05)
}
func verdict(_ r: Double) -> String {
  let text = r >= 4.5 ? "text PASS" : "text FAIL"
  let large = r >= 3 ? "large/non-text PASS" : "large/non-text FAIL"
  return "\(text), \(large)"
}
func hex(_ c: RGB) -> String { String(format: "#%02X%02X%02X", c.0, c.1, c.2) }
func parseHex(_ s: String) -> RGB? {
  var h = s.hasPrefix("#") ? String(s.dropFirst()) : s
  if h.count == 3 { h = h.map { "\($0)\($0)" }.joined() }
  guard h.count == 6, let v = Int(h, radix: 16) else { return nil }
  return ((v >> 16) & 0xFF, (v >> 8) & 0xFF, v & 0xFF)
}
func dist(_ a: RGB, _ b: RGB) -> Int { abs(a.0 - b.0) + abs(a.1 - b.1) + abs(a.2 - b.2) }

let usage = """
  usage: swift contrast.swift <image.png> --y PX [--x0 PX] [--x1 PX] [--scale 3] [--min-run 2] [--merge 6]
         swift contrast.swift <image.png> --rect x,y,w,h [--top 6] [--merge 24]
         swift contrast.swift --colors '#RRGGBB' '#RRGGBB'
  """
let args = Array(CommandLine.arguments.dropFirst())
var opts: [String: String] = [:]
var positional: [String] = []
var colorPair: [String] = []
var i = 0
while i < args.count {
  let a = args[i]
  if a == "-h" || a == "--help" { print(usage); exit(0) }
  if a == "--colors" {
    guard i + 2 < args.count else { fail("--colors needs two colours") }
    colorPair = [args[i + 1], args[i + 2]]
    i += 3
    continue
  }
  if a.hasPrefix("--") {
    guard i + 1 < args.count else { fail("\(a) needs a value") }
    opts[String(a.dropFirst(2))] = args[i + 1]
    i += 2
    continue
  }
  positional.append(a)
  i += 1
}
for k in opts.keys where !["y", "x0", "x1", "scale", "min-run", "merge", "rect", "top"].contains(k) {
  fail("unknown option --\(k)\n\(usage)")
}
func intOpt(_ k: String, _ d: Int?) -> Int? {
  guard let s = opts[k] else { return d }
  guard let v = Int(s) else { fail("--\(k): integer expected") }
  return v
}

if colorPair.count == 2 {
  guard let a = parseHex(colorPair[0]), let b = parseHex(colorPair[1]) else { fail("--colors: #RRGGBB #RRGGBB") }
  let r = ratio(a, b)
  print(String(format: "%@ vs %@  %.2f:1  ", hex(a), hex(b), r) + verdict(r))
  exit(0)
}

guard let path = positional.first else { fail(usage) }
guard let img = NSImage(contentsOfFile: path),
      let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else { fail("cannot read image: \(path)") }
let w = cg.width, h = cg.height
var data = [UInt8](repeating: 0, count: w * h * 4)
guard let ctx = CGContext(data: &data, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                          space: CGColorSpace(name: CGColorSpace.sRGB)!,
                          bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { fail("cannot create bitmap") }
ctx.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
func px(_ x: Int, _ y: Int) -> RGB { let o = (y * w + x) * 4; return (Int(data[o]), Int(data[o + 1]), Int(data[o + 2])) }
let scale = Double(opts["scale"] ?? "3") ?? 3
let name = (path as NSString).lastPathComponent

if let rs = opts["rect"] {
  // Rect mode: frequency of colours, clustered greedily within --merge.
  let p = rs.split(separator: ",").compactMap { Int($0) }
  guard p.count == 4 else { fail("--rect: x,y,w,h in pixels") }
  let x0 = max(0, p[0]), y0 = max(0, p[1]), x1 = min(w, p[0] + p[2]), y1 = min(h, p[1] + p[3])
  guard x0 < x1, y0 < y1 else { fail("--rect lies outside the \(w)x\(h) image") }
  let merge = intOpt("merge", 24)!, top = intOpt("top", 6)!
  var exact: [Int: Int] = [:]
  for y in y0..<y1 { for x in x0..<x1 { let c = px(x, y); exact[(c.0 << 16) | (c.1 << 8) | c.2, default: 0] += 1 } }
  var clusters: [(c: RGB, n: Int)] = []
  for (k, n) in exact.sorted(by: { $0.value > $1.value }) {
    let c: RGB = ((k >> 16) & 0xFF, (k >> 8) & 0xFF, k & 0xFF)
    if let j = clusters.firstIndex(where: { dist($0.c, c) <= merge }) { clusters[j].n += n } else { clusters.append((c, n)) }
  }
  clusters.sort { $0.n > $1.n }
  let total = (x1 - x0) * (y1 - y0)
  print("# \(name) \(w)x\(h) px, rect \(x0),\(y0) \(x1 - x0)x\(y1 - y0) px, colours merged within \(merge)")
  let bg = clusters[0].c
  for (j, cl) in clusters.prefix(top).enumerated() {
    var line = String(format: "  %@  %6.2f%%", hex(cl.c), 100.0 * Double(cl.n) / Double(total))
    if j == 0 { line += "  (background)" } else {
      let r = ratio(cl.c, bg)
      line += String(format: "  %.2f:1 vs background  ", r) + verdict(r)
    }
    print(line)
  }
  exit(0)
}

guard let y = intOpt("y", nil) else { fail("--y (pixel row) or --rect is required\n\(usage)") }
guard y >= 0 && y < h else { fail("--y \(y) outside the image (0..\(h - 1))") }
let x0 = max(0, intOpt("x0", 0)!), x1 = min(w - 1, intOpt("x1", w - 1)!)
guard x0 < x1 else { fail("--x0 must be below --x1") }
let merge = intOpt("merge", 6)!, minRun = intOpt("min-run", 2)!

// Runs: start colour, sum for the average, first and last x.
var runs: [(first: RGB, sum: (Int, Int, Int), a: Int, b: Int)] = []
var cur = (first: px(x0, y), sum: (0, 0, 0), a: x0, b: x0)
for x in x0...x1 {
  let c = px(x, y)
  if x > x0 && dist(c, cur.first) > merge { runs.append(cur); cur = (c, (0, 0, 0), x, x) }
  cur.sum.0 += c.0; cur.sum.1 += c.1; cur.sum.2 += c.2; cur.b = x
}
runs.append(cur)
func avg(_ r: (first: RGB, sum: (Int, Int, Int), a: Int, b: Int)) -> RGB {
  let n = Double(r.b - r.a + 1)
  return (Int((Double(r.sum.0) / n).rounded()), Int((Double(r.sum.1) / n).rounded()), Int((Double(r.sum.2) / n).rounded()))
}
let kept = runs.filter { $0.b - $0.a + 1 >= minRun }
print("# \(name) \(w)x\(h) px, row y=\(y) (\(String(format: "%.1f", Double(y) / scale)) pt), x \(x0)-\(x1), " +
      "scale \(scale), \(runs.count) runs, \(runs.count - kept.count) under \(minRun) px hidden")
var prev: RGB? = nil
for r in kept {
  let c = avg(r), n = r.b - r.a + 1
  var line = String(format: "x %5d-%5d  %5d px %7.2f pt  %@ rgb(%3d,%3d,%3d)", r.a, r.b, n, Double(n) / scale, hex(c), c.0, c.1, c.2)
  if let p = prev {
    let q = ratio(c, p)
    line += String(format: "  %5.2f:1 vs previous  ", q) + verdict(q)
  }
  print(line)
  prev = c
}
