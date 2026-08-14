// Native mixdog-token client: a Node Worker owns the in-process Node-API addon
// so CPU-heavy counting never blocks the daemon event loop. Session shards
// relay to this single owner over their existing IPC channel.
//
// Unavailable addon / dead worker / timeout all resolve `null`, and callers
// fall back to the WASM worker path. Kill switch:
// MIXDOG_TOKEN_NATIVE=0 (mode `auto` is the default; MIXDOG_TOKEN_NATIVE_BIN
// remains a compatible override for the addon path).
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve as pathResolve, dirname as pathDirname, join as pathJoin } from 'node:path';
import { Worker } from 'node:worker_threads';
import { getPluginData } from '../config.mjs';
import { ensureTokenAddon, findCachedTokenAddon } from '../tools/token-addon-fetcher.mjs';
import { safeIpcSend } from '../../../shared/safe-ipc-send.mjs';
import { packageNativeToolPath } from '../../../shared/native-tool-paths.mjs';

const PLUGIN_ROOT = process.env.MIXDOG_ROOT
    || pathResolve(pathDirname(fileURLToPath(import.meta.url)), '../../../../..');
const LOCAL_ADDON = pathJoin(
    PLUGIN_ROOT,
    'native/mixdog-token/target/release/mixdog-token.node',
);
const READY_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 30_000;
const SHARD_PREWARM_MESSAGE = 'token-native-prewarm';
const SHARD_COUNT_MESSAGE = 'token-native-count';
const SHARD_RESULT_MESSAGE = 'token-native-result';

function isSessionShardProcess() {
    return process.env.MIXDOG_SESSION_SHARD_PID === String(process.pid);
}

function sessionShardClientEnabled() {
    return isSessionShardProcess()
        && typeof process.send === 'function'
        && process.connected === true;
}

function nativeTokenMode() {
    return String(process.env.MIXDOG_TOKEN_NATIVE || 'auto').toLowerCase();
}

function nativeTokenModeEnabled() {
    return !/^(0|false|no|off|js)$/i.test(nativeTokenMode());
}

let _addonPath; // undefined = not resolved, null = none found
function _resolveAddon() {
    if (_addonPath !== undefined) return _addonPath;
    const candidates = [
        String(process.env.MIXDOG_TOKEN_NATIVE_ADDON || '').trim() || null,
        String(process.env.MIXDOG_TOKEN_NATIVE_BIN || '').trim() || null,
        LOCAL_ADDON,
        packageNativeToolPath('token'),
    ].filter(Boolean);
    _addonPath = candidates.find((candidate) => {
        try { return existsSync(candidate); } catch { return false; }
    }) || null;
    if (!_addonPath) {
        // Release-supply cache (sha256-verified against the bundled manifest).
        try { _addonPath = findCachedTokenAddon(getPluginData()) || null; } catch { _addonPath = null; }
    }
    return _addonPath;
}

let _workerOwner = null; // { worker, pending, seq, ready, resolveReady, readyTimer }
let _workerFailed = false;
let _shardSequence = 0;
let _shardListenerInstalled = false;
const _shardPending = new Map();

function _dropShardRequests() {
    for (const entry of _shardPending.values()) {
        clearTimeout(entry.timer);
        entry.resolve(null);
    }
    _shardPending.clear();
}

function _ensureShardResponseListener() {
    if (_shardListenerInstalled) return;
    _shardListenerInstalled = true;
    process.on('message', (message) => {
        if (!message || message.type !== SHARD_RESULT_MESSAGE) return;
        const tokenRequestId = String(message.tokenRequestId || '');
        const entry = _shardPending.get(tokenRequestId);
        if (!entry) return;
        _shardPending.delete(tokenRequestId);
        clearTimeout(entry.timer);
        const count = Number(message.count);
        entry.resolve(Number.isFinite(count) && count >= 0 ? count : null);
    });
    process.once('disconnect', _dropShardRequests);
}

function _requestShardTokenCount(text, timeoutMs = REQUEST_TIMEOUT_MS) {
    if (!sessionShardClientEnabled()) return Promise.resolve(null);
    _ensureShardResponseListener();
    const tokenRequestId = `token-${process.pid}-${++_shardSequence}`;
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            if (!_shardPending.delete(tokenRequestId)) return;
            resolve(null);
        }, timeoutMs);
        timer.unref?.();
        _shardPending.set(tokenRequestId, { resolve, timer });
        if (!safeIpcSend(process, {
            type: SHARD_COUNT_MESSAGE,
            tokenRequestId,
            text: String(text ?? ''),
        }, {
            onError: () => {
                const entry = _shardPending.get(tokenRequestId);
                if (!entry) return;
                _shardPending.delete(tokenRequestId);
                clearTimeout(entry.timer);
                entry.resolve(null);
            },
        })) {
            const entry = _shardPending.get(tokenRequestId);
            if (entry) {
                _shardPending.delete(tokenRequestId);
                clearTimeout(entry.timer);
                entry.resolve(null);
            }
        }
    });
}

function _dropWorker(error) {
    const owner = _workerOwner;
    _workerOwner = null;
    if (!owner) return;
    if (owner.readyTimer) clearTimeout(owner.readyTimer);
    owner.resolveReady(false);
    const reason = error instanceof Error ? error : new Error(String(error || 'token worker closed'));
    for (const entry of owner.pending.values()) {
        clearTimeout(entry.timer);
        entry.resolve(null);
        void reason;
    }
    owner.pending.clear();
    try { void owner.worker.terminate(); } catch { /* already down */ }
}

