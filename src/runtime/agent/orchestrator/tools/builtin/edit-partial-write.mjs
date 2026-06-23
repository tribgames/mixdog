import { openSync, writeSync, closeSync, fsyncSync, statSync } from 'fs';
import { normalizeErrorMessage } from './path-diagnostics.mjs';
import { hashText } from './hash-utils.mjs';
import { partialByteWriteEnabled } from './edit-byte-utils.mjs';
import { atomicWriteShouldFsync } from './atomic-write.mjs';

function partialWriteHooks(hooks = {}) {
    return {
        ioTraceStart: typeof hooks.ioTraceStart === 'function' ? hooks.ioTraceStart : () => 0,
        ioTraceDone: typeof hooks.ioTraceDone === 'function' ? hooks.ioTraceDone : () => {},
        validatePreparedEditBase: typeof hooks.validatePreparedEditBase === 'function' ? hooks.validatePreparedEditBase : () => null,
    };
}

export function tryWriteSameSizeByteReplacementsSync(fullPath, replacements, { baseStatSnapshot, baseMutationGeneration, baseContentHash, contentHash, fsync, filePath } = {}, hooks = {}) {
    const { ioTraceStart, ioTraceDone, validatePreparedEditBase } = partialWriteHooks(hooks);
    if (!partialByteWriteEnabled()) return null;
    if (!Array.isArray(replacements) || replacements.length === 0 || !baseStatSnapshot) return null;
    const sorted = replacements.slice().sort((a, b) => a.start - b.start || a.end - b.end);
    for (let i = 0; i < sorted.length; i++) {
        const span = sorted[i];
        if (!span || !Buffer.isBuffer(span.newBytes)) return null;
        if (!Number.isFinite(span.start) || !Number.isFinite(span.end) || span.start < 0 || span.end < span.start) return null;
        if (span.end - span.start !== span.newBytes.length) return null;
        if (i > 0 && span.start < sorted[i - 1].end) return null;
    }
    const prewriteErr = validatePreparedEditBase({
        fullPath,
        filePath: filePath || fullPath,
        baseStatSnapshot,
        baseMutationGeneration,
        baseContentHash,
    });
    if (prewriteErr) return { ok: false, error: prewriteErr };
    const traceStart = ioTraceStart();
    let fd = null;
    try {
        fd = openSync(fullPath, 'r+');
        for (const span of sorted) {
            writeSync(fd, span.newBytes, 0, span.newBytes.length, span.start);
        }
        if (atomicWriteShouldFsync(fsync)) {
            try { fsyncSync(fd); } catch (err) {
                if (!['EPERM', 'ENOTSUP', 'EINVAL'].includes(err?.code)) throw err;
            }
        }
    } catch (err) {
        return { ok: false, error: `Error: partial byte write failed — ${normalizeErrorMessage(err instanceof Error ? err.message : String(err))}` };
    } finally {
        try { if (fd !== null) closeSync(fd); } catch {}
    }
    let stat = null;
    try { stat = statSync(fullPath); } catch {}
    ioTraceDone('edit_partial_write', traceStart, {
        pathHash: hashText(fullPath).slice(0, 12),
        replacements: sorted.length,
        bytes: sorted.reduce((sum, span) => sum + span.newBytes.length, 0),
    });
    return { ok: true, stat, contentHash };
}
