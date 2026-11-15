// Pure logic for the Long tasks tab. A long task is an omp session pinned with `/pin`: omp
// keeps the pinned ids per agent dir in `session-pins.json`, and the dashboard lists every
// pinned session, live or closed, and can reopen a closed one in a new cmux workspace.
import { isAbsolute, normalize } from "node:path";
import type { JobReport } from "./reports";

/** omp session ids are lowercase UUIDs (v7 in practice). */
export const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Profile names typed into the reopen command; omp's own rule is stricter. */
export const PROFILE_NAME = /^[A-Za-z0-9._-]+$/;

/** omp's pins file inside each agent dir. */
export const PINS_FILE = "session-pins.json";

/**
 * Bytes read from the start of a session file: the 256-byte title slot plus the header
 * line, which holds a cwd and a few ids, fit with plenty to spare.
 */
export const SESSION_HEAD_BYTES = 8192;

/** A pinned session as GET /api/v1/hosts reports it. */
export type LongTask = {
  sessionId: string;
  title: string | null;
  cwd: string;
  /** Last path segment of `cwd`. */
  folder: string;
  /** Project of `cwd` (projects.ts), the Long tasks section the phone lists it in; null outside OMP_ROOT. */
  project: string | null;
  profile: string | null;
  lastActiveAt: number;
  /** Latest report per job, newest first (at most 3). */
  reports: JobReport[];
};

/** What the first lines of a session file say about it. */
export type SessionHead = {
  sessionId: string;
  title: string | null;
  cwd: string;
};

/** Where a session file lives: its agent dir and the profile that owns that dir (null = default). */
export type SessionLocation = {
  path: string;
  agentDir: string;
  profile: string | null;
};

export type PinRequest = { sessionId: string; pinned: boolean };

export type ReopenRequest = { sessionId: string };

/**
 * Reads a pins file the way omp does: a JSON array whose string entries are the ids.
 * A corrupt file or anything but an array counts as no pins, so one bad file never
 * hides the rest of the dashboard. Duplicates are dropped, first position kept.
 */
export function parsePins(text: string): string[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  return [...new Set(data.filter((id): id is string => typeof id === "string"))];
}

/** Adds or removes one id, keeping the other ids in their order. Applying it twice changes nothing more. */
export function setPinned(ids: readonly string[], sessionId: string, pinned: boolean): string[] {
  const rest = ids.filter((id) => id !== sessionId);
  if (!pinned) return rest;
  return ids.includes(sessionId) ? [...ids] : [...ids, sessionId];
}

/** The session id in an omp session file name (`<timestamp>_<id>.jsonl`), or null for any other file. */
export function sessionIdFromFileName(name: string): string | null {
  const match = /^[^/]+_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/.exec(name);
  return match ? match[1] : null;
}

function parseJsonObject(line: string | undefined): Record<string, unknown> | null {
  if (line === undefined) return null;
  try {
    const value: unknown = JSON.parse(line);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Reads the start of a session file. Current files open with a fixed-width title slot
 * (`{"type":"title","v":1,"title":…}`) followed by the session header; older files open
 * with the header. As in omp, the slot's title wins over the header's, and an empty slot
 * title means "no title". Returns null when no valid header is found.
 */
export function parseSessionHead(head: string): SessionHead | null {
  const lines = head.split("\n");
  const first = parseJsonObject(lines[0]);
  const slot =
    first?.type === "title" &&
    first.v === 1 &&
    typeof first.title === "string" &&
    typeof first.updatedAt === "string" &&
    typeof first.pad === "string"
      ? first
      : null;
  const header = slot ? parseJsonObject(lines[1]) : first;
  if (
    header?.type !== "session" ||
    typeof header.id !== "string" ||
    !SESSION_ID.test(header.id) ||
    typeof header.cwd !== "string" ||
    !header.cwd
  ) {
    return null;
  }
  const title = slot ? slot.title : header.title;
  return {
    sessionId: header.id,
    title: typeof title === "string" && title.trim() ? title : null,
    cwd: header.cwd,
  };
}

/** Validates POST /api/v1/pin. */
export function validatePinRequest(body: unknown): { req?: PinRequest; error?: string } {
  if (!body || typeof body !== "object") {
    return { error: "Request body must be a JSON object" };
  }
  const { sessionId, pinned } = body as Record<string, unknown>;
  if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) {
    return { error: "sessionId must be an omp session id" };
  }
  if (typeof pinned !== "boolean") {
    return { error: "pinned must be true or false" };
  }
  return { req: { sessionId, pinned } };
}

/** Validates POST /api/v1/long-tasks/reopen. */
export function validateReopenRequest(body: unknown): { req?: ReopenRequest; error?: string } {
  if (!body || typeof body !== "object") {
    return { error: "Request body must be a JSON object" };
  }
  const { sessionId } = body as Record<string, unknown>;
  if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) {
    return { error: "sessionId must be an omp session id" };
  }
  return { req: { sessionId } };
}

/**
 * Shell command cmux types into the new workspace to resume a closed session; resume
 * restores the session's model and thinking level. cmux types it as keystrokes, so a
 * control character (a newline above all) would run part of it early: such paths are
 * refused, as are paths outside the agent dir's `sessions/`. Throws on a refused input.
 */
export function reopenCommand(loc: SessionLocation): string {
  const { path, agentDir, profile } = loc;
  if (profile !== null && !PROFILE_NAME.test(profile)) {
    throw new Error(`Profile name is not shell-safe: ${JSON.stringify(profile)}`);
  }
  const insideSessions =
    isAbsolute(agentDir) &&
    isAbsolute(path) &&
    normalize(path) === path &&
    path.startsWith(`${agentDir.replace(/\/+$/, "")}/sessions/`) &&
    path.endsWith(".jsonl");
  if (!insideSessions || /[\u0000-\u001f\u007f]/.test(path)) {
    throw new Error(`Not a session file under ${agentDir}/sessions: ${JSON.stringify(path)}`);
  }
  const quoted = `'${path.replaceAll("'", `'\\''`)}'`;
  return profile === null ? `omp --resume ${quoted}` : `omp --profile=${profile} --resume ${quoted}`;
}
