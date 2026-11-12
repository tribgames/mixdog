// Which shell commands the built-in tools cover whole. A statement is covered
// only when its command, every flag and every operand are on the allow-list
// below, each entry of which has a replacement call that returns the same
// information; everything else (an unknown flag or filter, a filter that
// computes or writes, a wildcard, a variable, several paths, a device, a path
// the tool would read differently, a value outside the replacement's schema)
// is not covered and keeps running in the shell. The replacement text is the
// parsed form itself, checked against the replacing tool's input schema.
//
// Covered forms (P = one plain path to an existing regular text file; N = 1..500):
//   read:   cat P                      → read {file_path}        (file ≤ 16 KiB and ≤ 500 lines, UTF-8 without BOM)
//           head [-n] N P / head P     → read {file_path, limit}
//           tail [-n] N P / tail P     → read {file_path, tail}
//           tail -n +K P               → read {file_path, offset} (same size bound as cat)
//           Get-Content|gc|cat|type [-Path|-LiteralPath] P [-TotalCount|-First|-Head N | -Tail|-Last N]
//           <a read above, no window> | head [-n] N | tail [-n] N | Select-Object -First N | -Last N
//   search: grep|rg [-i] [-n] PATTERN P, Select-String [-Pattern] PATTERN [-Path] P [-CaseSensitive],
//           and `<plain read of P> | grep PATTERN` / `| Select-String PATTERN`  → grep {pattern, path, context:0, limit:0}
//           (PATTERN: letters, digits, space and . : = @ % / - only, so grep, .NET and Rust regex agree;
//           P within cat's size bound, so every match is returned)
//   list:   ls D (D a directory of ≤ 100 entries, none a pruned dependency folder)  → list {path}
// Not covered, by decision:
//   git — the git tool answers a status in its short form, caps a log and a diff, and reports an exit code
//         as text, so no git command is the same information there;
//   any redirect — `> /dev/null`, `2>$null` and `2>&1` change what the command returns;
//   more than one statement — after `&&` the second runs only if the first succeeded (a search that finds
//         nothing fails), which separate tool calls do not keep.
import { isUtf8 } from 'node:buffer';
import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { shellSplitPipelineSegments, shellSplitSegments, shellTokenize } from '../shell-analysis.mjs';
import { BUILTIN_TOOLS } from '../builtin-tools.mjs';
import { hasUnsafeWin32Component, isBlockedDevicePath, isUncPath, isWindowsDevicePath } from '../device-paths.mjs';
import { NOISE_DIR_NAMES } from '../glob-walk.mjs';
import { normalizeInputPath } from '../path-utils.mjs';

// A later pipeline stage that only shapes text. Used by the guard's note for
// reads that are not covered; coverage itself accepts a far narrower set.
export const TEXT_FILTERS = new Set([
  'select-object',
  'select',
  'select-string',
  'sls',
  'where-object',
  'sort-object',
  'sort',
  'measure-object',
  'format-table',
  'format-list',
  'ft',
  'fl',
  'out-string',
  'out-host',
  'head',
  'tail',
  'grep',
  'egrep',
  'rg',
  'wc',
  'uniq',
  'cut',
  'findstr',
]);

export const commandName = (token) =>
  String(token ?? '')
    .toLowerCase()
    .replace(/^.*[\\/]/, '')
    .replace(/\.exe$/, '');

// The read tool's default window; a covered window never exceeds it, so the
// replacement is never paged where the command was not.
const WINDOW_MAX = 500;
const WHOLE_FILE_BYTES = 16 * 1024;
const PEEK_BYTES = 8 * 1024;
const LIST_MAX = 100;
const SIMPLE_PATTERN = /^\w[\w .:=@%/-]*$/;

// Shell-significant or wildcard characters a covered path may not contain.
const UNSAFE_PATH = /[*?[\]{}$`,;|&<>()]/;
// The read tool takes `path:12` and `path#L12` as a line coordinate.
const LINE_COORDINATE = /#L\d|:\d+(?:-\d+)?(?::|$)/i;

// Shell syntax the tools cannot reproduce: background/substitution/grouping/
// redirection/variables, a comment, or an unterminated quote. Single quotes
// hide everything; double quotes still expand `$` and backticks.
function hasShellSyntax(text, shellType) {
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (quote === '"' && (ch === '$' || ch === '`')) return true;
      continue;
    }
    if (ch === '\\' && shellType !== 'powershell') {
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    else if ('&<>(){}$`'.includes(ch) || (ch === '#' && (i === 0 || /\s/.test(text[i - 1])))) return true;
  }
  return quote !== null;
}

