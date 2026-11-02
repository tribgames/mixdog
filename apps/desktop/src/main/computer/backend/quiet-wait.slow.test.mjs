import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { loadComputerSource } from './native-assets.ts';

// Timer and process scheduling slack when asserting elapsed time against a cap.
const CAP_TOLERANCE_MS = 50;

// Runs the real Wait-UntilQuiet / Get-QuietSample / Do-Wait with stubbed window
// data. It loads only the wait source and the Do-Wait function: no host, no
// window, no input.
async function runWaits(body) {
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-quiet-wait-'));
  const path = join(directory, 'quiet-wait.ps1');
  try {
    await writeFile(path, `${loadComputerSource('quiet-wait.ps1')}\n${body}`);
    const { stdout } = await promisify(execFile)(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path],
      { encoding: 'utf8', timeout: 60_000, windowsHide: true }
    );
    const line = stdout.split(/\r?\n/).find((value) => value.startsWith('@@QUIET@@'));
    assert.ok(line, `no result in: ${stdout}`);
    return JSON.parse(line.slice('@@QUIET@@'.length));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('quiet mode ends after 3 stable samples and runs to the cap while the window list changes', {
  skip: process.platform !== 'win32' && 'Windows only',
  timeout: 90_000,
}, async () => {
  const result = await runWaits(`
$script:n = 0
$stable = Wait-UntilQuiet 3 { 'same' }
$changing = Wait-UntilQuiet 1 { $script:n++; "windows $script:n" }
# Three samples 200 ms apart need 400 ms; a 300 ms cap cannot prove stability.
$short = Wait-UntilQuiet 0.3 { 'same' }
[Console]::Out.WriteLine('@@QUIET@@' + (@{ stable = $stable; changing = $changing; short = $short } | ConvertTo-Json -Depth 4 -Compress))
`);
  assert.equal(result.short.quiet, false);
  assert.ok(
    result.short.waited_ms >= 290 && result.short.waited_ms <= 300 + CAP_TOLERANCE_MS,
    `a 300 ms wait on a stable window ended at ${result.short.waited_ms} ms`
  );
  assert.equal(result.stable.quiet, true);
  // 3 samples 200 ms apart: two intervals, far under the 3000 ms cap.
  assert.ok(result.stable.waited_ms >= 390 && result.stable.waited_ms < 800, `stable waited ${result.stable.waited_ms} ms`);
  assert.equal(result.changing.quiet, false);
  assert.equal(result.changing.reason, 'still_changing');
  assert.ok(result.changing.waited_ms >= 990 && result.changing.waited_ms <= 1000 + CAP_TOLERANCE_MS);
});

test('a window title that changes only in case is not quiet', {
  skip: process.platform !== 'win32' && 'Windows only',
  timeout: 90_000,
}, async () => {
  const result = await runWaits(`
$script:n = 0
$cased = Wait-UntilQuiet 1 { $script:n++; if ($script:n % 2) { 'w1|Report' } else { 'w1|report' } }
[Console]::Out.WriteLine('@@QUIET@@' + (@{ cased = $cased } | ConvertTo-Json -Depth 4 -Compress))
`);
  assert.equal(result.cased.quiet, false);
  assert.equal(result.cased.reason, 'still_changing');
});

// Replaces Start-QuietSleep to log each deadline the wait sleeps to (on its own
// Stopwatch) and then wakes `$script:extraMs` after it. Samples log their start
// on the same Stopwatch, which PowerShell's dynamic scope makes visible to them.
const SLEEP_LOG = `
$script:sleepUntil = @()
$script:starts = @()
function Start-QuietSleep([double]$untilMs, [System.Diagnostics.Stopwatch]$clock) {
  $script:sleepUntil += $untilMs
  $ms = $untilMs - $clock.Elapsed.TotalMilliseconds
  if ($ms -gt 0) { [System.Threading.Thread]::Sleep([int]$ms + $script:extraMs) }
}
`;

function assertCapContract(result, capMs) {
  assert.ok(result.starts.every((start) => start < capMs), `a sample started at or after the ${capMs} ms cap: ${result.starts}`);
  assert.ok(result.sleepUntil.every((until) => until <= capMs), `a sleep runs past the ${capMs} ms cap: ${result.sleepUntil}`);
}
test('a slow sample does not carry the wait past its cap', {
  skip: process.platform !== 'win32' && 'Windows only',
  timeout: 90_000,
}, async () => {
  const result = await runWaits(`
${SLEEP_LOG}
$script:extraMs = 0
$script:n = 0
$slow = Wait-UntilQuiet 0.3 { $script:starts += $clock.Elapsed.TotalMilliseconds; $script:n++; Start-Sleep -Milliseconds 150; "state $script:n" }
[Console]::Out.WriteLine('@@QUIET@@' + (@{ slow = $slow; samples = $script:n; starts = @($script:starts); sleepUntil = @($script:sleepUntil) } | ConvertTo-Json -Depth 4 -Compress))
`);
  // A 150 ms sample (far slower than the few ms a Win32 snapshot takes) leaves
  // no room for a second one, so the wait stops sampling and sleeps out the cap.
  assert.equal(result.slow.quiet, false);
  assert.equal(result.samples, 1);
  // The contract is checked on what the wait itself does, not on elapsed wall
  // time (a sample cannot be interrupted and a wake can be late, so elapsed
  // time is scheduler luck): no sample starts at or after the cap and no sleep
  // is scheduled to end past it.
  assertCapContract(result, 300);
  assert.deepEqual(result.sleepUntil, [300], 'only the sleep out to the cap is expected');
});

test('a sleep that wakes late does not start a sample past the cap', {
  skip: process.platform !== 'win32' && 'Windows only',
  timeout: 90_000,
}, async () => {
  const result = await runWaits(`
${SLEEP_LOG}
# The inter-sample sleep wakes 400 ms late, past the 500 ms cap.
$script:extraMs = 400
$script:n = 0
$late = Wait-UntilQuiet 0.5 { $script:starts += $clock.Elapsed.TotalMilliseconds; $script:n++; "state $script:n" }
[Console]::Out.WriteLine('@@QUIET@@' + (@{ late = $late; samples = $script:n; starts = @($script:starts); sleepUntil = @($script:sleepUntil) } | ConvertTo-Json -Depth 4 -Compress))
`);
  assert.equal(result.late.quiet, false);
  assert.equal(result.samples, 1, `a sample started after the late wake: ${result.starts}`);
  assertCapContract(result, 500);
});
test('quiet sampling reads window metadata only, and Do-Wait is a fixed pause unless quiet is true', {
  skip: process.platform !== 'win32' && 'Windows only',
  timeout: 90_000,
}, async () => {
  const dowait = loadComputerSource('input-pointer.ps1');
  const doWait = dowait.slice(dowait.indexOf('function Do-Wait'), dowait.indexOf('\n}\n', dowait.indexOf('function Do-Wait')) + 3);
  const result = await runWaits(`
function Do-WindowSnapshot { @{ windows = @(@{ id = 'w1'; title = 'A'; focused = $true; minimized = $false; maximized = $false; x = 1; y = 2; width = 3; height = 4 }) } }
${doWait}
$sample = Get-QuietSample
$fixedClock = [System.Diagnostics.Stopwatch]::StartNew()
$fixed = Do-Wait ([pscustomobject]@{ duration = 1 })
$fixedMs = $fixedClock.Elapsed.TotalMilliseconds
$quiet = Do-Wait ([pscustomobject]@{ duration = 3; quiet = $true })
[Console]::Out.WriteLine('@@QUIET@@' + (@{ sample = $sample; fixed = $fixed.text; fixedMs = $fixedMs; quiet = $quiet.text } | ConvertTo-Json -Depth 4 -Compress))
`);
  assert.equal(result.sample, 'w1|A|True|False|False|1,2,3,4');
  assert.equal(result.fixed, 'waited 1s');
  assert.ok(result.fixedMs >= 990, `a default wait lasted ${result.fixedMs} ms of 1000`);
  const quiet = JSON.parse(result.quiet);
  assert.equal(quiet.quiet_wait.ended_early, true);
  assert.ok(quiet.quiet_wait.waited_ms < 1_000);
});
