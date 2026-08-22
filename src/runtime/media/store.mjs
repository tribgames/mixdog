/**
 * On-disk store for generated media.
 *
 * Assets live as real files under <data>/media/assets so nothing large is kept
 * in memory or in a session transcript; index.json holds the metadata list
 * (newest first) and is written atomically under a file lock because the
 * desktop and CLI can generate concurrently.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, statSync } from 'fs';
import { dirname, join, resolve, sep } from 'path';
import { randomUUID } from 'crypto';
import { spawn } from 'child_process';
import { resolvePluginData } from '../shared/plugin-paths.mjs';
import { writeJsonAtomicSync, withFileLockSync } from '../shared/atomic-file.mjs';
import {
  cacheRendition,
  ensureRendition,
  removeRenditions,
  renditionSpec,
} from './renditions.mjs';

// Renderer transport is base64 over IPC: refuse to inline anything larger.
const MAX_INLINE_BYTES = 48 * 1024 * 1024;
const MAX_CACHED_THUMBNAIL_BYTES = 4 * 1024 * 1024;

const EXTENSIONS = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
};
let layoutMigrationChecked = false;
let indexCachePath = '';
let indexCacheSignature = '';
let indexCacheAssets = [];
let indexCacheById = new Map();
let indexDiskReads = 0;
let indexCacheHits = 0;

function mediaDir() {
  return join(resolvePluginData(), 'media');
}

function assetsDir() {
  return join(mediaDir(), 'assets');
}

// Derived tile/detail renditions live beside the assets: they are a rebuildable
// cache, so they never share the asset tree the user browses.
function renditionsDir() {
  return join(mediaDir(), 'renditions');
}

function indexPath() {
  return join(mediaDir(), 'index.json');
}

function indexLockPath() {
  return `${indexPath()}.lock`;
}

function ensureDirs({ migrate = false } = {}) {
  mkdirSync(assetsDir(), { recursive: true });
  if (migrate && !layoutMigrationChecked) {
    migrateAssetLayout();
    layoutMigrationChecked = true;
  }
}

function indexSignature(path) {
  try {
    const info = statSync(path);
    return `${info.mtimeMs}:${info.ctimeMs}:${info.size}`;
  } catch (error) {
    // Only an absent file is "missing". Reporting EACCES/EIO as missing let the
    // read path cache an empty catalog for a store that is actually unreadable.
    if (error?.code === 'ENOENT') return 'missing';
    throw error;
  }
}

function rememberIndex(path, signature, assets) {
  indexCachePath = path;
  indexCacheSignature = signature;
  indexCacheAssets = assets;
  indexCacheById = new Map(assets.map((entry) => [entry.id, entry]));
  return assets;
}

function readIndex() {
  const path = indexPath();
  const signature = indexSignature(path);
  if (path === indexCachePath && signature === indexCacheSignature) {
    indexCacheHits += 1;
    return indexCacheAssets;
  }
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    // A missing index file is a genuinely empty catalog (first run). Every
    // OTHER read failure is not: answering with an empty list made the next
    // save/delete write that emptiness back over every existing asset entry.
    if (error?.code === 'ENOENT') return rememberIndex(path, signature, []);
    throw error;
  }
  const parsed = JSON.parse(raw);
  if (!parsed || !Array.isArray(parsed.assets)) {
    throw new Error(`media index is malformed: ${path}`);
  }
  indexDiskReads += 1;
  return rememberIndex(path, signature, parsed.assets);
}

function writeIndex(assets) {
  const path = indexPath();
  writeJsonAtomicSync(path, { version: 2, assets });
  rememberIndex(path, indexSignature(path), assets);
}

/**
 * The one catalog read-modify-write. Every mutation (migrate, save, duration
 * backfill, delete) holds index.lock across a fresh readIndex() and writes back
 * only what the callback returns, so a concurrent CLI/desktop generation can
 * never lose an entry — and a read that FAILS (rather than being absent)
 * propagates out of the lock instead of writing an empty catalog over it.
 */
function mutateIndex(mutate) {
  withFileLockSync(indexLockPath(), () => {
    const next = mutate(readIndex());
    if (next) writeIndex(next);
  });
}

export function mediaStoreCacheStats() {
  return {
    indexDiskReads,
    indexCacheHits,
    indexEntries: indexCacheAssets.length,
  };
}

function extensionFor(mime) {
  return EXTENSIONS[String(mime || '').toLowerCase()] || 'bin';
}

function folderSegment(value, fallback) {
  const normalized = String(value || '')
    .normalize('NFKC')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
    .slice(0, 80);
  if (!normalized || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(normalized)) {
    return fallback;
  }
  return normalized;
}

