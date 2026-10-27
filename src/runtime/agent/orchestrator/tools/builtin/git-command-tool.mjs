import { isUtf8 } from 'node:buffer';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { tokenizeDirectArgv } from './shell-direct-exe.mjs';
import { GIT_DIFF_EXIT_SIGNAL_FLAGS } from './bash-tool/benign-exit.mjs';
import { withBuiltinPathLocks } from './path-locks.mjs';
import { withAdvisoryLocks } from './advisory-lock.mjs';
import { gitRepoLockKey, withGitWorktreeWriteLock } from './git-repo-rw-lock.mjs';
import { invalidateBuiltinResultCache } from './cache-layers.mjs';
import { tryAdmitWorkspaceActivityAsync } from '../../../../shared/worktrees/activity-gate.mjs';
import { WORKTREE_SNAPSHOT_KIND } from '../../../../shared/worktrees/contract.mjs';
import { isWithin } from '../../../../shared/worktrees/paths.mjs';
import { readRegistrySync } from '../../../../shared/worktrees/registry.mjs';
import { runAbortable } from '../../../../shared/abort-race.mjs';
import { sleep } from '../../../../shared/sleep.mjs';
import { capMarker } from '../../../../shared/tool-output-marker.mjs';
import { drainCodeGraphCache } from '../code-graph-state.mjs';
import { ensureNativeSpawnServer, tryNativeSpawn } from '../lib/native-spawn-client.mjs';
import {
  commandHasShellSyntax,
  gitPlanIsReadOnly as isReadOnly,
  OPERATION_ALIASES,
  skipGitGlobalFlags,
} from './git-command-policy.mjs';
import {
  buildSelectedStagePatch,
  createDiffSnapshot,
  deleteDiffSnapshot,
  diffSnapshotMatches,
  getDiffSnapshot,
} from './git-partial-stage.mjs';
import {
  executeRawWorktree,
  executeWorktreeAction,
  WORKTREE_INPUT_FIELDS,
  WORKTREE_TOOL_ACTIONS,
} from './git-worktree-tool.mjs';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_CAPTURE_BYTES = 128 * 1024 * 1024;
// Sized from 3 days of real calls (2.9k diff/show/log/status results): diff and
// show p50 ~125 lines / 6K chars, p90 ~460-510 lines / 21-23K chars, p95 ~700
// lines / 30-36K chars. 500 lines / 40K chars fits ~91% of them (was ~65% at
// 50 lines / 12K) and 1000 covers the p97 tail; 1981 of 2010 calls that set
// output_limit asked for the old max of 200.
const GIT_OUTPUT_LIMIT_MAX = 1000;
const GIT_OUTPUT_LINES_DEFAULT = 500;
const GIT_LOG_LINES_DEFAULT = 100;
// Matches the other batch tools' 10-entry fan-out; a 6-command survey used to
// be refused outright, costing the model a round trip.
const GIT_COMMAND_ARRAY_LIMIT = 10;
// git's subcommand namespace is open-ended: any `git-*` executable on PATH
// (git-filter-repo, git-lfs, in-house wrappers) dispatches as a subcommand, so
// a finite allowlist can never keep up. It rejected `git filter-repo` as an
// "unsupported subcommand" while the shell tool still ran the very same
// command unblocked — buying no safety and costing a whole turn. So nothing is
// pre-rejected for being unknown: git itself reports a genuinely unknown
// subcommand, and that error tells the model what to do next.
//
// Destructive history/tree rewrites stay allowed on purpose. They are usually
// the actual job, reflog and loose objects make most of them recoverable, and
// the workflow already gates destructive git work.
//
// What this tool genuinely cannot host is a command that never returns, since
// each call occupies one synchronous turn. The classic hangs are already dead
// via the pinned GIT_PAGER / GIT_EDITOR / GIT_SEQUENCE_EDITOR /
// GIT_TERMINAL_PROMPT environment in runProcess, which leaves two shapes.
//
// A GUI subcommand blocks on a window or a stdin prompt that this process has
// no way to satisfy.
const GUI_OPERATIONS = new Set(['gui', 'citool', 'gitk', 'difftool', 'mergetool']);
// A resident server's correct behaviour IS to keep running, so it can only
// burn the full timeout here. It is not a bad command, just one in the wrong
// tool: shell promotes a long-running process to a background task, so point
// there instead of failing it outright.
const SERVER_OPERATIONS = new Set(['daemon', 'instaweb']);
// `git --version` / `git --help` are the standard availability probes and
// arrive in global-flag position, not as subcommands. Map them onto their
// subcommand form so the probe answers instead of erroring out.
// These answer anywhere: demanding a repository first turned an availability
// probe into `git rev-parse exited 128` inside a plain directory.
const REPO_FREE_OPERATIONS = new Set(['version', 'help']);

const GIT_DESCRIPTION_HEAD =
  'Run Git here, never through shell. An array runs in order and stops on failure; batch read-only commands in one. diff for known changes, status to discover them; history only when needed. git diff or git diff -- <paths> includes untracked files. Set include_stage_ids:true to select changes, then action:stage with diff_id/change_ids. Staging rejects stale or cross-Project diffs and returns per-file staged counts.';

