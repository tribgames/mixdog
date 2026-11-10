// A real agent-loop turn in a bot's home chat whose model first calls `react`
// with `args`, then answers with empty text (and, if nudged, with 'Sure.').
// The react call runs through the real tool batch and the real react handler,
// so its tool result is the one a live turn would see.
import { agentLoop } from './agent-loop.mjs';
import { setInternalToolsProvider } from '../internal-tools.mjs';
import { REACTION_TOOL_DEFS } from '../runtime-core/reaction-tool-defs.mjs';
import { createReactionToolHandlers } from '../../../../session-runtime/internal-tool-executor/reaction-tool.mjs';

let scopeSeq = 0;

// `reply`: the text the model answers with after reacting (default none).
// `nextPrompt`: a second user turn run afterwards in the same session, whose
// model answers 'Next.' — the provider prefix guard carries across both.
export async function runReactionTurn(
  args,
  { onToolCall = null, onToolResult = () => {}, reply = '', nextPrompt = '' } = {}
) {
  const scopeId = `reaction-turn-${process.pid}-${++scopeSeq}`;
  const prompt = { role: 'user', content: '고마워', meta: { transcript: { at: 1, messageId: 'msg_user_1' } } };
  const session = {
    id: 'sess_home_reviewer',
    owner: 'cli',
    agent: 'lead',
    mcpScopeId: scopeId,
    tools: [...REACTION_TOOL_DEFS],
    messages: [prompt],
    contextWindow: 200_000,
    rawContextWindow: 200_000,
    compaction: { auto: false },
  };
  const { react } = createReactionToolHandlers({ rt: { session }, live: () => null });
  const dispose = setInternalToolsProvider({
    scopeId,
    tools: [...REACTION_TOOL_DEFS],
    executor: (_name, toolArgs, callerCtx) => react(toolArgs, { callerCtx }),
  });
  const results = [];
  let sends = 0;
  const provider = {
    async send() {
      sends += 1;
      if (sends === 1) return { content: '', toolCalls: [{ id: 'call_react', name: 'react', arguments: args }] };
      if (sends > 3 || (reply && sends === 3)) return { content: 'Next.', toolCalls: [], stopReason: 'end_turn' };
      return { content: sends === 2 ? reply : 'Sure.', toolCalls: [], stopReason: 'end_turn' };
    },
  };
  const loopOpts = {
    session,
    sessionId: session.id,
    onToolResult: (message) => {
      results.push(message);
      onToolResult(message);
    },
  };
  try {
    // The turn's working transcript is the loop's own list, as in a live turn.
    const working = [prompt];
    session.liveTurnMessages = working;
    const result = await agentLoop(provider, working, 'fake-model', session.tools, onToolCall, process.cwd(), loopOpts);
    session.messages = [...working];
    delete session.liveTurnMessages;
    let next = null;
    if (nextPrompt) {
      if (result.content) session.messages.push({ role: 'assistant', content: result.content });
      session.messages.push({ role: 'user', content: nextPrompt });
      session.liveTurnMessages = session.messages;
      next = await agentLoop(provider, session.messages, 'fake-model', session.tools, null, process.cwd(), loopOpts);
    }
    const user = session.messages.find((message) => message.role === 'user');
    return { result, next, sends, results, reactions: user?.meta?.transcript?.reactions || [] };
  } finally {
    dispose();
  }
}
