export function assertLocalModelInput(model, messages, tools, options = {}, runtimeCapabilities = {}) {
  const content = messages.map((message) => message.content);
  while (content.length) {
    const value = content.pop();
    if (Array.isArray(value)) { content.push(...value); continue; }
    if (!value || typeof value !== 'object') continue;
    if (['image', 'image_url', 'input_image', 'audio', 'input_audio', 'video', 'file', 'document'].includes(value.type)) {
      throw new Error(`[local-provider] ${model.name} is text-only in this managed runtime. Use a compatible multimodal provider for image, audio, video or document input.`);
    }
    if (Array.isArray(value.content)) content.push(value.content);
  }
  const supportsTools = runtimeCapabilities.tools ?? model.supportsFunctionCalling;
  if (tools?.length && supportsTools === false) {
    throw new Error(`[local-provider] ${model.name} does not support the requested tool interface. Choose a tool-capable model.`);
  }
  if (options.effort || options.reasoningEffort) {
    throw new Error('[local-provider] reasoning-level controls are not configured for this model; remove the setting or choose another provider.');
  }
}
