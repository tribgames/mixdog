import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ADMIN_APPROVAL_REQUIRED, requireSensitiveImportApproval } from './profile-import-approval.ts';

test('history-only imports never require approval', () => {
  assert.doesNotThrow(() => requireSensitiveImportApproval({ hasSensitiveItem: false, administratorApproved: false }));
});

test('administrator-approved passwords/cookies are allowed', () => {
  assert.doesNotThrow(() => requireSensitiveImportApproval({ hasSensitiveItem: true, administratorApproved: true }));
});

test('passwords/cookies without approval are refused', () => {
  assert.throws(
    () => requireSensitiveImportApproval({ hasSensitiveItem: true, administratorApproved: false }),
    (error) => error instanceof Error && error.message === ADMIN_APPROVAL_REQUIRED
  );
});
