import { readFileSync, writeFileSync, appendFileSync, unlinkSync } from "fs";
import { appendFile as _appendFile } from "fs";
import { join, isAbsolute } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { DATA_DIR } from "./config.mjs";
import { ensureNopluginDir } from "./executor.mjs";
import { withFileLockSync } from "../../shared/atomic-file.mjs";
import { markFired, markDone, setDeferred, setSkippedUntil } from "../../shared/schedules-db.mjs";
import { runScheduleSession } from "../../shared/schedule-session-run.mjs";

const SCHEDULE_LOG = join(DATA_DIR, "schedule.log");
// Buffered async logger — coalesces per-line appends into batched writes.
let _schedLogBuf = [];
let _schedLogTimer = null;
function _flushScheduleLog() {
  _schedLogTimer = null;
  if (_schedLogBuf.length === 0) return;
  const lines = _schedLogBuf.join("");
  _schedLogBuf = [];
  _appendFile(SCHEDULE_LOG, lines, () => {});
}
function _flushSchedLogSync() {
  if (_schedLogBuf.length === 0) return;
  const lines = _schedLogBuf.join("");
  _schedLogBuf = [];
  try { appendFileSync(SCHEDULE_LOG, lines); } catch {}
}
process.on('exit', _flushSchedLogSync);
// Note: do not install a module-level SIGTERM handler that calls
// process.exit() here. The channels worker owns shutdown sequencing
// (drain queues, persist baselines, release the scheduler lock, etc.)
// and a library-level exit(0) preempts that drain. The `exit` listener
// above still flushes pending log lines synchronously when the worker
// finishes its own shutdown.
function logSchedule(msg) {
  process.stderr.write(`mixdog scheduler: ${msg}\n`);
  _schedLogBuf.push(`[${new Date().toISOString()}] ${msg}\n`);
  if (!_schedLogTimer) _schedLogTimer = setTimeout(_flushScheduleLog, 2000);
}

import { tryRead } from "./settings.mjs";
// node-cron is an optional runtime dep. If the module isn't installed
// (e.g. a fresh v0.6.190 where node_modules predates the package.json
// bump), cron expressions are disabled (cron stays null below) instead
// of crashing the whole channels worker.
let cron = null;
try {
  const mod = await import("node-cron");
  cron = mod.default || mod;
} catch (err) {
  process.stderr.write(`mixdog scheduler: node-cron unavailable, cron expressions disabled (${err?.code || err?.message || err})\n`);
}
const TICK_INTERVAL = 6e4;
// All schedule `time` values must be valid 5- or 6-field cron expressions
// (node-cron format). Legacy formats (HH:MM, everyNm, hourly, daily) are
// no longer accepted — migrate to cron: "MM HH * * *", "*/N * * * *", etc.
function isCronExpression(time) {
  if (typeof time !== "string" || !time) return false;
  if (!cron) return false;
  const tokens = time.trim().split(/\s+/);
  if (tokens.length !== 5 && tokens.length !== 6) return false;
  try { return cron.validate(time); } catch { return false; }
}
/** Validate a cron expression and throw a descriptive error if invalid.
 *  Used by schedule_control / schedules POST before accepting input. */
