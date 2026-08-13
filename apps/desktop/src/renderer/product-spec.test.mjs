import assert from 'node:assert/strict';
import test from 'node:test';
import {
  desktopSlashCommandDescription,
  resolveDesktopSlashCommand,
} from './slash-commands.ts';
import { SETTINGS_CATEGORIES } from './settings/settings-items.ts';

test('current slash-command and settings product choices', () => {
  const quitAlias = resolveDesktopSlashCommand('q');
  assert.equal(quitAlias?.action, 'close-task');
  assert.equal(desktopSlashCommandDescription(quitAlias), 'Close this task');
  assert.equal(
    SETTINGS_CATEGORIES.find((category) => category.value === 'context')?.items.includes('memory-cycles'),
    false,
  );
});
