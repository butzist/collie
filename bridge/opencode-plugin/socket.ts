// The local opencode plugin channel (Unix domain socket): `<stateDir>/opencode-plugin.sock`
// Mode 0600 in a 0700 folder, served by the bridge. No authentication.
//
// WHAT IT IS FOR. A pane's history normally comes off the agent's own log, but a running opencode
// server also knows its sessions in memory. A plugin registers each session it will answer for and
// this server asks it for history over the same connection the registration arrived on
// (`history()`). That direction is the only one that reads real answers: a plugin asking the bridge
// for history gets an honest refusal, because there is nothing here to answer with.
//
// ONE LISTENER AND ONE BUFFER PER SOCKET. Lines are split exactly once (in `accept`), and a line is
// dispatched either as a request or as the answer to a pending `history` request — never both. The
// first cut attached a second `data` listener per request, left it attached after the answer, and
// let every leaked listener share (and corrupt) one buffer; a 30 s timeout leaked one more.
//
// THE SESSION MAP IS PRUNED ON CLOSE. Two plugin instances can register the same session (OpenCode
// may load the plugin in more than one module realm); the newest registration answers, and when it
// goes away the next live connection for that session takes over instead of the map holding a dead
// socket for ever.

import { chmodSync, existsSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";

import { HOST } from "../host.ts";
import { opencodePluginSocketPath } from "./address.ts";
import {
  HISTORY_REQUEST_TIMEOUT_MS,
  OPENCODE_PLUGIN_ANSWER_MAX,
  OPENCODE_PLUGIN_LINE_MAX,
  parseOpencodePluginLine,
  type OpencodePluginRequest,
  type OpencodePluginResponse,
  type PluginHistoryAnswer,
} from "./parse.ts";

/** One registered plugin connection, as callers and tests can see it. */
export interface OpencodePluginConn {
  readonly socket: Socket;
  sessionId: string | null;
  lastSeen: number;
}

export interface OpencodePluginDeps {
  readonly socketPath?: string;
  readonly stateDir: string;
  readonly log?: (line: string) => void;
}

interface PendingHistory {
  readonly answer: (result: PluginHistoryAnswer | null) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

/** A connection and the state the socket's own line discipline needs (never exported). */
interface Connection {
  readonly conn: OpencodePluginConn;
  buffer: string;
  readonly pending: Map<string, PendingHistory>;
  closed: boolean;
}

export function pluginSocketPath(stateDir: string): string {
  return opencodePluginSocketPath(stateDir);
}

export class OpencodePluginServer {
  private server: Server | null = null;
  private readonly log: (line: string) => void;
  private readonly connections = new Set<Connection>();
  /** The live connection that answers for a session — the newest registration wins. */
  private readonly sessions = new Map<string, Connection>();

  constructor(private readonly deps: OpencodePluginDeps) {
    this.log = deps.log ?? ((line) => console.log(line));
  }

  async start(): Promise<boolean> {
    const path = this.deps.socketPath ?? pluginSocketPath(this.deps.stateDir);
    const dir = dirname(path);
    if (HOST.platform === "win32") {
      this.log("[opencode-plugin] no socket: opencode plugin channel needs a Unix socket on this host");
      return false;
    }
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      chmodSync(dir, 0o700);
      if (existsSync(path)) {
        if (!lstatSync(path).isSocket()) {
          this.log(`[opencode-plugin] no socket: ${path} exists and is not a socket`);
          return false;
        }
        // Try to connect to see if alive
        try {
          const test = createConnection({ path });
          await new Promise<void>((resolve, reject) => {
            const t = setTimeout(() => {
              test.destroy();
              reject(new Error("timeout"));
            }, 200);
            test.once("connect", () => {
              clearTimeout(t);
              test.destroy();
              resolve();
            });
            test.once("error", (e) => {
              clearTimeout(t);
              reject(e);
            });
          });
          this.log(`[opencode-plugin] no socket: another bridge listens on ${path}`);
          return false;
        } catch {
          try {
            unlinkSync(path);
          } catch {}
        }
      }
      const server = createServer((socket) => this.accept(socket));
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(path, () => {
          server.off("error", reject);
          resolve();
        });
      });
      // The socket itself, at `<stateDir>/opencode-plugin.sock`: `pluginSocketPath` is the only way
      // this path is made, so the file inherits the state folder's own access list.
      chmodSync(path, 0o600);
      server.unref();
      this.server = server;
      this.log(`[opencode-plugin] socket at ${path}`);
      return true;
    } catch (err) {
      this.log(`[opencode-plugin] no socket: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  stop(): void {
    const server = this.server;
    this.server = null;
    for (const connection of this.connections) this.close(connection);
    this.sessions.clear();
    if (server === null) return;
    server.close();
    try {
      const path = this.deps.socketPath ?? pluginSocketPath(this.deps.stateDir);
      if (existsSync(path) && lstatSync(path).isSocket()) unlinkSync(path);
    } catch {
      // ignore
    }
  }

  /**
   * Ask a plugin for one session's history.
   *
   * Null means "no live plugin can answer": nothing registered the session, the socket died, the
   * plugin reported a failure, or it did not answer within `timeoutMs`. A caller falls back to the
   * journal; it never learns which of those it was, by design — none of them changes what to do.
   */
  async history(
    sessionId: string,
    params: { after?: string; limit?: number } = {},
    timeoutMs = HISTORY_REQUEST_TIMEOUT_MS,
  ): Promise<PluginHistoryAnswer | null> {
    const connection = this.sessions.get(sessionId);
    if (connection === undefined || connection.closed) return null;
    return this.request(connection, sessionId, params, timeoutMs);
  }

  /** The connection that would answer for a session, or undefined. The socket is not used by callers. */
  connectionFor(sessionId: string): OpencodePluginConn | undefined {
    const connection = this.sessions.get(sessionId);
    return connection === undefined || connection.closed ? undefined : connection.conn;
  }

  private request(
    connection: Connection,
    sessionId: string,
    params: { after?: string; limit?: number },
    timeoutMs: number,
  ): Promise<PluginHistoryAnswer | null> {
    const socket = connection.conn.socket;
    if (connection.closed || socket.destroyed || !socket.writable) return Promise.resolve(null);
    const id = `h_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    return new Promise((resolve) => {
      let settled = false;
      // Settle through one guarded door, the way the mux clients do: the timer and a late answer race
      // each other, and the first one to arrive clears the other out.
      const finish = (settle: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        connection.pending.delete(id);
        settle();
      };
      const timer = setTimeout(() => finish(() => resolve(null)), timeoutMs);
      timer.unref?.();
      connection.pending.set(id, { answer: (answer) => finish(() => resolve(answer)), timer });
      try {
        socket.write(
          `${JSON.stringify({ v: 1, type: "history", id, sessionId, after: params.after, limit: params.limit })}\n`,
        );
      } catch {
        finish(() => resolve(null));
      }
    });
  }

  private accept(socket: Socket): void {
    socket.setEncoding("utf8");
    const connection: Connection = {
      conn: { socket, sessionId: null, lastSeen: Date.now() },
      buffer: "",
      pending: new Map(),
      closed: false,
    };
    this.connections.add(connection);
    socket.on("error", () => this.close(connection));
    socket.on("close", () => this.close(connection));
    socket.on("end", () => this.close(connection));
    socket.on("data", (chunk: string) => this.read(connection, chunk));
  }

  private read(connection: Connection, chunk: string): void {
    if (connection.closed) return;
    connection.buffer += chunk;
    // A REQUEST is tiny and a plugin has no business writing a megabyte unasked; an ANSWER is a whole
    // session's messages, which a real 130-message page measures at ~1 MB. So the ceiling depends on
    // whether anybody asked.
    const cap = connection.pending.size > 0 ? OPENCODE_PLUGIN_ANSWER_MAX : OPENCODE_PLUGIN_LINE_MAX;
    while (true) {
      const at = connection.buffer.indexOf("\n");
      if (at < 0) {
        if (connection.buffer.length > cap) {
          this.reply(connection, { ok: false, error: "too long" });
          this.close(connection);
        }
        return;
      }
      const line = connection.buffer.slice(0, at);
      connection.buffer = connection.buffer.slice(at + 1);
      if (line.trim() !== "") this.route(connection, line);
    }
  }

  private route(connection: Connection, line: string): void {
    const parsed = parseOpencodePluginLine(line);
    if (parsed.kind === "request") {
      this.serve(connection, parsed.request);
      return;
    }
    if (parsed.kind === "response") {
      this.settle(connection, parsed.response);
      return;
    }
    this.reply(connection, { ok: false, error: "bad request" });
  }

  private serve(connection: Connection, request: OpencodePluginRequest): void {
    if (request.type === "history") {
      // Collie asks, the plugin answers. A plugin that asks has nothing to read here, so say so
      // with the id it sent rather than pretending the question was malformed.
      this.reply(connection, { ok: false, type: "history", id: request.id, error: "unsupported" });
      return;
    }
    connection.conn.sessionId = request.sessionId;
    connection.conn.lastSeen = Date.now();
    this.sessions.set(request.sessionId, connection);
    this.log(`[opencode-plugin] registered ${request.sessionId}`);
    this.reply(connection, { ok: true, type: "registered" });
  }

  private settle(connection: Connection, answer: OpencodePluginResponse): void {
    if (answer.ok && answer.type !== "history") return; // the `registered` ack
    const id = answer.id;
    if (id === undefined) return;
    const pending = connection.pending.get(id);
    if (pending === undefined) return;
    connection.pending.delete(id);
    if (!answer.ok) this.log(`[opencode-plugin] history refused: ${answer.error}`);
    pending.answer(answer.ok ? { entries: answer.entries, more: answer.more === true } : null);
  }

  private reply(connection: Connection, answer: OpencodePluginResponse): void {
    const socket = connection.conn.socket;
    if (connection.closed || socket.destroyed || !socket.writable) return;
    try {
      socket.write(`${JSON.stringify(answer)}\n`);
    } catch {
      // ignore
    }
  }

  private close(connection: Connection): void {
    if (connection.closed) return;
    connection.closed = true;
    this.connections.delete(connection);
    this.unmap(connection);
    for (const pending of connection.pending.values()) {
      clearTimeout(pending.timer);
      pending.answer(null);
    }
    connection.pending.clear();
    try {
      connection.conn.socket.destroy();
    } catch {}
  }

  /** Give the session to the newest still-live connection, or forget it when none is left. */
  private unmap(connection: Connection): void {
    const sessionId = connection.conn.sessionId;
    if (sessionId === null || this.sessions.get(sessionId) !== connection) return;
    this.sessions.delete(sessionId);
    for (const other of this.connections) {
      if (other.conn.sessionId === sessionId) {
        this.sessions.set(sessionId, other);
        return;
      }
    }
  }
}
