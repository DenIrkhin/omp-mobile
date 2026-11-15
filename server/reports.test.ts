import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addressedFailures,
  DELIVERY_WINDOW_MS,
  newestPerJob,
  parseReportLine,
  latestPerJob,
  parseReports,
  pillText,
  readReportsTail,
  REPORT_MESSAGE_TYPE,
  reportMessage,
  reportsToDeliver,
  sanitizeSummary,
  type StoredReport,
  validateReport,
  WAKE_WINDOW_MS,
  wakeTurn,
} from "./reports";

const SESSION = "01a13694-3e14-7026-a2da-8aae16651d32";
const VALID = { sessionId: SESSION, job: "backup", outcome: "ok", summary: "done", details: null };

let seq = 0;
function report(fields: Partial<StoredReport> = {}): StoredReport {
  seq++;
  return {
    v: 1,
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    job: "backup",
    outcome: "ok",
    summary: "done",
    details: null,
    at: "2026-10-19T03:00:00.000Z",
    ...fields,
  };
}

function lines(...items: (StoredReport | string)[]): string {
  return items.map((item) => (typeof item === "string" ? item : JSON.stringify(item))).join("\n") + "\n";
}

describe("sanitizeSummary", () => {
  it("turns control characters other than newline and tab into spaces and trims the ends", () => {
    expect(sanitizeSummary("  \u001b[31mred\u0007\r\nnext\tcol\u0085end \n")).toBe("[31mred \nnext\tcol end");
  });

  it("keeps 4,000 characters and cuts longer text to 4,000 ending in …", () => {
    expect(sanitizeSummary("a".repeat(4000))).toBe("a".repeat(4000));
    const cut = sanitizeSummary("a".repeat(4001));
    expect(cut.length).toBe(4000);
    expect(cut.endsWith("a…")).toBe(true);
  });

  it("counts an emoji as one character and never splits it", () => {
    const cut = sanitizeSummary("😀".repeat(4001));
    expect(Array.from(cut).length).toBe(4000);
    expect(cut.endsWith("😀…")).toBe(true);
  });
});

describe("validateReport", () => {
  it("accepts a valid report and returns the summary sanitized", () => {
    expect(validateReport({ ...VALID, summary: " ok\u0000 " }).report).toEqual({
      sessionId: SESSION,
      job: "backup",
      outcome: "ok",
      summary: "ok",
      details: null,
    });
  });

  it("allows job names of 1 to 64 letters, digits, dots, underscores and dashes, starting with a letter or digit", () => {
    for (const job of ["a", "7", "db.backup_v2-nightly", `a${"b".repeat(63)}`]) {
      expect(validateReport({ ...VALID, job }).error).toBeUndefined();
    }
    for (const job of ["", "-x", ".x", "_x", "a b", "a/b", "../x", "é", `a${"b".repeat(64)}`]) {
      expect(validateReport({ ...VALID, job }).error).toContain("job");
    }
  });

  it("allows an absolute details path of at most 1,024 characters without control characters", () => {
    expect(validateReport({ ...VALID, details: `/${"d".repeat(1023)}` }).error).toBeUndefined();
    expect(validateReport({ ...VALID, details: `/${"d".repeat(1024)}` }).error).toContain("1024");
    expect(validateReport({ ...VALID, details: "logs/run.log" }).error).toContain("absolute");
    expect(validateReport({ ...VALID, details: "/tmp/a\nb" }).error).toContain("control");
  });

  it("refuses a bad session id, an unknown outcome and an empty summary", () => {
    expect(validateReport({ ...VALID, sessionId: SESSION.toUpperCase() }).error).toContain("session");
    expect(validateReport({ ...VALID, outcome: "FAILED" }).error).toContain("outcome");
    expect(validateReport({ ...VALID, summary: " \u0000\n\t " }).error).toBe("summary is empty");
  });

  it("accepts every outcome: ok, update and failed", () => {
    for (const outcome of ["ok", "update", "failed"] as const) {
      expect(validateReport({ ...VALID, outcome }).report?.outcome).toBe(outcome);
    }
  });
});

