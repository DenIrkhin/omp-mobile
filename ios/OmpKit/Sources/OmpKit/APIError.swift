import Foundation

public enum APIError: Error, Equatable {
    case offline, hostNotFound(String), unreachable(String), tls(String),
         forbidden(String), noAPIv1, incompatible(Int), http(Int, String, code: String?), decoding(String)

    public var message: String {
        switch self {
        case .offline:
            "This device is offline."
        case .hostNotFound(let h):
            "Can't find \(h). Is Tailscale connected on this device?"
        case .unreachable(let h):
            "No answer from \(h). Tailscale may be off, or the Mac is asleep or the server stopped."
        case .tls:
            "HTTPS failed. Check the address and that tailscale serve runs."
        case .forbidden(let text):
            text
        case .noAPIv1:
            "This server has no /api/v1. Update the server."
        case .incompatible(let n):
            "This server uses API version \(n). Update the app or the server."
        case .http(502, let e, _):
            "The Mac could not run omp: \(e)"
        case .http(_, let e, _):
            e
        case .decoding(let d):
            "The server sent a reply this app cannot read: \(d)"
        }
    }

    public init(_ error: URLError, host: String) {
        switch error.code {
        case .notConnectedToInternet:
            self = .offline
        case .cannotFindHost, .dnsLookupFailed:
            self = .hostNotFound(host)
        case .secureConnectionFailed, .serverCertificateHasBadDate, .serverCertificateUntrusted,
             .serverCertificateHasUnknownRoot, .serverCertificateNotYetValid:
            self = .tls(host)
        default:
            self = .unreachable(host)
        }
    }

    init(status: Int, body: Data, route: Route) {
        if route == .info && status == 404 {
            self = .noAPIv1
            return
        }
        guard let parsed = try? OmpJSON.decoder.decode(ErrorBody.self, from: body) else {
            self = .decoding("\(route.path): HTTP \(status) reply is not an API error")
            return
        }
        if status == 403 {
            switch parsed.error {
            case "Missing Tailscale-User-Login header":
                self = .forbidden("The request did not come through tailscale serve.")
            case "Tailscale login not permitted":
                self = .forbidden("This Tailscale login is not allowed here.")
            default:
                self = .forbidden(parsed.error)
            }
            return
        }
        self = .http(status, parsed.error, code: parsed.code)
    }
}
