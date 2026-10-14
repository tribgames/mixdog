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

// A mention being typed at the end of the draft: `$` plus a partial name.
const MENTION_TAIL = /(^|[\s([{"'`])\$([a-z0-9][a-z0-9-]{0,63})?$/;

/** The mention being typed at the end of `value`, or null. `start` is the `$`. */
export function skillMentionQuery(value) {
  const text = String(value ?? '');
  const match = MENTION_TAIL.exec(text);
  if (!match) return null;
  return { query: match[2] || '', start: match.index + match[1].length };
}

const byName = (a, b) => a.name.localeCompare(b.name, 'en');

/** Palette rows for `query`: enabled non-built-in skills whose name starts
 *  with the query, then those that merely contain it, each alphabetical. */
export function skillMentionItems(skills, query) {
  const needle = String(query || '').toLowerCase();
  const usable = (Array.isArray(skills) ? skills : []).filter(
    (skill) => typeof skill?.name === 'string' && skill.name && skill.enabled !== false && skill.source !== 'builtin'
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

/** `value` with the mention being typed replaced by `$name `. */
export function completeSkillMention(value, name) {
  const mention = skillMentionQuery(value);
  if (!mention || !name) return undefined;
  return `${String(value).slice(0, mention.start)}$${name} `;
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
