import { degradeMediaParts, isUnsentMediaText } from '../agent/orchestrator/providers/media-normalization.mjs';

// The local model is text-only: every media part is degraded (images, audio and
// video to fixed text; documents to their text form).

function hasUsableText(part) {
  return part?.type === 'text' && Boolean(String(part.text ?? '').trim()) && !isUnsentMediaText(part.text);
}

function hasText(content) {
  if (typeof content === 'string') return content.trim().length > 0;
  return Array.isArray(content) && content.some((part) => part?.type === 'text' && String(part.text ?? '').trim());
}

// Validates the request for a text-only local model and returns the messages to
// send: media parts anywhere in history become fixed text placeholders (stored
// messages are not mutated). Only a current user turn made solely of media is
// an error.
export function assertLocalModelInput(model, messages, tools, options = {}, runtimeCapabilities = {}) {
  const current = messages.findLast((message) => message.role === 'user');
  if (current && Array.isArray(current.content) && !hasText(current.content)) {
    const converted = degradeMediaParts(current.content);
    // Media with a text form (a PDF, an Office file) is usable input; only a
    // turn left with nothing but omitted placeholders is an error.
    if (converted !== current.content && !converted.some((part) => hasUsableText(part))) {
      throw new Error(
        `[local-provider] ${model.name} is text-only in this managed runtime. Use a compatible multimodal provider for image, audio, video or document input.`
      );
    }
  }
  const degraded = messages.map((message) => {
    if (!Array.isArray(message.content)) return message;
    const content = degradeMediaParts(message.content);
    return content === message.content ? message : { ...message, content };
  });
  const supportsTools = runtimeCapabilities.tools ?? model.supportsFunctionCalling;
  if (tools?.length && supportsTools === false) {
    throw new Error(
      `[local-provider] ${model.name} does not support the requested tool interface. Choose a tool-capable model.`
    );
  }
  if (options.effort || options.reasoningEffort) {
    throw new Error(
      '[local-provider] reasoning-level controls are not configured for this model; remove the setting or choose another provider.'
    );
  }
  return degraded;
}
