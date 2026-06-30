/**
 * Persistent TUI prompt input history, scoped by project working directory.
 * Stored under MIXDOG data dir (not the repo working tree).
 */
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { resolvePluginData } from '../runtime/shared/plugin-paths.mjs';

export const PROMPT_HISTORY_LIMIT = 50;

export function promptHistoryKey(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

/** Stable map key for cwd-scoped prompt history buckets. */
export function promptHistoryCwdKey(rawPath) {
  const text = String(rawPath || '').trim();
  if (!text) return '';
  const abs = resolve(text);
  return process.platform === 'win32'
    ? abs.replace(/[\\/]+$/, '').toLowerCase()
    : abs.replace(/\/+$/, '');
}

function historyFilePath(cwd) {
  const key = promptHistoryCwdKey(cwd);
  if (!key) return '';
  const digest = createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 32);
  return join(resolvePluginData(), 'tui-prompt-history', `${digest}.json`);
}

function readEntries(filePath) {
  if (!filePath || !existsSync(filePath)) return [];
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
    return entries
      .map((entry) => String(entry || '').trim())
      .filter((entry) => promptHistoryKey(entry));
  } catch {
    return [];
  }
}

function writeEntries(filePath, entries) {
  if (!filePath) return false;
  try {
    // Prompt text may be sensitive; restrict directory/file to the owning user.
    mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
    const payload = { version: 1, entries };
    const tmp = `${filePath}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, filePath);
    try {
      chmodSync(filePath, 0o600);
    } catch {
      /* best-effort; Windows may ignore mode bits */
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * In-memory session list (newest first). Dedupes by promptHistoryKey.
 */
export function pushSessionPromptHistory(sessionTexts, value, limit = PROMPT_HISTORY_LIMIT) {
  const text = String(value || '').trim();
  const key = promptHistoryKey(text);
  if (!key) return Array.isArray(sessionTexts) ? sessionTexts : [];
  const base = Array.isArray(sessionTexts) ? sessionTexts : [];
  const next = base.filter((entry) => promptHistoryKey(entry) !== key);
  next.unshift(text);
  return next.length > limit ? next.slice(0, limit) : next;
}

/**
 * Merge session-derived prompts (newest first) with persisted prompts from
 * older sessions. Dedupes by promptHistoryKey; session wins ordering.
 */
export function buildMergedPromptHistory(sessionTexts, persistedTexts, limit = PROMPT_HISTORY_LIMIT) {
  const seen = new Set();
  const history = [];

  const push = (raw) => {
    if (history.length >= limit) return;
    const text = String(raw || '').trim();
    const key = promptHistoryKey(text);
    if (!key || seen.has(key)) return;
    seen.add(key);
    history.push(text);
  };

  for (const text of sessionTexts) push(text);

  const persisted = Array.isArray(persistedTexts) ? persistedTexts : [];
  for (let i = persisted.length - 1; i >= 0; i -= 1) {
    push(persisted[i]);
  }

  return history;
}

export function loadPromptHistory(cwd) {
  const filePath = historyFilePath(cwd);
  const entries = readEntries(filePath);
  if (entries.length <= PROMPT_HISTORY_LIMIT) return entries;
  return entries.slice(-PROMPT_HISTORY_LIMIT);
}

/**
 * Append a submitted prompt for cwd. Skips empty keys; removes prior duplicate
 * keys (promptHistoryKey); caps at PROMPT_HISTORY_LIMIT.
 * Returns the saved entry list (oldest → newest) on success, or null on failure.
 */
export function appendPromptHistory(cwd, value) {
  const key = promptHistoryKey(value);
  if (!key) return null;
  const filePath = historyFilePath(cwd);
  const entries = readEntries(filePath).filter((entry) => promptHistoryKey(entry) !== key);
  entries.push(String(value).trim());
  const trimmed = entries.length > PROMPT_HISTORY_LIMIT
    ? entries.slice(-PROMPT_HISTORY_LIMIT)
    : entries;
  return writeEntries(filePath, trimmed) ? trimmed : null;
}

