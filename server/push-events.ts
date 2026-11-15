// Push events (build plan §6.1, §6.2, §6.5): which chat changes and job reports call for a
// notification, and the notification each becomes. Pure: server.ts polls the chats, watches the
// reports folder, keeps push-state.json and sends; push-events.test.ts drives these with made-up polls.
import type { ApnsMessage } from "./push-apns";
import type { StoredReport } from "./reports";

/** No second input push for the same session within this time. */
export const INPUT_COOLDOWN_MS = 30_000;
/** turnDone: a pinned chat busy at least this long, then idle on TURN_IDLE_POLLS polls in a row... */
export const TURN_MIN_BUSY_MS = 120_000;
export const TURN_IDLE_POLLS = 2;
/** ...and no turnDone push for it within this time. */
export const TURN_DONE_COOLDOWN_MS = 10 * 60_000;
/** At a start, a report written while the server was down is pushed when it is at most this old. */
export const DOWNTIME_WINDOW_MS = 60 * 60_000;
/** Pushed report ids are kept this long. */
export const SEEN_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
/** A report push shows at most this many characters of the summary's first line. */
export const SUMMARY_MAX_CHARS = 180;

/** One live chat as the chats watcher sees it. title: its session name, else its folder. */
export type HostSnap = {
  instanceId: string;
  generation: number;
  sessionId: string;
  title: string;
  folder: string;
  inputRequired: boolean;
  busy: boolean | null;
  pinned: boolean;
};

type HostWatchEntry = {
  generation: number;
  sessionId: string;
  inputRequired: boolean;
  busySince: number | null;
  idlePolls: number;
  turnDoneAt: number | null;
};

/** What the chats watcher remembers from the poll before, per instanceId. */
export type HostWatch = Map<string, HostWatchEntry>;

/** kind is also the name of the device's switch for it (push-devices.ts PushEvents). */
export type PushEvent =
  | { kind: "input" | "turnDone"; sessionId: string; instanceId: string; generation: number; title: string; folder: string }
  | { kind: "reportFailed" | "reportUpdate"; sessionId: string; title: string | null; report: StoredReport };

/** One report file's tail: the session it belongs to, its title when known, and its reports in file order. */
export type ReportFile = { sessionId: string; title: string | null; reports: readonly StoredReport[] };

/**
 * The events between the poll before (`prev`, null on the first poll after a start) and `hosts`.
 * input: a chat needs input and did not on the poll before for the same instanceId and generation,
 * and its session got no input push within INPUT_COOLDOWN_MS (`lastInputPush`, which the caller
 * keeps). turnDone: a pinned chat busy for TURN_MIN_BUSY_MS or more is idle on TURN_IDLE_POLLS
 * polls in a row, at most once per TURN_DONE_COOLDOWN_MS. busy null changes nothing.
 */
export function detectHostEvents(
  prev: HostWatch | null,
  hosts: readonly HostSnap[],
  now: number,
  lastInputPush: ReadonlyMap<string, number>,
): { state: HostWatch; events: PushEvent[] } {
  const state: HostWatch = new Map();
  const events: PushEvent[] = [];
  for (const host of hosts) {
    const old = prev?.get(host.instanceId);
    // A new chat, or a new generation of one, starts fresh: it did not need input before.
    const entry: HostWatchEntry =
      old !== undefined && old.generation === host.generation
        ? { ...old }
        : { generation: host.generation, sessionId: host.sessionId, inputRequired: false, busySince: null, idlePolls: 0, turnDoneAt: null };
    const chat = { sessionId: host.sessionId, instanceId: host.instanceId, generation: host.generation, title: host.title, folder: host.folder };
    if (host.inputRequired && !entry.inputRequired) {
      const last = lastInputPush.get(host.sessionId);
      if (last === undefined || now - last >= INPUT_COOLDOWN_MS) events.push({ kind: "input", ...chat });
    }
    entry.inputRequired = host.inputRequired;
    entry.sessionId = host.sessionId;
    if (host.busy === true) {
      entry.busySince ??= now;
      entry.idlePolls = 0;
    } else if (host.busy === false && entry.busySince !== null) {
      entry.idlePolls += 1;
      if (entry.idlePolls === 1 && now - entry.busySince < TURN_MIN_BUSY_MS) {
        // A short turn: forget it.
        entry.busySince = null;
        entry.idlePolls = 0;
      } else if (entry.idlePolls >= TURN_IDLE_POLLS) {
        if (host.pinned && (entry.turnDoneAt === null || now - entry.turnDoneAt >= TURN_DONE_COOLDOWN_MS)) {
          events.push({ kind: "turnDone", ...chat });
          entry.turnDoneAt = now;
        }
        entry.busySince = null;
        entry.idlePolls = 0;
      }
    }
    state.set(host.instanceId, entry);
  }
  // The first poll after a start only learns the chats, so a restart never repeats a push.
  return { state, events: prev === null ? [] : events };
}

