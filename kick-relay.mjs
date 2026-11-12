#!/usr/bin/env node
/**
 * Combined Chat — local Kick relay
 *
 * Kick's chat websocket (Centrifugo, since Oct 2026) only accepts
 * Origin: https://kick.com. A browser source / local HTML file cannot set
 * that header, so this tiny process does it on 127.0.0.1 and forwards
 * parsed chat to the page.
 *
 * Usage:
 *   node kick-relay.mjs
 *   node kick-relay.mjs --port 8787
 *
 * Local runs bind 127.0.0.1; hosted runs (PORT set) bind 0.0.0.0.
 * GET /assets?twitch=&kick= serves badges and third-party emotes (cached).
 * No logins, no stream keys, no passwords. Guest token is never printed.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { assetsToHttp } from "./assets.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const portIdx = args.indexOf("--port");
const PORT = Number(portIdx >= 0 ? args[portIdx + 1] : process.env.PORT) || 8787;
// Render and other hosts set PORT and must reach the process on all interfaces.
// Local runs without PORT stay on localhost only.
const HOST = process.env.HOST || (process.env.PORT ? "0.0.0.0" : "127.0.0.1");
const ORIGIN = "https://kick.com";
const HTML_FILE = path.join(__dirname, "combined-chat.html");

function log(...a) { console.log(new Date().toISOString().slice(11, 19), ...a); }
function uuid() { return crypto.randomUUID(); }

async function kickJson(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Origin: ORIGIN,
      Referer: ORIGIN + "/"
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error("Kick HTTP " + res.status + " " + url + " " + t.slice(0, 180));
  }
  return res.json();
}

async function resolveChannel(slug) {
  const res = await fetch("https://kick.com/api/v2/channels/" + encodeURIComponent(slug), {
    headers: { Accept: "application/json", Origin: ORIGIN, Referer: ORIGIN + "/" }
  });
  if (res.status === 404) throw new Error("Kick channel not found: " + slug);
  if (!res.ok) throw new Error("Kick channel lookup failed (" + res.status + ")");
  const data = await res.json();
  return {
    slug: data.slug || slug,
    channelId: data.id,
    chatroomId: data.chatroom && data.chatroom.id
  };
}

class KickUpstream {
  constructor(opts) {
    this.slug = opts.slug;
    this.channelId = opts.channelId;
    this.chatroomId = opts.chatroomId;
    this.clients = new Set();
    this.ws = null;
    this.clientId = null;
    this.token = null;
    this.closed = false;
    this.backoff = 800;
    this.connect();
  }

  broadcast(obj) {
    const raw = JSON.stringify(obj);
    for (const client of this.clients) {
      if (client.readyState === 1) client.send(raw);
    }
  }

  status(state, detail) {
    this.broadcast({ type: "status", state, detail, slug: this.slug });
  }

  async connect() {
    if (this.closed) return;
    this.status("connecting", "connecting to Kick");
    try {
      if (!this.chatroomId || !this.channelId) {
        const info = await resolveChannel(this.slug);
        this.slug = info.slug || this.slug;
        this.channelId = this.channelId || info.channelId;
        this.chatroomId = this.chatroomId || info.chatroomId;
        if (!this.chatroomId) throw new Error("No chatroom id for " + this.slug);
        log("resolved", this.slug, "channel", this.channelId, "chatroom", this.chatroomId);
      }
      this.clientId = uuid();
      const connPath = this.channelId
        ? "https://web.kick.com/api/v1/realtime/channels/" + this.channelId + "/chat/connection"
        : "https://web.kick.com/api/v1/realtime/connection";
      const conn = await kickJson(connPath, {
        client: { id: this.clientId, type: "web" },
        capabilities: { accepted_providers: [{ provider: "centrifugo" }] }
      });
      const wsUrl = conn && conn.data && conn.data.connections && conn.data.connections[0]
        && conn.data.connections[0].credentials && conn.data.connections[0].credentials.url;
      if (!wsUrl) throw new Error("Kick did not return a websocket URL");
      const tok = await kickJson("https://web.kick.com/api/v1/realtime/auth/connection", {
        client_id: this.clientId
      });
      this.token = tok && tok.data && tok.data.token;
      if (!this.token) throw new Error("Kick did not return a guest token");
      this.openSocket(wsUrl);
    } catch (err) {
      log("connect failed:", err.message);
      this.status("error", err.message);
      this.scheduleReconnect();
    }
  }

  openSocket(wsUrl) {
    const ws = new WebSocket(wsUrl, { headers: { Origin: ORIGIN, Referer: ORIGIN + "/" } });
    this.ws = ws;
    let cmdId = 1;
    let pingTimer;

    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ id: cmdId++, connect: { token: this.token, name: "js" } }));
    });

    ws.addEventListener("message", (ev) => {
      const raw = String(ev.data);
      for (const line of raw.split("\n")) {
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id && msg.connect) {
          const ch = "chatrooms." + this.chatroomId + ".v2";
          ws.send(JSON.stringify({ id: cmdId++, subscribe: { channel: ch } }));
          continue;
        }
        if (msg.id && msg.subscribe && !msg.error) {
          this.backoff = 800;
          this.status("connected", "connected");
          log("Kick chat connected:", this.slug);
          continue;
        }
        if (msg.id && msg.error) {
          this.status("error", msg.error.message || "subscribe error");
          continue;
        }
        if (msg.push && msg.push.pub && msg.push.pub.data) {
          this.handlePub(msg.push.pub.data);
          continue;
        }
        if (msg && Object.keys(msg).length === 0) {
          try { ws.send("{}"); } catch {}
        }
      }
    });

    ws.addEventListener("close", (e) => {
      clearInterval(pingTimer);
      if (this.closed) return;
      log("Kick socket closed", e.code);
      this.status("disconnected", "disconnected, retrying");
      this.scheduleReconnect(true);
    });

    ws.addEventListener("error", () => { /* close follows */ });

    // Guest tokens last ~45 minutes. Refresh around 40 minutes.
    this.refreshTimer = setTimeout(() => {
      if (this.closed) return;
      this.refreshToken(ws, () => cmdId++);
    }, 40 * 60 * 1000);
  }

  async refreshToken(ws, nextId) {
    try {
      const tok = await kickJson("https://web.kick.com/api/v1/realtime/auth/connection", {
        client_id: this.clientId
      });
      const token = tok && tok.data && tok.data.token;
      if (token && ws.readyState === 1) {
        this.token = token;
        ws.send(JSON.stringify({ id: nextId(), refresh: { token } }));
        this.refreshTimer = setTimeout(() => this.refreshToken(ws, nextId), 40 * 60 * 1000);
      }
    } catch (err) {
      log("token refresh failed:", err.message);
    }
  }

  handlePub(data) {
    const event = data.event || (data.tags && data.tags.event) || "";
    let inner = data.data != null ? data.data : data;
    if (typeof inner === "string") {
      try { inner = JSON.parse(inner); } catch { return; }
    }
    if (event && event !== "App\\Events\\ChatMessageEvent" && !(inner && inner.content && inner.sender)) {
      return;
    }
    if (!inner || inner.content == null || !inner.sender) return;
    const identity = inner.sender.identity || {};
    const badges = (identity.badges || []).map((b) => {
      if (!b) return null;
      if (typeof b !== "object") return { type: String(b) };
      return {
        type: b.type || b.text || "",
        text: b.text || "",
        count: b.count != null ? b.count : 0
      };
    }).filter((b) => b && b.type);
    this.broadcast({
      type: "chat",
      id: inner.id,
      user: inner.sender.username || inner.sender.slug || "user",
      color: identity.color || "",
      text: inner.content,
      badges
    });
  }

  scheduleReconnect(newIdentity) {
    if (this.closed) return;
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
    clearTimeout(this.refreshTimer);
    const wait = this.backoff;
    this.backoff = Math.min(15000, Math.floor(this.backoff * 1.7));
    if (newIdentity) {
      this.clientId = null;
      this.token = null;
    }
    setTimeout(() => this.connect(), wait);
  }

  addClient(ws) {
    this.clients.add(ws);
  }

  removeClient(ws) {
    this.clients.delete(ws);
    if (this.clients.size === 0) {
      // Keep the upstream briefly in case OBS reloads the dock.
      setTimeout(() => {
        if (this.clients.size === 0) this.destroy();
      }, 15000);
    }
  }

  destroy() {
    this.closed = true;
    clearTimeout(this.refreshTimer);
    if (this.ws) {
      try { this.ws.close(); } catch {}
    }
    upstreams.delete(this.key);
    log("released Kick upstream", this.slug);
  }
}

