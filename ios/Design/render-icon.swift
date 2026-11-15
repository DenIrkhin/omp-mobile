// Draws the app icon, a white chat bubble with three dots, in the three variants of
// ios/OmpMobile/Assets.xcassets/AppIcon.appiconset: blue (any), near-black (dark) and grayscale
// (tinted). Each is a 1024×1024 sRGB PNG with no alpha channel. Run from the repo root.
import CoreGraphics
import Foundation
import ImageIO

struct Variant {
    let file: String
    let background: CGColor
    let bubble: CGColor
    let dots: CGColor
}

func srgb(_ red: CGFloat, _ green: CGFloat, _ blue: CGFloat) -> CGColor {
    CGColor(srgbRed: red, green: green, blue: blue, alpha: 1)
}

let blue = srgb(0.0, 0.478, 1.0)
let variants = [
    Variant(file: "AppIcon.png", background: blue, bubble: srgb(1, 1, 1), dots: blue),
    Variant(file: "AppIcon-Dark.png", background: srgb(0.07, 0.07, 0.09), bubble: srgb(1, 1, 1), dots: blue),
    Variant(file: "AppIcon-Tinted.png", background: srgb(0, 0, 0), bubble: srgb(0.85, 0.85, 0.85), dots: srgb(0, 0, 0)),
]
let folder = URL(fileURLWithPath: "ios/OmpMobile/Assets.xcassets/AppIcon.appiconset")
let size = 1024

for variant in variants {
    guard let context = CGContext(
        data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpace(name: CGColorSpace.sRGB)!,
        bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)
    else { fatalError("no bitmap context") }
    // Core Graphics puts y = 0 at the bottom. The bubble and its tail span y 230 to 790, centered.
    context.setFillColor(variant.background)
    context.fill(CGRect(x: 0, y: 0, width: size, height: size))
    context.setFillColor(variant.bubble)
    context.addPath(CGPath(
        roundedRect: CGRect(x: 192, y: 330, width: 640, height: 460),
        cornerWidth: 140, cornerHeight: 140, transform: nil))
    context.fillPath()
    context.move(to: CGPoint(x: 340, y: 370))
    context.addLine(to: CGPoint(x: 500, y: 370))
    context.addLine(to: CGPoint(x: 290, y: 230))
    context.closePath()
    context.fillPath()
    context.setFillColor(variant.dots)
    for x in [352, 512, 672] {
        context.fillEllipse(in: CGRect(x: x - 48, y: 512, width: 96, height: 96))
    }
    guard let image = context.makeImage(),
          let destination = CGImageDestinationCreateWithURL(
              folder.appendingPathComponent(variant.file) as CFURL, "public.png" as CFString, 1, nil)
    else { fatalError("cannot write \(variant.file)") }
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else { fatalError("cannot write \(variant.file)") }
    print("wrote \(variant.file)")
}
