/**
 * Request interception rules.
 *
 * Chromium pauses a request that matches a rule and this module decides what
 * answers it: a refusal, or a mocked response. That reaches the states a live
 * network cannot be asked for on demand — a dead dependency, a 500, an empty
 * list — so a page's failure handling can be driven instead of described.
 *
 * The host owns the CDP wiring; this module owns the rule table, the matching,
 * and how a rule is reported back.
 */
import type { WebContents } from 'electron';

import type { BrowserCommand, BrowserCommandResult } from './command';

const MAX_RULES_PER_PAGE = 10;
const MAX_BODY_CHARS = 64 * 1024;
const MAX_PATTERN_CHARS = 400;

export interface BrowserInterceptRule {
  id: string;
  pattern: string;
  matcher: RegExp;
  resourceTypes: string[];
  abort: boolean;
  body: string;
  hits: number;
}

export interface BrowserFetchPattern {
  urlPattern: string;
  requestStage: 'Request' | 'Response';
}

/** Wildcard pattern to anchored matcher. A pattern without a wildcard is
 *  treated as a substring, which is how a caller reads "*\/api\/*" anyway. */
function patternMatcher(pattern: string): RegExp {
  const escaped = pattern.replace(
    /[.*+?^${}()|[\]\\]/g,
    (character) => (character === '*' ? '\u0000' : `\\${character}`),
  );
  return new RegExp(`^${escaped.split('\u0000').join('.*')}$`, 'i');
}

function normalizedPattern(raw: string): string {
  const pattern = raw.trim();
  if (pattern.length > MAX_PATTERN_CHARS) {
    throw new Error(`intercept url pattern is limited to ${MAX_PATTERN_CHARS} characters`);
  }
  return pattern.includes('*') ? pattern : `*${pattern}*`;
}

function describeRule(rule: BrowserInterceptRule): string {
  const scope = rule.resourceTypes.length ? ` (${rule.resourceTypes.join(', ')})` : '';
  const hits = `${rule.hits} hit${rule.hits === 1 ? '' : 's'}`;
  if (rule.abort) return `[${rule.id}] abort ${rule.pattern}${scope} — ${hits}`;
  const size = `${Buffer.byteLength(rule.body, 'utf8')} bytes`;
  return `[${rule.id}] replace body ${size} ${rule.pattern}${scope} — ${hits}`;
}

/**
 * Params for replacing a response payload.
 *
 * Only the body carries: fulfilling through Electron's guest debugger keeps the
 * real response's status line and headers, and a supplied status is dropped
 * rather than applied. The protocol still requires responseCode, so it is sent
 * and then ignored by Chromium — which is why a rule promises a replaced
 * payload and never a synthetic status.
 */
export function interceptFulfillParams(
  rule: BrowserInterceptRule,
  requestId: string,
): Record<string, unknown> {
  return {
    requestId,
    responseCode: 200,
    body: Buffer.from(rule.body, 'utf8').toString('base64'),
  };
}

export function createBrowserIntercept() {
  const rulesByGuest = new WeakMap<WebContents, Map<string, BrowserInterceptRule>>();
  let sequence = 0;

  function rulesFor(guest: WebContents): Map<string, BrowserInterceptRule> {
    let rules = rulesByGuest.get(guest);
    if (!rules) {
      rules = new Map();
      rulesByGuest.set(guest, rules);
    }
    return rules;
  }

  function listText(rules: Map<string, BrowserInterceptRule>): string {
    if (!rules.size) return 'No intercept rules are active on this page.';
    return `Intercept rules (${rules.size}):\n${[...rules.values()].map(describeRule).join('\n')}`;
  }

  /** Patterns the host hands to Fetch.enable. Resource types stay out of them
   *  on purpose: CDP spells them differently from the tool surface, and the
   *  match below filters the paused request anyway. */
  function interceptFetchPatterns(guest: WebContents): BrowserFetchPattern[] {
    return [...rulesFor(guest).values()].map((rule) => ({
      urlPattern: rule.pattern,
      // A refusal must land before the request leaves, while a mock is applied
      // once Chromium already holds a response to replace — replacing one is
      // what carries the mocked status line through to the page.
      requestStage: rule.abort ? ('Request' as const) : ('Response' as const),
    }));
  }

  function matchInterceptRule(
    guest: WebContents,
    url: string,
    resourceType: string,
  ): BrowserInterceptRule | undefined {
    const type = String(resourceType || '').toLowerCase();
    for (const rule of rulesFor(guest).values()) {
      if (!rule.matcher.test(url)) continue;
      if (rule.resourceTypes.length && !rule.resourceTypes.includes(type)) continue;
      rule.hits += 1;
      return rule;
    }
    return undefined;
  }

  function hasInterceptRules(guest: WebContents): boolean {
    return rulesFor(guest).size > 0;
  }

  async function applyRuleMutation(
    rules: Map<string, BrowserInterceptRule>,
    mutate: () => void,
    applyFetchPatterns: () => Promise<void>,
  ): Promise<void> {
    const previous = new Map(rules);
    mutate();
    try {
      await applyFetchPatterns();
    } catch (error) {
      rules.clear();
      for (const [id, rule] of previous) rules.set(id, rule);
      throw error;
    }
  }

  async function interceptResult(
    guest: WebContents,
    command: BrowserCommand,
    applyFetchPatterns: () => Promise<void>,
  ): Promise<BrowserCommandResult> {
    const operation = String(command.operation || 'list').trim().toLowerCase();
    const rules = rulesFor(guest);
    if (operation === 'list') return { text: listText(rules) };

    if (operation === 'add') {
      if (rules.size >= MAX_RULES_PER_PAGE) {
        throw new Error(
          `this page already holds ${MAX_RULES_PER_PAGE} intercept rules; remove one before adding another`,
        );
      }
      const pattern = normalizedPattern(String(command.url || ''));
      if (!pattern) throw new Error('intercept add requires url');
      const abort = command.abort === true;
      const body = abort ? '' : String(command.body ?? '');
      if (body.length > MAX_BODY_CHARS) {
        throw new Error(`intercept body is limited to ${MAX_BODY_CHARS} characters`);
      }
      const resourceTypes = (command.resourceTypes || []).map(
        (type) => String(type).toLowerCase(),
      );
      sequence += 1;
      const id = `i${sequence}`;
      const rule: BrowserInterceptRule = {
        id,
        pattern,
        matcher: patternMatcher(pattern),
        resourceTypes,
        abort,
        body,
        hits: 0,
      };
      await applyRuleMutation(rules, () => rules.set(id, rule), applyFetchPatterns);
      return {
        text: 'Intercepting from now on. Requests already in flight keep their original answer, '
          + 'and a replaced payload arrives under the response the server actually returned.\n\n'
          + listText(rules),
      };
    }

    if (operation === 'remove') {
      const id = String(command.ruleId || '').trim();
      if (!rules.has(id)) {
        throw new Error(`unknown intercept rule ${id || '(empty)'}; list intercept to see current ids`);
      }
      await applyRuleMutation(rules, () => {
        rules.delete(id);
      }, applyFetchPatterns);
      return { text: `Removed intercept rule ${id}.\n\n${listText(rules)}` };
    }

    if (operation === 'clear') {
      const removed = rules.size;
      await applyRuleMutation(rules, () => rules.clear(), applyFetchPatterns);
      return { text: `Removed ${removed} intercept rule(s).` };
    }

    throw new Error('intercept operation must be add, remove, list, or clear');
  }

  return {
    interceptResult,
    interceptFetchPatterns,
    matchInterceptRule,
    hasInterceptRules,
  };
}
