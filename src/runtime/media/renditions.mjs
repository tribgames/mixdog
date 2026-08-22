/**
 * Derived renditions for the media gallery (thumb / display / video poster).
 *
 * A gallery tile is ~512px and a detail view never exceeds the viewport, so
 * the original bytes are the wrong unit of transfer: over the remote link one
 * full-size still costs more than the entire visible grid. Renditions are
 * generated once, cached on disk beside the assets, and afterwards read back
 * as small files.
 *
 * sharp (stills) and ffmpeg (video posters) are OPTIONAL. When neither can
 * produce a rendition this module returns null and the caller reduces the
 * feature (glyph tile) or explicitly asks for the original. It never silently
 * substitutes full-size bytes for a thumbnail — that hidden path is exactly
 * what made the remote gallery slow.
 */
import { spawn } from 'child_process';
import { randomBytes } from 'crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { dirname, join } from 'path';

import { resolvePluginData } from '../shared/plugin-paths.mjs';

// maxEdge is the long edge in pixels; quality is the webp setting.
const SPECS = {
  thumb: { maxEdge: 512, quality: 70 },
  display: { maxEdge: 2048, quality: 82 },
};
// Probe order when reading a cached rendition: sharp writes webp, the
// ffmpeg-only poster path writes png.
const EXTENSION_MIME = {
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
};
const POSTER_TIMEOUT_MS = 20_000;
const MAX_POSTER_BYTES = 32 * 1024 * 1024;
const FAILED_RENDITION_COOLDOWN_MS = 30_000;
const MAX_CACHED_RENDITION_BYTES = 4 * 1024 * 1024;
const DEFAULT_RENDITION_CACHE_MAX_BYTES = 512 * 1024 * 1024;
const configuredRenditionCacheMaxBytes = Number(process.env.MIXDOG_RENDITION_CACHE_MAX_BYTES);
export const RENDITION_CACHE_MAX_BYTES = Number.isFinite(configuredRenditionCacheMaxBytes)
  && configuredRenditionCacheMaxBytes >= MAX_CACHED_RENDITION_BYTES
  ? Math.floor(configuredRenditionCacheMaxBytes)
  : DEFAULT_RENDITION_CACHE_MAX_BYTES;

const MEDIA_VARIANTS = Object.keys(SPECS);

/** Spec for a variant name, or null when the caller asked for the original. */
export function renditionSpec(variant) {
  return SPECS[String(variant || '')] || null;
}

let sharpPromise;
async function loadSharp() {
  sharpPromise ??= import('sharp').then((mod) => mod?.default || mod || null, () => null);
  return sharpPromise;
}

let ffmpegPromise;
// The managed voice runtime already installs ffmpeg; reuse it rather than
// shipping a second copy. MIXDOG_FFMPEG_PATH overrides for hosts that have
// their own build.
async function resolveFfmpeg() {
  ffmpegPromise ??= (async () => {
    const explicit = String(process.env.MIXDOG_FFMPEG_PATH || '').trim();
    if (explicit && existsSync(explicit)) return explicit;
    try {
      const { resolveVoiceRuntime } = await import('../channels/lib/voice-runtime-fetcher.mjs');
      const runtime = resolveVoiceRuntime(resolvePluginData());
      return runtime?.ffmpegPath && existsSync(runtime.ffmpegPath) ? runtime.ffmpegPath : null;
    } catch {
      return null;
    }
  })();
  return ffmpegPromise;
}

function renditionPath(cacheDir, variant, id, extension) {
  return join(cacheDir, variant, `${id}${extension}`);
}

function cachedRendition(cacheDir, variant, id) {
  for (const [extension, mime] of Object.entries(EXTENSION_MIME)) {
    const path = renditionPath(cacheDir, variant, id, extension);
    // stat IS the existence check: a separate existsSync leaves a window in
    // which concurrent pruning unlinks the file between the two calls, turning
    // a plain cache miss into a thrown media request.
    try {
      const info = statSync(path);
      if (info.isFile()) return { path, mime, bytes: info.size };
    } catch { /* absent or evicted mid-lookup */ }
  }
  return null;
}

/** Drop every cached rendition of one asset (called when the asset dies). */
export function removeRenditions(cacheDir, id) {
  for (const variant of MEDIA_VARIANTS) {
    for (const extension of Object.keys(EXTENSION_MIME)) {
      try { unlinkSync(renditionPath(cacheDir, variant, id, extension)); } catch { /* absent */ }
    }
  }
}

