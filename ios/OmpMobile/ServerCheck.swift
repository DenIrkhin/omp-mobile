import Foundation
import Observation
import OmpKit

/// The Connect check that onboarding and Settings share: parse the typed address, ask the server for
/// `GET /api/v1/info`, and keep what to show under the field.
@Observable
final class ServerCheck {
    enum Outcome {
        /// The typed text is not a server address; nothing was sent.
        case refused(ServerAddressError)
        /// The server answered, or the request failed with an `APIError`.
        case answered(ConnectResult)
    }

    /// A server that answered with API version 1, and its reply.
    struct Verified {
        let url: URL
        let info: ServerInfo
    }

    private(set) var isChecking = false
    private(set) var outcome: Outcome?
    private(set) var verified: Verified?
    @ObservationIgnored private var task: Task<Void, Never>?

    /// Starts a check of `input`. A check still running is cancelled first.
    func connect(_ input: String, using model: AppModel) {
        reset()
        switch ServerAddress.parse(input) {
        case .failure(let error):
            outcome = .refused(error)
        case .success(let url):
            isChecking = true
            task = Task {
                do {
                    let info = try await model.client(for: url).info()
                    guard !Task.isCancelled else { return }
                    let result = ConnectResult.evaluate(info)
                    if case .connected = result {
                        verified = Verified(url: url, info: info)
                    }
                    finish(.answered(result))
                } catch let error as APIError {
                    guard !Task.isCancelled else { return }
                    finish(.answered(.failed(error)))
                } catch {
                    // Only CancellationError gets here: reset() or a newer check owns the state now.
                }
            }
        }
    }

    /// Forgets the last check, as when the typed address changes.
    func reset() {
        task?.cancel()
        task = nil
        isChecking = false
        outcome = nil
        verified = nil
    }

    private func finish(_ outcome: Outcome) {
        self.outcome = outcome
        isChecking = false
    }
}
