// A running opencode plugin's answer, shaped like the journal the History screen already renders.
//
// WHY THIS EXISTS AT ALL. `GET /api/pane/:id/history` normally reads the harness's own log off disk.
// OpenCode keeps its sessions in one SQLite database, and a running server also holds them in
// memory — so when the database has nothing for a session (the row has not been written yet, the
// file is unreadable, or this process is not the one that owns it), the plugin that is already
// attached to the server can still answer. This module is the seam between that answer and
// `TranscriptPage`: it renders the plugin's model-facing messages as ordinary turns.
//
// WHAT IS DELIBERATELY DROPPED. `ctx.session.context()` is the MODEL's context, not the transcript:
// it carries the system prompt, skill bodies, idle markers, model/agent switches and compaction
// bookkeeping. None of that is speech. Only `user`, `assistant` and `synthetic` messages survive as
// turns, and an assistant block goes through the journal's own part mapper (`opencodePart`) so a
// tool call or a reasoning block reads exactly as it does on the database path.
//
// PAGING IS THE JOURNAL'S. The plugin answers forward (newest window, or entries after a cursor);
// the phone pages backwards (`?before=`). So the bridge asks for the widest window the protocol
// allows and slices it with `pageEntries` — one paging rule for both sources, and the same "an
// unknown cursor degrades to the newest page" behaviour.

import type { JsonObject, JsonValue } from "../json.ts";
import { opencodePart } from "../journal/opencode.ts";
import { pageEntries } from "../journal/store.ts";
import type { TranscriptEntry, TranscriptPage } from "../journal/types.ts";
import type { PluginHistoryAnswer } from "./parse.ts";

/** The protocol's ceiling, and what a fallback page asks for in one round trip. */
export const PLUGIN_HISTORY_LIMIT = 1000;
/**
 * How long a History request waits for a plugin before falling back to the journal's answer.
 *
 * Far shorter than the socket's own timeout: the plugin runs on this machine and answers from
 * memory in milliseconds, so a wedged one must not hold a phone's History screen for 30 s.
 */
export const PLUGIN_HISTORY_TIMEOUT_MS = 5_000;

/** What the bridge needs from the plugin channel — `OpencodePluginServer.history`, structurally. */
export type PluginHistoryReader = (
  sessionId: string,
  params: { after?: string; limit?: number },
) => Promise<PluginHistoryAnswer | null>;

function asObject(value: JsonValue | undefined): JsonObject | null {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) return null;
  return value;
}

function asString(value: JsonValue | undefined): string | null {
  if (typeof value !== "string" || value === "") return null;
  return value;
}

/** The log's own timestamp, ISO as the wire carries it; empty when the row named none. */
function isoOf(time: JsonValue | undefined): string {
  const record = asObject(time);
  const created = record?.created;
  if (typeof created !== "number" || !Number.isFinite(created)) return "";
  return new Date(created).toISOString();
}

function textParts(text: JsonValue | undefined): TranscriptEntry["parts"] {
  if (typeof text !== "string" || text.trim() === "") return [];
  const part = opencodePart({ type: "text", text });
  return part === null ? [] : [part];
}

function assistantParts(content: JsonValue | undefined): TranscriptEntry["parts"] {
  if (!Array.isArray(content)) return [];
  const parts: TranscriptEntry["parts"] = [];
  for (const block of content) {
    const part = opencodePart(block);
    if (part !== null) parts.push(part);
  }
  return parts;
}

/**
 * One turn per message a person or the agent said. Model bookkeeping is not a turn and never
 * becomes one, which is why the switch names the three roles it keeps rather than skipping the rest.
 */
export function transcriptFromPlugin(entries: readonly JsonValue[]): TranscriptEntry[] {
  const turns: TranscriptEntry[] = [];
  for (const entry of entries) {
    const message = asObject(entry);
    if (message === null) continue;
    const uuid = asString(message.id);
    const type = asString(message.type);
    if (uuid === null || type === null) continue;
    let role: TranscriptEntry["role"];
    let parts: TranscriptEntry["parts"];
    if (type === "user") {
      role = "user";
      parts = textParts(message.text);
    } else if (type === "assistant") {
      role = "assistant";
      parts = assistantParts(message.content);
    } else if (type === "synthetic") {
      role = "note";
      parts = textParts(message.text);
    } else {
      continue;
    }
    if (parts.length === 0) continue;
    turns.push({ uuid, ts: isoOf(message.time), role, parts });
  }
  return turns;
}

/**
 * Read one page of a session's history from a plugin, or null when the channel has nothing.
 *
 * Null is the same "nothing to serve" the store answers: no live plugin for the session, an error
 * answer, a timeout, or a session with no speech in it at all. The caller keeps whatever the journal
 * said, so a plugin that knows less than the database never makes the answer worse.
 *
 * ONE ROUND TRIP, THE WIDEST WINDOW THE PROTOCOL ALLOWS. The plugin answers forward (its newest
 * messages, or entries after a cursor) while the phone pages backwards, so paging is sliced here.
 * The cost is that a conversation longer than {@link PLUGIN_HISTORY_LIMIT} pages only inside that
 * newest window through this channel; reaching further back is the journal's job, and this route is
 * only asked when the journal had nothing.
 */
export async function historyPageFromPlugin(
  read: PluginHistoryReader,
  sessionId: string,
  page: { limit: number; before?: string },
): Promise<Omit<TranscriptPage, "paneId"> | null> {
  const answer = await read(sessionId, { limit: PLUGIN_HISTORY_LIMIT });
  if (answer === null) return null;
  const entries = transcriptFromPlugin(answer.entries);
  if (entries.length === 0) return null;
  const { window, hasMore } = pageEntries(entries, page);
  return {
    entries: window,
    // The plugin clipped older messages off its own window: when our page starts at the oldest entry
    // it returned, there is history behind it that this round trip did not carry.
    hasMore: hasMore || (answer.more && window.length > 0 && window[0] === entries[0]),
    total: entries.length,
    // Nothing was clipped off a file: the plugin answered from memory, not from a tail read.
    fileTruncated: false,
  };
}
