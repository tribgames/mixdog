import assert from 'node:assert/strict';
import test from 'node:test';

import { SLASH_COMMANDS as tuiSlashCommands } from '../../../../src/tui/app/slash-commands.mjs';
import { DESKTOP_ONLY_COMMANDS, assertSlashInventoryMatches } from '../../scripts/slash-inventory.mjs';
import { SLASH_COMMANDS as desktopSlashCommands } from './slash-commands.ts';

test('desktop slash commands match the TUI registry', () => {
  assertSlashInventoryMatches(desktopSlashCommands, tuiSlashCommands);
});

test('the desktop-only allowlist is exactly connect and is declared on desktop', () => {
  assert.deepEqual(DESKTOP_ONLY_COMMANDS, ['connect']);
  assert.ok(desktopSlashCommands.some((command) => command.name === 'connect'));
});

test('a desktop-only command is excluded only on the desktop side', () => {
  const extra = { name: 'connect', usage: '/connect', description: 'x' };
  assertSlashInventoryMatches([...tuiSlashCommands, extra], tuiSlashCommands, ['connect']);
});

test('a desktop command outside the allowlist still fails', () => {
  const extra = { name: 'other', usage: '/other', description: 'x' };
  assert.throws(() => assertSlashInventoryMatches([...tuiSlashCommands, extra], tuiSlashCommands, ['connect']));
});

test('a TUI-only command still fails', () => {
  assert.throws(() => assertSlashInventoryMatches(tuiSlashCommands.slice(1), tuiSlashCommands, ['connect']));
});

test('a field difference still fails', () => {
  const changed = tuiSlashCommands.map((command, index) => (index ? command : { ...command, description: 'changed' }));
  assert.throws(() => assertSlashInventoryMatches(changed, tuiSlashCommands, ['connect']));
});

test('an allowlisted name that appears in the TUI registry fails as stale', () => {
  const tui = [...tuiSlashCommands, { name: 'connect', usage: '/connect', description: 'x' }];
  assert.throws(() => assertSlashInventoryMatches(tui, tui, ['connect']), /allowlist is stale/);
});
