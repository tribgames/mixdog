// Optional-sharp image resize / downsample helper: a `read` on an image
// returns a viewable, budget-bounded image block instead of refusing
// oversized originals.
//
// sharp is a direct runtime dependency. Entry points still degrade to `null`
// when a platform-native binding cannot load so a damaged install reports the
// existing bounded fallback instead of crashing the whole daemon. A loaded
// sharp rejecting the bytes is different: corrupt images must never fall
// through to raw provider pass-through.

import { createHash } from 'node:crypto';

// Anthropic inline-image input is capped near 5MB base64 (API rejects on the
// base64 LENGTH, not raw bytes). IMAGE_TARGET_RAW_SIZE is the raw-byte target
// that stays under that cap after the 4/3 base64 inflation.
export const API_IMAGE_MAX_BASE64_SIZE = 5 * 1024 * 1024; // 5 MB
export const IMAGE_TARGET_RAW_SIZE = (API_IMAGE_MAX_BASE64_SIZE * 3) / 4; // 3.75 MB
// Vision billing counts 28x28 patches, not bytes: a lossless recompression
// saves upload but not one token. Dimensions are the only lever, and standard
// models cap an image at 1568px on its longest edge before processing — pixels
// sent beyond that are downscaled away server-side, so they cost upload and
// (until now) an inflated local estimate while the model saw the same picture.
export const IMAGE_MAX_WIDTH = 1568;
export const IMAGE_MAX_HEIGHT = 1568;
// Floor for the shortest edge. Patch tiling rejects a degenerate sub-patch
// image (the 1x1 PNG an empty render emits) with a hard 400 that fails the
// whole request, so such an image is scaled UP instead of passed through.
const IMAGE_MIN_DIMENSION = 200;
// Token budget for a single image. est tokens = base64.length * 0.125 (the
// common per-image heuristic). Default aligns to the 5MB base64 API ceiling so the
// dimension/raw-size resize governs the common case and the token gate only
// fires on pathologically dense images.
const DEFAULT_IMAGE_MAX_TOKENS = Math.ceil(API_IMAGE_MAX_BASE64_SIZE * 0.125);
const OPENAI_IMAGE_MAX_DIMENSION = 2048;
const OPENAI_IMAGE_PATCH_SIZE = 32;
const OPENAI_IMAGE_MAX_PATCHES = 1536;
// Anthropic bills 28x28 patches and a standard-tier image may spend 1568 of
// them, so the patch budget usually binds before the edge ceiling does:
// 1568x882 clears 1568px on both edges yet still needs 1792 patches. That is
// why the documented rendition of a 1080p frame lands near 1456x819 rather
// than at the edge limit.
const ANTHROPIC_IMAGE_PATCH_SIZE = 28;
const ANTHROPIC_IMAGE_MAX_PATCHES = 1568;
const IMAGE_RESIZE_CACHE_MAX_BYTES = 64 * 1024 * 1024;
const imageResizeCache = new Map();
let imageResizeCacheBytes = 0;
let imageResizeCacheHits = 0;
let imageResizeCacheMisses = 0;

class InvalidImageDataError extends Error {
  constructor(cause = null) {
    const detail = cause instanceof Error && cause.message ? `: ${cause.message}` : '';
    super(`invalid or corrupt image data${detail}`);
    this.name = 'InvalidImageDataError';
    this.code = 'INVALID_IMAGE_DATA';
    if (cause) this.cause = cause;
  }
}

export function imageProfileForProvider(provider) {
  const value = String(provider || '')
    .trim()
    .toLowerCase();
  return /^(?:openai|xai|grok|deepseek|opencode-go|mixdog-local)(?:-|$)/.test(value) ? 'openai' : 'anthropic';
}

function imagePatchCount(width, height, patchSize) {
  return (
    Math.ceil(Math.max(1, Number(width) || 1) / patchSize) * Math.ceil(Math.max(1, Number(height) || 1) / patchSize)
  );
}

export function openAIImagePatchCount(width, height) {
  return imagePatchCount(width, height, OPENAI_IMAGE_PATCH_SIZE);
}

function resizeCacheKey(buffer, ext, maxTokens, profile) {
  return createHash('sha256')
    .update(String(ext || ''))
    .update('\0')
    .update(String(maxTokens || 0))
    .update('\0')
    .update(String(profile || ''))
    .update('\0')
    .update(buffer)
    .digest('hex');
}

