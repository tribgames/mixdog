// A sentinel-free cwd that HOLDS one project answers an anchored call by
// adopting that project; a genuinely ambiguous tree still refuses, but names
// where to anchor instead.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { executeCodeGraphTool } from './dispatch.mjs';

const PY = 'class Mean:\n    def compute(self):\n        return 42\n';

function makeRepo(root, name) {
    const repo = join(root, name);
    mkdirSync(join(repo, '.git'), { recursive: true });
    mkdirSync(join(repo, 'tools'), { recursive: true });
    writeFileSync(join(repo, 'tools', 'compute_mean.py'), PY);
    return repo;
}

test('a relative anchor held by exactly one child project adopts that project', async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'mixdog-anchor-one-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    makeRepo(root, 'caffe');

    const out = String(await executeCodeGraphTool(
        'code_graph',
        { mode: 'symbols', files: 'tools/compute_mean.py' },
        root,
    ));
    assert.doesNotMatch(out, /Refusing to index an arbitrary tree/);
    assert.match(out, /compute/);
});

test('two child projects holding the same anchor stay refused, with the roots named', async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'mixdog-anchor-many-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    makeRepo(root, 'caffe');
    makeRepo(root, 'caffe-fork');

    let message = '';
    try {
        await executeCodeGraphTool(
            'code_graph',
            { mode: 'symbols', files: 'tools/compute_mean.py' },
            root,
        );
    } catch (error) {
        message = String(error?.message || error);
    }
    assert.match(message, /Refusing to index an arbitrary tree/);
    assert.match(message, /Project roots under this cwd/);
    assert.match(message, /"caffe"/);
});
