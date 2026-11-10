import assert from 'node:assert/strict';
import test from 'node:test';
import { handleExecMessage, sendToolResult } from './cursor-wire-exec.mjs';
import { encodeJsonValue, decodeJsonValue, decodeMessage } from './cursor-wire-protobuf.mjs';
import { selectToolsForChoice } from './cursor-wire-request.mjs';
import { describeBridgeTools } from '../runtime-core/tool-bridge.mjs';

function dispatch(name, args, tools) {
  const calls = [],
    frames = [];
  const bridge = { write: (frame) => frames.push(frame) };
  const exec = {
    id: 17,
    execId: 'deferred-exec',
    mcpArgs: {
      name,
      toolName: name,
      toolCallId: 'original-call',
      args: Object.fromEntries(Object.entries(args).map(([key, value]) => [key, encodeJsonValue(value)])),
    },
  };
  handleExecMessage(bridge, exec, tools, '', (call) => calls.push(call));
  return { calls, frames, bridge };
}
const decode = (frame) => decodeMessage('AgentClientMessage', frame.subarray(5)).execClientMessage;

test('JSON scalar presence preserves empty strings rather than turning them into null', () => {
  assert.deepEqual([...encodeJsonValue('')], [26, 0]);
  assert.equal(decodeJsonValue(Uint8Array.of(26, 0)), '');
  const original = { empty: '', zero: 0, no: false, nil: null, list: ['', false, 0], object: {} };
  assert.deepEqual(decodeJsonValue(encodeJsonValue(original)), original);
});

test('deferred MCP names enter the granted bridge once and reply to the original execution', () => {
  const { calls, frames, bridge } = dispatch('session', { action: 'status' }, [{ name: 'call_tool' }]);
  assert.equal(calls.length, 1);
  assert.equal(frames.length, 0);
  assert.equal(calls[0].toolName, 'call_tool');
  assert.equal(calls[0].toolCallId, 'original-call');
  assert.deepEqual(JSON.parse(calls[0].decodedArgs), { name: 'session', arguments: { action: 'status' } });
  sendToolResult(bridge, calls[0], { content: 'status result' }, true);
  const reply = decode(frames[0]);
  assert.equal(reply.id, 17);
  assert.equal(reply.execId, 'deferred-exec');
  assert.ok(reply.mcpResult.success);
});

test('advertised tools and malformed arguments are not rewritten or guessed', () => {
  const { calls } = dispatch('load_tool', { name: 'session' }, [{ name: 'load_tool' }, { name: 'call_tool' }]);
  assert.equal(calls[0].toolName, 'load_tool');
  assert.deepEqual(JSON.parse(calls[0].decodedArgs), { name: 'session' });
});

test('request-specific tool_choice cannot regain an excluded bridge', () => {
  const openAiTools = ['read', 'call_tool'].map((name) => ({ type: 'function', function: { name } }));
  for (const choice of ['none', { type: 'function', function: { name: 'read' } }]) {
    const selected = selectToolsForChoice(openAiTools, choice).map((tool) => ({ name: tool.function.name }));
    const { calls, frames } = dispatch('session', { action: 'status' }, selected);
    assert.equal(calls.length, 0);
    assert.match(decode(frames[0]).mcpResult.error.error, /Tool not available/);
  }
});

test('unknown names keep their exact identity for runtime policy rejection', () => {
  for (const name of ['UNKNOWN_FORBIDDEN', 'Read', 'tool_search']) {
    const { calls } = dispatch(name, { value: 'unchanged' }, [{ name: 'read' }, { name: 'call_tool' }]);
    assert.equal(calls[0].toolName, 'call_tool');
    assert.deepEqual(JSON.parse(calls[0].decodedArgs), { name, arguments: { value: 'unchanged' } });
  }
});

test('an exact wrapper for a directly selected target normalizes without changing its arguments or identity', () => {
  const { calls } = dispatch('call_tool', { name: 'read', arguments: { file_path: 'file.txt' } }, [
    { name: 'read' },
    { name: 'call_tool' },
  ]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].toolName, 'read');
  assert.equal(calls[0].toolCallId, 'original-call');
  assert.deepEqual(JSON.parse(calls[0].decodedArgs), { file_path: 'file.txt' });
});

test('wrapper normalization requires both current grants and preserves malformed/meta calls', () => {
  const wrapped = { name: 'read', arguments: {} };
  for (const tools of [[], [{ name: 'read' }]]) {
    const result = dispatch('call_tool', wrapped, tools);
    assert.equal(result.calls.length, 0);
    assert.ok(decode(result.frames[0]).mcpResult.error);
  }
  const bridgeOnly = dispatch('call_tool', wrapped, [{ name: 'call_tool' }]);
  assert.equal(bridgeOnly.calls[0].toolName, 'call_tool');
  const selected = ['call_tool', 'read', 'load_tool', 'tool_search'].map((name) => ({ name }));
  for (const args of [
    { name: 'read' },
    { name: 'read', arguments: {}, extra: true },
    ...[null, [], 'text'].map((argumentsValue) => ({ name: 'read', arguments: argumentsValue })),
    ...['', 'Read', ' read', 'x'.repeat(257), 'call_tool', 'load_tool', 'tool_search'].map((name) => ({
      name,
      arguments: {},
    })),
  ]) {
    const { calls } = dispatch('call_tool', args, selected);
    assert.equal(calls[0].toolName, 'call_tool');
    assert.deepEqual(JSON.parse(calls[0].decodedArgs), args);
  }
  const invalidTargetArgs = dispatch('call_tool', { name: 'read', arguments: { paths: ['bad-alias'] } }, selected);
  assert.equal(invalidTargetArgs.calls[0].toolName, 'read');
  assert.deepEqual(JSON.parse(invalidTargetArgs.calls[0].decodedArgs), { paths: ['bad-alias'] });
});

test('load_tool bad arguments remain invalid and explain the required names field', () => {
  for (const args of [{ name: 'session' }, {}]) {
    const result = describeBridgeTools({}, args);
    assert.equal(result.error.code, 'INVALID_ARGUMENTS');
    assert.match(result.error.message, /"names":\["exact_tool_name"\]/);
    assert.match(result.error.message, /names, not name/);
  }
});
