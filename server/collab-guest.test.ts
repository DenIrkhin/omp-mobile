import { afterEach, describe, expect, it } from "bun:test";
import { answerPending, describeRequest, parseCollabLink, readPending, titleHash } from "./collab-guest";

const KEY = new Uint8Array(32).fill(7);
const TOKEN = new Uint8Array(16).fill(9);
const SECRET = Buffer.concat([KEY, TOKEN]).toString("base64url");

const OTHER = "Other (type your own)";
const NEXT = "Next →";
const SELECT_HELP = "↑/↓ navigate  ⏎ select  ⎋ cancel";

// `ui-request` frames a throwaway omp 18.20.0 chat sent to a Collab guest on 2026-11-13: a bash
// approval (tools.approvalMode always-ask), then two `ask` forms. Form 1: a radio field with no
// default answered through Other, and a checkbox field (Dog toggled, then Other with free text).
// Form 2: a radio field with Medium checked, and a text field with minlength 3 answered "ab"
// first. Each list is the requests in the order they came, for the answers named beside them.
const RECORDED = {
  approval: { kind: "select", title: "Allow tool: bash\nCommand: echo hello-approval", options: ["Approve", "Approve bash for this session", "Deny"], approval: true, reqId: 1 },
  // Answers: Other, "Purple".
  radioOther: [
    { kind: "select", title: "Pick a color", options: ["Red", "Blue", "Green", OTHER], initialIndex: 0, selectionMarker: "radio", helpText: SELECT_HELP, reqId: 2 },
    { kind: "editor", title: "Pick a color", reqId: 3 },
  ],
  // Answers: Dog, Other, "Hamster", Next.
  checkbox: [
    { kind: "select", title: "Which pets?", options: ["Cat", "Dog", "Fish", OTHER, NEXT], selectionMarker: "checkbox", checkedIndices: [], markableCount: 4, helpText: "↑/↓ navigate  ⏎ toggle  Next → continue  ⎋ cancel", reqId: 4 },
    { kind: "select", title: "Which pets?", options: ["Cat", "Dog", "Fish", OTHER, NEXT], selectionMarker: "checkbox", checkedIndices: [1], markableCount: 4, helpText: "↑/↓ navigate  ⏎ toggle  Next → continue  ⎋ cancel", reqId: 5 },
    { kind: "editor", title: "Which pets?", reqId: 6 },
    { kind: "select", title: "Which pets?", options: ["Cat", "Dog", "Fish", OTHER, NEXT], selectionMarker: "checkbox", checkedIndices: [1, 3], markableCount: 4, helpText: "↑/↓ navigate  ⏎ toggle  Next → continue  ⎋ cancel", reqId: 7 },
  ],
  // Answer: Medium.
  radioDefault: { kind: "select", title: "Pick a size", options: ["Small", "Medium", "Large", OTHER], initialIndex: 1, selectionMarker: "radio", helpText: SELECT_HELP, reqId: 8 },
  // Answers: "ab", then "abc". The re-shown field came before the end of the first request.
  text: [
    { kind: "editor", title: "Your nickname", prefill: "", reqId: 9 },
    { kind: "editor", title: "Your nickname (Needs at least 3 characters)", prefill: "ab", reqId: 10 },
  ],
};

type Field =
  | { type: "approval"; title: string; options: string[] }
  | { type: "radio"; title: string; options: string[]; checked?: number }
  | { type: "checkbox"; title: string; options: string[] }
  | { type: "text"; title: string; minLength: number };

type Request = Record<string, unknown> & { reqId: number; title: string };
type Step = { end: number; next: Request | null; nextFirst?: boolean };

/**
 * omp 18.20.0's form dialog for guests (extension-ui-controller.ts formDialog), field by field:
 * the requests it poses and how it takes each answer. The first test checks it poses what the
 * recorded chat did.
 */
