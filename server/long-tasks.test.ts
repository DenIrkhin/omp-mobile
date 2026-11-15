import { describe, expect, it } from "bun:test";
import {
  parsePins,
  parseSessionHead,
  reopenCommand,
  sessionIdFromFileName,
  setPinned,
  validatePinRequest,
  validateReopenRequest,
} from "./long-tasks";

const ID = "01a13694-3e14-7026-a2da-8aae16651d32";
const OTHER = "019f889f-8e9a-7000-953a-d2c3960c6cda";
const AGENT_DIR = "/Users/you/.omp/profiles/work/agent";
const SESSION_PATH = `${AGENT_DIR}/sessions/--Users-you-dev-005nova--/2026-10-13T18-44-07-316Z_${ID}.jsonl`;

function slotLine(title: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "title",
    v: 1,
    title,
    source: "user",
    updatedAt: "2026-10-13T18:44:07.316Z",
    pad: " ".repeat(40),
    ...extra,
  });
}

function headerLine(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "session",
    version: 3,
    id: ID,
    timestamp: "2026-10-13T18:44:07.316Z",
    cwd: "/Users/you/dev/005nova",
    ...extra,
  });
}

describe("parsePins", () => {
  it("reads omp's tab-indented array", () => {
    expect(parsePins(JSON.stringify([ID, OTHER], null, "\t"))).toEqual([ID, OTHER]);
  });

  it("treats a corrupt, empty or non-array file as no pins", () => {
    for (const text of ["", "[\"01a1", "{}", "null", "\"01a13694\"", `{"pins":["${ID}"]}`]) {
      expect(parsePins(text)).toEqual([]);
    }
  });

  it("keeps string entries only and drops repeats, first position winning", () => {
    expect(parsePins(JSON.stringify([OTHER, 7, null, ID, OTHER, { id: ID }]))).toEqual([OTHER, ID]);
  });
});

describe("setPinned", () => {
  it("appends a new pin after the existing ones", () => {
    expect(setPinned([OTHER], ID, true)).toEqual([OTHER, ID]);
  });

  it("leaves the list as it was when the id is already pinned", () => {
    expect(setPinned([ID, OTHER], ID, true)).toEqual([ID, OTHER]);
  });

  it("removes only the given id, keeping the order of the rest", () => {
    const third = "01a104aa-b5c1-75dc-8a2e-fec33fb0c3d8";
    expect(setPinned([OTHER, ID, third], ID, false)).toEqual([OTHER, third]);
  });

  it("unpinning an id that is not pinned changes nothing", () => {
    expect(setPinned([OTHER], ID, false)).toEqual([OTHER]);
    expect(setPinned([], ID, false)).toEqual([]);
  });

  it("does not modify the list it was given", () => {
    const ids = [OTHER];
    setPinned(ids, ID, true);
    setPinned(ids, OTHER, false);
    expect(ids).toEqual([OTHER]);
  });
});

describe("sessionIdFromFileName", () => {
  it("takes the id from a session file name", () => {
    expect(sessionIdFromFileName(`2026-10-13T18-44-07-316Z_${ID}.jsonl`)).toBe(ID);
  });

  it("ignores artifact folders, temp files and other names", () => {
    for (const name of [
      `2026-10-13T18-44-07-316Z_${ID}`,
      `2026-10-13T18-44-07-316Z_${ID}.jsonl.tmp`,
      `${ID}.jsonl`,
      `2026-10-13T18-44-07-316Z_${ID.toUpperCase()}.jsonl`,
      "notes.jsonl",
    ]) {
      expect(sessionIdFromFileName(name)).toBeNull();
    }
  });
});

describe("parseSessionHead", () => {
  it("reads the title slot and the header after it, emoji included", () => {
    const head = `${slotLine("📧 inbox triage")}\n${headerLine({ title: "older title" })}\n{"type":"model_change"}\n`;
    expect(parseSessionHead(head)).toEqual({
      sessionId: ID,
      title: "📧 inbox triage",
      cwd: "/Users/you/dev/005nova",
    });
  });

  it("reports no title when the slot's title is empty, even if the header has one", () => {
    expect(parseSessionHead(`${slotLine("")}\n${headerLine({ title: "older title" })}\n`)?.title).toBeNull();
    expect(parseSessionHead(`${slotLine("   ")}\n${headerLine()}\n`)?.title).toBeNull();
  });

  it("reads files without a title slot, taking the header's title when it has one", () => {
    expect(parseSessionHead(`${headerLine({ title: "release-notes" })}\n`)).toEqual({
      sessionId: ID,
      title: "release-notes",
      cwd: "/Users/you/dev/005nova",
    });
    expect(parseSessionHead(`${headerLine()}\n`)?.title).toBeNull();
  });

  it("accepts a header cut off right after its closing brace", () => {
    expect(parseSessionHead(`${slotLine("x")}\n${headerLine()}`)?.sessionId).toBe(ID);
  });

  it("returns null without a complete, valid session header", () => {
    const full = headerLine();
    for (const head of [
      "",
      `${slotLine("x")}\n`,
      `${slotLine("x")}\n${full.slice(0, 60)}`,
      `${headerLine({ cwd: "" })}\n`,
      `${headerLine({ cwd: undefined })}\n`,
      `${headerLine({ id: "not-a-session-id" })}\n`,
      `${headerLine({ type: "message" })}\n`,
      // A first line that is not a valid slot is not skipped: it must be the header itself.
      `${slotLine("x", { v: 2 })}\n${full}\n`,
      `garbage\n${full}\n`,
    ]) {
      expect(parseSessionHead(head)).toBeNull();
    }
  });
});

