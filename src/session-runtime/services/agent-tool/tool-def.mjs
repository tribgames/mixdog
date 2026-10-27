// Static agent-tool descriptor and spawn/route constants.

export const PRESET_ALIASES = new Map([
  ['opus-xhigh', { base: 'opus-high', effort: 'xhigh', id: 'opus-xhigh', name: 'OPUS XHIGH' }],
]);

export const WORKER_INDEX_FILE = 'agent-workers.json';
export const LEAD_WORKER_INDEX_FILE = 'lead-workers.json';

export const ACTIVE_STAGES = new Set([
  'connecting',
  'requesting',
  'streaming',
  'tool_running',
  'running',
  'cancelling',
]);

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
  description:
    'Run scoped agent work as background tasks. spawn/send return task_id immediately. Reuse one tag for one scope for its whole lifetime; give distinct tags only to independent scopes. Never mint a new tag because a session expired or was lost — same-tag spawn respawns it with the full brief. Completion notifications arrive automatically; use status/read only for manual recovery. Close finished agents yourself.',
  inputSchema: {
    type: 'object',
    properties: {
      type: {
        type: 'string',
        enum: ['spawn', 'send', 'list', 'close', 'cancel', 'status', 'read', 'cleanup'],
        description:
          'Required action. New spawn requires agent and one of prompt/message/file; send requires tag and one of prompt/message/file; read/status/close/cancel require task_id or tag; list/cleanup require no target. list shows active agents and running tasks in full; idle/closed agents and finished tasks are counts plus a short latest tail (list with tag=<text> shows matching ones: case-insensitive substring, at most 25 per section).',
      },
      task_id: { type: 'string', description: 'Task ID returned by spawn/send.' },
      agent: {
        type: 'string',
        description: 'Workflow agent id; same-tag reuse can inherit it.',
      },
      tag: {
        type: 'string',
        description:
          'Stable scope handle; never derive a variant by appending a number or suffix. spawn generates one when omitted.',
      },
      prompt: { type: 'string', description: 'Spawn task brief.' },
      message: { type: 'string', description: 'Send follow-up.' },
      file: { type: 'string', description: 'Path to task text; used instead of prompt/message.' },
      cwd: { type: 'string', description: 'Project directory for a new or respawned agent.' },
      context: { type: 'string', description: 'Extra context for the spawn/send turn.' },
      attachments: {
        type: 'array',
        items: { type: 'string' },
        maxItems: 8,
        description:
          "spawn/send: files to attach (images, PDF/Office, text): a conversation attachment's file name or [attachment:id], or a path inside your folders. Produced files come back as paths; forward them by path.",
      },
      model: {
        type: 'string',
        description:
          "Spawn only, and only when the user explicitly names a model: runs this one spawn on it instead of the agent's preset route. Id, display name, or words of it; ambiguous or unknown names fail with candidates. The agent still supplies role and permissions.",
      },
      provider: { type: 'string', description: 'Narrows model to one provider; requires model.' },
      effort: { type: 'string', description: 'Reasoning effort for an explicit model.' },
    },
    required: ['type'],
    additionalProperties: false,
  },
};
