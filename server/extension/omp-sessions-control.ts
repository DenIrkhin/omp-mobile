// omp-sessions control extension.
//
// Lets the omp-mobile server (server/ in this repository) change this
// session's model and thinking level, compact it, run a skill, start, resume or
// stop a dev cycle, send it a prompt, and interrupt its turn. Collab guests cannot do the
// first ones (omp keeps /model, /compact, skills and extension commands host-only), and a
// guest prompt arrives as a steer, which would deny an open tool approval; so the dashboard
// server talks to a private Unix socket this extension opens instead:
//
//   ~/.omp/run/omp-sessions-control/<pid>.sock   (dir 0700, socket 0600)
//
// Protocol: the client writes ONE JSON line `{ v: 1, op, sessionId, ...args }`,
// the extension answers ONE JSON line `{ ok: true, ...data }` or
// `{ ok: false, error, code }` and closes. See ../control.ts for the client.
//
// Questions the chat waits on (ask, tool approvals) are out of an extension's reach; the
// server reads and answers them as a Collab guest (../collab-guest.ts).
//
// It also posts job reports into the session: ../report.ts appends them to
// ~/.omp/omp-sessions/reports/<sessionId>.jsonl (see ../reports.ts), and this
// extension watches that folder and posts each new report as a message that starts
// no turn, marks the cmux sidebar row with a pill per job, and raises a cmux banner
// for a failed job. A failed job's red pill goes once the chat has answered it
// (addressedFailures in ../reports.ts).
//
// It also adds the `/unpin` command, which takes this chat out of Long tasks the way the
// phone's pin button does: it removes the session from every agent dir's
// session-pins.json, and the dashboard's next sidebar check moves the cmux row. omp's own
// `/pin` toggles; `/unpin` never pins, so typing it twice is harmless.
//
// Extensions run in-process: an exception escaping a socket callback, timer or
// promise would tear down the whole omp session. Every callback below is wrapped
// and every promise has a rejection handler. Nothing is written to stdout/stderr
// (it would corrupt the TUI); the user sees changes through ctx.ui.notify.

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { listAgentDirs, readPins, writePin } from "../agent-dirs";
import { SESSION_ID } from "../long-tasks";
import {
  addressedFailures,
  newestPerJob,
  pillText,
  readReportsTail,
  REPORT_MESSAGE_TYPE,
  reportEntryId,
  reportFile,
  reportMessage,
  reportsDir,
  reportsToDeliver,
  type ReportOutcome,
  type StoredReport,
  wakeTurn,
} from "../reports";

const CONTROL_DIR = path.join(os.homedir(), ".omp", "run", "omp-sessions-control");
const SOCKET_PATH = path.join(CONTROL_DIR, `${process.pid}.sock`);
const MAX_REQUEST_BYTES = 64 * 1024;
const IDLE_TIMEOUT_MS = 5_000;
const THINKING_LEVELS: Record<string, true> = {
  off: true,
  minimal: true,
  low: true,
  medium: true,
  high: true,
  xhigh: true,
  max: true,
};
// YAML frontmatter at the top of SKILL.md (`---` … `---`), possibly empty.
const FRONTMATTER = /^---[ \t]*\r?\n(?:[\s\S]*?\r?\n)?---[ \t]*(?:\r?\n|$)/;
// A dev-cycle extension, which is not part of this repository, runs
// cycles; it answers requests on this pi.events channel (REQUEST_CHANNEL there).
const CYCLE_CHANNEL = "dev-cycle:request";
// Under the dashboard's 10 s socket timeout. Starting a cycle only switches the model first.
const CYCLE_TIMEOUT_MS = 8_000;
const CYCLE_ACTIONS: Record<string, true> = { start: true, resume: true, stop: true };
// How long `abort` waits for the turn to stop before it replies (under the dashboard's 10 s), and
// how often it checks.
const ABORT_WAIT_MS = 5_000;
const ABORT_POLL_MS = 100;
// Job reports. The extension, like the rest of omp, uses the default config root.
const OMP_CONFIG_ROOT = path.join(os.homedir(), ".omp");
const REPORTS_DIR = reportsDir(OMP_CONFIG_ROOT);
// How often a waiting report checks whether the turn has ended.
const IDLE_POLL_MS = 500;
// The owner's message is in the session only after the `input` event; the pill check waits this long.
const INPUT_SETTLE_MS = 1_500;
// cmux puts its CLI's path in every terminal it opens.
const CMUX_BIN = process.env.CMUX_BUNDLED_CLI_PATH || "cmux";
// Dark green and dark blue: cmux's system green (#34C759) and blue are hard to read on the light
// gray sidebar.
const PILLS: Record<ReportOutcome, { icon: string; color: string }> = {
  ok: { icon: "checkmark.circle.fill", color: "#166534" },
  update: { icon: "info.circle.fill", color: "#1D4ED8" },
  failed: { icon: "xmark.octagon.fill", color: "#FF453A" },
};

