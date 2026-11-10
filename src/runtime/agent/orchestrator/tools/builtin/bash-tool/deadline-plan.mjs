// Commands start in the foreground and hold the call for the shell hold
// (wait-budgets.mjs). Only work still running when the hold ends — or when new
// user input ends it early — moves to a tracked background task, returning
// partial output plus task_id and finishing by notification. A per-call
// wait_ms picks a different hold, clamped to the published range.
import { SHELL_HOLD_DEFAULT_MS, SHELL_HOLD_MAX_MS, SHELL_HOLD_MIN_MS } from '../wait-budgets.mjs';

export const DEFAULT_SHELL_AUTO_BACKGROUND_MS = SHELL_HOLD_DEFAULT_MS;
// The hold of an explicit background start: long enough for the child to be
// spawned and promoted, short enough to return at once.
const BACKGROUND_START_HOLD_MS = 1;

// JS timers (setTimeout) and PS WaitForExit(ms) are 32-bit: a delay above
// 2^31-1 wraps to a tiny/negative value and fires immediately. Clamp the
// uncapped explicit timeout once (~24.8 days ceiling) so every downstream
// timer — foreground, background job, hard-stop watcher — stays valid without
// per-site guards.
const TIMER_MAX_MS = 2_147_483_647;

// The shell hold. A timeout is the command's total deadline, not permission to
// hold the conversation open for that whole duration: when the hold ends a
// still-running command becomes a tracked background task and completion is
// pushed to the owner. MIXDOG_SHELL_AUTO_BACKGROUND_MS overrides the default;
// an explicit 0 disables it. A per-call wait_ms replaces the hold for that
// call, clamped to SHELL_HOLD_MIN_MS..SHELL_HOLD_MAX_MS. Gated on
// backgroundOnTimeout so disabled background tasks remain foreground.
function shellHoldMs(waitMs) {
  if (waitMs > 0) return Math.min(SHELL_HOLD_MAX_MS, Math.max(SHELL_HOLD_MIN_MS, Math.floor(waitMs)));
  const raw = process.env.MIXDOG_SHELL_AUTO_BACKGROUND_MS;
  const parsed = Number(raw);
  return raw != null && String(raw).trim() !== '' && Number.isFinite(parsed) && parsed >= 0
    ? Math.floor(parsed)
    : SHELL_HOLD_DEFAULT_MS;
}

function autoBackgroundBudget(backgroundOnTimeout, timeout, holdMs) {
  if (!backgroundOnTimeout || holdMs <= 0) return 0;
  return timeout > 0 ? Math.min(holdMs, timeout) : holdMs;
}

// Background safety net. An omitted timeout_ms means "no caller deadline",
// which is right for a build or an intentional server, but it also lets a
// forgotten task outlive whatever spawned it: shell-job RECORDS age out, a
// live job never does. MIXDOG_SHELL_BACKGROUND_MAX_MS bounds only that omitted
// case; an explicit caller timeout is never shortened.
function backgroundMaxBudget() {
  const envMs = Number(process.env.MIXDOG_SHELL_BACKGROUND_MAX_MS);
  return Number.isFinite(envMs) && envMs > 0 ? Math.min(Math.floor(envMs), TIMER_MAX_MS) : 0;
}

// timeout_ms is a caller-requested HARD total deadline, not a foreground wait
// budget. Omitted/0 means no deadline: the command starts foreground, then the
// coordination budget promotes it without shortening its lifetime. When
// promotion is available, only the foreground blocking portion is capped (120 s
// by default, BASH_MAX_TIMEOUT_MS overrides) and the REMAINDER of an explicit
// timeout becomes the background deadline.
export function planShellDeadlines({ args, wmicRewrite, backgroundOnTimeout }) {
  const envMaxTimeout = parseInt(process.env.BASH_MAX_TIMEOUT_MS ?? '', 10);
  // background:true (servers, watchers) skips the hold: the command moves to
  // the background as soon as it is running.
  const holdMs =
    args.background === true
      ? BACKGROUND_START_HOLD_MS
      : shellHoldMs(typeof args.wait_ms === 'number' ? args.wait_ms : 0);
  // The foreground cap never cuts the requested hold short.
  const maxForegroundMs = Math.max(envMaxTimeout > 0 ? envMaxTimeout : 120_000, holdMs);
  const hasExplicitTimeout = typeof args.timeout_ms === 'number' && args.timeout_ms > 0;
  const timeoutMs = hasExplicitTimeout ? args.timeout_ms : 0;
  // A rewrite-supplied cap (wmic → Get-CimInstance, 30 s) is a HARD deadline
  // exactly like an explicit caller timeout.
  const wmicCapMs = Math.max(0, Math.floor(Number(wmicRewrite?.timeoutMs) || 0));
  const hasHardDeadline = hasExplicitTimeout || wmicCapMs > 0;
  // timeoutMs <= 0 (omitted background default) means unlimited: pass it
  // through untouched — the min() clamps must not turn 0 into a bound.
  const defaultCapMs = hasExplicitTimeout ? TIMER_MAX_MS : maxForegroundMs;
  const totalTimeout = timeoutMs <= 0 ? wmicCapMs : Math.min(timeoutMs, wmicCapMs || defaultCapMs);
  const capForeground = hasHardDeadline && backgroundOnTimeout;
  const timeout = capForeground ? Math.min(totalTimeout, maxForegroundMs) : totalTimeout;
  const promotedTimeoutMs = capForeground ? Math.max(0, totalTimeout - timeout) : 0;
  return {
    timeout,
    promotedTimeoutMs,
    // A caller deadline at or below the foreground window has no remaining
    // budget to transfer: execShellCommand enforces that timeout instead of
    // promoting the child with timeoutMs=0 (unlimited to shell-jobs).
    promoteAtTimeout: backgroundOnTimeout && (!hasHardDeadline || promotedTimeoutMs > 0),
    // Soft/interrupt promotion happens before the foreground cap; an explicit
    // total deadline is preserved separately.
    backgroundDeadlineMs: hasHardDeadline ? totalTimeout : backgroundMaxBudget(),
    autoBackgroundMs: autoBackgroundBudget(backgroundOnTimeout, timeout, holdMs),
  };
}
