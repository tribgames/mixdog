// The phone's connection lifecycle through the protocol client: every scenario of remote-shim-lifecycle-departures.json, each played from
// its own script in its own process (remote-shim-lifecycle.scenario.mjs). Every checkpoint the departures
// file holds is compared whole: the connection indicator's state sequence, every socket opened, pinged or closed with its code, reason and
// virtual time, the resync requests, what the core knows of the phone, how a gated read ended, and the redial delays. The checkpoints that
// only name a moment ("connected", "boot-window-expired") must exist.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const departures = JSON.parse(readFileSync(new URL('./remote-shim-lifecycle-departures.json', import.meta.url), 'utf8'));
const runner = fileURLToPath(new URL('./remote-shim-lifecycle.scenario.mjs', import.meta.url));

const run = (name) => {
  const child = spawnSync(process.execPath, [...process.execArgv, runner, name], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const at = child.stdout.lastIndexOf('@@TRACE@@');
  assert.ok(child.status === 0 && at >= 0, `scenario ${name} failed (${child.status}):\n${child.stdout.slice(-1500)}\n${child.stderr.slice(-3000)}`);
  return JSON.parse(child.stdout.slice(at + '@@TRACE@@'.length));
};

// An entry whose checkpoints are an object keyed by name states only the checkpoints where the phone differs: those must exist and match whole.
for (const [name, departure] of Object.entries(departures).filter(([, entry]) => !Array.isArray(entry.checkpoints))) {
  test(`phone lifecycle departure: ${name}`, () => {
    const got = run(name);
    for (const [checkpointName, want] of Object.entries(departure.checkpoints)) {
      const at = got.find((checkpoint) => checkpoint.name === checkpointName);
      assert.ok(at, `${name} has no checkpoint ${checkpointName}`);
      assert.deepEqual(at, want, `${name} / ${checkpointName}`);
    }
  });
}

for (const [name, departure] of Object.entries(departures).filter(([, entry]) => Array.isArray(entry.checkpoints))) {
  test(`phone lifecycle with a refused restore: ${name}`, () => {
    const got = run(name);
    assert.deepEqual(
      got.map((checkpoint) => checkpoint.name),
      departure.checkpoints.map((checkpoint) => checkpoint.name)
    );
    got.forEach((checkpoint, index) => {
      if (departure.fromRecording.includes(checkpoint.name)) return;
      assert.deepEqual(checkpoint, departure.checkpoints[index], `${name} / ${checkpoint.name}`);
    });
  });
}