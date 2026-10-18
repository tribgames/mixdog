/**
 * Top-level field read of a serialized session record without materializing
 * its transcript.
 *
 * The agent pool needs a handful of top-level fields per worker session, yet
 * `JSON.parse` of the whole record built every message object — megabytes per
 * worker — on each rewrite the worker persisted. The record is instead proven
 * valid by the strict grammar walk of store-record-strict-scan.mjs, which
 * decodes only the requested members; a record it cannot prove (malformed,
 * duplicate top-level keys, pretty-printed, non-object root) is read by the
 * full parse itself.
 *
 * Contract: the result equals picking `fields` (in `fields` order, own
 * properties only) from `JSON.parse(bytes.toString('utf8'))` when that is an
 * object or an array (an array root picks none), and is `null` otherwise —
 * a document the full parse rejects included.
 */
import { provenTopLevelObject } from './store-record-strict-scan.mjs';

export function readTopLevelFields(bytes, fields) {
  const wanted = new Set(fields);
  let doc = provenTopLevelObject(bytes, (key) => wanted.has(key));
  if (!doc) {
    try {
      doc = JSON.parse(bytes.toString('utf8'));
    } catch {
      return null;
    }
    if (!doc || typeof doc !== 'object') return null;
  }
  const picked = {};
  for (const field of fields) {
    if (Object.hasOwn(doc, field)) picked[field] = doc[field];
  }
  return picked;
}
