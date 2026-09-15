import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserTaskLifecycle } from './task-lifecycle.ts';

function fixture() {
  const selected = new Map();
  const surfaces = [];
  const page = (name, blocked = false) => ({ name, blocked, dead: false, isDestroyed() { return this.dead; } });
  const owner = createBrowserTaskLifecycle({
    current: session => selected.get(session) ?? null,
    select: (session, value) => selected.set(session, value),
    close: value => { value.dead = true; },
    canClose: value => !value.blocked,
    preserve: value => { value.preserved = true; },
    surface: (session, request) => surfaces.push({ session, ...request }),
  });
  return { owner, selected, surfaces, page };
}

test('background cleanup never reveals a surface and preserves other sessions and user pages', () => {
  const { owner, selected, surfaces, page } = fixture();
  const user = page('user');
  const scratch = page('scratch');
  const other = page('other session');
  selected.set('a', user);
  owner.use('a', 1, user, false);
  owner.use('a', 1, scratch, true);
  owner.use('b', 1, other, true);
  assert.equal(owner.finish('a', 1), 1);
  assert.equal(scratch.dead, true);
  assert.equal(user.dead, false);
  assert.equal(other.dead, false);
  assert.equal(selected.get('a'), user);
  assert.deepEqual(surfaces, []);
  assert.throws(() => owner.begin('a', 1), /already finished/);
});

test('temporary foreground work restores the previous selected page and panel', () => {
  const { owner, selected, surfaces, page } = fixture();
  const user = page('user');
  const scratch = page('scratch');
  selected.set('a', user);
  owner.use('a', 2, scratch, true);
  selected.set('a', scratch);
  owner.reveal('a', 2, scratch);
  owner.finish('a', 2);
  assert.equal(selected.get('a'), user);
  assert.deepEqual(surfaces, [
    { session: 'a', temporaryTurnId: 2 }, { session: 'a', restoreTurnId: 2 },
  ]);
});

test('user interaction and explicit handoff preserve pages and their visible panel', () => {
  const { owner, selected, surfaces, page } = fixture();
  const scratch = page('draft');
  owner.use('a', 1, scratch, true);
  selected.set('a', scratch);
  owner.reveal('a', 1, scratch);
  owner.retain(scratch);
  owner.use('a', 1, scratch, false);
  assert.equal(owner.finish('a', 1), 0);
  assert.equal(scratch.dead, false);
  assert.deepEqual(surfaces, [
    { session: 'a', temporaryTurnId: 1 }, { session: 'a', retainTurnId: 1 },
  ]);
});

test('late old-turn cleanup cannot close a page reused by newer work or restore its panel', () => {
  const { owner, selected, surfaces, page } = fixture();
  const scratch = page('shared work');
  owner.use('a', 1, scratch, true);
  selected.set('a', scratch);
  owner.reveal('a', 1, scratch);
  owner.use('a', 2, scratch, false);
  owner.reveal('a', 2, scratch);
  assert.equal(owner.finish('a', 1), 0);
  assert.equal(scratch.dead, false);
  assert.equal(surfaces.some(value => value.restoreTurnId === 1), false);
  assert.equal(owner.finish('a', 2), 1);
});

test('popups inherit task ownership; blocked dialogs survive cleanup without affecting user popups', () => {
  const { owner, page } = fixture();
  const scratch = page('scratch');
  const popup = page('popup');
  const prompt = page('human dialog', true);
  const userPopup = page('user popup');
  owner.use('a', 1, scratch, true);
  owner.inherit(scratch, popup);
  owner.inherit(scratch, prompt);
  owner.inherit(page('unowned opener'), userPopup);
  assert.equal(owner.finish('a', 1), 2);
  assert.equal(popup.dead, true);
  assert.equal(prompt.dead, false);
  assert.equal(prompt.preserved, true);
  assert.equal(userPopup.dead, false);
});
