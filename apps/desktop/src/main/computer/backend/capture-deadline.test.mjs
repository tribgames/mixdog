import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PS_SESSION } from './ps-session.ts';
import { PS_RUNTIME } from './ps-runtime.ts';

// Only a hung fixture may end here. The former 10s budget SIGTERM-killed a
// healthy fixture on a hosted windows-latest runner (release-gate run
// 35088208105: code null, killed true, signal SIGTERM, empty stdout/stderr):
// the first inline `Add-Type` of a job compiles with a cold csc.exe while the
// whole suite runs in parallel, which took over 10s there, and the warm runs
// of this same helper in the same file then finished in ~1.3s each.
const FIXTURE_BUDGET_MS = 60_000;

async function run(script, input = '') {
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-capture-deadline-'));
  try {
    const path = join(directory, 'fixture.ps1');
    await writeFile(path, "$ErrorActionPreference='Stop'\n[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)\n" + script);
    return await new Promise((resolve, reject) => {
      const child = execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', path],
        { windowsHide: true, timeout: FIXTURE_BUDGET_MS }, (error, stdout) => {
          if (!error) { resolve(stdout.trim()); return; }
          // A killed child reports no stderr, so Node's bare "Command failed"
          // says nothing about why; name the budget that ended it instead.
          if (error.killed) {
            error.message += `\nkilled after the ${FIXTURE_BUDGET_MS} ms fixture budget`
              + ` (signal ${error.signal}, ${stdout.length} stdout bytes)`;
          }
          reject(error);
        });
      child.stdin.end(input);
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test('bounded WinRT waits cancel once, distinguish settled cancellation and never accept late work', {
  skip: process.platform !== 'win32', timeout: 90_000,
}, async () => {
  const wait = PS_SESSION.slice(PS_SESSION.indexOf('function Await-WinRt('),
    PS_SESSION.indexOf('\nfunction Resolve-WindowInfo('));
  const stdout = await run(String.raw`
Add-Type @'
public static class TaskFixture {
  public static int CancelRequests;
  public static System.Threading.Tasks.Task<T> Work<T>(object mode, System.Threading.CancellationToken token) {
    if ((string)mode == "done") return System.Threading.Tasks.Task.FromResult((T)(object)123);
    var source = new System.Threading.Tasks.TaskCompletionSource<T>();
    token.Register(() => {
      CancelRequests++;
      if ((string)mode == "ack") source.TrySetCanceled();
      if ((string)mode == "late") source.TrySetResult((T)(object)456);
    });
    return source.Task;
  }
}
'@
$script:WinRtAsTaskGeneric = [TaskFixture].GetMethod('Work')
` + wait + String.raw`
$values = @()
foreach ($mode in @('done','ack','late','hang')) {
  [TaskFixture]::CancelRequests = 0
  $errorText = ''
  $cancellation = ''
  $value = $null
  try { $value = Await-WinRt $mode ([int]) 100 } catch {
    $errorText = $_.Exception.GetBaseException().Message
    $cancellation = $_.Exception.GetBaseException().Data['WinRtCancellation']
  }
  $values += @{mode=$mode;value=$value;error=$errorText;cancellation=$cancellation;requests=[TaskFixture]::CancelRequests}
}
$values | ConvertTo-Json -Compress
`);
  const [done, ack, late, hang] = JSON.parse(stdout);
  assert.equal(done.value, 123);
  assert.equal(done.requests, 0);
  for (const row of [ack, late, hang]) {
    assert.match(row.error, /^winrt_timeout\|/);
    assert.equal(row.requests, 1);
    assert.equal(row.value, null);
  }
  assert.equal(ack.cancellation, 'settled');
  assert.equal(late.cancellation, 'settled');
  assert.equal(hang.cancellation, 'unconfirmed');
});

// Three sequential fixtures, so this one carries three fixture budgets.
test('native capture replies preserve cleanup evidence and retire only unconfirmed workers', {
  skip: process.platform !== 'win32', timeout: 200_000,
}, async () => {
  const loop = PS_RUNTIME.slice(PS_RUNTIME.indexOf('[Console]::OutputEncoding'));
  const script = String.raw`
Add-Type @'
public static class MixWin32 { public static int PointerEventsGenerated, PointerEventsFailed; public static object PointerProgress; }
public static class MixNativeInput { public static void InitializeOwnership(int value) {} }
public static class MixInputObservation { public static int Marker = 1; }
'@
function Invalidate-RefsForRequest($req) {}
function Handle($req) {
  $error = [InvalidOperationException]::new('capture_timeout|fixture')
  $error.Data['CaptureCleanup'] = @{status=$req.cleanup}
  throw $error
}
` + loop;
  for (const status of ['confirmed', 'failed', 'unconfirmed']) {
    const input = [1, 2].map(id => JSON.stringify({ id, action: 'window_capture', cleanup: status })).join('\n') + '\n';
    const stdout = await run(script, input);
    const replies = stdout.split(/\r?\n/).map(line => JSON.parse(line.slice(line.indexOf('{'))));
    assert.equal(replies.length, status === 'confirmed' ? 2 : 1);
    assert.equal(replies[0].ok, false);
    assert.equal(replies[0].result.capture_cleanup.status, status);
    assert.match(replies[0].error, /^capture_timeout\|/);
  }
});
