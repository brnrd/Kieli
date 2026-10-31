import XCTest
@testable import Keylo

final class KeyloTests:XCTestCase {
    func testSharedPluralAndFallbackFixtures() async throws {
        let data=try Data(contentsOf:Bundle.module.url(forResource:"messages",withExtension:"json",subdirectory:"Fixtures")!)
        let fixtures=try JSONSerialization.jsonObject(with:data) as! [[String:Any]]
        for fixture in fixtures {
            let locale=fixture["locale"] as! String
            let directory=FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            try FileManager.default.createDirectory(at:directory,withIntermediateDirectories:true)
            defer {try? FileManager.default.removeItem(at:directory)}
            let saved:[String:Any]=["endpoint":"https://copy.example.com/ota/mobile/\(locale)?channel=production","etag":"fixture","bundle":fixture["bundle"]!]
            try JSONSerialization.data(withJSONObject:saved).write(to:directory.appendingPathComponent("keylo-mobile-\(locale)-production.json"))
            let client=try KeyloClient(baseURL:URL(string:"https://copy.example.com")!,project:"mobile",locale:locale,deliveryKey:String(repeating:"a",count:32),cacheDirectory:directory)
            for check in fixture["checks"] as! [[Any]] {
                let actual=await client.text(check[0] as! String,fallback:"FALLBACK",arguments:check[1] as! [String:String])
                XCTAssertEqual(actual,check[2] as? String,"\(locale) \(check)")
            }
        }
    }
    func testCacheIsBoundToOriginAndInvalidEndpointsAreRejected() async throws {
        let directory=FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer {try? FileManager.default.removeItem(at:directory)}
        for url in ["http://copy.example.com","https://user:password@copy.example.com","https://copy.example.com/path","https://copy.example.com?token=secret"] {
            XCTAssertThrowsError(try KeyloClient(baseURL:URL(string:url)!,project:"mobile",locale:"en",deliveryKey:String(repeating:"a",count:32),cacheDirectory:directory))
        }
        try FileManager.default.createDirectory(at:directory,withIntermediateDirectories:true)
        try Data("broken json".utf8).write(to:directory.appendingPathComponent("keylo-mobile-en-production.json"))
        let client=try KeyloClient(baseURL:URL(string:"https://copy.example.com")!,project:"mobile",locale:"en",deliveryKey:String(repeating:"a",count:32),cacheDirectory:directory)
        let actual=await client.text("anything",fallback:"Bundled")
        XCTAssertEqual(actual,"Bundled")
    }
}
