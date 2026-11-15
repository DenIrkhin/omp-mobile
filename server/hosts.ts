// Pure logic for omp-sessions: validation, formatting, sorting, and link authorization.
import { type ProjectMap, projectOf } from "./projects";
import type { JobReport } from "./reports";

export type CliHost = {
  instanceId: string;
  generation: number;
  pid: number;
  sessionId: string;
  sessionName: string | null;
  cwd: string;
  model: {
    provider: string;
    id: string;
  };
  startedAt: number;
  participants: number;
  relayConnected: boolean;
  inputRequired: boolean;
  busy: boolean | null;
  access: "view" | "control";
};

export type CliListResponse = {
  version: number;
  hosts: CliHost[];
};

export type CliLinkResponse = {
  version: number;
  instanceId: string;
  generation: number;
  access: "view" | "control";
  url: string;
};

export type HostCard = {
  instanceId: string;
  generation: number;
  sessionId: string;
  sessionName: string | null;
  cwd: string;
  /** Last path segment of `cwd`, the card's title on the Chats tab. */
  folder: string;
  /** Project of `cwd` (projects.ts); null outside OMP_ROOT. */
  project: string | null;
  model: string;
  startedAt: number;
  participants: number;
  relayConnected: boolean;
  inputRequired: boolean;
  busy: boolean | null;
  access: "view" | "control";
  /** The session is pinned in omp (`/pin`), so the page lists it under Long tasks. */
  pinned: boolean;
  /** Latest report per job, newest first (at most 3); empty unless pinned. */
  reports: JobReport[];
};

export type LinkRequest = {
  instanceId: string;
  generation: number;
  access: "view" | "control";
};

export type LinkDecision =
  | { status: 200; url: string }
  | { status: 400; error: string }
  | { status: 403; error: string }
  | { status: 404; error: string }
  | { status: 409; error: string };

/**
 * Validates the raw JSON from `omp collab list --json`.
 * Returns null if the payload is invalid or unsupported.
 */
export function parseCliList(raw: string): CliListResponse | null {
  try {
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object" || data.version !== 1 || !Array.isArray(data.hosts)) {
      return null;
    }
    for (const h of data.hosts) {
      if (
        typeof h.instanceId !== "string" ||
        typeof h.generation !== "number" ||
        typeof h.cwd !== "string" ||
        typeof h.startedAt !== "number" ||
        typeof h.access !== "string" ||
        (h.access !== "view" && h.access !== "control")
      ) {
        return null;
      }
    }
    return data as CliListResponse;
  } catch {
    return null;
  }
}

/**
 * Validates the raw JSON from `omp collab link --json`.
 */
export function parseCliLink(raw: string): CliLinkResponse | null {
  try {
    const data = JSON.parse(raw);
    if (
      !data ||
      typeof data !== "object" ||
      data.version !== 1 ||
      typeof data.instanceId !== "string" ||
      typeof data.generation !== "number" ||
      typeof data.url !== "string" ||
      (data.access !== "view" && data.access !== "control")
    ) {
      return null;
    }
    return data as CliLinkResponse;
  } catch {
    return null;
  }
}

/**
 * Derives a folder name from the last path segment of cwd.
 */
export function deriveFolder(cwd: string): string {
  const trimmed = cwd.replace(/[\\/]+$/, "");
  if (!trimmed) return "root";
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || trimmed;
}

/**
 * Trims CLI host representation to what the frontend card needs. `map` gives the card its project.
 */
export function toHostCard(h: CliHost, map: ProjectMap, pinned: boolean, reports: JobReport[]): HostCard {
  return {
    instanceId: h.instanceId,
    generation: h.generation,
    sessionId: h.sessionId,
    sessionName: h.sessionName,
    cwd: h.cwd,
    folder: deriveFolder(h.cwd),
    project: projectOf(h.cwd, map),
    model: `${h.model?.provider || "unknown"}/${h.model?.id || "unknown"}`,
    startedAt: h.startedAt,
    participants: h.participants,
    relayConnected: h.relayConnected,
    inputRequired: h.inputRequired,
    busy: h.busy,
    access: h.access,
    pinned,
    reports,
  };
}

/**
 * Sort order:
 * 1. inputRequired (true first)
 * 2. busy === true (working first)
 * 3. busy === false or busy === null (idle / unknown)
 * 4. newest startedAt first
 */
export function sortHosts(cards: HostCard[]): HostCard[] {
  return [...cards].sort((a, b) => {
    if (a.inputRequired !== b.inputRequired) {
      return a.inputRequired ? -1 : 1;
    }
    const aWorking = a.busy === true;
    const bWorking = b.busy === true;
    if (aWorking !== bWorking) {
      return aWorking ? -1 : 1;
    }
    return b.startedAt - a.startedAt;
  });
}

/**
 * Validates incoming POST /api/v1/link request body.
 */
export function validateLinkRequest(body: unknown): { req?: LinkRequest; error?: string } {
  if (!body || typeof body !== "object") {
    return { error: "Request body must be a JSON object" };
  }
  const b = body as Record<string, unknown>;
  if (typeof b.instanceId !== "string" || !b.instanceId.trim()) {
    return { error: "instanceId must be a non-empty string" };
  }
  if (typeof b.generation !== "number" || !Number.isInteger(b.generation) || b.generation < 1) {
    return { error: "generation must be a positive integer" };
  }
  if (b.access !== "view" && b.access !== "control") {
    return { error: "access must be either 'view' or 'control'" };
  }
  return {
    req: {
      instanceId: b.instanceId.trim(),
      generation: b.generation,
      access: b.access,
    },
  };
}

/**
 * Checks whether an incoming request from Tailscale is authorized: its login must be one of
 * `allowedLogins`, compared without regard to case.
 */
export function checkAuth(
  headerLogin: string | null,
  allowedLogins: readonly string[]
): { authorized: boolean; reason?: string } {
  if (!headerLogin) {
    return { authorized: false, reason: "Missing Tailscale-User-Login header" };
  }
  const login = headerLogin.trim().toLowerCase();
  if (!allowedLogins.some((allowed) => allowed.trim().toLowerCase() === login)) {
    return { authorized: false, reason: "Tailscale login not permitted" };
  }
  return { authorized: true };
}

/**
 * Evaluates whether link generation can proceed or whether session state has diverged.
 */
export function preCheckLink(
  req: LinkRequest,
  liveHosts: CliHost[]
): { ok: true; targetHost: CliHost } | { ok: false; decision: Exclude<LinkDecision, { status: 200 }> } {
  const host = liveHosts.find((h) => h.instanceId === req.instanceId);
  if (!host) {
    return {
      ok: false,
      decision: { status: 404, error: `Host ${req.instanceId} is not running or no longer published` },
    };
  }

  if (host.generation !== req.generation) {
    return {
      ok: false,
      decision: {
        status: 409,
        error: `Session generation changed (expected ${req.generation}, host is at ${host.generation})`,
      },
    };
  }

  if (req.access === "control" && host.access === "view") {
    return {
      ok: false,
      decision: {
        status: 403,
        error: `Host ${req.instanceId} only allows view access`,
      },
    };
  }

  return { ok: true, targetHost: host };
}

/**
 * Post-checks the CLI link output to guard against races (session switched during CLI execution).
 */
export function postCheckLink(
  req: LinkRequest,
  cliLink: CliLinkResponse
): LinkDecision {
  if (cliLink.generation !== req.generation) {
    return {
      status: 409,
      error: `Session rotated during link creation (expected ${req.generation}, received ${cliLink.generation})`,
    };
  }
  return {
    status: 200,
    url: cliLink.url,
  };
}
