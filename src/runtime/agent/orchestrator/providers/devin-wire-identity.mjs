// Model-class identity for Devin wire decisions: which backend family a model
// id names (Gemini tool-schema rules) and the thinking form another model's
// reasoning is demoted into when it replays as plain text.
//
// Class matchers rank exact(4) > bounded(3) > namespace(2) > prefix(1) >
// glob(0), token length breaking ties; an equal rank across two classes
// resolves to 'unknown'. A trailing effort/thinking suffix is collapsed off
// the id before matching.

const MATCHER_RANK = Object.freeze({ exact: 4, bounded: 3, namespace: 2, prefix: 1, glob: 0 });

// [class, [[kind, token, boundedNamespace?], ...]]
const CLASS_MATCHERS = Object.freeze([
  [
    'ai21',
    [
      ['bounded', 'jamba'],
      ['namespace', 'ai21'],
    ],
  ],
  [
    'amazon',
    [
      ['bounded', 'nova'],
      ['bounded', 'titan'],
      ['namespace', 'amazon', true],
    ],
  ],
  [
    'anthropic',
    [
      ['namespace', 'anthropic', true],
      ['bounded', 'anthropic'],
      ['bounded', 'claude'],
    ],
  ],
  ['baidu', [['bounded', 'ernie']]],
  ['bytedance', [['bounded', 'doubao']]],
  [
    'cohere',
    [
      ['bounded', 'command'],
      ['namespace', 'cohere'],
    ],
  ],
  [
    'deepseek',
    [
      ['namespace', 'deepseek', true],
      ['bounded', 'deepseek'],
    ],
  ],
  ['gemini', [['bounded', 'gemini']]],
  ['gemma', [['bounded', 'gemma']]],
  [
    'glm',
    [
      ['bounded', 'glm'],
      ['bounded', 'zai-glm'],
    ],
  ],
  [
    'gpt-oss',
    [
      ['namespace', 'gpt-oss', true],
      ['bounded', 'gpt-oss'],
    ],
  ],
  [
    'kimi',
    [
      ['namespace', 'moonshotai'],
      ['bounded', 'kimi'],
      ['exact', 'k3'],
      ['exact', 'k3-256k'],
    ],
  ],
  [
    'meta',
    [
      ['bounded', 'muse-spark'],
      ['bounded', 'muse-wonder'],
      ['bounded', 'llama'],
      ['bounded', 'meta-llama'],
      ['namespace', 'meta-llama'],
    ],
  ],
  ['mimo', [['bounded', 'mimo']]],
  [
    'minimax',
    [
      ['namespace', 'minimax'],
      ['bounded', 'minimax'],
      ['bounded', 'hailuo'],
    ],
  ],
  [
    'mistral',
    [
      ['bounded', 'mistral'],
      ['bounded', 'mixtral'],
    ],
  ],
  [
    'openai',
    [
      ['namespace', 'openai'],
      ['namespace', 'openai', true],
      ['prefix', 'gpt-'],
      ['prefix', 'chatgpt-'],
      ['prefix', 'codex-'],
      ['exact', 'o1'],
      ['prefix', 'o1-'],
      ['prefix', 'o1.'],
      ['exact', 'o3'],
      ['prefix', 'o3-'],
      ['prefix', 'o3.'],
      ['exact', 'o4'],
      ['prefix', 'o4-'],
      ['prefix', 'o4.'],
    ],
  ],
  [
    'qwen',
    [
      ['bounded', 'qwen'],
      ['bounded', 'deepseek-r1-distill-qwen'],
      ['glob', '*distill-qwen*'],
    ],
  ],
  ['stepfun', [['bounded', 'step']]],
  [
    'xai',
    [
      ['prefix', 'cursor-grok-'],
      ['bounded', 'grok'],
      ['namespace', 'x-ai'],
      ['namespace', 'xai', true],
    ],
  ],
]);

