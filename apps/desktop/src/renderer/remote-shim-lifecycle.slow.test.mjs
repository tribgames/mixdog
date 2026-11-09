// The phone's connection lifecycle through the protocol client, replayed against what the Node relay web app (b6f10295a) did in the same
// scenarios (apps/mobile/fixtures/phone-lifecycle, recorded by benchmarks/rust-core/recorders/record-phone-lifecycle.mjs).
// Each scenario runs in its own process (remote-shim-lifecycle.scenario.mjs), the same script the recorder played.
//
// Every checkpoint of every scenario is compared whole and exactly: the connection indicator's full state sequence, the outage
// transitions, every socket opened, pinged or closed (with its code, reason and virtual time), the resync requests, what the core
// knows of the phone, how a pending call ended, the pairing reset message and the reconnected signal. Nothing is filtered or collapsed.
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

for (const name of Object.keys(golden)) {
  test(`phone lifecycle replays the Node recording: ${name}`, () => {
    const got = runScenario(name);
    const want = golden[name];
    assert.deepEqual(
      got.map((c) => c.name),
      want.map((c) => c.name)
    );
    want.forEach((expected, i) => assert.deepEqual(got[i], expected, `${name} / ${expected.name}`));
  });
}