function cloneResizeResult(result) {
  return {
    ...result,
    ...(result?.dimensions ? { dimensions: { ...result.dimensions } } : {}),
  };
}

function rememberResizeResult(key, result) {
  const bytes = Buffer.byteLength(String(result?.data || ''), 'base64');
  if (bytes <= 0 || bytes > IMAGE_RESIZE_CACHE_MAX_BYTES) return;
  const existing = imageResizeCache.get(key);
  if (existing) {
    imageResizeCacheBytes -= existing.bytes;
    imageResizeCache.delete(key);
  }
  imageResizeCache.set(key, { result: cloneResizeResult(result), bytes });
  imageResizeCacheBytes += bytes;
  while (imageResizeCacheBytes > IMAGE_RESIZE_CACHE_MAX_BYTES && imageResizeCache.size > 0) {
    const oldest = imageResizeCache.keys().next().value;
    const evicted = imageResizeCache.get(oldest);
    imageResizeCache.delete(oldest);
    imageResizeCacheBytes -= evicted?.bytes || 0;
  }
}

export function imageResizeCacheStats() {
  return {
    entries: imageResizeCache.size,
    bytes: imageResizeCacheBytes,
    maxBytes: IMAGE_RESIZE_CACHE_MAX_BYTES,
    hits: imageResizeCacheHits,
    misses: imageResizeCacheMisses,
  };
}

// Cached dynamic import. Resolves to the sharp factory or null (absent /
// failed). Cached so repeated reads don't re-attempt a failing import.
let _sharpPromise;
async function loadSharp() {
  if (_sharpPromise === undefined) {
    _sharpPromise = (async () => {
      try {
        const mod = await import('sharp');
        const sharp = mod?.default || mod || null;
        // libvips' internal operation cache (default ~50MB per
        // process) duplicates the JS-level resize cache above and the
        // on-disk rendition cache; keep pixels out of native memory.
        try {
          sharp?.cache(false);
        } catch {
          /* cache stays default */
        }
        return sharp;
      } catch {
        return null;
      }
    })();
  }
  return _sharpPromise;
}

function estTokens(base64) {
  return Math.ceil((base64?.length || 0) * 0.125);
}

function normalizeFmt(fmt) {
  if (!fmt) return 'png';
  const f = String(fmt).toLowerCase();
  return f === 'jpg' ? 'jpeg' : f;
}

// Build the metadata text block prepended to a resized image:
// "[Image: WxH, displayed at ...]" plus a coordinate
// scale note when the image was downsampled.
export function imageMetadataText(dims, sourcePath) {
  if (!dims) return sourcePath ? `[Image source: ${sourcePath}]` : null;
  const { originalWidth, originalHeight, displayWidth, displayHeight } = dims;
  if (!originalWidth || !originalHeight || !displayWidth || !displayHeight || displayWidth <= 0 || displayHeight <= 0) {
    return sourcePath ? `[Image source: ${sourcePath}]` : null;
  }
  const wasResized = originalWidth !== displayWidth || originalHeight !== displayHeight;
  const parts = [];
  if (sourcePath) parts.push(`source: ${sourcePath}`);
  parts.push(`${originalWidth}x${originalHeight}`);
  if (wasResized) {
    const scale = originalWidth / displayWidth;
    parts.push(
      `displayed at ${displayWidth}x${displayHeight}. Multiply coordinates by ${scale.toFixed(2)} to map to the original image.`
    );
  } else {
    parts.push(`displayed at ${displayWidth}x${displayHeight}`);
  }
  return `[Image: ${parts.join(', ')}]`;
}

