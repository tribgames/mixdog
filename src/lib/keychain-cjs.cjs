'use strict';

const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { resolvePluginData } = require('./plugin-paths.cjs');

const SERVICE = 'mixdog';
// Shared bound for every synchronous keychain backend (DPAPI/PowerShell on
// Windows, security(1) on macOS). A single env override keeps them consistent.
const KEYCHAIN_TIMEOUT_MS = Number(process.env.MIXDOG_KEYCHAIN_TIMEOUT_MS || 15000);
const POWERSHELL_TIMEOUT_MS = KEYCHAIN_TIMEOUT_MS;

// ---------------------------------------------------------------------------
// getSecret read cache — decrypted secrets stay resident for this process by
// default, avoiding repeated synchronous keychain subprocesses. An explicit
// finite TTL can bound cross-process staleness; 0 disables the cache.
// ---------------------------------------------------------------------------
const KEYCHAIN_CACHE_TTL_MS = (() => {
    const value = Number(process.env.MIXDOG_KEYCHAIN_CACHE_TTL_MS);
    return Number.isFinite(value) && value >= 0 ? value : Number.POSITIVE_INFINITY;
})();
/** @type {Map<string, {value: string, expiresAt: number}>} */
const _secretCache = new Map();
const _cacheGenerations = new Map();
let _cacheEpoch = 0;

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
        expiresAt: KEYCHAIN_CACHE_TTL_MS === Number.POSITIVE_INFINITY
            ? Number.POSITIVE_INFINITY
            : Date.now() + KEYCHAIN_CACHE_TTL_MS,
    });
}

function _cacheInvalidate(account) {
    _secretCache.delete(`${SERVICE}\0${account}`);
    _cacheGenerations.set(account, (_cacheGenerations.get(account) || 0) + 1);
}

