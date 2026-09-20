// Explicit user selection travels as text so queued, remote and multimodal
// prompts use the same transport. Only the leading, complete header is syntax;
// mentions in prose, quotations, attachments and skill bodies are not selectors.
export function skillSelectionHeader(name) {
  return `Skill: ${JSON.stringify(String(name))}\n\n`;
}

export function selectedSkillName(prompt) {
  const first = Array.isArray(prompt) ? prompt[0] : prompt;
  let text = '';
  if (typeof first === 'string') text = first;
  else if (first?.type === 'text') text = first.text;
  if (typeof text !== 'string') return null;
  const match = /^Skill: ("(?:[^"\\\r\n]|\\.)*")\r?\n\r?\n/.exec(text);
  if (!match) return null;
  try {
    const name = JSON.parse(match[1]);
    return typeof name === 'string' && name.trim() ? name.trim() : null;
  } catch {
    return null;
  }
}
