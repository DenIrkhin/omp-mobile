// The push rules a user notices: one push when a chat starts to need input, none after a restart,
// each job report once, a finished long turn of a pinned chat, and what a report push shows.
import { describe, expect, it } from "bun:test";
import {
  apnsPayload,
  detectHostEvents,
  detectReportEvents,
  type HostSnap,
  type HostWatch,
  parsePushState,
  type PushEvent,
  pushStateText,
  reportWatermark,
} from "./push-events";
import type { StoredReport } from "./reports";

const T0 = Date.parse("2026-11-14T08:00:00.000Z");
const ALPHA = "0194f3a2-1c2d-7e3f-8a4b-5c6d7e8f9a01";
const NIGHTLY = "0194f3a2-1c2d-7e3f-8a4b-5c6d7e8f9a03";

function host(over: Partial<HostSnap> = {}): HostSnap {
  return {
    instanceId: "inst-alpha",
    generation: 3,
    sessionId: ALPHA,
    title: "release notes",
    folder: "751orion-web",
    inputRequired: false,
    busy: false,
    pinned: false,
    ...over,
  };
}

/** Runs the polls `stepMs` apart from T0 and records each input push the way server.ts does. */
function polls(snaps: HostSnap[][], stepMs: number): { events: PushEvent[]; state: HostWatch | null } {
  const lastInputPush = new Map<string, number>();
  let state: HostWatch | null = null;
  const events: PushEvent[] = [];
  snaps.forEach((hosts, i) => {
    const now = T0 + i * stepMs;
    const result = detectHostEvents(state, hosts, now, lastInputPush);
    state = result.state;
    for (const event of result.events) if (event.kind === "input") lastInputPush.set(event.sessionId, now);
    events.push(...result.events);
  });
  return { events, state };
}

