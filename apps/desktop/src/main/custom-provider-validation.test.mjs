import assert from 'node:assert/strict';
import test from 'node:test';

import { DESKTOP_CAPABILITIES } from '../shared/contract.ts';
import { requiredCustomProviderInput } from './ipc-validation.ts';

const valid = {
  name: 'Local',
  protocol: 'openai-chat',
  baseURL: 'http://localhost:1234/v1',
  models: [{ id: 'm', name: 'M', contextWindow: 4096, maxOutputTokens: 512 }],
};

test('custom provider capabilities are exposed on the desktop surface', () => {
  for (const name of [
    'saveCustomProvider',
    'removeCustomProvider',
    'testCustomProvider',
    'checkCustomProviderKeyEnv',
    'discoverCustomProviderModels',
  ]) {
    assert.equal(DESKTOP_CAPABILITIES.includes(name), true);
  }
});

test('custom provider apiKeyEnv is validated and exclusive with apiKey', () => {
  const env = { ...valid, auth: 'key' };
  assert.doesNotThrow(() => requiredCustomProviderInput({ ...env, apiKeyEnv: 'GROQ_API_KEY' }));
  assert.doesNotThrow(() => requiredCustomProviderInput({ ...env, apiKeyEnv: '_a1' }));
  assert.doesNotThrow(() => requiredCustomProviderInput({ ...env, apiKeyEnv: 'A'.repeat(128) }));
  assert.doesNotThrow(() => requiredCustomProviderInput({ ...env, apiKeyEnv: null, apiKey: 'k' }));
  assert.doesNotThrow(() => requiredCustomProviderInput({ ...env, apiKeyEnv: 'X', apiKey: '' }));
  for (const bad of ['', '1ABC', 'A-B', 'A B', 'A'.repeat(129), 5, {}]) {
    assert.throws(() => requiredCustomProviderInput({ ...env, apiKeyEnv: bad }), /apiKeyEnv/, String(bad));
  }
  assert.throws(() => requiredCustomProviderInput({ ...env, apiKeyEnv: 'X', apiKey: 'k' }), /mutually exclusive/);
  assert.throws(() => requiredCustomProviderInput({ ...valid, auth: 'none', apiKeyEnv: 'X' }), /key auth/);
});

test('custom provider input shape is validated', () => {
  assert.equal(
    requiredCustomProviderInput({ ...valid, id: 'custom-0d6f3d4e-8c55-4a43-9b3e-6a8f6c3f1b10', apiKey: '' }).name,
    'Local'
  );
  assert.doesNotThrow(() => requiredCustomProviderInput({ ...valid, models: undefined }, true));
  assert.throws(() => requiredCustomProviderInput({ ...valid, models: undefined }), /models/);
  assert.throws(() => requiredCustomProviderInput({ ...valid, protocol: 'grpc' }), /protocol/);
  assert.throws(() => requiredCustomProviderInput({ ...valid, extra: 1 }), /unsupported/);
  assert.throws(
    () => requiredCustomProviderInput({ ...valid, models: [{ id: 'm', contextWindow: -1 }] }),
    /contextWindow/
  );
  assert.throws(() => requiredCustomProviderInput([]), /invalid/);
});

const v2 = {
  name: 'Local',
  protocol: 'openai-chat',
  baseURL: 'http://localhost:1234/v1',
  schemaVersion: 2,
  auth: 'none',
  discovery: { newModelsHidden: true },
  modelOverrides: {
    m: {
      manual: true,
      hidden: false,
      name: 'M',
      contextWindow: 4096,
      maxOutputTokens: 512,
      reasoning: { levels: ['low', 'max'], wireFormat: 'deepseek', wireValues: { low: 'l' }, replay: true },
    },
  },
};

test('v2 custom provider input shape is validated', () => {
  assert.doesNotThrow(() => requiredCustomProviderInput(v2));
  for (const bad of [
    { schemaVersion: 3 },
    { auth: 'basic' },
    { discovery: { x: 1 } },
    { discovery: { newModelsHidden: 'yes' } },
    { modelOverrides: [] },
    { modelOverrides: { m: { extra: 1 } } },
    { modelOverrides: { m: { hidden: 'no' } } },
    { modelOverrides: { m: { contextWindow: 0 } } },
    { modelOverrides: { m: { reasoning: { wireFormat: 'x' } } } },
    { modelOverrides: { m: { reasoning: { wireValues: { low: 1 } } } } },
    { modelOverrides: { m: { reasoning: { wireValues: { bogus: 'x' } } } } },
    { modelOverrides: { m: { reasoning: { nope: 1 } } } },
    { modelOverrides: JSON.parse('{"__proto__":{}}') },
    { modelOverrides: Object.fromEntries(Array.from({ length: 501 }, (_, i) => [`m${i}`, {}])) },
    { modelOverrides: { ['m'.repeat(257)]: {} } },
    { modelOverrides: { m: { name: 'n'.repeat(201) } } },
    { modelOverrides: { m: { reasoning: { wireValues: { low: 'w'.repeat(65) } } } } },
    { schemaVersion: undefined },
  ]) {
    assert.throws(() => requiredCustomProviderInput({ ...v2, ...bad }), TypeError, JSON.stringify(bad).slice(0, 60));
  }
  assert.doesNotThrow(() =>
    requiredCustomProviderInput({
      ...v2,
      modelOverrides: Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`m${i}`, {}])),
    })
  );
});

