// A manual/scheduled/clear compaction runs across event-loop yields and the
// summary provider call while nothing stops a turn from writing the live
// transcript. No message may be lost or reordered by its commit.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-compact-append-'));
process.env.MIXDOG_DATA_DIR = dataDir;
const { runSessionCompaction } = await import('./manager/compaction-runner.mjs');
const { _touchRuntime } = await import('./manager/runtime-liveness.mjs');

test.after(() => rmSync(dataDir, { recursive: true, force: true }));

const SUMMARY = [
  '## Goal',
  '- keep every appended message',
  '',
  '## Constraints & Preferences',
  '- (none)',
  '',
  '## Progress',
  '### Done',
  '- older turns summarized',
  '',
  '### In Progress',
  '- (none)',
  '',
  '### Blocked',
  '- (none)',
  '',
  '## Key Decisions',
  '- (none)',
  '',
  '## Next Steps',
  '- continue',
  '',
  '## Critical Context',
  '- (none)',
  '',
  '## Relevant Files',
  '- (none)',
].join('\n');

const PATHS = {
  summary: 1,
  rules: 100_000_000,
};

// A reference and its concurrent run share an id: the archive path the
// compacted recovery reference names contains it.
function sessionFor(path, tag = path) {
  const messages = [{ role: 'system', content: 'system rules stay exact' }];
  for (let turn = 0; turn < 30; turn += 1) {
    const id = `call-${turn}`;
    messages.push(
      { role: 'user', content: `request ${turn} ${'context '.repeat(400)}` },
      { role: 'assistant', content: '', toolCalls: [{ id, name: 'read', arguments: { path: `file-${turn}.txt` } }] },
      { role: 'tool', toolCallId: id, content: `result ${turn}\n${'line of output\n'.repeat(300)}` },
      { role: 'assistant', content: `answer ${turn} ${'detail '.repeat(400)}` }
    );
  }
  return {
    id: `compact-append-${process.pid}-${tag}`,
    provider: 'anthropic-oauth',
    model: 'fake-model',
    owner: 'agent',
    contextWindow: 100_000,
    compactBoundaryTokens: 100_000,
    messages,
    tools: [],
    compaction: { conversationThresholdTokens: PATHS[path] },
  };
}

// Runs one compaction. `everyTick` appends a finished turn on every
// event-loop turn until it settles (every yield and the provider window);
// `onSend` runs inside the summary provider call.
async function compactWhile(session, { everyTick = false, onSend = null } = {}) {
  const appended = [];
  const append = () => {
    const index = appended.length / 2;
    const turn = [
      { role: 'user', content: `appended request ${index}` },
      { role: 'assistant', content: `appended answer ${index}` },
    ];
    session.messages.push(...turn);
    appended.push(...turn);
    return turn;
  };
  let running = true;
  const tick = () => {
    if (!running) return;
    append();
    setImmediate(tick);
  };
  if (everyTick) setImmediate(tick);
  const provider = {
    name: 'anthropic-oauth',
    async send() {
      onSend?.({ append });
      await new Promise((resolve) => setImmediate(resolve));
      return { content: SUMMARY };
    },
  };
  try {
    const result = await runSessionCompaction(session, {
      mode: 'manual',
      force: true,
      config: {},
      provider,
      model: 'fake-model',
    });
    return { result, appended };
  } finally {
    running = false;
  }
}

for (const path of Object.keys(PATHS)) {
  test(`${path} compaction keeps turns appended during every yield in order after its result`, async () => {
    const reference = sessionFor(path);
    const { result: referenceResult } = await compactWhile(reference);
    assert.equal(referenceResult.changed, true);

    const session = sessionFor(path);
    const { result, appended } = await compactWhile(session, { everyTick: true });
    assert.equal(result.error, undefined);
    assert.equal(result.changed, true);
    assert.ok(appended.length >= 4, `appends landed across yields (${appended.length})`);
    const kept = session.messages.length - appended.length;
    appended.forEach((message, index) => assert.equal(session.messages[kept + index], message));
    assert.deepEqual(session.messages.slice(0, kept), reference.messages);
  });
}

test('a finished turn that replaced the transcript array is kept after the compacted result', async () => {
  const reference = sessionFor('summary', 'replaced');
  await compactWhile(reference);
  const session = sessionFor('summary', 'replaced');
  const turn = [
    { role: 'user', content: 'turn during the summary call' },
    { role: 'assistant', content: 'its answer' },
  ];
  const { result } = await compactWhile(session, {
    onSend: () => {
      session.messages = [...session.messages, ...turn];
    },
  });
  assert.equal(result.changed, true);
  assert.equal(result.afterMessages, reference.messages.length + 2);
  assert.deepEqual(session.messages.slice(0, -2), reference.messages);
  assert.equal(session.messages.at(-2), turn[0]);
  assert.equal(session.messages.at(-1), turn[1]);
});

test('a transcript rewound during the summary call is left as it is', async () => {
  const session = sessionFor('summary', 'rewound');
  let rewound = null;
  const { result } = await compactWhile(session, {
    onSend: () => {
      rewound = session.messages.slice(0, -2);
      session.messages = rewound;
    },
  });
  assert.equal(result.changed, false);
  assert.match(result.error, /changed while compacting/);
  assert.equal(session.messages, rewound);
  assert.equal(session.messages.length, 119);
  assert.equal(session.compaction.lastStage, 'manual_failed');
});

test('a turn still in flight at commit keeps the live transcript untouched', async (t) => {
  const session = sessionFor('summary', 'in-flight');
  const live = session.messages;
  const before = live.slice();
  t.after(() => {
    _touchRuntime(session.id).controller = null;
  });
  let provisional = null;
  const { result } = await compactWhile(session, {
    onSend: ({ append }) => {
      _touchRuntime(session.id).controller = new AbortController();
      provisional = append();
    },
  });
  assert.equal(result.changed, false);
  assert.match(result.error, /changed while compacting/);
  assert.equal(session.messages, live);
  assert.deepEqual(session.messages, [...before, ...provisional]);
});
