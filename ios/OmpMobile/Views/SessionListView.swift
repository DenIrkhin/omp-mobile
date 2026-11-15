import OmpKit
import SwiftUI

/// The list screen: Chats and Long tasks with search, project chips and cards, from the saved
/// server's `GET /api/v1/hosts`. The list rules are OmpKit's `SessionList`, the phone page's own. A
/// tapped notification lands here (`AppModel.tapDestination`) and opens a chat, a card, a report or a
/// toast.
struct SessionListView: View {
    /// The card a tapped notification is about, and its report.
    private struct Highlight: Equatable {
        let sessionId: String
        let reportId: String?
    }

    /// A tapped report notification whose card is gone.
    private struct ReportNote: Identifiable {
        let id = UUID()
        let job: String
        let outcome: ReportOutcome
        let at: Date
    }

    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @AppStorage("tab") private var tab: ListTab = .chats
    @AppStorage("project") private var project: String?
    @AppStorage("demo") private var demo = false
    @State private var search = ""
    @State private var showSettings = false
    @State private var confirmRemove: SessionEntry?
    @AppStorage("theme") private var theme: Theme = .system
    @State private var showNewSession = false
    @State private var confirmControl: SessionEntry?
    @State private var highlight: Highlight?
    @State private var scrollTarget: String?
    @State private var reportNote: ReportNote?

