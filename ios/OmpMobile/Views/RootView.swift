import OmpKit
import SwiftUI

/// Onboarding until a server address is saved or the demo runs, then the session list beside the open chat. On iPhone the split view collapses to the list, and opening a chat moves to it. The list polls while the app is in front.
struct RootView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.scenePhase) private var scenePhase
    @AppStorage("serverURL") private var serverURL = ""
    @AppStorage("demo") private var demo = false
    @State private var columns = NavigationSplitViewVisibility.all

    var body: some View {
        @Bindable var model = model
        if let url = serverAddress {
            NavigationSplitView(columnVisibility: $columns, preferredCompactColumn: $model.compactColumn) {
                SessionListView()
            } detail: {
                if let page = model.chats.page {
                    ChatScreen(page: page)
                        .id(ObjectIdentifier(page))
                } else {
                    ContentUnavailableView("Pick a chat", systemImage: "bubble.left.and.bubble.right")
                }
            }
            .task(id: url) {
                model.use(url)
                if scenePhase == .active { model.sessions.start() }
                await model.refreshInfo(from: url)
            }
            .onChange(of: scenePhase) { _, phase in
                switch phase {
                case .active:
                    model.sessions.start()
                    Task { await model.refreshInfo(from: url) }
                case .background:
                    model.sessions.stop()
                default:
                    break
                }
            }
            .onChange(of: model.sessions.loads) { model.listLoaded() }
        } else {
            OnboardingView(startsAtAddress: model.onboardingAtAddress)
        }
    }

    /// The demo's in-app server while the demo runs, else the saved address.
    private var serverAddress: URL? {
        if demo { return DemoServer.baseURL }
        return serverURL.isEmpty ? nil : URL(string: serverURL)
    }
}
