// A headless Collab guest that joins a chat's room for one request, to read or answer the
// question the chat is waiting on: an `ask` question, a tool approval, or an extension's
// select or editor dialog.
//
// omp keeps these dialogs out of an extension's reach (no event or context call shows or
// resolves them), but while a chat hosts a Collab room it mirrors every one of them to
// writable guests as a `ui-request` frame and settles the dialog with the first answer, local
// or remote (omp collab/host.ts requestGuestUi, modes/controllers/extension-ui-controller.ts).
// An answer sent here is the same `ui-response` the phone page sends when the user taps an
// option. The protocol mirrors the vendored web guest in .collab-build (collab-web/src/lib:
// link.ts, codec.ts, socket.ts) and wire/src/index.ts.
//
// Cost: every join makes the host send the whole transcript as `snapshot-chunk` frames before
// the pending asks, and shows "<name> joined the collab session" in the chat. Call it for
// chats whose host list entry says `inputRequired`.
import { createHash } from "node:crypto";

const COLLAB_PROTO = 3;
const DEFAULT_RELAY_URL = "wss://my.omp.sh";
const ROOM_KEY_BYTES = 32;
const WRITE_TOKEN_BYTES = 16;
const IV_BYTES = 12;
const ENVELOPE_HEADER_BYTES = 4;
const ROOM_PATH = /^\/r\/([A-Za-z0-9_-]{10,64})(?:\.([A-Za-z0-9_-]+))?$/;
const BARE_LINK = /^([A-Za-z0-9_-]{10,64})[#.]([A-Za-z0-9_-]+)$/;
const B64URL = /^[A-Za-z0-9_-]+$/;
const LOCAL_HOSTS: Record<string, true> = { localhost: true, "127.0.0.1": true, "::1": true, "[::1]": true };

// The rows omp adds to an ask question's option list. Three flows post them:
// - an ask form field (omp 18.20 `ask`; extension-ui-controller.ts form dialog): a radio list is
//   the choices plus Other, with no `markableCount`; a checkbox list is the choices plus a
//   markable Other, then Next once the field may be left. Other leads to a mirrored editor with
//   the field's title; after it a checkbox list is shown again with Other checked.
// - the guest mirror of an ask dialog: choices, then Other, Next and Chat rows past
//   `markableCount`; Other leads to a mirrored editor;
// - the ask tool's own select loop (tools/ask.ts askChoice): choices and Other all markable,
//   then a "<icon> Done selecting" row; its Other leads to a local-only input box no guest sees.
const OTHER_OPTION = "Other (type your own)";
const CHAT_OPTION = "Chat about this";
const NEXT_OPTION = "Next →";
const DONE_SUFFIX = " Done selecting";

// A tool approval offers grant labels, their "always" variants, Approve (or Approve Once), a
// "for this session" label and Deny (omp 18.20 approval select). A guest may give only a
// one-time answer; any grant that outlives this call is the owner's.
const APPROVAL_ANSWERS: Record<string, true> = { Approve: true, "Approve Once": true, Deny: true, Yes: true, No: true };
// Questions whose title names production, money-adjacent or irreversible work are the owner's
// to answer, whatever the answer. The config's `control.ownerOnlyWords` adds words of its own
// (ownerOnlyTitle).
const OWNER_ONLY_TITLE = [
  /\bprod/i,
  /--force\b/,
  /\bmerge/i,
  /\brelease/i,
  /\bdeploy/i,
  /\brm\s+-(?:rf|fr)\b/i,
  /\bkubectl\b/i,
  /\bhelm\b/i,
  /\bterraform\b/i,
  /\bDROP\b/,
  /\bsecret/i,
  /\btoken/i,
];

const WELCOME_TIMEOUT_MS = 30_000;
// Each snapshot chunk must arrive within this; a large transcript takes many chunks.
const SNAPSHOT_PROGRESS_TIMEOUT_MS = 30_000;
// The pending asks follow the last snapshot chunk in the same batch.
const ASKS_QUIET_MS = 400;
// After an answer: the host ends the request, then poses the next step of a multi-step dialog.
const STEP_TIMEOUT_MS = 10_000;
const FOLLOW_UP_MS = 1_000;

type SelectItem = string | { label: string; description?: string };

type UiRequest =
  | {
      reqId: number;
      kind: "select";
      title: string;
      options: SelectItem[];
      initialIndex?: number;
      selectionMarker?: "radio" | "checkbox";
      checkedIndices?: number[];
      markableCount?: number;
      helpText?: string;
      approval?: boolean;
    }
  | { reqId: number; kind: "editor"; title: string; prefill?: string };

export type PendingOption = { label: string; description?: string };

/**
 * One question a chat is waiting on, in the shape `pending` returns.
 * - `approval`: a tool approval; `options` are its choices ("Approve", "Deny", …).
 * - `ask`: one question of an ask form; `multi` when several options can be checked.
 *   `options` are the real choices; `other` is true when a free-text answer can be given here.
 * - `select`: an extension's own pick-one list.
 * - `editor`: free text, possibly prefilled.
 * `ownerOnly` marks a question only the owner may answer (see ownerOnlyTitle).
 */
export type PendingUi = {
  reqId: number;
  kind: "approval" | "ask" | "select" | "editor";
  title: string;
  options?: PendingOption[];
  multi?: boolean;
  checked?: string[];
  other?: boolean;
  prefill?: string;
  ownerOnly?: true;
  /** ISO time the question was posed: when it arrived, or for one already open at the join, the
   *  time of the chat's last transcript entry (the message that asked it). Null when unknown. */
  since: string | null;
};

export type AnswerValue = string | string[];

export type GuestResult<T> = { ok: true; value: T } | { ok: false; code: GuestErrorCode; error: string };
/**
 * - `changed`: the question the caller read is no longer the one open.
 * - `owner_only`: the answer or the question is the owner's to give.
 * - `rejected`: the chat showed the same field again, so it did not take the answer.
 * - `protocol`: the chat did not behave as this omp version is known to.
 * - `timeout`: the deadline passed before anything was sent.
 * - `outcome_unknown`: something was sent, then the call failed; read pending again.
 * - `busy`: another request is talking to this chat.
 */
export type GuestErrorCode =
  | "nothing_pending"
  | "changed"
  | "bad_request"
  | "owner_only"
  | "rejected"
  | "protocol"
  | "timeout"
  | "outcome_unknown"
  | "busy"
  | "failed";

export type PendingReply = { pending: PendingUi | null; queued: number };
export type AnswerReply = { answered: number; next: PendingUi | null };

/** Names the question an answer is meant for: its reqId and the hash of its title. */
export type QuestionTarget = { reqId: number; titleHash: string };

/** The first 8 hex characters of the SHA-256 of `title`: the title part of a question ref. */
export function titleHash(title: string): string {
  return createHash("sha256").update(title).digest("hex").slice(0, 8);
}

/** The relay socket URL, room key and write token in a full (control) Collab link. */
export function parseCollabLink(link: string): { wsUrl: string; key: Uint8Array; writeToken?: Uint8Array } | { error: string } {
  let text = link.trim().replace(/%23/gi, "#");
  const bare = BARE_LINK.exec(text);
  if (bare) text = `${DEFAULT_RELAY_URL}/r/${bare[1]}.${bare[2]}`;
  else if (!text.includes("://")) text = `wss://${text}`;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { error: "Invalid collab link" };
  }
  if ((url.protocol === "http:" || url.protocol === "https:") && url.hash) {
    const inner = parseCollabLink(url.hash.slice(1));
    if (!("error" in inner)) return inner;
  }
  let scheme: string;
  if (url.protocol === "wss:" || url.protocol === "https:") scheme = "wss:";
  else if ((url.protocol === "ws:" || url.protocol === "http:") && LOCAL_HOSTS[url.hostname]) scheme = "ws:";
  else return { error: `Unsupported collab relay ${url.protocol}//${url.hostname}` };
  const match = ROOM_PATH.exec(url.pathname);
  if (!match) return { error: "Collab link must contain a /r/<roomId> path" };
  const keyText = match[2] ?? url.hash.slice(1);
  const secret = B64URL.test(keyText) ? new Uint8Array(Buffer.from(keyText, "base64url")) : null;
  if (!secret || (secret.byteLength !== ROOM_KEY_BYTES && secret.byteLength !== ROOM_KEY_BYTES + WRITE_TOKEN_BYTES)) {
    return { error: "Collab link key has the wrong length" };
  }
  const port = url.port ? `:${url.port}` : "";
  return {
    wsUrl: `${scheme}//${url.hostname}${port}/r/${match[1]}`,
    key: secret.subarray(0, ROOM_KEY_BYTES),
    writeToken: secret.byteLength > ROOM_KEY_BYTES ? secret.subarray(ROOM_KEY_BYTES) : undefined,
  };
}

