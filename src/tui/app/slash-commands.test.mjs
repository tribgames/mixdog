import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeSlashCommandName, overlayBlocksGlobalTranscriptScroll, slashArgumentHint } from './slash-commands.mjs';

test('a command name resolves through its aliases, and an unknown one stays as typed', () => {
  assert.equal(normalizeSlashCommandName('clear'), 'clear');
  assert.equal(normalizeSlashCommandName('NEW'), 'clear');
  assert.equal(normalizeSlashCommandName('Projects'), 'project');
  assert.equal(normalizeSlashCommandName('config'), 'settings');
  assert.equal(normalizeSlashCommandName('nope'), 'nope');
  assert.equal(normalizeSlashCommandName(''), '');
  assert.equal(normalizeSlashCommandName(undefined), '');
});

test('an open prompt-owned overlay such as the /btw panel owns PageUp/PageDown and wheel scroll', () => {
  assert.equal(overlayBlocksGlobalTranscriptScroll({ btwPanel: true }), true);
  assert.equal(overlayBlocksGlobalTranscriptScroll({ picker: {} }), true);
  assert.equal(overlayBlocksGlobalTranscriptScroll({}), false);
  assert.equal(overlayBlocksGlobalTranscriptScroll(), false);
});

test('the argument hint comes from the resolved command, only after a trailing space', () => {
  assert.equal(slashArgumentHint('/model '), '/model [name|refresh]');
  assert.equal(slashArgumentHint('/autoclear '), '/autoclear [on|off|duration|unlimited]');
  assert.equal(slashArgumentHint('/projects '), '/project [path]');
  assert.equal(slashArgumentHint('/clear '), '');
  assert.equal(slashArgumentHint('/nope '), '');
  assert.equal(slashArgumentHint('/model'), '');
  assert.equal(slashArgumentHint('/model x '), '');
  assert.equal(slashArgumentHint(''), '');
});
