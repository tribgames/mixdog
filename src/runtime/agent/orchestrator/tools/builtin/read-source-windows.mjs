import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { getReadRangeIndex, nearestReadRangeAnchor, maybeRecordReadRangeAnchor, scheduleReadRangeIndexPersist } from './read-range-index.mjs';
import { READ_MAX_SCAN_BYTES, READ_STREAM_TIMEOUT_MS } from './read-constants.mjs';

// Raw, one-based inclusive source windows. Callers merge/sort intervals first.
// Unlike the display reader, this never truncates a line into usable patch text.
export async function readSourceWindows(path, intervals, { signal } = {}) {
    signal?.throwIfAborted();
    if (!intervals.length) return new Map();
    const handle = await open(path, 'r');
    try {
        const st = await handle.stat();
        if (!st.isFile()) throw new Error('source context requires a regular file');
        const index = await getReadRangeIndex(path, st, handle);
        const anchor = nearestReadRangeAnchor(index, intervals[0].start - 1);
        let position = anchor.byteOffset;
        let line = anchor.line + 1;
        let interval = 0;
        let scanned = 0;
        let retained = 0;
        let parts = [];
        let partBytes = 0;
        const lines = new Map();
        const buffer = Buffer.allocUnsafe(64 * 1024);
        const deadline = Date.now() + READ_STREAM_TIMEOUT_MS;
        const check = () => {
            signal?.throwIfAborted();
            if (Date.now() > deadline) throw new Error('source context read timed out');
        };
        const save = (segment, complete) => {
            if (line < intervals[interval].start) return;
            retained += segment.length;
            partBytes += segment.length;
            if (retained > 8 * 1024 * 1024 || partBytes > 1024 * 1024) {
                throw new Error('source context exceeds the bounded raw-text budget');
            }
            if (!complete) {
                parts.push(Buffer.from(segment));
                return;
            }
            let bytes = parts.length ? Buffer.concat([...parts, segment], partBytes) : segment;
            if (bytes.at(-1) === 13) bytes = bytes.subarray(0, bytes.length - 1);
            lines.set(line, bytes.toString('utf8'));
            parts = [];
            partBytes = 0;
        };
        while (interval < intervals.length) {
            check();
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
            check();
            if (!bytesRead) {
                if (partBytes) save(Buffer.alloc(0), true);
                break;
            }
            scanned += bytesRead;
            if (scanned > READ_MAX_SCAN_BYTES) throw new Error('source context scan exceeds byte budget');
            if (position === 0 && !index.prefixHash) {
                index.prefixHash = createHash('sha256').update(buffer.subarray(0, bytesRead)).digest('hex');
                scheduleReadRangeIndexPersist(index);
            }
            let start = 0;
            while (start < bytesRead && interval < intervals.length) {
                const end = buffer.indexOf(10, start);
                if (end < 0 || end >= bytesRead) {
                    save(buffer.subarray(start, bytesRead), false);
                    break;
                }
                save(buffer.subarray(start, end), true);
                line++;
                maybeRecordReadRangeAnchor(index, line - 1, position + end + 1);
                while (interval < intervals.length && line > intervals[interval].end) interval++;
                start = end + 1;
            }
            position += bytesRead;
        }
        return lines;
    } finally {
        await handle.close();
    }
}
