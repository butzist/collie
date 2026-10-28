// The local opencode plugin channel (Unix domain socket): `<stateDir>/opencode-plugin.sock`
// Mode 0600 in a 0700 folder, served by the bridge. No authentication.
// The plugin registers with its session ID so Collie can map between panes and socket connections.
// History requests have a timeout; the plugin must handle missing Collie socket gracefully.
// One JSON request line per connection in the general flow, but we support bidirectional connections.

import { chmodSync, existsSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";

import { opencodePluginSocketPath } from "./address.ts";
import { HISTORY_REQUEST_TIMEOUT_MS, OPENCODE_PLUGIN_LINE_MAX, parseOpencodePluginRequest, type OpencodePluginRequest, type OpencodePluginResponse } from "./parse.ts";

export interface OpencodePluginConn {
  socket: Socket;
  sessionId: string | null;
  paneId: string | null;
  lastSeen: number;
}

export interface OpencodePluginDeps {
  readonly socketPath?: string;
  readonly stateDir: string;
  /** Map from sessionId to connection */
  getConnection(sessionId: string): OpencodePluginConn | undefined;
  register(sessionId: string, paneId: string | undefined, conn: OpencodePluginConn): void;
  /** Request history from plugin; returns null on timeout/error */
  requestHistory(sessionId: string, params: { after?: string; limit?: number }): Promise<OpencodePluginResponse | null>;
  readonly log?: (line: string) => void;
}

export function pluginSocketPath(stateDir: string): string {
  return opencodePluginSocketPath(stateDir);
}

export class OpencodePluginServer {
  private server: Server | null = null;
  private readonly log: (line: string) => void;
  private conns = new Set<OpencodePluginConn>();

  constructor(private readonly deps: OpencodePluginDeps) {
    this.log = deps.log ?? ((line) => console.log(line));
  }

  async start(): Promise<boolean> {
    const path = this.deps.socketPath ?? pluginSocketPath(this.deps.stateDir);
    const dir = dirname(path);
    if (process.platform === "win32") {
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
          try { unlinkSync(path); } catch {}
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
    if (server === null) return;
    try {
      for (const c of this.conns) {
        try { c.socket.destroy(); } catch {}
      }
      this.conns.clear();
    } catch {}
    server.close();
    try {
      const path = this.deps.socketPath ?? pluginSocketPath(this.deps.stateDir);
      if (existsSync(path) && lstatSync(path).isSocket()) unlinkSync(path);
    } catch {
      // ignore
    }
  }

  private accept(socket: Socket): void {
    socket.setEncoding("utf8");
    const conn: OpencodePluginConn = { socket, sessionId: null, paneId: null, lastSeen: Date.now() };
    this.conns.add(conn);
    let buffer = "";
    let closed = false;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      this.conns.delete(conn);
      if (conn.sessionId) {
        // Don't aggressively remove mapping if we want to allow reconnection; but we do cleanup
      }
    };
    socket.on("error", cleanup);
    socket.on("close", cleanup);
    socket.on("end", cleanup);
    socket.on("data", (chunk: string) => {
      if (closed) return;
      buffer += chunk;
      while (true) {
        const at = buffer.indexOf("\n");
        if (at < 0) {
          if (buffer.length > OPENCODE_PLUGIN_LINE_MAX) {
            this.reply(socket, { ok: false, error: "too long" });
            socket.destroy();
            return;
          }
          break;
        }
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        void this.route(socket, conn, line);
      }
    });
  }

  reply(socket: Socket, answer: OpencodePluginResponse): void {
    if (socket.destroyed || !socket.writable) return;
    try {
      socket.write(JSON.stringify(answer) + "\n");
    } catch {
      // ignore
    }
  }

  private async route(socket: Socket, conn: OpencodePluginConn, line: string): Promise<void> {
    try {
      const req = parseOpencodePluginRequest(line);
      if (req === null) {
        this.reply(socket, { ok: false, error: "bad request" });
        return;
      }
      if (req.type === "register") {
        conn.sessionId = req.sessionId;
        conn.paneId = req.paneId ?? null;
        conn.lastSeen = Date.now();
        try {
          this.deps.register(req.sessionId, req.paneId, conn);
        } catch (err) {
          this.log(`[opencode-plugin] register failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        this.reply(socket, { ok: true, type: "registered" });
        return;
      }
      if (req.type === "history") {
        conn.lastSeen = Date.now();
        try {
          const res = await Promise.race([
            this.deps.requestHistory(req.sessionId, { after: req.after, limit: req.limit }),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), HISTORY_REQUEST_TIMEOUT_MS))
          ]);
          if (res === null) {
            this.reply(socket, { ok: false, type: "history", error: "timeout" });
            return;
          }
          this.reply(socket, res);
          return;
        } catch (err) {
          this.reply(socket, { ok: false, type: "history", error: err instanceof Error ? err.message : "failed" });
          return;
        }
      }
      this.reply(socket, { ok: false, error: "bad request" });
    } catch (err) {
      this.log(`[opencode-plugin] request failed: ${err instanceof Error ? err.message : String(err)}`);
      this.reply(socket, { ok: false, error: "failed" });
    }
  }

  /** Get connection for a sessionId (if registered) */
  connectionFor(sessionId: string): OpencodePluginConn | undefined {
    // scan is fine for small number of connections
    for (const c of this.conns) {
      if (c.sessionId === sessionId && !c.socket.destroyed) return c;
    }
    return undefined;
  }
}

export async function requestHistoryFromPlugin(conn: OpencodePluginConn, params: { after?: string; limit?: number }, timeoutMs = HISTORY_REQUEST_TIMEOUT_MS): Promise<OpencodePluginResponse | null> {
  return new Promise((resolve) => {
    if (conn.socket.destroyed || !conn.socket.writable) {
      resolve(null);
      return;
    }
    const id = `h_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      conn.socket.off("data", onData);
      resolve(null);
    }, timeoutMs);
    timer.unref?.();
    const onData = (chunk: string) => {
      // naive: accumulate? but our accept reads lines; easier to have a per-connection buffer
      // For simplicity in this design, we rely on the server's routing if bidirectional not needed,
      // but better to handle here too - store buffer on conn
    };
    // Better approach: attach a response handler
    const bufKey = "__opencodePluginBuf" as const;
    const pendingKey = "__opencodePluginPending" as const;
    (conn as any)[bufKey] = (conn as any)[bufKey] || "";
    (conn as any)[pendingKey] = (conn as any)[pendingKey] || new Map();
    const pending = (conn as any)[pendingKey] as Map<string, (res: OpencodePluginResponse) => void>;
    pending.set(id, (res) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(res);
    });
    const onDataLine = (chunk: string) => {
      let b = (conn as any)[bufKey] as string;
      b += chunk;
      while (true) {
        const at = b.indexOf("\n");
        if (at < 0) break;
        const line = b.slice(0, at);
        b = b.slice(at + 1);
        try {
          const parsed = JSON.parse(line) as OpencodePluginResponse;
          if (parsed && parsed.ok === true && (parsed as any).type === "history" && (parsed as any).id === id) {
            const h = pending.get(id);
            if (h) { pending.delete(id); h(parsed); }
            continue;
          }
          if (parsed && parsed.ok === false && (parsed as any).type === "history" && (parsed as any).id === id) {
            const h = pending.get(id);
            if (h) { pending.delete(id); h(parsed); }
            continue;
          }
        } catch {}
      }
      (conn as any)[bufKey] = b;
    };
    conn.socket.on("data", onDataLine);
    try {
      const req = { v: 1, type: "history", id, sessionId: conn.sessionId, after: params.after, limit: params.limit };
      conn.socket.write(JSON.stringify(req) + "\n");
    } catch (e) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      conn.socket.off("data", onDataLine);
      resolve(null);
    }
  });
}
