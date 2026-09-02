import { createExecutiveRevisionElements } from './design-pptx-executive-revisions.mjs';
import { element, line, source, text } from './design-pptx-scene-builders.mjs';

export const EXECUTIVE_SCENE_GRAMMARS = Object.freeze([
  'editorial-native',
  'ledger-native',
  'signal-native',
]);

function shape(id, role, x, y, w, h, style = {}, shapeType = 'rectangle', extra = {}) {
  return element(id, 'shape', role, x, y, w, h, style, { shapeType, ...extra });
}

function editorialScene(index) {
  if (index === 0) {
    return [
      shape('halo', 'visual', 70, 5, 23, 41, {
        fillRole: 'accent',
        fillTransparency: 86,
        lineRole: 'accent',
        lineTransparency: 100,
      }, 'oval'),
      text('eyebrow', 'eyebrow', 6, 9, 42, 4, { fontSize: 12, bold: true, colorRole: 'accent' }),
      text('title', 'title', 6, 19, 55, 27, { display: true, fontSize: 36, bold: true, colorRole: 'onInverse' }),
      line('title-rule', 'connector', 6, 51, 19, 0.5, { lineColor: 'accent', lineWidth: 3 }),
      text('subtitle', 'subtitle', 6, 57, 51, 12, { fontSize: 17, colorRole: 'surface2' }),
      text('hero', 'visual', 68, 17, 26, 16, { display: true, fontSize: 52, bold: true, colorRole: 'onInverse', align: 'center' }),
      text('hero-label', 'meta', 70, 35, 22, 5, { fontSize: 12, bold: true, colorRole: 'accent', align: 'center' }),
      text('meta', 'meta', 6, 78, 48, 4, { fontSize: 12, colorRole: 'surface2' }),
      source('surface2'),
    ];
  }
  if (index === 1) {
    return [
      shape('primary-field', 'evidence', 6, 8, 43, 78, {
        fillRole: 'inverse',
        lineRole: 'inverse',
      }),
      text('metric-a-label', 'meta', 10, 17, 30, 5, { fontSize: 12, bold: true, colorRole: 'accent' }),
      text('metric-a', 'metric', 10, 31, 34, 18, { display: true, fontSize: 52, bold: true, colorRole: 'onInverse' }),
      text('metric-a-unit', 'body', 10, 53, 24, 5, { fontSize: 13, colorRole: 'surface2' }),
      line('primary-rule', 'connector', 10, 64, 24, 0.5, { lineColor: 'accent', lineWidth: 2 }),
      text('subtitle', 'subtitle', 10, 69, 32, 9, { fontSize: 14, colorRole: 'surface2' }),
      text('title', 'title', 57, 9, 37, 23, { display: true, fontSize: 31, bold: true, colorRole: 'ink' }),
      text('metric-b-label', 'meta', 57, 43, 16, 4, { fontSize: 12, bold: true, colorRole: 'muted' }),
      text('metric-b', 'metric', 57, 50, 15, 11, { display: true, fontSize: 32, bold: true, colorRole: 'ink' }),
      text('metric-b-unit', 'body', 57, 64, 15, 5, { fontSize: 12, colorRole: 'muted' }),
      line('support-rule', 'connector', 75, 42, 0.4, 31, { lineColor: 'accent2', lineWidth: 2 }),
      text('metric-c-label', 'meta', 79, 43, 15, 4, { fontSize: 12, bold: true, colorRole: 'muted' }),
      text('metric-c', 'metric', 79, 50, 15, 11, { display: true, fontSize: 32, bold: true, colorRole: 'accent2' }),
      text('metric-c-unit', 'body', 79, 64, 15, 7, { fontSize: 12, colorRole: 'muted' }),
      source('ink'),
    ];
  }
  if (index === 2) {
    return [
      text('title', 'title', 6, 8, 70, 15, { display: true, fontSize: 32, bold: true, colorRole: 'ink' }),
      element('chart', 'chart', 'evidence', 6, 28, 64, 56),
      line('insight-rule', 'connector', 74, 28, 0.4, 56, { lineColor: 'accent', lineWidth: 2 }),
      text('note-kicker', 'meta', 78, 29, 16, 5, { fontSize: 12, bold: true, colorRole: 'accent' }),
      text('note-a', 'body', 78, 40, 16, 10, { fontSize: 14, bold: true, colorRole: 'ink' }),
      text('note-b', 'body', 78, 55, 16, 10, { fontSize: 14, bold: true, colorRole: 'ink' }),
      text('note-c', 'body', 78, 70, 16, 11, { fontSize: 14, bold: true, colorRole: 'ink' }),
      source('ink'),
    ];
  }
  if (index === 3) {
    return [
      text('title', 'title', 6, 8, 84, 16, { display: true, fontSize: 32, bold: true, colorRole: 'onInverse' }),
      text('subtitle', 'subtitle', 6, 26, 63, 5, { fontSize: 15, colorRole: 'surface2' }),
      text('total-label', 'meta', 6, 39, 20, 4, { fontSize: 12, bold: true, colorRole: 'accent' }),
      text('total', 'visual', 6, 45, 20, 13, { display: true, fontSize: 42, bold: true, colorRole: 'onInverse' }),
      line('branch-main', 'connector', 25, 53, 69, 0.5, { lineColor: 'surface2', lineWidth: 1.5 }),
      line('branch-a', 'connector', 37, 50, 0.4, 6, { lineColor: 'accent', lineWidth: 2 }),
      line('branch-b', 'connector', 72, 50, 0.4, 6, { lineColor: 'accent2', lineWidth: 2 }),
      shape('track-a-field', 'evidence', 31, 40, 28, 36, {
        fillRole: 'accent',
        fillTransparency: 84,
        lineRole: 'accent',
        lineTransparency: 55,
      }, 'rounded_rectangle'),
      shape('track-b-field', 'evidence', 66, 40, 28, 36, {
        fillRole: 'accent2',
        fillTransparency: 85,
        lineRole: 'accent2',
        lineTransparency: 55,
      }, 'rounded_rectangle'),
      text('track-a-label', 'meta', 35, 45, 20, 5, { fontSize: 13, bold: true, colorRole: 'accent' }),
      text('track-a-value', 'metric', 35, 53, 20, 10, { display: true, fontSize: 30, bold: true, colorRole: 'onInverse' }),
      text('track-a-detail', 'body', 35, 66, 20, 6, { fontSize: 12, colorRole: 'surface2' }),
      text('track-b-label', 'meta', 70, 45, 20, 5, { fontSize: 13, bold: true, colorRole: 'accent2' }),
      text('track-b-value', 'metric', 70, 53, 20, 10, { display: true, fontSize: 30, bold: true, colorRole: 'onInverse' }),
      text('track-b-detail', 'body', 70, 66, 20, 6, { fontSize: 12, colorRole: 'surface2' }),
      source('surface2'),
    ];
  }
  if (index === 4) {
    const positions = [14, 38, 62, 86];
    return [
      text('title', 'title', 6, 8, 77, 15, { display: true, fontSize: 32, bold: true, colorRole: 'ink' }),
      text('timeline-kicker', 'meta', 75, 12, 19, 4, { fontSize: 12, bold: true, colorRole: 'accent2', align: 'right' }),
      line('timeline', 'evidence', 10, 49, 80, 0.5, { lineColor: 'ink', lineTransparency: 42, lineWidth: 2 }),
      ...positions.flatMap((x, step) => {
        const above = step % 2 === 0;
        return [
          shape(`node-${step + 1}`, 'node', x - 2, 45, step === 3 ? 5.5 : 4.5, step === 3 ? 9 : 7.5, {
            fillRole: step === 3 ? 'accent2' : step === 0 ? 'accent' : 'canvas',
            lineRole: step === 3 ? 'accent2' : step === 0 ? 'accent' : 'ink',
            lineWidth: 2,
          }, 'oval'),
          line(`stem-${step + 1}`, 'connector', x, above ? 36 : 52, 0.35, 9, {
            lineColor: step === 3 ? 'accent2' : 'ink',
            lineTransparency: 35,
            lineWidth: 1.5,
          }),
          text(`phase-${step + 1}`, 'meta', x - 7, above ? 29 : 67, 14, 4, {
            fontSize: 13,
            bold: true,
            colorRole: step === 3 ? 'accent2' : step === 0 ? 'accent' : 'ink',
            align: 'center',
          }),
          text(`step-${step + 1}`, 'body', x - 9, above ? 34 : 73, 18, 5, {
            fontSize: 14,
            bold: true,
            colorRole: 'ink',
            align: 'center',
          }),
          text(`detail-${step + 1}`, 'body', x - 9, above ? 55 : 80, 18, 7, {
            fontSize: 12,
            colorRole: 'muted',
            align: 'center',
          }),
        ];
      }),
      source('ink'),
    ];
  }
  return [
    text('eyebrow', 'eyebrow', 6, 10, 34, 4, { fontSize: 12, bold: true, colorRole: 'accent' }),
    text('title', 'title', 6, 19, 56, 24, { display: true, fontSize: 36, bold: true, colorRole: 'onInverse' }),
    text('subtitle', 'subtitle', 6, 48, 55, 9, { fontSize: 16, colorRole: 'surface2' }),
    text('total', 'visual', 70, 13, 23, 15, { display: true, fontSize: 52, bold: true, colorRole: 'onInverse', align: 'center' }),
    shape('approval-field', 'field', 73, 31, 17, 8, { fillRole: 'accent', lineRole: 'accent' }, 'rounded_rectangle'),
    text('approval-label', 'meta', 74, 33, 15, 4, { fontSize: 12, bold: true, colorRole: 'onAccent', align: 'center' }),
    line('decision-rule', 'connector', 6, 62, 88, 0.5, { lineColor: 'surface2', lineTransparency: 30, lineWidth: 1.5 }),
    shape('track-a-field', 'evidence', 6, 68, 42, 14, {
      fillRole: 'accent',
      fillTransparency: 83,
      lineRole: 'accent',
      lineTransparency: 70,
    }, 'rounded_rectangle'),
    shape('track-b-field', 'evidence', 52, 68, 42, 14, {
      fillRole: 'accent2',
      fillTransparency: 84,
      lineRole: 'accent2',
      lineTransparency: 70,
    }, 'rounded_rectangle'),
    text('track-a-label', 'meta', 9, 72, 20, 4, { fontSize: 13, bold: true, colorRole: 'accent' }),
    text('track-a-value', 'metric', 34, 71, 11, 6, { fontSize: 20, bold: true, colorRole: 'onInverse', align: 'right' }),
    text('track-b-label', 'meta', 55, 72, 20, 4, { fontSize: 13, bold: true, colorRole: 'accent2' }),
    text('track-b-value', 'metric', 80, 71, 11, 6, { fontSize: 20, bold: true, colorRole: 'onInverse', align: 'right' }),
    source('surface2'),
  ];
}

