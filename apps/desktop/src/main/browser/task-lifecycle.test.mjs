import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserTaskLifecycle } from './task-lifecycle.ts';

function fixture({ close } = {}) {
  const selected = new Map();
  const surfaces = [];
  const page = (name, blocked = false) => ({
    name,
    blocked,
    dead: false,
    isDestroyed() {
      return this.dead;
    },
  });
  const owner = createBrowserTaskLifecycle({
    current: (session) => selected.get(session) ?? null,
    select: (session, value) => selected.set(session, value),
    close:
      close ??
      ((value) => {
        value.dead = true;
      }),
    canClose: (value) => !value.blocked,
    preserve: (value) => {
      value.preserved = true;
    },
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
    { session: 'a', temporaryTurnId: 2 },
    { session: 'a', restoreTurnId: 2 },
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
    { session: 'a', temporaryTurnId: 1 },
    { session: 'a', retainTurnId: 1 },
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
  assert.equal(
    surfaces.some((value) => value.restoreTurnId === 1),
    false
  );
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

test('a failed page close remains owned and retry never closes an already released page twice', () => {
  const attempts = [];
  let fail = true;
  const { owner, page } = fixture({
    close: (value) => {
      attempts.push(value.name);
      if (value.name === 'second' && fail) throw new Error('window close failed');
      value.dead = true;
    },
  });
  const first = page('first');
  const second = page('second');
  const third = page('third');
  for (const value of [first, second, third]) owner.use('s', 1, value, true);
  assert.throws(() => owner.finish('s', 1), /window close failed/);
  assert.equal(first.dead, true);
  assert.equal(second.dead, false);
  assert.equal(third.dead, false);
  fail = false;
  assert.equal(owner.finish('s', 1), 2);
  assert.deepEqual(attempts, ['first', 'second', 'second', 'third']);
  assert.equal(owner.finish('s', 1), 0);
});

test('failed-close recovery preserves newer ownership and handles a page destroyed while close threw', () => {
  for (const outcome of ['reused', 'destroyed']) {
    let fail = true;
    const { owner, page } = fixture({
      close: (value) => {
        if (outcome === 'destroyed' || !fail) value.dead = true;
        if (fail) throw new Error('close interrupted');
      },
    });
    const scratch = page('scratch');
    owner.use('s', 1, scratch, true);
    assert.throws(() => owner.finish('s', 1), /close interrupted/);
    fail = false;
    if (outcome === 'reused') owner.use('s', 2, scratch, false);
    assert.equal(owner.finish('s', 1), 0);
    if (outcome === 'reused') {
      assert.equal(scratch.dead, false);
      assert.equal(owner.finish('s', 2), 1);
    }
  }
});
