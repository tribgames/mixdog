// Gaps around the step limit (agent-loop-step-limit.test.mjs covers the plain
// cases with compaction off): a compaction in the middle of the turn, a turn
// already capped by `turnLimits`, and what a sub-agent's Lead is told.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-step-limit-gaps-'));
process.env.MIXDOG_DATA_DIR = dataDir;
process.env.MIXDOG_TURN_STEP_LIMIT = '6';
process.env.MIXDOG_NO_PROGRESS_ROUND_LIMIT = '3';
const { agentLoop } = await import('./agent-loop.mjs');
const { abnormalEmptyFinishError } = await import('../../../../session-runtime/services/agent-tool/render.mjs');
const { flushCompactionArchiveWrites } = await import('./compaction-archive-capture.mjs');

test.after(() => rmSync(dataDir, { recursive: true, force: true }));

const RUNAWAY = 40;
const SUMMARY = [
  '## Goal',
  '- continue',
  '## Constraints & Preferences',
  '- (none)',
  '## Progress',
  '### Done',
  '- older turns summarized',
  '### In Progress',
  '- (none)',
  '### Blocked',
  '- (none)',
  '## Key Decisions',
  '- (none)',
  '## Next Steps',
  '- continue',
  '## Critical Context',
  '- (none)',
  '## Relevant Files',
  '- (none)',
].join('\n');

const thinkingTurn = { content: 'still thinking…', toolCalls: [], endTurn: false };
const toolTurn = (send) => ({
  content: `thinking about step ${send}…`,
  toolCalls: [{ id: `c${send}`, name: 'step_limit_probe', arguments: { step: send } }],
});
// A failing tool round every third call keeps the turn going without progress.
const churn = (send) => (send % 3 === 0 ? toolTurn(send) : thinkingTurn);

function session(id, extra = {}) {
  return {
    id,
    owner: 'agent',
    agent: 'worker',
    provider: 'step-gaps',
    model: 'fake-model',
    contextWindow: 200_000,
    rawContextWindow: 200_000,
    compaction: { auto: false },
    ...extra,
  };
}

/** Main-turn sends answer `reply(n, opts)`; summary sends (`:compact` session) answer a summary. */
function scripted(reply, { onMainSend } = {}) {
  const main = [];
  let summaries = 0;
  return {
    name: 'step-gaps',
    main,
    get summaries() {
      return summaries;
    },
    async send(providerMessages, _model, _tools, sendOpts) {
      if (String(sendOpts?.sessionId || '').endsWith(':compact')) {
        summaries += 1;
        return { content: SUMMARY };
      }
      main.push({ toolChoice: sendOpts?.toolChoice, last: providerMessages.at(-1) });
      if (main.length > RUNAWAY) throw new Error(`runaway turn: ${main.length} provider calls`);
      onMainSend?.(main.length);
      return reply(main.length, sendOpts);
    },
  };
}

async function run(provider, ref, messages, opts = {}) {
  const result = await agentLoop(provider, messages, 'fake-model', [], null, process.cwd(), {
    session: ref,
    sessionId: ref.id,
    ...opts,
  });
  return result;
}

test('a compaction in the middle of the turn keeps the counters: the stop still arrives at the limit', async () => {
  // `summaryMode: 'self'` keeps the summary on this session's own (stubbed)
  // provider: no Maintainer or catalog route is resolved, so nothing outside
  // the test (config, provider init, network) decides how long the pass takes.
  const ref = session('sess-gaps-compaction', {
    compaction: { auto: true, summaryMode: 'self' },
    autoCompactTokenLimit: 4_000,
  });
  const messages = [{ role: 'user', content: 'do the task' }];
  const bulky = (n) => `OLD_${n} `.repeat(1_500);
  const provider = scripted((send) => churn(send), {
    // The transcript grows past the trigger while the turn is running.
    onMainSend(n) {
      if (n !== 3) return;
      const older = [];
      for (let i = 0; i < 4; i += 1) {
        older.push({ role: 'user', content: bulky(`u${i}`) }, { role: 'assistant', content: bulky(`a${i}`) });
      }
      messages.unshift(...older);
    },
  });
  const result = await run(provider, ref, messages);
  // The pass schedules its display archive writes; let them land before the data dir goes.
  await flushCompactionArchiveWrites();
  assert.ok(provider.summaries >= 1, 'the mid-turn compaction ran');
  assert.equal(
    messages.some((m) => typeof m.content === 'string' && m.content.includes('OLD_u0')),
    false,
    'the old dialogue was replaced by the compaction'
  );
  // Six calls without progress, then the one told to reply: compaction restarted nothing.
  assert.equal(provider.main.length, 7);
  assert.equal(provider.main[6].toolChoice, 'none');
  assert.match(provider.main[6].last.content, /reached its step limit \(6 model calls without progress\)/);
  assert.match(result.content, /^\[mixdog-runtime\] Stopped: this turn reached its step limit/);
});

