import test from 'node:test';
import assert from 'node:assert/strict';
import { coerceArgsToSchema } from './arg-schema-coerce.mjs';

const schema = {
    type: 'object',
    properties: {
        action: { type: 'string' },
        design: { type: 'object' },
        pages: { type: 'array', items: { type: 'integer' } },
        maxWidth: { type: 'integer' },
        render: { type: 'boolean' },
        limit: { anyOf: [{ type: 'number' }, { type: 'null' }] },
        query: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
        script: { type: 'string' },
    },
};

test('JSON text arguments take their declared structural shape', () => {
    const args = coerceArgsToSchema({
        action: 'finalize',
        design: '{"reviewed": true, "critique": [{"slide": 1}]}',
        pages: '[2, 3]',
        maxWidth: '300',
        render: 'false',
        limit: '12.5',
    }, schema);
    assert.deepEqual(args.design, { reviewed: true, critique: [{ slide: 1 }] });
    assert.deepEqual(args.pages, [2, 3]);
    assert.equal(args.maxWidth, 300);
    assert.equal(args.render, false);
    assert.equal(args.limit, 12.5);
    assert.equal(args.action, 'finalize');
});

test('string-compatible and mismatched values stay untouched', () => {
    const args = coerceArgsToSchema({
        query: '["a", "b"]',
        script: '{"not": "a script"}',
        design: 'plain prose',
        maxWidth: '300.5',
        pages: '{"page": 2}',
        unknown: '[1]',
    }, schema);
    assert.equal(args.query, '["a", "b"]');
    assert.equal(args.script, '{"not": "a script"}');
    assert.equal(args.design, 'plain prose');
    assert.equal(args.maxWidth, '300.5');
    assert.equal(args.pages, '{"page": 2}');
    assert.equal(args.unknown, '[1]');
});

test('non-object arguments and schemas without properties pass through', () => {
    assert.equal(coerceArgsToSchema(null, schema), null);
    const args = { design: '{"a":1}' };
    assert.equal(coerceArgsToSchema(args, { type: 'object' }), args);
    assert.equal(args.design, '{"a":1}');
});
