/**
 * Per-file buffered append queue.
 *
 * Hot paths (transcript writer, channel worker stderr log, etc.) previously
 * called appendFileSync per entry/chunk, which blocks the event loop on
 * every write. This module coalesces writes per path into an in-memory
 * buffer and flushes asynchronously via fs.promises.appendFile once the
 * buffer reaches BUFFER_FLUSH_BYTES or after DEBOUNCE_MS of inactivity.
 * Flushes are serialized per path so ordering is preserved. On process
 * exit, any remaining buffered bytes for every path are drained with one
 * synchronous appendFileSync call each (best-effort, matching the
 * agent-trace.mjs local spool exit-drain pattern).
 */
import { appendFileSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';

const BUFFER_FLUSH_BYTES = 32 * 1024;
const DEBOUNCE_MS = 50;
// Per path: comfortably above normal transcript/log bursts while bounding
// producer memory when a filesystem append is stalled.
export const BUFFERED_APPEND_MAX_BYTES = 8 * 1024 * 1024;
let totalDroppedBufferedBytes = 0;
const droppedBytesByPath = new Map();

// path -> { chunks: string[], bytes: number, timer, flushing, inFlight, failCount, droppedBytes }
const queues = new Map();

function getQueue(path) {
    let q = queues.get(path);
    if (!q) {
        q = {
            chunks: [], bytes: 0, timer: null, flushing: false, inFlight: null,
            failCount: 0, droppedBytes: droppedBytesByPath.get(path) ?? 0, path,
        };
        queues.set(path, q);
    }
    return q;
}

function scheduleFlush(path, q) {
    if (q.timer) return;
    q.timer = setTimeout(() => {
        q.timer = null;
        _flush(path, q);
    }, DEBOUNCE_MS);
    q.timer.unref?.();
}

function deleteIfIdle(path, q) {
    if (!q.timer && !q.flushing && !q.inFlight && q.chunks.length === 0
        && queues.get(path) === q) {
        queues.delete(path);
    }
}

function recordDroppedBytes(q, bytes) {
    q.droppedBytes += bytes;
    totalDroppedBufferedBytes += bytes;
    droppedBytesByPath.set(q.path, q.droppedBytes);
}

function keepNewestUtf8(text, maxBytes, totalBytes) {
    // At most maxBytes UTF-16 code units are encoded (plus one code unit when
    // the slice would split a surrogate pair), bounding this work even when a
    // producer supplies an arbitrarily large string.
    let windowStart = Math.max(0, text.length - maxBytes);
    if (windowStart > 0
        && /[\uDC00-\uDFFF]/.test(text[windowStart])
        && /[\uD800-\uDBFF]/.test(text[windowStart - 1])) {
        windowStart -= 1;
    }
    const bytes = Buffer.from(text.slice(windowStart), 'utf8');
    let start = Math.max(0, bytes.length - maxBytes);
    while (start < bytes.length && (bytes[start] & 0xC0) === 0x80) start += 1;
    return {
        text: bytes.subarray(start).toString('utf8'),
        bytes: bytes.length - start,
        droppedBytes: totalBytes - (bytes.length - start),
    };
}

function capIncomingText(text) {
    // A single native byteLength pass keeps queue accounting and flush timing
    // exact; only oversized input uses bounded tail-window encoding below.
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes <= BUFFERED_APPEND_MAX_BYTES) return { text, bytes, droppedBytes: 0 };
    return keepNewestUtf8(text, BUFFERED_APPEND_MAX_BYTES, bytes);
}

function trimBufferedQueue(q) {
    while (q.bytes > BUFFERED_APPEND_MAX_BYTES && q.chunks.length > 0) {
        const oldest = q.chunks[0];
        const oldestBytes = Buffer.byteLength(oldest, 'utf8');
        const overflowBytes = q.bytes - BUFFERED_APPEND_MAX_BYTES;
        if (oldestBytes <= overflowBytes) {
            q.chunks.shift();
            q.bytes -= oldestBytes;
            recordDroppedBytes(q, oldestBytes);
            continue;
        }

        const retained = keepNewestUtf8(oldest, oldestBytes - overflowBytes, oldestBytes);
        const removedBytes = oldestBytes - retained.bytes;
        q.chunks[0] = retained.text;
        q.bytes -= removedBytes;
        recordDroppedBytes(q, removedBytes);
        // A character-boundary trim can remove up to three extra bytes rather
        // than split a code point or exceed the hard byte cap.
        if (q.bytes > BUFFERED_APPEND_MAX_BYTES) continue;
    }
}

