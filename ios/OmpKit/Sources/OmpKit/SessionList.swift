import Foundation

/// The two lists of the phone. The raw values are the ones the web page stores for its tabs.
public enum ListTab: String, Sendable, CaseIterable {
    case chats
    case longTasks = "long-tasks"
}

/// One card: a live chat, a live long task, or a closed long task.
public struct SessionEntry: Sendable, Equatable, Identifiable {
    /// The live chat; nil when the long task is closed.
    public let host: HostCard?
    /// The long task; nil for a chat.
    public let task: LongTask?
    /// True for the entries of the Long tasks tab.
    public let pinned: Bool
    /// A long task's title, else the folder name.
    public let title: String
    public let sessionId: String
    public let folder: String
    public let cwd: String
    /// The server's project; `SessionList.view` treats one it does not list as "other".
    public let project: String?

    init(host: HostCard, task: LongTask?, pinned: Bool) {
        self.host = host
        self.task = task
        self.pinned = pinned
        self.title = pinned ? Self.displayTitle(task?.title, orFolder: host.folder) : host.folder
        self.sessionId = host.sessionId
        self.folder = host.folder
        self.cwd = host.cwd
        self.project = host.project
    }

    init(closed task: LongTask) {
        self.host = nil
        self.task = task
        self.pinned = true
        self.title = Self.displayTitle(task.title, orFolder: task.folder)
        self.sessionId = task.sessionId
        self.folder = task.folder
        self.cwd = task.cwd
        self.project = task.project
    }

    public var id: String { host?.instanceId ?? sessionId }
    public var sessionName: String? { host?.sessionName }
    /// The first 8 characters of the session id, which a card shows when the chat has no name.
    public var shortId: String { String(sessionId.prefix(8)) }

    /// What search looks through, as the web page builds it.
    var searchText: String {
        "\(title) \(sessionName ?? "") \(shortId) \(folder) \(cwd)".lowercased()
    }

    private static func displayTitle(_ title: String?, orFolder folder: String) -> String {
        if let title, !title.isEmpty { return title }
        return folder
    }
}

/// A project chip. `project` is nil for All.
public struct ProjectChip: Sendable, Equatable {
    public let project: String?
    /// The open tab's entries that match the search, in this project (All: in every project).
    public let count: Int
    public let isSelected: Bool

    public var label: String { project ?? "All" }
    /// A chip with nothing to show is dimmed but stays tappable.
    public var isEmpty: Bool { count == 0 }
}

/// A Long tasks section: one project, in chip order.
public struct ListSection: Sendable, Equatable {
    public let project: String
    public let entries: [SessionEntry]
}

public struct ListResult: Sendable, Equatable {
    /// The entries to show, in list order.
    public let shown: [SessionEntry]
    /// `shown` grouped by project on the Long tasks tab; empty on the Chats tab.
    public let sections: [ListSection]
    public let chips: [ProjectChip]
    /// The selected project after a project the server no longer lists fell back to nil (All).
    public let selected: String?
    /// "4 of 31 chats" while a search or a project is active and the tab has entries; else nil.
    public let countLine: String?
}

/// The phone page's list rules (`renderHosts` in `server/public/app.js`), for the app's list screen.
public enum SessionList {
    /// The chip and the Long tasks section of entries whose project the server does not list.
    public static let otherProject = "other"

    /// Splits the reply into the two tabs. A live host is a long task when it is pinned or has a
    /// long task; closed long tasks follow the live ones, in the server's order.
    public static func compose(_ response: HostsResponse) -> (chats: [SessionEntry], longTasks: [SessionEntry]) {
        var tasksById: [String: LongTask] = [:]
        for task in response.longTasks { tasksById[task.sessionId] = task }
        var chats: [SessionEntry] = []
        var longTasks: [SessionEntry] = []
        for host in response.hosts {
            let task = tasksById[host.sessionId]
            if host.pinned || task != nil {
                longTasks.append(SessionEntry(host: host, task: task, pinned: true))
            } else {
                chats.append(SessionEntry(host: host, task: nil, pinned: false))
            }
        }
        let liveIds = Set(response.hosts.map(\.sessionId))
        for task in response.longTasks where !liveIds.contains(task.sessionId) {
            longTasks.append(SessionEntry(closed: task))
        }
        return (chats, longTasks)
    }

    /// What one tab shows for a search and a selected project (nil: All).
    public static func view(
        tab: ListTab,
        entries: (chats: [SessionEntry], longTasks: [SessionEntry]),
        projects: [String],
        search: String,
        selected: String?
    ) -> ListResult {
        let tabEntries = tab == .chats ? entries.chats : entries.longTasks
        let words = search.lowercased().split(whereSeparator: \.isWhitespace).map(String.init)
        let matching = tabEntries.filter { entry in
            let text = entry.searchText
            return words.allSatisfy { text.contains($0) }
        }
        func project(of entry: SessionEntry) -> String {
            if let project = entry.project, projects.contains(project) { return project }
            return otherProject
        }

        var names = projects
        if selected == otherProject || (entries.chats + entries.longTasks).contains(where: { project(of: $0) == otherProject }) {
            names.append(otherProject)
        }
        let selection = selected.flatMap { names.contains($0) ? $0 : nil }

        var counts: [String: Int] = [:]
        for entry in matching { counts[project(of: entry), default: 0] += 1 }
        let chips = [ProjectChip(project: nil, count: matching.count, isSelected: selection == nil)]
            + names.map { ProjectChip(project: $0, count: counts[$0] ?? 0, isSelected: $0 == selection) }

        let shown = selection.map { picked in matching.filter { project(of: $0) == picked } } ?? matching
        let kind = tab == .chats ? "chats" : "long tasks"
        let countLine = (!words.isEmpty || selection != nil) && !tabEntries.isEmpty
            ? "\(shown.count) of \(tabEntries.count) \(kind)"
            : nil

        let sections: [ListSection] = tab == .chats ? [] : names.compactMap { name -> ListSection? in
            let list = shown.filter { project(of: $0) == name }
            return list.isEmpty ? nil : ListSection(project: name, entries: list)
        }
        return ListResult(shown: shown, sections: sections, chips: chips, selected: selection, countLine: countLine)
    }

    /// The selected project after a chip tap (nil: All). Tapping the lit chip keeps it: the chips
    /// pick one project at a time and never toggle off.
    public static func select(_ chip: String?, current: String?) -> String? {
        chip == current ? current : chip
    }
}
