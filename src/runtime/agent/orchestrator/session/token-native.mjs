// Native mixdog-token client: persistent stdio server (transport lifecycle
// modeled on tools/patch/native-server.mjs) that serves precise o200k BPE
// counts ~5-12x faster than the in-process tiktoken WASM worker.
//
// Wire format: length-prefixed BINARY frames (raw utf8 payload, no JSON
// escape/parse on either side — that overhead dominated once the encoder
// went linear-time):
//   request  : u8 op (1=ping, 2=count) | u32le id | u32le byteLen | payload
//   response : u8 op                   | u32le id | u64le count
// A stale JSON-only server never answers a binary ping, so the ready probe
// times out and this module degrades to the WASM worker path.
//
// Strictly a best-effort accelerator behind context-utils' async count path:
// unavailable binary / dead server / timeout all resolve `null`, and the
// caller falls back to the JS worker thread. Kill switch:
// MIXDOG_TOKEN_NATIVE=0 (mode `auto` is the default; MIXDOG_TOKEN_NATIVE_BIN
// overrides binary resolution).
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve as pathResolve, dirname as pathDirname, join as pathJoin } from 'node:path';
import { getPluginData } from '../config.mjs';
import { ensureTokenBinary, findCachedTokenBinary } from '../tools/token-binary-fetcher.mjs';

const PLUGIN_ROOT = process.env.MIXDOG_ROOT
    || pathResolve(pathDirname(fileURLToPath(import.meta.url)), '../../../../..');
const BIN_NAME = process.platform === 'win32' ? 'mixdog-token.exe' : 'mixdog-token';
const LOCAL_BIN = pathJoin(PLUGIN_ROOT, 'native/mixdog-token/target/release', BIN_NAME);
const READY_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 30_000;
const OP_PING = 1;
const OP_COUNT = 2;
const RESPONSE_FRAME_BYTES = 13;
const UNKNOWN_OP_SENTINEL = 0xFFFF_FFFF_FFFF_FFFFn;
const EMPTY_PAYLOAD = Buffer.alloc(0);

function nativeTokenMode() {
    return String(process.env.MIXDOG_TOKEN_NATIVE || 'auto').toLowerCase();
}

function nativeTokenModeEnabled() {
    return !/^(0|false|no|off|js)$/i.test(nativeTokenMode());
}

let _binPath; // undefined = not resolved, null = none found
function _resolveBinary() {
    if (_binPath !== undefined) return _binPath;
    const candidates = [
        String(process.env.MIXDOG_TOKEN_NATIVE_BIN || '').trim() || null,
        LOCAL_BIN,
    ].filter(Boolean);
    _binPath = candidates.find((candidate) => {
        try { return existsSync(candidate); } catch { return false; }
    }) || null;
    if (!_binPath) {
        // Release-supply cache (sha256-verified against the bundled manifest).
        try { _binPath = findCachedTokenBinary(getPluginData()) || null; } catch { _binPath = null; }
    }
    return _binPath;
}

let _server = null; // { child, pending: Map, seq, ready }  null after hard failure
let _serverFailed = false;

function _dropServer(error) {
    const server = _server;
    _server = null;
    if (!server) return;
    const reason = error instanceof Error ? error : new Error(String(error || 'mixdog-token server closed'));
    for (const [, entry] of server.pending) {
        clearTimeout(entry.timer);
        entry.resolve(null);
        void reason;
    }
    server.pending.clear();
    try { server.child.kill(); } catch { /* already down */ }
}

function _ensureServer() {
    if (_server || _serverFailed || !nativeTokenModeEnabled()) return _server;
    const bin = _resolveBinary();
    if (!bin) { _serverFailed = true; return null; }
    let child;
    try {
        child = spawn(bin, [], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    } catch {
        _serverFailed = true;
        return null;
    }
    const server = { child, pending: new Map(), seq: 0, ready: null };
    let inbox = EMPTY_PAYLOAD;
    child.stdout.on('data', (chunk) => {
        inbox = inbox.length ? Buffer.concat([inbox, chunk]) : chunk;
        while (inbox.length >= RESPONSE_FRAME_BYTES) {
            const id = inbox.readUInt32LE(1);
            const count = inbox.readBigUInt64LE(5);
            inbox = inbox.subarray(RESPONSE_FRAME_BYTES);
            const entry = server.pending.get(id);
            if (!entry) continue;
            server.pending.delete(id);
            clearTimeout(entry.timer);
            entry.resolve(count === UNKNOWN_OP_SENTINEL ? null : Number(count));
        }
    });
    child.on('error', () => { _serverFailed = true; _dropServer('spawn error'); });
    child.on('exit', () => { _dropServer('exited'); });
    // Best-effort accelerator: never keeps the process alive. Unref the
    // stdio PIPES too — child.unref() alone leaves the socket handles ref'd,
    // which kept short-lived hosts (node --test suites) from ever exiting.
    child.unref();
    child.stdin?.unref?.();
    child.stdout?.unref?.();
    child.stdin?.on?.('error', () => { /* EPIPE on teardown */ });
    // The native server exits when its stdio owner closes. A second Electron
    // guardian duplicated that same ownership signal while retaining ~100 MB.
    server.ready = _request(server, OP_PING, null, READY_TIMEOUT_MS).then((count) => count !== null);
    _server = server;
    return server;
}

function _request(server, op, text, timeoutMs = REQUEST_TIMEOUT_MS) {
    return new Promise((resolve) => {
        const id = ++server.seq;
        const timer = setTimeout(() => {
            server.pending.delete(id);
            resolve(null);
        }, timeoutMs);
        timer.unref?.();
        server.pending.set(id, { resolve, timer });
        try {
            const payload = text ? Buffer.from(text, 'utf8') : EMPTY_PAYLOAD;
            const header = Buffer.allocUnsafe(9);
            header[0] = op;
            header.writeUInt32LE(id >>> 0, 1);
            header.writeUInt32LE(payload.length >>> 0, 5);
            const stdin = server.child.stdin;
            stdin.cork();
            stdin.write(header);
            if (payload.length) stdin.write(payload);
            stdin.uncork();
        } catch {
            server.pending.delete(id);
            clearTimeout(timer);
            resolve(null);
        }
    });
}

/** True when the native counter can be attempted (mode on + binary present). */
export function nativeTokenCounterEnabled() {
    return nativeTokenModeEnabled() && !_serverFailed && Boolean(_resolveBinary());
}

/** Precise o200k count via the native server; null on any unavailability. */
export async function countTokensNative(text) {
    const server = _ensureServer();
    if (!server) return null;
    const ready = await server.ready;
    if (!ready) { _serverFailed = true; _dropServer('ready failed'); return null; }
    const count = await _request(server, OP_COUNT, String(text ?? ''));
    return Number.isFinite(count) && count >= 0 ? count : null;
}

let _fetchAttempted = false;

/** Boot prewarm: spawn the server + build the encoder off the first estimate.
 *  With no local/env/cached binary, kick ONE background manifest fetch; on
 *  success the resolution cache resets so the next estimate adopts it. */
export function prewarmNativeTokenCounter() {
    const server = _ensureServer();
    if (!server) {
        if (!_fetchAttempted && nativeTokenModeEnabled() && !_resolveBinary()) {
            _fetchAttempted = true;
            void ensureTokenBinary(getPluginData()).then((path) => {
                if (!path) return;
                _binPath = undefined;
                _serverFailed = false;
            }).catch(() => { /* soft degrade — WASM worker path remains */ });
        }
        return false;
    }
    server.ready?.catch?.(() => {});
    return true;
}
