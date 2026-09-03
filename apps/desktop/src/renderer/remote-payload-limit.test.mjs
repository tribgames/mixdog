import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import WebSocket, { WebSocketServer } from "ws";

import { startRelay } from "../../../relay/server.mjs";
import { startRemoteRelay } from "../main/remote-relay.ts";
import { createRelayE2EEClientHandshake } from "../shared/remote-e2ee.ts";
import * as payloadLimit from "../shared/remote-payload-limit.ts";
import {
  RELAY_DEFAULT_MAX_FRAME_BYTES,
  RELAY_PAYLOAD_TOO_LARGE_CODE,
  RELAY_ROUTING_CAPS_EVENT,
  readRelayPayloadRejection,
  readRelayUplinkCeilings,
  relayFallbackUplinkCeilings,
  relayFrameByteLength,
  relayFrameCallId,
  relayFrameCapRefusal,
  relayFrameRefusal,
  relayPayloadRejectedFrame,
  relayPayloadTooLargeMessage,
  relayStrandedCallRefusals,
  relayUplinkCeilingFields,
  relayUplinkContract,
  resolveRelayFrameLimit,
} from "../shared/remote-payload-limit.ts";

const MB = 1024 * 1024;
const LIMIT = 64 * MB;
// The desktop leg's own transport constant (main/remote-relay.ts): what it
// DECLARES it can receive. The relay clamps its uplink to it and publishes the
// result; nothing on this side may enforce the raw number.
const DESKTOP_DECLARED_BYTES = 68 * MB;

/** A live relay, a live desktop leg, and (on demand) a live phone leg — the
 *  actual handshake, not a hand-written capabilities frame. Every ceiling
 *  asserted below is one this relay published for this connection and enforces
 *  on the phone socket in the same test. */
const withRelay = async (options, run) => {
  const dir = mkdtempSync(join(tmpdir(), "mixdog-uplink-"));
  const relay = await startRelay({ port: 0, dataDir: join(dir, "data"), ...options });
  const sockets = [];
  // The first frame can arrive in the same tick as the handshake, so every
  // collector is attached BEFORE the socket is awaited.
  const open = (path, headers) => {
    const socket = new WebSocket(`ws://127.0.0.1:${relay.port}${path}`, { headers });
    sockets.push(socket);
    return {
      socket,
      ready: new Promise((resolve, reject) => {
        socket.once("open", () => resolve(socket));
        socket.once("error", reject);
      }),
    };
  };
  try {
    const deviceId = randomUUID();
    relay.store.authenticate(deviceId, "0123456789abcdef");
    const registered = relay.store.registerClient(deviceId, "bbbbbbbb", {});
    const leg = open("/desktop", {
      Authorization: `Basic ${Buffer.from(`${deviceId}:0123456789abcdef`).toString("base64")}`,
    });
    const capabilities = relayFrames(leg.socket, (value) => value?.type === "relay-capabilities");
    // Text the relay accepted arrives here as a routing envelope (binary, so it
    // reads as null); its refusals never do, which is the point of refusing on
    // the leg that sent the frame.
    const routed = relayFrames(leg.socket, (value) => value === null);
    await leg.ready;
    return await run({
      relay,
      desktop: leg.socket,
      capabilities,
      routed,
      openPhone: async () => {
        const phone = open(`/ws?token=${registered.token}`, {
          Origin: `http://127.0.0.1:${relay.port}`,
        });
        const refusals = relayFrames(
          phone.socket,
          (value) => value?.error === "frame-too-large",
        );
        await phone.ready;
        return { socket: phone.socket, refusals };
      },
    });
  } finally {
    for (const socket of sockets) {
      try { socket.terminate(); } catch { /* already gone */ }
    }
    await relay.close();
    rmSync(dir, { recursive: true, force: true });
  }
};

/** Frames off a live socket, in arrival order, awaitable by index. A message
 *  that is not JSON reads as null — the routing envelope for a phone frame the
 *  relay accepted is binary. */
const relayFrames = (socket, accept) => {
  const frames = [];
  const waiting = [];
  socket.on("message", (raw) => {
    let value = null;
    try { value = JSON.parse(String(raw)); } catch { value = null; }
    if (!accept(value)) return;
    frames.push(value === null ? { bytes: raw.length } : value);
    for (const resume of waiting.splice(0)) resume();
  });
  return {
    frames,
    async at(index) {
      while (frames.length <= index) {
        await Promise.race([
          new Promise((resume) => waiting.push(resume)),
          new Promise((unused, reject) => setTimeout(
            () => reject(new Error(`no frame ${index} within 2s`)),
            2_000,
          ).unref?.()),
        ]);
      }
      return frames[index];
    },
  };
};

/** The desktop hop, as main/remote-relay.ts performs it: consume the ceilings
 *  the relay published, bound them by the policy ceiling it declared, and hand
 *  the SAME numbers to the browser. (The wiring itself is pinned by the source
 *  assertions further down.) */
const desktopAdvertisement = (capabilities) => {
  const policy = resolveRelayFrameLimit(
    typeof capabilities.maxFrameBytes === "number" ? capabilities.maxFrameBytes : null,
  );
  const textFrames = capabilities.textFrames === 1;
  const uplink = relayUplinkContract(readRelayUplinkCeilings(capabilities), { policy, textFrames });
  return {
    type: "e2ee-ready",
    version: 1,
    maxFrameBytes: policy,
    maxRoutedBytes: uplink.capacity,
    ...relayUplinkCeilingFields(uplink),
    ...(textFrames ? { textFrames: 1 } : {}),
  };
};

/** The browser hop, as renderer/remote-shim.ts performs it: what this leg
 *  enforces on every frame before it is sent. */
const browserCeilings = (ready) => relayUplinkContract(readRelayUplinkCeilings(ready), {
  policy: resolveRelayFrameLimit(
    typeof ready.maxFrameBytes === "number" ? ready.maxFrameBytes : null,
  ),
  capacity: typeof ready.maxRoutedBytes === "number" ? ready.maxRoutedBytes : null,
  textFrames: ready.textFrames === 1,
});

/** Envelopes off one desktop leg, matched in arrival order. */
const legFrames = (socket) => {
  const frames = [];
  const waiting = [];
  let cursor = 0;
  socket.on("message", (raw) => {
    let value;
    try { value = JSON.parse(String(raw)); } catch { return; }
    frames.push(value);
    for (const resume of waiting.splice(0)) resume();
  });
  const waitFor = async (match) => {
    for (;;) {
      while (cursor < frames.length) {
        const frame = frames[cursor];
        cursor += 1;
        if (match(frame)) return frame;
      }
      await Promise.race([
        new Promise((resume) => waiting.push(resume)),
        new Promise((unused, reject) => setTimeout(
          () => reject(new Error("no matching desktop frame within 5s")),
          5_000,
        ).unref?.()),
      ]);
    }
  };
  return { socket, waitFor };
};

/** Enough of a DesktopService for a relay leg to open and answer a phone. */
const stubHost = () => ({
  getSnapshot: () => ({ sessionId: "session", items: [], status: "idle" }),
  subscribe: () => () => {},
  subscribeSessions: () => () => {},
  subscribeAgentPool: () => () => {},
  subscribeSessionStates: () => () => {},
  subscribeDesktopEvents: () => () => {},
  invokeDesktopOperation: async () => null,
});

/** The REAL desktop (`startRemoteRelay`) dialling a relay leg this test writes
 *  by hand — the only way to exercise an order a conforming relay never uses,
 *  such as a reconnect that never announces its capabilities. */
