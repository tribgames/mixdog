import assert from "node:assert/strict";
import test from "node:test";

import { createLatestStateMailbox } from "./desktop-service-protocol.ts";
import {
  createSnapshotDeltaDecoder,
  createSnapshotDeltaEncoder,
  markCompactWire,
} from "./state-delta.ts";
import { clientReadsLane, encodeRelayClientSessionState } from "./remote-relay.ts";
import { createRemotePaintProbeTracker } from "../shared/remote-performance.ts";
import {
  createKeyedListDeltaDecoder,
  createKeyedListDeltaEncoder,
} from "../shared/list-delta.ts";

test("session transcript updates cross the relay as compact deltas", () => {
  const items = Array.from({ length: 200 }, (_, id) => ({
    kind: id % 3 ? "assistant" : "user",
    id,
    text: "x".repeat(1_200),
  }));
  const first = {
    sessionId: "session",
    items,
    streamingTail: { id: "tail", kind: "assistant", text: "a".repeat(1_000) },
  };
  const next = {
    ...first,
    streamingTail: { ...first.streamingTail, text: "a".repeat(1_020) },
  };
  const encoder = createSnapshotDeltaEncoder();
  const decoder = createSnapshotDeltaDecoder();
  assert.equal(decoder.decode(encoder.encode(first)).ok, true);
  const wire = encoder.encode(next);
  const decoded = decoder.decode(wire);

  assert.equal(decoded.ok, true);
  assert.deepEqual(decoded.snapshot, next);
  assert.ok(JSON.stringify(wire).length < JSON.stringify(next).length / 100);
});

test("desktop-driven push lanes reach only the browsers that opened them", () => {
  // Terminal output, diagnostics and folder events are produced by desktop
  // activity — a build, a save — so a phone that never opened those surfaces
  // used to receive an entire build log.
  assert.equal(clientReadsLane(new Set(), "terminal"), false);
  assert.equal(clientReadsLane(new Set(["editor"]), "terminal"), false);
  assert.equal(clientReadsLane(new Set(["terminal"]), "terminal"), true);
  assert.equal(clientReadsLane(new Set(["editor", "files"]), "files"), true);
  // A browser that predates the lane protocol keeps receiving everything.
  assert.equal(clientReadsLane(null, "terminal"), true);
  assert.equal(clientReadsLane(null, "files"), true);
});

test("compact frames omit unchanged sections and stay lossless", () => {
  const TAIL_EPOCH = Symbol.for("mixdog.streaming-tail-text-epoch");
  const items = Array.from({ length: 30 }, (unused, id) => ({
    id,
    kind: "assistant",
    text: "settled turn ".repeat(8),
  }));
  const build = (text, tokens) => {
    const snapshot = {
      sessionId: "session",
      items,
      status: "running",
      tokens,
      streamingTail: { id: "tail", kind: "assistant", text },
    };
    Object.defineProperty(snapshot, TAIL_EPOCH, {
      value: 3,
      enumerable: false,
      configurable: true,
    });
    return snapshot;
  };
  // The compact shape is announced by the transport envelope, so a receiver
  // marks the payload before decoding it — exactly what remote-shim does.
  const received = (wire, compact) => {
    if (compact && wire && typeof wire === "object" && !Object.hasOwn(wire, "__itemsRevision")) {
      markCompactWire(wire);
    }
    return wire;
  };
  const stream = (encoder, decoder, compact = false) => {
    assert.equal(decoder.decode(received(encoder.encode(build("", 10)), compact)).ok, true);
    let steadyBytes = 0;
    let snapshot;
    for (let step = 1; step <= 5; step += 1) {
      const wire = encoder.encode(build("token ".repeat(step * 4), 10));
      steadyBytes = JSON.stringify(wire).length;
      const decoded = decoder.decode(received(wire, compact));
      assert.equal(decoded.ok, true);
      snapshot = decoded.snapshot;
    }
    return { steadyBytes, snapshot };
  };

  const compactEncoder = createSnapshotDeltaEncoder({ compact: true });
  const compactDecoder = createSnapshotDeltaDecoder();
  const compact = stream(compactEncoder, compactDecoder, true);
  // Nothing is lost by leaving the unchanged parts out of the frame.
  assert.equal(compact.snapshot.streamingTail.text, "token ".repeat(20));
  assert.equal(compact.snapshot.items.length, 30);
  assert.equal(compact.snapshot.status, "running");
  assert.equal(compact.snapshot.tokens, 10);

  const legacy = stream(createSnapshotDeltaEncoder(), createSnapshotDeltaDecoder());
  assert.deepEqual(compact.snapshot, legacy.snapshot);
  assert.ok(
    compact.steadyBytes * 2 < legacy.steadyBytes,
    `expected a much smaller live frame, got ${compact.steadyBytes} vs ${legacy.steadyBytes}`,
  );

  // A state field that DOES change still travels, and the stream continues.
  const changed = compactDecoder.decode(
    received(compactEncoder.encode(build("token ".repeat(20), 42)), true),
  );
  assert.equal(changed.ok, true);
  assert.equal(changed.snapshot.tokens, 42);
});