function localDateFolder(createdAt) {
  const date = new Date(Number(createdAt) || Date.now());
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function organizedAssetFile(entry) {
  const kind = entry.kind === 'video' ? 'videos' : 'images';
  const lane = folderSegment(entry.lane, 'unknown-provider');
  const model = folderSegment(entry.model, 'unknown-model');
  const date = localDateFolder(entry.createdAt);
  const id = folderSegment(entry.id, 'asset');
  return [kind, lane, model, date, `${id}.${extensionFor(entry.mime)}`].join('/');
}

function storedAssetPath(file) {
  const root = resolve(assetsDir());
  const path = resolve(root, String(file || ''));
  return path === root || path.startsWith(`${root}${sep}`) ? path : null;
}

/** Move flat v1 assets into kind/provider/model/date folders without losing old indexes. */
function migrateAssetLayout() {
  mutateIndex((current) => {
    let changed = false;
    const assets = current.map((entry) => {
      const targetFile = organizedAssetFile(entry);
      const sourcePath = storedAssetPath(entry.file);
      const targetPath = storedAssetPath(targetFile);
      if (!targetPath) return entry;
      if (String(entry.file || '').replace(/\\/g, '/') === targetFile) return entry;
      if (existsSync(targetPath)) {
        changed = true;
        return { ...entry, file: targetFile };
      }
      if (!sourcePath || !existsSync(sourcePath)) return entry;
      try {
        mkdirSync(dirname(targetPath), { recursive: true });
        renameSync(sourcePath, targetPath);
        changed = true;
        return { ...entry, file: targetFile };
      } catch {
        return entry;
      }
    });
    return changed ? assets : null;
  });
}

/** Persist one generated artifact and return its index entry. */
export function saveMediaAsset({ kind, lane, model, prompt, options = {}, mime, bytes, meta = {} }) {
  // Moving legacy files is a write-side maintenance task. Running it from
  // list/resolve made the first Studio read synchronously wait on index.lock.
  ensureDirs({ migrate: true });
  const id = randomUUID();
  const createdAt = Date.now();
  const entry = {
    id,
    kind,
    lane,
    model,
    prompt: String(prompt || '').slice(0, 4_000),
    options,
    mime,
    bytes: bytes.length,
    createdAt,
    ...meta,
  };
  const file = organizedAssetFile(entry);
  const path = storedAssetPath(file);
  if (!path) throw new Error('invalid media asset path');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  entry.file = file;
  // The gallery is NOT capped (user). An entry-count trim used to unlink the
  // oldest files here, which is data loss nobody asked for: a generated asset
  // leaves this store only through an explicit delete.
  mutateIndex((assets) => [entry, ...assets]);
  // The first gallery paint after a generation would otherwise be the one that
  // pays for the tile rendition; build it now, off the caller's path.
  void ensureRendition({
    id: entry.id,
    kind: entry.kind,
    sourcePath: path,
    variant: 'thumb',
    cacheDir: renditionsDir(),
    priority: 'background',
  });
  return entry;
}

export function listMediaAssets({ limit = 60, offset = 0, kind = null } = {}) {
  ensureDirs();
  const all = readIndex().filter((entry) => (kind ? entry.kind === kind : true));
  const start = Math.max(0, Math.trunc(Number(offset) || 0));
  const count = Math.min(200, Math.max(1, Math.trunc(Number(limit) || 60)));
  const assets = all.slice(start, start + count);
  return { total: all.length, assets };
}

function getMediaAsset(id) {
  ensureDirs();
  readIndex();
  return indexCacheById.get(id) || null;
}

/** Persist a duration probed while building a poster, so the gallery badge
 *  survives a restart without decoding the clip again. */
function rememberDuration(entry, durationSeconds) {
  if (!durationSeconds || entry.durationSeconds === durationSeconds) return;
  mutateIndex((assets) => {
    const row = assets.find((item) => item.id === entry.id);
    if (!row || row.durationSeconds === durationSeconds) return null;
    row.durationSeconds = durationSeconds;
    return assets;
  });
  entry.durationSeconds = durationSeconds;
}

/** Base64 for the inline (RPC) path. Large files are refused: bytes that big
 *  belong on the file route, not in a JSON frame. */
function inlineBase64(path) {
  const size = statSync(path).size;
  if (size > MAX_INLINE_BYTES) {
    const err = new Error('media asset is too large to preview');
    err.code = 'MEDIA_ASSET_TOO_LARGE';
    throw err;
  }
  return readFileSync(path).toString('base64');
}

/**
 * Locate an asset (or one of its renditions) as a FILE — no inlining.
 *
 * This is the unit the media routes serve: the client receives a cacheable,
 * range-able response instead of a base64 payload riding the RPC lane.
 * `available: false` means this host cannot build the rendition (no sharp /
 * no ffmpeg); the caller reduces the feature instead of substituting the
 * original behind the client's back.
 */
export async function resolveMediaFile(id, {
  variant = 'original',
  generate = true,
} = {}) {
  const entry = getMediaAsset(id);
  if (!entry) return null;
  const path = storedAssetPath(entry.file);
  if (!path || !existsSync(path)) return null;
  if (variant === 'original') return { ...entry, variant: 'original', path, available: true };
  if (!renditionSpec(variant)) throw new Error(`unknown media variant: ${variant}`);
  const rendition = await ensureRendition({
    id: entry.id,
    kind: entry.kind,
    sourcePath: path,
    variant,
    cacheDir: renditionsDir(),
    generate,
  });
  if (!rendition) return { ...entry, variant, path: '', available: false };
  rememberDuration(entry, rendition.durationSeconds);
  return {
    ...entry,
    ...(rendition.durationSeconds ? { durationSeconds: rendition.durationSeconds } : {}),
    variant,
    path: rendition.path,
    mime: rendition.mime,
    bytes: rendition.bytes,
    available: true,
  };
}

/**
 * Inline an asset for the renderer (base64 + mime).
 *
 * `variant` selects a derived rendition ('thumb' | 'display'); the original is
 * read only when it is asked for. A host that cannot build the rendition says
 * so (`available: false`) instead of quietly shipping full-size bytes — the
 * caller that can afford them (local IPC) opts in with `allowOriginal`.
 */
export async function readMediaAsset(id, {
  variant = 'original',
  allowOriginal = false,
  generate = true,
} = {}) {
  const file = await resolveMediaFile(id, { variant, generate });
  if (!file) return null;
  if (file.available) return { ...file, base64: inlineBase64(file.path) };
  if (!allowOriginal) return { ...file, base64: '' };
  const original = await resolveMediaFile(id, { variant: 'original' });
  if (!original) return null;
  return { ...original, downgraded: true, base64: inlineBase64(original.path) };
}

/** Cache a bounded thumbnail produced by Chromium when native codecs miss. */
export function cacheMediaThumbnail(id, input = {}) {
  const entry = getMediaAsset(id);
  if (!entry) return null;
  const base64 = typeof input.base64 === 'string' ? input.base64 : '';
  if (!base64 || base64.length > Math.ceil(MAX_CACHED_THUMBNAIL_BYTES * 4 / 3) + 8) {
    return { id, available: false };
  }
  const buffer = Buffer.from(base64, 'base64');
  if (!buffer.length || buffer.length > MAX_CACHED_THUMBNAIL_BYTES) {
    return { id, available: false };
  }
  const mime = String(input.mime || 'image/jpeg').toLowerCase();
  const rendition = cacheRendition({
    id: entry.id,
    variant: 'thumb',
    mime,
    buffer,
    cacheDir: renditionsDir(),
  });
  if (!rendition) return { id, available: false };
  const durationSeconds = Math.max(0, Math.round(Number(input.durationSeconds) || 0));
  if (durationSeconds) rememberDuration(entry, durationSeconds);
  return {
    id,
    available: true,
    variant: 'thumb',
    mime: rendition.mime,
    bytes: rendition.bytes,
    ...(durationSeconds ? { durationSeconds } : {}),
  };
}

export function mediaAssetPath(id) {
  const entry = getMediaAsset(id);
  return entry ? storedAssetPath(entry.file) : null;
}

/**
 * Hand an asset to the OS viewer. The path is resolved from our own index, so
 * no caller-supplied path ever reaches the shell.
 */
export function openMediaAsset(id) {
  const path = mediaAssetPath(id);
  if (!path || !existsSync(path)) return { id, opened: false };
  return { id, opened: openWithOs(path) };
}

/** Open one asset's containing directory, or the Studio assets root. */
export function openMediaFolder(id = '') {
  if (id) {
    const path = mediaAssetPath(id);
    if (!path || !existsSync(path)) return { id, path: '', opened: false };
    const folder = dirname(path);
    return { id, path: folder, opened: openWithOs(folder) };
  }
  ensureDirs();
  return { path: assetsDir(), opened: openWithOs(assetsDir()) };
}

function openWithOs(path) {
  const [command, args] = process.platform === 'win32'
    ? ['cmd', ['/c', 'start', '', path]]
    : process.platform === 'darwin'
      ? ['open', [path]]
      : ['xdg-open', [path]];
  const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  return true;
}

export function deleteMediaAsset(id) {
  ensureDirs();
  let removed = false;
  mutateIndex((assets) => {
    const entry = assets.find((row) => row.id === id);
    if (!entry) return null;
    const path = storedAssetPath(entry.file);
    try { if (path) unlinkSync(path); } catch {}
    removeRenditions(renditionsDir(), id);
    removed = true;
    return assets.filter((row) => row.id !== id);
  });
  return { id, removed };
}
