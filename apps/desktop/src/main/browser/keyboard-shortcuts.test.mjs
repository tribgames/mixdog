import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserInputDriver } from './input.ts';

test('function keys and a literal plus survive key parsing with their modifiers', async () => {
  const events = [];
  const driver = createBrowserInputDriver(async (_guest, _method, params) => {
    events.push(params); return 'completed';
  });
  await driver.pressKey({}, 'F5');
  await driver.pressKey({}, 'Control+Shift++');
  assert.deepEqual(events.filter(event => event.type === 'rawKeyDown').map(event =>
    [event.key, event.code, event.windowsVirtualKeyCode, event.modifiers]),
  [['F5', 'F5', 116, 0], ['+', 'Equal', 187, 10]]);
});