// `||` outside quotes: the second statement's running depends on the first's failure.
function hasOrOperator(text) {
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === "'" || ch === '"') quote = ch;
    else if (ch === '|' && text[i + 1] === '|') return true;
  }
  return false;
}

const isFlag = (token) => token.startsWith('-') && token.length > 1 && !/^-\d+$/.test(token);
const windowCount = (value) => (/^\d+$/.test(String(value)) && Number(value) >= 1 && Number(value) <= WINDOW_MAX ? Number(value) : null);

// ── files ────────────────────────────────────────────────────────────────────

// One literal path the read/grep/list tools would open as the very same file or
// directory, or null. `kind` is 'file' or 'dir'.
function plainPath(token, base, kind) {
  if (typeof token !== 'string' || token === '' || isFlag(token) || token === '--') return null;
  if (/^[~@]/.test(token) || UNSAFE_PATH.test(token)) return null;
  if (normalizeInputPath(token) !== token) return null;
  if (LINE_COORDINATE.test(token.replace(/^[A-Za-z]:/, ''))) return null;
  const full = resolve(base, token);
  for (const candidate of [token, full]) {
    if (
      isUncPath(candidate) ||
      isWindowsDevicePath(candidate) ||
      hasUnsafeWin32Component(candidate) ||
      isBlockedDevicePath(candidate)
    ) {
      return null;
    }
  }
  try {
    const stat = statSync(full);
    return (kind === 'file' ? stat.isFile() : stat.isDirectory()) ? { path: token, full, size: stat.size } : null;
  } catch {
    return null;
  }
}

function headBytes(full) {
  const fd = openSync(full, 'r');
  try {
    const buffer = Buffer.alloc(PEEK_BYTES);
    return buffer.subarray(0, readSync(fd, buffer, 0, PEEK_BYTES, 0));
  } finally {
    closeSync(fd);
  }
}

const hasUtf8Bom = (bytes) => bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
// Text the tools and the shell show alike: no NUL (binary / UTF-16) and no BOM.
const isPlainText = (bytes) => !bytes.includes(0) && !hasUtf8Bom(bytes);

// A file the read tool returns in one window with nothing dropped.
function isWholeFile(file) {
  if (file.size > WHOLE_FILE_BYTES) return false;
  const bytes = readFileSync(file.full);
  if (!isPlainText(bytes) || !isUtf8(bytes)) return false;
  // A last line without its newline is a line too.
  const newlines = bytes.reduce((count, byte) => count + (byte === 0x0a ? 1 : 0), 0);
  const unterminated = bytes.length > 0 && bytes[bytes.length - 1] !== 0x0a ? 1 : 0;
  return newlines + unterminated <= WINDOW_MAX;
}

// ── schemas ──────────────────────────────────────────────────────────────────

function conforms(value, schema) {
  if (schema.anyOf) return schema.anyOf.some((option) => conforms(value, option));
  if (schema.enum && !schema.enum.includes(value)) return false;
  switch (schema.type) {
    case 'string':
      return (
        typeof value === 'string' &&
        value.length >= (schema.minLength ?? 0) &&
        (!schema.pattern || new RegExp(schema.pattern).test(value))
      );
    case 'integer':
      return (
        Number.isInteger(value) &&
        value >= (schema.minimum ?? -Infinity) &&
        value <= (schema.maximum ?? Infinity)
      );
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return (
        Array.isArray(value) &&
        value.length >= (schema.minItems ?? 0) &&
        value.length <= (schema.maxItems ?? Infinity) &&
        value.every((item) => conforms(item, schema.items ?? {}))
      );
    case 'object': {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
      if ((schema.required ?? []).some((key) => !(key in value))) return false;
      return Object.entries(value).every(([key, item]) =>
        schema.properties?.[key] ? conforms(item, schema.properties[key]) : schema.additionalProperties !== false
      );
    }
    default:
      return true;
  }
}

const callIsValid = (call) => {
  const tool = BUILTIN_TOOLS.find((candidate) => candidate.name === call.tool);
  return Boolean(tool) && conforms(call.args, tool.inputSchema);
};

// ── read ─────────────────────────────────────────────────────────────────────