/**
 * The report events in `changed`: each failed or update report written at or after `watermark`
 * whose id is not in `seen`, once. `seen` (report id → report time) comes back with the new ids and
 * without ids older than the watermark, which can never be pushed again.
 */
export function detectReportEvents(
  changed: readonly ReportFile[],
  seen: ReadonlyMap<string, number>,
  watermark: number,
): { seen: Map<string, number>; events: PushEvent[] } {
  const next = new Map([...seen].filter(([, at]) => at >= watermark));
  const events: PushEvent[] = [];
  for (const { sessionId, title, reports } of changed) {
    for (const report of reports) {
      const at = Date.parse(report.at);
      if (at < watermark || next.has(report.id)) continue;
      next.set(report.id, at);
      if (report.outcome === "failed") events.push({ kind: "reportFailed", sessionId, title, report });
      if (report.outcome === "update") events.push({ kind: "reportUpdate", sessionId, title, report });
    }
  }
  return { seen: next, events };
}

/** Where the reports watcher starts at a start: max(savedAt, now − 1 h); from now without a state file. */
export function reportWatermark(savedAt: number | null, now: number): number {
  return savedAt === null ? now : Math.max(savedAt, now - DOWNTIME_WINDOW_MS);
}

/** <stateDir>/push-state.json: the pushed report ids with their report times, and when it was written. */
export type PushState = { savedAt: number | null; seen: Map<string, number> };

export function pushStateText(state: { savedAt: number; seen: ReadonlyMap<string, number> }): string {
  return `${JSON.stringify({ v: 1, savedAt: state.savedAt, seen: Object.fromEntries(state.seen) }, null, 2)}\n`;
}

/** The state in a push-state.json text; null when the text is not one. */
export function parsePushState(text: string): PushState | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { v, savedAt, seen } = parsed as { v?: unknown; savedAt?: unknown; seen?: unknown };
  if (v !== 1 || typeof savedAt !== "number" || !Number.isFinite(savedAt)) return null;
  if (typeof seen !== "object" || seen === null || Array.isArray(seen)) return null;
  const ids = new Map<string, number>();
  for (const [id, at] of Object.entries(seen)) {
    if (typeof at === "number" && Number.isFinite(at)) ids.set(id, at);
  }
  return { savedAt, seen: ids };
}

/** The first line of a summary, cut to SUMMARY_MAX_CHARS characters with "…" as the last; null when empty. */
function summaryLine(summary: string): string | null {
  const line = (summary.split("\n")[0] ?? "").trim();
  if (line === "") return null;
  const chars = Array.from(line);
  return chars.length <= SUMMARY_MAX_CHARS ? line : `${chars.slice(0, SUMMARY_MAX_CHARS - 1).join("")}…`;
}

/** The notification an event becomes (build plan §6.5); api/v1/fixtures/push-*.json hold one of each kind. */
export function apnsPayload(e: PushEvent, includeSummary: boolean): object {
  const aps = (alert: Record<string, string>) => ({ alert, sound: "default", "thread-id": e.sessionId });
  switch (e.kind) {
    case "input":
      return {
        aps: aps({ title: e.title, subtitle: "Needs input", body: e.folder }),
        omp: { v: 1, kind: "input", sessionId: e.sessionId, instanceId: e.instanceId, generation: e.generation },
      };
    case "turnDone":
      return {
        aps: aps({ title: `${e.title} finished` }),
        omp: { v: 1, kind: "turnDone", sessionId: e.sessionId, instanceId: e.instanceId, generation: e.generation },
      };
    default: {
      const { report } = e;
      const alert: Record<string, string> = { title: `${report.job} ${report.outcome}` };
      if (e.title !== null) alert.subtitle = e.title;
      const body = includeSummary ? summaryLine(report.summary) : null;
      if (body !== null) alert.body = body;
      return {
        aps: aps(alert),
        omp: { v: 1, kind: "report", sessionId: e.sessionId, reportId: report.id, job: report.job, outcome: report.outcome, at: report.at },
      };
    }
  }
}

/**
 * One device's message for an event: priority and expiry per build plan §6.1 and §6.3. An input push
 * replaces the session's older input banner (apns-collapse-id).
 */
export function apnsMessage(e: PushEvent, token: string, includeSummary: boolean): ApnsMessage {
  const payload = apnsPayload(e, includeSummary);
  switch (e.kind) {
    case "input":
      return { kind: "input", token, payload, priority: 10, ttlSeconds: 3600, collapseId: `input:${e.sessionId}` };
    case "turnDone":
      return { kind: "turnDone", token, payload, priority: 5, ttlSeconds: 3600 };
    case "reportFailed":
      return { kind: "report", token, payload, priority: 10, ttlSeconds: 86_400 };
    case "reportUpdate":
      return { kind: "report", token, payload, priority: 5, ttlSeconds: 86_400 };
  }
}
