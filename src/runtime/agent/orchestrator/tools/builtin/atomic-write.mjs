import { statSync, createWriteStream } from 'fs';
import * as fsPromises from 'fs/promises';
import { basename, dirname, join } from 'path';
import { performance } from 'perf_hooks';
import { randomBytes } from 'crypto';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { getAbortSignalForSession } from '../../session/abort-lookup.mjs';
import { hashText } from './hash-utils.mjs';

const STREAMING_THRESHOLD_BYTES = 1024 * 1024;

const WINDOWS_RENAME_RETRY_CODES = new Set(['EACCES', 'EBUSY', 'EPERM']);
const WINDOWS_RENAME_RETRY_BACKOFFS_MS = [25, 50, 100, 200, 400, 800, 1200, 1600];

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function expectedTargetSnapshotChanged(currentStat, expected) {
    if (!expected) return false;
    const snapshotExists = expected.exists !== false;
    const currentExists = !!currentStat;
    if (snapshotExists !== currentExists) return true;
    if (!snapshotExists || !currentExists) return false;
    if (currentStat.size !== expected.size) return true;
    if (Math.abs(Number(currentStat.mtimeMs) - Number(expected.mtimeMs)) > 1) return true;
    if (Number.isFinite(expected.ctimeMs)) {
        if (Math.abs(Number(currentStat.ctimeMs) - Number(expected.ctimeMs)) > 1) return true;
    }
    if (Number.isFinite(expected.ino) && Number(currentStat.ino) !== Number(expected.ino)) return true;
    return false;
}

function ioTraceEnabled() {
    return /^(1|true|yes|on)$/i.test(String(process.env.MIXDOG_IO_TRACE || ''));
}

function ioTraceStart() {
    return ioTraceEnabled() ? performance.now() : 0;
}

function ioTrace(event, fields = {}) {
    if (!ioTraceEnabled()) return;
    try {
        process.stderr.write(`[io-trace] ${JSON.stringify({
            event,
            ts: Date.now(),
            ...fields,
        })}\n`);
    } catch {}
}

function ioTraceDone(event, started, fields = {}) {
    if (!started || !ioTraceEnabled()) return;
    ioTrace(event, {
        ...fields,
        ms: Number((performance.now() - started).toFixed(3)),
    });
}

export function atomicWriteShouldFsync(value) {
    if (value === true || value === false) return value;
    return /^(1|true|yes|on|sync)$/i.test(String(process.env.MIXDOG_ATOMIC_FSYNC || ''));
}

// 'wx' preflight creates an empty placeholder at targetPath; if the write is
// later aborted or the rename fails, remove it so a failed create doesn't
// leave a 0-byte file behind. Only removes a still-empty target — another
// writer's content is never deleted.
async function cleanupEmptyWxTarget(targetPath) {
    try {
        const st = await fsPromises.stat(targetPath);
        if (st.size === 0) await fsPromises.unlink(targetPath);
    } catch { /* already gone or unreadable — leave it */ }
}