// `head` / `tail` flags: { first, last, skip, operands } or null for anything else.
function countWindow(name, args) {
  const out = { first: null, last: null, skip: null, operands: [] };
  let counted = false;
  const take = (text) => {
    if (counted) return false;
    counted = true;
    if (text.startsWith('+')) {
      if (name !== 'tail' || !/^\+[1-9]\d*$/.test(text)) return false;
      out.skip = Number(text.slice(1));
      return true;
    }
    const count = windowCount(text);
    if (count === null) return false;
    out[name === 'head' ? 'first' : 'last'] = count;
    return true;
  };
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    const attached = /^-n?(\d+)$/.exec(token) ?? /^-n(\+\d+)$/.exec(token);
    if (attached) {
      if (!take(attached[1])) return null;
    } else if (token === '-n') {
      if (args[i + 1] === undefined || !/^\+?\d+$/.test(args[i + 1]) || !take(args[++i])) return null;
    } else if (isFlag(token)) return null;
    else out.operands.push(token);
  }
  if (!counted) out[name === 'head' ? 'first' : 'last'] = 10;
  return out;
}

// What a read statement asks for: { kind: 'read', file, first, last, skip }.
function readSpec(name, args, powershell) {
  if (!powershell) {
    if (name === 'cat') {
      return args.length === 1 ? { kind: 'read', file: args[0], first: null, last: null, skip: null } : null;
    }
    const window = countWindow(name, args);
    return window?.operands.length === 1 ? { kind: 'read', file: window.operands[0], ...window } : null;
  }
  const spec = { kind: 'read', file: null, first: null, last: null, skip: null };
  const setFile = (value) => {
    if (spec.file !== null || value === undefined) return false;
    spec.file = value;
    return true;
  };
  const setCount = (key, value) => {
    if (spec[key] !== null || windowCount(value) === null) return false;
    spec[key] = windowCount(value);
    return true;
  };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i].toLowerCase();
    if (flag === '-path' || flag === '-literalpath') {
      if (!setFile(args[++i])) return null;
    } else if (flag === '-totalcount' || flag === '-first' || flag === '-head') {
      if (!setCount('first', args[++i])) return null;
    } else if (flag === '-tail' || flag === '-last') {
      if (!setCount('last', args[++i])) return null;
    } else if (isFlag(args[i]) || !setFile(args[i])) return null;
  }
  return spec.file !== null && !(spec.first !== null && spec.last !== null) ? spec : null;
}

// ── search ───────────────────────────────────────────────────────────────────

// `grep|rg [-i] [-n] PATTERN FILE` and `Select-String` spellings: { kind: 'search', file, pattern, ignoreCase }.
function searchSpec(name, args, powershell) {
  let pattern = null;
  let file = null;
  let ignoreCase = powershell;
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    const flag = token.toLowerCase();
    if (powershell) {
      if (flag === '-pattern') {
        if (pattern !== null || args[i + 1] === undefined) return null;
        pattern = args[++i];
      } else if (flag === '-path' || flag === '-literalpath') {
        if (file !== null || args[i + 1] === undefined) return null;
        file = args[++i];
      } else if (flag === '-casesensitive') ignoreCase = false;
      else if (isFlag(token)) return null;
      else positional.push(token);
    } else if (/^-[in]+$/.test(token)) ignoreCase ||= token.includes('i');
    else if (isFlag(token)) return null;
    else positional.push(token);
  }
  if (pattern === null) pattern = positional.shift();
  if (file === null) file = positional.shift();
  if (positional.length > 0 || pattern === undefined || file === undefined) return null;
  return { kind: 'search', file, pattern, ignoreCase };
}

// A pipeline stage after a read of one file: a window or a search of the same file.
function filterSpec(spec, stage, powershell) {
  if (spec.kind !== 'read' || spec.first !== null || spec.last !== null || spec.skip !== null) return null;
  const tokens = shellTokenize(stage);
  if (!tokens?.length) return null;
  const name = commandName(tokens[0]);
  const rest = tokens.slice(1);
  if (!powershell && (name === 'head' || name === 'tail')) {
    const window = countWindow(name, rest);
    if (!window || window.operands.length > 0 || window.skip !== null) return null;
    return { ...spec, first: window.first, last: window.last };
  }
  if (powershell && (name === 'select-object' || name === 'select')) {
    const flag = rest[0]?.toLowerCase();
    const count = windowCount(rest[1]);
    if (rest.length !== 2 || count === null || (flag !== '-first' && flag !== '-last')) return null;
    return { ...spec, first: flag === '-first' ? count : null, last: flag === '-last' ? count : null };
  }
  const searches = powershell ? ['select-string', 'sls'] : ['grep'];
  if (searches.includes(name) && rest.length === 1 && !isFlag(rest[0])) {
    return { kind: 'search', file: spec.file, pattern: rest[0], ignoreCase: powershell };
  }
  return null;
}

