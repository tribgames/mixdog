import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CUSTOM_REQUEST_BODY_MAX_CHARS,
  CUSTOM_RESERVED_BODY_KEYS,
} from '../../../../../src/runtime/agent/orchestrator/providers/custom-provider-config.mjs';
import { normalizeCustomProviderConfig } from '../../../../../src/runtime/agent/orchestrator/providers/custom-provider.mjs';
import { installTestDom } from '../test-support/test-dom.mjs';

const { restore } = installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  jsdom: { url: 'https://mixdog.test/' },
  actEnvironment: false,
});
test.after(restore);
const { blockedModelHeader, parseRequestBody, REQUEST_BODY_MAX_CHARS, RESERVED_BODY_KEYS, requestBodyText } =
  await import('./custom-request-options.tsx');

test('the UI refuses exactly the keys the runtime refuses, with the same size cap', () => {
  assert.deepEqual([...RESERVED_BODY_KEYS].sort(), [...CUSTOM_RESERVED_BODY_KEYS].sort());
  assert.equal(REQUEST_BODY_MAX_CHARS, CUSTOM_REQUEST_BODY_MAX_CHARS);
});

test('parseRequestBody: blank is none; bad JSON, non-objects and reserved keys block saving', () => {
  assert.deepEqual(parseRequestBody('  '), { value: {}, error: '' });
  assert.deepEqual(parseRequestBody('{"service_tier":"flex"}'), { value: { service_tier: 'flex' }, error: '' });
  assert.match(parseRequestBody('{').error, /valid JSON/);
  assert.match(parseRequestBody('[1]').error, /JSON object/);
  const blocked = parseRequestBody('{"model":"glm-5","stream":false,"temperature":0.2}');
  assert.match(blocked.error, /model, stream/);
  assert.doesNotMatch(blocked.error, /temperature/);
  assert.match(parseRequestBody(`{"a":"${'x'.repeat(REQUEST_BODY_MAX_CHARS)}"}`).error, /at most/);
});

test('the UI refuses the same top-level keys as the runtime, unsafe prototype keys included', () => {
  const config = { type: 'custom', schemaVersion: 2, name: 'P', protocol: 'openai-chat', baseURL: 'https://llm.example.com/v1' };
  for (const key of [...CUSTOM_RESERVED_BODY_KEYS, '__proto__', 'constructor', 'prototype', 'temperature', 'provider']) {
    const runtimeRefuses = (() => {
      try {
        normalizeCustomProviderConfig({ ...config, requestBody: JSON.parse(`{${JSON.stringify(key)}: 1}`) });
        return false;
      } catch {
        return true;
      }
    })();
    assert.equal(parseRequestBody(`{${JSON.stringify(key)}: 1}`).error !== '', runtimeRefuses, key);
  }
});

test('size is the serialized length: a maximal object survives the pretty-printed round trip', () => {
  const filler = 'x'.repeat(REQUEST_BODY_MAX_CHARS - '{"a":""}'.length);
  const object = { a: filler };
  assert.equal(JSON.stringify(object).length, REQUEST_BODY_MAX_CHARS);
  assert.ok(requestBodyText(object).length > REQUEST_BODY_MAX_CHARS);
  assert.deepEqual(parseRequestBody(requestBodyText(object)), { value: object, error: '' });
  const over = parseRequestBody(JSON.stringify({ a: `${filler}y` }));
  assert.match(over.error, /at most/);
  // The runtime accepts exactly what the UI accepts.
  normalizeCustomProviderConfig({
    type: 'custom',
    schemaVersion: 2,
    name: 'P',
    protocol: 'openai-chat',
    baseURL: 'https://llm.example.com/v1',
    requestBody: object,
  });
});

test('model headers: credential and transport headers are blocked; text round-trips', () => {
  assert.equal(blockedModelHeader([{ key: 'X-Provider', value: 'z' }]), '');
  assert.equal(blockedModelHeader([{ key: ' authorization ', value: 'Bearer' }]), 'authorization');
  assert.equal(blockedModelHeader([{ key: 'Content-Type', value: 'x' }]), 'Content-Type');
  assert.equal(requestBodyText({}), '');
  assert.deepEqual(JSON.parse(requestBodyText({ a: { b: 1 } })), { a: { b: 1 } });
});
