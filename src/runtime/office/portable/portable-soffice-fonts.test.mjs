import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { macFontConfig } from './portable-soffice.mjs';

// Headless LibreOffice on macOS reads fonts through its bundled fontconfig; a
// config that names no Mac folder drew every Hangul run as nothing.
test('the headless font config names every Mac font folder and the Office bundle Excel draws with', () => {
  const office = '/Applications/Microsoft Excel.app/Contents/Resources/DFonts';
  const config = macFontConfig('/tmp/cache & more', office);
  for (const directory of ['/System/Library/Fonts', '/Library/Fonts', join(homedir(), 'Library', 'Fonts'), office]) {
    assert.ok(config.includes(`<dir>${directory}</dir>`), directory);
  }
  assert.match(config, /<cachedir>\/tmp\/cache &amp; more<\/cachedir>/);
  assert.doesNotMatch(macFontConfig('/tmp/cache', ''), /DFonts/);
});
