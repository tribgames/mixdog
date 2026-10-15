// side-question.mjs — /btw: a quick question answered while the main turn
// keeps working. The answer comes from a cache-sharing fork of the session's
// latest provider request (side-question-store.mjs): the same model, system
// prompt, tools and cache-relevant options and the same message prefix, so
// the provider's prompt cache serves the prefix. Only the reply that request
// produced and one question are appended. One provider call, no tool loop;
// the answer is returned to the caller and never enters the transcript.
import { collectAssistantToolCallIds } from './context-tool-pairs.mjs';
import { buildIntermediateAssistantMessage, buildToolCallAssistantMessage } from './loop/assistant-commit.mjs';
import { logSessionLlmUsage } from './manager/ask-turn-commit.mjs';
import { disposeTransportScope, forkTransportScope } from '../providers/transport-scope.mjs';
import { isAgentOwner } from '../agent-owner.mjs';
import { getProvider } from '../providers/registry.mjs';
import { prepareTurnEffortConfiguration } from '../providers/effort-configuration.mjs';
import { providerNativeToolPrefixCount } from '../runtime-core/provider-request-tools.mjs';
import { snapshotProviderRequestTools } from '../runtime-core/tool-catalog.mjs';
import { repairTranscriptBeforeProviderSend } from './loop/transcript-repair.mjs';
import { buildRequestSendOptions } from './manager/ask-turn-loop-options.mjs';
import { filterModelVisibleSessionMessages } from './manager/message-sanitize.mjs';
import { hasUserConversationMessage } from './manager/prompt-utils.mjs';
import { loadSession } from './store.mjs';
import { projectSyntheticUserEnvelopes } from './synthetic-user-envelope.mjs';
import { beginSideQuestion, sideQuestionRequest, sideQuestionRequestSnapshot } from './side-question-store.mjs';

export { cancelSideQuestion } from './side-question-store.mjs';

export const SIDE_QUESTION_NO_REQUEST = 'Send a message first, then try /btw.';
export const SIDE_QUESTION_TOOL_ATTEMPT =
  'The model tried to use a tool instead of answering. A side question cannot run tools; try asking it differently.';
const SIDE_QUESTION_EMPTY_ANSWER = 'The model returned no answer.';

// The reply's tool calls run in the main session; the fork only needs each
// call answered so the request stays well-formed.
const SIDE_QUESTION_TOOL_STUB =
  'This tool call belongs to the main task and is handled there; its result is not part of this side question.';

function sideQuestionPrompt(question) {
  return [
    '<side-question>',
    'The user is asking you a quick side question. The main agent keeps working on the task on its own;',
    'this exchange does not reach it and does not change that work.',
    'Answer directly, in this one response, from what this conversation already contains.',
    'No tools are available here: do not call any, and do not offer or promise to do anything.',
    'If the conversation does not tell you the answer, say that you do not know.',
    '',
    question,
    '</side-question>',
  ].join('\n');
}

// The assistant turn the saved request produced, built the way the loop
// commits it (without the turn's one-shot transcript metadata), plus a stub
// result per tool call.
function replyMessages(response) {
  if (!response) return [];
  const reply = response.toolCalls?.length
    ? buildToolCallAssistantMessage(response, { calls: response.toolCalls, suppressMidTurnText: false, opts: {} })
    : buildIntermediateAssistantMessage(response, {});
  if (!reply) return [];
  const stubs = collectAssistantToolCallIds(reply).map((id) => ({
    role: 'tool',
    toolCallId: id,
    content: SIDE_QUESTION_TOOL_STUB,
  }));
  return [reply, ...stubs];
}

/**
 * The fork of a saved request: its messages unchanged, then the reply and
 * the question. The send options are the saved ones; the provider
 * continuation state follows the reply when it is appended, exactly as the
 * main loop's next request would carry it. `sharedCachePrefixCount` (the
 * shared prefix's message count, which survives model-proxy serialization)
 * keeps an Anthropic message breakpoint on the shared prefix, so the fork reads the
 * saved request's cache entry and writes none for its suffix.
 */