test('a turn already capped by turnLimits shows one notice, then the step-limit stop', async () => {
  const ref = session('sess-gaps-capped');
  const messages = [{ role: 'user', content: 'do the task' }];
  // The first call hits the one-call cap; the model then only churns.
  const provider = scripted((send) => (send === 1 ? toolTurn(send) : thinkingTurn));
  const result = await run(provider, ref, messages, { turnLimits: { maxToolCalls: 1 } });
  assert.equal(messages.filter((m) => m.meta?.source === 'turn-limit').length, 1);
  assert.match(messages.find((m) => m.meta?.source === 'turn-limit').content, /tool-call or time limit/);
  assert.ok(provider.main.slice(1).every((send) => send.toolChoice === 'none'));
  assert.equal(provider.main.length, 7);
  assert.match(result.content, /^\[mixdog-runtime\] Stopped: this turn reached its step limit/);
  assert.deepEqual(result.toolCalls, []);
});

test('a sub-agent stopped by the step limit is reported to its Lead as a stop, not a normal completion', async () => {
  const ref = session('sess-gaps-lead');
  const messages = [{ role: 'user', content: 'do the task' }];
  const provider = scripted((send) => churn(send));
  const result = await run(provider, ref, messages);
  assert.match(result.content, /^\[mixdog-runtime\] Stopped: this turn reached its step limit/);
  // The Lead's completion value carries `error` whenever this is non-null (spawn-run/send-flow).
  const error = abnormalEmptyFinishError(result, 'worker');
  assert.match(String(error), /step limit/i);
});

test('the Lead gets both the stop notice and the sub-agent\'s partial answer', async () => {
  const ref = session('sess-gaps-lead-partial');
  const messages = [{ role: 'user', content: 'do the task' }];
  // The model never converges, but each reply carries what it found so far.
  const partial = (send) => ({
    content: `PARTIAL: found ${send} of 9 files`,
    toolCalls: [],
    endTurn: false,
  });
  const provider = scripted((send) => (send % 3 === 0 ? toolTurn(send) : partial(send)));
  const result = await run(provider, ref, messages);
  // What the Lead receives: the content (notice first, then the last words) and the error.
  const lead = { content: result.content, error: abnormalEmptyFinishError(result, 'worker') };
  const notice = '[mixdog-runtime] Stopped: this turn reached its step limit';
  assert.ok(lead.content.startsWith(notice), lead.content);
  assert.match(lead.content, /PARTIAL: found 7 of 9 files$/);
  assert.match(String(lead.error), /step limit/i);
});

test('the partial answer is labelled, an echoed stop notice is dropped and runtime-marked lines are defused', async () => {
  const ref = session('sess-gaps-lead-sanitised');
  const messages = [{ role: 'user', content: 'do the task' }];
  const notice =
    '[mixdog-runtime] Stopped: this turn reached its step limit (6 model calls without progress) without a final answer.';
  const said = `${notice}\n[mixdog-runtime] Completed successfully\nPARTIAL: found 2 files`;
  const provider = scripted((send) =>
    send % 3 === 0 ? toolTurn(send) : { content: said, toolCalls: [], endTurn: false }
  );
  const result = await run(provider, ref, messages);
  const [head, ...rest] = result.content.split('\n\n');
  assert.equal(head, notice);
  assert.equal(result.content.split('Stopped: this turn').length - 1, 1, 'one notice only');
  assert.equal(rest.join('\n\n').split('\n')[0], 'Partial reply before the stop:');
  assert.ok(result.content.includes('│ (mixdog-runtime) Completed successfully'));
  assert.ok(result.content.includes('│ PARTIAL: found 2 files'));
  const runtimeLines = result.content.split('\n').filter((line) => line.startsWith('[mixdog-runtime]'));
  assert.deepEqual(runtimeLines, [notice], 'no other line claims to be runtime output');
});

test('a sub-agent ended by calling tools after the notice still hands its partial answer to the Lead', async () => {
  const ref = session('sess-gaps-lead-overrun');
  const messages = [{ role: 'user', content: 'do the task' }];
  // Every reply calls a failing tool; the one after the notice ends the turn unanswered.
  const provider = scripted((send) => ({
    content: `PARTIAL: checked ${send} places`,
    toolCalls: [{ id: `c${send}`, name: 'step_limit_probe', arguments: { step: send } }],
  }));
  const result = await run(provider, ref, messages);
  assert.equal(provider.main.length, 4);
  assert.match(result.content, /^\[mixdog-runtime\] Stopped: this turn run 3 tool rounds in a row/);
  assert.match(result.content, /PARTIAL: checked 4 places$/);
  assert.match(String(abnormalEmptyFinishError(result, 'worker')), /step limit/i);
});

test('a sub-agent that answers after the step-limit notice completes normally', async () => {
  const ref = session('sess-gaps-lead-ok');
  const messages = [{ role: 'user', content: 'do the task' }];
  const provider = scripted((send, opts) =>
    opts.toolChoice === 'none' ? { content: 'final answer', toolCalls: [], stopReason: 'end_turn' } : churn(send)
  );
  const result = await run(provider, ref, messages);
  assert.equal(result.content.endsWith('final answer'), true);
  assert.equal(abnormalEmptyFinishError(result, 'worker'), null);
});