/** Bound the rebuildable rendition tree by evicting the oldest files first. */
export function pruneRenditionCache(cacheDir, {
  maxBytes = RENDITION_CACHE_MAX_BYTES,
  protectedPath = '',
} = {}) {
  const budget = Math.max(0, Math.floor(Number(maxBytes) || 0));
  const rows = [];
  let totalBytes = 0;
  for (const variant of MEDIA_VARIANTS) {
    const dir = join(cacheDir, variant);
    let names;
    try { names = readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (!Object.keys(EXTENSION_MIME).some((extension) => name.endsWith(extension))) continue;
      const path = join(dir, name);
      try {
        const stat = statSync(path);
        if (!stat.isFile()) continue;
        rows.push({ path, bytes: stat.size, mtimeMs: stat.mtimeMs });
        totalBytes += stat.size;
      } catch { /* raced with another writer/pruner */ }
    }
  }
  rows.sort((a, b) => (a.mtimeMs - b.mtimeMs) || a.path.localeCompare(b.path));
  for (const row of rows) {
    if (totalBytes <= budget) break;
    if (row.path === protectedPath) continue;
    try {
      unlinkSync(row.path);
      totalBytes -= row.bytes;
    } catch { /* another process already removed it */ }
  }
  return { bytes: Math.max(0, totalBytes), entries: rows.length };
}

function writeRendition(cacheDir, variant, id, extension, buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0 || buffer.length > MAX_CACHED_RENDITION_BYTES) {
    return null;
  }
  const path = renditionPath(cacheDir, variant, id, extension);
  mkdirSync(dirname(path), { recursive: true });
  // Stage-then-rename: a reader must never observe a half-written cache file.
  const staging = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(staging, buffer);
  try {
    renameSync(staging, path);
  } catch (error) {
    // Another process may have won the same cache publication race.
    if (!existsSync(path)) throw error;
  } finally {
    try { unlinkSync(staging); } catch { /* renamed or already removed */ }
  }
  let bytes = buffer.length;
  try { bytes = statSync(path).size; } catch { /* use written size */ }
  pruneRenditionCache(cacheDir, { protectedPath: path });
  return { path, mime: EXTENSION_MIME[extension], bytes };
}

export function createPriorityScheduler(limit = 2) {
  const foreground = [];
  const background = [];
  let active = 0;
  let backgroundActive = 0;
  const concurrency = Math.max(1, limit);
  const backgroundConcurrency = Math.max(1, concurrency - 1);
  const pump = () => {
    while (active < concurrency) {
      const foregroundEntry = foreground.shift();
      const entry = foregroundEntry
        ?? (backgroundActive < backgroundConcurrency ? background.shift() : null);
      if (!entry) return;
      active += 1;
      if (!foregroundEntry) backgroundActive += 1;
      void Promise.resolve()
        .then(entry.task)
        .then(entry.resolve, entry.reject)
        .finally(() => {
          active -= 1;
          if (!foregroundEntry) backgroundActive -= 1;
          pump();
        });
    }
  };
  return (task, priority = 'foreground') => new Promise((resolve, reject) => {
    const queue = priority === 'background' ? background : foreground;
    queue.push({ task, resolve, reject });
    pump();
  });
}

const scheduleRendition = createPriorityScheduler(2);

/** Downscale a still (path or buffer) into a webp; null without sharp. */
async function encodeStill(input, spec) {
  const sharp = await loadSharp();
  if (!sharp) return null;
  try {
    const buffer = await sharp(input)
      // EXIF-rotated phone photos would otherwise land sideways in the grid.
      .rotate()
      .resize(spec.maxEdge, spec.maxEdge, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: spec.quality })
      .toBuffer();
    return { extension: '.webp', buffer };
  } catch {
    // sharp present but the source is not a decodable image.
    return null;
  }
}

function parseDurationSeconds(text) {
  const match = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text || '');
  if (!match) return 0;
  const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
  return Number.isFinite(seconds) ? Math.round(seconds) : 0;
}

export function videoPosterArguments(sourcePath, spec) {
  return [
    '-hide_banner', '-nostdin',
    '-i', sourcePath,
    // The encoded first frame is frequently a black transition. An accurate
    // post-input seek gives generated clips a representative early poster.
    '-ss', '0.12',
    '-frames:v', '1',
    '-vf', `scale='min(${spec.maxEdge},iw)':-2`,
    // Emit the tile JPEG directly. The old PNG -> sharp -> webp second encode
    // doubled cold-video latency and failed when sharp was unavailable.
    '-q:v', '4',
    '-f', 'image2', '-vcodec', 'mjpeg', 'pipe:1',
  ];
}

