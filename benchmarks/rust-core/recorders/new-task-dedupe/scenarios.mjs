// The scenarios of the new-task dedupe (`submitNewTask`), one list for the Node recording (record.mjs) and the core's replay
// (replay.mjs): the same steps, so the two are compared step by step. A step is one client action; `submit` names a content, the
// content names what the renderer sends (`prompt`, `options` without the id, `draft`).
//
//   submit      one `submitNewTask(prompt, {...options, id}, draft)`
//   together    several submits started at once (their replies in the order they were started)
//   crash       a submit whose process ends at a gate (`at`: reserved | configured | submitted), then the process restarts over
//               the same data directory; its reply is the lost one
//   restart     the process ends cleanly and starts again over the same data directory
//   seed        a file written into the receipts folder before the next step (`receipt`: a file's name is sha256(id))
//   obstruct    a directory in place of an id's receipt file, so reading it is an I/O error

export const CONTENTS = {
  c1: { prompt: 'write the quarterly report', options: { displayText: 'write the quarterly report' }, draft: { route: { provider: 'openai', model: 'gpt-5' } } },
  c2: { prompt: 'write the annual report', options: { displayText: 'write the annual report' }, draft: { route: { provider: 'openai', model: 'gpt-5-mini' } } },
  // A draft the session refuses before anything is sent (the draft's route names a provider that does not exist).
  refused: {
    prompt: 'write the quarterly report',
    options: { displayText: 'write the quarterly report' },
    draft: { route: { provider: 'no-such-provider', model: 'no-such-model' } },
  },
};

const submit = (id, content) => ({ op: 'submit', id, content });
const crash = (id, content, at) => ({ op: 'crash', id, content, at });

/** Bytes written into the receipts folder as the file of an id, for the corrupt-receipt scenarios. */
/** A step's reply as the caller received it, the same way on both sides: an answer whole with `ok: true`, a rejection as its message and every own
 *  field of the error (`code`, `data`, ...). */
export const asReceived = {
  answer: (result) => ({ ok: true, ...result }),
  rejection: (error) => ({ ok: false, error: String(error?.message ?? error), ...(error && typeof error === 'object' ? { ...error } : {}) }),
};

export const CORRUPT = {
  empty: '',
  'nul-filled': '\u0000'.repeat(64),
  truncated: '{"signature":"abc","sessionId":"sess_desktop_x","pha',
  oversized: JSON.stringify({ signature: 'a'.repeat(5000), sessionId: 'sess_desktop_x', phase: 'accepted' }),
  'wrong-phase': JSON.stringify({ signature: 'abc', sessionId: 'sess_desktop_x', phase: 'done' }),
  'wrong-session-id': JSON.stringify({ signature: 'abc', sessionId: 'not a session id', phase: 'accepted' }),
  'wrong-signature': JSON.stringify({ signature: 7, sessionId: 'sess_desktop_x', phase: 'accepted' }),
  array: '[]',
  'json-null': 'null',
};

/** How the replay compares a scenario with its recording (written into the fixture's manifest by the recorder): whole, by subtraction. */
export const COMPARISON = {
  method:
    "each scenario whole: its `steps`, and for every recorded step everything in the recording except the paths of `notCompared`; the core's side is built as `translated` states, and both sides are normalised only as `normalised` states",
  notCompared: {
    'recorded[].daemonCalls':
      "Node's calls from the desktop host to its daemon client inside one request (create, configure, submit, unsubscribe, read; the daemon is a model, leg.mjs): the core runs these steps inside its own `thread/start` with no wire between them. What they do is compared through `sessions` (a session made, given its prompt, or removed again) and `receipts`",
    'recorded[].reply.snapshot':
      "Node's answer carries the session snapshot its daemon returned (session-host-lifecycle.ts:922,951: the leg's daemon model, leg.mjs `full`, with the host's remote fields): the recording has no real one. The core's answer has no snapshot (its session state travels on the subscription's feed)",
  },
  /** Paths of the core's answer (each step's `reply`, every element of a `together` reply) that Node's answer has no counterpart for; every other path of the core's answer is compared. */
  coreNotCompared: {
    'reply.subscription': "the core's subscription to the session's feed (`thread/start` subscribes its caller); Node's host keeps its feed inside the process",
    'reply.thread.activityAt': "the core's thread summary (`thread/start`'s `thread`), whose Node counterpart is the snapshot the recording does not hold (see `notCompared`)",
    'reply.thread.classification': 'as `reply.thread.activityAt`',
    'reply.thread.compactCount': 'as `reply.thread.activityAt`',
    'reply.thread.createdAt': 'as `reply.thread.activityAt`',
    'reply.thread.cwd': 'as `reply.thread.activityAt`',
    'reply.thread.messageCount': 'as `reply.thread.activityAt`',
    'reply.thread.preview': 'as `reply.thread.activityAt`',
    'reply.thread.projectPath': 'as `reply.thread.activityAt`',
    'reply.thread.title': 'as `reply.thread.activityAt`',
    'reply.thread.updatedAt': 'as `reply.thread.activityAt`',
    'reply.turn': "the first turn the attempt started (`thread/start`'s `turn`); Node's turn starts in its daemon's `submit`, a model in the recording, whose answer the recording does not hold",
  },
  translated: {
    'recorded[].step': 'the step the replay drives (scenarios.mjs), the same list the recording ran',
    'recorded[].reply':
      "`submitNewTask` through the desktop's service lane (service-route.ts: `thread/start`), as received on both sides (`asReceived`): an answer is compared with `thread.id` as `sessionId` and `accepted: true` (the core answers only a started task, Node's `accepted` answer), less the paths of `coreNotCompared`; a rejection is its message and every own field of the error on both sides; a crash step's reply is `{crashed: at}` on both sides",
    'recorded[].receipts': 'the files of `<userdata>/new-task-receipts`, by name, byte for byte (latin1), as the recorder reads them',
    'recorded[].sessions':
      "every thread `thread/list` lists, with `prompts` = its `userMessage` items (`thread/items/list`) and `reserved` = no prompt yet (Node's daemon model sets `reserved` false exactly when it records a prompt, leg.mjs `submit`, and removes a reserved session without one on `unsubscribe`)",
  },
  normalised: {
    'fresh session address': 'numbered `<fresh:N>` by first appearance in the scenario on both sides (see `random`)',
    'thread.id': "the core's session address in `thread.id` is the reply's `sessionId` (see `translated`)",
    'key order': 'objects are compared without regard to key order (the recording is written with sorted keys); arrays in order',
  },
};

