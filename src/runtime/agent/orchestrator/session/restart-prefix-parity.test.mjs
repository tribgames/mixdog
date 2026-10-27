// The prompt cache across a process restart: the first request a restarted
// process sends for a session must repeat, block for block, the request the
// previous process sent last — tools, every system block, the thinking
// parameters and the messages — up to that request's last cache_control
// breakpoint, or the provider rewrites the whole prefix. Each phase runs in
// its own process (restart-prefix-parity.fixture.mjs): the process that sent
// the request is gone, and the next one has only the data dir.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { makeTempDirSync } from '../../../../../scripts/lib/scoped-temp.mjs';

const FIXTURE = fileURLToPath(new URL('./restart-prefix-parity.fixture.mjs', import.meta.url));
const root = makeTempDirSync('restart-prefix-parity');
// One phase starts a fresh runtime and runs at most two scripted turns; a
// phase still running after this has hung, and is killed.
const PHASE_DEADLINE_MS = 120_000;

// Every fixture process still running: `{ child, exited }`, `exited`
// resolving once the process is gone and its stdio closed.
const running = new Set();
const isAlive = (child) => child.exitCode === null && child.signalCode === null;
function stopPhase(entry) {
  if (isAlive(entry.child)) entry.child.kill('SIGKILL');
  return entry.exited;
}

// The temp root goes only after every fixture process that could still write
// into it has been killed and has exited.
test.after(async () => {
  await Promise.all([...running].map(stopPhase));
  rmSync(root, { recursive: true, force: true });
});
// Last resort when the run ends without the hook (a forced exit): kill what
// is left; the removal is best effort while a killed process lets go.
process.on('exit', () => {
  for (const { child } of running) if (isAlive(child)) child.kill('SIGKILL');
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* scoped temp; the next run's allocator never reuses it */
  }
});

/**
 * Runs one fixture phase to its exit and resolves its output file. With
 * `killWhenReady` the phase is killed once it prints the line `READY` (the
 * process dies mid-turn) and must have printed it. A phase past its deadline,
 * or cancelled through `signal`, is killed and awaited before this rejects.
 */
function runPhase(name, phase, extra = [], { killWhenReady = false, signal } = {}) {
  const dataDir = join(root, name, 'data');
  mkdirSync(dataDir, { recursive: true });
  const outFile = join(root, name, `${phase}.json`);
  const child = spawn(process.execPath, [FIXTURE, phase, dataDir, outFile, ...extra], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let failure = null;
  let ready = false;
  let stderr = '';
  let pending = '';
  const exited = new Promise((resolve) => {
    child.once('close', (code, exitSignal) => resolve({ code, exitSignal }));
    // A process that never started has no close to wait for.
    child.once('error', (error) => {
      failure ??= error;
      if (child.pid === undefined) resolve({ code: null, exitSignal: null });
      else child.kill('SIGKILL');
    });
  });
  const entry = { child, exited };
  running.add(entry);
  const fail = (error) => {
    failure ??= error;
    stopPhase(entry);
  };
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  // READY counts only as a whole line: stdout chunks may split it.
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    pending += chunk;
    let end = pending.indexOf('\n');
    while (end >= 0) {
      const line = pending.slice(0, end).replace(/\r$/, '');
      pending = pending.slice(end + 1);
      if (killWhenReady && line === 'READY' && !ready) {
        ready = true;
        stopPhase(entry);
      }
      end = pending.indexOf('\n');
    }
  });
  const deadline = setTimeout(
    () => fail(new Error(`${phase} passed its ${PHASE_DEADLINE_MS} ms deadline: ${stderr.slice(-2000)}`)),
    PHASE_DEADLINE_MS
  );
  const onAbort = () => fail(signal.reason ?? new Error(`${phase} cancelled`));
  if (signal?.aborted) onAbort();
  else signal?.addEventListener('abort', onAbort, { once: true });
  return exited.then(({ code, exitSignal }) => {
    clearTimeout(deadline);
    signal?.removeEventListener('abort', onAbort);
    running.delete(entry);
    if (failure) throw failure;
    if (killWhenReady && !ready) throw new Error(`${phase} exited before READY: ${stderr.slice(-2000)}`);
    if (!killWhenReady && code !== 0) throw new Error(`${phase} exited ${code ?? exitSignal}: ${stderr.slice(-2000)}`);
    return JSON.parse(readFileSync(outFile, 'utf8'));
  });
}

const withoutMarker = (block) => {
  if (!block || typeof block !== 'object') return block;
  const { cache_control: _marker, ...rest } = block;
  return rest;
};

/** The request as the prompt cache reads it: an ordered list of
 *  `[label, bytes, marked]` — the tools, each system block, the thinking
 *  parameters (they key the message cache), then every message block. */
