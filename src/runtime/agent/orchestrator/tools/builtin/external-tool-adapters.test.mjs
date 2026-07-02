import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tryExecuteExternalToolAdapter, isExternalAdapterTool } from './external-tool-adapters.mjs';

function makeDir() {
    return mkdtempSync(join(tmpdir(), 'ext-adapter-test-'));
}

test('isExternalAdapterTool recognizes adapted names only', () => {
    assert.equal(isExternalAdapterTool('StrReplace'), true);
    assert.equal(isExternalAdapterTool('str_replace'), true);
    assert.equal(isExternalAdapterTool('str_replace_editor'), true);
    assert.equal(isExternalAdapterTool('search_replace'), true);
    assert.equal(isExternalAdapterTool('Write'), true);
    assert.equal(isExternalAdapterTool('create_file'), true);
    assert.equal(isExternalAdapterTool('Bash'), true);
    assert.equal(isExternalAdapterTool('run_terminal_cmd'), true);
    // Destructive / different-shape names stay on the redirect path.
    assert.equal(isExternalAdapterTool('Delete'), false);
    assert.equal(isExternalAdapterTool('delete_file'), false);
    assert.equal(isExternalAdapterTool('edit'), false);
    assert.equal(isExternalAdapterTool('multiedit'), false);
    assert.equal(isExternalAdapterTool(''), false);
    assert.equal(isExternalAdapterTool(null), false);
});

test('StrReplace: unique match replaces content', async () => {
    const dir = makeDir();
    const file = join(dir, 'a.txt');
    writeFileSync(file, 'alpha\nbeta\ngamma\n');
    const out = await tryExecuteExternalToolAdapter('StrReplace', {
        path: file, old_string: 'beta', new_string: 'BETA',
    }, dir, {});
    assert.match(out, /^Updated .*\(1 replacement\)$/);
    assert.equal(readFileSync(file, 'utf8'), 'alpha\nBETA\ngamma\n');
});

test('StrReplace: zero matches errors without writing', async () => {
    const dir = makeDir();
    const file = join(dir, 'a.txt');
    writeFileSync(file, 'alpha\n');
    const out = await tryExecuteExternalToolAdapter('str_replace', {
        path: file, old_string: 'missing', new_string: 'x',
    }, dir, {});
    assert.match(out, /old_string not found/);
    assert.equal(readFileSync(file, 'utf8'), 'alpha\n');
});

test('StrReplace: ambiguous matches error with count', async () => {
    const dir = makeDir();
    const file = join(dir, 'a.txt');
    writeFileSync(file, 'dup\ndup\n');
    const out = await tryExecuteExternalToolAdapter('search_replace', {
        path: file, old_string: 'dup', new_string: 'x',
    }, dir, {});
    assert.match(out, /ambiguous: 2 matches/);
    assert.equal(readFileSync(file, 'utf8'), 'dup\ndup\n');
});

test('StrReplace: missing old_string falls back (null)', async () => {
    const dir = makeDir();
    const out = await tryExecuteExternalToolAdapter('StrReplace', {
        path: join(dir, 'a.txt'), new_string: 'x',
    }, dir, {});
    assert.equal(out, null);
});

test('StrReplace: unreadable target is a concrete error', async () => {
    const dir = makeDir();
    const out = await tryExecuteExternalToolAdapter('StrReplace', {
        path: join(dir, 'nope.txt'), old_string: 'a', new_string: 'b',
    }, dir, {});
    assert.match(out, /^Error: cannot read /);
});

test('Write: creates a new file with contents', async () => {
    const dir = makeDir();
    const file = join(dir, 'new', 'nested.txt');
    const out = await tryExecuteExternalToolAdapter('Write', {
        path: file, contents: 'created body',
    }, dir, {});
    assert.match(out, /^Created .*nested\.txt \(12 bytes\)$/);
    assert.equal(readFileSync(file, 'utf8'), 'created body');
});

test('Write: overwrites an existing file and says Updated', async () => {
    const dir = makeDir();
    const file = join(dir, 'exists.txt');
    writeFileSync(file, 'old');
    const out = await tryExecuteExternalToolAdapter('write', {
        file_path: file, content: 'new body',
    }, dir, {});
    assert.match(out, /^Updated /);
    assert.equal(readFileSync(file, 'utf8'), 'new body');
});

test('Write: missing contents falls back to redirect (null)', async () => {
    const dir = makeDir();
    const out = await tryExecuteExternalToolAdapter('Write', {
        path: join(dir, 'x.txt'),
    }, dir, {});
    assert.equal(out, null);
    assert.equal(existsSync(join(dir, 'x.txt')), false);
});

test('StrReplace: missing old_string/new_string falls back (null)', async () => {
    const dir = makeDir();
    const file = join(dir, 'a.txt');
    writeFileSync(file, 'body');
    const out = await tryExecuteExternalToolAdapter('StrReplace', {
        path: file, old_string: 'body',
    }, dir, {});
    assert.equal(out, null);
});

test('StrReplace: empty old_string is a concrete error (no hang)', async () => {
    const dir = makeDir();
    const file = join(dir, 'a.txt');
    writeFileSync(file, 'body');
    const out = await tryExecuteExternalToolAdapter('StrReplace', {
        path: file, old_string: '', new_string: 'x',
    }, dir, {});
    assert.match(out, /old_string must be a non-empty string/);
    assert.equal(readFileSync(file, 'utf8'), 'body');
});

test('bash family: missing command falls back (null)', async () => {
    const dir = makeDir();
    const out = await tryExecuteExternalToolAdapter('Bash', {}, dir, {});
    assert.equal(out, null);
});

test('Write: target outside workDir is refused (base containment)', async () => {
    const workDir = makeDir();
    const outsideDir = makeDir();
    const outside = join(outsideDir, 'escape.txt');
    const out = await tryExecuteExternalToolAdapter('Write', {
        path: outside, contents: 'should not land',
    }, workDir, {});
    assert.match(out, /cannot write outside the working directory/);
    assert.equal(existsSync(outside), false);
});

test('non-adapted names return null without touching fs', async () => {
    const dir = makeDir();
    const out = await tryExecuteExternalToolAdapter('Delete', {
        path: join(dir, 'x.txt'),
    }, dir, {});
    assert.equal(out, null);
});

test('bash family: executes a command via the shell runner', async () => {
    const dir = makeDir();
    const out = await tryExecuteExternalToolAdapter('run_terminal_cmd', {
        command: 'node -e "console.log(\'adapter-ok\')"',
    }, dir, {});
    assert.equal(typeof out, 'string');
    assert.match(out, /adapter-ok/);
});
