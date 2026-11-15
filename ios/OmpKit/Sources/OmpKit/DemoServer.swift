import Foundation
import Synchronization

/// The demo's server, inside the app. It answers the routes the app calls with made-up data, so the
/// demo runs the app's own list, pin and error code with no Mac and no network. `session()` makes the
/// URLSession that sends every request here.
public final class DemoServer: Sendable {
    /// The demo's server address. `.invalid` is reserved and never resolves (RFC 2606).
    public static let baseURL = URL(string: "https://demo.invalid")!
    /// The scheme of the demo's chat links; the app serves them from a page in its bundle.
    public static let pageScheme = "omp-demo"
    /// The one server the demo's URLSession answers from: a URLProtocol gets no reference to its session.
    public static let shared = DemoServer()
    /// The error text of a route the demo does not offer.
    static let notOffered = "The demo does not offer this."

    private struct State {
        /// The sample's times count back from here.
        var reference: Date
        /// Live chats on Long tasks.
        var pinned: Set<String>
        /// Long tasks an unpin took off the list.
        var unlisted: Set<String>
    }

    private let state: Mutex<State>

    /// The server's own dates: milliseconds since 1970, as `OmpJSON.decoder` reads them.
    private static let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .millisecondsSince1970
        return encoder
    }()

    init() {
        state = Mutex(Self.fresh())
    }

    /// Back to the sample as it starts: the last demo's pins go.
    public func reset() {
        state.withLock { $0 = Self.fresh() }
    }

    /// A URLSession whose every request gets its answer from `shared`, on the device.
    public static func session() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [DemoURLProtocol.self]
        return URLSession(configuration: configuration)
    }

    /// One request's answer: the HTTP status and the JSON body.
    func respond(method: String, path: String, body: Data?, now: Date = .now) -> (status: Int, body: Data) {
        state.withLock { state in
            switch (method, path) {
            case ("GET", "/api/v1/info"):
                return Self.reply(200, DemoSamples.info)
            case ("GET", "/api/v1/hosts"):
                return Self.reply(200, Self.hosts(state, now: now))
            case ("POST", "/api/v1/link"):
                return Self.link(state, body)
            case ("POST", "/api/v1/pin"):
                return Self.pin(&state, body)
            default:
                return Self.reply(501, ErrorBody(error: Self.notOffered, code: "demo"))
            }
        }
    }

    private static func fresh() -> State {
        State(reference: .now, pinned: DemoSamples.pinnedAtStart, unlisted: [])
    }

    private static func hosts(_ state: State, now: Date) -> HostsResponse {
        HostsResponse(
            fetchedAt: now,
            hosts: DemoSamples.hosts(at: state.reference, pinned: state.pinned),
            longTasks: DemoSamples.longTasks(at: state.reference).filter { !state.unlisted.contains($0.sessionId) },
            projects: DemoSamples.projects,
            pageCopy: nil)
    }

    /// The bundled sample page for a live chat; Control only where the chat gives control.
    private static func link(_ state: State, _ body: Data?) -> (status: Int, body: Data) {
        guard let body, let request = try? OmpJSON.decoder.decode(LinkRequest.self, from: body) else {
            return reply(400, ErrorBody(error: "Bad request", code: nil))
        }
        let hosts = DemoSamples.hosts(at: state.reference, pinned: state.pinned)
        guard let host = hosts.first(where: { $0.instanceId == request.instanceId }) else {
            return reply(404, ErrorBody(error: "That chat has ended.", code: nil))
        }
        guard host.generation == request.generation else {
            return reply(409, ErrorBody(error: "This chat restarted.", code: nil))
        }
        var components = URLComponents()
        components.scheme = pageScheme
        components.host = "chat"
        components.path = "/" + host.instanceId
        let access = host.access == .control ? request.access : .view
        components.queryItems = [
            URLQueryItem(name: "access", value: access.rawValue),
            URLQueryItem(name: "folder", value: host.folder),
        ]
        guard let url = components.url else { return reply(500, ErrorBody(error: "Bad link", code: nil)) }
        return reply(200, LinkResponse(url: url))
    }

    /// Pin: a live chat moves to Long tasks. Unpin: a live chat goes back to Chats, a closed long task
    /// leaves the list.
    private static func pin(_ state: inout State, _ body: Data?) -> (status: Int, body: Data) {
        guard let body, let request = try? OmpJSON.decoder.decode(PinRequest.self, from: body) else {
            return reply(400, ErrorBody(error: "Bad request", code: nil))
        }
        let id = request.sessionId
        let live = Set(DemoSamples.hosts(at: state.reference, pinned: []).map(\.sessionId))
        let listed = Set(DemoSamples.longTasks(at: state.reference).map(\.sessionId)).subtracting(state.unlisted)
        guard live.contains(id) || listed.contains(id) else {
            return reply(404, ErrorBody(error: "That session is not in the list.", code: nil))
        }
        if request.pinned {
            if live.contains(id) { state.pinned.insert(id) }
        } else {
            state.pinned.remove(id)
            state.unlisted.insert(id)
        }
        return reply(200, PinResponse(sessionId: id, pinned: request.pinned))
    }

    private static func reply(_ status: Int, _ value: some Encodable) -> (status: Int, body: Data) {
        (status, (try? encoder.encode(value)) ?? Data())
    }
}

/// Hands each request of the demo's URLSession to `DemoServer.shared` and returns its answer.
final class DemoURLProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let url = request.url else {
            client?.urlProtocol(self, didFailWithError: URLError(.badURL))
            return
        }
        let answer = DemoServer.shared.respond(
            method: request.httpMethod ?? "GET", path: url.path(), body: Self.body(of: request))
        guard let response = HTTPURLResponse(
            url: url, statusCode: answer.status, httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"])
        else {
            client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
            return
        }
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: answer.body)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    /// URLSession hands a POST body to a URLProtocol as a stream, not as `httpBody`.
    private static func body(of request: URLRequest) -> Data? {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return nil }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            if count <= 0 { break }
            data.append(buffer, count: count)
        }
        return data
    }
}