function _ensureWorker() {
    if (_workerOwner || _workerFailed || !nativeTokenModeEnabled()) return _workerOwner;
    const addonPath = _resolveAddon();
    if (!addonPath) return null;
    let worker;
    try {
        worker = new Worker(new URL('./token-native-worker.mjs', import.meta.url), {
            workerData: { addonPath },
            // `--input-type` is valid only for eval/stdin and makes a file URL
            // Worker fail before loading. Preserve all other runtime flags.
            execArgv: process.execArgv.filter((arg) => !arg.startsWith('--input-type')),
        });
    } catch {
        _workerFailed = true;
        return null;
    }
    let resolveReady;
    const ready = new Promise((resolve) => { resolveReady = resolve; });
    const owner = {
        worker,
        pending: new Map(),
        seq: 0,
        ready,
        resolveReady,
        readyTimer: null,
    };
    _workerOwner = owner;
    owner.readyTimer = setTimeout(() => {
        if (_workerOwner !== owner) return;
        _workerFailed = true;
        _dropWorker('ready timeout');
    }, READY_TIMEOUT_MS);
    owner.readyTimer.unref?.();
    worker.on('message', (message) => {
        if (_workerOwner !== owner || !message || typeof message !== 'object') return;
        if (message.type === 'ready') {
            if (owner.readyTimer) clearTimeout(owner.readyTimer);
            owner.readyTimer = null;
            owner.resolveReady(true);
            _workerFailed = false;
            if (owner.pending.size === 0) owner.worker.unref();
            return;
        }
        if (message.type === 'fatal') {
            _workerFailed = true;
            _dropWorker(String(message.error || 'addon initialization failed'));
            return;
        }
        if (message.type !== 'result') return;
        const entry = owner.pending.get(Number(message.id));
        if (!entry) return;
        owner.pending.delete(Number(message.id));
        clearTimeout(entry.timer);
        const count = Number(message.count);
        _workerFailed = false;
        entry.resolve(Number.isFinite(count) && count >= 0 ? count : null);
        if (owner.pending.size === 0) owner.worker.unref();
    });
    worker.once('error', (reason) => {
        if (_workerOwner !== owner) return;
        // A recoverable Worker exit is recreated on the next count;
        // initialization failures report `fatal` and stay off.
        _workerFailed = false;
        _dropWorker(reason);
    });
    worker.once('exit', () => {
        if (_workerOwner !== owner) return;
        _workerFailed = false;
        _dropWorker('exited');
    });
    return owner;
}

function _requestWorker(owner, text, timeoutMs = REQUEST_TIMEOUT_MS) {
    return new Promise((resolve) => {
        owner.worker.ref();
        const id = ++owner.seq;
        const timer = setTimeout(() => {
            owner.pending.delete(id);
            resolve(null);
            if (owner.pending.size === 0 && !owner.readyTimer) owner.worker.unref();
        }, timeoutMs);
        timer.unref?.();
        owner.pending.set(id, { resolve, timer });
        try {
            owner.worker.postMessage({ type: 'count', id, text: String(text ?? '') });
        } catch {
            owner.pending.delete(id);
            clearTimeout(timer);
            resolve(null);
            if (owner.pending.size === 0 && !owner.readyTimer) owner.worker.unref();
        }
    });
}

/** True when the native counter can be attempted (mode on + addon present). */
export function nativeTokenCounterEnabled() {
    if (isSessionShardProcess()) {
        return nativeTokenModeEnabled() && sessionShardClientEnabled();
    }
    return nativeTokenModeEnabled() && !_workerFailed && Boolean(_resolveAddon());
}

/** Precise o200k count via the daemon-owned addon worker. */
export async function countTokensNative(text) {
    if (isSessionShardProcess()) {
        if (!nativeTokenModeEnabled()) return null;
        return _requestShardTokenCount(text);
    }
    const owner = _ensureWorker();
    if (!owner) return null;
    const ready = await owner.ready;
    if (!ready) return null;
    const count = await _requestWorker(owner, text);
    return Number.isFinite(count) && count >= 0 ? count : null;
}

let _fetchAttempted = false;

/** Boot prewarm: start the worker and build the encoder off the first estimate.
 *  With no local/env/cached addon, kick ONE background manifest fetch; on
 *  success the resolution cache resets so the next estimate adopts it. */
export function prewarmNativeTokenCounter() {
    if (isSessionShardProcess()) {
        if (!nativeTokenModeEnabled() || !sessionShardClientEnabled()) return false;
        return safeIpcSend(process, { type: SHARD_PREWARM_MESSAGE }, { onError: () => {} });
    }
    const owner = _ensureWorker();
    if (!owner) {
        if (!_fetchAttempted && nativeTokenModeEnabled() && !_resolveAddon()) {
            _fetchAttempted = true;
            void ensureTokenAddon(getPluginData()).then((path) => {
                if (!path) return;
                _addonPath = undefined;
                _workerFailed = false;
            }).catch(() => { /* soft degrade — WASM worker path remains */ });
        }
        return false;
    }
    owner.ready.catch(() => {});
    return true;
}
