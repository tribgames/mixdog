import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runComputerProbe } from './fixtures/probe-runner.mjs';

test('live clipboard write preserves and restores the user clipboard', {
  skip: process.platform !== 'win32' || process.env.MIXDOG_COMPUTER_LIVE_CLIPBOARD !== '1',
  timeout: 200_000,
}, async () => {
  const clipboard = await readFile(new URL('./fixtures/live-clipboard.ps1', import.meta.url), 'utf8');
  const payload = await runComputerProbe(`
$probeResults = New-Object System.Collections.ArrayList
${clipboard}
[Console]::Out.WriteLine('@@MIXCU@@' + (@{results=$probeResults} | ConvertTo-Json -Compress -Depth 5))
exit
`);
  assert.equal(payload.results[0].ok, true, payload.results[0].error);
});
