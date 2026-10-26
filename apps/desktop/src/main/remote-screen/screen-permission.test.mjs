import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decideScreenPermission,
  effectiveScreenPermission,
  screenInputAllowed,
} from './screen-permission.ts';

const paired = (grant) => ({ enabled: true, pairedE2EE: true, grant });

test('the master switch gates everything', () => {
  assert.deepEqual(decideScreenPermission('view', { enabled: false, pairedE2EE: true, grant: 'control' }), {
    allowed: false,
    reason: 'disabled',
  });
});

test('only paired E2EE clients are admitted', () => {
  assert.deepEqual(decideScreenPermission('view', { enabled: true, pairedE2EE: false, grant: 'control' }), {
    allowed: false,
    reason: 'unauthorized',
  });
});

test('view and control are separate grants; view never implies control', () => {
  assert.deepEqual(decideScreenPermission('view', paired('view')), { allowed: true, permission: 'view' });
  assert.deepEqual(decideScreenPermission('control', paired('view')), { allowed: false, reason: 'not-granted' });
  assert.deepEqual(decideScreenPermission('control', paired('control')), { allowed: true, permission: 'control' });
  // A control grant also satisfies a view request.
  assert.deepEqual(decideScreenPermission('view', paired('control')), { allowed: true, permission: 'view' });
  assert.deepEqual(decideScreenPermission('view', paired('none')), { allowed: false, reason: 'not-granted' });
});

test('effective permission downgrades a live session when a grant is lowered', () => {
  assert.equal(effectiveScreenPermission(paired('control')), 'control');
  assert.equal(effectiveScreenPermission(paired('view')), 'view');
  assert.equal(effectiveScreenPermission(paired('none')), null);
  assert.equal(effectiveScreenPermission({ enabled: false, pairedE2EE: true, grant: 'control' }), null);
  assert.equal(effectiveScreenPermission({ enabled: true, pairedE2EE: false, grant: 'control' }), null);
});

test('input is allowed only with a live control permission', () => {
  assert.equal(screenInputAllowed('control'), true);
  assert.equal(screenInputAllowed('view'), false);
  assert.equal(screenInputAllowed(null), false);
});
