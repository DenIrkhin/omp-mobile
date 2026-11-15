import Foundation
import Testing
@testable import OmpKit

enum Fixture {
    static let folder = URL(filePath: #filePath)
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .appending(path: "api/v1/fixtures")

    static func data(_ name: String) throws -> Data {
        try Data(contentsOf: folder.appending(path: name))
    }

    static func names() throws -> [String] {
        try FileManager.default.contentsOfDirectory(atPath: folder.path(percentEncoded: false))
            .filter { $0.hasSuffix(".json") }
            .sorted()
    }
}

/// The notification the server sends (api/v1/README.md, "Push notifications"), field by field.
/// `PushRouteTests` reads the same files the way the app does.
struct PushPayloadFixture: Decodable {
    struct Aps: Decodable {
        struct Alert: Decodable {
            let title: String
            let subtitle: String?
            let body: String?
        }

        let alert: Alert
        let sound: String
        let threadId: String

        enum CodingKeys: String, CodingKey {
            case alert, sound
            case threadId = "thread-id"
        }
    }

    struct Omp: Decodable {
        let v: Int
        let kind: String
        let sessionId: String
        let instanceId: String?
        let generation: Int?
        let reportId: String?
        let job: String?
        let outcome: ReportOutcome?
        let at: Date?
    }

    let aps: Aps
    let omp: Omp
}

let modelByFixture: [String: @Sendable (Data) throws -> Void] = [
    "error-403.json": { _ = try OmpJSON.decoder.decode(ErrorBody.self, from: $0) },
    "error-409.json": { _ = try OmpJSON.decoder.decode(ErrorBody.self, from: $0) },
    "reopen-409.json": { _ = try OmpJSON.decoder.decode(ErrorBody.self, from: $0) },
    "hosts.json": { _ = try OmpJSON.decoder.decode(HostsResponse.self, from: $0) },
    "hosts-empty.json": { _ = try OmpJSON.decoder.decode(HostsResponse.self, from: $0) },
    "info.json": { _ = try OmpJSON.decoder.decode(ServerInfo.self, from: $0) },
    "launch-options.json": { _ = try OmpJSON.decoder.decode(LaunchOptions.self, from: $0) },
    "link-request.json": { _ = try OmpJSON.decoder.decode(LinkRequest.self, from: $0) },
    "link.json": { _ = try OmpJSON.decoder.decode(LinkResponse.self, from: $0) },
    "pin-request.json": { _ = try OmpJSON.decoder.decode(PinRequest.self, from: $0) },
    "pin.json": { _ = try OmpJSON.decoder.decode(PinResponse.self, from: $0) },
    "reopen-request.json": { _ = try OmpJSON.decoder.decode(ReopenRequest.self, from: $0) },
    "sessions-201.json": { _ = try OmpJSON.decoder.decode(LaunchResult.self, from: $0) },
    "sessions-request.json": { _ = try OmpJSON.decoder.decode(SessionsRequest.self, from: $0) },
    "devices-request.json": { _ = try OmpJSON.decoder.decode(DeviceRegistration.self, from: $0) },
    "devices.json": { _ = try OmpJSON.decoder.decode(DeviceRecord.self, from: $0) },
    "push-input.json": { _ = try OmpJSON.decoder.decode(PushPayloadFixture.self, from: $0) },
    "push-report.json": { _ = try OmpJSON.decoder.decode(PushPayloadFixture.self, from: $0) },
    "push-turn-done.json": { _ = try OmpJSON.decoder.decode(PushPayloadFixture.self, from: $0) },
]

@Suite struct ContractTests {
    @Test func everyFixtureDecodes() throws {
        let names = try Fixture.names()
        #expect(names.isEmpty == false)
        for name in names {
            guard let decode = modelByFixture[name] else {
                Issue.record("\(name) has no model in ContractTests: add one")
                continue
            }
            let data = try Fixture.data(name)
            #expect(throws: Never.self, "\(name)") { try decode(data) }
        }
    }