export const SCENARIOS = [
  { name: 'first-submit', steps: [submit('s-first', 'c1')] },
  // A reply lost after the receipt went to each phase: the client sends the same request again.
  { name: 'retry-after-reserved', steps: [crash('s-reserved', 'c1', 'reserved'), submit('s-reserved', 'c1')] },
  { name: 'retry-after-configured', steps: [crash('s-configured', 'c1', 'configured'), submit('s-configured', 'c1')] },
  { name: 'retry-after-submitted', steps: [crash('s-submitted', 'c1', 'submitted'), submit('s-submitted', 'c1')] },
  { name: 'retry-after-accepted', steps: [submit('s-accepted', 'c1'), submit('s-accepted', 'c1'), { op: 'restart' }, submit('s-accepted', 'c1')] },
  // Other content under a used id.
  { name: 'changed-content-after-accepted', steps: [submit('s-changed', 'c1'), submit('s-changed', 'c2'), submit('s-changed', 'c1')] },
  { name: 'changed-content-after-reserved', steps: [crash('s-changed-r', 'c1', 'reserved'), submit('s-changed-r', 'c2'), submit('s-changed-r', 'c1')] },
  { name: 'changed-content-after-configured', steps: [crash('s-changed-c', 'c1', 'configured'), submit('s-changed-c', 'c2'), submit('s-changed-c', 'c1')] },
  // A refused attempt frees the id for other content, on a fresh address; the same content resumes the refusal's address.
  { name: 'refusal-then-other-content', steps: [submit('s-refused', 'refused'), submit('s-refused', 'c2'), submit('s-refused', 'c2')] },
  { name: 'refusal-then-same-content', steps: [submit('s-refused-same', 'refused'), submit('s-refused-same', 'refused')] },
  { name: 'refusal-twice-then-other-content', steps: [submit('s-refused-twice', 'refused'), submit('s-refused-twice', 'refused'), submit('s-refused-twice', 'c1')] },
  // Two identical requests at once, and two with other content at once.
  { name: 'identical-at-once', steps: [{ op: 'together', calls: [submit('s-once', 'c1'), submit('s-once', 'c1')] }, submit('s-once', 'c1')] },
  { name: 'different-content-at-once', steps: [{ op: 'together', calls: [submit('s-both', 'c1'), submit('s-both', 'c2')] }, submit('s-both', 'c1')] },
  // A crash, then the restarted process serves a request that comes in twice at once.
  { name: 'crash-then-identical-at-once', steps: [crash('s-crash-once', 'c1', 'configured'), { op: 'together', calls: [submit('s-crash-once', 'c1'), submit('s-crash-once', 'c1')] }] },
  // A file in the receipts folder that is no receipt binds nothing.
  ...Object.keys(CORRUPT).map((shape) => ({ name: `corrupt-${shape}`, steps: [{ op: 'seed', id: `s-corrupt-${shape}`, shape }, submit(`s-corrupt-${shape}`, 'c1'), submit(`s-corrupt-${shape}`, 'c1')] })),
  { name: 'io-error', steps: [{ op: 'obstruct', id: 's-io' }, submit('s-io', 'c1')] },
];
