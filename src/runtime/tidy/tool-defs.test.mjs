import test from 'node:test';
import assert from 'node:assert/strict';

import { TIDY_ACTIONS, TOOL_DEFS } from './tool-defs.mjs';

test('tidy exposes one action-routed schema with no hidden fields', () => {
  assert.equal(TOOL_DEFS.length, 1);
  const tool = TOOL_DEFS[0];
  assert.equal(tool.name, 'tidy');
  assert.equal(tool.title, 'Tidy');
  assert.equal(tool.inputSchema.additionalProperties, false);
  assert.deepEqual(tool.inputSchema.required, ['action']);
  assert.deepEqual(tool.inputSchema.properties.action.enum, [...TIDY_ACTIONS]);
  assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), [
    'action',
    'apply',
    'approveDownloads',
    'engines',
    'languages',
    'limit',
    'offset',
    'paths',
    'structural',
  ]);
  assert.match(tool.inputSchema.properties.action.description, /results:/);
  assert.match(tool.inputSchema.properties.paths.description, /ls-files --cached/);
  assert.equal(tool.inputSchema.properties.limit.maximum, 100);
  for (const [name, schema] of Object.entries(tool.inputSchema.properties)) {
    assert.equal(schema.minLength, undefined, `${name} must not pin minLength`);
    assert.ok(schema.description, `${name} needs a description`);
  }
});

test('the tidy description states the routing, dry-run, and approval contracts', () => {
  const description = TOOL_DEFS[0].description;
  assert.match(description, /Clean up code across the languages/i);
  assert.match(description, /writes only with apply:true/i);
  assert.match(description, /approves/i);
  assert.match(description, /results pages the last check\/fix/i);
  assert.match(description, /Returns final results in this call\./);
  assert.ok(description.length < 700, `tidy description too large: ${description.length}`);
});
