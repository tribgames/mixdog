import assert from "node:assert/strict";
import test from "node:test";

import {
  hookLegSocketOptions,
  MAX_TUNNEL_BODY_BYTES,
  normalizeHookRequestFrame,
  resolveHookRelayUrl,
} from "./relay-tunnel.mjs";

test("webhook relay requires encrypted remote transport", () => {
  assert.equal(resolveHookRelayUrl({ MIXDOG_RELAY_URL: "off" }), null);
  assert.equal(
    resolveHookRelayUrl({ MIXDOG_RELAY_URL: "ws://127.0.0.1:9800" }),
    "ws://127.0.0.1:9800/",
  );
  assert.throws(
    () => resolveHookRelayUrl({ MIXDOG_RELAY_URL: "ws://relay.example" }),
    /must use wss/,
  );
  assert.throws(
    () => resolveHookRelayUrl({ MIXDOG_RELAY_URL: "wss://token@relay.example" }),
    /must not contain credentials/,
  );
});

test("webhook relay credentials use Authorization instead of the URL", () => {
  const connection = hookLegSocketOptions("wss://relay.example", {
    deviceId: "device-id",
    deviceSecret: "device-secret-value",
  });
  const url = new URL(connection.url);
  assert.equal(url.pathname, "/hookleg");
  assert.equal(url.search, "");
  assert.equal(
    Buffer.from(connection.headers.Authorization.slice("Basic ".length), "base64").toString("utf8"),
    "device-id:device-secret-value",
  );
});

test("webhook relay frames are bounded and confined to POST webhook routes", () => {
  const frame = normalizeHookRequestFrame({
    type: "http",
    id: "request-id",
    method: "POST",
    path: "/webhook/github?source=test",
    headers: { "content-type": "application/json", host: "ignored.example" },
    body: Buffer.from("{}").toString("base64"),
  });
  assert.equal(frame.body.toString(), "{}");
  assert.equal(frame.headers.host, undefined);
  assert.throws(
    () => normalizeHookRequestFrame({ ...frame, type: "http", method: "GET", body: "" }),
    /method must be POST/,
  );
  assert.throws(
    () => normalizeHookRequestFrame({ ...frame, type: "http", path: "/", body: "" }),
    /invalid webhook relay path/,
  );
  assert.throws(
    () => normalizeHookRequestFrame({
      ...frame,
      type: "http",
      body: "A".repeat(Math.ceil(MAX_TUNNEL_BODY_BYTES / 3) * 4 + 4),
    }),
    /invalid webhook relay body/,
  );
});
