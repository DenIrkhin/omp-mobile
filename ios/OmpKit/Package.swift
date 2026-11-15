// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "OmpKit",
    platforms: [.iOS("26.0"), .macOS("26.0")],
    products: [.library(name: "OmpKit", targets: ["OmpKit"])],
    targets: [
        .target(name: "OmpKit"),
        .testTarget(name: "OmpKitTests", dependencies: ["OmpKit"]),
    ],
    swiftLanguageModes: [.v6]
)
