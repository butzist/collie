// Collie <-> OpenCode plugin bridge for the OpenCode 2.1 plugin contract.
//
// OpenCode 2 replaced the plugin API: a plugin default-exports a `Plugin.define({ id, setup })`
// definition, `setup(ctx)` registers everything through the context, and the V1 object shape
// (`init`, an `event` callback, a `tui` callback) is silently ignored — which is how this file used
// to load "active" while never registering a single session. See
// https://opencode.ai/v2/docs/build/plugins/migrate-v1. What that costs here:
//
//   • V1 `setup`/`init` was handed the pane's session; V2 setup is per LOCATION and knows only
//     `ctx.location`, so sessions are discovered instead: the newest ones from `ctx.session.list()`
//     plus every session id an event carries.
//   • The V1 `event` callback was where a session change re-registered; V2 has no such callback, so
//     we consume `ctx.event.subscribe()` and track `data.sessionID` as sessions start, rename and
//     close.
//   • The V1 `tui` callback polled the TUI route for the session id. A V2 TUI part is a separate
//     `./tui` export loaded from `cli.json`; this file is server-only, and it does not need the
//     route because it sees every session in the location.
//   • History no longer needs `globalThis.__opencode` (it never existed): `ctx.session.context({
//     sessionID })` returns the session's messages as the model would see them.
//
// The wire protocol is unchanged (see `bridge/opencode-plugin/parse.ts`): one JSON object per line,
// `{v:1,type:"register",sessionId}` out and `{v:1,type:"history",id,sessionId,after?,limit?}` in.
// Collie answers a `register` with `{ok:true,type:"registered"}`.
//
// A missing Collie socket is normal (OpenCode runs on its own most of the time): we retry with a
// capped backoff and never throw from setup, so a broken bridge can never stop a session.

import net from "node:net";
import os from "node:os";
import path from "node:path";

import { Plugin } from "@opencode/plugin";

/** How many sessions we keep registered. One registration costs one line on the socket. */
const SESSION_TRACK_LIMIT = 200;
/** How many of a location's newest sessions we register before any event names one. */
const SESSION_SEED_LIMIT = 50;
/** History window, and the ceiling a request cannot raise. */
const HISTORY_DEFAULT_LIMIT = 100;
const HISTORY_MAX_LIMIT = 1000;
/** Reconnect backoff: first retry is quick, then it backs off while Collie is not running. */
const RECONNECT_MIN_MS = 2000;
const RECONNECT_MAX_MS = 30000;

function getCollieStateDir() {
  const env = process.env;
  if (env.COLLIE_STATE_DIR) return env.COLLIE_STATE_DIR;
  if (env.XDG_STATE_HOME) return path.join(env.XDG_STATE_HOME, "collie");
  return path.join(os.homedir(), ".local", "state", "collie");
}

function getSocketPath() {
  return path.join(getCollieStateDir(), "opencode-plugin.sock");
}

function debug(line) {
  if (process.env.COLLIE_OPENCODE_DEBUG) console.error(`[collie] ${line}`);
}

function isSessionId(value) {
  return typeof value === "string" && value !== "";
}

/**
 * Cut a session's messages to the window a request asked for.
 *
 * Entries are oldest first, the order a transcript renders in. `after` is a forward cursor (an entry
 * id, as the protocol names it): only entries newer than it are returned. Without a cursor the
 * NEWEST `limit` entries come back, so a first request is the tail of the conversation rather than
 * its opening. `more` is true whenever entries were left out of the window.
 */
export function pageEntries(entries, after, limit) {
  const cap =
    Number.isInteger(limit) && limit > 0 ? Math.min(limit, HISTORY_MAX_LIMIT) : HISTORY_DEFAULT_LIMIT;
  const list = Array.isArray(entries) ? entries.filter((e) => e && typeof e === "object") : [];
  let start = 0;
  if (isSessionId(after)) {
    const at = list.findIndex((entry) => entry.id === after);
    if (at >= 0) start = at + 1;
  }
  const rest = list.slice(start);
  if (rest.length <= cap) return { entries: rest, more: false };
  // A cursor pages forward from where the reader is; no cursor means "the end of the conversation".
  const window = start === 0 ? rest.slice(rest.length - cap) : rest.slice(0, cap);
  return { entries: window, more: true };
}

/** One socket to Collie, shared by every plugin instance in this process (V2 sets up one per location). */
export class CollieBridge {
  constructor({ socketPath = getSocketPath(), reader = null, log = debug } = {}) {
    this.socketPath = socketPath;
    this.reader = reader;
    this.log = log;
    this.socket = null;
    this.connected = false;
    this.connecting = false;
    this.disposed = false;
    this.failures = 0;
    this.buf = "";
    /** sessionId -> true, in the order we started tracking it (LRU: a touched session moves to the end). */
    this.sessions = new Map();
    /** Sessions already announced on the CURRENT socket; cleared on every close. */
    this.registered = new Set();
    this.reconnectTimer = null;
    this.clients = new Set();
  }

  /** Attach one plugin instance. Returns the cleanup V2 calls when that instance unloads. */
  attach(ctx) {
    this.disposed = false;
    const controller = new AbortController();
    const client = { controller, abort: () => controller.abort() };
    this.clients.add(client);
    this.reader = ctx;

    void this.#watch(ctx, controller.signal);
    void this.#seed(ctx);
    this.connect();

    return () => {
      this.clients.delete(client);
      try {
        controller.abort();
      } catch {}
      if (this.clients.size === 0) this.dispose();
    };
  }

