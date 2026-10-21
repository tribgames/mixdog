import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { SKIN_MANIFEST } from './skin-manifest';

const skinsDir = new URL('./skins/', import.meta.url);
const PLACEHOLDER = /unknown|unverified|tbd|todo|n\/a|to be replaced|^-+$/i;
const IMAGE = /\.(jpe?g|png|webp|avif|gif|svg)$/i;

test('every picture in skins/ has an ATTRIBUTION row', () => {
  const sheet = readFileSync(new URL('ATTRIBUTION.md', skinsDir), 'utf8');
  const rows = sheet.split('\n').filter((line) => line.startsWith('|'));
  const images = readdirSync(skinsDir).filter((name) => IMAGE.test(name));
  assert.ok(images.length > 0);
  for (const name of images) {
    const row = rows.find((line) => line.split('|')[1]?.trim() === name);
    assert.ok(row, `${name} has no row in skins/ATTRIBUTION.md`);
    const [source, tool, author, licence, date] = row
      .split('|')
      .slice(2, 7)
      .map((cell) => cell.trim());
    const label = `${name}: ${row}`;
    for (const cell of [source, tool, author, licence, date]) {
      assert.ok(cell, `${label} has an empty field`);
      assert.doesNotMatch(cell, PLACEHOLDER, `${label} has a placeholder field`);
    }
    assert.match(date, /^\d{4}-\d{2}-\d{2}$/, `${label} date must be YYYY-MM-DD`);
    // Only our own generated art, or CC0 with a source URL, may ship.
    const generated = /^generated for Mixdog$/i.test(source) && /project/i.test(licence);
    const cc0 = /^https?:\/\/\S+$/.test(source) && /^CC0\b/i.test(licence);
    assert.ok(generated || cc0, `${label}: provenance must be generated-for-Mixdog or CC0 with a source URL`);
  }
});

test('the manifest names real pictures with complete data', () => {
  for (const entry of SKIN_MANIFEST) {
    assert.ok(existsSync(new URL(entry.file, skinsDir)), entry.file);
    assert.match(entry.focal, /^\d{1,3}% \d{1,3}%$/);
    assert.match(entry.accent, /^#[0-9a-f]{6}$/);
    assert.ok(['light', 'dark', 'tint'].includes(entry.plate));
    assert.ok(entry.cast.hue >= 0 && entry.cast.hue < 360 && entry.cast.sat >= 0 && entry.cast.sat <= 100);
  }
});
