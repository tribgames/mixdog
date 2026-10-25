// Runtime guards against shell-tool misuse, run in the shell tool's validation
// step before hooks, approvals and execution (tool-exec.mjs) and again, once,
// for callers that reach executeBashTool without that step:
//   1. a long leading sleep is rejected (a wait belongs to background + task wait);
//   2. a plain leading `cd <dir>` moves into the `cwd` argument;
//   3. a shell file read (cat/Get-Content/grep/ls …) gets a pointer to the
//      read / grep / list tools — a note now, a rejection when the mode flips.
import { shellSplitPipelineSegments, shellSplitSegments, shellTokenize } from '../shell-analysis.mjs';
import { resolveShellFor } from '../shell-runtime.mjs';
import { formatShellToolFailure } from './result-format.mjs';

/** `warn` runs the read with a note; `reject` returns the block without running. */
export const SHELL_FILE_READ_MODE = 'warn';
export const SHELL_FILE_READ_NOTE = 'Note: use the read / grep / list tools for files instead of the shell.';
export const SHELL_FILE_READ_BLOCK =
  'Blocked: use read / grep / list for files instead of the shell (read takes offset/limit for a window of a large file).';
const LEADING_SLEEP_MIN_SECONDS = 5;

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// ── 1. leading sleep ─────────────────────────────────────────────────────────

// The first statement ends the command or is followed by `;`, `&&`, `||` or a
// newline. `Start-Sleep [-Seconds|-Milliseconds] N`, `sleep N[smhd]`, `timeout /t N`.
const STATEMENT_END = String.raw`(?=\s*(?:$|;|&&|\|\||\r?\n))`;
const SLEEP_RE = new RegExp(
  String.raw`^\s*(?:start-sleep|sleep)(?:\.exe)?\s+(?:(-[a-z]+)[\s:]+)?(\d+(?:\.\d+)?)([smhd]?)${STATEMENT_END}`,
  'i'
);
const TIMEOUT_RE = new RegExp(
  String.raw`^\s*timeout(?:\.exe)?\s+/t[\s:]*(\d+)(?:\s+(?:/nobreak|>\s*nul|2>&1))*${STATEMENT_END}`,
  'i'
);
const SLEEP_UNIT_SECONDS = { '': 1, s: 1, m: 60, h: 3600, d: 86400 };

/** Seconds of the sleep the command starts with, or null when it does not start with one. */
export function leadingSleepSeconds(command) {
  const text = String(command ?? '');
  const timeout = TIMEOUT_RE.exec(text);
  if (timeout) return Number(timeout[1]);
  const sleep = SLEEP_RE.exec(text);
  if (!sleep) return null;
  const [, flag, amount, unit] = sleep;
  if (flag && !/^-[sm][a-z]*$/i.test(flag)) return null;
  if (flag && /^-m/i.test(flag)) return Number(amount) / 1000;
  return Number(amount) * SLEEP_UNIT_SECONDS[unit.toLowerCase()];
}

function leadingSleepFailure(command) {
  const seconds = leadingSleepSeconds(command);
  if (seconds === null || seconds < LEADING_SLEEP_MIN_SECONDS) return null;
  return formatShellToolFailure(
    `Blocked: a leading sleep of ${Number(seconds.toFixed(2))} s. Run the step with background:true and wait with task wait (or poll a condition inside one command with its own deadline).`
  );
}

// ── 2. leading cd → cwd ──────────────────────────────────────────────────────

