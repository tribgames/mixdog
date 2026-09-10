import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { buildGlobPatternGroups } from './lib/glob-static-prefix.mjs';

function renderedGroups(root, groups) {
    return [...groups.entries()].map(([groupRoot, patterns]) => [
        relative(root, groupRoot).replace(/\\/g, '/') || '.',
        patterns,
    ]);
}

test('glob narrows positive relative patterns to existing static directory prefixes', async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'mixdog-glob-prefix-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    for (const dir of ['usr/bin', 'usr/local/bin', 'opt/runtime/bin']) {
        mkdirSync(join(root, dir), { recursive: true });
    }

    const groups = await buildGlobPatternGroups({
        patterns: ['usr/bin/python3*', 'usr/local/bin/python3*', 'opt/**/bin/python3*'],
        baseEntries: [{ root, prefix: '' }],
        resolveRoot: resolve,
    });

    assert.deepEqual(renderedGroups(root, groups), [
        ['usr/bin', ['/python3*']],
        ['usr/local/bin', ['/python3*']],
        ['opt', ['/**/bin/python3*']],
    ]);
});

test('glob keeps the original root for exclusions, traversal, and missing prefixes', async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'mixdog-glob-prefix-fallback-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, 'usr/bin'), { recursive: true });

    const cases = [
        ['negative', ['usr/bin/*.js', '!usr/bin/test*']],
        ['traversal', ['../outside/*.js']],
        ['missing', ['missing/bin/*.js']],
    ];

    for (const [name, patterns] of cases) {
        const groups = await buildGlobPatternGroups({
            patterns,
            baseEntries: [{ root, prefix: '' }],
            resolveRoot: resolve,
        });
        assert.deepEqual(renderedGroups(root, groups), [['.', patterns]], name);
    }
});

test('a linked prefix does not widen independent static prefixes or follow the link', async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'mixdog-glob-prefix-linked-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    for (const dir of ['usr/bin', 'usr/local/bin', 'opt/runtime']) {
        mkdirSync(join(root, dir), { recursive: true });
    }
    symlinkSync(join(root, 'usr/bin'), join(root, 'bin'), process.platform === 'win32' ? 'junction' : 'dir');
    const groups = await buildGlobPatternGroups({
        patterns: ['usr/bin/python*', 'usr/local/bin/python*', 'bin/python*', 'opt/**/python3*'],
        baseEntries: [{ root, prefix: '' }],
        resolveRoot: resolve,
    });
    assert.deepEqual(renderedGroups(root, groups), [
        ['usr/bin', ['/python*']],
        ['usr/local/bin', ['/python*']],
        ['opt', ['/**/python3*']],
    ]);
});

test('an unresolvable prefix does not widen other patterns', async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'mixdog-glob-prefix-independent-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, 'usr/bin'), { recursive: true });
    const groups = await buildGlobPatternGroups({
        patterns: ['missing/*.js', 'usr/bin/python*'],
        baseEntries: [{ root, prefix: '' }],
        resolveRoot: resolve,
    });
    assert.deepEqual(renderedGroups(root, groups), [
        ['.', ['missing/*.js']],
        ['usr/bin', ['/python*']],
    ]);
});