function _flush(path, q) {
    if (q.flushing) return;
    if (q.chunks.length === 0) return;
    const data = q.chunks.join('');
    q.chunks = [];
    q.bytes = 0;
    // Hold the in-flight payload until the write settles so an exit-time
    // sync drain can still recover it if it fires mid-write (fix: exit
    // drain must not miss data that was dequeued but not yet persisted).
    q.inFlight = data;
    q.flushing = true;
    appendFile(path, data, 'utf8')
        .then(() => {
            q.failCount = 0;
        })
        .catch(() => {
            // Requeue the failed data so a later flush/exit-drain retries
            // once, instead of silently dropping. Cap retries so a
            // permanently broken path (e.g. deleted dir) cannot loop
            // forever accumulating the same failing chunk.
            q.failCount += 1;
            if (q.failCount <= 3) {
                q.chunks.unshift(data);
                q.bytes += Buffer.byteLength(data, 'utf8');
                trimBufferedQueue(q);
            }
        })
        .finally(() => {
            q.inFlight = null;
            q.flushing = false;
            if (q.chunks.length > 0) {
                if (q.bytes >= BUFFER_FLUSH_BYTES) _flush(path, q);
                else scheduleFlush(path, q);
            } else deleteIfIdle(path, q);
        });
}

/**
 * Queue text for buffered append to `path`. Flushes async once the buffer
 * for that path crosses BUFFER_FLUSH_BYTES, or after DEBOUNCE_MS of
 * inactivity, whichever comes first.
 */
export function appendBuffered(path, text) {
    if (!path || !text) return;
    const q = getQueue(path);
    const incoming = capIncomingText(text);
    q.chunks.push(incoming.text);
    q.bytes += incoming.bytes;
    if (incoming.droppedBytes > 0) recordDroppedBytes(q, incoming.droppedBytes);
    trimBufferedQueue(q);
    if (q.bytes >= BUFFER_FLUSH_BYTES) {
        if (q.timer) { clearTimeout(q.timer); q.timer = null; }
        _flush(path, q);
    } else {
        scheduleFlush(path, q);
    }
}

/** Observable overflow counters for buffered append queues. */
export function getBufferedAppenderStats(path) {
    const q = queues.get(path);
    return {
        bufferedBytes: q?.bytes ?? 0,
        droppedBytes: q?.droppedBytes ?? droppedBytesByPath.get(path) ?? 0,
        totalDroppedBytes: totalDroppedBufferedBytes,
    };
}

/**
 * Synchronously drain any remaining buffered bytes for every known path.
 * Intended for process exit hooks only — best-effort, never throws.
 */
export function drainAllSync() {
    for (const [path, q] of queues) {
        drainPathSync(path);
    }
}

/**
 * Synchronously drain the queue for a single path. Writes any in-flight
 * (already-dequeued but not yet persisted) payload FIRST, then any
 * still-queued chunks, so nothing buffered is lost. Best-effort, never
 * throws.
 */
export function drainPathSync(path) {
    const q = queues.get(path);
    if (!q) return;
    if (q.timer) { clearTimeout(q.timer); q.timer = null; }
    if (q.inFlight) {
        try {
            appendFileSync(path, q.inFlight, 'utf8');
        } catch {
            // Best-effort; nothing to recover from here.
        }
        q.inFlight = null;
    }
    if (q.chunks.length === 0) {
        deleteIfIdle(path, q);
        return;
    }
    const data = q.chunks.join('');
    q.chunks = [];
    q.bytes = 0;
    try {
        appendFileSync(path, data, 'utf8');
    } catch {
        // Best-effort exit drain; nothing to recover from here.
    }
    deleteIfIdle(path, q);
}

/**
 * True if a path currently has an async write in flight. Callers that need
 * to rename/rotate the underlying file (which would race a concurrent
 * appendFile on some platforms, notably Windows) should check this and
 * defer the rename to a later tick rather than racing it.
 */
export function hasInFlightWrite(path) {
    const q = queues.get(path);
    return Boolean(q && q.inFlight);
}

try {
    process.on('exit', drainAllSync);
} catch {
    // Ignore lifecycle hook failures in embedded runtimes.
}
