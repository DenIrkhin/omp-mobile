import OmpKit
import SwiftUI

/// New session: a folder and a model the server offers, and an optional spend cap. Start asks the Mac
/// to start omp there, then the app opens the new chat in Control at once.
struct NewSessionSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @AppStorage("theme") private var theme: Theme = .system
    @AppStorage("lastFolder") private var lastFolder: String?
    @AppStorage("lastModel") private var lastModel: String?
    @State private var options: LaunchOptions?
    @State private var loadError: String?
    @State private var folder = ""
    @State private var modelId = ""
    @State private var cap = ""
    @State private var startError: String?
    @State private var isStarting = false

    var body: some View {
        NavigationStack {
            Form { content }
                .navigationTitle("New session")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel") { dismiss() }
                            .disabled(isStarting)
                    }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Start") { start() }
                            .disabled(!canStart)
                            .accessibilityIdentifier("newSession.start")
                    }
                }
        }
        .interactiveDismissDisabled(isStarting)
        .task { await load() }
    }

    private var spendCap: NewSession.SpendCap {
        NewSession.spendCap(cap, locale: .current)
    }

    private var canStart: Bool {
        options != nil && !folder.isEmpty && !modelId.isEmpty && spendCap != .invalid && !isStarting
    }

    @ViewBuilder
    private var content: some View {
        if let options {
            Section {
                Picker("Folder", selection: $folder) {
                    ForEach(options.folders, id: \.self) { item in
                        Text(NewSession.folderLabel(item, in: options)).tag(item)
                    }
                }
                .accessibilityIdentifier("newSession.folder")
                Picker("Model", selection: $modelId) {
                    ForEach(options.models, id: \.id) { item in
                        Text(item.label).tag(item.id)
                    }
                }
                .accessibilityIdentifier("newSession.model")
            }
            .disabled(isStarting)
            Section {
                TextField("No cap", text: $cap)
                    .keyboardType(.decimalPad)
                    .accessibilityIdentifier("newSession.cap")
            } header: {
                Text("Spend cap (USD)")
            } footer: {
                if spendCap == .invalid {
                    Text("Enter an amount above 0 and at most 500, or leave it empty.")
                        .foregroundStyle(.red)
                } else {
                    Text("Optional. omp's spending limit for this chat.")
                }
            }
            .disabled(isStarting)
            if isStarting {
                Section {
                    HStack(spacing: 12) {
                        ProgressView()
                        Text("Starting omp in \(NewSession.leafName(folder))… this takes a few seconds.")
                    }
                }
            }
            if let startError {
                Section {
                    Text(startError)
                        .foregroundStyle(.red)
                        .accessibilityIdentifier("newSession.error")
                }
            }
        } else if let loadError {
            Section {
                Text("Could not load folders: \(loadError)")
                    .foregroundStyle(.red)
                Button("Retry") { Task { await load() } }
            }
        } else {
            Section {
                HStack(spacing: 12) {
                    ProgressView()
                    Text("Loading folders and models…")
                }
            }
        }
    }

    private func load() async {
        guard let server = model.server else { return }
        loadError = nil
        do {
            let fresh = try await server.launchOptions()
            if let choice = NewSession.initialChoice(fresh, lastFolder: lastFolder, lastModel: lastModel) {
                folder = choice.folder
                modelId = choice.model
            }
            options = fresh
        } catch let failure as APIError {
            loadError = failure.message
        } catch {}
    }

    private func start() {
        let maxCost: Double?
        switch spendCap {
        case .noCap: maxCost = nil
        case .usd(let value): maxCost = value
        case .invalid: return
        }
        lastFolder = folder
        lastModel = modelId
        isStarting = true
        startError = nil
        Task {
            let failure = await model.startSession(folder: folder, model: modelId, maxCost: maxCost, theme: theme)
            isStarting = false
            if let failure {
                startError = failure.message
            } else {
                dismiss()
            }
        }
    }
}
