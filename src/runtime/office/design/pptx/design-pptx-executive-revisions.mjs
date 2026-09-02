import { element, line, source, text } from './design-pptx-scene-builders.mjs';


function shape(id, role, x, y, w, h, style = {}, shapeType = 'rectangle') {
  return element(id, 'shape', role, x, y, w, h, style, { shapeType });
}

function editorialRevision(index) {
  if (index === 0) {
    return [
      text('eyebrow', 'eyebrow', 6, 9, 45, 4, { fontSize: 12, bold: true, colorRole: 'accent' }),
      text('title', 'title', 6, 19, 51, 27, { display: true, fontSize: 37, bold: true, colorRole: 'onInverse' }),
      text('subtitle', 'subtitle', 6, 54, 48, 11, { fontSize: 17, colorRole: 'surface2' }),
      text('meta', 'meta', 6, 75, 42, 4, { fontSize: 12, colorRole: 'surface2' }),
      shape('decision-window', 'visual', 62, 13, 32, 61, {
        fillRole: 'accent',
        fillTransparency: 91,
        lineRole: 'accent',
        lineTransparency: 45,
        lineWidth: 1.5,
      }, 'rounded_rectangle'),
      text('hero', 'visual', 66, 25, 24, 16, {
        display: true,
        fontSize: 54,
        bold: true,
        colorRole: 'onInverse',
        align: 'center',
      }),
      text('hero-label', 'meta', 66, 45, 24, 5, {
        fontSize: 12,
        bold: true,
        colorRole: 'accent',
        align: 'center',
      }),
      line('decision-rule', 'connector', 68, 55, 20, 0.5, { lineColor: 'accent', lineWidth: 2 }),
      source('surface2'),
    ];
  }
  if (index === 1) {
    return [
      text('title', 'title', 6, 8, 88, 17, { display: true, fontSize: 32, bold: true, colorRole: 'ink' }),
      shape('proof-field', 'evidence', 6, 31, 53, 53, {
        fillRole: 'inverse',
        lineRole: 'inverse',
      }, 'rounded_rectangle'),
      text('metric-a-label', 'meta', 10, 38, 30, 4, { fontSize: 12, bold: true, colorRole: 'accent' }),
      text('metric-a', 'metric', 10, 46, 34, 17, { display: true, fontSize: 52, bold: true, colorRole: 'onInverse' }),
      text('metric-a-unit', 'body', 10, 66, 18, 4, { fontSize: 12, colorRole: 'surface2' }),
      line('proof-rule', 'connector', 10, 73, 22, 0.5, { lineColor: 'accent', lineWidth: 2 }),
      text('subtitle', 'subtitle', 35, 66, 20, 10, { fontSize: 13, colorRole: 'surface2', align: 'right' }),
      text('metric-b-label', 'meta', 69, 36, 22, 4, { fontSize: 12, bold: true, colorRole: 'muted' }),
      text('metric-b', 'metric', 69, 43, 22, 10, { fontSize: 30, bold: true, colorRole: 'ink' }),
      text('metric-b-unit', 'body', 69, 55, 22, 4, { fontSize: 12, colorRole: 'muted' }),
      text('metric-c-label', 'meta', 69, 65, 22, 4, { fontSize: 12, bold: true, colorRole: 'muted' }),
      text('metric-c', 'metric', 69, 72, 22, 9, { fontSize: 30, bold: true, colorRole: 'accent2' }),
      text('metric-c-unit', 'body', 69, 83, 22, 4, { fontSize: 12, colorRole: 'muted' }),
      source('ink'),
    ];
  }
  if (index === 2) {
    return [
      text('title', 'title', 6, 8, 88, 15, { display: true, fontSize: 32, bold: true, colorRole: 'ink' }),
      element('chart', 'chart', 'evidence', 6, 27, 63, 57),
      shape('signal-field', 'visual', 73, 27, 21, 57, {
        fillRole: 'inverse',
        lineRole: 'inverse',
      }, 'rounded_rectangle'),
      text('note-kicker', 'meta', 77, 32, 14, 4, { fontSize: 12, bold: true, colorRole: 'accent' }),
      text('note-a', 'body', 77, 39, 14, 12, { fontSize: 13, bold: true, colorRole: 'onInverse' }),
      line('signal-a', 'connector', 77, 52, 12, 0.4, { lineColor: 'surface2', lineTransparency: 35, lineWidth: 1 }),
      text('note-b', 'body', 77, 55, 14, 12, { fontSize: 13, bold: true, colorRole: 'onInverse' }),
      text('note-c', 'body', 77, 70, 14, 12, { fontSize: 13, bold: true, colorRole: 'onInverse' }),
      source('ink'),
    ];
  }
  if (index === 3) {
    return [
      text('title', 'title', 6, 8, 61, 16, { display: true, fontSize: 32, bold: true, colorRole: 'onInverse' }),
      text('subtitle', 'subtitle', 70, 10, 24, 8, { fontSize: 14, colorRole: 'surface2', align: 'right' }),
      text('total-label', 'meta', 6, 34, 20, 4, { fontSize: 12, bold: true, colorRole: 'accent' }),
      text('total', 'visual', 6, 42, 20, 13, { display: true, fontSize: 42, bold: true, colorRole: 'onInverse' }),
      line('branch-main', 'connector', 24, 51, 11, 0.2, { lineColor: 'surface2', lineWidth: 1.5 }),
      line('branch-spine', 'connector', 35, 43, 0.2, 25, { lineColor: 'surface2', lineWidth: 1.5 }),
      line('branch-a', 'connector', 35, 43, 5, 0.2, { lineColor: 'accent', lineWidth: 2 }),
      line('branch-b', 'connector', 35, 68, 5, 0.2, { lineColor: 'accent2', lineWidth: 2 }),
      shape('track-a-field', 'evidence', 40, 31, 54, 24, {
        fillRole: 'accent',
        fillTransparency: 86,
        lineRole: 'accent',
        lineTransparency: 60,
      }, 'rounded_rectangle'),
      shape('track-b-field', 'evidence', 40, 59, 54, 24, {
        fillRole: 'accent2',
        fillTransparency: 87,
        lineRole: 'accent2',
        lineTransparency: 60,
      }, 'rounded_rectangle'),
      text('track-a-label', 'meta', 44, 36, 18, 4, { fontSize: 13, bold: true, colorRole: 'accent' }),
      text('track-a-value', 'metric', 44, 42, 17, 7, { fontSize: 27, bold: true, colorRole: 'onInverse' }),
      text('track-a-detail', 'body', 64, 39, 26, 9, { fontSize: 12, colorRole: 'surface2', align: 'right' }),
      text('track-b-label', 'meta', 44, 64, 18, 4, { fontSize: 13, bold: true, colorRole: 'accent2' }),
      text('track-b-value', 'metric', 44, 70, 17, 7, { fontSize: 27, bold: true, colorRole: 'onInverse' }),
      text('track-b-detail', 'body', 64, 67, 26, 9, { fontSize: 12, colorRole: 'surface2', align: 'right' }),
      source('surface2'),
    ];
  }
  if (index === 4) {
    const columns = [10, 31, 52, 73];
    return [
      text('title', 'title', 6, 8, 72, 15, { display: true, fontSize: 32, bold: true, colorRole: 'ink' }),
      text('timeline-kicker', 'meta', 77, 12, 17, 4, { fontSize: 12, bold: true, colorRole: 'accent2', align: 'right' }),
      shape('operating-field', 'evidence', 6, 29, 88, 56, {
        fillRole: 'inverse',
        lineRole: 'inverse',
      }, 'rounded_rectangle'),
      line('timeline', 'connector', 11, 51, 76, 0.5, { lineColor: 'surface2', lineTransparency: 20, lineWidth: 2 }),
      ...columns.flatMap((x, step) => [
        ...(step > 0
          ? [line(`divider-${step}`, 'connector', x - 2, 35, 0.35, 42, {
            lineColor: 'surface2',
            lineTransparency: 72,
            lineWidth: 1,
          })]
          : []),
        text(`phase-${step + 1}`, 'meta', x, 36, 15, 4, {
          fontSize: 13,
          bold: true,
          colorRole: step === 3 ? 'accent2' : step === 0 ? 'accent' : 'surface2',
        }),
        shape(`node-${step + 1}`, 'node', x, 47, step === 3 ? 5 : 4, step === 3 ? 8 : 6.5, {
          fillRole: step === 3 ? 'accent2' : step === 0 ? 'accent' : 'inverse',
          lineRole: step === 3 ? 'accent2' : step === 0 ? 'accent' : 'surface2',
          lineWidth: 2,
        }, 'oval'),
        text(`step-${step + 1}`, 'body', x, 57, 16, 5, { fontSize: 14, bold: true, colorRole: 'onInverse' }),
        text(`detail-${step + 1}`, 'body', x, 66, 17, 10, { fontSize: 12, colorRole: 'surface2' }),
      ]),
      source('ink'),
    ];
  }
  return [
    text('eyebrow', 'eyebrow', 6, 9, 32, 4, { fontSize: 12, bold: true, colorRole: 'accent' }),
    text('title', 'title', 6, 18, 58, 25, { display: true, fontSize: 36, bold: true, colorRole: 'onInverse' }),
    text('subtitle', 'subtitle', 6, 48, 58, 9, { fontSize: 16, colorRole: 'surface2' }),
    text('total', 'visual', 72, 16, 21, 15, { display: true, fontSize: 52, bold: true, colorRole: 'onInverse', align: 'center' }),
    text('approval-label', 'meta', 74, 34, 17, 4, { fontSize: 12, bold: true, colorRole: 'accent', align: 'center' }),
    line('decision-rule', 'connector', 6, 62, 88, 0.5, { lineColor: 'surface2', lineTransparency: 28, lineWidth: 1.5 }),
    shape('track-a-field', 'evidence', 6, 68, 44, 14, {
      fillRole: 'accent',
      fillTransparency: 83,
      lineRole: 'accent',
      lineTransparency: 70,
    }),
    shape('track-b-field', 'evidence', 50, 68, 44, 14, {
      fillRole: 'accent2',
      fillTransparency: 84,
      lineRole: 'accent2',
      lineTransparency: 70,
    }),
    text('track-a-label', 'meta', 9, 72, 18, 4, { fontSize: 13, bold: true, colorRole: 'accent' }),
    text('track-a-value', 'metric', 35, 71, 11, 6, { fontSize: 20, bold: true, colorRole: 'onInverse', align: 'right' }),
    text('track-b-label', 'meta', 54, 72, 18, 4, { fontSize: 13, bold: true, colorRole: 'accent2' }),
    text('track-b-value', 'metric', 80, 71, 11, 6, { fontSize: 20, bold: true, colorRole: 'onInverse', align: 'right' }),
    source('surface2'),
  ];
}

