// colorcount.swift — the "loud colour" method for theme tickets: put deliberately loud test colours
// in the theme, take a screenshot, and count how many pixels are within a tolerance of each colour.
// A count shows where a theme key landed (or that it never did); the AVERAGE colour of the matching
// pixels shows what actually matched — a wide tolerance once counted a navy illustration as the
// theme's dark background, and only the average gave it away. Keep the tolerance tight.
//
// qa-toolkit 0.9.0 — copy into the project repo; compare with the plugin copy before trusting an old one.
//
// Prerequisites: macOS, Swift toolchain (AppKit/CoreGraphics only, no packages).
// Usage:
//   swift colorcount.swift <image.png> <colour>... [--tol 12] [--step 1] [--rect x,y,w,h]
//   colour: #RRGGBB or RRGGBB, optionally named: bg=#FF00FF
//   --tol   max difference per channel, 0-255 (default 12)
//   --step  sample every Nth pixel in x and y (default 1 = every pixel)
//   --rect  only count inside this pixel rectangle (origin top-left)
// Pixels are read in sRGB (a Display P3 screenshot is converted), alpha ignored.
// Output per colour: matching pixels, share of the sampled pixels, average matching colour and
// its distance from the target; "drift" when the average is more than tol/2 away on any channel —
// then the matches are probably another colour (an illustration, a gradient), not the theme value.
// Exit code: 0, or 1 on bad arguments / unreadable image.
import AppKit
import Foundation

func fail(_ msg: String) -> Never {
  FileHandle.standardError.write((msg + "\n").data(using: .utf8)!)
  exit(1)
}

func parseHex(_ s: String) -> (Int, Int, Int)? {
  var h = s.hasPrefix("#") ? String(s.dropFirst()) : s
  if h.count == 3 { h = h.map { "\($0)\($0)" }.joined() }
  guard h.count == 6, let v = Int(h, radix: 16) else { return nil }
  return ((v >> 16) & 0xFF, (v >> 8) & 0xFF, v & 0xFF)
}

var args = Array(CommandLine.arguments.dropFirst())
var tol = 12, step = 1
var rect: (Int, Int, Int, Int)? = nil
var positional: [String] = []
var i = 0
while i < args.count {
  let a = args[i]
  func value() -> String {
    guard i + 1 < args.count else { fail("\(a) needs a value") }
    i += 1
    return args[i]
  }
  switch a {
  case "--tol": guard let v = Int(value()), v >= 0 else { fail("--tol: integer 0-255") }; tol = v
  case "--step": guard let v = Int(value()), v >= 1 else { fail("--step: integer >= 1") }; step = v
  case "--rect":
    let p = value().split(separator: ",").compactMap { Int($0) }
    guard p.count == 4 else { fail("--rect: x,y,w,h in pixels") }
    rect = (p[0], p[1], p[2], p[3])
  case "-h", "--help":
    print("usage: swift colorcount.swift <image.png> <#RRGGBB|name=#RRGGBB>... [--tol 12] [--step 1] [--rect x,y,w,h]")
    exit(0)
  default: positional.append(a)
  }
  i += 1
}
guard positional.count >= 2 else {
  fail("usage: swift colorcount.swift <image.png> <#RRGGBB|name=#RRGGBB>... [--tol 12] [--step 1] [--rect x,y,w,h]")
}
let path = positional[0]
var targets: [(name: String, rgb: (Int, Int, Int))] = []
for spec in positional.dropFirst() {
  let parts = spec.split(separator: "=", maxSplits: 1).map(String.init)
  let hex = parts.last!
  guard let rgb = parseHex(hex) else { fail("not a colour: \(spec)") }
  let label = parts.count == 2 ? "\(parts[0]) \(hex.uppercased())" : hex.uppercased()
  targets.append((label, rgb))
}

guard let img = NSImage(contentsOfFile: path),
      let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else { fail("cannot read image: \(path)") }
let w = cg.width, h = cg.height
var data = [UInt8](repeating: 0, count: w * h * 4)
guard let ctx = CGContext(data: &data, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                          space: CGColorSpace(name: CGColorSpace.sRGB)!,
                          bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { fail("cannot create bitmap") }
ctx.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))

let (rx, ry, rw, rh) = rect ?? (0, 0, w, h)
let x0 = max(0, rx), y0 = max(0, ry), x1 = min(w, rx + rw), y1 = min(h, ry + rh)
guard x0 < x1, y0 < y1 else { fail("--rect lies outside the \(w)x\(h) image") }

var counts = [Int](repeating: 0, count: targets.count)
var sums = [(Int, Int, Int)](repeating: (0, 0, 0), count: targets.count)
var sampled = 0
var y = y0
while y < y1 {
  var x = x0
  while x < x1 {
    let o = (y * w + x) * 4
    let r = Int(data[o]), g = Int(data[o + 1]), b = Int(data[o + 2])
    sampled += 1
    for (k, t) in targets.enumerated()
    where abs(r - t.rgb.0) <= tol && abs(g - t.rgb.1) <= tol && abs(b - t.rgb.2) <= tol {
      counts[k] += 1
      sums[k].0 += r; sums[k].1 += g; sums[k].2 += b
    }
    x += step
  }
  y += step
}

let area = rect == nil ? "" : " rect \(x0),\(y0) \(x1 - x0)x\(y1 - y0)"
print("# \((path as NSString).lastPathComponent) \(w)x\(h) px\(area), \(sampled) px sampled, tol ±\(tol)")
for (k, t) in targets.enumerated() {
  let n = counts[k]
  let share = sampled > 0 ? 100.0 * Double(n) / Double(sampled) : 0
  let label = t.name.count < 24 ? t.name.padding(toLength: 24, withPad: " ", startingAt: 0) : t.name
  var line = label + String(format: " %9d px  %6.2f%%", n, share)
  if n > 0 {
    let ar = Int((Double(sums[k].0) / Double(n)).rounded())
    let ag = Int((Double(sums[k].1) / Double(n)).rounded())
    let ab = Int((Double(sums[k].2) / Double(n)).rounded())
    let dev = max(abs(ar - t.rgb.0), abs(ag - t.rgb.1), abs(ab - t.rgb.2))
    line += String(format: "  avg #%02X%02X%02X (Δmax %d)", ar, ag, ab, dev)
    if Double(dev) > Double(tol) / 2 { line += "  drift — matches are probably another colour" }
  }
  print(line)
}
