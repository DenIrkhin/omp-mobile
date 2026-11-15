import { describe, expect, it } from "bun:test";
import { titleHash, type AnswerReply, type GuestResult, type PendingReply, type QuestionTarget } from "./collab-guest";
import { collabUiRelay, handleControl, THINKING_LEVELS, validateControlRequest, type ControlContext, type SocketReply, type UiRelay } from "./control";
import type { CliHost } from "./hosts";
import type { LaunchModel } from "./launch";

const target = { instanceId: "inst-1", generation: 3 };
const MODELS: Record<string, LaunchModel> = {
  "opus-5.5-xhigh": { label: "Claude Opus 5.5 · xhigh", model: "anthropic/claude-opus-5-5", thinking: "xhigh" },
  "sonnet-5.5-medium": { label: "Claude Sonnet 5.5 · medium", model: "anthropic/claude-sonnet-5-5", thinking: "medium" },
  default: { label: "Profile default", model: null, thinking: null },
  "opus-own-thinking": { label: "Opus, own thinking", model: "anthropic/claude-opus-5-5", thinking: null },
};
const SETTINGS = { models: MODELS, devCycles: true, ownerOnlyWords: ["zz-owner-word"] };

const controlHost: CliHost = {
  instanceId: "inst-1",
  generation: 3,
  pid: 4242,
  sessionId: "sess-live",
  sessionName: null,
  cwd: "/tmp/omp-ctl-test",
  model: { provider: "google-antigravity", id: "gemini-3.8-flash" },
  startedAt: 1000,
  participants: 1,
  relayConnected: true,
  inputRequired: false,
  busy: false,
  access: "control",
};

const statusData = {
  sessionId: "sess-live",
  model: "google-antigravity/gemini-3.8-flash",
  thinking: "high",
  idle: true,
  skills: [{ name: "ping", description: "Replies PONG" }],
};

/** Fake socket transport: records every call and answers with `reply`. */
function fakeSend(reply: SocketReply) {
  const calls: { pid: number; payload: object }[] = [];
  const send = async (pid: number, payload: object) => {
    calls.push({ pid, payload });
    return reply;
  };
  return { calls, send };
}

/** Fake Collab relay: records every call and answers both ops with `reply`. */
function fakeUi(reply: GuestResult<PendingReply | AnswerReply> = { ok: false, code: "failed", error: "unused" }) {
  const calls: { op: string; value?: unknown; target?: QuestionTarget; words: readonly string[]; signal: AbortSignal }[] = [];
  const ui: UiRelay = {
    pending: async (_host, words, signal) => {
      calls.push({ op: "pending", words, signal });
      return reply as GuestResult<PendingReply>;
    },
    answer: async (_host, value, target, words, signal) => {
      calls.push({ op: "answer", value, target, words, signal });
      return reply as GuestResult<AnswerReply>;
    },
  };
  return { calls, ui };
}
const NO_UI = fakeUi().ui;

/** A request over the local API socket; `relisted` is what a fresh host list shows. */
function local(relisted: CliHost[] = []): ControlContext {
  return { local: true, signal: new AbortController().signal, relist: async () => relisted };
}
const LOCAL = local();
const TAILNET: ControlContext = { ...LOCAL, local: false };

const QUESTION_TITLE = "Run make build?";
const REF = `inst-1:3:4:${titleHash(QUESTION_TITLE)}`;