function report(over: Partial<StoredReport> = {}): StoredReport {
  return {
    v: 1,
    id: "0194f3a2-1c2d-7e3f-8a4b-5c6d7e8f9b01",
    job: "backup",
    outcome: "failed",
    summary: "Disk full",
    details: null,
    at: new Date(T0).toISOString(),
    ...over,
  };
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

describe("detectHostEvents", () => {
  it("sends nothing on the first poll after a start, even for a chat that already needs input", () => {
    const first = detectHostEvents(null, [host({ inputRequired: true })], T0, new Map());
    expect(first.events).toEqual([]);
    expect(detectHostEvents(first.state, [host({ inputRequired: true })], T0 + 5_000, new Map()).events).toEqual([]);
  });

  it("sends input once when a chat starts to need input", () => {
    const { events } = polls([[host()], [host({ inputRequired: true })]], 5_000);
    expect(events).toEqual([
      { kind: "input", sessionId: ALPHA, instanceId: "inst-alpha", generation: 3, title: "release notes", folder: "751orion-web" },
    ]);
  });

  it("sends nothing more while the same generation keeps needing input", () => {
    const asking = host({ inputRequired: true });
    const { events } = polls([[host()], [asking], [asking], [asking]], 60_000);
    expect(events.length).toBe(1);
  });

  it("sends input for a new generation of a chat, and for a new chat that already needs input", () => {
    const nextGeneration = host({ generation: 4, sessionId: "0194f3a2-1c2d-7e3f-8a4b-5c6d7e8f9a04", inputRequired: true });
    const newChat = host({ instanceId: "inst-bravo", sessionId: "0194f3a2-1c2d-7e3f-8a4b-5c6d7e8f9a02", inputRequired: true });
    const { events } = polls([[host({ inputRequired: true })], [nextGeneration, newChat]], 60_000);
    expect(events.map((e) => [e.kind, e.sessionId])).toEqual([
      ["input", "0194f3a2-1c2d-7e3f-8a4b-5c6d7e8f9a04"],
      ["input", "0194f3a2-1c2d-7e3f-8a4b-5c6d7e8f9a02"],
    ]);
  });

  it("sends no second input push for the same session within 30 seconds", () => {
    const asking = host({ inputRequired: true });
    // Polls 10 s apart: pushed at 10 s; at 30 s only 20 s later, held back; at 50 s, 40 s later, pushed.
    const { events } = polls([[host()], [asking], [host()], [asking], [host()], [asking]], 10_000);
    expect(events.map((e) => e.kind)).toEqual(["input", "input"]);
  });

  it("forgets a chat that vanished and counts it as new when it comes back", () => {
    const { events, state } = polls([[host()], [], [host({ inputRequired: true })]], 60_000);
    expect(events.map((e) => e.kind)).toEqual(["input"]);
    const gone = detectHostEvents(state, [], T0 + 300_000, new Map());
    expect([gone.events, gone.state.size]).toEqual([[], 0]);
  });

  it("sends turnDone when a pinned chat that worked 2 minutes or more is idle on two polls, at most once in 10 minutes", () => {
    const busy = host({ pinned: true, busy: true });
    const idle = host({ pinned: true, busy: false });
    const turn = [busy, busy, busy, idle, idle];
    // Polls 60 s apart: the turns end at 300 s, 600 s and 900 s; the one at 600 s is within 10 minutes of the first.
    const { events } = polls([[idle], ...[...turn, ...turn, ...turn].map((h) => [h])], 60_000);
    expect(events.map((e) => [e.kind, e.title])).toEqual([
      ["turnDone", "release notes"],
      ["turnDone", "release notes"],
    ]);
  });

  it("sends no turnDone for a turn under 2 minutes or for a chat that is not pinned", () => {
    const short = polls([[host()], [host({ pinned: true, busy: true })], [host({ pinned: true })], [host({ pinned: true })]], 60_000);
    const unpinned = polls([[host()], ...[true, true, true, false, false].map((busy) => [host({ busy })])], 60_000);
    expect([short.events, unpinned.events]).toEqual([[], []]);
  });
});

describe("detectReportEvents and reportWatermark", () => {
  it("pushes a failed or update report written after the watermark once, and never an ok report", () => {
    const reports = [
      report({ id: "0194f3a2-1c2d-7e3f-8a4b-5c6d7e8f9b01", outcome: "failed", at: iso(T0 + 1_000) }),
      report({ id: "0194f3a2-1c2d-7e3f-8a4b-5c6d7e8f9b02", job: "digest", outcome: "update", at: iso(T0 + 2_000) }),
      report({ id: "0194f3a2-1c2d-7e3f-8a4b-5c6d7e8f9b03", outcome: "ok", at: iso(T0 + 3_000) }),
    ];
    const files = [{ sessionId: NIGHTLY, title: "nightly build", reports }];
    const first = detectReportEvents(files, new Map(), T0);
    expect(first.events.map((e) => e.kind)).toEqual(["reportFailed", "reportUpdate"]);
    expect(detectReportEvents(files, first.seen, T0).events).toEqual([]);
  });

  it("pushes nothing again after a restart that reads the state file back", () => {
    const files = [{ sessionId: NIGHTLY, title: null, reports: [report({ at: iso(T0) })] }];
    const before = detectReportEvents(files, new Map(), T0 - 60_000);
    expect(before.events.length).toBe(1);
    // Saved in the same millisecond as the report; restarted 10 minutes later.
    const saved = parsePushState(pushStateText({ savedAt: T0, seen: before.seen }));
    if (saved === null) throw new Error("the state text did not parse");
    const watermark = reportWatermark(saved.savedAt, T0 + 600_000);
    expect(watermark).toBe(T0);
    expect(detectReportEvents(files, saved.seen, watermark).events).toEqual([]);
  });

  it("at a start, skips a report more than an hour old and pushes one written while the server was down", () => {
    const now = T0 + 3 * 3_600_000;
    const files = [
      {
        sessionId: NIGHTLY,
        title: null,
        reports: [
          report({ id: "0194f3a2-1c2d-7e3f-8a4b-5c6d7e8f9b01", at: iso(now - 2 * 3_600_000) }),
          report({ id: "0194f3a2-1c2d-7e3f-8a4b-5c6d7e8f9b02", at: iso(now - 30 * 60_000) }),
        ],
      },
    ];
    // State saved 3 hours ago: the watermark is an hour ago.
    const events = detectReportEvents(files, new Map(), reportWatermark(T0, now)).events;
    expect(events.map((e) => (e.kind === "reportFailed" ? e.report.id : null))).toEqual(["0194f3a2-1c2d-7e3f-8a4b-5c6d7e8f9b02"]);
    // No state file, or one that does not parse: only reports from now on.
    expect(parsePushState("{")).toBeNull();
    expect(detectReportEvents(files, new Map(), reportWatermark(null, now)).events).toEqual([]);
  });
});

describe("apnsPayload", () => {
  it("names the job and the chat, and shows the summary's first line cut to 180 characters only with includeSummary", () => {
    const e: PushEvent = {
      kind: "reportUpdate",
      sessionId: NIGHTLY,
      title: "nightly build",
      report: report({ job: "digest", outcome: "update", summary: `${"x".repeat(200)}\nsecond line` }),
    };
    expect((apnsPayload(e, true) as { aps: { alert: object } }).aps.alert).toEqual({
      title: "digest update",
      subtitle: "nightly build",
      body: `${"x".repeat(179)}…`,
    });
    expect((apnsPayload(e, false) as { aps: { alert: object } }).aps.alert).toEqual({ title: "digest update", subtitle: "nightly build" });
  });
});
