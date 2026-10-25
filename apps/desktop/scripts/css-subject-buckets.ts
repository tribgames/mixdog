// Build-time CSS rewrite: a selector whose subject compound is only `:is(A, B, …)`
// (plus pseudo-classes / pseudo-elements) becomes the list `…A, …B`.
//
// Why: Blink files each selector under its subject's id, class, attribute or
// tag and tries it only on elements that have it. A subject made of a
// multi-argument `:is()` has no single key, so the selector lands in the
// universal list and is tried against EVERY element on every style update
// (selector stats of a phone scrolling a long transcript: those rules were
// ~30% of all selector matching, each tried on ~5k elements and matching
// none). Spelled out, each arm is keyed on its own subject.
//
// The rewrite keeps what every element matches and the cascade:
//  - the rule stays where it is (only its selector list changes);
//  - each arm keeps the `:is()`'s specificity (the largest of its arguments)
//    through padding that every element matches whatever it carries: the
//    negation of an impossible compound `X:where(:not(X))`, which weighs
//    exactly X (Selectors 4 §17: :not() takes its argument's specificity,
//    :where() adds none) and no element can match;
//  - an argument with combinators is spelled out only where that is exact:
//    with no prefix, or under a root prefix (`html…` / `:root…`) when its
//    top compound cannot be the root element. Other arguments stay grouped in
//    a narrower `:is()`, padded the same way.
// A rule is left untouched when any argument cannot be padded exactly.
import type { Plugin as PostcssPlugin, Rule } from 'postcss';

type Specificity = [number, number, number];

/** One unit of (id, class, type) weight that every element matches. */
const PAD = [':not(#mx:where(:not(#mx)))', ':not(.mx:where(:not(.mx)))', ':not(mx:where(:not(mx)))'] as const;
const LEGACY_PSEUDO_ELEMENTS = new Set(['before', 'after', 'first-line', 'first-letter']);

/** Split at top-level occurrences of `separator` (outside (), [] and strings). */
export function splitTopLevel(text: string, separator = ','): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (char === '\\') index += 1;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === '\\') index += 1;
    else if (char === '(' || char === '[') depth += 1;
    else if (char === ')' || char === ']') depth -= 1;
    else if (depth === 0 && char === separator) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((part) => part.trim());
}