function invalidateSecretCache(account) {
    if (account == null) {
        _secretCache.clear();
        _cacheGenerations.clear();
        _cacheEpoch += 1;
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
function resolvePowershellExe() {
    const sysRoot = process.env.SystemRoot || process.env.windir;
    if (!sysRoot) {
        throw new Error('[keychain] cannot resolve SystemRoot to locate powershell.exe for DPAPI');
    }
    return path.join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

function powershellEnv() {
    const env = {};
    for (const key of [
        'SystemRoot', 'windir', 'PATH', 'PATHEXT',
        'TEMP', 'TMP', 'USERPROFILE',
    ]) {
        if (process.env[key] !== undefined) env[key] = process.env[key];
    }
    return env;
}

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
    const exe = resolvePowershellExe();
    const profiled = /^(1|true|yes|on)$/i.test(String(process.env.MIXDOG_BOOT_PROFILE || ''));
    const startedAt = profiled ? Date.now() : 0;
    const r = run(exe, ['-NonInteractive', '-NoProfile', '-Command', script], { timeout: POWERSHELL_TIMEOUT_MS });
    if (profiled) {
        const caller = (new Error().stack || '').split('\n').slice(2, 5)
            .map((line) => line.trim().replace(/\s+/g, '_')).join('<-');
        try { process.stderr.write(`[mixdog-boot] keychain:sync-powershell ms=${Date.now() - startedAt} by=${caller}\n`); } catch {}
    }
    if (r.error && r.error.code === 'ETIMEDOUT') {
        throw new Error(`[keychain] PowerShell DPAPI command timed out after ${POWERSHELL_TIMEOUT_MS}ms (host: ${exe})`);
    }
    if (r.error && r.error.code === 'ENOENT') {
        throw new Error(`[keychain] PowerShell not found: ${exe}`);
    }
    return r;
}

function powershellAsync(script, input = null) {
    return new Promise((resolve) => {
        let child;
        try {
            child = spawn(
                resolvePowershellExe(),
                ['-NonInteractive', '-NoProfile', '-Command', script],
                {
                    env: powershellEnv(),
                    shell: false,
                    windowsHide: true,
                    stdio: [input == null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
                    timeout: POWERSHELL_TIMEOUT_MS,
                },
            );
        } catch (error) {
            resolve({ status: null, stdout: '', stderr: '', error });
            return;
        }

        let stdout = '';
        let stderr = '';
        let settled = false;
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        const finish = (status, error = null) => {
            if (settled) return;
            settled = true;
            resolve({ status, stdout, stderr, error });
        };
        child.once('error', (error) => finish(null, error));
        child.once('close', (status) => finish(status));
        if (input != null) {
            child.stdin.on('error', () => { /* child exited early — close() reports it */ });
            child.stdin.end(input);
        }
    });
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

// Batch DPAPI decrypt used by prewarmSecrets: ONE PowerShell host decrypts
// every ciphertext. Windows CreateProcess for powershell.exe is a SYNCHRONOUS
// multi-hundred-ms operation on the calling thread (AV scanning), so the old
// per-secret spawn fan-out froze the caller's event loop for N x spawn cost —
// observed as a ~5s desktop boot stall with near-zero CPU. Accounts and
// ciphertexts travel via stdin (never interpolated into the script); decrypted
// values return base64-wrapped so arbitrary secret bytes survive the pipe.
const PS_UNPROTECT_BATCH = [
    'Add-Type -AssemblyName System.Security -ErrorAction SilentlyContinue;',
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;',
    '$scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser;',
    'while (($line = [Console]::In.ReadLine()) -ne $null) {',
    '  $parts = $line.Split("|", 2);',
    '  if ($parts.Count -lt 2) { continue }',
    '  try {',
    '    $enc = [Convert]::FromBase64String($parts[1]);',
    '    $dec = [System.Security.Cryptography.ProtectedData]::Unprotect($enc, $null, $scope);',
    '    [Console]::Out.WriteLine($parts[0] + "|" + [Convert]::ToBase64String($dec));',
    '  } catch {}',
    '}',
].join(' ');

async function prewarmSecrets() {
    try {
        if (platform() !== 'win32' || KEYCHAIN_CACHE_TTL_MS === 0) return;
        const dir = secretsDir();
        const entries = await fs.promises.readdir(dir, { withFileTypes: true });
        const epoch = _cacheEpoch;
        const rows = [];
        for (const entry of entries) {
            if (!entry.isFile() || !entry.name.endsWith('.dpapi')) continue;
            const account = entry.name.slice(0, -'.dpapi'.length);
            try {
                const b64 = (await fs.promises.readFile(path.join(dir, entry.name), 'utf8')).trim();
                // Account names are filenames (no '|' on Windows) and ciphertexts
                // are base64 — the line protocol below stays unambiguous.
                if (b64) rows.push({ account, generation: _cacheGenerations.get(account) || 0, b64 });
            } catch {
                // Individual corrupt or deleted entries must not prevent the
                // remaining secrets from warming.
            }
        }
        if (rows.length === 0) return;
        const r = await powershellAsync(
            PS_UNPROTECT_BATCH,
            rows.map((row) => `${row.account}|${row.b64}`).join('\n') + '\n',
        );
        if (r.error || r.status !== 0) return;
        const generations = new Map(rows.map((row) => [row.account, row.generation]));
        for (const line of String(r.stdout || '').split(/\r?\n/)) {
            const separator = line.indexOf('|');
            if (separator <= 0) continue;
            const account = line.slice(0, separator);
            if (!generations.has(account)) continue;
            try {
                const value = Buffer.from(line.slice(separator + 1), 'base64').toString('utf8');
                if (!value) continue;
                if (_cacheEpoch !== epoch || (_cacheGenerations.get(account) || 0) !== generations.get(account)) continue;
                _cacheSet(account, value);
            } catch {
                // An undecodable row must not prevent the remaining secrets from warming.
            }
        }
    } catch {
        // Prewarming is an optional startup optimization and must never fail boot.
    }
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

module.exports = {
    getSecret,
    setSecret,
    deleteSecret,
    hasSecret,
    invalidateSecretCache,
    prewarmSecrets,
    SERVICE,
};
