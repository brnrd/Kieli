import Foundation
@main struct Smoke {
    static func main() async throws {
        let fixtures=try JSONSerialization.jsonObject(with:Data(contentsOf:URL(fileURLWithPath:CommandLine.arguments[1]))) as! [[String:Any]]
        var count=0
        for fixture in fixtures {
            let locale=fixture["locale"] as! String
            let directory=FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            try FileManager.default.createDirectory(at:directory,withIntermediateDirectories:true)
            defer {try? FileManager.default.removeItem(at:directory)}
            let saved:[String:Any]=["endpoint":"https://copy.example.com/ota/mobile/\(locale)?channel=production","etag":"fixture","bundle":fixture["bundle"]!]
            try JSONSerialization.data(withJSONObject:saved).write(to:directory.appendingPathComponent("kieli-mobile-\(locale)-production.json"))
            let client=try KieliClient(baseURL:URL(string:"https://copy.example.com")!,project:"mobile",locale:locale,deliveryKey:String(repeating:"a",count:32),cacheDirectory:directory)
            for check in fixture["checks"] as! [[Any]] {
                let actual=await client.text(check[0] as! String,fallback:"FALLBACK",arguments:check[1] as! [String:String])
                guard actual==check[2] as? String else {throw NSError(domain:"SDKFixture: \(locale) \(check) got \(actual)",code:1)}
                count += 1
            }
        }
        print("Swift SDK: \(count) shared formatting and fallback checks passed.")
    }
}