describe("validatePinRequest", () => {
  it("accepts a session id with true or false", () => {
    expect(validatePinRequest({ sessionId: ID, pinned: true })).toEqual({ req: { sessionId: ID, pinned: true } });
    expect(validatePinRequest({ sessionId: ID, pinned: false })).toEqual({ req: { sessionId: ID, pinned: false } });
  });

  it("rejects anything but an object", () => {
    for (const body of [null, "x", 1, undefined]) {
      expect(validatePinRequest(body).error).toBe("Request body must be a JSON object");
    }
  });

  it("rejects malformed session ids, including path tricks and padding", () => {
    for (const sessionId of [ID.toUpperCase(), ` ${ID}`, `${ID}/../x`, ID.slice(0, -1), `../${ID}`, 42, undefined]) {
      expect(validatePinRequest({ sessionId, pinned: true }).error).toBe("sessionId must be an omp session id");
    }
  });

  it("requires pinned to be a real boolean", () => {
    for (const pinned of ["true", 1, null, undefined]) {
      expect(validatePinRequest({ sessionId: ID, pinned }).error).toBe("pinned must be true or false");
    }
  });
});

describe("validateReopenRequest", () => {
  it("accepts a session id", () => {
    expect(validateReopenRequest({ sessionId: ID })).toEqual({ req: { sessionId: ID } });
  });

  it("rejects a missing body or a malformed id", () => {
    expect(validateReopenRequest(null).error).toBe("Request body must be a JSON object");
    expect(validateReopenRequest({ sessionId: "abc" }).error).toBe("sessionId must be an omp session id");
    expect(validateReopenRequest({}).error).toBe("sessionId must be an omp session id");
  });
});

/** The arguments a POSIX shell passes to `omp` when it runs `command`. */
function shellArgs(command: string): string[] {
  const proc = Bun.spawnSync(["/bin/sh", "-c", `omp() { printf '%s\\n' "$@"; }; ${command}`]);
  return proc.stdout.toString().split("\n").slice(0, -1);
}

describe("reopenCommand", () => {
  it("resumes the file under its profile", () => {
    const command = reopenCommand({ path: SESSION_PATH, agentDir: AGENT_DIR, profile: "work" });
    expect(command).toBe(`omp --profile=work --resume '${SESSION_PATH}'`);
  });

  it("leaves out --profile for the default agent dir", () => {
    const agentDir = "/Users/you/.omp/agent";
    const path = `${agentDir}/sessions/--Users-you-dev--/2026-10-13T18-44-07-316Z_${ID}.jsonl`;
    expect(reopenCommand({ path, agentDir, profile: null })).toBe(`omp --resume '${path}'`);
  });

  it("hands the shell the exact path even with quotes, spaces and shell syntax in it", () => {
    const path = `${AGENT_DIR}/sessions/--Users-it's $(here) \`x\` \\ "q"--/2026_${ID}.jsonl`;
    expect(shellArgs(reopenCommand({ path, agentDir: AGENT_DIR, profile: "work" }))).toEqual([
      "--profile=work",
      "--resume",
      path,
    ]);
  });

  it("refuses files outside the agent dir's sessions folder", () => {
    for (const path of [
      `sessions/--x--/2026_${ID}.jsonl`,
      `${AGENT_DIR}/sessions/../../../../etc/2026_${ID}.jsonl`,
      `${AGENT_DIR}/2026_${ID}.jsonl`,
      `${AGENT_DIR}-evil/sessions/--x--/2026_${ID}.jsonl`,
      `${AGENT_DIR}/sessions//--x--/2026_${ID}.jsonl`,
      `${AGENT_DIR}/sessions/--x--/2026_${ID}.json`,
    ]) {
      expect(() => reopenCommand({ path, agentDir: AGENT_DIR, profile: "work" })).toThrow("Not a session file");
    }
  });

  it("refuses control characters, which cmux would type as keys", () => {
    for (const path of [`${AGENT_DIR}/sessions/--x\n--/2026_${ID}.jsonl`, `${AGENT_DIR}/sessions/--x\u001b--/2026_${ID}.jsonl`]) {
      expect(() => reopenCommand({ path, agentDir: AGENT_DIR, profile: "work" })).toThrow("Not a session file");
    }
  });

  it("refuses profile names that are not shell-safe", () => {
    for (const profile of ["omni work", "a;b", "$(x)", ""]) {
      expect(() => reopenCommand({ path: SESSION_PATH, agentDir: AGENT_DIR, profile })).toThrow("not shell-safe");
    }
  });
});