export function buildSideQuestionRequest(request, question) {
  const reply = replyMessages(request.response);
  const opts = { ...request.opts };
  if (reply.length && Object.hasOwn(request.response, 'providerState')) {
    opts.providerState = request.response.providerState;
  }
  if (request.messages.length) opts.sharedCachePrefixCount = request.messages.length;
  const messages = [
    ...request.messages,
    ...reply,
    // A user interjection keeps its own turn (never folded into a preceding
    // tool result), so the prefix's last block reaches the provider unchanged.
    { role: 'user', content: sideQuestionPrompt(question), meta: { source: 'steering' } },
  ];
  return { messages, opts };
}

/**
 * The request the main loop would send next for a session that has none saved
 * (the runtime restarted, or the saved one was forgotten): the session's own
 * provider, model, tools, send options and transcript, assembled by the same
 * pieces the loop uses, without the loop's side effects (no compaction, no
 * transcript repair in place, nothing written to the session). Null when the
 * session has no conversation, no resolvable provider, or is an agent's.
 */
function nextMainRequest(sessionId) {
  const session = sessionId ? loadSession(sessionId) : null;
  if (!session || session.closed === true || isAgentOwner(session)) return null;
  if (!hasUserConversationMessage(session.messages)) return null;
  const provider = getProvider(session.provider);
  if (!provider) return null;
  const transcript = filterModelVisibleSessionMessages(session.messages);
  repairTranscriptBeforeProviderSend(transcript, sessionId);
  const opts = buildRequestSendOptions({
    sessionId,
    session,
    turnEffort: session.effort || null,
    effortConfiguration: prepareTurnEffortConfiguration(session, provider),
    stepAutoEffort: null,
    codexTurnId: null,
    startedAtMs: Date.now(),
    signal: undefined,
  });
  const sendTools = snapshotProviderRequestTools({
    provider: session.provider || provider.name,
    tools: session.tools,
    nativeTools: opts.nativeTools,
    messages: transcript,
    session,
  });
  opts.iteration = 1;
  opts.providerToolSnapshotAuthoritative = true;
  opts.providerNativeToolPrefixCount = providerNativeToolPrefixCount(sendTools);
  return sideQuestionRequestSnapshot({
    provider,
    model: session.model,
    messages: projectSyntheticUserEnvelopes(transcript).messages,
    tools: sendTools,
    opts,
  });
}

function answerText(response) {
  if (response?.toolCalls?.length) return SIDE_QUESTION_TOOL_ATTEMPT;
  const text = typeof response?.content === 'string' ? response.content.trim() : '';
  return text || SIDE_QUESTION_EMPTY_ANSWER;
}

/**
 * Answer `question` from the session's latest provider request. One side
 * question runs per session: a new one aborts the previous, and
 * cancelSideQuestion aborts it. A session without a saved request forks the
 * request its next turn would send. Rejects when the session has no
 * conversation or provider, with the provider's error, or with the cancel
 * reason.
 */
export async function askSideQuestion(sessionId, question) {
  const text = typeof question === 'string' ? question.trim() : '';
  if (!text) throw new TypeError('Side question is empty.');
  const request = sideQuestionRequest(sessionId) || nextMainRequest(sessionId);
  if (!request) throw new Error(SIDE_QUESTION_NO_REQUEST);
  const run = beginSideQuestion(sessionId);
  const startedAt = Date.now();
  // The fork keeps the session id (prompt cache routing) but runs on its own
  // transport scope: no pooled socket, response-chain anchor, turn-state
  // token or provider run of the main session is waited on, read or replaced.
  const transportScope = forkTransportScope(sessionId, 'side');
  try {
    const { messages, opts } = buildSideQuestionRequest(request, text);
    let response;
    try {
      response = await request.provider.send(messages, request.model, request.tools.length ? request.tools : undefined, {
        ...opts,
        transportScope,
        admissionOwner: sessionId,
        signal: run.signal,
      });
    } catch (error) {
      throw run.signal.aborted ? run.signal.reason : error;
    }
    if (run.signal.aborted) throw run.signal.reason;
    const session = request.opts.session;
    if (response?.usage && session?.id) {
      void logSessionLlmUsage({
        session: { ...session, model: request.model },
        usage: response.usage,
        startedAt,
        mode: 'side-question',
      }).catch(() => {});
    }
    return { text: answerText(response) };
  } finally {
    run.end();
    disposeTransportScope(transportScope, request.provider);
  }
}
