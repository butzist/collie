import { describe, expect, test } from "bun:test";

import type { JsonObject } from "../json.ts";
import type { PluginHistoryAnswer } from "./parse.ts";
import {
  historyPageFromPlugin,
  PLUGIN_HISTORY_LIMIT,
  PLUGIN_HISTORY_TIMEOUT_MS,
  transcriptFromPlugin,
  type PluginHistoryReader,
} from "./history.ts";

// The converter's whole job is to keep the model's context from reading as a transcript: speech and
// notes survive, the scaffolding (system prompt, skills, idle markers, switches) does not.

const at = (n: number): JsonObject => ({ created: 1_700_000_000_000 + n });

const user = (id: string, text: string, n = 0): JsonObject => ({ id, type: "user", time: at(n), text });

const assistantText = (id: string, text: string, n = 0): JsonObject => ({
  id,
  type: "assistant",
  time: at(n),
  content: [{ type: "text", text }],
});

describe("transcriptFromPlugin", () => {
  test("a user turn and an assistant turn become speech", () => {
    const turns = transcriptFromPlugin([user("msg_u", "hello", 1), assistantText("msg_a", "hi there", 2)]);
    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({ uuid: "msg_u", role: "user", parts: [{ kind: "text", text: "hello" }] });
    expect(turns[1]).toMatchObject({ uuid: "msg_a", role: "assistant", parts: [{ kind: "text", text: "hi there" }] });
    expect(turns[0]?.ts).toBe(new Date(1_700_000_000_001).toISOString());
  });

  test("an assistant's reasoning and tool calls keep the journal's rendering", () => {
    const turns = transcriptFromPlugin([
      {
        id: "msg_a",
        type: "assistant",
        time: at(1),
        content: [
          { type: "reasoning", text: "let me look" },
          { type: "text", text: "reading the folder" },
          {
            type: "tool",
            id: "call_1",
            name: "bash",
            time: at(2),
            state: { status: "completed", input: { command: "ls -la" }, content: [{ type: "text", text: "a.txt\nb.txt" }] },
          },
        ],
      },
    ]);
    const parts = turns[0]?.parts ?? [];
    expect(parts.map((part) => part.kind)).toEqual(["thinking", "text", "tool"]);
    expect(parts[2]).toMatchObject({ kind: "tool", name: "bash", summary: "ls -la" });
  });

  test("a synthetic message is a note, not the agent speaking", () => {
    const turns = transcriptFromPlugin([{ id: "msg_s", type: "synthetic", time: at(1), text: "background task done" }]);
    expect(turns).toEqual([
      { uuid: "msg_s", ts: new Date(1_700_000_000_001).toISOString(), role: "note", parts: [{ kind: "text", text: "background task done" }] },
    ]);
  });

  test("model bookkeeping never becomes a turn", () => {
    // Every one of these is in a real `ctx.session.context()` answer; none is speech.
    const entries: JsonObject[] = [
      { id: "msg_sys", type: "system", time: at(1), text: "You are a helpful assistant." },
      { id: "msg_idle", type: "idle", time: at(2), outcome: "succeeded" },
      { id: "msg_model", type: "model-switched", time: at(3), model: { providerID: "p", id: "m" } },
      { id: "msg_agent", type: "agent-switched", time: at(4), agent: "build" },
      { id: "msg_loc", type: "location-switched", time: at(5), location: { directory: "/tmp" } },
      { id: "msg_skill", type: "skill", time: at(6), skill: "s1", name: "review", text: "a skill body" },
      { id: "msg_comp", type: "compaction", time: at(7), status: "completed", reason: "auto" },
      { id: "msg_shell", type: "shell", time: at(8), shellID: "sh1", command: "ls", status: "exited" },
    ];
    expect(transcriptFromPlugin(entries)).toEqual([]);
  });

  test("a turn with nothing to show is dropped, an entry with no id or an unknown shape too", () => {
    const turns = transcriptFromPlugin([
      user("msg_empty", "   "),
      { id: "msg_no_text", type: "user", time: at(1) },
      { id: "msg_no_content", type: "assistant", time: at(2) },
      { type: "user", time: at(3), text: "no id" },
      { id: "msg_unknown", type: "something-new", time: at(4), text: "who knows" },
      "not an object",
      null,
    ]);
    expect(turns).toEqual([]);
  });

  test("a turn without a timestamp still renders", () => {
    const turns = transcriptFromPlugin([{ id: "msg_u", type: "user", text: "hello" }]);
    expect(turns[0]?.ts).toBe("");
  });

  test("a session's turns keep their order", () => {
    const turns = transcriptFromPlugin([
      user("msg_1", "one", 1),
      assistantText("msg_2", "two", 2),
      user("msg_3", "three", 3),
    ]);
    expect(turns.map((turn) => turn.uuid)).toEqual(["msg_1", "msg_2", "msg_3"]);
  });
});

