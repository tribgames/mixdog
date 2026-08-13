// Media transport shared by every phone-facing surface: the desktop's LAN
// relay and (through the same header rules) the Electron `mixdog-media://`
// protocol.
//
// Gallery bytes are files, not RPC payloads. Serving them over HTTP is what
// buys the browser cache, parallel fetches and Range seeking that a base64
// capability answer can never have: a tile re-paints from cache, and a video
// starts playing from the first range instead of after a full download.
import { createReadStream, statSync } from 'node:fs';

const MEDIA_ROUTE = /^\/media\/([0-9a-fA-F-]{8,64})$/;
const ALLOWED_VARIANTS = new Set(['original', 'thumb', 'display']);
// Renditions are content-addressed by asset id: an asset never changes bytes
// under a stable id, so the client may keep them for a year.
const CACHE_CONTROL = 'private, max-age=31536000, immutable';

/** `{ assetId, variant }` for a media route, or null for anything else. */
export function parseMediaRequest(pathname, searchParams) {
  const match = MEDIA_ROUTE.exec(String(pathname || ''));
  if (!match) return null;
  const variant = String(searchParams?.get?.('variant') || 'original');
  if (!ALLOWED_VARIANTS.has(variant)) return null;
  return { assetId: match[1], variant };
}

export function mediaEtag(assetId, variant, bytes) {
  return `"${assetId}-${variant}-${bytes}"`;
}

/**
 * Resolve a Range header against a known size.
 * Returns null for "no range", `{ start, end }` for a satisfiable one, and
 * `{ unsatisfiable: true }` when the client asked outside the file.
 */
export function parseRange(header, size) {
  const raw = String(header || '').trim();
  if (!raw) return null;
  // Only the single-range form is worth supporting; a multipart answer buys
  // nothing for media playback and every player falls back to it.
  const match = /^bytes=(\d*)-(\d*)$/.exec(raw);
  if (!match || size <= 0) return { unsatisfiable: true };
  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) return { unsatisfiable: true };
  let start;
  let end;
  if (!rawStart) {
    // Suffix form: the LAST n bytes.
    const length = Number(rawEnd);
    if (!Number.isFinite(length) || length <= 0) return { unsatisfiable: true };
    start = Math.max(0, size - length);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd ? Number(rawEnd) : size - 1;
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
    return { unsatisfiable: true };
  }
  return { start, end: Math.min(end, size - 1) };
}

/**
 * Status + headers + byte window for one media answer.
 *
 * Pure: the relay leg ships this plan across the desktop socket while the
 * Electron media protocol uses the same cache and range rules.
 */
export function mediaResponsePlan({ size, mime, assetId, variant, rangeHeader, ifNoneMatch }) {
  const etag = mediaEtag(assetId, variant, size);
  const headers = {
    'Content-Type': mime || 'application/octet-stream',
    'Cache-Control': CACHE_CONTROL,
    'Accept-Ranges': 'bytes',
    ETag: etag,
  };
  if (String(ifNoneMatch || '') === etag) return { status: 304, headers, start: 0, end: -1 };
  const range = parseRange(rangeHeader, size);
  if (range?.unsatisfiable) {
    return {
      status: 416,
      headers: { ...headers, 'Content-Range': `bytes */${size}` },
      start: 0,
      end: -1,
    };
  }
  const start = range ? range.start : 0;
  const end = range ? range.end : size - 1;
  return {
    status: range ? 206 : 200,
    headers: {
      ...headers,
      'Content-Length': end - start + 1,
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
    },
    start,
    end,
  };
}

/** Stream one resolved media file, honouring Range / If-None-Match / HEAD. */
export function sendMediaFile(request, response, { path, mime, assetId, variant }) {
  let size;
  try {
    size = statSync(path).size;
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found.');
    return;
  }
  const plan = mediaResponsePlan({
    size,
    mime,
    assetId,
    variant,
    rangeHeader: request.headers.range,
    ifNoneMatch: request.headers['if-none-match'],
  });
  response.writeHead(plan.status, plan.headers);
  if (plan.status >= 300 || request.method === 'HEAD') {
    response.end();
    return;
  }
  createReadStream(path, { start: plan.start, end: plan.end })
    .on('error', () => response.destroy())
    .pipe(response);
}
