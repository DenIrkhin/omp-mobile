import Foundation
import Testing
@testable import OmpKit

private let now = Date(timeIntervalSince1970: 1_800_000_000)

private func host(name: String? = nil, inputRequired: Bool = false, busy: Bool? = nil) -> HostCard {
    HostCard(
        instanceId: "inst-alpha", generation: 1, sessionId: "a1b2c3d4-e5f6-7a8b", sessionName: name,
        cwd: "/Users/you/dev/alpha", folder: "alpha", project: "orion", model: "model-a",
        startedAt: now.addingTimeInterval(-300), participants: 1, relayConnected: true,
        inputRequired: inputRequired, busy: busy, access: .control, pinned: false, reports: [])
}

private func task(profile: String?) -> LongTask {
    LongTask(
        sessionId: "b2c3d4e5-f6a7-8b9c", title: "nightly build", cwd: "/Users/you/dev/bravo", folder: "bravo",
        project: "vega", profile: profile, lastActiveAt: now.addingTimeInterval(-7200), reports: [])
}

@Suite struct CardTextTests {
    @Test func relativeTimeCountsLikeThePage() {
        func ago(_ seconds: TimeInterval) -> String { CardText.relative(now.addingTimeInterval(-seconds), now: now) }
        #expect(ago(-5) == "just now")
        #expect(ago(9.9) == "just now")
        #expect(ago(10) == "10s ago")
        #expect(ago(59) == "59s ago")
        #expect(ago(60) == "1m ago")
        #expect(ago(3599) == "59m ago")
        #expect(ago(3600) == "1h ago")
        #expect(ago(86399) == "23h ago")
        #expect(ago(86400) == "1d ago")
    }

    @Test func statusLineSaysHowOldTheListIs() {
        #expect(CardText.updated(fetchedAt: now.addingTimeInterval(-2.9), now: now, pageCopyNote: nil) == "Updated just now")
        #expect(CardText.updated(fetchedAt: now.addingTimeInterval(-3), now: now, pageCopyNote: nil) == "Updated 3s ago")
        #expect(
            CardText.updated(fetchedAt: now.addingTimeInterval(-75), now: now, pageCopyNote: "build failed")
                == "Updated 75s ago · build failed")
    }

    @Test func pageCopyNoteOnlyWhenOnAndNotOk() {
        let broken = PageCopyState(ok: false, reason: "build failed")
        #expect(CardText.pageCopyNote(broken, enabled: true) == "build failed")
        #expect(CardText.pageCopyNote(broken, enabled: false) == nil)
        #expect(CardText.pageCopyNote(PageCopyState(ok: true, reason: nil), enabled: true) == nil)
        #expect(CardText.pageCopyNote(nil, enabled: true) == nil)
    }

    @Test func statusPicksNeedsInputFirst() {
        #expect(CardStatus(host(inputRequired: true, busy: true)) == .needsInput)
        #expect(CardStatus(host(busy: true)) == .running)
        #expect(CardStatus(host(busy: false)) == .idle)
        #expect(CardStatus(host(busy: nil)) == .unknown)
    }

    @Test func metaLineNamesTheSessionOrItsShortId() {
        #expect(CardText.liveMeta(host(name: "release notes"), now: now) == "Session: release notes · Model: model-a · Started: 5m ago")
        #expect(CardText.liveMeta(host(name: nil), now: now) == "Session: a1b2c3d4 · Model: model-a · Started: 5m ago")
        #expect(CardText.liveMeta(host(name: ""), now: now) == "Session: a1b2c3d4 · Model: model-a · Started: 5m ago")
    }

    @Test func closedMetaShowsAnotherProfile() {
        #expect(CardText.closedMeta(task(profile: "work"), mainProfile: "work", now: now) == "Last active: 2h ago")
        #expect(CardText.closedMeta(task(profile: nil), mainProfile: "work", now: now) == "Last active: 2h ago · Profile: default")
        #expect(CardText.closedMeta(task(profile: "lab"), mainProfile: nil, now: now) == "Last active: 2h ago · Profile: lab")
    }

    @Test func reportTimeCountsCalendarDays() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try #require(TimeZone(identifier: "UTC"))
        func at(_ secondsBefore: TimeInterval) -> String {
            CardText.reportTime(now.addingTimeInterval(-secondsBefore), now: now, calendar: calendar)
        }
        #expect(at(4 * 3600 + 56 * 60) == "today 03:04")
        #expect(at(23 * 3600) == "yesterday 09:00")
        #expect(at(3 * 86400) == "3d ago")
    }

    @Test func emptyListSaysWhy() {
        #expect(
            CardText.emptyState(tab: .longTasks, tabCount: 0, liveCount: 3, shownCount: 0, search: "", selected: nil)?.title
                == "No long tasks yet")
        #expect(
            CardText.emptyState(tab: .chats, tabCount: 0, liveCount: 3, shownCount: 0, search: "", selected: nil)?.title
                == "Every live chat is a long task")
        #expect(
            CardText.emptyState(tab: .chats, tabCount: 0, liveCount: 0, shownCount: 0, search: "", selected: nil)?.title
                == "No active shared sessions")
        #expect(
            CardText.emptyState(tab: .chats, tabCount: 4, liveCount: 4, shownCount: 0, search: " zulu ", selected: "orion")
                == EmptyState(
                    title: "No chats in orion match “zulu”",
                    hint: "Search checks the name and the folder. Clear the box or tap All to see more."))
        #expect(
            CardText.emptyState(tab: .longTasks, tabCount: 4, liveCount: 4, shownCount: 0, search: "", selected: "vega")
                == EmptyState(title: "No long tasks in vega", hint: "Tap All to see every project."))
        #expect(CardText.emptyState(tab: .chats, tabCount: 4, liveCount: 4, shownCount: 2, search: "zulu", selected: nil) == nil)
    }
}
