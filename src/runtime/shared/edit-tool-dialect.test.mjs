import test from 'node:test';
import assert from 'node:assert/strict';
import { filterModelEditTools } from './edit-tool-dialect.mjs';

const tools = [
    { name: 'edit', description: 'edit tool' },
    { name: 'apply_patch', description: 'patch tool' },
    { name: 'shell', description: 'Use edit/apply_patch, NOT sed/awk.' },
    { name: 'read', description: 'read tool' },
];

test('a Claude session keeps edit and reads only edit in the shell routing', () => {
    const surface = filterModelEditTools(tools, 'claude-fable-5-1');
    assert.deepEqual(surface.map((t) => t.name), ['edit', 'shell', 'read']);
    assert.equal(surface[1].description, 'Use edit, NOT sed/awk.');
});

test('a GPT session keeps apply_patch and reads only apply_patch in the shell routing', () => {
    const surface = filterModelEditTools(tools, 'gpt-5.6-sol');
    assert.deepEqual(surface.map((t) => t.name), ['apply_patch', 'shell', 'read']);
    assert.equal(surface[1].description, 'Use apply_patch, NOT sed/awk.');
});

test('rewriting never mutates the shared tool definition', () => {
    filterModelEditTools(tools, 'gpt-5.6-sol');
    assert.equal(tools[2].description, 'Use edit/apply_patch, NOT sed/awk.');
});
