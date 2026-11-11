#!/usr/bin/env node
// Golden twin of `src/runtime/agent/orchestrator/session/restart-prefix-parity.slow.test.mjs`: the prompt cache across
// a process restart. The product's own scenario script (`restart-prefix-parity.fixture.mjs`, run unchanged, one real
// child process per phase) drives a scripted anthropic-oauth session through the real session manager (`createSession`,
// `askSession`, the turn checkpoint, the cache-warm request rebuild, the Anthropic request builder). Scenarios:
//   idle         two complete turns, exit; then `resume` (the restarted process: warm re-arm + one turn)
//   killtool     killed in a tool run of the second turn (after READY); then `resume`
//   killrequest  killed with the second request on the wire (after READY); then `resume`
// The child's output file (every request body the builder made, the prefix-trace `changes`, the re-armed warm body)
// is recorded whole; the per-case prefix comparisons the test asserts are recorded next to them (computed here with
// the test's block-walk, so a replay can compare both).
//
//   node benchmarks/rust-core/recorders/record-session-restart-prefix.mjs --tree <dir>
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildPatchedTree } from './lib/patched-tree.mjs';
import { cleanup, runSessionRecorder } from './lib/session-rec.mjs';

const PATCH = 'benchmarks/rust-core/recorders/patches/node-fix-restart-prefix-settle.patch';
const PRELOAD = 'benchmarks/rust-core/recorders/lib/determinism-preload.mjs';
// A fixed base dir (the scenarios' data and work dirs live under it), so the paths in the requests repeat; it is under this
// machine's temp dir, so those paths are the recording machine's and are an explicit input (see environment).
const base = join(tmpdir(), 'rec-restart-prefix');
rmSync(base, { recursive: true, force: true });
mkdirSync(base, { recursive: true });
const PHASE_DEADLINE_MS = 120_000;
const children = new Set();
process.on('exit', () => { for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });

