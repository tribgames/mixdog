// One explorer: the agent loop driven directly with one fixed system prompt
// and the read-only filesystem tools — no session record, rules, skills,
// profile context or persistence.
import { agentLoop } from '../agent/orchestrator/session/agent-loop.mjs';
import { readOnlyFilesystemTools } from '../agent/orchestrator/session/manager/tool-resolution.mjs';
import { sharedPrefixProviderCacheOpts } from '../agent/orchestrator/agent-runtime/cache-strategy.mjs';
import { partialHandoffTextFromSession } from '../agent/orchestrator/agent-runtime/agent-progress-watchdog.mjs';

// Tool-calling responses before the explorer must answer from what it has.
export const EXPLORER_MAX_TOOL_ROUNDS = 10;

export const EXPLORER_SYSTEM_PROMPT = [
  'You explore the working directory read-only to answer one question. You cannot edit, run commands or delegate.',
  '',
  'Search:',
  `- You have ${EXPLORER_MAX_TOOL_ROUNDS} tool rounds: batch independent searches in one turn (parallel calls or array arguments).`,
  "- Search the question's own nouns, and match the subsystem it names, not a similarly named one.",
  '- Locate first, then read only that window.',
  '- A location a tool returned is final; never reconfirm it.',
  '- Before answering, list the parts the question asks about; each needs its own tool-returned `path:line`.',
  '- Cite implementation, not tests, docs or changelogs, unless asked.',
  '- A part without a `path:line`: search again with different terms, or use `code_graph` on a found symbol (definition, callers, writers). Call it missing only after that search, and name what you searched.',
  '- Stop once every part has its location.',
  '',
  'Answer shape, hard limit 1,500 characters, nothing else:',
  '- One short answer line.',
  '- One evidence line per hop of each part (entry, callee, writer, reader), at most 10 lines: `path:line` from tool output, the exact function or symbol name there, a few words.',
  '- No intro, summary, extra locations, notes about unread code or "Open:" lines.',
].join('\n');

// One list for the process: identical schema bytes for every explorer.
const EXPLORER_TOOLS = readOnlyFilesystemTools();
export const EXPLORER_TOOL_NAMES = Object.freeze(EXPLORER_TOOLS.map((tool) => tool.name));

/** Exact provider prefix inputs, for cache-stability checks. */
export function explorerPrefix() {
  return { system: EXPLORER_SYSTEM_PROMPT, tools: EXPLORER_TOOLS };
}

/**
 * Answer `query` on `route` with `provider`. Resolves the answer text (on a
 * salvage-flagged abort, the text written so far); rejects on failure.
 */
export async function runExplorer({ query, route, provider, cwd = null, signal, ownerSessionId = null }) {
  const tools = EXPLORER_TOOLS.slice();
  const messages = [
    { role: 'system', content: EXPLORER_SYSTEM_PROMPT },
    { role: 'user', content: query },
  ];
  // In-memory policy only: the schema allowlist is also the execution
  // allowlist (pre-dispatch-deny.mjs), and the owner ids attribute spend in
  // the usage ledger. No session id, so nothing session-keyed is created.
  const policy = {
    provider: route.provider,
    model: route.model,
    cwd,
    tools,
    schemaAllowedTools: EXPLORER_TOOL_NAMES,
    compaction: { auto: false },
    ownerSessionId,
    parentSessionId: ownerSessionId,
  };
  // Text of the request in flight, for salvage when the deadline cuts it.
  let streamed = '';
  try {
    const response = await agentLoop(provider, messages, route.model, tools, null, cwd, {
      signal,
      session: policy,
      ...(route.effort ? { effort: route.effort } : {}),
      fast: route.fast === true,
      modelParameters: route.modelParameters || {},
      turnLimits: { maxToolRounds: EXPLORER_MAX_TOOL_ROUNDS },
      ...sharedPrefixProviderCacheOpts(route.provider),
      onProviderSendStarted: () => {
        streamed = '';
      },
      onTextDelta: (chunk) => {
        streamed += typeof chunk === 'string' ? chunk : '';
      },
      onTextReset: ({ chars } = {}) => {
        streamed = streamed.slice(0, Math.max(0, streamed.length - (Number(chars) || 0)));
        return true;
      },
    });
    return String(response?.content || '').trim();
  } catch (error) {
    if (signal?.reason?.salvagePartial === true) {
      const partial = [partialHandoffTextFromSession({ messages }, 2), streamed.trim()].filter(Boolean).join('\n\n');
      if (partial) return partial;
    }
    throw error;
  }
}