// Reviewed provider-agnostic identity overrides (exact bare id or glob).
const EXACT_OVERRIDES = Object.freeze(
  new Map([
    ['daybreak-blue-latest', 'unknown'],
    ['daybreak-red-latest', 'unknown'],
    ['gpt-daybreak-blue-latest', 'openai'],
    ['gpt-daybreak-red-latest', 'openai'],
  ])
);
const GLOB_OVERRIDES = Object.freeze([
  ['*bonsai-27b*', 'qwen'],
  ['*bonsai-2-27b*', 'qwen'],
]);

// Trailing variant suffixes collapsed off an id before class matching.
const COLLAPSE_SUFFIXES = Object.freeze([
  ['-thinking'],
  ['-extra-high'],
  ['-none'],
  ['-minimal'],
  ['-medium'],
  ['-xhigh'],
  ['-high'],
  ['-low'],
  ['-max', 'qwen'],
]);

function bareOf(id) {
  const slash = id.lastIndexOf('/');
  return slash === -1 ? id : id.slice(slash + 1);
}

function globMatch(pattern, value) {
  const segments = pattern.split('*');
  if (segments.length === 1) return value === pattern;
  const head = segments[0];
  if (!value.startsWith(head)) return false;
  let remainder = value.slice(head.length);
  for (let i = 1; i < segments.length - 1; i += 1) {
    const segment = segments[i];
    if (!segment) continue;
    const found = remainder.indexOf(segment);
    if (found === -1) return false;
    remainder = remainder.slice(found + segment.length);
  }
  const last = segments.at(-1);
  return last === '' || remainder.endsWith(last);
}

// `token` itself, or `token` followed by - _ . : or a digit.
function boundedMatch(value, token) {
  if (value === token) return true;
  if (!value.startsWith(token)) return false;
  const next = value.charCodeAt(token.length);
  return next === 45 || next === 95 || next === 46 || next === 58 || (next >= 48 && next <= 57);
}

function matcherMatches([kind, token, boundedNamespace], lower, bare) {
  switch (kind) {
    case 'exact':
      return bare === token;
    case 'bounded':
      return boundedMatch(bare, token);
    case 'namespace':
      return (boundedNamespace ? lower.split(/[/.:]/) : lower.split('/')).some(
        (part) => part && (boundedNamespace ? boundedMatch(part, token) : part === token)
      );
    case 'prefix':
      return bare.startsWith(token);
    default:
      return globMatch(token, bare);
  }
}

function classOfLogicalId(model) {
  const lower = model.trim().toLowerCase();
  const bare = bareOf(lower);
  let winner = null;
  let tied = false;
  for (const [cls, matchers] of CLASS_MATCHERS) {
    for (const matcher of matchers) {
      if (!matcherMatches(matcher, lower, bare)) continue;
      const rank = [MATCHER_RANK[matcher[0]], matcher[1].length];
      if (winner && winner.rank[0] === rank[0] && winner.rank[1] === rank[1] && winner.cls !== cls) {
        tied = true;
      } else if (!winner || winner.rank[0] < rank[0] || (winner.rank[0] === rank[0] && winner.rank[1] < rank[1])) {
        winner = { rank, cls };
        tied = false;
      }
    }
  }
  return tied || !winner ? 'unknown' : winner.cls;
}

function collapsedId(model) {
  const lower = model.toLowerCase();
  const bare = bareOf(lower);
  let winner = null;
  for (const [suffix, exceptBarePrefix] of COLLAPSE_SUFFIXES) {
    if (!lower.endsWith(suffix)) continue;
    if (exceptBarePrefix && bare.startsWith(exceptBarePrefix)) continue;
    if (!winner || suffix.length > winner.length) winner = suffix;
  }
  return winner ? model.slice(0, model.length - winner.length) : model;
}

