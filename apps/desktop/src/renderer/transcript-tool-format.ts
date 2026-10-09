import { t, tExisting } from './i18n';
import { formatElapsed, oneLine } from './text-format';
import { boundedTextOf } from './transcript-tool-core';

// Getters: each read resolves in the ACTIVE language, not the boot language.
export const TOOL_DETAIL_LABELS = {
  get arguments() {
    return t('Arguments');
  },
  get before() {
    return t('Before');
  },
  get after() {
    return t('After');
  },
  get answer() {
    return t('Answer');
  },
  get questions() {
    return t('Questions');
  },
  get todos() {
    return t('Todos');
  },
  get plan() {
    return t('Plan');
  },
  get running() {
    return t('Running');
  },
  get completed() {
    return t('Completed');
  },
  get failed() {
    return t('Failed');
  },
  get targets() {
    return t('Targets');
  },
  get prompt() {
    return t('Prompt');
  },
};

const TOOL_ACTIVITY_CODE_LANGUAGES = new Map([
  ['ts', 'ts'],
  ['tsx', 'tsx'],
  ['mts', 'ts'],
  ['cts', 'ts'],
  ['js', 'js'],
  ['jsx', 'jsx'],
  ['mjs', 'js'],
  ['cjs', 'js'],
  ['json', 'json'],
  ['jsonc', 'json'],
  ['json5', 'json'],
  ['css', 'css'],
  ['scss', 'scss'],
  ['less', 'less'],
  ['html', 'html'],
  ['htm', 'html'],
  ['xml', 'xml'],
  ['svg', 'xml'],
  ['md', 'markdown'],
  ['markdown', 'markdown'],
  ['mdx', 'markdown'],
  ['py', 'python'],
  ['rb', 'ruby'],
  ['php', 'php'],
  ['java', 'java'],
  ['kt', 'kotlin'],
  ['kts', 'kotlin'],
  ['swift', 'swift'],
  ['go', 'go'],
  ['rs', 'rust'],
  ['c', 'c'],
  ['h', 'c'],
  ['cpp', 'cpp'],
  ['cc', 'cpp'],
  ['hpp', 'cpp'],
  ['cs', 'csharp'],
  ['sql', 'sql'],
  ['lua', 'lua'],
  ['sh', 'bash'],
  ['bash', 'bash'],
  ['zsh', 'bash'],
  ['ps1', 'powershell'],
  ['psm1', 'powershell'],
  ['yml', 'yaml'],
  ['yaml', 'yaml'],
  ['toml', 'toml'],
  ['ini', 'ini'],
  ['dockerfile', 'dockerfile'],
  ['gradle', 'gradle'],
  ['vue', 'html'],
  ['svelte', 'html'],
]);

export function toolActivityCodeLanguage(pathText: string): string {
  const name = String(pathText || '')
    .trim()
    .replace(/[\\/]+$/, '');
  if (!name) return '';
  const base = name.split(/[\\/]/).pop() || '';
  if (/^dockerfile$/i.test(base)) return 'dockerfile';
  const extension = /\.([A-Za-z0-9]+)$/.exec(base);
  return extension ? TOOL_ACTIVITY_CODE_LANGUAGES.get(extension[1].toLowerCase()) || '' : '';
}

export const TOOL_ACTIVITY_INTERNAL_ARGS = new Set(['categoryOrder', 'loadingTargets', 'agentBatch', 'verifyShell']);

/** Knobs that bound a call (how much, how long) rather than say what it did.
 *  They are never shown: a row of "Limit 45 · Timeout 10s" told the reader
 *  nothing about the work. */
export const TOOL_ACTIVITY_OPERATIONAL_ARGS = new Set([
  'limit',
  'head_limit',
  'output_limit',
  'max_results',
  'offset',
  'timeout',
  'timeout_ms',
  'wait_ms',
]);

export const TOOL_ACTIVITY_BULK_ARGS = new Set([
  'old_string',
  'new_string',
  'oldString',
  'newString',
  'old_str',
  'new_str',
  'content',
  'patch',
]);

