// Non-blocking, size-bounded line appender for diagnostic logs.
//
// Callers on hot paths (notification delivery, every session close) used to
// appendFileSync per line and, for one of them, stat + rewrite the file too.
// Here `append` only queues the line; one drain per file writes the batch
// asynchronously, and once the file would pass `maxBytes` it is cut down to
// its last `keepBytes` (whole lines) before the next batch lands. Best effort:
// a failed write drops its batch and never throws into the caller.
import { appendFile, readFile, stat, writeFile } from 'node:fs/promises';

// A wedged disk must not turn the queue into a memory leak.
const MAX_QUEUED_LINES = 4096;
// Other processes append to the same file; re-measure now and then.
const RESTAT_EVERY_DRAINS = 256;

export function createAsyncLogAppender({ maxBytes, keepBytes }) {
  /** path -> { lines, bytes (last known size or null), drains, running } */
  const lanes = new Map();

  async function measure(path) {
    try {
      return (await stat(path)).size;
    } catch {
      return 0;
    }
  }

  async function rotate(path) {
    const buffer = await readFile(path);
    if (buffer.length <= maxBytes) return buffer.length;
    let tail = buffer.subarray(buffer.length - keepBytes);
    // Start on a line boundary so no half line survives rotation.
    const newline = tail.indexOf(0x0a);
    if (newline >= 0 && newline + 1 < tail.length) tail = tail.subarray(newline + 1);
    await writeFile(path, tail);
    return tail.length;
  }

  async function drain(path, lane) {
    try {
      if (lane.bytes === null || ++lane.drains % RESTAT_EVERY_DRAINS === 0) lane.bytes = await measure(path);
      while (lane.lines.length > 0) {
        const chunk = lane.lines.join('');
        lane.lines = [];
        const size = Buffer.byteLength(chunk);
        if (lane.bytes + size > maxBytes) {
          lane.bytes = await measure(path);
          if (lane.bytes + size > maxBytes) lane.bytes = await rotate(path);
        }
        await appendFile(path, chunk);
        lane.bytes += size;
      }
    } catch {
      lane.bytes = null;
      lane.lines = [];
    } finally {
      lane.running = null;
      if (lane.lines.length > 0) lane.running = drain(path, lane);
    }
  }

  return {
    /** Queue one already-terminated line for `path`. */
    append(path, line) {
      let lane = lanes.get(path);
      if (!lane) {
        lane = { lines: [], bytes: null, drains: 0, running: null };
        lanes.set(path, lane);
      }
      lane.lines.push(line);
      if (lane.lines.length > MAX_QUEUED_LINES) lane.lines.shift();
      if (!lane.running) lane.running = drain(path, lane);
    },
    /** Resolves once everything queued so far has been written (or dropped). */
    async flush() {
      for (;;) {
        const running = [...lanes.values()].map((lane) => lane.running).filter(Boolean);
        if (running.length === 0) return;
        await Promise.all(running);
      }
    },
  };
}
