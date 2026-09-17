import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeGrokToolSchemas } from './grok-tool-schema.mjs';

const tool = (properties, required = []) => ({
  name: 'probe',
  description: 'probe',
  inputSchema: { type: 'object', properties, required },
});
const normalize = (properties, required) => normalizeGrokToolSchemas([tool(properties, required)])[0].inputSchema;

test('a one-or-many field keeps its array branch so Grok can batch targets', () => {
  const schema = normalize({
    file_path: {
      description: 'Path(s).',
      anyOf: [
        { type: 'string' },
        {
          type: 'array',
          minItems: 1,
          maxItems: 10,
          items: { anyOf: [{ type: 'string' }, { type: 'object', properties: { file_path: { type: 'string' } } }] },
        },
      ],
    },
    pattern: { anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'string', minLength: 1 }] },
  });
  assert.equal(schema.properties.file_path.type, 'array');
  assert.equal(schema.properties.file_path.anyOf, undefined);
  assert.equal(schema.properties.file_path.maxItems, 10);
  // Nested alternatives still flatten to their first branch.
  assert.deepEqual(schema.properties.file_path.items, { type: 'string' });
  assert.equal(schema.properties.file_path.description, 'Path(s). Pass one or more values as an array.');
  assert.equal(schema.properties.pattern.type, 'array');
  assert.equal(schema.properties.pattern.description, 'Pass one or more values as an array.');
});

test('alternatives that are not one-or-many keep the first branch and note a dropped array', () => {
  const schema = normalize({
    input: { anyOf: [{ type: 'object', properties: { a: { type: 'string' } } }, { type: 'array', items: { type: 'string' } }] },
    mode: { oneOf: [{ type: 'string', enum: ['a'] }, { type: 'string', enum: ['b'] }] },
  });
  assert.equal(schema.properties.input.type, 'object');
  assert.equal(schema.properties.input.description, 'This provider accepts a single value here, not an array.');
  assert.deepEqual(schema.properties.mode, { type: 'string', enum: ['a'] });
});

test('tools without alternatives are returned untouched', () => {
  const plain = tool({ name: { type: 'string' } }, ['name']);
  assert.equal(normalizeGrokToolSchemas([plain])[0], plain);
});
