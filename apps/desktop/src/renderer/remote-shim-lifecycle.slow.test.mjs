// The phone's connection lifecycle through the protocol client, replayed against what the Node relay web app (b6f10295a) did in the same
// scenarios (apps/mobile/fixtures/phone-lifecycle, recorded by benchmarks/rust-core/recorders/record-phone-lifecycle.mjs).
// Each scenario runs in its own process (remote-shim-lifecycle.scenario.mjs), the same script the recorder played.
//
// Compared exactly: what the core knows of the phone (foreground, screen, panels, view, lanes), how a pending call ends, the pairing
// reset message, whether the PC was seen offline, the reconnected signal, and every ping and close the page puts on the wire with its
// virtual time. The connection banner is compared as what the user sees: raised or not, and cleared at the end or not.
//
// Differences from Node that are decided, not accidents (decisions.md):
//  - a redial after a close waits the library's ladder (250 ms, doubling, jittered), where Node redialed at once: socket times are exact
//    only for the first dial and for the spread of a relay-side close (a pure function of the random draw), and the offline backoff is
//    compared by its cap and by the gaps once capped;
//  - the "syncing" indicator state is not raised on a plain view change.
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

const wireOf = (entries) =>
  entries.map((entry) => {
    const [what, at] = entry.split('@');
    return { what, at: Number(at) };
  });
const nonSocket = (entries) => wireOf(entries).filter((entry) => !entry.what.startsWith('socket'));
const sockets = (entries) => wireOf(entries).filter((entry) => entry.what.startsWith('socket')).map((entry) => entry.at);
const bannerOf = (banner) => ({ raised: banner.includes(true), clearedAtEnd: banner.includes(true) ? banner.at(-1) === false : null });
const gaps = (times) => times.slice(1).map((at, i) => at - times[i]);

/** Scenarios whose socket times are the point, and how each is held. */
const SOCKET_TIMES = {
  // A relay-side close of a live leg: the redial is spread by the random draw, and the draw is the only input.
  'live-leg-closed': 'exact',
  // The PC offline: the backoff reaches the same cap, and once capped the gaps are Node's.
  'pc-offline': 'capped',
};

for (const name of Object.keys(golden)) {
  test(`phone lifecycle replays the Node recording: ${name}`, () => {
    const want = golden[name];
    const got = runScenario(name);
    assert.deepEqual(
      got.map((c) => c.name),
      want.map((c) => c.name)
    );
    want.forEach((expected, i) => {
      const actual = got[i];
      const at = `${name} / ${expected.name}`;
      assert.deepEqual(actual.core, expected.core, `${at}: what the core knows of the phone`);
      assert.deepEqual(actual.calls, expected.calls, `${at}: how pending calls ended`);
      assert.deepEqual(actual.pairingInvalid, expected.pairingInvalid, `${at}: pairing reset message`);
      assert.equal(actual.offline, expected.offline, `${at}: PC seen offline`);
      assert.equal(actual.reconnected, expected.reconnected, `${at}: reconnected signal`);
      assert.deepEqual(bannerOf(actual.banner), bannerOf(expected.banner), `${at}: connection banner`);
      assert.deepEqual(nonSocket(actual.wire), nonSocket(expected.wire), `${at}: pings and closes`);
      const mine = sockets(actual.wire);
      const node = sockets(expected.wire);
      if (expected.name === 'connected') assert.deepEqual(mine, node, `${at}: first dial`);
      else if (SOCKET_TIMES[name] === 'exact') assert.deepEqual(mine, node, `${at}: redial spread`);
      else if (SOCKET_TIMES[name] === 'capped') {
        assert.equal(actual.maxRedialDelayMs, expected.maxRedialDelayMs, `${at}: backoff cap`);
        assert.equal(mine.length, node.length, `${at}: redial count`);
        assert.deepEqual(gaps(mine).slice(-6), gaps(node).slice(-6), `${at}: gaps once capped`);
      }
    });
  });
}
