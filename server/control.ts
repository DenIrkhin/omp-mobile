// Dashboard side of the session control socket opened by extension/omp-sessions-control.ts.
// Through it the dashboard changes a running session's model and thinking level, compacts
// it, runs a skill, starts, resumes or stops a dev cycle, sends a prompt, and interrupts a
// turn: things omp keeps host-only, out of Collab guests' reach, or that a guest can only do
// as a steer. The question a session waits on (`pending`, `answer`) is out of the extension's
// reach, so those two ops join the session's Collab room instead (collab-guest.ts).
//
// `pending`, `answer`, `prompt` and `abort` act for the owner inside a chat, so only the local
// API (a unix socket in a 0700 folder) serves them; the TCP listener answers 404. Its only check
// is a Tailscale login header, which any local process can set.
import { connect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  answerPending,
  readPending,
  titleHash,
  type AnswerReply,
  type AnswerValue,
  type GuestResult,
  type PendingReply,
  type PendingUi,
  type QuestionTarget,
} from "./collab-guest";
import type { CliHost } from "./hosts";
import type { LaunchModel } from "./launch";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/** Where the extension listens: one `<pid>.sock` per omp process. */
export const CONTROL_DIR = join(homedir(), ".omp", "run", "omp-sessions-control");

export function controlSocketPath(pid: number): string {
  return join(CONTROL_DIR, `${pid}.sock`);
}

const MAX_INSTRUCTIONS = 2000;
const MAX_ARGS = 4000;
// The extension reads at most 64 KiB per request line; the rest of the line needs far less.
const MAX_PROMPT_BYTES = 60 * 1024;
const MAX_ANSWER = 4000;
const MAX_ANSWER_ITEMS = 64;
const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
// dev-cycle.ts reads `<name>.md` from the session's command dirs, so no path separators.
const COMMAND_NAME = /^[A-Za-z0-9][\w.-]{0,127}$/;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_REPLY_BYTES = 1024 * 1024;
/** The name the session shows for the guest that reads and answers its questions. */
const GUEST_NAME = "omp-sessions";
/**
 * How long `pending` and `answer` may take, link lookup included. Under the server's 180 s idle
 * timeout, so the caller always gets a reply, never a dropped connection.
 */
export const GUEST_DEADLINE_MS = 150_000;
/** Ops only the local API serves; see the header. */
const LOCAL_ONLY_OPS: Record<string, true> = { pending: true, answer: true, prompt: true, abort: true };
/** `<instanceId>:<generation>:<reqId>:<titleHash8>`, as `pending` returns it in `ref`. */
const QUESTION_REF = /^([A-Za-z0-9_-]{1,128}):([1-9]\d{0,9}):([1-9]\d{0,9}):([0-9a-f]{8})$/;

/** Op-specific fields the extension receives after `{ v, sessionId }`. */
export type ControlCommand =
  | { op: "status" }
  | { op: "set-model"; model: string; thinking?: string }
  | { op: "set-thinking"; level: ThinkingLevel }
  | { op: "compact"; instructions?: string }
  | { op: "skill"; name: string; args?: string }
  | { op: "cycle"; action: "start"; command: string; args?: string }
  | { op: "cycle"; action: "resume" | "stop" }
  | { op: "prompt"; text: string }
  | { op: "abort"; force?: true };

/** The question an answer is meant for, parsed from the `ref` that `pending` returned. */
export type QuestionRef = QuestionTarget & { instanceId: string; generation: number };

/** Ops served through the session's Collab room, not its extension. */
export type UiCommand = { op: "pending" } | { op: "answer"; value: AnswerValue; ref: QuestionRef };

export type ControlRequest = {
  instanceId: string;
  generation: number;
  command: ControlCommand | UiCommand;
};

/** Outcome of one round trip over a control socket. */
export type SocketReply =
  | { kind: "reply"; body: Record<string, unknown> }
  | { kind: "no_extension" }
  | { kind: "error"; error: string };

export type ControlResponse = { status: number; body: Record<string, unknown> };

/**
 * What the config allows Manage: the model presets (`launch.models`), dev cycles, and the words
 * that make a question owner-only (`control.ownerOnlyWords`).
 */
