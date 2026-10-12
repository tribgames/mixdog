'use strict';

const { spawn, spawnSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const { resolvePluginData } = require('./plugin-paths.cjs');

const SERVICE = 'mixdog';
// Shared bound for every synchronous keychain provider (DPAPI/PowerShell on
// Windows, security(1) on macOS, secret-tool on Linux). A single env override
// keeps them consistent.
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
// A desktop process can create several session runtimes, and the preload path
// also warms credentials before the first runtime exists. All callers share
// this one process-wide operation so Windows never launches duplicate batch
// DPAPI PowerShell hosts for the same startup.
let _prewarmPromise = null;

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
    expiresAt:
      KEYCHAIN_CACHE_TTL_MS === Number.POSITIVE_INFINITY
        ? Number.POSITIVE_INFINITY
        : Date.now() + KEYCHAIN_CACHE_TTL_MS,
  });
}

function _cacheInvalidate(account) {
  _secretCache.delete(`${SERVICE}\0${account}`);
  _cacheGenerations.set(account, (_cacheGenerations.get(account) || 0) + 1);
}

function invalidateSecretCache(account) {
  // Linux reads are cache-only after one snapshot: an external invalidation
  // means the snapshot may be stale, so the next read reloads it.
  if (process.platform === 'linux') {
    _linuxLoadedUntil = 0;
    _prewarmPromise = null;
  }
  if (account == null) {
    _secretCache.clear();
    _cacheGenerations.clear();
    _cacheEpoch += 1;
    return;
  }
  _cacheInvalidate(account);
}

// CommonJS module: cannot import the ESM src/runtime/shared/wsl.mjs, so inline an
// equivalent WSL check (process.platform reports 'linux' inside WSL).
function isWSL() {
  if (process.platform !== 'linux') return false;
  if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) return true;
  try {
    return /microsoft|wsl/i.test(fs.readFileSync('/proc/version', 'utf8'));
  } catch {
    return false;
  }
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
  return spawnSync(cmd, args, {
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts,
  });
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
  for (const key of ['SystemRoot', 'windir', 'PATH', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

function powershell(script, input = null) {
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
  const r = run(exe, ['-NonInteractive', '-NoProfile', '-Command', script], {
    timeout: POWERSHELL_TIMEOUT_MS,
    env: powershellEnv(),
    ...(input == null ? {} : { input, stdio: ['pipe', 'pipe', 'pipe'] }),
  });
  if (profiled) {
    const caller = (new Error().stack || '')
      .split('\n')
      .slice(2, 5)
      .map((line) => line.trim().replace(/\s+/g, '_'))
      .join('<-');
    try {
      process.stderr.write(`[mixdog-boot] keychain:sync-powershell ms=${Date.now() - startedAt} by=${caller}\n`);
    } catch {}
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
      child = spawn(resolvePowershellExe(), ['-NonInteractive', '-NoProfile', '-Command', script], {
        env: powershellEnv(),
        shell: false,
        windowsHide: true,
        stdio: [input == null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        timeout: POWERSHELL_TIMEOUT_MS,
      });
    } catch (error) {
      resolve({ status: null, stdout: '', stderr: '', error });
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    const finish = (status, error = null) => {
      if (settled) return;
      settled = true;
      resolve({ status, stdout, stderr, error });
    };
    child.once('error', (error) => finish(null, error));
    child.once('close', (status) => finish(status));
    if (input != null) {
      child.stdin.on('error', () => {
        /* child exited early — close() reports it */
      });
      child.stdin.end(input);
    }
  });
}

function secretsDir() {
  return path.join(resolvePluginData(), 'secrets');
}

function dpApiFile(account) {
  return path.join(secretsDir(), `${account}.dpapi`);
}

function writeOwnerOnlyAtomicSync(file, text) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temporary = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  let descriptor = null;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, String(text), 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(temporary, file);
    try {
      fs.chmodSync(file, 0o600);
    } catch {}
    try {
      const directoryDescriptor = fs.openSync(dir, 'r');
      try {
        fs.fsyncSync(directoryDescriptor);
      } finally {
        fs.closeSync(directoryDescriptor);
      }
    } catch {}
  } catch (error) {
    if (descriptor !== null) {
      try {
        fs.closeSync(descriptor);
      } catch {}
    }
    try {
      fs.rmSync(temporary, { force: true });
    } catch {}
    throw error;
  }
}

