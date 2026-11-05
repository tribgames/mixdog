/**
 * Session log format: `<id>.log.jsonl`, one JSON record per line, appended
 * only. A session's state is its first record (`session`, the header) and the
 * replacement history after it (`compacted`), folded with every later record
 * in sequence order.
 *
 *   session   {t,s:0,v,logId,id,prev,legacy,header}  header without messages
 *   compacted {t,s,len,messages}                      replacement history: the
 *             base's is s:1 (a log always opens session + compacted); a later
 *             compaction is the next record in sequence, like any other
 *   append    {t,s,len,messages}                      messages added at the end
 *   edit      {t,s,len,at,del,messages}               splice of settled messages
 *   rollback  {t,s,len}                               transcript cut to `len`
 *   patch     {t,s,set,unset}                         header keys set / removed
 *
 * `s` counts from 0 without gaps; `len` is the message count after the
 * record, so every record proves the transcript length it leaves behind.
 * `legacy` = {sha1,size,mtimeMs[,redactedFrom]} of the `<id>.json` the log
 * was built from (`redactedFrom`: that json's sha1 before a redaction).
 */
import { createHash, randomBytes } from 'node:crypto';

export const SESSION_LOG_VERSION = 1;
export const SESSION_LOG_SUFFIX = '.log.jsonl';
export const SESSION_LOG_MIGRATION_ID = 'json-to-log-v1';

export const RECORD = Object.freeze({
  SESSION: 'session',
  COMPACTED: 'compacted',
  APPEND: 'append',
  EDIT: 'edit',
  ROLLBACK: 'rollback',
  PATCH: 'patch',
});

const MESSAGE_RECORDS = new Set([RECORD.COMPACTED, RECORD.APPEND, RECORD.EDIT, RECORD.ROLLBACK]);

export function newLogId() {
  return randomBytes(12).toString('hex');
}

export function sha1Hex(bytes) {
  return createHash('sha1').update(bytes).digest('hex');
}

/** Stat identity of a legacy `<id>.json`: what a base records and a reader compares. */
export function fileFingerprint(stat) {
  return { size: Number(stat.size), mtimeMs: Number(stat.mtimeMs) };
}

export function sameFingerprint(a, b) {
  return !!a && !!b && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

/** `[a,b,…]` from per-item JSON strings already built. */
function jsonArray(items) {
  return `[${items.join(',')}]`;
}

/** One message as stored: JSON of the item, `null` where JSON arrays write it. */
export function messageJson(message) {
  const text = JSON.stringify(message);
  return text === undefined ? 'null' : text;
}

// Every line starts `{"t":"<type>","s":<n>`: the key order below is the
// format, so a line's type and sequence are readable from its first bytes.
export function encodeSessionRecord({ logId, id, prev = null, legacy = null, header }) {
  return `${JSON.stringify({ t: RECORD.SESSION, s: 0, v: SESSION_LOG_VERSION, logId, id, prev, legacy, header })}\n`;
}

export function encodeCompacted(s, messageJsons) {
  return `{"t":"compacted","s":${s},"len":${messageJsons.length},"messages":${jsonArray(messageJsons)}}\n`;
}

export function encodeAppend(s, len, messageJsons) {
  return `{"t":"append","s":${s},"len":${len},"messages":${jsonArray(messageJsons)}}\n`;
}

export function encodeEdit(s, len, at, del, messageJsons) {
  return `{"t":"edit","s":${s},"len":${len},"at":${at},"del":${del},"messages":${jsonArray(messageJsons)}}\n`;
}

export function encodeRollback(s, len) {
  return `{"t":"rollback","s":${s},"len":${len}}\n`;
}

/** `set` maps key → that value's JSON text; `unset` lists removed keys. */
export function encodePatch(s, set, unset) {
  const entries = [];
  for (const [key, json] of set) entries.push(`${JSON.stringify(key)}:${json}`);
  return `{"t":"patch","s":${s},"set":{${entries.join(',')}},"unset":${JSON.stringify(unset)}}\n`;
}

const isCount = (value) => Number.isSafeInteger(value) && value >= 0;
const isPlainObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);

function validFingerprint(value) {
  return (
    value === null ||
    (isPlainObject(value) &&
      typeof value.sha1 === 'string' &&
      isCount(value.size) &&
      typeof value.mtimeMs === 'number' &&
      Number.isFinite(value.mtimeMs) &&
      (value.redactedFrom === undefined || typeof value.redactedFrom === 'string'))
  );
}