export const GIT_TOOL_DEF = {
  name: 'git',
  title: 'Git',
  annotations: {
    title: 'Git',
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
    compressible: true,
  },
  description: `${GIT_DESCRIPTION_HEAD} Worktrees are managed only: action:worktree; git worktree add/remove/list/prune map to managed operations (add -b keeps the session in place; add --detach makes a read-only snapshot worktree, removed when its turn ends; list --porcelain stays raw git; move/lock/unlock/repair are refused). Merge or remove only when the user asks.`,
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['command', 'stage', 'worktree'],
        description:
          'Default command. stage uses diff_id/change_ids instead of command. worktree uses worktree_action and its fields.',
      },
      command: {
        anyOf: [
          { type: 'string' },
          { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: GIT_COMMAND_ARRAY_LIMIT },
        ],
        description:
          'Full commands starting with git; shell-style quoting, no pipes/redirects/substitution (a && chain runs as the array). Mutations allowed.',
      },
      output_limit: {
        type: 'integer',
        minimum: 1,
        maximum: GIT_OUTPUT_LIMIT_MAX,
        description:
          'Body line cap; staging IDs are not capped. Default 500; git log defaults to 100. A cut ends with [output capped …] naming how to continue.',
      },
      include_stage_ids: {
        type: 'boolean',
        description:
          'Include staging IDs outside the body cap for git diff or git diff -- <paths> only. Default false.',
      },
      diff_id: { type: 'string', description: 'stage: exact diff_id from git diff.' },
      change_ids: {
        anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 50 }],
        description: 'stage: exact change ID or IDs to stage, including new files.',
      },
      worktree_action: {
        type: 'string',
        enum: [...WORKTREE_TOOL_ACTIONS],
        description:
          'enter: create or re-enter the managed worktree (branch: that branch, create: new); return: back to the project folder, worktree kept; merge: into its merge target; remove; list; prune.',
      },
      session_id: {
        type: 'string',
        description: 'enter/return/merge/remove: another session (it must be idle); default the caller.',
      },
      name: { type: 'string', description: 'enter: the new worktree name (branch <prefix><name>).' },
      branch: { type: 'string', description: 'enter: use the worktree of this branch instead.' },
      create: { type: 'boolean', description: 'enter with branch: create that branch.' },
      carry: {
        type: 'string',
        enum: ['leave', 'carry'],
        description: 'enter: the user answer to WORKTREE_DIRTY_CHOICE (uncommitted project-folder changes).',
      },
      confirm_large: {
        type: 'boolean',
        description: 'enter or git worktree add: the user accepted the WORKTREE_LARGE_REPO_CONFIRM size.',
      },
      force: { type: 'boolean', description: 'remove: discard dirty/unmerged work; only on explicit user request.' },
    },
    additionalProperties: false,
  },
};

// Only the Lead host runs enter/return/merge/remove/prune (git-worktree-tool.mjs
// leadHost); an agent keeps `list`, so its schema omits every field the other
// operations take.
const LEAD_ONLY_WORKTREE_FIELDS = ['session_id', 'name', 'branch', 'create', 'carry', 'confirm_large', 'force'];

function buildGitAgentToolDef(base) {
  const properties = { ...base.inputSchema.properties };
  for (const field of LEAD_ONLY_WORKTREE_FIELDS) delete properties[field];
  properties.action = {
    ...properties.action,
    description: 'Default command. stage uses diff_id/change_ids instead of command. worktree uses worktree_action.',
  };
  properties.worktree_action = { type: 'string', enum: ['list'], description: 'list only.' };
  return {
    ...base,
    description: `${GIT_DESCRIPTION_HEAD} Worktrees are Lead-managed: only worktree_action:list and git worktree list work; every other worktree operation is refused.`,
    inputSchema: { ...base.inputSchema, properties },
  };
}

/** The git tool as a delegated agent sees it (see bindAgentOwner). */
export const GIT_AGENT_TOOL_DEF = buildGitAgentToolDef(GIT_TOOL_DEF);

function cleanText(value) {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .trimEnd();
}

function ok(data = {}) {
  return JSON.stringify({
    ok: true,
    ...(data && typeof data === 'object' && !Array.isArray(data) ? data : { output: data }),
  });
}

const NOT_UTF8_STAGE_NOTE =
  'staging ids unavailable: this diff has bytes that are not UTF-8 (a file in another encoding), and staging its text would replace them; stage those files whole with git add -- <paths>';

function fail(message) {
  return `error: ${message}`;
}

function rejected(message) {
  return { text: fail(message), failed: true };
}

function appendText(left, right) {
  if (!right) return left;
  return `${left}${left && !left.endsWith('\n') ? '\n' : ''}${right}`;
}

function outputLines(value) {
  return String(value || '').match(/[^\n]*\n|[^\n]+$/g) || [];
}

// A line cap alone lets a few very long lines (minified files, lockfiles)
// through, so each command also gets a character budget, and a command array
// shares one. A cut always states what was omitted and how to page.
const COMMAND_CHAR_BUDGET = 40_000;
const ARRAY_CHAR_BUDGET = 60_000;
const MIN_COMMAND_CHARS = 1_000;
const LARGE_DIFF_LINES = GIT_OUTPUT_LINES_DEFAULT;
const LARGE_DIFF_HINT =
  'hint: large diff - run with --stat first for per-file sizes, add -U1 for less context, and page by file with -- <path>';

// Line-ending warnings are noise the model cannot act on; the content is unchanged.
const CRLF_WARNING_RE = /^warning: in the working copy of .* (?:CRLF|LF) will be replaced[^\n]*(?:\n|$)/gm;
// `index abc..def` carries abbreviated object ids the model never uses; mode
// changes keep their own `old mode`/`new mode`/`new file mode` lines.
const DIFF_INDEX_LINE_RE = /^index [0-9a-f,]+\.\.[0-9a-f]+(?: [0-7]+)?\r?(?:\n|$)/gm;
const PATCH_OPERATIONS = new Set(['diff', 'diff-files', 'diff-index', 'diff-tree', 'show', 'log']);

function visibleStderr(value) {
  return String(value || '').replace(CRLF_WARNING_RE, '');
}

function presentStdout(plan, value) {
  const stdout = String(value || '');
  if (plan.operation === 'merge-tree') return stdout.replace(/^Auto-merging .*(?:\r?\n|$)/gm, '');
  if (PATCH_OPERATIONS.has(plan.operation) && /^diff --git /m.test(stdout)) {
    return stdout.replace(DIFF_INDEX_LINE_RE, '');
  }
  return stdout;
}

function normalizeCap(limit) {
  return typeof limit === 'object' ? limit : { lines: limit, chars: COMMAND_CHAR_BUDGET };
}

function capOutput(text, cap) {
  const lines = outputLines(text);
  const lineCut = lines.length > cap.lines;
  const kept = lineCut ? lines.slice(0, cap.lines).join('') : text;
  if (kept.length <= cap.chars) {
    return {
      text: lineCut
        ? appendText(
            kept,
            capMarker({
              limit: `${cap.lines} lines`,
              shown: `${lines.length - cap.lines} more lines omitted`,
              narrow: `raise output_limit (max ${GIT_OUTPUT_LIMIT_MAX}) or narrow the command (-- <path>, -n/--skip)`,
            })
          )
        : text,
      truncated: lineCut,
      totalLines: lines.length,
    };
  }
  const newline = kept.lastIndexOf('\n', cap.chars - 1);
  const cut = newline > 0 ? newline + 1 : cap.chars;
  const shown = outputLines(kept.slice(0, cut)).length;
  return {
    text: appendText(
      kept.slice(0, cut),
      capMarker({
        limit: `${cap.chars} chars`,
        shown: `${lines.length - shown} more lines (${text.length - cut} chars) omitted`,
        narrow: 'narrow the command (-- <path>, -n/--skip) to page',
      })
    ),
    truncated: true,
    totalLines: lines.length,
  };
}

