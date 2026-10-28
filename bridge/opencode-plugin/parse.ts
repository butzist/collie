// The opencode plugin channel protocol (JSON lines over a Unix socket).
//
// THE CHANNEL HAS TWO DIRECTIONS AND ONE LINE IS ONLY EVER ONE OF THEM. Upward, a plugin sends a
// request: `register` (the sessions it will answer for) or `history` (a question this channel's
// grammar still names, which the bridge refuses honestly — Collie is the one that asks). Downward,
// Collie sends a `history` request and the plugin answers `{ok,type:"history",id,…}`. A request
// carries `v:1`; a response carries `ok`. Keeping the two parsers apart is the whole point: the
// first cut fed every inbound line to the REQUEST parser, so each perfectly good answer came back
// to the plugin as `{"ok":false,"error":"bad request"}`.
//
// Parsing happens here, at the socket boundary, and nowhere else (`no-runtime-typeof` is scoped off
// for this file in .oxlintrc.json for that reason). Callers get named domain values.

import { isOpencodeSessionId } from "../journal/opencode.ts";
import type { JsonObject, JsonValue } from "../json.ts";

/** One line may not exceed this before the connection is refused (a plugin's request is tiny). */
export const OPENCODE_PLUGIN_LINE_MAX = 64 * 1024;
/**
 * An ANSWER's ceiling, while a request is in flight.
 *
 * A whole session's messages travel in one line, and a real 130-message page measured 1,012,799
 * bytes, so the request-sized cap above would close the socket on every honest answer — the first
 * cut did exactly that. 1000 entries (the protocol's own limit) with tool output is the worst case.
 */
export const OPENCODE_PLUGIN_ANSWER_MAX = 32 * 1024 * 1024;
/** How long the bridge waits for a plugin's answer before treating the channel as absent. */
export const HISTORY_REQUEST_TIMEOUT_MS = 30_000;

/** A `history` answer as the bridge consumes it. */
export interface PluginHistoryAnswer {
  readonly entries: JsonValue[];
  readonly more: boolean;
}

export type OpencodePluginRequest =
  | { v: 1; type: "register"; sessionId: string }
  | { v: 1; type: "history"; id: string; sessionId: string; after?: string; limit?: number };

export type OpencodePluginResponse =
  | { ok: true; type: "registered" }
  | { ok: true; type: "history"; id: string; entries: JsonValue[]; more?: boolean; next?: string }
  | { ok: false; type?: "history"; id?: string; error: string };

function asObject(value: JsonValue | undefined): JsonObject | null {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) return null;
  return value;
}

function asString(value: JsonValue | undefined): string | null {
  if (typeof value !== "string" || value === "") return null;
  return value;
}

function asNumber(value: JsonValue | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

function parseLine(line: string): JsonObject | null {
  let parsed: JsonValue;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  return asObject(parsed);
}

/** One line, decided ONCE: a request, an answer, or neither. The socket parses a megabyte a time. */
export type OpencodePluginLine =
  | { kind: "request"; request: OpencodePluginRequest }
  | { kind: "response"; response: OpencodePluginResponse }
  | { kind: "invalid" };

function requestOf(parsed: JsonObject): OpencodePluginRequest | null {
  if (parsed.v !== 1) return null;
  const type = parsed.type;
  if (type === "register") {
    const sessionId = asString(parsed.sessionId);
    if (sessionId === null || !isOpencodeSessionId(sessionId)) return null;
    return { v: 1, type: "register", sessionId };
  }
  if (type === "history") {
    const id = asString(parsed.id);
    const sessionId = asString(parsed.sessionId);
    if (id === null || sessionId === null || !isOpencodeSessionId(sessionId)) return null;
    const after = asString(parsed.after) ?? undefined;
    const raw = parsed.limit;
    let limit: number | undefined;
    if (raw !== undefined) {
      const n = asNumber(raw);
      if (n === null || !Number.isInteger(n) || n < 1 || n > 1000) return null;
      limit = n;
    }
    return { v: 1, type: "history", id, sessionId, after, limit };
  }
  return null;
}

function responseOf(parsed: JsonObject): OpencodePluginResponse | null {
  if (typeof parsed.ok !== "boolean") return null;
  if (parsed.ok) {
    if (parsed.type === "registered") return { ok: true, type: "registered" };
    if (parsed.type !== "history") return null;
    const id = asString(parsed.id);
    const entries = parsed.entries;
    if (id === null || !Array.isArray(entries)) return null;
    const more = parsed.more === true ? true : undefined;
    const next = asString(parsed.next) ?? undefined;
    return { ok: true, type: "history", id, entries, more, next };
  }
  const error = asString(parsed.error) ?? "failed";
  const id = asString(parsed.id) ?? undefined;
  const type = parsed.type === "history" ? "history" : undefined;
  return { ok: false, type, id, error };
}

/**
 * A plugin's request. Null for anything that is not one, including a plugin's own ANSWER — the
 * called side must never read a response as a question.
 */
export function parseOpencodePluginRequest(line: string): OpencodePluginRequest | null {
  const parsed = parseLine(line);
  return parsed === null ? null : requestOf(parsed);
}

/** A plugin's answer. Null for anything that is not one, including a request. */
export function parseOpencodePluginResponse(line: string): OpencodePluginResponse | null {
  const parsed = parseLine(line);
  return parsed === null ? null : responseOf(parsed);
}

/** One JSON.parse per line, and the two schemas are tried in the only order that is unambiguous. */
export function parseOpencodePluginLine(line: string): OpencodePluginLine {
  const parsed = parseLine(line);
  if (parsed === null) return { kind: "invalid" };
  const request = requestOf(parsed);
  if (request !== null) return { kind: "request", request };
  const response = responseOf(parsed);
  if (response !== null) return { kind: "response", response };
  return { kind: "invalid" };
}
