import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { ELEVATED_BOOTSTRAP, ELEVATED_SUPERVISION, ELEVATED_INPUT_SOURCE, elevatedProgramInvocation } from './elevated-program.ts';
import { powershellHostProgram } from './program.ts';
import { MIXDOG_HOST_CSHARP } from './native-source.ts';
import { createHash } from 'node:crypto';

const exec = promisify(execFile);

test('elevated cleanup extracts authenticated literal native source without executing the host', {
  skip: process.platform !== 'win32',
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-owned-source-'));
  try {
    await writeFile(join(directory, 'host.ps1'), powershellHostProgram());
    const script = String.raw`
$ErrorActionPreference = 'Stop'
${ELEVATED_INPUT_SOURCE}
$source = Read-OwnedInputSource ([IO.File]::ReadAllBytes((Join-Path $env:AUDIT_DIRECTORY 'host.ps1')))
$sha = [Security.Cryptography.SHA256]::Create()
try { [Console]::WriteLine(([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($source.Trim())))).Replace('-','').ToLowerInvariant()) }
finally { $sha.Dispose() }
foreach ($bad in @(
  '$MixdogHostSource = (throw "must not run")',
  '$MixdogHostSource = "first"; $MixdogHostSource = "second"',
  '$MixdogHostSource = "$env:PATH"')) {
  $rejected = $false
  try { Read-OwnedInputSource ([Text.Encoding]::UTF8.GetBytes($bad)) | Out-Null }
  catch { $rejected = $true }
  if (-not $rejected) { throw 'accepted nonliteral or ambiguous source' }
}
`;
    const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64')], {
      windowsHide: true, timeout: 10000, env: { ...process.env, AUDIT_DIRECTORY: directory },
    });
    assert.equal(stdout.trim(), createHash('sha256').update(MIXDOG_HOST_CSHARP.trim()).digest('hex'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('compressed elevated transport preserves script scope and leaves room for the launch envelope', {
  skip: process.platform !== 'win32',
}, async () => {
  const production = Buffer.from(elevatedProgramInvocation(), 'utf16le').toString('base64');
  assert.ok(production.length < 20_000);
  const script = elevatedProgramInvocation(
    "$state = 'before'; function Complete { $script:state = 'after' }; Complete; [Console]::WriteLine($state)",
  );
  const { stdout } = await exec('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64'),
  ], { windowsHide: true, timeout: 10_000 });
  assert.equal(stdout.trim(), 'after');
});

test('elevated supervisor cancels only its harmless child and acknowledges its actual exit', {
  skip: process.platform !== 'win32',
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-supervisor-'));
  // Exercise the production supervisor without UAC or any desktop input.
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$tokens = $null
$errors = $null
[void][System.Management.Automation.Language.Parser]::ParseInput(
  [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:AUDIT_BOOTSTRAP)),
  [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
${ELEVATED_SUPERVISION}
$env:MIXDOG_ELEVATED_PARENT_PID = [string]$PID
$env:MIXDOG_ELEVATED_PARENT_TICKS = [string]([Diagnostics.Process]::GetCurrentProcess().StartTime.ToUniversalTime().Ticks)
$parentTicks = $env:MIXDOG_ELEVATED_PARENT_TICKS
$token = 'test-token'
$responsePath = Join-Path $env:AUDIT_DIRECTORY 'receipt'
$releaseInput = { $script:released = $true }
$results = @()
foreach ($mode in @('cancel','deadline','parent','success')) {
  $cancelPath = Join-Path $env:AUDIT_DIRECTORY $mode
  $deadline = [DateTime]::UtcNow.AddSeconds(10)
  $env:MIXDOG_ELEVATED_PARENT_TICKS = $parentTicks
  if ($mode -eq 'cancel') { [IO.File]::WriteAllText($cancelPath, 'cancel') }
  if ($mode -eq 'deadline') { $deadline = [DateTime]::UtcNow.AddSeconds(-1) }
  if ($mode -eq 'parent') { $env:MIXDOG_ELEVATED_PARENT_TICKS = '1' }
  $start = New-Object Diagnostics.ProcessStartInfo
  $start.FileName = $env:AUDIT_NODE
  $start.Arguments = if ($mode -eq 'success') { '-e "process.exit(0)"' } else { '-e "setTimeout(()=>{},30000)"' }
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $worker = New-Object Diagnostics.Process
  $worker.StartInfo = $start
  [void]$worker.Start()
  $workerStopped = $false
  $released = $false
  $reason = ''
  try {
    try { Wait-InputWorker } catch { $reason = $_.Exception.Message; Stop-InputWorker }
    Write-Receipt $mode
    $results += @{mode=$mode; exited=$worker.HasExited; stopped=$workerStopped; released=$released; reason=$reason}
  } finally {
    if (-not $worker.HasExited) { $worker.Kill(); [void]$worker.WaitForExit(5000) }
    $worker.Dispose()
  }
}
$results | ConvertTo-Json -Compress
`;
  try {
    const { stdout } = await exec('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64'),
    ], {
      windowsHide: true,
      timeout: 20_000,
      env: {
        ...process.env,
        AUDIT_DIRECTORY: directory,
        AUDIT_NODE: process.execPath,
        AUDIT_BOOTSTRAP: Buffer.from(ELEVATED_BOOTSTRAP, 'utf8').toString('base64'),
      },
    });
    const results = JSON.parse(stdout.trim());
    for (const result of results) {
      assert.equal(result.exited, true, result.mode);
      assert.equal(result.stopped, true, result.mode);
      assert.equal(result.released, result.mode !== 'success', result.mode);
      assert.equal(result.reason, result.mode === 'success' ? '' : 'privileged_worker_cancelled');
    }
    assert.equal(results.length, 4);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
