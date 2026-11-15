import Foundation
import Testing
@testable import OmpKit

@Suite struct PushTextTests {
    @Test func registrationFailure() {
        #expect(PushText.registrationFailed(
            domain: NSCocoaErrorDomain, code: 3000,
            description: "no valid “aps-environment” entitlement string found for application")
            == "Push needs a paid Apple Developer Program team.")
        #expect(PushText.registrationFailed(domain: "NSURLErrorDomain", code: -1009, description: "The device is offline.")
            == "This device could not register for notifications: The device is offline.")
    }

    /// The server's own bodies (`server/server.ts:775`, `:782-784`; `api/v1/README.md`, "Errors").
    @Test func serverAnswers() {
        func error(_ status: Int, _ body: String, _ route: Route) -> APIError {
            APIError(status: status, body: Data(body.utf8), route: route)
        }
        let refused = error(502, #"{"error":"APNs answered 400 BadDeviceToken","code":"BadDeviceToken"}"#, .pushTest)
        #expect(refused == .http(502, "APNs answered 400 BadDeviceToken", code: "BadDeviceToken"))
        #expect(PushText.testFailed(refused) == "Not sent: APNs answered 400 BadDeviceToken")
        let unknown = error(404, #"{"error":"This device is not registered for push","code":"unknown_device"}"#, .pushTest)
        #expect(unknown == .http(404, "This device is not registered for push", code: "unknown_device"))
        #expect(PushText.testFailed(unknown) == "This device is not registered for push")
        let noKey = error(400, #"{"error":"This server has no APNs key for production","code":"push_env"}"#, .devices)
        #expect(noKey == .http(400, "This server has no APNs key for production", code: "push_env"))
        #expect(noKey.message == "This server has no APNs key for production")
    }
}
