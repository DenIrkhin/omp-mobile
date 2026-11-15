// Job reports: a scheduled job (a launchd agent, or any script) posts its result to a
// long-task omp chat with report.ts. Each chat has its own append-only JSON Lines file,
//
//   <omp config root>/omp-sessions/reports/<session id>.jsonl   (dir 0700, file 0600)
//
// one report per line. The dashboard server reads it for the phone's Long tasks cards, and
// the chat's control extension (extension/omp-sessions-control.ts) posts new reports into
// the chat. The extension imports this module into omp's process, so it has no side
// effects at import and uses Node's APIs only.
import { appendFile, chmod, mkdir, open } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { isMissing } from "./agent-dirs";
import { SESSION_ID } from "./long-tasks";

/** Job names: a letter or digit, then up to 63 letters, digits, dots, underscores or dashes. */
export const JOB_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export const MAX_SUMMARY_CHARS = 4000;
export const MAX_DETAILS_CHARS = 1024;

/** Bytes read from the end of a report file. One line is at most about 18 KB (4,000 four-byte characters). */
export const REPORT_TAIL_BYTES = 128 * 1024;

/** Latest reports per long-task card, one per job. */
export const CARD_REPORTS = 3;

/** The extension posts reports at most this old into a chat... */
export const DELIVERY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** ...and at most this many in one pass, the newest ones. */
export const MAX_DELIVERIES_PER_PASS = 5;
/**
 * A report written with `wake` starts a turn when it is posted, so the chat goes on with the work that waited
 * for the job (a watcher's result, say). Only this soon after it was written: one posted when a chat is
 * resumed hours later comes in without a turn.
 */
export const WAKE_WINDOW_MS = 60 * 60 * 1000;

/** The customType of the session entry a report becomes when the extension posts it; its `details.id` is the report id. */
export const REPORT_MESSAGE_TYPE = "omp-sessions-report";

/**
 * ok: the job ran and all is well (green). update: the job ran and has news for the user, such as
 * a digest or a limit running low (blue). failed: the job itself broke (red, with a banner).
 */
export const REPORT_OUTCOMES = ["ok", "update", "failed"] as const;
export type ReportOutcome = (typeof REPORT_OUTCOMES)[number];

function isOutcome(value: unknown): value is ReportOutcome {
  return REPORT_OUTCOMES.some(outcome => outcome === value);
}

/** The latest report of one job, as GET /api/v1/hosts sends it. `id` is the report's own random UUID. */
export type JobReport = {
  id: string;
  job: string;
  outcome: ReportOutcome;
  summary: string;
  details: string | null;
  at: string;
};

/** One line of a report file. `wake`: posting it starts a turn (WAKE_WINDOW_MS). */
export type StoredReport = JobReport & { v: 1; wake?: true };

/** A report as report.ts received it, before it gets an id and a time. */
export type ReportRequest = Omit<JobReport, "id" | "at"> & { sessionId: string; wake?: true };

// C0 and C1 control characters except tab and newline.
const CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
const ANY_CONTROL_CHAR = /[\u0000-\u001f\u007f-\u009f]/;
// What `Date.prototype.toISOString` writes.
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

export function reportsDir(configRoot: string): string {
  return join(configRoot, "omp-sessions", "reports");
}

/** The report file of one chat. Throws on anything but an omp session id, so no other path can come out. */
export function reportFile(configRoot: string, sessionId: string): string {
  if (!SESSION_ID.test(sessionId)) {
    throw new Error(`Not an omp session id: ${JSON.stringify(sessionId)}`);
  }
  return join(reportsDir(configRoot), `${sessionId}.jsonl`);
}

/**
 * Makes a summary safe to show anywhere: control characters other than newline and tab
 * become spaces (CRLF counts as a newline), the ends are trimmed, and text longer than
 * MAX_SUMMARY_CHARS characters is cut to that length, its last character replaced by "…".
 */
