import { clean } from './clean.mjs';
import { positiveInt } from './numbers.mjs';

export const TAG_TOMBSTONE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function stampMs(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : 0;
  const text = clean(value);
  if (!text) return 0;
  const numeric = Number(text);
  if (Number.isFinite(numeric) && numeric > 0 && !/^\d{4}-/.test(text)) return numeric;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export function tagTombstoneKey(row = {}) {
  const parent = clean(row.parentSessionId || row.ownerSessionId);
  if (parent) return `session:${parent}\0${clean(row.tag)}`;
  return `${positiveInt(row.clientHostPid) || 0}\0${clean(row.tag)}`;
}

// Keys are built directly (same shape as tagTombstoneKey): this runs once per
// row/session on every scan, and spreading a session-sized row just to
// override its tag copied the whole record per lookup. `tag` must already be
// clean when passed.
export function findTagTombstone(row, tombstones, tag = clean(row.tag || row.agentTag)) {
  const parent = clean(row.parentSessionId || row.ownerSessionId);
  return (
    (parent && tombstones.get(`session:${parent}\0${tag}`)) ||
    tombstones.get(`${positiveInt(row.clientHostPid) || 0}\0${tag}`)
  );
}

export function tombstoneBlocksWork(row, tombstone) {
  const reapedAt = stampMs(tombstone?.reapedAt);
  if (!reapedAt) return false;
  // Saves, checkpoint recovery, and display reads are not new execution.
  return Math.max(stampMs(row.createdAt), stampMs(row.turnStartedAt)) <= reapedAt;
}
