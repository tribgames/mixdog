import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { loadComputerSource } from './native-assets.ts';
import { FOREGROUND_LOCK_LINE_PREFIX, FOREGROUND_LOCK_REPLY_PREFIX } from './foreground-lock-host.ts';

// The worker's side of the lease (MixForegroundLock.cs) over a real pipe
// standing in for its stdin, with the host's answers written into it.
const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition ([IO.File]::ReadAllText($env:LOCK_SOURCE) + [Environment]::NewLine + @'
public static class LeaseFixture {
  public static int UnlockMode; // 0: the unlock succeeds; 1: it answers false; 2: it throws
  public static bool LockRefused;
  public static int UnlockCalls;
  public static void RefuseOwnLock() { MixForegroundLock.Native = delegate(uint code) { return false; }; }
  public static void GrantOwnLock(int unlockMode) {
    UnlockMode = unlockMode;
    LockRefused = false;
    MixForegroundLock.Native = delegate(uint code) {
      if (code == 1) return !LockRefused;
      UnlockCalls++;
      if (UnlockMode == 2) throw new System.Exception("unlock failed");
      return UnlockMode == 0;
    };
  }
  public static void UseHost() { MixForegroundLock.Host = new MixForegroundLockHost(); }
  // Writes the lines into the worker's stdin after a delay, as the host would.
  public static void Feed(System.IO.Stream pipe, string[] lines, int delayMs) {
    var thread = new System.Threading.Thread(delegate () {
      System.Threading.Thread.Sleep(delayMs);
      byte[] bytes = System.Text.Encoding.UTF8.GetBytes(string.Join("\n", lines) + "\n");
      pipe.Write(bytes, 0, bytes.Length);
      pipe.Flush();
    });
    thread.IsBackground = true;
    thread.Start();
  }
}
'@)
$server = New-Object System.IO.Pipes.AnonymousPipeServerStream([System.IO.Pipes.PipeDirection]::Out)
$client = New-Object System.IO.Pipes.AnonymousPipeClientStream([System.IO.Pipes.PipeDirection]::In, $server.ClientSafePipeHandle)
$stdin = New-Object MixWorkerInput ($client)
$p = $env:REPLY_PREFIX
function At($offset) { return ([MixLeaseClock]::Now() + $offset).ToString('0.000', [Globalization.CultureInfo]::InvariantCulture) }
function Facts() { $copy = @{}; foreach ($key in [MixForegroundLock]::LastFacts.Keys) { $copy[$key] = [MixForegroundLock]::LastFacts[$key] }; return $copy }
$rows = [ordered]@{}
[LeaseFixture]::RefuseOwnLock(); [LeaseFixture]::UseHost()
# Only the answer naming this request counts; a command line between them
# still reaches the request loop.
$deadline = At 300
[LeaseFixture]::Feed($server, @(
  "$($p)ack 99 1 5 locked $deadline",
  "$($p)ack 7 2 5 locked $deadline",
  "$($p)released 7 1 5 released",
  "$($p)ack 7 x 5 locked $deadline",
  "$p",
  '{"id":7,"action":"snapshot"}',
  "$($p)ack 7 1 12 locked $deadline"
), 30)
$locked = [MixForegroundLock]::Acquire(100, 7)
$rows.matching = @{ locked = $locked; held = [MixForegroundLock]::Held; facts = (Facts); command = $stdin.ReadLine() }
# A release answer for another lease is ignored; the one naming lease 12 ends it.
[LeaseFixture]::Feed($server, @("$($p)released 7 1 13 released", "$($p)released 7 1 12 released"), 30)
$rows.matching.release = [MixForegroundLock]::Release()
$rows.matching.again = [MixForegroundLock]::Release()
# Nothing naming the request in time: no lock, and an unanswered release is
# no_ack, since the host may still hold a lease it granted late.
[LeaseFixture]::Feed($server, @("$($p)ack 7 3 14 locked $(At 300)"), 30)
$locked = [MixForegroundLock]::Acquire(100, 7)
$rows.unanswered = @{ locked = $locked; held = [MixForegroundLock]::Held; release = [MixForegroundLock]::Release(); facts = (Facts) }
# A lease whose deadline passed before its answer arrived protects nothing.
[LeaseFixture]::Feed($server, @("$($p)ack 7 3 15 locked $(At -1)"), 30)
$locked = [MixForegroundLock]::Acquire(100, 7)
[LeaseFixture]::Feed($server, @("$($p)released 7 3 15 released"), 30)
$rows.expired = @{ locked = $locked; release = [MixForegroundLock]::Release(); facts = (Facts) }
# The worker's own lock: an unlock that answers false is unknown, one that
# throws is failed, and only a successful one is released.
foreach ($mode in 0, 1, 2) {
  [LeaseFixture]::GrantOwnLock($mode)
  $locked = [MixForegroundLock]::Acquire(1000, 7)
  $rows["own$mode"] = @{ locked = $locked; release = [MixForegroundLock]::Release(); facts = (Facts) }
}
# A failed own unlock leaves the hold open: the next Release retries it rather
# than returning the cached result.
$first = [MixForegroundLock]::Release()
[LeaseFixture]::UnlockMode = 0
$rows.retry = @{ first = $first; second = [MixForegroundLock]::Release(); third = [MixForegroundLock]::Release() }
# A false unlock (Windows lifted the lock on the user's Alt key or click) ends
# the hold: the next request without the foreground right reaches the host lease.
[LeaseFixture]::GrantOwnLock(1)
$null = [MixForegroundLock]::Acquire(1000, 7)
$falseRelease = [MixForegroundLock]::Release()
[LeaseFixture]::LockRefused = $true
[LeaseFixture]::Feed($server, @("$($p)ack 7 4 21 locked $(At 300)"), 30)
$locked = [MixForegroundLock]::Acquire(100, 7)
$hostFacts = Facts
[LeaseFixture]::Feed($server, @("$($p)released 7 4 21 released"), 30)
$rows.afterFalse = @{ release = $falseRelease; locked = $locked; facts = $hostFacts; hostRelease = [MixForegroundLock]::Release() }
# The next request retries it too, before anything new starts...
[LeaseFixture]::GrantOwnLock(2)
$null = [MixForegroundLock]::Acquire(1000, 7)
$failedRelease = [MixForegroundLock]::Release()
$old = [MixForegroundLock]::LastFacts
[LeaseFixture]::UnlockMode = 0
$calls = [LeaseFixture]::UnlockCalls
$locked = [MixForegroundLock]::Acquire(1000, 7)
$rows.nextRequest = @{ failed = $failedRelease; locked = $locked; retried = ([LeaseFixture]::UnlockCalls - $calls);
  oldRelease = $old['release']; oldBy = $old['released_by']; release = [MixForegroundLock]::Release() }
# ...and while that retry still fails and no new lock proves the old one gone,
# nothing new starts.
[LeaseFixture]::GrantOwnLock(2)
$null = [MixForegroundLock]::Acquire(1000, 7)
$null = [MixForegroundLock]::Release()
[LeaseFixture]::LockRefused = $true
$locked = [MixForegroundLock]::Acquire(1000, 7)
$rows.stillOpen = @{ locked = $locked; facts = (Facts) }
[LeaseFixture]::GrantOwnLock(0)
$locked = [MixForegroundLock]::Acquire(50, 7)
Start-Sleep -Milliseconds 150
$rows.deadline = @{ locked = $locked; held = [MixForegroundLock]::Held; release = [MixForegroundLock]::Release(); facts = (Facts) }
[Console]::Out.WriteLine('@@RESULT@@' + ($rows | ConvertTo-Json -Compress -Depth 5))
`;

test('the worker accepts only the host answer naming its request and lease, and says how each hold ended', {
  skip: process.platform !== 'win32' && 'Windows only',
  timeout: 60_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-lease-worker-'));
  try {
    await writeFile(join(directory, 'lock.cs'), loadComputerSource('MixForegroundLock.cs'));
    await writeFile(join(directory, 'test.ps1'), SCRIPT);
    const { stdout } = await promisify(execFile)(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(directory, 'test.ps1')],
      {
        timeout: 45_000,
        windowsHide: true,
        env: { ...process.env, LOCK_SOURCE: join(directory, 'lock.cs'), REPLY_PREFIX: FOREGROUND_LOCK_REPLY_PREFIX },
      }
    );
    const lines = stdout.split(/\r?\n/);
    const rows = JSON.parse(lines.find((line) => line.startsWith('@@RESULT@@')).slice('@@RESULT@@'.length));
    const requests = lines
      .filter((line) => line.startsWith(FOREGROUND_LOCK_LINE_PREFIX))
      .map((line) => JSON.parse(line.slice(FOREGROUND_LOCK_LINE_PREFIX.length)));
    // Each request names the in-flight action, a fresh sequence and, for a release, the lease.
    assert.deepEqual(
      requests.map(({ op, action, seq, lease, hold_ms }) => [op, action, seq, lease ?? hold_ms]),
      [
        ['acquire', 7, 1, 100],
        ['release', 7, 1, 12],
        ['acquire', 7, 2, 100],
        ['release', 7, 2, 0],
        ['acquire', 7, 3, 100],
        ['release', 7, 3, 15],
        ['acquire', 7, 4, 100],
        ['release', 7, 4, 21],
      ]
    );
    assert.ok(requests.filter(({ op }) => op === 'acquire').every(({ answer_by }) => answer_by > 0));

    const { matching, unanswered, expired, own0, own1, own2, deadline } = rows;
    assert.deepEqual([matching.locked, matching.held, matching.facts.holder, matching.facts.lease], [true, true, 'host', 12]);
    assert.equal(matching.command, '{"id":7,"action":"snapshot"}');
    assert.deepEqual([matching.release, matching.again, matching.facts.host_answer], ['released', 'released', 'locked']);

    assert.deepEqual([unanswered.locked, unanswered.held, unanswered.release], [false, false, 'no_ack']);
    assert.deepEqual([unanswered.facts.host_answer, unanswered.facts.holder], ['no_answer', 'none']);

    assert.deepEqual([expired.locked, expired.facts.host_answer, expired.release], [false, 'expired_on_arrival', 'released']);

    assert.deepEqual([own0.locked, own0.release, own0.facts.holder], [true, 'released', 'worker']);
    assert.deepEqual([own1.release, own1.facts.unlock_attempts], ['unknown', 3]);
    assert.deepEqual([own2.release, own2.facts.unlock_attempts], ['failed', 3]);
    assert.deepEqual([deadline.locked, deadline.held, deadline.release, deadline.facts.released_by], [true, false, 'released', 'deadline']);

    // A false unlock ends the worker's own hold (reported unknown), so the next
    // request refused its own lock gets the host lease instead of already_held.
    const { afterFalse } = rows;
    assert.deepEqual(
      [afterFalse.release, afterFalse.locked, afterFalse.facts.holder, afterFalse.facts.lease, afterFalse.hostRelease],
      ['unknown', true, 'host', 21, 'released']
    );
    assert.equal(afterFalse.facts.stale_release, undefined);
    // After an unlock call throws (failed), each later Release retries until one succeeds.
    assert.deepEqual([rows.retry.first, rows.retry.second, rows.retry.third], ['failed', 'released', 'released']);
    // The next request retries the unlock first, on the request that held it.
    const { nextRequest, stillOpen } = rows;
    assert.deepEqual(
      [nextRequest.failed, nextRequest.retried, nextRequest.oldRelease, nextRequest.oldBy, nextRequest.locked, nextRequest.release],
      ['failed', 1, 'released', 'retry', true, 'released']
    );
    // Unproven and not superseded by a granted lock: nothing new starts.
    assert.deepEqual(
      [stillOpen.locked, stillOpen.facts.worker_error, stillOpen.facts.stale_release],
      [false, 'already_held', 'failed']
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
