import { finalizeTurnInterruptionSnapshot } from '../../../../src/runtime/agent/orchestrator/session/manager/turn-interruption.mjs';
const u = (content, extra = {}) => ({ role: 'user', content, ...extra });
const a = (content, extra = {}) => ({ role: 'assistant', content, ...extra });
const t = (id, content, extra = {}) => ({ role: 'tool', content, toolCallId: id, ...extra });
const call = (id) => ({ id, name: 'read', arguments: { path: 'x' } });
const snap = (o = {}) => ({ responseStarted: false, partialAssistantContent: '', partialReasoningContent: '', phase: 'streaming', observedToolCalls: [], observedToolResults: [], ...o });
const cases = [
  ['text, user cancel', [u('earlier'), a('ok'), u('go')], 'go', snap({ responseStarted: true, partialAssistantContent: 'half ' }), 'user-cancel'],
  ['text, cli-abort', [u('go')], 'go', snap({ responseStarted: true, partialAssistantContent: 'half ' }), 'cli-abort'],
  ['text, non-user abort', [u('go')], 'go', snap({ responseStarted: true, partialAssistantContent: 'half ' }), 'cli-agent-close'],
  ['text, steering interrupt', [u('go')], 'go', snap({ responseStarted: true, partialAssistantContent: 'half ' }), 'interrupt'],
  ['text, provider error', [u('go')], 'go', snap({ responseStarted: true, partialAssistantContent: 'half ' }), 'provider-error'],
  ['text, process crash', [u('go')], 'go', snap({ responseStarted: true, partialAssistantContent: 'half ' }), 'process-crash'],
  ['no output, user cancel rewinds', [u('earlier'), a('ok'), u('go')], 'go', snap(), 'user-cancel'],
  ['no output, cli-abort rewinds', [u('go')], 'go', snap(), 'cli-abort'],
  ['no output, keep prompt', [u('earlier'), a('ok'), u('go')], 'go', snap(), 'user-cancel-keep-prompt'],
  ['no output, non-user keeps prompt', [u('go')], 'go', snap(), 'cli-agent-close'],
  ['thinking only, user cancel rewinds', [u('go')], 'go', snap({ responseStarted: true, partialReasoningContent: 'hmm' }), 'user-cancel'],
  ['thinking only, non-user preserves', [u('go')], 'go', snap({ responseStarted: true, partialReasoningContent: 'hmm' }), 'cli-agent-close'],
  ['unanswered call in the tool phase', [u('go'), a('', { toolCalls: [call('c1')] })], 'go', snap({ responseStarted: true, phase: 'tools' }), 'user-cancel'],
  ['early result is kept, the other call is closed', [u('go'), a('', { toolCalls: [call('c1'), call('c2')] })], 'go',
    snap({ responseStarted: true, phase: 'tools', observedToolResults: [['c1', { role: 'tool', content: 'fine', toolCallId: 'c1', toolKind: null }]] }), 'user-cancel'],
  ['early error result keeps its kind', [u('go'), a('', { toolCalls: [call('c1')] })], 'go',
    snap({ responseStarted: true, phase: 'tools', observedToolResults: [['c1', { role: 'tool', content: 'Error: boom', toolCallId: 'c1', toolKind: 'error' }]] }), 'cli-abort'],
  ['observed streamed call not yet committed', [u('go')], 'go',
    snap({ responseStarted: true, partialAssistantContent: 'let me ', observedToolCalls: [['c9', { call: call('c9'), eagerStarted: false }]] }), 'user-cancel'],
  ['request on the wire after a tool result', [u('go'), a('', { toolCalls: [call('c1')] }), t('c1', 'data')], 'go', snap({ responseStarted: true, partialAssistantContent: 'next ' }), 'user-cancel'],
];
const out = cases.map(([name, transcript, current, snapshot, reason]) => {
  const r = finalizeTurnInterruptionSnapshot({ turnOutgoing: transcript.map((m) => structuredClone(m)), currentUserContent: current, snapshot, abortReason: reason });
  return { name, transcript, current, snapshot, reason, messages: r.messages, responsePreserved: r.responsePreserved, userTurnPreserved: r.userTurnPreserved };
});
console.log(JSON.stringify({ source: 'turn-interruption.mjs finalizeTurnInterruptionSnapshot', cases: out }, null, 1));
