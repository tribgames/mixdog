import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { describeCwdStartupEntries, describeGitStartupState } from './runtime-capabilities.mjs';

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

test('Cwd startup entries list the immediate directory contents with a cap', () => {
    const root = mkdtempSync(join(tmpdir(), 'mixdog-cwd-entries-'));
    try {
        assert.equal(describeCwdStartupEntries({ cwd: root }), '- Cwd entries at startup: none (empty directory).');

        mkdirSync(join(root, 'src'));
        writeFileSync(join(root, 'README.md'), 'x\n');
        writeFileSync(join(root, 'app.py'), 'x\n');
        assert.equal(
            describeCwdStartupEntries({ cwd: root }),
            '- Cwd entries at startup: app.py README.md src/',
        );

        for (let index = 0; index < 5; index += 1) writeFileSync(join(root, `z${index}.txt`), '');
        const capped = describeCwdStartupEntries({ cwd: root, limit: 4 });
        assert.match(capped, /^- Cwd entries at startup: app\.py README\.md src\/ z0\.txt … \+4 more \(list for the rest\)$/);

        assert.equal(describeCwdStartupEntries({ cwd: join(root, 'missing') }), '');
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
