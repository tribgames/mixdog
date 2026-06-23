import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { basename, dirname, join } from 'path';

let _resolvedShell = null;
// Per-kind cache for resolveShellFor(). 'default' aliases resolveShell()'s
// singleton; 'bash'/'powershell' get their own memoized slots. ONLY a
// successful (non-null) resolution is cached — a resolution MISS is
// deliberately not memoized so the next call re-probes (Git Bash / pwsh may
// be installed mid-session, and PATH can change for a long-lived host).
const _resolvedShellByKind = new Map();

function shellTypeFor(shell) {
    const stem = basename(String(shell || '')).toLowerCase().replace(/\.exe$/, '');
    if (stem === 'pwsh' || stem === 'powershell') return 'powershell';
    if (stem === 'bash' || stem === 'zsh' || stem === 'sh') return 'posix';
    return process.platform === 'win32' ? 'powershell' : 'posix';
}

function shellSpec(shell, shellType = shellTypeFor(shell)) {
    if (shellType === 'powershell') {
        // `-WindowStyle Hidden` is a Windows-only switch. PowerShell Core
        // (pwsh) on macOS/Linux rejects it, so only append it on win32.
        const psArgs = ['-NoLogo', '-NoProfile', '-NonInteractive'];
        if (process.platform === 'win32') psArgs.push('-WindowStyle', 'Hidden');
        psArgs.push('-Command');
        return {
            shell,
            shellArg: '-Command',
            shellArgs: psArgs,
            shellType,
        };
    }
    return { shell, shellArg: '-c', shellArgs: ['-c'], shellType };
}

function firstExistingPathFromWhere(commandName) {
    try {
        const r = spawnSync('cmd.exe', ['/d', '/s', '/c', `where ${commandName}`], {
            stdio: ['ignore', 'pipe', 'ignore'],
            windowsHide: true,
            timeout: 1000,
        });
        if (r.status !== 0 || !r.stdout) return null;
        const lines = r.stdout.toString('utf8').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
        return lines.find(p => existsSync(p)) || null;
    } catch {
        return null;
    }
}

function resolveWindowsPowerShell() {
    const pwsh = firstExistingPathFromWhere('pwsh.exe');
    if (pwsh) return shellSpec(pwsh, 'powershell');

    const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
    const bundled = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    if (existsSync(bundled)) return shellSpec(bundled, 'powershell');

    const powershell = firstExistingPathFromWhere('powershell.exe');
    if (powershell) return shellSpec(powershell, 'powershell');

    return shellSpec('powershell.exe', 'powershell');
}

export function resolveShell() {
    if (_resolvedShell) return _resolvedShell;
    // Gate on the actual platform, NOT WINDIR/SystemRoot env presence: under
    // WSL those vars can be inherited via interop while process.platform is
    // 'linux', and WSL must resolve /bin/sh — not Windows PowerShell.
    const isWindows = process.platform === 'win32';
    if (!isWindows) {
        _resolvedShell = shellSpec('/bin/sh', 'posix');
        return _resolvedShell;
    }
    const explicit = process.env.CLAUDE_CODE_SHELL;
    if (explicit && shellTypeFor(explicit) === 'powershell') {
        _resolvedShell = shellSpec(explicit);
        return _resolvedShell;
    }
    _resolvedShell = resolveWindowsPowerShell();
    return _resolvedShell;
}

function _isWindows() {
    // Real-platform check only (see resolveShell): env presence would make
    // WSL (process.platform 'linux') mis-resolve to Windows Git Bash.
    return process.platform === 'win32';
}

// Resolve Git Bash on Windows. Strategy (invariant-based, no silent fallback):
//  1. Iterate ALL `where git.exe` hits — a shim (Scoop/Chocolatey/winget under
//     a \shims\ dir) or a second install can be the FIRST match yet not a real
//     Git-for-Windows layout with a sibling bash.exe. For each, walk a few
//     ancestor levels of <gitDir> and probe the two known launcher shapes
//     (<root>\bin\bash.exe, <root>\usr\bin\bash.exe). This tolerates git.exe
//     living under cmd\, bin\, or mingw64\bin\ without a fixed sibling distance.
//  2. `where bash.exe` EXCLUDING any hit under System32 — that path is the WSL
//     `bash.exe` launcher, which is the wrong target (launches a Linux distro,
//     not Git-for-Windows bash).
// Returns a posix shellSpec, or null when Git Bash is genuinely not installed.
function resolveWindowsGitBash() {
    for (const git of allExistingPathsFromWhere('git.exe')) {
        const bash = probeGitBashFromGitExe(git);
        if (bash) return shellSpec(bash, 'posix');
    }
    // Fallback: a bare `bash.exe` on PATH, but never the System32 WSL launcher.
    const bash = firstExistingPathFromWhereExcluding('bash.exe', /\\system32\\/i);
    if (bash) return shellSpec(bash, 'posix');
    // Final fallback: probe well-known Git-for-Windows install roots on the
    // filesystem directly. PATH-independent and spawn-free, so it still resolves
    // when a long-lived server process inherited an env without Git\cmd, or when
    // the `where` probe times out (both observed in practice). Windows-only:
    // this function is reached solely via the _isWindows() branch in
    // resolveShellFor, so the hardcoded Windows paths never run on other OSes.
    const direct = gitBashFromKnownWindowsRoots();
    if (direct) return shellSpec(direct, 'posix');
    return null;
}

