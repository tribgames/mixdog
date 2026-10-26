// The shipped step bounds: 30 model calls without progress and 8 tool rounds
// with no new result; an env value that is not a positive integer falls back.
// turn-limits.mjs reads the env when it loads, so each case loads a fresh copy.
import assert from 'node:assert/strict';
import test from 'node:test';

const NAMES = ['MIXDOG_TURN_STEP_LIMIT', 'MIXDOG_NO_PROGRESS_ROUND_LIMIT'];
let copies = 0;

async function limitsWith(env) {
  const saved = Object.fromEntries(NAMES.map((name) => [name, process.env[name]]));
  for (const name of NAMES) delete process.env[name];
  Object.assign(process.env, env);
  try {
    const mod = await import(`./turn-limits.mjs?copy=${++copies}`);
    return { step: mod.STEP_LIMIT, rounds: mod.NO_PROGRESS_ROUND_LIMIT };
  } finally {
    for (const name of NAMES) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
}

test('the shipped defaults are 30 model calls and 8 empty rounds', async () => {
  assert.deepEqual(await limitsWith({}), { step: 30, rounds: 8 });
});

test('a valid env value replaces the default', async () => {
  assert.deepEqual(await limitsWith({ MIXDOG_TURN_STEP_LIMIT: '12', MIXDOG_NO_PROGRESS_ROUND_LIMIT: '5' }), {
    step: 12,
    rounds: 5,
  });
});

for (const bad of ['', 'abc', '0', '-3', '2.5', 'NaN', 'Infinity']) {
  test(`an invalid env value (${JSON.stringify(bad)}) falls back to the defaults`, async () => {
    assert.deepEqual(await limitsWith({ MIXDOG_TURN_STEP_LIMIT: bad, MIXDOG_NO_PROGRESS_ROUND_LIMIT: bad }), {
      step: 30,
      rounds: 8,
    });
  });
}

test('with the defaults, a turn of failing tool rounds is told to reply after 8 rounds and a thinking turn after 30 calls', async () => {
  const saved = Object.fromEntries(NAMES.map((name) => [name, process.env[name]]));
  for (const name of NAMES) delete process.env[name];
  const { agentLoop } = await import(`../agent-loop.mjs?defaults=${++copies}`);
  for (const name of NAMES) if (saved[name] !== undefined) process.env[name] = saved[name];

  const run = async (id, reply) => {
    const sends = [];
    const provider = {
      async send(messages, _model, _tools, opts) {
        sends.push({ toolChoice: opts?.toolChoice, last: messages.at(-1) });
        if (sends.length > 60) throw new Error('runaway turn');
        return reply(sends.length, opts);
      },
    };
    const ref = { id, owner: 'agent', agent: 'worker', contextWindow: 200_000, compaction: { auto: false } };
    const result = await agentLoop(provider, [{ role: 'user', content: 'go' }], 'fake-model', [], null, process.cwd(), {
      session: ref,
      sessionId: id,
    });
    return { sends, result };
  };
  const toolTurn = (n) => ({ content: `step ${n}`, toolCalls: [{ id: `c${n}`, name: 'probe', arguments: { n } }] });
  const finalTurn = { content: 'final answer', toolCalls: [], stopReason: 'end_turn' };

  const failing = await run('sess-defaults-rounds', (n, opts) =>
    opts.toolChoice === 'none' ? finalTurn : toolTurn(n)
  );
  assert.equal(failing.sends.length, 9);
  assert.equal(failing.sends[8].toolChoice, 'none');
  assert.match(failing.sends[8].last.content, /run 8 tool rounds in a row/);

  // A failing tool round every fourth call: 7 empty rounds by call 28, so the call count binds first.
  const thinking = { content: 'still thinking…', toolCalls: [], endTurn: false };
  const slow = await run('sess-defaults-steps', (n) => (n % 4 === 0 ? toolTurn(n) : thinking));
  assert.equal(slow.sends.length, 31);
  assert.equal(slow.sends[30].toolChoice, 'none');
  assert.match(slow.sends[30].last.content, /reached its step limit \(30 model calls without progress\)/);
  assert.match(slow.result.content, /^\[mixdog-runtime\] Stopped: this turn reached its step limit/);
});
