import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { tokenizeDirectArgv } from './shell-direct-exe.mjs';
import { withBuiltinPathLocks } from './path-locks.mjs';
import { withAdvisoryLocks } from './advisory-lock.mjs';
import { withGitRepoReadLock, withGitRepoWriteLock } from './git-repo-rw-lock.mjs';
import { invalidateBuiltinResultCache } from './cache-layers.mjs';
import { drainCodeGraphCache } from '../code-graph-state.mjs';
import { ensureNativeSpawnServer, tryNativeSpawn } from '../lib/native-spawn-client.mjs';
import { commandHasShellSyntax, gitPlanIsReadOnly as isReadOnly, OPERATION_ALIASES } from './git-command-policy.mjs';
import {
  buildSelectedStagePatch,
  createDiffSnapshot,
  deleteDiffSnapshot,
  diffSnapshotMatches,
  getDiffSnapshot,
} from './git-partial-stage.mjs';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_CAPTURE_BYTES = 128 * 1024 * 1024;
const GIT_OUTPUT_LIMIT_MAX = 200;
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
  description:
    'Run Git here, never through shell. An array (max 10) runs in order and stops on failure; batch read-only commands in one. diff for known changes, status to discover them; history only when needed. git diff or git diff -- <paths> includes untracked files. Set include_stage_ids:true to select changes, then action:stage with diff_id/change_ids. Staging rejects stale or cross-Project diffs and returns selected locations.',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['command', 'stage'],
        description: 'Default command. stage uses diff_id/change_ids instead of command.',
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
        description: 'Body line cap; staging IDs are not capped. Default 50; git log defaults to 10.',
      },
      include_stage_ids: {
        type: 'boolean',
        description:
          'Include staging IDs outside the body cap for git diff or git diff -- <paths> only. Default false.',
      },
      diff_id: { type: 'string', description: 'stage: exact diff_id from git diff with include_stage_ids:true.' },
      change_ids: {
        anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' }, maxItems: 50 }],
        description: 'stage: exact change ID or IDs to stage, including new files.',
      },
    },
    additionalProperties: false,
  },
};

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

function capOutput(text, limit) {
  const lines = outputLines(text);
  if (lines.length <= limit) return text;
  return appendText(
    lines.slice(0, limit).join(''),
    `... [${lines.length - limit} more lines omitted; raise output_limit or narrow the command]`
  );
}

function commandResult(plan, result, limit) {
  const output = capOutput(appendText(String(result.stdout || ''), String(result.stderr || '')), limit);
  if (succeeded(result)) return { text: output, failed: false };
  const processError = result.error || result.timedOut || result.aborted || result.overflow || result.exitCode == null;
  return {
    text: appendText(processError ? fail(gitFailureReason(plan, result)) : `exit ${result.exitCode}`, output),
    failed: true,
  };
}

