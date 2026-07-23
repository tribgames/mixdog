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
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import WebSocket from "ws";
import { DATA_DIR } from "../config.mjs";
import { logWebhook } from "./log.mjs";

/** Packaged default mirrors the desktop pairing relay. */
const DEFAULT_RELAY_URL = "wss://192-255-139-161.sslip.io";
const MAX_TUNNEL_BODY_BYTES = 1024 * 1024;
const HEARTBEAT_MS = 25_000;
const LOCAL_TIMEOUT_MS = 25_000;

export function resolveHookRelayUrl(env = process.env) {
  const raw = String(env.MIXDOG_RELAY_URL || "").trim();
  const flag = raw.toLowerCase();
  if (flag === "0" || flag === "false" || flag === "off") return null;
  return raw || DEFAULT_RELAY_URL;
}

export function hookIdentityPath() {
  return join(DATA_DIR, "relay-hook-device.json");
}

// Stable per-install identity (trust-on-first-use at the relay, mirroring
// the desktop leg). The secret never leaves this machine except toward the
// relay; the deviceId doubles as the public URL path segment.
export function loadOrCreateHookIdentity() {
  const path = hookIdentityPath();
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed.deviceId === "string" && /^[0-9a-f-]{8,64}$/.test(parsed.deviceId)
      && typeof parsed.deviceSecret === "string" && parsed.deviceSecret.length >= 16) {
      return { deviceId: parsed.deviceId, deviceSecret: parsed.deviceSecret };
    }
  } catch { /* first run */ }
  const identity = { deviceId: randomUUID(), deviceSecret: randomBytes(24).toString("hex") };
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(path, JSON.stringify(identity, null, 2), "utf8");
  } catch (err) {
    logWebhook(`hook tunnel: identity persist failed — ${err?.message || err}`);
  }
  return identity;
}

export function hookPublicBase(relayUrl, deviceId) {
  const url = new URL(relayUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = `/hook/${deviceId}`;
  url.search = "";
  url.hash = "";
  return url.toString();
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
    const body = frame.body ? Buffer.from(String(frame.body), "base64") : null;
    const request = http.request({
      host: "127.0.0.1",
      port,
      method: typeof frame.method === "string" ? frame.method : "GET",
      path: typeof frame.path === "string" && frame.path.startsWith("/") ? frame.path : "/",
      headers: frame.headers && typeof frame.headers === "object" ? frame.headers : {},
      timeout: LOCAL_TIMEOUT_MS,
    }, (response) => {
      const chunks = [];
      let total = 0;
      response.on("data", (chunk) => {
        total += chunk.length;
        if (total <= MAX_TUNNEL_BODY_BYTES) chunks.push(chunk);
      });
      response.on("end", () => respond(ws, frame.id, response.statusCode || 502,
        { "content-type": response.headers["content-type"] || "application/json" },
        Buffer.concat(chunks)));
      response.on("error", () => respond(ws, frame.id, 502, {}, null));
    });
    request.on("timeout", () => request.destroy(new Error("local webhook timeout")));
    request.on("error", (err) => respond(ws, frame.id, 502, { "content-type": "application/json" },
      Buffer.from(JSON.stringify({ error: String(err?.message || err) }))));
    if (body && body.length) request.write(body);
    request.end();
  };

  const connect = () => {
    if (closed) return;
    const target = new URL(relayUrl);
    target.pathname = "/hookleg";
    target.search = `device=${encodeURIComponent(deviceId)}&secret=${encodeURIComponent(deviceSecret)}`;
    let ws;
    try {
      ws = new WebSocket(target.toString(), { maxPayload: 8 * 1024 * 1024 });
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
      let frame;
      try { frame = JSON.parse(String(raw)); } catch { return; }
      if (frame?.type !== "http" || typeof frame.id !== "string") return;
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
