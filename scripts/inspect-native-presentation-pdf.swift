import AppKit
import PDFKit

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}

let started = ProcessInfo.processInfo.systemUptime
let source = URL(fileURLWithPath: CommandLine.arguments[1])
let output = URL(fileURLWithPath: CommandLine.arguments[2], isDirectory: true)
guard let document = PDFDocument(url: source), document.pageCount == 3 else {
    fail("Expected exactly three presentation pages")
}

let text = document.string ?? ""
try text.write(
    to: output.appendingPathComponent("native-presentation-extracted.txt"),
    atomically: true,
    encoding: .utf8
)
guard !text.contains("NATIVE_PRESENTATION_PRIVATE_NOTE"),
      !text.contains("Export PDF"),
      !text.contains("Exporter en PDF") else {
    fail("The presentation PDF contains private notes or editor controls")
}

let renderWidth = 960
let renderHeight = 540
let stride = renderWidth * 4
var pages: [[String: Any]] = []
for index in 0..<document.pageCount {
    let pageStarted = ProcessInfo.processInfo.systemUptime
    let page = document.page(at: index)!
    let bounds = page.bounds(for: .mediaBox)
    guard abs(bounds.width - 960.0) < 1, abs(bounds.height - 540.0) < 1 else {
        fail("Expected 960 by 540 point presentation pages")
    }
    var pixels = [UInt8](repeating: 255, count: stride * renderHeight)
    var nonWhitePixels = 0
    let png: Data = pixels.withUnsafeMutableBytes { bytes in
        guard let context = CGContext(
            data: bytes.baseAddress,
            width: renderWidth,
            height: renderHeight,
            bitsPerComponent: 8,
            bytesPerRow: stride,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue
        ) else {
            fail("Cannot allocate the presentation page bitmap")
        }
        context.setFillColor(CGColor(gray: 1, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: renderWidth, height: renderHeight))
        context.scaleBy(
            x: CGFloat(renderWidth) / bounds.width,
            y: CGFloat(renderHeight) / bounds.height
        )
        page.draw(with: .mediaBox, to: context)
        for offset in Swift.stride(from: 0, to: bytes.count, by: 4) {
            if bytes[offset] < 245 || bytes[offset + 1] < 245 || bytes[offset + 2] < 245 {
                nonWhitePixels += 1
            }
        }
        guard let image = context.makeImage(),
              let data = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) else {
            fail("Cannot encode the presentation page bitmap")
        }
        return data
    }
    guard nonWhitePixels > 100 else {
        fail("Each presentation page must contain rendered pixels")
    }
    try png.write(to: output.appendingPathComponent("native-presentation-page-\(index + 1).png"))
    pages.append([
        "page": index + 1,
        "width": bounds.width,
        "height": bounds.height,
        "ratio": bounds.width / bounds.height,
        "nonWhitePixels": nonWhitePixels,
        "inspectionSeconds": ProcessInfo.processInfo.systemUptime - pageStarted
    ])
}

let elapsed = ProcessInfo.processInfo.systemUptime - started
let evidence: [String: Any] = [
    "pageCount": document.pageCount,
    "pages": pages,
    "privateNotesExcluded": true,
    "inspectionSeconds": elapsed,
    "bitmap": ["width": renderWidth, "height": renderHeight, "format": "RGBA8"]
]
let json = try JSONSerialization.data(withJSONObject: evidence, options: [.prettyPrinted, .sortedKeys])
try json.write(to: output.appendingPathComponent("native-presentation-pdf-inspection.json"))
print("Verified three 16:9 native presentation pages")
