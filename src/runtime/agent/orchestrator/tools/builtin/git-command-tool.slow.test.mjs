import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import {
  executeGitStageTool,
  executeGitTool,
  GIT_STAGE_TOOL_DEF,
  GIT_TOOL_DEF,
  _gitCommandInternals,
} from './git-command-tool.mjs';
import { commandHasShellSyntax, gitCommandMutates } from './git-command-policy.mjs';

function parseOk(result) {
  assert.equal(typeof result, 'string');
  assert.doesNotMatch(result, /^(?:error:|exit [1-9])/i, result);
  return result;
}

function parseStage(result) {
  assert.doesNotMatch(String(result), /^error:/i, String(result));
  const parsed = JSON.parse(String(result));
  assert.equal(parsed.ok, true);
  return parsed;
}

function parseDiff(text) {
  return {
    diff_id: /^diff_id: (diff_[0-9a-f]{20})$/m.exec(text)?.[1],
    changes: [...text.matchAll(/^change:(chg_[0-9a-f]{16}) ("(?:[^"\\]|\\.)*") (.+)$/gm)]
      .map((match) => ({ id: match[1], path: JSON.parse(match[2]), location: match[3] })),
  };
}

function quote(value) {
  return `"${String(value).replaceAll('"', '\\"')}"`;
}

async function git(repo, command, options = {}) {
  return executeGitTool({ command: `git -C ${quote(repo)} ${command}`, ...options }, repo);
}

test('git command tool preserves native text, shell syntax, and destructive command policy', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-git-command-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'repo');

  assert.match(parseOk(await executeGitTool({ command: `git init ${quote(repo)}` }, root)), /Initialized empty Git repository/);
  parseOk(await git(repo, 'config user.name "Mixdog Test"'));
  parseOk(await git(repo, 'config user.email mixdog@example.invalid'));
  parseOk(await git(repo, 'config core.autocrlf false'));
  assert.match(String(await git(repo, 'config --global user.name')), /outside the local repository scope/);
  assert.match(String(await git(repo, 'config --system user.name')), /outside the local repository scope/);
  assert.match(String(await git(repo, 'config --file ../outside user.name')), /outside the local repository scope/);
  assert.match(String(await git(repo, 'config -f../outside user.name')), /outside the local repository scope/);
  assert.equal(
    _gitCommandInternals.creationTarget(
      _gitCommandInternals.parseCommand(`git clone origin ${quote(join(root, 'target'))}`, root)
    ),
    join(root, 'target')
  );

  writeFileSync(join(repo, 'base.txt'), 'base\n');
  const staged = parseOk(await git(repo, 'add --all'));
  assert.equal(staged, '');
  assert.match(await git(repo, 'status'), /^A  base\.txt$/m);
  const committed = parseOk(await git(repo, 'commit -m base'));
  assert.match(committed, /^\[.+[0-9a-f]+\] base\n/);
  assert.doesNotMatch(committed, /"status"|"summary"/);
  const base = parseOk(await git(repo, 'log --format=%H -1')).trim();
  assert.match(JSON.stringify(parseOk(await git(repo, 'show-ref'))), /refs\/heads\//);
  assert.match(JSON.stringify(parseOk(await git(repo, 'count-objects -v'))), /count:/);
  parseOk(await git(repo, 'check-ref-format refs/heads/test'));
  assert.match(String(await git(repo, 'archive HEAD')), /^error: git archive requires -o\/--output/);
  parseOk(await git(repo, 'prune --expire=now'));
  const shown = parseOk(await git(repo, `show ${base}`, { output_limit: 50 }));
  assert.match(JSON.stringify(shown), new RegExp(base));
  assert.match(JSON.stringify(shown), /base\.txt/);

  writeFileSync(join(repo, 'secret.txt'), 'secret[lost-object]\n');
  parseOk(await git(repo, 'add -- secret.txt'));
  parseOk(await git(repo, 'commit -m secret -m "Recovery context" -m "Signed-off-by: Test <test@example.invalid>"'));
  const secretLog = parseOk(await git(repo, 'log -1', { output_limit: 50 }));
  const secretCommit = parseOk(await git(repo, 'rev-parse HEAD')).trim();
  assert.match(secretLog, /Recovery context/);
  assert.match(secretLog, /Signed-off-by: Test/);
  const batchShow = JSON.stringify(parseOk(await git(repo, `show ${base} ${secretCommit}`, { output_limit: 100 })));
  assert.match(batchShow, new RegExp(base));
  assert.match(batchShow, new RegExp(secretCommit));

  parseOk(await git(repo, `reset --hard ${base}`));
  const fsck = parseOk(await git(repo, 'fsck --full --unreachable --no-reflogs', { output_limit: 20 }));
  assert.match(JSON.stringify(fsck), new RegExp(secretCommit));

  const reflog = parseOk(await git(repo, 'reflog --all', { output_limit: 20 }));
  assert.ok(reflog.includes(secretCommit.slice(0, 7)));
  const selectors = [...reflog.matchAll(/^\S+ (\S+@\{\d+\}):/gm)]
    .map((row) => row[1])
    .filter((value, index, all) => all.indexOf(value) === index)
    .slice(0, 2);
  const deleteCommand = `reflog delete --rewrite ${selectors.map(quote).join(' ')}`;
  parseOk(await git(repo, deleteCommand));
  // Dry-run previews mutate nothing and still return a normal result.
  parseOk(await git(repo, 'reflog expire --dry-run --verbose --expire-unreachable=now --all'));
  parseOk(await git(repo, 'prune --dry-run'));
  parseOk(await git(repo, 'clean -nd'));
  parseOk(await git(repo, 'reflog expire --expire-unreachable=now --all --rewrite'));
  parseOk(await git(repo, 'gc --prune=now'));

  renameSync(join(repo, 'base.txt'), join(repo, 'renamed.txt'));
  parseOk(await git(repo, 'add --all'));
  const renameDiff = parseOk(await git(repo, 'diff --cached', { output_limit: 20 }));
  const renameText = renameDiff;
  assert.match(renameText, /rename from base\.txt/);
  assert.match(renameText, /rename to renamed\.txt/);
  parseOk(await git(repo, 'reset --hard HEAD'));

  writeFileSync(join(repo, 'base.txt'), `${Array.from({ length: 120 }, (_, i) => `changed-${i}`).join('\n')}\n`);
  const rawDiff = spawnSync('git', ['-C', repo, 'diff', '--', 'base.txt'], { encoding: 'utf8' }).stdout;
  const diff = parseOk(await git(repo, 'diff -- base.txt', { output_limit: 5 }));
  const rawLines = rawDiff.trimEnd().split('\n');
  assert.equal(diff.split('\ndiff_id:')[0], `${rawLines.slice(0, 5).join('\n')}\n... [${rawLines.length - 5} more lines omitted; raise output_limit or narrow the command]`);
  assert.equal(parseDiff(diff).changes.length, 1);
  assert.equal(parseDiff(diff).changes[0].path, 'base.txt');
  assert.ok(diff.length < rawDiff.length / 2);
  parseOk(await git(repo, 'restore -- base.txt'));
  assert.equal(await git(repo, 'status'), spawnSync('git', ['-C', repo, 'status', '--short', '--branch'], { encoding: 'utf8' }).stdout);

  const bare = join(root, 'remote.git');
  parseOk(await executeGitTool({ command: `git init --bare ${quote(bare)}` }, root));
  parseOk(await git(repo, `remote add origin ${quote(bare)}`));
  assert.equal(parseOk(await git(repo, 'remote get-url origin')).trim(), bare);
  const pushed = parseOk(await git(repo, 'push --set-upstream origin HEAD'));
  assert.match(pushed, /To .+/);
  assert.doesNotMatch(pushed, /"status":/);

  const cloned = join(root, 'clone');
  assert.match(
    parseOk(await executeGitTool({ command: `git clone ${quote(bare)} ${quote(cloned)}` }, root)),
    /Cloning into/
  );
  assert.match(parseOk(await git(cloned, 'pull --rebase')), /Already up to date/);
  assert.equal(parseOk(await git(cloned, 'log --oneline')).trim().split('\n').length, 1);

  for (let i = 0; i < 11; i++) {
    const extra = spawnSync('git', ['-C', repo, 'commit', '--allow-empty', '-m', `extra-${i}`], { encoding: 'utf8' });
    assert.equal(extra.status, 0, extra.stderr);
  }
  assert.match(parseOk(await git(repo, 'log')), /\.\.\. \[\d+ more lines omitted;/);
  assert.ok(parseOk(await git(repo, 'log --all --oneline', { output_limit: 20 })).trim().split('\n').length >= 12);

  for (const name of ['one.tmp', 'two.tmp', 'three.tmp']) writeFileSync(join(repo, name), name);
  const cappedStatus = parseOk(await git(repo, 'status', { output_limit: 2 }));
  assert.equal(cappedStatus.split('\n').length, 3);
  assert.match(cappedStatus, /\.\.\. \[2 more lines omitted;/);
  for (const name of ['one.tmp', 'two.tmp', 'three.tmp']) rmSync(join(repo, name));

  const worktree = join(root, 'worktree');
  parseOk(await git(repo, `worktree add -b topic ${quote(worktree)} HEAD`));
  assert.match(JSON.stringify(parseOk(await git(repo, 'worktree list --porcelain'))), /topic/);
  assert.match(JSON.stringify(parseOk(await git(repo, 'branch --list'))), /topic/);

  // A `&&` chain is the command array written as one string: same order,
  // same stop-on-failure, answered in one shot.
  const chain = parseOk(
    await executeGitTool(
      { command: `git -C ${quote(repo)} status --short && git -C ${quote(repo)} log --oneline -1` },
      root
    )
  );
  assert.equal([...chain.matchAll(/^## git /gm)].length, 2);
  assert.match(chain, /extra-10/);
  const semi = parseOk(
    await executeGitTool({ command: `git -C ${quote(repo)} status --short; git -C ${quote(repo)} branch --list` }, root)
  );
  assert.equal([...semi.matchAll(/^## git /gm)].length, 2);
  // Non-git segments, pipes and substitution stay refused before anything runs.
  assert.match(
    String(await executeGitTool({ command: 'git status && echo x' }, root)),
    /^error: git command 2: command must begin with git/
  );
  assert.match(
    String(await executeGitTool({ command: 'git status && git log | head' }, root)),
    /^error: git command 2: git command must not contain shell operators/
  );
  assert.match(
    String(await executeGitTool({ command: 'git log --format="a && b" -1' }, repo)),
    /^error: git command must not contain shell operators|a && b/
  );
  assert.match(
    String(await executeGitTool({ command: Array.from({ length: 11 }, () => 'git status') }, root)),
    /^error: git command array requires 1 to 10 commands/
  );
});

test('git tool answers semantic exits and keeps literal operator characters', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-git-semantic-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'repo');
  parseOk(await executeGitTool({ command: `git init ${quote(repo)}` }, root));
  parseOk(await git(repo, 'config user.name "Mixdog Test"'));
  parseOk(await git(repo, 'config user.email mixdog@example.invalid'));
  parseOk(await git(repo, 'config core.autocrlf false'));
  writeFileSync(join(repo, 'base.txt'), 'base\n');
  parseOk(await git(repo, 'add --all'));
  parseOk(await git(repo, 'commit -m base'));

  // A separator inside one token is argument text, not a pipeline.
  assert.match(JSON.stringify(parseOk(await git(repo, 'log --format=%h|%s -n 1'))), /\|base/);
  assert.equal(commandHasShellSyntax('git log -- ":(exclude)node_modules"'), false);
  assert.equal(commandHasShellSyntax('git log --format=$(whoami)'), true);
  assert.match(String(await git(repo, 'log | head')), /^error: git command must not contain shell operators/);

  // Exit codes stay visible even for probes with no stdout.
  assert.equal(parseOk(await git(repo, 'grep -n base -- base.txt')), 'base.txt:1:base\n');
  assert.equal(await git(repo, 'grep -n mixdog-absent-token'), 'exit 1');

  // diff reports through the exit code for --quiet and --check.
  assert.equal(parseOk(await git(repo, 'diff --quiet')), '');
  assert.equal(parseOk(await git(repo, 'diff --check')), '');
  assert.equal(parseOk(await git(repo, 'reflog exists HEAD')), '');
  assert.equal(await git(repo, 'reflog exists refs/heads/missing'), 'exit 1');
  assert.equal(await git(repo, 'show-ref --verify --quiet refs/heads/missing'), 'exit 1');
  assert.equal(await git(repo, 'rev-parse --verify --quiet refs/heads/missing'), 'exit 1');
  assert.equal(parseOk(await git(repo, 'merge-base --is-ancestor HEAD HEAD')), '');
  writeFileSync(join(repo, 'base.txt'), 'base\ntrailing   \n');
  assert.equal(await git(repo, 'diff --quiet'), 'exit 1');
  const check = await git(repo, 'diff --check');
  assert.match(check, /^exit 2\n/);
  assert.match(check, /trailing whitespace/);
});

test('git preserves non-patch diff and history presentations', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-git-presentations-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'repo');
  parseOk(await executeGitTool({ command: `git init ${quote(repo)}` }, root));
  parseOk(await git(repo, 'config user.name "Mixdog Test"'));
  parseOk(await git(repo, 'config user.email mixdog@example.invalid'));
  writeFileSync(join(repo, 'base.txt'), 'base\n');
  parseOk(await git(repo, 'add -- base.txt'));
  parseOk(await git(repo, 'commit -m base'));
  writeFileSync(join(repo, 'base.txt'), 'changed\n');

  for (const command of [
    'diff --stat -- base.txt',
    'diff --raw -- base.txt',
    'diff --numstat -- base.txt',
    'diff --name-only -- base.txt',
    'diff --name-status -- base.txt',
    'diff-files -- base.txt',
    'diff-index HEAD -- base.txt',
  ]) {
    const result = parseOk(await git(repo, command));
    assert.match(JSON.stringify(result), /base\.txt/, command);
  }

  parseOk(await git(repo, 'add -- base.txt'));
  parseOk(await git(repo, 'commit -m changed'));
  assert.match(
    JSON.stringify(parseOk(await git(repo, 'diff-tree --no-commit-id HEAD^ HEAD -- base.txt'))),
    /base\.txt/
  );
  for (const command of ['log --stat -1', 'log --raw -1', 'log -p -1', 'show --raw HEAD']) {
    const result = parseOk(await git(repo, command));
    assert.doesNotMatch(result, /^\{"ok":/, command);
    assert.match(JSON.stringify(result), /base\.txt/, command);
  }
  assert.match(JSON.stringify(parseOk(await git(repo, 'reflog list'))), /refs\/heads\//);
});

test('git show preserves native text for blobs, trees, tags and mixed objects', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-git-show-objects-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'repo');
  parseOk(await executeGitTool({ command: `git init ${quote(repo)}` }, root));
  parseOk(await git(repo, 'config user.name "Mixdog Test"'));
  parseOk(await git(repo, 'config user.email mixdog@example.invalid'));
  const native = (args, input) => {
    const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', input });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  for (const content of [
    'payload[keep-the-last-character]\n',
    'payload without a final newline',
    '\x1eabc\x1fshort\x1fauthor\x1fdate\x1fsubject\nnot a commit or patch\n',
    '',
  ]) {
    const oid = native(['hash-object', '-w', '--stdin'], content).trim();
    assert.equal(parseOk(await git(repo, `show ${oid}`)), content);
  }
  writeFileSync(join(repo, 'payload.txt'), 'document contents\n');
  parseOk(await git(repo, 'add -- payload.txt'));
  parseOk(await git(repo, 'commit -m document'));
  parseOk(await git(repo, 'tag -a annotated -m annotation'));
  const blob = native(['rev-parse', 'HEAD:payload.txt']).trim();
  for (const objects of [['HEAD:payload.txt'], ['HEAD^{tree}'], ['annotated'], ['HEAD'], [blob, 'HEAD']]) {
    const actual = parseOk(await git(repo, `show ${objects.join(' ')}`, { output_limit: 200 }));
    assert.equal(actual, native(['show', ...objects]), objects.join(' '));
  }
});

test('git policy distinguishes probes from output and ref mutations', () => {
  for (const command of ['git --version', 'git remote -v', 'git reflog exists HEAD', 'git symbolic-ref HEAD']) {
    assert.equal(gitCommandMutates({ command }), false, command);
  }
  for (const command of [
    'git remote -v update',
    'git reflog delete HEAD@{0}',
    'git symbolic-ref --delete HEAD',
    'git diff --output=outside.patch',
  ]) {
    assert.equal(gitCommandMutates({ command }), true, command);
  }
});

test('git preserves native history arguments and pins safe diff execution', () => {
  const plan = (operation, args, limit = 7) => _gitCommandInternals.prepare({ operation, args }, limit);
  assert.deepEqual(plan('diff', []).argv, ['diff', '--no-ext-diff', '--no-color']);
  assert.deepEqual(plan('diff', ['--stat']).argv, ['diff', '--no-ext-diff', '--no-color', '--stat']);
  assert.deepEqual(plan('diff-files', ['-p']).argv, ['diff-files', '--no-ext-diff', '--no-color', '-p']);
  assert.deepEqual(plan('log', ['--oneline']).argv, ['log', '--oneline']);
  assert.deepEqual(plan('log', ['--stat']).argv, ['log', '--stat']);
  assert.equal(plan('reflog', ['list']).argv[0], 'reflog');
  assert.notEqual(plan('reflog', ['list']).argv[1], 'show');
});

test('git renders process output verbatim with stderr and numeric exits', () => {
  const { commandResult } = _gitCommandInternals;
  const render = (stdout, stderr, exitCode = 0) => commandResult({ operation: 'show' }, { stdout, stderr, exitCode }, 50);
  assert.equal(
    render('  text \r\n\n', 'warning\rprogress\n').text,
    '  text \r\n\nwarning\rprogress\n'
  );
  assert.deepEqual(render('partial', 'fatal: boom\n', 128), { text: 'exit 128\npartial\nfatal: boom\n', failed: true });
  assert.deepEqual(render('exit 1\n', ''), { text: 'exit 1\n', failed: false });
});

test('git and deferred git_stage expose separate compact contracts', () => {
  const properties = GIT_TOOL_DEF.inputSchema.properties;
  assert.deepEqual(Object.keys(properties), ['command', 'output_limit']);
  assert.deepEqual(GIT_TOOL_DEF.inputSchema.required, ['command']);
  assert.deepEqual(
    properties.command.anyOf.map((entry) => entry.type),
    ['string', 'array']
  );
  assert.equal(properties.command.anyOf[1].minItems, 1);
  assert.equal(properties.command.anyOf[1].maxItems, 10);
  assert.equal(properties.output_limit.maximum, 200);
  const stageProperties = GIT_STAGE_TOOL_DEF.inputSchema.properties;
  assert.deepEqual(Object.keys(stageProperties), ['diff_id', 'change_ids', 'output_limit']);
  assert.deepEqual(GIT_STAGE_TOOL_DEF.inputSchema.required, ['diff_id', 'change_ids']);
  assert.equal(stageProperties.change_ids.anyOf[1].maxItems, 50);
  assert.equal(stageProperties.output_limit.maximum, 200);
  assert.equal(GIT_STAGE_TOOL_DEF.annotations.destructiveHint, true);
  // Advisory wording anchors; update when the public description changes.
  assert.doesNotMatch(GIT_TOOL_DEF.description, /confirm/i);
  assert.match(GIT_TOOL_DEF.description, /Run Git here, never through shell/i);
  assert.match(GIT_TOOL_DEF.description, /An array \(max 10\) runs in order and stops on failure/i);
  assert.match(GIT_TOOL_DEF.description, /history only when needed/i);
  assert.match(properties.command.description, /no pipes\/redirects\/substitution/i);
  assert.match(properties.command.description, /&& chain runs as the array/i);
});

test('git answers read and mutation commands inside a bare repository', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-git-bare-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'repo');
  parseOk(await executeGitTool({ command: `git init ${quote(repo)}` }, root));
  parseOk(await git(repo, 'config user.name "Mixdog Test"'));
  parseOk(await git(repo, 'config user.email mixdog@example.invalid'));
  writeFileSync(join(repo, 'base.txt'), 'base\n');
  parseOk(await git(repo, 'add --all'));
  parseOk(await git(repo, 'commit -m base'));
  const bare = join(root, 'mirror.git');
  parseOk(await executeGitTool({ command: `git clone --mirror --no-hardlinks ${quote(repo)} ${quote(bare)}` }, root));

  // A mirror has no work tree; it is still a repository, not "repo:false".
  const log = parseOk(await git(bare, 'log --oneline -1'));
  assert.doesNotMatch(log, /^\{/);
  assert.match(JSON.stringify(log), /base/);
  const fsck = parseOk(await git(bare, 'fsck --full --no-reflogs --unreachable'));
  assert.doesNotMatch(fsck, /^\{/);
  const expire = parseOk(await git(bare, 'reflog expire --expire=now --all'));
  assert.equal(expire, '');
  // A plain directory still reports the honest absence.
  assert.match(await executeGitTool({ command: `git -C ${quote(root)} status` }, root), /^exit 128\nfatal: not a git repository/);
});

test('git command arrays run in order, allow mutations, and stop at the first failure', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-git-command-array-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'repo');
  parseOk(await executeGitTool({ command: `git init ${quote(repo)}` }, root));
  parseOk(await git(repo, 'config user.name "Mixdog Test"'));
  parseOk(await git(repo, 'config user.email mixdog@example.invalid'));
  writeFileSync(join(repo, 'base.txt'), 'base\n');
  parseOk(await git(repo, 'add --all'));
  parseOk(await git(repo, 'commit -m base'));
  writeFileSync(join(repo, 'base.txt'), 'changed\n');

  const batch = parseOk(
    await executeGitTool(
      {
        command: [`git -C ${quote(repo)} status --short`, `git -C ${quote(repo)} diff -- base.txt`],
        output_limit: 20,
      },
      repo
    )
  );
  assert.equal([...batch.matchAll(/^## git /gm)].length, 2);
  assert.match(batch, /\+changed\n/);

  // Ordered mutations run in one call; the later step sees the earlier one.
  const mutations = parseOk(
    await executeGitTool(
      {
        command: [`git -C ${quote(repo)} add -- base.txt`, `git -C ${quote(repo)} diff --cached --quiet`],
      },
      repo
    )
  );
  assert.equal([...mutations.matchAll(/^## git /gm)].length, 2);
  assert.match(mutations, /\nexit 1\nerror: command failed:/);
  parseOk(await git(repo, 'reset -q -- base.txt'));

  // Fail-fast: a failed step stops the array and reports what was skipped.
  const partial = parseOk(
    await executeGitTool(
      {
        command: [`git -C ${quote(repo)} show missing-ref`, `git -C ${quote(repo)} add -- base.txt`],
      },
      repo
    )
  );
  assert.equal([...partial.matchAll(/^## git /gm)].length, 1);
  assert.match(partial, /\nexit 128\n/);
  assert.ok(partial.endsWith(`error: command failed: git -C ${quote(repo)} show missing-ref`));
  assert.equal(parseOk(await git(repo, 'diff --cached --quiet')), '');

  // A malformed later command rejects the whole array before anything runs.
  const rejected = String(
    await executeGitTool(
      {
        command: [`git -C ${quote(repo)} add -- base.txt`, `git -C ${quote(repo)} status && echo x`],
      },
      repo
    )
  );
  assert.match(rejected, /^error: git command 2:/);
  assert.equal(parseOk(await git(repo, 'diff --cached --quiet')), '');
});

test('git clamps oversized output requests to 200 lines', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-git-output-cap-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'repo');
  parseOk(await executeGitTool({ command: `git init ${quote(repo)}` }, root));
  parseOk(await git(repo, 'config user.name "Mixdog Test"'));
  parseOk(await git(repo, 'config user.email mixdog@example.invalid'));
  writeFileSync(join(repo, 'large.txt'), `${Array.from({ length: 250 }, (_, index) => `line-${index}`).join('\n')}\n`);
  parseOk(await git(repo, 'add -- large.txt'));
  parseOk(await git(repo, 'commit -m large'));
  const shown = parseOk(await git(repo, 'show HEAD:large.txt', { output_limit: 500 }));
  assert.equal(shown.split('\n').length, 201);
  assert.ok(shown.endsWith('... [50 more lines omitted; raise output_limit or narrow the command]'));
});

// `git --version` is how a caller checks whether git exists at all; rejecting
// it as an "unsupported subcommand" turned the probe into a dead turn.
test('git availability probes answer instead of erroring', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-git-probe-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const probe = String(await executeGitTool({ command: 'git --version' }, root));
  assert.doesNotMatch(probe, /unsupported git subcommand/);
  assert.match(probe, /git version/i);
});

// Some providers hand the whole command over as one quoted scalar. The command
// itself is well formed, so it must run; only the quoting differs. Everything
// the tool refuses unquoted stays refused inside the quotes.
test('git runs a fully quoted command and keeps refusing quoted shell syntax', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-git-quoted-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'repo');
  parseOk(await executeGitTool({ command: `git init ${quote(repo)}` }, root));
  parseOk(await git(repo, 'config user.name "Mixdog Test"'));
  parseOk(await git(repo, 'config user.email mixdog@example.invalid'));
  writeFileSync(join(repo, 'base.txt'), 'base\n');
  parseOk(await git(repo, 'add --all'));
  parseOk(await git(repo, 'commit -m base'));
  writeFileSync(join(repo, 'base.txt'), 'changed\n');

  const plain = parseOk(await executeGitTool({ command: 'git status --short' }, repo));
  const quoted = parseOk(await executeGitTool({ command: '"git status --short"' }, repo));
  assert.equal(quoted, plain);
  assert.match(quoted, /^ M base\.txt$/m);
  assert.match(parseOk(await executeGitTool({ command: "'git diff -- base.txt'" }, repo)), /^diff --git a\/base.txt b\/base.txt\n/);

  // A quoted chain is one quoted command, not a chain: the unwrapped text
  // still carries the operator and is refused.
  assert.match(
    String(await executeGitTool({ command: '"git status && git log"' }, repo)),
    /^error: git command must not contain shell operators/
  );
  assert.match(
    String(await executeGitTool({ command: '"status --short"' }, repo)),
    /^error: command must begin with git/
  );
});

// git dispatches any `git-*` executable on PATH as a subcommand, so a finite
// allowlist could only ever go stale. An unknown name must reach git itself —
// whatever git answers is actionable, an "unsupported subcommand" refusal was
// not, and the shell tool ran the same command anyway.
test('git forwards unknown subcommands to git instead of pre-rejecting them', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-git-open-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'repo');
  parseOk(await executeGitTool({ command: `git init ${quote(repo)}` }, root));
  for (const command of ['git filter-repo --version', 'git fast-export --no-data HEAD']) {
    assert.doesNotMatch(String(await executeGitTool({ command }, repo)), /unsupported git subcommand/);
  }
});

// The only commands this tool cannot host are the ones that never return: a
// GUI blocks on a window nobody can click, and a resident server burns the
// full timeout by working correctly. The server case is a routing hint, not a
// verdict — shell can hold it as a background task.
test('git refuses only non-returning subcommands and routes servers to shell', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-git-deny-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'repo');
  parseOk(await executeGitTool({ command: `git init ${quote(repo)}` }, root));
  assert.match(String(await executeGitTool({ command: 'git mergetool' }, repo)), /interactive GUI/i);
  assert.match(String(await executeGitTool({ command: 'git daemon --export-all' }, repo)), /shell tool/i);
  assert.match(String(await executeGitTool({ command: 'git fast-export --help' }, repo)), /external viewer/i);
  assert.match(String(await executeGitTool({ command: 'git help fast-export' }, repo)), /external viewer/i);
  assert.match(String(await executeGitTool({ command: 'git' }, repo)), /requires a subcommand/i);
});

test('git stages selected change IDs and rejects stale diff snapshots without touching the index', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-git-stage-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'repo');
  parseOk(await git(root, `init ${quote(repo)}`));
  parseOk(await git(repo, 'config user.email test@example.com'));
  parseOk(await git(repo, 'config user.name Test'));
  writeFileSync(
    join(repo, 'sample.txt'),
    `${Array.from({ length: 12 }, (_, index) => `line-${index + 1}`).join('\n')}\n`
  );
  parseOk(await git(repo, 'add sample.txt'));
  parseOk(await git(repo, 'commit -m base'));

  const changed = Array.from({ length: 12 }, (_, index) => `line-${index + 1}`);
  changed[2] = 'selected-change';
  changed[8] = 'remaining-change';
  writeFileSync(join(repo, 'sample.txt'), `${changed.join('\n')}\n`);

  const scopedDiff = parseOk(await git(repo, 'diff -- sample.txt', { output_limit: 100 }));
  const text = parseOk(await git(repo, 'diff', { output_limit: 100 }));
  const diff = parseDiff(scopedDiff);
  assert.match(diff.diff_id, /^diff_[0-9a-f]{20}$/);
  assert.equal(diff.changes.length, 2);
  assert.deepEqual(parseDiff(text).changes, diff.changes);
  assert.equal(text.split('diff_id:')[0], scopedDiff.split('diff_id:')[0]);
  const selected = diff.changes[0];
  assert.ok(selected);
  const wrongScope = parseStage(
    await executeGitStageTool(
      {
        diff_id: diff.diff_id,
        change_ids: [selected.id],
      },
      root
    )
  );
  assert.equal(wrongScope.staged, false);
  assert.equal(wrongScope.reason, 'scope_mismatch');
  assert.equal(spawnSync('git', ['-C', repo, 'diff', '--cached'], { encoding: 'utf8' }).stdout, '');
  const staged = parseStage(
    await executeGitStageTool(
      {
        diff_id: diff.diff_id,
        change_ids: [selected.id],
      },
      repo
    )
  );
  assert.deepEqual(staged, {
    ok: true,
    staged: true,
    changes: [{ path: 'sample.txt', old_start: 3, new_start: 3, additions: 1, deletions: 1 }],
  });

  const cached = spawnSync('git', ['-C', repo, 'diff', '--cached'], { encoding: 'utf8' }).stdout;
  const unstaged = spawnSync('git', ['-C', repo, 'diff'], { encoding: 'utf8' }).stdout;
  assert.match(cached, /selected-change/);
  assert.doesNotMatch(cached, /remaining-change/);
  assert.match(unstaged, /remaining-change/);
  assert.doesNotMatch(unstaged, /selected-change/);

  const next = parseDiff(parseOk(await git(repo, 'diff', { output_limit: 100 })));
  changed[8] = 'changed-after-diff';
  writeFileSync(join(repo, 'sample.txt'), `${changed.join('\n')}\n`);
  const stale = parseStage(
    await executeGitStageTool(
      {
        diff_id: next.diff_id,
        change_ids: next.changes[0].id,
      },
      repo
    )
  );
  assert.equal(stale.staged, false);
  assert.equal(stale.reason, 'stale_diff');
  const cachedAfterStale = spawnSync('git', ['-C', repo, 'diff', '--cached'], { encoding: 'utf8' }).stdout;
  assert.equal(cachedAfterStale, cached);
});

