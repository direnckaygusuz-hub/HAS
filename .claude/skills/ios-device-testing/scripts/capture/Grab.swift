// Grab.swift — save frames from a USB-connected, unlocked iPhone screen (the QuickTime
// capture path: CoreMediaIO screen-capture devices + AVCaptureSession).
//
// qa-toolkit 0.8.1 — copy into the project repo; compare with the plugin copy before trusting an old one.
//
// Prerequisites: macOS with Xcode command-line tools; iPhone connected by USB, trusted,
// unlocked (Auto-Lock → Never). Must run inside the .app bundle that build.sh makes —
// macOS denies camera access to a bare CLI, and the bundle carries NSCameraUsageDescription.
// The user approves the camera prompt once.
//
// Usage (via `open -W -n -a Grab.app --args …`, see grab.sh / burst.sh):
//   Grab <out.png> [deviceNameSubstring]                       one frame -> out.png
//   Grab <prefix> <deviceNameSubstring|""> <everySec> <forSec> [maxSec]
//                                                  burst -> <prefix>-000.png …
//   forSec 0 = run until <prefix>.stop exists or SIGTERM/SIGINT (safety cap maxSec, default 3600).
// Result line ("OK …" / "ERR …") is written to <out>.status, since `open` swallows stdout.
//
// Traps: discover with mediaType nil (the iPhone is a muxed A/V source; .video hides it);
// frames arrive only when the screen changes, so a burst of a still screen yields one file.
import AVFoundation
import AppKit
import CoreMediaIO

// Opt in to screen-capture devices (iPhone/iPad over USB) — off by default.
var prop = CMIOObjectPropertyAddress(
    mSelector: CMIOObjectPropertySelector(kCMIOHardwarePropertyAllowScreenCaptureDevices),
    mScope: CMIOObjectPropertyScope(kCMIOObjectPropertyScopeGlobal),
    mElement: CMIOObjectPropertyElement(kCMIOObjectPropertyElementMain))
var allow: UInt32 = 1
CMIOObjectSetPropertyData(CMIOObjectID(kCMIOObjectSystemObject), &prop, 0, nil,
                          UInt32(MemoryLayout<UInt32>.size), &allow)

let args = CommandLine.arguments
let out = args.count > 1 ? args[1] : NSTemporaryDirectory() + "iphone.png"
let want = args.count > 2 ? args[2] : ""
let every = args.count > 3 ? Double(args[3]) ?? 0 : 0   // burst: min seconds between saved frames
let total = args.count > 4 ? Double(args[4]) ?? 0 : 0   // burst: duration in seconds (0 = until stopped)
let maxSec = args.count > 5 ? Double(args[5]) ?? 3600 : 3600  // until-stopped: safety cap
let untilStop = every > 0 && total <= 0
let status = out + ".status"
let stopFile = out + ".stop"

func finish(_ msg: String, _ code: Int32) {
    try? msg.write(toFile: status, atomically: true, encoding: .utf8)
    exit(code)
}

final class Sink: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
    var frames = 0, saved = 0
    var last = Date.distantPast
    let t0 = Date()
    func captureOutput(_ o: AVCaptureOutput, didOutput sb: CMSampleBuffer, from c: AVCaptureConnection) {
        frames += 1
        // Skip the first few frames: they can be black or half-drawn while the stream settles.
        guard frames >= 5, let px = CMSampleBufferGetImageBuffer(sb) else { return }
        if every > 0 && Date().timeIntervalSince(last) < every { return }
        let ci = CIImage(cvPixelBuffer: px)
        let rep = NSBitmapImageRep(ciImage: ci)
        guard let png = rep.representation(using: .png, properties: [:]) else { finish("ERR encode", 3); return }
        if every <= 0 {
            try? png.write(to: URL(fileURLWithPath: out))
            finish("OK \(Int(ci.extent.width))x\(Int(ci.extent.height))", 0)
        }
        try? png.write(to: URL(fileURLWithPath: String(format: "%@-%03d.png", out, saved)))
        saved += 1
        last = Date()
        if !untilStop && Date().timeIntervalSince(t0) > total { finish("OK burst \(saved) frames", 0) }
    }
}

let sink = Sink()
let session = AVCaptureSession()

func findDevice() -> AVCaptureDevice? {
    AVCaptureDevice.DiscoverySession(deviceTypes: [.external], mediaType: nil, position: .unspecified).devices
        .filter { !$0.localizedName.contains("FaceTime") && (want.isEmpty || $0.localizedName.contains(want)) }
        .first
}

// Poll on the main run loop (not Thread.sleep) so CoreMediaIO can publish the iPhone source.
func start(_ tries: Int = 0) {
    guard let d = findDevice() else {
        if tries > 60 { finish("ERR no iPhone capture device (connected + unlocked + trusted?)", 2) }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { start(tries + 1) }
        return
    }
    guard let input = try? AVCaptureDeviceInput(device: d) else { finish("ERR cannot open \(d.localizedName)", 2); return }
    session.addInput(input)
    let output = AVCaptureVideoDataOutput()
    output.setSampleBufferDelegate(sink, queue: DispatchQueue(label: "capture"))
    session.addOutput(output)
    session.startRunning()
}

AVCaptureDevice.requestAccess(for: .video) { ok in
    if !ok { finish("ERR camera access denied (System Settings → Privacy → Camera)", 4) }
    DispatchQueue.main.async { start() }
}
// Single frame: give up after 30 s. Burst: stop after the duration plus slack, keeping what was saved.
// Until-stopped: the cap is maxSec.
DispatchQueue.main.asyncAfter(deadline: .now() + (untilStop ? maxSec : max(30, total + 20))) {
    finish(every > 0 ? "OK burst \(sink.saved) frames (timeout)" : "ERR timeout (no frame; screen unlocked?)",
           every > 0 ? 0 : 5)
}

// Until-stopped mode: a stop file (burst.sh creates it on Ctrl-C / SIGTERM) or a signal ends it.
var signalSources: [DispatchSourceSignal] = []
if untilStop {  // burst.sh removes a stale stop file before launching
    func pollStop() {
        if FileManager.default.fileExists(atPath: stopFile) { finish("OK burst \(sink.saved) frames (stopped)", 0) }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { pollStop() }
    }
    pollStop()
    for sig in [SIGTERM, SIGINT] {
        signal(sig, SIG_IGN)
        let src = DispatchSource.makeSignalSource(signal: sig, queue: .main)
        src.setEventHandler { finish("OK burst \(sink.saved) frames (stopped by signal)", 0) }
        src.resume()
        signalSources.append(src)
    }
}
RunLoop.main.run()
