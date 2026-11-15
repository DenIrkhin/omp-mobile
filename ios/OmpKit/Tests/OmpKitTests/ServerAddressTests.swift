import Foundation
import Testing
@testable import OmpKit

@Suite struct ServerAddressTests {
    func origin(_ input: String) -> String? {
        try? ServerAddress.parse(input).get().absoluteString
    }

    func error(_ input: String) -> ServerAddressError? {
        switch ServerAddress.parse(input) {
        case .success: nil
        case .failure(let error): error
        }
    }

    @Test func acceptsTheFormsPeopleType() {
        #expect(origin("my-mac.example.ts.net") == "https://my-mac.example.ts.net")
        #expect(origin("https://my-mac.example.ts.net") == "https://my-mac.example.ts.net")
        #expect(origin("https://my-mac.example.ts.net/") == "https://my-mac.example.ts.net")
        #expect(origin("  My-Mac.Example.TS.net\n") == "https://my-mac.example.ts.net")
        #expect(origin("my-mac.example.ts.net:8443") == "https://my-mac.example.ts.net:8443")
        #expect(origin("HTTPS://my-mac.example.ts.net:8443/") == "https://my-mac.example.ts.net:8443")
        #expect(origin("my-mac.example.ts.net:443") == "https://my-mac.example.ts.net")
        #expect(origin("100.64.0.1") == "https://100.64.0.1")
    }

    @Test func refusesOtherSchemes() {
        #expect(error("http://my-mac.example.ts.net") == .notHTTPS)
        #expect(error("ftp://my-mac.example.ts.net") == .notHTTPS)
    }

    @Test func refusesAnythingBeyondTheAddress() {
        #expect(error("https://my-mac.example.ts.net/api/v1") == .notOrigin)
        #expect(error("my-mac.example.ts.net/dashboard") == .notOrigin)
        #expect(error("https://my-mac.example.ts.net?tab=chats") == .notOrigin)
        #expect(error("https://my-mac.example.ts.net#room") == .notOrigin)
        #expect(error("https://you@my-mac.example.ts.net") == .notOrigin)
    }

    @Test func refusesWhatIsNotAnAddress() {
        #expect(error("") == .empty)
        #expect(error(" \n") == .empty)
        #expect(error("my mac") == .invalid)
        #expect(error("https://") == .invalid)
        #expect(error("my_mac.example.ts.net") == .invalid)
        #expect(error("my-mac.example.ts.net:0") == .invalid)
        #expect(error("my-mac.example.ts.net:http") == .invalid)
    }
}
