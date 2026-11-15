import { describe, expect, it } from "bun:test";
import {
  type CollabBuildInfo,
  collabCacheControl,
  collabCsp,
  machineNameFromWhois,
  pageCopyState,
  parseBuildInfo,
  parseOmpVersion,
  REBUILD_RETRY_MS,
  resolveCollabPath,
  rewriteCollabUrl,
  shouldRebuild,
} from "./collab-copy";

const BASE = "https://mac.example.ts.net:8443/";
const ROOM = "test-room-0000000001";
const KEY = "test_key-0000000000000000000000000000000001";

const info: CollabBuildInfo = {
  ompVersion: "18.5.0",
  tag: "v18.5.0",
  commit: "9348320cc4",
  builtAt: "2026-10-03T03:56:50.183Z",
  inlineScriptHashes: ["sha256-xhvE/bGVoHeSC1+kb6i3RctL95c2hahU7q54ZGfm0Uo="],
};

describe("parseOmpVersion", () => {
  it("reads release and prerelease versions from omp --version", () => {
    expect(parseOmpVersion("omp/18.5.0\n")).toBe("18.5.0");
    expect(parseOmpVersion("omp/18.6.0-beta.1")).toBe("18.6.0-beta.1");
  });

  it("rejects output that is not a version line", () => {
    expect(parseOmpVersion("")).toBeNull();
    expect(parseOmpVersion("error: unknown flag")).toBeNull();
    expect(parseOmpVersion("omp/18.5")).toBeNull();
  });
});

describe("rewriteCollabUrl", () => {
  it("moves a default-relay link onto the page copy and keeps the room key intact", () => {
    expect(rewriteCollabUrl(`https://my.omp.sh/#${ROOM}.${KEY}`, BASE, null)).toBe(`${BASE}#${ROOM}.${KEY}`);
  });

  it("puts the guest name in the query, before the fragment the page reads the room from", () => {
    expect(rewriteCollabUrl(`https://my.omp.sh/#${ROOM}.${KEY}`, BASE, "iphone-2")).toBe(
      `${BASE}?name=iphone-2#${ROOM}.${KEY}`,
    );
  });

  it("leaves links the copy cannot open", () => {
    // Another relay: the copy's CSP only allows wss://my.omp.sh.
    expect(rewriteCollabUrl(`https://relay.example.com/#relay.example.com/r/${ROOM}.${KEY}`, BASE, null)).toBeNull();
    // Legacy "#" form and a missing fragment.
    expect(rewriteCollabUrl(`https://my.omp.sh/#${ROOM}#${KEY}`, BASE, null)).toBeNull();
    expect(rewriteCollabUrl("https://my.omp.sh/", BASE, null)).toBeNull();
  });
});

describe("machineNameFromWhois", () => {
  it("reads the machine name, falling back to the first label of the DNS name", () => {
    expect(machineNameFromWhois('{"Node":{"ComputedName":"iphone-2","Name":"x.example.ts.net."}}')).toBe(
      "iphone-2",
    );
    expect(machineNameFromWhois('{"Node":{"Name":"ipad2.example.ts.net."}}')).toBe("ipad2");
  });

  it("returns null for output that is not a machine name", () => {
    expect(machineNameFromWhois("no peer found")).toBeNull();
    expect(machineNameFromWhois('{"Node":null}')).toBeNull();
    expect(machineNameFromWhois('{"Node":{"ComputedName":"evil name<script>"}}')).toBeNull();
  });
});

describe("pageCopyState", () => {
  it("uses the copy only when it was built for the installed omp", () => {
    expect(pageCopyState(info, "18.5.0")).toEqual({ ok: true });

    const outdated = pageCopyState(info, "18.6.0");
    expect(outdated.ok).toBe(false);
    if (!outdated.ok) expect(outdated.reason).toContain("18.6.0");

    expect(pageCopyState(null, "18.5.0").ok).toBe(false);
    expect(pageCopyState(info, null).ok).toBe(false);
  });
});

describe("shouldRebuild", () => {
  const now = 1_000_000_000;

  it("builds at once for an omp version not tried yet", () => {
    expect(shouldRebuild(null, "18.8.6", now)).toBe(true);
    expect(shouldRebuild({ version: "18.8.6", finishedAt: now - 1000, error: null }, "18.9.0", now)).toBe(true);
  });

  it("never starts a second build while one runs, even for a newer omp", () => {
    expect(shouldRebuild({ version: "18.8.6", finishedAt: null, error: null }, "18.8.6", now)).toBe(false);
    expect(shouldRebuild({ version: "18.8.6", finishedAt: null, error: null }, "18.9.0", now)).toBe(false);
  });

  it("waits REBUILD_RETRY_MS before trying the same version again", () => {
    const failed = { version: "18.8.6", finishedAt: now, error: "patch no longer applies" };
    expect(shouldRebuild(failed, "18.8.6", now + REBUILD_RETRY_MS - 1)).toBe(false);
    expect(shouldRebuild(failed, "18.8.6", now + REBUILD_RETRY_MS)).toBe(true);
  });
});

describe("parseBuildInfo", () => {
  it("accepts what build-collab.ts writes", () => {
    expect(parseBuildInfo(JSON.stringify(info))).toEqual(info);
  });

  it("rejects missing fields, bad hashes and invalid JSON", () => {
    const { commit: _commit, ...withoutCommit } = info;
    expect(parseBuildInfo(JSON.stringify(withoutCommit))).toBeNull();
    expect(parseBuildInfo(JSON.stringify({ ...info, inlineScriptHashes: ["'unsafe-inline'"] }))).toBeNull();
    expect(parseBuildInfo("{")).toBeNull();
  });
});

describe("collabCsp", () => {
  it("allows the relay and the hashed inline script, never arbitrary inline script", () => {
    const csp = collabCsp(info);
    const scriptSrc = csp.split("; ").find((d) => d.startsWith("script-src "));
    expect(scriptSrc).toBe("script-src 'self' 'sha256-xhvE/bGVoHeSC1+kb6i3RctL95c2hahU7q54ZGfm0Uo='");
    expect(csp).toContain("connect-src 'self' wss://my.omp.sh");
  });
});

describe("resolveCollabPath", () => {
  const dist = "/srv/collab-dist";

  it("maps the root and asset paths inside the build directory", () => {
    expect(resolveCollabPath(dist, "/")).toBe("/srv/collab-dist/index.html");
    expect(resolveCollabPath(dist, "/6tetmte6.js")).toBe("/srv/collab-dist/6tetmte6.js");
  });

  it("refuses paths that leave the build directory", () => {
    expect(resolveCollabPath(dist, "/../server.ts")).toBeNull();
    expect(resolveCollabPath(dist, "/%2e%2e/server.ts")).toBeNull();
    expect(resolveCollabPath(dist, "/assets/..%2F..%2Fserver.ts")).toBeNull();
    expect(resolveCollabPath(dist, "/%00")).toBeNull();
    expect(resolveCollabPath(dist, "/%E0%A4%A")).toBeNull();
  });
});

describe("collabCacheControl", () => {
  it("caches content-hashed files forever and revalidates the rest", () => {
    expect(collabCacheControl("6tetmte6.js")).toBe("public, max-age=31536000, immutable");
    expect(collabCacheControl("index.html")).toBe("no-cache");
    expect(collabCacheControl("favicon.png")).toBe("no-cache");
  });
});
