import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAntigravityRequest } from '../../providers/antigravity-request.mjs';
import {
  beginProviderToolExclusions,
  providerToolExclusionReason,
  recordProviderToolExclusion,
} from './provider-tool-exclusions.mjs';
import { preDispatchDenyForSession } from './pre-dispatch-deny.mjs';
import { resolveExecutionToolCall } from './tool-call-resolution.mjs';

const messages = [
  { role: 'system', content: 'rules' },
  { role: 'user', content: 'hello' },
];
const tool = (name, inputSchema) => ({ name, description: `${name} tool.`, inputSchema, annotations: {} });
const good = tool('read', { type: 'object', properties: { file_path: { type: 'string' } } });
const rootAllOf = tool('mcp__x__broken', { type: 'object', properties: {}, allOf: [{}] });
const tupleItems = tool('mcp__x__tuple', { type: 'object', properties: { a: { type: 'bogus-type' } } });

// One provider request the way the agent loop sends it (send-phase.mjs):
// exclusions reset per request and are recorded for the session.
function sendRequest(session, tools, notices, model = 'claude-sonnet-4-6') {
  beginProviderToolExclusions(session);
  const onStageChange = (stage, detail) => notices.push({ stage, ...detail });
  const opts = { onToolExcluded: (exclusion) => recordProviderToolExclusion(session, exclusion, onStageChange) };
  return buildAntigravityRequest(messages, model, tools, opts, 'proj').request;
}

test('an excluded tool is noticed once per session and per distinct tool', () => {
  const session = { id: 's1', tools: [good, rootAllOf, tupleItems] };
  const notices = [];
  sendRequest(session, [good, rootAllOf], notices);
  sendRequest(session, [good, rootAllOf], notices);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].stage, 'notice');
  assert.equal(notices[0].tone, 'warn');
  assert.match(notices[0].message, /^Tool "mcp__x__broken" was excluded/);
  assert.match(notices[0].message, /input schema is invalid at \/allOf \(.*root "allOf"\)/);
  assert.match(notices[0].message, /Fix the tool's schema or disable the tool\.$/);

  sendRequest(session, [good, rootAllOf, tupleItems], notices);
  assert.deepEqual(
    notices.map((notice) => notice.message.match(/^Tool "([^"]+)"/)[1]),
    ['mcp__x__broken', 'mcp__x__tuple']
  );

  const other = { id: 's2', tools: [rootAllOf] };
  sendRequest(other, [rootAllOf], notices);
  assert.equal(notices.length, 3, 'another session is told again');
});

test('a direct call to an excluded tool gets an actionable error naming the reason', () => {
  const session = { id: 's3', tools: [good, rootAllOf] };
  const request = sendRequest(session, [good, rootAllOf], []);
  assert.deepEqual(request.tools.at(-1).functionDeclarations.map((d) => d.name), ['read']);
  const denial = preDispatchDenyForSession(session, { name: 'mcp__x__broken', arguments: {} });
  assert.match(denial, /^Error: tool "mcp__x__broken" is unavailable with the current model/);
  assert.match(denial, /rejected its input schema at \/allOf \(.*root "allOf"\)/);
  assert.match(denial, /no call was sent/);
  assert.match(denial, /fix the tool's schema or disable it/);
  assert.equal(preDispatchDenyForSession(session, { name: 'read', arguments: {} }), null);

  // A later request that keeps the tool (another model) lifts the refusal.
  sendRequest(session, [good, rootAllOf], [], 'gemini-3.8-flash');
  assert.equal(providerToolExclusionReason(session, 'mcp__x__broken'), null);
  assert.equal(preDispatchDenyForSession(session, { name: 'mcp__x__broken', arguments: {} }), null);
});

test('call_tool naming an excluded tool returns the same reason instead of a direct-tool hint', () => {
  const session = {
    id: 's4',
    deferredProviderMode: 'canonical',
    toolExposureMode: 'bridge-v1',
    toolSpec: 'full',
    tools: [good, rootAllOf],
    deferredToolCatalog: [good, rootAllOf],
  };
  sendRequest(session, [good, rootAllOf], []);
  const call = resolveExecutionToolCall(
    { id: 'X', name: 'call_tool', arguments: { name: 'mcp__x__broken', arguments: {} } },
    session
  );
  assert.match(call.bridgeError, /^Error: TOOL_EXCLUDED: tool "mcp__x__broken" is unavailable with the current model/);
  assert.match(call.bridgeError, /root "allOf"/);
  assert.match(preDispatchDenyForSession(session, call), /TOOL_EXCLUDED/);
});
