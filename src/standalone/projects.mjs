/**
 * standalone/projects.mjs — user-registered project (cwd) store.
 *
 * Projects are working directories the user explicitly registers (Codex-style).
 * There is NO git scanning and NO recent-history auto-import; only entries the
 * user creates appear here. Persisted as JSON at <MIXDOG_HOME>/projects.json.
 *
 * Data shape: { projects: [{ name, path, addedAt }] }
 */
import { homedir } from 'node:os';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

const MIXDOG_HOME = process.env.MIXDOG_HOME || join(homedir(), '.mixdog');
const PROJECTS_FILE = join(MIXDOG_HOME, 'projects.json');

/** Resolve a raw path to an absolute path against the user's cwd. */
function toAbsolute(rawPath) {
  const text = String(rawPath || '').trim();
  if (!text) return '';
  return isAbsolute(text) ? resolve(text) : resolve(process.cwd(), text);
}

/** Normalize a path for dedupe comparison (case-insensitive on Windows). */
function normalizeKey(absPath) {
  const text = String(absPath || '');
  return process.platform === 'win32' ? text.replace(/[\\/]+$/, '').toLowerCase() : text.replace(/\/+$/, '');
}

function readStore() {
  try {
    if (!existsSync(PROJECTS_FILE)) return { projects: [] };
    const raw = readFileSync(PROJECTS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    const projects = Array.isArray(parsed?.projects) ? parsed.projects : [];
    return {
      projects: projects
        .filter((entry) => entry && typeof entry.path === 'string' && entry.path.trim())
        .map((entry) => ({
          name: String(entry.name || basename(entry.path) || entry.path),
          path: String(entry.path),
          addedAt: Number(entry.addedAt) || 0,
        })),
    };
  } catch {
    return { projects: [] };
  }
}

function writeStore(store) {
  try {
    mkdirSync(dirname(PROJECTS_FILE), { recursive: true });
    const tmp = `${PROJECTS_FILE}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
    renameSync(tmp, PROJECTS_FILE);
  } catch {
    /* best-effort persistence */
  }
}

/** List registered projects (most recently added first). */
export function listProjects() {
  const { projects } = readStore();
  return projects.slice().sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
}

/**
 * Register a project by path. Derives the display name from the last path
 * segment, dedupes by normalized absolute path, and persists. Does NOT create
 * the directory on disk.
 */
export function addProject(rawPath) {
  const absPath = toAbsolute(rawPath);
  if (!absPath) return null;
  const store = readStore();
  const key = normalizeKey(absPath);
  const existing = store.projects.find((entry) => normalizeKey(entry.path) === key);
  if (existing) return existing;
  const entry = {
    name: basename(absPath) || absPath,
    path: absPath,
    addedAt: Date.now(),
  };
  store.projects.push(entry);
  writeStore(store);
  return entry;
}

/** Remove a registered project by path. Does NOT touch the directory on disk. */
export function removeProject(rawPath) {
  const absPath = toAbsolute(rawPath);
  if (!absPath) return false;
  const store = readStore();
  const key = normalizeKey(absPath);
  const next = store.projects.filter((entry) => normalizeKey(entry.path) !== key);
  if (next.length === store.projects.length) return false;
  writeStore({ projects: next });
  return true;
}

/**
 * Rename a registered project (display name only; the path is unchanged).
 * A blank name resets the name back to the path's folder basename. Returns the
 * updated entry, or null when no matching project exists.
 */
export function renameProject(rawPath, nextName) {
  const absPath = toAbsolute(rawPath);
  if (!absPath) return null;
  const store = readStore();
  const key = normalizeKey(absPath);
  const entry = store.projects.find((item) => normalizeKey(item.path) === key);
  if (!entry) return null;
  const trimmed = String(nextName || '').trim();
  entry.name = trimmed || basename(absPath) || absPath;
  writeStore(store);
  return entry;
}

/** Whether a path currently exists on disk. */
export function pathExists(rawPath) {
  const absPath = toAbsolute(rawPath);
  return !!absPath && existsSync(absPath);
}

/** Whether a path exists AND is a directory (tolerant of stat errors). */
export function isDirectory(rawPath) {
  const absPath = toAbsolute(rawPath);
  if (!absPath) return false;
  try {
    return statSync(absPath).isDirectory();
  } catch {
    return false;
  }
}

/** Create a directory (recursive). Returns the absolute path, or '' on failure. */
export function ensureDir(rawPath) {
  const absPath = toAbsolute(rawPath);
  if (!absPath) return '';
  try {
    mkdirSync(absPath, { recursive: true });
    return absPath;
  } catch {
    return '';
  }
}

/** Resolve a raw path to absolute (exported for callers that need it). */
export function resolveProjectPath(rawPath) {
  return toAbsolute(rawPath);
}
