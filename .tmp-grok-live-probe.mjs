import { GrokOAuthProvider } from './src/runtime/agent/orchestrator/providers/grok-oauth.mjs';
import { TOOL_SEARCH_TOOL } from './src/session-runtime/tool-defs.mjs';

function summarizeError(err) {
  return {
    name: err?.name,
    message: err?.message,
    code: err?.code,
    status: err?.status,
    httpStatus: err?.httpStatus,
    responseStatus: err?.response?.status,
    data: err?.data,
    error: err?.error,
    cause: err?.cause?.message || err?.cause,
    stackTop: String(err?.stack || '').split('\n').slice(0, 4).join('\n'),
  };
}

async function runCase(label, messages, tools = [], opts = {}) {
  const provider = new GrokOAuthProvider({});
  const events = [];
  try {
    const res = await provider.send(messages, 'grok-4.5', tools, {
      maxOutputTokens: 32,
      onStageChange: (s) => events.push(['stage', s]),
      onStreamDelta: () => {},
      onTextDelta: () => {},
      onToolCall: (c) => events.push(['tool', c?.name]),
      ...opts,
    });
    console.log('\nCASE_OK', label, JSON.stringify({ content: String(res?.content || '').slice(0, 200), toolCalls: res?.toolCalls?.map(c => c.name) || [], stopReason: res?.stopReason || null, events }));
  } catch (err) {
    console.log('\nCASE_ERR', label, JSON.stringify({ err: summarizeError(err), events }, null, 2));
  }
}

await runCase('clean-no-tools', [
  { role: 'system', content: 'You are concise.' },
  { role: 'user', content: 'Reply exactly: ok' },
]);

await runCase('provider-switch-prior-tool-history-no-tools', [
  { role: 'system', content: 'You are concise.' },
  { role: 'user', content: 'Before switch' },
  { role: 'assistant', content: '', toolCalls: [{ id: 'call_patch_1', name: 'apply_patch', arguments: { patch: '*** Begin Patch\n*** End Patch\n' } }] },
  { role: 'tool', toolCallId: 'call_patch_1', content: 'OK' },
  { role: 'user', content: 'Reply exactly: ok' },
], []);

await runCase('provider-switch-prior-load-tool-with-load-tool-active', [
  { role: 'system', content: 'You are concise.' },
  { role: 'user', content: 'Before switch' },
  { role: 'assistant', content: '', toolCalls: [{ id: 'call_load_1', name: 'load_tool', arguments: { names: ['read'] }, nativeType: 'tool_search_call' }] },
  { role: 'tool', toolCallId: 'call_load_1', content: '{"loaded":["read"]}', nativeToolSearch: { openaiTools: [{ name: 'read' }] } },
  { role: 'user', content: 'Reply exactly: ok' },
], [TOOL_SEARCH_TOOL]);
