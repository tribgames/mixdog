import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { SETTINGS_ITEMS } from './settings/settings-items.ts';
import { SLASH_COMMANDS as desktopSlashCommands } from './slash-commands.ts';
import { SLASH_COMMANDS as tuiSlashCommands } from '../../../../src/tui/app/slash-commands.mjs';

function decodeStringEscapes(value) {
  return value.replace(
    /\\(?:u\{([0-9a-fA-F]+)\}|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|(\r?\n)|([^\r\n]))/g,
    (_match, codePoint, unicode, hex, lineContinuation, character) => {
      if (codePoint) return String.fromCodePoint(Number.parseInt(codePoint, 16));
      if (unicode) return String.fromCharCode(Number.parseInt(unicode, 16));
      if (hex) return String.fromCharCode(Number.parseInt(hex, 16));
      if (lineContinuation) return '';
      return ({
        b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', 0: '\0',
      })[character] ?? character;
    },
  );
}

function countTopLevelItemObjects(source) {
  let braceDepth = 0;
  let count = 0;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === '/' && source[index + 1] === '/') {
      const end = source.indexOf('\n', index + 2);
      index = end === -1 ? source.length : end;
      continue;
    }
    if (character === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2);
      assert.notEqual(end, -1, 'TUI settings picker must not contain an unterminated comment');
      index = end + 1;
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      let end = index + 1;
      while (end < source.length && source[end] !== character) {
        end += source[end] === '\\' ? 2 : 1;
      }
      assert.ok(end < source.length, 'TUI settings picker must not contain an unterminated string');
      index = end;
      continue;
    }
    if (character === '{') {
      if (braceDepth === 0) count += 1;
      braceDepth += 1;
    } else if (character === '}') {
      braceDepth -= 1;
      assert.ok(braceDepth >= 0, 'TUI settings picker item braces must be balanced');
    }
  }

  assert.equal(braceDepth, 0, 'TUI settings picker item braces must be balanced');
  return count;
}

function parseTuiSettingsItems(source) {
  const itemsDeclaration = source.match(/\bconst items = \[/);
  assert.ok(itemsDeclaration, 'TUI settings picker must declare an items array');

  const itemsStart = itemsDeclaration.index + itemsDeclaration[0].length;
  const itemsEnd = source.indexOf('\n    ];', itemsStart);
  assert.notEqual(itemsEnd, -1, 'TUI settings picker items array must close');

  const itemsSource = source.slice(itemsStart, itemsEnd);
  const expected = [...itemsSource.matchAll(
    /\{\s*value:\s*(?<valueQuote>['"])(?<value>(?:(?!\k<valueQuote>)[^\\]|\\.)*)\k<valueQuote>\s*,\s*label:\s*(?<labelQuote>['"])(?<label>(?:(?!\k<labelQuote>)[^\\]|\\.)*)\k<labelQuote>/g,
  )].map(({ groups }) => ({
    value: decodeStringEscapes(groups.value),
    label: decodeStringEscapes(groups.label),
  }));
  const itemCount = countTopLevelItemObjects(itemsSource);

  assert.equal(
    expected.length,
    itemCount,
    'every TUI settings item with a value must expose a parseable value and label',
  );
  return expected;
}

test('desktop settings items exactly match the TUI settings picker', async () => {
  const tuiSettingsPicker = await readFile(
    new URL('../../../../src/tui/app/settings-picker.mjs', import.meta.url),
    'utf8',
  );
  const expected = parseTuiSettingsItems(tuiSettingsPicker);

  assert.deepEqual(
    SETTINGS_ITEMS.map(({ value, label }) => ({ value, label })),
    expected,
  );
});

test('desktop slash commands exactly match the TUI slash-command registry', () => {
  const commandFields = (command) => Object.fromEntries(
    ['name', 'usage', 'aliases', 'aliasUsage', 'showAliasUsage', 'params', 'description']
      .filter((field) => Object.hasOwn(command, field))
      .map((field) => [field, command[field]]),
  );

  assert.deepEqual(
    desktopSlashCommands.map(commandFields),
    tuiSlashCommands.map(commandFields),
  );
});
