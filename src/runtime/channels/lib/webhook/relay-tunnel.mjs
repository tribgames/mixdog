// Relay-backed public webhook tunnel — the ngrok child process replacement.
//
// The channel worker keeps ONE outbound WebSocket to the Mixdog relay
// (apps/relay/server.mjs `/hookleg`). Inbound requests on
//   https://<relay>/hook/<deviceId>/webhook/<name>
// arrive over that leg as JSON frames and are replayed against the LOCAL
// webhook HTTP server; the response returns verbatim. Endpoint HMAC
// verification stays local — the relay never inspects payloads. Works out
// of the box: no binary, no authtoken, no reserved domain.
import * as http from "http";
import { randomBytes, randomUUID } from "crypto";
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from "fs";
import { join } from "path";
import WebSocket from "ws";
import { DATA_DIR } from "../config.mjs";
import { logWebhook } from "./log.mjs";

/** Packaged default mirrors the desktop pairing relay. */
const DEFAULT_RELAY_URL = "wss://192-255-139-161.sslip.io";
export const MAX_TUNNEL_BODY_BYTES = 1024 * 1024;
const MAX_HOOK_FRAME_BYTES = 2 * 1024 * 1024;
const MAX_HOOK_HEADER_BYTES = 32 * 1024;
const HOP_HEADERS = new Set([
  "host", "connection", "content-length", "transfer-encoding", "keep-alive", "upgrade", "te",
]);
const HEARTBEAT_MS = 25_000;
const LOCAL_TIMEOUT_MS = 25_000;

export function resolveHookRelayUrl(env = process.env) {
  const raw = String(env.MIXDOG_RELAY_URL || "").trim();
  const flag = raw.toLowerCase();
  if (flag === "0" || flag === "false" || flag === "off") return null;
  let url;
  try {
    url = new URL(raw || DEFAULT_RELAY_URL);
  } catch {
    throw new TypeError("MIXDOG_RELAY_URL is invalid");
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const loopback = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  if (url.protocol !== "wss:" && !(url.protocol === "ws:" && loopback)) {
    throw new TypeError("MIXDOG_RELAY_URL must use wss://; ws:// is allowed only for loopback development");
  }
  if (url.username || url.password) {
    throw new TypeError("MIXDOG_RELAY_URL must not contain credentials");
  }
  return url.toString();
}

function hookIdentityPath() {
  return join(DATA_DIR, "relay-hook-device.json");
}

// Stable per-install identity (trust-on-first-use at the relay, mirroring
// the desktop leg). The secret never leaves this machine except toward the
// relay; the deviceId doubles as the public URL path segment.
function loadOrCreateHookIdentity() {
  const path = hookIdentityPath();
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed.deviceId === "string" && /^[0-9a-f-]{8,64}$/.test(parsed.deviceId)
      && typeof parsed.deviceSecret === "string" && parsed.deviceSecret.length >= 16) {
      // The secret authenticates the webhook tunnel leg (whoever holds it can
      // take over inbound deliveries), so clamp legacy world-readable files.
      try { chmodSync(path, 0o600); } catch { /* windows/fs quirk */ }
      return { deviceId: parsed.deviceId, deviceSecret: parsed.deviceSecret };
    }
  } catch { /* first run */ }
  const identity = { deviceId: randomUUID(), deviceSecret: randomBytes(24).toString("hex") };
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(path, JSON.stringify(identity, null, 2), { encoding: "utf8", mode: 0o600 });
    try { chmodSync(path, 0o600); } catch { /* windows/fs quirk */ }
  } catch (err) {
    logWebhook(`hook tunnel: identity persist failed — ${err?.message || err}`);
  }
  return identity;
}

