#!/usr/bin/env node
// Node's custom-provider config normalizer (normalizeCustomProviderConfig in
// custom-provider-config.mjs) over a table of inputs, valid and refused: the normalized
// config or the exact refusal text.
//   node benchmarks/rust-core/recorders/record-custom-config.mjs [--tree <dir>]
//
// Output: native/core/fixtures/custom-config/golden.json.
import { join } from 'node:path';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const finalDir = join(FIXTURES_ROOT, 'custom-config');
const stage = stageSet(finalDir);
const recorder = 'benchmarks/rust-core/recorders/record-custom-config.mjs';
const at = (path) => importFrom(tree, path);
const { normalizeCustomProviderConfig } = await at(
  'src/runtime/agent/orchestrator/providers/custom-provider-config.mjs'
);

const base = { name: 'P', protocol: 'openai-chat', baseURL: 'http://localhost:1234/v1' };
const v2 = { schemaVersion: 2, ...base };
const long = (n) => 'x'.repeat(n);

const CASES = [
  ['minimal legacy', base],
  ['minimal v2', v2],
  ['not an object', 'text'],
  ['array', []],
  ['legacy models become manual overrides', { ...base, models: [{ id: 'a', name: ' Alpha ', contextWindow: '8000', maxOutputTokens: 512 }, { id: 'b' }] }],
  ['legacy models not an array', { ...base, models: 'x' }],
  ['legacy duplicate model', { ...base, models: [{ id: 'a' }, { id: 'a' }] }],
  ['legacy null entry', { ...base, models: [null] }],
  ['legacy blank context', { ...base, models: [{ id: 'a', contextWindow: '' }] }],
  ['legacy bad context', { ...base, models: [{ id: 'a', contextWindow: 1.5 }] }],
  ['legacy huge context is dropped', { ...base, models: [{ id: 'a', contextWindow: 1e300 }] }],
  ['legacy with v2 field', { ...base, wires: ['chat'] }],
  ['legacy with overrides', { ...base, modelOverrides: {} }],
  ['legacy with headers', { ...base, headers: {} }],
  ['legacy with requestBody', { ...base, requestBody: {} }],
  ['legacy keeps its stated auth', { ...base, auth: 'none' }],
  ['future version', { ...v2, schemaVersion: 3 }],
  ['bad version', { ...v2, schemaVersion: 'two' }],
  ['version one', { ...v2, schemaVersion: 1 }],
  ['v2 unknown field', { ...v2, extra: 1 }],
  ['v2 transport fields are ignored', { ...v2, id: 'custom-x', apiKey: 'k', preconnect: true }],
  ['v2 bad type', { ...v2, type: 'other' }],
  ['v2 padded protocol', { ...v2, protocol: ' openai-chat' }],
  ['v2 non-string protocol', { ...v2, protocol: 3 }],
  ['v2 bad auth', { ...v2, auth: 'maybe' }],
  ['v2 non-boolean enabled', { ...v2, enabled: 'yes' }],
  ['v2 disabled', { ...v2, enabled: false }],
  ['v2 non-boolean preconnect', { ...v2, preconnect: 1 }],
  ['no name', { ...v2, name: '' }],
  ['name not a string', { ...v2, name: 3 }],
  ['name trimmed', { ...v2, name: '  Spaced  ' }],
  ['name too long', { ...v2, name: long(201) }],
  ['name control character', { ...v2, name: 'a\u0007b' }],
  ['no protocol', { ...v2, protocol: undefined }],
  ['unknown protocol', { ...v2, protocol: 'grpc' }],
  ['anthropic protocol', { ...v2, protocol: 'anthropic', baseURL: 'https://api.example.com/' }],
  ['responses protocol', { ...v2, protocol: 'openai-responses' }],
  ['no baseURL', { ...v2, baseURL: '' }],
  ['unparseable baseURL', { ...v2, baseURL: 'not a url' }],
  ['ftp baseURL', { ...v2, baseURL: 'ftp://example.com' }],
  ['credentials in baseURL', { ...v2, baseURL: 'https://u:p@example.com/v1' }],
  ['query in baseURL', { ...v2, baseURL: 'https://example.com/v1?x=1' }],
  ['hash in baseURL', { ...v2, baseURL: 'https://example.com/v1#x' }],
  ['bare question mark', { ...v2, baseURL: 'https://example.com/v1?' }],
  ['plain http on a remote host', { ...v2, baseURL: 'http://example.com/v1' }],
  ['http on loopback v6', { ...v2, baseURL: 'http://[::1]:8080/v1' }],
  ['http on 127.0.0.1', { ...v2, baseURL: 'http://127.0.0.1/v1///' }],
  ['https trailing slashes', { ...v2, baseURL: ' https://example.com/api/// ' }],
  ['baseURL too long', { ...v2, baseURL: `https://example.com/${long(2100)}` }],
  ['apiKeyEnv', { ...v2, apiKeyEnv: 'MY_KEY' }],
  ['apiKeyEnv with keyless auth is dropped', { ...v2, auth: 'none', apiKeyEnv: 'MY_KEY' }],
  ['apiKeyEnv invalid', { ...v2, apiKeyEnv: '1BAD' }],
  ['apiKeyEnv null', { ...v2, apiKeyEnv: null }],
  ['discovery hidden', { ...v2, discovery: { newModelsHidden: true } }],
  ['discovery null', { ...v2, discovery: null }],
  ['discovery unknown key', { ...v2, discovery: { other: 1 } }],
  ['discovery non-boolean', { ...v2, discovery: { newModelsHidden: 'yes' } }],
  ['wires', { ...v2, wires: ['messages', 'chat'] }],
  ['wires empty', { ...v2, wires: [] }],
  ['wires unsupported', { ...v2, wires: ['chat', 'grpc'] }],
  ['wires duplicate', { ...v2, wires: ['chat', 'chat'] }],
  ['wires missing the protocol wire', { ...v2, wires: ['responses'] }],
  ['wires on anthropic', { ...v2, protocol: 'anthropic', wires: ['messages'] }],
  ['wires not an array', { ...v2, wires: 'chat' }],
  ['modelWires', { ...v2, wires: ['chat', 'responses'], modelWires: { m1: 'responses' } }],
  ['modelWires without wires serve the protocol wire', { ...v2, modelWires: { m1: 'chat' } }],
  ['modelWires outside the served wires', { ...v2, modelWires: { m1: 'responses' } }],
  ['modelWires not an object', { ...v2, modelWires: [] }],
  ['modelWires on anthropic', { ...v2, protocol: 'anthropic', modelWires: { m: 'messages' } }],
  ['modelWires bad key', { ...v2, modelWires: { ' m': 'chat' } }],
  ['headers', { ...v2, headers: { 'X-Team': ' blue ', 'x-other': 'v' } }],
  ['headers not an object', { ...v2, headers: [] }],
  ['headers auth', { ...v2, headers: { Authorization: 'x' } }],
  ['headers api-key', { ...v2, headers: { 'API-Key': 'x' } }],
  ['headers duplicate', { ...v2, headers: { 'X-A': '1', 'x-a': '2' } }],
  ['headers bad name', { ...v2, headers: { 'bad name': '1' } }],
  ['headers empty name', { ...v2, headers: { '': '1' } }],
  ['headers non-string value', { ...v2, headers: { 'X-A': 1 } }],
  ['headers control value', { ...v2, headers: { 'X-A': 'a\nb' } }],
  ['headers non-latin value', { ...v2, headers: { 'X-A': 'é' } }],
  ['headers beyond latin-1', { ...v2, headers: { 'X-A': '€' } }],
  ['headers too many', { ...v2, headers: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`X-${i}`, 'v'])) }],
  ['headers long value', { ...v2, headers: { 'X-A': long(4097) } }],
  ['requestBody', { ...v2, requestBody: { top_p: 0.5, seed: 7 } }],
  ['requestBody reserved', { ...v2, requestBody: { model: 'x' } }],
  ['requestBody unsafe', { ...v2, requestBody: JSON.parse('{"__proto__":1}') }],
  ['requestBody not an object', { ...v2, requestBody: 3 }],
  ['requestBody too large', { ...v2, requestBody: { a: long(17000) } }],
  ['overrides', { ...v2, modelOverrides: { m1: { hidden: true, name: 'M One', contextWindow: 9000, maxOutputTokens: 800, supportsVision: false, manual: true } } }],
  ['overrides manual false is dropped', { ...v2, modelOverrides: { m1: { manual: false } } }],
  ['overrides not an object', { ...v2, modelOverrides: [] }],
  ['overrides entry not an object', { ...v2, modelOverrides: { m1: 3 } }],
  ['overrides unknown field', { ...v2, modelOverrides: { m1: { other: 1 } } }],
  ['overrides blank name', { ...v2, modelOverrides: { m1: { name: '  ' } } }],
  ['overrides bad context', { ...v2, modelOverrides: { m1: { contextWindow: '8000' } } }],
  ['overrides zero context', { ...v2, modelOverrides: { m1: { contextWindow: 0 } } }],
  ['overrides float context', { ...v2, modelOverrides: { m1: { contextWindow: 8000.5 } } }],
  ['overrides integral float context', { ...v2, modelOverrides: { m1: { contextWindow: 8000.0 } } }],
  ['overrides unsafe key', { ...v2, modelOverrides: JSON.parse('{"__proto__":{}}') }],
  ['overrides padded key', { ...v2, modelOverrides: { ' m1': {} } }],
  ['overrides empty key', { ...v2, modelOverrides: { '': {} } }],
  ['overrides key too long', { ...v2, modelOverrides: { [long(257)]: {} } }],
  ['overrides too many', { ...v2, modelOverrides: Object.fromEntries(Array.from({ length: 501 }, (_, i) => [`m${i}`, {}])) }],
  ['override non-boolean hidden', { ...v2, modelOverrides: { m1: { hidden: 1 } } }],
  ['override request fields', { ...v2, modelOverrides: { m1: { requestBody: { top_k: 3 }, requestHeaders: { 'X-M': 'v' } } } }],
  ['override refused transport header', { ...v2, modelOverrides: { m1: { requestHeaders: { Host: 'x' } } } }],
  ['override reasoning', { ...v2, modelOverrides: { m1: { reasoning: { levels: ['high', 'ultra', 'low'], wireFormat: 'vllm', wireValues: { high: ' hi ', max: 'mx' }, replay: true } } } }],
  ['override reasoning empty is dropped', { ...v2, modelOverrides: { m1: { reasoning: {} } } }],
  ['override reasoning unknown field', { ...v2, modelOverrides: { m1: { reasoning: { other: 1 } } } }],
  ['override reasoning unknown level', { ...v2, modelOverrides: { m1: { reasoning: { levels: ['loud'] } } } }],
  ['override reasoning duplicate level', { ...v2, modelOverrides: { m1: { reasoning: { levels: ['high', 'HIGH'] } } } }],
  ['override reasoning levels not an array', { ...v2, modelOverrides: { m1: { reasoning: { levels: 'high' } } } }],
  ['override reasoning bad wireFormat', { ...v2, modelOverrides: { m1: { reasoning: { wireFormat: 'x' } } } }],
  ['override reasoning deepseek on responses', { ...v2, protocol: 'openai-responses', modelOverrides: { m1: { reasoning: { wireFormat: 'deepseek' } } } }],
  ['override reasoning wire value outside levels', { ...v2, modelOverrides: { m1: { reasoning: { levels: ['low'], wireValues: { high: 'x' } } } } }],
  ['override reasoning wire value unknown level', { ...v2, modelOverrides: { m1: { reasoning: { wireValues: { loud: 'x' } } } } }],
  ['override reasoning wire value duplicate', { ...v2, modelOverrides: { m1: { reasoning: { wireValues: { high: 'x', HIGH: 'y' } } } } }],
  ['override reasoning blank wire value', { ...v2, modelOverrides: { m1: { reasoning: { wireValues: { high: ' ' } } } } }],
  ['override reasoning wire value not a string', { ...v2, modelOverrides: { m1: { reasoning: { wireValues: { high: 1 } } } } }],
  ['override reasoning wire value too long', { ...v2, modelOverrides: { m1: { reasoning: { wireValues: { high: long(65) } } } } }],
  ['override reasoning non-boolean replay', { ...v2, modelOverrides: { m1: { reasoning: { replay: 'yes' } } } }],
  ['override reasoning not an object', { ...v2, modelOverrides: { m1: { reasoning: [] } } }],
];

