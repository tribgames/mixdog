// Static agent-tool descriptor + spawn/route constants. Extracted from the
// agent-tool facade as a behavior-preserving split; values are byte-identical
// to the originals.

export const PRESET_ALIASES = new Map([
  ['opus-xhigh', { base: 'opus-high', effort: 'xhigh', id: 'opus-xhigh', name: 'OPUS XHIGH' }],
]);

export const DEFAULT_AGENT_PRESETS = Object.freeze({
  explore: 'sonnet-high',
  maintainer: 'haiku',
  worker: 'sonnet-high',
  'heavy-worker': 'sonnet-high',
  reviewer: 'opus-xhigh',
  debugger: 'opus-xhigh',
});

// Mirrors DEFAULT_PROVIDER in mixdog-session-runtime.mjs. Used only as the
// last-resort fallback when a stored agent route omits its provider and the
// config carries no defaultProvider.
export const DEFAULT_PROVIDER = 'anthropic-oauth';

export const WORKER_INDEX_FILE = 'agent-workers.json';

export const ACTIVE_STAGES = new Set(['connecting', 'requesting', 'streaming', 'tool_running', 'running', 'cancelling']);

export const AGENT_TOOL = {
  name: 'agent',
  title: 'Agent',
  annotations: {
    title: 'Agent',
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
    agentHidden: true,
  },
  description: 'Delegate scoped work; handoffs always start background tasks (task ids return immediately). Distinct tags for independent scopes; spawn/send with the same tag reuses the live session for the same scope. Wait for the completion notification; do not call status/read after spawn (manual recovery only).',
  inputSchema: {
    type: 'object',
    properties: {
      type: { type: 'string', enum: ['spawn', 'send', 'list', 'close', 'cancel', 'status', 'read', 'cleanup'], description: 'Action. Default spawn.' },
      task_id: { type: 'string', description: 'Manual recovery task ID. Required for read/status.' },
      agent: { type: 'string', description: 'Workflow agent id.' },
      tag: { type: 'string', description: 'Stable scope handle. Reuse the same tag for follow-up on the same scope; use distinct tags only for independent scopes.' },
      sessionId: { type: 'string', description: 'Raw sess_ id.' },
      prompt: { type: 'string', description: 'Scoped task brief.' },
      message: { type: 'string', description: 'Follow-up for send/reuse, or brief.' },
      file: { type: 'string', description: 'Prompt file.' },
      cwd: { type: 'string', description: 'Working directory.' },
      context: { type: 'string', description: 'Extra agent context.' },
    },
    additionalProperties: true,
  },
};
