// Pure logic for starting a new omp session from the dashboard.
import type { CliHost } from "./hosts";

/** A model choice from `launch.models` in the config; a null model or thinking level leaves the profile's own. */
export type LaunchModel = { label: string; model: string | null; thinking: string | null };

export type LaunchRequest = {
  folder: string;
  model: LaunchModel;
  /** Spending cap in USD, passed to omp as `--max-cost`; absent starts the session without one. */
  maxCost?: number;
};

/** The highest spending cap a launch may set, in USD. */
export const MAX_LAUNCH_COST = 500;

/**
 * Accepts only a folder the server offered, one of `models` and an optional spending cap. A
 * missing model means `defaultModel`; a missing or null maxCost means no cap.
 */
export function validateLaunchRequest(
  body: unknown,
  folders: string[],
  models: Record<string, LaunchModel>,
  defaultModel: string
): { req?: LaunchRequest; error?: string } {
  if (!body || typeof body !== "object") {
    return { error: "Request body must be a JSON object" };
  }
  const { folder, model = defaultModel, maxCost = null } = body as Record<string, unknown>;
  if (typeof folder !== "string" || !folders.includes(folder)) {
    return { error: "Folder is not in the allowed list" };
  }
  if (typeof model !== "string" || !Object.hasOwn(models, model)) {
    return { error: "Model is not in the allowed list" };
  }
  if (maxCost === null) {
    return { req: { folder, model: models[model] } };
  }
  // The cap is typed into the shell, so only a number in range gets through (NaN and Infinity
  // fail the range check). A cap under half a cent rounds to 0 cents, which leaves no budget at
  // all, so it is refused too.
  const cents = typeof maxCost === "number" && maxCost > 0 && maxCost <= MAX_LAUNCH_COST ? Math.round(maxCost * 100) : 0;
  if (cents < 1) {
    return { error: `maxCost must be a number of USD above 0 and at most ${MAX_LAUNCH_COST}` };
  }
  return { req: { folder, model: models[model], maxCost: cents / 100 } };
}

// Overlay that turns off the profile's autoResume, so every launch is a new session.
// Its path is typed into the shell, so it must stay free of spaces and shell syntax.
const NEW_SESSION_OVERLAY = new URL("./new-session.yml", import.meta.url).pathname;
if (!/^[A-Za-z0-9._/-]+$/.test(NEW_SESSION_OVERLAY)) {
  throw new Error(`new-session.yml path is not shell-safe: ${NEW_SESSION_OVERLAY}`);
}

/**
 * Shell command cmux types into the new workspace's login shell. Built only from the profile and
 * model the config loader accepted (letters, digits and a few marks, see config.ts) and the cap
 * validateLaunchRequest checked, a number that prints as digits and at most one dot. A null
 * profile, model or thinking level leaves its flag out, so omp and the profile decide.
 */
export function launchCommand(choice: LaunchModel, maxCost: number | undefined, profile: string | null): string {
  const flags = [
    ...(profile === null ? [] : [`--profile=${profile}`]),
    `--config=${NEW_SESSION_OVERLAY}`,
    ...(choice.model === null ? [] : [`--model=${choice.model}`]),
    ...(choice.thinking === null ? [] : [`--thinking=${choice.thinking}`]),
    ...(maxCost === undefined ? [] : [`--max-cost=${maxCost}`]),
  ];
  return `omp ${flags.join(" ")}`;
}

export function workspaceName(folder: string): string {
  const leaf = folder.replace(/\/+$/, "").split("/").pop() || folder;
  return `${leaf}-mobile`;
}

/**
 * Parses `cmux workspace create` output ("OK workspace:32") into the workspace ref.
 */
export function parseWorkspaceRef(stdout: string): string | null {
  const match = stdout.match(/^OK\s+(workspace:\d+)\s*$/m);
  return match ? match[1] : null;
}

/**
 * Finds the session that appeared in `folder` after the launch, ignoring hosts
 * that were already registered before it.
 */
export function findLaunchedHost(
  hosts: CliHost[],
  knownBefore: Set<string>,
  folder: string
): CliHost | null {
  const candidates = hosts
    .filter((h) => h.cwd === folder && !knownBefore.has(h.instanceId))
    .sort((a, b) => b.startedAt - a.startedAt);
  return candidates[0] ?? null;
}
