// swift-tools-version: 5.9
import PackageDescription
let package = Package(name:"Keylo",platforms:[.iOS(.v15),.macOS(.v12)],products:[.library(name:"Keylo",targets:["Keylo"])],targets:[.target(name:"Keylo"),.testTarget(name:"KeyloTests",dependencies:["Keylo"],resources:[.copy("Fixtures")])])