/** The record a parsed line holds, or null when it is not one of ours. */
export function decodeRecord(value) {
  if (!isPlainObject(value) || !isCount(value.s)) return null;
  switch (value.t) {
    case RECORD.SESSION:
      if (value.s !== 0 || value.v !== SESSION_LOG_VERSION) return null;
      if (typeof value.logId !== 'string' || !value.logId || typeof value.id !== 'string' || !value.id) return null;
      if (!isPlainObject(value.header) || Object.hasOwn(value.header, 'messages')) return null;
      if (Object.hasOwn(value.header, 'id') && value.header.id !== value.id) return null;
      if (!validFingerprint(value.legacy)) return null;
      if (value.prev !== null && !(isPlainObject(value.prev) && typeof value.prev.logId === 'string')) return null;
      return value;
    case RECORD.COMPACTED:
      return Array.isArray(value.messages) && value.len === value.messages.length ? value : null;
    case RECORD.APPEND:
      return Array.isArray(value.messages) && isCount(value.len) && value.messages.length > 0 ? value : null;
    case RECORD.EDIT:
      return Array.isArray(value.messages) && isCount(value.len) && isCount(value.at) && isCount(value.del)
        ? value
        : null;
    case RECORD.ROLLBACK:
      return isCount(value.len) ? value : null;
    case RECORD.PATCH:
      if (!isPlainObject(value.set) || !Array.isArray(value.unset)) return null;
      if (Object.hasOwn(value.set, 'messages') || value.unset.includes('messages')) return null;
      if (Object.hasOwn(value.set, 'id') || value.unset.includes('id')) return null;
      return value.unset.every((key) => typeof key === 'string') ? value : null;
    default:
      return null;
  }
}

export function isMessageRecord(record) {
  return MESSAGE_RECORDS.has(record.t);
}

/** The transcript length `record` leaves after `current`, or -1 when the
 *  record does not fit the transcript it follows. */
export function lengthAfter(current, record) {
  switch (record.t) {
    case RECORD.COMPACTED:
      return record.len;
    case RECORD.APPEND:
      return record.len === current + record.messages.length ? record.len : -1;
    case RECORD.EDIT:
      return record.at + record.del <= current && record.len === current - record.del + record.messages.length
        ? record.len
        : -1;
    case RECORD.ROLLBACK:
      return record.len <= current ? record.len : -1;
    default:
      return current;
  }
}

/** Apply a message record (already proven by lengthAfter) to `messages`. */
export function applyMessageRecord(messages, record) {
  switch (record.t) {
    case RECORD.COMPACTED:
      messages.length = 0;
      for (const message of record.messages) messages.push(message);
      return;
    case RECORD.APPEND:
      for (const message of record.messages) messages.push(message);
      return;
    case RECORD.EDIT:
      messages.splice(record.at, record.del, ...record.messages);
      return;
    case RECORD.ROLLBACK:
      messages.length = record.len;
      return;
    default:
      throw new Error(`[session-log] not a message record: ${record.t}`);
  }
}

export function applyPatch(header, record) {
  for (const key of record.unset) delete header[key];
  for (const key of Object.keys(record.set)) header[key] = record.set[key];
}

/**
 * Equality as JSON stores it: object key order is free, a key whose value is
 * undefined (or a function) counts as absent, such an array item as null.
 * A base is proven against its legacy load with this.
 */
export function jsonEqual(a, b) {
  const norm = (value) => (value === undefined || typeof value === 'function' ? undefined : value);
  a = norm(a);
  b = norm(b);
  if (a === b) return true;
  if (a === undefined || b === undefined || a === null || b === null) return false;
  if (typeof a !== 'object' || typeof b !== 'object') {
    if (typeof a === 'number' && typeof b === 'number') return JSON.stringify(a) === JSON.stringify(b);
    return false;
  }
  if (typeof a.toJSON === 'function' || typeof b.toJSON === 'function') {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      const x = norm(a[i]) ?? null;
      const y = norm(b[i]) ?? null;
      if (!jsonEqual(x, y)) return false;
    }
    return true;
  }
  const keysA = Object.keys(a).filter((key) => norm(a[key]) !== undefined);
  const keysB = Object.keys(b).filter((key) => norm(b[key]) !== undefined);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (!Object.hasOwn(b, key) || !jsonEqual(a[key], b[key])) return false;
  }
  return true;
}