const TOOL_ACTIVITY_SECRET_ARG = /(?:password|secret|token|api[_-]?key|authorization|cookie)/i;
export const TOOL_ACTIVITY_ROUTINE_RESULT =
  /^(?:ok|done|success(?:ful)?|completed|finished|updated|written|applied|saved|loaded|cancelled)[.!]?$/i;
export const TOOL_ACTIVITY_MEANINGLESS_RESULT =
  /^(?:ok|done|success(?:ful)?|completed|finished|updated|written|applied|loaded)[.!]?$/i;

export function toolActivityInline(value: unknown, max = 500): string {
  return oneLine(boundedTextOf(value, max)).trim();
}

export function toolActivityFirstText(args: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return '';
}

function toolActivityStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (typeof entry === 'string') return entry.trim();
      // `read` accepts `{file_path, offset, limit}` entries; name them by path.
      if (entry && typeof entry === 'object') {
        return toolActivityFirstText(entry as Record<string, unknown>, 'file_path', 'filePath', 'path');
      }
      return '';
    })
    .filter(Boolean);
}

export function toolActivityCompact(parts: Array<string | undefined>): string {
  return parts
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .join(' · ');
}

function toolActivityQuoted(value: unknown): string {
  const text = toolActivityInline(value, 300);
  return text ? `"${text}"` : '';
}

export function toolActivityCommand(args: Record<string, unknown>): string {
  const direct = toolActivityFirstText(args, 'command', 'cmd', 'description');
  if (direct) return direct;
  const commands = toolActivityStringList(args.commands ?? args.command);
  return commands.join('\n');
}

function toolActivityPath(args: Record<string, unknown>): string {
  return toolActivityFirstText(args, 'file_path', 'filePath', 'path', 'file', 'target');
}

/** A batch argument as its entries: a string is one entry, an array each. */
function toolActivityValues(value: unknown): string[] {
  if (typeof value === 'string') return value.trim() ? [value.trim()] : [];
  return toolActivityStringList(value);
}

type ToolActivityTargetNoun = 'file' | 'pattern' | 'query' | 'command' | 'URL' | 'path' | 'symbol' | 'change';

function toolActivityTargetCount(noun: ToolActivityTargetNoun, count: number): string {
  switch (noun) {
    case 'file':
      return t('{{count}} files', { count });
    case 'pattern':
      return t('{{count}} patterns', { count });
    case 'query':
      return t('{{count}} queries', { count });
    case 'command':
      return t('{{count}} commands', { count });
    case 'URL':
      return t('{{count}} URLs', { count });
    case 'path':
      return t('{{count}} paths', { count });
    case 'change':
      return t('{{count}} changes', { count });
    default:
      return t('{{count}} symbols', { count });
  }
}

/** One target reads as itself, several as a count ("3 files"). */
function toolActivityOneOrCount(
  values: string[],
  noun: ToolActivityTargetNoun,
  format: (value: string) => string = (value) => toolActivityInline(value)
): string {
  if (values.length > 1) return toolActivityTargetCount(noun, values.length);
  return values.length ? format(values[0]) : '';
}

/** `path:start-end`: the line window in the reference form paths already use. */
function readTarget(path: string, offsetValue: unknown, limitValue: unknown): string {
  const offset = Number(offsetValue);
  const limit = Number(limitValue);
  const hasOffset = Number.isFinite(offset) && offset > 0;
  const hasLimit = Number.isFinite(limit) && limit > 0;
  const start = hasOffset ? Math.floor(offset) : 1;
  let window = '';
  if (hasLimit) window = `:${start}-${start + Math.floor(limit) - 1}`;
  else if (hasOffset) window = `:${start}+`;
  return path ? `${path}${window}` : '';
}

function readTargets(args: Record<string, unknown>): string[] {
  const value = args.file_path ?? args.path;
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (typeof entry === 'string') return entry.trim();
      if (!entry || typeof entry !== 'object') return '';
      const record = entry as Record<string, unknown>;
      return readTarget(
        toolActivityFirstText(record, 'file_path', 'filePath', 'path'),
        record.offset ?? args.offset,
        record.limit ?? args.limit
      );
    })
    .filter(Boolean);
}