function wireBlocks(body) {
  const out = [['tools', JSON.stringify(body.tools || []), false]];
  for (const [index, block] of (body.system || []).entries()) {
    out.push([`system[${index}]`, JSON.stringify(withoutMarker(block)), !!block?.cache_control]);
  }
  out.push([
    'thinking/output_config',
    JSON.stringify({ thinking: body.thinking ?? null, output_config: body.output_config ?? null }),
    false,
  ]);
  for (const [index, message] of (body.messages || []).entries()) {
    const content = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content;
    const head = { role: message.role, ...(message.clear_at ? { clear_at: message.clear_at } : {}) };
    for (const [blockIndex, block] of content.entries()) {
      out.push([
        `messages[${index}](${message.role})[${blockIndex}]`,
        JSON.stringify({ ...head, block: withoutMarker(block) }),
        !!block?.cache_control,
      ]);
    }
  }
  return out;
}

/** Where `next` first departs from `previous`, and which of `previous`'s
 *  breakpoints `next` can still read. */
function prefixDiff(previous, next) {
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
}

// Each scenario runs once; its tests share the result. The test that starts
// it lends its signal, so cancelling that test kills the scenario's process.
const once = (run) => {
  let result = null;
  return (signal) => {
    result ??= run(signal);
    return result;
  };
};
const idle = once(async (signal) => {
  const before = await runPhase('idle', 'idle', [], { signal });
  return { before, after: await runPhase('idle', 'resume', [before.sessionId], { signal }) };
});
const killed = (phase) =>
  once(async (signal) => {
    const before = await runPhase(phase, phase, [], { killWhenReady: true, signal });
    return { before, after: await runPhase(phase, 'resume', [before.sessionId], { signal }) };
  });
const killedInTool = killed('killtool');
const killedInRequest = killed('killrequest');

test('a session idle across a restart sends its whole cached prefix again', async (t) => {
  const { before, after } = await idle(t.signal);
  const diff = prefixDiff(before.bodies.at(-1), after.bodies[0]);
  assert.deepEqual(diff.lostBreakpoints, [], JSON.stringify(diff, null, 2));
});

test('the warm a restart re-arms replays the last request exactly and the next turn reads all of it', async (t) => {
  const { before, after } = await idle(t.signal);
  assert.ok(after.warmBody, 'an idle session gets a re-armed warm');
  const replay = prefixDiff(before.bodies.at(-1), after.warmBody);
  assert.equal(replay.firstDiff, null, JSON.stringify(replay, null, 2));
  const next = prefixDiff(after.warmBody, after.bodies[0]);
  assert.deepEqual(next.lostBreakpoints, [], JSON.stringify(next, null, 2));
});

test('a session killed mid-turn gets no re-armed warm', async (t) => {
  // Its record holds the turn's prompt with no reply (the checkpoint is
  // merged only by the next turn), so there is no last request to rebuild.
  assert.equal((await killedInTool(t.signal)).after.warmBody, null);
  assert.equal((await killedInRequest(t.signal)).after.warmBody, null);
});

test('the first request after a restart is traced against the last one before it', async (t) => {
  const { after } = await idle(t.signal);
  assert.deepEqual(after.changes[0], { changedBlocks: 'none', markersChanged: false, lostMessageBreakpoints: 'none' });
});

test('a turn killed in a tool run resumes on the whole prefix its last request cached', async (t) => {
  const { before, after } = await killedInTool(t.signal);
  const diff = prefixDiff(before.bodies.at(-1), after.bodies[0]);
  assert.equal(diff.firstDiff, null, JSON.stringify(diff, null, 2));
  // The checkpoint carried the last settled request's fingerprint across the crash.
  assert.deepEqual(after.changes[0], { changedBlocks: 'none', markersChanged: false, lostMessageBreakpoints: 'none' });
});

test('a turn killed with a request on the wire resumes on the whole prefix that request cached', async (t) => {
  const { before, after } = await killedInRequest(t.signal);
  const sent = before.bodies.at(-1);
  const resumed = after.bodies[0];
  const diff = prefixDiff(sent, resumed);
  // Every block up to the killed request's message breakpoint — its tail
  // tool_result — comes back byte for byte; only the turn-scoped system
  // reminder after it (clear_at: next_user_message) is not repeated.
  assert.deepEqual(diff.lostBreakpoints, [], JSON.stringify(diff, null, 2));
  const at = Number(/^messages\[(\d+)\]\(user\)/.exec(diff.lastBreakpoint)?.[1]);
  const sentBlocks = sent.messages[at].content;
  assert.equal(sentBlocks.at(-1).type, 'tool_result');
  assert.equal(diff.firstDiff, `messages[${at + 1}](system)[0]`, JSON.stringify(diff, null, 2));
  // The restart marker and the next prompt follow as sibling text blocks in
  // the same user message, not as a turn of their own.
  const message = resumed.messages[at];
  assert.equal(message.role, 'user');
  const siblings = message.content.slice(sentBlocks.length);
  assert.ok(siblings.length > 0 && siblings.every((block) => block.type === 'text'), JSON.stringify(siblings));
  assert.match(
    siblings.map((block) => block.text).join('\n'),
    /Request interrupted by process restart[\s\S]*third task/
  );
  assert.ok(
    resumed.messages.slice(at + 1).every((next) => next.role !== 'user'),
    'no user turn of their own'
  );
});
