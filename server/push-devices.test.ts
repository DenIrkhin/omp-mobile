import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DEVICE_MAX_AGE_MS, type DeviceRequest, DeviceStore, type PushEvents, validateDeviceRequest, validateTokenRequest } from "./push-devices";

const DIR = mkdtempSync(join(tmpdir(), "push-devices-test-"));
afterAll(() => rmSync(DIR, { recursive: true, force: true }));

const TOKEN = "0123456789abcdef".repeat(4);
const OTHER = "fedcba9876543210".repeat(4);
const T0 = Date.parse("2026-11-14T08:00:00.000Z");
const PUSH = {
  bundleId: "io.github.you.ompmobile",
  keys: { sandbox: { keyId: "KEY0000001", path: "/keys/AuthKey_KEY0000001.p8" }, production: null },
};
const EVENTS: PushEvents = { input: true, reportFailed: true, reportUpdate: false, turnDone: false };
const ALPHA = { login: "you@example.com", deviceName: "iphone" };
const TOKEN_ERROR = { error: "token must be a hex device token of 32 to 200 characters" };

function registration(token: string, events: PushEvents = EVENTS): DeviceRequest {
  return { token, environment: "sandbox", bundleId: PUSH.bundleId, appVersion: "0.1.0 (3)", events };
}

let stores = 0;
/** A store in a folder of its own that does not exist yet, on the given clock. */
function store(clock: { now: number }): { devices: DeviceStore; file: string } {
  const file = join(DIR, `state-${stores++}`, "devices.json");
  return { devices: new DeviceStore(file, () => clock.now), file };
}

describe("DeviceStore", () => {
  it("registers a device owner-only and updates it by token", async () => {
    const clock = { now: T0 };
    const { devices, file } = store(clock);
    await devices.upsert(registration(TOKEN), ALPHA);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(file)).mode & 0o777).toBe(0o700);
    clock.now = T0 + 60_000;
    const updated = await devices.upsert(registration(TOKEN, { ...EVENTS, turnDone: true }), { ...ALPHA, deviceName: "ipad" });
    expect(updated).toEqual({
      ...registration(TOKEN, { ...EVENTS, turnDone: true }),
      login: "you@example.com",
      deviceName: "ipad",
      registeredAt: "2026-11-14T08:00:00.000Z",
      lastSeenAt: "2026-11-14T08:01:00.000Z",
    });
    expect(await devices.list()).toEqual([updated]);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("removes a device by token, and says so only once", async () => {
    const { devices } = store({ now: T0 });
    await devices.upsert(registration(TOKEN), ALPHA);
    await devices.upsert(registration(OTHER), ALPHA);
    expect(await devices.remove(TOKEN)).toBe(true);
    expect(await devices.remove(TOKEN)).toBe(false);
    expect((await devices.list()).map((device) => device.token)).toEqual([OTHER]);
  });

  it("drops a device not seen for 90 days when another registers", async () => {
    const clock = { now: T0 };
    const { devices } = store(clock);
    await devices.upsert(registration(TOKEN), ALPHA);
    clock.now = T0 + DEVICE_MAX_AGE_MS;
    await devices.upsert(registration(OTHER), ALPHA);
    expect((await devices.list()).map((device) => device.token)).toEqual([OTHER]);
  });
});

describe("push route checks", () => {
  const body = { token: TOKEN.toUpperCase(), environment: "sandbox", bundleId: PUSH.bundleId };

  it("takes a hex token in either case and fills in the default events", () => {
    expect(validateDeviceRequest(body, PUSH)).toEqual({
      req: { token: TOKEN, environment: "sandbox", bundleId: PUSH.bundleId, appVersion: null, events: EVENTS },
    });
    expect(validateTokenRequest({ token: TOKEN.toUpperCase() })).toEqual({ req: { token: TOKEN } });
  });

  it("refuses a token that is not even-length hex of 32 to 200 characters", () => {
    for (const token of ["xyz", "0".repeat(31), "0".repeat(30), "0".repeat(202), 42]) {
      expect(validateDeviceRequest({ ...body, token }, PUSH)).toEqual(TOKEN_ERROR);
      expect(validateTokenRequest({ token })).toEqual(TOKEN_ERROR);
    }
  });

  it("refuses another app and an environment without a key with code push_env", () => {
    expect(validateDeviceRequest({ ...body, bundleId: "io.github.someone.else" }, PUSH)).toEqual({
      error: "This server sends pushes only to the app io.github.you.ompmobile",
      code: "push_env",
    });
    expect(validateDeviceRequest({ ...body, environment: "production" }, PUSH)).toEqual({
      error: "This server has no APNs key for production",
      code: "push_env",
    });
  });
});