const upstreams = new Map();

function getUpstream(opts) {
  const key = (opts.slug || "").toLowerCase() + ":" + (opts.chatroomId || "");
  let u = upstreams.get(key);
  if (!u || u.closed) {
    u = new KickUpstream(opts);
    u.key = key;
    upstreams.set(key, u);
  }
  return u;
}

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".mjs": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8"
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
    return;
  }
  if (assetsToHttp(req, res)) return;
  let filePath = url.pathname === "/" ? HTML_FILE : path.join(__dirname, path.normalize(url.pathname).replace(/^(\.\.(\/|\\|$))+/, ""));
  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403); res.end("forbidden"); return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end("not found"); return; }
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
    res.end(data);
  });
});

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (url.pathname !== "/kick") {
    socket.destroy();
    return;
  }
  // Minimal WebSocket handshake (RFC 6455) so we don't need the 'ws' package.
  const key = req.headers["sec-websocket-key"];
  if (!key) { socket.destroy(); return; }
  const accept = crypto
    .createHash("sha1")
    .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
    .digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
    "Upgrade: websocket\r\n" +
    "Connection: Upgrade\r\n" +
    "Sec-WebSocket-Accept: " + accept + "\r\n\r\n"
  );
  if (head && head.length) socket.unshift(head);

  const client = new LocalSocket(socket);
  const preset = {
    slug: url.searchParams.get("kick") || url.searchParams.get("channel") || "",
    chatroomId: url.searchParams.get("chatroom") || url.searchParams.get("chatroomId") || "",
    channelId: url.searchParams.get("channelId") || ""
  };

  let upstream = null;

  function subscribe(msg) {
    const slug = (msg && msg.kick) || preset.slug;
    if (!slug && !(msg && msg.chatroomId) && !preset.chatroomId) {
      send(client, { type: "status", state: "error", detail: "No Kick channel name was given" });
      return;
    }
    if (upstream) upstream.removeClient(client);
    upstream = getUpstream({
      slug: slug || "channel",
      chatroomId: (msg && msg.chatroomId) || preset.chatroomId || "",
      channelId: (msg && msg.channelId) || preset.channelId || ""
    });
    upstream.addClient(client);
    upstream.status(upstream.ws && upstream.ws.readyState === 1 ? "connected" : "connecting",
      upstream.ws && upstream.ws.readyState === 1 ? "connected" : "connecting");
  }

  if (preset.slug || preset.chatroomId) subscribe({});

  client.onMessage = (text) => {
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    if (msg.type === "subscribe") subscribe(msg);
  };
  client.onClose = () => {
    if (upstream) upstream.removeClient(client);
  };
});

