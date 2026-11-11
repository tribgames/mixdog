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
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanup, mask, runSessionRecorder } from './lib/session-rec.mjs';

const base = mkdtempSync(join(tmpdir(), 'restart-prefix-'));
const PHASE_DEADLINE_MS = 120_000;
const children = new Set();
process.on('exit', () => { for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });

await runSessionRecorder(import.meta.url, {
  set: 'session-restart-prefix',
  testFile: 'src/runtime/agent/orchestrator/session/restart-prefix-parity.slow.test.mjs',
  entry: 'Spawned the tree\'s src/runtime/agent/orchestrator/session/restart-prefix-parity.fixture.mjs (the test\'s own scenario script) as real child processes: phases idle/killtool/killrequest then resume, each on a fresh MIXDOG_DATA_DIR, killing the kill phases on the READY line (SIGKILL). Inside: real session-lifecycle createSession, ask-session askSession, turn-checkpoint, cache-warm request rebuild, anthropic-oauth buildRequestBody and anthropic-prefix-trace with a scripted provider (the fixture\'s fake send). The fixture\'s own 300 ms checkpoint-settle delay before READY is the product scenario\'s, not the recorder\'s; the recorder waits on READY/exit with a 120 s deadline per phase.',
  replay: 'mixdog-ai warmer chain rearm (warmer/chain_tests.rs op rearm) and the mixdog-agent request builder for anthropic-oauth + the thread restart recovery: replay each scenario\'s turns (scripted provider steps in `script`) over a core restart at the recorded point (idle, in a tool run, request on the wire) and compare every request body block for block (`bodies`), the prefix `changes`, the re-armed `warmBody` (null when killed mid-turn) and the recorded `comparisons`.',
  exclusions: [
    'the temp base dir -> <BASE>; the random session id of each scenario -> <session N>; both applied to every string of the recorded bodies/changes',
    'the per-session scratch directory name in the system prompt (s.<16 hex>) -> s.<scratch>',
    'the system prompt\'s environment block (shell tools present/absent on PATH, git state, cwd entries) is the recording machine\'s and is recorded as it was: a replay supplies the same environment text, it is not a Rust-side value',
    'the kill phases are stopped with SIGKILL when READY is printed; their output file is the one the fixture wrote before READY (bodies and changes of the killed process)',
  ],
}, async ({ tree }) => {
  const fixture = join(tree, 'src/runtime/agent/orchestrator/session/restart-prefix-parity.fixture.mjs');
  const runPhase = (name, phase, extra = [], { killWhenReady = false } = {}) => new Promise((resolve, reject) => {
    const dataDir = join(base, name, 'data');
    mkdirSync(dataDir, { recursive: true });
    const outFile = join(base, name, `${phase}.json`);
    const child = spawn(process.execPath, [fixture, phase, dataDir, outFile, ...extra], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
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

  const sessions = new Map();
  const normalise = (value) => mask(value, [[base, '<BASE>'], [base.replaceAll('\\', '/'), '<BASE>'], [base.replaceAll('\\', '\\\\'), '<BASE>'], ...scenarios.map((s, i) => [s.before.sessionId, `<session ${i + 1}>`])]);
  const out = scenarios.map((s) => JSON.parse(JSON.stringify(normalise(s)).replace(/s\.[0-9a-f]{16}\b/g, 's.<scratch>')));
  const testLines = { idle: [192, 198, 214], killtool: [207, 219], killrequest: [207, 227] };
  const cases = out.map((s) => ({
    name: `restart-${s.name}`,
    testLines: testLines[s.name],
    input: { phases: [s.name, 'resume'], language: 'ko', model: 'claude-opus-5-5', kill: s.beforeKilledOnReady ? 'SIGKILL when READY is printed' : 'none (exits after two turns)' },
    result: { before: s.before, after: s.after, comparisons: s.comparisons },
  }));
  return { cases };
});
cleanup(base);
process.exit(0);
