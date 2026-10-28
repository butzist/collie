import { describe, expect, test } from "bun:test";

import type { JsonObject } from "../json.ts";
import {
  OPENCODE_PLUGIN_ANSWER_MAX,
  OPENCODE_PLUGIN_LINE_MAX,
  parseOpencodePluginLine,
  parseOpencodePluginRequest,
  parseOpencodePluginResponse,
} from "./parse.ts";

// The channel's two directions are parsed by two functions on purpose: a plugin's ANSWER must never
// be read as a question. These pin both parsers and the boundary between them.

const line = (value: JsonObject): string => JSON.stringify(value);
const SESSION = "ses_0123456789abcdefABCDEFghij";

describe("parseOpencodePluginRequest", () => {
  test("a register carries the session it will answer for", () => {
    expect(parseOpencodePluginRequest(line({ v: 1, type: "register", sessionId: SESSION }))).toEqual({
      v: 1,
      type: "register",
      sessionId: SESSION,
    });
  });

  test("a legacy pane id is tolerated and dropped", () => {
    // The pre-2.1 plugin named a pane; OpenCode 2 has no pane to name, and nothing here maps one.
    expect(
      parseOpencodePluginRequest(line({ v: 1, type: "register", sessionId: SESSION, paneId: "w1:p1" })),
    ).toEqual({ v: 1, type: "register", sessionId: SESSION });
  });

  test("a session id that is not opencode's shape is refused", () => {
    for (const sessionId of ["", "ses_short", "ses_" + "x".repeat(65), "../etc/passwd", "ses_bad-id"]) {
      expect(parseOpencodePluginRequest(line({ v: 1, type: "register", sessionId }))).toBeNull();
    }
  });

  test("a history request carries its id, cursor and limit", () => {
    expect(
      parseOpencodePluginRequest(
        line({ v: 1, type: "history", id: "h_1", sessionId: SESSION, after: "msg_1", limit: 25 }),
      ),
    ).toEqual({ v: 1, type: "history", id: "h_1", sessionId: SESSION, after: "msg_1", limit: 25 });
  });

  test("a limit outside the protocol's range is refused, not clamped", () => {
    for (const limit of [0, -1, 1.5, 1001, "10", null]) {
      expect(parseOpencodePluginRequest(line({ v: 1, type: "history", id: "h_1", sessionId: SESSION, limit }))).toBeNull();
    }
  });

  test("anything without v:1 is not a request", () => {
    expect(parseOpencodePluginRequest(line({ type: "register", sessionId: SESSION }))).toBeNull();
    expect(parseOpencodePluginRequest(line({ v: 2, type: "register", sessionId: SESSION }))).toBeNull();
  });

  test("a plugin's ANSWER is not a request", () => {
    expect(
      parseOpencodePluginRequest(line({ ok: true, type: "history", id: "h_1", sessionId: SESSION, entries: [] })),
    ).toBeNull();
    expect(parseOpencodePluginRequest(line({ ok: false, type: "history", id: "h_1", error: "failed" }))).toBeNull();
    expect(parseOpencodePluginRequest(line({ ok: true, type: "registered" }))).toBeNull();
  });

  test("a broken or non-object line is null", () => {
    expect(parseOpencodePluginRequest("not json")).toBeNull();
    expect(parseOpencodePluginRequest("[]")).toBeNull();
    expect(parseOpencodePluginRequest("null")).toBeNull();
  });
});

describe("parseOpencodePluginResponse", () => {
  test("the registration ack", () => {
    expect(parseOpencodePluginResponse(line({ ok: true, type: "registered" }))).toEqual({ ok: true, type: "registered" });
  });

  test("a history answer keeps its id, entries and window flag", () => {
    expect(
      parseOpencodePluginResponse(
        line({ ok: true, type: "history", id: "h_1", entries: [{ id: "msg_1" }], more: true }),
      ),
    ).toMatchObject({ ok: true, type: "history", id: "h_1", entries: [{ id: "msg_1" }], more: true });
  });

  test("an answer without an entries array is not an answer", () => {
    expect(parseOpencodePluginResponse(line({ ok: true, type: "history", id: "h_1" }))).toBeNull();
    expect(parseOpencodePluginResponse(line({ ok: true, type: "history", id: "h_1", entries: "x" }))).toBeNull();
  });

  test("a failure keeps the id so a request can be matched to it", () => {
    expect(parseOpencodePluginResponse(line({ ok: false, type: "history", id: "h_1", error: "failed" }))).toEqual({
      ok: false,
      type: "history",
      id: "h_1",
      error: "failed",
    });
  });

  test("a failure with no words still carries one", () => {
    expect(parseOpencodePluginResponse(line({ ok: false, type: "history", id: "h_1" }))).toMatchObject({
      ok: false,
      error: "failed",
    });
  });

  test("a request is not an answer", () => {
    expect(parseOpencodePluginResponse(line({ v: 1, type: "register", sessionId: SESSION }))).toBeNull();
    expect(parseOpencodePluginResponse(line({ v: 1, type: "history", id: "h_1", sessionId: SESSION }))).toBeNull();
  });

  test("the line cap is large enough for a page and small enough to bound one", () => {
    expect(OPENCODE_PLUGIN_LINE_MAX).toBe(64 * 1024);
  });
});

describe("parseOpencodePluginLine", () => {
  test("one line is decided once: request, answer, or neither", () => {
    const request = parseOpencodePluginLine(line({ v: 1, type: "register", sessionId: SESSION }));
    expect(request.kind).toBe("request");
    const answer = parseOpencodePluginLine(line({ ok: true, type: "registered" }));
    expect(answer.kind).toBe("response");
    expect(parseOpencodePluginLine("nonsense").kind).toBe("invalid");
    expect(parseOpencodePluginLine(line({ ok: "yes" })).kind).toBe("invalid");
  });

  test("an answer's ceiling is far above a request's, and both are bounded", () => {
    // A real 130-message page measured 1,012,799 bytes; the request cap would have closed the socket.
    expect(OPENCODE_PLUGIN_ANSWER_MAX).toBeGreaterThan(OPENCODE_PLUGIN_LINE_MAX * 100);
    expect(OPENCODE_PLUGIN_ANSWER_MAX).toBe(32 * 1024 * 1024);
  });
});
