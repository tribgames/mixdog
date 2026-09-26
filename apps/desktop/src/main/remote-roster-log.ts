// The desktop's side of the persisted phone roster (shared/remote-roster-cache.ts).
//
// Every sessions frame sent to a phone that announced a roster cache carries
// `__roster: [epoch, version]`: the version of THIS log at which it held
// exactly the rows that frame brought the phone to. The log numbers every
// change it observes, so a phone that reopens claiming [epoch, version] is
// answered with only the rows changed and the keys removed since — never on
// the strength of `updatedAt`, which working heartbeats and read cursors do
// not advance. A claim this process cannot answer exactly (another epoch,
// evicted tombstones, an id set that does not match) gets today's baseline.
import { createHash, randomBytes } from 'node:crypto';
import { canonicalJson } from '../shared/remote-view-resume';
import type { RosterClaim } from '../shared/remote-roster-cache';

const MAX_TOMBSTONES = 4_096;

interface RosterEntry {
  signature: string;
  added: number;
  changed: number;
}

export interface RosterCatchUp<T> {
  upsert: Array<[string, T]>;
  removed: string[];
  place?: number[];
  order?: string[];
}

export interface RosterLog<T> {
  readonly epoch: string;
  /** Record `items` as the current roster; answers the version they are. */
  ingest(items: readonly T[]): number;
  /** Only what a phone holding the claimed version lacks of `items`, or null
   *  when that cannot be proven. Ingests `items` first. */
  catchUp(claim: RosterClaim, items: readonly T[]): RosterCatchUp<T> | null;
}

export function rosterDigest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function createRosterLog<T>(
  keyOf: (item: T, index: number) => string,
  maxTombstones = MAX_TOMBSTONES
): RosterLog<T> {
  const epoch = randomBytes(12).toString('base64url');
  let version = 0;
  let order: string[] = [];
  let rows = new Map<string, RosterEntry>();
  const tombstones = new Map<string, { added: number; removed: number }>();
  /** Claims older than an evicted tombstone cannot learn about its removal. */
  let floor = 0;
  /** Last version at which rows that did NOT change moved relative to each
   *  other. Before it a phone's order cannot be rebuilt from the positions
   *  of the changed rows alone, so the whole order travels. */
  let permuted = 0;
  const ingest = (items: readonly T[]): number => {
    let bumped = false;
    const bump = (): number => {
      if (!bumped) {
        bumped = true;
        version += 1;
      }
      return version;
    };
    const nextOrder = items.map((item, index) => keyOf(item, index));
    const next = new Map<string, RosterEntry>();
    items.forEach((item, index) => {
      const key = nextOrder[index];
      const signature = JSON.stringify(item);
      const before = rows.get(key);
      if (before && before.signature === signature) {
        next.set(key, before);
        return;
      }
      const at = bump();
      next.set(key, { signature, added: before ? before.added : at, changed: at });
      tombstones.delete(key);
    });
    for (const [key, entry] of rows) {
      if (next.has(key)) continue;
      tombstones.set(key, { added: entry.added, removed: bump() });
    }
    for (const [key, entry] of tombstones) {
      if (tombstones.size <= maxTombstones) break;
      tombstones.delete(key);
      floor = Math.max(floor, entry.removed);
    }
    const kept = (sequence: string[]): string[] =>
      sequence.filter((key) => {
        const entry = next.get(key);
        return entry !== undefined && entry === rows.get(key);
      });
    const before = kept(order);
    const after = kept(nextOrder);
    if (before.length !== after.length || before.some((key, index) => key !== after[index])) {
      permuted = bump();
    }
    order = nextOrder;
    rows = next;
    return version;
  };
  return {
    epoch,
    ingest,
    catchUp(claim, items) {
      ingest(items);
      if (claim.epoch !== epoch || claim.version > version || claim.version < floor) return null;
      // The id set the claimed version held, rebuilt from the log: it must be
      // exactly the phone's before anything is sent on top of it.
      const held: string[] = [];
      for (const [key, entry] of rows) if (entry.added <= claim.version) held.push(key);
      for (const [key, entry] of tombstones) {
        if (entry.added <= claim.version && entry.removed > claim.version) held.push(key);
      }
      if (held.length !== claim.count || rosterDigest(held.sort()) !== claim.ids) return null;
      const upsert: Array<[string, T]> = [];
      const place: number[] = [];
      items.forEach((item, index) => {
        const key = order[index];
        if ((rows.get(key)?.changed ?? Infinity) <= claim.version) return;
        upsert.push([key, item]);
        place.push(index);
      });
      const removed = [...tombstones].filter(([, entry]) => entry.removed > claim.version).map(([key]) => key);
      return permuted > claim.version ? { upsert, removed, order: [...order] } : { upsert, removed, place };
    },
  };
}

/** A sessions list-delta payload stamped with the version its rows are. The
 *  no-delta marker and bare arrays pass through untouched. */
export function stampRoster<T>(log: RosterLog<T>, items: readonly T[], payload: unknown): unknown {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  return { ...payload, __roster: [log.epoch, log.ingest(items)] };
}

const sessionLogs = new WeakMap<object, RosterLog<{ id?: unknown }>>();

/** One log per desktop service: every phone's claims are against it. */
export function sessionRosterLog<T extends { id?: unknown }>(host: object): RosterLog<T> {
  let log = sessionLogs.get(host);
  if (!log) {
    log = createRosterLog<{ id?: unknown }>((session, index) => String(session.id || `session:${index}`));
    sessionLogs.set(host, log);
  }
  return log as unknown as RosterLog<T>;
}
