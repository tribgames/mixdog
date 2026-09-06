import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { acceptSessionIdentity, drainSessionClient, stopSessionClient } from './office-session-client.mjs';
import { executeOfficeTool } from '../index.mjs';

const exec = promisify(execFile);
function client() {
  const child = new EventEmitter();
  child.exitCode = null;
  child.ref = () => {};
  child.unref = () => {};
  child.kill = () => { throw new Error('No kill allowed without safe cleanup evidence'); };
  let ends = 0;
  child.stdin = { end: () => { ends++; } };
  return { sessionId: 'test', child, pending: new Map(), stderr: '', readline: { close() {} }, get ends() { return ends; } };
}

test('cancellation drains an in-flight open through EOF and captures its late identity', async () => {
  const c = client();
  const cleanup = drainSessionClient(c, 'cancelled');
  acceptSessionIdentity(c, { session: 'test', ok: true, ownership: 'owned', ownsApplication: true, appPid: 101 });
  assert.equal(c.appPid, 101);
  assert.equal(c.ends, 1);
  c.child.exitCode = 0;
  c.child.emit('close', 0);
  assert.deepEqual(await cleanup, { ok: true, hostExited: true });
});

test('cleanup timeout is explicit and does not kill a possibly shared application', async () => {
  const c = client();
  const result = await drainSessionClient(c, 'cancelled', { graceMs: 1 });
  assert.equal(result.ok, false);
  assert.equal(result.pending, true);
  assert.equal(c.closed, undefined);
  assert.equal(c.ends, 1);
  c.child.exitCode = 0;
  c.child.emit('close', 0);
  stopSessionClient(c);
});

test('host cleanup errors are returned instead of treating host exit as success', async () => {
  const c = client();
  const cleanup = drainSessionClient(c);
  c.stderr = 'MIXDOG_OFFICE_CLEANUP {"ok":false,"errors":["document close failed"]}';
  c.child.exitCode = 0;
  c.child.emit('close', 0);
  const result = await cleanup;
  assert.equal(result.ok, false);
  assert.match(result.errors[0], /document close failed/);
});

test('completed and retained applications do not leave stale kill ownership', () => {
  const c = client();
  acceptSessionIdentity(c, { session: 'test', ok: true, ownership: 'owned', ownsApplication: true, appPid: 101 });
  acceptSessionIdentity(c, { session: 'test', appPid: 101, cleanup: { applicationRetained: true } });
  assert.equal(c.ownsApplication, false);
  acceptSessionIdentity(c, { session: 'test', appPid: 101, cleanup: { processExited: true } });
  assert.equal(c.appPid, 0);
});

test('public Office cancellation preserves the underlying error detail', async () => {
  const result = await executeOfficeTool({ action: 'detect' }, { signal: AbortSignal.abort() });
  assert.equal(result.isError, true);
  const value = JSON.parse(result.content[0].text);
  assert.equal(value.code, 'cancelled');
  assert.ok(value.detail, 'cleanup/cancellation context must not be discarded by the public tool envelope');
});

test('PowerShell cleanup closes by format, preserves shared documents, and exposes failures', { skip: process.platform !== 'win32' }, async () => {
  const path = fileURLToPath(new URL('./office-com-cleanup.ps1', import.meta.url)).replaceAll("'", "''");
  const script = `
$ErrorActionPreference = 'Stop'
. '${path}'
Add-Type -TypeDefinition @'
using System;
public class CollectionProbe { public int Count = 1; }
public class AppProbe {
  public CollectionProbe Documents = new CollectionProbe();
  public CollectionProbe Workbooks = new CollectionProbe();
  public CollectionProbe Presentations = new CollectionProbe();
  public int Quits;
  public bool FailQuit;
  public void Quit() { if (FailQuit) throw new Exception("quit rejected"); Quits++; }
}
public class PptProbe {
  public CollectionProbe Collection;
  public bool Fail;
  public int Closes;
  public void Close() { if (Fail) throw new Exception("close rejected"); Closes++; Collection.Count--; }
}
public class WordProbe {
  public CollectionProbe Collection;
  public int Closes;
  public void Close(int save) { if (save != 0) throw new Exception("unexpected save"); Closes++; Collection.Count--; }
}
public class ExcelProbe {
  public CollectionProbe Collection;
  public int Closes;
  public void Close(bool save) { if (save) throw new Exception("unexpected save"); Closes++; Collection.Count--; }
}
'@
function Check($condition, $message) { if (-not $condition) { throw $message } }
function Make-State($format, $ownership, $ownsApplication, $otherDocuments = 0, $fail = $false) {
  $app = New-Object AppProbe
  switch ($format) {
    'pptx' { $doc = New-Object PptProbe; $doc.Collection = $app.Presentations; $doc.Fail = $fail }
    'docx' { $doc = New-Object WordProbe; $doc.Collection = $app.Documents }
    'xlsx' { $doc = New-Object ExcelProbe; $doc.Collection = $app.Workbooks }
  }
  $doc.Collection.Count = 1 + $otherDocuments
  return [pscustomobject]@{ Format=$format; Mode='background'; Ownership=$ownership; OwnsApplication=$ownsApplication; App=$app; Document=$doc; AppPid=0; AppStartTicks=0 }
}
foreach ($format in @('pptx', 'docx', 'xlsx')) {
  $state = Make-State $format 'owned' $true
  $app = $state.App; $doc = $state.Document
  $result = Close-SessionState $state $false
  Check ($result.ok -and $doc.Closes -eq 1 -and $app.Quits -eq 1) "wrong close signature for $format"
}
$state = Make-State 'pptx' 'owned' $false
$app = $state.App; $doc = $state.Document
$result = Close-SessionState $state $false
Check ($result.ok -and $doc.Closes -eq 1 -and $app.Quits -eq 0 -and $result.applicationRetained) 'shared application was quit'
$state = Make-State 'pptx' 'attached' $false
$app = $state.App; $doc = $state.Document
$result = Close-SessionState $state $false
Check ($result.ok -and $doc.Closes -eq 0 -and $app.Quits -eq 0 -and $result.detached) 'attached user document was closed'
$state = Make-State 'pptx' 'owned' $true 1
$app = $state.App
$result = Close-SessionState $state $false
Check ($result.ok -and $app.Presentations.Count -eq 1 -and $app.Quits -eq 0) 'another user document was closed'
$state = Make-State 'pptx' 'owned' $true 0 $true
$result = Close-SessionState $state $false
Check (-not $result.ok -and $result.errors.Count -gt 0 -and $null -ne $state.Document) 'close failure was hidden or cannot retry'
$state.Document.Fail = $false
$result = Close-SessionState $state $false
Check $result.ok 'explicit close retry failed'
$state = Make-State 'pptx' 'owned' $true
$state.App.FailQuit = $true
$result = Close-SessionState $state $false
Check (-not $result.ok -and $result.errors.Count -gt 0 -and $null -ne $state.App) 'quit failure was hidden or cannot retry'
$state.App.FailQuit = $false
$result = Close-SessionState $state $false
Check $result.ok 'explicit quit retry failed'
[Console]::Out.WriteLine('cleanup behavior passed')
`;
  const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { maxBuffer: 1024 * 1024 });
  assert.match(stdout, /cleanup behavior passed/);
});