// ---------------------------------------------------------------------------
// darwin — security(1)
// ---------------------------------------------------------------------------

// Bound security(1) calls so a stuck Keychain prompt (locked keychain, GUI
// unlock dialog with no display) cannot block hook/server callers forever —
// matching the Windows DPAPI and Linux secret-tool timeouts.
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
// linux/WSL — secret-tool (libsecret's command line for the Secret Service)
// ---------------------------------------------------------------------------
// Items carry the attributes service=<SERVICE> account=<account>, the pair
// earlier keytar-based builds wrote, so credentials saved before stay
// readable. Without secret-tool or a running Secret Service every call throws
// with the fix: silent credential loss is not permitted.

function secretToolHint() {
  return (
    'install libsecret-tools (it provides secret-tool) and run a Secret Service provider such as ' +
    'gnome-keyring or KeePassXC, or set the relevant MIXDOG_*/PROVIDER_API_KEY environment variable instead' +
    (isWSL() ? ' (WSL usually has no Secret Service; the environment variable is the reliable route)' : '')
  );
}

// The secret travels on stdin, never argv or env. The child gets a minimal
// env instead of process.env: the parent may hold *_API_KEY secrets in its own
// environment, which would otherwise be visible via /proc/<pid>/environ for the
// lifetime of this child. Only PATH resolution, locale, and the libsecret
// D-Bus session bridge are passed through.
function secretToolEnv() {
  const passthroughKeys = [
    'PATH',
    'HOME',
    'USER',
    'LOGNAME',
    'LANG',
    'LC_ALL',
    'TMPDIR',
    'TMP',
    'TEMP',
    'DISPLAY',
    'DBUS_SESSION_BUS_ADDRESS',
    'XDG_RUNTIME_DIR',
    'XDG_CURRENT_DESKTOP',
    'XDG_DATA_DIRS',
  ];
  const env = {};
  for (const key of passthroughKeys) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

// Raw tool output (stderr) may carry paths or service internals; keep it out of
// user-facing errors and print it only when explicitly debugging. Secrets are
// never part of it: they travel on stdin only.
function keychainDebug(what, detail) {
  if (process.env.MIXDOG_KEYCHAIN_DEBUG) console.error(`[keychain:debug] ${what}: ${String(detail).slice(0, 500)}`);
}

function secretToolCheck(r) {
  if (r.error?.code === 'ENOENT') {
    throw new Error(
      '[keychain] secret-tool is not installed — install libsecret-tools (sudo apt install libsecret-tools), ' +
        'or set the relevant MIXDOG_*/PROVIDER_API_KEY environment variable instead'
    );
  }
  if (r.error?.code === 'ETIMEDOUT') {
    throw new Error(
      `[keychain] secret-tool timed out after ${r.error.timeoutMs || KEYCHAIN_TIMEOUT_MS}ms — the keyring is locked or its unlock prompt ` +
        'was not answered. Unlock your keyring (e.g. log in again or open Passwords and Keys) and retry.'
    );
  }
  if (r.error) {
    keychainDebug('secret-tool failed to start', r.error.message);
    throw new Error('[keychain] secret-tool could not be started — check that libsecret-tools is installed and a Secret Service is running');
  }
  return r;
}

function secretTool(args, input) {
  return secretToolCheck(
    spawnSync('secret-tool', args, {
      env: secretToolEnv(),
      input: input ?? '',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: KEYCHAIN_TIMEOUT_MS,
      encoding: 'utf8',
      windowsHide: true,
    })
  );
}

// Non-blocking variant: the daemon event loop keeps running while a locked
// keyring waits on its unlock prompt; the child is killed at the same bound.
function secretToolAsync(args, input, timeoutMs = KEYCHAIN_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn('secret-tool', args, {
        env: secretToolEnv(),
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
      });
    } catch (error) {
      reject(error);
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        resolve(secretToolCheck(r));
      } catch (error) {
        reject(error);
      }
    };
    const timer = setTimeout(() => {
      done({
        status: null,
        stdout,
        stderr,
        error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT', timeoutMs }),
      });
      try {
        child.kill('SIGKILL');
      } catch {}
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', (error) => done({ status: null, stdout, stderr, error }));
    child.once('close', (status) => done({ status, stdout, stderr, error: null }));
    child.stdin.on('error', () => {
      /* child exited early — close reports it */
    });
    child.stdin.end(input ?? '');
  });
}