describe("validateControlRequest", () => {
  it("maps a set-model preset to its model and thinking level", () => {
    expect(validateControlRequest({ ...target, op: "set-model", preset: "opus-5.5-xhigh" }, MODELS)).toEqual({
      req: { ...target, command: { op: "set-model", model: "anthropic/claude-opus-5-5", thinking: "xhigh" } },
    });
  });

  it("rejects set-model with raw model strings, unknown presets and prototype keys", () => {
    for (const preset of ["anthropic/claude-opus-5-5", "opus", "", undefined, 7, "toString", "__proto__", "constructor", "default"]) {
      expect(validateControlRequest({ ...target, op: "set-model", preset }, MODELS).error).toBe("preset is not in the allowed list");
    }
  });

  it("leaves the thinking level out of set-model when the preset has none", () => {
    expect(validateControlRequest({ ...target, op: "set-model", preset: "opus-own-thinking" }, MODELS).req?.command).toEqual({
      op: "set-model",
      model: "anthropic/claude-opus-5-5",
    });
  });

  it("accepts every thinking level and nothing else", () => {
    for (const level of THINKING_LEVELS) {
      expect(validateControlRequest({ ...target, op: "set-thinking", level }, MODELS).req?.command).toEqual({ op: "set-thinking", level });
    }
    for (const level of ["extreme", "HIGH", "", null, undefined, 3, "constructor"]) {
      expect(validateControlRequest({ ...target, op: "set-thinking", level }, MODELS).error).toBeDefined();
    }
  });

  it("caps compact focus at 2000 characters and drops a blank one", () => {
    expect(validateControlRequest({ ...target, op: "compact", instructions: "x".repeat(2000) }, MODELS).req?.command).toEqual({
      op: "compact",
      instructions: "x".repeat(2000),
    });
    expect(validateControlRequest({ ...target, op: "compact", instructions: "x".repeat(2001) }, MODELS).error).toBeDefined();
    expect(validateControlRequest({ ...target, op: "compact", instructions: "   " }, MODELS).req?.command).toEqual({ op: "compact" });
    expect(validateControlRequest({ ...target, op: "compact" }, MODELS).req?.command).toEqual({ op: "compact" });
    expect(validateControlRequest({ ...target, op: "compact", instructions: 5 }, MODELS).error).toBeDefined();
  });

  it("accepts skill names up to 128 characters from the allowed alphabet", () => {
    for (const name of ["ping", "a.b_c:d/e-f", "9lives", "a".repeat(128)]) {
      expect(validateControlRequest({ ...target, op: "skill", name }, MODELS).req?.command).toEqual({ op: "skill", name });
    }
    for (const name of ["", "-ping", ".hidden", "../etc", "/abs", "has space", "semi;colon", "a".repeat(129), 42]) {
      expect(validateControlRequest({ ...target, op: "skill", name }, MODELS).error).toBe("name is not a valid skill name");
    }
  });

  it("caps skill args at 4000 characters and trims them", () => {
    expect(validateControlRequest({ ...target, op: "skill", name: "ping", args: "  hi  " }, MODELS).req?.command).toEqual({
      op: "skill",
      name: "ping",
      args: "hi",
    });
    expect(validateControlRequest({ ...target, op: "skill", name: "ping", args: "y".repeat(4000) }, MODELS).error).toBeUndefined();
    expect(validateControlRequest({ ...target, op: "skill", name: "ping", args: "y".repeat(4001) }, MODELS).error).toBeDefined();
  });

  it("starts a cycle only by a plain command name and passes trimmed args", () => {
    for (const command of ["feature-cycle", "app.cycle_2", "a".repeat(128)]) {
      expect(validateControlRequest({ ...target, op: "cycle", action: "start", command }, MODELS).req?.command).toEqual({
        op: "cycle",
        action: "start",
        command,
      });
    }
    for (const command of ["", "../feature-cycle", "a/b", "/abs", ".hidden", "-x", "has space", "a".repeat(129), 42, undefined]) {
      expect(validateControlRequest({ ...target, op: "cycle", action: "start", command }, MODELS).error).toBe("command is not a valid command name");
    }
    expect(validateControlRequest({ ...target, op: "cycle", action: "start", command: "feature-cycle", args: "  feat-x notes  " }, MODELS).req?.command).toEqual({
      op: "cycle",
      action: "start",
      command: "feature-cycle",
      args: "feat-x notes",
    });
    expect(validateControlRequest({ ...target, op: "cycle", action: "start", command: "feature-cycle", args: "   " }, MODELS).req?.command).toEqual({
      op: "cycle",
      action: "start",
      command: "feature-cycle",
    });
    expect(validateControlRequest({ ...target, op: "cycle", action: "start", command: "feature-cycle", args: "y".repeat(4001) }, MODELS).error).toBeDefined();
  });

  it("sends resume and stop without extra fields and rejects other actions", () => {
    for (const action of ["resume", "stop"] as const) {
      expect(validateControlRequest({ ...target, op: "cycle", action, command: "feature-cycle", args: "x" }, MODELS).req?.command).toEqual({
        op: "cycle",
        action,
      });
    }
    for (const action of ["goto", "pause", "", undefined]) {
      expect(validateControlRequest({ ...target, op: "cycle", action }, MODELS).error).toBe("action must be one of start, resume, stop");
    }
  });

  it("rejects bad targets and unknown ops", () => {
    expect(validateControlRequest(null, MODELS).error).toBeDefined();
    expect(validateControlRequest({ op: "status", instanceId: " ", generation: 1 }, MODELS).error).toBeDefined();
    for (const generation of [0, -1, 1.5, "1", undefined]) {
      expect(validateControlRequest({ op: "status", instanceId: "inst-1", generation }, MODELS).error).toBeDefined();
    }
    expect(validateControlRequest({ ...target, op: "reboot" }, MODELS).error).toBeDefined();
  });

  it("takes an answer as one string or a list of strings, for the question its ref names", () => {
    const ref = { instanceId: "inst-1", generation: 3, reqId: 4, titleHash: titleHash(QUESTION_TITLE) };
    expect(validateControlRequest({ ...target, op: "answer", value: "Approve", ref: REF }, MODELS).req?.command).toEqual({ op: "answer", value: "Approve", ref });
    // A reqId beside the ref, as an older client sends it, is ignored.
    expect(validateControlRequest({ ...target, op: "answer", value: ["a", "b"], ref: REF, reqId: 7 }, MODELS).req?.command).toEqual({
      op: "answer",
      value: ["a", "b"],
      ref,
    });
    for (const value of [undefined, null, 3, [], [1], { a: 1 }, "x".repeat(4001)]) {
      expect(validateControlRequest({ ...target, op: "answer", value, ref: REF }, MODELS).error).toBeDefined();
    }
    for (const bad of [undefined, 4, "", "inst-1:3:4", "inst-1:3:0:abcdef12", "inst-1:3:4:ABCDEF12", "inst-1:x:4:abcdef12", `${REF}0`]) {
      expect(validateControlRequest({ ...target, op: "answer", value: "a", ref: bad, reqId: 4 }, MODELS).error).toStartWith("ref must be");
    }
  });

  it("caps prompt text by its size as JSON in bytes, not its characters", () => {
    expect(validateControlRequest({ ...target, op: "prompt", text: "go on" }, MODELS).req?.command).toEqual({ op: "prompt", text: "go on" });
    for (const text of [undefined, "", "   ", 5]) {
      expect(validateControlRequest({ ...target, op: "prompt", text }, MODELS).error).toBeDefined();
    }
    // 20,000 Cyrillic letters are 40,002 bytes as JSON; 31,000 are 62,002, past the 61,440 cap.
    expect(validateControlRequest({ ...target, op: "prompt", text: "ж".repeat(20_000) }, MODELS).error).toBeUndefined();
    expect(validateControlRequest({ ...target, op: "prompt", text: "ж".repeat(31_000) }, MODELS).error).toBe("text must be a non-empty string of at most 61440 bytes as JSON");
  });

  it("takes abort with an optional force flag", () => {
    expect(validateControlRequest({ ...target, op: "abort" }, MODELS).req?.command).toEqual({ op: "abort" });
    expect(validateControlRequest({ ...target, op: "abort", force: false }, MODELS).req?.command).toEqual({ op: "abort" });
    expect(validateControlRequest({ ...target, op: "abort", force: true }, MODELS).req?.command).toEqual({ op: "abort", force: true });
    expect(validateControlRequest({ ...target, op: "abort", force: "yes" }, MODELS).error).toBe("force must be a boolean");
  });
});

