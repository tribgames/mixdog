import { isQueuedEntryEditable } from '../../../../src/tui/session/queue-helpers.mjs';

const entries = [
  {},
  { mode: 'prompt' },
  { mode: 'steer' },
  { mode: 'task-notification' },
  { mode: 'pending-resume' },
  { mode: 'goal-continuation' },
  { mode: 'goal-closeout' },
  { mode: 'prompt', isMeta: true },
  { mode: 'prompt', isMeta: false },
];
console.log(JSON.stringify({ source: 'queue-helpers.mjs isQueuedEntryEditable', cases: entries.map((entry) => ({ entry, editable: isQueuedEntryEditable(entry) })) }, null, 1));
