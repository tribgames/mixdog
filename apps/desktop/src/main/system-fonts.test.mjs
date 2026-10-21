import assert from 'node:assert/strict';
import test from 'node:test';
import { listSystemFonts, parseFontFamilies } from './system-fonts.ts';

test('font listings become sorted, unique family names', () => {
  assert.deepEqual(
    parseFontFamilies('win32', 'Segoe UI\r\nArial\r\n맑은 고딕\r\nArial\r\n\r\n'),
    ['Arial', 'Segoe UI', '맑은 고딕'].sort((a, b) => a.localeCompare(b))
  );
  // fontconfig joins a family's localized names with commas.
  assert.deepEqual(parseFontFamilies('linux', 'DejaVu Sans\nNoto Sans CJK KR,Noto Sans CJK KR Bold\n'), [
    'DejaVu Sans',
    'Noto Sans CJK KR',
    'Noto Sans CJK KR Bold',
  ]);
  // Hidden macOS system faces start with a dot.
  assert.deepEqual(parseFontFamilies('darwin', '.SF NS\nHelvetica Neue\nMenlo'), ['Helvetica Neue', 'Menlo']);
  assert.deepEqual(parseFontFamilies('win32', `${'x'.repeat(101)}\nArial`), ['Arial']);
});

test('a platform without a listing answers an empty list (free text stays)', async () => {
  assert.deepEqual(await listSystemFonts('aix'), []);
});
