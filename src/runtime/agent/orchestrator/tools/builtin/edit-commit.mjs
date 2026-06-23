import { markCodeGraphDirtyPaths } from '../code-graph.mjs';
import { atomicWrite } from './atomic-write.mjs';
import {
    invalidateBuiltinResultCache,
    seedRawContentCacheAfterWrite,
} from './cache-layers.mjs';
import { captureExpectedTargetSnapshot, materialiseByteReplacements } from './edit-byte-utils.mjs';
import { postEditSnapshotMeta } from './edit-context-utils.mjs';
import { tryWriteSameSizeByteReplacementsSync } from './edit-partial-write.mjs';
import { recordReadSnapshot } from './read-snapshot-runtime.mjs';
import { validatePreparedEditBase } from './edit-base-guard.mjs';

function commitHooks(hooks = {}) {
    return {
        ioTraceStart: typeof hooks.ioTraceStart === 'function' ? hooks.ioTraceStart : () => 0,
        ioTraceDone: typeof hooks.ioTraceDone === 'function' ? hooks.ioTraceDone : () => {},
    };
}

export async function commitPreparedEditUnlocked(prepared, readStateScope, options = {}, hooks = {}) {
    const traceHooks = commitHooks(hooks);
    if (Array.isArray(prepared.sameSizeByteReplacements) && prepared.sameSizeByteReplacements.length > 0) {
        const partial = tryWriteSameSizeByteReplacementsSync(prepared.fullPath, prepared.sameSizeByteReplacements, {
            baseStatSnapshot: prepared.baseStatSnapshot,
            baseMutationGeneration: prepared.baseMutationGeneration,
            baseContentHash: prepared.baseContentHash,
            contentHash: prepared.contentHash,
            fsync: options?.fsync,
            filePath: prepared.filePath,
        }, {
            ...traceHooks,
            validatePreparedEditBase,
        });
        if (partial?.ok) {
            invalidateBuiltinResultCache([prepared.fullPath]);
            markCodeGraphDirtyPaths([prepared.fullPath]);
            const afterBuf = materialiseByteReplacements(prepared.baseRawContent, prepared.sameSizeByteReplacements);
            const snapMeta = postEditSnapshotMeta(prepared.snapshot, 'edit', afterBuf, {
                contentBeforeEdit: prepared.baseRawContent,
                shiftRanges: false,
            });
            recordReadSnapshot(prepared.fullPath, partial.stat || undefined, readStateScope, snapMeta);
            return;
        }
        if (partial?.error) throw new Error(partial.error.replace(/^Error:\s*/, ''));
        if (!Buffer.isBuffer(prepared.content) && Buffer.isBuffer(prepared.baseRawContent)) {
            prepared.content = materialiseByteReplacements(prepared.baseRawContent, prepared.sameSizeByteReplacements);
        }
    }
    if (!Buffer.isBuffer(prepared.content) && typeof prepared.content !== 'string') {
        throw new Error('prepared edit missing materialised content');
    }
    const expectedTargetSnapshot = prepared.expectedTargetSnapshot
        || captureExpectedTargetSnapshot(prepared.fullPath);
    await atomicWrite(prepared.fullPath, prepared.content, {
        sessionId: options?.sessionId,
        mode: prepared.baseMode,
        expectedTargetSnapshot,
    });
    invalidateBuiltinResultCache([prepared.fullPath]);
    const writtenStat = seedRawContentCacheAfterWrite(prepared.fullPath, prepared.content);
    markCodeGraphDirtyPaths([prepared.fullPath]);
    recordReadSnapshot(prepared.fullPath, writtenStat || undefined, readStateScope, postEditSnapshotMeta(prepared.snapshot, 'edit', prepared.content, {
        contentBeforeEdit: prepared.baseRawContent,
        shiftRanges: false,
    }));
}

export async function commitPreparedEditCheckedUnlocked(prepared, readStateScope, options = {}, hooks = {}) {
    const prewriteErr = validatePreparedEditBase(prepared);
    if (prewriteErr) return { ok: false, error: prewriteErr };
    await commitPreparedEditUnlocked(prepared, readStateScope, options, hooks);
    return { ok: true };
}