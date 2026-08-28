// Static agent-tool descriptor + spawn/route constants. Extracted from the
// agent-tool facade as a behavior-preserving split; values are byte-identical
// to the originals.

export const PRESET_ALIASES = new Map([
  ['opus-xhigh', { base: 'opus-high', effort: 'xhigh', id: 'opus-xhigh', name: 'OPUS XHIGH' }],
]);

export const WORKER_INDEX_FILE = 'agent-workers.json';
export const LEAD_WORKER_INDEX_FILE = 'lead-workers.json';

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
    agentHidden: false,
  },
  description: 'Run scoped agent work as background tasks. spawn/send return task_id immediately. Reuse one tag for one scope for its whole lifetime; give distinct tags only to independent scopes. Never mint a new tag because a session expired or was lost — same-tag spawn respawns it with the full brief. Wait for completion notifications; use status/read only for manual recovery.',
  inputSchema: {
    type: 'object',
    properties: {
      type: { type: 'string', enum: ['spawn', 'send', 'list', 'close', 'cancel', 'status', 'read', 'cleanup'], description: 'Required action. New spawn requires agent and one of prompt/message/file; send requires tag and one of prompt/message/file; read/status/close/cancel require task_id or tag; list/cleanup require no target.' },
      task_id: { type: 'string', description: 'Task ID returned by spawn/send; target for read/status/close/cancel.' },
      agent: { type: 'string', description: 'Workflow agent id. Required for a new spawn; same-tag reuse can inherit it.' },
      tag: { type: 'string', description: 'Stable scope handle. Reuse the same tag for the same scope; never derive a variant by appending a number or suffix. send requires it, while spawn can generate one when omitted.' },
      prompt: { type: 'string', description: 'Spawn task brief; also accepted for send.' },
      message: { type: 'string', description: 'Send follow-up; also accepted for spawn.' },
      file: { type: 'string', description: 'Path to task text; alternative to prompt/message for spawn/send.' },
      cwd: { type: 'string', description: 'Project directory for a new or respawned agent.' },
      context: { type: 'string', description: 'Extra context for the spawn/send turn.' },
    },
    required: ['type'],
    additionalProperties: false,
  },
};
