import Foundation
import Testing
@testable import OmpKit

/// The demo's in-app server, through the client and decoder the app uses. One shared server answers
/// the demo's URLSession, so these tests run one at a time and each starts from the sample as it starts.
@Suite(.serialized)
struct DemoServerTests {
    private let client = APIClient(baseURL: DemoServer.baseURL, session: DemoServer.session())

    init() {
        DemoServer.shared.reset()
    }

    @Test func infoHidesWhatTheDemoCannotDo() async throws {
        let info = try await client.info()
        #expect(info.apiVersion == 1)
        #expect(info.features.longTasks && info.features.reports)
        #expect(!info.features.launch && !info.features.control && !info.features.devCycles)
        #expect(!info.features.push && !info.features.pageCopy)
    }

    @Test func sampleListFillsBothTabs() async throws {
        let response = try await client.hosts()
        let entries = SessionList.compose(response)
        #expect(entries.chats.map(\.id) == ["demo-1", "demo-2", "demo-3", "demo-4"])
        #expect(entries.longTasks.count == 5)
        #expect(entries.longTasks.filter { $0.host == nil }.count == 3)
        let statuses = response.hosts.map(CardStatus.init)
        #expect(statuses.filter { $0 == .needsInput }.count == 1)
        #expect(statuses.contains(.running))
        #expect(response.hosts.contains { $0.participants > 1 })
        let reports = response.hosts.flatMap(\.reports) + response.longTasks.flatMap(\.reports)
        #expect(Set(reports.map(\.outcome)) == [.ok, .update, .failed])
        #expect(response.projects == ["website", "mobile-app", "infra"])
        #expect((entries.chats + entries.longTasks).allSatisfy { response.projects.contains($0.project ?? "") })
    }

    @Test func pinMovesACardBetweenTabs() async throws {
        let chat = try #require(SessionList.compose(try await client.hosts()).chats.first { $0.id == "demo-1" })
        try await client.pin(sessionId: chat.sessionId, pinned: true)
        var entries = SessionList.compose(try await client.hosts())
        #expect(entries.longTasks.contains { $0.id == "demo-1" })
        #expect(entries.chats.count == 3)

        try await client.pin(sessionId: chat.sessionId, pinned: false)
        entries = SessionList.compose(try await client.hosts())
        #expect(entries.chats.contains { $0.id == "demo-1" })

        // A live long task with its own record goes back to Chats; a closed one leaves the list.
        let live = try #require(entries.longTasks.first { $0.id == "demo-5" })
        let closed = try #require(entries.longTasks.first { $0.host == nil })
        try await client.pin(sessionId: live.sessionId, pinned: false)
        try await client.pin(sessionId: closed.sessionId, pinned: false)
        entries = SessionList.compose(try await client.hosts())
        #expect(entries.chats.contains { $0.id == "demo-5" })
        #expect(!entries.longTasks.contains { $0.sessionId == closed.sessionId })
        #expect(entries.longTasks.count == 3)
    }

    @Test func linkOpensTheBundledPage() async throws {
        let url = try await client.link(instanceId: "demo-2", generation: 1, access: .control)
        #expect(url.scheme == DemoServer.pageScheme)
        #expect(url.host() == "chat")
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        #expect(items.contains(URLQueryItem(name: "access", value: "control")))
        #expect(items.contains(URLQueryItem(name: "folder", value: "mobile-app")))
        await #expect(throws: APIError.http(404, "That chat has ended.", code: nil)) {
            _ = try await client.link(instanceId: "demo-9", generation: 1, access: .view)
        }
    }

    @Test func otherRoutesSayTheDemoDoesNotOfferThem() async throws {
        let refusal = APIError.http(501, DemoServer.notOffered, code: "demo")
        await #expect(throws: refusal) { _ = try await client.launchOptions() }
        await #expect(throws: refusal) { try await client.reopen(sessionId: "demo-1") }
    }
}