function formHost(fields: Field[], firstReqId: number) {
  let reqId = firstReqId - 1;
  let index = 0;
  let mode: "list" | "editor" = "list";
  let checked = new Set<number>();
  let otherText: string | undefined;
  let text = "";
  let error: string | undefined;
  const answers: Record<string, unknown> = {};

  const pose = (): Request | null => {
    const field = fields[index];
    if (!field) return null;
    reqId++;
    if (field.type === "approval") return { kind: "select", title: field.title, options: field.options, approval: true, reqId };
    if (field.type === "text") return { kind: "editor", title: error ? `${field.title} (${error})` : field.title, prefill: text, reqId };
    if (mode === "editor") return { kind: "editor", title: field.title, reqId };
    if (field.type === "radio") {
      return { kind: "select", title: field.title, options: [...field.options, OTHER], initialIndex: Math.max(0, field.checked ?? 0), selectionMarker: "radio", helpText: SELECT_HELP, reqId };
    }
    const indices = field.options.flatMap((_, i) => (checked.has(i) ? [i] : []));
    if (otherText !== undefined) indices.push(field.options.length);
    return {
      kind: "select",
      title: field.title,
      options: [...field.options, OTHER, NEXT],
      selectionMarker: "checkbox",
      checkedIndices: indices,
      markableCount: field.options.length + 1,
      helpText: "↑/↓ navigate  ⏎ toggle  Next → continue  ⎋ cancel",
      reqId,
    };
  };
  // The request open now; omp replays it, reqId unchanged, to each guest that joins.
  let opened: Request | null = null;
  const request = () => (opened = pose());
  const advance = (title: string, answer: unknown) => {
    answers[title] = answer;
    index++;
    mode = "list";
    checked = new Set();
    otherText = undefined;
    text = "";
    error = undefined;
    return request();
  };

  return {
    answers,
    first: () => opened ?? request(),
    respond(value: string): Step {
      const end = reqId;
      const field = fields[index];
      if (field.type === "approval") return { end, next: advance(field.title, value) };
      if (field.type === "text") {
        if (value.length < field.minLength) {
          text = value;
          error = `Needs at least ${field.minLength} characters`;
          return { end, next: request(), nextFirst: true };
        }
        return { end, next: advance(field.title, value) };
      }
      if (field.type === "radio") {
        if (mode === "editor") {
          mode = "list";
          return { end, next: value.trim() ? advance(field.title, value) : request() };
        }
        if (value === OTHER) {
          mode = "editor";
          return { end, next: request() };
        }
        return { end, next: advance(field.title, field.options.includes(value) ? value : undefined) };
      }
      if (mode === "editor") {
        mode = "list";
        if (value.trim()) otherText = value;
        return { end, next: request() };
      }
      if (value === NEXT) return { end, next: advance(field.title, { checked: field.options.filter((_, i) => checked.has(i)), other: otherText }) };
      if (value === OTHER) {
        if (otherText !== undefined) otherText = undefined;
        else mode = "editor";
        return { end, next: request() };
      }
      const i = field.options.indexOf(value);
      if (i >= 0 && !checked.delete(i)) checked.add(i);
      return { end, next: request() };
    },
  };
}

const FORM_1: Field[] = [
  { type: "radio", title: "Pick a color", options: ["Red", "Blue", "Green"] },
  { type: "checkbox", title: "Which pets?", options: ["Cat", "Dog", "Fish"] },
];
const FORM_2: Field[] = [
  { type: "radio", title: "Pick a size", options: ["Small", "Medium", "Large"], checked: 1 },
  { type: "text", title: "Your nickname", minLength: 3 },
];
const APPROVAL: Field = { type: "approval", title: RECORDED.approval.title, options: RECORDED.approval.options };

describe("formHost", () => {
  it("poses what omp 18.20.0 posed for the same answers", () => {
    const approval = formHost([APPROVAL], 1);
    expect(approval.first()).toEqual(RECORDED.approval);
    const form1 = formHost(FORM_1, 2);
    const seen = [form1.first()];
    for (const value of [OTHER, "Purple", "Dog", OTHER, "Hamster"]) seen.push(form1.respond(value).next);
    expect(seen).toEqual([...RECORDED.radioOther, ...RECORDED.checkbox]);
    const form2 = formHost(FORM_2, 8);
    expect([form2.first(), form2.respond("Medium").next, form2.respond("ab").next]).toEqual([RECORDED.radioDefault, ...RECORDED.text]);
  });
});

