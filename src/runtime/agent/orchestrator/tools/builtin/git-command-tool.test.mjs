import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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
import { commandHasShellSyntax } from './git-command-policy.mjs';

function parseOk(result) {
    assert.doesNotMatch(String(result), /^Error:/, String(result));
    const parsed = JSON.parse(String(result));
    assert.equal(parsed.ok, true);
    return parsed;
}

function quote(value) {
    return `"${String(value).replaceAll('"', '\\"')}"`;
}

async function git(repo, command, options = {}) {
    return executeGitTool({ command: `git -C ${quote(repo)} ${command}`, ...options }, repo);
}

test('git command tool preserves shell syntax, compacts output, and gates destructive commands', async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'mixdog-git-command-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const repo = join(root, 'repo');

    assert.equal(parseOk(await executeGitTool({ command: `git init ${quote(repo)}` }, root)).summary, 'initialized');
    parseOk(await git(repo, 'config user.name "Mixdog Test"'));
    parseOk(await git(repo, 'config user.email mixdog@example.invalid'));
    assert.match(String(await git(repo, 'config --global user.name')), /outside the local repository scope/);
    assert.match(String(await git(repo, 'config --system user.name')), /outside the local repository scope/);
    assert.match(String(await git(repo, 'config --file ..\/outside user.name')), /outside the local repository scope/);
    assert.match(String(await git(repo, 'config -f..\/outside user.name')), /outside the local repository scope/);
    assert.equal(
        _gitCommandInternals.creationTarget(_gitCommandInternals.parseCommand(`git clone origin ${quote(join(root, 'target'))}`, root)),
        join(root, 'target'),
    );

    writeFileSync(join(repo, 'base.txt'), 'base\n');
    const staged = parseOk(await git(repo, 'add --all'));
    assert.equal(staged.summary, 'staged');
    assert.equal(staged.status.after.staged, 1);
    const committed = parseOk(await git(repo, 'commit -m base'));
    assert.match(committed.summary, /^committed(?: [0-9a-f]+)?$/);
    assert.equal(committed.output, undefined);
    const base = parseOk(await git(repo, 'log', { output_limit: 1 })).commits[0].oid;
    assert.match(JSON.stringify(parseOk(await git(repo, 'show-ref'))), /refs\/heads\//);
    assert.match(JSON.stringify(parseOk(await git(repo, 'count-objects -v'))), /count:/);
    parseOk(await git(repo, 'check-ref-format refs/heads/test'));
    assert.match(String(await git(repo, 'archive HEAD')), /^Error: git archive requires -o\/--output/);
    parseOk(await git(repo, 'prune --expire=now'));
    const shown = parseOk(await git(repo, `show ${base}`, { output_limit: 5 }));
    assert.equal(shown.commit.oid, base);
    assert.deepEqual(shown.diff.files, ['base.txt']);

    writeFileSync(join(repo, 'secret.txt'), 'secret[lost-object]\n');
    parseOk(await git(repo, 'add -- secret.txt'));
    parseOk(await git(repo, 'commit -m secret -m "Recovery context" -m "Signed-off-by: Test <test@example.invalid>"'));
    const secretLog = parseOk(await git(repo, 'log', { output_limit: 1 })).commits[0];
    const secretCommit = secretLog.oid;
    assert.deepEqual(secretLog.body, ['Recovery context']);
    const batchShow = parseOk(await git(repo, `show ${base} ${secretCommit}`, { output_limit: 5 })).commits;
    assert.deepEqual(batchShow.map((row) => row.commit.oid), [base, secretCommit]);

    parseOk(await git(repo, `reset --hard ${base}`));
    const fsck = parseOk(await git(repo, 'fsck --full --unreachable --no-reflogs', { output_limit: 20 }));
    assert.match(JSON.stringify(fsck), new RegExp(secretCommit));

    const reflog = parseOk(await git(repo, 'reflog --all', { output_limit: 20 }));
    assert.ok(reflog.entries.some((row) => row.oid === secretCommit));
    const selectors = reflog.entries.map((row) => row.selector).filter((value, index, all) => all.indexOf(value) === index).slice(0, 2);
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
    const renameText = renameDiff.patch || renameDiff.output;
    assert.match(renameText, /rename from base\.txt/);
    assert.match(renameText, /rename to renamed\.txt/);
    parseOk(await git(repo, 'reset --hard HEAD'));

    writeFileSync(join(repo, 'base.txt'), `${Array.from({ length: 120 }, (_, i) => `changed-${i}`).join('\n')}\n`);
    const rawDiff = spawnSync('git', ['-C', repo, 'diff', '--', 'base.txt'], { encoding: 'utf8' }).stdout;
    const diff = parseOk(await git(repo, 'diff -- base.txt', { output_limit: 5 }));
    assert.match(diff.patch, /-base/);
    assert.match(diff.patch, /\+changed-0/);
    assert.equal(diff.truncated, true);
    assert.ok(JSON.stringify(diff).length < rawDiff.length / 2);
    parseOk(await git(repo, 'restore -- base.txt'));
    assert.equal(parseOk(await git(repo, 'status')).clean, true);

    const bare = join(root, 'remote.git');
    parseOk(await executeGitTool({ command: `git init --bare ${quote(bare)}` }, root));
    parseOk(await git(repo, `remote add origin ${quote(bare)}`));
    assert.equal(parseOk(await git(repo, 'remote get-url origin')).output, bare);
    const pushed = parseOk(await git(repo, 'push --set-upstream origin HEAD'));
    assert.match(pushed.summary, /^pushed/);
    assert.ok(!JSON.stringify(pushed.output || []).includes('Enumerating objects:'));

    const cloned = join(root, 'clone');
    assert.equal(parseOk(await executeGitTool({ command: `git clone ${quote(bare)} ${quote(cloned)}` }, root)).summary, 'cloned');
    assert.equal(parseOk(await git(cloned, 'pull --rebase')).summary, 'up-to-date');
    assert.equal(parseOk(await git(cloned, 'log', { output_limit: 5 })).commits.length, 1);

    for (let i = 0; i < 11; i++) {
        const extra = spawnSync('git', ['-C', repo, 'commit', '--allow-empty', '-m', `extra-${i}`], { encoding: 'utf8' });
        assert.equal(extra.status, 0, extra.stderr);
    }
    assert.equal(parseOk(await git(repo, 'log')).commits.length, 10);
    assert.ok(parseOk(await git(repo, 'log --all', { output_limit: 20 })).commits.length >= 12);

    for (const name of ['one.tmp', 'two.tmp', 'three.tmp']) writeFileSync(join(repo, name), name);
    const cappedStatus = parseOk(await git(repo, 'status', { output_limit: 2 }));
    assert.equal(cappedStatus.changes.length, 2);
    assert.equal(cappedStatus.omitted, 1);
    for (const name of ['one.tmp', 'two.tmp', 'three.tmp']) rmSync(join(repo, name));

    const worktree = join(root, 'worktree');
    parseOk(await git(repo, `worktree add -b topic ${quote(worktree)} HEAD`));
    assert.match(JSON.stringify(parseOk(await git(repo, 'worktree list --porcelain'))), /topic/);
    assert.match(JSON.stringify(parseOk(await git(repo, 'branch --list'))), /topic/);

    assert.match(String(await executeGitTool({ command: 'git status && git log' }, root)), /^Error: git command must not contain shell operators/);
});

