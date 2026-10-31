// The model-facing `todo` step list. Its description is the only guidance the
// model gets about it: nothing is added to the system prompt or rules.
export const TODO_OPS = Object.freeze(['init', 'start', 'done', 'drop', 'block', 'unblock', 'append', 'rm', 'view']);
export const TODO_STATUSES = Object.freeze(['pending', 'in_progress', 'completed', 'abandoned', 'blocked']);
export const MAX_TODO_ITEMS = 50;
export const MAX_TODO_TEXT_LENGTH = 200;

const itemList = { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: MAX_TODO_ITEMS };

export const TODO_TOOL = Object.freeze({
  name: 'todo',
  title: 'Todo',
  annotations: {
    title: 'Todo',
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
    agentHidden: false,
  },
  description:
    'The step list for this request; the Lead and each agent keep their own. Use it whenever the work has three or more steps or several asks (a delegated brief with several parts counts); skip it only for a single step or a plain answer. Create it before the first real action: init with every ask as its own item, in order, covering investigation through verification. A follow-up that adds to the request: append its asks and any steps you discover; init is for a new, unrelated request and refuses while items are open. An item is named by its outcome in 3-8 words and keeps that exact wording; it is how you refer to it — lost the wording: view, never guess. Keep it current while you work, not at the end: the moment an item is finished and its result is read, mark it done with your next call — never batch completions. The runtime keeps exactly one item in progress; done moves it to the next. Send todo beside your next real tool call; when no real call is due, call it alone rather than skip the update. Waiting on the user, an agent or a shell: block it with a reason; unblock when it can move; done only after reading the result.',
  inputSchema: {
    type: 'object',
    properties: {
      op: { type: 'string', enum: TODO_OPS },
      items: { ...itemList, description: 'init (one default phase) / append: item wordings.' },
      phases: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          properties: { name: { type: 'string' }, items: itemList },
          required: ['name', 'items'],
          additionalProperties: false,
        },
        description: 'init: named phases instead of items.',
      },
      item: { type: 'string', description: 'start/done/drop/block/unblock/rm: exact item wording.' },
      phase: { type: 'string', description: 'append: target phase (default last; new name adds one).' },
      note: { type: 'string', description: 'done: optional one-line evidence.' },
      reason: { type: 'string', description: 'block: what it waits on.' },
    },
    required: ['op'],
    additionalProperties: false,
  },
});
