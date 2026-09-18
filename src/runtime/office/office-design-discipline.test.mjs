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
    { display: 'Cambria', body: 'Calibri', data: 'Arial' }
  );
  assert.deepEqual(typography.typography, { display: 'Cambria', body: 'Calibri', data: 'Courier New' });
  assert.deepEqual(
    typography.replaced.map((entry) => entry.requested),
    ['Aptos Display', 'Segoe UI']
  );
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
  // The four state colors derive when a pack sets none: the word clears the canvas, the light panel, and its own
  // field; the mark clears the canvas; and the words and fields add no saturated hue family beside the accents.
  for (const role of ['positive', 'warning', 'critical', 'informative']) {
    for (const field of ['FFFFFF', 'E2E8F0', palette.colors[`${role}Weak`]]) {
      assert.ok(contrastRatio(palette.colors[`${role}Text`], field) >= 4.5, `${role} text on ${field}`);
    }
    assert.ok(contrastRatio(palette.colors[role], 'FFFFFF') >= 3, `${role} mark on the canvas`);
  }
  const accents = saturatedHueFamilies([palette.colors.accent, palette.colors.accent2]).length;
  const withStates = saturatedHueFamilies([
    palette.colors.accent,
    palette.colors.accent2,
    ...['positive', 'warning', 'critical', 'informative'].flatMap((role) => [
      palette.colors[`${role}Text`],
      palette.colors[`${role}Weak`],
    ]),
  ]).length;
  assert.equal(withStates, accents, 'state words and fields stay under the saturated band');
  assert.equal(
    normalizePaletteTokens({ canvas: 'FFFFFF', ink: '111111', critical: 'B00020' }).colors.critical,
    'B00020',
    'a pack-set state color is kept'
  );

  // onAccent carries 10pt table values in the composers, so it clears the
  // readable minimum. A mid-toned accent cannot be answered by lightening
  // white any further: the repair has to reach for dark ink instead.
  for (const accent of ['73A527', '27A56A', 'D89224', '1F7A55']) {
    const repaired = normalizePaletteTokens({
      canvas: 'F8F9F6',
      ink: '17221C',
      muted: '66716B',
      accent,
      inverse: '132C24',
      onAccent: 'FFFFFF',
      onInverse: 'FFFFFF',
    }).colors;
    assert.ok(
      contrastRatio(repaired.onAccent, repaired.accent) >= 4.5,
      `${repaired.onAccent} on ${accent} measured ${contrastRatio(repaired.onAccent, repaired.accent)}`
    );
  }

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

// A page that fits its words is not a page anyone reads from a seat: past every
// reference body page and covering half the canvas, it is a document projected.
test('deck review reports a slide that projects a wall of prose', () => {
  const prose = '야간 출고는 묶음 단위로 실어 대기가 길어졌고 도크별 분할 이후 대기가 사라졌다. '.repeat(20);
  const document = {
    slideWidth: 960,
    slideHeight: 540,
    slides: [
      {
        index: 1,
        shapes: [{ index: 1, type: 'p:sp', left: 50, top: 40, width: 860, height: 60, text: '운영 보고', font: { size: 30 } }],
      },
      {
        index: 2,
        shapes: [
          { index: 1, type: 'p:sp', left: 50, top: 36, width: 860, height: 50, text: '지난 분기 요약', font: { size: 28 } },
          { index: 2, type: 'p:sp', left: 50, top: 110, width: 860, height: 360, text: prose, font: { size: 12 } },
        ],
      },
      {
        index: 3,
        shapes: [
          { index: 1, type: 'p:sp', left: 50, top: 36, width: 860, height: 50, text: '표로 본 분기', font: { size: 28 } },
          {
            index: 2,
            type: 'p:graphicFrame',
            left: 50,
            top: 110,
            width: 860,
            height: 360,
            text: prose,
            table: { rows: 8, columns: 4 },
          },
        ],
      },
    ],
  };
  const { issues } = reviewOfficeDesign({ format: 'pptx', document, design: { review: true } });
  const walls = issues.filter((entry) => entry.code === 'slide_text_dense');
  assert.equal(walls.length, 1, issues.map((entry) => `${entry.code}${entry.path}`).join(', '));
  assert.equal(walls[0].path, '/slide[2]');
  // The same words inside a table are a table, not a wall: the carrier reads them.
  assert.ok(!walls.some((entry) => entry.path === '/slide[3]'));
});

// A row of peers is one set to the reader: the odd size reads as a mistake, and
// the page's own geometry is what says which boxes form the row.
test('deck review reports a row of peers whose type does not match', () => {
  const box = (index, left, top, width, height, text, size) => ({
    index,
    type: 'p:sp',
    left,
    top,
    width,
    height,
    text,
    font: { size },
    fonts: ['Noto Sans KR'],
  });
  const document = {
    slideWidth: 960,
    slideHeight: 540,
    slides: [
      { index: 1, shapes: [box(1, 60, 190, 640, 100, '표지', 40)] },
      {
        index: 2,
        shapes: [
          box(1, 50, 36, 860, 64, '도입 전후 비교', 30),
          box(2, 50, 144, 400, 44, '도입 전', 20),
          box(3, 500, 144, 400, 44, '도입 후', 18),
          box(4, 50, 202, 400, 115, '묶음으로 실어 대기가 길었다', 14),
          box(5, 500, 202, 400, 115, '도크별로 나눠 대기가 사라졌다', 14),
        ],
      },
    ],
  };
  const { issues } = reviewOfficeDesign({ format: 'pptx', document, design: { review: true } });
  const peer = issues.find((entry) => entry.code === 'peer_style_inconsistent');
  assert.ok(peer, issues.map((entry) => entry.code).join(', '));
  assert.match(peer.message, /column-title boxes are set at 18 \/ 20 pt/);
  assert.equal(peer.path, '/slide[2]');

  // A narrow label beside the sentence it introduces is not a row of peers: they
  // hold different columns, and reading them as one set reported the grammar a
  // shipped deck had right on every one of its rows.
  const labelled = reviewOfficeDesign({
    format: 'pptx',
    document: {
      slideWidth: 960,
      slideHeight: 540,
      slides: [
        { index: 1, shapes: [box(1, 60, 190, 640, 100, '표지', 40)] },
        {
          index: 2,
          shapes: [
            box(1, 43, 73, 873, 54, '모델 선택부터 작업 기억까지 연결한다', 36),
            box(2, 61, 178, 140, 42, '모델 선택', 27),
            box(3, 252, 168, 665, 40, '역할에 맞게 모델을 지정한다', 22),
            box(4, 61, 276, 140, 42, '작업 분담', 27),
            box(5, 252, 267, 665, 40, '병렬 작업을 조율한다', 22),
          ],
        },
      ],
    },
    design: { review: true },
  }).issues;
  assert.deepEqual(
    labelled.filter((entry) => entry.code === 'peer_style_inconsistent'),
    []
  );
});

test('deck review blocks mixed typefaces, unsafe fonts, and rainbow accents from saved slides', () => {
  const slide = (index, shapes) => ({
    index,
    background: { color: '0B1220' },
    shapes: shapes.map((shape, shapeIndex) => ({
      index: shapeIndex + 1,
      type: 'p:sp',
      left: 40 + shapeIndex * 20,
      top: 40 + shapeIndex * 60,
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