test('git tool answers semantic exits and keeps literal operator characters', async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'mixdog-git-semantic-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const repo = join(root, 'repo');
    parseOk(await executeGitTool({ command: `git init ${quote(repo)}` }, root));
    parseOk(await git(repo, 'config user.name "Mixdog Test"'));
    parseOk(await git(repo, 'config user.email mixdog@example.invalid'));
    writeFileSync(join(repo, 'base.txt'), 'base\n');
    parseOk(await git(repo, 'add --all'));
    parseOk(await git(repo, 'commit -m base'));

    // A separator inside one token is argument text, not a pipeline.
    assert.match(JSON.stringify(parseOk(await git(repo, 'log --format=%h|%s -n 1'))), /\|base/);
    assert.equal(commandHasShellSyntax('git log -- ":(exclude)node_modules"'), false);
    assert.equal(commandHasShellSyntax('git log --format=$(whoami)'), true);
    assert.match(String(await git(repo, 'log | head')), /^Error: git command must not contain shell operators/);

    // grep exit 1 is "no match", not a failure.
    assert.equal(parseOk(await git(repo, 'grep -n base -- base.txt')).matched, true);
    assert.equal(parseOk(await git(repo, 'grep -n mixdog-absent-token')).matched, false);

    // diff reports through the exit code for --quiet and --check.
    assert.equal(parseOk(await git(repo, 'diff --quiet')).changed, false);
    assert.equal(parseOk(await git(repo, 'diff --check')).problems, false);
    writeFileSync(join(repo, 'base.txt'), 'base\ntrailing   \n');
    assert.equal(parseOk(await git(repo, 'diff --quiet')).changed, true);
    const check = parseOk(await git(repo, 'diff --check'));
    assert.equal(check.problems, true);
    assert.match(JSON.stringify(check), /trailing whitespace/);
});

test('git failure detail folds progress frames and keeps the fatal tail', () => {
    const { failureText, foldProgressFrames } = _gitCommandInternals;
    assert.equal(
        foldProgressFrames('Updating files:   1% (5/49152)\rUpdating files:  99% (48000/49152)\nfatal: boom'),
        'Updating files:  99% (48000/49152)\nfatal: boom',
    );
    const noisy = [...Array.from({ length: 60 }, (_, i) => `line-${i}`), 'fatal: boom'].join('\n');
    const text = failureText(noisy, 5);
    assert.match(text, /^…\[56 earlier lines omitted\]\n/);
    assert.match(text, /fatal: boom$/);
});