await runSessionRecorder(import.meta.url, {
  set: 'session-restart-prefix',
  testFile: 'src/runtime/agent/orchestrator/session/restart-prefix-parity.slow.test.mjs',
  dataFiles: [PATCH, PRELOAD],
  patch: { file: PATCH, applied: 'to a temporary copy of the tree\'s src (restart-prefix-parity.fixture.mjs only)', fixes: 'the scenario script slept 300 ms between two settleTurnCheckpointWrites calls before printing READY; the sleep is dropped, the first settle (the journal write lane idle, true) is the event it waited for' },
  entry: 'Spawned the patched copy of the tree\'s src/runtime/agent/orchestrator/session/restart-prefix-parity.fixture.mjs (the test\'s own scenario script, minus its 300 ms sleep: see patch) with node --import lib/determinism-preload.mjs as real child processes: phases idle/killtool/killrequest then resume, each on a fresh MIXDOG_DATA_DIR, killing the kill phases on the READY line (SIGKILL). Inside: real session-lifecycle createSession, ask-session askSession, turn-checkpoint, cache-warm request rebuild, anthropic-oauth buildRequestBody and anthropic-prefix-trace with a scripted provider (the fixture\'s fake send). The recorder waits on the READY line / the child\'s exit with a 120 s deadline per phase.',
  replay: 'The Rust core\'s restart path is the thread/resume + turn/start protocol (native/core/crates/mixdog-app-protocol methods.rs: thread/resume, turn/start, turn/interrupt) over mixdog-core-session recovery and the Anthropic request builder (mixdog-ai, the anthropic-oauth request body); the cache warmer is native/core/crates/mixdog-ai warmer (chain_tests.rs op rearm). Replay each scenario with the scripted provider steps (the script of the fixture: toolStep/textStep), restart the core at the recorded point (idle, in a tool run, request on the wire), and compare every request body block for block (odies), the prefix changes, the re-armed warmBody (null when killed mid-turn) and comparisons (derived by the test\'s own block walk). nvironment is an input: the system prompt\'s machine-derived environment text (cwd, shell tools, git state, cwd entries) as the recording machine produced it; the replay injects that text verbatim into the system prompt instead of computing its own.',
  values: 'exact (benchmarks/rust-core/recorders/lib/exact.mjs) for the recorder\'s own values; the child\'s output file is JSON the product script wrote (request bodies are already JSON), recorded as parsed',
  exclusions: [
    'no value of the requests is normalised. The child processes run with crypto.randomUUID/randomBytes as counters, Date.now() = 1700000000000 and process.pid = 4242 (lib/determinism-preload.mjs), so session ids, scratch directory names and stamps repeat',
    'the system prompt\'s environment block (cwd under the fixed base dir in the OS temp dir, shell tools present/absent on PATH, git state, cwd entries) is the recording machine\'s: it is recorded as it was, and extracted whole into each case\'s input.environment for the replay to inject verbatim',
    'the kill phases are stopped with SIGKILL when READY is printed; their output file is the one the fixture wrote before READY (bodies and changes of the killed process)',
  ],
}, async ({ tree }) => {
  const patched = buildPatchedTree(tree, join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', PATCH));
  const fixture = join(patched, 'src/runtime/agent/orchestrator/session/restart-prefix-parity.fixture.mjs');
  const preload = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), 'lib', 'determinism-preload.mjs')).href;
  const runPhase = (name, phase, extra = [], { killWhenReady = false } = {}) => new Promise((resolve, reject) => {
    const dataDir = join(base, name, 'data');
    mkdirSync(dataDir, { recursive: true });
    const outFile = join(base, name, `${phase}.json`);
    const child = spawn(process.execPath, ['--import', preload, fixture, phase, dataDir, outFile, ...extra], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    children.add(child);
    let stderr = '';
    let pending = '';
    let ready = false;
    let failure = null;
    const deadline = setTimeout(() => { failure ??= new Error(`${name}/${phase} passed its ${PHASE_DEADLINE_MS} ms deadline: ${stderr.slice(-2000)}`); child.kill('SIGKILL'); }, PHASE_DEADLINE_MS);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      pending += chunk;
      for (let end = pending.indexOf('\n'); end >= 0; end = pending.indexOf('\n')) {
        const line = pending.slice(0, end).replace(/\r$/, '');
        pending = pending.slice(end + 1);
        if (killWhenReady && line === 'READY' && !ready) { ready = true; child.kill('SIGKILL'); }
      }
    });
    child.once('error', (error) => { failure ??= error; });
    child.once('close', (code, signal) => {
      clearTimeout(deadline);
      children.delete(child);
      if (failure) return reject(failure);
      if (killWhenReady && !ready) return reject(new Error(`${name}/${phase} exited before READY: ${stderr.slice(-2000)}`));
      if (!killWhenReady && code !== 0) return reject(new Error(`${name}/${phase} exited ${code ?? signal}: ${stderr.slice(-2000)}`));
      resolve({ output: JSON.parse(readFileSync(outFile, 'utf8')), killed: killWhenReady });
    });
  });

  // The test's block walk, to record the comparisons it asserts.
  const withoutMarker = (block) => { if (!block || typeof block !== 'object') return block; const { cache_control: _m, ...rest } = block; return rest; };
  const wireBlocks = (body) => {
    const out = [['tools', JSON.stringify(body.tools || []), false]];
    for (const [index, block] of (body.system || []).entries()) out.push([`system[${index}]`, JSON.stringify(withoutMarker(block)), !!block?.cache_control]);
    out.push(['thinking/output_config', JSON.stringify({ thinking: body.thinking ?? null, output_config: body.output_config ?? null }), false]);
    for (const [index, message] of (body.messages || []).entries()) {
      const content = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content;
      const head = { role: message.role, ...(message.clear_at ? { clear_at: message.clear_at } : {}) };
      for (const [blockIndex, block] of content.entries()) out.push([`messages[${index}](${message.role})[${blockIndex}]`, JSON.stringify({ ...head, block: withoutMarker(block) }), !!block?.cache_control]);
    }
    return out;
  };
  const prefixDiff = (previous, next) => {
    const before = wireBlocks(previous);
    const after = wireBlocks(next);
    let index = 0;
    while (index < before.length && index < after.length && before[index][1] === after[index][1]) index += 1;
    const breakpoints = before.flatMap(([label, , marked], at) => (marked ? [{ label, at }] : []));
    return {
      firstDiff: index < before.length ? before[index][0] : null,
      previousBlock: before[index]?.[1] ?? null,
      nextBlock: after[index]?.[1] ?? null,
      lastBreakpoint: breakpoints.at(-1)?.label ?? null,
      lostBreakpoints: breakpoints.filter(({ at }) => at >= index).map(({ label }) => label),
    };
  };

  const scenarios = [];
  for (const [name, phase, killWhenReady] of [['idle', 'idle', false], ['killtool', 'killtool', true], ['killrequest', 'killrequest', true]]) {
    const before = await runPhase(name, phase, [], { killWhenReady });
    const after = await runPhase(name, 'resume', [before.output.sessionId]);
    const comparisons = { lastSentVsFirstAfterRestart: prefixDiff(before.output.bodies.at(-1), after.output.bodies[0]) };
    if (name === 'idle' && after.output.warmBody) {
      comparisons.lastSentVsWarmReplay = prefixDiff(before.output.bodies.at(-1), after.output.warmBody);
      comparisons.warmVsFirstAfterRestart = prefixDiff(after.output.warmBody, after.output.bodies[0]);
    }
    scenarios.push({ name, before: before.output, beforeKilledOnReady: before.killed, after: after.output, comparisons });
  }

  rmSync(patched, { recursive: true, force: true });
  // The environment block: the system block of the first request that holds the machine-derived startup facts.
  const environmentOf = (body) => (body.system || []).map((block) => block.text).find((text) => typeof text === 'string' && text.includes('Shell tools at startup')) ?? null;
  const testLines = { idle: [192, 198, 214], killtool: [207, 219], killrequest: [207, 227] };
  const cases = scenarios.map((s) => ({
    name: `restart-${s.name}`,
    testLines: testLines[s.name],
    input: { phases: [s.name, 'resume'], language: 'ko', model: 'claude-opus-5-5', kill: s.beforeKilledOnReady ? 'SIGKILL when READY is printed' : 'none (exits after two turns)', environment: environmentOf(s.before.bodies[0]) },
    result: { before: s.before, after: s.after, comparisons: s.comparisons },
  }));
  return { cases };
});
cleanup(base);
process.exit(0);
