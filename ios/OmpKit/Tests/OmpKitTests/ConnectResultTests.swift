import Foundation
import Testing
@testable import OmpKit

@Suite struct ConnectResultTests {
    /// `api/v1/fixtures/info.json` with some top-level keys replaced.
    func info(_ changes: [String: Any] = [:]) throws -> ServerInfo {
        let fixture = try JSONSerialization.jsonObject(with: Fixture.data("info.json"))
        var object = try #require(fixture as? [String: Any])
        object.merge(changes) { _, new in new }
        return try OmpJSON.decoder.decode(ServerInfo.self, from: JSONSerialization.data(withJSONObject: object))
    }

    @Test func connectedLineNamesLoginAndVersions() throws {
        let result = try ConnectResult.evaluate(info())
        #expect(result == .connected(summary: "Connected as you@example.com · server 0.1.0 · omp 18.4.10"))
    }

    @Test func lineLeavesOutAnUnknownOmpVersion() throws {
        let result = try ConnectResult.evaluate(info(["ompVersion": NSNull()]))
        #expect(result.message == "Connected as you@example.com · server 0.1.0")
    }

    @Test func otherAPIVersionAsksForAnUpdate() throws {
        let result = try ConnectResult.evaluate(info(["apiVersion": 2]))
        #expect(result == .failed(.incompatible(2)))
        #expect(result.message == "This server uses API version 2. Update the app or the server.")
    }
}