// One plain path token: quoted (no variable or escape characters) or unquoted
// (no shell metacharacters), then `;` or `&&` and a remainder.
const CD_RE =
  /^\s*(?:cd|set-location)\s+(?:-path\s+)?(?:"([^"$`]+)"|'([^'$`]+)'|([^\s;&|<>"'`$(){}*?,@%#!]+))\s*(?:;|&&)\s*(\S[\s\S]*)$/i;
const CD_LIKE_RE = /^(?:cd|set-location|pushd|popd)(?:\s|;|&|$)/i;

/** `{ dir, rest }` for a command that starts with a plain `cd <dir>` and more, else null. */
export function splitLeadingCd(command, shellType) {
  const match = CD_RE.exec(String(command ?? ''));
  if (!match) return null;
  const dir = match[1] ?? match[2] ?? match[3];
  const rest = match[4];
  if (CD_LIKE_RE.test(rest)) return null;
  if (dir.trim() === '' || dir.startsWith('-')) return null;
  // `~user` is another account's home in a shell, not a folder named so; a
  // quoted `~` is a literal directory name, only an unquoted one is home.
  if (dir.startsWith('~') && (match[3] === undefined || !/^~(?:[\\/]|$)/.test(dir))) return null;
  // A POSIX backslash escapes; only single quotes keep it literal.
  if (shellType !== 'powershell' && match[2] === undefined && dir.includes('\\')) return null;
  return { dir, rest };
}

// ── 3. shell file reads ──────────────────────────────────────────────────────

const POWERSHELL_READERS = {
  'get-content': 'read',
  gc: 'read',
  cat: 'read',
  type: 'read',
  'select-string': 'grep',
  sls: 'grep',
  'get-childitem': 'list',
  gci: 'list',
  ls: 'list',
  dir: 'list',
  rg: 'grep',
};
const POSIX_READERS = {
  cat: 'read',
  head: 'read',
  tail: 'read',
  less: 'read',
  grep: 'grep',
  rg: 'grep',
  ls: 'list',
  find: 'list',
};
// Flags whose next token is a path or pattern operand, and flags whose next
// token is a plain value; both are read off the operand count.
const OPERAND_FLAGS = new Set(['-path', '-literalpath', '-pattern', '-e', '--regexp', '-f', '--file']);
const VALUE_FLAGS = new Set(['-encoding', '-filter', '-include', '-exclude', '-g', '--glob', '-t', '--type']);
// A later pipeline stage that only shapes text; anything else is a program
// the first stage feeds.
const TEXT_FILTERS = new Set([
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
const FIND_WRITERS = new Set(['-exec', '-execdir', '-ok', '-okdir', '-delete', '-fprint', '-fprintf', '-fls']);
const BENIGN_REDIRECT_TARGET = /^(?:&\d|\$null|\/dev\/null|nul)$/i;

const commandName = (token) =>
  String(token ?? '')
    .toLowerCase()
    .replace(/^.*[\\/]/, '')
    .replace(/\.exe$/, '');

// The path/pattern operands of a stage, or null when it writes a file.
function stageOperands(args) {
  const operands = [];
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (token === '>' || token === '>>') {
      if (!BENIGN_REDIRECT_TARGET.test(args[i + 1] ?? '')) return null;
      i++;
      continue;
    }
    const flag = token.toLowerCase();
    if (flag.startsWith('-') && flag.length > 1) {
      if (OPERAND_FLAGS.has(flag) && i + 1 < args.length) operands.push(args[++i]);
      else if (VALUE_FLAGS.has(flag)) i++;
      continue;
    }
    // A bare count (`head -n 5`, `tail -n +5`) is a flag value, not an operand.
    if (!/^[+-]?\d+$/.test(token)) operands.push(token);
  }
  return operands;
}

/**
 * `{ tool, command }` when the command's first statement starts with a
 * read-only file command on a path — the tool that does that job — else null.
 * A pipeline whose later stage is a program, a write, and a first stage that
 * reads piped input are not file reads.
 */
export function detectShellFileRead(command, shellType) {
  const first = shellSplitSegments(String(command ?? ''))[0];
  if (!first) return null;
  const stages = shellSplitPipelineSegments(first);
  const tokens = shellTokenize(stages[0] ?? '');
  if (!tokens || tokens.length === 0) return null;
  const name = commandName(tokens[0]);
  const tool = (shellType === 'powershell' ? POWERSHELL_READERS : POSIX_READERS)[name];
  if (!tool) return null;
  for (const stage of stages.slice(1)) {
    if (!TEXT_FILTERS.has(commandName(stage.trim().split(/\s+/)[0]))) return null;
  }
  const args = tokens.slice(1);
  if (name === 'find') {
    const lowered = args.map((token) => token.toLowerCase());
    const matchesNames = lowered.some((token) => ['-name', '-iname', '-path', '-regex'].includes(token));
    return matchesNames && !lowered.some((token) => FIND_WRITERS.has(token)) ? { tool, command: name } : null;
  }
  const operands = stageOperands(args);
  if (!operands) return null;
  // A search names its pattern and then the path it reads; with one operand it reads piped input.
  return operands.length >= (tool === 'grep' ? 2 : 1) ? { tool, command: name } : null;
}

// ── the guard ────────────────────────────────────────────────────────────────

/** The syntax family of the shell a call asks for (`args.shell`, as foreign adapters set it), else the default shell's. */
export function requestedShellType(args) {
  const requested = typeof args?.shell === 'string' && args.shell ? resolveShellFor(args.shell) : null;
  return (requested ?? resolveShellFor('default'))?.shellType;
}

function recordFileRead(telemetry, entry) {
  if (!telemetry || typeof telemetry !== 'object') return;
  if (!Array.isArray(telemetry.shellMisuse)) telemetry.shellMisuse = [];
  telemetry.shellMisuse.push({ kind: 'file-read', ...entry });
}

/**
 * Apply the three guards to a shell call.
 * @returns {{ failure: string } | { args: object, notes: string[] }} the
 *   rejection, or the call to run (a leading `cd` moved into `cwd`) with the
 *   lines to add to its result.
 */
export function guardShellCall(
  args,
  { shellType, fileReadMode = SHELL_FILE_READ_MODE, agent = null, sessionId = null, telemetry = null } = {}
) {
  if (!isPlainObject(args) || typeof args.command !== 'string') return { args, notes: [] };
  const notes = [];
  let guarded = args;
  const moved = args.cwd == null ? splitLeadingCd(args.command, shellType) : null;
  if (moved) {
    guarded = { ...args, command: moved.rest, cwd: moved.dir };
    notes.push(`Moved \`cd ${moved.dir}\` into cwd.`);
  }
  const sleepFailure = leadingSleepFailure(guarded.command);
  if (sleepFailure) return { failure: sleepFailure };
  const read = detectShellFileRead(guarded.command, shellType);
  if (read) {
    recordFileRead(telemetry, { mode: fileReadMode, tool: read.tool, command: read.command, agent, sessionId });
    if (fileReadMode === 'reject') return { failure: formatShellToolFailure(SHELL_FILE_READ_BLOCK) };
    notes.push(SHELL_FILE_READ_NOTE);
  }
  return { args: guarded, notes };
}