// A missing item exits non-zero with nothing on stderr; anything on stderr is
// the Secret Service itself failing (no D-Bus session, locked collection).
function secretToolFailure(action, r) {
  const detail = (r.stderr || '').trim() || `exit ${r.status}`;
  // User-facing text is fixed; the raw tool output only goes to the debug log.
  keychainDebug(`secret-tool ${action} failed`, detail);
  if (/locked|denied|dismissed|cancel|not authori[sz]ed|IsLocked/i.test(detail)) {
    return new Error(
      `[keychain] secret-tool ${action} failed: the keyring is locked or the unlock prompt was declined. ` +
        'Unlock your keyring and retry.'
    );
  }
  return new Error(`[keychain] secret-tool ${action} failed — ${secretToolHint()}`);
}

function linuxGetBlocking(account) {
  const r = secretTool(['lookup', 'service', SERVICE, 'account', account]);
  if (r.status === 0) return r.stdout;
  if ((r.stderr || '').trim()) throw secretToolFailure('lookup', r);
  return null;
}

// Daemon-safe state. The synchronous read path NEVER spawns secret-tool on
// Linux: a locked keyring would freeze the event loop for the whole timeout.
// One bounded async `secret-tool search --all` snapshot (prewarmSecrets) fills
// the read cache; afterwards an uncached account is simply absent. Until that
// snapshot succeeds the sync read throws the actionable keyring error (callers
// already treat a throw as "no stored key") and a retry is scheduled lazily.
const LINUX_PREWARM_TIMEOUT_MS = Number(process.env.MIXDOG_KEYCHAIN_PREWARM_TIMEOUT_MS || 4000);
const LINUX_PREWARM_RETRY_MS = Number(process.env.MIXDOG_KEYCHAIN_RETRY_MS || 5000);
// An explicit "Unlock keyring" waits on the user typing a password.
const LINUX_INTERACTIVE_TIMEOUT_MS = Number(process.env.MIXDOG_KEYCHAIN_INTERACTIVE_TIMEOUT_MS || 120000);
// A window-focus re-check skips the TTL but not this floor (focus can flap).
const LINUX_RECHECK_MIN_MS = Number(process.env.MIXDOG_KEYCHAIN_RECHECK_MIN_MS || 2000);
const LINUX_LOCKED_MESSAGE =
  '[keychain] the keyring is locked — unlock it (log in again or open Passwords and Keys) and retry';
let _linuxLoadedUntil = 0;
let _linuxLastFailureAt = 0;
let _linuxPrewarmInFlight = false;
let _linuxSnapshotAt = 0;
let _linuxSnapshotChanged = false;
const LINUX_SNAPSHOT_TTL_MS = Number(process.env.MIXDOG_KEYCHAIN_SNAPSHOT_TTL_MS || 45000);
let _linuxBgTimer = null;
let _linuxBgAttempt = 0;
let _interactiveUnlock = false;
let _linuxPrewarmInteractive = false;
const _recoveryListeners = new Set();
let _keychainStatus = { state: 'unknown', message: '' };

function _noteKeychainOk() {
  _keychainStatus = { state: 'ok', message: '' };
  _linuxBgAttempt = 0;
  clearTimeout(_linuxBgTimer);
  _linuxBgTimer = null;
}

/** Subscribe to a failed Linux keyring becoming readable (e.g. user unlocked it). */
function onKeychainRecovered(listener) {
  _recoveryListeners.add(listener);
  return () => _recoveryListeners.delete(listener);
}

