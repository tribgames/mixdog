/**
 * How a caller's `query` picks elements and lines. One matcher serves the
 * host (accessibility snapshots, `read`) and the page-side DOM fallback, so
 * the two never disagree about what a filter means: whitespace splits the
 * query into keywords that match with OR (an element matching every keyword
 * ranks above a partial match), and `/pattern/` or `/pattern/i` is a regular
 * expression. A one-word query behaves exactly as a substring filter did.
 */
export type BrowserSemanticMatchField = 'name' | 'value' | 'role' | 'href';

export interface BrowserSemanticMatch {
  field: BrowserSemanticMatchField;
  score: number;
  /** How many of the query's keywords matched (1 for a regular expression). */
  matched: number;
  /** How many keywords the query had (1 for a regular expression). */
  terms: number;
}

export interface BrowserQueryPlan {
  regex?: RegExp;
  tokens: string[];
}

const REGEX_QUERY = /^\/(.+)\/([a-z]*)$/s;

/** Turn a raw query into keywords or a regular expression. Throws on a
 *  malformed pattern or an unsupported flag so the caller can say why. */
export function parseBrowserQuery(raw: unknown): BrowserQueryPlan {
  const query = String(raw ?? '').trim();
  if (!query) return { tokens: [] };
  const regex = REGEX_QUERY.exec(query);
  if (regex) {
    const flags = regex[2];
    if (flags.replace(/i/g, '').length) {
      throw new Error(`query regular expression accepts only the i flag, not "${flags}"`);
    }
    try {
      return { regex: new RegExp(regex[1], flags.includes('i') ? 'i' : ''), tokens: [] };
    } catch (error) {
      throw new Error(`query regular expression is invalid: ${(error as Error).message}`);
    }
  }
  return { tokens: query.toLowerCase().split(/\s+/).filter(Boolean) };
}

/** Whether one line of page text satisfies the query. */
export function browserQueryMatchesLine(plan: BrowserQueryPlan, line: string): boolean {
  if (plan.regex) return plan.regex.test(line);
  if (!plan.tokens.length) return true;
  const lowered = line.toLowerCase();
  return plan.tokens.some((token) => lowered.includes(token));
}

/** Self-contained element matcher, evaluated in the page for the DOM fallback
 *  and instantiated below for the host. Keep it free of module references. */
export const BROWSER_SEMANTIC_MATCH_SOURCE = `function(rawQuery, fields) {
  const compact = (value) => String(value == null ? '' : value).replace(/\\s+/g, ' ').trim();
  const query = compact(rawQuery);
  if (!query) return { field: 'name', score: 0, matched: 0, terms: 0 };
  const role = compact(fields.role).toLowerCase();
  const rolePriority = ({
    link: 40, button: 35, menuitem: 30, menuitemcheckbox: 30, menuitemradio: 30,
    tab: 25, option: 20, checkbox: 15, radio: 15, switch: 15, combobox: 10,
    listbox: 10, searchbox: 10, textbox: 10,
  })[role] || 0;
  const hrefText = (value) => {
    const raw = compact(value);
    if (!raw) return '';
    try {
      const parsed = new URL(raw);
      return compact(parsed.hostname + decodeURIComponent(parsed.pathname));
    } catch {
      return compact(raw.split(/[?#]/, 1)[0]);
    }
  };
  const candidates = [
    ['name', compact(fields.name), 400],
    ['value', compact(fields.value), 300],
    ['role', compact(fields.role), 200],
    ['href', hrefText(fields.href), role === 'link' ? 330 : 100],
  ];
  const regexForm = /^\\/(.+)\\/([a-z]*)$/s.exec(query);
  let regex = null;
  let tokens = [];
  if (regexForm) {
    try { regex = new RegExp(regexForm[1], regexForm[2].includes('i') ? 'i' : ''); } catch { return null; }
  } else {
    tokens = query.toLowerCase().split(/\\s+/).filter(Boolean);
  }
  const terms = regex ? [regex] : tokens;
  let best = null;
  let total = 0;
  let matched = 0;
  for (const term of terms) {
    let termBest = null;
    for (const [field, value, base] of candidates) {
      const lowered = value.toLowerCase();
      const hit = regex ? regex.test(value) : lowered.includes(term);
      if (!hit) continue;
      const bonus = regex ? 0 : (lowered === term ? 20 : lowered.startsWith(term) ? 10 : 0);
      const score = base + rolePriority + bonus;
      if (!termBest || score > termBest.score) termBest = { field, score };
    }
    if (!termBest) continue;
    matched += 1;
    total += termBest.score;
    if (!best || termBest.score > best.score) best = termBest;
  }
  if (!best) return null;
  return {
    field: best.field,
    score: total + (matched === terms.length ? 1000 : 0),
    matched,
    terms: terms.length,
  };
}`;

type SemanticMatcher = (
  queryValue: unknown,
  fields: { name?: unknown; value?: unknown; role?: unknown; href?: unknown },
) => BrowserSemanticMatch | null;

// The page and the host run the same source, so a ranking change lands in
// both places at once.
export const rankBrowserSemanticMatch: SemanticMatcher = new Function(
  `return (${BROWSER_SEMANTIC_MATCH_SOURCE})`,
)() as SemanticMatcher;
