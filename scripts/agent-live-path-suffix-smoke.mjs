import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findBySuffixStrip } from '../src/runtime/agent/orchestrator/tools/builtin/path-diagnostics.mjs';

function makeRepo() {
    const root = mkdtempSync(join(tmpdir(), 'mixdog-suffix-smoke-'));
    mkdirSync(join(root, 'src', 'tui'), { recursive: true });
    writeFileSync(join(root, 'src', 'tui', 'input-editing.mjs'), '// real file\n');
    return root;
}

test('smoke: hallucinated absolute prefix resolves to the real repo-relative file', () => {
    const root = makeRepo();
    try {
        const hallucinated = '/Users/nobody/Elsewhere/Project/ink/src/tui/input-editing.mjs';
        const hit = findBySuffixStrip(root, hallucinated);
        assert.equal(hit, 'src/tui/input-editing.mjs');
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('smoke: a non-existent tail resolves to null', () => {
    const root = makeRepo();
    try {
        const hit = findBySuffixStrip(root, '/Users/nobody/Elsewhere/Project/does/not/here.mjs');
        assert.equal(hit, null);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
