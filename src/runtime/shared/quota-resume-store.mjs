/**
 * quota-resume-store.mjs — the daemon's durable queue of Lead turns waiting
 * for their provider quota to reset, plus the global auto-resume setting.
 *
 * One process (the daemon) owns the file; every session runtime it hosts and
 * its resume scheduler read and mutate this same in-memory copy, and every
 * mutation is written through synchronously so a restart finds the queue
 * exactly as the last mutation left it. Mutations are synchronous on purpose:
 * a cancel and a fire can never interleave inside one, and each entry carries
 * a generation so a stale holder can neither fire nor defer a replaced entry.
 *
 * Entry: { sessionId, turnKey, provider, model, resetAt, attempts, generation,
 *          routeProvider, routeModel }
 *   resetAt  — when the scheduler next takes a usage reading (the provider's
 *              reset time, or the later re-check after a still-exhausted one).
 * Suspension: { sessionId, turnKey, goalId } — the Goal one quota failure
 *   moved from active to usage_limited, the only Goal a resume may revive.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolvePluginData } from './plugin-paths.mjs';
import { writeJsonAtomicSync } from './atomic-file.mjs';
import { readSection, updateSection } from './config.mjs';

export const QUOTA_RESUME_FILE = 'quota-resume.json';
const FILE_VERSION = 1;
const SETTING_SECTION = 'quotaResume';

let state = null;
const listeners = new Set();
// Frozen public snapshots keyed by the immutable entry object they describe,
// so an unchanged entry publishes the same value identity on every read.
const publicSnapshots = new WeakMap();

const text = (value) => (typeof value === 'string' ? value.trim() : '');
const finite = (value) => typeof value === 'number' && Number.isFinite(value);

function normalizeEntry(value) {
  const entry = {
    sessionId: text(value?.sessionId),
    turnKey: text(value?.turnKey),
    provider: text(value?.provider),
    model: typeof value?.model === 'string' ? value.model : '',
    resetAt: value?.resetAt,
    attempts: Number.isSafeInteger(value?.attempts) && value.attempts >= 0 ? value.attempts : 0,
    generation: value?.generation,
    // The session's own route when the resume was queued; a fire on any
    // other route is not the resume of this failure.
    routeProvider: typeof value?.routeProvider === 'string' ? value.routeProvider : '',
    routeModel: typeof value?.routeModel === 'string' ? value.routeModel : '',
  };
  if (!entry.sessionId || !entry.turnKey || !entry.provider || !finite(entry.resetAt)) return null;
  if (!Number.isSafeInteger(entry.generation) || entry.generation < 1) return null;
  return Object.freeze(entry);
}

function normalizeSuspension(value) {
  const suspension = {
    sessionId: text(value?.sessionId),
    turnKey: text(value?.turnKey),
    goalId: text(value?.goalId),
  };
  return suspension.sessionId && suspension.turnKey && suspension.goalId ? Object.freeze(suspension) : null;
}

function storePath() {
  return join(resolvePluginData(), QUOTA_RESUME_FILE);
}

function load() {
  const path = storePath();
  if (state?.path === path) return state;
  let raw = null;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    // A missing or torn file is an empty queue; an unreadable one is not.
    if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }
  const entries = new Map();
  for (const value of Array.isArray(raw?.entries) ? raw.entries : []) {
    const entry = normalizeEntry(value);
    if (entry) entries.set(entry.sessionId, entry);
  }
  const suspensions = new Map();
  for (const value of Array.isArray(raw?.suspensions) ? raw.suspensions : []) {
    const suspension = normalizeSuspension(value);
    if (suspension) suspensions.set(suspension.sessionId, suspension);
  }
  const generations = [Number.isSafeInteger(raw?.generation) ? raw.generation : 0];
  for (const entry of entries.values()) generations.push(entry.generation);
  state = { path, generation: Math.max(...generations), entries, suspensions };
  return state;
}

function persist(current) {
  writeJsonAtomicSync(
    current.path,
    {
      version: FILE_VERSION,
      generation: current.generation,
      entries: [...current.entries.values()],
      suspensions: [...current.suspensions.values()],
    },
    { fsyncDir: true }
  );
}

function notify(sessionId) {
  for (const listener of [...listeners]) {
    try {
      listener(sessionId);
    } catch {
      // The mutation is already persisted; one failing listener must neither
      // undo it nor keep the others from hearing about it.
    }
  }
}

/** Listener receives the changed sessionId, or null when every entry changed. */
export function subscribeQuotaResume(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function quotaResumeEntry(sessionId) {
  return load().entries.get(text(sessionId)) || null;
}

export function listQuotaResumeEntries() {
  return [...load().entries.values()];
}

/** The session snapshot's `quotaResume` value for an entry (or null). */
export function publicQuotaResume(entry) {
  if (!entry) return null;
  let snapshot = publicSnapshots.get(entry);
  if (!snapshot) {
    snapshot = Object.freeze({
      state: 'waiting',
      turnKey: entry.turnKey,
      provider: entry.provider,
      model: entry.model,
      resetAt: entry.resetAt,
      attempts: entry.attempts,
    });
    publicSnapshots.set(entry, snapshot);
  }
  return snapshot;
}

/** Queue (or replace) the session's resume under a fresh generation. */
export function scheduleQuotaResumeEntry({
  sessionId,
  turnKey,
  provider,
  model = '',
  resetAt,
  routeProvider = '',
  routeModel = '',
} = {}) {
  const current = load();
  const entry = normalizeEntry({
    sessionId,
    turnKey,
    provider,
    model,
    resetAt,
    routeProvider,
    routeModel,
    attempts: 0,
    generation: current.generation + 1,
  });
  if (!entry) throw new TypeError('quota resume needs a session, turn, provider and reset time');
  current.generation = entry.generation;
  current.entries.set(entry.sessionId, entry);
  persist(current);
  notify(entry.sessionId);
  return entry;
}

/** Remove the session's entry; with `generation`, only that exact entry. */
export function cancelQuotaResumeEntry(sessionId, { generation = null } = {}) {
  const current = load();
  const entry = current.entries.get(text(sessionId));
  if (!entry || (generation !== null && entry.generation !== generation)) return false;
  current.entries.delete(entry.sessionId);
  persist(current);
  notify(entry.sessionId);
  return true;
}

/** Move the exact entry to a later reading, keeping its generation. */
export function deferQuotaResumeEntry(sessionId, generation, { resetAt, attempts }) {
  const current = load();
  const entry = current.entries.get(text(sessionId));
  if (!entry || entry.generation !== generation) return null;
  const next = normalizeEntry({ ...entry, resetAt, attempts });
  if (!next) throw new TypeError('quota resume deferral needs a reset time');
  current.entries.set(next.sessionId, next);
  persist(current);
  notify(next.sessionId);
  return next;
}

export function cancelAllQuotaResumeEntries() {
  const current = load();
  const count = current.entries.size;
  if (count === 0) return 0;
  current.entries.clear();
  persist(current);
  notify(null);
  return count;
}

/** Record the Goal this quota failure suspended (replaces any earlier note). */
export function noteQuotaSuspendedGoal(sessionId, turnKey, goalId) {
  const suspension = normalizeSuspension({ sessionId, turnKey, goalId });
  if (!suspension) return false;
  const current = load();
  current.suspensions.set(suspension.sessionId, suspension);
  persist(current);
  return true;
}

/** The Goal the failure `turnKey` suspended, or '' when it suspended none. */
export function quotaSuspendedGoal(sessionId, turnKey) {
  const suspension = load().suspensions.get(text(sessionId));
  return suspension && suspension.turnKey === text(turnKey) ? suspension.goalId : '';
}

export function forgetQuotaSuspendedGoal(sessionId) {
  const current = load();
  if (!current.suspensions.delete(text(sessionId))) return false;
  persist(current);
  return true;
}

/** Global setting, default on. */
export function quotaAutoResumeEnabled() {
  return readSection(SETTING_SECTION)?.autoResume !== false;
}

/** Persist the setting; turning it off cancels every pending resume. */
export function setQuotaAutoResumeEnabled(enabled) {
  const next = enabled !== false;
  updateSection(SETTING_SECTION, (section) => ({ ...(section || {}), autoResume: next }));
  if (!next) cancelAllQuotaResumeEntries();
  return next;
}

/** Drop the in-memory copy so the next read loads from disk (a daemon restart). */
export function reloadQuotaResumeStore() {
  state = null;
}