/** The model class a wire or catalog id names ('gemini', 'anthropic', 'openai', …, or 'unknown'). */
export function devinModelClass(modelId) {
  const raw = String(modelId || '');
  const trimmed = raw.trim();
  const bare = bareOf(trimmed).toLowerCase();
  const exact = EXACT_OVERRIDES.get(bare);
  if (exact) return exact;
  const glob = GLOB_OVERRIDES.filter(([pattern]) => globMatch(pattern, bare)).sort(
    (a, b) => b[0].replaceAll('*', '').length - a[0].replaceAll('*', '').length
  );
  if (glob.length && !(glob[1] && glob[1][0].replaceAll('*', '').length === glob[0][0].replaceAll('*', '').length)) {
    return glob[0][1];
  }
  return classOfLogicalId(trimmed.length === raw.length ? collapsedId(trimmed) : trimmed);
}

/** Whether the catalog id or the concrete wire uid runs on a Gemini backend. */
export function isDevinGeminiModel(...ids) {
  return ids.some(
    (id) => typeof id === 'string' && (devinModelClass(id) === 'gemini' || id.startsWith('MODEL_GOOGLE_GEMINI_'))
  );
}

const isAsciiWhitespace = (code) =>
  code === 9 || code === 10 || code === 11 || code === 12 || code === 13 || code === 32;

function trimAsciiStart(text, start, end) {
  let cursor = start;
  while (cursor < end && isAsciiWhitespace(text.charCodeAt(cursor))) cursor += 1;
  return cursor;
}

function trimAsciiEnd(text, start, end) {
  let cursor = end;
  while (cursor > start && isAsciiWhitespace(text.charCodeAt(cursor - 1))) cursor -= 1;
  return cursor;
}

function delimitedClose(open, close, text, start, end) {
  let depth = 1;
  let cursor = start;
  while (cursor < end) {
    const nextClose = text.indexOf(close, cursor);
    if (nextClose < 0 || nextClose >= end) return -1;
    const nextOpen = text.indexOf(open, cursor);
    if (nextOpen >= 0 && nextOpen < nextClose) {
      depth += 1;
      cursor = nextOpen + open.length;
      continue;
    }
    depth -= 1;
    if (depth === 0) return nextClose;
    cursor = nextClose + close.length;
  }
  return -1;
}

// Text already wrapped in `open`…`close` blocks is unwrapped so it is not
// wrapped twice.
function unwrapDelimited(open, close, text) {
  const end = trimAsciiEnd(text, 0, text.length);
  let cursor = trimAsciiStart(text, 0, end);
  if (cursor >= end || !text.startsWith(open, cursor)) return text;
  const segments = [];
  while (cursor < end) {
    if (!text.startsWith(open, cursor)) return text;
    const innerStart = cursor + open.length;
    const innerEnd = delimitedClose(open, close, text, innerStart, end);
    if (innerEnd < 0) return text;
    const trimmedEnd = trimAsciiEnd(text, innerStart, innerEnd);
    const trimmedStart = trimAsciiStart(text, innerStart, trimmedEnd);
    segments.push(unwrapDelimited(open, close, text.slice(trimmedStart, trimmedEnd)));
    cursor = trimAsciiStart(text, innerEnd + close.length, end);
  }
  return segments.join('\n');
}

const THINK_BLOCK_CLASSES = new Set(['glm', 'kimi', 'qwen', 'deepseek', 'openai', 'gpt-oss', 'gemma']);

/**
 * Another model's reasoning as plain text in the target model's own thinking
 * form: bare prose for Claude (tagged reasoning is refused there), a fenced
 * ```thinking block for Gemini, <think> for the <think>-dialect families, and
 * <thinking> otherwise. No trailing delimiter.
 */
export function devinDemotedThinking(targetModelId, text) {
  if (!text) return '';
  const value = text.toWellFormed();
  const cls = devinModelClass(targetModelId);
  if (cls === 'anthropic') return value;
  if (cls === 'gemini') return `\`\`\`thinking\n${value}\n\`\`\``;
  if (THINK_BLOCK_CLASSES.has(cls)) return `<think>\n${value}\n</think>`;
  return `<thinking>\n${unwrapDelimited('<thinking>', '</thinking>', value)}\n</thinking>`;
}
