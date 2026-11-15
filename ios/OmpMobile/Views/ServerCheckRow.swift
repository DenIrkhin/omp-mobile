import OmpKit
import SwiftUI

/// The line under the address field after Connect or Check: the connect summary, or what went wrong.
/// Text, symbol and color together, never color alone.
struct ServerCheckRow: View {
    let outcome: ServerCheck.Outcome

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: failed ? "exclamationmark.triangle.fill" : "checkmark.circle.fill")
                .foregroundStyle(failed ? Color.red : Color.green)
                .accessibilityHidden(true)
            Text(text)
                .accessibilityIdentifier("server.message")
        }
    }

    private var failed: Bool {
        switch outcome {
        case .answered(.connected): false
        case .answered(.failed), .refused: true
        }
    }

    private var text: String {
        switch outcome {
        case .refused(let error): error.message
        case .answered(let result): result.message
        }
    }
}
