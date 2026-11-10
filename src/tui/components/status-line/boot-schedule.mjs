/*
 * components/status-line/boot-schedule.mjs — lazy statusline module loading, boot
 * full-render timing/backoff and active-work detection for StatusLine.
 */
import { loadStatuslineModule, resetStatuslineModuleLoad } from '../statusline-module-loader.mjs';

export { loadStatuslineModule, resetStatuslineModuleLoad };

export const STATUSLINE_RENDER_DEBOUNCE_MS = 150;
/** Background import of statusline.mjs before the +1000ms full-render tick. */
const STATUSLINE_MODULE_PREWARM_DELAY_MS = 300;

let statuslineModulePrewarmScheduled = false;

export function scheduleStatuslineModulePrewarm() {
  if (statuslineModulePrewarmScheduled) return;
  statuslineModulePrewarmScheduled = true;
  const timer = setTimeout(() => {
    loadStatuslineModule().catch(() => {});
  }, STATUSLINE_MODULE_PREWARM_DELAY_MS);
  timer.unref?.();
}

const STATUSLINE_BOOT_FULL_DELAY_MS = 1000;
const STATUSLINE_BOOT_FULL_DELAY_ACTIVE_MS = 2200;
export const STATUSLINE_BOOT_FULL_RETRY_MS = 2000;
const STATUSLINE_BOOT_FULL_RETRY_MAX_MS = 30000;
export const STATUSLINE_REFRESH_MS = 2000;
export const STATUSLINE_ACTIVE_REFRESH_MS = 500;

export function isTerminalStatus(statusText) {
  return /idle|done|complete|success|closed|error|fail|cancel|killed|timeout/.test(
    String(statusText || '').toLowerCase()
  );
}

function hasRunningStatuslineWorkers(agentWorkers = [], agentJobs = []) {
  for (const worker of Array.isArray(agentWorkers) ? agentWorkers : []) {
    const tag = String(worker?.tag || worker?.agent || worker?.name || '').trim();
    if (tag && !isTerminalStatus(worker?.stage || worker?.status)) return true;
  }
  for (const job of Array.isArray(agentJobs) ? agentJobs : []) {
    if (/running/i.test(String(job?.status || job?.stage || ''))) return true;
  }
  return false;
}

function stripAnsi(text) {
  return String(text || '').replace(/\x1b\[[0-9;]*m/g, '');
}

function hasActiveStatuslineTools(activeTools = null) {
  if (!activeTools || typeof activeTools !== 'object') return false;
  return Number(activeTools.web_search?.count) > 0;
}

export function hasActiveStatuslineWork(line, agentWorkers = [], agentJobs = [], activeTools = null) {
  if (hasRunningStatuslineWorkers(agentWorkers, agentJobs) || hasActiveStatuslineTools(activeTools)) return true;
  const plain = stripAnsi(line);
  return /\bRunning \d+ (?:Agents?|Shells?)\b/.test(plain) || /\b(?:Exploring|Searching|Memory)\b/.test(plain);
}

// Milliseconds left before the boot full render may run (<= 0 once eligible);
// the delay is longer while agents/shells/tools are active.
export function bootFullRenderDelayRemainingMs(mountAtMs, line, agentWorkers = [], agentJobs = [], activeTools = null) {
  const active = hasActiveStatuslineWork(line, agentWorkers, agentJobs, activeTools);
  const delay = active ? STATUSLINE_BOOT_FULL_DELAY_ACTIVE_MS : STATUSLINE_BOOT_FULL_DELAY_MS;
  return delay - (Date.now() - mountAtMs);
}

export function canAttemptBootFullRender(nextAttemptAtMs = 0) {
  return Date.now() >= nextAttemptAtMs;
}

export function scheduleBootFullRetry(backoffMsRef, nextAttemptAtRef) {
  resetStatuslineModuleLoad();
  const nextBackoff = Math.min(
    STATUSLINE_BOOT_FULL_RETRY_MAX_MS,
    Math.max(STATUSLINE_BOOT_FULL_RETRY_MS, backoffMsRef.current * 2)
  );
  backoffMsRef.current = nextBackoff;
  nextAttemptAtRef.current = Date.now() + nextBackoff;
}