test("a newly visible relay client receives a full transcript baseline", () => {
  const first = {
    sessionId: "session",
    items: [{ id: "prompt", kind: "user", text: "hello" }],
  };
  const next = {
    ...first,
    items: [...first.items, { id: "answer", kind: "assistant", text: "done" }],
  };
  const firstClient = new Map();
  const lateClient = new Map();
  const firstDecoder = createSnapshotDeltaDecoder();
  const lateDecoder = createSnapshotDeltaDecoder();

  assert.equal(firstDecoder.decode(
    encodeRelayClientSessionState(firstClient, "session", first),
  ).ok, true);
  assert.equal(firstDecoder.decode(
    encodeRelayClientSessionState(firstClient, "session", next),
  ).ok, true);
  const lateResult = lateDecoder.decode(
    encodeRelayClientSessionState(lateClient, "session", next),
  );

  assert.equal(lateResult.ok, true);
  assert.deepEqual(lateResult.snapshot, next);
});

test("latest-state mailbox keeps current data while an RTT-bound send is in flight", () => {
  const sent = [];
  const mailbox = createLatestStateMailbox((sequence, value) => {
    sent.push({ sequence, value });
  });

  mailbox.publish("first");
  mailbox.publish("superseded");
  mailbox.publish("latest");
  assert.deepEqual(sent, [{ sequence: 1, value: "first" }]);

  mailbox.acknowledge(1);
  assert.deepEqual(sent, [
    { sequence: 1, value: "first" },
    { sequence: 2, value: "latest" },
  ]);
});

test("different browsers retain independent transcript lane baselines", () => {
  const browserA = new Map();
  const browserB = new Map();
  const decoderA = createSnapshotDeltaDecoder();
  const decoderB = createSnapshotDeltaDecoder();
  const sessionA = {
    sessionId: "session-a",
    items: [{ id: "a1", kind: "assistant", text: "alpha" }],
    streamingTail: null,
  };
  const sessionB = {
    sessionId: "session-b",
    items: [{ id: "b1", kind: "assistant", text: "bravo" }],
    streamingTail: null,
  };

  assert.deepEqual(
    decoderA.decode(encodeRelayClientSessionState(browserA, "session-a", sessionA)).snapshot,
    sessionA,
  );
  assert.deepEqual(
    decoderB.decode(encodeRelayClientSessionState(browserB, "session-b", sessionB)).snapshot,
    sessionB,
  );

  const nextA = {
    ...sessionA,
    items: [...sessionA.items, { id: "a2", kind: "assistant", text: "updated" }],
  };
  assert.deepEqual(
    decoderA.decode(encodeRelayClientSessionState(browserA, "session-a", nextA)).snapshot,
    nextA,
  );
  assert.deepEqual(
    decoderB.decode(encodeRelayClientSessionState(browserB, "session-b", sessionB)).snapshot,
    sessionB,
  );
});

