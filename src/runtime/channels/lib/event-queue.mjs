import { readdirSync, readFileSync, existsSync as fsExistsSync, statSync, unlinkSync } from "fs";
import { join } from "path";
import { DATA_DIR } from "./config.mjs";
import { ensureDir } from "./state-file.mjs";
import { logEvent } from "./executor.mjs";
import { renameWithRetrySync, writeJsonAtomicSync } from "../../shared/atomic-file.mjs";
const QUEUE_DIR = join(DATA_DIR, "events", "queue");
const IN_PROGRESS_DIR = join(DATA_DIR, "events", "in-progress");
const PROCESSED_DIR = join(DATA_DIR, "events", "processed");
const PROCESSED_DIR_MAX_ENTRIES = 200;
function pruneProcessedDir() {
  try {
    if (!fsExistsSync(PROCESSED_DIR)) return;
    const names = readdirSync(PROCESSED_DIR);
    if (names.length <= PROCESSED_DIR_MAX_ENTRIES) return;
    const ranked = [];
    for (const name of names) {
      try {
        const st = statSync(join(PROCESSED_DIR, name));
        ranked.push({ name, mtime: st.mtimeMs });
      } catch {}
    }
    ranked.sort((a, b) => b.mtime - a.mtime);
    for (let i = PROCESSED_DIR_MAX_ENTRIES; i < ranked.length; i++) {
      try {
        unlinkSync(join(PROCESSED_DIR, ranked[i].name));
      } catch {}
    }
  } catch {}
}
function finiteInt(value, { min, max, def }) {
  const n = Number(value);
  if (!Number.isFinite(n)) return def;
  const i = Math.trunc(n);
  if (i < min) return min;
  if (i > max) return max;
  return i;
}
class EventQueue {
  config;
  channelId;
  tickTimer = null;
  batchTimer = null;
  _processQueueRunning = false;
  _processBatchRunning = false;
  injectFn = null;
  ownerGetter = null;
  ownerSkipLogged = false;
  // Per-item inject failure counts (keyed by original queue filename) so a
  // persistently-failing item is dead-lettered instead of retried forever.
  _injectFailCounts = new Map();
  // Monotonic enqueue counter — prevents same-millisecond enqueue ordering
  // from being decided by Math.random() (lex sort on the random suffix).
  // Counter is 8-digit zero-padded so lex sort matches numeric order.
  enqueueSeq = 0;
  // track files already notified during active state
  constructor(config, channelId) {
    this.config = config ?? {};
    this.channelId = channelId ?? "";
  }
  setInjectHandler(fn) {
    this.injectFn = fn;
  }
  setOwnerGetter(fn) {
    this.ownerGetter = fn;
  }
  // ── Lifecycle ─────────────────────────────────────────────────────
  start() {
    if (this.tickTimer) return;
    ensureDir(QUEUE_DIR);
    ensureDir(IN_PROGRESS_DIR);
    ensureDir(PROCESSED_DIR);
    // Recover events that were claimed (renamed into in-progress/) but never
    // executed because the process crashed between claim and execute. The
    // tick/batch loops only ever scan queue/, so without this they would be
    // stranded forever. Move them back to queue/ so the next tick re-claims.
    this.requeueStrandedInProgress();
    const tickSec = finiteInt(this.config.tickInterval, { min: 1, max: 3600, def: 2 });
    const tickMs = tickSec * 1e3;
    this.tickTimer = setInterval(() => this.processQueue(), tickMs);
    this.initialTickTimer = setTimeout(() => {
      this.initialTickTimer = null;
      this.processQueue();
    }, 3e3);
    const batchMin = finiteInt(this.config.batchInterval, { min: 1, max: 1440, def: 30 });
    const batchMs = batchMin * 6e4;
    this.batchTimer = setInterval(() => this.processBatch(), batchMs);
    logEvent("queue started");
  }
  stop() {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    if (this.batchTimer) {
      clearInterval(this.batchTimer);
      this.batchTimer = null;
    }
    if (this.initialTickTimer) {
      clearTimeout(this.initialTickTimer);
      this.initialTickTimer = null;
    }
  }
  reloadConfig(config, channelId) {
    this.stop();
    this.config = config ?? {};
    this.channelId = channelId ?? "";
    this.start();
  }
  // ── Enqueue ───────────────────────────────────────────────────────
  enqueue(item) {
    ensureDir(QUEUE_DIR);
    const seq = String(this.enqueueSeq++).padStart(8, "0");
    const id = `${Date.now()}-${seq}-${Math.random().toString(36).slice(2, 6)}`;
    // Filename is plain <id>.json — ordering is by enqueue sequence (monotonic).
    // Priority is stored inside the item JSON; callers sort/filter by item.priority.
    const filename = `${id}.json`;
    const finalPath = join(QUEUE_DIR, filename);
    writeJsonAtomicSync(finalPath, item, { fsyncDir: true });
    logEvent(`${item.name}: enqueued (${item.priority})`);
    if (item.priority === "high") {
      setImmediate(() => this.processQueue());
    }
  }
  // ── Process queue ─────────────────────────────────────────────────
  processQueue() {
    if (this._processQueueRunning) return;
    this._processQueueRunning = true;
    try {
      // Belt-and-suspenders ownership guard: if this process is not the
      // active owner, do nothing. The runtime should only have started this
      // queue on the owner path, but an ownership hand-off can briefly leave
      // two processes both ticking — this short-circuits that window.
      // This is multi-process active-owner gating, not HTTP authentication.
      if (this.ownerGetter) {
        // Fail closed: a probe exception must NOT be treated as ownership.
        // Duplicate-owner queue ticks are exactly what this guard prevents.
        let isOwner = false;
        try { isOwner = !!this.ownerGetter(); } catch { isOwner = false; }
        if (!isOwner) {
          if (!this.ownerSkipLogged) {
            logEvent("queue: skipping tick — not owner");
            this.ownerSkipLogged = true;
          }
          return;
        }
        this.ownerSkipLogged = false;
      }
      const files = this.readQueueFiles();
      if (files.length === 0) return;
      for (const file of files) {
        const item = this.readItem(file);
        if (!item) continue;
        // Low-priority items are coalesced by processBatch() on its own
        // interval; the per-tick loop must skip them or it would dispatch
        // each low item individually and starve the batching feature.
        if (item.priority === "low") continue;
        // Atomic claim: rename into in-progress/ before executing. If the
        // rename fails (another tick / cleanup raced, or file vanished),
        // skip this handle.
        const claimed = this.claimFile(file);
        if (!claimed) continue;
        this.executeItem(item, claimed);
      }
    } finally {
      this._processQueueRunning = false;
    }
  }
  processBatch() {
    // Belt-and-suspenders ownership guard: if this process is not the
    // active owner, do nothing. The runtime should only have started this
    // queue on the owner path, but an ownership hand-off can briefly leave
    // two processes both ticking — this short-circuits that window.
    // This is multi-process active-owner gating, not HTTP authentication.
    if (this.ownerGetter) {
      // Fail closed: a probe exception must NOT be treated as ownership.
      let isOwner = false;
      try { isOwner = !!this.ownerGetter(); } catch { isOwner = false; }
      if (!isOwner) {
        if (!this.ownerSkipLogged) {
          logEvent("queue: skipping batch tick — not owner");
          this.ownerSkipLogged = true;
        }
        return;
      }
      this.ownerSkipLogged = false;
    }
    const files = this.readQueueFiles();
    const lowFiles = files.filter((f) => {
      const item = this.readItem(f);
      return item?.priority === "low";
    });
    if (lowFiles.length === 0) return;
    const groups = /* @__PURE__ */ new Map();
    for (const file of lowFiles) {
      const item = this.readItem(file);
      if (!item) continue;
      const group = groups.get(item.name) ?? { items: [], files: [] };
      group.items.push(item);
      group.files.push(file);
      groups.set(item.name, group);
    }
    for (const [name, group] of groups) {
      // Claim all batch files atomically BEFORE building the combined
      // prompt so overlapping batch ticks don't double-process. Files
      // that fail to claim are dropped from this batch, and their
      // corresponding items are excluded from the prompt.
      const claimedPairs = [];
      for (let i = 0; i < group.files.length; i++) {
        const claimed = this.claimFile(group.files[i]);
        if (claimed) claimedPairs.push({ file: claimed, item: group.items[i] });
      }
      if (claimedPairs.length === 0) continue;
      const combined = claimedPairs.length === 1 ? claimedPairs[0].item.prompt : `Batch of ${claimedPairs.length} events:

${claimedPairs.map((p, i) => `--- Event ${i + 1} ---
${p.item.prompt}`).join("\n\n")}`;
      const batchItem = {
        ...claimedPairs[0].item,
        prompt: combined
      };
      logEvent(`${name}: processing batch of ${claimedPairs.length}`);
      const injected = this.executeItem(batchItem, null);
      for (const { file: claimedPath, item: originalItem } of claimedPairs) {
        if (injected) this.moveInProgressToProcessed(claimedPath, "batched");
        // Requeue each claimant with its own original item, not the combined
        // batchItem — otherwise every retry re-inflates that file's prompt
        // with the whole prior batch's text, and re-batching next tick
        // compounds it further.
        else this.requeueClaimed(claimedPath, originalItem);
      }
    }
  }
  // ── Execute ───────────────────────────────────────────────────────
  // Only interactive items pass through the queue now. Delegate-mode
  // webhooks invoke bridge directly and never enqueue here; the legacy
  // non-interactive / script exec branches were removed.
  executeItem(item, file) {
    if (this.injectFn) {
      const opts = { type: "webhook" };
      const chatId = this.resolveChannel(item.channel) || "";
      if (item.instruction) {
        opts.instruction = `${item.instruction}\n\n${item.prompt}`;
      } else {
        opts.instruction = item.prompt;
      }
      // Ack race guard: a throw from injectFn used to strand the claimed
      // file in in-progress/ until the next start() requeue (event lost
      // until restart). Requeue immediately so the next tick retries;
      // at-least-once semantics are preserved (a crash between inject and
      // moveToProcessed still requeues via requeueStrandedInProgress()).
      try {
        this.injectFn(chatId, `event:${item.name}`, " ", opts);
      } catch (err) {
        logEvent(`${item.name}: inject failed — requeueing: ${err?.message ?? err}`);
        if (file) this.requeueClaimed(file, item);
        return false;
      }
    }
    if (file) {
      this._injectFailCounts.delete(this.originalQueueName(file));
      this.moveToProcessed(file, "injected");
    }
    return true;
  }
  originalQueueName(claimed) {
    const match = /^in-progress-\d+-(.+)$/.exec(claimed);
    return match ? match[1] : claimed;
  }
  // Move a single claimed in-progress/ handle back to queue/, restoring the
  // original enqueue-ordered filename. Used when inject fails after claim.
  // Retry budget: after INJECT_MAX_ATTEMPTS failures the item is dead-lettered
  // to processed/ as "failed" instead of retrying every tick forever.
  static INJECT_MAX_ATTEMPTS = 5;
  requeueClaimed(claimed, item) {
    const original = this.originalQueueName(claimed);
    // _injectFailCounts is in-memory and resets on restart/handoff; the
    // persisted event.injectAttempts field survives that, so resuming attempt
    // counting after a restart takes the max of both instead of restarting
    // from 0 (which would let a dead-letter-bound item retry forever across
    // restarts).
    const persistedAttempts = Number(item?.injectAttempts) || 0;
    const fails = Math.max(this._injectFailCounts.get(original) ?? 0, persistedAttempts) + 1;
    if (fails >= EventQueue.INJECT_MAX_ATTEMPTS) {
      this._injectFailCounts.delete(original);
      logEvent(`queue: ${original} failed ${fails} inject attempts — dead-lettering`);
      this.moveInProgressToProcessed(claimed, "failed");
      return;
    }
    this._injectFailCounts.set(original, fails);
    // Stamp the attempt count onto the persisted event record itself
    // (best-effort) so restart/handoff resumes from the correct count above.
    if (item) {
      try {
        writeJsonAtomicSync(join(IN_PROGRESS_DIR, claimed), { ...item, injectAttempts: fails }, { fsyncDir: true });
      } catch {}
    }
    try {
      renameWithRetrySync(join(IN_PROGRESS_DIR, claimed), join(QUEUE_DIR, original));
    } catch (err) {
      if (err && err.code && err.code !== "ENOENT") {
        logEvent(`queue: requeue failed for ${claimed}: ${err.message ?? err}`);
      }
    }
  }
  // ── Helpers ───────────────────────────────────────────────────────
  readQueueFiles() {
    try {
      return readdirSync(QUEUE_DIR).filter((f) => f.endsWith(".json")).sort();
    } catch {
      return [];
    }
  }
  readItem(file) {
    try {
      return JSON.parse(readFileSync(join(QUEUE_DIR, file), "utf8"));
    } catch (err) {
      if (err.code !== "ENOENT") {
        logEvent(`queue: corrupt file ${file}`);
      }
      return null;
    }
  }
  // Atomically rename from queue/ to in-progress/. Returns the new
  // filename on success, or null if another worker already claimed it /
  // the file vanished. Same-volume rename stays atomic; Windows transient
  // EPERM/EACCES/EBUSY gets a short retry window.
  claimFile(file) {
    try {
      ensureDir(IN_PROGRESS_DIR);
      const claimed = `in-progress-${Date.now()}-${file}`;
      renameWithRetrySync(join(QUEUE_DIR, file), join(IN_PROGRESS_DIR, claimed));
      return claimed;
    } catch (err) {
      // ENOENT: another tick grabbed it; EEXIST: target collision (very rare).
      if (err && err.code && err.code !== "ENOENT" && err.code !== "EEXIST") {
        logEvent(`queue: claim failed for ${file}: ${err.message ?? err}`);
      }
      return null;
    }
  }
  // Move any leftover in-progress/ handles back to queue/ so a crash between
  // claim and execute does not strand the event. Claim names are
  // `in-progress-<ts>-<originalFile>`; strip the prefix to restore the
  // original queue filename (which preserves enqueue-sequence ordering).
  requeueStrandedInProgress() {
    let entries;
    try {
      entries = readdirSync(IN_PROGRESS_DIR).filter((f) => f.endsWith(".json"));
    } catch {
      return;
    }
    let count = 0;
    for (const claimed of entries) {
      const match = /^in-progress-\d+-(.+)$/.exec(claimed);
      const original = match ? match[1] : claimed;
      try {
        renameWithRetrySync(join(IN_PROGRESS_DIR, claimed), join(QUEUE_DIR, original));
        count++;
      } catch (err) {
        if (err && err.code && err.code !== "ENOENT") {
          logEvent(`queue: requeue failed for ${claimed}: ${err.message ?? err}`);
        }
      }
    }
    if (count > 0) logEvent(`queue: requeued ${count} stranded in-progress events`);
  }
  moveToProcessed(file, status) {
    // `file` may already live under in-progress/ (claimed) or still in
    // queue/ (batch paths). Try both locations.
    try {
      ensureDir(PROCESSED_DIR);
      const fromInProgress = join(IN_PROGRESS_DIR, file);
      const fromQueue = join(QUEUE_DIR, file);
      const src = this.existsSync(fromInProgress) ? fromInProgress : fromQueue;
      renameWithRetrySync(src, join(PROCESSED_DIR, `${status}-${file}`));
      pruneProcessedDir();
    } catch {
    }
  }
  moveInProgressToProcessed(file, status) {
    try {
      ensureDir(PROCESSED_DIR);
      renameWithRetrySync(join(IN_PROGRESS_DIR, file), join(PROCESSED_DIR, `${status}-${file}`));
      pruneProcessedDir();
    } catch {
    }
  }
  existsSync(p) {
    try {
      // readdirSync-free existence check via rename would be destructive —
      // fall back to a cheap stat via readFileSync on non-content probe.
      // Use fs.existsSync semantics without importing it twice.
      return fsExistsSync(p);
    } catch {
      return false;
    }
  }
  // The frontmatter `channel` key is a boolean-ish flag: any non-empty value
  // except "false" means post to the single main channel; absent → inject.
  // A pure-digit / snowflake value is honored verbatim as an explicit id
  // override (matches resolveWebhookChannelId in index.mjs).
  resolveChannel(flag) {
    if (flag == null) return "";
    const v = String(flag).trim();
    if (v === "" || v.toLowerCase() === "false") return "";
    if (/^-?\d+$/.test(v)) return v;
    return this.channelId ?? "";
  }
  /** Remove items from queue — after processing, dismissal, or any resolution */
  resolveItems(name, status = "done") {
    const files = this.readQueueFiles();
    let count = 0;
    for (const file of files) {
      const item = this.readItem(file);
      if (!item) continue;
      if (item.name === name || name === "*") {
        this.moveToProcessed(file, status);
        count++;
      }
    }
    if (count > 0) logEvent(`queue: resolved ${count} items (name=${name}, status=${status})`);
    return count;
  }
  /** Get queue status */
  getStatus() {
    const pending = this.readQueueFiles().length;
    return { pending, running: 0 };
  }
  /** List pending interactive items */
  getPendingInteractive() {
    return this.readQueueFiles().map((f) => this.readItem(f)).filter((item) => item !== null && item.exec === "interactive");
  }
}
export {
  EventQueue
};
