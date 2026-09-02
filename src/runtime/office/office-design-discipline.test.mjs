import test from 'node:test';
import assert from 'node:assert/strict';
import {
  contrastRatio,
  isSafeFontFamily,
  normalizePaletteTokens,
  normalizeTypographyTokens,
  saturatedHueFamilies,
} from './design/design-discipline.mjs';
import { expandOfficeDesignOperations, resolveOfficeDesign } from './design/design-system.mjs';
import { applyOfficeCreativeBrief } from './design/design-creative-director.mjs';
import { pptxBackgroundSpec } from './design/pptx/design-pptx.mjs';
import { pptText } from './design/pptx/design-pptx-primitives.mjs';
import { reviewOfficeDesign } from './quality/design-review.mjs';
import { normalizeOfficeReviewIssues } from './quality/quality-pipeline.mjs';

process.env.MIXDOG_OOXML_VALIDATOR_DISABLED = '1';

function scene(elements, { kind = 'content', backgroundRole = '' } = {}) {
  return {
    op: 'compose_slide',
    kind,
    title: 'Retention rose after the onboarding change',
    ...(backgroundRole ? { backgroundRole } : {}),
    plan: {
      authoredScene: {
        units: 'percent',
        elements,
      },
    },
  };
}

function expand(operations, design = {}) {
  return expandOfficeDesignOperations({
    format: 'pptx',
    backend: 'mixdog-ooxml',
    created: true,
    operations,
    design: { review: false, ...design },
  });
}

const title = { id: 'title', type: 'text', role: 'title', x: 6, y: 8, w: 60, h: 14, text: 'Retention rose after the onboarding change', style: { fontRole: 'display', fontSize: 30, bold: true, colorRole: 'ink' } };
const chart = {
  id: 'proof',
  type: 'chart',
  role: 'evidence',
  x: 6,
  y: 30,
  w: 56,
  h: 56,
  chart: { type: 'column', categories: ['Q1', 'Q2'], series: [{ name: 'Retention', values: [61, 74] }] },
};
const note = { id: 'note', type: 'text', role: 'body', x: 66, y: 34, w: 28, h: 40, text: 'Cohorts that finished onboarding retained 13 points better.', style: { fontRole: 'body', fontSize: 14, colorRole: 'muted' } };