// Resize / downsample an image buffer with sharp.
//
// Pipeline (resize / downsample under a token budget):
//   1. metadata() — read format + dimensions.
//   2. resize fit:inside withoutEnlargement to <= 2000x2000 (only when over
//      dimension caps OR over the 3.75MB raw target).
//   3. est tokens (base64.len * 0.125); if over budget, recompress jpeg q<=50.
//   4. still over budget -> 400x400 jpeg q20 hard fallback.
//
// Returns { data (base64), mimeType ("image/..."), dimensions } on success,
// null only when sharp is unavailable, and throws InvalidImageDataError when
// the decoder rejects the bytes.
// Constrain dimensions while preserving aspect ratio. Both limits bind, and
// either one can be the tighter: the per-edge ceiling governs an elongated
// image, the patch budget a wide one.
function targetDimensions(originalWidth, originalHeight, normalizedProfile) {
  let width = originalWidth;
  let height = originalHeight;
  const maxWidth = normalizedProfile === 'openai' ? OPENAI_IMAGE_MAX_DIMENSION : IMAGE_MAX_WIDTH;
  const maxHeight = normalizedProfile === 'openai' ? OPENAI_IMAGE_MAX_DIMENSION : IMAGE_MAX_HEIGHT;
  const patchSize = normalizedProfile === 'openai' ? OPENAI_IMAGE_PATCH_SIZE : ANTHROPIC_IMAGE_PATCH_SIZE;
  const maxPatches = normalizedProfile === 'openai' ? OPENAI_IMAGE_MAX_PATCHES : ANTHROPIC_IMAGE_MAX_PATCHES;
  const scale = Math.min(
    1,
    maxWidth / width,
    maxHeight / height,
    Math.sqrt((maxPatches * patchSize ** 2) / (width * height))
  );
  width = Math.max(1, Math.floor(width * scale));
  height = Math.max(1, Math.floor(height * scale));
  // Lift a sub-patch image to the floor, but never past the profile's own
  // ceiling: an extreme aspect ratio keeps its shape rather than being
  // blown up to satisfy its short edge.
  let allowEnlargement = false;
  const shortestEdge = Math.min(width, height);
  if (shortestEdge < IMAGE_MIN_DIMENSION) {
    const ceiling = Math.min(maxWidth, maxHeight);
    const upscale = Math.min(IMAGE_MIN_DIMENSION / shortestEdge, ceiling / Math.max(width, height));
    if (upscale > 1) {
      width = Math.max(1, Math.round(width * upscale));
      height = Math.max(1, Math.round(height * upscale));
      allowEnlargement = true;
    }
  }
  // Area scaling is exact, but rounding a partial patch up can still leave
  // one row or column over budget; trim the longer edge until it fits.
  while (imagePatchCount(width, height, patchSize) > maxPatches && (width > 1 || height > 1)) {
    if (width >= height) width -= 1;
    else height -= 1;
  }
  return { width, height, allowEnlargement };
}

// Token-budget gate: recompress to jpeg q50 at the (already resized) display
// dimensions, then the 400x400 jpeg q20 hard fallback. Fresh sharp instance
// per op — reusing an instance after toBuffer() drops the format conversion.
async function fitRenditionToTokenBudget(sharp, buffer, rendition, maxTokens) {
  const { originalWidth, originalHeight } = rendition;
  try {
    let s = sharp(buffer);
    if (rendition.displayWidth && rendition.displayHeight) {
      s = s.resize(rendition.displayWidth, rendition.displayHeight, { fit: 'inside', withoutEnlargement: true });
    }
    const jpeg = await s.jpeg({ quality: 50 }).toBuffer({ resolveWithObject: true });
    rendition.mediaType = 'jpeg';
    rendition.base64 = jpeg.data.toString('base64');
    rendition.displayWidth = jpeg.info.width || rendition.displayWidth;
    rendition.displayHeight = jpeg.info.height || rendition.displayHeight;
  } catch {
    /* keep the q-pre buffer; the 400x400 fallback runs next */
  }
  if (estTokens(rendition.base64) <= maxTokens) return;
  try {
    const fb = await sharp(buffer)
      .resize(400, 400, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 20 })
      .toBuffer();
    rendition.mediaType = 'jpeg';
    rendition.base64 = fb.toString('base64');
    if (originalWidth && originalHeight) {
      const scale = Math.min(400 / originalWidth, 400 / originalHeight, 1);
      rendition.displayWidth = Math.max(1, Math.round(originalWidth * scale));
      rendition.displayHeight = Math.max(1, Math.round(originalHeight * scale));
    }
  } catch {
    /* keep whatever we have */
  }
}

// A cached rendition, refreshed to most-recently-used; null on a miss.
function recallResizeResult(cacheKey) {
  const cached = imageResizeCache.get(cacheKey);
  if (!cached) {
    imageResizeCacheMisses += 1;
    return null;
  }
  imageResizeCacheHits += 1;
  imageResizeCache.delete(cacheKey);
  imageResizeCache.set(cacheKey, cached);
  return cloneResizeResult(cached.result);
}

