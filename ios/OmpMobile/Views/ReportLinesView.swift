import OmpKit
import SwiftUI

/// The latest report of each of a long task's jobs, one line each: outcome, job, when, and the
/// summary's first line (`buildReportList` in `server/public/app.js`). Tapping a line shows the whole
/// summary and the details path.
struct ReportLinesView: View {
    let reports: [JobReport]
    /// The report a tapped notification is about; its line opens and stays open.
    var expanded: String? = nil
    @State private var open: Set<String> = []

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(reports, id: \.id) { report in
                line(report)
            }
        }
        .onChange(of: expanded, initial: true) { _, id in
            if let id { open.insert(id) }
        }
    }

    private func line(_ report: JobReport) -> some View {
        let isOpen = open.contains(report.id)
        return VStack(alignment: .leading, spacing: 4) {
            Button {
                if isOpen { open.remove(report.id) } else { open.insert(report.id) }
            } label: {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Image(systemName: report.outcome.systemImage)
                        .foregroundStyle(report.outcome.tint)
                        .accessibilityLabel(report.outcome.rawValue)
                    Text(report.job)
                        .fontWeight(.semibold)
                    Text(CardText.reportTime(report.at, now: .now))
                        .foregroundStyle(.secondary)
                    Text(CardText.firstLine(report.summary))
                        .lineLimit(1)
                }
                .font(.caption)
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.borderless)
            .foregroundStyle(.primary)
            .accessibilityHint(isOpen ? "Hides the whole report." : "Shows the whole report.")
            if isOpen {
                Text(report.summary)
                    .font(.caption)
                if let details = report.details {
                    Text(details)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }
}
