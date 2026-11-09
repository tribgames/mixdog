// The phone's connection lifecycle through the protocol client, replayed against what the Node relay web app (b6f10295a) did in the same
// scenarios (apps/mobile/fixtures/phone-lifecycle, recorded by benchmarks/rust-core/recorders/record-phone-lifecycle.mjs).
// Each scenario runs in its own process (remote-shim-lifecycle.scenario.mjs), the same script the recorder played.
//
// Every checkpoint of every scenario is compared whole and exactly: the connection indicator's full state sequence, the outage
// transitions, every socket opened, pinged or closed (with its code, reason and virtual time), the resync requests, what the core
// knows of the phone, how a pending call ended, the pairing reset message and the reconnected signal; for the boot-read scenarios also every
// traced request with its virtual time and every consumer settlement. Nothing is filtered or collapsed.
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

for (const name of Object.keys(golden)) {
  test(`phone lifecycle replays the Node recording: ${name}`, () => {
    const got = run(runner, name);
    const want = golden[name];
    assert.deepEqual(
      got.map((c) => c.name),
      want.map((c) => c.name)
    );
    want.forEach((expected, i) => {
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