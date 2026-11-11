#!/usr/bin/env node
// What a 1.4.5 turn keeps when its save fails or its process dies, recorded from Node (`b6f10295a`): a real `askSession` turn against
// a scripted provider (lib/turn-durability-child.mjs), one data dir per case.
//
//  - `save-failure`: every session save fails from the provider's answer on (as `turn-durability.test.mjs:411` arms it). The same
//    process goes on: the next turn is asked while the saves still fail, then again once they land.
//  - `crash-*`: the process is killed (SIGKILL, no exit handler) at one point between the first streamed byte and the record that
//    completes the turn, then a new process opens the same data dir and reads the session as the desktop and the phone read it
//    (`projectStoredTranscript`, which recovers a dead owner's turn checkpoint), twice.
//
// Every step records what a client sees (the projected messages and display items), the durable record's messages and the turn
// checkpoint left on disk. Ids come from a counter and time is virtual (the child), so two runs write the same bytes.
//
//   node benchmarks/rust-core/recorders/record-turn-durability.mjs --tree <exact export of b6f10295a with node_modules> [--only <case>]
//
// Output: native/core/fixtures/turn-durability/golden.json (+ MANIFEST.json).
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const recorder = 'benchmarks/rust-core/recorders/record-turn-durability.mjs';
const child = 'benchmarks/rust-core/recorders/lib/turn-durability-child.mjs';
const CHILD_DEADLINE_MS = 60_000;

const { FIXTURES_ROOT, REPO_ROOT, commitStage, exactProductIdentity, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } = await import('./lib/common.mjs');
const { recorderProvenance } = await import('./lib/provenance.mjs');
const args = parseArgs();
const tree = resolveTree(args);
const identity = exactProductIdentity(tree, NODE_COMMIT);
const scratch = process.env.MIXDOG_RECORDER_SCRATCH;
if (!scratch) throw new Error('MIXDOG_RECORDER_SCRATCH must name a scratch folder (under D:\\mixdog-build)');

const CASES = [
  { name: 'save-failure', crash: false, note: 'every save fails from the answer on; the same process asks the next turn while they fail, then once they land' },
  { name: 'crash-before-write', crash: true, note: 'killed as the turn opens, before anything of it is written (its checkpoint journal not opened)' },
  { name: 'crash-before-output', crash: true, note: 'killed with the first request on the wire, before any output' },
  { name: 'crash-mid-stream', crash: true, note: 'killed after part of the answer streamed and was checkpointed' },
  { name: 'crash-tool-wire', crash: true, note: 'killed after a tool round, with the follow-up request on the wire' },
  { name: 'crash-answer-streamed', crash: true, note: 'the answer streamed and was checkpointed as streamed text; killed before the finished message and its seal (one write) are written' },
  { name: 'crash-sealed-unsaved', crash: true, note: 'the terminal save failed (the sealed turn is in the checkpoint), then killed' },
  { name: 'crash-saved-uncleared', crash: true, note: 'killed after the terminal save landed, before the checkpoint is removed' },
  { name: 'save-failure-tool-rounds', crash: false, note: 'every save fails from the first request on while the turn runs two tool rounds and answers; the next turn is refused, then runs once the saves land' },
  { name: 'fork-held', crash: false, note: "a turn held by a failed save, then forked (the desktop's inheritSession) while the saves fail and after they recover" },
  { name: 'resume-held', crash: true, note: 'a turn held by a failed save, shown to a client resuming it in the owning process, then killed and reopened' },
  { name: 'crash-sensitive', crash: true, note: 'a streamed value is checkpointed, then marked sensitive; the checkpoint is rewritten redacted, then killed: which files of the data hold the value, at the kill and after recovery' },
];
const only = args.get('only');
const selected = only ? CASES.filter((c) => c.name === only) : CASES;
if (!selected.length) throw new Error(`no case named ${only}`);

/** One child process; resolves with its exit, kills it at the deadline. */
function runChild(env, argv) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [join(REPO_ROOT, child), ...argv], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stdout.on('data', () => {});
    proc.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    const deadline = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`${argv[1]} ${argv[2]}: no exit within ${CHILD_DEADLINE_MS} ms\n${stderr}`));
    }, CHILD_DEADLINE_MS);
    proc.on('error', (error) => {
      clearTimeout(deadline);
      reject(error);
    });
    proc.on('exit', (code, signal) => {
      clearTimeout(deadline);
      resolve({ code, signal, stderr });
    });
  });
}