function ledgerRevision(index) {
  if (index === 0) {
    return [
      text('eyebrow', 'eyebrow', 6, 10, 35, 4, { fontSize: 12, bold: true, colorRole: 'accent' }),
      text('title', 'title', 6, 20, 60, 24, { display: true, fontSize: 36, bold: true, colorRole: 'onInverse' }),
      text('hero', 'visual', 73, 18, 21, 15, { display: true, fontSize: 52, bold: true, colorRole: 'onInverse', align: 'right' }),
      text('hero-label', 'meta', 75, 36, 19, 4, { fontSize: 12, bold: true, colorRole: 'accent', align: 'right' }),
      line('ledger-rule', 'connector', 6, 52, 88, 0.5, { lineColor: 'accent', lineWidth: 2 }),
      text('subtitle', 'subtitle', 6, 60, 62, 10, { fontSize: 17, colorRole: 'surface2' }),
      text('meta', 'meta', 75, 61, 19, 8, { fontSize: 12, colorRole: 'surface2', align: 'right' }),
      source('surface2'),
    ];
  }
  if (index === 1) {
    return [
      text('title', 'title', 6, 8, 67, 16, { display: true, fontSize: 32, bold: true, colorRole: 'ink' }),
      text('subtitle', 'subtitle', 75, 10, 19, 8, { fontSize: 13, colorRole: 'muted', align: 'right' }),
      shape('primary-band', 'evidence', 6, 31, 88, 25, { fillRole: 'inverse', lineRole: 'inverse' }),
      text('metric-a-label', 'meta', 10, 37, 20, 4, { fontSize: 12, bold: true, colorRole: 'accent' }),
      text('metric-a', 'metric', 34, 34, 28, 15, { display: true, fontSize: 46, bold: true, colorRole: 'onInverse', align: 'center' }),
      text('metric-a-unit', 'body', 64, 39, 15, 4, { fontSize: 12, colorRole: 'surface2' }),
      line('ledger-bottom', 'connector', 6, 64, 88, 0.4, { lineColor: 'ink', lineTransparency: 60, lineWidth: 1 }),
      text('metric-b-label', 'meta', 6, 70, 22, 4, { fontSize: 12, bold: true, colorRole: 'muted' }),
      text('metric-b', 'metric', 31, 68, 18, 9, { fontSize: 29, bold: true, colorRole: 'ink' }),
      text('metric-b-unit', 'body', 50, 72, 14, 4, { fontSize: 12, colorRole: 'muted' }),
      text('metric-c-label', 'meta', 66, 70, 14, 4, { fontSize: 12, bold: true, colorRole: 'muted' }),
      text('metric-c', 'metric', 80, 68, 14, 9, { fontSize: 29, bold: true, colorRole: 'accent2', align: 'right' }),
      text('metric-c-unit', 'body', 66, 81, 28, 4, { fontSize: 12, colorRole: 'muted', align: 'right' }),
      source('ink'),
    ];
  }
  if (index === 2) {
    return [
      text('title', 'title', 6, 8, 34, 23, { display: true, fontSize: 31, bold: true, colorRole: 'ink' }),
      text('note-kicker', 'meta', 6, 38, 24, 4, { fontSize: 12, bold: true, colorRole: 'accent' }),
      text('note-a', 'body', 6, 44, 27, 12, { fontSize: 13, bold: true, colorRole: 'ink' }),
      line('note-a-rule', 'connector', 6, 57, 23, 0.4, { lineColor: 'ink', lineTransparency: 68, lineWidth: 1 }),
      text('note-b', 'body', 6, 59, 27, 12, { fontSize: 13, bold: true, colorRole: 'ink' }),
      text('note-c', 'body', 6, 73, 27, 12, { fontSize: 13, bold: true, colorRole: 'ink' }),
      element('chart', 'chart', 'evidence', 39, 17, 55, 67),
      source('ink'),
    ];
  }
  if (index === 3) {
    return [
      text('title', 'title', 6, 8, 62, 16, { display: true, fontSize: 32, bold: true, colorRole: 'onInverse' }),
      text('subtitle', 'subtitle', 72, 10, 22, 8, { fontSize: 14, colorRole: 'surface2', align: 'right' }),
      text('total-label', 'meta', 6, 35, 20, 4, { fontSize: 12, bold: true, colorRole: 'accent' }),
      text('total', 'visual', 6, 43, 20, 13, { display: true, fontSize: 42, bold: true, colorRole: 'onInverse' }),
      shape('allocation-field', 'evidence', 34, 31, 60, 53, {
        fillRole: 'surface',
        fillTransparency: 94,
        lineRole: 'surface2',
        lineTransparency: 55,
      }, 'rounded_rectangle'),
      line('track-divider', 'connector', 38, 58, 52, 0.4, { lineColor: 'surface2', lineTransparency: 50, lineWidth: 1 }),
      text('track-a-label', 'meta', 39, 38, 16, 4, { fontSize: 13, bold: true, colorRole: 'accent' }),
      text('track-a-value', 'metric', 58, 36, 15, 8, { fontSize: 28, bold: true, colorRole: 'onInverse' }),
      text('track-a-detail', 'body', 73, 39, 17, 8, { fontSize: 12, colorRole: 'surface2', align: 'right' }),
      text('track-b-label', 'meta', 39, 65, 16, 4, { fontSize: 13, bold: true, colorRole: 'accent2' }),
      text('track-b-value', 'metric', 58, 63, 15, 8, { fontSize: 28, bold: true, colorRole: 'onInverse' }),
      text('track-b-detail', 'body', 73, 66, 17, 8, { fontSize: 12, colorRole: 'surface2', align: 'right' }),
      source('surface2'),
    ];
  }
  if (index === 4) {
    const rows = [32, 45, 58, 71];
    return [
      text('title', 'title', 6, 8, 72, 15, { display: true, fontSize: 32, bold: true, colorRole: 'ink' }),
      text('timeline-kicker', 'meta', 77, 12, 17, 4, { fontSize: 12, bold: true, colorRole: 'accent2', align: 'right' }),
      shape('timeline-ledger', 'evidence', 6, 28, 88, 57, {
        fillRole: 'surface',
        fillTransparency: 38,
        lineRole: 'ink',
        lineTransparency: 76,
      }),
      ...rows.flatMap((y, step) => [
        ...(step > 0
          ? [line(`row-rule-${step}`, 'connector', 9, y - 3, 82, 0.35, {
            lineColor: 'ink',
            lineTransparency: 78,
            lineWidth: 1,
          })]
          : []),
        text(`phase-${step + 1}`, 'meta', 10, y, 10, 4, {
          fontSize: 13,
          bold: true,
          colorRole: step === 3 ? 'accent2' : step === 0 ? 'accent' : 'ink',
        }),
        text(`step-${step + 1}`, 'body', 25, y - 1, 24, 5, { fontSize: 14, bold: true, colorRole: 'ink' }),
        text(`detail-${step + 1}`, 'body', 55, y - 1, 35, 5, { fontSize: 12, colorRole: 'muted', align: 'right' }),
      ]),
      source('ink'),
    ];
  }
  return [
    text('eyebrow', 'eyebrow', 6, 9, 32, 4, { fontSize: 12, bold: true, colorRole: 'accent' }),
    text('title', 'title', 6, 18, 80, 20, { display: true, fontSize: 35, bold: true, colorRole: 'onInverse' }),
    line('decision-rule', 'connector', 6, 44, 88, 0.5, { lineColor: 'accent', lineWidth: 2 }),
    text('total', 'visual', 6, 52, 23, 13, { display: true, fontSize: 47, bold: true, colorRole: 'onInverse' }),
    text('approval-label', 'meta', 7, 68, 19, 4, { fontSize: 12, bold: true, colorRole: 'accent' }),
    text('subtitle', 'subtitle', 34, 51, 60, 8, { fontSize: 16, colorRole: 'surface2' }),
    shape('track-a-field', 'evidence', 34, 64, 29, 16, {
      fillRole: 'accent',
      fillTransparency: 85,
      lineRole: 'accent',
      lineTransparency: 70,
    }),
    shape('track-b-field', 'evidence', 65, 64, 29, 16, {
      fillRole: 'accent2',
      fillTransparency: 86,
      lineRole: 'accent2',
      lineTransparency: 70,
    }),
    text('track-a-label', 'meta', 37, 69, 13, 4, { fontSize: 12, bold: true, colorRole: 'accent' }),
    text('track-a-value', 'metric', 51, 68, 9, 5, { fontSize: 18, bold: true, colorRole: 'onInverse', align: 'right' }),
    text('track-b-label', 'meta', 68, 69, 13, 4, { fontSize: 12, bold: true, colorRole: 'accent2' }),
    text('track-b-value', 'metric', 82, 68, 9, 5, { fontSize: 18, bold: true, colorRole: 'onInverse', align: 'right' }),
    source('surface2'),
  ];
}