test('IPC custom-provider vocabulary and limits match the runtime normalizer', async () => {
  const ipc = await import('./ipc-validation.ts');
  const runtime = await import('../../../../src/runtime/agent/orchestrator/providers/custom-provider-config.mjs');
  assert.deepEqual([...ipc.CUSTOM_REASONING_LEVELS], [...runtime.CUSTOM_REASONING_LEVELS]);
  assert.equal(ipc.CUSTOM_MAX_OVERRIDES, runtime.CUSTOM_MODEL_OVERRIDE_LIMIT);
  // Every boundary value the IPC accepts, the runtime accepts too.
  const atLimit = {
    ...v2,
    baseURL: 'http://localhost:1234/v1',
    name: 'p'.repeat(ipc.CUSTOM_MAX_NAME),
    modelOverrides: {
      ['m'.repeat(ipc.CUSTOM_MAX_MODEL_ID)]: {
        name: 'n'.repeat(ipc.CUSTOM_MAX_NAME),
        reasoning: {
          levels: [...ipc.CUSTOM_REASONING_LEVELS],
          wireValues: { low: 'w'.repeat(ipc.CUSTOM_MAX_WIRE_VALUE) },
        },
      },
    },
  };
  assert.doesNotThrow(() => requiredCustomProviderInput(atLimit));
  assert.doesNotThrow(() => runtime.normalizeCustomProviderConfig(atLimit));
});

