import Foundation

public struct LinkRequest: Codable, Sendable, Equatable {
    public let instanceId: String
    public let generation: Int
    public let access: Access
}

public struct PinRequest: Codable, Sendable, Equatable {
    public let sessionId: String
    public let pinned: Bool
}

public struct ReopenRequest: Codable, Sendable, Equatable {
    public let sessionId: String
}

public struct SessionsRequest: Codable, Sendable, Equatable {
    public let folder: String
    public let model: String
    public let maxCost: Double?
}

public struct DeviceRegistration: Codable, Sendable, Equatable {
    public let token: String
    public let environment: String
    public let bundleId: String
    public let appVersion: String?
    public let events: PushEvents

    public init(token: String, environment: String, bundleId: String, appVersion: String?, events: PushEvents) {
        self.token = token
        self.environment = environment
        self.bundleId = bundleId
        self.appVersion = appVersion
        self.events = events
    }
}

/// The body of `POST /api/v1/devices/remove` and `POST /api/v1/push/test`.
public struct DeviceTokenRequest: Codable, Sendable, Equatable {
    public let token: String
}
