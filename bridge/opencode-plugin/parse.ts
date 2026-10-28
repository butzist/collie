// The opencode plugin channel protocol parsing (JSON lines).

import { isOpencodeSessionId } from "../journal/opencode.ts";

export const OPENCODE_PLUGIN_LINE_MAX = 64 * 1024;
export const HISTORY_REQUEST_TIMEOUT_MS = 30000;

export type OpencodePluginRequest =
  | { v: 1; type: "register"; sessionId: string; paneId?: string }
  | { v: 1; type: "history"; id: string; sessionId: string; after?: string; limit?: number };

export type OpencodePluginResponse =
  | { ok: true; type: "registered" }
  | { ok: true; type: "history"; id: string; entries: unknown[]; more?: boolean; next?: string }
  | { ok: false; type?: string; error: string };

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}

function asString(x: unknown): string | null {
  return typeof x === "string" && x !== "" ? x : null;
}

function asNumber(x: unknown): number | null {
  return typeof x === "number" && Number.isFinite(x) ? x : null;
}

export function parseOpencodePluginRequest(line: string): OpencodePluginRequest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  if (parsed.v !== 1) return null;
  const type = parsed.type;
  if (type === "register") {
    const sessionId = asString(parsed.sessionId);
    if (sessionId === null || !isOpencodeSessionId(sessionId)) return null;
    const paneId = asString(parsed.paneId) ?? undefined;
    return { v: 1, type: "register", sessionId, paneId };
  }
  if (type === "history") {
    const id = asString(parsed.id);
    const sessionId = asString(parsed.sessionId);
    if (id === null || sessionId === null || !isOpencodeSessionId(sessionId)) return null;
    const after = asString(parsed.after) ?? undefined;
    let limit: number | undefined;
    const lim = parsed.limit;
    if (lim !== undefined) {
      const n = asNumber(lim);
      if (n === null || !Number.isInteger(n) || n < 1 || n > 1000) return null;
      limit = n;
    }
    return { v: 1, type: "history", id, sessionId, after, limit };
  }
  return null;
}