// metadata() only parses headers; libpng can still reject a corrupt IDAT
// stream later. Force one full pixel decode before any original bytes are
// allowed through unchanged.
async function decodedImageMeta(sharp, buffer) {
  const meta = await sharp(buffer).metadata();
  await sharp(buffer, {
    sequentialRead: true,
    limitInputPixels: 64 * 1024 * 1024,
  })
    .raw()
    .toBuffer();
  return meta;
}

// The rendition inside the profile's target box. Trimming the edges
// separately can leave a box the picture does not fill: fit:'inside' keeps
// the aspect ratio, so the rendition is smaller than the box that was asked
// for. Report what came out — the metadata line and its coordinate scale are
// read as the truth about this image.
async function renderRendition(sharp, buffer, meta, ext, profile) {
  const originalWidth = meta.width;
  const originalHeight = meta.height;
  const rendition = {
    base64: '',
    mediaType: normalizeFmt(meta.format || ext),
    originalWidth,
    originalHeight,
    displayWidth: originalWidth,
    displayHeight: originalHeight,
  };
  let outBuf = buffer;
  if (originalWidth && originalHeight) {
    const { width, height, allowEnlargement } = targetDimensions(originalWidth, originalHeight, profile);
    const needsResize = width !== originalWidth || height !== originalHeight;
    if (needsResize || buffer.length > IMAGE_TARGET_RAW_SIZE) {
      const resized = await sharp(buffer)
        .resize(width, height, { fit: 'inside', withoutEnlargement: !allowEnlargement })
        .toBuffer({ resolveWithObject: true });
      outBuf = resized.data;
      rendition.displayWidth = resized.info.width || width;
      rendition.displayHeight = resized.info.height || height;
    }
  }
  rendition.base64 = outBuf.toString('base64');
  return rendition;
}

export async function resizeImageBuffer(
  buffer,
  ext,
  { maxTokens = DEFAULT_IMAGE_MAX_TOKENS, profile = 'anthropic' } = {}
) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return null;
  const normalizedProfile = profile === 'openai' ? 'openai' : 'anthropic';
  const cacheKey = resizeCacheKey(buffer, ext, maxTokens, normalizedProfile);
  const cached = recallResizeResult(cacheKey);
  if (cached) return cached;
  const sharp = await loadSharp();
  if (!sharp) return null;
  try {
    const meta = await decodedImageMeta(sharp, buffer);
    const rendition = await renderRendition(sharp, buffer, meta, ext, normalizedProfile);
    if (estTokens(rendition.base64) > maxTokens) await fitRenditionToTokenBudget(sharp, buffer, rendition, maxTokens);
    const result = {
      data: rendition.base64,
      mimeType: `image/${rendition.mediaType}`,
      dimensions: {
        originalWidth: rendition.originalWidth,
        originalHeight: rendition.originalHeight,
        displayWidth: rendition.displayWidth,
        displayHeight: rendition.displayHeight,
      },
    };
    rememberResizeResult(cacheKey, result);
    return result;
  } catch (error) {
    // A present decoder rejected the payload. Passing the original bytes
    // through poisons the conversation and makes every later request 400.
    throw new InvalidImageDataError(error);
  }
}

// Build an image content block (+ optional metadata text) from a raw buffer.
// Returns { textBlock, imageBlock } on success, or null on fallback. Used by
// the notebook reader to embed cell-output images.
export async function imageBlocksFromBuffer(buffer, mimeType, { sourcePath, maxTokens } = {}) {
  const ext = (mimeType || '').split('/')[1] || 'png';
  let resized;
  try {
    resized = await resizeImageBuffer(buffer, ext, maxTokens ? { maxTokens } : {});
  } catch (error) {
    if (error?.code === 'INVALID_IMAGE_DATA') return null;
    throw error;
  }
  if (!resized) return null;
  const metaText = imageMetadataText(resized.dimensions, sourcePath);
  return {
    textBlock: metaText ? { type: 'text', text: metaText } : null,
    imageBlock: { type: 'image', data: resized.data, mimeType: resized.mimeType },
  };
}