function commandResult(plan, result, limit) {
  const stdout = presentStdout(plan, result.stdout);
  const capped = capOutput(appendText(stdout, visibleStderr(result.stderr)), normalizeCap(limit));
  let output = capped.text;
  if ((capped.truncated || capped.totalLines > LARGE_DIFF_LINES) && /^diff --git /m.test(stdout)) {
    output = appendText(output, LARGE_DIFF_HINT);
  }
  if (succeeded(result)) return { text: output, failed: false };
  const processError = result.error || result.timedOut || result.aborted || result.overflow || result.exitCode == null;
  if (processError) return { text: appendText(fail(gitFailureReason(plan, result)), output), failed: true };
  const outcome = exitSignal(plan, result);
  if (outcome === 'conflicts') {
    // A conflicted merge-tree is its answer, not a failed command: the array continues.
    return {
      text: appendText(
        `exit ${result.exitCode}\n[outcome: conflicts]\nmerge has conflicts (see the CONFLICT lines); this is a result, not a command failure`,
        output
      ),
      failed: false,
    };
  }
  // A no-match signal is still a non-zero exit, so a command array stops on
  // it; the outcome line only keeps the card from reporting a failure.
  return {
    text: appendText(outcome ? `exit ${result.exitCode}\n[outcome: ${outcome}]` : `exit ${result.exitCode}`, output),
    failed: true,
  };
}

// Paths come from git unquoted; only a name that would break the one-line
// listing (control characters, quotes) is JSON-quoted.
function listedPath(path) {
  return [...path].some((char) => char.charCodeAt(0) < 0x20 || char === '"') ? JSON.stringify(path) : path;
}

function stageableDiffResult(plan, result, snapshot, limit) {
  if (!snapshot.diffId) return commandResult(plan, result, limit);
  const rendered = commandResult(plan, result, limit);
  // The hunk headers are already in the body; one line per file names the id range.
  const files = [];
  for (const change of snapshot.changes) {
    const last = files.at(-1);
    if (last?.path === change.path && !change.kind && !last.kind) last.end = change.id;
    else files.push({ path: change.path, start: change.id, end: change.id, kind: change.kind });
  }
  const listing = files.map(
    ({ path, start, end, kind }) =>
      `${listedPath(path)}: ${start === end ? start : `${start}-${end}`}${kind ? ' [whole file]' : ''}`
  );
  rendered.text = appendText(
    rendered.text,
    [
      `diff_id: ${snapshot.diffId} (ids number the +/- runs in diff order; [whole file] ids stage the entire file)`,
      ...listing,
    ].join('\n')
  );
  return rendered;
}

// Per-file staged counts; the paths and ranges the model already holds are not repeated per change.
function stagedSummary(changes) {
  const files = new Map();
  for (const { path, additions = 0, deletions = 0 } of changes) {
    const entry = files.get(path) || { count: 0, additions: 0, deletions: 0 };
    entry.count += 1;
    entry.additions += additions;
    entry.deletions += deletions;
    files.set(path, entry);
  }
  return {
    changes: changes.length,
    additions: [...files.values()].reduce((sum, entry) => sum + entry.additions, 0),
    deletions: [...files.values()].reduce((sum, entry) => sum + entry.deletions, 0),
    files: [...files].map(
      ([path, entry]) =>
        `${path}: ${entry.count} ${entry.count === 1 ? 'change' : 'changes'} +${entry.additions} -${entry.deletions}`
    ),
  };
}

// A provider sometimes delivers the whole command as one quoted scalar
// (`"git diff"`). That tokenizes to a single argument, so the git prefix check
// rejected it and the caller paid a failed call plus a retry for a command it
// had already written correctly. Unwrap exactly one balanced quote layer when
// the inner text holds no further quote of that kind; anything else is left
// byte-identical. Operator, substitution, and prefix checks then run on the
// real command, so a quoted `"git log | cat"` is still refused.
function unwrapQuotedCommand(command) {
  const text = String(command ?? '').trim();
  const quote = text[0];
  if ((quote !== '"' && quote !== "'") || text.length < 2 || !text.endsWith(quote)) return command;
  const inner = text.slice(1, -1);
  return inner.includes(quote) ? command : inner;
}

function parseCommand(rawCommand, workDir) {
  const command = unwrapQuotedCommand(rawCommand);
  if (commandHasShellSyntax(command)) {
    // commandHasShellSyntax already skips quoted text; the pipe hint follows
    // only when the rejected command really has an unquoted `|`.
    const unquoted = command.replace(/"(?:\\.|[^"\\])*"|'[^']*'/g, '');
    throw new Error(
      `git command must not contain shell operators or substitution; multiple commands belong in the command array.${
        unquoted.includes('|') ? ' For | head/tail use output_limit, for | grep use the grep tool' : ''
      }`
    );
  }
  const tokens = tokenizeDirectArgv(command);
  if (!tokens?.length || !/(^|[\\/])git(?:\.exe)?$/i.test(tokens[0])) {
    throw new Error('command must begin with git');
  }
  let cwd = resolve(workDir || process.cwd());
  const globalArgs = [];
  const index = skipGitGlobalFlags(tokens, {
    onChdir: (path) => {
      if (!path) throw new Error('git -C requires a path');
      cwd = resolve(cwd, path);
    },
    onValueFlag: (token, value) => {
      if (!value) throw new Error(`${token} requires a value`);
      globalArgs.push(token, value);
    },
    onBareFlag: (token) => {
      globalArgs.push(token);
    },
  });
  const rawOperation = String(tokens[index] || '').toLowerCase();
  const operation = OPERATION_ALIASES.get(rawOperation) ?? rawOperation;
  if (!operation) throw new Error('git requires a subcommand');
  const args = tokens.slice(index + 1);
  if (
    args.includes('--help') ||
    (operation === 'help' && args.some((value) => !value.startsWith('-'))) ||
    (operation === 'help' && args.some((value) => ['-w', '--web', '-m', '--man', '-i', '--info'].includes(value)))
  ) {
    throw new Error('git manual help can open an external viewer; use the subcommand -h form for terminal usage');
  }
  if (GUI_OPERATIONS.has(operation)) {
    throw new Error(
      `git ${operation} opens an interactive GUI and would never return here; use its non-interactive form (diff, merge, add -p)`
    );
  }
  if (SERVER_OPERATIONS.has(operation)) {
    throw new Error(
      `git ${operation} is a long-running server; start it with the shell tool so it becomes a background task`
    );
  }
  return { command: String(command), cwd, globalArgs, operation, args };
}

