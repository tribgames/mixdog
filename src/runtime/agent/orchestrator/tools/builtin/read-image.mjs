import { readFileSync, statSync } from 'fs';
import { extname } from 'path';
import {
  API_IMAGE_MAX_BASE64_SIZE,
  imageMetadataText,
  resizeImageBuffer,
} from './read-image-resize.mjs';

// Image extensions native Read renders as image blocks (FileReadTool.ts).
const IMAGE_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

// Legacy pass-through cap. Used ONLY when sharp is unavailable (or resize
// failed) so an oversized original can't blow the token budget as a giant
// base64 blob. With sharp present, resizeImageBuffer downsamples instead, so
// large-but-resizable images are no longer hard-refused. ~3.75MB raw ≈ ~5MB b64.
const MAX_IMAGE_BYTES = 3_750_000;

// Returns the image MIME type for a path, or null if not a recognised image.
export function imageMimeForPath(p) {
  return IMAGE_MIME[extname(String(p || '')).toLowerCase()] || null;
}

// Build an MCP image-content result for an image file, or null if the path is
// not a recognised image (caller falls through to the normal text read).
//
// sharp present: read buffer -> resize fit:inside ≤2000x2000 -> token-budget
// recompress -> emit a metadata text block ("[Image: WxH, displayed at ...]")
// followed by the image block.
//
// sharp absent / resize failed: GRACEFUL fallback to the legacy
// pass-through-with-cap behaviour (refuse over-cap originals with an isError
// text result, else emit the raw base64 image block). No throw on missing sharp.
export async function readImageAsContent(fullPath, displayPath) {
  const mimeType = imageMimeForPath(fullPath);
  if (!mimeType) return null;
  let st;
  try { st = statSync(fullPath); } catch { return null; }

  let buf;
  try { buf = readFileSync(fullPath); } catch { return null; }
  if (buf.length === 0) {
    return {
      content: [{ type: 'text', text: `Error: image "${displayPath}" is empty (0 bytes).` }],
      isError: true,
    };
  }

  // sharp path: resize / downsample / token-budget. Returns null when sharp is
  // absent or processing failed, in which case we drop to the legacy cap path.
  const ext = mimeType.split('/')[1] || 'png';
  const resized = await resizeImageBuffer(buf, ext);
  if (resized) {
    const metaText = imageMetadataText(resized.dimensions, displayPath);
    const content = [];
    if (metaText) content.push({ type: 'text', text: metaText });
    content.push({ type: 'image', data: resized.data, mimeType: resized.mimeType });
    return { content };
  }

  // --- Legacy fallback (sharp unavailable) ---
  if (st.size > MAX_IMAGE_BYTES) {
    return {
      content: [{
        type: 'text',
        text: `Error: image "${displayPath}" is ${st.size} bytes, over the ${MAX_IMAGE_BYTES}-byte inline-view cap (image resizing unavailable: install the optional "sharp" dependency to auto-downsample). Convert/resize before reading.`,
      }],
      isError: true,
    };
  }
  // Guard the base64 length against the hard API ceiling even under the cap.
  const data = buf.toString('base64');
  if (data.length > API_IMAGE_MAX_BASE64_SIZE) {
    return {
      content: [{
        type: 'text',
        text: `Error: image "${displayPath}" base64 size ${data.length} exceeds the ${API_IMAGE_MAX_BASE64_SIZE}-byte API limit (image resizing unavailable). Resize before reading.`,
      }],
      isError: true,
    };
  }
  return { content: [{ type: 'image', data, mimeType }] };
}
