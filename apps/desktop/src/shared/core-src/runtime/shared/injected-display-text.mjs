export const INJECTED_DISPLAY_BLOCK_TAGS = Object.freeze([
  'system-reminder',
  'available-deferred-tools',
  'mcp-instructions',
  'memory-context',
  'skill',
  'event',
]);

export function stripInjectedBlocks(value, { dropUnterminated = false } = {}) {
  let text = String(value ?? '');
  for (const tag of INJECTED_DISPLAY_BLOCK_TAGS) {
    text = text.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, 'gi'), ' ');
    if (dropUnterminated) text = text.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*$`, 'i'), ' ');
    // Orphan closing tags are always runtime residue, never authored text.
    text = text.replace(new RegExp(`<\\/${tag}\\s*>`, 'gi'), ' ');
  }
  return text;
}