    @Test func everyModelHasItsFixture() throws {
        let names = try Fixture.names()
        for key in modelByFixture.keys {
            #expect(names.contains(key), "\(key) has no fixture file")
        }
    }

    @Test func infoFields() throws {
        let info = try OmpJSON.decoder.decode(ServerInfo.self, from: Fixture.data("info.json"))
        #expect(info.apiVersion == 1)
        #expect(info.features.longTasks == true)
        #expect(info.features.launch == false)
        #expect(info.features.pageCopy == true)
        #expect(info.features.push == false)
        #expect(info.push == nil)
        #expect(info.deviceName == "iphone")
        #expect(info.mainProfile == "work")
    }

    @Test func hostsFields() throws {
        let hosts = try OmpJSON.decoder.decode(HostsResponse.self, from: Fixture.data("hosts.json"))
        #expect(hosts.fetchedAt == Date(timeIntervalSince1970: 1_762_995_600))
        #expect(hosts.hosts[0].access == .view)
        #expect(hosts.hosts[1].access == .control)
        #expect(hosts.hosts[0].sessionName == nil)
        #expect(hosts.hosts[1].pinned == true)
        let report = hosts.hosts[1].reports[0]
        #expect(report.id == "0194f3a2-1c2d-7e3f-8a4b-5c6d7e8f9b01")
        #expect(report.outcome == .update)
        #expect(report.details == nil)
        #expect(report.at == Date(timeIntervalSince1970: 1_794_470_400))
        #expect(hosts.longTasks[1].profile == nil)
        #expect(hosts.longTasks[0].lastActiveAt == Date(timeIntervalSince1970: 1_762_995_000))
        #expect(hosts.pageCopy == PageCopyState(ok: true, reason: nil))

        let empty = try OmpJSON.decoder.decode(HostsResponse.self, from: Fixture.data("hosts-empty.json"))
        #expect(empty.pageCopy == nil)
        #expect(empty.hosts.isEmpty)
        #expect(empty.projects == ["orion", "vega", "dev"])
    }

    @Test func requestsEncodeLikeTheirFixtures() throws {
        func expectEncodes(_ value: some Encodable, like name: String) throws {
            let encoded = try JSONSerialization.jsonObject(with: OmpJSON.encoder.encode(value)) as? NSDictionary
            let fixture = try JSONSerialization.jsonObject(with: Fixture.data(name)) as? NSDictionary
            #expect(encoded != nil)
            #expect(encoded == fixture, "\(name)")
        }
        try expectEncodes(
            LinkRequest(instanceId: "inst-alpha", generation: 3, access: .control), like: "link-request.json")
        try expectEncodes(
            PinRequest(sessionId: "0194f3a2-1c2d-7e3f-8a4b-5c6d7e8f9a02", pinned: true), like: "pin-request.json")
        try expectEncodes(
            ReopenRequest(sessionId: "0194f3a2-1c2d-7e3f-8a4b-5c6d7e8f9a03"), like: "reopen-request.json")
        try expectEncodes(
            SessionsRequest(folder: "/Users/you/dev/751orion-web", model: "fast", maxCost: 5),
            like: "sessions-request.json")
        try expectEncodes(
            DeviceRegistration(
                token: String(repeating: "0123456789abcdef", count: 4), environment: "sandbox",
                bundleId: "io.github.you.ompmobile", appVersion: "0.1.0 (3)",
                events: PushEvents(input: true, reportFailed: true, reportUpdate: false, turnDone: false)),
            like: "devices-request.json")
    }

    @Test func unknownValuesFallBack() throws {
        let access = try OmpJSON.decoder.decode([Access].self, from: Data(#"["owner","control","view"]"#.utf8))
        #expect(access == [.view, .control, .view])
        let outcomes = try OmpJSON.decoder.decode(
            [ReportOutcome].self, from: Data(#"["skipped","failed","ok","update"]"#.utf8))
        #expect(outcomes == [.unknown, .failed, .ok, .update])
    }
}