// One entry per normalized tool name, shared by every name in a group.
function byToolName<T>(groups: Array<[names: string[], value: T]>): Record<string, T> {
  const table: Record<string, T> = {};
  for (const [names, value] of groups) {
    for (const name of names) table[name] = value;
  }
  return table;
}

type ToolSubjectFormatter = (args: Record<string, unknown>, path: string, fallback: string) => string;

function readSubject(args: Record<string, unknown>, path: string): string {
  const paths = readTargets(args);
  if (paths.length > 1) return toolActivityTargetCount('file', paths.length);
  // A batch entry already carries its own window; only a plain path takes the call's.
  if (paths.length === 1) return paths[0];
  return readTarget(path, args.offset, args.limit);
}

function grepSubject(args: Record<string, unknown>): string {
  return toolActivityCompact([
    toolActivityOneOrCount(toolActivityValues(args.pattern ?? args.query), 'pattern', toolActivityQuoted),
    toolActivityOneOrCount(toolActivityValues(args.path), 'path'),
    args.glob ? toolActivityInline(args.glob) : '',
  ]);
}

function globSubject(args: Record<string, unknown>): string {
  return toolActivityCompact([
    toolActivityOneOrCount(toolActivityValues(args.pattern ?? args.glob), 'pattern'),
    toolActivityOneOrCount(toolActivityValues(args.path), 'path'),
  ]);
}

function findSubject(args: Record<string, unknown>): string {
  return toolActivityCompact([
    toolActivityOneOrCount(toolActivityValues(args.query ?? args.fuzzy), 'query', toolActivityQuoted),
    toolActivityOneOrCount(toolActivityValues(args.path), 'path'),
  ]);
}

function codeGraphSubject(args: Record<string, unknown>): string {
  const mode = toolActivityInline(args.mode ?? args.action ?? '');
  // callers/callees name the direction of the walk; the target alone hides it.
  const direction = /^(?:callers|callees)$/.test(mode) ? mode : '';
  const targets = toolActivityCompact([
    toolActivityOneOrCount(toolActivityValues(args.symbols ?? args.symbol), 'symbol'),
    toolActivityOneOrCount(toolActivityValues(args.files ?? args.file ?? args.path), 'file'),
  ]);
  return toolActivityCompact([direction, targets || toolActivityQuoted(args.query)]) || mode;
}

function commandSubject(args: Record<string, unknown>): string {
  const commands = toolActivityValues(args.commands ?? args.command);
  if (commands.length > 1) return toolActivityTargetCount('command', commands.length);
  return toolActivityInline(toolActivityCommand(args), 1_000);
}

function questionsSubject(args: Record<string, unknown>): string {
  const questions = Array.isArray(args.questions) ? args.questions : [];
  if (!questions.length) return '';
  const count = `${questions.length} ${questions.length === 1 ? 'question' : 'questions'}`;
  return tExisting('{{count}} questions', count, { count: questions.length });
}