// Probe standard Git-for-Windows install roots via the filesystem only.
// Env-var roots first (machine ProgramFiles + per-user LOCALAPPDATA installs),
// then fixed Program Files fallbacks for the rare case those vars are empty.
function gitBashFromKnownWindowsRoots() {
    const env = process.env;
    const roots = [];
    for (const base of [env.ProgramW6432, env.ProgramFiles, env['ProgramFiles(x86)']]) {
        if (base) roots.push(join(base, 'Git'));
    }
    if (env.LOCALAPPDATA) roots.push(join(env.LOCALAPPDATA, 'Programs', 'Git'));
    roots.push('C:\\Program Files\\Git', 'C:\\Program Files (x86)\\Git');
    for (const root of roots) {
        for (const rel of [['bin', 'bash.exe'], ['usr', 'bin', 'bash.exe']]) {
            const cand = join(root, ...rel);
            if (existsSync(cand)) return cand;
        }
    }
    return null;
}

// Walk up to 3 ancestor levels from <gitExe>'s directory, probing each
// candidate install root for bin\bash.exe then usr\bin\bash.exe. Covers
// git.exe under <root>\cmd\, <root>\bin\, and <root>\mingw64\bin\.
function probeGitBashFromGitExe(gitExe) {
    let dir = dirname(gitExe);
    for (let level = 0; level < 3 && dir; level++) {
        for (const rel of [['bin', 'bash.exe'], ['usr', 'bin', 'bash.exe']]) {
            const cand = join(dir, ...rel);
            if (existsSync(cand)) return cand;
        }
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return null;
}

function allExistingPathsFromWhere(commandName) {
    try {
        const r = spawnSync('cmd.exe', ['/d', '/s', '/c', `where ${commandName}`], {
            stdio: ['ignore', 'pipe', 'ignore'],
            windowsHide: true,
            timeout: 1000,
        });
        if (r.status !== 0 || !r.stdout) return [];
        return r.stdout.toString('utf8').split(/\r?\n/).map(s => s.trim())
            .filter(Boolean).filter(p => existsSync(p));
    } catch {
        return [];
    }
}

function firstExistingPathFromWhereExcluding(commandName, excludeRe) {
    try {
        const r = spawnSync('cmd.exe', ['/d', '/s', '/c', `where ${commandName}`], {
            stdio: ['ignore', 'pipe', 'ignore'],
            windowsHide: true,
            timeout: 1000,
        });
        if (r.status !== 0 || !r.stdout) return null;
        const lines = r.stdout.toString('utf8').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
        return lines.find(p => existsSync(p) && !excludeRe.test(p)) || null;
    } catch {
        return null;
    }
}

// Kind-aware shell resolution. kind:
//  'default'    → identical to resolveShell() (PowerShell on Windows, /bin/sh elsewhere).
//  'bash'       → on Windows, Git Bash (or null if not installed); elsewhere /bin/sh (POSIX is already bash-compatible).
//  'powershell' → on Windows, resolveShell(); elsewhere pwsh if present, else null.
// Each kind is memoized independently, but ONLY on success: a resolution miss
// (null) is not cached, so the caller's clear-error path is re-probed on the
// next call rather than pinned for the life of the process.
export function resolveShellFor(kind = 'default') {
    if (kind == null || kind === 'default') return resolveShell();
    if (_resolvedShellByKind.has(kind)) return _resolvedShellByKind.get(kind);

    let spec = null;
    if (kind === 'bash') {
        spec = _isWindows() ? resolveWindowsGitBash() : shellSpec('/bin/sh', 'posix');
    } else if (kind === 'powershell') {
        if (_isWindows()) {
            spec = resolveShell();
        } else {
            const pwsh = (() => {
                try {
                    const r = spawnSync('which', ['pwsh'], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 1000 });
                    if (r.status !== 0 || !r.stdout) return null;
                    const p = r.stdout.toString('utf8').split(/\r?\n/).map(s => s.trim()).find(Boolean);
                    return p && existsSync(p) ? p : null;
                } catch { return null; }
            })();
            spec = pwsh ? shellSpec(pwsh, 'powershell') : null;
        }
    } else {
        spec = resolveShell();
    }

    // Cache positively only — see the _resolvedShellByKind / doc comments above.
    if (spec) _resolvedShellByKind.set(kind, spec);
    return spec;
}
