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