// While the keyring is locked/failing nothing may depend on a read to retry, so
// retry in the background with a bounded backoff (5s → 10s). A missing
// secret-tool cannot fix itself and is not retried.
function _scheduleLinuxBackgroundRetry() {
  if (_linuxBgTimer || _keychainStatus.state === 'missing' || _gdbusMissing) return;
  const delay = Math.min(LINUX_PREWARM_RETRY_MS * 2, LINUX_PREWARM_RETRY_MS + _linuxBgAttempt * (LINUX_PREWARM_RETRY_MS / 2));
  _linuxBgAttempt++;
  _linuxBgTimer = setTimeout(async () => {
    _linuxBgTimer = null;
    await retryKeychain();
  }, delay);
  _linuxBgTimer.unref?.();
}

// Passive access to the Secret Service over D-Bus. Unlike secret-tool (whose
// lookup/search raises GNOME's "Authentication required" prompt as soon as a
// MATCHING item sits in a locked collection) SearchItems never prompts: it
// answers with the matching item paths split into unlocked and locked ones.
// Only Mixdog's own items matter — a locked collection that holds none of them
// (e.g. the login keyring next to an unlocked default one) is irrelevant.
// 'unknown' (null) means no gdbus / service unreachable / unparsable; passive
// callers must treat it as "do not run secret-tool".
let _gdbusMissing = false;
const SECRETS_DEST = 'org.freedesktop.secrets';
const SECRETS_ROOT = '/org/freedesktop/secrets';
const SECRET_SERVICE_IFACE = 'org.freedesktop.Secret.Service';
const SECRET_ITEM_IFACE = 'org.freedesktop.Secret.Item';

/** One bounded gdbus method call; resolves { ok, out, err } (never rejects). */
function gdbusCall(objectPath, method, args = []) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(
        'gdbus',
        ['call', '--session', '--dest', SECRETS_DEST, '--object-path', objectPath, '--method', method, ...args],
        { env: secretToolEnv(), stdio: ['ignore', 'pipe', 'pipe'], shell: false, windowsHide: true }
      );
    } catch {
      resolve({ ok: false, out: '', err: '' });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok, out: stdout, err: stderr });
    };
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {}
      done(false);
    }, 2000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', (error) => {
      if (error?.code === 'ENOENT') _gdbusMissing = true;
      done(false);
    });
    child.once('close', (status) => done(status === 0));
  });
}

// gdbus prints the (ao, ao) reply as `([objectpath '/…/7'], @ao [])`.
function parseSearchItems(out) {
  const array = '(@ao \\[\\s*\\]|\\[[^\\]]*\\])';
  const m = new RegExp(`^\\(\\s*${array}\\s*,\\s*${array}\\s*\\)$`).exec(String(out).trim());
  if (!m) return null;
  const paths = (text) => [...text.matchAll(/'(\/org\/freedesktop\/secrets\/collection\/[^']+)'/g)].map((x) => x[1]);
  return { unlocked: paths(m[1]), locked: paths(m[2]) };
}

/** Mixdog's items by lock state, or null when the service cannot be asked. */
async function searchMixdogItems() {
  const r = await gdbusCall(SECRETS_ROOT, `${SECRET_SERVICE_IFACE}.SearchItems`, [`{'service': '${SERVICE}'}`]);
  return r.ok ? parseSearchItems(r.out) : null;
}

// An item's attributes are readable without unlocking its collection.
// Resolves the account name, '' for an item that vanished since the search
// (a keyring can list a just-deleted item), null when the call itself failed.
async function itemAccount(objectPath) {
  const r = await gdbusCall(objectPath, 'org.freedesktop.DBus.Properties.Get', [SECRET_ITEM_IFACE, 'Attributes']);
  if (!r.ok) return /does not exist|UnknownObject|No such (object|item)/i.test(r.err) ? '' : null;
  const m = /'account':\s*'((?:[^'\\]|\\.)*)'/.exec(r.out);
  return m ? m[1].replace(/\\(.)/g, '$1') : '';
}

const LINUX_UNREACHABLE_MESSAGE =
  '[keychain] the keyring is not reachable — make sure it is running, then use Unlock keyring / Retry';
