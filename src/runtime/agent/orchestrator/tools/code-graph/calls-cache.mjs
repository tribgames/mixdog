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

// Apply a payload onto a cache-loaded graph. Fingerprint mismatch → the file
// changed since the sidecar was written, so its calls stay unknown.
export function applyCallsSidecarToGraph(graph, payload) {
  const files = payload?.files;
  if (!files || !graph?.nodes) return 0;
  let applied = 0;
  for (const node of graph.nodes.values()) {
    const entry = files[node.rel];
    if (!Array.isArray(entry) || entry.length !== 2) continue;
    if (entry[0] !== (node.fingerprint || '')) continue;
    if (!Array.isArray(entry[1])) continue;
    node.calls = entry[1];
    applied += 1;
  }
  return applied;
}
