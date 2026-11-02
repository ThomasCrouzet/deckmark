import AppKit
import PDFKit

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}

let started = ProcessInfo.processInfo.systemUptime
let source = URL(fileURLWithPath: CommandLine.arguments[1])
let output = URL(fileURLWithPath: CommandLine.arguments[2], isDirectory: true)
let fixture = try String(contentsOfFile: CommandLine.arguments[3], encoding: .utf8)
guard let metadataStart = fixture.range(of: "<!-- mdsh-presentation\n"),
      let metadataEnd = fixture.range(of: "-->", range: metadataStart.upperBound..<fixture.endIndex),
      let metadata = fixture[metadataStart.upperBound..<metadataEnd.lowerBound].data(using: .utf8),
      let deck = try JSONSerialization.jsonObject(with: metadata) as? [String: Any],
      deck["width"] as? Int == 1280, deck["height"] as? Int == 720,
      let slides = deck["slides"] as? [[String: Any]], slides.count == 3 else {
    fail("Expected the retained 1280 by 720 presentation fixture")
}

func rgb(_ value: Any?) -> [Int] {
    guard let hex = value as? String, hex.count == 7, hex.first == "#",
          let number = Int(hex.dropFirst(), radix: 16) else {
        fail("Expected an opaque fixture color")
    }
    return [(number >> 16) & 255, (number >> 8) & 255, number & 255]
}

// Coordinates are in the rendered bitmap, from the top left.
func colorPatch(_ pixels: [UInt8], _ name: String, _ x: Int, _ y: Int, _ expected: [Int]) -> [String: Any] {
    var matched = 0
    var sum = [0, 0, 0]
    for row in y..<(y + 20) {
        for column in x..<(x + 20) {
            let offset = (row * 960 + column) * 4
            let actual = (0..<3).map { Int(pixels[offset + $0]) }
            for channel in 0..<3 { sum[channel] += actual[channel] }
            if zip(actual, expected).allSatisfy({ abs($0.0 - $0.1) <= 8 }) { matched += 1 }
        }
    }
    return ["name": name, "x": x, "y": y, "width": 20, "height": 20,
            "expectedRGB": expected, "meanRGB": sum.map { Double($0) / 400 },
            "matchedPixels": matched, "totalPixels": 400, "passed": matched >= 396]
}

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
var colorsPassed = true
for index in 0..<document.pageCount {
    let pageStarted = ProcessInfo.processInfo.systemUptime
    let page = document.page(at: index)!
    let bounds = page.bounds(for: .mediaBox)
    guard abs(bounds.width - 960.0) < 1, abs(bounds.height - 540.0) < 1 else {
        fail("Expected 960 by 540 point presentation pages")
    }
    var pixels = [UInt8](repeating: 255, count: stride * renderHeight)
    var nonWhitePixels = 0
    var strokePixels = 0
    let png: Data = pixels.withUnsafeMutableBytes { bytes in
        guard let context = CGContext(
            data: bytes.baseAddress,
            width: renderWidth,
            height: renderHeight,
            bitsPerComponent: 8,
            bytesPerRow: stride,
            space: CGColorSpace(name: CGColorSpace.sRGB)!,
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
            if abs(Int(bytes[offset]) - 31) <= 8 &&
               abs(Int(bytes[offset + 1]) - 41) <= 8 &&
               abs(Int(bytes[offset + 2]) - 55) <= 8 {
                strokePixels += 1
            }
        }
        guard let image = context.makeImage(),
              let data = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) else {
            fail("Cannot encode the presentation page bitmap")
        }
        return data
    }
    try png.write(to: output.appendingPathComponent("native-presentation-page-\(index + 1).png"))
    let background = rgb(slides[index]["background"])
    var patches = [
        colorPatch(pixels, "background-top-left", 16, 16, background),
        colorPatch(pixels, "background-top-right", 924, 16, background),
        colorPatch(pixels, "background-bottom-left", 16, 504, background),
        colorPatch(pixels, "background-bottom-right", 924, 504, background)
    ]
    if index < 2 {
        guard let elements = slides[index]["elements"] as? [[String: Any]],
              elements.count == 1, let shape = elements.first,
              shape["type"] as? String == (index == 0 ? "rectangle" : "ellipse"),
              shape["x"] as? Int == 100, shape["y"] as? Int == 100,
              shape["width"] as? Int == 480, shape["height"] as? Int == 240,
              shape["rotation"] as? Int == 0 else {
            fail("Expected the native fixture shape geometry")
        }
        patches.append(colorPatch(pixels, index == 0 ? "rectangle-fill" : "ellipse-fill", 245, 155, rgb(shape["fill"])))
    }
    let pagePassed = strokePixels > 100 && patches.allSatisfy { $0["passed"] as? Bool == true }
    colorsPassed = colorsPassed && pagePassed
    pages.append([
        "page": index + 1,
        "width": bounds.width,
        "height": bounds.height,
        "ratio": bounds.width / bounds.height,
        "nonWhitePixels": nonWhitePixels,
        "strokePixels": strokePixels,
        "colorPatches": patches,
        "passed": pagePassed,
        "inspectionSeconds": ProcessInfo.processInfo.systemUptime - pageStarted
    ])
}

let elapsed = ProcessInfo.processInfo.systemUptime - started
let evidence: [String: Any] = [
    "pageCount": document.pageCount,
    "pages": pages,
    "privateNotesExcluded": true,
    "colorsPassed": colorsPassed,
    "colorTolerance": 8,
    "minimumPatchMatch": 0.99,
    "inspectionSeconds": elapsed,
    "bitmap": ["width": renderWidth, "height": renderHeight, "format": "RGBA8", "colorSpace": "sRGB", "origin": "top-left"]
]
let json = try JSONSerialization.data(withJSONObject: evidence, options: [.prettyPrinted, .sortedKeys])
try json.write(to: output.appendingPathComponent("native-presentation-pdf-inspection.json"))
guard colorsPassed else { fail("Presentation backgrounds, shape fills, or strokes do not match the fixture") }
print("Verified three 16:9 native presentation pages with fixture colors")
