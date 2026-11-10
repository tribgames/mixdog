// The phone's terminal and folder-watch adapter against a real mixdogd, compared whole with what Node (b6f10295a) answered and pushed
// for the same script (apps/mobile/fixtures/phone-terminal/golden.json, recorded by benchmarks/rust-core/recorders/record-phone-terminal.mjs).
// The scenario runs in its own process (remote-protocol-terminal.scenario.mjs); the core binary is MIXDOGD_BIN.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { compareTraces } from './remote-protocol-terminal-compare.mjs';

const golden = JSON.parse(readFileSync(new URL('../../../mobile/fixtures/phone-terminal/golden.json', import.meta.url), 'utf8')).trace;
const runner = fileURLToPath(new URL('./remote-protocol-terminal.scenario.mjs', import.meta.url));

test('phone terminal adapter replays the Node recording over a real core', () => {
  const child = spawnSync(process.execPath, [...process.execArgv, runner], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 600_000 });
  assert.ok(!child.error, `scenario did not finish within 600 s: ${child.error?.message}\n${child.stderr?.slice(-3000)}`);
  const at = child.stdout.lastIndexOf('@@TRACE@@');
  assert.ok(child.status === 0 && at >= 0, `scenario failed (${child.status}):\n${child.stdout.slice(-1500)}\n${child.stderr.slice(-3000)}`);
  const got = JSON.parse(child.stdout.slice(at + '@@TRACE@@'.length));
  compareTraces(got, golden);
});