function hookPublicBase(relayUrl, deviceId) {
  const url = new URL(relayUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = `/hook/${deviceId}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function hookLegSocketOptions(relayUrl, { deviceId, deviceSecret }) {
  const target = new URL(resolveHookRelayUrl({ MIXDOG_RELAY_URL: relayUrl }));
  target.pathname = "/hookleg";
  target.search = "";
  target.hash = "";
  return {
    url: target.toString(),
    headers: {
      Authorization: `Basic ${Buffer.from(`${deviceId}:${deviceSecret}`, "utf8").toString("base64")}`,
    },
  };
}

export function normalizeHookRequestFrame(frame) {
  if (!frame || typeof frame !== "object" || Array.isArray(frame)
    || frame.type !== "http"
    || typeof frame.id !== "string" || frame.id.length < 1 || frame.id.length > 128) {
    throw new TypeError("invalid webhook relay frame");
  }
  if (frame.method !== "POST") throw new TypeError("webhook relay method must be POST");
  if (typeof frame.path !== "string" || frame.path.length > 4096
    || !/^\/webhook\/[A-Za-z0-9_-]{1,64}(?:\?[^#\r\n]{0,2048})?$/.test(frame.path)) {
    throw new TypeError("invalid webhook relay path");
  }
  const inputHeaders = frame.headers && typeof frame.headers === "object" && !Array.isArray(frame.headers)
    ? frame.headers : {};
  const headers = {};
  let headerBytes = 0;
  for (const [rawName, rawValue] of Object.entries(inputHeaders)) {
    const name = String(rawName).toLowerCase();
    if (HOP_HEADERS.has(name)) continue;
    if (!/^[!#$%&'*+\-.^_`|~0-9a-z]+$/.test(name)) {
      throw new TypeError("invalid webhook relay header name");
    }
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    const normalized = values.map((value) => String(value));
    if (normalized.some((value) => /[\r\n]/.test(value) || value.length > 8192)) {
      throw new TypeError("invalid webhook relay header value");
    }
    headerBytes += name.length + normalized.reduce((sum, value) => sum + value.length, 0);
    if (headerBytes > MAX_HOOK_HEADER_BYTES) throw new TypeError("webhook relay headers exceed limit");
    headers[name] = Array.isArray(rawValue) ? normalized : normalized[0];
  }
  const encoded = frame.body == null ? "" : String(frame.body);
  const maximumEncoded = Math.ceil(MAX_TUNNEL_BODY_BYTES / 3) * 4;
  if (encoded.length > maximumEncoded
    || (encoded && !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))) {
    throw new TypeError("invalid webhook relay body");
  }
  const body = encoded ? Buffer.from(encoded, "base64") : null;
  if (body && body.length > MAX_TUNNEL_BODY_BYTES) {
    throw new TypeError("webhook relay body exceeds limit");
  }
  return { id: frame.id, method: "POST", path: frame.path, headers, body };
}

/** Public base URL for status surfaces; null until the first tunnel start
 *  persisted an identity (no identity is ever created here). */
export function readHookPublicBase(env = process.env) {
  const relayUrl = resolveHookRelayUrl(env);
  if (!relayUrl) return null;
  try {
    const parsed = JSON.parse(readFileSync(hookIdentityPath(), "utf8"));
    if (typeof parsed.deviceId === "string" && parsed.deviceId) {
      return hookPublicBase(relayUrl, parsed.deviceId);
    }
  } catch { /* tunnel has not started yet */ }
  return null;
}

