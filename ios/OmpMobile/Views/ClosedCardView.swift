import OmpKit
import SwiftUI

/// A long task whose chat is closed: title and folder, Closed, when it was last active, the profile
/// when it is not the server's main one, and job reports (`buildClosedCard` in
/// `server/public/app.js`). Reopen, when the server runs New session, starts the chat again.
struct ClosedCardView: View {
    let entry: SessionEntry
    let task: LongTask
    let mainProfile: String?
    let showReports: Bool
    let canPin: Bool
    let isPinning: Bool
    let canReopen: Bool
    let isReopening: Bool
    let reopenDisabled: Bool
    /// A tapped notification is about this card; `SessionListView` tints its row.
    let isHighlighted: Bool
    /// The report a tapped notification is about; its line opens.
    let expandedReport: String?
    let onPin: () -> Void
    let onReopen: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 8) {
                summary
                if canPin {
                    PinButton(entry: entry, isBusy: isPinning, action: onPin)
                }
            }
            if showReports && !task.reports.isEmpty {
                ReportLinesView(reports: task.reports, expanded: expandedReport)
            }
            if canReopen {
                Button(isReopening ? "Starting…" : "Reopen", action: onReopen)
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                    .disabled(reopenDisabled)
                    .accessibilityHint("Starts the chat again on the Mac.")
                    .accessibilityIdentifier("reopen.\(entry.id)")
            }
        }
        .padding(.vertical, 4)
    }

    private var summary: some View {
        let meta = CardText.closedMeta(task, mainProfile: mainProfile, now: .now)
        return VStack(alignment: .leading, spacing: 6) {
            Text(entry.title)
                .font(.headline)
            Text(entry.cwd)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.middle)
            StatusBadge(.closed)
            Text(meta)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(entry.title), \(CardStatus.closed.text), \(meta)")
        .accessibilityValue(isHighlighted ? "From notification" : "")
        .accessibilityIdentifier("card.\(entry.id)")
    }
}
