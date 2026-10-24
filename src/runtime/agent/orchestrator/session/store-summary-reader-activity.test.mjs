// The catalog's `working` overlay comes from the runtime map, not from a file:
// a turn that settles after its last save must still re-list the catalog, or
// its row keeps spinning and never takes its completion dot (a bot home has
// no later title write to do it).
import assert from 'node:assert/strict';
import test from 'node:test';

import { runtimeState } from './manager/runtime-state.mjs';
import { subscribeStoredSessionCatalogChanges } from './store-summary-reader.mjs';
import { emitSessionActivityChange, emitSessionApprovalCardChange } from '../../../shared/session-activity-signal.mjs';

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
