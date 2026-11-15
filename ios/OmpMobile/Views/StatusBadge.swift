import OmpKit
import SwiftUI

/// A short status on a card: text, an SF Symbol and a color, so color is never the only sign.
struct StatusBadge: View {
    let text: String
    let systemImage: String
    let tint: Color

    init(text: String, systemImage: String, tint: Color) {
        self.text = text
        self.systemImage = systemImage
        self.tint = tint
    }

    init(_ status: CardStatus) {
        self.init(text: status.text, systemImage: status.systemImage, tint: status.tint)
    }

    var body: some View {
        Label(text, systemImage: systemImage)
            .font(.caption.weight(.semibold))
            .foregroundStyle(tint)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(tint.opacity(0.15), in: Capsule())
    }
}

extension CardStatus {
    var systemImage: String {
        switch self {
        case .needsInput: "exclamationmark.bubble.fill"
        case .running: "play.circle.fill"
        case .idle: "checkmark.circle.fill"
        case .unknown: "questionmark.circle"
        case .closed: "stop.circle"
        }
    }

    var tint: Color {
        switch self {
        case .needsInput: .orange
        case .running: .blue
        case .idle: .green
        case .unknown, .closed: .gray
        }
    }
}

extension ReportOutcome {
    /// The mark before a report line. An outcome this app does not know gets the failed mark, as on
    /// the phone page.
    var systemImage: String {
        switch self {
        case .ok: "checkmark.circle.fill"
        case .update: "info.circle.fill"
        case .failed, .unknown: "xmark.octagon.fill"
        }
    }

    var tint: Color {
        switch self {
        case .ok: .green
        case .update: .blue
        case .failed, .unknown: .red
        }
    }
}
