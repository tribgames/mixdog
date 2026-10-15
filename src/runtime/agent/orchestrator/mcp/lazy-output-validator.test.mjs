import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { createLazyOutputValidator } from './lazy-output-validator.mjs';

const schema = { type: 'object', properties: { count: { type: 'number' } }, required: ['count'] };

test('listing tools compiles no output schema; the first result compiles only its tool', () => {
  const compiled = [];
  class CountingValidator extends AjvJsonSchemaValidator {
    getValidator(target) {
      compiled.push(target);
      return super.getValidator(target);
    }
  }
  const client = new Client(
    { name: 'test', version: '1.0.0' },
    { jsonSchemaValidator: createLazyOutputValidator(CountingValidator) }
  );
  const tools = Array.from({ length: 50 }, (_, i) => ({
    name: `t${i}`,
    inputSchema: { type: 'object' },
    outputSchema: schema,
  }));
  client.cacheToolMetadata(tools);
  assert.equal(compiled.length, 0, 'listing compiles nothing');
  const validate = client.getToolOutputValidator('t3');
  assert.ok(validate, 'a tool with an outputSchema still has a validator');
  assert.equal(client.getToolOutputValidator('missing'), undefined);
  assert.deepEqual(validate({ count: 2 }), { valid: true, data: { count: 2 }, errorMessage: undefined });
  assert.equal(compiled.length, 1, 'the first result compiles its own schema');
  const invalid = validate({ count: 'x' });
  assert.equal(invalid.valid, false);
  assert.match(invalid.errorMessage, /count/);
  assert.equal(compiled.length, 1, 'later results reuse the compiled schema');
});

test('schemas with $id resolve exactly as the stock SDK client, whatever the call order', () => {
  const tools = [
    {
      name: 'base',
      inputSchema: { type: 'object' },
      outputSchema: {
        $id: 'https://example.test/base.json',
        type: 'object',
        properties: { n: { type: 'number' } },
        required: ['n'],
      },
    },
    {
      name: 'uses',
      inputSchema: { type: 'object' },
      outputSchema: {
        type: 'object',
        properties: { inner: { $ref: 'https://example.test/base.json' } },
        required: ['inner'],
      },
    },
    {
      name: 'dup',
      inputSchema: { type: 'object' },
      outputSchema: { $id: 'https://example.test/base.json', type: 'object', properties: { n: { type: 'string' } } },
    },
  ];
  const stock = new Client({ name: 'stock', version: '1.0.0' });
  const lazy = new Client(
    { name: 'lazy', version: '1.0.0' },
    { jsonSchemaValidator: createLazyOutputValidator(AjvJsonSchemaValidator) }
  );
  stock.cacheToolMetadata(tools);
  lazy.cacheToolMetadata(tools);
  // Called before the tool whose schema it references, and a repeated $id.
  for (const [tool, input] of [
    ['uses', { inner: { n: 1 } }],
    ['uses', { inner: { n: 'x' } }],
    ['dup', { n: 'text' }],
    ['dup', { n: 2 }],
    ['base', { n: 3 }],
  ]) {
    assert.deepEqual(
      lazy.getToolOutputValidator(tool)(input),
      stock.getToolOutputValidator(tool)(input),
      `${tool} ${JSON.stringify(input)}`
    );
  }
});

test('a reference to an $id listed later fails the listing, as in the stock SDK client', () => {
  const tools = [
    {
      name: 'early',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object', properties: { inner: { $ref: 'https://example.test/late.json' } } },
    },
    {
      name: 'late',
      inputSchema: { type: 'object' },
      outputSchema: { $id: 'https://example.test/late.json', type: 'object' },
    },
  ];
  const stock = new Client({ name: 'stock', version: '1.0.0' });
  const lazy = new Client(
    { name: 'lazy', version: '1.0.0' },
    { jsonSchemaValidator: createLazyOutputValidator(AjvJsonSchemaValidator) }
  );
  assert.throws(() => stock.cacheToolMetadata(tools), /resolve reference/);
  assert.throws(() => lazy.cacheToolMetadata(tools), /resolve reference/);
});

test('a schema referencing only its own definitions still compiles on first use', () => {
  let compiled = 0;
  class CountingValidator extends AjvJsonSchemaValidator {
    getValidator(target) {
      compiled += 1;
      return super.getValidator(target);
    }
  }
  const client = new Client(
    { name: 'test', version: '1.0.0' },
    { jsonSchemaValidator: createLazyOutputValidator(CountingValidator) }
  );
  const local = { type: 'object', properties: { item: { $ref: '#/$defs/item' } }, $defs: { item: { type: 'string' } } };
  client.cacheToolMetadata([{ name: 'local', inputSchema: { type: 'object' }, outputSchema: local }]);
  assert.equal(compiled, 0);
  assert.equal(client.getToolOutputValidator('local')({ item: 3 }).valid, false);
  assert.equal(compiled, 1);
});
