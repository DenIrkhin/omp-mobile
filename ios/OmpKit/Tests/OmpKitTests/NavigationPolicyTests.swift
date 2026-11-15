import Foundation
import Testing
@testable import OmpKit

@Suite struct NavigationPolicyTests {
    let chat = URL(string: "https://alpha.example/s/room?theme=dark#k=Zm9v")!

    func decide(_ url: String, tap: Bool) -> NavigationPolicy.Decision {
        NavigationPolicy.decide(url: URL(string: url)!, chatURL: chat, userInitiated: tap)
    }

    @Test func sameOriginLoadsInPlace() {
        #expect(decide("https://alpha.example/other?x=1", tap: false) == .allow)
        #expect(decide("https://ALPHA.example:443/s/room", tap: true) == .allow)
    }

    @Test func aTappedLinkElsewhereOpensTheBrowser() {
        #expect(decide("https://bravo.example/docs", tap: true) == .openExternally)
        #expect(decide("tel:+15550100", tap: true) == .openExternally)
    }

    @Test func anUntappedNavigationElsewhereIsCancelled() {
        #expect(decide("https://bravo.example/", tap: false) == .cancel)
        #expect(decide("about:blank", tap: false) == .cancel)
    }

    @Test func anotherPortOrSchemeIsAnotherOrigin() {
        #expect(decide("https://alpha.example:8443/s/room", tap: true) == .openExternally)
        #expect(decide("https://alpha.example:8443/s/room", tap: false) == .cancel)
        #expect(decide("http://alpha.example/s/room", tap: false) == .cancel)
    }
}
