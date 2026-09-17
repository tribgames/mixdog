import assert from 'node:assert/strict';
import test from 'node:test';
import { bindEditorCommand } from './editor-command-binding.ts';

test('shared editor shortcuts follow the current tab without retaining or registering old callbacks', () => {
  const commands = [];
  const editor = { addCommand: (key, run) => commands.push({ key, run }) };
  const calls = [];
  let binding;
  for (let index = 0; index < 100; index++) {
    binding?.dispose();
    binding = bindEditorCommand(editor, 42, () => calls.push(index));
  }
  assert.equal(commands.length, 1);
  commands[0].run();
  assert.deepEqual(calls, [99]);
  binding.dispose();
  commands[0].run();
  assert.deepEqual(calls, [99], 'a hidden or closed tab must not handle the shortcut');
});

test('late tab cleanup cannot remove the replacement shortcut', () => {
  let invoke;
  const editor = { addCommand: (_key, run) => { invoke = run; } };
  const calls = [];
  const old = bindEditorCommand(editor, 42, () => calls.push('old'));
  const current = bindEditorCommand(editor, 42, () => calls.push('current'));
  old.dispose();
  invoke();
  assert.deepEqual(calls, ['current']);
  current.dispose();
});
