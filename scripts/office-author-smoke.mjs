import { resolve } from 'node:path';
import { executeOfficeTool, resetOfficeSessionsForTest } from '../src/runtime/office/index.mjs';

function value(result) {
  if (result?.isError) throw new Error(result?.content?.[0]?.text || 'Office Use failed');
  return JSON.parse(result.content[0].text);
}

const cwd = process.cwd();
const output = resolve(cwd, process.argv[2] || '.smoke/authored-smoke.pptx');

const script = String.raw`
const pptxgen = require('pptxgenjs');
const pres = new pptxgen();
pres.layout = 'LAYOUT_WIDE';
const NAVY = '1E2761', ICE = 'CADCFC', WHITE = 'FFFFFF', INK = '1C1D2C', MUTED = '5B5F7A', TEAL = '0B8A8F', TINT = 'EEF3FB';
const DISPLAY = 'Cambria', BODY = 'Calibri';

function ring(slide, x, y, size, color, transparency) {
  slide.addShape(pres.ShapeType.ellipse, { x, y, w: size, h: size, line: { color, width: 1.25, transparency }, fill: { type: 'none' } });
}
function motif(slide, dark) {
  const c = dark ? ICE : NAVY;
  ring(slide, 8.9, -1.6, 6.2, c, 78);
  ring(slide, 9.7, -0.8, 4.6, c, 70);
  ring(slide, 10.5, 0.0, 3.0, c, 60);
}

// 1 · cover
{
  const s = pres.addSlide();
  s.background = { color: NAVY };
  motif(s, true);
  s.addText('MIXDOG OFFICE USE', { x: 0.8, y: 2.0, w: 6, h: 0.4, fontFace: BODY, fontSize: 12, bold: true, color: ICE, charSpacing: 4, margin: 0 });
  s.addText('Office Use\nOptimization Report', { x: 0.8, y: 2.5, w: 8.5, h: 2.2, fontFace: DISPLAY, fontSize: 48, bold: true, color: WHITE, margin: 0, valign: 'top' });
  s.addText('A semantic design system that turns multi-call choreography into one native document workflow.', { x: 0.8, y: 4.9, w: 7.2, h: 0.9, fontFace: BODY, fontSize: 16, color: ICE, margin: 0 });
  s.addText('Runtime design review · August 2026', { x: 0.8, y: 6.5, w: 6, h: 0.4, fontFace: BODY, fontSize: 11, color: ICE, margin: 0 });
}

// 2 · before: statement + hero number
{
  const s = pres.addSlide();
  s.background = { color: WHITE };
  s.addText('BEFORE', { x: 0.8, y: 0.7, w: 4, h: 0.4, fontFace: BODY, fontSize: 12, bold: true, color: TEAL, charSpacing: 4, margin: 0 });
  s.addText('The bottleneck was orchestration, not capability.', { x: 0.8, y: 1.3, w: 6.6, h: 2.4, fontFace: DISPLAY, fontSize: 38, bold: true, color: INK, margin: 0, valign: 'top' });
  s.addText('A 21-operation report required 22 tool calls because layout, review, and polish were disconnected.', { x: 0.8, y: 4.0, w: 6.0, h: 1.2, fontFace: BODY, fontSize: 16, color: MUTED, margin: 0 });
  s.addShape(pres.ShapeType.rect, { x: 8.0, y: 0.7, w: 4.6, h: 6.1, fill: { color: TINT }, line: { type: 'none' }, rectRadius: 0.2 });
  s.addText('22', { x: 8.0, y: 1.6, w: 4.6, h: 2.6, fontFace: DISPLAY, fontSize: 150, bold: true, color: NAVY, align: 'center', margin: 0 });
  s.addText('tool calls per report', { x: 8.0, y: 4.4, w: 4.6, h: 0.5, fontFace: BODY, fontSize: 16, bold: true, color: INK, align: 'center', margin: 0 });
  s.addText('21 operations · 13 snapshots · 4 QA round trips', { x: 8.0, y: 4.95, w: 4.6, h: 0.5, fontFace: BODY, fontSize: 12, color: MUTED, align: 'center', margin: 0 });
}

// 3 · process: four steps with icon circles
{
  const s = pres.addSlide();
  s.background = { color: WHITE };
  s.addText('One contract replaces the choreography', { x: 0.8, y: 0.7, w: 11.7, h: 0.9, fontFace: DISPLAY, fontSize: 36, bold: true, color: INK, margin: 0 });
  const steps = [
    ['01', 'Brief', 'Intent, audience, content, and evidence in one request.'],
    ['02', 'Compose', 'The script maps every claim to native Office objects.'],
    ['03', 'Render', 'Each slide becomes an image the reviewer can inspect.'],
    ['04', 'Polish', 'Critique feeds one deterministic repair pass.'],
  ];
  steps.forEach(([n, title, detail], i) => {
    const x = 0.8 + i * 3.0;
    s.addShape(pres.ShapeType.rect, { x, y: 2.0, w: 2.7, h: 4.6, fill: { color: i === 0 ? NAVY : TINT }, line: { type: 'none' }, rectRadius: 0.15 });
    s.addShape(pres.ShapeType.ellipse, { x: x + 0.3, y: 2.35, w: 0.9, h: 0.9, fill: { color: i === 0 ? ICE : NAVY }, line: { type: 'none' } });
    s.addText(n, { x: x + 0.3, y: 2.35, w: 0.9, h: 0.9, fontFace: BODY, fontSize: 16, bold: true, color: i === 0 ? NAVY : WHITE, align: 'center', valign: 'middle', margin: 0 });
    s.addText(title, { x: x + 0.3, y: 3.6, w: 2.2, h: 0.6, fontFace: DISPLAY, fontSize: 24, bold: true, color: i === 0 ? WHITE : INK, margin: 0 });
    s.addText(detail, { x: x + 0.3, y: 4.3, w: 2.1, h: 1.8, fontFace: BODY, fontSize: 14, color: i === 0 ? ICE : MUTED, margin: 0, valign: 'top' });
  });
}

// 4 · results: one hero metric + native chart
{
  const s = pres.addSlide();
  s.background = { color: WHITE };
  s.addText('Less overhead. Same correctness.', { x: 0.8, y: 0.7, w: 11.7, h: 0.9, fontFace: DISPLAY, fontSize: 36, bold: true, color: INK, margin: 0 });
  s.addText('The optimized workflow preserves the result while cutting runtime and interaction cost.', { x: 0.8, y: 1.6, w: 9, h: 0.5, fontFace: BODY, fontSize: 16, color: MUTED, margin: 0 });
  s.addShape(pres.ShapeType.rect, { x: 0.8, y: 2.5, w: 4.4, h: 4.3, fill: { color: NAVY }, line: { type: 'none' }, rectRadius: 0.2 });
  s.addText('3', { x: 0.8, y: 2.7, w: 4.4, h: 2.2, fontFace: DISPLAY, fontSize: 120, bold: true, color: WHITE, align: 'center', margin: 0 });
  s.addText('tool calls, down from 22', { x: 1.1, y: 5.0, w: 3.8, h: 0.5, fontFace: BODY, fontSize: 16, bold: true, color: WHITE, align: 'center', margin: 0 });
  s.addText('−86% interaction overhead', { x: 1.1, y: 5.5, w: 3.8, h: 0.5, fontFace: BODY, fontSize: 13, color: ICE, align: 'center', margin: 0 });
  s.addChart(pres.ChartType.bar, [
    { name: 'Runtime (s)', labels: ['Before', 'After'], values: [41.2, 22.8] },
  ], {
    x: 5.6, y: 2.5, w: 6.9, h: 4.3,
    barDir: 'col', chartColors: [ICE, TEAL], showValue: true, dataLabelPosition: 'outEnd', dataLabelFontFace: BODY, dataLabelFontSize: 14, dataLabelColor: INK,
    showTitle: true, title: 'Runtime per report, seconds (−44.6%)', titleFontFace: BODY, titleFontSize: 14, titleColor: INK,
    catAxisLabelFontFace: BODY, catAxisLabelColor: MUTED, valAxisLabelFontFace: BODY, valAxisLabelColor: MUTED,
    valGridLine: { color: 'E4E7EE', size: 0.5 }, catGridLine: { style: 'none' }, showLegend: false, valAxisHidden: false,
  });
}

// 5 · closing
{
  const s = pres.addSlide();
  s.background = { color: NAVY };
  motif(s, true);
  s.addText('DESIGN SYSTEM', { x: 0.8, y: 1.9, w: 4, h: 0.4, fontFace: BODY, fontSize: 12, bold: true, color: ICE, charSpacing: 4, margin: 0 });
  s.addText('One contract.\nMore work per turn.', { x: 0.8, y: 2.4, w: 8.5, h: 2.3, fontFace: DISPLAY, fontSize: 48, bold: true, color: WHITE, margin: 0, valign: 'top' });
  const chain = ['Brief', 'Compose', 'Render', 'Critique', 'Polish'];
  chain.forEach((label, i) => {
    const x = 0.8 + i * 2.25;
    s.addShape(pres.ShapeType.roundRect, { x, y: 5.1, w: 1.9, h: 0.6, fill: { color: i === chain.length - 1 ? ICE : '2B3676' }, line: { type: 'none' }, rectRadius: 0.3 });
    s.addText(label, { x, y: 5.1, w: 1.9, h: 0.6, fontFace: BODY, fontSize: 14, bold: true, color: i === chain.length - 1 ? NAVY : WHITE, align: 'center', valign: 'middle', margin: 0 });
    if (i < chain.length - 1) s.addText('→', { x: x + 1.9, y: 5.1, w: 0.35, h: 0.6, fontFace: BODY, fontSize: 14, color: ICE, align: 'center', valign: 'middle', margin: 0 });
  });
}

await pres.writeFile({ fileName: OUTPUT });
`;

try {
  const authored = value(await executeOfficeTool({ action: 'author', path: output, script, overwrite: true }, { cwd }));
  const { logs, render, ...summary } = authored;
  process.stdout.write(`${JSON.stringify({ ...summary, render: render ? { pageCount: render.pageCount, output: render.output, images: render.images?.map((image) => image.path) } : null, logs }, null, 2)}\n`);
  if (authored.session) {
    const finalized = value(await executeOfficeTool({ action: 'finalize', session: authored.session, design: { reviewed: true } }, { cwd }));
    process.stdout.write(`${JSON.stringify({ ok: finalized.ok, reason: finalized.reason, blockingIssues: finalized.blockingIssues, advisoryIssues: finalized.review?.advisoryIssues?.map((issue) => `${issue.severity}:${issue.code}`), validation: finalized.validation?.ok, quality: finalized.review?.quality?.score }, null, 2)}\n`);
  }
} finally {
  resetOfficeSessionsForTest();
}
