// swift-tools-version: 5.9
// SwarmX macOS Menu Bar App

import PackageDescription

let package = Package(
    name: "SwarmX",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .executable(name: "SwarmX", targets: ["SwarmX"])
    ],
    targets: [
        .executableTarget(
            name: "SwarmX",
            path: "SwarmX/Sources"
        )
    ]
)