async function runProcess(program, argv, { cwd, signal, maxBytes = MAX_CAPTURE_BYTES, optionalLocks = true } = {}) {
  let child;
  try {
    await ensureNativeSpawnServer();
    const native = tryNativeSpawn({
      shell: program,
      argv,
      spawnOptions: {
        cwd,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
          GIT_PAGER: 'cat',
          GIT_EDITOR: 'true',
          GIT_SEQUENCE_EDITOR: 'true',
          LC_ALL: 'C',
          // Reads run beside writes without a lock (git-repo-rw-lock.mjs).
          // With optional locks off `git status` never takes index.lock to
          // write back a refreshed index, so it cannot fail a concurrent
          // write on that lock. (`git diff` ignores the setting and may still
          // refresh the index briefly; the write retry absorbs that.)
          ...(optionalLocks ? {} : { GIT_OPTIONAL_LOCKS: '0' }),
        },
        outputLimit: maxBytes,
        // Bytes as git wrote them, decoded once by the caller: a multibyte
        // character split across two pipe reads must not become U+FFFD.
        rawOutput: true,
      },
    });
    if (!native?.child)
      throw Object.assign(new Error('verified native spawn server unavailable'), { code: 'NATIVE_SPAWN_UNAVAILABLE' });
    child = native.child;
  } catch (error) {
    return {
      exitCode: null,
      signal: null,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      error,
      timedOut: false,
      aborted: false,
      overflow: false,
    };
  }
  return new Promise((done) => {
    const stdout = [],
      stderr = [];
    let bytes = 0,
      timedOut = false,
      aborted = false,
      overflow = false,
      settled = false;
    const stop = () => {
      try {
        child.kill('SIGKILL');
      } catch {}
    };
    const finish = (exitCode, exitSignal, error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      done({
        exitCode,
        signal: exitSignal,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        error,
        timedOut,
        aborted,
        overflow,
      });
    };
    const take = (bucket, chunk) => {
      const buffer = Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > maxBytes) {
        overflow = true;
        stop();
        return;
      }
      bucket.push(buffer);
    };
    child.stdout.on('data', (chunk) => take(stdout, chunk));
    child.stderr.on('data', (chunk) => take(stderr, chunk));
    child.once('error', (error) => finish(null, null, error));
    child.once('close', (code, exitSignal) => finish(code, exitSignal));
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, DEFAULT_TIMEOUT_MS);
    timer.unref?.();
    const onAbort = () => {
      aborted = true;
      stop();
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

function succeeded(result) {
  return result?.exitCode === 0 && !result.error && !result.timedOut && !result.aborted && !result.overflow;
}

// `git grep` exits 1 for no match and `git diff --exit-code/--quiet/--check`
// exits 1 to report a difference; the shell tool marks the same exits as
// signals, so the git tool does too. `git merge-tree` exits 1 with its report
// on stdout when the merge has conflicts. Returns the outcome name or null.
function exitSignal(plan, result) {
  if (result.exitCode !== 1 || visibleStderr(result.stderr).trim()) return null;
  if (plan.operation === 'grep') return 'no-match';
  if (plan.operation === 'merge-tree') return String(result.stdout || '').trim() ? 'conflicts' : null;
  if (plan.operation !== 'diff') return null;
  const separator = plan.args.indexOf('--');
  const options = separator === -1 ? plan.args : plan.args.slice(0, separator);
  return options.some((arg) => GIT_DIFF_EXIT_SIGNAL_FLAGS.has(arg)) ? 'no-match' : null;
}

// ENOENT from the spawn itself is a capability fact, not a git error: the
// executable is absent. Naming it stops the caller from re-running git a
// different way to find out.
function gitFailureReason(plan, result) {
  if (result.error?.code === 'ENOENT') return 'git executable not found in this environment';
  if (result.error) return `git process failed (${result.error.code || result.error.message || result.error})`;
  if (result.aborted) return 'git command aborted';
  if (result.timedOut) return 'git command timed out';
  if (result.overflow) return 'git output exceeded 128 MiB';
  return `git ${plan.operation} exited ${result.exitCode}`;
}

function commandFailure(plan, result, limit = GIT_OUTPUT_LINES_DEFAULT) {
  return commandResult(plan, result, limit).text;
}

function runGit(plan, argv, options = {}) {
  return runProcess('git', [...plan.globalArgs, ...argv], {
    cwd: plan.cwd,
    signal: options.signal,
    optionalLocks: !options.readOnly,
  });
}

// Another process (an editor, a terminal, an IDE) holding one of git's lock
// files makes git refuse a write: index.lock, a ref or packed-refs lock,
// config.lock. Commands take that lock before changing anything, so a brief
// retry with backoff turns the collision into a short wait; a command that had
// already done part of its work reports its own state on the retry.
const GIT_LOCK_CONTENTION_RE =
  /Unable to create '[^'\n]*\.lock': File exists|could not lock config file [^\n]*: File exists/;
const GIT_LOCK_RETRY_DELAYS_MS = [100, 200, 400, 800, 1600];

async function runGitWrite(plan, argv, { signal } = {}) {
  let retryMs = 0;
  for (let retries = 0; ; retries += 1) {
    const result = Object.assign(await runGit(plan, argv, { signal }), { retries, retryMs });
    const delay = GIT_LOCK_RETRY_DELAYS_MS[retries];
    if (succeeded(result) || delay === undefined || !GIT_LOCK_CONTENTION_RE.test(String(result.stderr))) return result;
    await runAbortable(signal, () => sleep(delay)).catch(() => {});
    if (signal?.aborted) return result;
    retryMs += delay;
  }
}

const LOCK_WAIT_REPORT_MS = 1000;

// Waiting is reported once it exceeds a second, so a slow answer is never
// mistaken for slow git work.
function lockWaitNote(waitedMs, result = null) {
  const total = waitedMs + (result?.retryMs || 0);
  if (total <= LOCK_WAIT_REPORT_MS) return '';
  const retried = result?.retries ? ` (git lock file busy; retried ${result.retries}x)` : '';
  return `note: waited ${(total / 1000).toFixed(1)}s for concurrent git writes${retried}`;
}

