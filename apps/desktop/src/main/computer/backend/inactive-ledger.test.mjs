import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import test from 'node:test';
import { MIXDOG_HOST_CSHARP } from './native-source.ts';
import { INACTIVE_LEDGER_RECOVERY_PROGRAM } from './program.ts';

const exec = promisify(execFile);
const STYLE_MEMBERS = `
[DllImport("user32.dll")] public static extern int GetWindowLongW(IntPtr h, int i);
[DllImport("user32.dll")] public static extern int SetWindowLongW(IntPtr h, int i, int v);`;
const NOACTIVATE = 0x08000000;

function firstLine(child, pattern) {
  return new Promise((resolve, reject) => {
    let text = '';
    child.stdout.on('data', (chunk) => {
      text += chunk;
      const match = text.match(pattern);
      if (match) resolve(match);
    });
    child.once('exit', () => reject(new Error(`exited before ${pattern}: ${text}`)));
  });
}

function powershell(script, env) {
  return exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    windowsHide: true,
    timeout: 120_000,
    env: { ...process.env, ...env },
  });
}

async function style(handle) {
  const { stdout } = await powershell(
    `Add-Type -Namespace T -Name W -MemberDefinition '${STYLE_MEMBERS}'; [Console]::Out.WriteLine([T.W]::GetWindowLongW([IntPtr]${handle}, -20))`
  );
  return Number(stdout.trim());
}

test('inactive ledger survives a killed worker and recovery clears only matching roots', {
  skip: process.platform !== 'win32' && 'Windows only',
  timeout: 240_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-inactive-ledger-'));
  const stopPath = join(directory, 'stop');
  const ledger = join(directory, 'worker.ledger');
  let owner;
  let worker;
  try {
    await writeFile(join(directory, 'native.cs'), MIXDOG_HOST_CSHARP);
    // The window's owner is a separate process that keeps pumping messages.
    owner = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Add-Type -AssemblyName System.Windows.Forms
$f = New-Object System.Windows.Forms.Form
$f.Show()
[Console]::Out.WriteLine('handle=' + $f.Handle.ToInt64())
while (-not (Test-Path $env:STOP_PATH)) { [System.Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 50 }`,
      ],
      { windowsHide: true, env: { ...process.env, STOP_PATH: stopPath } }
    );
    const handle = (await firstLine(owner, /handle=(\d+)/))[1];

    // The "worker" journals and sets the bit, then is killed without cleanup.
    worker = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName Accessibility
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies @('System.dll','System.Core.dll','System.Drawing.dll',[Accessibility.IAccessible].Assembly.Location) -TypeDefinition ([IO.File]::ReadAllText((Join-Path $env:AUDIT_DIRECTORY 'native.cs')))
Add-Type -Namespace T -Name W -MemberDefinition '${STYLE_MEMBERS}'
$h = [IntPtr]${handle}
[MixWin32]::LedgerAdd($h)
[void][T.W]::SetWindowLongW($h, -20, [T.W]::GetWindowLongW($h, -20) -bor ${NOACTIVATE})
[Console]::Out.WriteLine('added')
Start-Sleep -Seconds 600`,
      ],
      {
        windowsHide: true,
        env: { ...process.env, AUDIT_DIRECTORY: directory, MIXDOG_COMPUTER_INACTIVE_LEDGER: ledger },
      }
    );
    await firstLine(worker, /added/);
    worker.kill();
    await new Promise((resolve) => (worker.exitCode !== null ? resolve() : worker.once('exit', resolve)));

    assert.ok(existsSync(ledger), 'ledger persisted past the kill');
    assert.notEqual((await style(handle)) & NOACTIVATE, 0);

    const recorded = await readFile(ledger, 'utf8');
    const [kind, , pid, className] = recorded.trim().split('\t');
    assert.equal(kind, '+');

    // Identity mismatches (recycled handle) and released entries are skipped.
    const mismatched = join(directory, 'mismatch.ledger');
    const wrongClass = join(directory, 'class.ledger');
    const released = join(directory, 'released.ledger');
    const hex = Number(handle).toString(16);
    await writeFile(mismatched, `+\t${hex}\t${Number(pid) + 1}\t${className}\n`);
    await writeFile(wrongClass, `+\t${hex}\t${pid}\tOtherClass\n`);
    await writeFile(released, `+\t${hex}\t${pid}\t${className}\n-\t${hex}\t${pid}\t${className}\n`);
    await powershell(INACTIVE_LEDGER_RECOVERY_PROGRAM, {
      MIXDOG_ABORT_LEDGERS: [mismatched, wrongClass, released].join('|'),
    });
    assert.notEqual((await style(handle)) & NOACTIVATE, 0, 'skipped entries must not touch the window');
    assert.ok(!existsSync(mismatched) && !existsSync(wrongClass) && !existsSync(released));

    await powershell(INACTIVE_LEDGER_RECOVERY_PROGRAM, { MIXDOG_ABORT_LEDGERS: ledger });
    assert.equal((await style(handle)) & NOACTIVATE, 0);
    assert.ok(!existsSync(ledger));
  } finally {
    worker?.kill();
    await writeFile(stopPath, '');
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
});