describe("parseReports and latestPerJob", () => {
  it("skips malformed lines and keeps the valid ones in file order", () => {
    const good = report();
    const update = report({ outcome: "update" });
    const text = lines(
      "not json",
      JSON.stringify({ ...report(), v: 2 }),
      JSON.stringify({ ...report(), outcome: "warn" }),
      JSON.stringify({ ...report(), at: "yesterday" }),
      JSON.stringify({ ...report(), job: "bad job" }),
      JSON.stringify({ ...report(), details: "relative/path" }),
      JSON.stringify({ ...report(), summary: "  " }),
      "[1,2]",
      good,
      update,
      '{"v":1,"id":"truncated',
    );
    expect(parseReports(text)).toEqual([good, update]);
  });

  it("returns each job's newest report with its id, newest first, at most the limit", () => {
    const reports = [
      report({ job: "a", at: "2026-10-19T01:00:00.000Z", summary: "a old" }),
      report({ job: "b", at: "2026-10-19T02:00:00.000Z" }),
      report({ job: "a", at: "2026-10-19T05:00:00.000Z", summary: "a new", outcome: "failed" }),
      report({ job: "c", at: "2026-10-19T03:00:00.000Z" }),
      report({ job: "d", at: "2026-10-19T04:00:00.000Z", details: "/tmp/d.log" }),
    ];
    expect(latestPerJob(reports, 3)).toEqual([
      { id: reports[2].id, job: "a", outcome: "failed", summary: "a new", details: null, at: "2026-10-19T05:00:00.000Z" },
      { id: reports[4].id, job: "d", outcome: "ok", summary: "done", details: "/tmp/d.log", at: "2026-10-19T04:00:00.000Z" },
      { id: reports[3].id, job: "c", outcome: "ok", summary: "done", details: null, at: "2026-10-19T03:00:00.000Z" },
    ]);
  });

  it("lets the later line win when one job has two reports with the same time", () => {
    const reports = [report({ summary: "first" }), report({ summary: "second" })];
    expect(latestPerJob(reports, 3).map((r) => r.summary)).toEqual(["second"]);
  });
});

describe("readReportsTail", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "reports-test-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns nothing for a missing file", async () => {
    expect(await readReportsTail(join(dir, "none.jsonl"))).toEqual([]);
  });

  it("skips the line cut by the start of the window and keeps a line that starts exactly at it", async () => {
    const first = report({ summary: "x".repeat(200) });
    const second = report();
    const third = report();
    const file = join(dir, "r.jsonl");
    writeFileSync(file, lines(first, second, third));
    const tail = `${JSON.stringify(second)}\n${JSON.stringify(third)}\n`;
    expect(await readReportsTail(file, Buffer.byteLength(tail))).toEqual([second, third]);
    expect(await readReportsTail(file, Buffer.byteLength(tail) - 1)).toEqual([third]);
  });
});

describe("reportsToDeliver", () => {
  const now = Date.parse("2026-10-19T12:00:00.000Z");
  const recent = (hoursAgo: number) => new Date(now - hoursAgo * 3_600_000).toISOString();

  it("posts the reports after the last one the chat has, oldest first", () => {
    const [a, b, c] = [report({ at: recent(3) }), report({ at: recent(2) }), report({ at: recent(1) })];
    expect(reportsToDeliver([a, b, c], new Set([a.id]), now)).toEqual({ deliver: [b, c], skipped: 0 });
    expect(reportsToDeliver([a, b, c], new Set([a.id, b.id, c.id]), now)).toEqual({ deliver: [], skipped: 0 });
  });

  it("never posts a report older than one the chat already has", () => {
    const [a, b, c] = [report({ at: recent(3) }), report({ at: recent(2) }), report({ at: recent(1) })];
    expect(reportsToDeliver([a, b, c], new Set([b.id]), now).deliver).toEqual([c]);
  });

  it("leaves out reports older than 7 days", () => {
    const old = report({ at: new Date(now - DELIVERY_WINDOW_MS - 1).toISOString() });
    const edge = report({ at: new Date(now - DELIVERY_WINDOW_MS).toISOString() });
    expect(reportsToDeliver([old, edge], new Set(), now).deliver).toEqual([edge]);
  });

  it("posts at most 5, the newest, and counts the older ones it leaves out", () => {
    const reports = Array.from({ length: 7 }, (_, i) => report({ at: recent(7 - i) }));
    expect(reportsToDeliver(reports, new Set(), now)).toEqual({ deliver: reports.slice(2), skipped: 2 });
  });

  it("starts a turn only for a wake report written within the hour", () => {
    const wake = report({ wake: true, at: new Date(now - WAKE_WINDOW_MS).toISOString() });
    const stale = report({ wake: true, at: new Date(now - WAKE_WINDOW_MS - 1).toISOString() });
    expect(wakeTurn([report({ at: recent(0) }), wake], now)).toBe(true);
    expect(wakeTurn([stale, report({ at: recent(0) })], now)).toBe(false);
  });

  it("keeps wake through the file only when it is true", () => {
    const asked = validateReport({ ...VALID, wake: true }).report;
    expect(asked?.wake).toBe(true);
    expect("wake" in (validateReport(VALID).report ?? {})).toBe(false);
    const line = (wake: unknown) => JSON.stringify({ ...report(), wake });
    expect(parseReportLine(line(true))?.wake).toBe(true);
    expect(parseReportLine(line("yes"))).not.toHaveProperty("wake");
  });
});

