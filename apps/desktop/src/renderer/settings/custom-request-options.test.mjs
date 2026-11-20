import assert from 'node:assert/strict';
import test from 'node:test';

import { installTestDom } from '../test-support/test-dom.mjs';

const { restore } = installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  jsdom: { url: 'https://mixdog.test/' },
  actEnvironment: false,
});
test.after(restore);
const { blockedModelHeader, parseRequestBody, REQUEST_BODY_MAX_CHARS, requestBodyText } = await import(
  './custom-request-options.tsx'
);

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

test('size is the serialized length: a maximal object survives the pretty-printed round trip', () => {
  const filler = 'x'.repeat(REQUEST_BODY_MAX_CHARS - '{"a":""}'.length);
  const object = { a: filler };
  assert.equal(JSON.stringify(object).length, REQUEST_BODY_MAX_CHARS);
  assert.ok(requestBodyText(object).length > REQUEST_BODY_MAX_CHARS);
  assert.deepEqual(parseRequestBody(requestBodyText(object)), { value: object, error: '' });
  const over = parseRequestBody(JSON.stringify({ a: `${filler}y` }));
  assert.match(over.error, /at most/);
});

test('model headers: credential and transport headers are blocked; text round-trips', () => {
  assert.equal(blockedModelHeader([{ key: 'X-Provider', value: 'z' }]), '');
  assert.equal(blockedModelHeader([{ key: ' authorization ', value: 'Bearer' }]), 'authorization');
  assert.equal(blockedModelHeader([{ key: 'Content-Type', value: 'x' }]), 'Content-Type');
  assert.equal(requestBodyText({}), '');
  assert.deepEqual(JSON.parse(requestBodyText({ a: { b: 1 } })), { a: { b: 1 } });
});
