import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { describeGitStartupState } from './runtime-capabilities.mjs';

const gitAvailable = spawnSync('git', ['--version'], {
    encoding: 'utf8',
    windowsHide: true,
}).status === 0;

test('Git startup state reports clean and dirty repository snapshots', {
    skip: gitAvailable ? false : 'git is unavailable',
}, () => {
    const root = mkdtempSync(join(tmpdir(), 'mixdog-git-startup-'));
    try {
        assert.equal(spawnSync('git', ['init', '-q'], {
            cwd: root,
            encoding: 'utf8',
            windowsHide: true,
        }).status, 0);

        const clean = describeGitStartupState({
            cwd: root,
            capabilities: { available: ['git'] },
        });
        assert.match(clean, /Git startup state: repository root /);
        assert.match(clean, /; clean\.$/);

        writeFileSync(join(root, 'dirty.txt'), 'dirty\n');
        const dirty = describeGitStartupState({
            cwd: root,
            capabilities: { available: ['git'] },
        });
        assert.match(dirty, /; changes present\.$/);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('Git startup state preserves the non-repository message', () => {
    const root = mkdtempSync(join(tmpdir(), 'mixdog-nonrepo-startup-'));
    try {
        const state = describeGitStartupState({
            cwd: root,
            capabilities: { available: ['git'] },
        });
        assert.match(state, /was not inside a git repository at startup/);
        assert.doesNotMatch(state, /; (?:clean|changes present)\./);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
