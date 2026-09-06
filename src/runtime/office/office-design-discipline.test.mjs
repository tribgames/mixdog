import test from 'node:test';
import assert from 'node:assert/strict';
import {
  contrastRatio,
  isSafeFontFamily,
  normalizePaletteTokens,
  normalizeTypographyTokens,
  saturatedHueFamilies,
} from './design/design-discipline.mjs';
import { resolveOfficeDesign } from './design/design-system.mjs';
import { reviewOfficeDesign } from './quality/design-review.mjs';
import { normalizeOfficeReviewIssues } from './quality/quality-pipeline.mjs';

process.env.MIXDOG_OOXML_VALIDATOR_DISABLED = '1';

test('design tokens replace unsafe typefaces and keep palettes readable', () => {
  const typography = normalizeTypographyTokens(
    { display: 'Aptos Display', body: 'Segoe UI', data: 'Courier New' },
    { display: 'Cambria', body: 'Calibri', data: 'Arial' },
  );
  assert.deepEqual(typography.typography, { display: 'Cambria', body: 'Calibri', data: 'Courier New' });
  assert.deepEqual(typography.replaced.map((entry) => entry.requested), ['Aptos Display', 'Segoe UI']);
  assert.equal(isSafeFontFamily('Consolas'), false);
  assert.equal(isSafeFontFamily('맑은 고딕'), true);
  assert.equal(isSafeFontFamily('Noto Sans KR'), true);
  assert.equal(isSafeFontFamily('Noto Sans'), true);
  assert.equal(isSafeFontFamily('본고딕'), true);

  const palette = normalizePaletteTokens({
    canvas: 'FFFFFF',
    ink: '111111',
    muted: 'A0A0A0',
    accent: '2563EB',
    accent2: 'F59E0B',
    surface: 'F1F5F9',
    surface2: 'E2E8F0',
    inverse: '000000',
    onAccent: 'FFFFFF',
    onInverse: 'FFFFFF',
  });
  assert.notEqual(palette.colors.inverse, '000000');
  assert.ok(contrastRatio(palette.colors.muted, palette.colors.surface2) >= 4.5);
  assert.ok(contrastRatio(palette.colors.accentLight, palette.colors.inverse2) >= 4.5);
  assert.ok(contrastRatio(palette.colors.accent2Deep, palette.colors.surface2) >= 4.5);
  assert.ok(palette.adjustments.some((entry) => entry.role === 'inverse'));
  assert.ok(palette.adjustments.some((entry) => entry.role === 'muted'));

  const design = resolveOfficeDesign('pptx', {
    typography: { display: 'Aptos Display', body: 'Consolas' },
    palette: { inverse: '#07080B' },
  });
  assert.equal(design.tokens.typography.display, 'Cambria');
  assert.equal(design.tokens.typography.body, 'Calibri');
  assert.equal(design.discipline.replacedFonts.length, 2);
  assert.notEqual(design.tokens.colors.inverse, '07080B');
  assert.equal(saturatedHueFamilies(['60A5FA', 'A3E635', 'A78BFA']).length, 3);
});

test('deck review blocks mixed typefaces, unsafe fonts, and rainbow accents from saved slides', () => {
  const slide = (index, shapes) => ({
    index,
    background: { color: '0B1220' },
    shapes: shapes.map((shape, shapeIndex) => ({
      index: shapeIndex + 1,
      type: 'p:sp',
      left: 40 + (shapeIndex * 20),
      top: 40 + (shapeIndex * 60),
      width: 300,
      height: 40,
      font: { size: 18 },
      ...shape,
    })),
  });
  const document = {
    slideWidth: 960,
    slideHeight: 540,
    slides: [
      slide(1, [{ text: 'Cover', fonts: ['Aptos Display'], colors: ['F5F7FA'] }]),
      slide(2, [
        { text: 'A', fonts: ['Aptos'], colors: ['60A5FA'] },
        { text: 'B', fonts: ['맑은 고딕'], colors: ['A3E635'] },
        { text: 'C', fonts: ['Consolas'], colors: ['A78BFA'] },
        { text: 'D', fonts: ['Calibri'], colors: ['F5F7FA'] },
      ]),
      slide(3, [{ text: 'Close', fonts: ['Calibri'], colors: ['F5F7FA'] }]),
    ],
  };
  const { issues } = reviewOfficeDesign({ format: 'pptx', document, design: { review: true } });
  const codes = issues.map((entry) => entry.code);
  assert.ok(codes.includes('font_family_overuse'));
  assert.ok(codes.includes('unsafe_font_family'));
  assert.ok(codes.includes('accent_hue_overuse'));
  const normalized = normalizeOfficeReviewIssues(issues);
  for (const code of ['font_family_overuse', 'unsafe_font_family', 'accent_hue_overuse']) {
    assert.equal(normalized.find((entry) => entry.code === code)?.severity, 'error');
  }
});
