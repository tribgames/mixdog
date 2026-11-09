// The phone's connection lifecycle through the protocol client, replayed against what the Node relay web app (b6f10295a) did in the same
// scenarios (apps/mobile/fixtures/phone-lifecycle, recorded by benchmarks/rust-core/recorders/record-phone-lifecycle.mjs).
// Each scenario runs in its own process (remote-shim-lifecycle.scenario.mjs), the same script the recorder played.
//
// Every checkpoint of every scenario is compared whole and exactly: the connection indicator's full state sequence, the outage
// transitions, every socket opened, pinged or closed (with its code, reason and virtual time), the resync requests, what the core
// knows of the phone, how a pending call ended, the pairing reset message and the reconnected signal. Nothing is filtered or collapsed.
//
// One visible protocol difference is declared, not hidden (see PHONE_REQUESTS): on an MXT session the PC acknowledges nothing itself, the phone
// acks the records the PC sent, so the phone's ACKs follow how many records the PC sent, which follows how many requests the phone made. Where
// the two dialects made the same requests the ACKs are compared exactly; where they did not, every ACK of both is checked against the
// transport's one rule (see ackViolations) and the request lists are compared against the declared difference.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const golden = JSON.parse(readFileSync(new URL('../../../mobile/fixtures/phone-lifecycle/golden.json', import.meta.url), 'utf8')).scenarios;
const runner = fileURLToPath(new URL('./remote-shim-lifecycle.scenario.mjs', import.meta.url));

const runScenario = (name) => {
  const child = spawnSync(process.execPath, [...process.execArgv, runner, name], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const at = child.stdout.lastIndexOf('@@TRACE@@');
  assert.ok(child.status === 0 && at >= 0, `scenario ${name} failed (${child.status}):\n${child.stdout.slice(-1500)}\n${child.stderr.slice(-3000)}`);
  return JSON.parse(child.stdout.slice(at + '@@TRACE@@'.length));
};

/**
 * The phone's requests on an MXT session in this build (a test adapter that issues no boot reads): `initialize`, then the app feed, and the
 * app feed again for each resync. Node's phone asked, per connection, for the boot reads (remote-shim-calls.ts:30-45 at b6f10295a:
 * readSettings, readHostDisplayPreferences, readActivityRailPins, viewerDevice, getSnapshot, listProjects), `synchronizeViews`, and
 * `setRemoteLanes` (remote-shim-sync.ts:91-95 `publishLanes`, also on every resync) -- the recording holds the list. In this build the group
 * adapters (PH-2) own the boot reads, the app feed replaces the view sync, and lanes are `feed/subscribe` only for a lane in use
 * (apps/mobile/src/phone-lanes.ts).
 */
const PHONE_REQUESTS = {
  'mxt-negotiated': {
    connected: ['initialize', 'app/subscribe'],
    'reports-over-records': ['initialize', 'app/subscribe'],
    'quiet-visible': ['initialize', 'app/subscribe'],
    hidden: ['initialize', 'app/subscribe'],
    woken: ['initialize', 'app/subscribe', 'app/subscribe'],
  },
  'mxt-background': {
    connected: ['initialize', 'app/subscribe'],
    suspended: ['initialize', 'app/subscribe'],
    back: ['initialize', 'app/subscribe'],
  },
  'mxt-stripped-offer': { refused: [] },
};

const parseAck = (entry) => {
  const m = /^x:ack\(through=(\d+),sent=(\d+)\)@(\d+)$/u.exec(entry);
  return m ? { through: Number(m[1]), sent: Number(m[2]), at: Number(m[3]) } : null;
};

/** The transport's ACK rule (remote-transport-peer.ts:570 `ack`, :916, :938; MAX_ACK_DELAY 25 ms): an ack never passes what was sent, advances, and
 *  after the last one at most one record is left unacked -- that one is acked 25 ms after it arrived, and not at all while the page is hidden. */
function ackViolations(trace) {
  const bad = [];
  let through = 0;
  for (const c of trace) {
    if (c.wire.some((e) => e.startsWith('socket'))) through = 0;
    for (const ack of c.wire.map(parseAck).filter(Boolean)) {
      if (ack.through > ack.sent) bad.push(`${c.name}: ack ${ack.through} passes the ${ack.sent} records sent`);
      if (ack.through <= through) bad.push(`${c.name}: ack ${ack.through} does not advance past ${through}`);
      if (ack.at > 0 && ack.at !== 25) bad.push(`${c.name}: a delayed ack at +${ack.at} ms, not 25`);
      if (ack.at > 0 && ack.through !== ack.sent) bad.push(`${c.name}: a delayed ack at +${ack.at} ms leaves records unacked`);
      through = ack.through;
    }
    if (c.pcRecords - through > 1) bad.push(`${c.name}: ${c.pcRecords - through} records left unacked`);
    // Hidden: the delayed ack stops with the timers, so the odd record stays unacked.
    if (c.name === 'hidden' && c.pcRecords - through !== 1) bad.push(`${c.name}: the hidden page should hold one record unacked, holds ${c.pcRecords - through}`);
  }
  return bad;
}

const withoutAcks = (c) => ({ ...c, wire: c.wire.filter((e) => !parseAck(e)), pcRecords: undefined, pcRequests: undefined });

for (const name of Object.keys(golden)) {
  test(`phone lifecycle replays the Node recording: ${name}`, () => {
    const got = runScenario(name);
    const want = golden[name];
    assert.deepEqual(
      got.map((c) => c.name),
      want.map((c) => c.name)
    );
    want.forEach((expected, i) => {
      const actual = got[i];
      if (!PHONE_REQUESTS[name]) return assert.deepEqual(actual, expected, `${name} / ${expected.name}`);
      // Same requests, same records: the ACKs are compared exactly with everything else.
      if (JSON.stringify(actual.pcRequests) === JSON.stringify(expected.pcRequests)) return assert.deepEqual(actual, expected, `${name} / ${expected.name}`);
      assert.deepEqual(withoutAcks(actual), withoutAcks(expected), `${name} / ${expected.name}`);
      assert.deepEqual(actual.pcRequests, PHONE_REQUESTS[name][expected.name], `${name} / ${expected.name}: the phone's requests`);
    });
    if (PHONE_REQUESTS[name]) {
      assert.deepEqual(ackViolations(want), [], `${name}: Node's ACKs follow the rule`);
      assert.deepEqual(ackViolations(got), [], `${name}: the phone's ACKs follow the rule`);
    }
  });
}