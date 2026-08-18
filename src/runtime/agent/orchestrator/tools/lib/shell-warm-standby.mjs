// Warm pwsh standby: one pre-spawned PowerShell per (shell path, env
// signature) waits with a stdin-reading bootstrap. Taking it skips
// CreateProcess + Defender scan (~300ms warm, ~1.8s cold) for the next shell
// call; the script arrives via the spawn server's stdinWrite message and runs
// with identical exit-code/stdout/stderr semantics. Any miss falls back to
// the regular gated spawn. MIXDOG_SHELL_WARM_STANDBY=0 disables.
import { createHash } from 'node:crypto';
import { nativeSpawnSupportsStdinPipe, setNativeSpawnRequestIdle, tryNativeSpawn } from './native-spawn-client.mjs';
import { SHELL_OUTPUT_DISK_CAP } from '../shell-exec-output.mjs';

// Bootstrap: pre-warm scriptblock compilation while parked, re-decode stdin
// as UTF-8 (console input encoding would mangle non-ASCII), then dot-source
// the fed script so exit codes, $LASTEXITCODE and terminating errors behave
// exactly like `-Command <script>`.
const STANDBY_BOOTSTRAP = "$null = . ([scriptblock]::Create('$null')); [Console]::InputEncoding=[System.Text.UTF8Encoding]::new($false); . ([scriptblock]::Create([Console]::In.ReadToEnd()))";
const STANDBY_ARGS = ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', STANDBY_BOOTSTRAP];
const _configuredIdleMs = Number(process.env.MIXDOG_SHELL_WARM_STANDBY_IDLE_MS);
const STANDBY_TTL_MS = Number.isFinite(_configuredIdleMs) && _configuredIdleMs >= 100
    ? Math.floor(_configuredIdleMs)
    : 2 * 60_000;

let _slot = null; // { native, shell, envSig, createdAt }
let _slotIdleTimer = null;

function _clearSlotIdleTimer() {
    if (!_slotIdleTimer) return;
    clearTimeout(_slotIdleTimer);
    _slotIdleTimer = null;
}

function _armSlotIdleTimer(slot) {
    _clearSlotIdleTimer();
    _slotIdleTimer = setTimeout(() => {
        _slotIdleTimer = null;
        if (_slot !== slot) return;
        _slot = null;
        try { slot.native.child.kill(); } catch { /* best-effort */ }
    }, STANDBY_TTL_MS);
    _slotIdleTimer.unref?.();
}

function _disabled() {
    return process.env.MIXDOG_SHELL_WARM_STANDBY === '0';
}

function envSignature(env) {
    const entries = Object.entries(env || {})
        .map(([key, value]) => `${key}=${value}`)
        .sort()
        .join('\n');
    return createHash('sha256').update(entries).digest('hex');
}

function _slotAlive(slot) {
    return Boolean(slot
        && slot.native?.child
        && slot.native.child.exitCode == null
        && !slot.native.child.killed);
}

function psQuote(value) {
    return String(value).replace(/'/g, "''");
}

/** Pre-spawn the next standby (fire-and-forget; a live one is kept). */
export function ensureWarmShellStandby({ shell, env }) {
    if (_disabled() || !shell) return;
    // Old spawn binaries ignore stdinPipe (null stdin → instant-EOF standby
    // that would ack commands without running them); require the handshake.
    if (!nativeSpawnSupportsStdinPipe()) return;
    if (_slotAlive(_slot)) return;
    let native = null;
    try {
        native = tryNativeSpawn({
            shell: String(shell),
            argv: STANDBY_ARGS,
            spawnOptions: {
                env,
                cwd: process.cwd(),
                outputLimit: SHELL_OUTPUT_DISK_CAP,
                rawOutput: true,
                stdinPipe: true,
                shellType: 'powershell',
                command: '(warm shell standby)',
            },
        });
    } catch { native = null; }
    if (!native?.child) return;
    // Parked standby must not pin the host event loop (a one-shot CLI or test
    // runner would otherwise never exit); reactivated at take time.
    setNativeSpawnRequestIdle(native.child, true);
    const slot = {
        native,
        shell: String(shell),
        envSig: envSignature(env),
        createdAt: Date.now(),
    };
    const release = () => {
        if (_slot !== slot) return;
        _slot = null;
        _clearSlotIdleTimer();
    };
    native.child.once('close', release);
    native.child.once('error', release);
    _slot = slot;
    _armSlotIdleTimer(slot);
}

/** Take the parked standby for immediate use, or null on any mismatch.
 *  Always refills so the NEXT call finds a warm one. */
export function takeWarmShellStandby({ shell, env, cwd }) {
    if (_disabled() || !shell) return null;
    const slot = _slot;
    const refill = () => { try { ensureWarmShellStandby({ shell, env }); } catch { /* best-effort */ } };
    const usable = _slotAlive(slot)
        && slot.shell === String(shell)
        && typeof slot.native.child.writeStdin === 'function'
        && Number.isFinite(slot.native.child.pid) && slot.native.child.pid > 0
        && Date.now() - slot.createdAt <= STANDBY_TTL_MS
        && slot.envSig === envSignature(env);
    if (!usable) {
        // Stale (TTL/env/shell drift): kill so it cannot linger; a still-
        // warming slot (no pid yet) is left in place for a later call.
        if (_slotAlive(slot) && Number.isFinite(slot.native.child.pid)
            && (slot.shell !== String(shell)
                || Date.now() - slot.createdAt > STANDBY_TTL_MS
                || slot.envSig !== envSignature(env))) {
            _slot = null;
            _clearSlotIdleTimer();
            try { slot.native.child.kill(); } catch { /* best-effort */ }
        }
        refill();
        return null;
    }
    _slot = null;
    _clearSlotIdleTimer();
    // Back to active: the caller is about to run a real command on it and the
    // host must stay alive until that command settles.
    setNativeSpawnRequestIdle(slot.native.child, false);
    refill();
    const feed = (commandText, workDir) => {
        // cwd prelude: the standby was spawned in the daemon cwd. Set-Location
        // fixes $PWD and native-child working dirs; Environment.CurrentDirectory
        // fixes .NET relative-path APIs.
        const prelude = workDir
            ? `Set-Location -LiteralPath '${psQuote(workDir)}'; [System.Environment]::CurrentDirectory = '${psQuote(workDir)}'; `
            : '';
        // Single atomic write+EOF: a separate close message can race ahead
        // of the server's async write thread and feed an empty script.
        slot.native.child.writeStdin(prelude + String(commandText ?? ''), { close: true });
    };
    return { spawned: slot.native, feed };
}

export function _resetWarmShellStandbyForTest() {
    const slot = _slot;
    _slot = null;
    _clearSlotIdleTimer();
    if (slot?.native?.child) {
        try { slot.native.child.kill(); } catch { /* best-effort */ }
    }
}