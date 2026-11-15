// Reply bodies of the HTTP API under /api/v1, which the phone page and the iOS app read
// (api/v1/README.md). The routes in server.ts build every body here, so api-v1.test.ts can hold
// each one against its file in api/v1/fixtures/. Pure: no I/O.
import type { PageCopyState } from "./collab-copy";
import type { Config } from "./config";
import { type CliHost, type HostCard, sortHosts, toHostCard } from "./hosts";
import type { LaunchModel } from "./launch";
import type { LongTask, PinRequest } from "./long-tasks";
import { type ProjectMap, projectNames } from "./projects";
import { PUSH_ENVIRONMENTS, type PushEnvironment } from "./push-apns";
import type { Device } from "./push-devices";
import type { JobReport } from "./reports";

/** The version in every path and in GET /api/v1/info; a change that breaks clients makes it 2. */
export const API_VERSION = 1;

/** The config switches GET /api/v1/info reports. */
export type InfoConfig = Pick<Config, "longTasks" | "control" | "reports" | "push"> & {
  launch: Pick<Config["launch"], "enabled" | "profile">;
  pageCopy: Pick<Config["pageCopy"], "publicUrl">;
};

/** What GET /api/v1/info says besides the config: who asks, from which device, and the versions the Mac runs. */
export type InfoFacts = { login: string; deviceName: string | null; serverVersion: string; ompVersion: string | null };

export type InfoBody = {
  apiVersion: number;
  serverVersion: string;
  ompVersion: string | null;
  login: string;
  deviceName: string | null;
  /** The omp profile New session starts chats in; null is omp's default profile. */
  mainProfile: string | null;
  /** The optional modules the server runs; a client hides the buttons of the ones that are off. */
  features: {
    longTasks: boolean;
    launch: boolean;
    control: boolean;
    devCycles: boolean;
    reports: boolean;
    push: boolean;
    pageCopy: boolean;
  };
  /** Push settings; null when push is off. environments: the APNs environments the server has a key for. */
  push: { bundleId: string; environments: PushEnvironment[] } | null;
};

export function infoBody(config: InfoConfig, facts: InfoFacts): InfoBody {
  const push = config.push;
  return {
    apiVersion: API_VERSION,
    serverVersion: facts.serverVersion,
    ompVersion: facts.ompVersion,
    login: facts.login,
    deviceName: facts.deviceName,
    mainProfile: config.launch.profile,
    features: {
      longTasks: config.longTasks.enabled,
      launch: config.launch.enabled,
      control: config.control.enabled,
      devCycles: config.control.devCycles,
      reports: config.reports.enabled,
      push: push !== null,
      pageCopy: config.pageCopy.publicUrl !== null,
    },
    push: push === null ? null : { bundleId: push.bundleId, environments: PUSH_ENVIRONMENTS.filter((env) => push.keys[env] !== null) },
  };
}

/** The pins, long tasks and their reports, as server.ts loads them for GET /api/v1/hosts. */
export type PinsState = {
  pinnedIds: ReadonlySet<string>;
  longTasks: LongTask[];
  reports: ReadonlyMap<string, JobReport[]>;
};

export type HostsBody = {
  fetchedAt: number;
  hosts: HostCard[];
  longTasks: LongTask[];
  projects: string[];
  pageCopy: PageCopyState | null;
};

/** The list: one card per live chat in sortHosts order, the long tasks, and the order of the projects. */
export function hostsBody(
  fetchedAt: number,
  live: readonly CliHost[],
  map: ProjectMap,
  pins: PinsState,
  pageCopy: PageCopyState | null,
): HostsBody {
  return {
    fetchedAt,
    hosts: sortHosts(live.map((h) => toHostCard(h, map, pins.pinnedIds.has(h.sessionId), pins.reports.get(h.sessionId) ?? []))),
    longTasks: pins.longTasks,
    projects: projectNames(map),
    pageCopy,
  };
}

export function linkBody(url: string): { url: string } {
  return { url };
}

export function pinBody(pin: PinRequest): PinRequest {
  return { sessionId: pin.sessionId, pinned: pin.pinned };
}

export type LaunchOptionsBody = { folders: string[]; models: { id: string; label: string }[]; defaultModel: string };

/** New session's choices: each model choice by id and label; its model and thinking flags stay on the server. */
export function launchOptionsBody(folders: string[], models: Record<string, LaunchModel>, defaultModel: string): LaunchOptionsBody {
  return { folders, models: Object.entries(models).map(([id, { label }]) => ({ id, label })), defaultModel };
}

/** 201 of New session and Reopen: the chat that came up, and its cmux workspace. */
export type LaunchedBody = { instanceId: string; generation: number; access: CliHost["access"]; workspace: string };

export function launchedBody(host: CliHost, workspace: string): LaunchedBody {
  return { instanceId: host.instanceId, generation: host.generation, access: host.access, workspace };
}

/** Every JSON error: a message for people, and `code` where a client acts on the kind of error. */
export type ErrorBody = { error: string; code?: string };

export function errorBody(error: string, code?: string): ErrorBody {
  return code === undefined ? { error } : { error, code };
}

/** 200 of POST /api/v1/devices: the device as the server keeps it, without the login and the app version. */
export type DeviceBody = Pick<Device, "token" | "deviceName" | "events" | "registeredAt" | "lastSeenAt">;

export function deviceBody(device: Device): DeviceBody {
  return {
    token: device.token,
    deviceName: device.deviceName,
    events: device.events,
    registeredAt: device.registeredAt,
    lastSeenAt: device.lastSeenAt,
  };
}

export function removedBody(removed: boolean): { removed: boolean } {
  return { removed };
}

export function pushTestBody(apnsId: string): { apnsId: string } {
  return { apnsId };
}