export function sanitizeSummary(text: string): string {
  const clean = text.replaceAll("\r\n", "\n").replace(CONTROL_CHARS, " ").trim();
  // Count code points, not UTF-16 units, so the cut never splits an emoji.
  let count = 0;
  let keepEnd = 0;
  let end = 0;
  for (const char of clean) {
    count++;
    if (count === MAX_SUMMARY_CHARS) keepEnd = end;
    if (count > MAX_SUMMARY_CHARS) return `${clean.slice(0, keepEnd)}…`;
    end += char.length;
  }
  return clean;
}

/** Why `details` is not a usable details path, or null when it is. */
function detailsError(details: string): string | null {
  if (!isAbsolute(details)) return "details must be an absolute path";
  if (details.length > MAX_DETAILS_CHARS) return `details must be at most ${MAX_DETAILS_CHARS} characters`;
  // The path is shown on a line of its own in the chat.
  if (ANY_CONTROL_CHAR.test(details)) return "details must not contain control characters";
  return null;
}

/** Validates a report before it is written. The summary comes back sanitized. */
export function validateReport(fields: {
  sessionId: string;
  job: string;
  outcome: string;
  summary: string;
  details: string | null;
  wake?: boolean;
}): { report?: ReportRequest; error?: string } {
  const { sessionId, job, outcome, details } = fields;
  if (!SESSION_ID.test(sessionId)) {
    return { error: "session must be an omp session id (a lowercase UUID)" };
  }
  if (!JOB_NAME.test(job)) {
    return { error: "job must start with a letter or digit and use only letters, digits, '.', '_' and '-' (64 at most)" };
  }
  if (!isOutcome(outcome)) {
    return { error: `outcome must be ${REPORT_OUTCOMES.join(", ")}` };
  }
  const summary = sanitizeSummary(fields.summary);
  if (!summary) {
    return { error: "summary is empty" };
  }
  const badDetails = details === null ? null : detailsError(details);
  if (badDetails) {
    return { error: badDetails };
  }
  return { report: { sessionId, job, outcome, summary, details, ...(fields.wake ? { wake: true as const } : {}) } };
}

/**
 * Appends one report to its chat's file, creating the folder (0700) and the file (0600)
 * when missing. One write call per line: appends from parallel jobs do not interleave.
 * Returns the file.
 */
export async function appendReport(configRoot: string, sessionId: string, report: StoredReport): Promise<string> {
  const file = reportFile(configRoot, sessionId);
  const dir = reportsDir(configRoot);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  await appendFile(file, `${JSON.stringify(report)}\n`, { encoding: "utf8", mode: 0o600 });
  return file;
}

/** One report file line, or null for anything that is not a valid report. */
export function parseReportLine(line: string): StoredReport | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const { v, id, job, outcome, summary, details, at, wake } = value as Record<string, unknown>;
  if (
    v !== 1 ||
    // Report ids are random lowercase UUIDs, the same shape as session ids.
    typeof id !== "string" ||
    !SESSION_ID.test(id) ||
    typeof job !== "string" ||
    !JOB_NAME.test(job) ||
    !isOutcome(outcome) ||
    typeof summary !== "string" ||
    (details !== null && (typeof details !== "string" || detailsError(details) !== null)) ||
    typeof at !== "string" ||
    !ISO_UTC.test(at) ||
    !Number.isFinite(Date.parse(at))
  ) {
    return null;
  }
  // The file is the user's own, but a hand edit must not put control characters on the page or in a chat.
  const clean = sanitizeSummary(summary);
  if (!clean) return null;
  return { v, id, job, outcome, summary: clean, details, at, ...(wake === true ? { wake: true as const } : {}) };
}

/** The valid reports in a file's text, in file order. Malformed lines are skipped. */
export function parseReports(text: string): StoredReport[] {
  const reports: StoredReport[] = [];
  for (const line of text.split("\n")) {
    const report = line.trim() ? parseReportLine(line) : null;
    if (report) reports.push(report);
  }
  return reports;
}

