import assert from 'node:assert/strict';
import test from 'node:test';
import { assertSafeComputerInput } from './guards.ts';
import { validateComputerToolArgs, toComputerHostCommand } from '../../../../../../src/runtime/computer-bridge/action-schema.mjs';

const checkHostCommands = (command) => {
  assertSafeComputerInput(command);
  for (const step of command.steps || []) {
    assertSafeComputerInput({ ...step, delivery: command.delivery });
  }
};

const verifyBoth = (args) => {
  assert.equal(validateComputerToolArgs(args), null);
  const command = toComputerHostCommand(args);
  assert.doesNotThrow(() => checkHostCommands(command));
};

test('tool and desktop gates accept the same Unicode boundary values', () => {
  verifyBoth({ action: 'verify', input: { window_id: 'hwnd:0x1', expect: [{ present: '😀'.repeat(4096) }] } });
  verifyBoth({ action: 'menu', input: { window_id: 'hwnd:0x1', path: ['😀'.repeat(512)] } });
  verifyBoth({ action: 'capture', input: { query: '😀'.repeat(4096) } });
  verifyBoth({ action: 'act', input: { window_id: 'hwnd:0x1', actions: [{ type: 'type', text: '😀'.repeat(30000) }] } });
  verifyBoth({ action: 'clipboard', input: { operation: 'write', text: '😀'.repeat(50000) } });
  for (const command of [
    { action: 'verify', expect: [{ present: '😀'.repeat(4097) }] },
    { action: 'invoke_menu', path: ['😀'.repeat(513)] },
    { action: 'type', text: '😀'.repeat(30001) },
    { action: 'clipboard_write', text: '😀'.repeat(50001) },
  ]) assert.throws(() => assertSafeComputerInput(command), /input_too_large/);
});

test('foreground typing keeps the same UTF-16 budget on both boundaries', () => {
  verifyBoth({ action: 'act', input: { window_id: 'hwnd:0x1', delivery: 'foreground', actions: [
    { type: 'type', text: '😀'.repeat(2000) },
  ] } });
  const args = { action: 'act', input: { window_id: 'hwnd:0x1', delivery: 'foreground', actions: [
    { type: 'type', text: '😀'.repeat(2001) },
  ] } };
  assert.match(validateComputerToolArgs(args), /4000 UTF-16 code units/);
  assert.throws(() => checkHostCommands(toComputerHostCommand(args)), /4000 UTF-16 code units/);
});
