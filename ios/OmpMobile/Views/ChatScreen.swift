import OmpKit
import SwiftUI

/// The open chat in the detail column: the page copy under a toolbar with the chat's name, Watching or
/// Control, and Reload. On iPhone the split view's back button returns to the list; the web view stays
/// in `ChatPool`, so the same chat again shows at once.
struct ChatScreen: View {
    @Environment(AppModel.self) private var model
    @AppStorage("theme") private var theme: Theme = .system
    let page: ChatPage

    var body: some View {
        CollabWebView(page: page)
            .ignoresSafeArea(.keyboard)
            .overlay {
                if let error = page.loadError {
                    ContentUnavailableView {
                        Label("Can't load the chat", systemImage: "exclamationmark.bubble")
                    } description: {
                        Text(error)
                    } actions: {
                        Button("Retry") { reload() }
                            .accessibilityIdentifier("chat.retry")
                    }
                    .background(.background)
                }
            }
            .navigationTitle(page.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    VStack(spacing: 0) {
                        Text(page.title)
                            .font(.headline)
                            .lineLimit(1)
                        Text(page.key.access == .control ? "Control" : "Watching")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .accessibilityIdentifier("chat.access")
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        reload()
                    } label: {
                        if page.isReloading {
                            ProgressView()
                        } else {
                            Label("Reload", systemImage: "arrow.clockwise")
                        }
                    }
                    .disabled(page.isReloading)
                    .accessibilityLabel("Reload")
                    .accessibilityIdentifier("chat.reload")
                }
            }
            .onChange(of: theme) { reload() }
            .onAppear { model.shownChat = page }
            .onDisappear { if model.shownChat === page { model.shownChat = nil } }
    }

    private func reload() {
        Task { await model.reloadChat(theme: theme) }
    }
}
