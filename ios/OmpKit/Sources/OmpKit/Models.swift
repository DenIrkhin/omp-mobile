import Foundation

public enum Access: String, Codable, Sendable, Equatable {
    case view, control

    public init(from decoder: any Decoder) throws {
        self = Access(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .view
    }
}

public enum ReportOutcome: String, Codable, Sendable, Equatable {
    case ok, update, failed, unknown

    public init(from decoder: any Decoder) throws {
        self = ReportOutcome(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .unknown
    }
}

public struct ServerInfo: Codable, Sendable, Equatable {
    public struct Features: Codable, Sendable, Equatable {
        public let longTasks: Bool
        public let launch: Bool
        public let control: Bool
        public let devCycles: Bool
        public let reports: Bool
        public let push: Bool
        public let pageCopy: Bool
    }

    public let apiVersion: Int
    public let serverVersion: String
    public let ompVersion: String?
    public let login: String
    public let deviceName: String?
    public let mainProfile: String?
    public let features: Features
    public let push: PushInfo?
}

public struct PushInfo: Codable, Sendable, Equatable {
    public let bundleId: String
    public let environments: [String]
}

public struct HostsResponse: Codable, Sendable, Equatable {
    public let fetchedAt: Date
    public let hosts: [HostCard]
    public let longTasks: [LongTask]
    public let projects: [String]
    public let pageCopy: PageCopyState?
}

public struct HostCard: Codable, Sendable, Equatable {
    public let instanceId: String
    public let generation: Int
    public let sessionId: String
    public let sessionName: String?
    public let cwd: String
    public let folder: String
    public let project: String?
    public let model: String
    public let startedAt: Date
    public let participants: Int
    public let relayConnected: Bool
    public let inputRequired: Bool
    public let busy: Bool?
    public let access: Access
    public let pinned: Bool
    public let reports: [JobReport]
}

public struct LongTask: Codable, Sendable, Equatable {
    public let sessionId: String
    public let title: String?
    public let cwd: String
    public let folder: String
    public let project: String?
    public let profile: String?
    public let lastActiveAt: Date
    public let reports: [JobReport]
}

public struct JobReport: Codable, Sendable, Equatable {
    public let id: String
    public let job: String
    public let outcome: ReportOutcome
    public let summary: String
    public let details: String?
    public let at: Date
}

public struct PageCopyState: Codable, Sendable, Equatable {
    public let ok: Bool
    public let reason: String?
}

public struct LinkResponse: Codable, Sendable, Equatable {
    public let url: URL
}

public struct PinResponse: Codable, Sendable, Equatable {
    public let sessionId: String
    public let pinned: Bool
}

public struct LaunchOptions: Codable, Sendable, Equatable {
    public struct ModelOption: Codable, Sendable, Equatable {
        public let id: String
        public let label: String
    }

    public let folders: [String]
    public let models: [ModelOption]
    public let defaultModel: String
}

public struct LaunchResult: Codable, Sendable, Equatable {
    public let instanceId: String
    public let generation: Int
    public let access: Access
    public let workspace: String
}

public struct ErrorBody: Codable, Sendable, Equatable {
    public let error: String
    public let code: String?
}

public struct PushEvents: Codable, Sendable, Equatable {
    public let input: Bool
    public let reportFailed: Bool
    public let reportUpdate: Bool
    public let turnDone: Bool

    public init(input: Bool, reportFailed: Bool, reportUpdate: Bool, turnDone: Bool) {
        self.input = input
        self.reportFailed = reportFailed
        self.reportUpdate = reportUpdate
        self.turnDone = turnDone
    }
}

public struct DeviceRecord: Codable, Sendable, Equatable {
    public let token: String
    public let deviceName: String?
    public let events: PushEvents
    public let registeredAt: Date
    public let lastSeenAt: Date
}

public struct DeviceRemoveResponse: Codable, Sendable, Equatable {
    public let removed: Bool
}

public struct PushTestResponse: Codable, Sendable, Equatable {
    public let apnsId: String
}
