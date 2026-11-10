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
import { readWorkerRecordHeader } from './store-agent-worker-header.mjs';
import { ABSENT_RECORD_STAMP, isSettledRecordStamp, sessionRecordFilesOf } from './store/session-record.mjs';
import { sessionRecordStampSync } from './store/session-log-reader.mjs';
import { serveWorkerRequests } from '../../../shared/worker-requests.mjs';

// `path` names the session by its legacy record path; its stamp is the
// record stamp (log and json).
function stampOrNull(path) {
  try {
    const stamp = sessionRecordStampSync(sessionRecordFilesOf(path));
    return stamp === ABSENT_RECORD_STAMP ? null : stamp;
  } catch {
    return null;
  }
}

function probe(path, known, fields) {
  const before = stampOrNull(path);
  if (!before) return { absent: true };
  if (known === before) return { same: true };
  let header = null;
  try {
    header = readWorkerRecordHeader(path, fields);
  } catch {
    return { unreadable: true };
  }
  if (!header) return { unreadable: true };
  return {
    header,
    stamp: before,
    settled: isSettledRecordStamp(before) && before === stampOrNull(path),
  };
}

serveWorkerRequests(({ fields, entries }) => entries.map(([path, known]) => probe(path, known, fields)));