test('design tokens replace unsafe typefaces and keep palettes readable', () => {
  const typography = normalizeTypographyTokens(
    { display: 'Aptos Display', body: 'Segoe UI', data: 'Courier New' },
    { display: 'Cambria', body: 'Calibri', data: 'Arial' },
  );
  assert.deepEqual(typography.typography, { display: 'Cambria', body: 'Calibri', data: 'Courier New' });
  assert.deepEqual(typography.replaced.map((entry) => entry.requested), ['Aptos Display', 'Segoe UI']);
  assert.equal(isSafeFontFamily('Consolas'), false);
  assert.equal(isSafeFontFamily('맑은 고딕'), true);

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

test('authored scenes only accept palette roles and typography roles', () => {
  assert.throws(
    () => expand([scene([{ ...title, style: { ...title.style, fontRole: '', fontName: 'Aptos Display' } }, chart, note])]),
    /AUTHORED_SCENE_FONT_ROLE_REQUIRED/,
  );
  assert.throws(
    () => expand([scene([{ ...title, style: { ...title.style, colorRole: '', color: '60A5FA' } }, chart, note])]),
    /AUTHORED_SCENE_COLOR_ROLE_REQUIRED/,
  );
  const expanded = expand([scene([
    { ...title, style: { ...title.style, fontRole: '', fontName: 'Calibri' } },
    chart,
    note,
  ])]);
  const titleBox = expanded.operations.find((entry) => entry.op === 'add_textbox');
  assert.equal(titleBox.properties.fontName, 'Calibri');
});

test('authored scenes repair accent and neutral text contrast, and reject the rest', () => {
  const dark = expand([scene([
    { ...title, style: { ...title.style, colorRole: 'onInverse' } },
    { id: 'label', type: 'text', role: 'eyebrow', x: 6, y: 4, w: 40, h: 4, text: 'PROOF', style: { fontRole: 'data', fontSize: 12, bold: true, colorRole: 'accent' } },
    chart,
    { ...note, style: { ...note.style, colorRole: 'ink' } },
  ], { backgroundRole: 'inverse' })]);
  const design = dark.design;
  const boxes = dark.operations.filter((entry) => entry.op === 'add_textbox');
  const label = boxes.find((entry) => entry.text === 'PROOF');
  assert.equal(label.properties.color, design.tokens.colors.accentLight);
  const body = boxes.find((entry) => entry.text.startsWith('Cohorts'));
  assert.ok(contrastRatio(body.properties.color, design.tokens.colors.inverse) >= 4.5);
  assert.ok(dark.semantic[0].plan.authoredScene.discipline.contrastRepairs.length >= 2);

  const healed = expand([scene([
    title,
    chart,
    { ...note, style: { ...note.style, colorRole: 'surface2' } },
  ])]);
  const healedBody = healed.operations.filter((entry) => entry.op === 'add_textbox').find((entry) => entry.text.startsWith('Cohorts'));
  assert.equal(healedBody.properties.color, healed.design.tokens.colors.ink);
  assert.throws(
    () => expand([scene([
      { ...title, style: { ...title.style, colorRole: 'onInverse' } },
      chart,
      { ...note, style: { ...note.style, colorRole: 'inverse2' } },
    ], { backgroundRole: 'inverse' })]),
    /AUTHORED_SCENE_TEXT_CONTRAST/,
  );
});

test('authored scenes reject top-heavy content and frame evidence images', () => {
  assert.throws(
    () => expand([scene([
      title,
      { ...chart, y: 24, h: 10 },
      { ...note, y: 24, h: 10 },
    ])]),
    /AUTHORED_SCENE_UNBALANCED_COMPOSITION/,
  );
  const framed = expand([scene([
    title,
    { id: 'shot', type: 'image', role: 'evidence', x: 6, y: 30, w: 56, h: 56, path: 'C:/evidence/app.png' },
    note,
  ])]);
  const imageIndex = framed.operations.findIndex((entry) => entry.op === 'add_image');
  const frame = framed.operations[imageIndex - 1];
  assert.equal(frame.op, 'add_shape');
  assert.equal(frame.shapeType, 'rounded_rectangle');
  assert.ok(frame.properties.width > framed.operations[imageIndex].width);
  assert.deepEqual(framed.semantic[0].plan.imageTreatments, [{ element: 'shot', treatment: 'contained-frame' }]);

  const cover = expand([scene([
    { ...title, x: 6, y: 30, w: 50, h: 30, layer: 2, style: { ...title.style, colorRole: 'onInverse' } },
    { id: 'hero', type: 'image', role: 'visual', x: 40, y: 0, w: 60, h: 100, layer: 1, allowBleed: true, path: 'C:/evidence/app.png' },
  ], { kind: 'cover', backgroundRole: 'inverse' })]);
  const heroIndex = cover.operations.findIndex((entry) => entry.op === 'add_image');
  const scrim = cover.operations[heroIndex + 1];
  assert.equal(scrim.op, 'add_shape');
  assert.equal(scrim.properties.fillTransparency, 45);
  assert.deepEqual(cover.semantic[0].plan.imageTreatments, [{ element: 'hero', treatment: 'scrim' }]);
});

test('soft review repairs hollow cards, drifting axes, uneven rows, and sliver lines', () => {
  const card = { id: 'card', type: 'shape', role: 'field', x: 60, y: 20, w: 34, h: 66, layer: 0, style: { fillRole: 'inverse' } };
  const hero = { id: 'hero', type: 'text', role: 'visual', x: 64, y: 26, w: 26, h: 12, layer: 1, text: '1.8억', style: { fontRole: 'display', fontSize: 40, bold: true, colorRole: 'onInverse' } };
  const label = { id: 'label', type: 'text', role: 'meta', x: 64, y: 40, w: 20, h: 4, layer: 2, text: 'DECISION SIZE', style: { fontRole: 'data', fontSize: 12, bold: true, colorRole: 'accent' } };
  const rule = { id: 'rule', type: 'line', role: 'connector', x: 64, y: 48, w: 20, h: 0.5, layer: 3, style: { lineRole: 'accent', lineWidth: 2 } };
  const expanded = expand([scene([
    { ...title, x: 6, y: 20, w: 48, h: 16 },
    { id: 'body-a', type: 'text', role: 'body', x: 6.7, y: 40, w: 40, h: 10, text: 'Retention rose 13 points.', style: { fontRole: 'body', fontSize: 12, colorRole: 'ink' } },
    { id: 'body-b', type: 'text', role: 'body', x: 6.4, y: 52, w: 40, h: 10, text: 'Churn fell in every cohort.', style: { fontRole: 'body', fontSize: 14, colorRole: 'ink' } },
    { id: 'k1', type: 'shape', role: 'metric', x: 6, y: 66, w: 12, h: 12, text: '61%', style: { fillRole: 'surface', colorRole: 'ink', fontSize: 18 } },
    { id: 'k2', type: 'shape', role: 'metric', x: 20, y: 66, w: 12, h: 12, text: '74%', style: { fillRole: 'surface', colorRole: 'ink', fontSize: 18 } },
    { id: 'k3', type: 'shape', role: 'metric', x: 40, y: 66, w: 12, h: 12, text: '80%', style: { fillRole: 'surface', colorRole: 'ink', fontSize: 18 } },
    card,
    hero,
    label,
    rule,
  ])]);
  const plan = expanded.semantic[0].plan;
  const scenes = plan.authoredScene.elements;
  const byId = (id) => scenes.find((element) => element.id === id);
  const rules = plan.authoredScene.discipline.softRepairs.map((entry) => entry.rule);
  assert.ok(rules.includes('S2'), 'hollow card is repaired');
  assert.ok(byId('hero').style.fontSize > 40, 'hero grows toward callout scale');
  assert.equal(byId('rule').height, 0, 'sliver line snaps horizontal');
  assert.equal(byId('body-a').style.fontSize, 14, 'body copy is lifted to the role floor');
  assert.equal(byId('body-a').left, byId('body-b').left, 'left axes snap together');
  const k = ['k1', 'k2', 'k3'].map(byId);
  const gaps = [k[1].left - (k[0].left + k[0].width), k[2].left - (k[1].left + k[1].width)];
  assert.ok(Math.abs(gaps[0] - gaps[1]) < 0.5, 'row gutters are equalised');
  assert.equal(typeof plan.authoredScene.discipline.emphasis.primary, 'string');
});

test('anchor slides carry the art-direction motif when the composition leaves room', () => {
  const cover = expand([scene([
    { ...title, x: 6, y: 20, w: 52, h: 24, style: { ...title.style, fontSize: 36, colorRole: 'onInverse' } },
    { id: 'sub', type: 'text', role: 'subtitle', x: 6, y: 50, w: 48, h: 10, text: 'Onboarding decides retention.', style: { fontRole: 'body', fontSize: 18, colorRole: 'surface2' } },
  ], { kind: 'cover', backgroundRole: 'inverse' })], {
    artDirection: 'editorial-contrast',
    intent: 'Decide the onboarding investment',
  });
  const plan = cover.semantic[0].plan;
  assert.equal(plan.motif, 'oversized-numeral');
  const ghost = cover.operations.find((entry) => entry.op === 'add_textbox' && entry.properties.fontSize >= 150);
  assert.ok(ghost, 'oversized numeral is rendered behind the content layer');
  assert.ok(ghost.properties.left > 400, 'numeral sits away from the title column');

  const spread = expand([{
    op: 'compose_slide',
    kind: 'content',
    title: 'Retention rose after the onboarding change',
    metrics: [{ value: '74%', label: 'retained' }],
    plan: {
      regions: [
        { id: 'title', role: 'title', x: 6, y: 6, w: 60, h: 12 },
        { id: 'proof', role: 'metric', x: 6, y: 20, w: 30, h: 16 },
        { id: 'note', role: 'body', x: 40, y: 20, w: 40, h: 12 },
      ],
    },
  }]);
  const regionPlan = spread.semantic[0].plan;
  assert.ok(regionPlan.repairs.some((entry) => entry.action === 'spread-vertically'));
  assert.ok(regionPlan.regions.find((region) => region.id === 'proof').top > 200, 'top-heavy regions are spread down the canvas');
});

test('emphasis mismatch blocks when body copy outweighs the evidence the brief names', () => {
  const heavyBody = scene([
    { ...title, w: 50, h: 14 },
    { ...chart, x: 60, y: 60, w: 30, h: 26 },
    { id: 'wall', type: 'text', role: 'body', x: 6, y: 24, w: 50, h: 62, text: 'A long explanation that dominates the page and keeps going. '.repeat(12), style: { fontRole: 'body', fontSize: 20, colorRole: 'ink' } },
  ]);
  heavyBody.creativeBrief = { focalPoint: 'evidence' };
  const expanded = expand([heavyBody]);
  const emphasis = expanded.semantic[0].plan.authoredScene.discipline.emphasis;
  assert.equal(emphasis.matches, false);
  assert.equal(emphasis.primary, 'wall');
  const balanced = scene([title, chart, note]);
  balanced.creativeBrief = { focalPoint: 'evidence' };
  assert.equal(expand([balanced]).semantic[0].plan.authoredScene.discipline.emphasis.matches, true);
  assert.equal(normalizeOfficeReviewIssues([{ code: 'emphasis_mismatch', path: '/slide[2]', message: 'x' }])[0].severity, 'error');
});

test('statement slides take the sandwich beat unless the directed inverse slide sits next to them', () => {
  const design = resolveOfficeDesign('pptx', { profile: 'technical' });
  assert.equal(pptxBackgroundSpec({}, design, 'statement', 2).backgroundRole, 'inverse');
  assert.equal(pptxBackgroundSpec({}, design, 'process', 3).backgroundRole, 'canvas');
  assert.equal(pptxBackgroundSpec({ slideRole: 'content' }, design, 'statement', 2).backgroundRole, 'canvas');
  const creative = {
    briefs: [
      { operationIndex: 0, role: 'stakes' },
      { operationIndex: 1, role: 'choice' },
      { operationIndex: 2, role: 'stakes' },
      { operationIndex: 3, role: 'stakes' },
    ],
  };
  const operations = [
    { op: 'compose_slide', kind: 'statement', title: 'Beside the choice' },
    { op: 'compose_slide', kind: 'comparison', title: 'Choice' },
    { op: 'compose_slide', kind: 'process', title: 'Steps' },
    { op: 'compose_slide', kind: 'statement', title: 'Standing alone' },
  ];
  const directed = operations.map((operation, index) => applyOfficeCreativeBrief(operation, creative, index, operations));
  assert.equal(directed[0].slideRole, 'content');
  assert.equal(directed[1].backgroundRole, 'inverse');
  assert.equal(directed[3].slideRole, undefined);
});

test('text boxes keep an overhang inset on the far side of their alignment', () => {
  assert.equal(pptText(1, 'x', { fontSize: 38 }).properties.marginRight, 13);
  assert.equal(pptText(1, 'x', { fontSize: 38 }).properties.marginLeft, 0);
  const right = pptText(1, 'x', { fontSize: 38, alignment: 'right' }).properties;
  assert.equal(right.marginLeft, 13);
  assert.equal(right.marginRight, 0);
  assert.equal(pptText(1, 'x', { fontSize: 38, marginRight: 24 }).properties.marginRight, 24);
  const paragraphs = pptText(1, '', {}, [{ text: 'a', fontSize: 20 }]).properties;
  assert.equal(paragraphs.marginRight, 7);
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
