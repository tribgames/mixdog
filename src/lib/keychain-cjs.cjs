'use strict';

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { resolvePluginData } = require('./plugin-paths.cjs');

const SERVICE = 'mixdog';
// Shared bound for every synchronous keychain backend (DPAPI/PowerShell on
// Windows, security(1) on macOS). A single env override keeps them consistent.
const KEYCHAIN_TIMEOUT_MS = Number(process.env.MIXDOG_KEYCHAIN_TIMEOUT_MS || 15000);
const POWERSHELL_TIMEOUT_MS = KEYCHAIN_TIMEOUT_MS;

// ---------------------------------------------------------------------------
// getSecret read cache — collapse repeated reads during a turn while bounding
// cross-process staleness. Misses are never cached, so a token saved by another
// process becomes visible immediately; hits expire so rotations are observed.
// ---------------------------------------------------------------------------
const KEYCHAIN_CACHE_TTL_MS = (() => {
    const value = Number(process.env.MIXDOG_KEYCHAIN_CACHE_TTL_MS);
    return Number.isFinite(value) && value >= 0 ? value : 30000;
})();
/** @type {Map<string, {value: string, expiresAt: number}>} */
const _secretCache = new Map();

function _cacheGet(account) {
    const key = `${SERVICE}\0${account}`;
    const entry = _secretCache.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
        _secretCache.delete(key);
        return undefined;
    }
    return entry.value;
}

function _cacheSet(account, value) {
    if (value == null || KEYCHAIN_CACHE_TTL_MS === 0) return;
    _secretCache.set(`${SERVICE}\0${account}`, {
        value,
        expiresAt: Date.now() + KEYCHAIN_CACHE_TTL_MS,
    });
}

function _cacheInvalidate(account) {
    _secretCache.delete(`${SERVICE}\0${account}`);
}

function invalidateSecretCache(account) {
    if (account == null) {
        _secretCache.clear();
        return;
    }
    _cacheInvalidate(account);
}

// CommonJS module: cannot import the ESM src/shared/wsl.mjs, so inline an
// equivalent WSL check (process.platform reports 'linux' inside WSL).
function isWSL() {
    if (process.platform !== 'linux') return false;
    if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) return true;
    try { return /microsoft|wsl/i.test(fs.readFileSync('/proc/version', 'utf8')); }
    catch { return false; }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function platform() {
    return process.platform;
}

function run(cmd, args, opts) {
    // windowsHide + stdio:['ignore','pipe','pipe'] keeps powershell.exe
    // consoleless during DPAPI ops. Without these flags every keychain
    // read/write flashes a conhost window: setup-html's loaders call
    // /agent/config and /memory/auth, and each credential probe can trigger
    // one powershell.exe spawn — users saw 8-15 console flashes during
    // config-UI page load.
    // Default opts go BEFORE the spread so callers can still override.
    const result = spawnSync(cmd, args, {
        encoding: 'utf8',
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        ...opts,
    });
    return result;
}

