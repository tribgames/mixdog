import { runEagerEntry, createEagerEntry } from '../../../../src/runtime/agent/orchestrator/session/eager-dispatch/entry.mjs';

// What `notifyEarlyResult` hands the host for a settled eager call: the model-visible text, and `isError` only
// when the call threw.
const cases = [
  ['returns text', async () => 'fine'],
  ['returns an error outcome as text', async () => 'Error: path is required'],
  ['returns nothing', async () => undefined],
  ['throws', async () => { throw new Error('boom'); }],
];
const out = [];
for (const [name, run] of cases) {
  const seen = [];
  await runEagerEntry({
    call: { id: 'c1', name: 'read', arguments: {} },
    entry: createEagerEntry({ mutationEpoch: 0 }),
    preceding: [],
    waitForPreceding: async () => null,
    execute: run,
    opts: { onToolResult: (message) => seen.push(message) },
    sessionId: null,
    cwd: '/',
  });
  const { content, isError, toolCallId } = seen[0];
  out.push({ name, content, isError, toolCallId });
}
console.log(JSON.stringify({ source: 'eager-dispatch/entry.mjs notifyEarlyResult', cases: out }, null, 1));