function stageableDiffResult(plan, result, snapshot, limit) {
  if (!snapshot.diffId) return commandResult(plan, result, limit);
  const rendered = commandResult(plan, result, limit);
  rendered.text = appendText(rendered.text, `diff_id: ${snapshot.diffId}`);
  let previousPath;
  for (const change of snapshot.changes) {
    if (change.path !== previousPath) {
      rendered.text = appendText(rendered.text, `file: ${JSON.stringify(change.path)}`);
      previousPath = change.path;
    }
    const location =
      change.kind || `@@ -${change.old_start},${change.deletions} +${change.new_start},${change.additions} @@`;
    rendered.text = appendText(rendered.text, `change:${change.id} ${location}`);
  }
  return rendered;
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
  if (commandHasShellSyntax(command))
    throw new Error(
      'git command must not contain shell operators or substitution; multiple commands belong in the command array'
    );
  const tokens = tokenizeDirectArgv(command);
  if (!tokens?.length || !/(^|[\\/])git(?:\.exe)?$/i.test(tokens[0])) {
    throw new Error('command must begin with git');
  }
  let cwd = resolve(workDir || process.cwd());
  const globalArgs = [];
  let index = 1;
  while (index < tokens.length) {
    const token = tokens[index];
    if (token === '-C') {
      const path = tokens[++index];
      if (!path) throw new Error('git -C requires a path');
      cwd = resolve(cwd, path);
      index++;
      continue;
    }
    if (token.startsWith('-C') && token.length > 2) {
      cwd = resolve(cwd, token.slice(2));
      index++;
      continue;
    }
    if (
      token === '-c' ||
      token === '--config-env' ||
      token === '--git-dir' ||
      token === '--work-tree' ||
      token === '--namespace'
    ) {
      const value = tokens[index + 1];
      if (!value) throw new Error(`${token} requires a value`);
      globalArgs.push(token, value);
      index += 2;
      continue;
    }
    if (
      /^--(?:git-dir|work-tree|namespace|config-env)=/.test(token) ||
      [
        '--no-pager',
        '--paginate',
        '--bare',
        '--literal-pathspecs',
        '--glob-pathspecs',
        '--noglob-pathspecs',
        '--icase-pathspecs',
      ].includes(token)
    ) {
      globalArgs.push(token);
      index++;
      continue;
    }
    break;
  }
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

async function runProcess(program, argv, { cwd, signal, maxBytes = MAX_CAPTURE_BYTES } = {}) {
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
        },
        outputLimit: maxBytes,
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

function commandFailure(plan, result, limit = 50) {
  return commandResult(plan, result, limit).text;
}

function runGit(plan, argv, options = {}) {
  return runProcess('git', [...plan.globalArgs, ...argv], { cwd: plan.cwd, signal: options.signal });
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

async function runStageableDiff(plan, argv, repo, signal) {
  const result = await runGit(plan, argv, { signal });
  if (!succeeded(result)) return result;
  result.stdout = String(result.stdout);
  result.stderr = String(result.stderr);
  const paths = plan.args.slice(1);
  const untracked = await runGit(
    plan,
    ['ls-files', '--others', '--exclude-standard', '--full-name', '-z', '--', ...paths],
    { signal }
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
      { signal }
    );
    // --no-index uses exit 1 for a successfully produced patch.
    if (!succeeded({ ...added, exitCode: added.exitCode === 1 ? 0 : added.exitCode })) return added;
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
  const root = repoRootCache.get(key);
  if (!root) return null;
  const nearest = nearestGitDir(plan.cwd);
  if (!nearest || resolve(nearest) !== resolve(root)) {
    repoRootCache.delete(key);
    return null;
  }
  repoRootCache.delete(key);
  repoRootCache.set(key, root);
  return root;
}

function rememberRepoRoot(key, root) {
  if (!key || !root) return;
  repoRootCache.delete(key);
  repoRootCache.set(key, root);
  while (repoRootCache.size > REPO_ROOT_CACHE_MAX) {
    const oldest = repoRootCache.keys().next().value;
    if (oldest === undefined) break;
    repoRootCache.delete(oldest);
  }
}

async function resolveRepo(plan, signal) {
  const key = repoRootCacheKey(plan);
  const hit = cachedRepoRoot(key, plan);
  if (hit) return { root: hit, probe: null };
  const result = await runGit(plan, ['rev-parse', '--show-toplevel'], { signal });
  if (succeeded(result)) {
    const root = cleanText(result.stdout);
    rememberRepoRoot(key, root);
    return { root, probe: result };
  }
  // A bare repository (mirror clone, server-side repo) has no work tree, so
  // `--show-toplevel` refuses; that is still a repository. Answering
  // "not a git repository" here sent a caller off to clone a work tree just
  // to inspect objects it already had.
  if (/must be run in a work tree/i.test(String(result.stderr || ''))) {
    const bare = await runGit(plan, ['rev-parse', '--absolute-git-dir'], { signal });
    if (!succeeded(bare)) return { root: null, probe: bare };
    const root = cleanText(bare.stdout);
    rememberRepoRoot(key, root);
    return { root, probe: bare };
  }
  return { root: null, probe: result };
}

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
  return { ...plan, args: ['--local', ...plan.args] };
}

function optionFreePositionals(args) {
  const takesValue = new Set([
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
  const out = [];
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (value === '--') {
      out.push(...args.slice(index + 1));
      break;
    }
    if (takesValue.has(value)) {
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

async function executeCreation(plan, target, limit, signal) {
  return withBuiltinPathLocks([target], () =>
    withAdvisoryLocks([target], async () => {
      const result = await runGit(plan, [plan.operation, ...plan.args], { signal });
      invalidateBuiltinResultCache();
      drainCodeGraphCache();
      return commandResult(plan, result, limit);
    })
  );
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
  const limit = Math.min(GIT_OUTPUT_LIMIT_MAX, Math.max(1, Number(input?.output_limit) || 50));
  const signal = options?.signal || options?.abortSignal || null;
  const repo = snapshot.repo;
  return withGitRepoWriteLock(
    repo,
    () =>
      withBuiltinPathLocks([repo], () =>
        withAdvisoryLocks([repo], async () => {
          const current = await runStageableDiff(snapshot.plan, snapshot.argv, repo, signal);
          if (!succeeded(current)) return commandFailure(snapshot.plan, current, limit);
          const raw = current.stdout;
          if (!diffSnapshotMatches(snapshot, raw)) {
            return ok({
              staged: false,
              reason: 'stale_diff',
              hint: 'The working diff changed. Run git diff with include_stage_ids:true again and select current change_ids.',
            });
          }
          const built = buildSelectedStagePatch(raw, request.changeIds);
          if (built.missing.length || !built.patch) {
            return fail(
              `git stage change_ids are not present in the diff: ${built.missing.join(', ') || '(none selected)'}`
            );
          }
          return withStagePatchFile(built.patch, async (patchPath) => {
            const applyArgs = ['apply', '--cached', '--unidiff-zero', patchPath];
            const applyPlan = { ...snapshot.plan, cwd: repo, operation: 'apply', args: applyArgs.slice(1) };
            const check = await runGit(applyPlan, ['apply', '--cached', '--check', '--unidiff-zero', patchPath], {
              signal,
            });
            if (!succeeded(check)) return commandFailure(applyPlan, check, limit);
            const applied = await runGit(applyPlan, applyArgs, { signal });
            if (!succeeded(applied)) return commandFailure(applyPlan, applied, limit);
            deleteDiffSnapshot(request.diffId);
            invalidateBuiltinResultCache();
            drainCodeGraphCache();
            return ok({
              staged: true,
              changes: built.changes.map(({ id, preview, ...change }) => change),
            });
          });
        })
      ),
    { signal }
  );
}

async function executeSingleGitTool(input, workDir, options = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return rejected('git requires an arguments object');
  const hasCommand = typeof input.command === 'string' && Boolean(input.command.trim());
  if (!hasCommand) return rejected('git requires command');
  let plan;
  try {
    plan = localizeConfigPlan(parseCommand(input.command, workDir));
  } catch (error) {
    return rejected(error.message);
  }
  if (
    plan.operation === 'archive' &&
    !plan.args.some((value) => value === '-o' || value === '--output' || value.startsWith('--output='))
  ) {
    return rejected('git archive requires -o/--output; binary stdout is not returned');
  }
  const limitDefault = plan.operation === 'log' ? 10 : 50;
  const limit = Math.min(GIT_OUTPUT_LIMIT_MAX, Math.max(1, Number(input.output_limit) || limitDefault));
  const signal = options?.signal || options?.abortSignal || null;
  if (plan.operation === 'init' || plan.operation === 'clone') {
    const target = creationTarget(plan);
    return withGitRepoWriteLock(target, () => executeCreation(plan, target, limit, signal), { signal });
  }
  if (REPO_FREE_OPERATIONS.has(plan.operation)) {
    const result = await runGit(plan, [plan.operation, ...plan.args], { signal });
    return commandResult(plan, result, limit);
  }
  // Report the command the caller actually ran. Naming the internal probe
  // ("git rev-parse exited 128") for a `git status` in a plain directory hid
  // git's own "fatal: not a git repository" line behind a command the model
  // never issued — and re-ran the probe just to build that message.
  const { root: repo, probe } = await resolveRepo(plan, signal);
  if (!repo) {
    const missing = probe ?? (await runGit(plan, ['rev-parse', '--show-toplevel'], { signal }));
    return commandResult(plan, missing, limit);
  }
  const prepared = prepare(plan);
  const stageableRequest = plan.operation === 'diff' && (plan.args.length === 0 || plan.args[0] === '--');
  if (stageableRequest) prepared.argv.splice(1, 0, '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/');
  if (isReadOnly(plan)) {
    return withGitRepoReadLock(
      repo,
      async () => {
        const result = stageableRequest
          ? await runStageableDiff(plan, prepared.argv, repo, signal)
          : await runGit(plan, prepared.argv, { signal });
        if (!succeeded(result)) return commandResult(plan, result, limit);
        if (stageableRequest && input.include_stage_ids === true) {
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
      },
      { signal }
    );
  }
  return withGitRepoWriteLock(
    repo,
    () =>
      withBuiltinPathLocks([repo], () =>
        withAdvisoryLocks([repo], async () => {
          const result = await runGit(plan, prepared.argv, { signal });
          invalidateBuiltinResultCache();
          drainCodeGraphCache();
          return commandResult(plan, result, limit);
        })
      ),
    { signal }
  );
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

export async function executeGitTool(input, workDir, options = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fail('git requires an arguments object');
  const action = input.action ?? 'command';
  if (action === 'stage') {
    if (input.command !== undefined || input.include_stage_ids !== undefined) {
      return fail('git action:stage accepts diff_id/change_ids, not command/include_stage_ids');
    }
    return executeGitStage(input, workDir, options);
  }
  if (action !== 'command') return fail('git action must be command or stage');
  if (input.diff_id !== undefined || input.change_ids !== undefined) {
    return fail('git diff_id/change_ids require action:stage');
  }
  const chained = typeof input.command === 'string' ? splitChainedGitCommands(input.command) : null;
  if (!Array.isArray(input.command) && !chained) return (await executeSingleGitTool(input, workDir, options)).text;
  const commands = chained || input.command;
  if (commands.length < 1 || commands.length > GIT_COMMAND_ARRAY_LIMIT) {
    return fail(`git command array requires 1 to ${GIT_COMMAND_ARRAY_LIMIT} commands`);
  }

  for (let index = 0; index < commands.length; index += 1) {
    const command = commands[index];
    if (typeof command !== 'string' || !command.trim()) {
      return fail(`git command ${index + 1} must be a non-empty string`);
    }
    try {
      localizeConfigPlan(parseCommand(command, workDir));
    } catch (error) {
      return fail(`git command ${index + 1}: ${error.message}`);
    }
  }

  // Ordered execution with fail-fast: a mutation sequence (`reflog expire`
  // then `gc`) must not run its later steps on a state the earlier step did
  // not produce. Every command is parsed above before any runs, so a typo in
  // command 3 never leaves commands 1-2 half applied. Each command still
  // acquires its own repository lock inside executeSingleGitTool.
  const results = [];
  for (const command of commands) {
    const result = await executeSingleGitTool({ ...input, command }, workDir, options);
    results.push(`## ${command}\n${result.text}`);
    if (result.failed) {
      return appendText(results.join('\n'), `error: command failed: ${command}`);
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
};
