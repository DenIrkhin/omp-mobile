import Foundation

enum OmpJSON {
    static let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let c = try decoder.singleValueContainer()
            if let ms = try? c.decode(Double.self) {
                return Date(timeIntervalSince1970: ms / 1000)
            }
            let s = try c.decode(String.self)
            if let date = try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(s) {
                return date
            }
            if let date = try? Date.ISO8601FormatStyle().parse(s) {
                return date
            }
            throw DecodingError.dataCorruptedError(
                in: c, debugDescription: "Expected milliseconds since 1970 or an ISO 8601 date, got \(s)")
        }
        return decoder
    }()

    static let encoder = JSONEncoder()

    static func reason(_ error: any Error) -> String {
        guard let error = error as? DecodingError else { return String(describing: error) }
        switch error {
        case .keyNotFound(let key, let ctx):
            return "missing " + dotted(ctx.codingPath + [key])
        case .valueNotFound(_, let ctx), .typeMismatch(_, let ctx), .dataCorrupted(let ctx):
            return ctx.codingPath.isEmpty
                ? ctx.debugDescription
                : dotted(ctx.codingPath) + ": " + ctx.debugDescription
        @unknown default:
            return String(describing: error)
        }
    }

    private static func dotted(_ path: [any CodingKey]) -> String {
        path.map { $0.intValue.map(String.init) ?? $0.stringValue }.joined(separator: ".")
    }
}