const withDesktop = async (run) => {
  const dir = mkdtempSync(join(tmpdir(), "mixdog-desktop-leg-"));
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  const legs = [];
  const waiting = [];
  server.on("connection", (socket) => {
    legs.push(legFrames(socket));
    for (const resume of waiting.splice(0)) resume();
  });
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  let handle = null;
  try {
    handle = await startRemoteRelay({
      relayUrl: `ws://127.0.0.1:${server.address().port}`,
      userDataPath: dir,
      host: stubHost(),
    });
    return await run({
      handle,
      leg: async (index) => {
        while (legs.length <= index) {
          await Promise.race([
            new Promise((resume) => waiting.push(resume)),
            new Promise((unused, reject) => setTimeout(
              () => reject(new Error(`no desktop connection ${index} within 8s`)),
              8_000,
            ).unref?.()),
          ]);
        }
        return legs[index];
      },
    });
  } finally {
    if (handle) await handle.close();
    for (const leg of legs) {
      try { leg.socket.terminate(); } catch { /* already gone */ }
    }
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
};

/** A phone completing the genuine E2EE handshake over one leg: the
 *  `e2ee-ready` the desktop actually sent it, and a reader for everything the
 *  desktop sends that channel afterwards. */
const browserHandshake = async (leg, pairing, clientId) => {
  leg.socket.send(JSON.stringify({ type: "client-open", clientId }));
  const challenge = await leg.waitFor(
    (frame) => frame.type === "frame" && frame.clientId === clientId,
  );
  const handshake = await createRelayE2EEClientHandshake(pairing, JSON.parse(challenge.data));
  leg.socket.send(JSON.stringify({
    type: "frame",
    clientId,
    data: JSON.stringify(handshake.hello),
  }));
  const nextMessage = async () => {
    for (;;) {
      const frame = await leg.waitFor(
        (value) => value.type === "frame" && value.clientId === clientId,
      );
      try {
        return await handshake.channel.decryptJson(JSON.parse(frame.data));
      } catch { /* not a box for this channel */ }
    }
  };
  const nextEvent = async (event) => {
    for (;;) {
      const message = await nextMessage();
      if (message?.event === event) return message;
    }
  };
  for (;;) {
    const message = await nextMessage();
    if (message?.type === "e2ee-ready") return { ready: message, nextMessage, nextEvent };
  }
};

/** The browser hop after a mid-connection update, as `learnRoutingCaps` does
 *  it: the published ceilings are replaced, the two scalars only tighten. */
const browserCeilingsAfter = (ready, update) => relayUplinkContract(
  readRelayUplinkCeilings(update),
  {
    policy: resolveRelayFrameLimit(update.maxFrameBytes, ready.maxFrameBytes),
    capacity: Math.min(update.maxRoutedBytes, ready.maxRoutedBytes),
    textFrames: update.textFrames === 1,
  },
);

/** What a leg does with one frame it has already serialized: refuse it (and
 *  say whose it is) or send it. This is the whole attribution model — the
 *  frame in hand IS the frame that fails. */
const sendAttempt = (payload, bytes, limit = LIMIT) =>
  relayFrameRefusal(bytes, limit, relayFrameCallId(payload));

test("a refusal is read from every leg's envelope", () => {
  // Relay → desktop leg: the desktop's own oversize answer.
  assert.deepEqual(
    readRelayPayloadRejection({
      type: "frame-too-large",
      clientId: "client-1",
      bytes: 13 * MB,
      limit: 8 * MB,
    }),
    { bytes: 13 * MB, limit: 8 * MB, callId: null, scope: "unknown" },
  );
  // Relay → phone leg: rides `resync`, the only cleartext key an E2EE browser
  // handles before decryption.
  assert.deepEqual(
    readRelayPayloadRejection({
      resync: 1,
      error: "frame-too-large",
      bytes: 13 * MB,
      limit: 8 * MB,
    }),
    { bytes: 13 * MB, limit: 8 * MB, callId: null, scope: "unknown" },
  );
  // Desktop → browser over an AUTHENTICATED channel: the one case allowed to
  // name a call, because the desktop named the frame it declined to send.
  assert.deepEqual(
    readRelayPayloadRejection({
      event: "relayPayloadRejected",
      payload: { bytes: 13 * MB, limit: 8 * MB, id: 41 },
    }, true),
    { bytes: 13 * MB, limit: 8 * MB, callId: 41, scope: "call" },
  );
});

test("trust follows the channel, not the shape", () => {
  const forgedEvent = {
    event: "relayPayloadRejected",
    payload: { bytes: 1, limit: 64 * MB, id: 77 },
  };
  // Non-E2EE connection: clear relay data reaches the same handler, so the
  // very same frame selects nobody there.
  assert.deepEqual(
    readRelayPayloadRejection(forgedEvent, false),
    { bytes: 1, limit: 64 * MB, callId: null, scope: "unknown" },
  );
  // Unstated trust is no trust.
  assert.equal(readRelayPayloadRejection(forgedEvent).callId, null);
  assert.equal(readRelayPayloadRejection(forgedEvent, true).callId, 77);
  // A forged `push` scope cannot silence the wait bound either.
  assert.equal(
    readRelayPayloadRejection({
      event: "relayPayloadRejected",
      payload: { bytes: 1, limit: 64 * MB, scope: "push" },
    }, false).scope,
    "unknown",
  );
});

test("a relay-controlled signal can never select a victim", () => {
  // Forged/attacker-influenced cleartext: the id is dropped, not honoured.
  assert.deepEqual(
    readRelayPayloadRejection({
      resync: 1,
      error: "frame-too-large",
      bytes: 1,
      limit: 64 * MB,
      id: 77,
    }, true),
    { bytes: 1, limit: 64 * MB, callId: null, scope: "unknown" },
  );
  // Same for the desktop leg's own notice envelope.
  assert.deepEqual(
    readRelayPayloadRejection({
      type: "frame-too-large",
      clientId: "client-1",
      bytes: 70 * MB,
      limit: 64 * MB,
      id: 77,
    }, true),
    { bytes: 70 * MB, limit: 64 * MB, callId: null, scope: "unknown" },
  );
});

test("an unattributed refusal is reported to the user and blames nobody", () => {
  const rejection = readRelayPayloadRejection({
    type: "frame-too-large",
    bytes: 70 * MB,
    limit: 64 * MB,
  });
  assert.equal(rejection.callId, null);
  assert.equal(rejection.scope, "unknown");
  assert.equal(
    relayPayloadTooLargeMessage(rejection),
    "payload too large for the relay (70.0 of 64.0 MB)",
  );
  // It still reaches a browser: an unattributed notice is a real frame, with
  // no id and nothing that could pass for one.
  const notice = relayPayloadRejectedFrame({ ...rejection, callId: null, scope: "unknown" });
  assert.deepEqual(notice, {
    event: "relayPayloadRejected",
    payload: { bytes: 70 * MB, limit: 64 * MB },
  });
  assert.equal(readRelayPayloadRejection(notice, true).scope, "unknown");
  // Nothing in the module can turn sizes into a victim any more.
  assert.equal(payloadLimit.relayRejectedFrameIds, undefined);
  assert.equal(payloadLimit.findRefusedOutboundFrame, undefined);
});

test("the browser enforces the ceilings the relay published, to the byte", async () => {
  await withRelay({ maxFrameBytes: 8_192, uplinkCapacityBytes: 4_400 }, async (session) => {
    // What the relay itself decided for THIS connection, off the wire.
    const published = await session.capabilities.at(0);
    assert.equal(published.maxFrameBytes, 8_192);
    assert.equal(published.uplinkCapacityBytes, 4_400);
    assert.equal(published.uplinkBinaryCeilingBytes, 4_358);
    assert.equal(published.uplinkTextCeilingBytes, 720);
    assert.equal(published.textFrames, undefined);
    // Forwarded through the desktop, unchanged, and enforced by the browser.
    const ready = desktopAdvertisement(published);
    assert.equal(ready.uplinkTextCeilingBytes, 720);
    const ceilings = browserCeilings(ready);
    assert.deepEqual(ceilings, { capacity: 4_400, binary: 4_358, text: 720 });
    // The frame the mirrored formula used to admit at 8192/8192 is refused
    // here, at the relay's own number…
    assert.deepEqual(relayFrameCapRefusal("a".repeat(3_050), ceilings, 7), {
      bytes: 3_050,
      limit: 720,
      callId: 7,
      scope: "call",
    });
    // …and the boundary is the relay's, both ways, on both wire forms.
    assert.equal(relayFrameCapRefusal("a".repeat(720), ceilings, 7), null);
    assert.equal(relayFrameCapRefusal("a".repeat(721), ceilings, 7).limit, 720);
    assert.equal(relayFrameCapRefusal(new Uint8Array(4_358), ceilings, 7), null);
    assert.equal(relayFrameCapRefusal(new Uint8Array(4_359), ceilings, 7).limit, 4_358);

    // The relay agrees, on a real phone socket: same frame, same ceiling.
    const phone = await session.openPhone();
    phone.socket.send("a".repeat(3_050));
    assert.deepEqual(await phone.refusals.at(0), {
      resync: 1,
      error: "frame-too-large",
      bytes: 3_050,
      limit: 720,
    });

    // The acknowledgement is an answer to the declaration, on this connection.
    session.desktop.send(JSON.stringify({
      type: "desktop-lanes",
      media: false,
      e2ee: 1,
      maxPayloadBytes: DESKTOP_DECLARED_BYTES,
      textFrames: 1,
    }));
    const acked = await session.capabilities.at(1);
    assert.equal(acked.textFrames, 1);
    // Declared 68 MiB, but the relay's own capacity for this leg still rules.
    assert.equal(acked.uplinkCapacityBytes, 4_400);
    assert.equal(acked.uplinkTextCeilingBytes, 4_358);
    const ackedCeilings = browserCeilings(desktopAdvertisement(acked));
    assert.deepEqual(ackedCeilings, { capacity: 4_400, binary: 4_358, text: 4_358 });
    assert.equal(relayFrameCapRefusal("a".repeat(3_050), ackedCeilings, 7), null);
    assert.deepEqual(relayFrameCapRefusal("a".repeat(5_000), ackedCeilings, 7), {
      bytes: 5_000,
      limit: 4_358,
      callId: 7,
      scope: "call",
    });
    // And again the relay: the frame the browser now admits is carried, the
    // one it refuses is refused there at the very same ceiling.
    phone.socket.send("a".repeat(3_050));
    assert.equal((await session.routed.at(0)).bytes, 3_050 + 6 + 36);
    phone.socket.send("a".repeat(5_000));
    assert.equal((await phone.refusals.at(1)).limit, 4_358);
  });
});

test("the legacy 64 MiB path refuses at the relay's figure, not the leg's", async () => {
  await withRelay({ uplinkCapacityBytes: 64 * MB }, async (session) => {
    // A leg that declares its receive cap but not the text envelope: the
    // classic 64 MiB path, answered on the connection that declared it.
    session.desktop.send(JSON.stringify({
      type: "desktop-lanes",
      media: false,
      e2ee: 1,
      maxPayloadBytes: DESKTOP_DECLARED_BYTES,
    }));
    const published = await session.capabilities.at(1);
    assert.equal(published.maxFrameBytes, 64 * MB);
    assert.equal(published.textFrames, undefined);
    // Never the desktop's declared 68 MiB: the relay clamps a declaration to
    // what it will actually route, and publishes THAT.
    assert.equal(published.uplinkCapacityBytes, 64 * MB);
    assert.equal(published.uplinkTextCeilingBytes, 11_184_798);
    assert.equal(published.uplinkBinaryCeilingBytes, 67_108_822);
    const ceilings = browserCeilings(desktopAdvertisement(published));
    assert.equal(ceilings.text, 11_184_798);
    // 11,500,000 bytes: refused by the relay at 11,184,798, and now refused
    // here at the same byte instead of being sent on a 68 MiB assumption.
    assert.deepEqual(relayFrameCapRefusal("a".repeat(11_500_000), ceilings, 7), {
      bytes: 11_500_000,
      limit: 11_184_798,
      callId: 7,
      scope: "call",
    });
    assert.equal(relayFrameCapRefusal("a".repeat(11_184_798), ceilings, 7), null);
  });
});

test("a peer that publishes no ceilings falls back, never more permissively", async () => {
  await withRelay({}, async (session) => {
    const published = await session.capabilities.at(0);
    // The same handshake from a relay that predates published ceilings.
    const legacy = { type: "relay-capabilities", binaryFrames: 1, maxFrameBytes: 64 * MB };
    assert.equal(readRelayUplinkCeilings(legacy), null);
    // Partial publication is no publication: two authoritative numbers and one
    // guess is still a guess.
    assert.equal(readRelayUplinkCeilings({ ...legacy, uplinkCapacityBytes: 4_400 }), null);
    assert.equal(readRelayUplinkCeilings({
      ...legacy,
      uplinkCapacityBytes: 4_400,
      uplinkBinaryCeilingBytes: 4_358,
    }), null);
    const fallback = browserCeilings(desktopAdvertisement(legacy));
    // Priced at the smallest capacity the relay can hold, not at the 64 MiB
    // policy: an unpublished capacity says nothing about the receiving leg.
    assert.equal(fallback.capacity, 1_024);
    assert.equal(fallback.text, 153);
    assert.equal(fallback.binary, 954);
    // Strictly inside what that relay would have carried — the safe direction.
    assert.ok(fallback.text < published.uplinkTextCeilingBytes);
    assert.ok(fallback.binary < published.uplinkBinaryCeilingBytes);
    // Same for an older DESKTOP, which publishes only the capacity it learned:
    // the browser derives from it and lands below the relay's real ceilings.
    const olderDesktop = browserCeilings({
      type: "e2ee-ready",
      version: 1,
      maxFrameBytes: 8_192,
      maxRoutedBytes: 4_400,
    });
    assert.equal(olderDesktop.binary, 4_330);
    assert.equal(olderDesktop.text, 716);
  });
});

test("an unpublished capacity is priced at the floor, never at the policy", async () => {
  // A real leg whose capacity is far below the policy ceiling — the shape the
  // policy substitution got catastrophically wrong.
  await withRelay({ uplinkCapacityBytes: 64 * 1_024 }, async (session) => {
    // 64 KiB of capacity under a 64 MiB policy — the relay's own floor for a
    // leg that has not declared, and this relay's configured clamp besides.
    const published = await session.capabilities.at(0);
    assert.equal(published.maxFrameBytes, 64 * MB);
    assert.equal(published.uplinkCapacityBytes, 65_536);
    assert.equal(published.uplinkBinaryCeilingBytes, 65_494);
    assert.equal(published.uplinkTextCeilingBytes, 10_910);
    // The same path, from a relay that publishes nothing. Substituting the
    // policy ceiling for the missing capacity yielded 67,108,794 / 11,184,793
    // here — a thousandfold past what this leg carries.
    const silent = {
      type: "relay-capabilities",
      binaryFrames: 1,
      maxFrameBytes: published.maxFrameBytes,
    };
    const fallback = browserCeilings(desktopAdvertisement(silent));
    assert.equal(fallback.capacity, 1_024);
    assert.equal(fallback.binary, 954);
    assert.equal(fallback.text, 153);
    assert.ok(fallback.binary < published.uplinkBinaryCeilingBytes);
    assert.ok(fallback.text < published.uplinkTextCeilingBytes);
    // A 1 MB frame: admitted by the policy substitution, refused here — and
    // refused by the relay too.
    assert.equal(relayFrameCapRefusal("a".repeat(MB), fallback, 7).limit, 153);
    const phone = await session.openPhone();
    phone.socket.send("a".repeat(MB));
    assert.equal((await phone.refusals.at(0)).limit, 10_910);
  });
});

test("a silent leg is never priced above what that leg really carries", async () => {
  // 4 KiB of capacity: well under the relay's undeclared-leg floor, and a
  // configuration it accepts. The fallback has to stay inside it.
  await withRelay({ uplinkCapacityBytes: 4_096 }, async (session) => {
    const published = await session.capabilities.at(0);
    assert.equal(published.uplinkCapacityBytes, 4_096);
    assert.equal(published.uplinkBinaryCeilingBytes, 4_054);
    assert.equal(published.uplinkTextCeilingBytes, 670);
    const silent = {
      type: "relay-capabilities",
      binaryFrames: 1,
      maxFrameBytes: published.maxFrameBytes,
    };
    const fallback = browserCeilings(desktopAdvertisement(silent));
    assert.equal(fallback.binary, 954);
    assert.equal(fallback.text, 153);
    assert.ok(fallback.binary <= 4_054, "binary stays within the real leg");
    assert.ok(fallback.text <= 670, "text stays within the real leg");
    // The relay's own verdict on a frame between the two: refused there at
    // 670, and refused here long before it could be sent.
    const phone = await session.openPhone();
    phone.socket.send("a".repeat(1_000));
    assert.equal((await phone.refusals.at(0)).limit, 670);
    assert.equal(relayFrameCapRefusal("a".repeat(1_000), fallback, 7).limit, 153);
  });
  // And at the smallest capacity the relay can hold at all.
  await withRelay({ uplinkCapacityBytes: 1_024 }, async (session) => {
    const published = await session.capabilities.at(0);
    assert.equal(published.uplinkCapacityBytes, 1_024);
    assert.equal(published.uplinkBinaryCeilingBytes, 982);
    assert.equal(published.uplinkTextCeilingBytes, 158);
    const fallback = browserCeilings(desktopAdvertisement({
      type: "relay-capabilities",
      binaryFrames: 1,
      maxFrameBytes: published.maxFrameBytes,
    }));
    assert.ok(fallback.binary <= 982 && fallback.text <= 158);
  });
});

test("a frame sent INTO the ceiling drop fails at once, not in 20 seconds", async () => {
  // The update cannot be atomic with the relay's own enforcement: the relay
  // lowers the ceiling now, the phone hears about it a round trip later, and a
  // frame sent in between meets the new limit. Nothing here waits for the
  // update — that window is the subject.
  await withRelay({ maxFrameBytes: 8_192, uplinkCapacityBytes: 4 * MB }, async (session) => {
    session.desktop.send(JSON.stringify({
      type: "desktop-lanes",
      media: false,
      e2ee: 1,
      maxPayloadBytes: 4 * MB,
    }));
    const roomy = await session.capabilities.at(1);
    assert.equal(roomy.uplinkCapacityBytes, 4 * MB);
    assert.equal(roomy.uplinkTextCeilingBytes, 8_192);
    // A phone attaches and is told those ceilings; a 3 KB request fits them,
    // so the pre-send guard passes it and the call starts waiting.
    const learned = browserCeilings(desktopAdvertisement(roomy));
    assert.equal(relayFrameCapRefusal("a".repeat(3_050), learned, 7), null);
    const phone = await session.openPhone();

    // THE WINDOW: the relay lowers this leg while that request is on its way.
    session.desktop.send(JSON.stringify({
      type: "desktop-lanes",
      media: false,
      e2ee: 1,
      maxPayloadBytes: 4_400,
    }));
    const lowered = await session.capabilities.at(2);
    assert.equal(lowered.uplinkTextCeilingBytes, 720);
    const started = Date.now();
    phone.socket.send("a".repeat(3_050));
    // The relay refuses it and keeps the connection: sizes, a limit, no call.
    const refused = await phone.refusals.at(0);
    assert.deepEqual(refused, {
      resync: 1,
      error: "frame-too-large",
      bytes: 3_050,
      limit: 720,
    });
    assert.equal(phone.socket.readyState, WebSocket.OPEN);
    const rejection = readRelayPayloadRejection(refused, false);
    assert.equal(rejection.callId, null);
    assert.equal(rejection.scope, "unknown");
    // The relay cannot see inside the envelope, so the resolution happens
    // here: the reported limit becomes the ceiling in force…
    const ceilings = relayUplinkContract(
      readRelayUplinkCeilings(desktopAdvertisement(roomy)),
      {
        policy: resolveRelayFrameLimit(rejection.limit, roomy.maxFrameBytes),
        capacity: roomy.uplinkCapacityBytes,
        textFrames: false,
      },
    );
    assert.equal(ceilings.text, 720);
    // …and every call still waiting is judged by the frame IT sent. The one
    // caught by the drop fails NOW, with its size and that limit; the healthy
    // call beside it is not touched.
    const stranded = relayStrandedCallRefusals([
      [7, { bytes: 3_050, binary: false }],
      [8, { bytes: 200, binary: false }],
    ], ceilings);
    assert.deepEqual(stranded, [{ bytes: 3_050, limit: 720, callId: 7, scope: "call" }]);
    // Prompt: decided with the refusal in hand, not by the 20-second deadline
    // that would also have closed the socket.
    assert.ok(Date.now() - started < 2_000, "settled without waiting out a deadline");
    // A push caught by the same window has no call to fail, and is not lost
    // either: the notice carries sizes, and the shim toasts it.
    assert.match(relayPayloadTooLargeMessage(rejection), /payload too large for the relay/);
    assert.deepEqual(relayStrandedCallRefusals([], ceilings), []);
  });
});

test("a ceiling lowered mid-connection reaches a phone already attached", async () => {
  await withDesktop(async (session) => {
    const leg = await session.leg(0);
    leg.socket.send(JSON.stringify({
      type: "relay-capabilities",
      maxFrameBytes: 8 * MB,
      uplinkCapacityBytes: 4 * MB,
      uplinkBinaryCeilingBytes: 4_194_262,
      uplinkTextCeilingBytes: 699_038,
    }));
    const phone = await browserHandshake(leg, session.handle.pairing, "c1");
    assert.equal(phone.ready.uplinkTextCeilingBytes, 699_038);
    // A 3 KB request fits the ceiling this phone was handed at handshake time.
    const stale = browserCeilings(phone.ready);
    assert.equal(relayFrameCapRefusal("a".repeat(3_050), stale, 7), null);

    // The relay republishes a smaller leg. Nothing else changes on this
    // connection — the phone is still attached, mid-session.
    leg.socket.send(JSON.stringify({
      type: "relay-capabilities",
      maxFrameBytes: 8_192,
      uplinkCapacityBytes: 4_400,
      uplinkBinaryCeilingBytes: 4_358,
      uplinkTextCeilingBytes: 720,
    }));
    const update = await phone.nextEvent(RELAY_ROUTING_CAPS_EVENT);
    assert.deepEqual(update.payload, {
      maxFrameBytes: 8_192,
      maxRoutedBytes: 4_400,
      uplinkCapacityBytes: 4_400,
      uplinkBinaryCeilingBytes: 4_358,
      uplinkTextCeilingBytes: 720,
    });
    const current = browserCeilingsAfter(phone.ready, update.payload);
    assert.deepEqual(current, { capacity: 4_400, binary: 4_358, text: 720 });
    // The very frame that used to fit is now refused HERE, naming the call it
    // carries: that call fails at once instead of waiting out 20 seconds for
    // an answer the relay was never going to forward.
    assert.deepEqual(relayFrameCapRefusal("a".repeat(3_050), current, 7), {
      bytes: 3_050,
      limit: 720,
      callId: 7,
      scope: "call",
    });
    // A fire-and-forget publish has no call to fail, so it is refused as a
    // push — which the shim shows instead of dropping in silence.
    assert.equal(relayFrameCapRefusal("a".repeat(3_050), current, null).scope, "push");

    // Republishing the SAME numbers says nothing new and costs no frame: the
    // next event this phone sees is the next real change.
    leg.socket.send(JSON.stringify({
      type: "relay-capabilities",
      maxFrameBytes: 8_192,
      uplinkCapacityBytes: 4_400,
      uplinkBinaryCeilingBytes: 4_358,
      uplinkTextCeilingBytes: 720,
    }));
    leg.socket.send(JSON.stringify({
      type: "relay-capabilities",
      maxFrameBytes: 8_192,
      uplinkCapacityBytes: 2_200,
      uplinkBinaryCeilingBytes: 2_158,
      uplinkTextCeilingBytes: 354,
    }));
    const next = await phone.nextEvent(RELAY_ROUTING_CAPS_EVENT);
    assert.equal(next.payload.maxRoutedBytes, 2_200);
    assert.equal(next.payload.uplinkTextCeilingBytes, 354);
  });
});

test("a reconnect that announces nothing inherits no ceilings", async () => {
  await withDesktop(async (session) => {
    // Connection 1: a relay that publishes tight ceilings for this leg.
    const first = await session.leg(0);
    first.socket.send(JSON.stringify({
      type: "relay-capabilities",
      maxFrameBytes: 8_192,
      uplinkCapacityBytes: 4_400,
      uplinkBinaryCeilingBytes: 4_358,
      uplinkTextCeilingBytes: 720,
    }));
    const { ready } = await browserHandshake(first, session.handle.pairing, "c1");
    assert.equal(ready.maxFrameBytes, 8_192);
    assert.equal(ready.maxRoutedBytes, 4_400);
    assert.equal(ready.uplinkBinaryCeilingBytes, 4_358);
    assert.equal(ready.uplinkTextCeilingBytes, 720);

    // Connection 2: the leg comes back and says NOTHING — omitted, delayed, or
    // reordered behind the phone it is already routing.
    first.socket.close();
    const second = await session.leg(1);
    const { ready: readyAgain } = await browserHandshake(second, session.handle.pairing, "c2");
    // Nothing from the connection that is gone.
    assert.notEqual(readyAgain.maxRoutedBytes, 4_400);
    assert.notEqual(readyAgain.uplinkTextCeilingBytes, 720);
    assert.notEqual(readyAgain.uplinkBinaryCeilingBytes, 4_358);
    assert.notEqual(readyAgain.maxFrameBytes, 8_192);
    // An unlearned connection: the shared default policy, and a capacity
    // nobody stated priced at the smallest one the relay can hold.
    assert.equal(readyAgain.maxFrameBytes, RELAY_DEFAULT_MAX_FRAME_BYTES);
    assert.equal(readyAgain.maxRoutedBytes, 1_024);
    assert.equal(readyAgain.uplinkBinaryCeilingBytes, 954);
    assert.equal(readyAgain.uplinkTextCeilingBytes, 153);
    assert.equal(readyAgain.textFrames, undefined);
    // And what the browser enforces from it is that minimum, not the ceilings
    // of a connection that no longer exists.
    const ceilings = browserCeilings(readyAgain);
    assert.equal(relayFrameCapRefusal("a".repeat(20_000), ceilings, 7).limit, 153);
    assert.equal(relayFrameCapRefusal("a".repeat(153), ceilings, 7), null);
    assert.equal(relayFrameCapRefusal("a".repeat(154), ceilings, 7).limit, 153);
  });
});

test("the fallback formula is explicit about assuming the worst", () => {
  // The relay routes by a 36-byte randomUUID; the fallback charges 64, which
  // can only make its ceiling smaller than the relay's.
  assert.equal(payloadLimit.RELAY_FALLBACK_CLIENT_ID_BYTES, 64);
  assert.equal(payloadLimit.RELAY_JSON_ESCAPE_WORST_CASE, 6);
  // An unpublished capacity is the smallest one the relay can hold
  // (server.mjs MIN_UPLINK_CAPACITY_BYTES), never the policy ceiling and never
  // a comfortable floor some real configuration sits below.
  assert.equal(payloadLimit.RELAY_UNPUBLISHED_CAPACITY_BYTES, 1_024);
  assert.deepEqual(
    relayUplinkContract(null, { policy: 64 * MB }),
    { capacity: 1_024, binary: 954, text: 153 },
  );
  // A smaller policy bounds it further; the minimum never rises with policy.
  assert.deepEqual(
    relayUplinkContract(null, { policy: 4_096 }),
    { capacity: 1_024, binary: 954, text: 153 },
  );
  // A capacity the peer DID state is used as stated — only the missing one is
  // replaced by the minimum.
  assert.deepEqual(
    relayUplinkContract(null, { policy: 64 * MB, capacity: 65_536 }),
    { capacity: 65_536, binary: 65_466, text: 10_905 },
  );
  const caps = { capacity: 4_400, policy: 8_192 };
  const plain = relayFallbackUplinkCeilings(caps);
  assert.equal(
    plain.binary,
    4_400 - payloadLimit.RELAY_BINARY_HEADER_BYTES - payloadLimit.RELAY_FALLBACK_CLIENT_ID_BYTES,
  );
  assert.equal(
    plain.text,
    Math.floor(
      (4_400 - payloadLimit.RELAY_JSON_ENVELOPE_BYTES - payloadLimit.RELAY_FALLBACK_CLIENT_ID_BYTES)
        / 6,
    ),
  );
  // Below the ceilings the relay publishes for that very path (4358/720).
  assert.ok(plain.binary < 4_358 && plain.text < 720);
  // With the acknowledgement, text rides the fixed wrapper.
  assert.equal(relayFallbackUplinkCeilings({ ...caps, textFrames: true }).text, plain.binary);
  // Policy always bounds both, and nothing goes negative.
  assert.equal(relayFallbackUplinkCeilings({ capacity: 1_000_000, policy: 4_096 }).binary, 4_096);
  assert.equal(relayFallbackUplinkCeilings({ capacity: 10, policy: 4_096 }).binary, 0);
  // A published ceiling is never raised by the policy one, only lowered.
  assert.deepEqual(
    relayUplinkContract({ capacity: 4_400, binary: 4_358, text: 720 }, { policy: 1_024 }),
    { capacity: 4_400, binary: 1_024, text: 720 },
  );
  // The derivation-first helpers are gone: they made this leg disagree with
  // the relay in both directions.
  assert.equal(payloadLimit.relayUplinkCeilings, undefined);
  assert.equal(payloadLimit.RELAY_MAX_CLIENT_ID_BYTES, undefined);
  assert.equal(payloadLimit.relayJsonStringByteLength, undefined);
  assert.equal(payloadLimit.relayRoutedFrameByteLength, undefined);
  assert.equal(payloadLimit.RELAY_ROUTING_ENVELOPE_BYTES, undefined);
  assert.equal(payloadLimit.relayClientFrameLimit, undefined);
});

test("an unknown or malformed refusal never throws and is never acted on", () => {
  for (const frame of [
    null,
    undefined,
    "frame-too-large",
    42,
    {},
    { type: "frame" },
    { resync: 1 },
    { error: "something-else" },
    { event: "state", payload: { bytes: 1 } },
  ]) {
    assert.equal(readRelayPayloadRejection(frame), null);
  }
});

test("unusable sizes and ids are dropped rather than trusted", () => {
  assert.deepEqual(
    readRelayPayloadRejection({ type: "frame-too-large", bytes: -1, limit: "nope" }),
    { bytes: null, limit: null, callId: null, scope: "unknown" },
  );
  assert.deepEqual(
    readRelayPayloadRejection({ type: "frame-too-large", bytes: "8388608", limit: 0 }),
    { bytes: 8 * MB, limit: null, callId: null, scope: "unknown" },
  );
  assert.deepEqual(
    readRelayPayloadRejection({ resync: 1, error: "frame-too-large" }),
    { bytes: null, limit: null, callId: null, scope: "unknown" },
  );
  assert.deepEqual(
    readRelayPayloadRejection({
      event: "relayPayloadRejected",
      payload: { bytes: 9 * MB, limit: 8 * MB, id: "41" },
    }, true),
    { bytes: 9 * MB, limit: 8 * MB, callId: null, scope: "unknown" },
  );
});

test("the user reads the size, not a generic disconnect", () => {
  assert.equal(
    relayPayloadTooLargeMessage({ bytes: 13_000_000, limit: 8 * MB, callId: null }),
    "payload too large for the relay (12.4 of 8.0 MB)",
  );
  // A relay that reported only the refused size still names it.
  assert.equal(
    relayPayloadTooLargeMessage({ bytes: 13_000_000, limit: null, callId: null }),
    "payload too large for the relay (12.4 MB)",
  );
  assert.equal(
    relayPayloadTooLargeMessage({ bytes: null, limit: null, callId: null }),
    "payload too large for the relay",
  );
});

test("two in-flight frames of identical size each fail their own call", () => {
  // The classic misattribution: same size, two calls. Each frame is judged as
  // it is sent, so size collision is not a failure mode at all.
  const first = sendAttempt({ id: 41, ok: true, value: "x" }, 70 * MB);
  const second = sendAttempt({ id: 42, ok: true, value: "y" }, 70 * MB);
  assert.equal(first.callId, 41);
  assert.equal(second.callId, 42);
  // And the FIRST refusal is the first call's, never the newest one's.
  assert.deepEqual(first, { bytes: 70 * MB, limit: LIMIT, callId: 41, scope: "call" });
});

test("a push colliding with a call in size blames nobody", () => {
  const push = sendAttempt({ event: "sessionState", payload: {} }, 70 * MB);
  const call = sendAttempt({ id: 42, ok: true, value: "y" }, 70 * MB);
  assert.equal(push.callId, null);
  assert.equal(call.callId, 42);
  // The push refusal still reaches the user, it just accuses no call.
  assert.equal(
    relayPayloadTooLargeMessage(push),
    "payload too large for the relay (70.0 of 64.0 MB)",
  );
  // A push refusal is explicitly scoped: it leaves nobody waiting, so it must
  // not shorten a healthy call's deadline.
  assert.equal(push.scope, "push");
  assert.deepEqual(relayPayloadRejectedFrame(push), {
    event: "relayPayloadRejected",
    payload: { bytes: 70 * MB, limit: LIMIT, scope: "push" },
  });
  assert.equal(
    readRelayPayloadRejection(relayPayloadRejectedFrame(push), true).scope,
    "push",
  );
  assert.deepEqual(relayPayloadRejectedFrame(call), {
    event: "relayPayloadRejected",
    payload: { bytes: 70 * MB, limit: LIMIT, id: 42 },
  });
});

test("no amount of later traffic can lose the victim", () => {
  // The old design kept 8 slots and dropped the oldest; a victim behind newer
  // large frames was silently unattributable. There is no log to overflow now.
  const victim = sendAttempt({ id: 7, ok: true, value: "big" }, 70 * MB);
  for (let index = 0; index < 40; index += 1) {
    assert.equal(sendAttempt({ id: 1_000 + index, ok: true }, 2 * MB), null);
  }
  assert.equal(victim.callId, 7);
  assert.equal(sendAttempt({ id: 7, ok: true, value: "big" }, 70 * MB).callId, 7);
});

test("a frame within the limit is simply sent", () => {
  assert.equal(sendAttempt({ id: 41 }, LIMIT), null);
  assert.equal(sendAttempt({ id: 41 }, LIMIT + 1).bytes, LIMIT + 1);
});

test("the enforced ceiling is never more permissive than the relay's", () => {
  // Nothing learned yet: the shared conservative default applies.
  assert.equal(resolveRelayFrameLimit(null, undefined), RELAY_DEFAULT_MAX_FRAME_BYTES);
  assert.equal(RELAY_DEFAULT_MAX_FRAME_BYTES, 64 * MB);
  // Declared by the relay handshake — authoritative, even when larger.
  assert.equal(resolveRelayFrameLimit(128 * MB), 128 * MB);
  // A refusal notice proving a smaller ceiling always wins.
  assert.equal(resolveRelayFrameLimit(128 * MB, 8 * MB), 8 * MB);
  assert.equal(resolveRelayFrameLimit(8 * MB, 128 * MB), 8 * MB);
  // Unusable values are ignored rather than trusted.
  assert.equal(resolveRelayFrameLimit(0, -5, Number.NaN, "8"), RELAY_DEFAULT_MAX_FRAME_BYTES);
  assert.equal(resolveRelayFrameLimit(Number.POSITIVE_INFINITY, 8 * MB), 8 * MB);
});

test("frames are measured in the relay's unit, UTF-8 bytes", () => {
  const korean = "동해물과 백두산이";
  assert.equal(korean.length, 9);
  assert.equal(relayFrameByteLength(korean), 25);
  assert.equal(relayFrameByteLength("ascii-only"), 10);
  assert.equal(relayFrameByteLength(new Uint8Array(7)), 7);
  // A non-ASCII request that a UTF-16 count would place UNDER the limit is
  // still recognised as the frame the relay refused.
  const limit = 32;
  const frame = "가".repeat(15); // 15 UTF-16 units, 45 UTF-8 bytes.
  assert.ok(frame.length < limit);
  // Measured as the relay charges it, the frame is refused — and it is the
  // sending call that fails, immediately.
  assert.deepEqual(
    relayFrameRefusal(relayFrameByteLength(frame), limit, relayFrameCallId({ id: 7 })),
    { bytes: 45, limit, callId: 7, scope: "call" },
  );
  // A UTF-16 count would have let it through to a relay that refuses it.
  assert.equal(relayFrameRefusal(frame.length, limit, 7), null);
});

test("the desktop refuses its own oversize frame instead of sending it", async () => {
  const source = await readFile(new URL("../main/remote-relay.ts", import.meta.url), "utf8");
  // Measured on the serialized frame, judged against the learned ceiling, and
  // attributed to the call that frame carries.
  assert.match(source, /const bytes = relayFrameByteLength\(wire\);/);
  assert.match(
    source,
    /relayFrameRefusal\(bytes, relayFrameLimit\(\), relayFrameCallId\(payload\)\)/,
  );
  const refusalAt = source.indexOf("if (refusal) {");
  const sendAt = source.indexOf("await sendRawAndWait(wire);");
  assert.ok(refusalAt > 0 && refusalAt < sendAt, "the check runs before the send");
  assert.match(source.slice(refusalAt, sendAt), /return;/);
  // The ceiling comes from what the relay reports, never from a guess.
  assert.match(source, /declaredFrameLimit = resolveRelayFrameLimit\(envelope\.maxFrameBytes\);/);
  // No size log survives: nothing to evict, nothing to misattribute.
  for (const gone of ["outboundFrames", "noteOutboundFrame", "takeRefusedOutboundCall"]) {
    assert.equal(source.includes(gone), false, `${gone} must be gone`);
  }
});

test("a relay notice teaches the limit, names no call, and is never broadcast", async () => {
  const source = await readFile(new URL("../main/remote-relay.ts", import.meta.url), "utf8");
  const branch = source.indexOf("if (envelope.type === RELAY_FRAME_TOO_LARGE) {");
  const bail = source.indexOf("if (envelope.type !== 'frame'");
  assert.ok(branch > 0 && branch < bail, "the notice branch runs before the frame bail");
  const handler = source.slice(branch, bail);
  // A malformed envelope leaves without touching the connection.
  assert.match(handler, /if \(!rejection\) return;/);
  assert.match(handler, /noticedFrameLimit = resolveRelayFrameLimit\(rejection\.limit, noticedFrameLimit\);/);
  // The victim field is forced away on the one route that still notifies.
  assert.match(handler, /relayPayloadRejectedFrame\(\{ \.\.\.rejection, callId: null, scope: 'unknown' \}\)/);
  // Unattributed: nobody else's leg hears about it — no sibling toast, no
  // sibling deadline, no leaked size. It is recorded where it happened.
  const unattributed = handler.slice(
    handler.indexOf("if (!clientId) {"),
    handler.indexOf("// Named:"),
  );
  assert.ok(unattributed.length > 0, "the unattributed route exists");
  assert.match(unattributed, /console\.error\(/);
  assert.match(unattributed, /return;/);
  assert.equal(unattributed.includes("sendEncryptedFrame"), false);
  assert.equal(handler.includes("activeClients.keys()"), false);
  assert.equal(handler.includes("for (const target of targets)"), false);
});

test("the browser is advertised the relay's published ceilings", async () => {
  const source = await readFile(new URL("../main/remote-relay.ts", import.meta.url), "utf8");
  // Learned from the genuine capabilities frame, per connection…
  assert.match(source, /relayPublishedCeilings = readRelayUplinkCeilings\(envelope\);/);
  assert.match(
    source,
    /const relayUplinkLimits = \(\): RelayUplinkCeilings => relayUplinkContract\(\s+relayPublishedCeilings,\s+\{ policy: relayFrameLimit\(\), textFrames: relayTextFrames \},\s+\);/,
  );
  // …and handed on unchanged: the policy ceiling for the frame as sent, the
  // relay's own ceilings for the frame as routed.
  assert.match(source, /const uplink = relayUplinkLimits\(\);/);
  assert.match(
    source,
    /maxFrameBytes: relayFrameLimit\(\),[\s\S]{0,400}?maxRoutedBytes: uplink\.capacity,\s+\.\.\.relayUplinkCeilingFields\(uplink\),/,
  );
  // The hardcoded transport constant is gone from the advertisement: it is
  // larger than every ceiling on this path and belongs to no relay.
  assert.equal(source.includes("maxRoutedBytes: MAX_WS_PAYLOAD_BYTES"), false);
  // ONE shape for both frames, so the handshake and a later update can never
  // describe the same connection differently.
  assert.match(source, /type: 'e2ee-ready',\s+version: 1,\s+\.\.\.relayRoutingCapsPayload\(uplink\),/);
  // A republished capabilities frame reaches the phones already attached, and
  // only when it says something new.
  assert.match(source, /relayPublishedCeilings = readRelayUplinkCeilings\(envelope\);\s+\/\/[\s\S]{0,200}?republishRoutingCaps\(\);/);
  assert.match(source, /if \(signature === advertisedRoutingCaps\) return;/);
  assert.match(
    source,
    /broadcastEncrypted\(\{ event: RELAY_ROUTING_CAPS_EVENT, payload \}, false\);/,
  );
  // The text envelope is advertised from the relay's ACK, never from generic
  // binary support: an older binary-capable relay still JSON-wraps text.
  assert.match(source, /relayTextFrames = envelope\.textFrames === 1;/);
  assert.match(source, /\.\.\.\(relayTextFrames \? \{ textFrames: 1 as const \} : \{\}\),/);
  assert.equal(/\.\.\.\(relayBinaryFrames \? \{ textFrames/.test(source), false);
  assert.equal(source.includes("relayClientFrameLimit"), false);
});

test("an unattributed refusal reaches the desktop UI, naming no call", async () => {
  const [relay, service, stateBridge, contract, preload, notifications] = await Promise.all([
    readFile(new URL("../main/remote-relay.ts", import.meta.url), "utf8"),
    readFile(new URL("../main/desktop-service.ts", import.meta.url), "utf8"),
    readFile(new URL("../main/ipc-state-bridge.ts", import.meta.url), "utf8"),
    readFile(new URL("../shared/contract.ts", import.meta.url), "utf8"),
    readFile(new URL("../preload/index.ts", import.meta.url), "utf8"),
    readFile(new URL("./notifications.tsx", import.meta.url), "utf8"),
  ]);
  // Raised where it happens, with sizes only — no client, no call.
  assert.match(
    relay,
    /options\.onRelayPayloadRefused\?\.\(\{\s+bytes: rejection\.bytes,\s+limit: rejection\.limit,\s+\}\);/,
  );
  // …and carried out to the window process, then to the renderer.
  assert.match(service, /name: 'relay-payload-refused', value/);
  assert.match(stateBridge, /this\.send\(DESKTOP_IPC\.relayPayloadRefused, value\)/);
  assert.match(contract, /relayPayloadRefused: 'mixdog:relay-payload-refused',/);
  assert.match(contract, /subscribeRelayPayloadRefused\?\(/);
  assert.match(preload, /ipcRenderer\.on\(DESKTOP_IPC\.relayPayloadRefused, receive\);/);
  // The toast says how large, and blames nothing.
  assert.match(notifications, /subscribeRelayPayloadRefused\?\.\(/);
  assert.match(notifications, /relayPayloadTooLargeMessage\(\{\s+bytes: detail\?\.bytes \?\? null,/);
  assert.match(notifications, /callId: null,\s+scope: "unknown",/);
});

test("the desktop declares its receive cap on connect, and so on redial", async () => {
  const source = await readFile(new URL("../main/remote-relay.ts", import.meta.url), "utf8");
  // The transport cap sits above the policy ceiling by the fixed routing
  // header, so a policy-sized frame survives being wrapped.
  assert.match(source, /const MAX_WS_PAYLOAD_BYTES = 68 \* 1024 \* 1024;/);
  const declaration = /sendEnvelope\(\{\s+type: 'desktop-lanes',\s+media: false,\s+e2ee: 1,\s+maxPayloadBytes: MAX_WS_PAYLOAD_BYTES,\s+textFrames: 1,\s+\}\);/;
  assert.match(source, declaration);
  // Inside the open handler: every connection, including every redial,
  // re-declares it before the first frame can be routed.
  const declaredAt = source.search(declaration);
  // The relay leg's own handlers, not the one-shot revoke socket earlier on.
  const openAt = source.lastIndexOf("ws.on('open'", declaredAt);
  const messageAt = source.indexOf("ws.on('message'", declaredAt);
  assert.ok(openAt > 0 && declaredAt > openAt && declaredAt < messageAt);
  // And the token registration still follows it.
  assert.ok(source.indexOf("type: 'set-client-token'") > declaredAt);
});

test("a text-flagged binary frame is handed on as a string", async () => {
  const { decodeRelayBinaryFrame, encodeRelayBinaryFrame } = await import(
    "../../../relay/lib/relay-binary-frame.mjs"
  );
  const clientId = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
  const text = JSON.stringify({ type: "e2ee-box", ciphertext: "zzz", note: "한글" });
  const bytes = Buffer.from(text, "utf8");
  // What the desktop does with a decoded frame, verbatim.
  const dataOf = (frame) => (
    frame.text ? Buffer.from(frame.data).toString("utf8") : frame.data
  );
  const flagged = decodeRelayBinaryFrame(
    encodeRelayBinaryFrame({ clientId, data: bytes, text: true }),
  );
  assert.equal(flagged.text, true);
  const routed = dataOf(flagged);
  assert.equal(typeof routed, "string");
  // Identical to what the JSON envelope's `data` would have delivered.
  assert.equal(routed, text);
  // An old frame decodes exactly as before: no flag, still bytes.
  const legacy = decodeRelayBinaryFrame(encodeRelayBinaryFrame({ clientId, data: bytes }));
  assert.equal(legacy.text, false);
  assert.equal(typeof dataOf(legacy), "object");
  assert.equal(Buffer.from(dataOf(legacy)).toString("utf8"), text);
  const source = await readFile(new URL("../main/remote-relay.ts", import.meta.url), "utf8");
  assert.match(
    source,
    /data: frame\.text \? Buffer\.from\(frame\.data\)\.toString\('utf8'\) : frame\.data,/,
  );
});

test("the browser refuses its own oversize request before it is sent", async () => {
  const source = await readFile(new URL("./remote-shim.ts", import.meta.url), "utf8");
  assert.match(
    source,
    /relayFrameCapRefusal\(\s*frame,\s*relayUplinkLimits\(\),\s*relayFrameCallId\(payload\),\s*\)/,
  );
  // The ceilings are the relay's, forwarded by the desktop; the wrapping mode
  // only prices the fallback.
  assert.match(source, /learnRoutingCaps\(message\);/);
  assert.match(source, /publishedCeilings = readRelayUplinkCeilings\(message\);/);
  // A ceiling the relay lowered mid-connection is applied where it arrives —
  // from the authenticated channel only, since nothing else may decide what
  // this leg puts on the wire.
  assert.match(
    source,
    /if \(message\.event === RELAY_ROUTING_CAPS_EVENT\) \{\s+if \(authenticated && message\.payload && typeof message\.payload === 'object'\) \{\s+learnRoutingCaps\(message\.payload as Record<string, unknown>\);/,
  );
  assert.match(source, /relayTextEnvelope = message\.textFrames === 1;/);
  assert.match(
    source,
    /const relayUplinkLimits = \(\): RelayUplinkCeilings => relayUplinkContract\(\s+publishedCeilings,\s+\{ policy: relayFrameLimit\(\), capacity: learnedRoutedLimit, textFrames: relayTextEnvelope \},\s+\);/,
  );
  // Learned caps belong to ONE connection: a redial (or a replacement desktop
  // leg) starts unlearned, so a relay that came back BIGGER is not held to the
  // smaller ceiling it taught before.
  assert.match(
    source,
    /const resetLearnedCaps = \(\): void => \{\s+learnedFrameLimit = null;\s+learnedRoutedLimit = null;\s+publishedCeilings = null;\s+relayTextEnvelope = false;\s+\};/,
  );
  assert.equal(source.split("resetLearnedCaps();").length - 1, 2);
  assert.match(source, /relayBinaryFrames = false;\s+resetLearnedCaps\(\);/);
  assert.match(source, /relayBinaryFrames = clear\.binaryFrames === 1;[\s\S]{0,200}?resetLearnedCaps\(\);/);
  // Both send paths are guarded, and the guard runs BEFORE the send.
  for (const [guard, send] of [
    ["refuseOversize(frame);", "ws.send(frame);"],
    ["refuseOversize(directFrame);", "ws.send(directFrame);"],
  ]) {
    const guardAt = source.indexOf(guard);
    const sendAt = source.indexOf(send);
    assert.ok(guardAt > 0 && guardAt < sendAt, `${guard} must precede ${send}`);
  }
  // The caller fails at once — no 20-second deadline, and no closed socket for
  // what is a bad request rather than a broken connection.
  assert.match(source, /failure\.code = RELAY_PAYLOAD_TOO_LARGE_CODE;\s+\/\/ A fire/);
  assert.match(
    source,
    /if \(\(failure as \{ code\?: string \}\)\.code === RELAY_PAYLOAD_TOO_LARGE_CODE\) return;\s+try \{ ws\.close\(\)/,
  );
  assert.equal(RELAY_PAYLOAD_TOO_LARGE_CODE, "RELAY_PAYLOAD_TOO_LARGE");
  // The ceiling is learned from the desktop handshake and from any notice.
  assert.match(source, /learnFrameLimit\(message\.maxFrameBytes\);/);
  assert.match(source, /learnedRoutedLimit = resolveRelayFrameLimit\(message\.maxRoutedBytes, learnedRoutedLimit\);/);
  // A call remembers the frame IT sent — on the call, not in a log — so a
  // ceiling that drops mid-flight can be applied to that very frame.
  assert.match(
    source,
    /entry\.frame = \{ bytes: relayFrameByteLength\(frame\), binary: typeof frame !== 'string' \};/,
  );
  assert.match(source, /noteSentFrame\(frame\);\s+ws\.send\(frame\);/);
  assert.match(source, /noteSentFrame\(directFrame\);\s+ws\.send\(directFrame\);/);
  // A refusal that names nobody settles exactly the calls the proved ceiling
  // strands, and does it before anything is shown or returned.
  assert.match(
    source,
    /learnFrameLimit\(rejection\.limit\);[\s\S]{0,200}?failStrandedCalls\(\);/,
  );
  assert.match(source, /relayStrandedCallRefusals\(waiting, relayUplinkLimits\(\)\)/);
  // That settlement is a rejection with the payload code, never a close.
  assert.match(
    source,
    /const failStrandedCalls = \(\): void => \{[\s\S]{0,900}?failure\.code = RELAY_PAYLOAD_TOO_LARGE_CODE;\s+entry\.reject\(failure\);/,
  );
  assert.equal(/const failStrandedCalls[\s\S]{0,900}?ws\.close\(\)/.test(source), false);
  // The deadline still belongs to the call alone: a call settled early never
  // reaches the close inside its own timeout.
  assert.match(
    source,
    /if \(!pending\.delete\(id\)\) return;\s+reject\(new Error\('mixdog remote call timed out\.'\)\);/,
  );
  // No size-matching bookkeeping survives: nothing looks a refusal up by bytes.
  assert.equal(source.includes("recordFrameBytes"), false);
  assert.equal(source.includes("relayRejectedFrameIds"), false);
});

test("an inbound refusal fails only a named call, otherwise it is shown", async () => {
  const [shim, notifications] = await Promise.all([
    readFile(new URL("./remote-shim.ts", import.meta.url), "utf8"),
    readFile(new URL("./notifications.tsx", import.meta.url), "utf8"),
  ]);
  // Cleartext phone-leg signal, handled before the resync it rides on, and
  // explicitly untrusted.
  assert.match(
    shim,
    /const rejected = readRelayPayloadRejection\(clear, false\);\s+if \(rejected\) applyRelayPayloadRejection\(rejected\);\s+requestResync\(\);/,
  );
  // Inbound frames carry the trust of the channel they arrived on.
  assert.match(
    shim,
    /const rejectedPayload = readRelayPayloadRejection\(message, authenticated\);\s+if \(rejectedPayload\) \{\s+applyRelayPayloadRejection\(rejectedPayload\);/,
  );
  assert.match(shim, /handleMessage\(message, true\);/);
  assert.match(shim, /handleMessage\(clear, false\);/);
  assert.equal(/handleMessage\((message|clear|frame)\)/.test(shim), false);
  // The unattributed BRANCH decides no call's fate: a healthy call answering
  // at 3 s (or at 19 s) is unaffected, and a stream of notices cannot postpone
  // or shorten anything, because nothing here touches a deadline at all.
  const nullBranchAt = shim.indexOf("if (rejection.callId === null) {");
  const nullBranch = shim.slice(nullBranchAt, shim.indexOf("const entry = pending.get", nullBranchAt));
  assert.ok(nullBranchAt > 0, "the unattributed branch exists");
  assert.match(nullBranch, /showRemoteToast\(message\);\s+return;/);
  for (const forbidden of ["pending", "setTimeout", "clearTimeout", "expireIn", ".reject("]) {
    assert.equal(nullBranch.includes(forbidden), false, `${forbidden} must not appear`);
  }
  // No re-arming machinery survives anywhere, so repeated notices are inert.
  for (const gone of ["expireIn", "UNATTRIBUTED_REFUSAL"]) {
    assert.equal(shim.includes(gone), false, `${gone} must be gone`);
  }
  // A call's deadline is created exactly once, where the call is registered.
  assert.equal(shim.split("deadline = window.setTimeout").length - 1, 1);
  assert.match(shim, /const deadline = window\.setTimeout\(/);
  // No id: user-visible toast, no victim. With one: exactly that call.
  assert.match(shim, /if \(rejection\.callId === null\) \{/);
  assert.match(shim, /pending\.delete\(rejection\.callId\);/);
  // The toast rides the surface notifications.tsx actually renders.
  const toastEvent = /DESKTOP_TOAST_EVENT = "([^"]+)"/.exec(notifications);
  assert.ok(toastEvent, "notifications.tsx exports the toast event name");
  assert.ok(
    shim.includes(`new CustomEvent('${toastEvent[1]}'`),
    "the shim dispatches the toast event notifications.tsx listens for",
  );
});
