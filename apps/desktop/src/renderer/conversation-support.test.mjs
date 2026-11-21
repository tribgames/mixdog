import assert from 'node:assert/strict';
import test from 'node:test';

import { toolActivityParts } from './conversation-support.tsx';

const answered = 'User has answered your questions: "Q?"="A". You can now continue with these answers in mind.';

test('an answered question stands between the calls made before and after it', () => {
  const read = { kind: 'tool', id: 'read', name: 'read', args: {}, result: 'ok' };
  const ask = { kind: 'tool', id: 'ask', name: 'ask_user', args: { questions: [] }, result: answered };
  const shell = { kind: 'tool', id: 'shell', name: 'shell', args: { command: 'ls' }, result: 'ok' };
  assert.deepEqual(toolActivityParts([read, ask, shell], false), [
    { tools: [read] },
    { asked: ask },
    { tools: [shell] },
  ]);
  const waiting = { kind: 'tool', id: 'wait', name: 'ask_user', args: { questions: [] } };
  assert.deepEqual(toolActivityParts([read, waiting, shell], true), [
    { tools: [read] },
    { waiting: true },
    { tools: [shell] },
  ]);
  assert.deepEqual(toolActivityParts([read, shell], true), [{ tools: [read, shell] }]);
});

test('an answered question inside a roll-up stands between the members before and after it', () => {
  const plan = (id) => ({ kind: 'tool', id, name: 'update_plan', args: {}, result: 'ok', count: 1, completedCount: 1 });
  const ask = { kind: 'tool', id: 'ask', name: 'ask_user', args: { questions: [] }, result: answered, completedCount: 1 };
  const aggregate = {
    kind: 'tool',
    id: 'g',
    aggregate: true,
    count: 3,
    completedCount: 3,
    toolMembers: [plan('p1'), ask, plan('p2')],
  };
  const parts = toolActivityParts([aggregate], false);
  assert.deepEqual(
    parts.map((part) => (part.tools ? part.tools.flatMap((item) => item.toolMembers.map((m) => m.id)) : part.asked.id)),
    [['p1'], 'ask', ['p2']]
  );
  assert.deepEqual(
    parts.filter((part) => part.tools).map((part) => [part.tools[0].id, part.tools[0].count, part.tools[0].completedCount]),
    [
      ['g', 1, 1],
      ['g:1', 1, 1],
    ]
  );
});