/** Representative frame + duration of a clip, straight from ffmpeg; null when the
 *  managed runtime is not installed. */
async function grabVideoFrame(sourcePath, spec) {
  const ffmpeg = await resolveFfmpeg();
  if (!ffmpeg) return null;
  return new Promise((resolve) => {
    const child = spawn(
      ffmpeg,
      videoPosterArguments(sourcePath, spec),
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    );
    const chunks = [];
    let total = 0;
    let stderr = '';
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch { /* already gone */ }
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), POSTER_TIMEOUT_MS);
    timer.unref?.();
    child.stdout.on('data', (chunk) => {
      total += chunk.length;
      // A corrupt clip could stream frames forever; the poster is one image.
      if (total > MAX_POSTER_BYTES) {
        finish(null);
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', () => finish(null));
    child.on('close', () => {
      const buffer = Buffer.concat(chunks);
      finish(buffer.length ? { buffer, durationSeconds: parseDurationSeconds(stderr) } : null);
    });
  });
}

// Two tiles asking for the same missing rendition must not both encode it.
const inflight = new Map();
const failedUntil = new Map();
const FAILED_RENDITION_CACHE_MAX = 256;

function pruneFailedRenditions(now = Date.now()) {
  for (const [key, expiresAt] of failedUntil) {
    if (expiresAt <= now) failedUntil.delete(key);
  }
  while (failedUntil.size > FAILED_RENDITION_CACHE_MAX) {
    const oldest = failedUntil.keys().next().value;
    if (oldest === undefined) break;
    failedUntil.delete(oldest);
  }
}

function rememberFailedRendition(key) {
  failedUntil.delete(key);
  failedUntil.set(key, Date.now() + FAILED_RENDITION_COOLDOWN_MS);
  pruneFailedRenditions();
}

async function generate({ id, kind, sourcePath, variant, spec, cacheDir }) {
  if (kind === 'video') {
    // Only the tile-sized poster is worth extracting: a "display" frame would
    // be a still pretending to be a clip.
    if (variant !== 'thumb') return null;
    const frame = await grabVideoFrame(sourcePath, spec);
    if (!frame) return null;
    const written = writeRendition(cacheDir, variant, id, '.jpg', frame.buffer);
    return written ? { ...written, durationSeconds: frame.durationSeconds } : null;
  }
  const encoded = await encodeStill(sourcePath, spec);
  return encoded ? writeRendition(cacheDir, variant, id, encoded.extension, encoded.buffer) : null;
}

/**
 * Cached rendition for one asset, generating it on first use.
 * Returns `{ path, mime, bytes, durationSeconds? }`, or null when this host
 * cannot produce it (no sharp / no ffmpeg / undecodable source).
 */
export async function ensureRendition({
  id,
  kind,
  sourcePath,
  variant,
  cacheDir,
  priority = 'foreground',
  generate = true,
}) {
  const spec = renditionSpec(variant);
  if (!spec) return null;
  const cached = cachedRendition(cacheDir, variant, id);
  if (cached) return cached;
  if (!generate) return null;
  const key = `${variant}:${id}`;
  pruneFailedRenditions();
  if ((failedUntil.get(key) || 0) > Date.now()) return null;
  const pending = inflight.get(key)
    ?? scheduleRendition(
      () => generate({ id, kind, sourcePath, variant, spec, cacheDir }),
      priority,
    )
      .then((result) => {
        if (result) failedUntil.delete(key);
        else rememberFailedRendition(key);
        return result;
      })
      .catch(() => {
        rememberFailedRendition(key);
        return null;
      })
      .finally(() => { inflight.delete(key); });
  inflight.set(key, pending);
  return pending;
}

/** Persist a small browser-generated fallback so a codec miss is paid once. */
export function cacheRendition({ id, variant = 'thumb', mime, buffer, cacheDir }) {
  if (!renditionSpec(variant)) return null;
  const extension = mime === 'image/webp'
    ? '.webp'
    : mime === 'image/png' ? '.png'
      : mime === 'image/jpeg' ? '.jpg' : '';
  if (!extension || !buffer?.length || buffer.length > MAX_CACHED_RENDITION_BYTES) return null;
  failedUntil.delete(`${variant}:${id}`);
  return writeRendition(cacheDir, variant, id, extension, buffer);
}