export function startHookTunnel({ relayUrl, getLocalPort }) {
  const { deviceId, deviceSecret } = loadOrCreateHookIdentity();
  let socket = null;
  let closed = false;
  let retryMs = 1_000;
  let reconnectTimer = null;
  let announced = false;

  const scheduleReconnect = () => {
    if (closed) return;
    reconnectTimer = setTimeout(connect, retryMs);
    reconnectTimer.unref?.();
    retryMs = Math.min(30_000, retryMs * 2);
  };

  const respond = (ws, id, status, headers, bodyBuffer) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify({
        type: "http-response",
        id,
        status,
        headers: headers || {},
        body: bodyBuffer && bodyBuffer.length ? bodyBuffer.toString("base64") : "",
      }));
    } catch { /* relay vanished; it times the request out */ }
  };

  const forwardToLocal = (frame, ws) => {
    const port = getLocalPort();
    if (!port) {
      respond(ws, frame.id, 503, { "content-type": "application/json" },
        Buffer.from('{"error":"webhook server not listening"}'));
      return;
    }
    let request;
    try {
      request = http.request({
        host: "127.0.0.1",
        port,
        method: frame.method,
        path: frame.path,
        headers: frame.headers,
        timeout: LOCAL_TIMEOUT_MS,
      }, (response) => {
      const chunks = [];
      let total = 0;
      let overflow = false;
      response.on("data", (chunk) => {
        total += chunk.length;
        if (total > MAX_TUNNEL_BODY_BYTES) {
          overflow = true;
          response.destroy(new Error("local webhook response exceeds limit"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        if (overflow) return;
        respond(ws, frame.id, response.statusCode || 502,
          { "content-type": response.headers["content-type"] || "application/json" },
          Buffer.concat(chunks));
      });
      response.on("error", () => respond(ws, frame.id, 502, {}, null));
      });
    } catch (err) {
      respond(ws, frame.id, 400, { "content-type": "application/json" },
        Buffer.from(JSON.stringify({ error: String(err?.message || err) })));
      return;
    }
    request.on("timeout", () => request.destroy(new Error("local webhook timeout")));
    request.on("error", (err) => respond(ws, frame.id, 502, { "content-type": "application/json" },
      Buffer.from(JSON.stringify({ error: String(err?.message || err) }))));
    if (body && body.length) request.write(body);
    request.end();
  };

  const connect = () => {
    if (closed) return;
    const connection = hookLegSocketOptions(relayUrl, { deviceId, deviceSecret });
    let ws;
    try {
      ws = new WebSocket(connection.url, {
        headers: connection.headers,
        maxPayload: MAX_HOOK_FRAME_BYTES,
      });
    } catch (err) {
      logWebhook(`hook tunnel: dial failed — ${err?.message || err}`);
      scheduleReconnect();
      return;
    }
    socket = ws;
    // NAT paths silently drop idle sockets; protocol pings keep the leg warm
    // and detect a half-dead link so the reconnect loop restores it.
    let alive = true;
    ws.on("pong", () => { alive = true; });
    const heartbeat = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (!alive) { try { ws.terminate(); } catch { /* close reconnects */ } return; }
      alive = false;
      try { ws.ping(); } catch { /* close reconnects */ }
    }, HEARTBEAT_MS);
    heartbeat.unref?.();
    ws.on("open", () => {
      retryMs = 1_000;
      if (!announced) {
        announced = true;
        logWebhook(`hook tunnel up: ${hookPublicBase(relayUrl, deviceId)}`);
      }
    });
    ws.on("message", (raw) => {
      alive = true;
      let rawFrame;
      try { rawFrame = JSON.parse(String(raw)); } catch { return; }
      let frame;
      try {
        frame = normalizeHookRequestFrame(rawFrame);
      } catch (err) {
        if (typeof rawFrame?.id === "string") {
          respond(ws, rawFrame.id, 400, { "content-type": "application/json" },
            Buffer.from(JSON.stringify({ error: String(err?.message || err) })));
        }
        return;
      }
      forwardToLocal(frame, ws);
    });
    ws.on("error", () => { /* surfaced as close */ });
    ws.on("close", () => {
      clearInterval(heartbeat);
      if (socket === ws) socket = null;
      scheduleReconnect();
    });
  };

  connect();
  return {
    deviceId,
    publicBase: hookPublicBase(relayUrl, deviceId),
    close() {
      if (closed) return;
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (socket) {
        try { socket.terminate(); } catch { /* already gone */ }
        socket = null;
      }
    },
  };
}
