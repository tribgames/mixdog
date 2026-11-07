#!/usr/bin/env node
// How a room member's finished turn is read (`apps/desktop/src/main/agent-room-turn.ts` and
// `session-final-answer.ts`): the final answer of a session snapshot, a turn that finished without
// text, its tool summaries, and the words a turn posts. The real TypeScript is bundled with esbuild
// (the private helpers get an export line appended to a copy of the source; no logic changes).
//
//   node benchmarks/rust-core/recorders/record-room-answer.mjs --tree <tree w/ node_modules>
// Output: native/core/fixtures/room-answer/golden.json
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const sandbox = mkdtempSync(join(tmpdir(), 'room-answer-'));
process.env.MIXDOG_DATA_DIR = sandbox;
process.env.MIXDOG_HOME = sandbox;
process.on('exit', () => rmSync(sandbox, { recursive: true, force: true }));
const tree = resolveTree(parseArgs());

const esbuild = await importFrom(tree, 'node_modules/esbuild/lib/main.js');
const main = join(tree, 'apps/desktop/src/main');
const outfile = join(sandbox, 'turn.mjs');
await esbuild.build({
  stdin: {
    contents: `${readFileSync(join(main, 'agent-room-turn.ts'), 'utf8')}\nexport { toolSummaries, emptyFinishedTurn, spokenText };\n`,
    sourcefile: join(main, 'agent-room-turn.ts'),
    resolveDir: main,
    loader: 'ts',
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile,
  logLevel: 'error',
});
const turn = await import(pathToFileURL(outfile).href);
await esbuild.build({
  entryPoints: [join(main, 'session-final-answer.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: join(sandbox, 'final.mjs'),
  logLevel: 'error',
});
const { sessionFinalAnswer } = await import(pathToFileURL(join(sandbox, 'final.mjs')).href);

const assistant = (id, text, extra = {}) => ({ kind: 'assistant', id, text, ...extra });
const done = (id, at, extra = {}) => ({ kind: 'turndone', id, at, status: 'done', ...extra });
const user = (id, at) => ({ kind: 'user', id, at, text: 'hi' });
const tool = (name, result, at, extra = {}) => ({ kind: 'tool', name, result, at, ...extra });
const snap = (items, extra = {}) => ({ busy: false, items, ...extra });

const finalCases = [
  ['no snapshot', null, 5],
  ['busy', snap([], { busy: true }), 5],
  ['streaming tail', snap([], { streamingTail: 'x' }), 5],
  ['start is not a number', snap([done(1, 9, { finalAssistantId: 'a' }), assistant('a', 'ok')]), 'x'],
  ['no items', { busy: false }, 5],
  ['no turndone', snap([user('u', 1), assistant('a', 'ok')]), 5],
  ['done without id', snap([{ kind: 'turndone', at: 9, status: 'done', finalAssistantId: 'a' }, assistant('a', 'ok')]), 5],
  ['done before the start', snap([assistant('a', 'ok'), done(1, 4, { finalAssistantId: 'a' })]), 5],
  ['done at without a number', snap([assistant('a', 'ok'), done(1, '9', { finalAssistantId: 'a' })]), 5],
  ['a newer user prompt after', snap([assistant('a', 'ok'), done(1, 9, { finalAssistantId: 'a' }), user('u', 10)]), 5],
  ['a newer assistant after', snap([assistant('a', 'ok'), done(1, 9, { finalAssistantId: 'a' }), assistant('b', 'more')]), 5],
  ['a tool after is fine', snap([assistant('a', 'ok'), done(1, 9, { finalAssistantId: 'a' }), tool('x', 'r', 10)]), 5],
  ['failed', snap([done(2, 9, { status: 'failed' })]), 5],
  ['cancelled', snap([done(2, 9, { status: 'cancelled', finalAssistantId: 'a' }), assistant('a', 'ok')]), 5],
  ['reacted alone', snap([done(3, 9, { reacted: true })]), 5],
  ['reacted with an answer id', snap([assistant('a', 'ok'), done(3, 9, { reacted: true, finalAssistantId: 'a' })]), 5],
  ['reacted false', snap([done(3, 9, { reacted: false })]), 5],
  ['done without a final id', snap([assistant('a', 'ok'), done(3, 9)]), 5],
  ['another status', snap([assistant('a', 'ok'), done(3, 9, { status: 'weird', finalAssistantId: 'a' })]), 5],
  ['answer missing', snap([done(3, 9, { finalAssistantId: 'a' })]), 5],
  ['answer id on a non-assistant', snap([{ kind: 'tool', id: 'a', name: 'x' }, done(3, 9, { finalAssistantId: 'a' })]), 5],
  ['a turndone between answer and done', snap([assistant('a', 'ok'), done(1, 8), done(3, 9, { finalAssistantId: 'a' })]), 5],
  ['answer streaming', snap([assistant('a', 'ok', { streaming: true }), done(3, 9, { finalAssistantId: 'a' })]), 5],
  ['answer without text', snap([assistant('a', undefined), done(3, 9, { finalAssistantId: 'a' })]), 5],
  ['answer text not a string', snap([assistant('a', 7), done(3, 9, { finalAssistantId: 'a' })]), 5],
  ['answer text blank', snap([assistant('a', '  \n'), done(3, 9, { finalAssistantId: 'a' })]), 5],
  ['answer ok', snap([user('u', 1), assistant('a', ' hello (pass) '), done(3, 9, { finalAssistantId: 'a' })]), 5],
  ['numeric ids', snap([assistant(7, 'ok'), done(8, 9, { finalAssistantId: 7 })]), 5],
  ['the last turndone is the one read', snap([assistant('a', 'old'), done(1, 6, { finalAssistantId: 'a' }), user('u', 7), assistant('b', 'new'), done(2, 9, { finalAssistantId: 'b' })]), 5],
  ['at equals the start', snap([assistant('a', 'ok'), done(1, 5, { finalAssistantId: 'a' })]), 5],
].map(([name, snapshot, startedAt]) => ({ name, snapshot, startedAt, answer: sessionFinalAnswer(snapshot, startedAt) }));

const emptyCases = [
  ['no snapshot', null, 5],
  ['busy', snap([done(1, 9)], { busy: true }), 5],
  ['streaming tail', snap([done(1, 9)], { streamingTail: 'x' }), 5],
  ['no items', { busy: false }, 5],
  ['no turndone', snap([user('u', 1)]), 5],
  ['not done', snap([done(1, 9, { status: 'failed' })]), 5],
  ['at not a number', snap([done(1, '9')]), 5],
  ['before the start', snap([done(1, 4)]), 5],
  ['done is not last', snap([done(1, 9), tool('x', 'r', 10)]), 5],
  ['no answer id: empty turn', snap([user('u', 1), done(1, 9)]), 5],
  ['answer with text', snap([assistant('a', 'words'), done(1, 9, { finalAssistantId: 'a' })]), 5],
  ['answer blank', snap([assistant('a', '  '), done(1, 9, { finalAssistantId: 'a' })]), 5],
  ['answer id on another kind', snap([{ kind: 'tool', id: 'a' }, done(1, 9, { finalAssistantId: 'a' })]), 5],
  ['answer text not a string', snap([assistant('a', 7), done(1, 9, { finalAssistantId: 'a' })]), 5],
  ['answer missing', snap([done(1, 9, { finalAssistantId: 'gone' })]), 5],
  ['the last of two turndones', snap([done(1, 6), done(2, 9)]), 5],
  ['at equals the start', snap([done(1, 5)]), 5],
].map(([name, snapshot, startedAt]) => ({ name, snapshot, startedAt, answer: turn.emptyFinishedTurn(snapshot, startedAt) }));

const long = 'é'.repeat(300) + '😀'.repeat(60);
const toolCases = [
  ['no snapshot', null, 5],
  ['no items', {}, 5],
  ['only the tools after the last user message', snap([tool('old', 'r0', 9), user('u', 1), tool('a', 'r1', 6), assistant('x', 'text'), tool('b', 'r2', 7)]), 5],
  ['no user message at all', snap([tool('a', 'r1', 6), tool('b', 'r2', 7)]), 5],
  ['the last item is the user message', snap([tool('a', 'r1', 6), user('u', 8)]), 5],
  ['older than the start are dropped', snap([user('u', 1), tool('a', 'r', 4), tool('b', 'r', 5), tool('c', 'r', 6)]), 5],
  ['no time counts as the start', snap([user('u', 1), tool('a', 'r', undefined), tool('b', 'r', 0), tool('c', 'r', 'x'), tool('d', 'r', '7')]), 5],
  ['names', snap([user('u', 1), tool(undefined, 'r', 6), tool('', 'r', 6), tool(7, 'r', 6)]), 5],
  ['results', snap([user('u', 1), tool('a', undefined, 6), tool('b', null, 6), tool('c', { a: 1, b: ['x', 2] }, 6), tool('d', 12, 6), tool('e', '', 6), tool('f', false, 6)]), 5],
  ['long results are cut at 400 UTF-16 units', snap([user('u', 1), tool('a', long, 6), tool('b', { text: long }, 6)]), 5],
].map(([name, snapshot, startedAt]) => ({ name, snapshot, startedAt, answer: turn.toolSummaries(snapshot, startedAt) }));

const spokenCases = [];
for (const status of ['done', 'failed', 'cancelled']) {
  for (const text of ['hello', '(pass)', 'Thanks. (pass)', 'hello (PASS)', ' ', '', '(pass) trailing', 'a\n(pass)\n']) {
    for (const waiting of [false, true]) {
      const answer = { id: 1, at: 9, status, text };
      spokenCases.push({ answer, waiting, spoken: turn.spokenText(answer, waiting) });
    }
  }
}

// A result cut at 400 UTF-16 units can end on half an emoji: Node holds a lone surrogate, which a
// JSON file written through an UTF-8 encoder (and the Rust side) carries as U+FFFD, so the golden
// records the answer the way Node's own UTF-8 encoder writes it (`toWellFormed`).
const wellFormed = (value) => {
  if (typeof value === 'string') return value.toWellFormed();
  if (Array.isArray(value)) return value.map(wellFormed);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, each]) => [key, wellFormed(each)]));
  return value;
};

const finalOut = join(FIXTURES_ROOT, 'room-answer');
const out = stageSet(finalOut);
writeJson(join(out, 'golden.json'), wellFormed({
  note: 'what the real 1.4.5 desktop agent-room-turn.ts / session-final-answer.ts answer; `answer: null` is a turn not finished yet',
  finalAnswers: finalCases,
  emptyTurns: emptyCases,
  toolSummaries: toolCases,
  spokenText: spokenCases,
}));
writeSetManifest(out, {
  set: 'room-answer',
  recorder: 'benchmarks/rust-core/recorders/record-room-answer.mjs',
  command: 'node benchmarks/rust-core/recorders/record-room-answer.mjs --tree <tree>',
  extra: { finalAnswers: finalCases.length, emptyTurns: emptyCases.length, toolSummaries: toolCases.length, spokenText: spokenCases.length },
});
commitStage(out, finalOut);
console.log(`final=${finalCases.length} empty=${emptyCases.length} tools=${toolCases.length} spoken=${spokenCases.length}`);