function prepare(plan) {
  const args = [...plan.args];
  const operation = plan.operation;
  if (
    operation === 'status' &&
    args.every((value) => ['-s', '--short', '-b', '--branch', '-sb', '-bs'].includes(value))
  ) {
    return { argv: ['status', '--short', '--branch'] };
  }
  if (['diff', 'diff-files', 'diff-index', 'diff-tree'].includes(operation)) {
    return { argv: [operation, '--no-ext-diff', '--no-color', ...args] };
  }
  return { argv: [operation, ...args] };
}

// A stage applies the text of this diff, so a patch with bytes that are not
// UTF-8 (a legacy-encoded file) would be applied with U+FFFD in their place.
// `notUtf8` marks such a diff: it is shown, but never staged by id.
async function runStageableDiff(plan, argv, repo, signal) {
  const result = await runGit(plan, argv, { signal, readOnly: true });
  if (!succeeded(result)) return result;
  result.notUtf8 = !isUtf8(result.stdout);
  result.stdout = String(result.stdout);
  result.stderr = String(result.stderr);
  const paths = plan.args.slice(1);
  const untracked = await runGit(
    plan,
    ['ls-files', '--others', '--exclude-standard', '--full-name', '-z', '--', ...paths],
    { signal, readOnly: true }
  );
  if (!succeeded(untracked)) return untracked;
  for (const path of String(untracked.stdout).split('\0').filter(Boolean)) {
    const added = await runGit(
      { ...plan, cwd: repo },
      [
        'diff',
        '--no-index',
        '--binary',
        '--no-ext-diff',
        '--no-textconv',
        '--no-color',
        '--src-prefix=a/',
        '--dst-prefix=b/',
        '--',
        '/dev/null',
        path,
      ],
      { signal, readOnly: true }
    );
    // --no-index uses exit 1 for a successfully produced patch.
    if (!succeeded({ ...added, exitCode: added.exitCode === 1 ? 0 : added.exitCode })) return added;
    if (!isUtf8(added.stdout)) result.notUtf8 = true;
    result.stdout = appendText(result.stdout, String(added.stdout));
    result.stderr = appendText(result.stderr, String(added.stderr));
  }
  return result;
}

// Repo-root resolution used to spawn an extra `git rev-parse` on EVERY call —
// on Windows that is half the cost of a git tool call (82ms for one process,
// 180ms for two). The answer is cached per resolved cwd and re-validated with
// a few stats: a cached root stays correct only while it is still the NEAREST
// repository, so an init/clone/worktree that appears closer to cwd invalidates
// it. Explicit --git-dir/--work-tree overrides re-point resolution entirely and
// never read the cache.
const repoRootCache = new Map();
const REPO_ROOT_CACHE_MAX = 64;

function repoRootCacheKey(plan) {
  return plan.globalArgs.length ? null : resolve(plan.cwd);
}

function nearestGitDir(startDir) {
  let dir = resolve(startDir);
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function cachedRepoRoot(key, plan) {
  if (!key) return null;
  const hit = repoRootCache.get(key);
  if (!hit) return null;
  const nearest = nearestGitDir(plan.cwd);
  if (!nearest || resolve(nearest) !== resolve(hit.root)) {
    repoRootCache.delete(key);
    return null;
  }
  repoRootCache.delete(key);
  repoRootCache.set(key, hit);
  return hit;
}

function rememberRepoRoot(key, hit) {
  if (!key || !hit?.root) return;
  repoRootCache.delete(key);
  repoRootCache.set(key, hit);
  while (repoRootCache.size > REPO_ROOT_CACHE_MAX) {
    const oldest = repoRootCache.keys().next().value;
    if (oldest === undefined) break;
    repoRootCache.delete(oldest);
  }
}

// `lockKey` is the repository's canonical common git dir: the main checkout
// and its linked worktrees share one object store and ref namespace, so their
// writes share one repository lock state, scoped per worktree (managed
// worktree mutations take the same key for the whole repository).
async function resolveRepo(plan, signal) {
  const key = repoRootCacheKey(plan);
  const hit = cachedRepoRoot(key, plan);
  if (hit) return { root: hit.root, lockKey: hit.lockKey, probe: null };
  const result = await runGit(plan, ['rev-parse', '--show-toplevel', '--path-format=absolute', '--git-common-dir'], {
    signal,
  });
  if (succeeded(result)) {
    const [root, commonDir] = cleanText(result.stdout).split('\n');
    const resolved = { root, lockKey: gitRepoLockKey(commonDir || root) };
    rememberRepoRoot(key, resolved);
    return { ...resolved, probe: result };
  }
  // A bare repository (mirror clone, server-side repo) has no work tree, so
  // `--show-toplevel` refuses; that is still a repository. Answering
  // "not a git repository" here sent a caller off to clone a work tree just
  // to inspect objects it already had.
  if (/must be run in a work tree/i.test(String(result.stderr || ''))) {
    const bare = await runGit(plan, ['rev-parse', '--absolute-git-dir'], { signal });
    if (!succeeded(bare)) return { root: null, lockKey: null, probe: bare };
    const root = cleanText(bare.stdout);
    const resolved = { root, lockKey: gitRepoLockKey(root) };
    rememberRepoRoot(key, resolved);
    return { ...resolved, probe: bare };
  }
  return { root: null, lockKey: null, probe: result };
}

const CONFIG_SUBCOMMANDS = new Set(['get', 'set', 'unset', 'list', 'rename-section', 'remove-section', 'edit']);

function localizeConfigPlan(plan) {
  if (plan.operation !== 'config') return plan;
  const external = plan.args.find(
    (value) =>
      ['--global', '--system', '--file', '-f'].includes(value) ||
      value.startsWith('--file=') ||
      (/^-f./.test(value) && !value.startsWith('--'))
  );
  if (external) throw new Error(`git config ${external} is outside the local repository scope`);
  if (plan.args.some((value) => value === '--local' || value === '--worktree')) return plan;
  // `git config get|set|list …` takes its scope option after the subcommand
  // (`--local get k` reads `get` as a key name); the legacy form takes it first.
  if (CONFIG_SUBCOMMANDS.has(plan.args[0])) {
    return { ...plan, args: [plan.args[0], '--local', ...plan.args.slice(1)] };
  }
  return { ...plan, args: ['--local', ...plan.args] };
}

// init/clone options that consume the following argument.
const CREATION_VALUE_FLAGS = new Set([
  '-b',
  '--branch',
  '-c',
  '--config',
  '--depth',
  '-j',
  '--jobs',
  '-o',
  '--origin',
  '--reference',
  '--reference-if-able',
  '--separate-git-dir',
  '--template',
  '-u',
  '--upload-pack',
  '--filter',
  '--server-option',
  '--shallow-since',
  '--shallow-exclude',
  '--bundle-uri',
  '--revision',
  '--ref-format',
  '--object-format',
  '--initial-branch',
]);

function optionFreePositionals(args, valueFlags = CREATION_VALUE_FLAGS) {
  const out = [];
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (value === '--') {
      out.push(...args.slice(index + 1));
      break;
    }
    if (valueFlags.has(value)) {
      index++;
      continue;
    }
    if (value.startsWith('-')) continue;
    out.push(value);
  }
  return out;
}

