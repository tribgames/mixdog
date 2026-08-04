import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findBySuffixStrip } from '../src/runtime/agent/orchestrator/tools/builtin/path-diagnostics.mjs';

function makeRepo() {
    const root = mkdtempSync(join(tmpdir(), 'mixdog-suffix-test-'));
    mkdirSync(join(root, 'src', 'tui'), { recursive: true });
    writeFileSync(join(root, 'src', 'tui', 'input-editing.mjs'), '// real file\n');
    mkdirSync(join(root, 'vendor', 'ink', 'build'), { recursive: true });
    writeFileSync(join(root, 'vendor', 'ink', 'build', 'index.js'), '// vendored\n');
    return root;
}

test('resolves a hallucinated absolute prefix to the real repo-relative file', () => {
    const root = makeRepo();
    try {
        const hallucinated = '/Users/danma/Local/Project/ink/src/tui/input-editing.mjs';
        const hit = findBySuffixStrip(root, hallucinated);
        assert.equal(hit, 'src/tui/input-editing.mjs');
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('resolves a hallucinated prefix onto a vendor/ path (no skip-dir filtering)', () => {
    const root = makeRepo();
    try {
        const hallucinated = '/Users/danma/Local/Project/vendor/ink/build/index.js';
        const hit = findBySuffixStrip(root, hallucinated);
        assert.equal(hit, 'vendor/ink/build/index.js');
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('returns null when no tail length matches a real file', () => {
    const root = makeRepo();
    try {
        const hit = findBySuffixStrip(root, '/Users/danma/Local/Project/does/not/exist.mjs');
        assert.equal(hit, null);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('a bare basename (1 segment) is never matched', () => {
    const root = makeRepo();
    try {
        const hit = findBySuffixStrip(root, 'input-editing.mjs');
        assert.equal(hit, null);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
