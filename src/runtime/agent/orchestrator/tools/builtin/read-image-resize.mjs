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
const IMAGE_MAX_WIDTH = 2000;
const IMAGE_MAX_HEIGHT = 2000;
// Token budget for a single image. est tokens = base64.length * 0.125 (the
// common per-image heuristic). Default aligns to the 5MB base64 API ceiling so the
// dimension/raw-size resize governs the common case and the token gate only
// fires on pathologically dense images.
const DEFAULT_IMAGE_MAX_TOKENS = Math.ceil(API_IMAGE_MAX_BASE64_SIZE * 0.125);
export const OPENAI_IMAGE_MAX_DIMENSION = 2048;
export const OPENAI_IMAGE_PATCH_SIZE = 32;
export const OPENAI_IMAGE_MAX_PATCHES = 1536;
const IMAGE_RESIZE_CACHE_MAX_BYTES = 64 * 1024 * 1024;
const imageResizeCache = new Map();
let imageResizeCacheBytes = 0;
let imageResizeCacheHits = 0;
let imageResizeCacheMisses = 0;

export class InvalidImageDataError extends Error {
    constructor(cause = null) {
        const detail = cause instanceof Error && cause.message ? `: ${cause.message}` : '';
        super(`invalid or corrupt image data${detail}`);
        this.name = 'InvalidImageDataError';
        this.code = 'INVALID_IMAGE_DATA';
        if (cause) this.cause = cause;
    }
}

export function imageProfileForProvider(provider) {
    const value = String(provider || '').trim().toLowerCase();
    return /^(?:openai|xai|grok|deepseek|opencode-go|ollama|lmstudio)(?:-|$)/.test(value)
        ? 'openai'
        : 'anthropic';
}

export function openAIImagePatchCount(width, height) {
    return Math.ceil(Math.max(1, Number(width) || 1) / OPENAI_IMAGE_PATCH_SIZE)
        * Math.ceil(Math.max(1, Number(height) || 1) / OPENAI_IMAGE_PATCH_SIZE);
}

function resizeCacheKey(buffer, ext, maxTokens, profile) {
    return createHash('sha256')
        .update(String(ext || '')).update('\0')
        .update(String(maxTokens || 0)).update('\0')
        .update(String(profile || '')).update('\0')
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
                try { sharp?.cache(false); } catch { /* cache stays default */ }
                return sharp;
            } catch {
                return null;
            }
        })();
    }
    return _sharpPromise;
}

export function prewarmImageResizer() {
    return loadSharp();
}

