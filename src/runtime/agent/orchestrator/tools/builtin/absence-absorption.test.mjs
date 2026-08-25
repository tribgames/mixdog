// Absence absorption: a conclusive "no such path" (read/list) and git's
// exit-128 state verdict are ANSWERS, not tool failures. The full diagnostic
// body is preserved — only the error envelope is dropped, so the caller acts
// on the evidence instead of entering error recovery.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { executeBuiltinTool } from '../builtin.mjs';
import { executeGitTool } from './git-command-tool.mjs';

test('read of a conclusively missing path answers [path absent], not Error', async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'mixdog-absent-read-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const out = String(await executeBuiltinTool('read', { path: join(root, 'no-such-file.txt') }, root));
    assert.match(out, /^\[path absent\]/);
    assert.match(out, /ENOENT/);
    assert.doesNotMatch(out, /^Error:/);
});

test('list of a conclusively missing directory answers [path absent], not Error', async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'mixdog-absent-list-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const out = String(await executeBuiltinTool('list', { path: join(root, 'no-such-dir') }, root));
    assert.match(out, /^\[path absent\]/);
    assert.doesNotMatch(out, /^Error:/);
});

test('git exit 128 returns the state verdict as a non-error envelope', async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'mixdog-absent-git128-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const repo = join(root, 'repo');
    await executeGitTool({ command: `git init "${repo}"` }, root);
    // Unborn branch: `git log` exits 128 with git's own explanation.
    const out = String(await executeGitTool({ command: `git -C "${repo}" log` }, repo));
    assert.doesNotMatch(out, /^Error:/);
    const parsed = JSON.parse(out);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.exit, 128);
    assert.ok(String(parsed.stderr || parsed.reason || '').length > 0);
});
