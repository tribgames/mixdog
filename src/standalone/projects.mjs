/**
 * standalone/projects.mjs — user-registered project (cwd) store.
 *
 * Projects are working directories the user explicitly registers (Codex-style).
 * There is NO git scanning and NO recent-history auto-import; only entries the
 * user creates appear here. Persisted as JSON at <MIXDOG_HOME>/projects.json.
 *
 * Data shape: { projects: [{ name, path, addedAt, lastSelectedAt? }] }
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
          ...(Number(entry.lastSelectedAt) > 0
            ? { lastSelectedAt: Number(entry.lastSelectedAt) }
            : {}),
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

/**
 * Idempotently ensure `<absPath>/.mixdog/project.id` exists so the project
 * selection store and memory project_id classification (resolveProjectId)
 * agree. Rules:
 *   - Never overwrite an existing marker (user may have set 'common' or a
 *     custom id — respect it).
 *   - Only act when absPath is a real directory on disk; never create the
 *     project folder itself (addProject does NOT create the directory).
 *   - Marker value = provided name, else basename(absPath). Skip when the
 *     value is empty or 'common' (resolveProjectId would force COMMON).
 *   - Best-effort: any failure is swallowed so registration/selection never
 *     breaks.
 */
function ensureProjectIdMarker(absPath, name) {
  try {
    if (!absPath) return;
    // Only when the project folder actually exists as a directory on disk.
    try {
      if (!statSync(absPath).isDirectory()) return;
    } catch {
      return; // missing / unstattable → silently skip
    }
    const markerPath = join(absPath, '.mixdog', 'project.id');
    if (existsSync(markerPath)) return; // preserve existing value
    const value = String(name || basename(absPath) || '').trim();
    if (!value || value.toLowerCase() === 'common') return;
    const markerDir = join(absPath, '.mixdog');
    mkdirSync(markerDir, { recursive: true });
    const tmp = `${markerPath}.${process.pid}.tmp`;
    writeFileSync(tmp, `${value}\n`, 'utf8');
    renameSync(tmp, markerPath);
  } catch {
    /* best-effort marker; never throw */
  }
}

function projectRecency(entry) {
  const last = Number(entry?.lastSelectedAt);
  if (Number.isFinite(last) && last > 0) return last;
  return Number(entry?.addedAt) || 0;
}

function compareProjects(a, b) {
  const byRecency = projectRecency(b) - projectRecency(a);
  if (byRecency !== 0) return byRecency;
  const byName = String(a.name).localeCompare(String(b.name));
  if (byName !== 0) return byName;
  return String(a.path).localeCompare(String(b.path));
}

/** List registered projects (most recently selected first; addedAt fallback). */
export function listProjects() {
  const { projects } = readStore();
  return projects.slice().sort(compareProjects);
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
  if (existing) {
    ensureProjectIdMarker(absPath, existing.name);
    return existing;
  }
  const entry = {
    name: basename(absPath) || absPath,
    path: absPath,
    addedAt: Date.now(),
  };
  store.projects.push(entry);
  writeStore(store);
  ensureProjectIdMarker(absPath, entry.name);
  return entry;
}

/**
 * Mark an existing registered project as selected (updates lastSelectedAt).
 * Does not register missing paths; use addProject for that. Returns the updated
 * entry, or null when no matching project exists.
 */
export function touchProjectSelected(rawPath) {
  const absPath = toAbsolute(rawPath);
  if (!absPath) return null;
  const store = readStore();
  const key = normalizeKey(absPath);
  const entry = store.projects.find((item) => normalizeKey(item.path) === key);
  if (!entry) return null;
  entry.lastSelectedAt = Date.now();
  writeStore(store);
  ensureProjectIdMarker(absPath, entry.name);
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