type ThinkingLevel = Parameters<ExtensionAPI["setThinkingLevel"]>[0];
type ErrorCode = "bad_request" | "session_mismatch" | "not_found" | "busy" | "input_required" | "failed";
type Reply = { ok: true; [key: string]: unknown } | { ok: false; error: string; code: ErrorCode };

/** The main interactive session the socket acts on. */
type Owner = { pi: ExtensionAPI; ctx: ExtensionContext };

// Module-level state is shared by every session in this process (subagents rerun
// the factory with a fresh `pi`), so only the main TUI session may set it.
let owner: Owner | null = null;
let server: net.Server | null = null;
let compacting = false;
// The owner session's open tool approvals and running ask calls, by tool call id. A prompt
// sent while one is open would answer it in the owner's place, so `prompt` refuses then.
const openQuestions = new Set<string>();
// Job report state, for the owner's session only.
let reportsWatcher: fs.FSWatcher | null = null;
let passRunning = false;
let passQueued = false;
let idleTimer: NodeJS.Timeout | undefined;
let midnightTimer: NodeJS.Timeout | undefined;
let inputTimer: NodeJS.Timeout | undefined;
// Reports posted by this process. sendMessage adds the session entry asynchronously,
// so the next pass may not find a report in the session yet that this one posted.
const postedReports = new Set<string>();
// The session whose job pills are on the cmux row, and per job the pill text it set, or null once
// it cleared the pill of a failed report the chat addressed. A pass touches cmux only on a change.
let pillSession: string | null = null;
const pillShown = new Map<string, string | null>();

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function notify(text: string, type: "info" | "error" = "info"): void {
  try {
    owner?.ctx.ui.notify(text, type);
  } catch {}
}

function fail(code: ErrorCode, error: string): Reply {
  return { ok: false, error, code };
}

/** Removes sockets left behind by omp processes that exited without shutting down. */
function removeDeadSockets(): void {
  for (const name of fs.readdirSync(CONTROL_DIR)) {
    const match = /^(\d+)\.sock$/.exec(name);
    if (!match || Number(match[1]) === process.pid) continue;
    try {
      process.kill(Number(match[1]), 0);
    } catch (err) {
      if (err instanceof Error && "code" in err && err.code === "ESRCH") {
        fs.rmSync(path.join(CONTROL_DIR, name), { force: true });
      }
    }
  }
}

