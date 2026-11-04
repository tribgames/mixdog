/**
 * Worker thread of the agent pool's header probes: one request carries every
 * session path a listing needs, and the answer carries what each probe found.
 * The stat of a path whose stamp is unchanged is the only file access for it;
 * a changed one is read here too, so the listing's thread makes no per-row
 * file call at all (each was an awaited round trip through the shared libuv
 * pool, which a daemon's saturated file I/O queued for seconds).
 *
 * Per path the answer is the same verdict probeWorkerSessionHeaderAsync gives:
 *   { absent }                    no file (or not statable)
 *   { same }                      the stamp equals `known`
 *   { unreadable }                read or parse failed
 *   { header, stamp, settled }    read at `stamp`; `settled` = may be cached
 */
import { readFileSync } from 'node:fs';
import { isSettledSessionStamp, sameSessionStamp, statSessionStamp } from './store/canonical-reader.mjs';
import { readTopLevelFields } from './store-agent-worker-header.mjs';
import { serveWorkerRequests } from '../../../shared/worker-requests.mjs';

function stampOrNull(path) {
  try {
    return statSessionStamp(path);
  } catch {
    return null;
  }
}

function probe(path, known, fields) {
  const before = stampOrNull(path);
  if (!before) return { absent: true };
  if (sameSessionStamp(known, before)) return { same: true };
  let header = null;
  try {
    header = readTopLevelFields(readFileSync(path), fields);
  } catch {
    return { unreadable: true };
  }
  if (!header) return { unreadable: true };
  return {
    header,
    stamp: before,
    settled: isSettledSessionStamp(before) && sameSessionStamp(before, stampOrNull(path)),
  };
}

serveWorkerRequests(({ fields, entries }) => entries.map(([path, known]) => probe(path, known, fields)));
