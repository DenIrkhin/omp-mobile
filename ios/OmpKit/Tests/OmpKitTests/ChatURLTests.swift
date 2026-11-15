import Foundation
import Testing
@testable import OmpKit

@Suite struct ChatURLTests {
    @Test func addsTheTheme() {
        let url = ChatURL.themed(URL(string: "https://alpha.example/s/room#k=Zm9v")!, theme: .dark)
        #expect(url.absoluteString == "https://alpha.example/s/room?theme=dark#k=Zm9v")
    }

    @Test func replacesTheTheme() {
        let url = ChatURL.themed(
            URL(string: "https://alpha.example/s/room?theme=light&x=1&theme=dark#k=Zm9v")!, theme: .system)
        #expect(url.absoluteString == "https://alpha.example/s/room?theme=system&x=1#k=Zm9v")
    }

    @Test func keepsOtherItemsAndTheFragment() {
        let url = ChatURL.themed(
            URL(string: "https://alpha.example/s/room?a=1%2B2&b=c%20d&flag#k=Zm9v%2Bbar/baz")!, theme: .light)
        #expect(url.absoluteString == "https://alpha.example/s/room?a=1%2B2&b=c%20d&flag&theme=light#k=Zm9v%2Bbar/baz")
    }
}