describe("handleControl", () => {
  it("sends to the host's pid with the session id from the host list, not the request body", async () => {
    const { calls, send } = fakeSend({ kind: "reply", body: { ok: true, ...statusData } });
    await handleControl({ ...target, op: "set-thinking", level: "low", sessionId: "sess-forged", v: 9 }, [controlHost], SETTINGS, NO_UI, LOCAL, send);
    expect(calls).toEqual([{ pid: 4242, payload: { v: 1, op: "set-thinking", level: "low", sessionId: "sess-live" } }]);
  });

  it("adds model presets and thinking levels to a status reply", async () => {
    const { send } = fakeSend({ kind: "reply", body: { ok: true, ...statusData } });
    const res = await handleControl({ ...target, op: "status" }, [controlHost], SETTINGS, NO_UI, LOCAL, send);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ...statusData,
      presets: [
        { id: "opus-5.5-xhigh", label: "Claude Opus 5.5 · xhigh", model: "anthropic/claude-opus-5-5", thinking: "xhigh" },
        { id: "sonnet-5.5-medium", label: "Claude Sonnet 5.5 · medium", model: "anthropic/claude-sonnet-5-5", thinking: "medium" },
        { id: "opus-own-thinking", label: "Opus, own thinking", model: "anthropic/claude-opus-5-5", thinking: null },
      ],
      thinkingLevels: THINKING_LEVELS,
    });
  });

  it("returns the extension's data for other ops without presets", async () => {
    const { send } = fakeSend({ kind: "reply", body: { ok: true, started: true } });
    expect(await handleControl({ ...target, op: "compact" }, [controlHost], SETTINGS, NO_UI, LOCAL, send)).toEqual({ status: 200, body: { started: true } });
  });

  it("refuses before contacting the session when the target is wrong", async () => {
    const { calls, send } = fakeSend({ kind: "reply", body: { ok: true } });
    expect((await handleControl({ ...target, op: "nope" }, [controlHost], SETTINGS, NO_UI, LOCAL, send)).status).toBe(400);
    expect((await handleControl({ ...target, instanceId: "gone", op: "status" }, [controlHost], SETTINGS, NO_UI, LOCAL, send)).status).toBe(404);
    expect((await handleControl({ ...target, generation: 2, op: "status" }, [controlHost], SETTINGS, NO_UI, LOCAL, send)).status).toBe(409);
    expect((await handleControl({ ...target, op: "status" }, [{ ...controlHost, access: "view" }], SETTINGS, NO_UI, LOCAL, send)).status).toBe(403);
    expect((await handleControl({ ...target, op: "status" }, [{ ...controlHost, pid: 0 }], SETTINGS, NO_UI, LOCAL, send)).status).toBe(502);
    expect(calls).toEqual([]);
  });

  it("serves pending, answer, prompt and abort only on the local API", async () => {
    const waiting = { ...controlHost, inputRequired: true };
    const { calls, ui } = fakeUi();
    const { calls: sent, send } = fakeSend({ kind: "reply", body: { ok: true, ...statusData } });
    for (const body of [
      { op: "pending" },
      { op: "answer", value: "Approve", ref: REF },
      { op: "prompt", text: "go on" },
      { op: "abort", force: true },
      { op: "answer" },
    ]) {
      expect(await handleControl({ ...target, ...body }, [waiting], SETTINGS, ui, TAILNET, send)).toEqual({ status: 404, body: { error: "Not found" } });
    }
    expect(calls).toEqual([]);
    expect(sent).toEqual([]);
    expect((await handleControl({ ...target, op: "status" }, [controlHost], SETTINGS, ui, TAILNET, send)).status).toBe(200);
  });

  it("reports a session without the extension as 503 no_extension", async () => {
    const { send } = fakeSend({ kind: "no_extension" });
    const res = await handleControl({ ...target, op: "status" }, [controlHost], SETTINGS, NO_UI, LOCAL, send);
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("no_extension");
  });

  it("maps extension error codes to HTTP statuses", async () => {
    const cases: [string | undefined, number][] = [
      ["session_mismatch", 409],
      ["busy", 409],
      ["input_required", 409],
      ["bad_request", 400],
      ["not_found", 404],
      ["failed", 502],
      ["constructor", 502],
      [undefined, 502],
    ];
    for (const [code, status] of cases) {
      const { send } = fakeSend({ kind: "reply", body: { ok: false, error: "nope", code } });
      const res = await handleControl({ ...target, op: "skill", name: "ping" }, [controlHost], SETTINGS, NO_UI, LOCAL, send);
      expect(res).toEqual({ status, body: { error: "nope", code: code ?? "failed" } });
    }
  });

  it("turns a transport failure into a 502 with its message", async () => {
    const { send } = fakeSend({ kind: "error", error: "Session did not answer within 10s" });
    expect(await handleControl({ ...target, op: "status" }, [controlHost], SETTINGS, NO_UI, LOCAL, send)).toEqual({
      status: 502,
      body: { error: "Session did not answer within 10s" },
    });
  });

  it("refuses dev cycles with code disabled before looking up the session when they are turned off", async () => {
    const off = { models: MODELS, devCycles: false, ownerOnlyWords: [] };
    const { calls, send } = fakeSend({ kind: "reply", body: { ok: true, ...statusData, cycle: { commands: [{ name: "x" }], state: null } } });
    expect(await handleControl({ instanceId: "zz-none", generation: 1, op: "cycle", action: "stop" }, [controlHost], off, NO_UI, LOCAL, send)).toEqual({
      status: 400,
      body: { error: "Dev cycles are turned off on this server", code: "disabled" },
    });
    expect(calls).toEqual([]);
    const res = await handleControl({ ...target, op: "status" }, [controlHost], off, NO_UI, LOCAL, send);
    expect(res.body.cycle).toEqual({ commands: [], state: null });
  });

  it("reads no question without joining a session that is not waiting on one", async () => {
    const { calls, ui } = fakeUi();
    const { calls: sent, send } = fakeSend({ kind: "reply", body: { ok: true } });
    expect(await handleControl({ ...target, op: "pending" }, [controlHost], SETTINGS, ui, LOCAL, send)).toEqual({ status: 200, body: { pending: null, queued: 0 } });
    expect(await handleControl({ ...target, op: "answer", value: "Approve", ref: REF }, [controlHost], SETTINGS, ui, LOCAL, send)).toEqual({
      status: 409,
      body: { error: "The session is not waiting on a question any more; read pending again", code: "changed" },
    });
    expect(calls).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("adds the question's ref to pending, and answers the question the ref names before the deadline", async () => {
    const waiting = { ...controlHost, inputRequired: true };
    const question = { reqId: 4, kind: "approval" as const, title: QUESTION_TITLE, options: [{ label: "Approve" }, { label: "Deny" }], since: null };
    const pending = fakeUi({ ok: true, value: { pending: question, queued: 0 } });
    expect(await handleControl({ ...target, op: "pending" }, [waiting], SETTINGS, pending.ui, LOCAL)).toEqual({
      status: 200,
      body: { pending: { ...question, ref: REF }, queued: 0 },
    });
    expect(pending.calls[0].signal).toBe(LOCAL.signal);
    expect(pending.calls[0].words).toEqual(["zz-owner-word"]);
    const next = { ...question, reqId: 5, title: "Second?" };
    const answer = fakeUi({ ok: true, value: { answered: 4, next } });
    expect(await handleControl({ ...target, op: "answer", value: "Deny", ref: REF }, [waiting], SETTINGS, answer.ui, LOCAL)).toEqual({
      status: 200,
      body: { answered: 4, next: { ...next, ref: `inst-1:3:5:${titleHash("Second?")}` } },
    });
    expect(answer.calls).toEqual([{ op: "answer", value: "Deny", target: { reqId: 4, titleHash: titleHash(QUESTION_TITLE) }, words: ["zz-owner-word"], signal: LOCAL.signal }]);
  });

  it("answers 409 changed when the ref's chat, generation or process is not the live one", async () => {
    const waiting = { ...controlHost, inputRequired: true };
    const { calls, ui } = fakeUi({ ok: true, value: { answered: 4, next: null } });
    const cases: [Record<string, unknown>, CliHost[]][] = [
      [{ ...target, ref: `inst-1:2:4:${titleHash(QUESTION_TITLE)}` }, [waiting]],
      [{ ...target, ref: `inst-9:3:4:${titleHash(QUESTION_TITLE)}` }, [waiting]],
      [{ ...target, ref: REF }, []],
      [{ ...target, ref: REF }, [{ ...waiting, generation: 4 }]],
    ];
    for (const [body, hosts] of cases) {
      const res = await handleControl({ ...body, op: "answer", value: "Deny" }, hosts, SETTINGS, ui, LOCAL);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe("changed");
    }
    expect(calls).toEqual([]);
  });

  it("maps guest error codes to HTTP statuses", async () => {
    const waiting = { ...controlHost, inputRequired: true };
    const cases = [
      ["changed", 409],
      ["busy", 409],
      ["bad_request", 400],
      ["owner_only", 403],
      ["rejected", 422],
      ["timeout", 504],
      ["outcome_unknown", 504],
      ["protocol", 502],
      ["failed", 502],
    ] as const;
    for (const [code, status] of cases) {
      const { ui } = fakeUi({ ok: false, code, error: "nope" });
      expect(await handleControl({ ...target, op: "answer", value: "x", ref: REF }, [waiting], SETTINGS, ui, LOCAL)).toEqual({ status, body: { error: "nope", code } });
    }
  });

  it("fails loudly when omp reports a question that never reached the guest", async () => {
    const waiting = { ...controlHost, inputRequired: true };
    const none = fakeUi({ ok: true, value: { pending: null, queued: 0 } });
    expect(await handleControl({ ...target, op: "pending" }, [waiting], SETTINGS, none.ui, local([waiting]))).toMatchObject({ status: 502, body: { code: "protocol" } });
    // Answered in the meantime: the fresh list no longer shows a question.
    expect(await handleControl({ ...target, op: "pending" }, [waiting], SETTINGS, none.ui, local([controlHost]))).toEqual({ status: 200, body: { pending: null, queued: 0 } });
    const gone = fakeUi({ ok: false, code: "nothing_pending", error: "nope" });
    expect(await handleControl({ ...target, op: "answer", value: "x", ref: REF }, [waiting], SETTINGS, gone.ui, local([waiting]))).toMatchObject({ status: 502, body: { code: "protocol" } });
    expect(await handleControl({ ...target, op: "answer", value: "x", ref: REF }, [waiting], SETTINGS, gone.ui, local([controlHost]))).toMatchObject({ status: 409, body: { code: "changed" } });
  });

  it("refuses a prompt, a skill, a cycle start and an unforced abort while the session waits on a question", async () => {
    const waiting = { ...controlHost, inputRequired: true };
    const { calls, send } = fakeSend({ kind: "reply", body: { ok: true } });
    for (const body of [
      { op: "prompt", text: "go on" },
      { op: "skill", name: "ping" },
      { op: "cycle", action: "start", command: "feature-cycle" },
      { op: "abort" },
    ]) {
      const res = await handleControl({ ...target, ...body }, [waiting], SETTINGS, NO_UI, LOCAL, send);
      expect(res).toMatchObject({ status: 409, body: { code: "input_required" } });
    }
    expect(calls).toEqual([]);
    await handleControl({ ...target, op: "abort", force: true }, [waiting], SETTINGS, NO_UI, LOCAL, send);
    await handleControl({ ...target, op: "cycle", action: "stop" }, [waiting], SETTINGS, NO_UI, LOCAL, send);
    await handleControl({ ...target, op: "prompt", text: "go on" }, [controlHost], SETTINGS, NO_UI, LOCAL, send);
    expect(calls.map((c) => c.payload)).toEqual([
      { v: 1, op: "abort", force: true, sessionId: "sess-live" },
      { v: 1, op: "cycle", action: "stop", sessionId: "sess-live" },
      { v: 1, op: "prompt", text: "go on", sessionId: "sess-live" },
    ]);
  });
});

describe("collabUiRelay", () => {
  it("lets one request at a time talk to a chat", async () => {
    const link = Promise.withResolvers<string>();
    const relay = collabUiRelay(() => link.promise);
    const first = relay.pending(controlHost, [], new AbortController().signal);
    expect(await relay.answer(controlHost, "Deny", { reqId: 1, titleHash: "abcdef12" }, [], new AbortController().signal)).toMatchObject({ ok: false, code: "busy" });
    link.reject(new Error("no link"));
    expect(await first).toEqual({ ok: false, code: "failed", error: "no link" });
    // Free again once the first request is done.
    expect(await relay.pending(controlHost, [], new AbortController().signal)).toEqual({ ok: false, code: "failed", error: "no link" });
  });
});
