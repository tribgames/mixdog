/**
 * Session catalog DB: table layout, row codec and the listing comparison.
 * Pure (no IO, no node:sqlite) so both the worker and tests can use it.
 *
 * One row per catalog session: every field store-summary-reader.mjs
 * normalizedRow produces, the storage fingerprint (full stamp of the session
 * file the row was judged at), the title normalized at write, and the
 * bookkeeping the mirror needs (lead visibility, sync epoch, row signature).
 */
import { createHash } from 'node:crypto';

/** Bumped whenever the table layout or a codec changes: the DB is then
 *  dropped and backfilled again from the JSON catalog. */
export const SCHEMA_VERSION = 5;
/** PRAGMA application_id ('MXSC'): a file without it is not this catalog. */
export const APPLICATION_ID = 0x4d585343;

// [row key, column, codec]
//   real/int  numbers; bool 0/1; text strings
//   loose     whatever the source carried (string/number/null as is, anything
//             else as a JSON BLOB), so the row round-trips exactly
//   json      object or null, as JSON text
//   optjson   like json, but the key is absent from the row when NULL
const FIELDS = [
  ['id', 'id', 'text'],
  ['updatedAt', 'updated_at', 'real'],
  ['lastUsedAt', 'last_used_at', 'real'],
  ['createdAt', 'created_at', 'real'],
  ['lastHeartbeatAt', 'last_heartbeat_at', 'real'],
  // Always 0 in a stored row: liveness is overlaid from `.hb` sidecars at read.
  ['heartbeatAt', 'heartbeat_at', 'real'],
  ['closed', 'closed', 'bool'],
  ['status', 'status', 'text'],
  ['owner', 'owner', 'loose'],
  ['agent', 'agent', 'loose'],
  ['sourceType', 'source_type', 'loose'],
  ['sourceName', 'source_name', 'loose'],
  ['scopeKey', 'scope_key', 'loose'],
  ['ownerSessionId', 'owner_session_id', 'loose'],
  ['visibility', 'visibility', 'loose'],
  ['clientHostPid', 'client_host_pid', 'loose'],
  ['cwd', 'cwd', 'loose'],
  ['desktopSession', 'desktop_session', 'json'],
  ['workspace', 'workspace', 'optjson'],
  ['provider', 'provider', 'loose'],
  ['model', 'model', 'loose'],
  ['agentTag', 'agent_tag', 'loose'],
  ['task_id', 'task_id', 'loose'],
  ['permission', 'permission', 'loose'],
  ['toolPermission', 'tool_permission', 'loose'],
  ['messageCount', 'message_count', 'int'],
  ['title', 'title', 'text'],
  ['preview', 'preview', 'text'],
  ['generation', 'generation', 'loose'],
  ['storageMtimeMs', 'storage_mtime_ms', 'real'],
  ['storageSize', 'storage_size', 'real'],
  ['detachedReason', 'detached_reason', 'loose'],
  // importOrigin.key of an imported conversation (schema 3).
  ['importKey', 'import_key', 'loose'],
  // Source session of an inherited (forked) session (schema 4).
  ['inheritedFromSessionId', 'inherited_from_session_id', 'loose'],
  // Real human turns (null for a row written before schema 5).
  ['realTurnCount', 'real_turn_count', 'loose'],
];

const COLUMN_TYPES = { text: 'TEXT', real: 'REAL', int: 'INTEGER', bool: 'INTEGER', json: 'TEXT', optjson: 'TEXT' };

const columnDefinition = ([, column, codec]) => {
  if (column === 'id') return 'id TEXT PRIMARY KEY';
  // No declared type = no affinity: loose values are stored exactly as bound.
  return codec === 'loose' ? column : `${column} ${COLUMN_TYPES[codec]}`;
};