function _noteKeychainFailure(error) {
  const message = String(error?.message || error);
  const state =
    error?.code === 'KEYRING_UNREACHABLE'
      ? 'unreachable'
      : /not installed/.test(message)
        ? 'missing'
        : /locked|timed out/.test(message)
          ? 'locked'
          : 'error';
  _keychainStatus = { state, message };
}

/** Linux keyring health for the UI: ok | locked | missing | error | unknown. */
function keychainStatus() {
  return { ..._keychainStatus };
}

function _linuxLoaded() {
  return _linuxLoadedUntil > Date.now();
}

function linuxGet(account) {
  if (KEYCHAIN_CACHE_TTL_MS === 0) return linuxGetBlocking(account);
  if (_linuxLoaded()) return null;
  if (Date.now() - _linuxLastFailureAt > LINUX_PREWARM_RETRY_MS) void prewarmSecrets();
  throw new Error(
    _keychainStatus.message ||
      '[keychain] the Linux keyring has not been read yet — unlock your keyring (log in again or open Passwords and Keys)'
  );
}

// `secret-tool search --all` splits its report across streams: header, label,
// secret, created/modified and schema go to stdout while the attribute.* lines
// go to stderr (observed on GNOME). Pairing items across the split is
// unreliable, so the search is only used to DISCOVER account names (the
// attribute.account lines of either stream); values come from per-account
// `lookup`. The discovered count must match the item count, otherwise the
// snapshot could be silently incomplete and is rejected.
function parseSecretToolSearchAccounts(stdout, stderr) {
  const text = `${String(stdout || '')}\n${String(stderr || '')}`;
  const accounts = new Set();
  let attributeLines = 0;
  let items = 0;
  for (const line of text.split(/\r?\n/)) {
    if (/^\[\/.*\]$/.test(line)) items++;
    const m = line.match(/^attribute\.account = (.+)$/);
    if (m) {
      attributeLines++;
      accounts.add(m[1]);
    }
  }
  if (attributeLines !== items) {
    // A locked keyring answers the search with items but no attributes. Keep
    // the parse detail out of the UI-facing message.
    const error = new Error(LINUX_LOCKED_MESSAGE);
    error.detail = `secret-tool search returned ${items} item(s) but ${attributeLines} account attribute(s)`;
    throw error;
  }
  return [...accounts];
}
// Which accounts to read, and whether Mixdog items are stuck in a locked
// collection. Passive reads never prompt: SearchItems says which items are
// unlocked, and only those are read. secret-tool is used only where that cannot
// prompt without the user asking: to list accounts when no Mixdog item exists
// at all (this also proves the tool is installed), and — for an explicit
// `interactive` unlock — `search --unlock`, which is what raises the prompt
// (a plain search lists locked items without attributes and never asks).
// Its listing is not used: attributes and secrets arrive split across stdout
// and stderr and one stale item makes the whole command fail, so the unlocked
// items are listed through D-Bus again afterwards.
async function _linuxAccountsToRead(interactive, remaining) {
  let found = await searchMixdogItems();
  if (found === null && !interactive) {
    const error = new Error(LINUX_UNREACHABLE_MESSAGE);
    error.code = 'KEYRING_UNREACHABLE';
    throw error;
  }
  const listAccounts = async (args) => {
    const r = await secretToolAsync(args, undefined, remaining());
    // Exit 1 with an empty stderr just means "no items".
    if (r.status !== 0 && (r.stderr || '').trim()) throw secretToolFailure('search', r);
    return { accounts: parseSecretToolSearchAccounts(r.stdout, r.stderr), lockedLeft: false };
  };
  if (found !== null && found.unlocked.length === 0 && found.locked.length === 0) {
    return listAccounts(['search', '--all', 'service', SERVICE]);
  }
  if (interactive && (found === null || found.locked.length > 0)) {
    const unlock = await secretToolAsync(['search', '--all', '--unlock', 'service', SERVICE], undefined, remaining());
    found = await searchMixdogItems();
    if (found === null) {
      if (unlock.status !== 0 && (unlock.stderr || '').trim()) throw secretToolFailure('search', unlock);
      return { accounts: parseSecretToolSearchAccounts(unlock.stdout, unlock.stderr), lockedLeft: false };
    }
  }
  const names = await Promise.all(found.unlocked.map((objectPath) => itemAccount(objectPath)));
  if (names.includes(null)) {
    const error = new Error(LINUX_UNREACHABLE_MESSAGE);
    error.code = 'KEYRING_UNREACHABLE';
    throw error;
  }
  return { accounts: [...new Set(names.filter(Boolean))], lockedLeft: found.locked.length > 0 };
}
async function _prewarmLinuxOnce() {
  _linuxPrewarmInFlight = true;
  const interactive = _interactiveUnlock;
  _linuxPrewarmInteractive = interactive;
  try {
    if (KEYCHAIN_CACHE_TTL_MS === 0) return;
    // One deadline covers the search AND every per-account lookup.
    const deadline = Date.now() + (interactive ? LINUX_INTERACTIVE_TIMEOUT_MS : LINUX_PREWARM_TIMEOUT_MS);
    const remaining = () => {
      const ms = deadline - Date.now();
      if (ms <= 0) {
        const error = new Error(LINUX_LOCKED_MESSAGE);
        error.detail = 'prewarm deadline exceeded';
        throw error;
      }
      return ms;
    };
    const epoch = _cacheEpoch;
    const generations = new Map(_cacheGenerations);
    const { accounts, lockedLeft } = await _linuxAccountsToRead(interactive, remaining);
    if (_cacheEpoch !== epoch) return;
    const values = [];
    for (const account of accounts) {
      const value = await linuxGetAsync(account, remaining());
      if (value !== null) values.push([account, value]);
    }    if (_cacheEpoch !== epoch) return;
    // Replace, not merge: values the keyring now holds overwrite the cache and
    // cached accounts the keyring no longer has are dropped, so external CLI /
    // other-process add, replace and delete are picked up. A same-process
    // set/delete that ran meanwhile bumped the account's generation and wins.
    const fresh = new Map(values);
    const prefix = `${SERVICE}\0`;
    let changed = false;
    // Mixdog items in a locked collection cannot be listed: a cached account the
    // readable items no longer show may live there, so nothing is dropped.
    for (const key of lockedLeft ? [] : [..._secretCache.keys()]) {
      if (!key.startsWith(prefix)) continue;
      const account = key.slice(prefix.length);
      if ((_cacheGenerations.get(account) || 0) !== (generations.get(account) || 0)) continue;
      if (!fresh.has(account)) {
        _secretCache.delete(key);
        changed = true;
      }
    }
    for (const [account, value] of fresh) {
      if ((_cacheGenerations.get(account) || 0) !== (generations.get(account) || 0)) continue;
      if (_cacheGet(account) !== value) changed = true;
      _cacheSet(account, value);
    }
    _linuxSnapshotChanged = changed;
    if (lockedLeft) {
      // The readable items are cached; the rest of the keyring still needs an
      // unlock, so the status stays locked and uncached accounts keep throwing
      // that error instead of reading as absent.
      const error = new Error(LINUX_LOCKED_MESSAGE);
      error.detail = 'Mixdog items sit in a locked collection (passive search)';
      throw error;
    }
    _linuxSnapshotAt = Date.now();
    _linuxLoadedUntil =
      KEYCHAIN_CACHE_TTL_MS === Number.POSITIVE_INFINITY
        ? Number.POSITIVE_INFINITY
        : Date.now() + KEYCHAIN_CACHE_TTL_MS;
    _linuxLastFailureAt = 0;
    const recovered = _keychainStatus.state !== 'ok' && _keychainStatus.state !== 'unknown';
    _noteKeychainOk();
    if (recovered) {
      for (const listener of [..._recoveryListeners]) {
        try {
          listener();
        } catch {
          /* listener failures must not break keyring recovery */
        }
      }
    }
  } catch (error) {
    _linuxLastFailureAt = Date.now();
    _noteKeychainFailure(error);
    // Allow a later lazy retry once the cool-down passes.
    _prewarmPromise = null;
    _scheduleLinuxBackgroundRetry();
  } finally {
    _linuxPrewarmInFlight = false;
  }
}