type SelectRequest = Extract<UiRequest, { kind: "select" }>;

function selectLabels(request: SelectRequest): string[] {
  return request.options.map((item) => (typeof item === "string" ? item : item.label));
}

/**
 * The rows of an ask question's select: its real choices (row index → label), the row that
 * finishes a multi-select, and the Other row when a guest can answer its free text (an editor
 * follows it; the ask tool's own select loop opens a local-only input instead). `otherChecked`:
 * a form checkbox list already holds free text, and pressing Other clears it.
 */
function askRows(request: SelectRequest) {
  const labels = selectLabels(request);
  const markable = request.markableCount ?? labels.length;
  const localOther = labels.some((label) => label.endsWith(DONE_SUFFIX));
  const checkedRows = request.checkedIndices ?? [];
  const choices = new Map<number, string>();
  let finish: string | null = null;
  let other: string | null = null;
  let otherChecked = false;
  for (const [row, label] of labels.entries()) {
    if (label.startsWith(OTHER_OPTION)) {
      if (!localOther) other = label;
      otherChecked = !localOther && row < markable && checkedRows.includes(row);
    } else if (row >= markable) {
      if (label === NEXT_OPTION || label.endsWith(DONE_SUFFIX)) finish = label;
    } else {
      choices.set(row, label);
    }
  }
  const checked = checkedRows.flatMap((row) => choices.get(row) ?? []);
  return { labels, choices: [...choices.values()], checked, finish, other, otherChecked };
}