describe("historyPageFromPlugin", () => {
  const conversation = (count: number): JsonObject[] =>
    Array.from({ length: count }, (_, i) =>
      i % 2 === 0 ? user(`msg_${String(i).padStart(2, "0")}`, `turn ${i}`, i) : assistantText(`msg_${String(i).padStart(2, "0")}`, `reply ${i}`, i),
    );

  function reader(answer: PluginHistoryAnswer | null) {
    const calls: { sessionId: string; limit?: number; after?: string }[] = [];
    const read: PluginHistoryReader = async (sessionId, params) => {
      calls.push({ sessionId, ...params });
      return answer;
    };
    return { read, calls };
  }

  test("the newest page is the tail, and the prompt is the protocol's widest window", async () => {
    const { read, calls } = reader({ entries: conversation(10), more: false });
    const page = await historyPageFromPlugin(read, "ses_0123456789abcdefABCDEFghij", { limit: 3 });
    expect(page?.entries.map((entry) => entry.uuid)).toEqual(["msg_07", "msg_08", "msg_09"]);
    expect(page?.hasMore).toBe(true);
    expect(page?.total).toBe(10);
    expect(page?.fileTruncated).toBe(false);
    // Paging is local (the phone pages backwards, the plugin answers forwards), so one wide ask.
    expect(calls).toEqual([{ sessionId: "ses_0123456789abcdefABCDEFghij", limit: PLUGIN_HISTORY_LIMIT }]);
  });

  test("a before-cursor pages backwards from a turn already held", async () => {
    const { read } = reader({ entries: conversation(10), more: false });
    const page = await historyPageFromPlugin(read, "ses_0123456789abcdefABCDEFghij", { limit: 2, before: "msg_05" });
    expect(page?.entries.map((entry) => entry.uuid)).toEqual(["msg_03", "msg_04"]);
    expect(page?.hasMore).toBe(true);
  });

  test("the oldest page says there is nothing behind it", async () => {
    const { read } = reader({ entries: conversation(4), more: false });
    const page = await historyPageFromPlugin(read, "ses_0123456789abcdefABCDEFghij", { limit: 10 });
    expect(page?.entries).toHaveLength(4);
    expect(page?.hasMore).toBe(false);
  });

  test("a stale cursor degrades to the newest page rather than an empty one", async () => {
    const { read } = reader({ entries: conversation(4), more: false });
    const page = await historyPageFromPlugin(read, "ses_0123456789abcdefABCDEFghij", { limit: 2, before: "msg_gone" });
    expect(page?.entries.map((entry) => entry.uuid)).toEqual(["msg_02", "msg_03"]);
  });

  test("a window the plugin itself clipped still reports older history", async () => {
    const { read } = reader({ entries: conversation(4), more: true });
    const page = await historyPageFromPlugin(read, "ses_0123456789abcdefABCDEFghij", { limit: 10 });
    expect(page?.hasMore).toBe(true);
  });

  test("a clipped window that the local page already walked past is not a second claim", async () => {
    const { read } = reader({ entries: conversation(4), more: true });
    const page = await historyPageFromPlugin(read, "ses_0123456789abcdefABCDEFghij", { limit: 2, before: "msg_03" });
    expect(page?.entries.map((entry) => entry.uuid)).toEqual(["msg_01", "msg_02"]);
    // Entries before msg_01 exist in the plugin's own clipped tail, but our page does not start
    // there, so the local answer is the honest one.
    expect(page?.hasMore).toBe(true);
  });

  test("an absent channel or a session with no speech is null, never an empty page", async () => {
    expect(await historyPageFromPlugin(async () => null, "ses_0123456789abcdefABCDEFghij", { limit: 10 })).toBeNull();
    const { read } = reader({ entries: [{ id: "msg_sys", type: "system", text: "prompt" }], more: false });
    expect(await historyPageFromPlugin(read, "ses_0123456789abcdefABCDEFghij", { limit: 10 })).toBeNull();
  });

  test("the route's wait is far shorter than the socket's own", () => {
    expect(PLUGIN_HISTORY_TIMEOUT_MS).toBeLessThan(30_000);
    expect(PLUGIN_HISTORY_TIMEOUT_MS).toBeLessThanOrEqual(5_000);
  });
});