// True when sharp resolved; used for the per-file change summary / fallback note.
async function sharpAvailable() {
    return (await loadSharp()) !== null;
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
    if (!originalWidth || !originalHeight || !displayWidth || !displayHeight
        || displayWidth <= 0 || displayHeight <= 0) {
        return sourcePath ? `[Image source: ${sourcePath}]` : null;
    }
    const wasResized = originalWidth !== displayWidth || originalHeight !== displayHeight;
    const parts = [];
    if (sourcePath) parts.push(`source: ${sourcePath}`);
    parts.push(`${originalWidth}x${originalHeight}`);
    if (wasResized) {
        const scale = originalWidth / displayWidth;
        parts.push(`displayed at ${displayWidth}x${displayHeight}. Multiply coordinates by ${scale.toFixed(2)} to map to the original image.`);
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
export async function resizeImageBuffer(buffer, ext, {
    maxTokens = DEFAULT_IMAGE_MAX_TOKENS,
    profile = 'anthropic',
} = {}) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) return null;
    const normalizedProfile = profile === 'openai' ? 'openai' : 'anthropic';
    const cacheKey = resizeCacheKey(buffer, ext, maxTokens, normalizedProfile);
    const cached = imageResizeCache.get(cacheKey);
    if (cached) {
        imageResizeCacheHits += 1;
        imageResizeCache.delete(cacheKey);
        imageResizeCache.set(cacheKey, cached);
        return cloneResizeResult(cached.result);
    }
    imageResizeCacheMisses += 1;
    const sharp = await loadSharp();
    if (!sharp) return null;
    try {
        const meta = await sharp(buffer).metadata();
        // metadata() only parses headers; libpng can still reject a corrupt
        // IDAT stream later. Force one full pixel decode before any original
        // bytes are allowed through unchanged.
        await sharp(buffer, {
            sequentialRead: true,
            limitInputPixels: 64 * 1024 * 1024,
        }).raw().toBuffer();
        const fmt = normalizeFmt(meta.format || ext);
        const originalWidth = meta.width;
        const originalHeight = meta.height;
        const originalSize = buffer.length;

        let outBuf = buffer;
        let mediaType = fmt;
        let displayWidth = originalWidth;
        let displayHeight = originalHeight;

        if (originalWidth && originalHeight) {
            // Constrain dimensions while preserving aspect ratio.
            let width = originalWidth;
            let height = originalHeight;
            const maxWidth = normalizedProfile === 'openai' ? OPENAI_IMAGE_MAX_DIMENSION : IMAGE_MAX_WIDTH;
            const maxHeight = normalizedProfile === 'openai' ? OPENAI_IMAGE_MAX_DIMENSION : IMAGE_MAX_HEIGHT;
            let scale = Math.min(1, maxWidth / width, maxHeight / height);
            if (normalizedProfile === 'openai') {
                scale = Math.min(
                    scale,
                    Math.sqrt((OPENAI_IMAGE_MAX_PATCHES * OPENAI_IMAGE_PATCH_SIZE ** 2) / (width * height)),
                );
            }
            width = Math.max(1, Math.floor(width * scale));
            height = Math.max(1, Math.floor(height * scale));
            while (normalizedProfile === 'openai' && openAIImagePatchCount(width, height) > OPENAI_IMAGE_MAX_PATCHES) {
                if (width >= height) width -= 1;
                else height -= 1;
            }
            const needsResize = width !== originalWidth || height !== originalHeight;
            if (needsResize || originalSize > IMAGE_TARGET_RAW_SIZE) {
                outBuf = await sharp(buffer)
                    .resize(width, height, { fit: 'inside', withoutEnlargement: true })
                    .toBuffer();
                displayWidth = width;
                displayHeight = height;
            }
        }

        let base64 = outBuf.toString('base64');

        // Token-budget gate: recompress to jpeg q50 at the (already resized)
        // display dimensions. Fresh sharp instance per op — reusing an
        // instance after toBuffer() drops the format conversion.
        if (estTokens(base64) > maxTokens) {
            try {
                let s = sharp(buffer);
                if (displayWidth && displayHeight) {
                    s = s.resize(displayWidth, displayHeight, { fit: 'inside', withoutEnlargement: true });
                }
                const jpeg = await s.jpeg({ quality: 50 }).toBuffer();
                outBuf = jpeg;
                mediaType = 'jpeg';
                base64 = jpeg.toString('base64');
            } catch { /* keep the q-pre buffer; the 400x400 fallback runs next */ }

            // Hard fallback: 400x400 jpeg q20.
            if (estTokens(base64) > maxTokens) {
                try {
                    const fb = await sharp(buffer)
                        .resize(400, 400, { fit: 'inside', withoutEnlargement: true })
                        .jpeg({ quality: 20 })
                        .toBuffer();
                    outBuf = fb;
                    mediaType = 'jpeg';
                    base64 = fb.toString('base64');
                    if (originalWidth && originalHeight) {
                        const scale = Math.min(400 / originalWidth, 400 / originalHeight, 1);
                        displayWidth = Math.max(1, Math.round(originalWidth * scale));
                        displayHeight = Math.max(1, Math.round(originalHeight * scale));
                    }
                } catch { /* keep whatever we have */ }
            }
        }

        const result = {
            data: base64,
            mimeType: `image/${mediaType}`,
            dimensions: { originalWidth, originalHeight, displayWidth, displayHeight },
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
