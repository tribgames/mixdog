import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createWorkerPool } from './worker-pool.ts';

test('retiring a host worker releases its session and process', {
  skip: process.platform !== 'win32' && 'Windows only',
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-computer-worker-pool-'));
  const retiredSessions = [];
  const pool = createWorkerPool({
    dataDirectory: () => directory,
    isBridgeEnabled: () => false,
    isDisposed: () => false,
    onSessionRetired: (sessionId) => {
      retiredSessions.push(sessionId);
    },
  });
  try {
    const child = pool.ensurePowerShell('warm-up-race');
    const exited = Promise.race([once(child, 'exit'), once(child, 'error')]);
    pool.retirePowerShell(child, new Error('bridge disabled during warm-up'));
    assert.equal(pool.powerShellBySession.has('warm-up-race'), false);
    assert.deepEqual(retiredSessions, ['warm-up-race']);
    let timeout;
    try {
      await Promise.race([
        exited,
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error('retired computer host worker did not exit')), 5_000);
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
  } finally {
    pool.removeHostScript();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a per-command timeout retires a stuck provider instead of waiting for the global ceiling', {
  skip: process.platform !== 'win32' && 'Windows only',
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-computer-worker-timeout-'));
  const pool = createWorkerPool({
    dataDirectory: () => directory,
    isBridgeEnabled: () => false,
    isDisposed: () => false,
  });
  try {
    await assert.rejects(
      pool.callPowerShell(
        {
          action: 'wait',
          duration: 1,
          session_id: 'provider-timeout',
          read_only: true,
        },
        100
      ),
      /computer_command_timeout: command exceeded 100ms/
    );
    assert.equal(pool.powerShellBySession.has('provider-timeout'), false);
  } finally {
    pool.removeHostScript();
    await rm(directory, { recursive: true, force: true });
  }
});

// A window whose accessibility provider answers every WM_GETOBJECT four seconds
// late; it never takes the foreground and closes itself after 30 s.
const SLOW_PROVIDER_FIXTURE = `
using System;
using System.Windows.Forms;
internal sealed class SlowProviderForm : Form {
  protected override bool ShowWithoutActivation { get { return true; } }
  protected override void WndProc(ref Message m) {
    if (m.Msg == 0x003D) System.Threading.Thread.Sleep(4000);
    base.WndProc(ref m);
  }
}
internal static class SlowProviderFixture {
  [STAThread]
  private static void Main(string[] args) {
    SlowProviderForm form = new SlowProviderForm {
      Text = "Mixdog Slow Provider Fixture",
      ShowInTaskbar = false,
      StartPosition = FormStartPosition.Manual,
      Left = 0, Top = 0, Width = 240, Height = 140
    };
    form.Controls.Add(new Button { Text = "Slow", Left = 10, Top = 10 });
    Timer lifetime = new Timer { Interval = 30000 };
    lifetime.Tick += delegate { lifetime.Stop(); form.Close(); };
    form.Shown += delegate {
      System.IO.File.WriteAllText(args[0], form.Handle.ToInt64().ToString("x"));
      lifetime.Start();
    };
    Application.Run(form);
  }
}
`;

/** Runs `body` against a warmed session worker and the slow provider window,
 *  then closes the window and every worker it started. `patchHost` rewrites
 *  the published host program before a worker runs it. */
async function withSlowProvider(patchHost, body) {
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-computer-slow-provider-'));
  const pool = createWorkerPool({
    dataDirectory: () => directory,
    isBridgeEnabled: () => false,
    isDisposed: () => false,
    spawnProcess: (command, args, options) => {
      if (!patchHost) return spawn(command, args, options);
      const original = args.at(-1);
      const patched = join(directory, 'patched-host.ps1');
      writeFileSync(patched, patchHost(readFileSync(original, 'utf8')));
      return spawn(command, [...args.slice(0, -1), patched], options);
    },
  });
  let fixture;
  let host;
  try {
    const source = join(directory, 'slow-provider.cs');
    const exe = join(directory, 'slow-provider.exe');
    const hwndFile = join(directory, 'slow-provider.hwnd');
    await writeFile(source, SLOW_PROVIDER_FIXTURE, 'utf8');
    execFileSync(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        "$ErrorActionPreference = 'Stop'; Add-Type -TypeDefinition ([IO.File]::ReadAllText($env:FIXTURE_SOURCE)) " +
          "-ReferencedAssemblies @('System.dll','System.Drawing.dll','System.Windows.Forms.dll') " +
          '-OutputAssembly $env:FIXTURE_OUTPUT -OutputType WindowsApplication',
      ],
      { windowsHide: true, stdio: 'pipe', env: { ...process.env, FIXTURE_SOURCE: source, FIXTURE_OUTPUT: exe } }
    );
    fixture = spawn(exe, [hwndFile], { stdio: 'ignore' });
    let hwnd = '';
    for (let attempt = 0; attempt < 100 && !hwnd; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      hwnd = await readFile(hwndFile, 'utf8').catch(() => '');
    }
    assert.ok(hwnd, 'the slow provider window opened');

    const session_id = 'slow-provider';
    // Start the worker outside the measured read.
    await pool.callPowerShell({ action: 'wait', duration: 0, session_id, read_only: true });
    host = pool.powerShellBySession.get(session_id);
    const snapshot = {
      action: 'snapshot',
      window_id: `hwnd:0x${hwnd.trim()}`,
      bounded: true,
      max_elements: 50,
      deadline_ms: 1_000,
      session_id,
      read_only: true,
    };
    await body({ pool, snapshot });
    const busy = await pool.callPowerShell(snapshot, 2_500);
    assert.match(busy.error, /^computer_command_timeout: an earlier abandoned accessibility read is still running/);
    const after = await pool.callPowerShell({ action: 'wait', duration: 0, session_id, read_only: true });
    assert.equal(after.ok, true);
    assert.equal(pool.powerShellBySession.get(session_id), host, 'the session keeps its input host');
    assert.equal(host.killed, false);
    assert.equal(host.exitCode, null);
  } finally {
    if (fixture) {
      const closed = fixture.exitCode === null ? once(fixture, 'exit') : Promise.resolve();
      fixture.kill();
      await closed;
    }
    // A host the timeout already retired is no longer mapped, but its exit
    // still releases the cached host assembly.
    for (const child of new Set([host, ...pool.powerShellBySession.values()].filter(Boolean))) {
      const exited = child.exitCode === null && child.signalCode === null ? once(child, 'exit') : Promise.resolve();
      pool.retirePowerShell(child, new Error('test cleanup'));
      await exited;
    }
    pool.removeHostScript();
    await rm(directory, { recursive: true, force: true });
  }
}

test("a slow accessibility provider abandons the read and keeps the session's input host", {
  skip: process.platform !== 'win32' && 'Windows only',
  timeout: 120_000,
}, async () => {
  await withSlowProvider(null, async ({ pool, snapshot }) => {
    const abandoned = await pool.callPowerShell(snapshot, 2_500);
    assert.equal(abandoned.ok, false);
    assert.match(
      abandoned.error,
      /^computer_command_timeout: accessibility read exceeded 1000ms during the element search; the read was abandoned/
    );
  });
});

test('a stalled enrichment after a fast element search spends only what is left of the same deadline', {
  skip: process.platform !== 'win32' && 'Windows only',
  timeout: 120_000,
}, async () => {
  // The element search answers after 600 ms with no candidates, so the read
  // goes on to MSAA enrichment, which the window stalls.
  const fastSearch = (program) => {
    const patched = program.replace(
      /\$uiaRead = \[MixBoundedUia\]::FindAll\([^\n]*\)/,
      () => 'Start-Sleep -Milliseconds 600; $uiaRead = [pscustomobject]@{ Root = $null; Elements = @() }'
    );
    assert.notEqual(patched, program, 'the element search was replaced');
    return patched;
  };
  await withSlowProvider(fastSearch, async ({ pool, snapshot }) => {
    const startedAt = performance.now();
    const abandoned = await pool.callPowerShell(snapshot, 2_500);
    const elapsed = performance.now() - startedAt;
    assert.equal(abandoned.ok, false);
    assert.match(
      abandoned.error,
      /^computer_command_timeout: accessibility read exceeded 1000ms during the MSAA enrichment; the read was abandoned/
    );
    // One budget: the search's 600 ms leave the enrichment about 400 ms, not a
    // fresh 1000 ms.
    assert.ok(elapsed < 1_450, `the read ended ${Math.round(elapsed)} ms after it began`);
  });
});

test('first use starts one native worker and never refills an unused spare', {
  skip: process.platform !== 'win32' && 'Windows only',
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-computer-worker-demand-'));
  const pool = createWorkerPool({
    dataDirectory: () => directory,
    isBridgeEnabled: () => true,
    isDisposed: () => false,
  });
  try {
    assert.deepEqual(pool.residentWorkerPids(), []);
    const warmed = pool.ensurePowerShell('first-use');
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(pool.ensurePowerShell('first-use'), warmed);
    assert.deepEqual(pool.residentWorkerPids(), [warmed.pid]);
    assert.equal(warmed.killed, false);
  } finally {
    for (const child of pool.powerShellBySession.values()) pool.retirePowerShell(child, new Error('test cleanup'));
    pool.removeHostScript();
    await rm(directory, { recursive: true, force: true });
  }
});
