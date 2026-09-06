import { readFileSync } from 'node:fs';
import { readTopLevelLifecycleRecord, isLifecycleUnreadable } from '../lifecycle-scan.mjs';

export const CANONICAL_RECORD_UNREADABLE = Symbol('lifecycle-ambiguous');

/** Reads CURRENT bytes on every call. Only byte-identical content may reuse a
 * decoded primitive authority; mtime/size are never sufficient for a guard.
 * Full lifecycle barriers always receive a fresh, privately owned document. */
export function createCanonicalSessionReader({
    readText = (target) => readFileSync(target, 'utf-8'),
    maxEntries = 8,
    maxTextChars = 32 * 1024 * 1024,
} = {}) {
    const entries = new Map();
    let retainedChars = 0;
    const forget = (target) => {
        const entry = entries.get(target);
        if (entry) retainedChars -= entry.raw.length;
        entries.delete(target);
    };
    const read = (target, lifecycleOnly = false) => {
        let raw;
        try {
            raw = readText(target);
        } catch (error) {
            forget(target);
            return error?.code === 'ENOENT' || error?.code === 'ENOTDIR'
                ? null
                : CANONICAL_RECORD_UNREADABLE;
        }
        if (lifecycleOnly) {
            const cached = entries.get(target);
            if (cached && cached.raw === raw) {
                entries.delete(target);
                entries.set(target, cached);
                return cached.value;
            }
        }
        const record = readTopLevelLifecycleRecord(raw);
        const invalid = isLifecycleUnreadable(record);
        if (!lifecycleOnly) return invalid ? CANONICAL_RECORD_UNREADABLE : record;
        const value = invalid
            ? CANONICAL_RECORD_UNREADABLE
            : Object.freeze({ id: record.id, closed: record.closed, generation: record.generation });
        forget(target);
        if (typeof raw === 'string' && raw.length <= maxTextChars && maxEntries > 0) {
            entries.set(target, { raw, value });
            retainedChars += raw.length;
            while (entries.size > maxEntries || retainedChars > maxTextChars) {
                forget(entries.keys().next().value);
            }
        }
        return value;
    };
    return Object.assign(read, {
        forget,
        clear() { entries.clear(); retainedChars = 0; },
        stats: () => ({ entries: entries.size, retainedChars }),
    });
}

export const readCanonicalSessionRecord = createCanonicalSessionReader();
