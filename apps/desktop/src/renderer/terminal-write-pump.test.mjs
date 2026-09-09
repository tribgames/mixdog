import assert from "node:assert/strict";
import test from "node:test";
import { TerminalWritePump } from "./terminal-write-pump.ts";

function harness(limit = 65536) {
  const writes = [];
  const acknowledgements = [];
  const clock = { time: 0 };
  const pump = new TerminalWritePump(
    (data, complete) => writes.push({ data, complete, at: clock.time }),
    (id, count) => acknowledgements.push([id, count]),
    () => clock.time,
    limit,
  );
  return { pump, writes, acknowledgements, clock };
}

test("ordinary output reaches xterm without waiting for earlier parse callbacks", () => {
  const { pump, writes, acknowledgements, clock } = harness();
  for (const data of ["a", "한", "\x1b[31m", "b"]) pump.push("term", data);
  assert.deepEqual(writes.map((write) => write.data), ["a", "한", "\x1b[31m", "b"]);
  assert.deepEqual(acknowledgements, [], "backpressure acknowledges parsing, not submission");
  assert.equal(pump.hasQueuedOutput, true);
  clock.time = 16;
  for (const write of writes) write.complete();
  assert.equal(pump.hasQueuedOutput, false);
  assert.deepEqual(acknowledgements, [["term", 1], ["term", 1], ["term", 5], ["term", 1]]);
  assert.equal(pump.timingStats.maxQueueMs, 0);
  assert.equal(pump.timingStats.meanCommitMs, 16);
  pump.dispose();
});

test("replay and local predictions remain ordered barriers between live output", async () => {
  const { pump, writes } = harness();
  pump.push("term", "before");
  const replay = pump.writeReplay("restored scrollback");
  pump.push("term", "after");
  assert.deepEqual(writes.map((write) => write.data), ["before"]);
  writes[0].complete();
  assert.deepEqual(writes.map((write) => write.data), ["before", "restored scrollback"]);
  writes[1].complete();
  await replay;
  assert.deepEqual(writes.map((write) => write.data), ["before", "restored scrollback", "after"]);
  writes[2].complete();
  pump.dispose();
});

test("large bursts are bounded, preserve text, and report queue delay separately from parse time", () => {
  const { pump, writes, acknowledgements, clock } = harness(4);
  pump.push("term", "1234");
  clock.time = 2;
  pump.push("term", "가나");
  pump.push("term", "다라");
  assert.equal(writes.length, 1);
  assert.equal(pump.timingStats.inFlightChars, 4);
  clock.time = 12;
  writes[0].complete();
  assert.deepEqual(writes.map((write) => write.data), ["1234", "가나다라"]);
  clock.time = 16;
  writes[1].complete();
  assert.equal(pump.timingStats.maxQueueMs, 10);
  assert.deepEqual(acknowledgements, [["term", 4], ["term", 4]]);
  pump.dispose();
});

test("dispose releases every acknowledgement and replay once, including late callbacks", async () => {
  const { pump, writes, acknowledgements } = harness();
  pump.push("old", "a");
  pump.push("old", "b");
  const replay = pump.writeReplay("reconnect");
  pump.push("new", "c");
  pump.dispose();
  await replay;
  for (const write of writes) { write.complete(); write.complete(); }
  pump.push("new", "ignored");
  assert.deepEqual(acknowledgements, [["old", 1], ["old", 1], ["new", 1]]);
  assert.equal(pump.hasQueuedOutput, false);
  assert.equal(pump.timingStats.inFlightChars, 0);
});

test("synchronous write failure does not strand later output", () => {
  const acknowledged = [];
  const pump = new TerminalWritePump(
    () => { throw new Error("disposed terminal"); },
    (id, count) => acknowledged.push([id, count]),
  );
  pump.push("term", "a");
  pump.push("term", "b");
  assert.deepEqual(acknowledged, [["term", 1], ["term", 1]]);
  assert.equal(pump.hasQueuedOutput, false);
  pump.dispose();
});
