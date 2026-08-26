'use strict';

// Deterministic routing for the session runtime SHARD host.
//
// One child process owning every session runtime, every agent dispatch, every
// provider parse and every tool result is a single event-loop failure domain:
// one slow parse or one runaway tool stalls unrelated sessions and their
// control/abort path. The host therefore runs a BOUNDED set of identical
// runtime children ("shards") and routes work to them deterministically.
//
// Routing rules (all pure, all testable here):
//   * Ownership is keyed by session identity (sessionId), not by arrival
//     order, so every view/recovery/resume of one session lands on the SAME
//     shard and its in-process session store stays authoritative.
//   * A key's home shard is a stable hash; probing continues in a stable
//     rotation only while the home shard is not placeable (lagging/quarantined).
//   * Once a key is claimed it keeps its shard until the last holder releases
//     it — health changes never migrate live work, which would strand accepted
//     input in the abandoned child.

import { availableParallelism } from 'node:os';

export const SESSION_RUNTIME_SHARD_ENV = 'MIXDOG_SESSION_RUNTIME_SHARDS';
export const MAX_SESSION_RUNTIME_SHARDS = 16;
const DEFAULT_MAX_SHARDS = 4;

/**
 * Bounded shard count. Shards multiply resident workers, so the default stays
 * small and scales with cores; operators may pin it explicitly.
 */
export function resolveShardCount(env = process.env, parallelism = availableParallelism()) {
  const override = Number(env?.[SESSION_RUNTIME_SHARD_ENV]);
  if (Number.isFinite(override) && override >= 1) {
    return Math.min(MAX_SESSION_RUNTIME_SHARDS, Math.floor(override));
  }
  const cpus = Math.max(1, Math.floor(Number(parallelism) || 1));
  if (cpus <= 2) return 1;
  return Math.max(2, Math.min(DEFAULT_MAX_SHARDS, Math.ceil(cpus / 4)));
}

/** FNV-1a (32-bit): stable across processes and daemon restarts. */
export function hashRoutingKey(key) {
  const text = String(key ?? '');
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index) & 0xff;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function normalizeShardCount(shardCount) {
  const count = Math.floor(Number(shardCount) || 1);
  return Math.max(1, Math.min(MAX_SESSION_RUNTIME_SHARDS, count));
}

/** Home shard for a routing key. */
export function shardIndexForKey(key, shardCount) {
  const count = normalizeShardCount(shardCount);
  return hashRoutingKey(key) % count;
}

/** Home shard first, then a stable rotation over the remaining shards. */
export function shardProbeOrder(key, shardCount) {
  const count = normalizeShardCount(shardCount);
  const home = shardIndexForKey(key, count);
  const order = [];
  for (let step = 0; step < count; step += 1) order.push((home + step) % count);
  return order;
}

/**
 * Placement for a NEW key. Falls back through the probe order while shards are
 * not placeable; when every shard is unplaceable the home shard still owns the
 * work (queued, never dropped).
 */
export function selectShardIndex(key, shardCount, isPlaceable = () => true) {
  const order = shardProbeOrder(key, shardCount);
  for (const index of order) {
    let ok = true;
    try { ok = isPlaceable(index) !== false; } catch { ok = true; }
    if (ok) return index;
  }
  return order[0];
}

/** Routing key for a session runtime: session identity when known. */
export function runtimeRoutingKey(options, fallbackKey = '') {
  const sessionId = String(options?.sessionId || '').trim();
  return sessionId || String(fallbackKey || '');
}

/**
 * Refcounted key -> shard ownership. Ownership is sticky for as long as any
 * holder exists so recovery/resume of the same session never changes shard.
 */
export function createShardOwnership() {
  const owners = new Map(); // key -> { index, refs }
  return {
    claim(key, resolve) {
      const id = String(key || '');
      const existing = owners.get(id);
      if (existing) {
        existing.refs += 1;
        return existing.index;
      }
      const index = Math.max(0, Math.floor(Number(resolve(id)) || 0));
      owners.set(id, { index, refs: 1 });
      return index;
    },
    peek(key) {
      const existing = owners.get(String(key || ''));
      return existing ? existing.index : null;
    },
    release(key) {
      const id = String(key || '');
      const existing = owners.get(id);
      if (!existing) return null;
      existing.refs -= 1;
      if (existing.refs <= 0) owners.delete(id);
      return existing.index;
    },
    get size() { return owners.size; },
    entries() { return [...owners].map(([key, value]) => ({ key, ...value })); },
  };
}

/**
 * Provider capacity cooldown is an ACCOUNT-wide fact, but each shard discovers
 * it in its own process. The host merges the strongest known cooldown and
 * replays it to the other shards; merging must be monotonic so a replay can
 * never shorten or clear a live cooldown (that would re-open the hammering
 * window this state exists to close).
 */
export function mergeProviderCooldown(current, incoming) {
  const base = {
    untilMs: Number(current?.untilMs) || 0,
    disabledReason: current?.disabledReason ? String(current.disabledReason) : null,
    updatedAt: Number(current?.updatedAt) || 0,
  };
  const untilMs = Number(incoming?.untilMs) || 0;
  const disabledReason = incoming?.disabledReason ? String(incoming.disabledReason) : null;
  const grew = untilMs > base.untilMs + 1_000;
  const newlyDisabled = Boolean(disabledReason) && disabledReason !== base.disabledReason;
  if (!grew && !newlyDisabled) return { changed: false, cooldown: base };
  return {
    changed: true,
    cooldown: {
      untilMs: Math.max(base.untilMs, untilMs),
      disabledReason: disabledReason || base.disabledReason,
      updatedAt: Number(incoming?.observedAt) || Date.now(),
    },
  };
}
