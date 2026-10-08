import {
  API_IMAGE_MAX_BASE64_SIZE,
  IMAGE_MAX_WIDTH,
  IMAGE_MAX_HEIGHT,
  resizeImageBuffer,
  supersedingImageMetadataText,
} from '../../tools/builtin/read-image-resize.mjs';

import { isEnvironmentError } from '../../../../shared/environment-error.mjs';

const MAX_INPUT_BASE64_SIZE = Math.ceil((64 * 1024 * 1024) / 3) * 4;

export class AnthropicImagePreparationError extends Error {
  constructor(path, detail, cause, failingImageData) {
    super(
      `Anthropic image preparation failed at ${path}: ${detail}. The original image and conversation were not changed.`,
      { cause }
    );
    this.name = 'AnthropicImagePreparationError';
    this.code = 'ANTHROPIC_IMAGE_PREPARATION_FAILED';
    this.status = 400;
    // Identifies the rejected image for recovery; never part of the message.
    Object.defineProperty(this, 'failingImageData', { value: failingImageData, enumerable: false });
  }
}

// The image may be fine; this machine cannot resize it (broken sharp runtime,
// out of memory...). Not an image rejection: recovery must not strip anything.
export class AnthropicImageRuntimeError extends Error {
  constructor(path, cause) {
    super(
      `Anthropic image preparation unavailable at ${path}: image resizing is unavailable; repair the sharp runtime. The original image and conversation were not changed.`,
      { cause }
    );
    this.name = 'AnthropicImageRuntimeError';
    this.code = 'ANTHROPIC_IMAGE_RUNTIME_UNAVAILABLE';
    this.status = 400;
  }
}

// Work on the lowered request, not stored history: this covers attachments,
// tool results, replayed images, and provider switches alike. Keep the
// IMAGE_MAX_WIDTH x IMAGE_MAX_HEIGHT display box (1568px) independent of image count so crossing 20 images never invalidates
// an earlier image or changes its cached rendition.
export async function prepareAnthropicImages(messages, { signal } = {}) {
  if (!Array.isArray(messages)) return messages;

  async function prepareContent(content, path) {
    if (!Array.isArray(content)) return content;
    const next = [];
    let changed = false;
    // Sequential decoding bounds native pixel memory; the shared resizer's
    // byte-bounded cache avoids decoding the same history on every turn.
    for (let index = 0; index < content.length; index += 1) {
      signal?.throwIfAborted();
      const part = content[index];
      const partPath = `${path}.${index}`;
      if (part?.type === 'tool_result') {
        const nested = await prepareContent(part.content, `${partPath}.content`);
        next.push(nested === part.content ? part : { ...part, content: nested });
        changed ||= nested !== part.content;
        continue;
      }
      // Remote URLs / file IDs remain server-owned. Never fetch them or
      // inspect arbitrary tool inputs, signed thinking, or PDF bytes.
      if (part?.type !== 'image' || part.source?.type !== 'base64') {
        next.push(part);
        continue;
      }
      const source = part.source;
      if (typeof source.data !== 'string' || !source.data.length || source.data.length > MAX_INPUT_BASE64_SIZE) {
        throw new AnthropicImagePreparationError(
          partPath,
          'image is empty or exceeds the 64 MiB input limit; use a smaller image'
        );
      }
      let resized;
      try {
        resized = await resizeImageBuffer(
          Buffer.from(source.data, 'base64'),
          String(source.media_type || 'image/png').split('/')[1],
          { profile: 'anthropic' }
        );
      } catch (error) {
        if (isEnvironmentError(error)) throw new AnthropicImageRuntimeError(partPath, error);
        throw new AnthropicImagePreparationError(
          partPath,
          'image could not be decoded; reattach a valid image',
          error,
          source.data
        );
      }
      signal?.throwIfAborted();
      if (!resized) throw new AnthropicImageRuntimeError(partPath);
      const dims = resized.dimensions;
      if (
        !dims?.displayWidth ||
        !dims?.displayHeight ||
        dims.displayWidth > IMAGE_MAX_WIDTH ||
        dims.displayHeight > IMAGE_MAX_HEIGHT ||
        resized.data.length > API_IMAGE_MAX_BASE64_SIZE
      ) {
        throw new AnthropicImagePreparationError(
          partPath,
          'image still exceeds the supported size; use a smaller image',
          undefined,
          source.data
        );
      }
      if (resized.data === source.data && resized.mimeType === source.media_type) {
        next.push(part);
        continue;
      }
      changed = true;
      if (dims.originalWidth !== dims.displayWidth || dims.originalHeight !== dims.displayHeight) {
        next.push({ type: 'text', text: supersedingImageMetadataText(dims) });
      }
      // Cache markers stay attached to the same logical block. No
      // sanitizer or reordering runs after this byte-preparation pass.
      next.push({
        ...part,
        source: { ...source, data: resized.data, media_type: resized.mimeType },
      });
    }
    return changed ? next : content;
  }

  let changed = false;
  const next = [];
  for (let index = 0; index < messages.length; index += 1) {
    signal?.throwIfAborted();
    const message = messages[index];
    const content = await prepareContent(message?.content, `messages.${index}.content`);
    next.push(content === message?.content ? message : { ...message, content });
    changed ||= content !== message?.content;
  }
  return changed ? next : messages;
}