export async function atomicWrite(targetPath, content, {
    mode,
    signal,
    sessionId,
    flags,
    fsync,
    preserveMetadata = false,
    expectedTargetSnapshot,
} = {}) {
    const traceStart = ioTraceStart();
    let resolvedSignal = signal;
    if (!resolvedSignal && sessionId) {
        try { resolvedSignal = await getAbortSignalForSession(sessionId); } catch { resolvedSignal = null; }
    }
    const abortReason = () => {
        const r = resolvedSignal?.reason;
        if (r instanceof Error) return r;
        if (typeof r === 'string' && r) return new Error(r);
        return new Error('atomicWrite aborted');
    };
    if (resolvedSignal?.aborted) throw abortReason();

    const dir = dirname(targetPath);
    const rnd = randomBytes(4).toString('hex');
    const tmp = join(dir, `.${basename(targetPath)}.mixdog-tmp-${rnd}`);
    let effectiveMode = mode;
    let existingStat = null;
    try { existingStat = statSync(targetPath); } catch { /* target doesn't exist */ }
    if (effectiveMode === undefined && existingStat) {
        effectiveMode = existingStat.mode & 0o777;
    }
    if (effectiveMode === undefined) effectiveMode = 0o644;

    const contentByteLength = Buffer.isBuffer(content)
        ? content.length
        : Buffer.byteLength(String(content ?? ''), 'utf-8');
    const useStreaming = contentByteLength > STREAMING_THRESHOLD_BYTES;

    let fh = null;
    try {
        if (useStreaming) {
            // Streaming path: avoid buffering the entire payload through
            // fh.writeFile (which copies into a single Buffer). createWriteStream
            // on 'wx' still rejects collisions / pre-existing symlinks.
            const ws = createWriteStream(tmp, { flags: 'wx', mode: effectiveMode });
            const source = Buffer.isBuffer(content)
                ? Readable.from([content])
                : (typeof content === 'string'
                    ? Readable.from([Buffer.from(content, 'utf-8')])
                    : content); // assume it's a Readable already
            await pipeline(source, ws);
            if (atomicWriteShouldFsync(fsync)) {
                fh = await fsPromises.open(tmp, 'r+');
                await fh.sync();
                await fh.close();
                fh = null;
            }
        } else {
            // 'wx' rejects an existing temp file (random collision or a
            // pre-existing symlink at the temp path) instead of silently
            // truncating it. randomBytes(4) keeps collisions astronomically
            // unlikely, but 'wx' makes the guarantee explicit and protects
            // against symlink-attack scenarios on shared tmp dirs.
            fh = await fsPromises.open(tmp, 'wx', effectiveMode);
            await fh.writeFile(content);
            if (atomicWriteShouldFsync(fsync)) await fh.sync();
            await fh.close();
            fh = null;
        }
    } catch (writeErr) {
        try { if (fh) await fh.close(); } catch { /* already closed */ }
        try { await fsPromises.unlink(tmp); } catch { /* already gone */ }
        throw writeErr;
    }

    // Opt-in metadata preservation: capture utimes/owner from the existing
    // target and apply to the temp file before rename. Skip chown on Windows
    // (process.geteuid is absent). Best-effort — failures are non-fatal.
    if (preserveMetadata && existingStat) {
        try {
            await fsPromises.utimes(tmp, existingStat.atime, existingStat.mtime);
        } catch { /* best-effort */ }
        if (process.platform !== 'win32' && typeof process.geteuid === 'function') {
            try {
                await fsPromises.chown(tmp, existingStat.uid, existingStat.gid);
            } catch { /* best-effort: requires privilege or same-owner */ }
        }
    }

    if (flags === 'wx') {
        let excl = null;
        try {
            excl = await fsPromises.open(targetPath, 'wx');
            await excl.close();
        } catch (exclErr) {
            if (excl) try { await excl.close(); } catch { /* already closed */ }
            try { await fsPromises.unlink(tmp); } catch { /* already gone */ }
            throw Object.assign(
                new Error(`create target already exists (race detected): ${targetPath}`),
                { code: 'EEXIST', __skip: true }
            );
        }
    }

    if (resolvedSignal?.aborted) {
        try { await fsPromises.unlink(tmp); } catch { /* already gone */ }
        if (flags === 'wx') await cleanupEmptyWxTarget(targetPath);
        throw abortReason();
    }

    let lastErr = null;
    const maxAttempts = process.platform === 'win32' ? WINDOWS_RENAME_RETRY_BACKOFFS_MS.length + 1 : 1;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (expectedTargetSnapshot) {
            let currentStat = null;
            try { currentStat = statSync(targetPath); } catch { currentStat = null; }
            if (expectedTargetSnapshotChanged(currentStat, expectedTargetSnapshot)) {
                try { await fsPromises.unlink(tmp); } catch { /* already gone */ }
                const err = new Error(`target changed between preflight and rename (TOCTOU): ${targetPath}`);
                err.code = 'ESTALE_TARGET';
                throw err;
            }
        }
        try {
            await fsPromises.rename(tmp, targetPath);
            // When fsync is requested, also fsync the parent directory so
            // the rename itself is durable across power-loss. Directory
            // fsync is a no-op / unsupported on Windows; swallow EPERM /
            // EISDIR / EINVAL there.
            if (atomicWriteShouldFsync(fsync)) {
                let dirHandle = null;
                try {
                    dirHandle = await fsPromises.open(dir, 'r');
                    await dirHandle.sync();
                } catch { /* unsupported on this platform — best effort */ }
                finally {
                    if (dirHandle) try { await dirHandle.close(); } catch { /* already closed */ }
                }
            }
            ioTraceDone('atomic_write', traceStart, {
                pathHash: hashText(targetPath).slice(0, 12),
                bytes: Buffer.isBuffer(content) ? content.length : Buffer.byteLength(String(content ?? ''), 'utf-8'),
                flags: flags || '',
                fsync: atomicWriteShouldFsync(fsync),
                attempts: attempt + 1,
            });
            return;
        } catch (err) {
            lastErr = err;
            const code = err && err.code;
            if (process.platform === 'win32' && WINDOWS_RENAME_RETRY_CODES.has(code) && attempt < maxAttempts - 1) {
                await sleep(WINDOWS_RENAME_RETRY_BACKOFFS_MS[attempt] + Math.floor(Math.random() * 40));
                continue;
            }
            break;
        }
    }
    try { await fsPromises.unlink(tmp); } catch { /* already gone */ }
    if (flags === 'wx') await cleanupEmptyWxTarget(targetPath);
    throw lastErr;
}
