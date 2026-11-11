// What each paired phone receives on the terminal lane, against a real mixdogd (MIXDOGD_BIN, built with
// `--features "terminal-lease-clock replay-controls"`), compared whole with Node (b6f10295a): apps/mobile/fixtures/terminal-lane-reach/golden.json,
// recorded by benchmarks/rust-core/recorders/record-terminal-lane-reach.mjs. Per phone, every termData (exact text, envelope `droppable`),
// termActivity and termSizeOwner in order: tabs the desktop or a phone opens, a phone leaving and coming back, a phone joining mid-output,
// a tab whose shell ends and one disposed while it runs, and an unpaired phone whose socket is still open.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { replayLaneReach } from '../../../../benchmarks/rust-core/recorders/lib/terminal-lane-reach-replay.mjs';

const golden = JSON.parse(readFileSync(new URL('../../../mobile/fixtures/terminal-lane-reach/golden.json', import.meta.url), 'utf8'));

test('terminal output reaches the phones Node sent it to', { timeout: 300_000 }, async () => {
  assert.ok(process.env.MIXDOGD_BIN, 'MIXDOGD_BIN must name a built mixdogd');
  const differences = await replayLaneReach({ exe: process.env.MIXDOGD_BIN, golden });
  assert.deepEqual(differences, []);
});