// The call for a parsed read or search, or null when the files or the pattern are not exactly covered.
function callFor(spec, base) {
  const file = plainPath(spec.file, base, 'file');
  if (!file || !isPlainText(headBytes(file.full))) return null;
  if (spec.kind === 'search') {
    // Every match of a file this small fits one unpaged answer.
    if (!SIMPLE_PATTERN.test(spec.pattern) || !isWholeFile(file)) return null;
    return {
      tool: 'grep',
      args: { pattern: spec.ignoreCase ? `(?i)${spec.pattern}` : spec.pattern, path: spec.file, context: 0, limit: 0 },
    };
  }
  if (spec.first !== null) return { tool: 'read', args: { file_path: spec.file, limit: spec.first } };
  if (spec.last !== null) return { tool: 'read', args: { file_path: spec.file, tail: spec.last } };
  if (!isWholeFile(file)) return null;
  return {
    tool: 'read',
    args: spec.skip === null ? { file_path: spec.file } : { file_path: spec.file, offset: spec.skip },
  };
}

// ── list ─────────────────────────────────────────────────────────────────────

// `ls D`: the list tool shows the same entries when D has no dotfile-independent difference
// (a pruned dependency folder) and fits one page.
function listCall(args, base) {
  if (args.length !== 1) return null;
  const dir = plainPath(args[0], base, 'dir');
  if (!dir) return null;
  const names = readdirSync(dir.full).filter((entry) => !entry.startsWith('.'));
  if (names.length > LIST_MAX || names.some((entry) => NOISE_DIR_NAMES.has(entry))) return null;
  return { tool: 'list', args: { path: args[0] } };
}

// ── statements and commands ──────────────────────────────────────────────────

const READERS = {
  powershell: new Set(['get-content', 'gc', 'cat', 'type']),
  posix: new Set(['cat', 'head', 'tail']),
};
const SEARCHERS = {
  powershell: new Set(['select-string', 'sls']),
  posix: new Set(['grep', 'rg']),
};

// The tool call replacing one statement, or null when it is not covered.
function coverStatement(statement, shellType, base) {
  const powershell = shellType === 'powershell';
  const stages = shellSplitPipelineSegments(statement);
  if (stages.length === 0) return null;
  const firstTokens = shellTokenize(stages[0]);
  if (!firstTokens?.length) return null;
  const text = statement.trim();
  const plainStages = stages;
  if (plainStages.length === 0 || plainStages.some((stage) => hasShellSyntax(stage, shellType))) return null;
  // The tokenizer reads `\*` as an escaped star, but in PowerShell it is a path separator and a wildcard.
  if (powershell && /\\[*?]/.test(text)) return null;
  const tokens = shellTokenize(plainStages[0]);
  const name = commandName(tokens[0]);
  const args = tokens.slice(1);
  if (name === 'ls' && !powershell) return plainStages.length === 1 ? listCall(args, base) : null;
  let spec = null;
  if (READERS[powershell ? 'powershell' : 'posix'].has(name)) spec = readSpec(name, args, powershell);
  else if (SEARCHERS[powershell ? 'powershell' : 'posix'].has(name)) spec = searchSpec(name, args, powershell);
  if (!spec || plainStages.length > 2) return null;
  if (plainStages.length === 2) spec = filterSpec(spec, plainStages[1], powershell);
  return spec ? callFor(spec, base) : null;
}

/**
 * The tool call that replaces `command` (a one-element list), or null when the
 * command is more than one statement or its statement is not on the
 * allow-list. Relative paths are judged against `cwd`.
 */
export function coveringToolCalls(command, shellType, { cwd = process.cwd() } = {}) {
  const text = String(command ?? '');
  if (hasOrOperator(text)) return null;
  const statements = shellSplitSegments(text);
  if (statements.length !== 1) return null;
  // The splitters drop a dangling operator (`cat f &&`, `cat f |`), which the
  // shell refuses as a syntax error: the one statement must be the whole text.
  if (statements[0].trim() !== text.trim() || /[|&]\s*$/.test(text)) return null;
  try {
    const call = coverStatement(statements[0], shellType, cwd);
    return call && callIsValid(call) ? [call] : null;
  } catch {
    // A file that cannot be inspected is not one the tools are known to read the same way.
    return null;
  }
}