export type ControlSettings = { models: Record<string, LaunchModel>; devCycles: boolean; ownerOnlyWords: readonly string[] };

/**
 * Reads and answers the question a session waits on; see collabUiRelay. `ownerOnlyWords` as in
 * ownerOnlyTitle; `signal` is the deadline.
 */
export type UiRelay = {
  pending(host: CliHost, ownerOnlyWords: readonly string[], signal: AbortSignal): Promise<GuestResult<PendingReply>>;
  answer(host: CliHost, value: AnswerValue, target: QuestionTarget, ownerOnlyWords: readonly string[], signal: AbortSignal): Promise<GuestResult<AnswerReply>>;
};

/**
 * A UiRelay that joins the host's Collab room through the control link `link` returns (or throws).
 * One guest per chat at a time: a second caller gets `busy`, so two never interleave toggles.
 */
export function collabUiRelay(link: (host: CliHost) => Promise<string>): UiRelay {
  const inUse = new Set<string>();
  const withLink = async <T>(host: CliHost, run: (url: string) => Promise<GuestResult<T>>): Promise<GuestResult<T>> => {
    if (inUse.has(host.instanceId)) {
      return { ok: false, code: "busy", error: "Another request is reading or answering this chat; try again when it is done" };
    }
    inUse.add(host.instanceId);
    try {
      let url: string;
      try {
        url = await link(host);
      } catch (err) {
        return { ok: false, code: "failed", error: err instanceof Error ? err.message : String(err) };
      }
      return await run(url);
    } finally {
      inUse.delete(host.instanceId);
    }
  };
  return {
    pending: (host, ownerOnlyWords, signal) => withLink(host, (url) => readPending(url, GUEST_NAME, ownerOnlyWords, signal)),
    answer: (host, value, target, ownerOnlyWords, signal) => withLink(host, (url) => answerPending(url, GUEST_NAME, value, target, ownerOnlyWords, signal)),
  };
}

/** The `ref` of a question `host` shows: what `answer` must send back. */
export function questionRef(host: CliHost, question: PendingUi): string {
  return `${host.instanceId}:${host.generation}:${question.reqId}:${titleHash(question.title)}`;
}

/**
 * Validates POST /api/control. set-model takes the id of a preset in `models` that names a model,
 * never a raw model string; a preset without a thinking level leaves the session's own. Empty
 * optional text (compact focus, skill and cycle args) is dropped.
 */
