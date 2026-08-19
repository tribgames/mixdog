import assert from "node:assert/strict";
import test from "node:test";

import { createLatestStateMailbox } from "./desktop-service-protocol.ts";
import {
  createSnapshotDeltaDecoder,
  createSnapshotDeltaEncoder,
} from "./state-delta.ts";
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

test("latest-state mailbox drops superseded publications before encoding", () => {
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
