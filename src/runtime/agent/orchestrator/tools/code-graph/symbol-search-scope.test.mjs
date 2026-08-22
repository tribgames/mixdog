// A file/directory anchor scopes symbol_search: it used to scan the whole
// graph and silently ignore the anchor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { executeCodeGraphTool } from './dispatch.mjs';

function makeProject() {
    const root = mkdtempSync(join(tmpdir(), 'mixdog-cg-scope-'));
    writeFileSync(join(root, 'package.json'), '{"name":"scope-fixture"}\n');
    mkdirSync(join(root, 'inside'));
    mkdirSync(join(root, 'outside'));
    writeFileSync(join(root, 'inside', 'one.mjs'), 'export function alphaHelper() {\n  return 1;\n}\n');
    writeFileSync(join(root, 'outside', 'two.mjs'), 'export function alphaWidget() {\n  return 2;\n}\n');
    return root;
}

test('symbol_search honours a directory anchor', async (t) => {
    const root = makeProject();
    t.after(() => rmSync(root, { recursive: true, force: true }));

    const scoped = String(await executeCodeGraphTool('code_graph', {
        mode: 'symbol_search',
        symbol: 'alpha',
        cwd: root,
        files: [join(root, 'inside')],
    }, root));
    assert.match(scoped, /alphaHelper/);
    assert.doesNotMatch(scoped, /alphaWidget/);

    const wide = String(await executeCodeGraphTool('code_graph', {
        mode: 'symbol_search',
        symbol: 'alpha',
        cwd: root,
    }, root));
    assert.match(wide, /alphaHelper/);
    assert.match(wide, /alphaWidget/);
});

test('symbol_search honours a single-file anchor', async (t) => {
    const root = makeProject();
    t.after(() => rmSync(root, { recursive: true, force: true }));

    const scoped = String(await executeCodeGraphTool('code_graph', {
        mode: 'symbol_search',
        symbol: 'alpha',
        cwd: root,
        file: join(root, 'outside', 'two.mjs'),
    }, root));
    assert.match(scoped, /alphaWidget/);
    assert.doesNotMatch(scoped, /alphaHelper/);
});