function ledgerScene(index) {
  if (index === 0) {
    return [
      text('eyebrow', 'eyebrow', 6, 11, 40, 4, { fontSize: 12, bold: true, colorRole: 'accent' }),
      text('hero', 'visual', 6, 19, 38, 15, { display: true, fontSize: 54, bold: true, colorRole: 'onInverse' }),
      text('hero-label', 'meta', 7, 36, 28, 4, { fontSize: 12, bold: true, colorRole: 'surface2' }),
      line('ledger-rule', 'connector', 6, 46, 88, 0.5, { lineColor: 'accent', lineWidth: 2 }),
      text('title', 'title', 48, 19, 46, 24, { display: true, fontSize: 34, bold: true, colorRole: 'onInverse' }),
      text('subtitle', 'subtitle', 48, 55, 43, 12, { fontSize: 16, colorRole: 'surface2' }),
      text('meta', 'meta', 6, 78, 40, 4, { fontSize: 12, colorRole: 'surface2' }),
      source('surface2'),
    ];
  }
  if (index === 1) {
    return [
      text('title', 'title', 6, 8, 66, 16, { display: true, fontSize: 32, bold: true, colorRole: 'ink' }),
      text('subtitle', 'subtitle', 74, 10, 20, 8, { fontSize: 13, colorRole: 'muted', align: 'right' }),
      line('ledger-top', 'connector', 6, 27, 88, 0.5, { lineColor: 'ink', lineTransparency: 55, lineWidth: 1 }),
      text('metric-a-label', 'meta', 6, 37, 20, 4, { fontSize: 12, bold: true, colorRole: 'muted' }),
      text('metric-a', 'metric', 6, 45, 23, 14, { display: true, fontSize: 42, bold: true, colorRole: 'accent' }),
      text('metric-a-unit', 'body', 6, 62, 20, 4, { fontSize: 12, colorRole: 'muted' }),
      text('metric-b-label', 'meta', 39, 37, 20, 4, { fontSize: 12, bold: true, colorRole: 'muted' }),
      text('metric-b', 'metric', 39, 45, 20, 14, { display: true, fontSize: 42, bold: true, colorRole: 'ink' }),
      text('metric-b-unit', 'body', 39, 62, 20, 4, { fontSize: 12, colorRole: 'muted' }),
      text('metric-c-label', 'meta', 72, 37, 20, 4, { fontSize: 12, bold: true, colorRole: 'muted' }),
      text('metric-c', 'metric', 72, 45, 22, 14, { display: true, fontSize: 42, bold: true, colorRole: 'accent2' }),
      text('metric-c-unit', 'body', 72, 62, 22, 5, { fontSize: 12, colorRole: 'muted' }),
      source('ink'),
    ];
  }
  if (index === 2) {
    return [
      text('title', 'title', 6, 8, 35, 22, { display: true, fontSize: 31, bold: true, colorRole: 'ink' }),
      text('note-kicker', 'meta', 6, 38, 24, 4, { fontSize: 12, bold: true, colorRole: 'accent' }),
      text('note-a', 'body', 6, 46, 27, 9, { fontSize: 14, bold: true, colorRole: 'ink' }),
      text('note-b', 'body', 6, 59, 27, 9, { fontSize: 14, bold: true, colorRole: 'ink' }),
      text('note-c', 'body', 6, 72, 27, 9, { fontSize: 14, bold: true, colorRole: 'ink' }),
      element('chart', 'chart', 'evidence', 39, 16, 55, 68),
      source('ink'),
    ];
  }
  if (index === 3) {
    return [
      text('title', 'title', 6, 8, 61, 17, { display: true, fontSize: 31, bold: true, colorRole: 'onInverse' }),
      text('subtitle', 'subtitle', 70, 10, 24, 8, { fontSize: 14, colorRole: 'surface2', align: 'right' }),
      text('total-label', 'meta', 6, 36, 20, 4, { fontSize: 12, bold: true, colorRole: 'accent' }),
      text('total', 'visual', 6, 43, 20, 13, { display: true, fontSize: 40, bold: true, colorRole: 'onInverse' }),
      shape('track-a-field', 'evidence', 34, 34, 26, 42, { fillRole: 'surface', lineRole: 'accent' }),
      shape('track-b-field', 'evidence', 68, 34, 26, 42, { fillRole: 'surface', lineRole: 'accent2' }),
      text('track-a-label', 'meta', 38, 40, 18, 4, { fontSize: 12, bold: true, colorRole: 'accent' }),
      text('track-a-value', 'metric', 38, 49, 18, 9, { fontSize: 28, bold: true, colorRole: 'ink' }),
      text('track-a-detail', 'body', 38, 63, 18, 8, { fontSize: 12, colorRole: 'muted' }),
      text('track-b-label', 'meta', 72, 40, 18, 4, { fontSize: 12, bold: true, colorRole: 'accent2' }),
      text('track-b-value', 'metric', 72, 49, 18, 9, { fontSize: 28, bold: true, colorRole: 'ink' }),
      text('track-b-detail', 'body', 72, 63, 18, 8, { fontSize: 12, colorRole: 'muted' }),
      source('surface2'),
    ];
  }
  if (index === 4) {
    return [
      text('title', 'title', 6, 8, 76, 15, { display: true, fontSize: 31, bold: true, colorRole: 'ink' }),
      line('timeline', 'evidence', 10, 36, 80, 0.5, { lineColor: 'accent2', lineWidth: 3 }),
      ...[0, 1, 2, 3].flatMap((step) => {
        const x = [8, 31, 54, 77][step];
        return [
          shape(`node-${step + 1}`, 'node', x, 31, 5, 8, {
            fillRole: step === 3 ? 'accent2' : 'canvas',
            lineRole: step === 3 ? 'accent2' : 'ink',
            lineWidth: 2,
          }, 'oval'),
          text(`phase-${step + 1}`, 'meta', x, 43, 17, 4, { fontSize: 12, bold: true, colorRole: step === 3 ? 'accent2' : 'ink' }),
          text(`step-${step + 1}`, 'body', x, 50, 17, 6, { fontSize: 14, bold: true, colorRole: 'ink' }),
          text(`detail-${step + 1}`, 'body', x, 60, 17, 10, { fontSize: 12, colorRole: 'muted' }),
        ];
      }),
      source('ink'),
    ];
  }
  return [
    text('eyebrow', 'eyebrow', 6, 10, 35, 4, { fontSize: 12, bold: true, colorRole: 'accent' }),
    text('title', 'title', 6, 20, 80, 18, { display: true, fontSize: 35, bold: true, colorRole: 'onInverse' }),
    line('decision-rule', 'connector', 6, 44, 88, 0.5, { lineColor: 'accent', lineWidth: 2 }),
    text('total', 'visual', 6, 52, 24, 13, { display: true, fontSize: 46, bold: true, colorRole: 'onInverse' }),
    text('approval-label', 'meta', 7, 68, 20, 4, { fontSize: 12, bold: true, colorRole: 'accent' }),
    text('subtitle', 'subtitle', 39, 53, 55, 10, { fontSize: 17, colorRole: 'surface2' }),
    text('split', 'body', 39, 69, 52, 6, { fontSize: 14, bold: true, colorRole: 'onInverse' }),
    source('surface2'),
  ];
}