const TOOL_SUBJECTS = byToolName<ToolSubjectFormatter>([
  [['read'], readSubject],
  [['view_image', 'read_mcp_resource'], (args, path) => path || toolActivityFirstText(args, 'uri')],
  [['edit', 'strreplace', 'str_replace', 'str_replace_editor', 'search_replace'], (_args, path) => path],
  [['apply_patch'], (_args, _path, fallback) => fallback],
  [['shell', 'bash', 'bash_session', 'shell_command', 'job_wait'], commandSubject],
  // A stage call has no command: its summary names the staged changes.
  [
    ['git'],
    (args) =>
      args.action === 'stage'
        ? toolActivityOneOrCount(toolActivityValues(args.change_ids ?? args.change_id), 'change')
        : commandSubject(args),
  ],
  [['git_stage'], (args) => toolActivityOneOrCount(toolActivityValues(args.files ?? args.paths), 'file')],
  [['grep'], grepSubject],
  [['glob'], globSubject],
  [['find'], findSubject],
  [['code_graph'], codeGraphSubject],
  [
    ['list', 'ls'],
    // The entry limit is an argument, not what was listed: beside the result
    // count it read as a second, contradicting total ("80 entries 81 entries").
    (args) => toolActivityOneOrCount(toolActivityValues(args.path ?? args.dir ?? args.cwd), 'path'),
  ],
  [
    ['web_search', 'web_search_call', 'search_query', 'image_query'],
    (args) =>
      toolActivityOneOrCount(
        toolActivityValues(args.query ?? args.queries ?? args.keywords),
        'query',
        toolActivityQuoted
      ),
  ],
  [
    ['web_fetch', 'fetch'],
    (args, _path, fallback) =>
      toolActivityOneOrCount(toolActivityValues(args.url ?? args.urls ?? args.uri), 'URL', (value) =>
        toolActivityInline(value, 1_000)
      ) || fallback,
  ],
  [
    ['load_tool'],
    (args, _path, fallback) => {
      const names = [...toolActivityStringList(args.names), ...toolActivityStringList(args.select)];
      return names.join(', ') || fallback;
    },
  ],
  [['skill', 'skill_execute', 'skill_view', 'skills_list', 'use_skill', 'update_plan'], () => ''],
  [
    ['task'],
    (args) =>
      toolActivityCompact([toolActivityFirstText(args, 'action'), toolActivityFirstText(args, 'task_id', 'id')]),
  ],
  [
    ['agent', 'bridge'],
    (args, _path, fallback) => toolActivityFirstText(args, 'description', 'tag', 'role', 'model') || fallback,
  ],
  [['request_user_input'], questionsSubject],
  // "open · example.com/path": the scheme says nothing on a browser row.
  [['browser', 'browser_devtools'], (_args, _path, fallback) => fallback.replace(/https?:\/\/(?:www\.)?/g, '')],
]);

export function toolActivitySubject(normalizedName: string, args: Record<string, unknown>, fallback: string): string {
  const format = TOOL_SUBJECTS[normalizedName];
  return format ? format(args, toolActivityPath(args), fallback) : fallback;
}

/** A call's batchable arguments, one list per argument (patterns, paths…). */
type ToolTargetsFormatter = (args: Record<string, unknown>) => string[][];

// Each entry of a batch call, listed in the detail view only when one call
// carried several targets (the row itself then reads "3 files").
const TOOL_TARGETS = byToolName<ToolTargetsFormatter>([
  [['read'], (args) => [readTargets(args)]],
  [
    ['grep'],
    (args) => [toolActivityValues(args.pattern ?? args.query).map(toolActivityQuoted), toolActivityValues(args.path)],
  ],
  [['glob'], (args) => [toolActivityValues(args.pattern ?? args.glob), toolActivityValues(args.path)]],
  [
    ['find'],
    (args) => [toolActivityValues(args.query ?? args.fuzzy).map(toolActivityQuoted), toolActivityValues(args.path)],
  ],
  [
    ['code_graph'],
    (args) => [
      toolActivityValues(args.symbols ?? args.symbol),
      toolActivityValues(args.files ?? args.file ?? args.path),
    ],
  ],
  [['list', 'ls'], (args) => [toolActivityValues(args.path ?? args.dir ?? args.cwd)]],
  [
    ['shell', 'bash', 'bash_session', 'shell_command', 'job_wait', 'git'],
    (args) => [toolActivityValues(args.commands ?? args.command)],
  ],
  [['git_stage'], (args) => [toolActivityValues(args.files ?? args.paths)]],
  [
    ['web_search', 'web_search_call', 'search_query', 'image_query'],
    (args) => [toolActivityValues(args.query ?? args.queries ?? args.keywords).map(toolActivityQuoted)],
  ],
  [['web_fetch', 'fetch'], (args) => [toolActivityValues(args.url ?? args.urls ?? args.uri)]],
]);

/** Every entry of each argument that carried more than one; empty when none did. */
export function toolActivityTargets(normalizedName: string, args: Record<string, unknown>): string[] {
  return (TOOL_TARGETS[normalizedName]?.(args) ?? []).filter((values) => values.length > 1).flat();
}

export function toolActivityFieldLabel(key: string): string {
  const labels: Record<string, string> = {
    api_key: t('API key'),
    include_noise: t('Include ignored'),
    timeout_ms: t('Timeout'),
  };
  if (labels[key]) return labels[key];
  const text = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim();
  return text ? t(`${text[0].toUpperCase()}${text.slice(1)}`) : key;
}