export function validateControlRequest(body: unknown, models: Record<string, LaunchModel>): { req?: ControlRequest; error?: string } {
  if (!body || typeof body !== "object") {
    return { error: "Request body must be a JSON object" };
  }
  // Each field below is checked with typeof before use.
  const b = body as Record<string, unknown>;
  if (typeof b.instanceId !== "string" || !b.instanceId.trim()) {
    return { error: "instanceId must be a non-empty string" };
  }
  if (typeof b.generation !== "number" || !Number.isInteger(b.generation) || b.generation < 1) {
    return { error: "generation must be a positive integer" };
  }
  const target = { instanceId: b.instanceId.trim(), generation: b.generation };

  switch (b.op) {
    case "status":
      return { req: { ...target, command: { op: "status" } } };
    case "set-model": {
      const preset = typeof b.preset === "string" && Object.hasOwn(models, b.preset) ? models[b.preset] : null;
      if (preset === null || preset.model === null) {
        return { error: "preset is not in the allowed list" };
      }
      const command: ControlCommand =
        preset.thinking === null
          ? { op: "set-model", model: preset.model }
          : { op: "set-model", model: preset.model, thinking: preset.thinking };
      return { req: { ...target, command } };
    }
    case "set-thinking": {
      const level = THINKING_LEVELS.find((l) => l === b.level);
      if (!level) {
        return { error: `level must be one of ${THINKING_LEVELS.join(", ")}` };
      }
      return { req: { ...target, command: { op: "set-thinking", level } } };
    }
    case "compact": {
      if (b.instructions !== undefined && typeof b.instructions !== "string") {
        return { error: "instructions must be a string" };
      }
      if (b.instructions && b.instructions.length > MAX_INSTRUCTIONS) {
        return { error: `instructions must be at most ${MAX_INSTRUCTIONS} characters` };
      }
      const instructions = b.instructions?.trim();
      return { req: { ...target, command: instructions ? { op: "compact", instructions } : { op: "compact" } } };
    }
    case "skill": {
      if (typeof b.name !== "string" || !SKILL_NAME.test(b.name)) {
        return { error: "name is not a valid skill name" };
      }
      const { args, error } = readArgs(b.args);
      if (error) return { error };
      return { req: { ...target, command: args ? { op: "skill", name: b.name, args } : { op: "skill", name: b.name } } };
    }
    case "cycle": {
      if (b.action === "resume" || b.action === "stop") {
        return { req: { ...target, command: { op: "cycle", action: b.action } } };
      }
      if (b.action !== "start") {
        return { error: "action must be one of start, resume, stop" };
      }
      if (typeof b.command !== "string" || !COMMAND_NAME.test(b.command)) {
        return { error: "command is not a valid command name" };
      }
      const { args, error } = readArgs(b.args);
      if (error) return { error };
      const command = b.command;
      return { req: { ...target, command: args ? { op: "cycle", action: "start", command, args } : { op: "cycle", action: "start", command } } };
    }
    case "pending":
      return { req: { ...target, command: { op: "pending" } } };
    case "answer": {
      const value = b.value;
      const valid =
        (typeof value === "string" && value.length <= MAX_ANSWER) ||
        (Array.isArray(value) &&
          value.length > 0 &&
          value.length <= MAX_ANSWER_ITEMS &&
          value.every((v) => typeof v === "string" && v.length <= MAX_ANSWER));
      if (!valid) {
        return { error: `value must be a string or a non-empty list of strings, each at most ${MAX_ANSWER} characters` };
      }
      // `ref` names the question the caller read; a `reqId` sent beside it is ignored.
      const ref = typeof b.ref === "string" ? QUESTION_REF.exec(b.ref) : null;
      if (!ref) {
        return { error: "ref must be the ref that pending returned (<instanceId>:<generation>:<reqId>:<titleHash>)" };
      }
      const answer = value as AnswerValue;
      const question: QuestionRef = { instanceId: ref[1], generation: Number(ref[2]), reqId: Number(ref[3]), titleHash: ref[4] };
      return { req: { ...target, command: { op: "answer", value: answer, ref: question } } };
    }
    case "prompt":
      // The size the extension reads is the JSON-encoded text in bytes, not its characters.
      if (typeof b.text !== "string" || !b.text.trim() || Buffer.byteLength(JSON.stringify(b.text)) > MAX_PROMPT_BYTES) {
        return { error: `text must be a non-empty string of at most ${MAX_PROMPT_BYTES} bytes as JSON` };
      }
      return { req: { ...target, command: { op: "prompt", text: b.text } } };
    case "abort":
      if (b.force !== undefined && typeof b.force !== "boolean") {
        return { error: "force must be a boolean" };
      }
      return { req: { ...target, command: b.force ? { op: "abort", force: true } : { op: "abort" } } };
    default:
      return { error: "op must be one of status, set-model, set-thinking, compact, skill, cycle, pending, answer, prompt, abort" };
  }
}

/** Optional arguments for a skill or a cycle: a string of at most MAX_ARGS characters, trimmed. */
function readArgs(value: unknown): { args?: string; error?: string } {
  if (value === undefined) return {};
  if (typeof value !== "string") return { error: "args must be a string" };
  if (value.length > MAX_ARGS) return { error: `args must be at most ${MAX_ARGS} characters` };
  return { args: value.trim() };
}

/**
 * Sends one JSON line to the extension in omp process `pid` and reads its one-line
 * reply. A missing socket file (ENOENT) or one nobody listens on (ECONNREFUSED)
 * means the session runs without the extension.
 */
