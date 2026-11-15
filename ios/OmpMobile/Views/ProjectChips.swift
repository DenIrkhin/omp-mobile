import OmpKit
import SwiftUI

/// All, then one chip per project with how many cards of the open tab match the search. One chip is
/// lit; tapping it again changes nothing. A chip with 0 is dimmed but still works.
struct ProjectChips: View {
    let chips: [ProjectChip]
    let tab: ListTab
    let onTap: (String?) -> Void

    var body: some View {
        ScrollView(.horizontal) {
            HStack(spacing: 8) {
                ForEach(chips, id: \.label) { chip in
                    Button {
                        onTap(chip.project)
                    } label: {
                        HStack(spacing: 6) {
                            Text(chip.label)
                            Text("\(chip.count)").monospacedDigit()
                        }
                        .font(.subheadline.weight(chip.isSelected ? .semibold : .regular))
                        .padding(.horizontal, 14)
                        .frame(minHeight: 44)
                        .foregroundStyle(chip.isSelected ? Color.white : Color.primary)
                        .background(chip.isSelected ? Color.accentColor : Color.secondary.opacity(0.15), in: Capsule())
                    }
                    .buttonStyle(.plain)
                    .opacity(chip.isEmpty ? 0.45 : 1)
                    .accessibilityLabel("\(chip.label), \(chip.count) \(noun(chip.count))")
                    .accessibilityAddTraits(chip.isSelected ? .isSelected : [])
                    .accessibilityIdentifier("chip.\(chip.label)")
                }
            }
        }
        .scrollIndicators(.hidden)
    }

    private func noun(_ count: Int) -> String {
        switch tab {
        case .chats: count == 1 ? "chat" : "chats"
        case .longTasks: count == 1 ? "long task" : "long tasks"
        }
    }
}
