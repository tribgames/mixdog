/*
 * components/user-message-skills.mjs — the skills a user row applied.
 *
 * A user transcript row carries `appliedSkills` (the runtime's record of the
 * skills that turn actually loaded, live or restored). The row marks the
 * `$name` tokens of exactly those skills — found by the shared mention parser
 * the runtime and desktop use — and adds one applied-skills line under the
 * text. The row-height estimate counts that same line.
 */
import { skillMentions } from '../../runtime/shared/skill-mentions.mjs';

/** The applied skill names of a row value: non-empty strings only. */
export function appliedSkillNames(value) {
  return (Array.isArray(value) ? value : []).filter((name) => typeof name === 'string' && name);
}

/** The line rendered under a user row, or '' when it applied no skill. */
export function appliedSkillsLine(value) {
  const names = appliedSkillNames(value);
  return names.length ? `Skills applied: ${names.join(', ')}` : '';
}

/** `text` split into plain and marked spans; only `$name` tokens of applied
 *  skills are marked, so unknown names, `$HOME` and `$300` stay plain. */
export function userTextSegments(text, value) {
  const source = String(text ?? '');
  const applied = new Set(appliedSkillNames(value));
  if (!applied.size) return [{ text: source, mention: false }];
  const segments = [];
  let at = 0;
  for (const mention of skillMentions(source, (name) => applied.has(name))) {
    if (mention.start > at) segments.push({ text: source.slice(at, mention.start), mention: false });
    segments.push({ text: source.slice(mention.start, mention.end), mention: true });
    at = mention.end;
  }
  if (at < source.length || !segments.length) segments.push({ text: source.slice(at), mention: false });
  return segments;
}