export function sendControl(pid: number, payload: object, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<SocketReply> {
  const { promise, resolve } = Promise.withResolvers<SocketReply>();
  const socket = connect(controlSocketPath(pid));
  const chunks: Buffer[] = [];
  let size = 0;
  const timer = setTimeout(
    () => finish({ kind: "error", error: `Session did not answer within ${timeoutMs / 1000}s` }),
    timeoutMs
  );
  // Only the first call settles the promise; the rest just repeat the cleanup.
  const finish = (reply: SocketReply) => {
    clearTimeout(timer);
    socket.destroy();
    resolve(reply);
  };

  socket.on("connect", () => socket.write(`${JSON.stringify(payload)}\n`));
  socket.on("data", (chunk: Buffer) => {
    size += chunk.length;
    if (size > MAX_REPLY_BYTES) {
      finish({ kind: "error", error: "Session reply is too large" });
    } else {
      chunks.push(chunk);
    }
  });
  socket.on("end", () => {
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {}
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "ok" in parsed && typeof parsed.ok === "boolean") {
      // A JSON object with a boolean `ok`; handleControl checks the fields it reads.
      const body: Record<string, unknown> = Object.fromEntries(Object.entries(parsed));
      finish({ kind: "reply", body });
    } else {
      finish({ kind: "error", error: "Session sent an unreadable reply" });
    }
  });
  socket.on("close", () => finish({ kind: "error", error: "Session closed the connection without answering" }));
  socket.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT" || err.code === "ECONNREFUSED") {
      finish({ kind: "no_extension" });
    } else {
      finish({ kind: "error", error: `Control socket error: ${err.message}` });
    }
  });
  return promise;
}

/** HTTP status for each extension or guest error code; anything else is a 502. */
const STATUS_BY_CODE: Record<string, number> = {
  bad_request: 400,
  owner_only: 403,
  not_found: 404,
  nothing_pending: 404,
  session_mismatch: 409,
  busy: 409,
  input_required: 409,
  changed: 409,
  rejected: 422,
  timeout: 504,
  outcome_unknown: 504,
};

/**
 * Where a request came from and what bounds it.
 * - `local`: it came over the local API socket; only then are LOCAL_ONLY_OPS served.
 * - `signal`: the deadline for `pending` and `answer` (GUEST_DEADLINE_MS, or the caller left).
 * - `relist`: a fresh host list, to tell a question that just closed from one omp no longer shows.
 */
export type ControlContext = { local: boolean; signal: AbortSignal; relist: () => Promise<CliHost[]> };

/** The 409 `changed` an answer gets when the question it names is gone. */
function changed(error: string): ControlResponse {
  return { status: 409, body: { error: `${error}; read pending again`, code: "changed" } };
}

/**
 * After a guest found no open question: still `inputRequired` in a fresh host list means omp
 * reported a question that never reached the guest, a protocol change to fail loudly on.
 */
async function stillWaiting(host: CliHost, ctx: ControlContext): Promise<boolean> {
  const fresh = (await ctx.relist()).find((h) => h.instanceId === host.instanceId && h.generation === host.generation);
  return fresh?.inputRequired === true;
}

const PROTOCOL_ERROR: ControlResponse = {
  status: 502,
  body: { error: "The chat reports an open question, but none reached the guest: omp's Collab protocol may have changed", code: "protocol" },
};

/**
 * POST /api/control: checks the target against the live host list, then relays the command to that
 * host's process, or for `pending` and `answer` to its Collab room through `ui`. The session id
 * always comes from `hosts`. `settings` come from the config.
 */
