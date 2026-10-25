// A turn that never converges — the model keeps being called, reasoning and
// calling tools that produce nothing, without a final answer — ends after a
// bounded number of provider calls instead of looping until the user's quota
// is gone. Productive tool work stays uncapped.
import assert from 'node:assert/strict';
import test from 'node:test';

// Small limits so the bound is observable; read when the loop module loads.
process.env.MIXDOG_TURN_STEP_LIMIT = '6';
process.env.MIXDOG_NO_PROGRESS_ROUND_LIMIT = '3';
const { agentLoop } = await import('./agent-loop.mjs');

// Far above any bound the loop should allow: before the limits existed these
// turns ran until this guard threw.
const RUNAWAY = 40;

function session(id) {
  return {
    id,
    owner: 'agent',
    agent: 'worker',
    contextWindow: 200_000,
    rawContextWindow: 200_000,
    compaction: { auto: false },
  };
}

/** Every send answers `reply(send, sendOpts)`; records tool choice and last message. */
function scripted(reply) {
  const sends = [];
  return {
    sends,
    async send(providerMessages, _model, _tools, sendOpts) {
      sends.push({ toolChoice: sendOpts?.toolChoice, last: providerMessages.at(-1) });
      if (sends.length > RUNAWAY) throw new Error(`runaway turn: ${sends.length} provider calls`);
      return reply(sends.length, sendOpts);
    },
  };
}

// Reasoning-heavy turn that calls a different tool every time.
const toolTurn = (send) => ({
  content: `thinking about step ${send}…`,
  toolCalls: [{ id: `c${send}`, name: 'step_limit_probe', arguments: { step: send } }],
});
const finalTurn = { content: 'final answer', toolCalls: [], stopReason: 'end_turn' };

// The probe tool is absent, so the runtime answers it with an error; a test
// that needs a SUCCESSFUL call marks the result as an ordinary one.
const succeed = (message) => {
  if (message.role === 'tool') message.toolKind = 'normal';
};

async function run(id, provider, extra = {}) {
  const messages = [{ role: 'user', content: 'do the task' }];
  const { sessionProps, ...opts } = extra;
  const ref = Object.assign(session(id), sessionProps);
  const result = await agentLoop(provider, messages, 'fake-model', [], null, process.cwd(), {
    session: ref,
    sessionId: id,
    ...opts,
  });
  return { result, messages };
}

// Reasoning that declares itself unfinished, with a failing tool round every
// third call: each round restarts the continuation ladder, so before the step
// limit nothing ever ended this turn.
const thinkingTurn = { content: 'still thinking…', toolCalls: [], endTurn: false };
const churn = (send) => (send % 3 === 0 ? toolTurn(send) : thinkingTurn);

test('a turn that keeps reasoning without progress stops at the step limit', async () => {
  const provider = scripted((send) => churn(send));
  const { result, messages } = await run('sess-step-limit', provider);
  // Six calls, then one more told to reply without tools; it kept reasoning.
  assert.equal(provider.sends.length, 7);
  assert.equal(provider.sends[6].toolChoice, 'none');
  assert.match(provider.sends[6].last.content, /reached its step limit \(6 model calls without progress\)/);
  assert.match(result.content, /^\[mixdog-runtime\] Stopped: this turn reached its step limit/);
  assert.deepEqual(result.toolCalls, []);
  assert.equal(messages.filter((m) => m.meta?.source === 'turn-limit').length, 1);
});

test('the reply after the step-limit notice is the final answer', async () => {
  const provider = scripted((send, opts) => (opts.toolChoice === 'none' ? finalTurn : churn(send)));
  const { result } = await run('sess-step-limit-reply', provider);
  assert.equal(provider.sends.length, 7);
  assert.match(result.content, /final answer$/);
});

test('tool rounds in which every call fails end the turn after the no-progress limit', async () => {
  const provider = scripted((send, opts) => (opts.toolChoice === 'none' ? finalTurn : toolTurn(send)));
  const { result, messages } = await run('sess-no-progress', provider);
  // Three failing rounds, then the reply without tools.
  assert.equal(provider.sends.length, 4);
  assert.equal(provider.sends[3].toolChoice, 'none');
  assert.match(provider.sends[3].last.content, /3 tool rounds in a row in which no call produced a new result/);
  assert.equal(result.content, 'final answer');
  assert.ok(messages.filter((m) => m.role === 'tool').every((m) => m.toolKind === 'error'));
});

