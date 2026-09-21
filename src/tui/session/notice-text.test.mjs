import assert from 'node:assert/strict';
import test from 'node:test';
import { polishNoticeText } from './notice-text.mjs';

test('failed notices resolve their action through the known-action table, case-insensitively', () => {
  assert.equal(polishNoticeText('api key save failed: bad key'), 'Couldn’t save API key: bad key');
  assert.equal(polishNoticeText('mcp toggle failed'), 'Couldn’t toggle MCP server.');
  assert.equal(polishNoticeText('Plugin Add failed'), 'Couldn’t add plugin.');
  assert.equal(polishNoticeText('OpenAI usage auth save failed'), 'Couldn’t save OpenAI usage auth.');
  assert.equal(polishNoticeText('plugin MCP enable failed'), 'Couldn’t enable plugin MCP.');
});

test('an unknown action falls back to its verb suffix, then to the raw action', () => {
  assert.equal(polishNoticeText('widget update failed'), 'Couldn’t update widget.');
  assert.equal(polishNoticeText('widget reconnect failed: gone'), 'Couldn’t reconnect widget: gone');
  assert.equal(polishNoticeText('mystery failed'), 'Couldn’t mystery.');
});

test('busy notices reuse the same action polish with a sentence start', () => {
  assert.equal(polishNoticeText('compact already in progress'), 'Compact context is already running.');
  assert.equal(polishNoticeText('widget update already in progress.'), 'Update widget is already running.');
});

test('non-failure notices keep their own shapes', () => {
  assert.equal(polishNoticeText('✓ saved'), 'saved');
  assert.equal(polishNoticeText('Error: could not reach daemon: timeout'), 'Couldn’t reach daemon: timeout');
  assert.equal(polishNoticeText('A key is required for login'), 'A key required for login.');
  assert.equal(polishNoticeText(''), '');
  assert.equal(polishNoticeText('plain note'), 'plain note');
});