class LocalSocket {
  constructor(socket) {
    this.socket = socket;
    this.readyState = 1;
    this._buf = Buffer.alloc(0);
    this.onMessage = null;
    this.onClose = null;
    socket.on("data", (d) => this._feed(d));
    socket.on("close", () => this._die());
    socket.on("error", () => this._die());
  }
  send(data) {
    if (this.readyState !== 1) return;
    const payload = Buffer.from(String(data));
    this.socket.write(encodeFrame(payload, 0x1));
  }
  close() { this._die(); }
  _die() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    try { this.socket.end(); } catch {}
    if (this.onClose) this.onClose();
  }
  _feed(chunk) {
    this._buf = Buffer.concat([this._buf, chunk]);
    while (true) {
      const parsed = decodeFrame(this._buf);
      if (!parsed) break;
      this._buf = parsed.rest;
      if (parsed.opcode === 0x8) { this._die(); return; }
      if (parsed.opcode === 0x9) { this.socket.write(encodeFrame(parsed.payload, 0xa)); continue; }
      if (parsed.opcode === 0x1 || parsed.opcode === 0x2) {
        if (this.onMessage) this.onMessage(parsed.payload.toString("utf8"));
      }
    }
  }
}

function encodeFrame(payload, opcode) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | opcode;
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(len, 6);
  }
  return Buffer.concat([header, payload]);
}

function decodeFrame(buf) {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    offset = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    const high = buf.readUInt32BE(2);
    const low = buf.readUInt32BE(6);
    if (high !== 0 || low > 0x7fffffff) return null;
    len = low;
    offset = 10;
  }
  const maskLen = masked ? 4 : 0;
  if (buf.length < offset + maskLen + len) return null;
  let payload = buf.subarray(offset + maskLen, offset + maskLen + len);
  if (masked) {
    const mask = buf.subarray(offset, offset + 4);
    const copy = Buffer.from(payload);
    for (let i = 0; i < copy.length; i++) copy[i] ^= mask[i % 4];
    payload = copy;
  }
  return { opcode, payload, rest: buf.subarray(offset + maskLen + len) };
}

server.listen(PORT, HOST, () => {
  log("Combined Chat Kick relay on http://" + HOST + ":" + PORT + "/");
  log("Open: http://127.0.0.1:" + PORT + "/combined-chat.html?twitch=fordenad&kick=fordenad");
  log("Ctrl+C to stop.");
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error("Port " + PORT + " is already in use. Is the relay already running?");
    process.exit(1);
  }
  throw err;
});

process.on("SIGINT", () => { server.close(); process.exit(0); });
process.on("SIGTERM", () => { server.close(); process.exit(0); });
