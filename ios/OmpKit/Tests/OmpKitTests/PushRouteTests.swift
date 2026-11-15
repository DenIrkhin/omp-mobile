import Foundation
import Testing
@testable import OmpKit

@Suite struct PushRouteTests {
    let gone = "0194f3a2-1c2d-7e3f-8a4b-5c6d7e8f9a09"
    let at = Date(timeIntervalSince1970: 1_794_452_640)

    /// A notification's `userInfo` as iOS hands it over: the fixture's JSON object.
    func userInfo(_ name: String) throws -> [AnyHashable: Any] {
        try #require(JSONSerialization.jsonObject(with: Fixture.data(name)) as? [AnyHashable: Any])
    }

    func userInfo(omp: [String: Any]) -> [AnyHashable: Any] {
        ["aps": ["alert": ["title": "alpha"]], "omp": omp]
    }

    /// `hosts.json` as the list composes it: bravo is a live chat that allows only watching, alpha a live
    /// long task that allows control, and nightly build a closed long task.
    func entries() throws -> (chats: [SessionEntry], longTasks: [SessionEntry]) {
        let entries = SessionList.compose(try OmpJSON.decoder.decode(HostsResponse.self, from: Fixture.data("hosts.json")))
        #expect(entries.chats.map(\.sessionId) == ["0194f3a2-1c2d-7e3f-8a4b-5c6d7e8f9a02"])
        #expect(entries.longTasks.map(\.sessionId)
            == ["0194f3a2-1c2d-7e3f-8a4b-5c6d7e8f9a01", "0194f3a2-1c2d-7e3f-8a4b-5c6d7e8f9a03"])
        #expect(entries.longTasks[1].host == nil)
        return entries
    }

    @Test func fixturesBecomeRoutes() throws {
        #expect(PushRoute(userInfo: try userInfo("push-input.json"))
            == .input(sessionId: "0194f3a2-1c2d-7e3f-8a4b-5c6d7e8f9a01", instanceId: "inst-alpha", generation: 3))
        #expect(PushRoute(userInfo: try userInfo("push-report.json"))
            == .report(
                sessionId: "0194f3a2-1c2d-7e3f-8a4b-5c6d7e8f9a03", reportId: "0194f3a2-1c2d-7e3f-8a4b-5c6d7e8f9b02",
                job: "backup", outcome: .failed, at: at))
        #expect(PushRoute(userInfo: try userInfo("push-turn-done.json"))
            == .turnDone(sessionId: "0194f3a2-1c2d-7e3f-8a4b-5c6d7e8f9a01"))
    }

    /// Send test's notification (`testMessage` in `server/push-apns.ts`).
    @Test func testNotification() {
        #expect(PushRoute(userInfo: userInfo(omp: ["v": 1, "kind": "test"])) == .test)
    }

    @Test func refusals() {
        let input: [String: Any] = [
            "v": 1, "kind": "input", "sessionId": "alpha", "instanceId": "inst-alpha", "generation": 3,
        ]
        #expect(PushRoute(userInfo: userInfo(omp: input)) == .input(sessionId: "alpha", instanceId: "inst-alpha", generation: 3))
        var later = input
        later["v"] = 2
        var unknownKind = input
        unknownKind["kind"] = "digest"
        var noGeneration = input
        noGeneration["generation"] = nil
        var textGeneration = input
        textGeneration["generation"] = "3"
        let reportWithoutTime: [String: Any] = [
            "v": 1, "kind": "report", "sessionId": "alpha", "reportId": "bravo", "job": "backup", "outcome": "failed",
        ]
        for omp in [later, unknownKind, noGeneration, textGeneration, reportWithoutTime] {
            #expect(PushRoute(userInfo: userInfo(omp: omp)) == nil, "\(omp)")
        }
        #expect(PushRoute(userInfo: ["aps": ["alert": ["title": "alpha"]]]) == nil)
    }

    @Test func inputDestinations() throws {
        let entries = try entries()
        let bravo = entries.chats[0]
        let alpha = entries.longTasks[0]
        let nightly = entries.longTasks[1]
        // The notification's instance and generation are old: the chat is found by its session.
        #expect(PushRoute.input(sessionId: alpha.sessionId, instanceId: "inst-old", generation: 1).destination(in: entries)
            == .chat(alpha, access: .control))
        #expect(PushRoute.input(sessionId: bravo.sessionId, instanceId: "inst-bravo", generation: 1).destination(in: entries)
            == .chat(bravo, access: .view))
        #expect(PushRoute.input(sessionId: nightly.sessionId, instanceId: "inst-old", generation: 2).destination(in: entries)
            == .card(nightly, tab: .longTasks, reportId: nil))
        #expect(PushRoute.input(sessionId: gone, instanceId: "inst-old", generation: 1).destination(in: entries) == .ended)
    }

    @Test func reportAndTurnDoneDestinations() throws {
        let entries = try entries()
        let bravo = entries.chats[0]
        let alpha = entries.longTasks[0]
        let nightly = entries.longTasks[1]
        let reportId = "0194f3a2-1c2d-7e3f-8a4b-5c6d7e8f9b01"
        func report(_ sessionId: String) -> PushRoute {
            .report(sessionId: sessionId, reportId: reportId, job: "backup", outcome: .failed, at: at)
        }
        #expect(report(alpha.sessionId).destination(in: entries) == .card(alpha, tab: .longTasks, reportId: reportId))
        #expect(report(nightly.sessionId).destination(in: entries) == .card(nightly, tab: .longTasks, reportId: reportId))
        #expect(report(bravo.sessionId).destination(in: entries) == .card(bravo, tab: .chats, reportId: reportId))
        #expect(report(gone).destination(in: entries) == .report(job: "backup", outcome: .failed, at: at))
        #expect(PushRoute.turnDone(sessionId: alpha.sessionId).destination(in: entries)
            == .card(alpha, tab: .longTasks, reportId: nil))
        #expect(PushRoute.turnDone(sessionId: gone).destination(in: entries) == .ended)
        #expect(PushRoute.test.destination(in: entries) == .refreshOnly)
    }
}
