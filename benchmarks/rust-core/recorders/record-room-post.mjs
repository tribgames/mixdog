#!/usr/bin/env node
// The room host's side of a member's turn (`apps/desktop/src/main/agent-room-turn.ts`): waiting for
// the member's answer (`pollForAnswer`), posting the failures held (`postFailures`) and posting
// the member's words (`postSpeech`). The real TypeScript is bundled with esbuild (the private
// helpers get an export line appended to a copy of the source; no logic changes) and driven with a
// scripted host that logs every call it takes.
//
//   node benchmarks/rust-core/recorders/record-room-post.mjs --tree <tree w/ node_modules>
// Output: native/core/fixtures/room-post/golden.json
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const sandbox = mkdtempSync(join(tmpdir(), 'room-post-'));
process.env.MIXDOG_DATA_DIR = sandbox;
process.env.MIXDOG_HOME = sandbox;
process.on('exit', () => rmSync(sandbox, { recursive: true, force: true }));
const tree = resolveTree(parseArgs());

const esbuild = await importFrom(tree, 'node_modules/esbuild/lib/main.js');
const main = join(tree, 'apps/desktop/src/main');
const outfile = join(sandbox, 'turn.mjs');
await esbuild.build({
  stdin: {
    contents: `${readFileSync(join(main, 'agent-room-turn.ts'), 'utf8')}\nexport { pollForAnswer, postSpeech };\n`,
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

/** A host that logs what it is asked and answers from the scenario's script. `now` counts up from
 *  1000 and ids are `n1`, `n2`, ... so both sides see the same values. */
function fakeHost(script = {}) {
  const calls = [];
  let clock = 1000;
  let seq = 0;
  let reads = 0;
  return {
    calls,
    host: {
      roomId: 'room01',
      pollMs: 25,
      now: () => (clock += 1),
      newId: () => `n${(seq += 1)}`,
      republish: () => calls.push(['republish']),
      sleep: async (ms) => {
        calls.push(['sleep', ms]);
      },
      log: (line) => calls.push(['log', line]),
      post: async (rows) => {
        calls.push(['post', rows]);
        if (script.postFails) throw new Error(script.postFails);
      },
      readSnapshot: async (sessionId) => {
        calls.push(['readSnapshot', sessionId]);
        const list = script.snapshots ?? [];
        const next = list[Math.min(reads, list.length - 1)];
        reads += 1;
        if (script.onRead) script.onRead(reads);
        if (next && next.throw) throw new Error(next.throw);
        return next ?? null;
      },
    },
  };
}

const assistant = (id, text) => ({ kind: 'assistant', id, text });
const done = (id, at, extra = {}) => ({ kind: 'turndone', id, at, status: 'done', ...extra });
const answered = (at = 2000, text = 'ok') => ({ busy: false, items: [assistant('a', text), done(9, at, { finalAssistantId: 'a' })] });
const busy = (extra = {}) => ({ busy: true, items: [], ...extra });
const newState = (extra = {}) => ({ stop: false, speaking: '', speakingName: '', typingId: '', memberSession: '', approval: null, pending: null, calls: [], waiting: false, failures: [], ...extra });

/** `pollForAnswer`: `halts` maps the n-th check of `halted()` to its outcome. */
async function poll(name, script, { halts = {}, stopAtRead = 0, state = {} } = {}) {
  const { host, calls } = fakeHost({ ...script, onRead: (n) => { if (stopAtRead && n === stopAtRead) st.stop = true; } });
  const st = newState(state);
  let checks = 0;
  const halted = () => {
    checks += 1;
    const outcome = halts[checks];
    calls.push(['halted', checks, outcome ?? null]);
    return outcome ? Promise.resolve(outcome) : null;
  };
  let result;
  try {
    const polled = await turn.pollForAnswer(host, st, 'sess1', 1500, halted);
    result = typeof polled === 'string' ? polled : { answer: polled.answer, snapshot: polled.snapshot };
  } catch (error) {
    result = { threw: error.message };
  }
  return { name, script, halts, stopAtRead, state, result, calls, approval: st.approval };
}

const failuresOf = (list) => list.map(([id, name, reason]) => ({ id, name, reason }));

async function failures(name, held, script = {}) {
  const { host, calls } = fakeHost(script);
  const st = newState({ failures: failuresOf(held) });
  let threw = null;
  try {
    await turn.postFailures(host, st);
  } catch (error) {
    threw = error.message;
  }
  return { name, held, script, threw, calls, left: st.failures };
}

const members = [
  { id: 'bench', name: 'Bench' },
  { id: 'alpha', name: 'Alpha' },
  { id: 'gh', name: 'Git Hub' },
];

async function speech(name, { text, agentId = 'bench', snapshot = null, startedAt = 1500, memberSession = 'sess1', held = [], waiting = true, script = {}, labelled = true }) {
  const { host, calls } = fakeHost(script);
  const st = newState({ memberSession, waiting, failures: failuresOf(held) });
  const room = { name: 'Release room', members: members.map((member) => member.id), cursors: {}, lastSpeaker: undefined, lastAt: undefined };
  const labels = new Map(labelled ? members.map((member) => [member.id, { ...member, route: undefined, description: '' }]) : []);
  const member = labels.get(agentId) ?? { id: agentId, name: agentId, route: undefined, description: '' };
  let result;
  try {
    result = await turn.postSpeech(host, st, room, labels, agentId, member, text, snapshot, startedAt);
  } catch (error) {
    result = { threw: error.message };
  }
  return { name, text, agentId, snapshot, startedAt, memberSession, held, waiting, script, labelled, result, calls, waitingAfter: st.waiting, failuresLeft: st.failures, lastSpeaker: room.lastSpeaker ?? null, lastAt: room.lastAt ?? null };
}

const toolSnap = { busy: false, items: [{ kind: 'user', id: 'u', at: 1 }, { kind: 'tool', name: 'shell', result: 'ok', at: 1600 }, { kind: 'tool', name: 'read', result: { b: 1 }, at: 1700 }] };

const polls = [
  await poll('the first read has the answer', { snapshots: [answered()] }),
  await poll('busy reads first, then the answer', { snapshots: [busy(), busy({ streamingTail: 'x' }), answered()] }),
  await poll('an answer from before the start is not this turn', { snapshots: [answered(1000), answered(2000)] }),
  await poll('an approval card is republished when it changes', { snapshots: [busy({ toolApproval: { id: 'a1' } }), busy({ toolApproval: { id: 'a1' } }), busy({ toolApproval: { id: 'a2' } }), busy({}), answered()] }),
  await poll('an approval the state already shows is not republished', { snapshots: [busy({ toolApproval: { id: 7 } }), answered()] }, { state: { approval: { id: '7' } } }),
  await poll('a finished turn without text is an empty answer', { snapshots: [busy(), { busy: false, items: [{ kind: 'user', id: 'u', at: 1 }, done(5, 2000)] }] }),
  await poll('a stop that lands during a read ends the wait', { snapshots: [busy(), busy(), answered()] }, { stopAtRead: 2 }),
  await poll('a halt before the first read', { snapshots: [answered()] }, { halts: { 1: 'superseded' } }),
  await poll('a halt after two reads', { snapshots: [busy(), busy(), answered()] }, { halts: { 3: 'unavailable' } }),
  await poll('five failed reads in a row then success', { snapshots: [{ throw: 'e1' }, { throw: 'e2' }, { throw: 'e3' }, { throw: 'e4' }, { throw: 'e5' }, answered()] }),
  await poll('failed reads that are not in a row never end the wait', { snapshots: [{ throw: 'e1' }, busy(), { throw: 'e2' }, { throw: 'e3' }, { throw: 'e4' }, { throw: 'e5' }, { throw: 'e6' }, answered()] }),
  await poll('six failed reads in a row end it with the error', { snapshots: [busy(), { throw: 'e1' }, { throw: 'e2' }, { throw: 'e3' }, { throw: 'e4' }, { throw: 'e5' }, { throw: 'e6' }, answered()] }),
  await poll('a null snapshot is not an answer', { snapshots: [null, answered()] }),
];

const failureCases = [
  await failures('nothing held posts nothing', []),
  await failures('one failure', [['alpha', 'Alpha', 'boom']]),
  await failures('names and reasons are listed once, in first-seen order', [['alpha', 'Alpha', 'boom'], ['gh', 'Git Hub', ''], ['bench', 'Alpha', 'boom'], ['x', 'Bench', 'later']]),
  await failures('no reason at all', [['alpha', 'Alpha', ''], ['gh', 'Git Hub', '']]),
  await failures('a post that fails still empties the held list', [['alpha', 'Alpha', 'boom']], { postFails: 'disk full' }),
];

const speechCases = [
  await speech('plain words', { text: 'All good.' }),
  await speech('no member session', { text: 'All good.', memberSession: '' }),
  await speech('a mention of a peer', { text: '@Alpha can you check this?' }),
  await speech('a mention by id', { text: 'thanks @gh' }),
  await speech('a mention of itself or an unknown name stays plain', { text: '@Bench and @Nobody' }),
  await speech('a mention with no label for the peer', { text: 'hey @alpha', labelled: false }),
  await speech('the tools of the turn', { text: 'done', snapshot: toolSnap }),
  await speech('no tool after the start', { text: 'done', snapshot: toolSnap, startedAt: 5000 }),
  await speech('held failures are posted first', { text: 'back', held: [['alpha', 'Alpha', 'boom']] }),
  await speech('not waiting any more', { text: 'plain', waiting: false }),
  await speech('a failing post keeps the user waiting', { text: 'plain', script: { postFails: 'disk full' } }),
  await speech('a failing failures post stops before the speech', { text: 'plain', held: [['alpha', 'Alpha', 'boom']], script: { postFails: 'disk full' } }),
  await speech('a speaker with no label', { text: 'hi', agentId: 'stranger', labelled: false }),
];

const finalOut = join(FIXTURES_ROOT, 'room-post');
const out = stageSet(finalOut);
writeJson(join(out, 'golden.json'), {
  note: 'what the real 1.4.5 desktop agent-room-turn.ts does with a scripted host; `now` counts up from 1000, ids are n1, n2, ...',
  polls,
  failures: failureCases,
  speech: speechCases,
});
writeSetManifest(out, {
  set: 'room-post',
  recorder: 'benchmarks/rust-core/recorders/record-room-post.mjs',
  command: 'node benchmarks/rust-core/recorders/record-room-post.mjs --tree <tree>',
  extra: { polls: polls.length, failures: failureCases.length, speech: speechCases.length },
});
commitStage(out, finalOut);
console.log(`polls=${polls.length} failures=${failureCases.length} speech=${speechCases.length}`);