async function record(spec) {
  const sandbox = mkdtempSync(join(scratch, `turn-durability-${spec.name}-`));
  const env = { ...process.env, MIXDOG_SKIP_USER_DATA_BACKUP: '1', MIXDOG_AGENT_TRACE_DISABLE: '1' };
  for (const name of ['MIXDOG_DATA_DIR', 'MIXDOG_HOME', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) {
    env[name] = join(sandbox, name.toLowerCase());
    mkdirSync(env[name], { recursive: true });
  }
  const work = join(sandbox, 'work');
  mkdirSync(work, { recursive: true });
  writeFileSync(join(work, 'x.txt'), 'FILE-SENTINEL\n');
  writeFileSync(join(work, 'y.txt'), 'FILE-SENTINEL\n');
  const out = join(sandbox, 'steps.jsonl');
  writeFileSync(out, '');
  const run = await runChild(env, [tree, spec.name, 'run', out, work]);
  const killed = run.code !== 0;
  if (killed !== spec.crash) throw new Error(`${spec.name}: run exited ${run.code}/${run.signal}\n${run.stderr}`);
  if (spec.crash) {
    const reopen = await runChild(env, [tree, spec.name, 'reopen', out, work]);
    if (reopen.code !== 0) throw new Error(`${spec.name}: reopen exited ${reopen.code}/${reopen.signal}\n${reopen.stderr}`);
  }
  // The session id is the child's counter-made id: the same in every run.
  const steps = readFileSync(out, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  if (spec.crash && !steps.some((s) => s.step === 'killed')) throw new Error(`${spec.name}: the run did not reach its kill point\n${run.stderr}`);
  return { name: spec.name, note: spec.note, crash: spec.crash, steps };
}

const cases = [];
for (const spec of selected) cases.push(await record(spec));
if (only) {
  console.log(JSON.stringify(cases, null, 2));
  process.exit(0);
}
const finalDir = join(FIXTURES_ROOT, 'turn-durability');
const stage = stageSet(finalDir);
writeJson(join(stage, 'golden.json'), { note: 'what a 1.4.5 turn keeps when its save fails or its process dies (askSession, b6f10295a)', cases });
writeSetManifest(stage, {
  set: 'turn-durability',
  recorder,
  command: `node ${recorder} --tree <exact export of ${NODE_COMMIT}>`,
  identity,
  extra: {
    exact: true,
    cases: cases.length,
    // The child is spawned by path, not imported: it is listed as an input.
    ...recorderProvenance(import.meta.url, [child]),
    // What the replay (`mixdog-core` `run_host::turn_durability_replay`) leaves out of each compared step, and why.
    exclusions: [
      'minted ids (message, attempt, session ids, also inside texts) are compared as <id:N> by first appearance: each side mints its own',
      'object member order: not part of a JSON object',
      "view.items: each row's own `id` (finalAssistantId is compared as the position of the row it names) and `expanded`, the client's open/closed state of a tool card",
      'view.messages: the same transcript as view.items, which is compared',
      'disk.messages: the `system` message, the assembled system prompt Node stores and Rust assembles per request',
      "disk on the Rust side: the input row's meta.transcript checkpointId, device and completionVerb and its completion's checkpointId (stamps of Rust's turn/start, outside this change), and the cancel line's meta.turnEnd (the typed fact Node reads from the line's text)",
      'save-failure rows: the end row\'s messageId: in the process that ran the turn Node shows its live end row (turnDoneItem), which names no message; this view is the stored-transcript projection',
      'checkpoint: the 1.4.5 turn-checkpoint file; Rust keeps the same draft in its draft file beside the session log, compared through what the reopened session shows and stores, and (crash-sensitive) through secretFiles: Rust compares whether any file of its data holds the value, as the layouts differ',
      'stage: compared only as busy (non-null) or idle; result and the refusal name: the answer is compared through the rows, the refusal through its code and message',
    ],
  },
});
commitStage(stage, finalDir);
console.log(`cases=${cases.length}`);
process.exit(0);