// One accept set: every v2 modelOverrides / reasoning / discovery case is
// accepted or rejected identically by the IPC validator and the runtime
// normalizer (the authority). `true` = accepted.
const PARITY_CASES = [
  ['baseline', {}, true],
  ['empty override', { modelOverrides: { m: {} } }, true],
  ['ultra level', { modelOverrides: { m: { reasoning: { levels: ['ultra'] } } } }, true],
  ['ultra wire key', { modelOverrides: { m: { reasoning: { levels: ['max'], wireValues: { ultra: 'u' } } } } }, true],
  ['case/space-folded level', { modelOverrides: { m: { reasoning: { levels: [' High'] } } } }, true],
  ['empty levels', { modelOverrides: { m: { reasoning: { levels: [] } } } }, true],
  [
    'all levels',
    { modelOverrides: { m: { reasoning: { levels: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] } } } },
    true,
  ],
  ['deepseek on chat', { modelOverrides: { m: { reasoning: { wireFormat: 'deepseek' } } } }, true],
  ['max safe integer', { modelOverrides: { m: { contextWindow: Number.MAX_SAFE_INTEGER } } }, true],
  ['discovery empty', { discovery: {} }, true],
  ['ultra + max duplicate', { modelOverrides: { m: { reasoning: { levels: ['max', 'ultra'] } } } }, false],
  ['duplicate level', { modelOverrides: { m: { reasoning: { levels: ['low', 'low'] } } } }, false],
  ['unknown level', { modelOverrides: { m: { reasoning: { levels: ['turbo'] } } } }, false],
  ['non-string level', { modelOverrides: { m: { reasoning: { levels: [1] } } } }, false],
  ['levels not array', { modelOverrides: { m: { reasoning: { levels: 'low' } } } }, false],
  [
    'wire key not in levels',
    { modelOverrides: { m: { reasoning: { levels: ['low'], wireValues: { high: 'h' } } } } },
    false,
  ],
  [
    'duplicate wire key via alias',
    { modelOverrides: { m: { reasoning: { wireValues: { max: 'a', ultra: 'b' } } } } },
    false,
  ],
  ['blank wire value', { modelOverrides: { m: { reasoning: { wireValues: { low: '  ' } } } } }, false],
  ['control char wire value', { modelOverrides: { m: { reasoning: { wireValues: { low: 'a\u0001b' } } } } }, false],
  [
    'deepseek on responses',
    { protocol: 'openai-responses', modelOverrides: { m: { reasoning: { wireFormat: 'deepseek' } } } },
    false,
  ],
  ['unknown override key', { modelOverrides: { m: { extra: 1 } } }, false],
  ['unknown reasoning key', { modelOverrides: { m: { reasoning: { nope: 1 } } } }, false],
  ['unknown discovery key', { discovery: { x: 1 } }, false],
  ['null discovery', { discovery: null }, false],
  ['null modelOverrides', { modelOverrides: null }, false],
  ['numeric-string contextWindow', { modelOverrides: { m: { contextWindow: '4096' } } }, false],
  ['numeric-string maxOutputTokens', { modelOverrides: { m: { maxOutputTokens: '512' } } }, false],
  ['unsafe integer', { modelOverrides: { m: { contextWindow: 2 ** 60 } } }, false],
  ['zero', { modelOverrides: { m: { maxOutputTokens: 0 } } }, false],
  ['fraction', { modelOverrides: { m: { contextWindow: 1.5 } } }, false],
  ['null number', { modelOverrides: { m: { contextWindow: null } } }, false],
  ['blank name', { modelOverrides: { m: { name: '  ' } } }, false],
  ['control char name', { modelOverrides: { m: { name: 'a\u0007' } } }, false],
  ['model id with surrounding space', { modelOverrides: { ' m': {} } }, false],
  ['model id with control char', { modelOverrides: { 'm\u0000': {} } }, false],
  ['non-boolean hidden', { modelOverrides: { m: { hidden: 'no' } } }, false],
  ['non-boolean replay', { modelOverrides: { m: { reasoning: { replay: 1 } } } }, false],
  // Top level.
  ['auth omitted', {}, true],
  ['auth none', { auth: 'none' }, true],
  ['auth key', { auth: 'key' }, true],
  ['enabled false', { enabled: false }, true],
  ['type custom', { type: 'custom' }, true],
  ['every protocol', { protocol: 'anthropic' }, true],
  ['unknown top-level field', { extra: 1 }, false],
  ['enabled string', { enabled: 'false' }, false],
  ['enabled null', { enabled: null }, false],
  ['auth null', { auth: null }, false],
  ['auth wrong case', { auth: 'KEY' }, false],
  ['auth number', { auth: 1 }, false],
  ['protocol padded', { protocol: ' openai-chat' }, false],
  ['protocol number', { protocol: 1 }, false],
  ['protocol unknown', { protocol: 'grpc' }, false],
  ['name number', { name: 1 }, false],
  ['name blank', { name: ' ' }, false],
  ['name control char', { name: 'a\u0001' }, false],
  ['name too long', { name: 'n'.repeat(201) }, false],
  ['type other', { type: 'openai' }, false],
  ['v2 with legacy models', { models: [{ id: 'm' }] }, false],
  ['baseURL not string', { baseURL: 5 }, false],
  ['baseURL too long', { baseURL: `http://localhost:1234/${'a'.repeat(2048)}` }, false],
  ['schemaVersion string', { schemaVersion: '2' }, false],
  ['schemaVersion future', { schemaVersion: 3 }, false],
];

test('IPC validator and runtime normalizer accept and reject the same v2 inputs', async () => {
  const { normalizeCustomProviderConfig } = await import(
    '../../../../src/runtime/agent/orchestrator/providers/custom-provider-config.mjs'
  );
  const base = { name: 'Local', protocol: 'openai-chat', baseURL: 'http://localhost:1234/v1', schemaVersion: 2 };
  const accepts = (fn) => {
    try {
      fn();
      return true;
    } catch {
      return false;
    }
  };
  for (const [label, patch, expected] of PARITY_CASES) {
    const input = { ...base, ...patch };
    assert.equal(
      accepts(() => requiredCustomProviderInput(input)),
      expected,
      `IPC: ${label}`
    );
    assert.equal(
      accepts(() => normalizeCustomProviderConfig(input)),
      expected,
      `runtime: ${label}`
    );
  }
  // Transport fields ride along with the config: IPC validates them, the
  // normalizer ignores them (preconnect is a runtime-only construction flag).
  assert.doesNotThrow(() =>
    requiredCustomProviderInput({ ...base, id: 'custom-0d6f3d4e-8c55-4a43-9b3e-6a8f6c3f1b10', apiKey: 'k' })
  );
  assert.doesNotThrow(() => normalizeCustomProviderConfig({ ...base, id: 'custom-x', apiKey: 'k', preconnect: false }));
  assert.throws(() => normalizeCustomProviderConfig({ ...base, preconnect: 'no' }));
  // The runtime canonicalizes what the IPC lets through.
  const out = normalizeCustomProviderConfig({
    ...base,
    modelOverrides: { m: { reasoning: { levels: ['ultra'], wireValues: { ultra: 'u' } } } },
  });
  assert.deepEqual(out.modelOverrides.m.reasoning, { levels: ['max'], wireValues: { max: 'u' } });
  // Unversioned (legacy) input keeps its tolerant migration.
  const legacy = normalizeCustomProviderConfig({
    ...base,
    schemaVersion: undefined,
    models: [{ id: 'm', contextWindow: '4096', name: '' }],
  });
  assert.deepEqual(legacy.modelOverrides.m, { manual: true, hidden: false, contextWindow: 4096 });
});

