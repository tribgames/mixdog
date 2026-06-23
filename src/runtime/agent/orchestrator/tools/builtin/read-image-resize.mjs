// Optional-sharp image resize / downsample helper. Mirrors Claude Code's
// imageResizer.ts (maybeResizeAndDownsampleImageBuffer +
// readImageWithTokenBudget) so a `read` on an image returns a viewable,
// budget-bounded image block instead of refusing oversized originals.
//
// sharp is an OPTIONAL dependency. Every entry point degrades to a `null`
// return when sharp can't be loaded (not installed, native binding missing,
// dlopen failure); callers fall back to the legacy pass-through-with-cap
// behaviour. No code path throws on a missing sharp.

// Anthropic inline-image input is capped near 5MB base64 (API rejects on the
// base64 LENGTH, not raw bytes). IMAGE_TARGET_RAW_SIZE is the raw-byte target
// that stays under that cap after the 4/3 base64 inflation.
export const API_IMAGE_MAX_BASE64_SIZE = 5 * 1024 * 1024; // 5 MB
export const IMAGE_TARGET_RAW_SIZE = (API_IMAGE_MAX_BASE64_SIZE * 3) / 4; // 3.75 MB
export const IMAGE_MAX_WIDTH = 2000;
export const IMAGE_MAX_HEIGHT = 2000;
// Token budget for a single image. est tokens = base64.length * 0.125 (CC's
// per-image heuristic). Default aligns to the 5MB base64 API ceiling so the
// dimension/raw-size resize governs the common case and the token gate only
// fires on pathologically dense images.
export const DEFAULT_IMAGE_MAX_TOKENS = Math.ceil(API_IMAGE_MAX_BASE64_SIZE * 0.125);

// Cached dynamic import. Resolves to the sharp factory or null (absent /
// failed). Cached so repeated reads don't re-attempt a failing import.
let _sharpPromise;
async function loadSharp() {
    if (_sharpPromise === undefined) {
        _sharpPromise = (async () => {
            try {
                const mod = await import('sharp');
                return mod?.default || mod || null;
            } catch {
                return null;
            }
        })();
    }
    return _sharpPromise;
}

// True when sharp resolved; used for the per-file change summary / fallback note.
export async function sharpAvailable() {
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

// Build the metadata text block prepended to a resized image. Mirrors CC
// createImageMetadataText: "[Image: WxH, displayed at ...]" plus a coordinate
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
// Pipeline (mirrors CC maybeResizeAndDownsampleImageBuffer + token budget):
//   1. metadata() — read format + dimensions.
//   2. resize fit:inside withoutEnlargement to <= 2000x2000 (only when over
//      dimension caps OR over the 3.75MB raw target).
//   3. est tokens (base64.len * 0.125); if over budget, recompress jpeg q<=50.
//   4. still over budget -> 400x400 jpeg q20 hard fallback.
//
// Returns { data (base64), mimeType ("image/..."), dimensions } on success,
// or null when sharp is unavailable OR any sharp op threw (caller falls back
// to legacy pass-through-with-cap).
export async function resizeImageBuffer(buffer, ext, { maxTokens = DEFAULT_IMAGE_MAX_TOKENS } = {}) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) return null;
    const sharp = await loadSharp();
    if (!sharp) return null;
    try {
        const meta = await sharp(buffer).metadata();
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
            if (width > IMAGE_MAX_WIDTH) {
                height = Math.round((height * IMAGE_MAX_WIDTH) / width);
                width = IMAGE_MAX_WIDTH;
            }
            if (height > IMAGE_MAX_HEIGHT) {
                width = Math.round((width * IMAGE_MAX_HEIGHT) / height);
                height = IMAGE_MAX_HEIGHT;
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

        return {
            data: base64,
            mimeType: `image/${mediaType}`,
            dimensions: { originalWidth, originalHeight, displayWidth, displayHeight },
        };
    } catch {
        // sharp present but processing failed (corrupt header, unsupported
        // format, OOM). Signal fallback rather than throwing.
        return null;
    }
}

// Build an image content block (+ optional metadata text) from a raw buffer.
// Returns { textBlock, imageBlock } on success, or null on fallback. Used by
// the notebook reader to embed cell-output images.
export async function imageBlocksFromBuffer(buffer, mimeType, { sourcePath, maxTokens } = {}) {
    const ext = (mimeType || '').split('/')[1] || 'png';
    const resized = await resizeImageBuffer(buffer, ext, maxTokens ? { maxTokens } : {});
    if (!resized) return null;
    const metaText = imageMetadataText(resized.dimensions, sourcePath);
    return {
        textBlock: metaText ? { type: 'text', text: metaText } : null,
        imageBlock: { type: 'image', data: resized.data, mimeType: resized.mimeType },
    };
}
