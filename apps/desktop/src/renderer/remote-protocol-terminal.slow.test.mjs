// The phone's terminal and folder-watch adapter against a real mixdogd, compared whole with what Node (b6f10295a) answered and pushed
// for the same script (apps/mobile/fixtures/phone-terminal/golden.json, recorded by benchmarks/rust-core/recorders/record-phone-terminal.mjs).
// The scenario runs in its own process (remote-protocol-terminal.scenario.mjs); the core binary is MIXDOGD_BIN.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { compareTraces, loadRuns } from './remote-protocol-terminal-compare.mjs';

// Refused before the scenario runs unless runs.json is exactly what MANIFEST.json's runList lists.
const runs = loadRuns();
const runner = fileURLToPath(new URL('./remote-protocol-terminal.scenario.mjs', import.meta.url));

test('phone terminal adapter replays the Node recording over a real core', async () => {
  const child = spawnSync(process.execPath, [...process.execArgv, runner], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 600_000 });
  assert.ok(!child.error, `scenario did not finish within 600 s: ${child.error?.message}\n${child.stderr?.slice(-3000)}`);
  const at = child.stdout.lastIndexOf('@@TRACE@@');
  assert.ok(child.status === 0 && at >= 0, `scenario failed (${child.status}):\n${child.stdout.slice(-1500)}\n${child.stderr.slice(-3000)}`);
  const got = JSON.parse(child.stdout.slice(at + '@@TRACE@@'.length));
  if (process.env.PHONE_TERMINAL_KEEP_TRACE) writeFileSync(process.env.PHONE_TERMINAL_KEEP_TRACE, JSON.stringify(got)); // for looking at a difference
  const { exemptions, sets, bytes } = await compareTraces(got, runs);
  // What the pass rests on: every unit left to one of Node's values, every pair compared as one place, and per tab and stretch whether
  // the output's bytes were one Node run's or only its states were.
  console.log(`exemptions (${exemptions.length}):\n  ${exemptions.join('\n  ')}`);
  console.log(`activity changes compared with their own frame as one place (${sets.length}):\n  ${sets.join('\n  ')}`);
  const exact = bytes.filter((stretch) => stretch.exact).length;
  console.log(`output per tab and stretch (${bytes.length}): ${exact} with a Node run's bytes exactly, ${bytes.length - exact} passed on states only`);
  for (const { part, tab, where, exact: same } of bytes) console.log(`  ${part}: ${tab} ${where}: ${same ? "a Node run's bytes" : 'states only'}`);
});
