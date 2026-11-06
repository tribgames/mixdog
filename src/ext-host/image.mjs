// The image calls the extension host serves, over Node's own `sharp` paths
// (`shared/read-image-resize.mjs`) so the bytes are Node's. The image arrives base64, as a message
// part carries it; nothing on disk is touched.
//
// An answer is `{ ok }` or `{ error: 'invalid' | 'environment' }`, the two reasons Node has for no
// image: the decoder rejected the bytes, or there is no decoder / the machine failed
// (`isEnvironmentError`). Only the first judges the image.
import { isEnvironmentError } from '../runtime/shared/environment-error.mjs';
import {
  decodedImageMeta,
  encodeToolImageJpeg,
  loadSharp,
  resizeImageBuffer,
} from '../runtime/shared/read-image-resize.mjs';

const coded = (code, message) => Object.assign(new Error(message), { code });

const failure = (error) => ({ value: { error: isEnvironmentError(error) ? 'environment' : 'invalid' } });
const noDecoder = { value: { error: 'environment' } };

function bytesOf(params) {
  if (typeof params.data !== 'string') throw coded('invalid_params', 'data must be a base64 string');
  return Buffer.from(params.data, 'base64');
}

// `decodedImageMeta`: the dimensions after one full pixel decode.
async function probe(ctx) {
  const buffer = bytesOf(ctx.params);
  const sharp = await loadSharp();
  if (!sharp) return noDecoder;
  try {
    const { width, height } = await decodedImageMeta(sharp, buffer);
    return { value: { ok: { width: width || 0, height: height || 0 } } };
  } catch (error) {
    return failure(error);
  }
}

// One tool-result re-encode: `compactToolResultImage`'s sharp call at a quality.
async function jpeg(ctx) {
  const { width, height, allowEnlargement, quality } = ctx.params;
  for (const [name, value] of Object.entries({ width, height, quality })) {
    if (!Number.isInteger(value)) throw coded('invalid_params', `${name} must be an integer`);
  }
  if (typeof allowEnlargement !== 'boolean') throw coded('invalid_params', 'allowEnlargement must be a boolean');
  const buffer = bytesOf(ctx.params);
  const sharp = await loadSharp();
  if (!sharp) return noDecoder;
  try {
    const encoded = await encodeToolImageJpeg(sharp, buffer, width, height, allowEnlargement, quality);
    return {
      value: { ok: { data: encoded.data.toString('base64'), width: encoded.info.width, height: encoded.info.height } },
    };
  } catch (error) {
    return failure(error);
  }
}

// `resizeImageBuffer` as the provider image preparation calls it: whether the decoder takes the
// image. The rendition itself is not returned.
async function validate(ctx) {
  const buffer = bytesOf(ctx.params);
  try {
    const resized = await resizeImageBuffer(buffer, String(ctx.params.format ?? ''), { profile: 'anthropic' });
    return resized ? { value: { ok: true } } : noDecoder;
  } catch (error) {
    return failure(error);
  }
}

// The read tool's resize (`read-image.mjs`): `resizeImageBuffer(buffer, ext)` end to end, with its
// defaults. `ok` is Node's `{ data, mimeType, dimensions }`, or null when there is no sharp (or
// the buffer is empty); a decoder rejection is `invalid`, whatever its cause, because the read
// tool reports every `INVALID_IMAGE_DATA` the same way.
async function resize(ctx) {
  const buffer = bytesOf(ctx.params);
  try {
    return { value: { ok: await resizeImageBuffer(buffer, String(ctx.params.ext ?? '')) } };
  } catch (error) {
    if (error?.code !== 'INVALID_IMAGE_DATA') throw error;
    return { value: { error: 'invalid' } };
  }
}

// The media store's still rendition (`renditions.mjs` `encodeStill`): the webp of a variant's size
// and quality, EXIF-rotated. `ok` is `{ extension, data }`, or null when Node gives none (no sharp,
// or a source that does not decode: Node does not tell them apart either).
async function still(ctx) {
  const { renditionSpec, encodeStill } = await import('../runtime/media/renditions.mjs');
  const spec = renditionSpec(ctx.params.variant);
  if (!spec) throw coded('invalid_params', `unknown rendition variant: ${ctx.params.variant}`);
  const encoded = await encodeStill(bytesOf(ctx.params), spec);
  return { value: { ok: encoded ? { extension: encoded.extension, data: encoded.buffer.toString('base64') } : null } };
}

export const imageHandlers = {
  'image.still': still,
  'image.probe': probe,
  'image.jpeg': jpeg,
  'image.validate': validate,
  'image.resize': resize,
};
