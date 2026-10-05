// Commands start in the foreground. Only work still running after the
// 15 s coordination budget is promoted to a tracked background task.
// Short commands therefore complete in the original tool turn, while longer
// work returns partial output plus task_id and finishes by notification.
// 15 s because a command promoted moments before it ends costs a whole
// follow-up request on `task wait`. Session logs (2026-09-30..10-05), the 260
// promoted commands with a recorded duration: 108 had ended within 10 s, 144
// within 15 s and only 152 within 20 s.
export const DEFAULT_SHELL_AUTO_BACKGROUND_MS = 15_000;

// JS timers (setTimeout) and PS WaitForExit(ms) are 32-bit: a delay above
// 2^31-1 wraps to a tiny/negative value and fires immediately. Clamp the
// uncapped explicit timeout once (~24.8 days ceiling) so every downstream
// timer — foreground, background job, hard-stop watcher — stays valid without
// per-site guards.
const TIMER_MAX_MS = 2_147_483_647;

// Main-agent blocking budget. A timeout is the command's total deadline, not
// permission to hold the conversation open for that whole duration: after
// 15 s a still-running command becomes a tracked background task and
// completion is pushed to the owner. MIXDOG_SHELL_AUTO_BACKGROUND_MS
// overrides; an explicit 0 disables. Gated on backgroundOnTimeout so
// disabled background tasks remain foreground.
// A per-call wait_ms extends that default for the call, capped by the
// foreground maximum; it never shortens it. A shorter window promotes a
// command that would have returned its result in the starting call and spends
// a whole follow-up request on `task wait`. Session logs (2026-09-30..10-05,
// 3062 shell calls): 329 passed a wait_ms under the default (53% of one model
// family's calls), 256 of those were promoted, and 108 of the 192 with a
// recorded duration had finished inside the default window (10 s then).
function autoBackgroundBudget(backgroundOnTimeout, timeout, waitMs, maxForegroundMs) {
  const raw = process.env.MIXDOG_SHELL_AUTO_BACKGROUND_MS;
  const parsed = Number(raw);
  let defaultMs =
    raw != null && String(raw).trim() !== '' && Number.isFinite(parsed) && parsed >= 0
      ? Math.floor(parsed)
      : DEFAULT_SHELL_AUTO_BACKGROUND_MS;
  if (waitMs > 0) defaultMs = Math.max(defaultMs, Math.min(waitMs, maxForegroundMs));
  if (!backgroundOnTimeout || defaultMs <= 0) return 0;
  return timeout > 0 ? Math.min(defaultMs, timeout) : defaultMs;
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
  const maxForegroundMs = envMaxTimeout > 0 ? envMaxTimeout : 120_000;
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
    autoBackgroundMs: autoBackgroundBudget(
      backgroundOnTimeout,
      timeout,
      typeof args.wait_ms === 'number' ? args.wait_ms : 0,
      maxForegroundMs
    ),
  };
}