export async function handleControl(
  body: unknown,
  hosts: CliHost[],
  settings: ControlSettings,
  ui: UiRelay,
  ctx: ControlContext,
  send: typeof sendControl = sendControl
): Promise<ControlResponse> {
  const op = body && typeof body === "object" && "op" in body ? body.op : undefined;
  if (!ctx.local && typeof op === "string" && LOCAL_ONLY_OPS[op] === true) {
    return { status: 404, body: { error: "Not found" } };
  }
  const { req, error } = validateControlRequest(body, settings.models);
  if (!req) {
    return { status: 400, body: { error } };
  }
  if (req.command.op === "cycle" && !settings.devCycles) {
    return { status: 400, body: { error: "Dev cycles are turned off on this server", code: "disabled" } };
  }
  const command = req.command;
  const host = hosts.find((h) => h.instanceId === req.instanceId);
  // An answer names one question of one omp process; any other process or generation is `changed`.
  if (command.op === "answer") {
    if (command.ref.instanceId !== req.instanceId || command.ref.generation !== req.generation) {
      return changed("The ref names another chat or generation than the request");
    }
    if (!host) return changed(`Host ${req.instanceId} is not running any more`);
    if (host.generation !== req.generation) return changed(`Session generation changed (now ${host.generation})`);
  }
  if (!host) {
    return { status: 404, body: { error: `Host ${req.instanceId} is not running or no longer published` } };
  }
  if (host.generation !== req.generation) {
    return {
      status: 409,
      body: { error: `Session generation changed (expected ${req.generation}, host is at ${host.generation})` },
    };
  }
  if (host.access !== "control") {
    return { status: 403, body: { error: `Host ${req.instanceId} only allows view access` } };
  }
  if (!Number.isInteger(host.pid) || host.pid < 1) {
    return { status: 502, body: { error: `Host ${req.instanceId} reported no process id` } };
  }

  // inputRequired is omp's own "a question is open for guests"; without it there is nothing to join for.
  if (command.op === "pending") {
    if (!host.inputRequired) return { status: 200, body: { pending: null, queued: 0 } };
    const read = await ui.pending(host, settings.ownerOnlyWords, ctx.signal);
    if (!read.ok) return codeError(read);
    const { pending, queued } = read.value;
    if (pending === null) return (await stillWaiting(host, ctx)) ? PROTOCOL_ERROR : { status: 200, body: { pending: null, queued: 0 } };
    return { status: 200, body: { pending: { ...pending, ref: questionRef(host, pending) }, queued } };
  }
  if (command.op === "answer") {
    if (!host.inputRequired) return changed("The session is not waiting on a question any more");
    const result = await ui.answer(host, command.value, { reqId: command.ref.reqId, titleHash: command.ref.titleHash }, settings.ownerOnlyWords, ctx.signal);
    if (result.ok) {
      const { answered, next } = result.value;
      return { status: 200, body: { answered, next: next === null ? null : { ...next, ref: questionRef(host, next) } } };
    }
    if (result.code === "nothing_pending") {
      return (await stillWaiting(host, ctx)) ? PROTOCOL_ERROR : changed("The question is no longer open");
    }
    return codeError(result);
  }
  // A prompt, a skill or a new cycle while a question is open can answer or deny it in the
  // owner's place (omp denies an open approval on a steer); an abort would cancel it.
  const sendsText = command.op === "prompt" || command.op === "skill" || (command.op === "cycle" && command.action === "start");
  if (host.inputRequired && (sendsText || (command.op === "abort" && !command.force))) {
    const what = command.op === "abort" ? "; send force to interrupt anyway" : "; answer it first";
    return { status: 409, body: { error: `The session is waiting on a question${what}`, code: "input_required" } };
  }

  const result = await send(host.pid, { v: 1, ...command, sessionId: host.sessionId });
  if (result.kind === "no_extension") {
    return {
      status: 503,
      body: { error: "This session runs without the omp-sessions control extension", code: "no_extension" },
    };
  }
  if (result.kind === "error") {
    return { status: 502, body: { error: result.error } };
  }

  const { ok, ...data } = result.body;
  if (ok === true) {
    if (req.command.op !== "status") {
      return { status: 200, body: data };
    }
    // Manage offers only presets that name a model; with dev cycles off it shows no cycle actions.
    const presets = Object.entries(settings.models)
      .filter(([, preset]) => preset.model !== null)
      .map(([id, { label, model, thinking }]) => ({ id, label, model, thinking }));
    const body = settings.devCycles ? { ...data } : { ...data, cycle: { commands: [], state: null } };
    return { status: 200, body: { ...body, presets, thinkingLevels: THINKING_LEVELS } };
  }
  return codeError({
    code: typeof data.code === "string" ? data.code : "failed",
    error: typeof data.error === "string" ? data.error : "Session refused the request",
  });
}

/** An extension or guest error as a response: STATUS_BY_CODE's status, else 502. */
function codeError(result: { code: string; error: string }): ControlResponse {
  const status = Object.hasOwn(STATUS_BY_CODE, result.code) ? STATUS_BY_CODE[result.code] : 502;
  return { status, body: { error: result.error, code: result.code } };
}
