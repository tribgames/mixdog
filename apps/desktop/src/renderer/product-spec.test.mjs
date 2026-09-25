import assert from 'node:assert/strict';
import test from 'node:test';
import { desktopSlashCommandDescription, resolveDesktopSlashCommand } from './slash-commands.ts';
import {
  SETTINGS_CATEGORIES,
  settingsCategoriesForSurface,
  settingsCategoryForSurface,
} from './settings/settings-items.ts';

test('current slash-command and settings product choices', () => {
  const quitAlias = resolveDesktopSlashCommand('q');
  assert.equal(quitAlias?.action, 'close-task');
  assert.equal(desktopSlashCommandDescription(quitAlias), 'Close this task');
  assert.equal(resolveDesktopSlashCommand('goal')?.action, 'goal');
  assert.equal(
    SETTINGS_CATEGORIES.find((category) => category.value === 'context')?.items.includes('memory-cycles'),
    false
  );
});

test('remote settings hide desktop-local credential categories', () => {
  assert.equal(settingsCategoriesForSurface(true), settingsCategoriesForSurface(true));
  const remoteCategories = settingsCategoriesForSurface(true).map((category) => category.value);
  assert.equal(remoteCategories.includes('providers'), false);
  assert.equal(remoteCategories.includes('mcp'), false);
  assert.equal(remoteCategories.includes('skills'), false);
  assert.equal(remoteCategories.includes('plugins'), false);
  assert.equal(settingsCategoryForSurface('providers', true), 'general');
  assert.equal(settingsCategoryForSurface('providers', false), 'providers');
  assert.equal(settingsCategoryForSurface('mcp', false), 'general');
});

test('developer settings are a local-only Support category ahead of shortcuts', () => {
  const developer = SETTINGS_CATEGORIES.find((category) => category.value === 'developer');
  assert.deepEqual(developer && { group: developer.group, items: [...developer.items] }, {
    group: 'Support',
    items: ['developer'],
  });
  const local = settingsCategoriesForSurface(false).map((category) => category.value);
  assert.ok(local.includes('developer'));
  assert.ok(local.indexOf('developer') < local.indexOf('shortcuts'));
  assert.equal(
    settingsCategoriesForSurface(true).some((category) => category.value === 'developer'),
    false
  );
  assert.equal(settingsCategoryForSurface('developer', true), 'general');
  assert.equal(settingsCategoryForSurface('developer', false), 'developer');
});
