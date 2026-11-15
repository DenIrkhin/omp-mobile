import Foundation

enum Route: Sendable, Equatable {
    case info, hosts, link, pin, reopen, launchOptions, sessions, devices, devicesRemove, pushTest

    var path: String {
        switch self {
        case .info: "api/v1/info"
        case .hosts: "api/v1/hosts"
        case .link: "api/v1/link"
        case .pin: "api/v1/pin"
        case .reopen: "api/v1/long-tasks/reopen"
        case .launchOptions: "api/v1/launch-options"
        case .sessions: "api/v1/sessions"
        case .devices: "api/v1/devices"
        case .devicesRemove: "api/v1/devices/remove"
        case .pushTest: "api/v1/push/test"
        }
    }

    var timeout: TimeInterval {
        switch self {
        case .info: 8
        case .hosts, .link, .pin, .launchOptions, .devices, .devicesRemove: 10
        // The server waits up to 10 s for APNs and tries once more with a new token key.
        case .pushTest: 25
        case .sessions, .reopen: 45
        }
    }
}

public struct APIClient: Sendable {
    public let baseURL: URL
    let session: URLSession

    public init(baseURL: URL, session: URLSession) {
        self.baseURL = baseURL
        self.session = session
    }

    var host: String { baseURL.host() ?? baseURL.absoluteString }

    public func info() async throws -> ServerInfo {
        struct VersionProbe: Decodable { let apiVersion: Int }
        let data = try await get(.info)
        let probe = try decode(VersionProbe.self, data, route: .info)
        if probe.apiVersion != 1 { throw APIError.incompatible(probe.apiVersion) }
        return try decode(ServerInfo.self, data, route: .info)
    }

    public func hosts() async throws -> HostsResponse {
        try decode(HostsResponse.self, try await get(.hosts), route: .hosts)
    }

    public func link(instanceId: String, generation: Int, access: Access) async throws -> URL {
        let data = try await post(.link, LinkRequest(instanceId: instanceId, generation: generation, access: access))
        return try decode(LinkResponse.self, data, route: .link).url
    }

    public func pin(sessionId: String, pinned: Bool) async throws {
        let data = try await post(.pin, PinRequest(sessionId: sessionId, pinned: pinned))
        _ = try decode(PinResponse.self, data, route: .pin)
    }

    public func reopen(sessionId: String) async throws {
        let data = try await post(.reopen, ReopenRequest(sessionId: sessionId))
        _ = try decode(LaunchResult.self, data, route: .reopen)
    }

    public func launchOptions() async throws -> LaunchOptions {
        try decode(LaunchOptions.self, try await get(.launchOptions), route: .launchOptions)
    }

    public func startSession(folder: String, model: String, maxCost: Double?) async throws -> LaunchResult {
        let data = try await post(.sessions, SessionsRequest(folder: folder, model: model, maxCost: maxCost))
        return try decode(LaunchResult.self, data, route: .sessions)
    }

    public func registerDevice(_ registration: DeviceRegistration) async throws -> DeviceRecord {
        try decode(DeviceRecord.self, try await post(.devices, registration), route: .devices)
    }

    /// True when the server had the token and forgot it; false when it was not registered.
    public func removeDevice(token: String) async throws -> Bool {
        let data = try await post(.devicesRemove, DeviceTokenRequest(token: token))
        return try decode(DeviceRemoveResponse.self, data, route: .devicesRemove).removed
    }

    /// Sends one test notification to a registered device; returns the id APNs gave it.
    public func testPush(token: String) async throws -> String {
        let data = try await post(.pushTest, DeviceTokenRequest(token: token))
        return try decode(PushTestResponse.self, data, route: .pushTest).apnsId
    }

    private func get(_ route: Route) async throws -> Data {
        let request = URLRequest(url: baseURL.appending(path: route.path), timeoutInterval: route.timeout)
        return try await perform(request, route: route)
    }

    private func post(_ route: Route, _ body: some Encodable) async throws -> Data {
        var request = URLRequest(url: baseURL.appending(path: route.path), timeoutInterval: route.timeout)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try OmpJSON.encoder.encode(body)
        return try await perform(request, route: route)
    }

    private func perform(_ request: URLRequest, route: Route) async throws -> Data {
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch let error as URLError where error.code == .cancelled {
            throw CancellationError()
        } catch let error as URLError {
            throw APIError(error, host: host)
        }
        guard let http = response as? HTTPURLResponse else {
            throw APIError.decoding("\(route.path): not an HTTP reply")
        }
        guard (200..<300).contains(http.statusCode) else {
            throw APIError(status: http.statusCode, body: data, route: route)
        }
        return data
    }

    private func decode<T: Decodable>(_: T.Type, _ data: Data, route: Route) throws -> T {
        do {
            return try OmpJSON.decoder.decode(T.self, from: data)
        } catch {
            throw APIError.decoding("\(route.path): \(OmpJSON.reason(error))")
        }
    }
}
