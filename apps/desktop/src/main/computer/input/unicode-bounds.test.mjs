import assert from 'node:assert/strict';
import test from 'node:test';
import { assertSafeComputerInput } from './guards.ts';

const emoji = (count) => '\u{1F600}'.repeat(count);

test('the desktop guard counts Unicode boundary values by code point', () => {
  for (const command of [
    { action: 'verify', expect: [{ present: emoji(4096) }] },
    { action: 'invoke_menu', path: [emoji(512)] },
    { action: 'type', text: emoji(30000) },
    { action: 'clipboard_write', text: emoji(50000) },
  ])
    assert.doesNotThrow(() => assertSafeComputerInput(command), command.action);
  for (const command of [
    { action: 'verify', expect: [{ present: emoji(4097) }] },
    { action: 'invoke_menu', path: [emoji(513)] },
    { action: 'type', text: emoji(30001) },
    { action: 'clipboard_write', text: emoji(50001) },
  ])
    assert.throws(() => assertSafeComputerInput(command), /input_too_large/, command.action);
});

test('a capture query is bounded at 4,096 code points', () => {
  assert.doesNotThrow(() => assertSafeComputerInput({ action: 'capture', query: emoji(4096) }));
  assert.throws(() => assertSafeComputerInput({ action: 'capture', query: emoji(4097) }), /input_too_large: query/);
});

test('foreground typing is bounded at 4,000 UTF-16 code units: 2,000 emoji pass, 2,001 do not', () => {
  const type = (text) => ({ action: 'type', delivery: 'foreground', window_id: 'hwnd:0x1', text });
  assert.doesNotThrow(() => assertSafeComputerInput(type(emoji(2000))));
  assert.throws(() => assertSafeComputerInput(type(emoji(2001))), /foreground text exceeds 4000 UTF-16 code units/);
});