function linuxSet(account, value) {
  const r = secretTool(['store', `--label=${SERVICE} ${account}`, 'service', SERVICE, 'account', account], value);
  if (r.status !== 0) throw secretToolFailure('store', r);
}

function linuxDelete(account) {
  const r = secretTool(['clear', 'service', SERVICE, 'account', account]);
  if (r.status !== 0 && (r.stderr || '').trim()) throw secretToolFailure('clear', r);
}

async function linuxGetAsync(account, timeoutMs) {
  const r = await secretToolAsync(['lookup', 'service', SERVICE, 'account', account], undefined, timeoutMs);
  if (r.status === 0) return r.stdout;
  if ((r.stderr || '').trim()) throw secretToolFailure('lookup', r);
  return null;
}

async function linuxSetAsync(account, value) {
  const r = await secretToolAsync(
    ['store', `--label=${SERVICE} ${account}`, 'service', SERVICE, 'account', account],
    value
  );
  if (r.status !== 0) throw secretToolFailure('store', r);
}

async function linuxDeleteAsync(account) {
  const r = await secretToolAsync(['clear', 'service', SERVICE, 'account', account]);
  if (r.status !== 0 && (r.stderr || '').trim()) throw secretToolFailure('clear', r);
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
  '$bytes = [Convert]::FromBase64String(([Console]::In.ReadToEnd()).Trim());',
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

async function _prewarmSecretsOnce() {
  try {
    if (platform() === 'linux') return await _prewarmLinuxOnce();
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
      `${rows.map((row) => `${row.account}|${row.b64}`).join('\n')}\n`
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

function prewarmSecrets() {
  _prewarmPromise ??= _prewarmSecretsOnce();
  return _prewarmPromise;
}

/** Passive refresh, called on provider-setup reads. While readable it detects a
 *  keyring that locked meanwhile (no prompt) and, once the snapshot is older
 *  than the TTL (or, for a window-focus re-check, `force`, at most every
 *  LINUX_RECHECK_MIN_MS), re-snapshots it so external changes are picked up.
 *  Resolves true when cached values changed. Never prompts. */
async function refreshKeychainStatus({ force = false } = {}) {
  if (platform() !== 'linux' || _keychainStatus.state !== 'ok' || KEYCHAIN_CACHE_TTL_MS === 0) return false;
  const age = Date.now() - _linuxSnapshotAt;
  if (age >= (force ? LINUX_RECHECK_MIN_MS : LINUX_SNAPSHOT_TTL_MS)) {
    if (_linuxPrewarmInFlight && _prewarmPromise) await _prewarmPromise;
    else {
      _prewarmPromise = null;
      _linuxSnapshotChanged = false;
      await prewarmSecrets();
    }
    return _linuxSnapshotChanged;
  }
  const found = await searchMixdogItems();
  if (found && found.locked.length > 0) {
    _keychainStatus = { state: 'locked', message: LINUX_LOCKED_MESSAGE };
    _scheduleLinuxBackgroundRetry();
  }
  return false;
}
/** Re-read a Linux keyring that previously failed (locked, tool missing, bad
 *  snapshot) — e.g. after the user unlocked it. Resolves true when this call
 *  recovered it, so callers can drop caches built while it was unavailable.
 *  `interactive` (an explicit user action) may raise the unlock prompt: a
 *  passive attempt already in flight cannot, so it is awaited and then
 *  followed by one interactive attempt — unless that attempt was interactive
 *  itself, which already showed the (possibly declined) prompt. */
async function retryKeychain({ interactive = false } = {}) {
  if (platform() !== 'linux' || _keychainStatus.state === 'ok' || _keychainStatus.state === 'unknown') return false;
  if (_linuxPrewarmInFlight && _prewarmPromise) {
    await _prewarmPromise;
    if (_keychainStatus.state === 'ok' || interactive !== true || _linuxPrewarmInteractive) {
      return _keychainStatus.state === 'ok';
    }
  }
  _prewarmPromise = null;
  _interactiveUnlock = interactive === true;
  try {
    await prewarmSecrets();
  } finally {
    _interactiveUnlock = false;
  }
  return _keychainStatus.state === 'ok';
}
function win32Set(account, value) {
  const dir = secretsDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // The secret travels via stdin (base64 of UTF-8) so it never appears in the
  // process argv or needs script-level quoting.
  const r = powershell(`& { ${PS_PROTECT} }`, Buffer.from(value, 'utf8').toString('base64'));
  if (r.status !== 0) throw new Error(`[keychain] DPAPI encrypt failed (exit ${r.status}): ${r.stderr || r.stdout}`);
  const out = (r.stdout || '').trim();
  if (!out) throw new Error(`[keychain] DPAPI encrypt returned empty output (stderr: ${(r.stderr || '').trim()})`);
  writeOwnerOnlyAtomicSync(dpApiFile(account), out);
}

function win32Delete(account) {
  const file = dpApiFile(account);
  if (!fs.existsSync(file)) throw new Error(`[keychain] secret not found: ${account}`);
  fs.unlinkSync(file);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const BACKENDS = {
  darwin: { get: darwinGet, set: darwinSet, delete: darwinDelete },
  linux: {
    get: linuxGet,
    set: linuxSet,
    delete: linuxDelete,
    getAsync: linuxGetAsync,
    setAsync: linuxSetAsync,
    deleteAsync: linuxDeleteAsync,
  },
  win32: { get: win32Get, set: win32Set, delete: win32Delete },
};

function backend() {
  const selected = BACKENDS[platform()];
  if (!selected) throw new Error(`[keychain] unsupported platform: ${process.platform}`);
  return selected;
}

function getSecret(account) {
  const cached = _cacheGet(account);
  if (cached !== undefined) return cached;
  const value = backend().get(account);
  _cacheSet(account, value);
  return value;
}

function hasSecret(account) {
  const cached = _cacheGet(account);
  if (cached !== undefined) return cached != null;
  if (platform() === 'win32') return fs.existsSync(dpApiFile(account));
  try {
    return getSecret(account) != null;
  } catch {
    return false;
  }
}

function setSecret(account, value) {
  let stored = false;
  try {
    backend().set(account, value);
    stored = true;
  } finally {
    _cacheInvalidate(account);
    // Linux reads are cache-only, so a fresh write must stay readable.
    if (stored && platform() === 'linux') _cacheSet(account, value);
  }
}

function deleteSecret(account) {
  try {
    backend().delete(account);
  } finally {
    _cacheInvalidate(account);
  }
}

// Async entry points: on Linux the secret-tool child runs without blocking the
// event loop; other platforms keep their existing (sync) providers.
async function getSecretAsync(account) {
  const cached = _cacheGet(account);
  if (cached !== undefined) return cached;
  const b = backend();
  if (!b.getAsync) return getSecret(account);
  if (_linuxLoaded()) return null;
  const generation = _cacheGenerations.get(account) || 0;
  let value;
  try {
    value = await b.getAsync(account);
  } catch (error) {
    _noteKeychainFailure(error);
    throw error;
  }
  _noteKeychainOk();
  if ((_cacheGenerations.get(account) || 0) === generation) _cacheSet(account, value);
  return value;
}

async function setSecretAsync(account, value) {
  const b = backend();
  if (!b.setAsync) return setSecret(account, value);
  let stored = false;
  try {
    await b.setAsync(account, value);
    stored = true;
    _noteKeychainOk();
  } catch (error) {
    _noteKeychainFailure(error);
    throw error;
  } finally {
    _cacheInvalidate(account);
    if (stored) _cacheSet(account, value);
  }
}

async function deleteSecretAsync(account) {
  const b = backend();
  if (!b.deleteAsync) return deleteSecret(account);
  try {
    await b.deleteAsync(account);
    _noteKeychainOk();
  } catch (error) {
    _noteKeychainFailure(error);
    throw error;
  } finally {
    _cacheInvalidate(account);
  }
}

module.exports = {
  getSecret,
  setSecret,
  deleteSecret,
  getSecretAsync,
  setSecretAsync,
  deleteSecretAsync,
  hasSecret,
  keychainStatus,
  invalidateSecretCache,
  prewarmSecrets,
  retryKeychain,
  refreshKeychainStatus,
  onKeychainRecovered,
  SERVICE,
};
