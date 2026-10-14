/*
 * app/skill-mention-palette.mjs — `$name` skill completion in the prompt.
 *
 * Typing `$` at the start of the draft or after whitespace/an opening
 * bracket or quote (the shared runtime mention rule, runtime/shared/
 * skill-mentions.mjs) opens the command palette with the user's enabled
 * custom skills; accepting inserts `$name `. Built-in skills are not listed,
 * but still load when their name is typed: the runtime resolves mentions.
 */
import { useEffect, useState } from 'react';
import { isInMarkdownCode, isReservedMentionName } from '../../runtime/shared/skill-mentions.mjs';

// A mention being typed just before the caret: `$` plus a partial name.
const MENTION_TAIL = /(^|[\s([{"'`])\$([a-z0-9][a-z0-9-]{0,63})?$/;

const caretIn = (text, caret) => (Number.isInteger(caret) ? Math.max(0, Math.min(text.length, caret)) : text.length);

/** The mention being typed before `caret` (default: end of `value`), or null.
 *  `start` is the `$`, `end` the caret. */
export function skillMentionQuery(value, caret) {
  const text = String(value ?? '');
  const end = caretIn(text, caret);
  const match = MENTION_TAIL.exec(text.slice(0, end));
  if (!match) return null;
  const start = match.index + match[1].length;
  // `$` inside inline code or a fenced block is never a mention (the shared
  // parser's rule, judged on the whole draft like the desktop composer).
  if (isInMarkdownCode(text, start)) return null;
  return { query: match[2] || '', start, end };
}

const byName = (a, b) => a.name.localeCompare(b.name, 'en');

/** Palette rows for `query`: enabled, in-project (not `activeHere:false`)
 *  non-built-in skills whose name starts with the query, then those that
 *  merely contain it, each alphabetical. */
export function skillMentionItems(skills, query) {
  const needle = String(query || '').toLowerCase();
  const usable = (Array.isArray(skills) ? skills : []).filter(
    (skill) =>
      typeof skill?.name === 'string' &&
      skill.name &&
      skill.enabled !== false &&
      skill.activeHere !== false &&
      skill.source !== 'builtin' &&
      // `$path`/`$300` are never mentions, so offering them would insert prose.
      !isReservedMentionName(skill.name)
  );
  const prefix = usable.filter((skill) => skill.name.startsWith(needle)).sort(byName);
  const contains = needle
    ? usable.filter((skill) => !skill.name.startsWith(needle) && skill.name.includes(needle)).sort(byName)
    : [];
  return [...prefix, ...contains].map((skill) => ({
    kind: 'skill',
    name: skill.name,
    label: `$${skill.name}`,
    description: skill.description || '',
  }));
}

/** The draft with the `$fragment` before `caret` replaced by `$name `; the
 *  text after the caret is kept and the caret lands after the insertion. */
export function completeSkillMention(value, name, caret) {
  const text = String(value ?? '');
  const mention = skillMentionQuery(text, caret);
  if (!mention || !name) return undefined;
  const head = `${text.slice(0, mention.start)}$${name} `;
  return { value: head + text.slice(mention.end), cursor: head.length };
}

/** The skill list for the palette, fetched each time a mention starts. */
export function useSkillMentionSkills(store, active) {
  const [skills, setSkills] = useState([]);
  useEffect(() => {
    if (!active) return undefined;
    let live = true;
    Promise.resolve()
      .then(() => store.skillsStatus?.())
      .then((status) => {
        if (live) setSkills(Array.isArray(status?.skills) ? status.skills : []);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [store, active]);
  return skills;
}
