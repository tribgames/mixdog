import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeSlashCommandName,
  overlayBlocksGlobalTranscriptScroll,
  slashArgumentHint,
} from './slash-commands.mjs';
import { BTW_CHROME_ROWS, btwContentRows, btwPanelRows, btwScrollMax, btwScrollOffset } from './btw-controller.mjs';

test('a command name resolves through its aliases, and an unknown one stays as typed', () => {
  assert.equal(normalizeSlashCommandName('clear'), 'clear');
  assert.equal(normalizeSlashCommandName('NEW'), 'clear', 'aliases resolve to the canonical name');
  assert.equal(normalizeSlashCommandName('Projects'), 'project');
  assert.equal(normalizeSlashCommandName('nope'), 'nope');
  assert.equal(normalizeSlashCommandName(''), '');
  assert.equal(normalizeSlashCommandName(undefined), '');
});

test('an open /btw panel owns PageUp/PageDown and wheel scroll', () => {
  assert.equal(overlayBlocksGlobalTranscriptScroll({ btwPanel: true }), true);
  assert.equal(overlayBlocksGlobalTranscriptScroll({}), false);
});

test('btw scroll offsets page by one row less than the body, clamped to the content', () => {
  assert.equal(btwScrollMax(30, 10), 20);
  assert.equal(btwScrollMax(5, 10), 0);
  assert.equal(btwScrollOffset({ pageDown: true }, 0, 10, 30), 9);
  assert.equal(btwScrollOffset({ pageDown: true }, 18, 10, 30), 20);
  assert.equal(btwScrollOffset({ pageUp: true }, 5, 10, 30), 0);
  assert.equal(btwScrollOffset({ pageUp: true }, 20, 10, 30), 11);
  assert.equal(btwScrollOffset({}, 50, 10, 30), 20);
  const long = { question: 'q', status: 'done', text: Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n\n') };
  assert.ok(btwContentRows(long, 80) > 10, 'a long answer is taller than the 10-row panel body');
  assert.equal(btwPanelRows(long, 80), BTW_CHROME_ROWS + 10, 'panel height stays capped');
});

test('the argument hint comes from the resolved command, only after a trailing space', () => {
  assert.equal(slashArgumentHint('/model '), '/model [name|refresh]');
  assert.equal(slashArgumentHint('/autoclear '), '/autoclear [on|off|duration|unlimited]');
  assert.equal(slashArgumentHint('/projects '), '/project [path]', 'an alias hints the canonical command');
  assert.equal(slashArgumentHint('/clear '), '', 'a command without params has no hint');
  assert.equal(slashArgumentHint('/nope '), '');
  assert.equal(slashArgumentHint('/model'), '', 'no trailing space is still the command token');
  assert.equal(slashArgumentHint('/model x '), '');
  assert.equal(slashArgumentHint(''), '');
});
