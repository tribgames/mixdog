import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { executeCodeGraphTool } from './dispatch.mjs';
import { CODE_GRAPH_TOOL_DEFS } from '../code-graph-tool-defs.mjs';

const PY = 'class Term:\n    def is_alive(self):\n        return True\n';

test('an exact absolute file outside every project is a valid outline target', async () => {
  const outside = mkdtempSync(join(tmpdir(), 'mixdog-loose-file-'));
  try {
    const target = join(outside, 'headless_terminal.py');
    writeFileSync(target, PY);
    // cwd is THIS project; the anchor lives outside it and under no sentinel.
    const out = String(await executeCodeGraphTool(
      'code_graph',
      { mode: 'symbols', files: target },
      process.cwd(),
    ));
    assert.doesNotMatch(out, /Refusing to index an arbitrary tree/);
    assert.match(out, /is_alive/);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test('a sentinel-free working directory outlines its own files with an implicit cwd', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-implicit-cwd-'));
  try {
    writeFileSync(join(root, 'app.py'), PY);
    const out = String(await executeCodeGraphTool(
      'code_graph',
      { mode: 'symbols', files: 'app.py' },
      root,
    ));
    assert.doesNotMatch(out, /Refusing to index an arbitrary tree/);
    assert.match(out, /is_alive/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a directory anchor outside every project is still refused', async () => {
  const outside = mkdtempSync(join(tmpdir(), 'mixdog-loose-dir-'));
  try {
    writeFileSync(join(outside, 'app.py'), PY);
    let message = '';
    try {
      await executeCodeGraphTool('code_graph', { mode: 'overview', file: outside }, process.cwd());
    } catch (error) {
      message = String(error?.message || error);
    }
    // A directory names a tree to walk, not a target: the guard must hold.
    assert.match(message, /no detectable project root|Refusing to index an arbitrary tree/);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test('the code_graph contract advertises the direct outline path', () => {
  const def = CODE_GRAPH_TOOL_DEFS.find((tool) => tool.name === 'code_graph');
  assert.ok(def, 'code_graph tool definition must exist');
  assert.match(def.description, /mode:symbols with files\[\] is the cheap direct outline/);
  assert.match(def.description, /no file body/);
  const mode = def.inputSchema.properties.mode.description;
  assert.match(mode, /needs no prior search/);
  // Absolute anchors are supported, so the schema must not claim otherwise.
  assert.match(def.inputSchema.properties.files.description, /project-relative or absolute/);
});
