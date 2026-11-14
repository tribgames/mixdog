import assert from 'node:assert/strict';
import test from 'node:test';

import { createSecretSlotMirror } from './secret-requests.ts';
import { createTakeoverMirror } from './takeover-gate.ts';

const held = { sessionId: 's1', takeoverId: '4', step: 'sign-in on a.com', surface: 'computer' };

test('the takeover mirror refuses its own session with the core text and nobody else', async () => {
  let state = { held: [held], screen: 'sign-in on a.com', secretSlots: [] };
  const mirror = createTakeoverMirror(async () => state);
  await assert.rejects(
    () => mirror.assertFree('s1'),
    (error) => error.message.startsWith('Browser Use is paused for this session: the user has taken over (sign-in on a.com)') && error.message.includes('Wait for the handoff_user result')
  );
  await mirror.assertFree('s2');
  assert.equal(mirror.heldOf('s1')?.takeoverId, '4');
  assert.equal(mirror.screenStep(), 'sign-in on a.com');
  // It reads the core again on every check: the takeover ending frees the session at once.
  state = { held: [], secretSlots: [] };
  await mirror.assertFree('s1');
  assert.equal(mirror.heldOf('s1'), undefined);
  assert.equal(mirror.screenStep(), undefined);
});

test('the takeover mirror holds nothing before it has read the core', () => {
  const mirror = createTakeoverMirror(async () => ({ held: [held], secretSlots: [] }));
  assert.equal(mirror.heldOf('s1'), undefined);
});

test('the secret slot mirror asks the core about the one id and never sends an unusable one', async () => {
  const asked = [];
  const mirror = createSecretSlotMirror(async (ids) => {
    asked.push(ids);
    return { held: [], secretSlots: (ids ?? []).filter((id) => id === 'secret_abcdefgh1234') };
  });
  assert.equal(await mirror.has('secret_abcdefgh1234'), true);
  assert.equal(await mirror.has('secret_zzzzzzzz9999'), false);
  assert.equal(await mirror.has('not-a-secret-id'), false);
  assert.deepEqual(asked, [['secret_abcdefgh1234'], ['secret_zzzzzzzz9999']]);
});
