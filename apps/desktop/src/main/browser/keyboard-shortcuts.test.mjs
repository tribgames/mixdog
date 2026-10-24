import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserInputDriver } from './input.ts';

test('function keys and a literal plus survive key parsing with their modifiers', async () => {
  const events = [];
  const driver = createBrowserInputDriver(async (_guest, _method, params) => {
    events.push(params);
    return 'completed';
  });
  await driver.pressKey({}, 'F5');
  await driver.pressKey({}, 'Control+Shift++');
  assert.deepEqual(
    events
      .filter((event) => event.type === 'rawKeyDown')
      .map((event) => [event.key, event.code, event.windowsVirtualKeyCode, event.modifiers]),
    [
      ['F5', 'F5', 116, 0],
      ['+', 'Equal', 187, 10],
    ]
  );
});

test('a letter shortcut names its own key, never Shift plus that key', async () => {
  const events = [];
  const driver = createBrowserInputDriver(async (_guest, _method, params) => {
    events.push(params);
    return 'completed';
  });

  await driver.pressKey({}, 'Control+A');

  const down = events.find((event) => event.type === 'rawKeyDown');
  assert.deepEqual([down.key, down.code, down.windowsVirtualKeyCode, down.modifiers], ['A', 'KeyA', 65, 2]);
  assert.equal(
    events.some((event) => event.type === 'char'),
    false,
    'select-all is a shortcut, so it types nothing'
  );
});

test('Command+A supplies the macOS editor select-all command without typing or changing other shortcuts', async () => {
  const events = [];
  const driver = createBrowserInputDriver(async (_guest, _method, params) => {
    events.push(params);
    return 'completed';
  });
  await driver.pressKey({}, 'Meta+A');
  await driver.pressKey({}, 'Control+A');
  const downs = events.filter((event) => event.type === 'rawKeyDown');
  assert.deepEqual(downs[0].commands, process.platform === 'darwin' ? ['selectAll'] : undefined);
  assert.equal(downs[1].commands, undefined);
  assert.equal(events.some((event) => event.type === 'char'), false);
});

test('punctuation presses carry their real key codes and only Shift still types', async () => {
  const events = [];
  const driver = createBrowserInputDriver(async (_guest, _method, params) => {
    events.push(params);
    return 'completed';
  });
  await driver.pressKey({}, '.');
  await driver.pressKey({}, '!');
  await driver.pressKey({}, 'Control+Enter');
  assert.deepEqual(
    events
      .filter((event) => event.type === 'rawKeyDown')
      .map((event) => [event.key, event.code, event.windowsVirtualKeyCode, event.modifiers]),
    [
      ['.', 'Period', 190, 0],
      ['!', 'Digit1', 49, 8],
      ['Enter', 'Enter', 13, 2],
    ]
  );
  assert.deepEqual(
    events.filter((event) => event.type === 'char').map((event) => event.text),
    ['.', '!']
  );
});

test('the page guard stops an Enter before its key-down; once down, a navigating submit still gets its key-up', async () => {
  const events = [];
  const driver = createBrowserInputDriver(async (_guest, _method, params, _signal, beforeDispatch) => {
    beforeDispatch?.();
    events.push(params.type);
    return 'completed';
  });
  let url = 'https://a.test/';
  const guard = () => {
    if (url !== 'https://a.test/') throw new Error('nothing was submitted');
  };
  url = 'https://b.test/';
  await assert.rejects(driver.pressKey({}, 'enter', undefined, guard), /nothing was submitted/);
  assert.deepEqual(events, []);

  url = 'https://a.test/';
  const navigating = createBrowserInputDriver(async (_guest, _method, params, _signal, beforeDispatch) => {
    beforeDispatch?.();
    events.push(params.type);
    if (params.type === 'char') url = 'https://b.test/'; // the submit navigates
    return 'completed';
  });
  await navigating.pressKey({}, 'enter', undefined, guard);
  assert.deepEqual(events, ['rawKeyDown', 'char', 'keyUp']);
});
