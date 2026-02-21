// swift-tools-version: 5.9
// SwarmX iOS Node

import PackageDescription

let package = Package(
    name: "SwarmX-iOS",
    platforms: [
        .iOS(.v17)
    ],
    products: [
        .library(name: "SwarmX-iOS", targets: ["SwarmXiOS"])
    ],
    targets: [
        .target(
            name: "SwarmXiOS",
            path: "SwarmX/Sources"
        )
    ]
)
