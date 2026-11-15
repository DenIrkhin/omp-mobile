import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApnsClient, type ApnsReply, type ApnsRequest, importP8, JWT_RENEW_MS, signJwt, testMessage } from "./push-apns";

const DIR = mkdtempSync(join(tmpdir(), "push-apns-test-"));
afterAll(() => rmSync(DIR, { recursive: true, force: true }));

const TOKEN = "0123456789abcdef".repeat(4);
const T0 = 1_763_100_000_000;
const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);

/** The JSON of one part of a JWT. */
function part(jwt: string, index: number): unknown {
  return JSON.parse(Buffer.from(jwt.split(".")[index], "base64url").toString("utf8"));
}

/** The provider token of a recorded request. */
function jwtOf(request: ApnsRequest): string {
  return (request.headers.authorization ?? "").replace(/^bearer /, "");
}

/**
 * A client on a fake transport: it records each request, answers from `replies` in turn (200 once
 * they run out), and moves the clock one second on per request.
 */
function client(replies: Partial<ApnsReply>[], clock: { now: number }) {
  const requests: ApnsRequest[] = [];
  const lines: string[] = [];
  const apns = new ApnsClient({
    teamId: "TEAM000001",
    bundleId: "io.github.you.ompmobile",
    keys: { sandbox: { keyId: "KEY0000001", path: "/keys/AuthKey_KEY0000001.p8" }, production: null },
    loadKey: async () => pair.privateKey,
    now: () => clock.now,
    log: (line) => lines.push(line),
    transport: async (_env, request) => {
      requests.push(request);
      clock.now += 1000;
      return { status: 200, apnsId: null, reason: null, timestamp: null, ...replies.shift() };
    },
  });
  return { apns, requests, lines };
}

describe("signJwt and importP8", () => {
  it("reads a .p8 key and signs an ES256 token whose 64-byte r‖s signature verifies", async () => {
    const der = Buffer.from(await crypto.subtle.exportKey("pkcs8", pair.privateKey)).toString("base64");
    // A .p8 file as Apple ships it: the PKCS #8 key in base64 between PEM armor lines.
    const armor = (word: string): string => `-----${word} PRIVATE KEY-----`;
    const file = join(DIR, "AuthKey_KEY0000001.p8");
    writeFileSync(file, `${armor("BEGIN")}\n${der}\n${armor("END")}\n`, { mode: 0o600 });
    const jwt = await signJwt(await importP8(file), "KEY0000001", "TEAM000001", 1_763_100_000);
    const [header, claims, signature] = jwt.split(".");
    expect(part(jwt, 0)).toEqual({ alg: "ES256", kid: "KEY0000001" });
    expect(part(jwt, 1)).toEqual({ iss: "TEAM000001", iat: 1_763_100_000 });
    const raw = new Uint8Array(Buffer.from(signature, "base64url"));
    expect(raw.length).toBe(64);
    const data = new TextEncoder().encode(`${header}.${claims}`);
    expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pair.publicKey, raw, data)).toBe(true);
  });
});

describe("ApnsClient", () => {
  it("reuses the provider token for 50 minutes, then signs a new one", async () => {
    const clock = { now: T0 };
    const { apns, requests } = client([], clock);
    await apns.send("sandbox", testMessage(TOKEN), T0);
    clock.now = T0 + JWT_RENEW_MS - 60_000;
    await apns.send("sandbox", testMessage(TOKEN), T0);
    clock.now = T0 + JWT_RENEW_MS;
    await apns.send("sandbox", testMessage(TOKEN), T0);
    expect(jwtOf(requests[1])).toBe(jwtOf(requests[0]));
    expect(part(jwtOf(requests[2]), 1)).toEqual({ iss: "TEAM000001", iat: (T0 + JWT_RENEW_MS) / 1000 });
  });

  it("sends the request APNs expects: the device path, the topic and the delivery headers", async () => {
    const clock = { now: T0 };
    const { apns, requests } = client([], clock);
    const result = await apns.send("sandbox", testMessage(TOKEN), T0);
    await apns.send("sandbox", { ...testMessage(TOKEN), kind: "input", priority: 5, ttlSeconds: 60, collapseId: "input:alpha" }, T0);
    const [plain, collapsed] = requests;
    expect(plain.path).toBe(`/3/device/${TOKEN}`);
    const { authorization, ...delivery } = plain.headers;
    expect(authorization).toMatch(/^bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    expect(delivery).toEqual({
      "apns-topic": "io.github.you.ompmobile",
      "apns-push-type": "alert",
      "apns-priority": "10",
      "apns-expiration": String(T0 / 1000 + 3600),
      "apns-id": result.apnsId,
    });
    expect(JSON.parse(plain.body)).toEqual(testMessage(TOKEN).payload);
    expect(collapsed.headers["apns-priority"]).toBe("5");
    expect(collapsed.headers["apns-collapse-id"]).toBe("input:alpha");
    expect(collapsed.headers["apns-expiration"]).toBe(String((T0 + 1000) / 1000 + 60));
  });

  it("drops a token APNs reports dead, unless the device registered again after that", async () => {
    const { apns } = client(
      [
        { status: 410, reason: "Unregistered", timestamp: T0 },
        { status: 410, reason: "Unregistered", timestamp: T0 - 1 },
        { status: 400, reason: "BadDeviceToken" },
        { status: 400, reason: "DeviceTokenNotForTopic" },
        { status: 429, reason: "TooManyRequests" },
      ],
      { now: T0 },
    );
    const removed: boolean[] = [];
    for (let i = 0; i < 5; i++) removed.push((await apns.send("sandbox", testMessage(TOKEN), T0)).removeDevice);
    expect(removed).toEqual([true, false, true, true, false]);
  });

  it("signs a new provider token and retries once when APNs says the old one expired", async () => {
    const { apns, requests } = client([{ status: 403, reason: "ExpiredProviderToken" }], { now: T0 });
    const result = await apns.send("sandbox", testMessage(TOKEN), T0);
    expect(result.status).toBe(200);
    expect(requests).toHaveLength(2);
    expect(part(jwtOf(requests[1]), 1)).toEqual({ iss: "TEAM000001", iat: T0 / 1000 + 1 });
  });

  it("stops an environment whose key APNs refuses until the server restarts, and never logs the token", async () => {
    const { apns, requests, lines } = client([{ status: 403, reason: "InvalidProviderToken" }], { now: T0 });
    expect((await apns.send("sandbox", testMessage(TOKEN), T0)).reason).toBe("InvalidProviderToken");
    const again = await apns.send("sandbox", testMessage(TOKEN), T0);
    expect([again.status, again.reason]).toEqual([403, "InvalidProviderToken"]);
    expect(requests).toHaveLength(1);
    expect(lines.some((line) => line.startsWith("push config error sandbox InvalidProviderToken"))).toBe(true);
    expect(lines.join("\n")).not.toContain(TOKEN);
  });
});