function signalScene(index) {
  if (index === 0 || index === 5) {
    return [
      shape('signal-field', 'visual', 5, 5, 90, 84, {
        fillRole: 'accent',
        fillTransparency: 92,
        lineRole: 'accent',
        lineTransparency: 75,
      }, 'rounded_rectangle'),
      text('eyebrow', 'eyebrow', 9, 11, 35, 4, { fontSize: 12, bold: true, colorRole: 'accent' }),
      text('title', 'title', 9, 22, 55, 26, { display: true, fontSize: 35, bold: true, colorRole: 'onInverse' }),
      text(index === 0 ? 'hero' : 'total', 'visual', 69, 20, 20, 14, { display: true, fontSize: 48, bold: true, colorRole: 'onInverse', align: 'center' }),
      text(index === 0 ? 'hero-label' : 'approval-label', 'meta', 70, 37, 18, 5, { fontSize: 12, bold: true, colorRole: 'accent', align: 'center' }),
      text('subtitle', 'subtitle', 9, 58, 58, 10, { fontSize: 16, colorRole: 'surface2' }),
      ...(index === 0
        ? [text('meta', 'meta', 9, 76, 36, 4, { fontSize: 12, colorRole: 'surface2' })]
        : [text('split', 'body', 9, 76, 64, 5, { fontSize: 14, bold: true, colorRole: 'onInverse' })]),
      source('surface2'),
    ];
  }
  if (index === 1) {
    return [
      text('title', 'title', 6, 8, 88, 15, { display: true, fontSize: 32, bold: true, colorRole: 'ink' }),
      line('signal-rule', 'connector', 6, 29, 88, 0.5, { lineColor: 'accent', lineWidth: 3 }),
      text('metric-a-label', 'meta', 6, 37, 20, 4, { fontSize: 12, bold: true, colorRole: 'accent' }),
      text('metric-a', 'metric', 6, 45, 40, 18, { display: true, fontSize: 58, bold: true, colorRole: 'ink' }),
      text('metric-a-unit', 'body', 7, 66, 18, 4, { fontSize: 12, colorRole: 'muted' }),
      text('metric-b-label', 'meta', 57, 39, 16, 4, { fontSize: 12, bold: true, colorRole: 'muted' }),
      text('metric-b', 'metric', 57, 47, 16, 10, { fontSize: 28, bold: true, colorRole: 'ink' }),
      text('metric-b-unit', 'body', 57, 60, 16, 4, { fontSize: 12, colorRole: 'muted' }),
      text('metric-c-label', 'meta', 79, 39, 15, 4, { fontSize: 12, bold: true, colorRole: 'muted' }),
      text('metric-c', 'metric', 79, 47, 15, 10, { fontSize: 28, bold: true, colorRole: 'accent2' }),
      text('metric-c-unit', 'body', 79, 60, 15, 6, { fontSize: 12, colorRole: 'muted' }),
      source('ink'),
    ];
  }
  if (index === 2) return editorialScene(index);
  if (index === 3) return ledgerScene(index);
  return editorialScene(index);
}

export function createExecutiveSceneElements(grammar, index, round = 1) {
  if (Number(round) > 1) return createExecutiveRevisionElements(grammar, index);
  return grammar === 'ledger-native'
    ? ledgerScene(index)
    : grammar === 'signal-native'
      ? signalScene(index)
      : editorialScene(index);
}
