import assert from 'node:assert/strict';
import test from 'node:test';

import { loginSavePayload } from './auth-login-draft.ts';

const base = {
  site: 'dart.fss.or.kr',
  username: 'data-team',
  password: '',
  totpSecret: '',
  totpCleared: false,
  note: 'team',
};

test('a bare site becomes an https origin; username and site are trimmed', () => {
  const payload = loginSavePayload({ ...base, site: '  dart.fss.or.kr  ', username: '  data-team  ', password: 'pw' });
  assert.equal(payload.origin, 'https://dart.fss.or.kr');
  assert.equal(payload.username, 'data-team');
  // A scheme already present is kept.
  assert.equal(loginSavePayload({ ...base, site: 'https://x.test', password: 'pw' }).origin, 'https://x.test');
});

test('editing without touching the key omits totpSecret so the saved key survives', () => {
  const payload = loginSavePayload({ ...base, id: 'a'.repeat(24) });
  assert.ok(!('totpSecret' in payload), 'an untouched edit never sends the key');
});

test('typing a new key, or removing it, sends the change', () => {
  const changed = loginSavePayload({ ...base, id: 'a'.repeat(24), totpSecret: 'JBSWY3DPEHPK3PXP' });
  assert.equal(changed.totpSecret, 'JBSWY3DPEHPK3PXP');
  const removed = loginSavePayload({ ...base, id: 'a'.repeat(24), totpCleared: true });
  assert.equal(removed.totpSecret, '', 'an explicit removal clears the key');
});

test('an empty (or whitespace-only) key field with no removal omits totpSecret', () => {
  // The type-then-clear case is exercised end-to-end through the dialog in
  // auth-panel.test.mjs; here the payload rule itself: empty + not cleared omits.
  assert.ok(
    !('totpSecret' in loginSavePayload({ ...base, id: 'a'.repeat(24), totpSecret: '   ', totpCleared: false }))
  );
});

test('adding a login sends the key only when one was entered', () => {
  assert.ok(!('totpSecret' in loginSavePayload({ ...base, password: 'pw' })));
  assert.equal(
    loginSavePayload({ ...base, password: 'pw', totpSecret: ' JBSWY3DPEHPK3PXP ' }).totpSecret,
    'JBSWY3DPEHPK3PXP'
  );
});