function startServer(): void {
  try {
    fs.mkdirSync(CONTROL_DIR, { recursive: true, mode: 0o700 });
    fs.chmodSync(CONTROL_DIR, 0o700);
    removeDeadSockets();
    fs.rmSync(SOCKET_PATH, { force: true });

    const srv = net.createServer((socket) => {
      try {
        handleConnection(socket);
      } catch {
        socket.destroy();
      }
    });
    srv.on("error", (err) => {
      try {
        notify(`Dashboard control socket failed: ${errorText(err)}`, "error");
        if (server === srv) stopServer();
      } catch {}
    });
    srv.listen(SOCKET_PATH, () => {
      try {
        fs.chmodSync(SOCKET_PATH, 0o600);
      } catch (err) {
        notify(`Dashboard control socket: could not restrict permissions: ${errorText(err)}`, "error");
        if (server === srv) stopServer();
      }
    });
    // The socket must never keep omp alive after the session wants to exit.
    srv.unref();
    server = srv;
  } catch (err) {
    notify(`Dashboard control socket could not start: ${errorText(err)}`, "error");
  }
}

function stopServer(): void {
  const srv = server;
  server = null;
  try {
    srv?.close();
  } catch {}
  try {
    fs.rmSync(SOCKET_PATH, { force: true });
  } catch {}
}

function handleConnection(socket: net.Socket): void {
  const chunks: Buffer[] = [];
  let size = 0;
  let received = false;

  const send = (reply: Reply) => {
    try {
      socket.end(`${JSON.stringify(reply)}\n`);
    } catch {
      socket.destroy();
    }
  };

  socket.on("error", () => {
    try {
      socket.destroy();
    } catch {}
  });
  socket.setTimeout(IDLE_TIMEOUT_MS);
  socket.on("timeout", () => {
    try {
      socket.destroy();
    } catch {}
  });
  socket.on("data", (chunk: Buffer) => {
    try {
      if (received) return;
      const newline = chunk.indexOf(0x0a);
      const take = newline === -1 ? chunk : chunk.subarray(0, newline);
      size += take.length;
      if (size > MAX_REQUEST_BYTES) {
        received = true;
        send(fail("bad_request", `Request exceeds ${MAX_REQUEST_BYTES} bytes`));
        return;
      }
      chunks.push(take);
      if (newline === -1) return;

      received = true;
      // The request is in; a slow op (model switch) must not hit the idle timeout.
      socket.setTimeout(0);
      const line = Buffer.concat(chunks).toString("utf8");
      dispatch(line).then(send, (err: unknown) => send(fail("failed", errorText(err))));
    } catch (err) {
      send(fail("failed", errorText(err)));
    }
  });
}

async function dispatch(line: string): Promise<Reply> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return fail("bad_request", "Request is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) || !("v" in parsed) || parsed.v !== 1) {
    return fail("bad_request", "Unsupported request version");
  }
  // A plain JSON object; each op checks the fields it reads with typeof.
  const req: Record<string, unknown> = Object.fromEntries(Object.entries(parsed));
  const current = owner;
  if (!current) {
    return fail("failed", "No interactive session is attached");
  }
  if (req.sessionId !== current.ctx.sessionManager.getSessionId()) {
    return fail("session_mismatch", "This omp process is running a different session now");
  }

  switch (req.op) {
    case "status":
      return { ok: true, ...(await status(current)) };
    case "set-model":
      return setModel(current, req);
    case "set-thinking":
      return setThinking(current, req);
    case "compact":
      return compact(current, req);
    case "skill":
      return runSkill(current, req);
    case "cycle":
      return runCycle(current, req);
    case "prompt":
      return sendPrompt(current, req);
    case "abort":
      return abortTurn(current, req);
    default:
      return fail("bad_request", `Unknown op ${JSON.stringify(req.op)}`);
  }
}

