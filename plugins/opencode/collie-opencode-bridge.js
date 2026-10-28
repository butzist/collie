// Collie <-> OpenCode plugin bridge (no auth). Handles missing Collie socket gracefully.
// Registers with session ID so Collie can map between panes and socket connections.
// Responds to history requests over Unix socket.

import net from "node:net";
import os from "node:os";
import path from "node:path";

function getCollieStateDir() {
  const env = process.env;
  if (env.COLLIE_STATE_DIR) return env.COLLIE_STATE_DIR;
  if (env.XDG_STATE_HOME) return path.join(env.XDG_STATE_HOME, "collie");
  return path.join(os.homedir(), ".local", "state", "collie");
}

function getSocketPath() {
  return path.join(getCollieStateDir(), "opencode-plugin.sock");
}

function sessionIDFromProperties(properties) {
  return typeof properties?.sessionID === "string" && properties.sessionID
    ? properties.sessionID
    : typeof properties?.sessionId === "string" && properties.sessionId
      ? properties.sessionId
      : undefined;
}

function sessionIDFromCtx(ctx) {
  if (!ctx) return undefined;
  if (ctx.sessionID) return ctx.sessionID;
  if (ctx.sessionId) return ctx.sessionId;
  if (ctx.session?.id) return ctx.session.id;
  if (ctx.properties) return sessionIDFromProperties(ctx.properties);
  return undefined;
}

class CollieBridge {
  constructor() {
    this.socketPath = getSocketPath();
    this.socket = null;
    this.connected = false;
    this.reconnecting = false;
    this.registeredSessionId = null;
    this.buf = "";
    this.pendingHistory = new Map();
  }

  connect() {
    if (this.connected || this.reconnecting) return;
    this.reconnecting = true;
    try {
      const socket = net.createConnection(this.socketPath, () => {
        this.socket = socket;
        this.connected = true;
        this.reconnecting = false;
        this.buf = "";
        // Try to register if we know session
        if (this.registeredSessionId) {
          this.send({ v: 1, type: "register", sessionId: this.registeredSessionId });
        }
      });
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => {
        this.buf += chunk;
        this.processBuffer();
      });
      socket.on("error", () => {
        this.cleanup();
      });
      socket.on("close", () => {
        this.cleanup();
        // Retry later if we might want to reconnect
        setTimeout(() => {
          this.reconnecting = false;
          if (this.registeredSessionId) this.connect();
        }, 2000);
      });
      socket.on("end", () => {
        this.cleanup();
      });
    } catch (e) {
      this.reconnecting = false;
      // Gracefully handle missing socket - just do nothing
    }
  }

  cleanup() {
    if (this.socket) {
      try { this.socket.destroy(); } catch {}
    }
    this.socket = null;
    this.connected = false;
  }

  send(obj) {
    if (!this.connected || !this.socket || this.socket.destroyed) {
      // Try to connect lazily
      if (!this.reconnecting) this.connect();
      return false;
    }
    try {
      this.socket.write(JSON.stringify(obj) + "\n");
      return true;
    } catch {
      this.cleanup();
      return false;
    }
  }

  register(sessionId) {
    if (!sessionId) return;
    this.registeredSessionId = sessionId;
    if (!this.connected) {
      this.connect();
      return;
    }
    this.send({ v: 1, type: "register", sessionId });
  }

  processBuffer() {
    while (true) {
      const at = this.buf.indexOf("\n");
      if (at < 0) break;
      const line = this.buf.slice(0, at);
      this.buf = this.buf.slice(at + 1);
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        this.handleMessage(msg);
      } catch {
        // ignore bad messages
      }
    }
  }

  handleMessage(msg) {
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "history" && msg.id) {
      // Collie is asking for history - try to provide it
      // For now, if we can't get full history from plugin APIs easily, return empty or try best effort
      try {
        // Best effort: try to get session messages if available via global APIs
        const entries = this.collectHistory(msg.sessionId, msg.after, msg.limit);
        this.send({ ok: true, type: "history", id: msg.id, entries, more: false });
      } catch (e) {
        this.send({ ok: false, type: "history", id: msg.id, error: e instanceof Error ? e.message : "failed" });
      }
      return;
    }
  }

  collectHistory(sessionId, after, limit) {
    // Try to collect history from available sources
    // This is a best-effort implementation
    const entries = [];
    try {
      // Try to access opencode internal state if exposed
      if (globalThis.__opencode && typeof globalThis.__opencode.getSession === "function") {
        const session = globalThis.__opencode.getSession(sessionId);
        if (session && Array.isArray(session.messages)) {
          for (let i = 0; i < session.messages.length; i++) {
            entries.push(session.messages[i]);
            if (limit && entries.length >= limit) break;
          }
        }
      }
    } catch {}
    return entries;
  }
}

const bridge = new CollieBridge();

export const CollieOpenCodePlugin = {
  id: "collie.opencode.bridge",
  name: "Collie Bridge",
  description: "Bridges OpenCode to Collie via local socket (no auth, registers session id)",
  async init(ctx) {
    // Try to get session id from context
    const sid = sessionIDFromCtx(ctx) || sessionIDFromProperties(ctx?.properties);
    if (sid) {
      bridge.register(sid);
    } else {
      bridge.connect();
    }
  },
  async setup(ctx) {
    const sid = sessionIDFromCtx(ctx) || sessionIDFromProperties(ctx?.properties);
    if (sid) bridge.register(sid);
    bridge.connect();
    return () => {
      // cleanup if needed
    };
  },
  event: async (event) => {
    try {
      const sid = event?.properties?.sessionID || event?.sessionID || event?.session?.id;
      if (sid && sid !== bridge.registeredSessionId) {
        bridge.register(sid);
      }
    } catch {
      // ignore
    }
  },
  tui: async (api) => {
    try {
      const getSid = () => {
        try {
          const route = api?.route?.current;
          if (route?.name === "session" && route?.params?.sessionID) return route.params.sessionID;
        } catch {}
        return undefined;
      };
      const sid = getSid();
      if (sid) bridge.register(sid);
      bridge.connect();
      // poll for route changes
      if (typeof setInterval === "function") {
        const poll = setInterval(() => {
          const nsid = getSid();
          if (nsid && nsid !== bridge.registeredSessionId) bridge.register(nsid);
        }, 500);
        return () => clearInterval(poll);
      }
    } catch {
      // ignore
    }
  },
};

export default CollieOpenCodePlugin;