/** Index just past the `)` matching the `(` at `open`. */
function closeParen(text: string, open: number): number {
  let depth = 0;
  let quote = '';
  for (let index = open; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (char === '\\') index += 1;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === '\\') index += 1;
    else if (char === '(' || char === '[') depth += 1;
    else if (char === ')' || char === ']') {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return -1;
}

/** Top-level compounds of a complex selector, with the combinator before each. */
export function compounds(selector: string): Array<{ combinator: string; compound: string }> {
  const out: Array<{ combinator: string; compound: string }> = [];
  let depth = 0;
  let quote = '';
  let current = '';
  let combinator = '';
  for (let index = 0; index < selector.length; index += 1) {
    const char = selector[index];
    if (quote) {
      current += char;
      if (char === '\\') current += selector[++index] ?? '';
      else if (char === quote) quote = '';
      continue;
    }
    if (depth === 0 && (/\s/.test(char) || char === '>' || char === '+' || char === '~')) {
      if (current) {
        out.push({ combinator, compound: current });
        current = '';
        combinator = '';
      }
      if (out.length > 0) {
        if (char === '>' || char === '+' || char === '~') combinator = char;
        else if (!combinator) combinator = ' ';
      }
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === '\\') {
      current += char + (selector[++index] ?? '');
      continue;
    } else if (char === '(' || char === '[') depth += 1;
    else if (char === ')' || char === ']') depth -= 1;
    current += char;
  }
  if (current) out.push({ combinator, compound: current });
  return out;
}

function maxSpecificity(list: Specificity[]): Specificity {
  return list.reduce((best, next) => (compare(next, best) > 0 ? next : best), [0, 0, 0] as Specificity);
}

function compare(left: Specificity, right: Specificity): number {
  for (let index = 0; index < 3; index += 1) if (left[index] !== right[index]) return left[index] - right[index];
  return 0;
}

/** Selectors Level 4 specificity of a complex selector. */
export function specificity(selector: string): Specificity {
  const total: Specificity = [0, 0, 0];
  const add = (value: Specificity) => {
    for (let index = 0; index < 3; index += 1) total[index] += value[index];
  };
  let index = 0;
  while (index < selector.length) {
    const char = selector[index];
    if (char === '#') {
      total[0] += 1;
      index = skipIdent(selector, index + 1);
    } else if (char === '.') {
      total[1] += 1;
      index = skipIdent(selector, index + 1);
    } else if (char === '[') {
      total[1] += 1;
      index = closeParen(selector, index);
    } else if (char === ':') {
      const element = selector[index + 1] === ':';
      const nameStart = index + (element ? 2 : 1);
      const nameEnd = skipIdent(selector, nameStart);
      const name = selector.slice(nameStart, nameEnd).toLowerCase();
      const hasArgs = selector[nameEnd] === '(';
      const end = hasArgs ? closeParen(selector, nameEnd) : nameEnd;
      const args = hasArgs ? selector.slice(nameEnd + 1, end - 1) : '';
      if (element || LEGACY_PSEUDO_ELEMENTS.has(name)) total[2] += 1;
      else if (name === 'where') {
        // zero
      } else if (name === 'is' || name === 'not' || name === 'has' || name === 'matches') {
        add(maxSpecificity(splitTopLevel(args).map(specificity)));
      } else if ((name === 'nth-child' || name === 'nth-last-child') && /\sof\s/i.test(args)) {
        total[1] += 1;
        add(
          maxSpecificity(
            splitTopLevel(
              args
                .split(/\sof\s/i)
                .slice(1)
                .join(' of ')
            ).map(specificity)
          )
        );
      } else total[1] += 1;
      index = end;
    } else if (char === '*' || /[\s>+~,|]/.test(char)) {
      index += 1;
    } else if (/[a-zA-Z_\-\\]/.test(char) || char.charCodeAt(0) > 127) {
      total[2] += 1;
      index = skipIdent(selector, index);
    } else {
      index += 1;
    }
  }
  return total;
}

function skipIdent(text: string, start: number): number {
  let index = start;
  while (index < text.length) {
    const char = text[index];
    if (char === '\\') index += 2;
    else if (/[a-zA-Z0-9_-]/.test(char) || char.charCodeAt(0) > 127) index += 1;
    else break;
  }
  return index;
}

function padding(target: Specificity, value: Specificity): string | null {
  let pad = '';
  for (let index = 0; index < 3; index += 1) {
    const missing = target[index] - value[index];
    if (missing < 0) return null;
    pad += PAD[index].repeat(missing);
  }
  return pad;
}

const ROOT_COMPOUND = /^(?:html|:root)(?:[[:.].*)?$/i;

/** True when the compound cannot match the root element (html carries no class or id). */
function neverRoot(compound: string): boolean {
  if (/(^|[^\\])[.#]/.test(compound.replace(/\([^)]*\)|\[[^\]]*\]/g, ''))) return true;
  const type = /^[a-zA-Z][\w-]*/.exec(compound)?.[0];
  return Boolean(type && type.toLowerCase() !== 'html');
}

/** The rewritten selector list for one complex selector, or null to keep it. */
export function expandSubjectIs(selector: string): string[] | null {
  const parts = compounds(selector);
  const subject = parts.at(-1);
  if (!subject || !/^:is\(/i.test(subject.compound)) return null;
  const close = closeParen(subject.compound, 3);
  if (close < 0) return null;
  const suffix = subject.compound.slice(close);
  // Only pseudo-classes / pseudo-elements may follow: anything else keys the subject already.
  if (suffix && !suffix.startsWith(':')) return null;
  if (/(^|[^\\])[.#[]/.test(suffix.replace(/\([^)]*\)/g, ''))) return null;
  const args = splitTopLevel(subject.compound.slice(4, close - 1));
  if (args.length < 2 || args.some((arg) => !arg || /::|:(before|after|first-line|first-letter)\b/i.test(arg))) {
    return null;
  }
  const prefixParts = parts.slice(0, -1);
  const prefix = selector.slice(0, selector.lastIndexOf(subject.compound));
  const rootPrefix =
    prefixParts.length > 0 &&
    prefixParts.every((part) => ROOT_COMPOUND.test(part.compound)) &&
    subject.combinator === ' ';
  const target = maxSpecificity(args.map(specificity));
  const spelled: string[] = [];
  const grouped: string[] = [];
  for (const arg of args) {
    const argParts = compounds(arg);
    const exact =
      argParts.length === 1 || prefixParts.length === 0 || (rootPrefix && neverRoot(argParts[0]?.compound ?? ''));
    if (exact) spelled.push(arg);
    else grouped.push(arg);
  }
  if (spelled.length === 0) return null;
  const out: string[] = [];
  for (const arg of spelled) {
    const pad = padding(target, specificity(arg));
    if (pad === null) return null;
    out.push(`${prefix}${arg}${pad}${suffix}`);
  }
  if (grouped.length > 0) {
    const groupSpecificity = maxSpecificity(grouped.map(specificity));
    const pad = padding(target, groupSpecificity);
    if (pad === null) return null;
    out.push(`${prefix}:is(${grouped.join(', ')})${pad}${suffix}`);
  }
  return out;
}

/** Rewrites a rule's selector list; returns whether it changed. */
export function rewriteRule(rule: Pick<Rule, 'selector'>): boolean {
  if (rule.selector.includes('&')) return false;
  const selectors = splitTopLevel(rule.selector);
  let changed = false;
  const next = selectors.flatMap((selector) => {
    const expanded = expandSubjectIs(selector);
    if (!expanded) return [selector];
    changed = true;
    return expanded;
  });
  if (changed) rule.selector = next.join(',\n');
  return changed;
}

export function cssSubjectBuckets(): PostcssPlugin {
  return {
    postcssPlugin: 'mixdog-css-subject-buckets',
    Rule(rule) {
      const parent = rule.parent as { type?: string; name?: string } | undefined;
      if (parent?.type === 'atrule' && /keyframes$/i.test(parent.name ?? '')) return;
      rewriteRule(rule);
    },
  };
}
cssSubjectBuckets.postcss = true;