async function status(current: Owner) {
  const { pi, ctx } = current;
  const skills = pi
    .getCommands()
    .filter((c) => c.source === "skill" && c.name.startsWith("skill:"))
    .map((c) => {
      const name = c.name.slice("skill:".length);
      return c.description ? { name, description: c.description } : { name };
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const model = ctx.models.current();
  const cycle = await askCycle(current, { action: "status" });
  return {
    sessionId: ctx.sessionManager.getSessionId(),
    model: model ? `${model.provider}/${model.id}` : null,
    thinking: pi.getThinkingLevel() ?? null,
    idle: ctx.isIdle() && !compacting,
    // Running background jobs (async bash, task subagents); null when the session has no job manager.
    jobs: ctx.getAsyncJobSnapshot()?.running.length ?? null,
    // Finished job results still waiting to be delivered into the chat; null as for `jobs`.
    queued: ctx.getAsyncJobSnapshot()?.delivery.queued ?? null,
    skills,
    // null when this session's dev-cycle cannot take dashboard requests (not loaded, or older).
    cycle: cycle?.ok === true ? (cycle.cycle ?? null) : null,
  };
}

/**
 * Sends `text` as the owner's message: idle, as an aside, which starts a turn; busy, as a
 * follow-up that waits for the turn to end. Never a steer: a steer denies an open tool approval,
 * and an aside sent while a turn has just started is queued, not steered.
 */
function sendPrompt({ pi, ctx }: Owner, req: Record<string, unknown>): Reply {
  if (typeof req.text !== "string" || !req.text.trim()) {
    return fail("bad_request", "text must be a non-empty string");
  }
  if (openQuestions.size > 0) {
    return fail("input_required", "The chat is waiting on a question or approval; answer it first");
  }
  const idle = ctx.isIdle();
  const sent = pi.sendUserMessage(req.text, { deliverAs: idle ? "aside" : "followUp" });
  Promise.resolve(sent).then(undefined, (err: unknown) => notify(`Dashboard prompt was not sent: ${errorText(err)}`, "error"));
  return { ok: true, started: idle, queued: !idle };
}

/**
 * Interrupts the running turn, as Esc does, then waits up to ABORT_WAIT_MS for it to stop.
 * Refuses while a question or approval is open, which the abort would cancel, unless `force`.
 */
async function abortTurn({ ctx }: Owner, req: Record<string, unknown>): Promise<Reply> {
  if (openQuestions.size > 0 && req.force !== true) {
    return fail("input_required", "The chat is waiting on a question or approval; send force to interrupt anyway");
  }
  if (ctx.isIdle()) return { ok: true, aborted: false, idle: true };
  ctx.abort();
  notify("Dashboard: interrupted the turn");
  const until = Date.now() + ABORT_WAIT_MS;
  while (!ctx.isIdle() && Date.now() < until) await Bun.sleep(ABORT_POLL_MS);
  return { ok: true, aborted: true, idle: ctx.isIdle() };
}

async function setModel(current: Owner, req: Record<string, unknown>): Promise<Reply> {
  const { pi, ctx } = current;
  if (typeof req.model !== "string" || !req.model) {
    return fail("bad_request", "model must be a provider/id string");
  }
  const thinking = req.thinking;
  if (thinking !== undefined && (typeof thinking !== "string" || THINKING_LEVELS[thinking] !== true)) {
    return fail("bad_request", "thinking is not a known level");
  }
  const model = ctx.models.resolve(req.model);
  if (!model) {
    return fail("not_found", `Unknown model ${req.model}`);
  }
  if (!(await pi.setModel(model))) {
    return fail("failed", `No credentials for ${model.provider}/${model.id}`);
  }
  if (thinking !== undefined) pi.setThinkingLevel(thinking as ThinkingLevel);
  const level = pi.getThinkingLevel();
  notify(`Dashboard: model → ${model.provider}/${model.id}${level ? ` · ${level}` : ""}`);
  return { ok: true, ...(await status(current)) };
}

async function setThinking(current: Owner, req: Record<string, unknown>): Promise<Reply> {
  const level = req.level;
  if (typeof level !== "string" || THINKING_LEVELS[level] !== true) {
    return fail("bad_request", "level is not a known thinking level");
  }
  current.pi.setThinkingLevel(level as ThinkingLevel);
  notify(`Dashboard: thinking → ${current.pi.getThinkingLevel() ?? level}`);
  return { ok: true, ...(await status(current)) };
}

function compact({ ctx }: Owner, req: Record<string, unknown>): Reply {
  if (req.instructions !== undefined && typeof req.instructions !== "string") {
    return fail("bad_request", "instructions must be a string");
  }
  if (compacting || !ctx.isIdle()) {
    return fail("busy", "The session is busy; wait for the current turn to finish");
  }
  const instructions = req.instructions?.trim() || undefined;
  compacting = true;
  notify(instructions ? `Dashboard: compacting context (focus: ${instructions})` : "Dashboard: compacting context");
  // Not awaited: the dashboard only learns that compaction started.
  let running: Promise<void>;
  try {
    running = ctx.compact(instructions);
  } catch (err) {
    compacting = false;
    return fail("failed", errorText(err));
  }
  running
    .then(undefined, (err: unknown) => notify(`Dashboard compaction failed: ${errorText(err)}`, "error"))
    .finally(() => {
      compacting = false;
    });
  return { ok: true, started: true };
}

/**
 * Sends the same message `/skill:<name> args` sends from the TUI: the SKILL.md
 * body under omp's prompts/skills/user-invocation.md header and footer.
 */
async function runSkill({ pi }: Owner, req: Record<string, unknown>): Promise<Reply> {
  if (typeof req.name !== "string" || !req.name) {
    return fail("bad_request", "name must be a skill name");
  }
  // While busy the skill message is a steer, and a steer denies an open tool approval.
  if (openQuestions.size > 0) {
    return fail("input_required", "The chat is waiting on a question or approval; answer it first");
  }
  if (req.args !== undefined && typeof req.args !== "string") {
    return fail("bad_request", "args must be a string");
  }
  const name = req.name;
  const command = pi.getCommands().find((c) => c.source === "skill" && c.name === `skill:${name}`);
  if (!command?.path) {
    return fail("not_found", `Unknown skill ${name}`);
  }
  const body = (await fs.promises.readFile(command.path, "utf8")).replace(/^\uFEFF/, "").replace(FRONTMATTER, "").trim();
  const args = req.args?.trim() ?? "";

  const lines = [`[IMPORTANT: User invoked the "${name}" skill; follow its instructions. Full skill below.]`, ""];
  if (body) lines.push(body, "");
  lines.push(
    "---",
    "",
    `[Skill directory: ${path.dirname(command.path)}]`,
    "Resolve relative paths in this skill (e.g. `scripts/foo.js`, `templates/config.yaml`) against this absolute directory; read referenced assets and templates; run scripts with the terminal tool when skill instructions call for it."
  );
  if (args) lines.push(`User: ${args}`);

  pi.sendMessage(
    {
      customType: "skill-prompt",
      content: lines.join("\n").trim(),
      display: true,
      details: {
        name,
        path: command.path,
        args: args || undefined,
        prompt: `/skill:${name}${args ? ` ${args}` : ""}`,
        lineCount: body ? body.split("\n").length : 0,
      },
      attribution: "user",
    },
    { triggerTurn: true }
  );
  notify(`Dashboard: ran /skill:${name}`);
  return { ok: true, sent: true };
}

/**
 * Sends one request to this session's dev-cycle extension and waits for its reply. Null when
 * no dev-cycle claims it: the extension is not loaded, or predates the request channel.
 */
function askCycle(
  { pi, ctx }: Owner,
  fields: { action: string; command?: string; args?: string }
): Promise<Record<string, unknown> | null> {
  const { promise, resolve } = Promise.withResolvers<Record<string, unknown> | null>();
  const timer = setTimeout(
    () => resolve({ ok: false, code: "failed", error: `dev-cycle did not answer within ${CYCLE_TIMEOUT_MS / 1000}s` }),
    CYCLE_TIMEOUT_MS
  );
  const request = {
    ...fields,
    sessionId: ctx.sessionManager.getSessionId(),
    claimed: false,
    reply: (result: unknown) => {
      clearTimeout(timer);
      resolve(
        typeof result === "object" && result !== null
          ? Object.fromEntries(Object.entries(result))
          : { ok: false, code: "failed", error: "dev-cycle sent an unreadable reply" }
      );
    },
  };
  // dev-cycle claims the request synchronously, inside emit.
  pi.events.emit(CYCLE_CHANNEL, request);
  if (!request.claimed) {
    clearTimeout(timer);
    resolve(null);
  }
  return promise;
}

/** Starts, resumes or stops this session's dev cycle through the dev-cycle extension. */
async function runCycle(current: Owner, req: Record<string, unknown>): Promise<Reply> {
  const action = req.action;
  if (typeof action !== "string" || CYCLE_ACTIONS[action] !== true) {
    return fail("bad_request", "action must be one of start, resume, stop");
  }
  let fields: { action: string; command?: string; args?: string } = { action };
  if (action === "start") {
    if (openQuestions.size > 0) {
      return fail("input_required", "The chat is waiting on a question or approval; answer it first");
    }
    if (typeof req.command !== "string" || !req.command) {
      return fail("bad_request", "command must be a command name");
    }
    if (req.args !== undefined && typeof req.args !== "string") {
      return fail("bad_request", "args must be a string");
    }
    fields = { action, command: req.command, args: req.args };
  }
  const reply = await askCycle(current, fields);
  if (!reply) {
    return fail("not_found", "The dev-cycle extension is not loaded in this session; restart it");
  }
  if (reply.ok !== true) {
    const code = reply.code === "bad_request" || reply.code === "not_found" || reply.code === "busy" ? reply.code : "failed";
    return fail(code, typeof reply.error === "string" ? reply.error : "dev-cycle refused the request");
  }
  const message = typeof reply.message === "string" ? reply.message : `Cycle ${action} done.`;
  notify(`Dashboard: ${message}`);
  return { ok: true, ...(await status(current)), message };
}

/** Fire-and-forget `cmux <args>`. Pills and banners are cosmetic: every failure is swallowed. */
function cmux(args: string[]): void {
  try {
    const child = spawn(CMUX_BIN, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {}
}

/** Removes the job pills this process put on its cmux row. */
function clearPills(): void {
  const workspace = process.env.CMUX_WORKSPACE_ID;
  if (workspace) {
    for (const [job, text] of pillShown) if (text !== null) cmux(["clear-status", `job:${job}`, "--workspace", workspace]);
  }
  pillShown.clear();
  pillSession = null;
  clearTimeout(midnightTimer);
}

/**
 * Puts one pill per job on this chat's cmux row, for the job's newest report. A failed report the
 * chat has addressed (`addressed`, from addressedFailures) gets no pill: its red pill is cleared. A
 * pill shows only the time on the day of the report, so another pass at midnight adds the date.
 */
function showPills(sessionId: string, reports: StoredReport[], addressed: ReadonlySet<string>): void {
  const workspace = process.env.CMUX_WORKSPACE_ID;
  if (!workspace) return;
  if (pillSession !== sessionId) clearPills();
  pillSession = sessionId;
  const now = new Date();
  for (const report of newestPerJob(reports)) {
    if (report.outcome === "failed" && addressed.has(report.id)) {
      // Also clears a pill an earlier process of this chat left behind.
      if (pillShown.get(report.job) !== null) cmux(["clear-status", `job:${report.job}`, "--workspace", workspace]);
      pillShown.set(report.job, null);
      continue;
    }
    const { icon, color } = PILLS[report.outcome];
    // Bold through cmux's markdown format. `_` is the only markdown character a job name can hold.
    const text = `**${pillText(report, now).replaceAll("_", "\\_")}**`;
    if (pillShown.get(report.job) === text) continue;
    cmux(["set-status", `job:${report.job}`, text, "--icon", icon, "--color", color, "--format", "markdown", "--workspace", workspace]);
    pillShown.set(report.job, text);
  }
  clearTimeout(midnightTimer);
  if (![...pillShown.values()].some((text) => text !== null)) return;
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 5);
  midnightTimer = setTimeout(() => {
    try {
      requestPass();
    } catch {}
  }, midnight.getTime() - now.getTime());
  midnightTimer.unref();
}

/** A cmux banner (and unread badge) for a failed job's report. */
function failureBanner(report: StoredReport): void {
  const workspace = process.env.CMUX_WORKSPACE_ID;
  if (!workspace) return;
  const surface = process.env.CMUX_SURFACE_ID;
  const body = report.summary.split("\n")[0];
  cmux(["notify", "--title", `${report.job} failed`, "--body", body, "--workspace", workspace, ...(surface ? ["--surface", surface] : [])]);
}

/**
 * Posts the session's new reports and refreshes its pills. A report waits while a turn
 * runs: sent then, it would steer that turn. omp emits agent_end while it still counts the
 * prompt as in flight, so the wait polls isIdle instead of trusting agent_end. The pills are
 * refreshed while it waits too: a pill steers nothing, and a failed one goes as soon as the
 * owner's message is in the session.
 */
async function reportPass(): Promise<void> {
  const current = owner;
  if (!current) return;
  const sessionId = current.ctx.sessionManager.getSessionId();
  if (!SESSION_ID.test(sessionId)) return;
  const file = reportFile(OMP_CONFIG_ROOT, sessionId);
  const reports = await readReportsTail(file);
  if (owner !== current || current.ctx.sessionManager.getSessionId() !== sessionId) {
    // The session changed while the file was read; its own pass is queued.
    return;
  }
  const entries = current.ctx.sessionManager.getEntries();
  if (!current.ctx.isIdle() || compacting) {
    showPills(sessionId, reports, addressedFailures(reports, entries));
    if (!idleTimer) {
      idleTimer = setTimeout(() => {
        try {
          idleTimer = undefined;
          requestPass();
        } catch {}
      }, IDLE_POLL_MS);
      idleTimer.unref();
    }
    return;
  }
  const delivered = new Set(postedReports);
  for (const entry of entries) {
    const id = reportEntryId(entry);
    if (id !== null) delivered.add(id);
  }
  const { deliver, skipped } = reportsToDeliver(reports, delivered, Date.now());
  // A wake report starts one turn, on the last message of the pass, so the earlier ones never steer it.
  const turn = wakeTurn(deliver, Date.now());
  for (const [i, report] of deliver.entries()) {
    current.pi.sendMessage(
      {
        customType: REPORT_MESSAGE_TYPE,
        content: reportMessage(report),
        display: true,
        details: { id: report.id, job: report.job, outcome: report.outcome, at: report.at },
      },
      { triggerTurn: turn && i === deliver.length - 1 }
    );
    postedReports.add(report.id);
    if (report.outcome === "failed") failureBanner(report);
  }
  if (skipped > 0) {
    notify(`${skipped} older job report${skipped === 1 ? " was" : "s were"} not posted here; see ${file}`);
  }
  showPills(sessionId, reports, addressedFailures(reports, entries));
}

/** Runs a report pass. Passes never overlap: one asked for during a pass runs after it. */
function requestPass(): void {
  if (passRunning) {
    passQueued = true;
    return;
  }
  passRunning = true;
  reportPass()
    .then(undefined, (err: unknown) => notify(`Job reports: ${errorText(err)}`, "error"))
    .finally(() => {
      try {
        passRunning = false;
        if (passQueued) {
          passQueued = false;
          requestPass();
        }
      } catch {}
    });
}

/** Watches the reports folder for writes to the owner session's report file. */
function watchReports(): void {
  if (reportsWatcher) return;
  try {
    fs.mkdirSync(REPORTS_DIR, { recursive: true, mode: 0o700 });
    const watcher = fs.watch(REPORTS_DIR, (_event, filename) => {
      try {
        if (owner && filename === `${owner.ctx.sessionManager.getSessionId()}.jsonl`) requestPass();
      } catch {}
    });
    watcher.on("error", () => {
      try {
        watcher.close();
      } catch {}
      // The next session start or switch watches again.
      if (reportsWatcher === watcher) reportsWatcher = null;
    });
    watcher.unref();
    reportsWatcher = watcher;
  } catch (err) {
    notify(`Job reports: cannot watch ${REPORTS_DIR}: ${errorText(err)}`, "error");
  }
}

function stopReports(): void {
  try {
    reportsWatcher?.close();
  } catch {}
  reportsWatcher = null;
  clearTimeout(idleTimer);
  idleTimer = undefined;
  clearTimeout(inputTimer);
  inputTimer = undefined;
  clearPills();
}

export default function ompSessionsControl(pi: ExtensionAPI) {
  // Remember the newest main-session context; start the socket and the report watch on
  // first sight. Subagent sessions (kind "sub") and non-TUI modes never touch either.
  const adopt = (ctx: ExtensionContext) => {
    if (ctx.agent?.kind !== "main" || ctx.mode !== "tui") return;
    owner = { pi, ctx };
    if (!server) startServer();
    watchReports();
    requestPass();
  };

  pi.on("session_start", (_event, ctx) => adopt(ctx));
  pi.on("session_switch", (_event, ctx) => adopt(ctx));
  pi.on("session_branch", (_event, ctx) => adopt(ctx));
  pi.on("session_tree", (_event, ctx) => adopt(ctx));

  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx.agent?.kind !== "main" || owner?.pi !== pi) return;
    stopServer();
    stopReports();
    owner = null;
    openQuestions.clear();
  });

  // Open questions of the owner session only; a subagent's approval is not the chat's.
  pi.on("tool_approval_requested", (event) => {
    if (owner?.pi === pi) openQuestions.add(event.toolCallId);
  });
  pi.on("tool_approval_resolved", (event) => {
    if (owner?.pi === pi) openQuestions.delete(event.toolCallId);
  });
  pi.on("tool_execution_start", (event) => {
    if (owner?.pi === pi && event.toolName === "ask") openQuestions.add(event.toolCallId);
  });
  pi.on("tool_execution_end", (event) => {
    if (owner?.pi === pi) openQuestions.delete(event.toolCallId);
  });
  // A turn's end settles whatever it asked, even if a resolve event was missed. It also answers
  // the failed reports posted before it, so the pass clears their pills.
  pi.on("agent_end", () => {
    if (owner?.pi !== pi) return;
    openQuestions.clear();
    requestPass();
  });
  // The owner wrote: their message answers the failed reports posted before it. omp appends it to
  // the session after this event, and a pass now could post a report ahead of the prompt, so the
  // pass runs INPUT_SETTLE_MS later, by when the turn has started (the pass only refreshes pills
  // then) or the input started none.
  pi.on("input", () => {
    if (owner?.pi !== pi) return;
    clearTimeout(inputTimer);
    inputTimer = setTimeout(() => {
      try {
        inputTimer = undefined;
        requestPass();
      } catch {}
    }, INPUT_SETTLE_MS);
    inputTimer.unref();
  });

  pi.registerCommand("unpin", {
    description: "Take this chat out of Long tasks",
    handler: async (_args, ctx) => {
      const sessionId = ctx.sessionManager.getSessionId();
      let unpinned = false;
      try {
        // A session can be pinned in more than one agent dir; the dashboard counts them all.
        for (const { dir } of await listAgentDirs(OMP_CONFIG_ROOT)) {
          if ((await readPins(dir)).includes(sessionId) && (await writePin(dir, sessionId, false))) unpinned = true;
        }
      } catch (err) {
        ctx.ui.notify(`Could not unpin this chat: ${errorText(err)}`, "error");
        return;
      }
      ctx.ui.notify(
        unpinned
          ? "This chat left Long tasks. Its cmux row moves to its project group within 15 seconds."
          : "This chat is not in Long tasks. (/unpin-account releases the chat's OAuth account.)",
        "info",
      );
    },
  });
}