function validateCronExpression(time) {
  if (typeof time !== "string" || !time) throw new Error(`invalid cron expression: ${JSON.stringify(time)}`);
  if (!cron) throw new Error(`cron expression "${time}" rejected: node-cron is not available (install node-cron to use cron expressions)`);
  const tokens = time.trim().split(/\s+/);
  if (tokens.length !== 5 && tokens.length !== 6) {
    throw new Error(`invalid cron expression "${time}": expected 5 or 6 fields, got ${tokens.length}. Legacy formats (HH:MM, everyNm, hourly, daily) are no longer supported — use a cron expression instead.`);
  }
  let valid = false;
  try { valid = cron.validate(time); } catch (e) {
    throw new Error(`invalid cron expression "${time}": ${e?.message || e}`);
  }
  if (!valid) throw new Error(`invalid cron expression "${time}": failed node-cron validation. Legacy formats (HH:MM, everyNm, hourly, daily) are no longer supported — use a cron expression instead.`);
}
class Scheduler {
  nonInteractive;
  interactive;
  channelId;
  promptsDir;
  tickTimer = null;
  lastFired = /* @__PURE__ */ new Map();
  // name -> "YYYY-MM-DDTHH:MM"
  running = /* @__PURE__ */ new Set();
  injectFn = null;
  sendFn = null;
  pendingCheck = null;
  // Activity tracking
  lastActivity = 0;
  // timestamp of last inbound message
  deferred = /* @__PURE__ */ new Map();
  // name -> deferred-until timestamp
  cronJobs = /* @__PURE__ */ new Map();
  // name -> node-cron ScheduledTask for cron-expression entries
  oneShotTimers = /* @__PURE__ */ new Map();
  // name -> setTimeout handle for when_at one-shot entries
  //
  // `channelId` is the single resolved main-channel id used when a schedule's
  // `channel` flag is set (post-to-channel); absent flag → inject into session.
  constructor(nonInteractive, interactive, channelId) {
    this.nonInteractive = nonInteractive.filter((s) => s.enabled !== false);
    this.interactive = interactive.filter((s) => s.enabled !== false);
    this.channelId = channelId ?? "";
    this.promptsDir = join(DATA_DIR, "prompts");
    this.refreshSkipCache();
  }
  setInjectHandler(fn) {
    this.injectFn = fn;
  }
  setSendHandler(fn) {
    this.sendFn = fn;
  }
  setPendingCheck(fn) {
    this.pendingCheck = typeof fn === 'function' ? fn : null;
  }
  noteActivity() {
    this.lastActivity = Date.now();
  }
  /** Find a loaded schedule def by name (either routing bucket). */
  findSchedule(name) {
    return [...this.nonInteractive, ...this.interactive].find((s) => s.name === name) ?? null;
  }
  /** Rebuild the in-memory deferred cache (used by the status snapshot) from
   *  the loaded rows' deferred_until values. Called on construct + reload so
   *  persisted defer/skip state survives a config reload. */
  refreshSkipCache() {
    this.deferred.clear();
    const now = Date.now();
    for (const s of [...this.nonInteractive, ...this.interactive]) {
      const until = s.deferredUntil ? new Date(s.deferredUntil).getTime() : 0;
      if (until > now) this.deferred.set(s.name, until);
    }
  }
  /** Defer a schedule by N minutes from now (persisted to deferred_until). */
  async defer(name, minutes) {
    const mins = Number(minutes);
    if (!Number.isFinite(mins) || mins <= 0) {
      throw new Error(`defer: minutes must be a positive number, got ${JSON.stringify(minutes)}`);
    }
    const s = this.findSchedule(name);
    if (!s) throw new Error(`defer: unknown schedule "${name}" — use schedule_status to list valid names`);
    const until = new Date(Date.now() + mins * 6e4);
    await setDeferred(name, until);
    s.deferredUntil = until.toISOString();
    this.deferred.set(name, until.getTime());
  }
  /** Skip a schedule for the rest of today (persisted to skipped_until = end
   *  of the local day). */
  async skipToday(name) {
    const s = this.findSchedule(name);
    if (!s) throw new Error(`skip_today: unknown schedule "${name}" — use schedule_status to list valid names`);
    const eod = new Date();
    eod.setHours(23, 59, 59, 999);
    await setSkippedUntil(name, eod);
    s.skippedUntil = eod.toISOString();
  }
  /** Check if a schedule should be skipped, reading deferred_until /
   *  skipped_until from the loaded row (in-memory cache, refreshed on reload). */
  shouldSkip(name) {
    const s = this.findSchedule(name);
    if (!s) return false;
    const now = Date.now();
    const deferredUntil = s.deferredUntil ? new Date(s.deferredUntil).getTime() : 0;
    if (deferredUntil && now < deferredUntil) return true;
    const skippedUntil = s.skippedUntil ? new Date(s.skippedUntil).getTime() : 0;
    if (skippedUntil && now < skippedUntil) return true;
    return false;
  }
  /** Timestamp (ms) until which `name` is currently skipped — the later of a
   *  still-future deferred_until / skipped_until, or 0 if not skipped. Used to
   *  re-arm a deferred when_at one-shot for the moment the skip expires. */
  skipUntil(name) {
    const s = this.findSchedule(name);
    if (!s) return 0;
    const now = Date.now();
    let until = 0;
    const deferredUntil = s.deferredUntil ? new Date(s.deferredUntil).getTime() : 0;
    if (deferredUntil && now < deferredUntil) until = Math.max(until, deferredUntil);
    const skippedUntil = s.skippedUntil ? new Date(s.skippedUntil).getTime() : 0;
    if (skippedUntil && now < skippedUntil) until = Math.max(until, skippedUntil);
    return until;
  }
  /** Get current session activity state.
   *  Returns { lastActivityMs, pendingWork } — callers apply their own
   *  thresholds. pendingWork is true when pendingCheck() reports work in
   *  flight. lastActivityMs is 0 when no activity has been recorded. */
  getSessionState() {
    let pendingWork = false;
    try {
      if (this.pendingCheck) pendingWork = !!this.pendingCheck();
    } catch { /* probe failure is not fatal */ }
    return { lastActivityMs: this.lastActivity, pendingWork };
  }
  /** Returns true when the session is considered idle (no pending work and
   *  lastActivityMs is either 0 or older than the given threshold).
   *  threshold defaults to 15 minutes but callers should pass their own. */
  isSessionIdle(thresholdMs = 15 * 6e4) {
    const { lastActivityMs, pendingWork } = this.getSessionState();
    if (pendingWork) return false;
    if (lastActivityMs === 0) return true;
    return Date.now() - lastActivityMs >= thresholdMs;
  }
  /** Get time context for prompt enrichment */
  getTimeContext() {
    const now = /* @__PURE__ */ new Date();
    const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const dow = now.getDay();
    return {
      hour: now.getHours(),
      dayOfWeek: days[dow],
      isWeekend: dow === 0 || dow === 6
    };
  }
  /** Wrap prompt with session context metadata */
  wrapPrompt(name, prompt, type) {
    const { lastActivityMs, pendingWork } = this.getSessionState();
    const state = pendingWork ? "active" : lastActivityMs === 0 ? "idle" : "recent";
    const time = this.getTimeContext();
    const header = [
      `[schedule: ${name} | type: ${type} | session: ${state}]`,
      `[time: ${time.dayOfWeek} ${String(time.hour).padStart(2, "0")}:${String((/* @__PURE__ */ new Date()).getMinutes()).padStart(2, "0")} | weekend: ${time.isWeekend}]`,
      `Before starting any work, briefly tell the user what you're about to do in one short sentence.`
    ].join("\n");
    return `${header}

${prompt}`;
  }
  static SCHEDULER_LOCK = join(tmpdir(), "mixdog-scheduler.lock");
  static INSTANCE_UUID = randomUUID();
  static _exitHookInstalled = false;
  start() {
    if (this.tickTimer) return;
    const total = this.nonInteractive.length + this.interactive.length;
    if (total === 0) {
      process.stderr.write("mixdog scheduler: no schedules configured\n");
      return;
    }
    ensureNopluginDir();
    const lockContent = `${process.pid}
${Date.now()}
${Scheduler.INSTANCE_UUID}`;
    let acquiredSchedulerLock = false;
    withFileLockSync(`${Scheduler.SCHEDULER_LOCK}.acquire`, () => {
      try {
        writeFileSync(Scheduler.SCHEDULER_LOCK, lockContent, { flag: "wx" });
        acquiredSchedulerLock = true;
      } catch (err) {
        if (err.code === "EEXIST") {
          try {
            const content = readFileSync(Scheduler.SCHEDULER_LOCK, "utf8");
            const lines = content.split("\n");
            const pid = parseInt(lines[0]);
            let isAlive = false;
            try {
              process.kill(pid, 0);
              isAlive = true;
            } catch {
            }
            if (isAlive) {
              // No heartbeat: lock age cannot distinguish a long-running
              // healthy owner from PID-reuse, so an age-only reclaim
              // would double-schedule cron jobs while the original
              // owner is still firing. Only proceed to reclaim when
              // process.kill(pid, 0) actually proves the PID is dead —
              // not by guessing from `lockAge > 1h`.
              process.stderr.write(`mixdog scheduler: another session (PID ${pid}) owns the scheduler, skipping
`);
              return;
            }
          } catch {
          }
          // Reclaim runs under the shared atomic-file acquisition guard.
          // That guard serializes this scheduler acquisition path's
          // check/unlink/wx sequence, so a second reclaimer cannot delete
          // a fresh lock in the path gap between stale unlink and create.
          try { unlinkSync(Scheduler.SCHEDULER_LOCK); } catch {}
          try {
            writeFileSync(Scheduler.SCHEDULER_LOCK, lockContent, { flag: "wx" });
            acquiredSchedulerLock = true;
          } catch (e2) {
            if (e2.code === "EEXIST") {
              process.stderr.write(`mixdog scheduler: lock reclaimed by another session during reclaim, skipping
`);
              return;
            }
            throw e2;
          }
        } else {
          throw err;
        }
      }
    }, { timeoutMs: 60000, staleMs: 30000 });
    if (!acquiredSchedulerLock) return;
    if (!Scheduler._exitHookInstalled) {
      Scheduler._exitHookInstalled = true;
      process.on("exit", () => {
        // Verify ownership before unlink: an exiting process whose lock
        // was already reclaimed by a newer owner (PID-reuse / restart race)
        // must NOT delete the new owner's lock file. Read-verify-then-unlink
        // mirrors memory/index.mjs releaseLock().
        try {
          const content = readFileSync(Scheduler.SCHEDULER_LOCK, "utf8");
          const lockedPid = parseInt(content.split("\n")[0]);
          if (lockedPid === process.pid) unlinkSync(Scheduler.SCHEDULER_LOCK);
        } catch {
        }
      });
    }
    logSchedule(`${this.nonInteractive.length} non-interactive, ${this.interactive.length} interactive
`);
    this.registerCronJobs();
    this.tick();
    this.tickTimer = setInterval(() => this.tick(), TICK_INTERVAL);
  }
  /** Register schedule entries. `when_cron` entries bind to node-cron (dow
   *  field covers the day guard); `when_at` entries arm a one-shot timer. */
  registerCronJobs() {
    const all = [
      ...this.nonInteractive.map((s) => ({ schedule: s, type: "non-interactive" })),
      ...this.interactive.map((s) => ({ schedule: s, type: "interactive" })),
    ];
    for (const { schedule: s, type } of all) {
      if (s.whenCron) {
        if (!isCronExpression(s.whenCron)) {
          process.stderr.write(`mixdog scheduler: invalid cron "${s.name}" (${s.whenCron}) — skipped\n`);
          continue;
        }
        try {
          const task = cron.schedule(s.whenCron, () => this.onCronFire(s, type), {
            timezone: s.timezone || undefined,
            name: s.name,
          });
          this.cronJobs.set(s.name, task);
          logSchedule(`registered cron "${s.name}" = "${s.whenCron}"${s.timezone ? ` tz=${s.timezone}` : ""}\n`);
        } catch (err) {
          process.stderr.write(`mixdog scheduler: failed to register cron "${s.name}" (${s.whenCron}): ${err}\n`);
        }
      } else if (s.whenAt) {
        this.armOneShot(s, type);
      }
    }
  }
  /** Fire path for a cron-triggered entry. node-cron's dow field covers the
   *  day guard, so there is no separate days filter. Persists last_fired_at. */
  async onCronFire(schedule, type) {
    const now = /* @__PURE__ */ new Date();
    if (this.shouldSkip(schedule.name)) return;
    // Record lastFired only when the fire actually proceeds past
    // fireTimed's running/precondition guards (it resolves truthy on a
    // real fire), so failed/skipped fires no longer display as fired.
    this.fireTimed(schedule, type).then(async (fired) => {
      if (!fired) return;
      this.lastFired.set(schedule.name, now.toISOString());
      try { await markFired(schedule.name, now); }
      catch (err) { process.stderr.write(`mixdog scheduler: ${schedule.name} markFired failed: ${err}\n`); }
    }).catch(
      (err) => process.stderr.write(`mixdog scheduler: ${schedule.name} failed: ${err}\n`)
    );
  }
  stop() {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    this.destroyCronJobs();
    // Release the scheduler lock so a subsequent start() in the same
    // process can re-acquire it. Without this, the wx-create in start()
    // hits its own live lock (matching INSTANCE_UUID + recent mtime) and
    // refuses to register cron jobs, leaving the scheduler silently idle
    // after a reload/restart cycle. Read-verify-then-unlink so we don't
    // delete another live owner's lock file (mirrors memory releaseLock).
    try {
      const content = readFileSync(Scheduler.SCHEDULER_LOCK, "utf8");
      const lockedPid = parseInt(content.split("\n")[0]);
      if (lockedPid === process.pid) unlinkSync(Scheduler.SCHEDULER_LOCK);
    } catch {}
  }
  destroyCronJobs() {
    for (const [, task] of this.cronJobs) {
      try { task.destroy(); } catch {}
    }
    this.cronJobs.clear();
    for (const [, timer] of this.oneShotTimers) {
      try { clearTimeout(timer); } catch {}
    }
    this.oneShotTimers.clear();
  }
  /** Arm a when_at one-shot: schedule a timer for the instant. Past-due
   *  entries (misfire recovery at start) fire immediately. setTimeout's
   *  ~24.8-day (2^31-1 ms) ceiling is handled by re-arming for far-future
   *  instants instead of firing early. */
  armOneShot(schedule, type) {
    const fireAt = new Date(schedule.whenAt).getTime();
    if (!Number.isFinite(fireAt)) {
      process.stderr.write(`mixdog scheduler: invalid when_at for "${schedule.name}" (${schedule.whenAt}) — skipped\n`);
      return;
    }
    const delay = fireAt - Date.now();
    const MAX = 2 ** 31 - 1;
    if (delay > MAX) {
      const timer = setTimeout(() => this.armOneShot(schedule, type), MAX);
      this.oneShotTimers.set(schedule.name, timer);
      return;
    }
    const timer = setTimeout(() => this.fireOneShot(schedule, type), Math.max(0, delay));
    this.oneShotTimers.set(schedule.name, timer);
    logSchedule(`armed one-shot "${schedule.name}" at ${new Date(fireAt).toISOString()}${delay <= 0 ? " (misfire → immediate)" : ""}\n`);
  }
  /** markDone with bounded retry. A one-shot that fired but failed to persist
   *  status='done' would otherwise stay 'active' with a past when_at and
   *  re-arm (duplicate fire) on the next restart/reload, so recovering the
   *  done-marker matters — retry a few times with a logged failure. */
  async markDoneWithRetry(name, attempts = 3) {
    for (let i = 0; i < attempts; i++) {
      try { await markDone(name); return true; }
      catch (err) {
        process.stderr.write(`mixdog scheduler: ${name} markDone failed (attempt ${i + 1}/${attempts}): ${err}\n`);
        if (i < attempts - 1) await new Promise((r) => setTimeout(r, 250));
      }
    }
    return false;
  }
  /** Fire a one-shot exactly once, then mark it done so it never re-arms.
   *  Idempotent: if last_fired_at is already set (a prior fire whose markDone
   *  failed left the row 'active'), do NOT fire again — only retry markDone so
   *  the stuck-active entry stops re-arming/misfiring. */
  async fireOneShot(schedule, type) {
    this.oneShotTimers.delete(schedule.name);
    const now = /* @__PURE__ */ new Date();
    if (schedule.lastFiredAt) {
      logSchedule(`one-shot "${schedule.name}" already fired (last_fired_at set) — retrying markDone only\n`);
      await this.markDoneWithRetry(schedule.name);
      return;
    }
    // when_at one-shots must honor deferred_until / skipped_until just like
    // cron fires (onCronFire) do. Unlike a recurring cron, a one-shot's timer
    // already elapsed and tickAsync is a no-op, so simply returning would mean
    // it never fires until a restart. Re-arm for the deferral expiry (the
    // later of when_at and deferred/skipped-until) so it fires on its own.
    if (this.shouldSkip(schedule.name)) {
      const until = this.skipUntil(schedule.name);
      const fireAt = new Date(schedule.whenAt).getTime();
      const target = Math.max(Number.isFinite(fireAt) ? fireAt : 0, until);
      const MAX = 2 ** 31 - 1;
      let delay = target - Date.now();
      delay = delay > MAX ? MAX : Math.max(delay, 1);
      logSchedule(`one-shot "${schedule.name}" deferred/skipped — re-arming for ${new Date(target).toISOString()}\n`);
      const timer = setTimeout(() => this.fireOneShot(schedule, type), delay);
      this.oneShotTimers.set(schedule.name, timer);
      return;
    }
    // Mark done ONLY after a successful fire. A false/throwing fireTimed
    // (missing prompt/model, running guard, dispatch error) must leave the
    // one-shot pending so a reload/restart can retry it — never retire it.
    try {
      // awaitDispatch: for a one-shot we must wait for the actual LLM/relay
      // dispatch outcome — a truthy fireTimed alone (cron's fire-and-forget
      // contract) would retire the entry even when schedulerLlm() later
      // rejects. Only a resolved dispatch counts as a real fire here.
      const fired = await this.fireTimed(schedule, type, { awaitDispatch: true });
      if (!fired) {
        logSchedule(`one-shot "${schedule.name}" did not fire (skipped/guarded) — leaving pending for retry\n`);
        return;
      }
      this.lastFired.set(schedule.name, now.toISOString());
      schedule.lastFiredAt = now.toISOString();
      try { await markFired(schedule.name, now); }
      catch (err) { process.stderr.write(`mixdog scheduler: ${schedule.name} markFired failed: ${err}\n`); }
      await this.markDoneWithRetry(schedule.name);
    } catch (err) {
      process.stderr.write(`mixdog scheduler: ${schedule.name} one-shot failed: ${err} — leaving pending for retry\n`);
    }
  }
  restart() {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    this.destroyCronJobs();
    // Read-verify-then-unlink so a non-owner reload can't delete the
    // live owner's lock file (mirrors stop() and the exit handler).
    try {
      const content = readFileSync(Scheduler.SCHEDULER_LOCK, "utf8");
      const lockedPid = parseInt(content.split("\n")[0]);
      if (lockedPid === process.pid) unlinkSync(Scheduler.SCHEDULER_LOCK);
    } catch {}
    this.start();
  }
  reloadConfig(nonInteractive, interactive, channelId, options = {}) {
    this.nonInteractive = nonInteractive.filter((s) => s.enabled !== false);
    this.interactive = interactive.filter((s) => s.enabled !== false);
    this.channelId = channelId ?? "";
    this.promptsDir = join(DATA_DIR, "prompts");
    // Defer/skip state is persisted (deferred_until / skipped_until) and
    // re-read from the reloaded rows, so a reload no longer drops it.
    this.refreshSkipCache();
    if (options.restart === false) {
      // Caller owns lifecycle; still drop stale cron bindings so they don't fire against old config.
      this.destroyCronJobs();
      return;
    }
    this.restart();
  }
  getStatus() {
    const rows = [
      ...this.nonInteractive.map((s) => ({ s, type: "non-interactive" })),
      ...this.interactive.map((s) => ({ s, type: "interactive" })),
    ];
    return rows.map(({ s, type }) => ({
      name: s.name,
      time: s.whenCron ?? s.whenAt ?? null,
      type,
      running: false,
      lastFired: this.lastFired.get(s.name) ?? null,
    }));
  }
  async triggerManual(name) {
    const timed = [...this.nonInteractive, ...this.interactive].find((e) => e.name === name);
    if (timed) {
      if (this.running.has(name)) return `"${name}" is already running`;
      const isNonInteractive = this.nonInteractive.includes(timed);
      const now = /* @__PURE__ */ new Date();
      const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
      const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
      // Match onCronFire: record lastFired only when fireTimed actually
      // proceeds past its running/precondition guards (resolves truthy),
      // and reflect a non-fire in the returned status.
      const fired = await this.fireTimed(timed, isNonInteractive ? "non-interactive" : "interactive");
      if (fired) {
        this.lastFired.set(name, `${dateStr}T${hhmm}`);
        return `triggered "${name}"`;
      }
      return `"${name}" did not fire (skipped or already running)`;
    }
    return `schedule "${name}" not found`;
  }
  // ── Tick ─────────────────────────────────────────────────────────────
  tick() {
    this.tickAsync().catch(
      (err) => process.stderr.write(`mixdog scheduler: tick error: ${err}
`)
    );
  }
  async tickAsync() {
    // All timed schedules are handled exclusively by node-cron
    // (registerCronJobs). tick() no longer does any per-day work; the
    // interval is kept for future cadence-driven work and lifecycle parity.
  }
  // ── Fire timed schedule ─────────────────────────────────────────────
  async fireTimed(schedule, type, opts = {}) {
    const prompt = this.resolvePrompt(schedule);
    if (!prompt) {
      process.stderr.write(`mixdog scheduler: prompt not found for "${schedule.name}"
`);
      return false;
    }
    // target 'channel' → relay the run result to the schedule's channel_id
    // (falling back to the resolved main channel). target 'session' → no
    // channel relay; the visible session run IS the surface.
    const channelId = schedule.target === "channel"
      ? this.resolveChannel(schedule.channelId)
      : "";
    return await this.fireTimedPrompt(schedule, type, prompt, channelId, opts);
  }
  /** Fire a timed schedule with the given prompt content */
  async fireTimedPrompt(schedule, type, prompt, channelId, { awaitDispatch = false } = {}) {
    logSchedule(`firing ${schedule.name} (${type})
`);
    // Legacy interactive Lead-session inject is retired: every schedule fire
    // runs as its own visible session below (New-task parity, user decision).
    if (this.running.has(schedule.name)) return false;
    this.running.add(schedule.name);
    const presetId = schedule.model;
    if (!presetId) {
      this.running.delete(schedule.name);
      logSchedule(`${schedule.name}: missing required "model" in schedule config — dispatch rejected\n`);
      return false;
    }
    // Cron (recurring) keeps the fire-and-forget contract: return truthy now
    // and swallow async failures. A one-shot (awaitDispatch) instead awaits
    // the dispatch so a rejected run propagates and the caller leaves the
    // entry pending for retry instead of retiring it.
    // Fires now run as VISIBLE schedule sessions (desktop Recent / TUI
    // resume) via runScheduleSession; the wrapped prompt keeps the schedule
    // context header, and the channel relay below is unchanged.
    const dispatch = runScheduleSession(schedule, { prompt })
      .then(({ result }) => {
        this.running.delete(schedule.name);
        if (result && channelId && this.sendFn) {
          this.sendFn(channelId, result).catch(
            (err) => process.stderr.write(`mixdog scheduler: ${schedule.name} relay failed: ${err}\n`)
          );
        }
        logSchedule(`${schedule.name} done\n`);
        return true;
      })
      .catch((err) => {
        this.running.delete(schedule.name);
        logSchedule(`${schedule.name} LLM error: ${err.message}\n`);
        if (awaitDispatch) throw err;
        return false;
      });
    if (awaitDispatch) return await dispatch;
    return true;
  }
  // ── Helpers ─────────────────────────────────────────────────────────
  /** Resolve prompt: inline text from the row, with a prompts-dir file
   *  fallback for legacy `<name>.md` references. */
  resolvePrompt(schedule) {
    const ref = schedule.prompt ?? `${schedule.name}.md`;
    const fromFile = this.loadPrompt(ref);
    if (fromFile) return fromFile;
    if (schedule.prompt) return schedule.prompt;
    return null;
  }
  loadPrompt(nameOrPath) {
    const full = isAbsolute(nameOrPath) ? nameOrPath : join(this.promptsDir, nameOrPath);
    return tryRead(full);
  }
  /** Resolve a schedule's channel flag to a channel id (pre-refactor
   *  semantics): absent/empty/"false" → "" (inject into session); a
   *  pure-digit / snowflake value is honored verbatim as an explicit id
   *  override; any other value — including legacy labels like "main" —
   *  resolves to the configured main channel. */
  resolveChannel(flag) {
    if (flag == null) return this.channelId ?? "";
    const v = String(flag).trim();
    if (v.toLowerCase() === "false") return "";
    if (/^-?\d+$/.test(v)) return v;
    // empty or a legacy label ("main") → configured main channel
    return this.channelId ?? "";
  }
}
export {
  Scheduler
};