describe("addressedFailures", () => {
  // Session entries as omp writes them, a minute apart from 10:00.
  let minute = 0;
  const stamp = () => new Date(Date.parse("2026-10-19T10:00:00.000Z") + minute++ * 60_000).toISOString();
  const posted = (r: StoredReport) => ({ type: "custom_message", customType: REPORT_MESSAGE_TYPE, details: { id: r.id }, timestamp: stamp() });
  const user = () => ({ type: "message", message: { role: "user" }, timestamp: stamp() });
  const assistant = (stopReason: string) => ({ type: "message", message: { role: "assistant", stopReason }, timestamp: stamp() });
  const toolResult = () => ({ type: "message", message: { role: "toolResult" }, timestamp: stamp() });
  const failed = (fields: Partial<StoredReport> = {}) => report({ outcome: "failed", at: "2026-10-19T09:00:00.000Z", ...fields });

  it("keeps a failed report the chat has not been posted yet", () => {
    const r = failed({ at: "2026-10-19T12:00:00.000Z" });
    expect(addressedFailures([r], [user(), assistant("stop")])).toEqual(new Set());
  });

  it("clears a posted failed report once the owner writes", () => {
    const r = failed();
    expect(addressedFailures([r], [user(), posted(r), user()])).toEqual(new Set([r.id]));
  });

  it("clears a posted failed report once the chat finishes a turn after it", () => {
    const r = failed();
    expect(addressedFailures([r], [posted(r), assistant("toolUse"), toolResult(), assistant("stop")])).toEqual(new Set([r.id]));
  });

  it("keeps a posted failed report while the chat only calls tools after it", () => {
    const r = failed();
    expect(addressedFailures([r], [user(), assistant("stop"), posted(r), assistant("toolUse"), toolResult(), assistant("error")])).toEqual(new Set());
  });

  it("never returns ok or update reports", () => {
    const [ok, update] = [report(), report({ outcome: "update" })];
    expect(addressedFailures([ok, update], [posted(ok), posted(update), user()])).toEqual(new Set());
  });

  it("clears a failed report posted before the window once a later report's entry has an answer after it", () => {
    const [r, later] = [failed(), report({ job: "other" })];
    expect(addressedFailures([r, later], [user(), posted(later)])).toEqual(new Set());
    expect(addressedFailures([r, later], [user(), posted(later), assistant("stop")])).toEqual(new Set([r.id]));
  });

  it("clears a failed report written before the window began once the window holds a user message", () => {
    const r = failed({ at: "2026-10-19T09:00:00.000Z" });
    expect(addressedFailures([r], [assistant("stop")])).toEqual(new Set());
    expect(addressedFailures([r], [assistant("toolUse"), user()])).toEqual(new Set([r.id]));
    // Written inside the window but not posted: it waits for the chat, so it stays.
    expect(addressedFailures([failed({ at: "2026-10-19T23:00:00.000Z" })], [user(), user()])).toEqual(new Set());
  });

  it("lets a newer ok report of the job win, so the pill is green whatever the failure", () => {
    const [bad, good] = [failed({ at: "2026-10-19T09:00:00.000Z" }), report({ at: "2026-10-19T09:30:00.000Z" })];
    expect(addressedFailures([bad, good], [posted(bad), posted(good)])).toEqual(new Set());
    expect(newestPerJob([bad, good])).toEqual([good]);
  });
});

describe("reportMessage and pillText", () => {
  // Built from local time, as the chat and the pill show it.
  const at = new Date(2026, 9, 19, 3, 4).toISOString();

  it("writes the job, outcome, local time, summary, details and the not-typed-by-the-user line", () => {
    expect(reportMessage({ job: "backup", outcome: "failed", summary: "disk full\nretry later", details: "/tmp/b.log", at })).toBe(
      [
        "Job report: backup FAILED at 2026-10-19 03:04",
        "disk full\nretry later",
        "Details: /tmp/b.log",
        "Posted by a scheduled job through the omp-sessions reporter, not typed by the user.",
      ].join("\n"),
    );
    expect(reportMessage({ job: "backup", outcome: "ok", summary: "done", details: null, at }).split("\n")).toEqual([
      "Job report: backup ok at 2026-10-19 03:04",
      "done",
      "Posted by a scheduled job through the omp-sessions reporter, not typed by the user.",
    ]);
    expect(reportMessage({ job: "digest", outcome: "update", summary: "digest", details: null, at }).split("\n")[0]).toBe(
      "Job report: digest update at 2026-10-19 03:04",
    );
    expect(reportMessage({ job: "deploy-fix", outcome: "ok", summary: "app-775 green", details: null, at, wake: true }).split("\n")[2]).toBe(
      "This is the result this chat waited for: go on with the work that waited on it.",
    );
  });

  it("shows only the time on the report's day and adds the date later", () => {
    const pill = { job: "backup", outcome: "ok" as const, summary: "done", details: null, at };
    expect(pillText(pill, new Date(2026, 9, 19, 23, 59))).toBe("backup ok · 03:04");
    expect(pillText({ ...pill, outcome: "failed" }, new Date(2026, 9, 20, 0, 1))).toBe("backup failed · Oct 19 03:04");
  });
});