test("remote paint probes measure publish-to-paint without clock synchronization", () => {
  let now = 1_000;
  const tracker = createRemotePaintProbeTracker({
    enabled: true,
    intervalMs: 1_000,
    now: () => now,
  });
  const probe = tracker.issue("session");
  assert.ok(probe);
  assert.equal(tracker.issue("session"), null);

  now += 240;
  assert.deepEqual(tracker.acknowledgeFrame({
    method: "remotePerfPaint",
    params: [probe.id, 18.5],
  }), {
    id: probe.id,
    sessionId: "session",
    roundTripMs: 240,
    receiveToPaintMs: 18.5,
  });
});

test("catalog updates send only changed keyed rows", () => {
  const encoder = createKeyedListDeltaEncoder((item) => item.id);
  const decoder = createKeyedListDeltaDecoder();
  const first = [
    { id: "a", title: "A" },
    { id: "b", title: "B" },
  ];
  assert.deepEqual(decoder.decode(encoder.encode(first)).items, first);
  const next = [
    first[0],
    { id: "b", title: "B2" },
  ];
  const wire = encoder.encode(next);
  assert.equal(wire.__listPatch.upsert.length, 1);
  assert.deepEqual(decoder.decode(wire).items, next);
});

test("a changed row sends only its changed fields", () => {
  const encoder = createKeyedListDeltaEncoder((item) => item.id);
  const decoder = createKeyedListDeltaDecoder();
  const first = [{
    id: "a",
    preview: "x".repeat(400),
    title: "Session A",
    cwd: "C:/some/long/project/path",
    working: false,
  }];
  assert.deepEqual(decoder.decode(encoder.encode(first)).items, first);

  // A working heartbeat flips. The 400-byte preview must not ride along.
  const next = [{ ...first[0], working: true }];
  const wire = encoder.encode(next);
  const entry = wire.__listPatch.upsert[0];
  assert.equal(entry.length, 3);
  assert.deepEqual(entry[1], { working: true });
  assert.ok(JSON.stringify(wire).length < 200);
  assert.deepEqual(decoder.decode(wire).items, next);
});

test("a field patch carries keys the row no longer has", () => {
  const encoder = createKeyedListDeltaEncoder((item) => item.id);
  const decoder = createKeyedListDeltaDecoder();
  const first = [{ id: "a", title: "A", working: true }];
  assert.deepEqual(decoder.decode(encoder.encode(first)).items, first);

  const next = [{ id: "a", title: "A" }];
  const decoded = decoder.decode(encoder.encode(next));
  assert.equal(decoded.ok, true);
  assert.deepEqual(decoded.items, next);
});

test("a field patch without its base row breaks the chain instead of guessing", () => {
  const encoder = createKeyedListDeltaEncoder((item) => item.id);
  const decoder = createKeyedListDeltaDecoder();
  const first = [{ id: "a", title: "A", working: false }];
  decoder.decode(encoder.encode(first));
  const wire = encoder.encode([{ ...first[0], working: true }]);

  // A receiver that missed the base row must resync, never merge onto nothing.
  const fresh = createKeyedListDeltaDecoder();
  assert.equal(fresh.decode(wire).ok, false);
});

test("state fields rebuilt with equal values do not travel again", () => {
  const encoder = createSnapshotDeltaEncoder();
  const decoder = createSnapshotDeltaDecoder();
  const items = [{ id: 1, kind: "user", text: "hi" }];
  const workers = () => [{ id: "w1", status: "running", model: "x".repeat(200) }];
  const first = { items, agentWorkers: workers(), busy: true };
  assert.equal(decoder.decode(encoder.encode(first)).ok, true);

  // The publisher rebuilds its snapshot every frame: equal values, new objects.
  const wire = encoder.encode({ items, agentWorkers: workers(), busy: true });
  assert.deepEqual(wire.__statePatch.changed, {});
  const decoded = decoder.decode(wire);
  assert.equal(decoded.ok, true);
  assert.deepEqual(decoded.snapshot.agentWorkers, first.agentWorkers);

  // A real change still travels.
  const moved = encoder.encode({
    items,
    agentWorkers: [{ id: "w1", status: "done", model: "x".repeat(200) }],
    busy: true,
  });
  assert.ok(moved.__statePatch.changed.agentWorkers);
  assert.equal(decoder.decode(moved).snapshot.agentWorkers[0].status, "done");
});
