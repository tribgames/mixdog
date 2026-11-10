// The phone's connection lifecycle through the protocol client, replayed against what the Node relay web app (b6f10295a) did in the same
// scenarios (apps/mobile/fixtures/phone-lifecycle, recorded by benchmarks/rust-core/recorders/record-phone-lifecycle.mjs).
// Each scenario runs in its own process (remote-shim-lifecycle.scenario.mjs), the same script the recorder played.
//
// Every checkpoint of every scenario is compared whole and exactly: the connection indicator's full state sequence, the outage
// transitions, every socket opened, pinged or closed (with its code, reason and virtual time), the resync requests, what the core
// knows of the phone, how a pending call ended, the pairing reset message and the reconnected signal; for the boot-read scenarios also every
// request and consumer settlement, in one log in the order they happened. Nothing is filtered or collapsed but the one named Node-only request below.
//
// The MXT transport's ACKs are not part of a lifecycle trace (how many records the PC sends differs with the protocol's requests, and the ACK
// count follows it): they are pinned by the transport oracle below, which gives both products one scripted record stream and compares the
// whole ordered control trace -- ACK through/ranges, carrier, virtual time.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const fixtures = new URL('../../../mobile/fixtures/phone-lifecycle/', import.meta.url);
const golden = JSON.parse(readFileSync(new URL('golden.json', fixtures), 'utf8')).scenarios;
const transport = JSON.parse(readFileSync(new URL('transport.json', fixtures), 'utf8')).scenarios;
const lanePushes = JSON.parse(readFileSync(new URL('lane-pushes.json', fixtures), 'utf8'));
const runner = fileURLToPath(new URL('./remote-shim-lifecycle.scenario.mjs', import.meta.url));
const oracle = fileURLToPath(new URL('./remote-shim-transport-oracle.scenario.mjs', import.meta.url));

const run = (script, name) => {
  const child = spawnSync(process.execPath, [...process.execArgv, script, name], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const at = child.stdout.lastIndexOf('@@TRACE@@');
  assert.ok(child.status === 0 && at >= 0, `scenario ${name} failed (${child.status}):
${child.stdout.slice(-1500)}
${child.stderr.slice(-3000)}`);
  return JSON.parse(child.stdout.slice(at + '@@TRACE@@'.length));
};

// The push lanes: what a phone receives after it connects, until it opens a lane. Node's phone sends an empty `setRemoteLanes` on connect
// (a fresh relay client has `lanes: null`, which reads every lane; the empty set reads none); the phone sends nothing, because the core's lanes
// are feeds a connection receives only after it opens them. Recorded: Node by the real push-lane module and setRemoteLanes handler, the core by the
// in-process server rig (native/core/crates/mixdog-app-server/src/tests/lane_pushes.rs). The two are compared phase by phase.
test('lane pushes: a phone that has not opened a lane hears the same at the core as at Node after its empty registration', () => {
  const node = Object.fromEntries(lanePushes.node.phases.map((p) => [p.phase, p]));
  const core = (phase, feed) => lanePushes.core.find((s) => s.phase === phase && s.feed === feed).frames;
  const laneEvents = (p) => ['terminal output', 'folder change', 'language diagnostics', 'visualize state'].flatMap((k) => p.heard[k]);
  // Node, registered empty: no lane push, the global push (activity rail pins) arrives. Core, app feed only: no lane frame, the app frame arrives.
  assert.deepEqual(laneEvents(node['registered-empty']), []);
  assert.deepEqual(node['registered-empty'].heard['activity rail pins'], ['activity-rail-pins-changed']);
  assert.deepEqual(core('pushes-with-app-feed-only', 'lane'), []);
  assert.deepEqual(core('pushes-with-app-feed-only', 'app'), ['evt@2']);
  // Opening the terminal lane (Node: registering it; core: feed/subscribe) brings that lane's pushes and no other lane's.
  assert.deepEqual(laneEvents(node['lane-terminal-registered']), ['termData']);
  assert.deepEqual(core('lane-feed-opened', 'lane'), ['response', 'snapshot@2']);
  assert.deepEqual(core('pushes-with-lane-feed', 'lane'), ['evt@3']);
  // Dropping the lane returns Node to the empty state; closing the feed (feed/unsubscribe) does the same at the core, and the app feed goes on.
  assert.deepEqual(laneEvents(node['lane-terminal-dropped']), []);
  assert.deepEqual(core('lane-feed-closed', 'lane'), ['response']);
  assert.deepEqual(core('pushes-after-lane-feed-closed', 'lane'), []);
  assert.deepEqual(core('pushes-after-lane-feed-closed', 'app'), ['evt@4']);
});

// The difference the empty registration leaves: Node's client is read as "everything" from its join until the phone's registration is handled
// (every lane push passes), the core's connection hears nothing until it opens a feed. The page has no lane listener in that window (it registers
// a lane when it first uses it), so nothing it could show is lost; pinned here so the difference stays named.
// Accepted by the user (decisions.md, rust-core scratch, recorded by the Lead): Node sends the empty `setRemoteLanes` immediately at connect, so the
// window is a race inside Node, not behavior anyone relies on.
test('lane pushes: Node passes every lane before the phone registers, the core delivers nothing before a feed is opened', () => {
  const before = lanePushes.node.phases.find((p) => p.phase === 'connected-before-registration');
  assert.deepEqual(before.heard['terminal output'], ['termData']);
  assert.deepEqual(before.heard['folder change'], ['folderChanged']);
  assert.deepEqual(before.heard['language diagnostics'], ['lspDiagnostics']);
  assert.deepEqual(before.heard['visualize state'], ['visualizeChanged']);
  for (const feed of ['app', 'lane']) {
    assert.deepEqual(lanePushes.core.find((s) => s.phase === 'pushes-before-any-feed' && s.feed === feed).frames, []);
  }
});

// The one request Node makes and the phone does not: Node publishes its lane set (`setRemoteLanes`) on every connect, an empty set too; the
// phone's lanes are protocol feeds opened only while a lane is in use (apps/mobile/src/phone-lanes.ts). What the empty set changed at Node is
// recorded and compared in the two lane-push tests below (lane-pushes.json): a connection with no feed hears what Node's empty set hears. A request sent only to match
// Node's count would be a dummy. Only the empty publish is removed from the recording; a non-empty one would still have to match.
const NODE_ONLY_REQUEST = /^request:setRemoteLanes\(empty\)@/u;
const withoutNodeOnly = (checkpoint) => (checkpoint.log ? { ...checkpoint, log: checkpoint.log.filter((entry) => !NODE_ONLY_REQUEST.test(entry)) } : checkpoint);

for (const name of Object.keys(golden)) {
  test(`phone lifecycle replays the Node recording: ${name}`, () => {
    const got = run(runner, name);
    const want = golden[name];
    assert.deepEqual(
      got.map((c) => c.name),
      want.map((c) => c.name)
    );
    want.map(withoutNodeOnly).forEach((expected, i) => {
      assert.deepEqual(got[i], expected, `${name} / ${expected.name}`);
    });
  });
}

// The transport oracle: the whole ordered, decoded control trace of a scripted session must equal Node's -- every ACK (through, ranges), its
// presence, its virtual time and its carrier, the pings and pongs, the records and what the page received.
for (const name of Object.keys(transport)) {
  test(`the MXT transport answers the scripted record stream as Node's did: ${name}`, () => {
    assert.deepEqual(run(oracle, name), transport[name]);
  });
}