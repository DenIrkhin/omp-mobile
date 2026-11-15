import Foundation

/// The demo's made-up list: six live chats and three closed long tasks in three projects, with job
/// reports. Times count back from `reference`, so the cards read "12m ago" when the demo starts.
enum DemoSamples {
    static let projects = ["website", "mobile-app", "infra"]

    static let info = ServerInfo(
        apiVersion: 1, serverVersion: "demo", ompVersion: nil, login: "demo", deviceName: "Demo Mac",
        mainProfile: nil,
        features: ServerInfo.Features(
            longTasks: true, launch: false, control: false, devCycles: false, reports: true, push: false,
            pageCopy: false),
        push: nil)

    private static let nightlyOps = "5d5a6e54-2f7c-4b6e-9a55-4e5f6a7b8c05"
    private static let releasePrep = "8e6b7f45-1a8d-4c7f-8b66-5f6a7b8c9d06"

    /// The two live chats that start on Long tasks.
    static let pinnedAtStart: Set<String> = [nightlyOps, releasePrep]

    static func hosts(at reference: Date, pinned: Set<String>) -> [HostCard] {
        func host(
            _ instanceId: String, _ sessionId: String, name: String?, cwd: String, project: String,
            model: String, minutesAgo: Double, participants: Int = 1, input: Bool = false, busy: Bool,
            access: Access = .control, reports: [JobReport] = []
        ) -> HostCard {
            HostCard(
                instanceId: instanceId, generation: 1, sessionId: sessionId, sessionName: name, cwd: cwd,
                folder: String(cwd.split(separator: "/").last ?? ""), project: project, model: model,
                startedAt: reference.addingTimeInterval(-minutesAgo * 60), participants: participants,
                relayConnected: true, inputRequired: input, busy: busy, access: access,
                pinned: pinned.contains(sessionId), reports: reports)
        }
        return [
            host("demo-1", "4f1c2a90-6b3e-4d2a-9c11-0a1b2c3d4e01", name: "pricing-footer", cwd: "~/code/website",
                 project: "website", model: "anthropic/claude-sonnet-4-5", minutesAgo: 12, busy: true),
            host("demo-2", "7a2d3b81-5c4f-4e3b-8d22-1b2c3d4e5f02", name: "checkout-tests", cwd: "~/code/mobile-app",
                 project: "mobile-app", model: "openai/gpt-5", minutesAgo: 38, input: true, busy: false),
            host("demo-3", "2b3e4c72-4d5a-4f4c-9e33-2c3d4e5f6a03", name: nil, cwd: "~/code/website/blog",
                 project: "website", model: "anthropic/claude-haiku-4-5", minutesAgo: 120, participants: 2,
                 busy: false),
            host("demo-4", "9c4f5d63-3e6b-4a5d-8f44-3d4e5f6a7b04", name: "dns-cleanup", cwd: "~/code/infra/terraform",
                 project: "infra", model: "openai/gpt-5", minutesAgo: 300, busy: false, access: .view),
            host("demo-5", nightlyOps, name: "nightly-ops", cwd: "~/code/infra",
                 project: "infra", model: "anthropic/claude-sonnet-4-5", minutesAgo: 1200, busy: false,
                 reports: [report(1, "nightly-backup", .ok, "Backup finished: 3 databases, 2.1 GB", hoursAgo: 6, reference)]),
            host("demo-6", releasePrep, name: "release-1-4", cwd: "~/code/mobile-app/release",
                 project: "mobile-app", model: "openai/gpt-5", minutesAgo: 180, busy: true,
                 reports: [report(2, "beta-build", .update, "Build 1.4.0 (212) uploaded and waiting for testers", hoursAgo: 0.67, reference)]),
        ]
    }

    /// The long-task records: the two pinned live chats' first, then three whose chats are closed.
    static func longTasks(at reference: Date) -> [LongTask] {
        func task(
            _ sessionId: String, _ title: String, cwd: String, project: String, hoursAgo: Double,
            reports: [JobReport] = []
        ) -> LongTask {
            LongTask(
                sessionId: sessionId, title: title, cwd: cwd, folder: String(cwd.split(separator: "/").last ?? ""),
                project: project, profile: nil, lastActiveAt: reference.addingTimeInterval(-hoursAgo * 3600),
                reports: reports)
        }
        return [
            task(nightlyOps, "Nightly backups", cwd: "~/code/infra", project: "infra", hoursAgo: 0.05),
            task(releasePrep, "Release 1.4 prep", cwd: "~/code/mobile-app/release", project: "mobile-app", hoursAgo: 0.02),
            task("3f7c8a36-0b9e-4d8a-9c77-6a7b8c9d0e07", "Image CDN move", cwd: "~/code/website", project: "website",
                 hoursAgo: 26, reports: [
                    report(3, "link-check", .ok, "No broken links: 1,204 pages checked", hoursAgo: 27, reference),
                    report(4, "deploy-preview", .failed, "Preview build failed: the CDN_URL setting is missing", hoursAgo: 26, reference),
                 ]),
            task("6a8d9b27-9cae-4e9b-8d88-7b8c9d0e1f08", "Crash digest", cwd: "~/code/mobile-app", project: "mobile-app",
                 hoursAgo: 5, reports: [
                    report(5, "crash-digest", .update, "4 new crashes since yesterday, all on the settings screen", hoursAgo: 5, reference),
                 ]),
            task("1b9eac18-8dbf-4fac-9e99-8c9d0e1f2a09", "Database upgrade dry run", cwd: "~/code/infra/db", project: "infra",
                 hoursAgo: 48, reports: [
                    report(6, "db-upgrade", .ok, "Dry run passed in 14 minutes", hoursAgo: 48, reference),
                 ]),
        ]
    }

    private static func report(
        _ n: Int, _ job: String, _ outcome: ReportOutcome, _ summary: String, hoursAgo: Double, _ reference: Date
    ) -> JobReport {
        JobReport(
            id: "demo-report-\(n)", job: job, outcome: outcome, summary: summary, details: nil,
            at: reference.addingTimeInterval(-hoursAgo * 3600))
    }
}
