import Foundation
import Testing
@testable import OmpKit

private let start = Date(timeIntervalSince1970: 0)

private func host(
    _ folder: String, project: String?, pinned: Bool = false, sessionId: String? = nil, sessionName: String? = nil
) -> HostCard {
    HostCard(
        instanceId: "inst-\(folder)", generation: 1, sessionId: sessionId ?? "id-\(folder)", sessionName: sessionName,
        cwd: "/Users/you/dev/\(folder)", folder: folder, project: project, model: "model-a", startedAt: start,
        participants: 0, relayConnected: true, inputRequired: false, busy: nil, access: .view, pinned: pinned,
        reports: [])
}

private func task(_ folder: String, project: String?, title: String?) -> LongTask {
    LongTask(
        sessionId: "id-\(folder)", title: title, cwd: "/Users/you/dev/\(folder)", folder: folder, project: project,
        profile: nil, lastActiveAt: start, reports: [])
}

private func entries(_ hosts: [HostCard], _ tasks: [LongTask] = []) -> (chats: [SessionEntry], longTasks: [SessionEntry]) {
    SessionList.compose(HostsResponse(fetchedAt: start, hosts: hosts, longTasks: tasks, projects: [], pageCopy: nil))
}

private func view(
    _ tab: ListTab, _ entries: (chats: [SessionEntry], longTasks: [SessionEntry]), projects: [String],
    search: String = "", selected: String? = nil
) -> ListResult {
    SessionList.view(tab: tab, entries: entries, projects: projects, search: search, selected: selected)
}

private func chipLine(_ result: ListResult) -> [String] {
    result.chips.map { "\($0.label) \($0.count)\($0.isEmpty ? " empty" : "")\($0.isSelected ? " lit" : "")" }
}

@Suite struct SessionListTests {
    @Test func composeSplitsChatsFromLongTasks() {
        let e = entries(
            [host("charlie", project: "orion"), host("papa", project: "orion", pinned: true), host("tango", project: "vega")],
            [task("delta", project: "vega", title: "nightly build"), task("tango", project: "vega", title: "release notes"),
             task("echo", project: nil, title: "")])
        #expect(e.chats.map(\.folder) == ["charlie"])
        #expect(e.longTasks.map(\.folder) == ["papa", "tango", "delta", "echo"])
        #expect(e.longTasks.map(\.title) == ["papa", "release notes", "nightly build", "echo"])
        #expect(e.longTasks.map { $0.host != nil } == [true, true, false, false])
    }

    @Test func searchNeedsEveryWordInSomeField() {
        let e = entries(
            [host("alpha-web", project: "orion", sessionId: "a1b2c3d4-e5f6-7a8b", sessionName: "Release Notes"),
             host("bravo", project: "orion")],
            [task("charlie", project: "orion", title: "Nightly Build")])
        func chats(_ search: String) -> [String] { view(.chats, e, projects: ["orion"], search: search).shown.map(\.folder) }
        #expect(chats("release") == ["alpha-web"])
        #expect(chats("A1B2C3D4") == ["alpha-web"])
        #expect(chats("e5f6") == [])
        #expect(chats("bravo") == ["bravo"])
        #expect(chats("users/you/dev") == ["alpha-web", "bravo"])
        #expect(chats("web notes") == ["alpha-web"])
        #expect(chats("web bravo") == [])
        #expect(chats("  ") == ["alpha-web", "bravo"])
        #expect(view(.longTasks, e, projects: ["orion"], search: "nightly").shown.map(\.folder) == ["charlie"])
    }

    @Test func chipsCountTheOpenTabsMatches() {
        let e = entries([
            host("alpha", project: "orion"), host("bravo", project: "orion"), host("charlie", project: "vega"),
            host("delta", project: "vega", pinned: true),
        ])
        let projects = ["orion", "vega"]
        #expect(chipLine(view(.chats, e, projects: projects)) == ["All 3 lit", "orion 2", "vega 1"])
        #expect(chipLine(view(.chats, e, projects: projects, search: "alpha")) == ["All 1 lit", "orion 1", "vega 0 empty"])
        let emptyPick = view(.longTasks, e, projects: projects, selected: "orion")
        #expect(chipLine(emptyPick) == ["All 1", "orion 0 empty lit", "vega 1"])
        #expect(emptyPick.shown.isEmpty)
    }

    @Test func otherChipShowsOnlyWhenNeededOrSelected() {
        let listed = entries([host("alpha", project: "orion")])
        #expect(view(.chats, listed, projects: ["orion"]).chips.map(\.label) == ["All", "orion"])
        let picked = view(.chats, listed, projects: ["orion"], selected: "other")
        #expect(chipLine(picked) == ["All 1", "orion 1", "other 0 empty lit"])
        #expect(picked.selected == "other")

        let outside = entries(
            [host("alpha", project: "orion"), host("bravo", project: "zulu", pinned: true)],
            [task("charlie", project: nil, title: "c")])
        #expect(chipLine(view(.chats, outside, projects: ["orion"])) == ["All 1 lit", "orion 1", "other 0 empty"])
        #expect(chipLine(view(.longTasks, outside, projects: ["orion"])) == ["All 2 lit", "orion 0 empty", "other 2"])
    }

    @Test func aProjectTheServerDropsFallsBackToAll() {
        let e = entries([host("alpha", project: "orion"), host("bravo", project: "vega")])
        let result = view(.chats, e, projects: ["orion"], selected: "vega")
        #expect(result.selected == nil)
        #expect(chipLine(result) == ["All 2 lit", "orion 1", "other 1"])
        #expect(result.shown.map(\.folder) == ["alpha", "bravo"])
        #expect(result.countLine == nil)
    }

    @Test func tappingTheLitChipKeepsIt() {
        #expect(SessionList.select("orion", current: "orion") == "orion")
        #expect(SessionList.select(nil, current: nil) == nil)
        #expect(SessionList.select("vega", current: "orion") == "vega")
        #expect(SessionList.select(nil, current: "orion") == nil)
    }

    @Test func countLineShowsWhileFiltering() {
        let e = entries([host("alpha", project: "orion"), host("bravo", project: "orion"), host("charlie", project: "vega")])
        let projects = ["orion", "vega"]
        #expect(view(.chats, e, projects: projects).countLine == nil)
        #expect(view(.chats, e, projects: projects, selected: "orion").countLine == "2 of 3 chats")
        #expect(view(.chats, e, projects: projects, search: "charlie").countLine == "1 of 3 chats")
        #expect(view(.longTasks, e, projects: projects, search: "alpha").countLine == nil)
        let pinned = entries([host("alpha", project: "orion", pinned: true)])
        #expect(view(.longTasks, pinned, projects: projects, search: "zz").countLine == "0 of 1 long tasks")
    }

    @Test func longTasksGroupByProjectInChipOrder() {
        let e = entries(
            [host("alpha", project: "vega", pinned: true), host("bravo", project: "orion", pinned: true),
             host("charlie", project: nil, pinned: true)],
            [task("delta", project: "orion", title: "d")])
        let projects = ["orion", "vega", "dev"]
        let sections = view(.longTasks, e, projects: projects).sections
        #expect(sections.map { "\($0.project): \($0.entries.map(\.folder).joined(separator: ","))" }
            == ["orion: bravo,delta", "vega: alpha", "other: charlie"])
        #expect(view(.longTasks, e, projects: projects, selected: "vega").sections.map(\.project) == ["vega"])
        #expect(view(.chats, e, projects: projects).sections.isEmpty)
    }
}
