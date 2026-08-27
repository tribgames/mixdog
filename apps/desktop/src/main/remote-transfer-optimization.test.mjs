import assert from "node:assert/strict";
import test from "node:test";

import { createLatestStateMailbox } from "./desktop-service-protocol.ts";
import {
  createSnapshotDeltaDecoder,
  createSnapshotDeltaEncoder,
  isNoDelta,
  markCompactWire,
  reconcileSessionProjection,
} from "./state-delta.ts";
import {
  clientReadsLane,
  encodeRelayClientSessionState,
  remoteTranscriptSnapshot,
} from "./remote-relay.ts";
import {
  createRemotePaintProbeTracker,
  remoteFrameLane,
} from "../shared/remote-performance.ts";
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
  // B's baseline is untouched by A's frame: nothing moved for B, so B is sent
  // nothing — and its own next change still decodes onto the right baseline.
  assert.equal(
    isNoDelta(encodeRelayClientSessionState(browserB, "session-b", sessionB)),
    true,
  );
  const nextB = {
    ...sessionB,
    items: [...sessionB.items, { id: "b2", kind: "assistant", text: "second" }],
  };
  assert.deepEqual(
    decoderB.decode(encodeRelayClientSessionState(browserB, "session-b", nextB)).snapshot,
    nextB,
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
  // Nothing moved, so the frame never leaves.
  assert.equal(
    isNoDelta(encoder.encode({ items, agentWorkers: workers(), busy: true })),
    true,
  );

  // A real change still travels.
  const moved = encoder.encode({
    items,
    agentWorkers: [{ id: "w1", status: "done", model: "x".repeat(200) }],
    busy: true,
  });
  assert.ok(moved.__statePatch.changed.agentWorkers);
  assert.equal(decoder.decode(moved).snapshot.agentWorkers[0].status, "done");
});

/** A payload is marked compact by the receiving transport, never on the wire. */
function receiveCompact(wire) {
  if (wire && typeof wire === "object" && !Object.hasOwn(wire, "__itemsRevision")) {
    markCompactWire(wire);
  }
  return wire;
}

test("a remote transcript drops provider replay blocks and keeps item identity", () => {
  const plain = { id: "a", role: "user", content: "hi" };
  const heavy = {
    id: "b",
    role: "assistant",
    content: "answer",
    thinkingBlocks: [{ type: "thinking", thinking: "x".repeat(4_000), signature: "sig" }],
    providerReplay: {
      version: 1,
      provider: "anthropic",
      items: [{ type: "thinking", thinking: "x".repeat(4_000), signature: "sig" }],
    },
  };
  const snapshot = { sessionId: "s", items: [plain, heavy], status: "idle" };
  const projected = remoteTranscriptSnapshot(snapshot);

  assert.notEqual(projected, snapshot);
  assert.equal(projected.items[0], plain, "an untouched item is passed through by reference");
  assert.equal(Object.hasOwn(projected.items[1], "thinkingBlocks"), false);
  assert.equal(Object.hasOwn(projected.items[1], "providerReplay"), false);
  assert.equal(projected.items[1].content, "answer");
  assert.ok(
    JSON.stringify(projected).length * 4 < JSON.stringify(snapshot).length,
    "the replay blocks dominated the payload",
  );

  // A second publication of the SAME items must project to the same objects,
  // or the delta encoder would treat every frame as a full rewrite.
  const again = remoteTranscriptSnapshot({ ...snapshot });
  assert.equal(again.items[1], projected.items[1]);
});

test("a remote client receives the transcript's tail, not its whole history", () => {
  const items = Array.from({ length: 400 }, (unused, index) => ({
    id: `i${index}`,
    content: `turn ${index}`,
  }));
  const encoders = new Map();
  const floors = new Map();
  const first = encodeRelayClientSessionState(
    encoders, "s", { sessionId: "s", items }, true, floors,
  );
  const decoder = createSnapshotDeltaDecoder();
  const opened = decoder.decode(receiveCompact(first));

  assert.equal(opened.ok, true);
  assert.equal(opened.snapshot.items.length, 60);
  assert.equal(opened.snapshot.items[59].id, "i399", "the window ends at the newest turn");
  assert.equal(opened.snapshot.transcriptWindowStart, 340);

  // An appended turn must cost ONE item, not a rewritten window: the floor
  // stays put, so the receiver's array simply grows.
  const grown = [...items, { id: "i400", content: "turn 400" }];
  const next = encodeRelayClientSessionState(
    encoders, "s", { sessionId: "s", items: grown }, true, floors,
  );
  assert.ok(JSON.stringify(next).length < 200, JSON.stringify(next).slice(0, 300));
  const appended = decoder.decode(receiveCompact(next));
  assert.equal(appended.ok, true);
  assert.equal(appended.snapshot.items.length, 61);
  assert.equal(appended.snapshot.items[60].id, "i400");
});

test("a transcript shorter than the window is sent whole", () => {
  const items = Array.from({ length: 12 }, (unused, index) => ({ id: `i${index}` }));
  const floors = new Map();
  const wire = encodeRelayClientSessionState(
    new Map(), "s", { sessionId: "s", items }, true, floors,
  );
  assert.equal(wire.items.length, 12);
  assert.equal(Object.hasOwn(wire, "transcriptWindowStart"), false);
});

test("a remote transcript with nothing to drop is returned unchanged", () => {
  const snapshot = { sessionId: "s", items: [{ id: "a", content: "hi" }], status: "idle" };
  assert.equal(remoteTranscriptSnapshot(snapshot), snapshot);
});

