// swift-tools-version: 5.9
import PackageDescription
let package = Package(name:"Kieli",platforms:[.iOS(.v15),.macOS(.v12)],products:[.library(name:"Kieli",targets:["Kieli"])],targets:[.target(name:"Kieli"),.testTarget(name:"KieliTests",dependencies:["Kieli"],resources:[.copy("Fixtures")])])