export const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE IF NOT EXISTS sessions (
    ${FIELDS.map(columnDefinition).join(',\n    ')},
    activity REAL NOT NULL,
    title_norm TEXT NOT NULL,
    fingerprint TEXT,
    lead_visible INTEGER NOT NULL,
    row_sig TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_recent ON sessions(activity DESC, id);
  CREATE INDEX IF NOT EXISTS sessions_lead_recent ON sessions(lead_visible, activity DESC, id);
  CREATE INDEX IF NOT EXISTS sessions_visibility_recent ON sessions(visibility, activity DESC, id);
  CREATE INDEX IF NOT EXISTS sessions_owner_session ON sessions(owner_session_id);
`;

const WRITE_COLUMNS = [
  ...FIELDS.map(([, column]) => column),
  'activity',
  'title_norm',
  'fingerprint',
  'lead_visible',
  'row_sig',
];

export const UPSERT_SQL = `INSERT INTO sessions(${WRITE_COLUMNS.join(',')})
  VALUES (${WRITE_COLUMNS.map(() => '?').join(',')})
  ON CONFLICT(id) DO UPDATE SET ${WRITE_COLUMNS.slice(1)
    .map((column) => `${column}=excluded.${column}`)
    .join(',')}`;

/** Recent-activity key of the JSON listing (store-summary-reader byRecentActivity). */
export function activityOf(row) {
  return row.lastUsedAt || row.updatedAt || 0;
}

/** Newest activity first, ties by id: the DB order and the keyset order.
 *  Ids are ASCII ([A-Za-z0-9_-]), so code-unit order equals SQLite BINARY. */
export function byActivityThenId(left, right) {
  const delta = activityOf(right) - activityOf(left);
  if (delta !== 0) return delta;
  if (left.id === right.id) return 0;
  return left.id < right.id ? -1 : 1;
}

/** Title normalized once at write: what a title lookup or sort compares. */
export function normalizedTitle(row) {
  return String(row.title || row.preview || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function encodeLoose(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number') return value;
  return Buffer.from(JSON.stringify(value), 'utf8');
}

function decodeLoose(value) {
  if (value instanceof Uint8Array) return JSON.parse(Buffer.from(value).toString('utf8'));
  return value;
}

function encodeField(codec, value) {
  switch (codec) {
    case 'bool':
      return value === true ? 1 : 0;
    case 'json':
    case 'optjson':
      return value == null ? null : JSON.stringify(value);
    case 'loose':
      return encodeLoose(value);
    default:
      return value;
  }
}

function decodeField(codec, value) {
  switch (codec) {
    case 'bool':
      return value === 1;
    case 'json':
    case 'optjson':
      return value == null ? null : JSON.parse(value);
    case 'loose':
      return decodeLoose(value);
    default:
      return value;
  }
}

/** Signature of what one mirror entry writes: equal signature, no write. */
export function rowSignature({ row, fingerprint, leadVisible }) {
  return createHash('sha1')
    .update(JSON.stringify([fingerprint ?? null, leadVisible === true, row]))
    .digest('base64');
}

/** Bind parameters of UPSERT_SQL for one mirror entry. */
export function upsertParams(entry, signature) {
  const { row } = entry;
  return [
    ...FIELDS.map(([key, , codec]) => encodeField(codec, row[key])),
    activityOf(row),
    normalizedTitle(row),
    entry.fingerprint ?? null,
    entry.leadVisible === true ? 1 : 0,
    signature,
  ];
}

/** A `sessions` row back in normalizedRow shape. */
export function rowFromDb(record) {
  const row = {};
  for (const [key, column, codec] of FIELDS) {
    const value = decodeField(codec, record[column]);
    if (codec === 'optjson' && value === null) continue;
    row[key] = value;
  }
  return row;
}

// Overlays a listing adds at read time; never part of the comparison.
const OVERLAY_KEYS = new Set(['heartbeatAt', 'agentHeartbeatAt']);

/** Comparable JSON of a row's stored fields (overlays excluded). */
function comparable(row) {
  const out = [];
  for (const [key] of FIELDS) {
    if (OVERLAY_KEYS.has(key)) continue;
    out.push(row[key] === undefined ? null : row[key]);
  }
  return JSON.stringify(out);
}

const FIRST_IDS = 5;

/**
 * Shadow comparison of the DB listing against the JSON listing, both in the
 * one catalog order (byActivityThenId) and compared exactly as given: ids
 * present in only one, positions of the common ids, and stored row fields.
 */
export function compareListings(json, dbRows) {
  const jsonById = new Map(json.map((row) => [row.id, row]));
  const dbById = new Map(dbRows.map((row) => [row.id, row]));
  const missing = json.filter((row) => !dbById.has(row.id)).map((row) => row.id);
  const extra = dbRows.filter((row) => !jsonById.has(row.id)).map((row) => row.id);
  const commonJson = json.filter((row) => dbById.has(row.id));
  const commonDb = dbRows.filter((row) => jsonById.has(row.id));
  const order = [];
  for (let index = 0; index < commonJson.length; index++) {
    if (commonJson[index].id !== commonDb[index].id) order.push(commonJson[index].id);
  }
  const fields = commonJson.filter((row) => comparable(row) !== comparable(dbById.get(row.id))).map((row) => row.id);
  return {
    json: json.length,
    db: dbRows.length,
    missing: missing.length,
    extra: extra.length,
    order: order.length,
    fields: fields.length,
    ids: {
      missing: missing.slice(0, FIRST_IDS),
      extra: extra.slice(0, FIRST_IDS),
      order: order.slice(0, FIRST_IDS),
      fields: fields.slice(0, FIRST_IDS),
    },
  };
}

// ── Keyset cursor (activity time, id) ──────────────────────────────────────
/** Opaque cursor naming the last row of a page. */
export function encodeCatalogCursor(row) {
  return Buffer.from(JSON.stringify([activityOf(row), row.id]), 'utf8').toString('base64url');
}

/** `{ activity, id }` of a cursor, null for none; throws on a malformed one. */
export function decodeCatalogCursor(cursor) {
  if (cursor === undefined || cursor === null || cursor === '') return null;
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
  } catch {
    parsed = null;
  }
  if (!Array.isArray(parsed) || !Number.isFinite(parsed[0]) || typeof parsed[1] !== 'string') {
    throw Object.assign(new Error('invalid session catalog cursor'), { code: 'EINVALIDCURSOR' });
  }
  return { activity: parsed[0], id: parsed[1] };
}

/** Whether `row` sorts strictly after the cursor position. */
export function isAfterCursor(row, after) {
  if (!after) return true;
  const activity = activityOf(row);
  return activity < after.activity || (activity === after.activity && row.id > after.id);
}