test('scoped tiny diffs include all IDs, preserve out-of-scope changes and never label comparisons', async (t) => {
  const repo = mkdtempSync(join(tmpdir(), 'mixdog-git-scoped-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  parseOk(await git(repo, 'init'));
  parseOk(await git(repo, 'config user.email test@example.com'));
  parseOk(await git(repo, 'config user.name Test'));
  writeFileSync(join(repo, 'selected.txt'), 'old\n');
  writeFileSync(join(repo, 'outside.txt'), 'outside\n');
  parseOk(await git(repo, 'add --all'));
  parseOk(await git(repo, 'commit -m base'));
  writeFileSync(join(repo, 'selected.txt'), 'selected\n');
  writeFileSync(join(repo, 'outside.txt'), 'unselected\n');
  writeFileSync(join(repo, 'outside-new.txt'), 'untracked\n');
  const text = parseOk(await git(repo, 'diff -- selected.txt', { output_limit: 1 }));
  const diff = parseDiff(text);
  assert.deepEqual(diff.changes.map(({ path }) => path), ['selected.txt']);
  assert.match(text, /more lines omitted/);
  writeFileSync(join(repo, 'outside.txt'), 'changed outside scope\n');
  const staged = parseStage(await executeGitStageTool({
    diff_id: diff.diff_id, change_ids: diff.changes.map(({ id }) => id), output_limit: 1,
  }, repo));
  assert.deepEqual(staged.changes, [{ path: 'selected.txt', old_start: 1, new_start: 1, additions: 1, deletions: 1 }]);
  assert.equal(parseOk(await git(repo, 'diff --cached --name-only')).trim(), 'selected.txt');
  for (const command of [
    'diff --cached -- selected.txt', 'diff --staged -- selected.txt',
    'diff HEAD -- selected.txt', 'diff HEAD HEAD -- selected.txt', 'diff -R -- outside.txt',
    'diff --stat -- outside.txt', 'diff --name-only -- outside.txt',
  ]) {
    assert.doesNotMatch(parseOk(await git(repo, command)), /^diff_id:|^change:/m, command);
  }
});

test('untracked scoped files stage without discovery mutations and reject external edits or index changes', async (t) => {
  const repo = mkdtempSync(join(tmpdir(), 'mixdog-git-new-files-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  parseOk(await git(repo, 'init'));
  mkdirSync(join(repo, 'nested'));
  writeFileSync(join(repo, 'nested', '새 파일.txt'), 'new content without newline');
  writeFileSync(join(repo, 'nested', 'empty.txt'), '');
  writeFileSync(join(repo, 'outside.txt'), 'outside\n');
  writeFileSync(join(repo, '.git', 'info', 'exclude'), 'ignored.txt\n');
  writeFileSync(join(repo, 'nested', 'ignored.txt'), 'ignored\n');
  const all = parseDiff(parseOk(await git(repo, 'diff', { output_limit: 1 })));
  assert.deepEqual(all.changes.map(({ path }) => path).sort(), [
    'nested/empty.txt', 'nested/새 파일.txt', 'outside.txt',
  ]);
  const directory = join(repo, 'nested');
  const text = parseOk(await executeGitTool({ command: 'git diff -- .', output_limit: 1 }, directory));
  const diff = parseDiff(text);
  assert.deepEqual(diff.changes.map(({ path }) => path).sort(), ['nested/empty.txt', 'nested/새 파일.txt']);
  assert.ok(diff.changes.every(({ location }) => location === 'new_file'));
  assert.equal(parseOk(await git(repo, 'diff --cached')), '');
  assert.equal(parseOk(await git(repo, 'ls-files')), '');
  const selected = diff.changes.find(({ path }) => path.endsWith('새 파일.txt'));
  const request = { diff_id: diff.diff_id, change_ids: selected.id };
  writeFileSync(join(directory, '새 파일.txt'), 'external edit');
  assert.equal(parseStage(await executeGitStageTool(request, directory)).reason, 'stale_diff');
  assert.equal(parseOk(await git(repo, 'ls-files')), '');
  writeFileSync(join(directory, '새 파일.txt'), 'new content without newline');
  const invalid = await executeGitStageTool({ ...request, change_ids: 'chg_missing' }, directory);
  assert.match(invalid, /^error: git stage change_ids are not present/);
  const lock = join(repo, '.git', 'index.lock');
  writeFileSync(lock, '');
  const locked = await executeGitStageTool(request, directory);
  assert.match(locked, /^exit 128/);
  assert.match(locked, /index\.lock/);
  rmSync(lock);
  const staged = parseStage(await executeGitStageTool(request, directory));
  assert.deepEqual(staged, {
    ok: true, staged: true,
    changes: [{ path: 'nested/새 파일.txt', kind: 'new_file', additions: 1, deletions: 0 }],
  });
  assert.equal(parseOk(await git(repo, 'show ":nested/새 파일.txt"')), 'new content without newline');
  assert.equal(parseStage(await executeGitStageTool(request, directory)).reason, 'expired_diff');
  const empty = parseDiff(parseOk(await git(repo, 'diff -- nested/empty.txt', { output_limit: 1 })));
  assert.equal(empty.changes.length, 1);
  const emptyRequest = { diff_id: empty.diff_id, change_ids: empty.changes[0].id };
  assert.equal(parseStage(await executeGitStageTool(emptyRequest, repo)).staged, true);
  assert.equal(parseOk(await git(repo, 'show :nested/empty.txt')), '');
  const outside = parseDiff(parseOk(await git(repo, 'diff -- outside.txt', { output_limit: 1 })));
  parseOk(await git(repo, 'add -- outside.txt'));
  const before = parseOk(await git(repo, 'diff --cached'));
  assert.equal(parseStage(await executeGitStageTool({
    diff_id: outside.diff_id, change_ids: outside.changes[0].id,
  }, repo)).reason, 'stale_diff');
  assert.equal(parseOk(await git(repo, 'diff --cached')), before);
  writeFileSync(join(repo, 'intent.txt'), 'intent to add\n');
  parseOk(await git(repo, 'add -N -- intent.txt'));
  const intent = parseDiff(parseOk(await git(repo, 'diff -- intent.txt', { output_limit: 1 })));
  assert.equal(intent.changes.length, 1);
  assert.equal(intent.changes[0].location, 'new_file');
  assert.equal(parseStage(await executeGitStageTool({
    diff_id: intent.diff_id, change_ids: intent.changes[0].id,
  }, repo)).staged, true);
  assert.equal(parseOk(await git(repo, 'show :intent.txt')), 'intent to add\n');
});