test('git and deferred git_stage expose separate compact contracts', () => {
    const properties = GIT_TOOL_DEF.inputSchema.properties;
    assert.deepEqual(Object.keys(properties), ['command', 'output_limit']);
    assert.deepEqual(GIT_TOOL_DEF.inputSchema.required, ['command']);
    assert.equal(properties.command.minLength, undefined);
    assert.equal(properties.output_limit.maximum, 200);
    const stageProperties = GIT_STAGE_TOOL_DEF.inputSchema.properties;
    assert.deepEqual(Object.keys(stageProperties), ['diff_id', 'change_ids', 'output_limit']);
    assert.deepEqual(GIT_STAGE_TOOL_DEF.inputSchema.required, ['diff_id', 'change_ids']);
    assert.equal(stageProperties.change_ids.anyOf[1].maxItems, 50);
    assert.equal(stageProperties.output_limit.maximum, 200);
    assert.equal(GIT_STAGE_TOOL_DEF.annotations.destructiveHint, true);
    assert.doesNotMatch(GIT_TOOL_DEF.description, /confirm/i);
    assert.match(GIT_TOOL_DEF.description, /Use diff directly when changed content for a known target is required/i);
    assert.match(GIT_TOOL_DEF.description, /Run one Git command directly, without a shell/i);
    assert.match(GIT_TOOL_DEF.description, /repository mutations are serialized/i);
});

test('git clamps oversized output requests to 200 lines', async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'mixdog-git-output-cap-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const repo = join(root, 'repo');
    parseOk(await executeGitTool({ command: `git init ${quote(repo)}` }, root));
    parseOk(await git(repo, 'config user.name "Mixdog Test"'));
    parseOk(await git(repo, 'config user.email mixdog@example.invalid'));
    writeFileSync(
        join(repo, 'large.txt'),
        `${Array.from({ length: 250 }, (_, index) => `line-${index}`).join('\n')}\n`,
    );
    parseOk(await git(repo, 'add -- large.txt'));
    parseOk(await git(repo, 'commit -m large'));
    const shown = parseOk(await git(repo, 'show HEAD:large.txt', { output_limit: 500 }));
    assert.equal(shown.lines.length, 200);
    assert.equal(shown.omitted, 50);
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

test('git stages selected change IDs and rejects stale diff snapshots without touching the index', async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'mixdog-git-stage-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const repo = join(root, 'repo');
    parseOk(await git(root, `init ${quote(repo)}`));
    parseOk(await git(repo, 'config user.email test@example.com'));
    parseOk(await git(repo, 'config user.name Test'));
    writeFileSync(join(repo, 'sample.txt'), `${Array.from({ length: 12 }, (_, index) => `line-${index + 1}`).join('\n')}\n`);
    parseOk(await git(repo, 'add sample.txt'));
    parseOk(await git(repo, 'commit -m base'));

    const changed = Array.from({ length: 12 }, (_, index) => `line-${index + 1}`);
    changed[2] = 'selected-change';
    changed[8] = 'remaining-change';
    writeFileSync(join(repo, 'sample.txt'), `${changed.join('\n')}\n`);

    const scopedDiff = parseOk(await git(repo, 'diff -- sample.txt', { output_limit: 100 }));
    assert.equal(scopedDiff.diff_id, undefined);
    assert.equal(scopedDiff.changes, undefined);
    const diff = parseOk(await git(repo, 'diff', { output_limit: 100 }));
    assert.match(diff.diff_id, /^diff_[0-9a-f]{20}$/);
    assert.equal(diff.changes.length, 2);
    const selected = diff.changes.find((change) => change.preview.some((line) => line.includes('selected-change')));
    assert.ok(selected);
    const wrongScope = parseOk(await executeGitStageTool({
        diff_id: diff.diff_id,
        change_ids: [selected.id],
    }, root));
    assert.equal(wrongScope.staged, false);
    assert.equal(wrongScope.reason, 'scope_mismatch');
    assert.equal(spawnSync('git', ['-C', repo, 'diff', '--cached'], { encoding: 'utf8' }).stdout, '');
    const staged = parseOk(await executeGitStageTool({
        diff_id: diff.diff_id,
        change_ids: [selected.id],
    }, repo));
    assert.equal(staged.staged, true);
    assert.deepEqual(staged.change_ids, [selected.id]);

    const cached = spawnSync('git', ['-C', repo, 'diff', '--cached'], { encoding: 'utf8' }).stdout;
    const unstaged = spawnSync('git', ['-C', repo, 'diff'], { encoding: 'utf8' }).stdout;
    assert.match(cached, /selected-change/);
    assert.doesNotMatch(cached, /remaining-change/);
    assert.match(unstaged, /remaining-change/);
    assert.doesNotMatch(unstaged, /selected-change/);

    const next = parseOk(await git(repo, 'diff', { output_limit: 100 }));
    changed[8] = 'changed-after-diff';
    writeFileSync(join(repo, 'sample.txt'), `${changed.join('\n')}\n`);
    const stale = parseOk(await executeGitStageTool({
        diff_id: next.diff_id,
        change_ids: next.changes[0].id,
    }, repo));
    assert.equal(stale.staged, false);
    assert.equal(stale.reason, 'stale_diff');
    const cachedAfterStale = spawnSync('git', ['-C', repo, 'diff', '--cached'], { encoding: 'utf8' }).stdout;
    assert.equal(cachedAfterStale, cached);
});
