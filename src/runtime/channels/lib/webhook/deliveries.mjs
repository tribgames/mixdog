import { join } from "path";
import { readFileSync, mkdirSync, writeFileSync, unlinkSync, existsSync, renameSync, watch as fsWatch } from "fs";
import { appendFile } from "fs/promises";
import { DATA_DIR } from "../config.mjs";
import { readMarkdownDocument } from "../../../shared/markdown-frontmatter.mjs";
import { logWebhook } from "./log.mjs";

const WEBHOOKS_DIR = join(DATA_DIR, "webhooks");

// ── Endpoint config loader ─────────────────────────────────────────────
// Reads DATA_DIR/webhooks/<name>/WEBHOOK.md (written by setup-server.mjs
// via POST /webhooks). The frontmatter IS the config object; the markdown
// body is the instructions/prompt. Cached in-memory, invalidated by
// fs.watch on the webhooks directory. Returns the frontmatter object
// { secret, parser, channel, model, role, enabled } where routing is by
// `channel` presence and `role` names a user-workflow entry when set.
const _endpointCache = new Map();
let _endpointWatcher = null;
function _endpointConfigPath(name) {
  return join(WEBHOOKS_DIR, name, "WEBHOOK.md");
}
// Per-endpoint HMAC secret is stored in a side file (WEBHOOKS_DIR/<name>/secret),
// not in WEBHOOK.md frontmatter — frontmatter is a lossy `key: value` format
// (unquote strips surrounding quotes) and would corrupt user secrets on the
// save->rewrite round-trip. Read fresh on each verify (no cache): the signing
// path is not hot and a stale secret would silently reject valid deliveries.
function _readEndpointSecret(name) {
  try {
    const s = readFileSync(join(WEBHOOKS_DIR, name, "secret"), "utf8").trim();
    return s || null;
  } catch {
    return null;
  }
}
function _ensureEndpointWatcher() {
  if (_endpointWatcher) return;
  try {
    if (!existsSync(WEBHOOKS_DIR)) return;
    _endpointWatcher = fsWatch(WEBHOOKS_DIR, { recursive: true }, (_event, filename) => {
      if (!filename) { _endpointCache.clear(); return; }
      // filename is like "<endpoint>/WEBHOOK.md" or "<endpoint>"
      const parts = String(filename).split(/[\\/]/);
      const endpointName = parts[0];
      if (endpointName) _endpointCache.delete(endpointName);
      else _endpointCache.clear();
    });
    _endpointWatcher.on("error", () => { _endpointWatcher = null; _endpointCache.clear(); });
    // Don't let the watcher keep the event loop alive: embedders/tests that
    // merely load an endpoint config should still be able to exit cleanly.
    _endpointWatcher.unref?.();
  } catch {
    // Watch failures are non-fatal; cache simply stays until process restart.
  }
}
function _closeEndpointWatcher() {
  if (!_endpointWatcher) return;
  try { _endpointWatcher.close(); } catch {}
  _endpointWatcher = null;
  _endpointCache.clear();
}
function loadEndpointConfig(name) {
  if (!name) return null;
  // A cached entry is only authoritative while the fs.watch handle is
  // armed — otherwise a later mkdir+write of WEBHOOKS_DIR/<name>/
  // WEBHOOK.md has no way to invalidate the cache and a stale `null`
  // (e.g. captured before WEBHOOKS_DIR existed) would pin forever.
  if (_endpointCache.has(name) && _endpointWatcher) return _endpointCache.get(name);
  _ensureEndpointWatcher();
  const p = _endpointConfigPath(name);
  if (!existsSync(p)) {
    // Only cache the missing-config state when the watcher is live, so
    // a later create can invalidate it. Otherwise leave the slot empty
    // and re-read on the next call.
    if (_endpointWatcher) _endpointCache.set(name, null);
    return null;
  }
  try {
    // Frontmatter is the config object; `enabled` arrives as a string and
    // is cast so `endpoint?.enabled === false` gates match a written
    // `enabled: false`.
    const { frontmatter } = readMarkdownDocument(readFileSync(p, "utf8"));
    const cfg = { ...frontmatter };
    if (Object.prototype.hasOwnProperty.call(cfg, "enabled")) {
      cfg.enabled = cfg.enabled !== "false" && cfg.enabled !== false;
    }
    _endpointCache.set(name, cfg);
    return cfg;
  } catch {
    if (_endpointWatcher) _endpointCache.set(name, null);
    return null;
  }
}

