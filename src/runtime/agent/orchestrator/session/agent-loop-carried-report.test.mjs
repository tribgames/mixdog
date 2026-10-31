// The answer a turn went on past (a todo reminder after it) is the turn's
// report however the turn then ends: an empty end after todo bookkeeping only
// delivers it as the result; new work that fails or overruns its cap keeps
// the failure and reports the answer with it (./loop/no-tool-turn.mjs,
// ./loop/turn-report.mjs).
import assert from 'node:assert/strict';
import test from 'node:test';

import { agentLoop } from './agent-loop.mjs';
import { beginTodoTurn } from './loop/no-tool-turn/todo-check.mjs';
import { executeTodoTool } from '../runtime-core/todo-list.mjs';
import { getBackgroundTask, registerBackgroundTask } from '../../../shared/background-tasks.mjs';
import { reconcileJobStreamStalled } from '../../../../session-runtime/services/agent-tool/job-task-reconcile.mjs';

const REPORT = 'Status: done\n\nFull report.';
let seq = 0;

function workerSession() {
  seq += 1;
  const session = {
    id: `sess_carried_report_${seq}`,
    owner: 'cli',
    agent: 'worker',
    contextWindow: 200_000,
    rawContextWindow: 200_000,
    compaction: { auto: false },
  };
  executeTodoTool(session, { op: 'init', items: ['Only step'] });
  beginTodoTurn(session, { genuine: true });
  return session;
}

const call = (send, name) => ({ id: `c${send}`, name, arguments: name === 'todo' ? { op: 'view' } : {} });

// send 1 is the report; the reminder follows it; `after(send, session)` scripts the rest.
async function run(after, extra = {}) {
  const session = workerSession();
  let sends = 0;
  const provider = {
    async send() {
      sends += 1;
      if (sends === 1) return { content: REPORT, toolCalls: [], stopReason: 'end_turn' };
      return after(sends, session);
    },
  };
  const messages = [{ role: 'user', content: 'do the work' }];
  const result = await agentLoop(provider, messages, 'fake-model', [], null, process.cwd(), {
    session,
    sessionId: session.id,
    ...extra,
  });
  return { result, sends, messages };
}

const empty = { content: '', toolCalls: [], stopReason: 'end_turn' };

test('an empty end after only todo bookkeeping delivers the report as the result', async () => {
  const { result, sends } = await run((send, session) => {
    if (send === 2) {
      executeTodoTool(session, { op: 'done', item: 'Only step' });
      return { content: '', toolCalls: [call(send, 'todo')] };
    }
    return empty;
  });
  assert.equal(sends, 3, 'no empty-turn nudge');
  assert.equal(result.terminationReason, undefined);
  assert.equal(result.reportContent, REPORT);
});

test('new work after the report that ends empty stays a failure and carries the report', async () => {
  const { result } = await run((send) => (send === 2 ? { content: '', toolCalls: [call(send, 'read')] } : empty));
  assert.equal(result.terminationReason, 'empty');
  assert.equal(result.reportContent, REPORT);
});

test('a Lead question taken in before the next send ends the bookkeeping exemption', async () => {
  const stages = [];
  let queued = ['Lead: one more question?'];
  const { result, sends, messages } = await run(
    (send, session) => {
      if (send === 2) {
        executeTodoTool(session, { op: 'done', item: 'Only step' });
        return { content: '', toolCalls: [call(send, 'todo')] };
      }
      return empty;
    },
    {
      drainSteering: (_sessionId, { stage }) => {
        if (stage !== 'pre-send' || queued.length === 0) return [];
        stages.push(stage);
        const taken = queued;
        queued = [];
        return taken;
      },
    }
  );
  assert.deepEqual(stages, ['pre-send'], 'the question came in at the pre-send drain');
  assert.ok(messages.some((message) => message.role === 'user' && /one more question/.test(String(message.content))));
  assert.ok(sends > 3, 'the empty reply to the question is nudged');
  assert.equal(result.terminationReason, 'empty', 'an unanswered question is a failure');
  assert.equal(result.reportContent, REPORT, 'still carrying the report');
});

test('a capped turn that overruns after the report keeps it: bookkeeping completes, new work fails', async () => {
  const capped = { turnLimits: { maxToolCalls: 8, wrapUpAt: Date.now() - 1 } };
  const bookkeeping = await run((send) => ({ content: '', toolCalls: [call(send, 'todo')] }), capped);
  assert.equal(bookkeeping.result.terminationReason, undefined);
  assert.equal(bookkeeping.result.reportContent, REPORT);
  const work = await run((send) => ({ content: '', toolCalls: [call(send, send === 2 ? 'todo' : 'read')] }), capped);
  assert.equal(work.result.terminationReason, 'empty');
  assert.equal(work.result.reportContent, REPORT);
});

test('a turn that throws after the report carries it on the error to the failed task', async () => {
  const failure = await run((send) => {
    if (send === 2) return { content: '', toolCalls: [call(send, 'todo')] };
    throw new Error('provider exploded');
  }).catch((error) => error);
  assert.equal(failure.message, 'provider exploded');
  assert.equal(failure.carriedReport, REPORT);
  const task = registerBackgroundTask({ surface: 'agent' });
  reconcileJobStreamStalled({ taskId: task.taskId }, failure, { tag: 'worker-1' });
  const settled = getBackgroundTask(task.taskId);
  assert.equal(settled.status, 'failed');
  assert.deepEqual(settled.result, { tag: 'worker-1', content: REPORT });
});
