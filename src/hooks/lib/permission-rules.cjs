'use strict';
/**
 * permission-rules.cjs
 * Pattern matcher and priority evaluator. Priority order and Tool(content)
 * parsing mirror Claude Code native logic; specifier matching uses a local
 * path/command glob (native delegates per-tool content matching to each tool).
 *
 * Priority (highest → lowest): deny > ask > allow > mode default
 *
 * Pattern forms:
 *   mcp__*              → toolName starts with "mcp__"
 *   ToolName            → exact toolName match (no parens)
 *   ToolName(*)         → toolName matches AND specifier glob matches any
 *   ToolName(specifier) → toolName matches AND specifier glob matches
 *                         toolInput.path / .command / .file
 *   Glob chars: * (any chars within segment), ** (any segments)
 *
 * No external deps; no eval/Function.
 */

// Read-only tool set (mixdog tool names).
const READ_ONLY_TOOLS = new Set([
  'read', 'list', 'glob', 'grep', 'find_symbol', 'find_references', 'find_callers', 'explore',
  'recall', 'search', 'fetch', 'web_fetch',
  'schedule_status', 'list_models', 'job_wait', 'download_attachment',
]);

/**
 * Find the index of the first/last UNescaped occurrence of a char.
 * A char is escaped when preceded by an odd number of backslashes.
 * Mirrors native permissionRuleParser.findFirst/LastUnescapedChar.
 */
function findFirstUnescapedChar(str, char) {
  for (let i = 0; i < str.length; i++) {
    if (str[i] !== char) continue;
    let bs = 0, j = i - 1;
    while (j >= 0 && str[j] === '\\') { bs++; j--; }
    if (bs % 2 === 0) return i;
  }
  return -1;
}

function findLastUnescapedChar(str, char) {
  for (let i = str.length - 1; i >= 0; i--) {
    if (str[i] !== char) continue;
    let bs = 0, j = i - 1;
    while (j >= 0 && str[j] === '\\') { bs++; j--; }
    if (bs % 2 === 0) return i;
  }
  return -1;
}

/** Reverse escapeRuleContent: \( -> (, \) -> ), \\ -> \ (order matters). */
function unescapeRuleContent(content) {
  return content
    .replace(/\\\(/g, '(')
    .replace(/\\\)/g, ')')
    .replace(/\\\\/g, '\\');
}

/**
 * Convert a glob pattern string to a RegExp.
 * Supports: * (non-slash wildcard), ** (any), ? (single char).
 * Safe: no eval.
 */
function globToRegex(glob) {
  let src = '';
  let i = 0;
  while (i < glob.length) {
    const ch = glob[i];
    if (ch === '*' && glob[i + 1] === '*') {
      src += '.*';
      i += 2;
      if (glob[i] === '/') i++; // consume trailing slash
    } else if (ch === '*') {
      src += '[^/\\\\]*';
      i++;
    } else if (ch === '?') {
      src += '[^/\\\\]';
      i++;
    } else {
      // Escape regex metacharacters
      src += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
      i++;
    }
  }
  return new RegExp('^' + src + '$', 'i');
}

/**
 * Match a single pattern entry against (toolName, toolInput).
 * Returns true if the pattern applies.
 */
function matchesPattern(pattern, toolName, toolInput) {
  if (typeof pattern !== 'string') return false;

  // Detect Tool(specifier) form. Escape-aware, mirroring native
  // permissionRuleValueFromString: only UNescaped parens delimit the
  // specifier, and the close paren must be the final char.
  const parenIdx = findFirstUnescapedChar(pattern, '(');
  const closeIdx = findLastUnescapedChar(pattern, ')');
  if (parenIdx > 0 && closeIdx === pattern.length - 1 && closeIdx > parenIdx) {
    const namePart = pattern.slice(0, parenIdx);
    const rawSpecifier = pattern.slice(parenIdx + 1, closeIdx);

    if (toolName !== namePart) return false;

    // Empty "()" or wildcard "(*)" specifier → tool-wide rule, match any
    if (rawSpecifier === '' || rawSpecifier === '*') return true;

    // Unescape \( \) before glob matching
    const specifier = unescapeRuleContent(rawSpecifier);
    // Match specifier against known path-bearing fields
    const specRe = globToRegex(specifier);
    const inp = toolInput || {};
    const candidates = [...new Set([
      inp.path, inp.command, inp.file, inp.file_path, inp.base_path, inp.cwd,
      ...(Array.isArray(inp.path)      ? inp.path.map(p => (p && typeof p === 'object' ? p.path : p)) : []),
      ...(Array.isArray(inp.reads)     ? inp.reads.map(r => r?.path)                              : []),
      ...(Array.isArray(inp.edits)     ? inp.edits.flatMap(e => [e?.path, e?.file_path])          : []),
      ...(Array.isArray(inp.writes)    ? inp.writes.flatMap(w => [w?.path, w?.file_path])         : []),
    ].filter(v => typeof v === 'string'))];

    return candidates.some(c => specRe.test(c));
  }

  // Prefix wildcard: e.g. "mcp__*"
  if (pattern.endsWith('*')) {
    const prefix = pattern.slice(0, -1);
    return toolName.startsWith(prefix);
  }

  // Glob on toolName itself (may contain * or **)
  if (pattern.includes('*') || pattern.includes('?')) {
    return globToRegex(pattern).test(toolName);
  }

  // Exact match
  return toolName === pattern;
}

/**
 * Evaluate priority rules against a tool call.
 *
 * @param {string}   toolName
 * @param {object}   toolInput
 * @param {string[]} allowList
 * @param {string[]} denyList
 * @param {string[]} askList
 * @returns {'deny'|'ask'|'allow'|null}  null = no list matched (use mode default)
 */
function evaluateRules(toolName, toolInput, allowList, denyList, askList) {
  if (denyList.some(p => matchesPattern(p, toolName, toolInput))) return 'deny';
  if (askList.some(p => matchesPattern(p, toolName, toolInput)))  return 'ask';
  if (allowList.some(p => matchesPattern(p, toolName, toolInput))) return 'allow';
  return null;
}

/**
 * Determine whether a tool is considered read-only.
 * For mcp__ tools: strip the mcp__ prefix chain and check the short tool name.
 */
function isReadOnlyTool(toolName) {
  // Strip mcp__plugin_...__  prefix (one or more double-underscore segments)
  const parts = toolName.split('__');
  const shortName = parts[parts.length - 1];
  return READ_ONLY_TOOLS.has(shortName);
}

module.exports = { matchesPattern, evaluateRules, isReadOnlyTool, READ_ONLY_TOOLS };