export function toolActivityFieldValue(key: string, value: unknown): string {
  if (TOOL_ACTIVITY_SECRET_ARG.test(key)) return '••••••';
  if (key === 'timeout_ms' && Number(value) > 0) {
    return formatElapsed(Number(value));
  }
  if (typeof value === 'boolean') return value ? t('Yes') : t('No');
  if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) {
    return value.join(', ');
  }
  if (value && typeof value === 'object') {
    try {
      return JSON.stringify(value, null, 2).slice(0, 8_000);
    } catch {
      // Cyclic or non-JSON values fall back to the bounded text serializer.
    }
  }
  return boundedTextOf(value, 8_000);
}

export function toolActivityRedactInlineSecrets(text: string, args: Record<string, unknown>): string {
  let redacted = text;
  for (const [key, value] of Object.entries(args)) {
    if (!TOOL_ACTIVITY_SECRET_ARG.test(key) || value == null || typeof value === 'object') continue;
    const raw = toolActivityInline(value);
    if (!raw) continue;
    redacted = redacted.split(`${key}=${raw}`).join(`${key}=••••••`).split(`${key}: ${raw}`).join(`${key}: ••••••`);
  }
  return redacted;
}

// Argument keys the activity line already shows for each normalized tool
// name; the detail view skips them.
const TOOL_REPRESENTED_KEYS = byToolName<readonly string[]>([
  [['read'], ['file_path', 'filePath', 'path', 'file', 'offset', 'limit', 'pages']],
  [
    ['view_image', 'read_mcp_resource'],
    ['file_path', 'filePath', 'path', 'file', 'uri'],
  ],
  [
    ['edit', 'strreplace', 'str_replace', 'str_replace_editor', 'search_replace'],
    ['file_path', 'filePath', 'path', 'file', 'target'],
  ],
  [
    ['shell', 'bash', 'bash_session', 'shell_command', 'job_wait', 'git'],
    ['command', 'commands', 'cmd', 'description'],
  ],
  [['git_stage'], ['files', 'paths']],
  [['grep'], ['pattern', 'query', 'path', 'glob']],
  [['glob'], ['pattern', 'glob', 'path']],
  [['find'], ['query', 'fuzzy', 'path']],
  [
    ['list', 'ls'],
    ['path', 'dir', 'cwd'],
  ],
  [
    ['web_search', 'web_search_call', 'search_query', 'image_query'],
    ['query', 'queries', 'keywords'],
  ],
  [
    ['web_fetch', 'fetch'],
    ['url', 'urls', 'uri'],
  ],
  [['load_tool'], ['names', 'select', 'query', 'q', 'text']],
  [
    ['skill', 'skill_execute', 'skill_view', 'skills_list', 'use_skill'],
    ['name', 'skill', 'skill_name', 'query', 'q'],
  ],
  [['task'], ['action', 'task_id', 'id']],
  [
    ['agent', 'bridge'],
    ['type', 'action', 'description', 'tag', 'role', 'model', 'prompt', 'status', 'task_id', 'sessionId'],
  ],
  [['request_user_input'], ['questions', 'answers']],
  [['update_plan'], ['plan', 'todos', 'explanation']],
  [
    ['memory', 'remember', 'save_memory', 'update_memory', 'recall_memory', 'recall', 'search_memories'],
    [
      'action',
      'type',
      'operation',
      'op',
      'query',
      'queries',
      'text',
      'input',
      'summary',
      'element',
      'key',
      'name',
      'value',
      'limit',
      'topK',
    ],
  ],
  [
    ['code_graph'],
    ['mode', 'action', 'symbols', 'symbol', 'query', 'files', 'file', 'path', 'body', 'limit', 'depth', 'cwd'],
  ],
  [['cwd'], ['action', 'type', 'path', 'cwd', 'dir']],
  [['list_mcp_resources', 'list_mcp_resource_templates'], ['server']],
]);

export function toolActivityRepresentedKeys(normalizedName: string): Set<string> {
  return new Set(TOOL_REPRESENTED_KEYS[normalizedName] ?? []);
}
