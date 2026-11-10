// Inline `$name` skill mentions: a skill can be named anywhere in a prompt.
// A candidate is `$` at the start of the text or after whitespace or an
// opening bracket/quote, followed by a skill-name token (the same
// lowercase-letters, digits and hyphens rule, 64 characters at most, that
// skill-document.mjs enforces). It selects a skill only when the token is
// exactly a known skill name, so `$HOME`, `$300` and unknown names stay prose.
// The token ends where no ASCII identifier character follows (`$pptx_env`,
// `$pptxUPPER` are not `pptx`); any other character, Korean particles
// included (`$pptx로`), ends it.
const MENTION = /(^|[\s([{"'`])\$([a-z0-9][a-z0-9-]{0,63})(?![A-Za-z0-9_-])/g;

// Common environment-variable names (compared case-insensitively) and
// numeric-only tokens are never inline mentions, even when a skill has that
// name: `$path` or `$300` in prose means the variable or the amount. Choosing
// such a skill explicitly (the `Skill:` header chip) still works.
const RESERVED_NAMES = new Set([
  'path',
  'home',
  'user',
  'shell',
  'pwd',
  'tmpdir',
  'temp',
  'tmp',
  'lang',
  'term',
  'xdg_config_home',
  'userprofile',
  'appdata',
  'localappdata',
  'programfiles',
  'systemroot',
  'windir',
  'comspec',
]);

/** True when `name` can never be an inline mention (env var or number). */
export function isReservedMentionName(name) {
  const value = String(name ?? '');
  return /^[0-9]+$/.test(value) || RESERVED_NAMES.has(value.toLowerCase());
}

// Markdown code is never a mention: fenced blocks (``` or ~~~, 3+ chars,
// optional info string, closed by a fence of the same char at least as long,
// else running to the end) and inline code spans (a backtick run closed by
// the next run of exactly the same length; an unmatched run is literal).
// Deliberate Mixdog difference: Codex (codex-rs/skills/src/mentions.rs) scans
// raw bytes with no code handling. Offsets stay those of the original text,
// so desktop highlighting lines up (and never lands inside code).
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

function inlineCodeRanges(source, from, to, ranges) {
  const runs = [];
  const re = /`+/g;
  re.lastIndex = from;
  for (let match = re.exec(source); match && match.index < to; match = re.exec(source)) {
    runs.push({ start: match.index, end: Math.min(to, match.index + match[0].length) });
  }
  for (let index = 0; index < runs.length; index += 1) {
    const length = runs[index].end - runs[index].start;
    const close = runs.findIndex((run, at) => at > index && run.end - run.start === length);
    if (close < 0) continue;
    ranges.push([runs[index].start, runs[close].end]);
    index = close;
  }
}

/** [start, end) offsets of Markdown code (fenced blocks and inline spans). */
function codeRanges(source) {
  const ranges = [];
  let open = null;
  let proseStart = 0;
  for (let at = 0; at <= source.length; ) {
    const newline = source.indexOf('\n', at);
    const end = newline < 0 ? source.length : newline;
    const next = newline < 0 ? source.length + 1 : newline + 1;
    const line = source.slice(at, end).replace(/\r$/, '');
    if (!open) {
      const fence = FENCE_OPEN.exec(line);
      if (fence && !(fence[1][0] === '`' && fence[2].includes('`'))) {
        inlineCodeRanges(source, proseStart, at, ranges);
        open = { char: fence[1][0], length: fence[1].length, start: at };
      }
    } else {
      const fence = FENCE_CLOSE.exec(line);
      if (fence && fence[1][0] === open.char && fence[1].length >= open.length) {
        ranges.push([open.start, Math.min(next, source.length)]);
        proseStart = Math.min(next, source.length);
        open = null;
      }
    }
    at = next;
  }
  if (open) ranges.push([open.start, source.length]);
  else inlineCodeRanges(source, proseStart, source.length, ranges);
  return ranges;
}

/** True when `offset` in `text` lies inside Markdown code (a fenced block or
 *  an inline code span) by the same rules mention recognition uses, so a
 *  composer can tell whether a `$` being typed can become a mention. */
export function isInMarkdownCode(text, offset) {
  const source = typeof text === 'string' ? text : '';
  if (!Number.isInteger(offset) || (!source.includes('`') && !source.includes('~~~'))) return false;
  return codeRanges(source).some(([from, to]) => offset >= from && offset < to);
}

/** Every syntactically valid `$name` in `text` outside Markdown code, in
 *  order: `start` is the `$`. */
export function skillMentionCandidates(text) {
  const source = typeof text === 'string' ? text : '';
  const found = [];
  let code = null;
  for (const match of source.matchAll(MENTION)) {
    if (isReservedMentionName(match[2])) continue;
    const start = match.index + match[1].length;
    code ??= source.includes('`') || source.includes('~~~') ? codeRanges(source) : [];
    if (code.some(([from, to]) => start >= from && start < to)) continue;
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