function signalRevision(index) {
  if (index === 0) {
    return [
      shape('signal-panel', 'visual', 60, 8, 34, 70, {
        fillRole: 'accent',
        fillTransparency: 89,
        lineRole: 'accent',
        lineTransparency: 60,
      }, 'rounded_rectangle'),
      text('eyebrow', 'eyebrow', 6, 10, 38, 4, { fontSize: 12, bold: true, colorRole: 'accent' }),
      text('title', 'title', 6, 21, 49, 28, { display: true, fontSize: 37, bold: true, colorRole: 'onInverse' }),
      text('subtitle', 'subtitle', 6, 58, 48, 11, { fontSize: 16, colorRole: 'surface2' }),
      text('hero', 'visual', 65, 24, 24, 16, { display: true, fontSize: 55, bold: true, colorRole: 'onInverse', align: 'center' }),
      text('hero-label', 'meta', 66, 44, 22, 5, { fontSize: 12, bold: true, colorRole: 'accent', align: 'center' }),
      text('meta', 'meta', 66, 60, 22, 8, { fontSize: 12, colorRole: 'surface2', align: 'center' }),
      source('surface2'),
    ];
  }
  if (index === 1) {
    return [
      text('title', 'title', 6, 8, 88, 16, { display: true, fontSize: 32, bold: true, colorRole: 'ink' }),
      line('signal-rule', 'connector', 6, 29, 88, 0.5, { lineColor: 'accent', lineWidth: 3 }),
      text('metric-a-label', 'meta', 6, 38, 22, 4, { fontSize: 12, bold: true, colorRole: 'accent' }),
      text('metric-a', 'metric', 6, 47, 42, 18, { display: true, fontSize: 58, bold: true, colorRole: 'ink' }),
      text('metric-a-unit', 'body', 7, 68, 18, 4, { fontSize: 12, colorRole: 'muted' }),
      shape('support-signal', 'evidence', 55, 36, 39, 47, {
        fillRole: 'inverse',
        lineRole: 'inverse',
      }, 'rounded_rectangle'),
      text('metric-b-label', 'meta', 60, 43, 14, 4, { fontSize: 12, bold: true, colorRole: 'surface2' }),
      text('metric-b', 'metric', 76, 41, 14, 8, { fontSize: 29, bold: true, colorRole: 'onInverse', align: 'right' }),
      text('metric-b-unit', 'body', 60, 52, 30, 4, { fontSize: 12, colorRole: 'surface2', align: 'right' }),
      line('support-rule', 'connector', 60, 59, 30, 0.4, { lineColor: 'surface2', lineTransparency: 45, lineWidth: 1 }),
      text('metric-c-label', 'meta', 60, 65, 14, 4, { fontSize: 12, bold: true, colorRole: 'surface2' }),
      text('metric-c', 'metric', 76, 63, 14, 8, { fontSize: 29, bold: true, colorRole: 'accent2', align: 'right' }),
      text('metric-c-unit', 'body', 60, 75, 30, 4, { fontSize: 12, colorRole: 'surface2', align: 'right' }),
      source('ink'),
    ];
  }
  if (index === 2) {
    return [
      text('title', 'title', 6, 8, 65, 15, { display: true, fontSize: 32, bold: true, colorRole: 'ink' }),
      text('note-kicker', 'meta', 75, 11, 19, 4, { fontSize: 12, bold: true, colorRole: 'accent', align: 'right' }),
      element('chart', 'chart', 'evidence', 6, 28, 60, 56),
      shape('signal-stack', 'visual', 70, 28, 24, 56, {
        fillRole: 'surface',
        fillTransparency: 20,
        lineRole: 'accent',
        lineTransparency: 55,
      }, 'rounded_rectangle'),
      text('note-a', 'body', 74, 33, 16, 12, { fontSize: 13, bold: true, colorRole: 'ink' }),
      line('signal-a', 'connector', 74, 46, 16, 0.4, { lineColor: 'accent', lineWidth: 1.5 }),
      text('note-b', 'body', 74, 49, 16, 12, { fontSize: 13, bold: true, colorRole: 'ink' }),
      text('note-c', 'body', 74, 65, 16, 13, { fontSize: 13, bold: true, colorRole: 'ink' }),
      source('ink'),
    ];
  }
  if (index === 3) {
    return [
      text('title', 'title', 6, 8, 61, 16, { display: true, fontSize: 32, bold: true, colorRole: 'onInverse' }),
      text('subtitle', 'subtitle', 70, 10, 24, 8, { fontSize: 14, colorRole: 'surface2', align: 'right' }),
      text('total-label', 'meta', 6, 36, 20, 4, { fontSize: 12, bold: true, colorRole: 'accent' }),
      text('total', 'visual', 6, 44, 20, 13, { display: true, fontSize: 42, bold: true, colorRole: 'onInverse' }),
      line('branch-main', 'connector', 24, 52, 13, 0.5, { lineColor: 'accent', lineWidth: 3 }),
      shape('track-a-field', 'evidence', 39, 31, 25, 52, {
        fillRole: 'accent',
        fillTransparency: 82,
        lineRole: 'accent',
        lineTransparency: 50,
      }, 'rounded_rectangle'),
      shape('track-b-field', 'evidence', 69, 31, 25, 52, {
        fillRole: 'accent2',
        fillTransparency: 83,
        lineRole: 'accent2',
        lineTransparency: 50,
      }, 'rounded_rectangle'),
      text('track-a-label', 'meta', 43, 38, 17, 4, { fontSize: 13, bold: true, colorRole: 'accent' }),
      text('track-a-value', 'metric', 43, 48, 17, 9, { fontSize: 29, bold: true, colorRole: 'onInverse' }),
      text('track-a-detail', 'body', 43, 64, 17, 10, { fontSize: 12, colorRole: 'surface2' }),
      text('track-b-label', 'meta', 73, 38, 17, 4, { fontSize: 13, bold: true, colorRole: 'accent2' }),
      text('track-b-value', 'metric', 73, 48, 17, 9, { fontSize: 29, bold: true, colorRole: 'onInverse' }),
      text('track-b-detail', 'body', 73, 64, 17, 10, { fontSize: 12, colorRole: 'surface2' }),
      source('surface2'),
    ];
  }
  if (index === 4) {
    const positions = [11, 32, 53, 74];
    return [
      text('title', 'title', 6, 8, 72, 15, { display: true, fontSize: 32, bold: true, colorRole: 'ink' }),
      text('timeline-kicker', 'meta', 77, 12, 17, 4, { fontSize: 12, bold: true, colorRole: 'accent2', align: 'right' }),
      shape('cadence-field', 'evidence', 6, 29, 88, 56, {
        fillRole: 'inverse',
        lineRole: 'accent',
        lineTransparency: 65,
      }, 'rounded_rectangle'),
      line('timeline', 'connector', 11, 47, 74, 0.5, { lineColor: 'accent2', lineWidth: 3 }),
      ...positions.flatMap((x, step) => [
        text(`phase-${step + 1}`, 'meta', x, 35, 15, 4, {
          fontSize: 13,
          bold: true,
          colorRole: step === 3 ? 'accent2' : step === 0 ? 'accent' : 'surface2',
        }),
        shape(`node-${step + 1}`, 'node', x, 43, step === 3 ? 5.5 : 4.5, step === 3 ? 9 : 7.5, {
          fillRole: step === 3 ? 'accent2' : step === 0 ? 'accent' : 'inverse',
          lineRole: step === 3 ? 'accent2' : step === 0 ? 'accent' : 'surface2',
          lineWidth: 2,
        }, 'oval'),
        text(`step-${step + 1}`, 'body', x, 56, 16, 5, { fontSize: 14, bold: true, colorRole: 'onInverse' }),
        text(`detail-${step + 1}`, 'body', x, 66, 16, 10, { fontSize: 12, colorRole: 'surface2' }),
      ]),
      source('ink'),
    ];
  }
  return [
    text('eyebrow', 'eyebrow', 6, 9, 32, 4, { fontSize: 12, bold: true, colorRole: 'accent' }),
    text('title', 'title', 6, 18, 59, 25, { display: true, fontSize: 36, bold: true, colorRole: 'onInverse' }),
    text('subtitle', 'subtitle', 6, 48, 58, 9, { fontSize: 16, colorRole: 'surface2' }),
    shape('approval-signal', 'visual', 69, 13, 25, 42, {
      fillRole: 'accent',
      fillTransparency: 87,
      lineRole: 'accent',
      lineTransparency: 55,
    }, 'rounded_rectangle'),
    text('total', 'visual', 72, 20, 19, 13, { display: true, fontSize: 48, bold: true, colorRole: 'onInverse', align: 'center' }),
    text('approval-label', 'meta', 73, 37, 17, 4, { fontSize: 12, bold: true, colorRole: 'accent', align: 'center' }),
    shape('track-a-field', 'evidence', 6, 66, 44, 16, { fillRole: 'accent', lineRole: 'accent' }),
    shape('track-b-field', 'evidence', 50, 66, 44, 16, { fillRole: 'accent2', lineRole: 'accent2' }),
    text('track-a-label', 'meta', 9, 71, 18, 4, { fontSize: 13, bold: true, colorRole: 'onAccent' }),
    text('track-a-value', 'metric', 35, 70, 11, 6, { fontSize: 20, bold: true, colorRole: 'onAccent', align: 'right' }),
    text('track-b-label', 'meta', 54, 71, 18, 4, { fontSize: 13, bold: true, colorRole: 'onAccent' }),
    text('track-b-value', 'metric', 80, 70, 11, 6, { fontSize: 20, bold: true, colorRole: 'onAccent', align: 'right' }),
    source('surface2'),
  ];
}

export function createExecutiveRevisionElements(grammar, index) {
  if (grammar === 'ledger-native') return ledgerRevision(index);
  if (grammar === 'signal-native') return signalRevision(index);
  return editorialRevision(index);
}