describe("report.ts", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "report-cli-test-"));
    writeFileSync(join(root, "config.json"), JSON.stringify({ omp: { configRoot: root } }));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function run(...args: string[]) {
    const proc = Bun.spawnSync([process.execPath, join(import.meta.dir, "report.ts"), ...args], {
      env: { ...process.env, OMP_MOBILE_CONFIG: join(root, "config.json") },
    });
    return { code: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
  }
  const base = ["--session", SESSION, "--job", "backup", "--outcome", "ok"];
  const reportsFile = () => join(root, "omp-sessions", "reports", `${SESSION}.jsonl`);

  it("exits 64 with a message on stderr for usage errors and writes nothing", () => {
    const cases: [string[], string][] = [
      [["--job", "backup", "--outcome", "ok", "--summary", "x"], "--session is required"],
      [[...base], "exactly one of --summary and --summary-file"],
      [[...base, "--summary", "x", "--summary-file", "/tmp/x"], "exactly one of --summary and --summary-file"],
      [[...base, "--summary", "x", "--verbose", "1"], 'unknown argument "--verbose"'],
      [[...base, "--summary", "x", "--job", "other"], "--job given twice"],
      [[...base, "--summary"], "--summary needs a value"],
      [[...base, "--summary", " \u0001 "], "summary is empty"],
      [[...base, "--summary", "x", "--details", "run.log"], "absolute"],
      [["--session", SESSION, "--job", "../x", "--outcome", "ok", "--summary", "x"], "job must"],
      [["--session", SESSION, "--job", "backup", "--outcome", "done", "--summary", "x"], "outcome must"],
      [[...base, "--summary-file", join(root, "missing.txt")], "cannot read --summary-file"],
    ];
    for (const [args, message] of cases) {
      const { code, stderr } = run(...args);
      expect(code).toBe(64);
      expect(stderr).toContain(message);
      expect(stderr).toContain("Usage:");
    }
    expect(() => statSync(reportsFile())).toThrow();
  });

  it("appends one line per report to a 0600 file in a 0700 folder and warns about an unknown session", () => {
    const summaryFile = join(root, "summary.txt");
    writeFileSync(summaryFile, "\n  3 files copied\r\nall good\u0007\n");
    const first = run(...base, "--summary-file", summaryFile, "--details", "/tmp/backup.log");
    expect(first.code).toBe(0);
    expect(first.stderr).toContain(`no omp session file has the id ${SESSION}`);
    expect(first.stdout).toMatch(new RegExp(`^reported [0-9a-f-]{36} for backup to ${reportsFile()}\\n$`));
    const second = run("--session", SESSION, "--job", "sync", "--outcome", "failed", "--summary", "boom");
    expect(second.code).toBe(0);

    const stored = readFileSync(reportsFile(), "utf8").trimEnd().split("\n").map((line) => JSON.parse(line));
    expect(stored).toHaveLength(2);
    expect(Object.keys(stored[0])).toEqual(["v", "id", "job", "outcome", "summary", "details", "at"]);
    expect(stored[0]).toMatchObject({ v: 1, job: "backup", outcome: "ok", summary: "3 files copied\nall good", details: "/tmp/backup.log" });
    expect(stored[0].id).toBe(first.stdout.split(" ")[1]);
    expect(stored[1]).toMatchObject({ job: "sync", outcome: "failed", summary: "boom", details: null });
    expect(Date.parse(stored[1].at)).toBeGreaterThan(Date.now() - 60_000);
    expect(statSync(join(root, "omp-sessions", "reports")).mode & 0o777).toBe(0o700);
    expect(statSync(reportsFile()).mode & 0o777).toBe(0o600);
  });

  it("does not warn when a session file with the id exists in a profile", () => {
    const cwdDir = join(root, "profiles", "work", "agent", "sessions", "--Users-x--");
    mkdirSync(cwdDir, { recursive: true });
    writeFileSync(join(cwdDir, `2026-10-19T03-04-05-000Z_${SESSION}.jsonl`), "");
    const { code, stderr } = run(...base, "--summary", "x");
    expect(code).toBe(0);
    expect(stderr).toBe("");
  });

  it("exits 1 when the report cannot be written", () => {
    // A file where the folder should be.
    writeFileSync(join(root, "omp-sessions"), "");
    const { code, stderr } = run(...base, "--summary", "x");
    expect(code).toBe(1);
    expect(stderr).toContain(`could not write ${reportsFile()}`);
  });
});
