import test from 'node:test';
import assert from 'node:assert/strict';
import { filterModelEditTools } from './edit-tool-dialect.mjs';
import { BUILTIN_TOOLS } from '../agent/orchestrator/tools/builtin/builtin-tools.mjs';
import { PATCH_TOOL_DEFS } from '../agent/orchestrator/tools/patch-tool-defs.mjs';

const tools = [
  { name: 'edit', description: 'edit tool' },
  { name: 'apply_patch', description: 'patch tool' },
  { name: 'shell', description: 'Use edit/apply_patch, NOT sed/awk.' },
  { name: 'read', description: 'read tool' },
];

test('a Claude session keeps edit and reads only edit in the shell routing', () => {
  const surface = filterModelEditTools(tools, 'claude-fable-5-1');
  assert.deepEqual(
    surface.map((t) => t.name),
    ['edit', 'shell', 'read']
  );
  assert.equal(surface[1].description, 'Use edit, NOT sed/awk.');
});

test('a GPT session keeps apply_patch and reads only apply_patch in the shell routing', () => {
  const surface = filterModelEditTools(tools, 'gpt-5.6-sol');
  assert.deepEqual(
    surface.map((t) => t.name),
    ['apply_patch', 'shell', 'read']
  );
  assert.equal(surface[1].description, 'Use apply_patch, NOT sed/awk.');
});

test('rewriting never mutates the shared tool definition', () => {
  filterModelEditTools(tools, 'gpt-5.6-sol');
  assert.equal(tools[2].description, 'Use edit/apply_patch, NOT sed/awk.');
});

test('real shell descriptions name only the selected editing tool', () => {
  const catalog = [...BUILTIN_TOOLS, ...PATCH_TOOL_DEFS];
  for (const [model, selected, absent] of [
    ['gpt-5.6-sol', 'apply_patch', 'edit'],
    ['claude-opus-5', 'edit', 'apply_patch'],
  ]) {
    const surface = filterModelEditTools(catalog, model);
    assert.equal(
      surface.some((tool) => tool.name === selected),
      true
    );
    assert.equal(
      surface.some((tool) => tool.name === absent),
      false
    );
    const shell = surface.find((tool) => tool.name === 'shell');
    assert.match(
      shell.description,
      new RegExp(`\\(sed/awk/redirection\\)→${selected}, Git→git when that tool is on the surface`)
    );
    assert.doesNotMatch(shell.description, /edit\/apply_patch|apply_patch or edit/);
    if (selected === 'edit') assert.doesNotMatch(shell.description, /apply_patch/);
    // No description on the surface names the dialect the session cannot call.
    for (const tool of surface) {
      assert.doesNotMatch(
        String(tool.description || ''),
        new RegExp(`\\b${absent}\\b`),
        `${tool.name} names ${absent}`
      );
    }
  }
});

test('model switches rebind descriptions even after catalog copies', () => {
  let surface = tools;
  for (const [model, selected] of [
    ['gpt-5.6-sol', 'apply_patch'],
    ['claude-opus-5', 'edit'],
    ['gpt-5.6-sol', 'apply_patch'],
  ]) {
    surface = filterModelEditTools(
      surface.map((tool) => ({ ...tool })),
      model
    );
    const shell = surface.find((tool) => tool.name === 'shell');
    assert.equal(shell.description, `Use ${selected}, NOT sed/awk.`);
    assert.deepEqual(JSON.parse(JSON.stringify(shell)), {
      name: 'shell',
      description: `Use ${selected}, NOT sed/awk.`,
    });
  }
});
