// the webkit half of the thumbnail pixel check (scripts/thumb-check.ts
// --webkit builds and runs it; docs/verification.md, thumbnails).
//
//   thumb-webkit <page.html> <css width> <css height> <dpr> <out.png>
//
// loads a local page in a WKWebView in an offscreen window, at a device
// scale factor forced to <dpr> (WKWebView's _setOverrideDeviceScaleFactor:,
// so the screen's own scale does not limit it), with the window's colour
// space srgb and occlusion detection off (a locked or asleep screen would
// otherwise throttle the web process), waits until every image decoded,
// snapshots the whole view at device pixels and writes an 8-bit srgb png.
// prints the page's devicePixelRatio and the snapshot's pixel size.

import Cocoa
import WebKit

func callBool(_ target: AnyObject, _ name: String, _ value: Bool) {
  typealias F = @convention(c) (AnyObject, Selector, Bool) -> Void
  let sel = NSSelectorFromString(name)
  guard let m = class_getInstanceMethod(type(of: target), sel) else {
    print("missing \(name)")
    return
  }
  unsafeBitCast(method_getImplementation(m), to: F.self)(target, sel, value)
}

func callFloat(_ target: AnyObject, _ name: String, _ value: CGFloat) {
  typealias F = @convention(c) (AnyObject, Selector, CGFloat) -> Void
  let sel = NSSelectorFromString(name)
  guard let m = class_getInstanceMethod(type(of: target), sel) else {
    print("missing \(name)")
    exit(3)
  }
  unsafeBitCast(method_getImplementation(m), to: F.self)(target, sel, value)
}

final class Harness: NSObject, NSApplicationDelegate, WKNavigationDelegate {
  let args = CommandLine.arguments
  var window: NSWindow!
  var view: WKWebView!
  var activity: NSObjectProtocol?

  func applicationDidFinishLaunching(_ note: Notification) {
    activity = ProcessInfo.processInfo.beginActivity(
      options: [.userInitiated, .latencyCritical], reason: "pixel check")
    let page = URL(fileURLWithPath: args[1])
    let (width, height, dpr) = (Double(args[2])!, Double(args[3])!, Double(args[4])!)
    let config = WKWebViewConfiguration()
    for name in [
      "_setPageVisibilityBasedProcessSuppressionEnabled:",
      "_setHiddenPageDOMTimerThrottlingEnabled:",
    ] {
      callBool(config.preferences, name, false)
    }
    config.websiteDataStore = .nonPersistent()
    let frame = NSRect(x: 0, y: 0, width: width, height: height)
    view = WKWebView(frame: frame, configuration: config)
    view.navigationDelegate = self
    callBool(view, "_setWindowOcclusionDetectionEnabled:", false)
    callFloat(view, "_setOverrideDeviceScaleFactor:", CGFloat(dpr))
    window = NSWindow(
      contentRect: NSRect(x: -20000, y: -20000, width: width, height: height),
      styleMask: [.borderless], backing: .buffered, defer: false)
    window.colorSpace = .sRGB
    window.contentView = view
    window.orderBack(nil)
    view.loadFileURL(page, allowingReadAccessTo: page.deletingLastPathComponent())
    DispatchQueue.main.asyncAfter(deadline: .now() + 60) {
      print("timed out")
      exit(2)
    }
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    let wait = "await Promise.all([...document.images].map((i) => i.decode())); return devicePixelRatio;"
    webView.callAsyncJavaScript(wait, arguments: [:], in: nil, in: .page) { result in
      switch result {
      case .failure(let error):
        print("decode failed: \(error)")
        exit(4)
      case .success(let ratio):
        print("devicePixelRatio \(ratio)")
        // time for every decoded image to paint
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { self.snapshot() }
      }
    }
  }

  func snapshot() {
    let config = WKSnapshotConfiguration()
    config.rect = view.bounds
    config.afterScreenUpdates = true
    view.takeSnapshot(with: config) { image, error in
      guard let image, let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
        print("snapshot failed: \(String(describing: error))")
        exit(5)
      }
      let srgb = CGColorSpace(name: CGColorSpace.sRGB)!
      guard
        let context = CGContext(
          data: nil, width: cg.width, height: cg.height, bitsPerComponent: 8, bytesPerRow: 0,
          space: srgb, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)
      else { exit(6) }
      context.draw(cg, in: CGRect(x: 0, y: 0, width: cg.width, height: cg.height))
      guard let flat = context.makeImage(),
        let out = CGImageDestinationCreateWithURL(
          URL(fileURLWithPath: self.args[5]) as CFURL, "public.png" as CFString, 1, nil)
      else { exit(7) }
      CGImageDestinationAddImage(out, flat, nil)
      CGImageDestinationFinalize(out)
      print("snapshot \(cg.width)x\(cg.height) \(cg.colorSpace?.name as String? ?? "?")")
      exit(0)
    }
  }
}

let app = NSApplication.shared
let harness = Harness()
app.delegate = harness
app.setActivationPolicy(.accessory)
app.run()
