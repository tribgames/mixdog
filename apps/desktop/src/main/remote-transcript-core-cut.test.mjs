// A tool row the core cut for the phone (`toolOutput`) shows the card facts of its whole output: summaries (line counts), failures and
// the rest, as the facts the whole row gives. The core's cut is stood in for here by its rule (the first lines, at most the characters,
// with the whole output's line counts said on the row, `mixdog-app-server-transport` `tool_output_cut.rs`).
import assert from 'node:assert/strict';
import test from 'node:test';

import { toolOutputFacts } from '../renderer/transcript-tool-model.ts';
import { remoteTranscriptRow } from './remote-transcript.ts';

const SHOWN = { chars: 600, lines: 5 };
const COMMANDS = new Set(['shell', 'bash', 'bash_session', 'shell_command']);

function coreCut(row) {
  const whole = row.result;
  const lines = SHOWN.lines + (COMMANDS.has(row.name) ? 1 : 0);
  const segments = whole.split('\n');
  let kept = segments.slice(0, lines).join('\n').slice(0, SHOWN.chars);
  if (kept.length >= whole.length) return row;
  if (kept.length === whole.length) kept = whole;
  return {
    ...row,
    result: kept,
    rawResult: kept,
    remoteOutputTruncated: whole.length,
    remoteOutputOnRequest: true,
    remoteOutputStats: { lines: whole.trimEnd().split('\n').length, nonBlankLines: segments.filter((line) => line.trim()).length },
  };
}

const numbered = (count, text) => Array.from({ length: count }, (_, i) => `${i + 1}\t${text(i)}`).join('\n');
const rows = (name, args, result, extra = {}) => ({
  kind: 'tool',
  id: `${name}-1`,
  name,
  args,
  result,
  rawResult: result,
  isError: false,
  startedAt: 1,
  completedAt: 2,
  count: 1,
  completedCount: 1,
  ...extra,
});

const SAMPLES = [
  rows('read', { path: 'src/a.ts' }, numbered(300, (i) => (i === 150 ? 'throw new Error("boom")' : `const value${i} = ${i};`))),
  rows('read', { path: 'notes.md' }, `${'a paragraph of text '.repeat(10)}\n\n`.repeat(40)),
  rows('glob', { pattern: '**/*.ts' }, Array.from({ length: 150 }, (_, i) => `src/dir${i}/file${i}.ts`).join('\n')),
  rows('ls', { path: '.' }, `${Array.from({ length: 90 }, (_, i) => `entry${i}`).join('\n')}\n`),
  rows('bash', { command: 'cat big.log' }, Array.from({ length: 200 }, (_, i) => `log line ${i}: nothing wrong`).join('\n')),
  rows('bash', { command: 'git status' }, Array.from({ length: 60 }, (_, i) => `\tmodified:   file${i}.ts`).join('\n')),
  rows('read', { path: 'crlf.txt' }, Array.from({ length: 80 }, (_, i) => `line ${i} with a carriage return`).join('\r\n')),
  rows('read', { path: 'lead.txt' }, `\n\n${Array.from({ length: 80 }, (_, i) => `body ${i}`).join('\n')}   \n\n`),
  rows('bash', { command: 'make' }, Array.from({ length: 90 }, (_, i) => (i === 40 ? 'error: something failed here' : `compiling unit ${i}`)).join('\n')),
  rows('shell', { command: 'npm run build' }, `${Array.from({ length: 120 }, (_, i) => `step ${i} ok`).join('\n')}\n`),
];

test('a cut row carries the facts of its whole output: the card reads the same summary either way', () => {
  for (const whole of SAMPLES) {
    const cut = coreCut(whole);
    assert.notEqual(cut, whole, `${whole.name} was cut`);
    const shown = remoteTranscriptRow(cut, true).row;
    assert.deepEqual(toolOutputFacts(shown, 3), toolOutputFacts(whole, 3), `${whole.name}: ${String(whole.args.path ?? whole.args.command ?? whole.args.pattern)}`);
  }
});

test('the facts that the cut text alone would give do differ, so the carried ones are what the card shows', () => {
  const [read] = SAMPLES;
  const cut = coreCut(read);
  assert.notDeepEqual(toolOutputFacts(cut, 3).summary, toolOutputFacts(read, 3).summary);
  assert.equal(toolOutputFacts(remoteTranscriptRow(cut, true).row, 3).summary, '300 lines');
});

// A run of calls the core cut is one card of members: each member keeps what the core said of it, so it offers "Show full output",
// reads the whole row from the core under the core's own id, and shows the facts of its whole output.
import { mergeToolRows, rowOf } from '../../../../packages/protocol-client/src/rows.ts';

const wireCut = (id, whole, live) => {
  const segments = whole.trimEnd().split('\n');
  const kept = whole.split('\n').slice(0, 5).join('\n');
  return {
    type: 'toolCall',
    id,
    name: 'read',
    input: { path: `${id}.ts` },
    output: kept,
    run: { result: kept, ...(live ? { live: true, callId: `call-${id}` } : {}) },
    meta: {
      status: 'completed',
      at: 1,
      ext: {
        remoteOutputTruncated: whole.length,
        remoteOutputOnRequest: true,
        remoteOutputStats: { lines: segments.length, nonBlankLines: segments.filter((line) => line.trim()).length },
        remoteOutputNotes: { result: { kind: 'omitted', at: kept.length, omitted: whole.length - kept.length } },
      },
    },
  };
};
const wholeRead = (id) => numbered(300, (i) => `const ${id}${i} = ${i};`);

for (const live of [false, true]) {
  test(`${live ? 'live' : 'restored'} members of an aggregate keep the core's cut metadata and show their whole output's facts`, () => {
    const wholes = ['a', 'b'].map(wholeRead);
    const rows = mergeToolRows(['a', 'b'].map((id, i) => rowOf(wireCut(id, wholes[i], live))).filter(Boolean));
    const card = rows.find((row) => row.aggregate === true);
    assert.equal(card.toolMembers.length, 2);
    for (const [index, member] of card.toolMembers.entries()) {
      assert.equal(member.remoteOutputTruncated, wholes[index].length, 'the member says its output was cut');
      assert.equal(member.remoteOutputOnRequest, true);
      assert.equal(member.remoteOutputNotes.result.kind, 'omitted');
      assert.equal(member.coreItemId, live ? ['a', 'b'][index] : undefined, 'a live member is read under the core\'s id, not its call\'s');
      const shown = remoteTranscriptRow(card, true).row.toolMembers[index];
      assert.equal(toolOutputFacts(shown, 3).summary, '300 lines', 'the member shows the whole output\'s count, not the cut text\'s');
    }
  });
}

test('what the phone cuts of a row beside what the core cut does not blank the core\'s note', () => {
  const rawResult = `${'raw line\n'.repeat(400)}[exit code: 0]`;
  const row = rows('bash', { command: 'make' }, 'head', {
    rawResult,
    remoteOutputTruncated: 5_000,
    remoteOutputNotes: { result: { kind: 'omitted', at: 4, omitted: 4_996 } },
  });
  const shown = remoteTranscriptRow(row, true).row;
  assert.equal(shown.remoteOutputNotes.result.omitted, 4_996, 'the core\'s note of the result stands');
  assert.equal(shown.remoteOutputNotes.rawResult.kind, 'omitted', 'the note of the raw result is added');
  assert.equal(shown.remoteOutputTruncated, Math.max(5_000, rawResult.length), 'the longest of the two lengths');
});
