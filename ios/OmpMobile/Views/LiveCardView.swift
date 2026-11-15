import OmpKit
import SwiftUI

/// A live chat or live long task: title and folder, status, the meta line, job reports, and Watch and Control, which open the chat in the app (`buildLiveCard` in `server/public/app.js`).
struct LiveCardView: View {
    let entry: SessionEntry
    let host: HostCard
    let showReports: Bool
    let canPin: Bool
    let isPinning: Bool
    let canOpen: Bool
    let isOpening: Bool
    /// A tapped notification is about this card; `SessionListView` tints its row.
    let isHighlighted: Bool
    /// The report a tapped notification is about; its line opens.
    let expandedReport: String?
    let onPin: () -> Void
    let onWatch: () -> Void
    let onControl: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 8) {
                summary
                if canPin {
                    PinButton(entry: entry, isBusy: isPinning, action: onPin)
                }
            }
            if showReports && !host.reports.isEmpty {
                ReportLinesView(reports: host.reports, expanded: expandedReport)
            }
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 8) { actions }
                VStack(alignment: .leading, spacing: 8) { actions }
            }
        }
        .padding(.vertical, 4)
    }

    private var status: CardStatus { CardStatus(host) }

    private var summary: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(entry.title)
                .font(.headline)
            Text(entry.cwd)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.middle)
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 6) { badges }
                VStack(alignment: .leading, spacing: 4) { badges }
            }
            Text(CardText.liveMeta(host, now: .now))
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilitySummary)
        .accessibilityValue(isHighlighted ? "From notification" : "")
        .accessibilityIdentifier("card.\(entry.id)")
    }

    @ViewBuilder
    private var badges: some View {
        StatusBadge(status)
        if host.participants > 1 {
            StatusBadge(text: "\(host.participants) connected", systemImage: "person.2.fill", tint: .gray)
        }
        if !host.relayConnected {
            StatusBadge(text: "Relay offline", systemImage: "wifi.slash", tint: .red)
        }
    }

    @ViewBuilder
    private var actions: some View {
        Button("Watch", action: onWatch)
            .buttonStyle(.bordered)
            .controlSize(.large)
            .disabled(!canOpen)
            .accessibilityHint("Opens the chat in the app.")
            .accessibilityIdentifier("watch.\(entry.id)")
        if host.access == .control {
            Button("Control", action: onControl)
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .disabled(!canOpen)
                .accessibilityHint("Asks to confirm. Gives full control of the session on the Mac.")
                .accessibilityIdentifier("control.\(entry.id)")
        }
        if isOpening {
            ProgressView()
        }
    }

    private var accessibilitySummary: String {
        var parts = [entry.title, status.text, "session \(CardText.sessionName(host))", "model \(host.model)"]
        if host.participants > 1 { parts.append("\(host.participants) connected") }
        if !host.relayConnected { parts.append("relay offline") }
        return parts.joined(separator: ", ")
    }
}