// Request-body size is JSON.stringify(...).length, so these inputs are given as raw request
// text (a parse/stringify round trip would hide how a number prints): `1.0` is `1`, `1e21` is
// `1e+21`, `-0` is `0`.
const rawBody = (body) => `{"schemaVersion":2,"name":"P","protocol":"openai-chat","baseURL":"http://localhost:1234/v1","requestBody":${body}}`;
const sized = (head, tail, size) => {
  const probe = JSON.stringify(JSON.parse(`${head}""${tail}`)).length;
  return `${head}"${'a'.repeat(size - probe)}"${tail}`;
};
const RAW = [];
for (const [label, head] of [['1.0', '{"x":1.0,"pad":'], ['1e21', '{"x":1e21,"pad":'], ['-0', '{"x":-0,"pad":'], ['1.50', '{"x":1.50,"pad":']]) {
  for (const size of [16384, 16385]) {
    const body = sized(head, '}', size);
    RAW.push([`requestBody with ${label} at ${JSON.stringify(JSON.parse(body)).length} characters`, rawBody(body)]);
  }
}

const out = [
  ...CASES.map(([name, input]) => [name, input, null]),
  ...RAW.map(([name, text]) => [name, JSON.parse(text), text]),
].map(([name, input, inputText]) => {
  const given = JSON.parse(JSON.stringify(input === undefined ? null : input, (_, v) => (v === undefined ? undefined : v)));
  const shown = inputText === null ? { input: given } : { inputText };
  try {
    return { name, ...shown, config: normalizeCustomProviderConfig(input), error: null };
  } catch (error) {
    return { name, ...shown, config: null, error: error.message };
  }
});writeJson(join(stage, 'golden.json'), out);
writeSetManifest(stage, { set: 'custom-config', recorder, command: 'node benchmarks/rust-core/recorders/record-custom-config.mjs --tree <tree>', identityTree: tree });
commitStage(stage, finalDir);
