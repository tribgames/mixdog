import assert from "node:assert/strict";
import test from "node:test";
import { createRemoteSessionInbox } from "./remote-session-inbox.ts";

const frame = (sessionId, text) => ({
  sessionId,
  snapshot: { sessionId, items: [{ id: `${sessionId}-user`, kind: "user", text }] },
  frameSource: "live",
});

test("startup frames reach a late mounted store without another host publication", () => {
  const inbox = createRemoteSessionInbox({ onGap: () => assert.fail("no lost frames") });
  inbox.publish(frame("a", "sent from phone"));
  inbox.publish(frame("a", "latest prompt"));
  inbox.publish(frame("b", "another session"));
  const received = [];
  const unsubscribe = inbox.subscribe((update) => received.push(update));
  assert.deepEqual(received, [frame("a", "latest prompt"), frame("b", "another session")]);
  inbox.publish(frame("a", "live update"));
  assert.deepEqual(received.at(-1), frame("a", "live update"));
  unsubscribe();
  inbox.publish(frame("b", "while switching"));
  const reopened = [];
  inbox.subscribe((update) => reopened.push(update));
  assert.deepEqual(reopened, [frame("b", "while switching")]);
});

test("a new connection discards undelivered old frames without clearing mounted stores", () => {
  const inbox = createRemoteSessionInbox({ onGap: () => assert.fail("no lost frames") });
  inbox.publish(frame("a", "old connection"));
  inbox.reset();
  const received = [];
  inbox.subscribe((update) => received.push(update));
  assert.deepEqual(received, []);
  inbox.publish(frame("a", "restored connection"));
  inbox.reset();
  assert.deepEqual(received, [frame("a", "restored connection")]);
});

test("a bounded startup inbox requests recovery only when its consumer can receive it", () => {
  let recovery = 0;
  const inbox = createRemoteSessionInbox({ maxEntries: 2, onGap: () => { recovery += 1; } });
  for (const id of ["a", "b", "c"]) inbox.publish(frame(id, id));
  assert.equal(recovery, 0);
  const received = [];
  inbox.subscribe((update) => received.push(update.sessionId));
  assert.deepEqual(received, ["b", "c"]);
  assert.equal(recovery, 1);
  inbox.subscribe(() => {});
  assert.equal(recovery, 1);
});
