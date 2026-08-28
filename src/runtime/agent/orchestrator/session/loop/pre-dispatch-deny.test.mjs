import assert from 'node:assert/strict';
import test from 'node:test';

import { preDispatchDenyForSession } from './pre-dispatch-deny.mjs';

test('Agent runtime denies only recursive agent control', () => {
  const reviewer = { owner: 'agent', agent: 'reviewer' };
  assert.match(
    preDispatchDenyForSession(reviewer, { name: 'agent', arguments: {} }),
    /Lead-only/,
  );
  assert.equal(
    preDispatchDenyForSession(reviewer, { name: 'inject_input', arguments: {} }),
    null,
  );
  assert.equal(
    preDispatchDenyForSession(reviewer, { name: 'apply_patch', arguments: {} }),
    null,
  );
});

test('internal Agent roles use the same runtime tool gate', () => {
  const cycle = { owner: 'agent', agent: 'cycle1-agent' };
  assert.equal(
    preDispatchDenyForSession(cycle, { name: 'apply_patch', arguments: {} }),
    null,
  );
});
