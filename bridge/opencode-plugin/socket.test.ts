import { describe, expect, test } from "bun:test";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { JsonObject } from "../json.ts";
import { OPENCODE_PLUGIN_LINE_MAX, parseOpencodePluginRequest, type OpencodePluginRequest } from "./parse.ts";
import { OpencodePluginServer } from "./socket.ts";

// A real Unix socket, a real plugin on the far end, and the line discipline in between: this is the
// half the bridge owns. The tests that matter are the ones the first cut failed — every answer was
// answered with "bad request", listeners leaked per request, and a dead connection shadowed a live
// one for the same session.

const SESSION = "ses_0123456789abcdefABCDEFghij";
const OTHER = "ses_zyxwvutsrqponmlkjihgfedcba";

interface Plug {
  readonly socket: Socket;
  readonly lines: string[];
  /** The next `count` lines the plugin received, as JSON. Consumes them. */
  next(count?: number): Promise<JsonObject[]>;
  send(value: JsonObject): void;
}

/** The plugin's end of the channel, with a queue so no test has to guess at a sleep. */
async function plug(path: string): Promise<Plug> {
  const socket = createConnection(path);
  const lines: string[] = [];
  const waiters: Array<() => void> = [];
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf("\n")) >= 0) {
      lines.push(buffer.slice(0, at));
      buffer = buffer.slice(at + 1);
    }
    for (const wake of waiters.splice(0)) wake();
  });
  await once(socket, "connect");
  return {
    socket,
    lines,
    async next(count = 1) {
      while (lines.length < count) await new Promise<void>((wake) => waiters.push(wake));
      // SAFETY: every line this channel carries is JSON written by the server under test.
      return lines.splice(0, count).map((line) => JSON.parse(line) as JsonObject);
    },
    send(value) {
      socket.write(`${JSON.stringify(value)}\n`);
    },
  };
}

async function register(end: Plug, sessionId = SESSION): Promise<void> {
  end.send({ v: 1, type: "register", sessionId });
  const [ack] = await end.next(1);
  expect(ack).toEqual({ ok: true, type: "registered" });
}

/** The `history` request the server just wrote, parsed by the bridge's own parser. */
function askedFor(line: JsonObject): Extract<OpencodePluginRequest, { type: "history" }> {
  const request = parseOpencodePluginRequest(JSON.stringify(line));
  if (request === null || request.type !== "history") throw new Error("expected a history request");
  return request;
}

async function waitFor(predicate: () => boolean, ms = 2000): Promise<void> {
  const until = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > until) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

interface Bench {
  readonly server: OpencodePluginServer;
  readonly dir: string;
  readonly path: string;
}

async function bench(): Promise<Bench> {
  const dir = mkdtempSync(join(tmpdir(), "collie-opencode-plugin-"));
  const path = join(dir, "opencode-plugin.sock");
  const server = new OpencodePluginServer({ stateDir: dir, socketPath: path, log: () => {} });
  expect(await server.start()).toBe(true);
  return { server, dir, path };
}

function shutdown(instance: Bench, ...ends: Plug[]): void {
  for (const end of ends) end.socket.destroy();
  instance.server.stop();
  rmSync(instance.dir, { recursive: true, force: true });
}

