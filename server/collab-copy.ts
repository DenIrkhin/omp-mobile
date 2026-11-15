// Pure logic for the dashboard's own copy of omp's Collab web page (see build-collab.ts).
import { isAbsolute, join, normalize, relative } from "path";

/** Relay the copy may connect to. Links for any other relay keep their my.omp.sh URL. */
export const COLLAB_RELAY_ORIGIN = "wss://my.omp.sh";

/** Written by build-collab.ts next to the built files. */
export type CollabBuildInfo = {
  ompVersion: string;
  tag: string;
  commit: string;
  builtAt: string;
  /** CSP hashes ("sha256-…") of the inline scripts in index.html. */
  inlineScriptHashes: string[];
};

export type PageCopyState = { ok: true } | { ok: false; reason: string };

/** "omp/18.4.10" → "18.4.10". */
export function parseOmpVersion(output: string): string | null {
  const match = output.trim().match(/^omp\/(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/m);
  return match ? match[1] : null;
}

export function parseBuildInfo(text: string): CollabBuildInfo | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const fields: Record<string, unknown> = Object.fromEntries(Object.entries(data));
  const { ompVersion, tag, commit, builtAt, inlineScriptHashes } = fields;
  if (
    typeof ompVersion !== "string" ||
    typeof tag !== "string" ||
    typeof commit !== "string" ||
    typeof builtAt !== "string" ||
    !Array.isArray(inlineScriptHashes) ||
    !inlineScriptHashes.every((h) => typeof h === "string" && /^sha256-[A-Za-z0-9+/]+=*$/.test(h))
  ) {
    return null;
  }
  return { ompVersion, tag, commit, builtAt, inlineScriptHashes };
}

/**
 * The copy is used only when it was built for the omp that is installed now: a host refuses a
 * page that speaks a different Collab protocol version, and my.omp.sh always matches.
 */
export function pageCopyState(info: CollabBuildInfo | null, installedVersion: string | null): PageCopyState {
  if (!info) return { ok: false, reason: "Page copy is not built. On the server Mac run: bun build-collab.ts" };
  if (!installedVersion) return { ok: false, reason: "Could not read the installed omp version" };
  if (info.ompVersion !== installedVersion) {
    return {
      ok: false,
      reason: `Page copy is for omp ${info.ompVersion}, but omp ${installedVersion} is installed. On the server Mac run: bun build-collab.ts`,
    };
  }
  return { ok: true };
}

/** The server's latest automatic run of build-collab.ts. */
export type RebuildAttempt = {
  version: string;
  /** null while the build is running. */
  finishedAt: number | null;
  error: string | null;
};

/** Wait before building again for the same omp version, so a failing build is not rerun on every poll. */
export const REBUILD_RETRY_MS = 10 * 60_000;

/**
 * Whether to start build-collab.ts while the copy is unusable: never while a build runs, at once
 * for an omp version not tried yet, and for the same version only REBUILD_RETRY_MS after the last
 * try ended (GitHub unreachable, the patch no longer applies).
 */
export function shouldRebuild(last: RebuildAttempt | null, installedVersion: string, now: number): boolean {
  if (!last) return true;
  if (last.finishedAt === null) return false;
  return last.version !== installedVersion || now - last.finishedAt >= REBUILD_RETRY_MS;
}

// Default-relay links end in a bare "<roomId>.<key>" fragment (omp's BARE_LINK_RE, dot form).
const BARE_DEFAULT_RELAY_LINK = /^[A-Za-z0-9_-]{10,64}\.[A-Za-z0-9_-]+$/;

/**
 * Moves a Collab browser link onto the page copy: everything before "#" becomes `base`, the
 * fragment (room id + key) is kept as is. `guestName` goes in `?name=`, where the patched page
 * takes it as the name the chat shows for this guest. Returns null for links the copy must not
 * open: another relay, a legacy form, or no fragment.
 */
export function rewriteCollabUrl(url: string, base: string, guestName: string | null): string | null {
  const hash = url.indexOf("#");
  if (hash < 0) return null;
  const fragment = url.slice(hash + 1);
  if (!BARE_DEFAULT_RELAY_LINK.test(fragment)) return null;
  const query = guestName ? `?name=${encodeURIComponent(guestName)}` : "";
  return `${base}${query}#${fragment}`;
}

// A Tailscale machine name is one DNS label.
const MACHINE_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,30}[A-Za-z0-9])?$/;

/** The machine name ("iphone") in `tailscale whois --json` output, or null. */
export function machineNameFromWhois(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || !("Node" in parsed)) return null;
  const node = parsed.Node;
  if (typeof node !== "object" || node === null) return null;
  let name = "";
  if ("ComputedName" in node && typeof node.ComputedName === "string") name = node.ComputedName;
  else if ("Name" in node && typeof node.Name === "string") name = node.Name.split(".")[0];
  return MACHINE_NAME.test(name) ? name : null;
}

export function collabCsp(info: CollabBuildInfo, relayOrigin = COLLAB_RELAY_ORIGIN): string {
  const scriptHashes = info.inlineScriptHashes.map((h) => `'${h}'`).join(" ");
  return [
    "default-src 'self'",
    `script-src 'self'${scriptHashes ? ` ${scriptHashes}` : ""}`,
    `connect-src 'self' ${relayOrigin}`,
    "img-src 'self' data: blob:",
    // KaTeX and the transcript set inline style attributes.
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/** Maps a request path to a file inside `distDir`; null when it would leave the directory. */
export function resolveCollabPath(distDir: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  const relativePath = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const filePath = normalize(join(distDir, relativePath));
  const fromRoot = relative(distDir, filePath);
  if (!fromRoot || fromRoot.startsWith("..") || isAbsolute(fromRoot)) return null;
  return filePath;
}

/** Bun's `[hash].[ext]` names are content-addressed and never change; everything else revalidates. */
export function collabCacheControl(fileName: string): string {
  return /^[a-z0-9]{8}\.[a-z0-9]+$/.test(fileName) ? "public, max-age=31536000, immutable" : "no-cache";
}

/** CSP hash sources for every attribute-less inline `<script>` in a built index.html. */
export function inlineScriptHashes(html: string): string[] {
  const hashes: string[] = [];
  for (const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
    hashes.push(`sha256-${new Bun.CryptoHasher("sha256").update(match[1]).digest("base64")}`);
  }
  return hashes;
}
