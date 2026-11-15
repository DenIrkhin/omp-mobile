// APNs with a token key (build plan §6.3): an ES256 JWT signed with WebCrypto, one HTTP/2 session
// per environment, and what the server does with each answer. It never logs a device token or the
// text of a notification. server.ts and scripts/push-test.ts send through it; push-apns.test.ts
// replaces the transport.
import { readFile } from "node:fs/promises";
import { type ClientHttp2Session, connect, constants } from "node:http2";

/** sandbox: builds installed from Xcode and the Simulator; production: TestFlight and App Store builds. */
export type PushEnvironment = "sandbox" | "production";
export const PUSH_ENVIRONMENTS: readonly PushEnvironment[] = ["sandbox", "production"];

/** An APNs auth key: its 10-character id and the .p8 file Apple lets you download once. */
export type PushKey = { keyId: string; path: string };

const APNS_ORIGINS: Record<PushEnvironment, string> = {
  sandbox: "https://api.sandbox.push.apple.com",
  production: "https://api.push.apple.com",
};
// APNs refuses a provider token older than an hour and one renewed more often than every 20 minutes.
export const JWT_RENEW_MS = 50 * 60_000;
const SESSION_IDLE_MS = 60 * 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_PAYLOAD_BYTES = 4096;

/** One request as the transport sends it: the path and headers of a POST, and its JSON body. */
export type ApnsRequest = { path: string; headers: Record<string, string>; body: string };
/** APNs's answer: the status, its apns-id header, and reason and timestamp from the JSON body. */
export type ApnsReply = { status: number; apnsId: string | null; reason: string | null; timestamp: number | null };
/** Sends one request to one environment; rejects when APNs cannot be reached. */
export type ApnsTransport = (env: PushEnvironment, request: ApnsRequest) => Promise<ApnsReply>;

/** One notification. kind names it in the log, such as "test"; ttlSeconds: how long APNs keeps trying. */
export type ApnsMessage = {
  kind: string;
  token: string;
  payload: object;
  priority: 10 | 5;
  ttlSeconds: number;
  collapseId?: string;
};

/**
 * What came of a send. status 0: the request never reached APNs, and reason says why (NoKey,
 * KeyUnreadable, PayloadTooLarge, Unreachable). removeDevice: APNs says the token no longer works.
 */
export type SendResult = { status: number; apnsId: string; reason: string | null; removeDevice: boolean };

function base64url(data: string | Uint8Array): string {
  return (typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data)).toString("base64url");
}

/** The provider token APNs wants: header {alg: ES256, kid}, claims {iss: team id, iat}, an r‖s signature. */
export async function signJwt(key: CryptoKey, keyId: string, teamId: string, issuedAt: number): Promise<string> {
  const input = `${base64url(JSON.stringify({ alg: "ES256", kid: keyId }))}.${base64url(JSON.stringify({ iss: teamId, iat: issuedAt }))}`;
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(input));
  return `${input}.${base64url(new Uint8Array(signature))}`;
}

/** Reads an APNs .p8 file, a PKCS #8 P-256 key in PEM, as a signing key. */
export async function importP8(path: string): Promise<CryptoKey> {
  const pem = await readFile(path, "utf8");
  const der = new Uint8Array(Buffer.from(pem.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, ""), "base64"));
  return crypto.subtle.importKey("pkcs8", der, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}

/** The notification POST /api/v1/push/test and scripts/push-test.ts send. */
export function testMessage(token: string): ApnsMessage {
  return {
    kind: "test",
    token,
    payload: {
      aps: { alert: { title: "omp-mobile", body: "Test notification from your Mac" }, sound: "default" },
      omp: { v: 1, kind: "test" },
    },
    priority: 10,
    ttlSeconds: 3600,
  };
}

/** APNs over HTTP/2: one session per environment, reused, dropped after GOAWAY or an error, closed after an hour idle. */
export function http2Transport(): { send: ApnsTransport; close: () => void } {
  const sessions = new Map<PushEnvironment, ClientHttp2Session>();
  const idleTimers = new Map<PushEnvironment, ReturnType<typeof setTimeout>>();

  const open = (env: PushEnvironment): ClientHttp2Session => {
    const current = sessions.get(env);
    if (current && !current.closed && !current.destroyed) return current;
    const session = connect(APNS_ORIGINS[env]);
    const forget = (): void => {
      if (sessions.get(env) === session) sessions.delete(env);
    };
    session.on("goaway", forget);
    session.on("close", forget);
    session.on("error", forget);
    sessions.set(env, session);
    return session;
  };

  const closeWhenIdle = (env: PushEnvironment): void => {
    clearTimeout(idleTimers.get(env));
    idleTimers.set(
      env,
      setTimeout(() => {
        idleTimers.delete(env);
        sessions.get(env)?.close();
      }, SESSION_IDLE_MS),
    );
  };

  const send: ApnsTransport = (env, request) =>
    new Promise((resolve, reject) => {
      clearTimeout(idleTimers.get(env));
      const stream = open(env).request({ ":method": "POST", ":path": request.path, ...request.headers });
      let status = 0;
      let apnsId: string | null = null;
      let text = "";
      const timer = setTimeout(() => {
        stream.close(constants.NGHTTP2_CANCEL);
        reject(new Error(`APNs did not answer within ${REQUEST_TIMEOUT_MS / 1000} s`));
      }, REQUEST_TIMEOUT_MS);
      stream.setEncoding("utf8");
      stream.on("response", (headers) => {
        status = Number(headers[":status"]);
        const id = headers["apns-id"];
        apnsId = typeof id === "string" ? id : null;
      });
      stream.on("data", (chunk) => {
        text += String(chunk);
      });
      stream.on("end", () => {
        clearTimeout(timer);
        closeWhenIdle(env);
        resolve(parseReply(status, apnsId, text));
      });
      stream.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      stream.end(request.body);
    });

  const close = (): void => {
    for (const timer of idleTimers.values()) clearTimeout(timer);
    idleTimers.clear();
    for (const session of sessions.values()) session.close();
    sessions.clear();
  };

  return { send, close };
}