describe("OpencodePluginServer", () => {
  test("a register maps the session and is acknowledged", async () => {
    const b = await bench();
    const end = await plug(b.path);
    try {
      await register(end);
      expect(b.server.connectionFor(SESSION)?.sessionId).toBe(SESSION);
      expect(b.server.connectionFor(OTHER)).toBeUndefined();
    } finally {
      shutdown(b, end);
    }
  });

  test("history asks the plugin down the socket and resolves its answer", async () => {
    const b = await bench();
    const end = await plug(b.path);
    try {
      await register(end);
      const asked = b.server.history(SESSION, { limit: 5 }, 1000);
      const [line] = await end.next(1);
      const request = askedFor(line!);
      expect(request).toMatchObject({ v: 1, type: "history", sessionId: SESSION, limit: 5 });
      end.send({
        ok: true,
        type: "history",
        id: request.id,
        sessionId: SESSION,
        entries: [{ id: "msg_1" }, { id: "msg_2" }],
        more: true,
      });
      expect(await asked).toEqual({ entries: [{ id: "msg_1" }, { id: "msg_2" }], more: true });
    } finally {
      shutdown(b, end);
    }
  });

  test("an answer is not answered again", async () => {
    // The first cut routed every inbound line through the REQUEST parser, so this answer came back
    // as {"ok":false,"error":"bad request"} — noise a plugin could read as a failure.
    const b = await bench();
    const end = await plug(b.path);
    try {
      await register(end);
      const asked = b.server.history(SESSION, {}, 1000);
      const [line] = await end.next(1);
      end.send({ ok: true, type: "history", id: askedFor(line!).id, entries: [] });
      await asked;
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(end.lines).toEqual([]);
      // One listener on the server's end for the life of the connection, answers included.
      expect(b.server.connectionFor(SESSION)?.socket.listenerCount("data")).toBe(1);
    } finally {
      shutdown(b, end);
    }
  });

  test("two questions in flight settle by id, in either order", async () => {
    const b = await bench();
    const end = await plug(b.path);
    try {
      await register(end);
      const first = b.server.history(SESSION, { limit: 1 }, 1000);
      const second = b.server.history(SESSION, { limit: 2 }, 1000);
      const [one, two] = await end.next(2);
      end.send({ ok: true, type: "history", id: askedFor(two!).id, entries: [{ id: "second" }] });
      end.send({ ok: true, type: "history", id: askedFor(one!).id, entries: [{ id: "first" }] });
      expect(await first).toEqual({ entries: [{ id: "first" }], more: false });
      expect(await second).toEqual({ entries: [{ id: "second" }], more: false });
    } finally {
      shutdown(b, end);
    }
  });

  test("a timeout resolves null, and the late answer cannot settle the next question", async () => {
    const b = await bench();
    const end = await plug(b.path);
    try {
      await register(end);
      expect(await b.server.history(SESSION, {}, 30)).toBeNull();
      const [droppedLine] = await end.next(1);
      const dropped = askedFor(droppedLine!);
      const next = b.server.history(SESSION, {}, 1000);
      const [liveLine] = await end.next(1);
      // The stale answer names the FIRST request's id: it must not settle the second.
      end.send({ ok: true, type: "history", id: dropped.id, entries: [{ id: "stale" }] });
      end.send({ ok: true, type: "history", id: askedFor(liveLine!).id, entries: [{ id: "live" }] });
      expect(await next).toEqual({ entries: [{ id: "live" }], more: false });
      expect(b.server.connectionFor(SESSION)?.socket.listenerCount("data")).toBe(1);
    } finally {
      shutdown(b, end);
    }
  });

  test("a failure answer gives the caller null, and the channel keeps working", async () => {
    const b = await bench();
    const end = await plug(b.path);
    try {
      await register(end);
      const failed = b.server.history(SESSION, {}, 1000);
      const [line] = await end.next(1);
      end.send({ ok: false, type: "history", id: askedFor(line!).id, error: "failed" });
      expect(await failed).toBeNull();
      const second = b.server.history(SESSION, {}, 1000);
      const [secondLine] = await end.next(1);
      end.send({ ok: true, type: "history", id: askedFor(secondLine!).id, entries: [] });
      expect(await second).toEqual({ entries: [], more: false });
    } finally {
      shutdown(b, end);
    }
  });

  test("an answer larger than a request line is still an answer", async () => {
    // A real 130-message page measured 1,012,799 bytes. The request-sized cap closed the socket on
    // every honest answer; the ceiling is the ANSWER's while a request is in flight.
    const b = await bench();
    const end = await plug(b.path);
    try {
      await register(end);
      const asked = b.server.history(SESSION, {}, 1000);
      const [line] = await end.next(1);
      const big = "x".repeat(200_000);
      end.send({ ok: true, type: "history", id: askedFor(line!).id, entries: [{ id: "msg_big", type: "user", text: big }] });
      const answer = await asked;
      expect(answer?.entries).toHaveLength(1);
      expect(b.server.connectionFor(SESSION)).toBeDefined();
    } finally {
      shutdown(b, end);
    }
  });

  test("a giant unsolicited line closes the connection instead of buffering it", async () => {
    const b = await bench();
    const end = await plug(b.path);
    try {
      await register(end);
      end.socket.write("x".repeat(OPENCODE_PLUGIN_LINE_MAX + 1024));
      const [refusal] = await end.next(1);
      expect(refusal).toEqual({ ok: false, error: "too long" });
      await waitFor(() => end.socket.destroyed);
    } finally {
      shutdown(b, end);
    }
  });

  test("a plugin that asks the bridge for history is refused with its own id", async () => {
    const b = await bench();
    const end = await plug(b.path);
    try {
      await register(end);
      end.send({ v: 1, type: "history", id: "h_asked", sessionId: SESSION });
      const [refusal] = await end.next(1);
      expect(refusal).toEqual({ ok: false, type: "history", id: "h_asked", error: "unsupported" });
    } finally {
      shutdown(b, end);
    }
  });

  test("a line that is neither request nor answer is answered as noise", async () => {
    const b = await bench();
    const end = await plug(b.path);
    try {
      end.send({ hello: "there" });
      const [refusal] = await end.next(1);
      expect(refusal).toEqual({ ok: false, error: "bad request" });
    } finally {
      shutdown(b, end);
    }
  });

  test("a line split across chunks is still one line", async () => {
    const b = await bench();
    const end = await plug(b.path);
    try {
      const line = JSON.stringify({ v: 1, type: "register", sessionId: SESSION });
      end.socket.write(line.slice(0, 10));
      await new Promise((resolve) => setTimeout(resolve, 20));
      end.socket.write(`${line.slice(10)}\n`);
      const [ack] = await end.next(1);
      expect(ack).toEqual({ ok: true, type: "registered" });
      expect(b.server.connectionFor(SESSION)).toBeDefined();
    } finally {
      shutdown(b, end);
    }
  });

  test("two connections for one session: the newest answers, the older takes over when it dies", async () => {
    // OpenCode may load the plugin in more than one module realm, so this is a real shape, and a
    // dead connection must not shadow a live one.
    const b = await bench();
    const older = await plug(b.path);
    const newer = await plug(b.path);
    try {
      await register(older);
      await register(newer);
      const newest = b.server.history(SESSION, {}, 1000);
      const [newestLine] = await newer.next(1);
      expect(older.lines).toEqual([]);
      newer.send({ ok: true, type: "history", id: askedFor(newestLine!).id, entries: [{ id: "newer" }] });
      expect(await newest).toEqual({ entries: [{ id: "newer" }], more: false });

      // Hold the connection object: until the server sees the close, the map still names it, and a
      // question sent there would vanish into a dead socket.
      const departed = b.server.connectionFor(SESSION);
      newer.socket.destroy();
      await waitFor(() => {
        const live = b.server.connectionFor(SESSION);
        return live !== undefined && live !== departed && !live.socket.destroyed;
      });
      const asked = b.server.history(SESSION, {}, 1000);
      const [line] = await older.next(1);
      older.send({ ok: true, type: "history", id: askedFor(line!).id, entries: [{ id: "older" }] });
      expect(await asked).toEqual({ entries: [{ id: "older" }], more: false });
    } finally {
      shutdown(b, older);
    }
  });

  test("a dead connection settles its pending question as null", async () => {
    const b = await bench();
    const end = await plug(b.path);
    try {
      await register(end);
      const asked = b.server.history(SESSION, {}, 5000);
      await end.next(1);
      end.socket.destroy();
      expect(await asked).toBeNull();
      await waitFor(() => b.server.connectionFor(SESSION) === undefined);
    } finally {
      shutdown(b, end);
    }
  });

  test("stop closes the socket, forgets the session and unlinks the path", async () => {
    const b = await bench();
    const end = await plug(b.path);
    try {
      await register(end);
      b.server.stop();
      await waitFor(() => end.socket.destroyed);
      expect(b.server.connectionFor(SESSION)).toBeUndefined();
      // A second start after stop is a clean socket, not "another bridge listens".
      expect(await b.server.start()).toBe(true);
    } finally {
      end.socket.destroy();
      shutdown(b);
    }
  });
});
