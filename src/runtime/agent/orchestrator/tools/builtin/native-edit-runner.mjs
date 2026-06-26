import { existsSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { performance } from 'perf_hooks';
import { fileURLToPath } from 'url';
import { snapshotCoversFullFile } from './snapshot-helpers.mjs';
import { getPluginData } from '../../config.mjs';
import { findCachedPatchBinary } from '../patch-binary-fetcher.mjs';
import { runServerEdit } from '../patch.mjs';

const PLUGIN_ROOT = process.env.MIXDOG_ROOT
    || resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const NATIVE_EDIT_DEFAULT_BIN = join(
    PLUGIN_ROOT,
    'native/mixdog-patch/target/release',
    process.platform === 'win32' ? 'mixdog-patch.exe' : 'mixdog-patch',
);

export function nativeEditMode() {
    return String(process.env.MIXDOG_EDIT_NATIVE || 'auto').toLowerCase();
}

function nativeEditBinCandidate() {
    const override = process.env.MIXDOG_EDIT_NATIVE_BIN || process.env.MIXDOG_PATCH_NATIVE_BIN;
    if (override) return { path: override, kind: 'override' };
    if (existsSync(NATIVE_EDIT_DEFAULT_BIN)) return { path: NATIVE_EDIT_DEFAULT_BIN, kind: 'local' };
    const cached = findCachedPatchBinary(getPluginData());
    if (cached) return { path: cached, kind: 'cached' };
    return { path: NATIVE_EDIT_DEFAULT_BIN, kind: 'missing' };
}

export function nativeEditBinPath() {
    return nativeEditBinCandidate().path;
}

export function nativeEditShouldAttempt({ editSnapshot, oldStr, newStr, preloadedContent, preloadedRawBuf }) {
    const mode = nativeEditMode();
    if (/^(0|false|no|off|js|legacy)$/i.test(mode)) return false;
    const forcedNative = /^(1|true|yes|on|native)$/i.test(mode);
    const candidate = nativeEditBinCandidate();
    if (!existsSync(candidate.path)) return false;
    // Cached release prebuilds are guaranteed valid for apply_patch, but older
    // manifests (currently v0.6.5 in clean CI) predate the EDIT server protocol.
    // In auto mode, native edit is only an acceleration, so require either a
    // local cargo build or an explicit override. If a user forces native mode,
    // still try the cached binary and surface any protocol failure.
    if (candidate.kind === 'cached' && !forcedNative) return false;
    if (!snapshotCoversFullFile(editSnapshot)) return false;
    if (preloadedContent !== null || preloadedRawBuf !== null) return false;
    if (typeof oldStr !== 'string' || oldStr.length === 0 || typeof newStr !== 'string') return false;
    if (forcedNative) return true;
    // auto: the persistent server removed per-call spawn cost, so route edits to
    // native edit2 by default (B3). Same-size edits keep the JS in-place partial
    // write, which rewrites bytes in place instead of the whole file.
    const oldBytes = Buffer.byteLength(oldStr, 'utf-8');
    const newBytes = Buffer.byteLength(newStr, 'utf-8');
    if (oldBytes === newBytes) return false;
    return true;
}

export async function runNativeExactEdit({ fullPath, oldStr, newStr, replaceAll, signal = null }) {
    const forcedNative = /^(1|true|yes|on|native)$/i.test(nativeEditMode());
    if (signal?.aborted) {
        return { ok: false, fallback: false, error: signal.reason?.message || signal.reason || 'native edit aborted' };
    }
    const oldBuf = Buffer.from(oldStr, 'utf-8');
    const newBuf = Buffer.from(newStr, 'utf-8');
    const started = performance.now();
    try {
        // PARITY GUARD: the native engine MATCHES via the curly-quote fold
        // tier but applies new_string verbatim, silently downgrading the
        // file's typographic quotes (JS slow path preserves them via
        // preserveQuoteTypography). When old_string carries quote-family
        // chars — the only inputs that can land on the curly tier — probe
        // with a dry run (persistent server, ~ms) and defer curly-tier
        // matches to the JS editor.
        if (/["'‘’“”]/.test(oldStr)) {
            const probe = await runServerEdit({ fullPath, oldBuf, newBuf, replaceAll, dryRun: true, signal });
            if (probe?.tier === 'curly') {
                return { ok: false, fallback: true, error: 'curly-quote fold match — deferred to JS editor for typography preservation' };
            }
        }
        const res = await runServerEdit({ fullPath, oldBuf, newBuf, replaceAll, signal });
        return {
            ok: true,
            replacements: res.replacements,
            readMs: res.readMs,
            applyMs: res.applyMs,
            writeMs: res.writeMs,
            totalMs: res.totalMs,
            roundtripMs: res.roundtripMs ?? (performance.now() - started),
            stage: res.tier,
            contentHash: res.contentHash,
        };
    } catch (err) {
        if (err?.name === 'AbortError') {
            return { ok: false, fallback: false, error: err.message };
        }
        const msg = String(err?.message || err);
        // Tier misses and not-found map to a JS fallback; transport/spawn errors
        // also fall back so a server hiccup never blocks an edit. Older cached
        // mixdog-patch binaries (for example the v0.6.5 release prebuilds used
        // by clean CI before a local cargo build exists) support APPLY but not
        // the EDIT server protocol, and answer EDIT with the APPLY parser's
        // "bad header" error. In auto mode that means "native edit unavailable",
        // not "the edit is invalid", so fall through to the JS editor. When the
        // user explicitly forces native mode, keep surfacing the native failure.
        const fallback = !forcedNative && /old_string (?:not found|found \d+ times)|not valid UTF-8|no exact match|not found|server|bad header|bad edit header/i.test(msg);
        return { ok: false, fallback, error: msg };
    }
}