function parseReply(status: number, apnsId: string | null, text: string): ApnsReply {
  let reason: string | null = null;
  let timestamp: number | null = null;
  if (text.trim() !== "") {
    try {
      const body = JSON.parse(text) as { reason?: unknown; timestamp?: unknown };
      if (typeof body.reason === "string") reason = body.reason;
      if (typeof body.timestamp === "number") timestamp = body.timestamp;
    } catch {}
  }
  return { status, apnsId, reason, timestamp };
}

export type ApnsOptions = {
  teamId: string;
  bundleId: string;
  keys: Record<PushEnvironment, PushKey | null>;
  transport: ApnsTransport;
  /** Default importP8; tests pass a generated key. */
  loadKey?: (path: string) => Promise<CryptoKey>;
  now?: () => number;
  log?: (line: string) => void;
};

/** Sends notifications with the config's keys: one provider token per environment, renewed after 50 minutes. */
export class ApnsClient {
  private readonly options: ApnsOptions;
  private readonly loadKey: (path: string) => Promise<CryptoKey>;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly signingKeys = new Map<PushEnvironment, Promise<CryptoKey>>();
  private readonly tokens = new Map<PushEnvironment, { jwt: string; issuedAt: number }>();
  // An environment whose key APNs refused: no request goes there until the server restarts.
  private readonly stopped = new Map<PushEnvironment, string>();

  constructor(options: ApnsOptions) {
    this.options = options;
    this.loadKey = options.loadKey ?? importP8;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? console.log;
  }

  /** Sends `message`; lastSeenAt (ms) is the device's last registration, for APNs's 410 answer. */
  async send(env: PushEnvironment, message: ApnsMessage, lastSeenAt: number): Promise<SendResult> {
    const result = await this.deliver(env, message, crypto.randomUUID(), lastSeenAt);
    this.log(`push ${message.kind} ${result.apnsId} -> ${result.status} ${result.reason ?? "ok"}`);
    return result;
  }

  private async deliver(env: PushEnvironment, message: ApnsMessage, id: string, lastSeenAt: number): Promise<SendResult> {
    const local = (reason: string): SendResult => ({ status: 0, apnsId: id, reason, removeDevice: false });
    const key = this.options.keys[env];
    if (key === null) return local("NoKey");
    const stopReason = this.stopped.get(env);
    if (stopReason !== undefined) return { status: 403, apnsId: id, reason: stopReason, removeDevice: false };
    const body = JSON.stringify(message.payload);
    if (Buffer.byteLength(body) > MAX_PAYLOAD_BYTES) return local("PayloadTooLarge");
    for (let attempt = 1; ; attempt++) {
      let jwt: string;
      try {
        jwt = await this.providerToken(env, key, attempt > 1);
      } catch (err) {
        this.log(`push ${env} key error: ${err instanceof Error ? err.message : String(err)}`);
        return local("KeyUnreadable");
      }
      let reply: ApnsReply;
      try {
        reply = await this.options.transport(env, {
          path: `/3/device/${message.token}`,
          headers: this.headers(jwt, message, id),
          body,
        });
      } catch (err) {
        this.log(`push ${env} transport error: ${err instanceof Error ? err.message : String(err)}`);
        return local("Unreachable");
      }
      const result: SendResult = { status: reply.status, apnsId: reply.apnsId ?? id, reason: reply.reason, removeDevice: false };
      if (reply.status === 403 && reply.reason === "ExpiredProviderToken" && attempt === 1) continue;
      if (reply.status === 403 && (reply.reason === "InvalidProviderToken" || reply.reason === "BadEnvironmentKeyIdInToken")) {
        this.stopped.set(env, reply.reason);
        this.log(`push config error ${env} ${reply.reason}: no pushes to ${env} until the server restarts`);
      }
      if (reply.status === 410) result.removeDevice = reply.timestamp === null || reply.timestamp >= lastSeenAt;
      if (reply.status === 400 && (reply.reason === "BadDeviceToken" || reply.reason === "DeviceTokenNotForTopic")) {
        result.removeDevice = true;
      }
      return result;
    }
  }

  private async providerToken(env: PushEnvironment, key: PushKey, renew: boolean): Promise<string> {
    const now = this.now();
    const cached = this.tokens.get(env);
    if (!renew && cached && now - cached.issuedAt < JWT_RENEW_MS) return cached.jwt;
    let signingKey = this.signingKeys.get(env);
    if (signingKey === undefined) {
      signingKey = this.loadKey(key.path);
      this.signingKeys.set(env, signingKey);
      // A key file that could not be read is read again on the next send.
      signingKey.catch(() => this.signingKeys.delete(env));
    }
    const jwt = await signJwt(await signingKey, key.keyId, this.options.teamId, Math.floor(now / 1000));
    this.tokens.set(env, { jwt, issuedAt: now });
    return jwt;
  }

  private headers(jwt: string, message: ApnsMessage, id: string): Record<string, string> {
    const headers: Record<string, string> = {
      authorization: `bearer ${jwt}`,
      "apns-topic": this.options.bundleId,
      "apns-push-type": "alert",
      "apns-priority": String(message.priority),
      "apns-expiration": String(Math.floor(this.now() / 1000) + message.ttlSeconds),
      "apns-id": id,
    };
    if (message.collapseId !== undefined) headers["apns-collapse-id"] = message.collapseId;
    return headers;
  }
}