describe("parseCollabLink", () => {
  it("reads the default relay, a custom relay, and a web link", () => {
    const room = "AbCdEfGhIjKlMnOp";
    for (const link of [`${room}.${SECRET}`, `https://my.omp.sh/#${room}.${SECRET}`]) {
      const parsed = parseCollabLink(link);
      expect(parsed).toMatchObject({ wsUrl: `wss://my.omp.sh/r/${room}` });
      if ("error" in parsed) throw new Error(parsed.error);
      expect([...parsed.key]).toEqual([...KEY]);
      expect([...(parsed.writeToken ?? [])]).toEqual([...TOKEN]);
    }
    expect(parseCollabLink(`relay.example:8443/r/${room}.${SECRET}`)).toMatchObject({ wsUrl: `wss://relay.example:8443/r/${room}` });
    expect(parseCollabLink(`ws://relay.example/r/${room}.${SECRET}`)).toHaveProperty("error");
  });
});

describe("describeRequest", () => {
  it("names no recommended option: omp preselects row 0 of a list with no default", () => {
    expect(describeRequest(RECORDED.radioOther[0] as never, null, [])).toEqual({
      reqId: 2,
      kind: "ask",
      title: "Pick a color",
      options: [{ label: "Red" }, { label: "Blue" }, { label: "Green" }],
      multi: false,
      other: true,
      since: null,
    });
    expect(describeRequest(RECORDED.radioDefault as never, null, [])).not.toHaveProperty("recommended");
  });

  it("shows a form checkbox field's own options and checks, apart from Other and Next", () => {
    expect(describeRequest(RECORDED.checkbox[3] as never, "2026-11-13T10:00:00.000Z", [])).toEqual({
      reqId: 7,
      kind: "ask",
      title: "Which pets?",
      options: [{ label: "Cat" }, { label: "Dog" }, { label: "Fish" }],
      multi: true,
      checked: ["Dog"],
      other: true,
      since: "2026-11-13T10:00:00.000Z",
    });
  });

  it("marks a tool approval, and a question only the owner may answer", () => {
    expect(describeRequest(RECORDED.approval as never, null, [])).toEqual({
      reqId: 1,
      kind: "approval",
      title: "Allow tool: bash\nCommand: echo hello-approval",
      options: [{ label: "Approve" }, { label: "Approve bash for this session" }, { label: "Deny" }],
      since: null,
    });
    for (const command of ["kubectl apply -f x.yml", "git push --force", "rm -rf build", "gh pr merge 4"]) {
      expect(describeRequest({ ...RECORDED.approval, title: `Allow tool: bash\nCommand: ${command}` } as never, null, []).ownerOnly).toBe(true);
    }
  });

  it("marks a question owner-only when its title holds one of the config's words, ignoring case", () => {
    const request = { ...RECORDED.approval, title: "Allow tool: bash\nCommand: curl https://api.payments.example.com/charge" } as never;
    expect(describeRequest(request, null, ["Payments.Example.com"]).ownerOnly).toBe(true);
    expect(describeRequest(request, null, [])).not.toHaveProperty("ownerOnly");
  });
});

type Received = { t: string; reqId?: number; value?: string };