function creationTarget(plan) {
  const positional = optionFreePositionals(plan.args);
  if (plan.operation === 'init') return resolve(plan.cwd, positional.at(-1) || '.');
  if (plan.operation !== 'clone') return plan.cwd;
  if (positional.length >= 2) return resolve(plan.cwd, positional.at(-1));
  const source = String(positional[0] || '').replace(/[\\/]+$/, '');
  const leaf =
    basename(source.includes(':') ? source.slice(source.lastIndexOf(':') + 1) : source).replace(/\.git$/i, '') ||
    'repo';
  return resolve(plan.cwd, leaf);
}

// Pruning or repacking deletes unreachable objects, including ones a write in
// any worktree has just created and not yet referenced (git gc documents
// --prune=now as unsafe beside a concurrent writer), so these hold the whole
// repository.
const REPO_WIDE_OPERATIONS = new Set(['gc', 'maintenance', 'prune', 'prune-packed', 'repack']);

// The worktrees a mutating plan touches; null holds the whole repository. A
// write changes its cwd's worktree, so writes on different worktrees never
// wait for each other. (`git worktree` never runs as a git write here: it
// maps to managed operations, which take the repository lock themselves.)
function writeScopes(plan, root) {
  if (REPO_WIDE_OPERATIONS.has(plan.operation)) return null;
  return [root];
}

// A mutating git call holds the in-process and cross-process locks on its
// paths, and drops the result caches it may have invalidated.
function withGitMutationLocks(paths, callback) {
  return withBuiltinPathLocks(paths, () => withAdvisoryLocks(paths, callback));
}

// A write holds Mixdog's repository lock on the worktrees it touches (the
// whole repository when `scopes` is null), then the path and cross-process
// locks on the same paths; `callback` learns how long acquiring them took.
function withGitWriteLocks(lockKey, scopes, root, signal, callback) {
  const started = Date.now();
  return withGitWorktreeWriteLock(
    lockKey,
    scopes,
    () => withGitMutationLocks(scopes || [root], () => callback(Date.now() - started)),
    { signal }
  );
}

// The managed snapshot worktree `repo` lies in, else null. A registry that
// cannot be read names none: commands elsewhere run as before.
function snapshotContaining(repo) {
  let entries;
  try {
    entries = readRegistrySync().entries;
  } catch {
    return null;
  }
  return (
    Object.values(entries).find(
      (record) =>
        record?.kind === WORKTREE_SNAPSHOT_KIND && typeof record.path === 'string' && isWithin(record.path, repo)
    ) ?? null
  );
}

// A command run in a snapshot worktree is one of its consumers: the workspace
// lease it holds (activity-gate, the same as a background shell's) keeps the
// snapshot from being removed in any process until it ends, and a snapshot
// whose removal is under way refuses it. Returns the release.
async function admitSnapshotCommand(repo, sessionId) {
  const snapshot = snapshotContaining(repo);
  if (!snapshot) return () => {};
  const leave = await tryAdmitWorkspaceActivityAsync(sessionId || 'git-tool', repo, { kind: 'command' });
  if (!leave) throw new Error(`the snapshot worktree ${snapshot.path} is being removed; nothing ran`);
  // Fails only when workspace admission stopped (reported there), which keeps the snapshot held.
  return () => leave().catch(() => {});
}

function invalidateAfterGitMutation() {
  invalidateBuiltinResultCache();
  drainCodeGraphCache();
}

function outputLimit(value, fallback) {
  return Math.min(GIT_OUTPUT_LIMIT_MAX, Math.max(1, Number(value) || fallback));
}

function abortSignalOf(options) {
  return options?.signal || options?.abortSignal || null;
}

function stageRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { error: 'git stage must be an object' };
  }
  const diffId = typeof value.diff_id === 'string' ? value.diff_id.trim() : '';
  const rawIds = Array.isArray(value.change_ids) ? value.change_ids : [value.change_ids];
  const changeIds = [...new Set(rawIds.map((item) => String(item || '').trim()).filter(Boolean))];
  if (!diffId) return { error: 'git stage requires diff_id from a prior git diff' };
  if (!changeIds.length) return { error: 'git stage requires at least one change_id' };
  if (changeIds.length > 50) return { error: 'git stage accepts at most 50 change_ids' };
  return { diffId, changeIds };
}

