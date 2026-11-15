// The devices registered for push (build plan §6.4): <stateDir>/devices.json, written whole to a
// temp file and renamed over the old one, owner-only. Also the checks of the push routes' request
// bodies. server.ts creates the store only when push is on.
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isMissing } from "./agent-dirs";
import type { PushEnvironment, PushKey } from "./push-apns";

/** Which notifications a device wants (build plan §6.1). */
export type PushEvents = { input: boolean; reportFailed: boolean; reportUpdate: boolean; turnDone: boolean };
const DEFAULT_EVENTS: PushEvents = { input: true, reportFailed: true, reportUpdate: false, turnDone: false };

export type DeviceRequest = {
  token: string;
  environment: PushEnvironment;
  bundleId: string;
  appVersion: string | null;
  events: PushEvents;
};

/** A registered device; registeredAt and lastSeenAt are ISO times. */
export type Device = DeviceRequest & { login: string; deviceName: string | null; registeredAt: string; lastSeenAt: string };

/** A device not seen this long is dropped: the app registers on every launch. */
export const DEVICE_MAX_AGE_MS = 90 * 24 * 60 * 60_000;
// APNs device tokens are hex; Apple warns against assuming their length.
const TOKEN = /^(?:[0-9a-f]{2}){16,100}$/;
const TOKEN_ERROR = "token must be a hex device token of 32 to 200 characters";
const APP_VERSION_MAX = 64;

/** A checked request, or the 400 message and, when a client acts on it, its code. */
export type Checked<T> = { req?: T; error?: string; code?: string };

/** `value` as a lowercase device token: hex of an even length from 32 to 200; else null. */
export function deviceToken(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const token = value.toLowerCase();
  return TOKEN.test(token) ? token : null;
}

/** POST /api/v1/devices: a device token, an environment the server has a key for, this server's app. */
export function validateDeviceRequest(
  body: unknown,
  push: { bundleId: string; keys: Record<PushEnvironment, PushKey | null> },
): Checked<DeviceRequest> {
  if (!body || typeof body !== "object") return { error: "Request body must be a JSON object" };
  const { token, environment, bundleId, appVersion, events } = body as Record<string, unknown>;
  const hex = deviceToken(token);
  if (hex === null) return { error: TOKEN_ERROR };
  if (environment !== "sandbox" && environment !== "production") return { error: "environment must be sandbox or production" };
  if (bundleId !== push.bundleId) return { error: `This server sends pushes only to the app ${push.bundleId}`, code: "push_env" };
  if (push.keys[environment] === null) return { error: `This server has no APNs key for ${environment}`, code: "push_env" };
  if (appVersion !== undefined && appVersion !== null && (typeof appVersion !== "string" || appVersion.length > APP_VERSION_MAX)) {
    return { error: `appVersion must be a string of at most ${APP_VERSION_MAX} characters` };
  }
  const chosen: PushEvents = { ...DEFAULT_EVENTS };
  if (events !== undefined) {
    if (!events || typeof events !== "object" || Array.isArray(events)) return { error: "events must be an object" };
    for (const name of Object.keys(DEFAULT_EVENTS) as (keyof PushEvents)[]) {
      const value = (events as Record<string, unknown>)[name];
      if (value === undefined) continue;
      if (typeof value !== "boolean") return { error: `events.${name} must be true or false` };
      chosen[name] = value;
    }
  }
  return {
    req: {
      token: hex,
      environment,
      bundleId: push.bundleId,
      appVersion: typeof appVersion === "string" ? appVersion : null,
      events: chosen,
    },
  };
}

/** POST /api/v1/devices/remove and /api/v1/push/test: one device token. */
export function validateTokenRequest(body: unknown): Checked<{ token: string }> {
  if (!body || typeof body !== "object") return { error: "Request body must be a JSON object" };
  const token = deviceToken((body as Record<string, unknown>).token);
  return token === null ? { error: TOKEN_ERROR } : { req: { token } };
}

export class DeviceStore {
  private readonly file: string;
  private readonly now: () => number;
  // Each change reads, edits and rewrites the whole file; this chain runs them one at a time.
  private queue: Promise<unknown> = Promise.resolve();

  constructor(file: string, now: () => number = Date.now) {
    this.file = file;
    this.now = now;
  }

  /** The registered devices; [] before the first registration. */
  async list(): Promise<Device[]> {
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch (err) {
      if (isMissing(err)) return [];
      throw err;
    }
    const parsed = JSON.parse(text) as { devices?: unknown };
    return Array.isArray(parsed.devices) ? (parsed.devices as Device[]) : [];
  }

  async find(token: string): Promise<Device | null> {
    return (await this.list()).find((device) => device.token === token) ?? null;
  }

  /** Adds the device or updates the one with its token; drops devices not seen for 90 days. */
  upsert(req: DeviceRequest, who: { login: string; deviceName: string | null }): Promise<Device> {
    return this.change((devices) => {
      const now = this.now();
      const at = new Date(now).toISOString();
      const old = devices.find((device) => device.token === req.token);
      const device: Device = {
        ...req,
        login: who.login,
        deviceName: who.deviceName,
        registeredAt: old?.registeredAt ?? at,
        lastSeenAt: at,
      };
      const kept = devices.filter((d) => d.token !== req.token && now - Date.parse(d.lastSeenAt) < DEVICE_MAX_AGE_MS);
      return { devices: [...kept, device], result: device };
    });
  }

  /** Removes the device with this token; false when there was none. */
  remove(token: string): Promise<boolean> {
    return this.change((devices) => {
      const kept = devices.filter((device) => device.token !== token);
      return { devices: kept, result: kept.length !== devices.length };
    });
  }

  private change<T>(edit: (devices: Device[]) => { devices: Device[]; result: T }): Promise<T> {
    const run = this.queue.then(async () => {
      const { devices, result } = edit(await this.list());
      await this.write(devices);
      return result;
    });
    this.queue = run.catch(() => {});
    return run;
  }

  private async write(devices: Device[]): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify({ devices }, null, 2)}\n`, { mode: 0o600 });
    await chmod(temp, 0o600);
    await rename(temp, this.file);
  }
}