// PS 5.1(powershell.exe) first: pwsh(PS 7) does not auto-load ProtectedData assembly,
// so DPAPI calls silently fail there. Windows always ships powershell.exe.
function powershell(script) {
    // Bound DPAPI PowerShell calls with a timeout: a hung powershell.exe
    // (AV scan stall, profile loader, transient cert chain lookup) would
    // otherwise block hook/server callers synchronously. The default is long
    // enough for cold PowerShell startup on Windows without silently dropping
    // setup UI credential saves.
    // Resolve powershell.exe to its deterministic System32 location rather than
    // a PATH lookup, so a shadow `powershell.exe` earlier in PATH cannot hijack
    // secret encryption/decryption. (pwsh/PS7 is intentionally not used: it does
    // not auto-load the ProtectedData assembly, so DPAPI silently fails there.)
    const _sysRoot = process.env.SystemRoot || process.env.windir;
    if (!_sysRoot) {
        throw new Error('[keychain] cannot resolve SystemRoot to locate powershell.exe for DPAPI');
    }
    const _psHosts = [path.join(_sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')];
    let timedOut = null;
    for (const exe of _psHosts) {
        const r = run(exe, ['-NonInteractive', '-NoProfile', '-Command', script], { timeout: POWERSHELL_TIMEOUT_MS });
        if (r.error && r.error.code === 'ENOENT') continue;
        if (r.error && r.error.code === 'ETIMEDOUT') {
            timedOut = { exe, timeoutMs: POWERSHELL_TIMEOUT_MS };
            continue;
        }
        return r;
    }
    if (timedOut) {
        throw new Error(`[keychain] PowerShell DPAPI command timed out after ${timedOut.timeoutMs}ms (last host: ${timedOut.exe})`);
    }
    const err = new Error('[keychain] PowerShell not found (tried powershell, pwsh)');
    throw err;
}

function secretsDir() {
    return path.join(resolvePluginData(), 'secrets');
}

function dpApiFile(account) {
    return path.join(secretsDir(), account + '.dpapi');
}

// ---------------------------------------------------------------------------
// darwin — security(1)
// ---------------------------------------------------------------------------

// Bound security(1) calls so a stuck Keychain prompt (locked keychain, GUI
// unlock dialog with no display) cannot block hook/server callers forever —
// matching the Windows DPAPI and Linux keytar timeouts.
function darwinRun(args) {
    const r = run('security', args, { timeout: KEYCHAIN_TIMEOUT_MS });
    if (r.error && r.error.code === 'ETIMEDOUT') {
        throw new Error(`[keychain] security command timed out after ${KEYCHAIN_TIMEOUT_MS}ms`);
    }
    return r;
}

function darwinGet(account) {
    const r = darwinRun(['find-generic-password', '-a', account, '-s', SERVICE, '-w']);
    if (r.status !== 0) return null;
    return r.stdout.trimEnd();
}

function darwinSet(account, value) {
    const r = darwinRun(['add-generic-password', '-a', account, '-s', SERVICE, '-w', value, '-U']);
    if (r.status !== 0) throw new Error(`[keychain] security set failed: ${r.stderr || r.stdout}`);
}

function darwinDelete(account) {
    const r = darwinRun(['delete-generic-password', '-a', account, '-s', SERVICE]);
    if (r.status !== 0) throw new Error(`[keychain] security delete failed: ${r.stderr || r.stdout}`);
}

// ---------------------------------------------------------------------------
// linux/WSL — keytar (libsecret binding, optionalDependency)
// ---------------------------------------------------------------------------
// keytar must be installed: npm install keytar (requires libsecret-dev on
// Debian/Ubuntu, or libsecret on other distros). If not installed, every
// call throws immediately — silent credential loss is not permitted.

let _keytarMod = null;
function loadKeytar() {
    if (_keytarMod !== null) return _keytarMod;
    try { _keytarMod = require('keytar'); }
    catch {
        throw new Error(
            '[keychain] keytar is not installed — run: npm install keytar\n' +
            '  Requires libsecret-dev (Debian/Ubuntu) or libsecret (other distros).\n' +
            '  Cannot access credentials on this platform without it.' +
            (isWSL()
                ? '\n  Detected WSL: there is usually no Secret Service here; ' +
                  'set the relevant MIXDOG_*/PROVIDER_API_KEY env var instead.'
                : '')
        );
    }
    return _keytarMod;
}

// keytar is Promise-based; bridge to sync via spawnSync of a child Node process.
// Avoids Atomics.wait on main thread (which hangs when SAB is not forwarded to worker).
function keytarSync(method, ...args) {
    loadKeytar(); // throws if not installed — before spawning child
    const { spawnSync } = require('child_process');
    // Pass service/account/value via stdin (not env) to avoid shell injection
    // and to keep secret values out of /proc/<pid>/environ on Linux.
    // Build a minimal child env instead of spreading process.env: the parent
    // may hold *_API_KEY secrets in its own environment, and those would
    // otherwise be visible via /proc/<pid>/environ for the lifetime of this
    // child. Only pass what PATH resolution / locale / the libsecret D-Bus
    // session bridge actually need.
    const passthroughKeys = [
        'PATH', 'HOME', 'USER', 'LOGNAME',
        'LANG', 'LC_ALL',
        'TMPDIR', 'TMP', 'TEMP',
        'DISPLAY', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR', 'XDG_CURRENT_DESKTOP', 'XDG_DATA_DIRS',
    ];
    const env = { _KEYTAR_METHOD: method };
    for (const key of passthroughKeys) {
        if (process.env[key] !== undefined) env[key] = process.env[key];
    }
    const script = [
        'const kt = require("keytar");',
        'const method = process.env._KEYTAR_METHOD;',
        'let input = "";',
        'process.stdin.setEncoding("utf8");',
        'process.stdin.on("data", (chunk) => { input += chunk; });',
        'process.stdin.on("end", () => {',
        '  const args = JSON.parse(input);',
        '  kt[method](...args)',
        '    .then(v => { process.stdout.write(JSON.stringify({ ok: true, value: v })); })',
        '    .catch(e => { process.stdout.write(JSON.stringify({ ok: false, error: e.message })); });',
        '});',
    ].join(' ');
    const r = spawnSync(process.execPath, ['-e', script], {
        env,
        input: JSON.stringify(args),
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 5000,
        encoding: 'utf8',
        windowsHide: true,
    });
    if (r.error) throw new Error(`[keychain] keytar.${method} spawnSync failed: ${r.error.message}`);
    if (r.status !== 0) {
        const detail = (r.stderr || '').trim() || `exit ${r.status}`;
        throw new Error(`[keychain] keytar.${method} child exited with error: ${detail}`);
    }
    let parsed;
    try { parsed = JSON.parse(r.stdout); } catch {
        throw new Error(`[keychain] keytar.${method} child returned unparseable output: ${String(r.stdout).slice(0, 200)}`);
    }
    if (!parsed.ok) throw new Error(`[keychain] keytar.${method} failed: ${parsed.error}`);
    return parsed.value ?? null;
}

function linuxGet(account) {
    return keytarSync('getPassword', SERVICE, account);
}

function linuxSet(account, value) {
    keytarSync('setPassword', SERVICE, account, value);
}

function linuxDelete(account) {
    keytarSync('deletePassword', SERVICE, account);
}

// ---------------------------------------------------------------------------
// win32 — DPAPI via PowerShell
// ---------------------------------------------------------------------------

// Add-Type loads System.Security on PS 5.1 hosts where the assembly is not
// auto-loaded — ProtectedData/DataProtectionScope resolve to TypeNotFound
// otherwise, and the host returns exit 0 with empty stdout, which then falls
// through win32Set's empty-output guard. PS 7+ already has the type loaded;
// SilentlyContinue covers the benign "already loaded" case on repeat calls.
const PS_PROTECT = [
    'Add-Type -AssemblyName System.Security -ErrorAction SilentlyContinue;',
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;',
    '$value = $args[0];',
    '$bytes = [System.Text.Encoding]::UTF8.GetBytes($value);',
    '$scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser;',
    '$enc = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, $scope);',
    '[Convert]::ToBase64String($enc)',
].join(' ');

const PS_UNPROTECT = [
    'Add-Type -AssemblyName System.Security -ErrorAction SilentlyContinue;',
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;',
    '$b64 = $args[0];',
    '$enc = [Convert]::FromBase64String($b64);',
    '$scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser;',
    '$dec = [System.Security.Cryptography.ProtectedData]::Unprotect($enc, $null, $scope);',
    '[System.Text.Encoding]::UTF8.GetString($dec)',
].join(' ');

function win32Get(account) {
    const file = dpApiFile(account);
    if (!fs.existsSync(file)) return null;
    const b64 = fs.readFileSync(file, 'utf8').trim();
    if (!b64) throw new Error(`[keychain] DPAPI ciphertext file is empty: ${file}`);
    const r = powershell(`& { ${PS_UNPROTECT} } '${b64}'`);
    if (r.status !== 0) throw new Error(`[keychain] DPAPI decrypt failed (exit ${r.status}): ${r.stderr || r.stdout}`);
    const out = (r.stdout || '').trim();
    if (!out) throw new Error(`[keychain] DPAPI decrypt returned empty output (stderr: ${(r.stderr || '').trim()})`);
    return out;
}

function win32Set(account, value) {
    const dir = secretsDir();
    fs.mkdirSync(dir, { recursive: true });
    // Pass value as a PS argument via -Command inline to avoid shell injection;
    // value is embedded as a PS single-quoted string literal with ' escaped.
    const escaped = value.replace(/'/g, "''");
    const r = powershell(`& { ${PS_PROTECT} } '${escaped}'`);
    if (r.status !== 0) throw new Error(`[keychain] DPAPI encrypt failed (exit ${r.status}): ${r.stderr || r.stdout}`);
    const out = (r.stdout || '').trim();
    if (!out) throw new Error(`[keychain] DPAPI encrypt returned empty output (stderr: ${(r.stderr || '').trim()})`);
    fs.writeFileSync(dpApiFile(account), out, 'utf8');
}

function win32Delete(account) {
    const file = dpApiFile(account);
    if (!fs.existsSync(file)) throw new Error(`[keychain] secret not found: ${account}`);
    fs.unlinkSync(file);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function getSecret(account) {
    const cached = _cacheGet(account);
    if (cached !== undefined) return cached;
    let value;
    switch (platform()) {
        case 'darwin': value = darwinGet(account); break;
        case 'linux':  value = linuxGet(account); break;
        case 'win32':  value = win32Get(account); break;
        default: throw new Error(`[keychain] unsupported platform: ${process.platform}`);
    }
    _cacheSet(account, value);
    return value;
}

function hasSecret(account) {
    const cached = _cacheGet(account);
    if (cached !== undefined) return cached != null;
    if (platform() === 'win32') return fs.existsSync(dpApiFile(account));
    try { return getSecret(account) != null; }
    catch { return false; }
}

function setSecret(account, value) {
    try {
        switch (platform()) {
            case 'darwin': darwinSet(account, value); break;
            case 'linux':  linuxSet(account, value); break;
            case 'win32':  win32Set(account, value); break;
            default: throw new Error(`[keychain] unsupported platform: ${process.platform}`);
        }
    } finally {
        _cacheInvalidate(account);
    }
}

function deleteSecret(account) {
    try {
        switch (platform()) {
            case 'darwin': darwinDelete(account); break;
            case 'linux':  linuxDelete(account); break;
            case 'win32':  win32Delete(account); break;
            default: throw new Error(`[keychain] unsupported platform: ${process.platform}`);
        }
    } finally {
        _cacheInvalidate(account);
    }
}

module.exports = { getSecret, setSecret, deleteSecret, hasSecret, invalidateSecretCache, SERVICE };
