import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import test from 'node:test';

process.env.MIXDOG_DAEMON_HOST = '1';
process.env.MIXDOG_PWSH_STANDBY_POOL = '4';

const [
  { executeBashTool, prewarmShellStandbys },
  { runRg },
] = await Promise.all([
  import('../src/runtime/agent/orchestrator/tools/builtin/bash-tool.mjs'),
  import('../src/runtime/agent/orchestrator/tools/builtin/rg-runner.mjs'),
]);

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
}

test('parallel shell and search wave completes without serialization or result bleed', {
  skip: process.platform !== 'win32',
}, async (t) => {
  prewarmShellStandbys();
  await new Promise((resolve) => setTimeout(resolve, 600));

  const waveStartedAt = performance.now();
  const shellLatencies = [];
  const searchLatencies = [];
  const shells = Array.from({ length: 8 }, async (_, index) => {
    const startedAt = performance.now();
    const output = await executeBashTool({
      command: `Start-Sleep -Milliseconds 500; Write-Output 'shell-wave-${index}'`,
      shell: 'powershell',
      timeout: 10_000,
    }, process.cwd(), {});
    shellLatencies.push(performance.now() - startedAt);
    assert.match(String(output), new RegExp(`shell-wave-${index}`));
  });
  const searches = Array.from({ length: 8 }, async () => {
    const startedAt = performance.now();
    const output = await runRg(['--files', '--glob', 'package.json', '.'], {
      cwd: process.cwd(),
      timeout: 10_000,
    });
    searchLatencies.push(performance.now() - startedAt);
    assert.match(String(output), /package\.json/);
  });

  await Promise.all([...shells, ...searches]);
  const elapsedMs = performance.now() - waveStartedAt;
  const shellP95 = percentile(shellLatencies, 0.95);
  const searchP95 = percentile(searchLatencies, 0.95);
  t.diagnostic(
    `shells=8 searches=8 total=${elapsedMs.toFixed(1)}ms `
    + `shellP95=${shellP95.toFixed(1)}ms searchP95=${searchP95.toFixed(1)}ms`,
  );
  assert.ok(elapsedMs < 3_000, `parallel mixed wave took ${elapsedMs.toFixed(1)}ms`);
  assert.ok(shellP95 < 3_000, `parallel shell p95 ${shellP95.toFixed(1)}ms`);
  assert.ok(searchP95 < 1_500, `parallel search p95 ${searchP95.toFixed(1)}ms`);
});
