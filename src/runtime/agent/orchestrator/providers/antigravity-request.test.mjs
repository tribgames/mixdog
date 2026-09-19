import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAntigravityRequest, antigravityFunctionCallingMode } from './antigravity-request.mjs';

const tools = [
  {
    name: 'read',
    description: 'Read a file.',
    inputSchema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] },
  },
];
const messages = [
  { role: 'system', content: 'rules' },
  { role: 'user', content: 'hello' },
];
const toolConfig = (opts) =>
  buildAntigravityRequest(messages, 'gemini-3.8-flash', tools, opts, 'proj').request.toolConfig;

test('function-calling mode defaults to VALIDATED; the env override and toolChoice take precedence', () => {
  assert.equal(antigravityFunctionCallingMode({}), 'VALIDATED');
  assert.equal(antigravityFunctionCallingMode({ MIXDOG_ANTIGRAVITY_FC_MODE: 'auto' }), 'AUTO');
  assert.equal(antigravityFunctionCallingMode({ MIXDOG_ANTIGRAVITY_FC_MODE: 'ANY' }), 'ANY');
  assert.equal(antigravityFunctionCallingMode({ MIXDOG_ANTIGRAVITY_FC_MODE: 'bogus' }), 'VALIDATED');
  const previous = process.env.MIXDOG_ANTIGRAVITY_FC_MODE;
  try {
    delete process.env.MIXDOG_ANTIGRAVITY_FC_MODE;
    assert.deepEqual(toolConfig({}), { functionCallingConfig: { mode: 'VALIDATED' } });
    process.env.MIXDOG_ANTIGRAVITY_FC_MODE = 'AUTO';
    assert.deepEqual(toolConfig({}), { functionCallingConfig: { mode: 'AUTO' } });
    assert.deepEqual(toolConfig({ toolChoice: 'none' }), { functionCallingConfig: { mode: 'NONE' } });
  } finally {
    if (previous === undefined) delete process.env.MIXDOG_ANTIGRAVITY_FC_MODE;
    else process.env.MIXDOG_ANTIGRAVITY_FC_MODE = previous;
  }
});