// A fake relay + host on localhost that seals frames with the room key the way omp does.
describe("guest against a fake host", () => {
  let stop: (() => void) | undefined;
  afterEach(() => stop?.());

  /**
   * Hosts `fields` as one form (from reqId `firstReqId`). `extra`: another dialog open at the
   * same time; `extraAfterFirstAnswer` sends it only after the first answer, before the next step.
   * `silent`: never welcome the guest; `hangOnAnswer`: never end a request.
   */
  async function startHost(
    fields: Field[],
    opts: { firstReqId?: number; extra?: Request; extraAfterFirstAnswer?: boolean; silent?: boolean; hangOnAnswer?: boolean } = {}
  ) {
    const key = await crypto.subtle.importKey("raw", KEY, "AES-GCM", false, ["encrypt", "decrypt"]);
    const received: Received[] = [];
    const host = formHost(fields, opts.firstReqId ?? 1);
    const seal = async (frame: object) => {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const body = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(frame))));
      return Buffer.concat([new Uint8Array(4), iv, body]);
    };
    let first = true;
    const server = Bun.serve({
      port: 0,
      fetch: (req, srv) => (srv.upgrade(req) ? undefined : new Response("no", { status: 400 })),
      websocket: {
        async message(ws, data) {
          const bytes = new Uint8Array(data as Buffer);
          const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.subarray(4, 16) }, key, bytes.subarray(16));
          const frame = JSON.parse(new TextDecoder().decode(plain));
          received.push(frame);
          if (frame.t === "hello") {
            if (opts.silent) return;
            ws.send(await seal({ t: "welcome", proto: 3, entryCount: 1 }));
            ws.send(await seal({ t: "snapshot-chunk", entries: [{ timestamp: "2026-11-13T09:00:00.000Z" }], final: true }));
            const open = host.first();
            if (open) ws.send(await seal({ t: "ui-request", request: open }));
            if (opts.extra && !opts.extraAfterFirstAnswer) ws.send(await seal({ t: "ui-request", request: opts.extra }));
          } else if (frame.t === "ui-response") {
            if (opts.hangOnAnswer) return;
            if (opts.extra && frame.reqId === opts.extra.reqId) {
              ws.send(await seal({ t: "ui-request-end", reqId: frame.reqId }));
              return;
            }
            const step = host.respond(frame.value);
            const end = await seal({ t: "ui-request-end", reqId: step.end });
            const next = step.next ? await seal({ t: "ui-request", request: step.next }) : null;
            if (!step.nextFirst) ws.send(end);
            if (first && opts.extra && opts.extraAfterFirstAnswer) ws.send(await seal({ t: "ui-request", request: opts.extra }));
            first = false;
            if (next) ws.send(next);
            if (step.nextFirst) ws.send(end);
          }
        },
      },
    });
    stop = () => server.stop(true);
    return { link: `ws://localhost:${server.port}/r/AbCdEfGhIjKlMnOp.${SECRET}`, received, answers: host.answers };
  }

  const signal = () => new AbortController().signal;
  const target = (request: { reqId: number; title: string }) => ({ reqId: request.reqId, titleHash: titleHash(request.title) });
  const responses = (received: Received[]) => received.filter((f) => f.t === "ui-response").map((f) => f.value);

  it("reads the open question with the time of the last transcript entry", async () => {
    const { link } = await startHost(FORM_1, { firstReqId: 2 });
    expect(await readPending(link, "test", [], signal())).toEqual({
      ok: true,
      value: { pending: describeRequest(RECORDED.radioOther[0] as never, "2026-11-13T09:00:00.000Z", []), queued: 0 },
    });
  });

  it("answers an approval once, and refuses a grant for the session before sending anything", async () => {
    const refused = await startHost([APPROVAL]);
    expect(await answerPending(refused.link, "test", "Approve bash for this session", target(RECORDED.approval), [], signal())).toMatchObject({ ok: false, code: "owner_only" });
    expect(responses(refused.received)).toEqual([]);
    stop?.();
    for (const value of ["Approve", "Deny"]) {
      const { link, answers } = await startHost([APPROVAL]);
      expect(await answerPending(link, "test", value, target(RECORDED.approval), [], signal())).toEqual({ ok: true, value: { answered: 1, next: null } });
      expect(answers).toEqual({ [RECORDED.approval.title]: value });
      stop?.();
    }
  });

  it("refuses any answer to a question only the owner may answer", async () => {
    const title = "Allow tool: bash\nCommand: kubectl delete pod alpha";
    const { link, received } = await startHost([{ ...APPROVAL, title }]);
    expect(await answerPending(link, "test", "Deny", { reqId: 1, titleHash: titleHash(title) }, [], signal())).toMatchObject({ ok: false, code: "owner_only" });
    expect(responses(received)).toEqual([]);
  });

  it("refuses any answer to a question whose title holds one of the config's words", async () => {
    const title = "Allow tool: bash\nCommand: curl https://api.payments.example.com/charge";
    const { link, received } = await startHost([{ ...APPROVAL, title }]);
    expect(await answerPending(link, "test", "Deny", { reqId: 1, titleHash: titleHash(title) }, ["payments.example.com"], signal())).toMatchObject({ ok: false, code: "owner_only" });
    expect(responses(received)).toEqual([]);
  });

  it("answers changed when the reqId holds another question or none", async () => {
    const { link, received } = await startHost([APPROVAL]);
    expect(await answerPending(link, "test", "Approve", { reqId: 1, titleHash: titleHash("Allow tool: bash\nCommand: echo other") }, [], signal())).toMatchObject({ ok: false, code: "changed" });
    expect(await answerPending(link, "test", "Approve", { reqId: 2, titleHash: titleHash(RECORDED.approval.title) }, [], signal())).toMatchObject({ ok: false, code: "changed" });
    expect(responses(received)).toEqual([]);
  });

  it("answers a radio field through Other with free text, and reports the next field", async () => {
    const { link, received, answers } = await startHost(FORM_1, { firstReqId: 2 });
    const result = await answerPending(link, "test", "Purple", target(RECORDED.radioOther[0]), [], signal());
    expect(result).toMatchObject({ ok: true, value: { answered: 2, next: { reqId: 4, kind: "ask", title: "Which pets?", multi: true } } });
    expect(responses(received)).toEqual([OTHER, "Purple"]);
    expect(answers).toEqual({ "Pick a color": "Purple" });
  });

  it("sets a checkbox field's choices and free text, then presses Next", async () => {
    const { link, received, answers } = await startHost([FORM_1[1]], { firstReqId: 4 });
    const result = await answerPending(link, "test", ["Dog", "Hamster"], target(RECORDED.checkbox[0]), [], signal());
    expect(result).toEqual({ ok: true, value: { answered: 4, next: null } });
    expect(responses(received)).toEqual(["Dog", OTHER, "Hamster", NEXT]);
    expect(answers).toEqual({ "Which pets?": { checked: ["Dog"], other: "Hamster" } });
  });

  it("reports rejected when the chat shows the same field again", async () => {
    const { link, answers } = await startHost([FORM_2[1]], { firstReqId: 9 });
    expect(await answerPending(link, "test", "ab", target(RECORDED.text[0]), [], signal())).toMatchObject({ ok: false, code: "rejected" });
    expect(answers).toEqual({});
  });

  it("refuses more than one free-text answer before sending anything", async () => {
    const { link, received } = await startHost([FORM_1[1]], { firstReqId: 4 });
    expect(await answerPending(link, "test", ["Purple", "Pink"], target(RECORDED.checkbox[0]), [], signal())).toMatchObject({ ok: false, code: "bad_request" });
    expect(responses(received)).toEqual([]);
  });

  it("with two dialogs open, reads the oldest and never takes the other for a step", async () => {
    const extra = { ...RECORDED.approval, reqId: 30 };
    const both = await startHost([FORM_1[1]], { firstReqId: 4, extra });
    expect(await readPending(both.link, "test", [], signal())).toMatchObject({ ok: true, value: { pending: { reqId: 4 }, queued: 1 } });
    stop?.();
    // The approval arrives after the first toggle, before the list is shown again.
    const late = await startHost([FORM_1[1]], { firstReqId: 4, extra, extraAfterFirstAnswer: true });
    const result = await answerPending(late.link, "test", ["Cat", "Fish"], target(RECORDED.checkbox[0]), [], signal());
    expect(result).toMatchObject({ ok: true, value: { answered: 4 } });
    expect(late.received.filter((f) => f.t === "ui-response").map((f) => f.reqId)).not.toContain(30);
    expect(late.answers).toEqual({ "Which pets?": { checked: ["Cat", "Fish"] } });
  });

  it("gives up at the deadline with nothing sent when the chat never answers the join", async () => {
    const { link, received } = await startHost(FORM_1, { silent: true });
    const result = await answerPending(link, "test", "Red", { reqId: 1, titleHash: titleHash("Pick a color") }, [], AbortSignal.timeout(300));
    expect(result).toMatchObject({ ok: false, code: "timeout" });
    expect(responses(received)).toEqual([]);
  });

  it("reports outcome_unknown when the deadline passes after an answer was sent", async () => {
    const { link, received } = await startHost([APPROVAL], { hangOnAnswer: true });
    const result = await answerPending(link, "test", "Deny", target(RECORDED.approval), [], AbortSignal.timeout(1_500));
    expect(result).toMatchObject({ ok: false, code: "outcome_unknown" });
    expect(responses(received)).toEqual(["Deny"]);
  });

  it("sends nothing once the caller has gone", async () => {
    const { link, received } = await startHost([APPROVAL]);
    const gone = new AbortController();
    gone.abort(new Error("caller hung up"));
    expect(await answerPending(link, "test", "Deny", target(RECORDED.approval), [], gone.signal)).toMatchObject({ ok: false, code: "timeout" });
    expect(received).toEqual([]);
  });
});
