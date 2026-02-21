// swift-tools-version: 5.9
// Groklets iOS Node

import PackageDescription

let package = Package(
    name: "Groklets-iOS",
    platforms: [
        .iOS(.v17)
    ],
    products: [
        .library(name: "Groklets-iOS", targets: ["GrokletsiOS"])
    ],
    targets: [
        .target(
            name: "GrokletsiOS",
            path: "Groklets/Sources"
        )
    ]
)