  async #watch(ctx, signal) {
    try {
      for await (const event of ctx.event.subscribe({ signal })) {
        const data = event?.data;
        if (!data || typeof data !== "object") continue;
        const sessionId = data.sessionID;
        if (!isSessionId(sessionId)) continue;
        if (event.type === "session.deleted") this.untrack(sessionId);
        else this.track(sessionId);
      }
    } catch (err) {
      if (!signal.aborted) this.log(`event stream ended: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async #seed(ctx) {
    try {
      const page = await ctx.session.list({ limit: SESSION_SEED_LIMIT, order: "desc" });
      for (const session of page?.data ?? []) {
        if (isSessionId(session?.id)) this.track(session.id);
      }
    } catch (err) {
      this.log(`could not list sessions: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  track(sessionId) {
    if (!isSessionId(sessionId) || this.disposed) return;
    if (this.sessions.has(sessionId)) this.sessions.delete(sessionId); // move to the newest end
    this.sessions.set(sessionId, true);
    while (this.sessions.size > SESSION_TRACK_LIMIT) {
      const oldest = this.sessions.keys().next().value;
      this.sessions.delete(oldest);
      this.registered.delete(oldest);
    }
    if (this.connected) {
      if (!this.registered.has(sessionId)) this.register(sessionId);
      return;
    }
    // A socket that failed before any session was known schedules no retry (nothing to announce);
    // the first session we learn about starts it again.
    if (!this.connecting && !this.reconnectTimer) this.connect();
  }

  untrack(sessionId) {
    this.sessions.delete(sessionId);
    this.registered.delete(sessionId);
  }

  connect() {
    if (this.disposed || this.connected || this.connecting) return;
    if (process.platform === "win32") return; // Collie serves this channel only on a Unix socket
    this.connecting = true;
    let socket;
    try {
      socket = net.createConnection(this.socketPath, () => {
        this.connecting = false;
        this.failures = 0;
        this.socket = socket;
        this.connected = true;
        this.buf = "";
        this.registered.clear();
        this.log(`connected to ${this.socketPath}`);
        for (const sessionId of this.sessions.keys()) this.register(sessionId);
      });
    } catch {
      this.connecting = false;
      this.#scheduleReconnect();
      return;
    }
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      this.buf += chunk;
      this.#drain();
    });
    socket.on("error", () => this.#lost(socket));
    socket.on("close", () => this.#lost(socket));
    socket.on("end", () => this.#lost(socket));
  }

  #lost(socket) {
    this.connecting = false;
    if (this.socket === socket || this.socket === null) {
      this.socket = null;
      this.connected = false;
      this.registered.clear();
      this.buf = "";
    }
    try {
      socket.destroy();
    } catch {}
    this.#scheduleReconnect();
  }

  #scheduleReconnect() {
    if (this.disposed || this.reconnectTimer || this.sessions.size === 0) return;
    const delay = Math.min(RECONNECT_MIN_MS * 2 ** this.failures, RECONNECT_MAX_MS);
    this.failures += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  send(message) {
    if (!this.socket || this.socket.destroyed) return false;
    try {
      this.socket.write(`${JSON.stringify(message)}\n`);
      return true;
    } catch {
      return false;
    }
  }

  register(sessionId) {
    if (this.send({ v: 1, type: "register", sessionId })) this.registered.add(sessionId);
  }

  #drain() {
    while (true) {
      const at = this.buf.indexOf("\n");
      if (at < 0) return;
      const line = this.buf.slice(0, at);
      this.buf = this.buf.slice(at + 1);
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue; // Collie only writes JSON lines; a stray one is not worth dropping the socket over
      }
      this.#handle(message);
    }
  }

  #handle(message) {
    if (!message || typeof message !== "object") return;
    if (message.type === "history" && isSessionId(message.id)) {
      void this.#answerHistory(message);
      return;
    }
    if (message.type === "registered") this.log("registered");
  }

  async #answerHistory(message) {
    const { id, sessionId } = message;
    if (!isSessionId(sessionId)) {
      this.send({ ok: false, type: "history", id, error: "no session" });
      return;
    }
    try {
      const ctx = this.reader;
      if (!ctx) throw new Error("no plugin context");
      const entries = await ctx.session.context({ sessionID: sessionId });
      const window = pageEntries(entries, message.after, message.limit);
      this.send({ ok: true, type: "history", id, sessionId, entries: window.entries, more: window.more });
    } catch (err) {
      // An unknown session id rejects with an empty message, so fall back to a word Collie can show.
      const reason = (err instanceof Error && err.message) || "failed";
      this.log(`history for ${sessionId} failed: ${reason}`);
      this.send({ ok: false, type: "history", id, sessionId, error: reason });
    }
  }

  dispose() {
    this.disposed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const socket = this.socket;
    this.socket = null;
    this.connected = false;
    this.registered.clear();
    try {
      socket?.destroy();
    } catch {}
  }
}

/**
 * One bridge per module realm. V2 sets the plugin up once per location it loaded, and every instance
 * would otherwise open its own socket and its own event stream; the sessions are the server's, not a
 * location's, so the instances share one connection. V2 can also import the module into more than one
 * realm (a process here has two), where `globalThis` is not shared — those realms open a socket each,
 * and the duplicate registrations are harmless: Collie maps the session to the newest connection.
 */
function sharedBridge() {
  const key = Symbol.for("collie.opencode.bridge");
  const existing = globalThis[key];
  if (existing) return existing;
  const bridge = new CollieBridge();
  globalThis[key] = bridge;
  return bridge;
}

export default Plugin.define({
  id: "collie.opencode.bridge",
  async setup(ctx) {
    return sharedBridge().attach(ctx);
  },
});
