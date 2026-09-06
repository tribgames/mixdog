import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { ABORT_CLEANUP_PROGRAM } from '../backend/program.ts';
import { runComputerProbe } from './fixtures/probe-runner.mjs';

test('generated abort cleanup program compiles', {
  skip: process.platform !== 'win32', timeout: 30_000,
}, async () => {
  const invokeStart = ABORT_CLEANUP_PROGRAM.indexOf('[MixdogAbortCleanup]::Run(');
  assert.ok(invokeStart > 0);
  const script = `${ABORT_CLEANUP_PROGRAM.slice(0, invokeStart)}[Console]::Out.WriteLine('cleanup-compiled')\n`;
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-computer-cleanup-'));
  const path = join(directory, 'cleanup.ps1');
  try {
    await writeFile(path, script);
    const { stdout } = await promisify(execFile)('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path,
    ], { encoding: 'utf8', timeout: 20_000, windowsHide: true });
    assert.match(stdout, /cleanup-compiled/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('generated Windows input host refuses unarmed keyboard and pointer input', {
  skip: process.platform !== 'win32', timeout: 200_000,
}, async () => {
  const probe = (await readFile(new URL('./fixtures/native-safety.ps1', import.meta.url), 'utf8'))
    .replace('@@MIXDOG_LIVE_CLIPBOARD_PROBE@@', '');
  const payload = await runComputerProbe(probe);
  const resultsByName = Object.fromEntries(payload.results.map((entry) => [entry.name, entry]));
  assert.deepEqual(payload.results.filter((entry) => !entry.ok).map((entry) => entry.name),
    ['key', 'click'], JSON.stringify(payload.results, null, 2));
  assert.match(resultsByName.key.error, /key requires focus_window first/);
  assert.match(resultsByName.click.error, /click requires focus_window first/);
});
