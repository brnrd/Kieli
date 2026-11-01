import Foundation

// Read only the synthetic resources prepared by smoke-apple.mjs. No imported code
// is compiled; Foundation renders the supported native count formatters.
let root = CommandLine.arguments[1]
for (locale, expected) in [("en", "2 items in your cart"), ("ru", "2 товара в корзине")] {
    guard let bundle = Bundle(path: root + "/" + locale + ".lproj") else {
        fatalError("Missing fixture bundle")
    }
    let format = bundle.localizedString(forKey: "cart.items", value: nil, table: "Localizable")
    let actual = String.localizedStringWithFormat(format, CLong(2))
    guard actual == expected else { fatalError("Unexpected native plural: \(actual)") }
    print("Foundation \(locale): \(actual)")
    if locale == "en" {
        let simple = bundle.localizedString(forKey: "simple.count", value: nil, table: "Localizable")
        guard String.localizedStringWithFormat(simple, Int32(2)) == "2 items" else {
            fatalError("32-bit count changed")
        }
        let special = bundle.localizedString(forKey: "counts.special", value: nil, table: "Localizable")
        guard String.localizedStringWithFormat(special, CLongLong(1)) == "1 item & <tag> (50%)" else {
            fatalError("64-bit count or literal percent changed")
        }
        guard String.localizedStringWithFormat(special, CLongLong(2)) == "2 items # aren't {variables}" else {
            fatalError("Literal braces/hash/apostrophe changed")
        }
    }
}
