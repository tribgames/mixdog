import { existsSync } from 'fs';
import { basename, delimiter, dirname, join } from 'path';

let _resolvedShell = null;
let _configuredShell = null;
// Per-kind cache for resolveShellFor(). 'default' aliases resolveShell()'s
// singleton; 'bash'/'powershell' get their own memoized slots. Misses receive
// a short TTL so a missing optional shell cannot rescan PATH for every tool
// call while a long-lived host can still discover a later installation.
const _resolvedShellByKind = new Map();
const SHELL_RESOLUTION_MISS_TTL_MS = 30_000;

export function setConfiguredShell(value = '') {
    const next = String(value || '').trim();
    _configuredShell = next || null;
    _resolvedShell = null;
    _resolvedShellByKind.clear();
}

function shellTypeFor(shell) {
    const stem = basename(String(shell || '')).toLowerCase().replace(/\.exe$/, '');
    if (stem === 'pwsh' || stem === 'powershell') return 'powershell';
    if (stem === 'bash' || stem === 'zsh' || stem === 'sh') return 'posix';
    return process.platform === 'win32' ? 'powershell' : 'posix';
}

function shellSpec(shell, shellType = shellTypeFor(shell)) {
    if (shellType === 'powershell') {
        // Deliberately NO `-WindowStyle Hidden` here: every spawn site passes
        // windowsHide:true (CREATE_NO_WINDOW), which suppresses the console at
        // the OS level without leaving a token on the command line. The CLI
        // switch is redundant AND matches Defender's node→hidden-PowerShell
        // dropper signature (Trojan:Win32/PowhidSubExec false positive).
        const psArgs = ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command'];
        return {
            shell,
            shellArg: '-Command',
            shellArgs: psArgs,
            shellType,
        };
    }
    return { shell, shellArg: '-c', shellArgs: ['-c'], shellType };
}

function allExistingPathsFromPath(commandName) {
    const rawPath = String(process.env.PATH || '');
    let cwd = '';
    try { cwd = process.cwd(); } catch {}
    const entries = [cwd, ...rawPath.split(delimiter)]
        .map((entry) => entry.trim().replace(/^"(.*)"$/, '$1'))
        .filter(Boolean);
    const seen = new Set();
    const matches = [];
    for (const entry of entries) {
        const candidate = join(entry, commandName);
        const key = process.platform === 'win32' ? candidate.toLowerCase() : candidate;
        if (seen.has(key)) continue;
        seen.add(key);
        if (existsSync(candidate)) matches.push(candidate);
    }
    return matches;
}

function firstExistingPathFromPath(commandName, excludeRe = null) {
    return allExistingPathsFromPath(commandName)
        .find((candidate) => !excludeRe || !excludeRe.test(candidate)) || null;
}

function resolveWindowsPowerShell() {
    const pwsh = firstExistingPathFromPath('pwsh.exe');
    if (pwsh) return shellSpec(pwsh, 'powershell');

    const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
    const bundled = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    if (existsSync(bundled)) return shellSpec(bundled, 'powershell');

    const powershell = firstExistingPathFromPath('powershell.exe');
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
    const explicit = _configuredShell || process.env.MIXDOG_SHELL;
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
    for (const git of allExistingPathsFromPath('git.exe')) {
        const bash = probeGitBashFromGitExe(git);
        if (bash) return shellSpec(bash, 'posix');
    }
    // Fallback: a bare `bash.exe` on PATH, but never the System32 WSL launcher.
    const bash = firstExistingPathFromPath('bash.exe', /\\system32\\/i);
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

// Kind-aware shell resolution. kind:
//
// Resolve a real bash on macOS/Linux. When 'bash' is explicitly requested we
// must NOT hand back /bin/sh, which on dash/ash distros is not bash and breaks
// bash-only syntax. Probe common install paths, then `bash` on PATH; only when
// nothing is found do we fall back to /bin/sh so a shell is still returned.
function resolvePosixBash() {
    for (const p of ['/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash', '/opt/homebrew/bin/bash']) {
        if (existsSync(p)) return shellSpec(p, 'posix');
    }
    const fromPath = firstExistingPathFromPath('bash');
    if (fromPath) return shellSpec(fromPath, 'posix');
    return shellSpec('/bin/sh', 'posix');
}

// Kind-aware shell resolution. kind:
//  'default'    → identical to resolveShell() (PowerShell on Windows, /bin/sh elsewhere).
//  'bash'       → on Windows, Git Bash (or null if not installed); elsewhere a real bash
//                 binary (/bin/bash, /usr/bin/bash, or `bash` on PATH), falling back to
//                 /bin/sh only when no bash exists (dash/ash distros break on bash syntax).
//  'powershell' → on Windows, resolveShell(); elsewhere pwsh if present, else null.
// Each kind is memoized independently. Successes remain stable for the process;
// misses expire quickly so installs/PATH changes remain discoverable.
export function resolveShellFor(kind = 'default') {
    if (kind == null || kind === 'default') return resolveShell();
    const cached = _resolvedShellByKind.get(kind);
    if (cached) {
        if (cached.spec || cached.expiresAt > Date.now()) return cached.spec;
        _resolvedShellByKind.delete(kind);
    }

    let spec = null;
    if (kind === 'bash') {
        spec = _isWindows() ? resolveWindowsGitBash() : resolvePosixBash();
    } else if (kind === 'powershell') {
        if (_isWindows()) {
            spec = resolveShell();
        } else {
            const pwsh = firstExistingPathFromPath('pwsh');
            spec = pwsh ? shellSpec(pwsh, 'powershell') : null;
        }
    } else {
        spec = resolveShell();
    }

    _resolvedShellByKind.set(kind, {
        spec,
        expiresAt: spec ? Number.POSITIVE_INFINITY : Date.now() + SHELL_RESOLUTION_MISS_TTL_MS,
    });
    return spec;
}