test('a call replayed with the same successful result ends the turn after the no-progress limit', async () => {
  const replay = (send) => ({
    content: 'checking again…',
    toolCalls: [{ id: `r${send}`, name: 'step_limit_probe', arguments: { path: 'a.txt' } }],
  });
  const provider = scripted((send, opts) => (opts.toolChoice === 'none' ? finalTurn : replay(send)));
  const { result } = await run('sess-replay', provider, {
    onToolResult(message) {
      succeed(message);
      message.content = 'same output';
    },
  });
  // The first result is new; three identical replays later the model is told to reply.
  assert.equal(provider.sends.length, 5);
  assert.equal(provider.sends[4].toolChoice, 'none');
  assert.match(provider.sends[4].last.content, /3 tool rounds in a row in which no call produced a new result/);
  assert.equal(result.content, 'final answer');
});

test('a waiting tool returning the same result is not cut off', async () => {
  const poll = (send) => ({
    content: 'waiting…',
    toolCalls: [{ id: `w${send}`, name: 'sleep', arguments: { ms: 1000 } }],
  });
  const provider = scripted((send) => (send <= 5 ? poll(send) : finalTurn));
  const { result, messages } = await run('sess-wait', provider, {
    onToolResult(message) {
      succeed(message);
      message.content = 'still running';
    },
  });
  assert.equal(provider.sends.length, 6);
  assert.equal(result.content, 'final answer');
  assert.equal(messages.filter((m) => m.meta?.source === 'turn-limit').length, 0);
});

test('a task wait returning the same result is not cut off', async () => {
  const poll = (send) => ({
    content: 'waiting…',
    toolCalls: [{ id: `t${send}`, name: 'task', arguments: { action: 'wait', task_id: 'job_1' } }],
  });
  const provider = scripted((send) => (send <= 5 ? poll(send) : finalTurn));
  const { result, messages } = await run('sess-task-wait', provider, {
    onToolResult(message) {
      succeed(message);
      message.content = 'still running';
    },
  });
  assert.equal(provider.sends.length, 6);
  assert.equal(result.content, 'final answer');
  assert.equal(messages.filter((m) => m.meta?.source === 'turn-limit').length, 0);
});

for (const [label, args] of [
  ['task list', { name: 'task', arguments: { action: 'list' } }],
  ['task read', { name: 'task', arguments: { action: 'read', task_id: 'job_1' } }],
  ['agent status', { name: 'agent', arguments: { type: 'status', task_id: 'job_1' } }],
  ['agent list', { name: 'agent', arguments: JSON.stringify({ type: 'list' }) }],
]) {
  test(`${label} repeated with identical arguments and result makes no progress`, async () => {
    const replay = (send) => ({ content: 'checking…', toolCalls: [{ id: `s${send}`, ...args }] });
    const provider = scripted((send, opts) => (opts.toolChoice === 'none' ? finalTurn : replay(send)));
    const { result } = await run(`sess-poll-${label.replace(' ', '-')}`, provider, {
      onToolResult(message) {
        succeed(message);
        message.content = 'job_1 running';
      },
    });
    assert.equal(provider.sends.length, 5);
    assert.equal(provider.sends[4].toolChoice, 'none');
    assert.match(provider.sends[4].last.content, /3 tool rounds in a row in which no call produced a new result/);
    assert.equal(result.content, 'final answer');
  });
}

test('no tool starts eagerly while the wrap-up response streams after the notice', async () => {
  const started = [];
  const provider = scripted((send, opts) => {
    const call = { id: `c${send}`, name: 'step_limit_probe', arguments: { step: send } };
    // The provider streams the call (opts.onToolCall) before send() returns.
    opts.onToolCall?.(call);
    return { content: 'wrapping up…', toolCalls: [call] };
  });
  const { result } = await run('sess-no-eager-after-notice', provider, {
    sessionProps: {
      beforeToolHook(call) {
        started.push(call.toolCallId);
      },
    },
  });
  // Three failing rounds run; the call streamed with the wrap-up reply (c4) never starts.
  assert.equal(provider.sends.length, 4);
  assert.equal(provider.sends[3].toolChoice, 'none');
  assert.deepEqual(started, ['c1', 'c2', 'c3']);
  assert.match(result.content, /^\[mixdog-runtime\] Stopped/);
});

test('productive work runs past the step limit, failures interleaved with progress included', async () => {
  const provider = scripted((send) => (send <= 12 ? toolTurn(send) : finalTurn));
  const { result, messages } = await run('sess-healthy', provider, {
    // Odd rounds fail, even rounds succeed: never three failures in a row.
    onToolResult(message) {
      if (Number(message.toolCallId.slice(1)) % 2 === 0) succeed(message);
    },
  });
  assert.equal(provider.sends.length, 13);
  assert.ok(provider.sends.every((s) => s.toolChoice === undefined));
  assert.equal(result.content, 'final answer');
  assert.equal(result.toolCallsTotal, 12);
  assert.equal(messages.filter((m) => m.meta?.source === 'turn-limit').length, 0);
});