// ── Delivery tracking ─────────────────────────────────────────────────
// Per-endpoint append-only log at WEBHOOKS_DIR/<name>/deliveries.jsonl.
// Each POST writes at least two lines: {status:"pending"|"processing"}
// then {status:"done"|"failed"|"dedup"}. Earlier fields (payloadPreview,
// headersSummary) are kept on the first line only; later status updates
// reference the same `id` and are merged latest-wins at read time.
const DELIVERY_INDEX_MAX_IDS = 2000;
const DELIVERY_LOG_MAX_LINES = 10_000;
// A "pending" claim normally resolves to a terminal status (done/failed) or
// "processing" within seconds. If a row is stuck at "pending" past this TTL
// (crash between the pending write and the terminal write, with no restart
// warm to clear it), treat it as abandoned rather than always-kept —
// otherwise an unbounded number of stuck-pending ids could accumulate and
// defeat DELIVERY_INDEX_MAX_IDS entirely.
const DELIVERY_PENDING_TTL_MS = 10 * 60 * 1000;
function _isFreshPending(entry) {
  const ts = Date.parse(entry?.ts ?? "");
  if (Number.isNaN(ts)) return true; // no timestamp to judge staleness — keep (fail safe toward dedup).
  return Date.now() - ts < DELIVERY_PENDING_TTL_MS;
}
/** @type {Map<string, Map<string, object>>} */
const _deliveryIndexByEndpoint = new Map();
/** @type {Set<string>} */
const _deliveryIndexWarmed = new Set();
/** @type {Map<string, number>} */
const _deliveryLogLineCountByEndpoint = new Map();
/** @type {Map<string, number>} distinct-id count at last warm/compaction; drives the redundancy-based compaction trigger. */
const _deliveryKeptCountByEndpoint = new Map();
function _deliveriesPath(name) {
  return join(WEBHOOKS_DIR, name, "deliveries.jsonl");
}
function _mergeDeliveryRows(prior, entry) {
  return prior ? { ...prior, ...entry } : entry;
}
function _isBlockingDeliveryStatus(status) {
  // "pending" is a non-terminal claim too: between the pending row write and
  // the terminal done/failed row (eventPipeline enqueue, delegate dispatch) a
  // concurrent retry of the same delivery id must dedup, not double-dispatch.
  return status === "received" || status === "pending" || status === "processing" || status === "done";
}
function _deliveryIndexFor(name) {
  let map = _deliveryIndexByEndpoint.get(name);
  if (!map) {
    map = new Map();
    _deliveryIndexByEndpoint.set(name, map);
  }
  return map;
}
// Bound retained ids so successful ("done") deliveries cannot accumulate
// forever in RAM or on disk. In-flight claims (received/processing) are
// ALWAYS kept — dropping one would let a duplicate dispatch through. The
// remaining DELIVERY_INDEX_MAX_IDS budget goes to the newest "done" rows
// (dedup of recent retries) first, then newest terminal rows for history.
// Older "done" rows age out; a sender re-delivering an id that stale is
// treated as new — acceptable beyond any realistic retry window.
function _retainedDeliveryIds(entries) {
  const inflight = [];
  const done = [];
  const other = [];
  for (const e of entries) {
    // "pending" is a non-terminal claim too (see _isBlockingDeliveryStatus)
    // — it must stay in the always-kept inflight set during pruning, or a
    // concurrent retry of the same id can bypass dedup while the original
    // delivery is still pending. Bounded by DELIVERY_PENDING_TTL_MS so a
    // stuck/abandoned pending row (crash, never resolved) doesn't pin
    // itself in the always-kept set forever and grow the index unbounded;
    // once stale it falls through to the capped `other` pool below.
    if (e.status === "received" || e.status === "processing" || (e.status === "pending" && _isFreshPending(e))) {
      inflight.push(e);
    }
    else if (e.status === "done") done.push(e);
    else other.push(e);
  }
  const keep = new Set(inflight.map((e) => e.id));
  const byTsDesc = (a, b) => String(b.ts || "").localeCompare(String(a.ts || ""));
  done.sort(byTsDesc);
  other.sort(byTsDesc);
  for (const e of [...done, ...other]) {
    if (keep.size >= DELIVERY_INDEX_MAX_IDS) break;
    keep.add(e.id);
  }
  return keep;
}
function _pruneDeliveryIndexMap(byId) {
  if (byId.size <= DELIVERY_INDEX_MAX_IDS) return;
  const keep = _retainedDeliveryIds([...byId.values()]);
  for (const id of byId.keys()) {
    if (!keep.has(id)) byId.delete(id);
  }
}
function _deliveryLogLineCount(name) {
  return _deliveryLogLineCountByEndpoint.get(name) ?? 0;
}
function _setDeliveryLogLineCount(name, n) {
  _deliveryLogLineCountByEndpoint.set(name, Math.max(0, n));
}
function _bumpDeliveryLogLineCount(name, delta = 1) {
  _setDeliveryLogLineCount(name, _deliveryLogLineCount(name) + delta);
}
function _readDeliveriesFileMerged(name) {
  const p = _deliveriesPath(name);
  const byId = new Map();
  let lineCount = 0;
  if (!existsSync(p)) return { byId, lineCount };
  try {
    const raw = readFileSync(p, "utf8");
    for (const line of raw.split("\n")) {
      if (!line) continue;
      lineCount++;
      try {
        const entry = JSON.parse(line);
        if (!entry?.id) continue;
        byId.set(entry.id, _mergeDeliveryRows(byId.get(entry.id), entry));
      } catch {}
    }
  } catch {}
  return { byId, lineCount };
}
function _ingestDeliveriesFileIntoIndex(name) {
  const { byId: merged, lineCount } = _readDeliveriesFileMerged(name);
  const byId = _deliveryIndexFor(name);
  byId.clear();
  for (const [id, row] of merged) byId.set(id, row);
  _pruneDeliveryIndexMap(byId);
  _setDeliveryLogLineCount(name, lineCount);
  // Track the RETAINED (post-prune) distinct count, not the raw file count:
  // a pre-existing oversized log then trips the compaction trigger promptly
  // instead of inflating the threshold until it grows even larger.
  _deliveryKeptCountByEndpoint.set(name, byId.size);
}
function _ensureDeliveryIndex(name) {
  if (_deliveryIndexWarmed.has(name)) return;
  _deliveryIndexWarmed.add(name);
  _ingestDeliveriesFileIntoIndex(name);
}
function _applyDeliveryEntryToIndex(name, entry) {
  if (!entry?.id) return;
  const byId = _deliveryIndexFor(name);
  byId.set(entry.id, _mergeDeliveryRows(byId.get(entry.id), entry));
  _pruneDeliveryIndexMap(byId);
}
function _compactDeliveriesLogIfNeeded(name) {
  // Redundancy-based trigger: compact only when the log holds meaningfully more
  // lines than distinct ids (i.e. there are status-update rows to collapse).
  // The threshold scales with the distinct-id count so an endpoint with many
  // legitimate blocking ids does NOT re-compact on every append (which would
  // re-read the whole log permanently once distinct > DELIVERY_LOG_MAX_LINES).
  const kept = _deliveryKeptCountByEndpoint.get(name) ?? _deliveryIndexFor(name).size;
  const threshold = Math.max(DELIVERY_LOG_MAX_LINES, kept * 2);
  if (_deliveryLogLineCount(name) <= threshold) return;
  const { byId: merged } = _readDeliveriesFileMerged(name);
  const rows = [...merged.values()];
  const keepIds = _retainedDeliveryIds(rows);
  const keep = new Map();
  for (const e of rows) {
    if (keepIds.has(e.id)) keep.set(e.id, e);
  }
  const lines = [...keep.values()]
    .sort((a, b) => String(a.ts || "").localeCompare(String(b.ts || "")))
    .map((e) => JSON.stringify(e) + "\n")
    .join("");
  const p = _deliveriesPath(name);
  const tmp = `${p}.compact-${process.pid}-${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, lines);
    renameSync(tmp, p);
    // Refresh index + counters by RE-READING the post-rename file (not the
    // pre-rename `keep` snapshot). The webhook daemon is the single writer and
    // append+compact run synchronously in one process, so no append can
    // interleave between the fresh read and the rename; re-reading keeps the
    // warmed state exactly matching on-disk content.
    _ingestDeliveriesFileIntoIndex(name);
  } catch (err) {
    logWebhook(`${name}: deliveries compact failed: ${err?.message ?? err}`);
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {}
  }
}
function appendDelivery(name, entry) {
  try {
    const dir = join(WEBHOOKS_DIR, name);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const full = { ts: new Date().toISOString(), ...entry };
    const line = JSON.stringify(full) + "\n";
    void appendFile(_deliveriesPath(name), line).catch((err) => {
      logWebhook(`${name}: deliveries append failed: ${err?.message ?? err}`);
    });
    const wasWarmed = _deliveryIndexWarmed.has(name);
    _ensureDeliveryIndex(name);
    if (wasWarmed) _bumpDeliveryLogLineCount(name, 1);
    _applyDeliveryEntryToIndex(name, full);
    _compactDeliveriesLogIfNeeded(name);
    return true;
  } catch (err) {
    logWebhook(`${name}: deliveries append failed: ${err?.message ?? err}`);
    return false;
  }
}
// Dedup gate against a still-active claim or a successful prior delivery.
// Only rows with status "received" (non-terminal claim) or "done"
// (successful delivery) block a retry; terminal "failed" rows (and any
// other unknown/legacy terminal status) are NOT considered duplicates so
// a sender can legitimately
// redeliver the same id after a recoverable failure. Without this
// scoping, every prior row would permanently dedup the id and stop
// legit redelivery.
function deliveryExists(name, id) {
  // "processing" must also dedup: a delegate dispatch in flight (up to
  // DISPATCH_TIMEOUT_MS = 10 min) would otherwise be duplicated by a
  // retried delivery of the same id while the first handler is still
  // running. Block on any non-terminal status.
  _ensureDeliveryIndex(name);
  const entry = _deliveryIndexFor(name).get(id);
  return Boolean(entry && _isBlockingDeliveryStatus(entry.status));
}
function extractDeliveryId(headers) {
  return headers["x-github-delivery"]
    || headers["x-delivery-id"]
    || headers["x-request-id"]
    || null;
}
function buildHeadersSummary(headers) {
  const summary = {};
  if (headers["x-github-event"]) summary.event_type = headers["x-github-event"];
  if (headers["x-github-delivery"]) summary.delivery_id = headers["x-github-delivery"];
  summary.signature_present = Boolean(
    headers["x-hub-signature-256"] || headers["x-signature-256"]
      || headers["stripe-signature"] || headers["sentry-hook-signature"]
  );
  if (headers["content-type"]) summary.content_type = headers["content-type"];
  return summary;
}

export {
  WEBHOOKS_DIR,
  _readEndpointSecret,
  _closeEndpointWatcher,
  loadEndpointConfig,
  appendDelivery,
  deliveryExists,
  extractDeliveryId,
  buildHeadersSummary,
};
