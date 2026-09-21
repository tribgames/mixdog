import test from 'node:test';
import assert from 'node:assert/strict';
import { toGeminiTools } from './gemini-schema.mjs';

test('Gemini schema conjunction intersects enum values and preserves an equal default', () => {
  const inputSchema = {
    type: 'string',
    enum: ['read', 'write'],
    default: 'read',
    allOf: [{ enum: ['read', 'delete'], const: 'read', default: 'read' }],
  };
  const original = structuredClone(inputSchema);
  const { parameters } = toGeminiTools([{ name: 'action', inputSchema }]).functionDeclarations[0];
  assert.deepEqual(parameters, { type: 'string', enum: ['read'], default: 'read' });
  assert.deepEqual(inputSchema, original);
});

test('Gemini schema conjunction compares defaults by value rather than property insertion order', () => {
  for (const [right, expected] of [
    [
      { b: 2, a: 1 },
      { b: 2, a: 1 },
    ],
    [{ b: 3, a: 1 }, undefined],
  ]) {
    const inputSchema = {
      type: 'object',
      default: { a: 1, b: 2 },
      allOf: [{ type: 'object', default: right }],
    };
    const { parameters } = toGeminiTools([{ name: 'defaults', inputSchema }]).functionDeclarations[0];
    assert.equal(Object.hasOwn(parameters, 'default'), expected !== undefined);
    assert.deepEqual(parameters.default, expected);
  }
});

test('Gemini schema conjunction rejects disjoint enum values and contradictory const values', () => {
  for (const branch of [{ enum: ['delete'] }, { enum: ['read'], const: 'write' }]) {
    const inputSchema = { type: 'string', enum: ['read'], allOf: [branch] };
    const { parameters } = toGeminiTools([{ name: 'conflict', inputSchema }]).functionDeclarations[0];
    assert.deepEqual(parameters, {
      type: 'string',
      enum: ['__mixdog_unrepresentable_schema_conjunction__'],
      description: 'Schema conjunction could not be represented safely: empty enum intersection',
    });
  }
});
