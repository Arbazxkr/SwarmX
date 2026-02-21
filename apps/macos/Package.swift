// swift-tools-version: 5.9
// Groklets macOS Menu Bar App

import PackageDescription

let package = Package(
    name: "Groklets",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .executable(name: "Groklets", targets: ["Groklets"])
    ],
    targets: [
        .executableTarget(
            name: "Groklets",
            path: "Groklets/Sources"
        )
    ]
)
