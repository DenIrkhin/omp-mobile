import Foundation
import Testing
@testable import OmpKit

@Suite struct APIErrorTests {
    let host = "mac.example.ts.net"

    func body(_ s: String) -> Data { Data(s.utf8) }

    @Test func urlErrorTexts() {
        let offline = "This device is offline."
        let notFound = "Can't find mac.example.ts.net. Is Tailscale connected on this device?"
        let noAnswer = "No answer from mac.example.ts.net. Tailscale may be off, or the Mac is asleep or the server stopped."
        let https = "HTTPS failed. Check the address and that tailscale serve runs."
        let cases: [(URLError.Code, String)] = [
            (.notConnectedToInternet, offline),
            (.cannotFindHost, notFound),
            (.dnsLookupFailed, notFound),
            (.timedOut, noAnswer),
            (.cannotConnectToHost, noAnswer),
            (.networkConnectionLost, noAnswer),
            (.secureConnectionFailed, https),
            (.serverCertificateUntrusted, https),
            (.serverCertificateHasBadDate, https),
            (.serverCertificateHasUnknownRoot, https),
            (.serverCertificateNotYetValid, https),
        ]
        for (code, text) in cases {
            #expect(APIError(URLError(code), host: host).message == text, "\(code)")
        }
    }

    @Test func forbiddenTexts() throws {
        let fixture = try Fixture.data("error-403.json")
        #expect(APIError(status: 403, body: fixture, route: .hosts)
            == .forbidden("This Tailscale login is not allowed here."))
        #expect(APIError(status: 403, body: body(#"{"error":"Missing Tailscale-User-Login header"}"#), route: .hosts)
            == .forbidden("The request did not come through tailscale serve."))
        #expect(APIError(status: 403, body: body(#"{"error":"Host inst-alpha only allows view access"}"#), route: .hosts)
            == .forbidden("Host inst-alpha only allows view access"))
    }

    @Test func noAPIv1OnlyForInfo() {
        #expect(APIError(status: 404, body: body(#"{"error":"Not found"}"#), route: .info) == .noAPIv1)
        #expect(APIError(status: 404, body: body("Not found"), route: .info) == .noAPIv1)
        #expect(APIError(status: 404, body: body(#"{"error":"Not found"}"#), route: .hosts)
            == .http(404, "Not found", code: nil))
    }

    @Test func badGatewayText() {
        let error = APIError(
            status: 502, body: body(#"{"error":"cmux could not create a workspace: exit code 1"}"#), route: .sessions)
        #expect(error == .http(502, "cmux could not create a workspace: exit code 1", code: nil))
        #expect(error.message == "The Mac could not run omp: cmux could not create a workspace: exit code 1")
    }

    @Test func conflictKeepsCode() throws {
        let error = APIError(status: 409, body: try Fixture.data("reopen-409.json"), route: .reopen)
        #expect(error == .http(409, "This session is already running", code: "running"))
        #expect(error.message == "This session is already running")
    }

    @Test func unreadableErrorBody() {
        let error = APIError(status: 500, body: body("<html>oops</html>"), route: .hosts)
        guard case .decoding = error else {
            Issue.record("expected .decoding, got \(error)")
            return
        }
    }
}