async function withStagePatchFile(patch, callback) {
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-git-stage-'));
  const patchPath = join(directory, 'selected.patch');
  try {
    await writeFile(patchPath, patch, 'utf8');
    return await callback(patchPath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function executeGitStage(input, workDir, options = {}) {
  const request = stageRequest(input);
  if (request.error) return fail(request.error);
  const snapshot = getDiffSnapshot(request.diffId);
  if (!snapshot) {
    return ok({
      staged: false,
      reason: 'expired_diff',
      hint: 'Run git diff with include_stage_ids:true again and use its new diff_id/change_ids.',
    });
  }
  if (snapshot.scope !== resolve(workDir || process.cwd())) {
    return ok({
      staged: false,
      reason: 'scope_mismatch',
      hint: 'Run git diff with include_stage_ids:true in the current Project and use its diff_id/change_ids.',
    });
  }
  const limit = outputLimit(input?.output_limit, GIT_OUTPUT_LINES_DEFAULT);
  const signal = abortSignalOf(options);
  const repo = snapshot.repo;
  const { lockKey } = await resolveRepo({ ...snapshot.plan, cwd: repo }, signal);
  // The diff check and the index apply form one transaction on this
  // worktree's index, so the stage holds its worktree for both.
  return withGitWriteLocks(lockKey || repo, [repo], repo, signal, async (waitedMs) => {
    const noted = (text, result) => appendText(text, lockWaitNote(waitedMs, result));
    const answer = (data, result) => {
      const note = lockWaitNote(waitedMs, result);
      return ok(note ? { ...data, note } : data);
    };
    const current = await runStageableDiff(snapshot.plan, snapshot.argv, repo, signal);
    if (!succeeded(current)) return noted(commandFailure(snapshot.plan, current, limit));
    if (current.notUtf8) return noted(fail(NOT_UTF8_STAGE_NOTE));
    const raw = current.stdout;
    if (!diffSnapshotMatches(snapshot, raw)) {
      return answer({
        staged: false,
        reason: 'stale_diff',
        hint: 'The working diff changed. Run git diff with include_stage_ids:true again and select current change_ids.',
      });
    }
    const built = buildSelectedStagePatch(raw, request.changeIds);
    if (built.missing.length || !built.patch) {
      return noted(
        fail(`git stage change_ids are not present in the diff: ${built.missing.join(', ') || '(none selected)'}`)
      );
    }
    return withStagePatchFile(built.patch, async (patchPath) => {
      const applyArgs = ['apply', '--cached', '--unidiff-zero', patchPath];
      const applyPlan = { ...snapshot.plan, cwd: repo, operation: 'apply', args: applyArgs.slice(1) };
      const check = await runGit(applyPlan, ['apply', '--cached', '--check', '--unidiff-zero', patchPath], {
        signal,
      });
      if (!succeeded(check)) return noted(commandFailure(applyPlan, check, limit));
      const applied = await runGitWrite(applyPlan, applyArgs, { signal });
      if (!succeeded(applied)) return noted(commandFailure(applyPlan, applied, limit), applied);
      deleteDiffSnapshot(request.diffId);
      invalidateAfterGitMutation();
      return answer({ staged: true, ...stagedSummary(built.changes) }, applied);
    });
  });
}

async function executeSingleGitTool(input, workDir, options = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return rejected('git requires an arguments object');
  const hasCommand = typeof input.command === 'string' && Boolean(input.command.trim());
  if (!hasCommand) {
    return rejected(
      input.include_stage_ids === true
        ? 'git requires command; staging IDs come from command:"git diff" (or "git diff -- <paths>") with include_stage_ids:true'
        : 'git requires command: a full command starting with git, e.g. command:"git status"'
    );
  }
  let plan;
  try {
    plan = localizeConfigPlan(parseCommand(input.command, workDir));
  } catch (error) {
    return rejected(error.message);
  }
  // No unmanaged worktree is ever made here: worktree commands run as their
  // managed operations (git-worktree-tool.mjs); only `list --porcelain` stays git.
  if (plan.operation === 'worktree') {
    const mapped = await executeRawWorktree(plan, input, options);
    if (mapped) {
      if (!isReadOnly(plan)) invalidateAfterGitMutation();
      return mapped;
    }
  }
  if (
    plan.operation === 'archive' &&
    !plan.args.some((value) => value === '-o' || value === '--output' || value.startsWith('--output='))
  ) {
    return rejected('git archive requires -o/--output; binary stdout is not returned');
  }
  const limitDefault = plan.operation === 'log' ? GIT_LOG_LINES_DEFAULT : GIT_OUTPUT_LINES_DEFAULT;
  const limit = {
    lines: outputLimit(input.output_limit, limitDefault),
    chars: options.charBudget ?? COMMAND_CHAR_BUDGET,
  };
  const signal = abortSignalOf(options);
  if (plan.operation === 'init' || plan.operation === 'clone') {
    const target = creationTarget(plan);
    return withGitWriteLocks(target, null, target, signal, async (waitedMs) => {
      const result = await runGit(plan, [plan.operation, ...plan.args], { signal });
      invalidateAfterGitMutation();
      const rendered = commandResult(plan, result, limit);
      rendered.text = appendText(rendered.text, lockWaitNote(waitedMs));
      return rendered;
    });
  }
  if (REPO_FREE_OPERATIONS.has(plan.operation)) {
    const result = await runGit(plan, [plan.operation, ...plan.args], { signal });
    return commandResult(plan, result, limit);
  }
  // Report the command the caller actually ran. Naming the internal probe
  // ("git rev-parse exited 128") for a `git status` in a plain directory hid
  // git's own "fatal: not a git repository" line behind a command the model
  // never issued — and re-ran the probe just to build that message.
  const { root: repo, lockKey, probe } = await resolveRepo(plan, signal);
  if (!repo) {
    const missing = probe ?? (await runGit(plan, ['rev-parse', '--show-toplevel'], { signal }));
    return commandResult(plan, missing, limit);
  }
  // A command in a snapshot worktree uses it like a worker would: it holds a
  // workspace lease there while it runs, so the snapshot is never removed
  // under it, and a snapshot being removed refuses it.
  let leaveSnapshot;
  try {
    leaveSnapshot = await admitSnapshotCommand(repo, options.sessionId);
  } catch (error) {
    return rejected(error.message);
  }
  try {
    return await runInRepository(input, plan, { repo, lockKey, limit, signal, workDir });
  } finally {
    await leaveSnapshot();
  }
}

async function runInRepository(input, plan, { repo, lockKey, limit, signal, workDir }) {
  const prepared = prepare(plan);
  const stageableRequest = plan.operation === 'diff' && (plan.args.length === 0 || plan.args[0] === '--');
  if (stageableRequest) prepared.argv.splice(1, 0, '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/');
  // A read takes no lock, so it never waits behind another read, a long
  // `git log -S`, or a write (git-repo-rw-lock.mjs explains why that is safe).
  if (isReadOnly(plan)) {
    const result = stageableRequest
      ? await runStageableDiff(plan, prepared.argv, repo, signal)
      : await runGit(plan, prepared.argv, { signal, readOnly: true });
    if (!succeeded(result)) return commandResult(plan, result, limit);
    if (stageableRequest && input.include_stage_ids === true) {
      if (result.notUtf8) {
        const rendered = commandResult(plan, result, limit);
        rendered.text = appendText(rendered.text, NOT_UTF8_STAGE_NOTE);
        return rendered;
      }
      const snapshot = createDiffSnapshot({
        repo,
        scope: resolve(workDir || process.cwd()),
        plan,
        argv: prepared.argv,
        raw: result.stdout,
      });
      return stageableDiffResult(plan, result, snapshot, limit);
    }
    return commandResult(plan, result, limit);
  }
  return withGitWriteLocks(lockKey, writeScopes(plan, repo), repo, signal, async (waitedMs) => {
    // A managed removal holds the same folder lock while it deletes: once it
    // is ours, a folder that is gone was removed, and nothing runs there.
    if (!existsSync(repo)) return rejected(`the worktree folder ${repo} was removed meanwhile; nothing ran`);
    const result = await runGitWrite(plan, prepared.argv, { signal });
    invalidateAfterGitMutation();
    const rendered = commandResult(plan, result, limit);
    rendered.text = appendText(rendered.text, lockWaitNote(waitedMs, result));
    return rendered;
  });
}

// `git a && git b` written as one string means exactly what the command array
// means: run in order, stop at the first failure. Splitting it here answers in
// one shot instead of rejecting and costing a round trip. Only top-level `&&`,
// `;` and newlines split; each piece still has to be a full git command, so
// pipes, redirects, substitution and non-git segments are refused as before.
function splitChainedGitCommands(command) {
  const text = String(command ?? '');
  const pieces = [];
  let quote = null;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (char === '\\' && quote === '"') {
        index += 1;
        continue;
      }
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    let width = 0;
    if (char === '&' && text[index + 1] === '&') width = 2;
    else if (char === ';' || char === '\n') width = 1;
    else if (char === '\r' && text[index + 1] === '\n') width = 2;
    if (!width) continue;
    pieces.push(text.slice(start, index));
    index += width - 1;
    start = index + 1;
  }
  if (quote || pieces.length === 0) return null;
  pieces.push(text.slice(start));
  const commands = pieces.map((piece) => piece.trim()).filter(Boolean);
  return commands.length > 1 ? commands : null;
}

// The tool only runs git, so a submitted command that omits the leading `git`
// ("status --short") gets it instead of a rejection. Only whole submitted
// commands are prefixed; a `&&` piece after the first still has to be a full
// git command, so non-git chain segments stay refused.
// A JSON-stringified string[] ('["git status","git log"]') for an array param.
// No git command or change id starts with `[`, so this never reinterprets a
// call that could have worked.
function parseStringifiedArray(value) {
  if (typeof value !== 'string') return value;
  const text = value.trim();
  if (!text.startsWith('[') || !text.endsWith(']')) return value;
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) && parsed.length > 0 && parsed.every((item) => typeof item === 'string')
      ? parsed
      : value;
  } catch {
    return value;
  }
}