// Transport fields (`id`, `apiKey`): the real setup service
// (provider-admin.mjs, via saveCustomProvider → resolveCustomInput) and the
// IPC validator accept and reject the same inputs. Keyless inputs keep the
// service off the OS keychain; rejected key-auth cases fail before it.
const EXISTING_ID = 'custom-0d6f3d4e-8c55-4a43-9b3e-6a8f6c3f1b10';
const TRANSPORT_CASES = [
  ['no id (new provider)', {}, true],
  ['existing generated id', { id: EXISTING_ID }, true],
  ['apiKey string (ignored when keyless)', { apiKey: 'k' }, true],
  ['apiKey empty', { apiKey: '' }, true],
  ['apiKey at the bound', { apiKey: 'k'.repeat(65_536) }, true],
  ['id null', { id: null }, false],
  ['id empty', { id: '' }, false],
  ['id number', { id: 7 }, false],
  ['id not a generated custom id', { id: 'custom-x' }, false],
  ['id first-party', { id: 'openai' }, false],
  ['id padded', { id: ` ${EXISTING_ID}` }, false],
  ['id uppercase', { id: EXISTING_ID.toUpperCase().replace('CUSTOM', 'custom') }, false],
  ['apiKey null keyless', { apiKey: null }, false],
  ['apiKey null with key auth', { apiKey: null, auth: 'key' }, false],
  ['apiKey number with key auth', { apiKey: 5, auth: 'key' }, false],
  ['apiKey over the bound', { apiKey: 'k'.repeat(65_537) }, false],
];

test('setup service and IPC validator accept and reject the same transport fields', async () => {
  const admin = await import('../../../../src/session-runtime/services/provider-admin.mjs');
  const ipc = await import('./ipc-validation.ts');
  assert.equal(ipc.CUSTOM_MAX_API_KEY, admin.CUSTOM_API_KEY_MAX);
  const base = {
    schemaVersion: 2,
    name: 'Local',
    protocol: 'openai-chat',
    baseURL: 'http://localhost:1234/v1',
    auth: 'none',
  };
  const cfgMod = () => {
    let config = {
      providers: { [EXISTING_ID]: { ...base, type: 'custom', enabled: true, discovery: {}, modelOverrides: {} } },
    };
    return { loadConfig: () => structuredClone(config), saveConfig: (next) => (config = structuredClone(next)) };
  };
  for (const [label, patch, expected] of TRANSPORT_CASES) {
    const input = { ...base, ...patch };
    let ipcOk = true;
    try {
      requiredCustomProviderInput(input);
    } catch {
      ipcOk = false;
    }
    const serviceOk = await admin.saveCustomProvider(cfgMod(), input).then(
      () => true,
      () => false
    );
    assert.equal(ipcOk, expected, `IPC: ${label}`);
    assert.equal(serviceOk, expected, `service: ${label}`);
  }
});

test('updateCustomProviderModel is registered and its patch shape is validated', async () => {
  assert.equal(DESKTOP_CAPABILITIES.includes('updateCustomProviderModel'), true);
  const { requiredCustomModelPatch } = await import('./ipc-validation.ts');
  assert.doesNotThrow(() => requiredCustomModelPatch('custom-x', 'm', null));
  assert.doesNotThrow(() =>
    requiredCustomModelPatch('custom-x', 'm', { hidden: null, name: null, reasoning: { levels: null, replay: false } })
  );
  // ultra is accepted (the runtime canonicalizes it); patch wire values are
  // pruned against the merged levels by the service, not rejected here.
  assert.doesNotThrow(() =>
    requiredCustomModelPatch('custom-x', 'm', { reasoning: { levels: ['ultra'], wireValues: { low: 'l' } } })
  );
  assert.throws(() => requiredCustomModelPatch('custom-x', 'm', { contextWindow: '10' }), /contextWindow/);
  assert.throws(() => requiredCustomModelPatch('custom-x', 'm', { extra: 1 }), /unsupported/);
  assert.throws(() => requiredCustomModelPatch('custom-x', '__proto__', {}), /invalid/);
  assert.throws(() => requiredCustomModelPatch('custom-x', 'm', { contextWindow: -1 }), /contextWindow/);
  assert.throws(() => requiredCustomModelPatch('custom-x', 'm', []), /invalid/);
});
