import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createWorkerPool } from './worker-pool.ts';
import { runComputerProbe } from '../host/fixtures/probe-runner.mjs';
import { DEFAULT_CAPTURE_AFTER_DELAY_MS } from '../shared/common.ts';

test('native step batching preserves guard order, post-input settling and failure without replay', {
  skip: process.platform !== 'win32', timeout: 200_000,
}, async () => {
  const payload = await runComputerProbe(String.raw`
$script:events = New-Object System.Collections.ArrayList
$script:failAfter = $false
function Do-WindowSnapshot {
  [void]$script:events.Add('snapshot')
  if ($script:failAfter -and $script:events.Count -eq 3) { throw 'fixture_observation_failed: after input' }
  return @{ windows = @() }
}
function Do-Type($req) {
  [void]$script:events.Add('type')
  return New-ActionResult 'type' 'fixture' 'unverifiable' $false 'fixture delivered' $null 'background' $req.window_id
}
function Request-Step($step) {
  return @{ action = 'sequence_step'; delivery = 'background'; session_id = 'batch-probe'; step = $step }
}
$step = @{ action = 'type'; delivery = 'background'; session_id = 'batch-probe'; window_id = 'hwnd:0x1'; text = 'fixture' }
$accepted = Handle (Request-Step $step)
$order = @($script:events)
$denials = New-Object System.Collections.ArrayList
foreach ($change in @(
  @{ action = 'launch' }, @{ action = 'sequence_step' }, @{ delivery = 'foreground' },
  @{ session_id = 'other' }, @{ window_id = '' }, @{ read_only = $true },
  @{ authorization_expires_at = 1 }, @{ action = 'wait'; duration = 6 }
)) {
  $script:events.Clear()
  $candidate = $step.Clone()
  foreach ($key in $change.Keys) { $candidate[$key] = $change[$key] }
  $errorText = ''
  try { $null = Handle (Request-Step $candidate) } catch { $errorText = $_.Exception.Message }
  [void]$denials.Add(@{ error = $errorText; events = @($script:events) })
}
$script:events.Clear()
$readOnly = Request-Step $step
$readOnly.read_only = $true
$readOnlyError = ''
try { $null = Handle $readOnly } catch { $readOnlyError = $_.Exception.Message }
$readOnlyEvents = @($script:events)
$script:events.Clear()
$script:failAfter = $true
$failure = ''
try { $null = Handle (Request-Step $step) } catch { $failure = $_.Exception.Message }
[Console]::Out.WriteLine('@@MIXCU@@' + (@{
  accepted = $accepted; order = $order; denials = @($denials)
  read_only_error = $readOnlyError; read_only_events = $readOnlyEvents
  failure = $failure; failure_events = @($script:events)
} | ConvertTo-Json -Depth 8 -Compress))
exit 0
`);
  assert.deepEqual(payload.order, ['snapshot', 'type', 'snapshot']);
  assert.equal(payload.accepted.step_result.delivery_accepted, true);
  assert.equal(payload.accepted.timings_ms.settle_credit_ms, 0);
  assert.ok(payload.accepted.timings_ms.settle_ms >= DEFAULT_CAPTURE_AFTER_DELAY_MS - 1);
  for (const denied of payload.denials) {
    assert.match(denied.error, /sequence_step_invalid|computer_policy_expired/);
    assert.deepEqual(denied.events, []);
  }
  assert.match(payload.read_only_error, /read_only/);
  assert.deepEqual(payload.read_only_events, []);
  assert.match(payload.failure, /fixture_observation_failed/);
  assert.deepEqual(payload.failure_events, ['snapshot', 'type', 'snapshot']);
});

test('resident backend phase measurements compare legacy and batched passive steps without touching input', {
  skip: process.platform !== 'win32', timeout: 120_000,
}, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-sequence-timing-'));
  const pool = createWorkerPool({
    dataDirectory: () => directory, isBridgeEnabled: () => false, isDisposed: () => false,
  });
  const session_id = 'sequence-timing';
  let requests = 0;
  const call = async (request) => {
    requests++;
    const response = await pool.callPowerShell({ ...request, session_id });
    assert.equal(response.ok, true, response.error);
    return response.result;
  };
  const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  try {
    const initial = await call({ action: 'window_snapshot', read_only: true });
    const window_id = initial.windows[0]?.id;
    if (!window_id) { t.skip('no desktop window available for passive timing'); return; }
    const measurements = [];
    for (const duration of [0, 0.2]) {
      const legacy = [];
      const batch = [];
      const phases = [];
      for (let sample = 0; sample < 3; sample++) {
        // Alternate ordering so warm worker drift does not always favor one path.
        for (const mode of sample % 2 ? ['batch', 'legacy'] : ['legacy', 'batch']) {
          const step = { action: 'wait', duration, window_id, session_id, delivery: 'background' };
          const countBefore = requests;
          const started = performance.now();
          if (mode === 'legacy') {
            await call({ action: 'window_snapshot', read_only: true });
            await call(step);
            await new Promise((resolve) => setTimeout(resolve, DEFAULT_CAPTURE_AFTER_DELAY_MS));
            await call({ action: 'window_snapshot', read_only: true });
            legacy.push(performance.now() - started);
            assert.equal(requests - countBefore, 3);
          } else {
            const result = await call({ action: 'sequence_step', delivery: 'background', step });
            batch.push(performance.now() - started);
            phases.push(result.timings_ms);
            assert.equal(requests - countBefore, 1);
            assert.ok(Array.isArray(result.windows_before) && Array.isArray(result.windows_after));
            const timing = result.timings_ms;
            assert.ok(timing.delivery_ms + timing.settle_ms >= DEFAULT_CAPTURE_AFTER_DELAY_MS - 1);
            assert.ok(timing.settle_credit_ms <= Math.min(DEFAULT_CAPTURE_AFTER_DELAY_MS, timing.delivery_ms));
            if (duration === 0.2) assert.equal(result.settle_delay_ms, 0);
          }
        }
      }
      measurements.push({
        wait_ms: duration * 1000, samples: legacy.length,
        legacy_requests_per_step: 3, batch_requests_per_step: 1,
        legacy_median_ms: Number(median(legacy).toFixed(2)),
        batch_median_ms: Number(median(batch).toFixed(2)),
        native_phases_median_ms: Object.fromEntries(Object.keys(phases[0])
          .map((key) => [key, Number(median(phases.map((phase) => phase[key])).toFixed(2))])),
      });
    }
    // Timing is advisory, not an exact-speed assertion under shared-machine load.
    t.diagnostic(JSON.stringify({ sequence_backend_measurements: measurements }));
  } finally {
    const exits = [...pool.powerShellBySession.values()].map((child) => {
      const exited = once(child, 'exit');
      pool.retirePowerShell(child, new Error('timing fixture finished'));
      return exited;
    });
    await Promise.all(exits);
    pool.removeHostScript();
    await rm(directory, { recursive: true, force: true });
  }
});