    var body: some View {
        content
            .navigationTitle("omp mobile")
            .searchable(
                text: $search, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search by name or folder")
            .toolbar { toolbar }
            .overlay(alignment: .bottom) { toastOverlay }
            .sheet(isPresented: $showSettings) { settings }
            .sheet(isPresented: $showNewSession) { NewSessionSheet().environment(model) }
            .sheet(item: $reportNote) { note in
                ReportNoteSheet(job: note.job, outcome: note.outcome, at: note.at)
            }
            .confirmationDialog(
                "Remove “\(confirmRemove?.title ?? "")” from Long tasks?",
                isPresented: Binding(get: { confirmRemove != nil }, set: { if !$0 { confirmRemove = nil } }),
                titleVisibility: .visible,
                presenting: confirmRemove
            ) { entry in
                Button("Remove", role: .destructive) { setPinned(entry, to: false) }
            } message: { _ in
                Text("Its chat is closed, so it disappears from this list. On the Mac, omp --resume still finds it.")
            }
            .confirmationDialog(
                "Open full control of “\(confirmControl?.folder ?? "")”?",
                isPresented: Binding(get: { confirmControl != nil }, set: { if !$0 { confirmControl = nil } }),
                titleVisibility: .visible,
                presenting: confirmControl
            ) { entry in
                Button("Open") { open(entry, access: .control) }
            } message: { _ in
                Text("Anyone holding this link can prompt the agent and run shell commands and tools on your Mac.")
            }
            .onChange(of: model.tapDestination, initial: true) { _, destination in
                guard let destination else { return }
                model.tapDestination = nil
                go(to: destination)
            }
            .task(id: highlight) {
                // The tint shows for 8 seconds; a report line it opened stays open.
                guard highlight != nil else { return }
                try? await Task.sleep(for: .seconds(8))
                if !Task.isCancelled { highlight = nil }
            }
    }

    @ViewBuilder
    private var content: some View {
        let store = model.sessions
        if let response = store.response {
            list(response)
        } else if let error = store.error {
            ContentUnavailableView {
                Label("Can't load chats", systemImage: "network.slash")
            } description: {
                Text(error.message)
            } actions: {
                Button("Retry") {
                    Task { await store.refresh(manual: true) }
                }
                .accessibilityIdentifier("list.retry")
            }
        } else {
            ProgressView("Connecting…")
        }
    }

    private func list(_ response: HostsResponse) -> some View {
        let store = model.sessions
        let features = model.info?.features
        let result = SessionList.view(
            tab: tab, entries: store.entries, projects: response.projects, search: search, selected: project)
        let empty = CardText.emptyState(
            tab: tab,
            tabCount: tab == .chats ? store.entries.chats.count : store.entries.longTasks.count,
            liveCount: response.hosts.count,
            shownCount: result.shown.count,
            search: search,
            selected: result.selected)
        return ScrollViewReader { proxy in
            List {
                Section {
                    Picker("List", selection: $tab) {
                        Text("Chats (\(store.entries.chats.count))").tag(ListTab.chats)
                        Text("Long tasks (\(store.entries.longTasks.count))").tag(ListTab.longTasks)
                    }
                    .pickerStyle(.segmented)
                    .accessibilityIdentifier("list.tab")
                    ProjectChips(chips: result.chips, tab: tab) { chip in
                        project = SessionList.select(chip, current: result.selected)
                    }
                    ListStatusView(
                        fetchedAt: response.fetchedAt,
                        pageCopyNote: CardText.pageCopyNote(response.pageCopy, enabled: features?.pageCopy == true),
                        countLine: result.countLine)
                }
                .listRowSeparator(.hidden)

                if let empty {
                    ContentUnavailableView(empty.title, systemImage: "tray", description: Text(empty.hint))
                        .listRowBackground(Color.clear)
                } else if tab == .chats {
                    Section {
                        ForEach(result.shown) { entry in
                            card(entry, features: features)
                        }
                    }
                } else {
                    ForEach(result.sections, id: \.project) { section in
                        Section {
                            ForEach(section.entries) { entry in
                                card(entry, features: features)
                            }
                        } header: {
                            Text("\(section.project) · \(section.entries.count)")
                        }
                    }
                }
            }
            .refreshable { await store.refresh() }
            .opacity(store.error == nil ? 1 : 0.5)
            .safeAreaInset(edge: .top) {
                VStack(spacing: 8) {
                    if demo {
                        DemoBanner {
                            model.onboardingAtAddress = true
                            model.leaveDemo()
                            demo = false
                        }
                    }
                    if let error = store.error {
                        ConnectionBanner(message: error.message) {
                            Task { await store.refresh(manual: true) }
                        }
                    }
                }
            }
            .onChange(of: result.selected, initial: true) { _, selected in
                // A project the server no longer lists fell back to All; remember that, as the page does.
                if project != selected { project = selected }
            }
            .task(id: scrollTarget) {
                // A tapped notification's card: the tab, project and search changed with it, so the list
                // gets a moment to show the card first.
                guard let target = scrollTarget else { return }
                try? await Task.sleep(for: .milliseconds(300))
                guard !Task.isCancelled else { return }
                withAnimation(reduceMotion ? nil : .default) { proxy.scrollTo(target, anchor: .center) }
                scrollTarget = nil
            }
        }
    }

    private func card(_ entry: SessionEntry, features: ServerInfo.Features?) -> some View {
        let canPin = features?.longTasks == true
        let showReports = features?.reports == true
        let canReopen = features?.launch == true && features?.longTasks == true
        let isPinning = model.sessions.pinning.contains(entry.sessionId)
        let isHighlighted = highlight?.sessionId == entry.sessionId
        let expandedReport = isHighlighted ? highlight?.reportId : nil
        return Group {
            if let host = entry.host {
                LiveCardView(
                    entry: entry, host: host, showReports: showReports, canPin: canPin, isPinning: isPinning,
                    canOpen: model.opening == nil, isOpening: model.opening == host.instanceId,
                    isHighlighted: isHighlighted, expandedReport: expandedReport,
                    onPin: { togglePin(entry) }, onWatch: { open(entry, access: .view) },
                    onControl: { confirmControl = entry })
            } else if let task = entry.task {
                ClosedCardView(
                    entry: entry, task: task, mainProfile: model.info?.mainProfile, showReports: showReports,
                    canPin: canPin, isPinning: isPinning, canReopen: canReopen,
                    isReopening: model.sessions.reopening == entry.sessionId,
                    reopenDisabled: model.sessions.reopening != nil,
                    isHighlighted: isHighlighted, expandedReport: expandedReport,
                    onPin: { togglePin(entry) }, onReopen: { reopen(entry) })
            }
        }
        .listRowBackground(isHighlighted ? Color.accentColor.opacity(0.15) : nil)
        .id(entry.id)
        .swipeActions(edge: .trailing) {
            if canPin { pinAction(entry, isPinning: isPinning) }
        }
        .contextMenu {
            if canPin { pinAction(entry, isPinning: isPinning) }
        }
    }

    private func pinAction(_ entry: SessionEntry, isPinning: Bool) -> some View {
        Button {
            togglePin(entry)
        } label: {
            Label(entry.pinned ? "Unpin" : "Pin", systemImage: entry.pinned ? "pin.slash" : "pin")
        }
        .tint(entry.pinned ? .gray : .orange)
        .disabled(isPinning)
    }

    /// Unpinning a closed long task removes its card from the app, so that asks first, as on the page.
    private func togglePin(_ entry: SessionEntry) {
        if entry.pinned && entry.host == nil {
            confirmRemove = entry
        } else {
            setPinned(entry, to: !entry.pinned)
        }
    }

    private func setPinned(_ entry: SessionEntry, to pinned: Bool) {
        let store = model.sessions
        Task { await store.setPinned(entry, to: pinned) }
    }

    private func open(_ entry: SessionEntry, access: Access) {
        guard let host = entry.host else { return }
        Task { await model.openChat(ChatTarget(host: host, title: entry.title, access: access), theme: theme) }
    }

    private func reopen(_ entry: SessionEntry) {
        let store = model.sessions
        Task { await store.reopen(entry) }
    }

    /// A tapped notification's destination. Sheets and dialogs close first, so what it shows is on
    /// screen; a chat opens with no confirm dialog.
    private func go(to destination: PushDestination) {
        showSettings = false
        showNewSession = false
        confirmControl = nil
        confirmRemove = nil
        switch destination {
        case .chat(let entry, let access):
            open(entry, access: access)
        case .card(let entry, let cardTab, let reportId):
            model.compactColumn = .sidebar
            tab = cardTab
            project = nil
            search = ""
            highlight = Highlight(sessionId: entry.sessionId, reportId: reportId)
            scrollTarget = entry.id
        case .report(let job, let outcome, let at):
            model.compactColumn = .sidebar
            reportNote = ReportNote(job: job, outcome: outcome, at: at)
        case .ended:
            model.compactColumn = .sidebar
            model.sessions.showToast("That chat has ended.", isError: true)
        case .refreshOnly:
            break
        }
    }

    @ViewBuilder
    private var toastOverlay: some View {
        if let toast = model.sessions.toast {
            ToastView(toast: toast)
                .padding(.bottom, 16)
                .task(id: toast.id) {
                    try? await Task.sleep(for: .seconds(3))
                    model.sessions.dismissToast(toast.id)
                }
        }
    }

    private var settings: some View {
        NavigationStack {
            SettingsView()
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done") { showSettings = false }
                            .accessibilityIdentifier("settings.done")
                    }
                }
        }
        .environment(model)
    }

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        ToolbarItem(placement: .topBarTrailing) {
            refreshButton
        }
        if model.info?.features.launch == true {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    showNewSession = true
                } label: {
                    Label("New session", systemImage: "plus")
                }
                .accessibilityIdentifier("list.newSession")
            }
        }
        ToolbarItem(placement: .topBarTrailing) {
            Button {
                showSettings = true
            } label: {
                Label("Settings", systemImage: "gearshape")
            }
            .accessibilityIdentifier("root.settings")
        }
    }

    /// Spins only while a refresh the user asked for runs; with Reduce Motion it only dims.
    private var refreshButton: some View {
        let store = model.sessions
        return Button {
            Task { await store.refresh(manual: true) }
        } label: {
            if store.isRefreshing && !reduceMotion {
                ProgressView()
            } else {
                Label("Refresh", systemImage: "arrow.clockwise")
            }
        }
        .disabled(store.isRefreshing)
        .accessibilityLabel("Refresh")
        .accessibilityIdentifier("list.refresh")
    }
}

/// Under the chips: how old the list is with the page copy's problem, and the count line while a search or a project hides cards.
private struct ListStatusView: View {
    let fetchedAt: Date
    let pageCopyNote: String?
    let countLine: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            TimelineView(.periodic(from: .now, by: 1)) { context in
                Text(CardText.updated(fetchedAt: fetchedAt, now: context.date, pageCopyNote: pageCopyNote))
                    .accessibilityIdentifier("list.updated")
            }
            if let countLine {
                Text(countLine)
                    .accessibilityIdentifier("list.count")
            }
        }
        .font(.footnote)
        .foregroundStyle(.secondary)
    }
}
