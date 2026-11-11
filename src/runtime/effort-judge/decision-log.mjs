// The effort judge's decision log. One line per judgment adds up quickly (every
// tool-result step of every agent is one: a log left to grow reached 134 MB),
// and what stays useful of an old judgment is how often each outcome happened,
// not the line itself. So the log is three files beside each other:
//   decisions.jsonl          the newest judgments as written, up to one segment
//   decisions.1.jsonl        the segment before it
//   decisions-summary.jsonl  everything older, as counts per day, route and kind
// When the newest file passes a segment, the previous segment is counted into
// the summary and removed, and the newest takes its place. The counting runs
// off the turn's path and reads the segment as a stream.
import { appendFileSync, createReadStream, mkdirSync, statSync } from 'node:fs';
import { appendFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

/** About 17,000 judgments. */
export const DECISION_SEGMENT_BYTES = 4 * 1024 * 1024;

const MS_BUCKETS = [100, 200, 300, 500];

function msBucket(ms) {
  for (const limit of MS_BUCKETS) if (ms < limit) return `under${limit}`;
  return `from${MS_BUCKETS.at(-1)}`;
}

function bump(counts, key) {
  counts[key] = (counts[key] || 0) + 1;
}

const sortedCounts = (counts) => Object.fromEntries(Object.keys(counts).sort().map((key) => [key, counts[key]]));

/**
 * Counts decision lines into one row per day, provider, model and kind (a
 * turn's judgment or a tool-result step's). Every count of a row adds up with
 * the same row of another segment, so the latency is kept as buckets, not as
 * percentiles. `sessions` is the number of sessions seen in this segment.
 */
export function createDecisionSummary() {
  const rows = new Map();
  return {
    add(line) {
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        return;
      }
      const at = typeof entry?.at === 'string' ? entry.at : '';
      if (at.length < 10) return;
      const kind = entry.atStep === undefined ? 'turn' : 'step';
      const provider = String(entry.provider ?? '');
      const model = String(entry.model ?? '');
      const key = JSON.stringify([at.slice(0, 10), provider, model, kind]);
      let row = rows.get(key);
      if (!row) {
        row = {
          day: at.slice(0, 10),
          provider,
          model,
          kind,
          from: at,
          to: at,
          judged: 0,
          sessions: new Set(),
          skipped: {},
          efforts: {},
          ms: {},
        };
        rows.set(key, row);
      }
      if (at < row.from) row.from = at;
      if (at > row.to) row.to = at;
      row.judged += 1;
      if (entry.sessionId) row.sessions.add(entry.sessionId);
      // `load-error: <message>` carries the message; the reason is what counts.
      if (entry.skipped !== undefined) bump(row.skipped, String(entry.skipped).split(':')[0]);
      else if (entry.effort !== undefined) bump(row.efforts, `${entry.base ?? ''}>${entry.effort}`);
      if (Number.isFinite(entry.ms)) bump(row.ms, msBucket(entry.ms));
    },
    rows() {
      return [...rows.keys()].sort().map((key) => {
        const row = rows.get(key);
        return {
          ...row,
          sessions: row.sessions.size,
          skipped: sortedCounts(row.skipped),
          efforts: sortedCounts(row.efforts),
          ms: sortedCounts(row.ms),
        };
      });
    },
  };
}

const sibling = (file, suffix) => `${file.replace(/\.jsonl$/, '')}${suffix}`;

// Counts `segment` into `summary` and removes it; a segment that is not there is nothing to do.
async function fold(segment, summary) {
  const counts = createDecisionSummary();
  try {
    let rest = '';
    for await (const chunk of createReadStream(segment, 'utf8')) {
      const lines = `${rest}${chunk}`.split('\n');
      rest = lines.pop();
      for (const line of lines) if (line) counts.add(line);
    }
    if (rest) counts.add(rest);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  const rows = counts.rows();
  if (rows.length) await appendFile(summary, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
  await unlink(segment);
}

const logs = new Map();

/**
 * The log at `file`: `record(entry)` appends one line and, past a segment,
 * starts the rotation; `settled()` resolves when no rotation is running.
 */
export function decisionLog(file, { segmentBytes = DECISION_SEGMENT_BYTES } = {}) {
  let log = logs.get(file);
  if (log) return log;
  const previous = sibling(file, '.1.jsonl');
  const leaving = sibling(file, '.leaving.jsonl');
  const summary = sibling(file, '-summary.jsonl');
  // Other processes append to the same file; the size is read when this one starts and again before a rotation.
  let bytes = null;
  let rotating = null;
  const sizeOnDisk = () => {
    try {
      return statSync(file).size;
    } catch {
      return 0;
    }
  };
  async function rotate() {
    // A segment a stopped process left half-counted goes first.
    await fold(leaving, summary);
    const size = sizeOnDisk();
    if (size <= segmentBytes) {
      // Another process rotated it.
      bytes = size;
      return;
    }
    if (size > 2 * segmentBytes) {
      // A log from before segments existed: counted whole, not kept as a segment.
      await rename(file, leaving);
    } else {
      await rename(previous, leaving).catch(() => {});
      await rename(file, previous);
    }
    bytes = 0;
    await fold(leaving, summary);
  }
  log = {
    record(entry) {
      const line = `${JSON.stringify(entry)}\n`;
      try {
        appendFileSync(file, line);
      } catch {
        mkdirSync(dirname(file), { recursive: true });
        appendFileSync(file, line);
      }
      bytes = (bytes ?? sizeOnDisk() - Buffer.byteLength(line)) + Buffer.byteLength(line);
      if (bytes > segmentBytes && !rotating) {
        rotating = rotate()
          .catch(() => {
            /* the log is diagnostic only; the next record past the segment tries again */
            bytes = null;
          })
          .finally(() => {
            rotating = null;
          });
      }
    },
    settled: () => rotating ?? Promise.resolve(),
  };
  logs.set(file, log);
  return log;
}
