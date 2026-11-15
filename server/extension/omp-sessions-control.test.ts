// The control extension against a fake omp: a `pi` that records what the extension sends and a
// `ctx` whose turn state the test sets, talked to over the extension's real control socket. The
// home folder is a temporary one while the module loads, so the socket and the reports folder
// live there, not in the user's ~/.omp. cmux is a script that logs its arguments.
import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import * as os from "node:os";
import { join } from "node:path";
import { REPORT_MESSAGE_TYPE, type StoredReport } from "../reports";

type Handler = (event: Record<string, unknown>, ctx?: unknown) => void;

const SESSION = "01a13694-3e14-7026-a2da-8aae16651d32";

const handlers = new Map<string, Handler[]>();
const sent: { text: string; options?: unknown }[] = [];
const messages: unknown[] = [];
const turn = { idle: true, abortedAt: 0 };
const ABORT_TAKES_MS = 300;

const pi = {
  on: (name: string, handler: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
  registerCommand: () => {},
  sendUserMessage: (text: string, options?: unknown) => {
    sent.push({ text, options });
  },
  sendMessage: (message: unknown) => {
    messages.push(message);
  },
  getCommands: () => [{ name: "skill:ping", source: "skill", path: "/nonexistent/SKILL.md" }],
  getThinkingLevel: () => "high",
  events: { emit: () => {} },
};

// The session's entries, which the pill tests fill.
const entries: unknown[] = [];

const ctx = {
  agent: { kind: "main" },
  mode: "tui",
  sessionManager: { getSessionId: () => SESSION, getEntries: () => [...entries] },
  // A turn stops ABORT_TAKES_MS after the abort, as omp's does once the stream unwinds.
  isIdle: () => turn.idle || (turn.abortedAt > 0 && Date.now() - turn.abortedAt >= ABORT_TAKES_MS),
  abort: () => {
    turn.abortedAt = Date.now();
  },
  ui: { notify: () => {} },
  models: { current: () => ({ provider: "anthropic", id: "claude-sonnet-5-5" }) },
  getAsyncJobSnapshot: () => ({ running: [{ id: "bg_1" }], recent: [], delivery: { queued: 2, delivering: false } }),
};

function fire(name: string, event: Record<string, unknown> = {}): void {
  for (const handler of handlers.get(name) ?? []) handler(event, ctx);
}
let home = "";
let socketPath = "";
let cmuxLog = "";
const savedEnv = { cli: process.env.CMUX_BUNDLED_CLI_PATH, workspace: process.env.CMUX_WORKSPACE_ID };

/** One request line to the extension's socket, and its parsed reply. */
async function request(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { promise, resolve, reject } = Promise.withResolvers<Record<string, unknown>>();
  const socket = connect(socketPath);
  let data = "";
  socket.on("connect", () => socket.write(`${JSON.stringify({ v: 1, sessionId: SESSION, ...body })}\n`));
  socket.on("data", (chunk) => {
    data += chunk.toString("utf8");
  });
  socket.on("end", () => resolve(JSON.parse(data)));
  socket.on("error", reject);
  return promise;
}

beforeAll(async () => {
  home = mkdtempSync("/tmp/ompctl-");
  cmuxLog = join(home, "cmux.log");
  const fakeCmux = join(home, "cmux");
  writeFileSync(fakeCmux, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${cmuxLog}'\n`, { mode: 0o755 });
  // The module reads the cmux path when it loads, the workspace on each call.
  process.env.CMUX_BUNDLED_CLI_PATH = fakeCmux;
  process.env.CMUX_WORKSPACE_ID = "workspace:test";
  // Bun reads HOME once at startup, so the module gets this folder through a mocked homedir,
  // put back right after it loaded.
  const realOs = { ...os };
  mock.module("node:os", () => ({ ...realOs, homedir: () => home }));
  try {
    // Dynamic: the module reads homedir for its socket and reports paths when it loads.
    const { default: ompSessionsControl } = await import("./omp-sessions-control");
    ompSessionsControl(pi as never);
  } finally {
    mock.module("node:os", () => realOs);
  }
  socketPath = join(home, ".omp", "run", "omp-sessions-control", `${process.pid}.sock`);
  fire("session_start");
  // The socket listens asynchronously; wait for its file rather than a fixed time.
  for (let i = 0; i < 50 && !(await Bun.file(socketPath).exists()); i++) await Bun.sleep(20);
});

afterAll(() => {
  fire("session_shutdown");
  rmSync(home, { recursive: true, force: true });
  for (const [key, value] of [["CMUX_BUNDLED_CLI_PATH", savedEnv.cli], ["CMUX_WORKSPACE_ID", savedEnv.workspace]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

let reportSeq = 0;
/** Appends a report to the session's report file, which the extension watches. */
function writeReport(job: string, outcome: StoredReport["outcome"]): StoredReport {
  reportSeq++;
  const report: StoredReport = {
    v: 1,
    id: `00000000-0000-4000-8000-${String(reportSeq).padStart(12, "0")}`,
    job,
    outcome,
    summary: "x",
    details: null,
    at: new Date(Date.now() - 1000 + reportSeq).toISOString(),
  };
  const dir = join(home, ".omp", "omp-sessions", "reports");
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, `${SESSION}.jsonl`), `${JSON.stringify(report)}\n`);
  return report;
}

const posted = (report: StoredReport) => ({ type: "custom_message", customType: REPORT_MESSAGE_TYPE, details: { id: report.id }, timestamp: new Date().toISOString() });
const message = (role: string, stopReason?: string) => ({ type: "message", message: { role, stopReason }, timestamp: new Date().toISOString() });

/** The cmux calls so far, one argument string each. */
function cmuxCalls(): string[] {
  return existsSync(cmuxLog) ? readFileSync(cmuxLog, "utf8").split("\n").filter(Boolean) : [];
}

/** Waits up to `ms` for a cmux call that starts with `prefix`. */
async function cmuxCall(prefix: string, ms = 3000): Promise<string | undefined> {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(50)) {
    const call = cmuxCalls().find((line) => line.startsWith(prefix));
    if (call) return call;
  }
  return undefined;
}

describe("omp-sessions control extension", () => {
  it("reports running jobs and queued job results in status", async () => {
    expect(await request({ op: "status" })).toMatchObject({ ok: true, idle: true, jobs: 1, queued: 2 });
  });

  it("sends a prompt as an aside when idle and as a follow-up when busy, never as a steer", async () => {
    sent.length = 0;
    turn.idle = true;
    expect(await request({ op: "prompt", text: "go on" })).toEqual({ ok: true, started: true, queued: false });
    turn.idle = false;
    expect(await request({ op: "prompt", text: "and then" })).toEqual({ ok: true, started: false, queued: true });
    expect(sent).toEqual([
      { text: "go on", options: { deliverAs: "aside" } },
      { text: "and then", options: { deliverAs: "followUp" } },
    ]);
    turn.idle = true;
  });

  it("refuses a prompt, a skill and a cycle start while an ask or approval is open", async () => {
    sent.length = 0;
    messages.length = 0;
    for (const [open, close, event] of [
      ["tool_execution_start", "tool_execution_end", { toolName: "ask", toolCallId: "call-ask" }],
      ["tool_approval_requested", "tool_approval_resolved", { toolCallId: "call-bash" }],
    ] as const) {
      fire(open, event);
      for (const body of [{ op: "prompt", text: "go on" }, { op: "skill", name: "ping" }, { op: "cycle", action: "start", command: "feature-cycle" }]) {
        expect(await request(body)).toMatchObject({ ok: false, code: "input_required" });
      }
      fire(close, event);
    }
    expect(sent).toEqual([]);
    expect(messages).toEqual([]);
    expect(await request({ op: "prompt", text: "go on" })).toMatchObject({ ok: true });
  });

  it("refuses an abort while a question is open unless forced, and replies once the turn stopped", async () => {
    turn.idle = false;
    turn.abortedAt = 0;
    fire("tool_execution_start", { toolName: "ask", toolCallId: "call-ask" });
    expect(await request({ op: "abort" })).toMatchObject({ ok: false, code: "input_required" });
    expect(turn.abortedAt).toBe(0);
    const started = Date.now();
    expect(await request({ op: "abort", force: true })).toEqual({ ok: true, aborted: true, idle: true });
    expect(Date.now() - started).toBeGreaterThanOrEqual(ABORT_TAKES_MS);
    fire("tool_execution_end", { toolName: "ask", toolCallId: "call-ask" });
    turn.idle = true;
    turn.abortedAt = 0;
    expect(await request({ op: "abort" })).toEqual({ ok: true, aborted: false, idle: true });
  });

  describe("job pills", () => {
    it("keeps a failed pill until the owner writes, then clears it on input", async () => {
      turn.idle = true;
      const failed = writeReport("disk-check", "failed");
      // Not posted into the chat yet: the pass posts it, and the pill shows.
      expect(await cmuxCall("set-status job:disk-check **disk-check failed")).toBeDefined();
      expect(messages).toContainEqual(expect.objectContaining({ details: expect.objectContaining({ id: failed.id }) }));
      entries.push(posted(failed));
      // Tool calls alone answer nothing. Passes run one after another, so once the next report's
      // pill shows, the pass agent_end asked for is done.
      entries.push(message("assistant", "toolUse"), message("toolResult"));
      fire("agent_end");
      writeReport("marker", "ok");
      expect(await cmuxCall("set-status job:marker")).toBeDefined();
      expect(cmuxCalls().filter((line) => line.startsWith("clear-status job:disk-check"))).toEqual([]);
      entries.push(message("user"));
      fire("input", { text: "looking", source: "interactive" });
      expect(await cmuxCall("clear-status job:disk-check --workspace workspace:test")).toBeDefined();
    });

    it("clears a failed pill once the chat finishes a turn after it, and the midnight pass does not bring it back", async () => {
      const failed = writeReport("sync", "failed");
      expect(await cmuxCall("set-status job:sync **sync failed")).toBeDefined();
      entries.push(posted(failed), message("assistant", "stop"));
      fire("agent_end");
      expect(await cmuxCall("clear-status job:sync")).toBeDefined();
      // Any later pass, such as the one at midnight, leaves the cleared pill alone.
      writeFileSync(cmuxLog, "");
      writeReport("other", "ok");
      expect(await cmuxCall("set-status job:other")).toBeDefined();
      expect(cmuxCalls().filter((line) => line.includes("job:sync"))).toEqual([]);
    });

    it("shows a newer ok report of the job, whatever the failure before it", async () => {
      writeFileSync(cmuxLog, "");
      writeReport("fetch", "failed");
      expect(await cmuxCall("set-status job:fetch **fetch failed")).toBeDefined();
      writeReport("fetch", "ok");
      expect(await cmuxCall("set-status job:fetch **fetch ok")).toBeDefined();
    });
  });
});
