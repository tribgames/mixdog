import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeSlashCommandName, slashArgumentHint } from './slash-commands.mjs';

test('a command name resolves through its aliases, and an unknown one stays as typed', () => {
  assert.equal(normalizeSlashCommandName('clear'), 'clear');
  assert.equal(normalizeSlashCommandName('NEW'), 'clear', 'aliases resolve to the canonical name');
  assert.equal(normalizeSlashCommandName('Projects'), 'project');
  assert.equal(normalizeSlashCommandName('nope'), 'nope');
  assert.equal(normalizeSlashCommandName(''), '');
  assert.equal(normalizeSlashCommandName(undefined), '');
});

test('the argument hint comes from the resolved command, only after a trailing space', () => {
  assert.equal(slashArgumentHint('/model '), '/model [name|refresh]');
  assert.equal(slashArgumentHint('/autoclear '), '/autoclear [on|off|duration]');
  assert.equal(slashArgumentHint('/projects '), '/project [path]', 'an alias hints the canonical command');
  assert.equal(slashArgumentHint('/clear '), '', 'a command without params has no hint');
  assert.equal(slashArgumentHint('/nope '), '');
  assert.equal(slashArgumentHint('/model'), '', 'no trailing space is still the command token');
  assert.equal(slashArgumentHint('/model x '), '');
  assert.equal(slashArgumentHint(''), '');
});