test("dropped replay blocks cost a remote client nothing on later frames", () => {
  const items = Array.from({ length: 40 }, (unused, index) => ({
    id: `i${index}`,
    role: index % 2 ? "assistant" : "user",
    content: `turn ${index}`,
    thinkingBlocks: [{ type: "thinking", thinking: "y".repeat(2_000) }],
  }));
  const encoders = new Map();
  const first = encodeRelayClientSessionState(encoders, "s", { sessionId: "s", items }, true);
  assert.ok(!JSON.stringify(first).includes("thinkingBlocks"));
  // Same items, same objects: the second publication is not a frame at all.
  const second = encodeRelayClientSessionState(encoders, "s", { sessionId: "s", items }, true);
  assert.equal(isNoDelta(second), true);
});

test("a cold view re-read from disk does not re-send the transcript", () => {
  const items = Array.from({ length: 120 }, (unused, id) => ({
    id,
    kind: id % 2 ? "assistant" : "user",
    text: "settled turn ".repeat(60),
  }));
  const stored = { sessionId: "cold", items, status: "idle", queued: [] };
  const encoder = createSnapshotDeltaEncoder({ compact: true });
  const decoder = createSnapshotDeltaDecoder();
  assert.equal(decoder.decode(receiveCompact(encoder.encode(stored))).ok, true);

  // The one second cold-view clock re-reads the store: same content, new graph.
  const reread = JSON.parse(JSON.stringify(stored));
  assert.equal(
    reconcileSessionProjection(stored, reread),
    stored,
    "an unchanged read must collapse onto the retained projection",
  );

  // One settled turn arrives; only that item may travel.
  const grown = JSON.parse(JSON.stringify(stored));
  grown.items.push({ id: 120, kind: "assistant", text: "new answer" });
  const next = reconcileSessionProjection(stored, grown);
  assert.notEqual(next, stored);
  const wire = encoder.encode(next);
  assert.ok(
    JSON.stringify(wire).length < JSON.stringify(grown).length / 50,
    "a one-item change must not carry the whole transcript",
  );
  const decoded = decoder.decode(receiveCompact(wire));
  assert.equal(decoded.ok, true);
  assert.deepEqual(decoded.snapshot.items, grown.items);
  assert.equal(decoded.snapshot.status, "idle");
});

test("a snapshot that did not move produces no frame at all", () => {
  const items = [{ id: 1, kind: "user", text: "hi" }];
  const snapshot = () => ({ sessionId: "quiet", items, status: "idle", tokens: 12 });
  for (const compact of [true, false]) {
    const encoder = createSnapshotDeltaEncoder({ compact });
    const decoder = createSnapshotDeltaDecoder();
    // Only a compact peer marks its payloads; a v1 wire must reach the decoder
    // exactly as it was sent.
    const receive = (wire) => (compact ? receiveCompact(wire) : wire);
    assert.equal(decoder.decode(receive(encoder.encode(snapshot()))).ok, true);

    // The publisher republishes on its own clock: equal values, new objects.
    assert.equal(isNoDelta(encoder.encode(snapshot())), true);
    assert.equal(isNoDelta(encoder.encode(snapshot())), true);

    // Holding the revision keeps the chain intact for the next real change.
    const moved = encoder.encode({ ...snapshot(), status: "running" });
    assert.equal(isNoDelta(moved), false);
    const decoded = decoder.decode(receive(moved));
    assert.equal(decoded.ok, true, `chain survived suppressed frames (compact=${compact})`);
    assert.equal(decoded.snapshot.status, "running");
    assert.deepEqual(decoded.snapshot.items, items);
  }
});

test("an idle transcript frame is named for what it carries", () => {
  assert.equal(remoteFrameLane({ e: "T", s: 1, w: { r: 7 } }), "compact:T:idle");
  assert.equal(remoteFrameLane({ e: "T", s: 1, w: { r: 7, ta: "hello" } }), "compact:T:ta");
  assert.equal(
    remoteFrameLane({ e: "T", s: 1, w: { r: 7, sc: { agentWorkers: [], stats: {} } } }),
    "compact:T:sc(agentWorkers,stats)",
  );
});

test("streamed text appends without the in-process epoch marker", () => {
  const items = [{ id: 1, kind: "user", text: "go" }];
  const opening = "a".repeat(40_000);
  const first = {
    sessionId: "session",
    items,
    streamingTail: { id: "tail", kind: "assistant", text: opening },
  };
  const encoder = createSnapshotDeltaEncoder({ compact: true });
  const decoder = createSnapshotDeltaDecoder();
  assert.equal(decoder.decode(receiveCompact(encoder.encode(first))).ok, true);

  // The snapshot crossed a hop, so it carries no epoch symbol — the frame must
  // still be the appended suffix, not the whole streamed text.
  const next = {
    ...first,
    streamingTail: { ...first.streamingTail, text: `${opening}+more` },
  };
  const wire = encoder.encode(next);
  assert.ok(JSON.stringify(wire).length < 200, "an append must not carry the text");
  const decoded = decoder.decode(receiveCompact(wire));
  assert.equal(decoded.ok, true);
  assert.equal(decoded.snapshot.streamingTail.text, next.streamingTail.text);

  // A replaced tail is not an append and still travels whole.
  const replaced = {
    ...first,
    streamingTail: { ...first.streamingTail, text: "b".repeat(40_000) },
  };
  const replacedWire = encoder.encode(replaced);
  assert.ok(JSON.stringify(replacedWire).length > 40_000);
  assert.equal(
    decoder.decode(receiveCompact(replacedWire)).snapshot.streamingTail.text,
    replaced.streamingTail.text,
  );
});
