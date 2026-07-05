import { readFileSync, writeFileSync, appendFileSync, unlinkSync } from "fs";
import { appendFile as _appendFile } from "fs";
import { join, isAbsolute } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { DATA_DIR } from "./config.mjs";
import { runScript as execScript, ensureNopluginDir } from "./executor.mjs";
import { withFileLockSync } from "../../shared/atomic-file.mjs";
import { makeAgentDispatch } from '../../agent/orchestrator/agent-runtime/agent-dispatch.mjs';

const schedulerLlm = makeAgentDispatch({ taskType: 'scheduler-task', agent: 'scheduler-task', sourceType: 'scheduler' });
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
export function validateCronExpression(time) {
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
// Build a {hhmm, dateStr, dow} snapshot in the given IANA TZ. Falls
// back to local Date math when tz is absent.
function tzSnapshot(now, tz) {
  if (!tz) {
    return {
      hhmm: `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`,
      dateStr: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`,
      dow: now.getDay(),
    };
  }
  const parts = new Intl.DateTimeFormat("en-US", {
    hour12: false, timeZone: tz,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", weekday: "short",
  }).formatToParts(now).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  const hour = parts.hour === "24" ? "00" : parts.hour;
  const dowMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    hhmm: `${hour}:${parts.minute}`,
    dateStr: `${parts.year}-${parts.month}-${parts.day}`,
    dow: dowMap[parts.weekday] ?? now.getDay(),
  };
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
  skippedToday = /* @__PURE__ */ new Set();
  // names skipped for today
  skippedTodayDate = "";
  // "YYYY-MM-DD" local date the skippedToday set belongs to
  cronJobs = /* @__PURE__ */ new Map();
  // name -> node-cron ScheduledTask for cron-expression entries
  //
  // `channelId` is the single resolved main-channel id used when a schedule's
  // `channel` flag is set (post-to-channel); absent flag → inject into session.
  constructor(nonInteractive, interactive, channelId) {
    this.nonInteractive = nonInteractive.filter((s) => s.enabled !== false);
    this.interactive = interactive.filter((s) => s.enabled !== false);
    this.channelId = channelId ?? "";
    this.promptsDir = join(DATA_DIR, "prompts");
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
  /** Defer a schedule by N minutes from now */
  defer(name, minutes) {
    const mins = Number(minutes);
    if (!Number.isFinite(mins) || mins <= 0) {
      throw new Error(`defer: minutes must be a positive number, got ${JSON.stringify(minutes)}`);
    }
    const allSchedules = [...this.nonInteractive, ...this.interactive];
    const exists = allSchedules.some(s => s.name === name);
    if (!exists) throw new Error(`defer: unknown schedule "${name}" — use schedule_status to list valid names`);
    this.deferred.set(name, Date.now() + mins * 6e4);
  }
  /** Skip a schedule for the rest of today */
  skipToday(name) {
    const allSchedules = [...this.nonInteractive, ...this.interactive];
    const exists = allSchedules.some(s => s.name === name);
    if (!exists) throw new Error(`skip_today: unknown schedule "${name}" — use schedule_status to list valid names`);
    this.rolloverSkippedTodayIfNeeded();
    this.skippedToday.add(name);
  }
  /** Roll the skippedToday bucket over when the local date has changed */
  rolloverSkippedTodayIfNeeded() {
    const today = new Date().toLocaleDateString('sv-SE');
    if (this.skippedTodayDate !== today) {
      this.skippedToday.clear();
      this.skippedTodayDate = today;
    }
  }
  /** Check if a schedule should be skipped (deferred or skipped today) */
  shouldSkip(name) {
    this.rolloverSkippedTodayIfNeeded();
    if (this.skippedToday.has(name)) return true;
    const until = this.deferred.get(name);
    if (until && Date.now() < until) return true;
    if (until && Date.now() >= until) this.deferred.delete(name);
    return false;
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
  /** Register cron-expression entries with node-cron. All schedule entries
   *  must use cron expressions. Entries that fail cron validation are skipped
   *  with a logged error. */
  registerCronJobs() {
    const all = [
      ...this.nonInteractive.map((s) => ({ schedule: s, type: "non-interactive" })),
      ...this.interactive.map((s) => ({ schedule: s, type: "interactive" })),
    ];
    for (const { schedule: s, type } of all) {
      if (!isCronExpression(s.time)) continue;
      try {
        const task = cron.schedule(s.time, () => this.onCronFire(s, type), {
          timezone: s.timezone || undefined,
          name: s.name,
        });
        this.cronJobs.set(s.name, task);
        logSchedule(`registered cron "${s.name}" = "${s.time}"${s.timezone ? ` tz=${s.timezone}` : ""}\n`);
      } catch (err) {
        process.stderr.write(`mixdog scheduler: failed to register cron "${s.name}" (${s.time}): ${err}\n`);
      }
    }
  }
  /** Fire path for a cron-triggered entry. Applies day guards against
   *  the schedule's TZ (or local when absent). */
  async onCronFire(schedule, type) {
    const now = /* @__PURE__ */ new Date();
    const tz = schedule.timezone || null;
    const snap = tzSnapshot(now, tz);
    const isWeekend = snap.dow === 0 || snap.dow === 6;
    const days = schedule.days ?? "daily";
    if (!this.matchesDays(days, snap.dow, isWeekend)) return;
    if (this.shouldSkip(schedule.name)) return;
    // Record lastFired only when the fire actually proceeds past
    // fireTimed's running/precondition guards (it resolves truthy on a
    // real fire), so failed/skipped fires no longer display as fired.
    this.fireTimed(schedule, type).then(
      (fired) => { if (fired) this.lastFired.set(schedule.name, now.toISOString()); }
    ).catch(
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
    if (this.deferred.size > 0 || this.skippedToday.size > 0) {
      process.stderr.write(`mixdog scheduler: reload clearing ${this.deferred.size} deferred, ${this.skippedToday.size} skipped
`);
    }
    this.deferred.clear();
    this.skippedToday.clear();
    if (options.restart === false) {
      // Caller owns lifecycle; still drop stale cron bindings so they don't fire against old config.
      this.destroyCronJobs();
      return;
    }
    this.restart();
  }
  getStatus() {
    const result = [];
    for (const s of this.nonInteractive) {
      result.push({
        name: s.name,
        time: s.time,
        days: s.days ?? "daily",
        type: "non-interactive",
        running: false,
        lastFired: this.lastFired.get(s.name) ?? null
      });
    }
    for (const s of this.interactive) {
      result.push({
        name: s.name,
        time: s.time,
        days: s.days ?? "daily",
        type: "interactive",
        running: false,
        lastFired: this.lastFired.get(s.name) ?? null
      });
    }
    return result;
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
  /** Day abbreviation → JS day number (0=Sun...6=Sat) */
  static DAY_ABBRS = {
    sun: 0,
    mon: 1,
    tue: 2,
    wed: 3,
    thu: 4,
    fri: 5,
    sat: 6
  };
  /** Check if today matches the schedule's days setting */
  matchesDays(days, dow, isWeekend) {
    if (days === "daily") return true;
    if (days === "weekday") return !isWeekend;
    if (days === "weekend") return isWeekend;
    const dayList = days.split(",").map((d) => d.trim().toLowerCase());
    return dayList.some((d) => Scheduler.DAY_ABBRS[d] === dow);
  }
  // ── Fire timed schedule ─────────────────────────────────────────────
  async fireTimed(schedule, type) {
    const execMode = schedule.exec ?? "prompt";
    if (execMode === "script" || execMode === "script+prompt") {
      if (!schedule.script) {
        process.stderr.write(`mixdog scheduler: no script specified for "${schedule.name}"
`);
        return false;
      }
      if (this.running.has(schedule.name)) return false;
      this.running.add(schedule.name);
      const channelId2 = this.resolveChannel(schedule.channel);
      logSchedule(`firing ${schedule.name} (${type}, exec=${execMode})
`);
      try {
        const scriptResult = await this.runScript(schedule.script);
        if (execMode === "script") {
          this.running.delete(schedule.name);
          if (scriptResult && this.sendFn) {
            await this.sendFn(channelId2, scriptResult).catch(
              (err) => process.stderr.write(`mixdog scheduler: ${schedule.name} relay failed: ${err}
`)
            );
          }
          process.stderr.write(`mixdog scheduler: ${schedule.name} script done
`);
          return true;
        }
        const prompt2 = this.loadPrompt(schedule.prompt ?? `${schedule.name}.md`);
        if (!prompt2) {
          this.running.delete(schedule.name);
          process.stderr.write(`mixdog scheduler: prompt not found for "${schedule.name}"
`);
          return false;
        }
        const combinedPrompt = `${prompt2}

---
## Script Output
\`\`\`
${scriptResult}
\`\`\``;
        this.running.delete(schedule.name);
        return await this.fireTimedPrompt(schedule, type, combinedPrompt, channelId2);
      } catch (err) {
        this.running.delete(schedule.name);
        process.stderr.write(`mixdog scheduler: ${schedule.name} script error: ${err}
`);
        return false;
      }
    }
    const prompt = this.resolvePrompt(schedule);
    if (!prompt) {
      process.stderr.write(`mixdog scheduler: prompt not found for "${schedule.name}"
`);
      return false;
    }
    const channelId = this.resolveChannel(schedule.channel);
    return await this.fireTimedPrompt(schedule, type, prompt, channelId);
  }
  /** Fire a timed schedule with the given prompt content */
  async fireTimedPrompt(schedule, type, prompt, channelId) {
    logSchedule(`firing ${schedule.name} (${type})
`);
    if (type === "interactive") {
      if (this.injectFn) {
        this.injectFn(channelId, schedule.name, " ", {
          instruction: prompt,
          type: "schedule"
        });
        return true;
      }
      return false;
    }
    if (this.running.has(schedule.name)) return false;
    this.running.add(schedule.name);
    const presetId = schedule.model;
    if (!presetId) {
      this.running.delete(schedule.name);
      logSchedule(`${schedule.name}: missing required "model" in schedule config — dispatch rejected\n`);
      return false;
    }
    schedulerLlm({ prompt, preset: presetId, sourceName: schedule.name })
      .then((result) => {
        this.running.delete(schedule.name);
        if (result && this.sendFn) {
          this.sendFn(channelId, result).catch(
            (err) => process.stderr.write(`mixdog scheduler: ${schedule.name} relay failed: ${err}\n`)
          );
        }
        logSchedule(`${schedule.name} done\n`);
      })
      .catch((err) => {
        this.running.delete(schedule.name);
        logSchedule(`${schedule.name} LLM error: ${err.message}\n`);
      });
    return true;
  }
  // ── Script execution (delegates to shared executor) ────────────────
  runScript(scriptName) {
    return new Promise((resolve, reject) => {
      execScript(`schedule:${scriptName}`, scriptName, (result, code) => {
        if (code !== 0 && code !== null) {
          reject(new Error(`script exited with code ${code}`));
        } else {
          resolve(result);
        }
      });
    });
  }
  // ── Helpers ─────────────────────────────────────────────────────────
  /**
   * Map a schedule's `channel` flag to a target channel id. The flag is
   * boolean-ish: any non-empty value except "false" (including legacy labels
   * like "main") means "post to the main channel"; absent/false → "" (inject
   * into the Lead session). No label resolution. A pure-digit / snowflake
   * value is honored verbatim as an explicit id override (matches
   * resolveWebhookChannelId in index.mjs).
   */
  resolveChannel(flag) {
    if (flag == null) return "";
    const v = String(flag).trim();
    if (v === "" || v.toLowerCase() === "false") return "";
    if (/^-?\d+$/.test(v)) return v;
    return this.channelId ?? "";
  }
  /** Resolve prompt: try file first, fall back to inline text */
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
}
export {
  Scheduler
};