/**
 * True when only the owner may answer a question titled `title`: it matches a built-in pattern,
 * or it contains one of `words` (the config's `control.ownerOnlyWords`), ignoring case.
 */
export function ownerOnlyTitle(title: string, words: readonly string[]): boolean {
  if (OWNER_ONLY_TITLE.some((pattern) => pattern.test(title))) return true;
  const lower = title.toLowerCase();
  return words.some((word) => lower.includes(word.toLowerCase()));
}

/**
 * A `ui-request` in the shape `pending` returns. It names no recommended option: omp preselects
 * the first row of a list that has no default, so the dialog cannot tell a recommendation apart.
 */
export function describeRequest(request: UiRequest, since: string | null, ownerOnlyWords: readonly string[]): PendingUi {
  const ownerOnly = ownerOnlyTitle(request.title, ownerOnlyWords) ? { ownerOnly: true as const } : {};
  if (request.kind === "editor") {
    return { reqId: request.reqId, kind: "editor", title: request.title, ...(request.prefill ? { prefill: request.prefill } : {}), ...ownerOnly, since };
  }
  const all = request.options.map((item): PendingOption =>
    typeof item === "string" ? { label: item } : item.description ? { label: item.label, description: item.description } : { label: item.label }
  );
  if (request.approval) {
    return { reqId: request.reqId, kind: "approval", title: request.title, options: all, ...ownerOnly, since };
  }
  if (!request.selectionMarker) {
    return { reqId: request.reqId, kind: "select", title: request.title, options: all, ...ownerOnly, since };
  }
  const rows = askRows(request);
  const multi = request.selectionMarker === "checkbox";
  return {
    reqId: request.reqId,
    kind: "ask",
    title: request.title,
    options: all.filter((option) => rows.choices.includes(option.label)),
    multi,
    ...(multi ? { checked: rows.checked } : {}),
    other: rows.other !== null,
    ...ownerOnly,
    since,
  };
}

