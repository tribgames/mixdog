// The catalog's `working` overlay comes from the runtime map, not from a file:
// a turn that settles after its last save must still re-list the catalog, or
// its row keeps spinning and never takes its completion dot (a bot home has
// no later title write to do it).
import assert from 'node:assert/strict';
import test from 'node:test';

import { runtimeState } from './manager/runtime-state.mjs';
import { subscribeStoredSessionCatalogChanges } from './store-summary-reader.mjs';
import { emitSessionActivityChange, emitSessionApprovalCardChange } from '../../../shared/session-activity-signal.mjs';
import { endBotWork, noteBotWork } from '../../../shared/bot-owned-work.mjs';

test('a turn starting or settling re-lists the catalog; other activity refreshes only the pool', (t) => {
  const kinds = [];
  t.after(subscribeStoredSessionCatalogChanges((kind) => kinds.push(kind)));
  t.after(() => runtimeState.clear());
  const take = () => kinds.splice(0);

  runtimeState.set('sess_home_lead', { stage: 'streaming', session: { owner: 'user', agent: 'lead' } });
  emitSessionActivityChange('sess_home_lead');
  assert.deepEqual(take(), ['agent-activity', 'turn-activity'], 'the turn started');

  emitSessionActivityChange('sess_home_lead');
  assert.deepEqual(take(), ['agent-activity'], 'a task wait inside the same turn: pool only');

  runtimeState.set('sess_home_lead', { stage: 'done', session: { owner: 'user', agent: 'lead' } });
  emitSessionActivityChange('sess_home_lead');
  assert.deepEqual(take(), ['agent-activity', 'turn-activity'], 'the turn settled after its save');

  emitSessionApprovalCardChange('sess_home_lead');
  assert.deepEqual(take(), ['approval']);
});

// `handedBy` rides on the catalog row, but no file and no working-set change
// moves with it: a send accepted while the task already works, or ended while
// other work goes on, must still re-list the catalog.
test('the bots owning a session’s work changing re-lists the catalog, once per membership change', (t) => {
  const kinds = [];
  t.after(subscribeStoredSessionCatalogChanges((kind) => kinds.push(kind)));
  t.after(() => ['run_1', 'run_2', 'run_3'].forEach(endBotWork));
  t.after(() => runtimeState.clear());
  const take = () => kinds.splice(0);

  // The task is working already (a user turn): the working set will not change.
  runtimeState.set('sess_task', { stage: 'streaming', session: { owner: 'user', agent: 'lead' } });
  emitSessionActivityChange('sess_task');
  take();

  noteBotWork({ runId: 'run_1', sessionId: 'sess_task', agentId: 'bot_a' });
  assert.deepEqual(take(), ['bot-work'], 'a send accepted into a working task');
  noteBotWork({ runId: 'run_2', sessionId: 'sess_task', agentId: 'bot_a' });
  assert.deepEqual(take(), [], 'the same bot sending again changes nothing the row shows');
  noteBotWork({ runId: 'run_3', sessionId: 'sess_task', agentId: 'bot_b' });
  assert.deepEqual(take(), ['bot-work'], 'another bot joins');
  endBotWork('run_1');
  assert.deepEqual(take(), [], 'the bot still has another send in flight');
  endBotWork('run_2');
  assert.deepEqual(take(), ['bot-work'], 'the bot’s last send ended while the task keeps working');
  endBotWork('run_2');
  assert.deepEqual(take(), [], 'a run that already ended is not announced twice');
  endBotWork('run_3');
  assert.deepEqual(take(), ['bot-work'], 'the last bot left');
});