/**
 * The reports in the last `maxBytes` of a file, in file order; [] when the file does not
 * exist. A line cut by the start of the window is skipped.
 */
export async function readReportsTail(file: string, maxBytes = REPORT_TAIL_BYTES): Promise<StoredReport[]> {
  let handle;
  try {
    handle = await open(file, "r");
  } catch (err) {
    if (isMissing(err)) return [];
    throw err;
  }
  try {
    const { size } = await handle.stat();
    // One byte more than the window: if it is the newline before the window, the first line is whole.
    const start = Math.max(0, size - maxBytes - 1);
    const buffer = Buffer.alloc(size - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    return parseReports(start === 0 ? text : text.slice(text.indexOf("\n") + 1));
  } finally {
    await handle.close();
  }
}

/** The newest report of each job, newest first. Equal times: the later line wins. */
export function newestPerJob(reports: readonly StoredReport[]): StoredReport[] {
  const newest = new Map<string, { report: StoredReport; time: number }>();
  for (const report of reports) {
    const time = Date.parse(report.at);
    const seen = newest.get(report.job);
    if (!seen || time >= seen.time) newest.set(report.job, { report, time });
  }
  return [...newest.values()].sort((a, b) => b.time - a.time).map(({ report }) => report);
}

/** The newest report of each job, newest first, at most `limit`. Equal times: the later line wins. */
export function latestPerJob(reports: readonly StoredReport[], limit: number): JobReport[] {
  return newestPerJob(reports)
    .slice(0, limit)
    .map(({ id, job, outcome, summary, details, at }) => ({ id, job, outcome, summary, details, at }));
}

/** The report id of a session entry the extension posted a report as, or null for any other entry. */
export function reportEntryId(entry: unknown): string | null {
  if (typeof entry !== "object" || entry === null) return null;
  const { type, customType, details } = entry as Record<string, unknown>;
  if (type !== "custom_message" || customType !== REPORT_MESSAGE_TYPE) return null;
  if (typeof details !== "object" || details === null) return null;
  const { id } = details as Record<string, unknown>;
  return typeof id === "string" ? id : null;
}

/**
 * The ids of the failed reports this chat has addressed, so their red pills can go. `entries` are
 * the chat's session entries in order: omp's SessionEntry objects, or transcript lines parsed as
 * JSON. They may be only a window, the tail of the transcript.
 *
 * An answer is a user message (the owner wrote), or an assistant message that ended with
 * stopReason "stop" (the chat finished a turn). Tool calls alone are not one. A failed report is
 * addressed when:
 *
 * 1. its report entry is in `entries` and an answer comes after it;
 * 2. or its entry is not there, but a report later in the file has an entry there, and an answer
 *    comes after that entry. Reports are posted in file order and an older one is never posted
 *    after a newer one (reportsToDeliver), so this one was posted before the window began, or was
 *    passed over for good;
 * 3. or neither, but the report was written before the first timestamped entry, and `entries`
 *    hold a user message. The report then belongs to text before the window (cut off, or an
 *    earlier transcript the chat was handed over from), and the owner has written since.
 *
 * Anything else stays: a report not posted yet (the chat was busy) keeps its pill. Ok and update
 * reports are never in the result.
 */
export function addressedFailures(reports: readonly StoredReport[], entries: readonly unknown[]): Set<string> {
  const posted = new Map<string, number>();
  let lastAnswer = -1;
  let userMessage = false;
  let windowStart = Number.NaN;
  for (const [i, entry] of entries.entries()) {
    if (typeof entry !== "object" || entry === null) continue;
    const { type, timestamp, message } = entry as Record<string, unknown>;
    if (Number.isNaN(windowStart) && typeof timestamp === "string") windowStart = Date.parse(timestamp);
    const id = reportEntryId(entry);
    if (id !== null) {
      if (!posted.has(id)) posted.set(id, i);
      continue;
    }
    if (type !== "message" || typeof message !== "object" || message === null) continue;
    const { role, stopReason } = message as Record<string, unknown>;
    if (role === "user") {
      lastAnswer = i;
      userMessage = true;
    } else if (role === "assistant" && stopReason === "stop") {
      lastAnswer = i;
    }
  }
  const addressed = new Set<string>();
  // The earliest entry of a report later in the file than the one at hand.
  let laterPosted = Number.POSITIVE_INFINITY;
  for (let i = reports.length - 1; i >= 0; i--) {
    const report = reports[i];
    const at = posted.get(report.id);
    if (report.outcome === "failed") {
      const answered =
        at !== undefined
          ? lastAnswer > at
          : laterPosted !== Number.POSITIVE_INFINITY
            ? lastAnswer > laterPosted
            : Date.parse(report.at) < windowStart && userMessage;
      if (answered) addressed.add(report.id);
    }
    if (at !== undefined) laterPosted = Math.min(laterPosted, at);
  }
  return addressed;
}

/**
 * The reports to post into a chat now, oldest first. Candidates come after the last report
 * the chat already has (in file order, so the chat stays in the order the reports came
 * in), are not in it, and are at most DELIVERY_WINDOW_MS old. Of those, the newest
 * MAX_DELIVERIES_PER_PASS are posted; `skipped` counts the older ones left out, which no
 * later pass posts either.
 */
export function reportsToDeliver(
  reports: readonly StoredReport[],
  delivered: ReadonlySet<string>,
  now: number,
): { deliver: StoredReport[]; skipped: number } {
  let start = 0;
  for (let i = reports.length - 1; i >= 0; i--) {
    if (delivered.has(reports[i].id)) {
      start = i + 1;
      break;
    }
  }
  const pending = reports
    .slice(start)
    .filter((report) => !delivered.has(report.id) && Date.parse(report.at) >= now - DELIVERY_WINDOW_MS);
  return {
    deliver: pending.slice(-MAX_DELIVERIES_PER_PASS),
    skipped: Math.max(0, pending.length - MAX_DELIVERIES_PER_PASS),
  };
}

/** Whether posting `deliver` starts a turn: one of them asks for it and was written within WAKE_WINDOW_MS. */
export function wakeTurn(deliver: readonly StoredReport[], now: number): boolean {
  return deliver.some((report) => report.wake === true && Date.parse(report.at) >= now - WAKE_WINDOW_MS);
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The message a report becomes in its chat. Times are local. */
export function reportMessage(report: Omit<JobReport, "id"> & { wake?: true }): string {
  const at = new Date(report.at);
  const when = `${at.getFullYear()}-${pad2(at.getMonth() + 1)}-${pad2(at.getDate())} ${pad2(at.getHours())}:${pad2(at.getMinutes())}`;
  const lines = [`Job report: ${report.job} ${report.outcome === "failed" ? "FAILED" : report.outcome} at ${when}`, report.summary];
  if (report.details) lines.push(`Details: ${report.details}`);
  if (report.wake) lines.push("This is the result this chat waited for: go on with the work that waited on it.");
  lines.push("Posted by a scheduled job through the omp-sessions reporter, not typed by the user.");
  return lines.join("\n");
}

/** Text of a job's cmux status pill: "backup ok · 03:04", or "backup failed · Oct 18 03:04" before today. */
export function pillText(report: Omit<JobReport, "id">, now: Date): string {
  const at = new Date(report.at);
  const time = `${pad2(at.getHours())}:${pad2(at.getMinutes())}`;
  const today =
    at.getFullYear() === now.getFullYear() && at.getMonth() === now.getMonth() && at.getDate() === now.getDate();
  return `${report.job} ${report.outcome} · ${today ? time : `${MONTHS[at.getMonth()]} ${at.getDate()} ${time}`}`;
}
