// Inline `$name` skill mentions: a skill can be named anywhere in a prompt.
// A candidate is `$` at the start of the text or after whitespace or an
// opening bracket/quote, followed by a skill-name token (the same
// lowercase-letters, digits and hyphens rule, 64 characters at most, that
// skill-document.mjs enforces). It selects a skill only when the token is
// exactly a known skill name, so `$HOME`, `$300` and unknown names stay prose.
const MENTION = /(^|[\s([{"'`])\$([a-z0-9][a-z0-9-]{0,63})(?![a-z0-9-])/g;

/** Every syntactically valid `$name` in `text`, in order: `start` is the `$`. */
export function skillMentionCandidates(text) {
  const source = typeof text === 'string' ? text : '';
  const found = [];
  for (const match of source.matchAll(MENTION)) {
    const start = match.index + match[1].length;
    found.push({ name: match[2], start, end: start + 1 + match[2].length });
  }
  return found;
}

/** Candidates whose name `isSkill(name)` accepts (all occurrences, in order). */
export function skillMentions(text, isSkill) {
  return skillMentionCandidates(text).filter((mention) => isSkill(mention.name));
}

/** Distinct mentioned skill names in first-mention order. */
export function mentionedSkillNames(text, isSkill) {
  return [...new Set(skillMentions(text, isSkill).map((mention) => mention.name))];
}