function withGitPrefix(command) {
  if (typeof command !== 'string') return command;
  const text = String(unwrapQuotedCommand(command)).trim();
  const first = text ? tokenizeDirectArgv(text)?.[0] : '';
  if (!first || /(^|[\\/])git(?:\.exe)?$/i.test(first)) return command;
  return `git ${text}`;
}

export async function executeGitTool(rawInput, workDir, options = {}) {
  if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput))
    return fail('git requires an arguments object');
  const rawCommand = parseStringifiedArray(rawInput.command);
  const input = {
    ...rawInput,
    command: Array.isArray(rawCommand) ? rawCommand.map(withGitPrefix) : withGitPrefix(rawCommand),
  };
  if (rawInput.change_ids !== undefined) input.change_ids = parseStringifiedArray(rawInput.change_ids);
  if (rawInput.command === undefined) delete input.command;
  const action = input.action ?? 'command';
  if (action === 'worktree') {
    const text = await executeWorktreeAction(input, workDir, options);
    if (input.worktree_action !== 'list') invalidateAfterGitMutation();
    return text;
  }
  const worktreeField = WORKTREE_INPUT_FIELDS.find((field) => input[field] !== undefined);
  if (worktreeField) return fail(`git ${worktreeField} requires action:worktree`);
  if (input.confirm_large !== undefined && action !== 'command') {
    return fail('git confirm_large applies to action:worktree or a git worktree add command');
  }
  if (action === 'stage') {
    if (input.command !== undefined || input.include_stage_ids !== undefined) {
      return fail('git action:stage accepts diff_id/change_ids, not command/include_stage_ids');
    }
    return executeGitStage(input, workDir, options);
  }
  if (action !== 'command') return fail('git action must be command, stage or worktree');
  if (input.diff_id !== undefined || input.change_ids !== undefined) {
    return fail('git diff_id/change_ids require action:stage');
  }
  const chained = typeof input.command === 'string' ? splitChainedGitCommands(input.command) : null;
  if (!Array.isArray(input.command) && !chained) return (await executeSingleGitTool(input, workDir, options)).text;
  const commands = chained || input.command;
  if (commands.length < 1 || commands.length > GIT_COMMAND_ARRAY_LIMIT) {
    return fail(`git command array requires 1 to ${GIT_COMMAND_ARRAY_LIMIT} commands`);
  }

  const operations = [];
  for (let index = 0; index < commands.length; index += 1) {
    const command = commands[index];
    if (typeof command !== 'string' || !command.trim()) {
      return fail(`git command ${index + 1} must be a non-empty string`);
    }
    try {
      operations.push(localizeConfigPlan(parseCommand(command, workDir)).operation);
    } catch (error) {
      return fail(`git command ${index + 1}: ${error.message}`);
    }
  }

  // Ordered execution with fail-fast: a mutation sequence (`reflog expire`
  // then `gc`) must not run its later steps on a state the earlier step did
  // not produce. Every command is parsed above before any runs, so a typo in
  // command 3 never leaves commands 1-2 half applied. Each write still
  // acquires its own worktree lock inside executeSingleGitTool.
  // Headers name the position and subcommand only: echoing the argument list
  // (a 22-path `add`) cost more than the result it labelled.
  const results = [];
  let used = 0;
  for (let index = 0; index < commands.length; index += 1) {
    const label = `${index + 1}: git ${operations[index]}`;
    const charBudget = Math.min(COMMAND_CHAR_BUDGET, Math.max(MIN_COMMAND_CHARS, ARRAY_CHAR_BUDGET - used));
    const result = await executeSingleGitTool({ ...input, command: commands[index] }, workDir, {
      ...options,
      charBudget,
    });
    const section = `## ${label}\n${result.text}`;
    used += section.length;
    results.push(section);
    if (result.failed) {
      return appendText(results.join('\n'), `error: command failed: ${label}`);
    }
  }
  return results.join('\n');
}

export const _gitCommandInternals = {
  creationTarget,
  commandResult,
  stageableDiffResult,
  localizeConfigPlan,
  parseCommand,
  prepare,
  resolveRepo,
  writeScopes,
};
