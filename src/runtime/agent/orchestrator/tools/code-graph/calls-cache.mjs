// Per-root sidecar for AST call sites: `<hash>.calls.json` next to the main
// `<hash>.json` graph entry.
//
// Why a sidecar at all: call tuples dominate a serialized graph (this repo:
// main entry 12.9 MB → 41.8 MB with calls inline, ~1.5 s added to every cold
// reload) while only callers/callees/references read them. Splitting them out
// keeps the main entry — the one every mode parses on a cold process — at its
// pre-call-sites size, and moves the call payload behind a lazy read that only
// the three call modes trigger.
//
// Payload shape (compact on purpose):
//   { "v": 1, "files": { "<rel>": ["<fp>", [[name,line,col,kind,recv,inSym],…]] } }
// A rel is ABSENT when its calls are unknown (null); `[]` is written out, so
// "parsed, no call sites" survives the round trip and never decays into
// "unknown" (which would cost the file its call rows on the next query).
//
// `fp` is the same fingerprint the main entry stores for that file, so a
// sidecar entry is only applied to a file whose bytes did not change. That
// makes the sidecar valid across incremental (`--files`) rebuilds: unchanged
// files keep their call sites even when the rebuilding process never hydrated
// them.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CALLS_SIDECAR_VERSION = 1;
const CALLS_SIDECAR_SUFFIX = '.calls.json';

export function callsSidecarPath(dir, hash) {
  return join(dir, `${hash}${CALLS_SIDECAR_SUFFIX}`);
}

// `<hash>.calls.json` → `<hash>`; any other name → null.
export function callsSidecarHash(fileName) {
  const name = String(fileName || '');
  if (!name.endsWith(CALLS_SIDECAR_SUFFIX)) return null;
  return name.slice(0, -CALLS_SIDECAR_SUFFIX.length) || null;
}

// Build the payload to persist for `graph`, carrying forward every still-valid
// entry of `previous`. A node whose calls are unknown right now (null) keeps
// the previously persisted tuples when its fingerprint is unchanged — the
// incremental path reuses nodes from a cache entry that was never hydrated, so
// without this a single `--files` rebuild would erase the sidecar.
// Entries for rels that left the graph are dropped, bounding the file.
export function buildCallsSidecarPayload(graph, previous = null) {
  const previousFiles =
    previous && typeof previous === 'object' && previous.files && typeof previous.files === 'object'
      ? previous.files
      : null;
  const files = {};
  let fresh = 0;
  let carried = 0;
  for (const node of graph?.nodes?.values?.() || []) {
    const fp = node?.fingerprint || '';
    if (Array.isArray(node?.calls)) {
      files[node.rel] = [fp, node.calls];
      fresh += 1;
      continue;
    }
    const prior = previousFiles?.[node.rel];
    if (Array.isArray(prior) && prior.length === 2 && prior[0] === fp && Array.isArray(prior[1])) {
      files[node.rel] = [fp, prior[1]];
      carried += 1;
    }
  }
  return { payload: { v: CALLS_SIDECAR_VERSION, files }, fresh, carried };
}

// A graph contributes nothing when no node carries decoded-or-raw call tuples;
// the caller then leaves the existing sidecar untouched instead of overwriting
// it with an empty one (e.g. a build by a binary without the v2 wire).
export function graphHasCallsToPersist(graph) {
  for (const node of graph?.nodes?.values?.() || []) {
    if (Array.isArray(node?.calls)) return true;
  }
  return false;
}

export function readCallsSidecarPayload(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    if (parsed.v !== CALLS_SIDECAR_VERSION) return null;
    if (!parsed.files || typeof parsed.files !== 'object') return null;
    return parsed;
  } catch {
    // Missing (old cache without a sidecar), unreadable or corrupt → unknown
    // calls. Never fatal here: the graph re-indexes and re-persists, and a
    // query that ends up with no call data at all reports the capability error.
    return null;
  }
}

const NO_CALLS_KEY = Symbol('no calls key');

// Validate and measure one `[rel, [fp, calls], size?]` sidecar entry against a
// cache-loaded graph WITHOUT touching it; null when it is not accepted.
// Fingerprint mismatch → the file changed since the sidecar was written, so
// its calls stay unknown. The record carries the list's size (the entry's
// measured `size`, else `sizeOf(calls)`) and the size of what it replaces, so
// installing never walks a call tuple.
export function stageCallsSidecarEntry(graph, [rel, entry, size], sizeOf) {
  const node = graph.nodes.get(rel);
  if (!node) return null;
  if (!Array.isArray(entry) || entry.length !== 2) return null;
  if (entry[0] !== (node.fingerprint || '')) return null;
  if (!Array.isArray(entry[1])) return null;
  const record = { node, calls: entry[1], bytes: Number(size ?? sizeOf(entry[1])), replaced: null, replacedBytes: 0 };
  measureReplacedCalls(record, sizeOf);
  return record;
}

// (Re)measure what a staged list replaces — an incremental build's re-parsed
// files already carry calls; a node without a `calls` key gains one.
export function measureReplacedCalls(record, sizeOf) {
  const { node } = record;
  const had = Object.hasOwn(node, 'calls');
  record.replaced = had ? node.calls : NO_CALLS_KEY;
  record.replacedBytes = had ? sizeOf(node.calls) : -(8 + sizeOf('calls'));
}

/** True when the node's `calls` changed since its record was measured. */
export function isStagedReplacementStale(record) {
  const { node } = record;
  return (Object.hasOwn(node, 'calls') ? node.calls : NO_CALLS_KEY) !== record.replaced;
}

// Install staged call lists in one synchronous step, so no query observes part
// of a payload: assignments and precomputed sizes only. `bytes` is the change
// in the graph's retained size: the staged lists minus what they replaced.
export function installCallsSidecarEntries(staged) {
  let bytes = 0;
  for (const record of staged) {
    record.node.calls = record.calls;
    bytes += record.bytes - record.replacedBytes;
  }
  return { applied: staged.length, bytes };
}