function readRequest(value: unknown): UiRequest | null {
  if (typeof value !== "object" || value === null) return null;
  const r = value as Record<string, unknown>;
  if (typeof r.reqId !== "number" || typeof r.title !== "string") return null;
  if (r.kind === "editor") return r as unknown as UiRequest;
  if (r.kind === "select" && Array.isArray(r.options)) return r as unknown as UiRequest;
  return null;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** One guest connection to a chat's Collab room. */
class GuestSession {
  readonly #ws: WebSocket;
  readonly #key: Promise<CryptoKey>;
  readonly #writeToken: string;
  readonly #name: string;
  readonly #signal: AbortSignal;
  readonly #onAbort: () => void;
  #recvChain: Promise<void> = Promise.resolve();
  #sendChain: Promise<unknown> = Promise.resolve();
  #closed: string | null = null;
  #welcomed = false;
  #snapshotDone = false;
  /** Snapshot chunks received so far; each one restarts the snapshot timeout. */
  #chunks = 0;
  /** The join batch (welcome, snapshot, replayed asks) is in. */
  #joined = false;
  #lastEntryAt: string | null = null;
  /** Requests received so far; each open request keeps the count at its arrival as `seq`. */
  #seq = 0;
  /** A `ui-response` went out on the socket. */
  #answered = false;
  /** Open requests by reqId, with the time each was posed (null for those replayed at the join). */
  readonly #requests = new Map<number, { request: UiRequest; since: string | null; seq: number }>();
  readonly #listeners = new Set<() => void>();

  constructor(wsUrl: string, key: Uint8Array, writeToken: Uint8Array, name: string, signal: AbortSignal) {
    this.#name = name;
    this.#signal = signal;
    this.#writeToken = Buffer.from(writeToken).toString("base64url");
    this.#key = crypto.subtle.importKey("raw", new Uint8Array(key), "AES-GCM", false, ["encrypt", "decrypt"]);
    this.#onAbort = () => this.close(`Deadline passed (${errorText(signal.reason)})`);
    signal.addEventListener("abort", this.#onAbort, { once: true });
    this.#ws = new WebSocket(`${wsUrl}?role=guest`);
    this.#ws.binaryType = "arraybuffer";
    this.#ws.onopen = () => {
      this.#send({ t: "hello", proto: COLLAB_PROTO, name: this.#name, writeToken: this.#writeToken }).catch(() => {});
    };
    this.#ws.onmessage = (event) => this.#receive(event.data);
    this.#ws.onclose = (event) => this.#end(`Collab room closed (${event.code}${event.reason ? ` ${event.reason}` : ""})`);
    this.#ws.onerror = () => {};
  }

  /** Something was sent that may have changed the chat's answer. */
  get answered(): boolean {
    return this.#answered;
  }

  close(reason = "closed"): void {
    this.#signal.removeEventListener("abort", this.#onAbort);
    this.#end(reason);
    try {
      this.#ws.close(1000);
    } catch {}
  }

  #end(reason: string): void {
    if (this.#closed !== null) return;
    this.#closed = reason;
    this.#notify();
  }

  #notify(): void {
    for (const listener of [...this.#listeners]) listener();
  }

  /**
   * Seals and sends one frame, after every frame before it. Resolves with the number of requests
   * received when it went out. Nothing goes out once the session ended (the deadline included):
   * the check runs after the encryption, right before the socket write.
   */
  #send(frame: { t: string; [field: string]: unknown }): Promise<number> {
    const sent = this.#sendChain.then(async () => {
      const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
      const plain = new TextEncoder().encode(JSON.stringify(frame));
      const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await this.#key, plain));
      // Envelope: [4-byte peer id, 0 = the host][IV][ciphertext + tag].
      const out = new Uint8Array(ENVELOPE_HEADER_BYTES + IV_BYTES + sealed.byteLength);
      out.set(iv, ENVELOPE_HEADER_BYTES);
      out.set(sealed, ENVELOPE_HEADER_BYTES + IV_BYTES);
      if (this.#closed !== null) throw new Error(this.#closed);
      if (frame.t === "ui-response") this.#answered = true;
      this.#ws.send(out);
      return this.#seq;
    });
    this.#sendChain = sent.catch((err: unknown) => this.#end(`Could not send to the chat: ${errorText(err)}`));
    return sent;
  }

  #receive(data: unknown): void {
    // Text messages are the relay's own control messages (peer counts); nothing here needs them.
    if (!(data instanceof ArrayBuffer) || data.byteLength <= ENVELOPE_HEADER_BYTES + IV_BYTES) return;
    const bytes = new Uint8Array(data);
    this.#recvChain = this.#recvChain
      .then(async () => {
        if (this.#closed !== null) return;
        let frame: Record<string, unknown>;
        try {
          const iv = bytes.subarray(ENVELOPE_HEADER_BYTES, ENVELOPE_HEADER_BYTES + IV_BYTES);
          const body = bytes.subarray(ENVELOPE_HEADER_BYTES + IV_BYTES);
          const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, await this.#key, body);
          frame = JSON.parse(new TextDecoder().decode(plain));
        } catch {
          this.#end("Collab frame could not be decrypted (wrong link?)");
          return;
        }
        this.#apply(frame);
        this.#notify();
      })
      .catch(() => {});
  }

  #trackEntries(entries: unknown): void {
    if (!Array.isArray(entries)) return;
    for (const entry of entries) {
      if (entry && typeof entry === "object" && "timestamp" in entry && typeof entry.timestamp === "string") this.#lastEntryAt = entry.timestamp;
    }
  }

  #apply(frame: Record<string, unknown>): void {
    switch (frame.t) {
      case "welcome":
        this.#welcomed = true;
        if (frame.readOnly === true) this.#end("The Collab link is view-only");
        break;
      case "snapshot-chunk":
        this.#chunks++;
        this.#trackEntries(frame.entries);
        if (frame.final === true) this.#snapshotDone = true;
        break;
      case "entry":
        this.#trackEntries([frame.entry]);
        break;
      case "ui-request": {
        const request = readRequest(frame.request);
        if (request) {
          // A request replayed in the join batch was posed before we came; one after it, now.
          const since = this.#joined ? new Date().toISOString() : null;
          this.#requests.set(request.reqId, { request, since, seq: ++this.#seq });
        }
        break;
      }
      case "ui-request-end":
        if (typeof frame.reqId === "number") this.#requests.delete(frame.reqId);
        break;
      case "error":
        // Before the welcome, an error is the host's refusal of our hello.
        if (!this.#welcomed || frame.resync === true) this.#end(`Chat refused the guest: ${String(frame.message)}`);
        break;
      case "bye":
        this.#end(`Chat ended the Collab room: ${String(frame.reason)}`);
        break;
    }
  }

  /** Resolves once `ready()` is true, or with the reason the session ended; rejects on timeout. */
  #until(ready: () => boolean, timeoutMs: number, what: string): Promise<void> {
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const check = () => {
      if (this.#closed !== null) {
        done();
        reject(new Error(this.#closed));
      } else if (ready()) {
        done();
        resolve();
      }
    };
    const timer = setTimeout(() => {
      done();
      reject(new Error(`Timed out waiting for ${what}`));
    }, timeoutMs);
    const done = () => {
      clearTimeout(timer);
      this.#listeners.delete(check);
    };
    this.#listeners.add(check);
    check();
    return promise;
  }

  /** Waits for the welcome, the whole snapshot, and the asks replayed after it. */
  async join(): Promise<void> {
    await this.#until(() => this.#welcomed, WELCOME_TIMEOUT_MS, "the chat to welcome the guest");
    while (!this.#snapshotDone) {
      const seen = this.#chunks;
      await this.#until(() => this.#snapshotDone || this.#chunks > seen, SNAPSHOT_PROGRESS_TIMEOUT_MS, "the chat transcript");
    }
    await Bun.sleep(ASKS_QUIET_MS);
    this.#joined = true;
    if (this.#closed !== null) throw new Error(this.#closed);
  }

  /** The open requests, oldest first; ownerOnlyWords as in ownerOnlyTitle. */
  requests(ownerOnlyWords: readonly string[]): PendingUi[] {
    return [...this.#requests.values()]
      .sort((a, b) => a.request.reqId - b.request.reqId)
      .map(({ request, since }) => describeRequest(request, since ?? this.#lastEntryAt, ownerOnlyWords));
  }

  /**
   * Sends one `ui-response` and waits for the host to end that request. Returns the request count
   * when the response went out: the next step of the dialog arrives after it.
   */
  async #respond(reqId: number, value: string): Promise<number> {
    const mark = await this.#send({ t: "ui-response", reqId, value });
    await this.#until(() => !this.#requests.has(reqId), STEP_TIMEOUT_MS, "the chat to take the answer");
    return mark;
  }

  /**
   * The oldest request that arrived after `mark` (see #respond), within `timeoutMs`, or null.
   * With `title`, only a request with that title counts: a dialog's next step keeps its title,
   * so another dialog open at the same time is never taken for it.
   */
  async #nextAfter(mark: number, timeoutMs: number, title?: string): Promise<UiRequest | null> {
    const find = () =>
      [...this.#requests.values()]
        .filter((r) => r.seq > mark && (title === undefined || r.request.title === title))
        .sort((a, b) => a.seq - b.seq)[0]?.request ?? null;
    try {
      await this.#until(() => find() !== null, timeoutMs, "the next question");
    } catch (err) {
      if (this.#closed !== null) throw err;
      return null;
    }
    return find();
  }

  /** A step of a multi-step answer: the follow-up request of `kind` and `title`, else an error. */
  async #step<K extends UiRequest["kind"]>(mark: number, kind: K, title: string): Promise<Extract<UiRequest, { kind: K }>> {
    const next = await this.#nextAfter(mark, STEP_TIMEOUT_MS, title);
    if (!next || next.kind !== kind) throw new Error(`The chat did not show the expected ${kind} step of "${title}"`);
    return next as Extract<UiRequest, { kind: K }>;
  }

  /**
   * Answers `request` with `value` the way the owner would in the dialog. Returns the last
   * request it answered and the mark after that answer, or an error before anything is sent.
   */
  async answer(request: UiRequest, value: AnswerValue): Promise<GuestResult<{ last: UiRequest; mark: number }>> {
    const done = (last: UiRequest, mark: number) => ({ ok: true as const, value: { last, mark } });
    if (request.kind === "editor") {
      if (typeof value !== "string") return badRequest("This question takes text: value must be a string");
      return done(request, await this.#respond(request.reqId, value));
    }
    if (request.approval) {
      const labels = selectLabels(request);
      if (typeof value !== "string" || !labels.includes(value)) return badRequest(`value must be one of: ${labels.join(" | ")}`);
      if (APPROVAL_ANSWERS[value] !== true) {
        return { ok: false, code: "owner_only", error: `"${value}" grants more than this one call; only the owner may choose it` };
      }
      return done(request, await this.#respond(request.reqId, value));
    }
    if (!request.selectionMarker) {
      const labels = selectLabels(request);
      if (typeof value !== "string" || !labels.includes(value)) return badRequest(`value must be one of: ${labels.join(" | ")}`);
      return done(request, await this.#respond(request.reqId, value));
    }
    const rows = askRows(request);
    if (request.selectionMarker === "radio") {
      if (typeof value !== "string") return badRequest("This question takes one answer: value must be a string");
      // "Chat about this" (the ask dialog's way out to the chat) is an answer too.
      if (rows.choices.includes(value) || (value === CHAT_OPTION && rows.labels.includes(CHAT_OPTION))) {
        return done(request, await this.#respond(request.reqId, value));
      }
      if (rows.other === null) return badRequest(`value must be one of: ${rows.choices.join(" | ")}`);
      if (!value.trim()) return badRequest("A free-text answer must not be empty");
      const editor = await this.#step(await this.#respond(request.reqId, rows.other), "editor", request.title);
      return done(editor, await this.#respond(editor.reqId, value));
    }

    // Checkbox list: toggle rows until the checked set matches, set or clear the free text
    // through Other, then finish (Next / Done).
    const wanted = typeof value === "string" ? [value] : value;
    const custom = wanted.filter((v) => !rows.choices.includes(v));
    if (wanted.length === 0 || custom.length > 1 || (custom.length === 1 && (rows.other === null || !custom[0].trim()))) {
      return badRequest(`value must name options among: ${rows.choices.join(" | ")}${rows.other === null ? "" : " (plus at most one free-text answer)"}`);
    }
    let current: SelectRequest = request;
    const toggled: string[] = [];
    for (const label of rows.choices) {
      if (askRows(current).checked.includes(label) === wanted.includes(label)) continue;
      current = await this.#step(await this.#respond(current.reqId, label), "select", request.title);
      toggled.push(label);
    }
    // A form list that already holds free text clears it on Other; set it again when wanted.
    if (askRows(current).otherChecked) {
      current = await this.#step(await this.#respond(current.reqId, askRows(current).other ?? OTHER_OPTION), "select", request.title);
    }
    const other = askRows(current).other;
    if (custom.length === 1 && other !== null) {
      const editor = await this.#step(await this.#respond(current.reqId, other), "editor", request.title);
      const mark = await this.#respond(editor.reqId, custom[0]);
      // An ask dialog's question ends with the text; a form's checkbox field shows its list again.
      const back = await this.#nextAfter(mark, FOLLOW_UP_MS, request.title);
      if (!back || back.kind !== "select" || back.selectionMarker !== "checkbox") return done(editor, mark);
      current = back;
    }
    const finish = askRows(current).finish;
    if (finish === null) {
      // Put the list back the way the owner left it before failing.
      for (const label of toggled.reverse()) {
        current = await this.#step(await this.#respond(current.reqId, label), "select", request.title);
      }
      return { ok: false, code: "protocol", error: "The chat offered no Next or Done row after the choices were set; the toggles were undone" };
    }
    return done(current, await this.#respond(current.reqId, finish));
  }

  /**
   * The request `target` names. `changed` when that reqId is not open or holds a question with
   * another title (a restarted omp counts reqIds from 1 again).
   */
  target(target: QuestionTarget): GuestResult<UiRequest> {
    if (this.#requests.size === 0) return { ok: false, code: "nothing_pending", error: "The chat is not waiting on a question" };
    const request = this.#requests.get(target.reqId)?.request;
    if (!request || titleHash(request.title) !== target.titleHash) {
      return { ok: false, code: "changed", error: `The question ${target.reqId} you read is no longer open; read pending again` };
    }
    return { ok: true, value: request };
  }

  /** The first request that arrived after `mark` within a short wait (the next question), or null. */
  async followUp(mark: number, ownerOnlyWords: readonly string[]): Promise<PendingUi | null> {
    const next = await this.#nextAfter(mark, FOLLOW_UP_MS);
    return next ? (this.requests(ownerOnlyWords).find((r) => r.reqId === next.reqId) ?? null) : null;
  }
}

function badRequest(error: string): { ok: false; code: "bad_request"; error: string } {
  return { ok: false, code: "bad_request", error };
}

/**
 * Joins the room behind `link`, runs `body`, and always leaves. `signal` is the caller's
 * deadline: once it fires, nothing more is sent, and the call fails with `timeout` when nothing
 * was sent yet or `outcome_unknown` when an answer may have landed.
 */
async function withGuest<T>(
  link: string,
  name: string,
  signal: AbortSignal,
  body: (guest: GuestSession) => Promise<GuestResult<T>>
): Promise<GuestResult<T>> {
  if (signal.aborted) return { ok: false, code: "timeout", error: `Deadline passed before joining the chat (${errorText(signal.reason)}); nothing was sent` };
  const parsed = parseCollabLink(link);
  if ("error" in parsed) return { ok: false, code: "failed", error: parsed.error };
  if (!parsed.writeToken) return { ok: false, code: "failed", error: "The Collab link is view-only" };
  const guest = new GuestSession(parsed.wsUrl, parsed.key, parsed.writeToken, name, signal);
  try {
    await guest.join();
    return await body(guest);
  } catch (err) {
    if (guest.answered) {
      return { ok: false, code: "outcome_unknown", error: `${errorText(err)}. An answer was sent, so the chat may have taken it; run pending again` };
    }
    if (signal.aborted) return { ok: false, code: "timeout", error: `${errorText(err)}; nothing was sent` };
    return { ok: false, code: "failed", error: errorText(err) };
  } finally {
    guest.close();
  }
}

/** The oldest question the chat is waiting on, and how many more are open. */
export function readPending(link: string, name: string, ownerOnlyWords: readonly string[], signal: AbortSignal): Promise<GuestResult<PendingReply>> {
  return withGuest(link, name, signal, async (guest) => {
    const open = guest.requests(ownerOnlyWords);
    return { ok: true, value: { pending: open[0] ?? null, queued: Math.max(0, open.length - 1) } };
  });
}

/**
 * Answers the question `target` names with `value`, then reports the next question the chat
 * shows within a second (the next field of the same ask form), or null. Refuses a question only
 * the owner may answer, and reports `rejected` when the chat shows the same field again.
 */
export function answerPending(
  link: string,
  name: string,
  value: AnswerValue,
  target: QuestionTarget,
  ownerOnlyWords: readonly string[],
  signal: AbortSignal
): Promise<GuestResult<AnswerReply>> {
  return withGuest(link, name, signal, async (guest) => {
    const found = guest.target(target);
    if (!found.ok) return found;
    const request = found.value;
    if (ownerOnlyTitle(request.title, ownerOnlyWords)) {
      return { ok: false, code: "owner_only", error: `Only the owner may answer "${request.title.split("\n")[0]}"` };
    }
    const answered = await guest.answer(request, value);
    if (!answered.ok) return answered;
    const { last, mark } = answered.value;
    // The answer is in once the chat ended its request; a lost follow-up only loses `next`.
    const next = await guest.followUp(mark, ownerOnlyWords).catch(() => null);
    const field = last.kind === "editor" || (last.kind === "select" && last.selectionMarker !== undefined);
    if (next && field && (next.title === last.title || next.title.startsWith(`${last.title} (`))) {
      return { ok: false, code: "rejected", error: `The chat showed "${next.title}" again: it did not take the answer` };
    }
    return { ok: true, value: { answered: request.reqId, next } };
  });
}
