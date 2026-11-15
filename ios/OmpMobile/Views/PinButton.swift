import OmpKit
import SwiftUI

/// The pin on a card: it moves a chat to Long tasks, or takes a long task off the list.
struct PinButton: View {
    let entry: SessionEntry
    let isBusy: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: entry.pinned ? "pin.fill" : "pin")
                .frame(width: 44, height: 44)
        }
        .buttonStyle(.borderless)
        .disabled(isBusy)
        .accessibilityLabel(entry.pinned ? "Remove from Long tasks" : "Move to Long tasks")
        .accessibilityIdentifier("pin.\(entry.id)")
    }
}
