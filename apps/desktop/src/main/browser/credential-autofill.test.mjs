import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

import { BROWSER_CREDENTIAL_AUTOFILL_FUNCTION } from './credential-autofill.ts';

test('stored credential fill targets the current login form and emits framework events without returning secrets', async () => {
  const dom = new JSDOM(`<!doctype html>
    <form>
      <input id="identity" name="user_id" type="text">
      <input id="password" name="pw" type="password">
      <input id="new-password" type="password" autocomplete="new-password">
    </form>`, {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    url: 'https://accounts.example.test/login',
  });
  try {
    const events = [];
    for (const input of dom.window.document.querySelectorAll('input')) {
      input.getBoundingClientRect = () => ({
        left: 10, top: 10, right: 210, bottom: 40,
        width: 200, height: 30, x: 10, y: 10,
        toJSON() { return this; },
      });
      input.addEventListener('input', () => events.push(`${input.id}:input`));
      input.addEventListener('change', () => events.push(`${input.id}:change`));
    }
    const fill = dom.window.eval(`(${BROWSER_CREDENTIAL_AUTOFILL_FUNCTION})`);
    const result = await fill({
      username: 'fixture-user',
      password: 'fixture-password',
    });
    assert.equal(dom.window.document.querySelector('#identity').value, 'fixture-user');
    assert.equal(dom.window.document.querySelector('#password').value, 'fixture-password');
    assert.equal(dom.window.document.querySelector('#new-password').value, '');
    assert.equal(result.usernameFilled, true);
    assert.equal(result.passwordFilled, true);
    assert.doesNotMatch(JSON.stringify(result), /fixture-user|fixture-password/);
    assert.deepEqual(events, [
      'identity:input',
      'identity:change',
      'password:input',
      'password:change',
    ]);
  } finally {
    dom.window.close();
  }
});
