import OmpKit
import SwiftUI

/// A tapped report notification whose card is no longer in the list: the job, its outcome and when,
/// from the notification itself.
struct ReportNoteSheet: View {
    let job: String
    let outcome: ReportOutcome
    let at: Date
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    LabeledContent("Job", value: job)
                        .accessibilityIdentifier("reportNote.job")
                    LabeledContent("Outcome") {
                        Label(outcome.rawValue, systemImage: outcome.systemImage)
                            .foregroundStyle(outcome.tint)
                    }
                    LabeledContent("Time", value: at.formatted(date: .abbreviated, time: .shortened))
                } footer: {
                    Text("Its chat is no longer in the list.")
                }
            }
            .navigationTitle("Job report")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                        .accessibilityIdentifier("reportNote.done")
                }
            }
        }
        .presentationDetents([.medium, .large])
    }
}
