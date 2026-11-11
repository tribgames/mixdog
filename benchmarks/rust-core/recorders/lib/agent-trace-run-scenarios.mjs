// The scripted turns of the run trace recording (record-agent-trace-run.mjs) and its replay on the Rust core
// (replay-agent-trace-run.mjs): one definition, so both sides are given the same model replies, workspace and environment.
// `env` is laid over the process environment of the side that runs the turn (Node's process, the core); MIXDOG_DIAGNOSTICS turns
// the local `history/agent-trace.jsonl` on (`isDiagnosticIOEnabled`, off in ship mode by default).

export const MODEL = 'fake-model';
export const FILES = {
  'a.txt': 'hello\nsecond line\n',
  'b.txt': 'bee\n',
  'c.txt': 'same\nsame\n',
};

const DONE = { text: 'done', calls: [] };
const DIAGNOSTICS = { MIXDOG_DIAGNOSTICS: '1' };

export function scenarios() {
  return [
    {
      // One batch: a read, a read of a missing file, a read of two paths at once (the batch row's array_lengths), a glob (the
      // row's local_search) and a list (the row's integrity).
      name: 'one batch of reads',
      env: DIAGNOSTICS,
      replies: [
        {
          text: 'go',
          calls: [
            { id: 'r1', name: 'read', args: { path: 'a.txt' } },
            { id: 'r2', name: 'read', args: { path: 'missing.txt' } },
            { id: 'r3', name: 'read', args: { path: ['a.txt', 'b.txt'] } },
            { id: 'g1', name: 'glob', args: { pattern: '*.txt' } },
            { id: 'l1', name: 'list', args: { path: '.' } },
          ],
        },
        DONE,
      ],
    },
    {
      // Two batches (two batch ids); the first holds a call that fails (an error tool row and its tool-failures.jsonl row).
      name: 'a failing call, then a second batch',
      env: DIAGNOSTICS,
      replies: [
        {
          text: 'go',
          calls: [
            { id: 'e1', name: 'read', args: {} },
            { id: 'r5', name: 'read', args: { path: 'a.txt', offset: 2 } },
          ],
        },
        { text: 'again', calls: [{ id: 'r4', name: 'read', args: { path: 'b.txt' } }] },
        DONE,
      ],
    },
    {
      // A batch-group edit (one anchor, two distinct replacements, the anchor twice in the file): the first member fails as
      // ambiguous and its retry succeeds, so its tool row carries two execution intervals.
      name: 'an ambiguous edit retried in its batch group',
      env: DIAGNOSTICS,
      replies: [
        { text: 'go', calls: [{ id: 'c0', name: 'read', args: { path: 'c.txt' } }] },
        {
          text: 'edit',
          calls: [
            { id: 'x1', name: 'edit', args: { file_path: 'c.txt', old_string: 'same', new_string: 'one' } },
            { id: 'x2', name: 'edit', args: { file_path: 'c.txt', old_string: 'same', new_string: 'two' } },
          ],
        },
        DONE,
      ],
    },
  ];
}
