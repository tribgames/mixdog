import assert from 'node:assert/strict';
import { readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
    killShellJob,
    startBackgroundShellJob,
    waitForShellJob,
} from '../src/runtime/agent/orchestrator/tools/builtin/shell-jobs.mjs';
import { shellJobDetailPath } from '../src/runtime/agent/orchestrator/tools/builtin/shell-job-paths.mjs';

function availablePowerShellHosts() {
    return ['powershell.exe', 'pwsh.exe'].filter((host) => {
        const result = spawnSync(host, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'], {
            encoding: 'utf8',
            windowsHide: true,
        });
        return !result.error && result.status === 0;
    });
}

const windowProbe = String.raw`
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public delegate bool MixdogEnumWindowsProc(IntPtr hWnd, IntPtr lParam);
public static class MixdogWindowProbe {
    [DllImport("user32.dll")] public static extern bool EnumWindows(MixdogEnumWindowsProc callback, IntPtr lParam);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder text, int maxCount);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
'@
$consoleWindowPids = @{}
$callback = [MixdogEnumWindowsProc] {
    param([IntPtr] $hWnd, [IntPtr] $lParam)
    $className = New-Object System.Text.StringBuilder 256
    [void] [MixdogWindowProbe]::GetClassName($hWnd, $className, $className.Capacity)
    if ($className.ToString() -eq 'ConsoleWindowClass') {
        [uint32] $pid = 0
        [void] [MixdogWindowProbe]::GetWindowThreadProcessId($hWnd, [ref] $pid)
        $consoleWindowPids[[string] $pid] = $true
    }
    return $true
}
[void] [MixdogWindowProbe]::EnumWindows($callback, [IntPtr]::Zero)
Get-CimInstance Win32_Process | ForEach-Object {
    Write-Output "P|$($_.ProcessId)|$($_.ParentProcessId)|$($_.Name)"
}
$consoleWindowPids.Keys | ForEach-Object { Write-Output "W|$_" }
`;

function processConsoleSnapshot(probeHost) {
    const result = spawnSync(probeHost, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', windowProbe], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 10_000,
    });
    if (result.error || result.status !== 0) {
        throw new Error(`Console window probe failed: ${result.error?.message || result.stderr || result.status}`);
    }
    const processes = new Map();
    const consoleWindowPids = new Set();
    for (const row of result.stdout.split(/\r?\n/)) {
        const [kind, pid, parentPid, name] = row.split('|');
        if (kind === 'P') processes.set(Number(pid), { parentPid: Number(parentPid), name });
        if (kind === 'W') consoleWindowPids.add(Number(pid));
    }
    return { processes, consoleWindowPids };
}

function processTreePids(processes, rootPid) {
    const tree = new Set([rootPid]);
    let changed = true;
    while (changed) {
        changed = false;
        for (const [pid, process] of processes) {
            if (!tree.has(pid) && tree.has(process.parentPid)) {
                tree.add(pid);
                changed = true;
            }
        }
    }
    return tree;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function removeJobArtifacts(detail) {
    for (const file of [
        shellJobDetailPath(detail.jobId),
        detail.stdoutPath,
        detail.stderrPath,
        detail.exitPath,
        detail.donePath,
        `${detail.exitPath}.cmd.ps1`,
        `${detail.exitPath}.user.ps1`,
    ]) {
        try { rmSync(file, { force: true }); } catch {}
    }
}

test('Windows PowerShell shell jobs create no conhost or ConsoleWindowClass window', async (t) => {
    if (process.platform !== 'win32') return t.skip('win32-only');
    const hosts = availablePowerShellHosts();
    if (hosts.length === 0) return t.skip('no PowerShell host installed');
    const workDir = mkdtempSync(join(tmpdir(), 'mixdog-shell-job-window-'));
    const probeHost = hosts[0];

    try {
        for (const shell of hosts) {
            const before = processConsoleSnapshot(probeHost);
            const job = startBackgroundShellJob({
                command: "Start-Sleep -Milliseconds 5000; Write-Output 'mixdog-window-probe-out'; [Console]::Error.WriteLine('mixdog-window-probe-err')",
                timeoutMs: 10_000,
                workDir,
                mergeStderr: false,
                spawnEnv: process.env,
                shell,
                shellType: 'powershell',
            });
            try {
                const newConsoleHosts = new Set();
                for (let i = 0; i < 8; i += 1) {
                    await sleep(100);
                    const snapshot = processConsoleSnapshot(probeHost);
                    const jobTree = processTreePids(snapshot.processes, job.pid);
                    // windowsHide may give the outer wrapper one hidden console
                    // (a direct child of job.pid). A second conhost belongs to
                    // Start-Process only when it is nested below that wrapper.
                    const isNestedJobConsole = (pid) => {
                        const process = snapshot.processes.get(pid);
                        return process && process.parentPid !== job.pid && jobTree.has(process.parentPid);
                    };
                    for (const [pid, process] of snapshot.processes) {
                        if (process.name?.toLowerCase() === 'conhost.exe'
                            && !before.processes.has(pid) && isNestedJobConsole(pid)) {
                            newConsoleHosts.add(`${pid}|conhost.exe|parent=${process.parentPid}`);
                        }
                    }
                    for (const pid of snapshot.consoleWindowPids) {
                        if (!before.consoleWindowPids.has(pid) && isNestedJobConsole(pid)) {
                            newConsoleHosts.add(`${pid}|ConsoleWindowClass`);
                        }
                    }
                }
                const detail = await waitForShellJob(job.jobId, { timeoutMs: 10_000, pollMs: 50 });
                assert.equal(detail?.exitCode, 0, `${shell} preserves the child exit code`);
                assert.equal(readFileSync(job.stdoutPath, 'utf8').trim(), 'mixdog-window-probe-out', `${shell} preserves stdout redirection`);
                assert.equal(readFileSync(job.stderrPath, 'utf8').trim(), 'mixdog-window-probe-err', `${shell} preserves stderr redirection`);
                assert.deepEqual([...newConsoleHosts], [], `${shell} created a console host/window in its process tree: ${[...newConsoleHosts].join(', ')}`);
            } finally {
                killShellJob(job.jobId);
                removeJobArtifacts(job);
            }
        }
    } finally {
        rmSync(workDir, { recursive: true, force: true });
    }
});
