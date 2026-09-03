# Device kit

Owns the code: the helper functions that realize `design.md` §5 devices and `layouts.md` skeletons. Adapt the tokens to the brief, keep the functions, and draw every repeated element through one function so the deck stays consistent. Picture helpers are in `pictures.md` §4.

**Hard rule — paragraph options sit on the first run**: the runtime keeps one `a:pPr` per paragraph (the first). `bullet`, `align`, `paraSpaceAfter`, `lineSpacingMultiple` go on the text box or on a paragraph's first run; `breakLine: true` on a paragraph's last run. A later run carrying them loses them silently. → runtime (absorbed: the normalizer keeps the first `pPr`; nothing to check)

## 1. Tokens, canvas, masters
```js
const pptxgen = require('pptxgenjs');
const sharp = require('sharp');
const pres = new pptxgen();
pres.layout = 'LAYOUT_WIDE';
const W = 13.33, H = 7.5, M = 0.6;            // canvas + outer margin (inches)
const S = pres.ShapeType;                      // camelCase presets: S.chevron, S.blockArc, S.round1Rect, S.leftBrace, S.wedgeRectCallout, S.custGeom
const T = {                                    // palette ladder from the brief (design.md §6)
  ink: '1B2430', body: '2E3A48', muted: '5B6B7A', line: 'D6DEE5',
  paper: 'F7F9FB', paperAlt: 'E9EFF3', tint: 'DCEBEC', dark: '0F1B26', darkAlt: '1E2F3C',
  onDark: 'EEF3F6', onDarkMuted: 'A9B8C4', onDarkAccent: '7FD1D8',
  accent: '0E7C86', accentDeep: '0A5A62',
  display: 'Cambria', sans: 'Calibri', light: 'Calibri Light', data: 'Arial',   // overwritten by family() below
};
const box = (x, y, w, h) => ({ x, y, w, h });
const PX = 160;                                 // raster density: inches × PX = pixels (≥ 2× placed size)

// Type scale (design.md §7): the reading mode sets the body anchor; every role derives from it,
// so one deck never mixes a document-density body with a presentation-scale title.
const MODE = 'balanced';                        // presentation 24 · balanced 18 · text 15 (body pt); the brief's reading mode
function typeScale(mode) {
  const b = { presentation: 24, balanced: 18, text: 15 }[mode] ?? 18;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Math.round(v)));
  return {
    body: b, lead: Math.round(b * 1.2), caption: clamp(b * 0.7, 10.5, 16), kicker: clamp(b * 0.62, 10, 14),
    section: Math.round(b * 1.5), title: clamp(b * 2, 28, 44), cover: clamp(b * 2.6, 36, 56), hero: Math.round(b * 3.6),
    lh: { title: 1.2, dense: 1.4, body: 1.5, breathing: 1.7 },   // leading by role; the paragraph step is always larger than the line step
  };
}
const TYPE = typeScale(MODE);

// Family preset (design.md §3): locks the type pairing and the page chrome. The palette is never part of it.
// Latin pairing per family; `light` is the body face for prose (a lighter weight, or the sans when the face has none).
const FAMILY = {
  'swiss-minimal':   { display: 'Arial',       sans: 'Arial',   light: 'Arial',         data: 'Arial',       chrome: ['kicker', 'mark', 'page'] },
  'editorial':       { display: 'Cambria',     sans: 'Calibri', light: 'Calibri Light', data: 'Cambria',     chrome: ['kicker', 'mark', 'page'] },
  'photo-editorial': { display: 'Calibri',     sans: 'Calibri', light: 'Calibri Light', data: 'Calibri',     chrome: ['mark', 'page'] },
  'data-journalism': { display: 'Calibri',     sans: 'Calibri', light: 'Calibri Light', data: 'Cambria',     chrome: ['kicker', 'source', 'page'] },
  'soft-rounded':    { display: 'Calibri',     sans: 'Calibri', light: 'Calibri Light', data: 'Calibri',     chrome: ['kicker', 'mark', 'page'] },
  'dark-tech':       { display: 'Arial',       sans: 'Calibri', light: 'Calibri Light', data: 'Arial',       chrome: ['kicker', 'mark', 'page'] },
  'glassmorphism':   { display: 'Arial',       sans: 'Arial',   light: 'Arial',         data: 'Arial',       chrome: ['mark', 'page'] },
  'blueprint':       { display: 'Courier New', sans: 'Calibri', light: 'Calibri Light', data: 'Courier New', chrome: ['tags', 'page'] },
  'brutalist':       { display: 'Arial',       sans: 'Arial',   light: 'Arial',         data: 'Arial',       chrome: ['mark', 'page'] },   // display weight comes from bold 40-54 pt
};
// Korean pairing per family (design.md §3 table). `safe` uses faces every Windows PowerPoint has:
// Malgun Gothic in three weights (Semilight / regular / bold) and Batang for the serif display; the
// family's Latin data face stays for numerals. `noto` (Noto Sans KR / Noto Serif KR) only after the
// user confirmed the recipients have it; finalize then needs `allowUnsafeFonts: true`.
const KOREAN = {
  safe: {
    serif:   { display: 'Batang',        sans: 'Malgun Gothic', light: 'Malgun Gothic Semilight' },   // contrast: serif display over a light sans body
    weight:  { display: 'Malgun Gothic', sans: 'Malgun Gothic', light: 'Malgun Gothic Semilight' },   // contrast by weight: bold display, semilight body
    concord: { display: 'Malgun Gothic', sans: 'Malgun Gothic', light: 'Malgun Gothic' },             // one face, one weight step (swiss, brutalist)
  },
  noto: {
    serif:   { display: 'Noto Serif KR', sans: 'Noto Sans KR', light: 'Noto Sans KR' },
    weight:  { display: 'Noto Sans KR',  sans: 'Noto Sans KR', light: 'Noto Sans KR' },
    concord: { display: 'Noto Sans KR',  sans: 'Noto Sans KR', light: 'Noto Sans KR' },
  },
};
const KOREAN_PAIRING = { 'swiss-minimal': 'concord', 'editorial': 'serif', 'photo-editorial': 'weight', 'data-journalism': 'weight',
  'soft-rounded': 'weight', 'dark-tech': 'weight', 'glassmorphism': 'weight', 'blueprint': 'weight', 'brutalist': 'concord' };
// korean: false | 'safe' | 'noto' (true = 'safe').
function family(name, { korean = false } = {}) {
  const f = FAMILY[name];
  const k = korean ? KOREAN[korean === true ? 'safe' : korean][KOREAN_PAIRING[name]] : null;
  Object.assign(T, { display: k ? k.display : f.display, sans: k ? k.sans : f.sans, light: k ? k.light : f.light, data: f.data });
  return f;
}
const F = family('editorial', { korean: false });
const SOURCE = '';                              // data-journalism running source line, one per deck (e.g. 'Source: company filings, 2025')

// Page chrome lives on masters, not on slides: background, page number, and any
// element every slide of that role repeats. Add a master per background role.
function master(title, background, { number = true, muted = T.muted } = {}) {
  const objects = F.chrome.includes('source') && SOURCE
    ? [{ text: { text: SOURCE, options: { ...box(M, H - 0.5, 8, 0.3), fontFace: T.sans, fontSize: 9, color: muted, margin: 0 } } }] : [];
  pres.defineSlideMaster({ title, background: { color: background }, objects,
    ...(number && F.chrome.includes('page')
      ? { slideNumber: { x: W - M - 1, y: H - 0.5, w: 1, h: 0.3, fontFace: T.data, fontSize: 9, color: muted, align: 'right' } } : {}) });
}
master('CONTENT', T.paper);
master('BREATHING', T.dark, { muted: T.onDarkMuted });
master('ANCHOR', T.dark, { number: false });
const content = () => pres.addSlide({ masterName: 'CONTENT' });
const breathing = () => pres.addSlide({ masterName: 'BREATHING' });
const anchor = () => pres.addSlide({ masterName: 'ANCHOR' });
```

## 2. Raster helpers (sharp turns an SVG string into a PNG the deck can place)
```js
async function png(svg) {
  const buf = await sharp(Buffer.from(svg)).png().toBuffer();
  return 'image/png;base64,' + buf.toString('base64');
}
// Linear gradient field. stops: [[offset%, hex, alpha], ...]; angle 0 = left→right, 90 = top→bottom.
async function gradientField(slide, x, y, w, h, stops, angle = 0) {
  const pw = Math.round(w * PX), ph = Math.round(h * PX);
  const rad = angle * Math.PI / 180, x2 = 50 + 50 * Math.cos(rad), y2 = 50 + 50 * Math.sin(rad);
  const s = stops.map(([o, c, a = 1]) => `<stop offset="${o}%" stop-color="#${c}" stop-opacity="${a}"/>`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${pw}" height="${ph}"><defs><linearGradient id="g" x1="${100 - x2}%" y1="${100 - y2}%" x2="${x2}%" y2="${y2}%">${s}</linearGradient></defs><rect width="${pw}" height="${ph}" fill="url(#g)"/></svg>`;
  slide.addImage({ data: await png(svg), ...box(x, y, w, h) });
}
// Icon from a 24-unit SVG path inside a tinted circle.
async function icon(slide, x, y, d, path, { tint = T.paperAlt, color = T.accent } = {}) {
  slide.addShape(S.ellipse, { ...box(x, y, d, d), fill: { color: tint }, line: { color: tint } });
  const px = Math.round(d * 0.5 * PX);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 24 24"><path d="${path}" fill="#${color}"/></svg>`;
  slide.addImage({ data: await png(svg), ...box(x + d * 0.25, y + d * 0.25, d * 0.5, d * 0.5) });
}
// Soft radial glow behind a hero element (dark-tech, cover motif).
async function glow(slide, cx, cy, r, color = T.accent, alpha = 0.35) {
  const px = Math.round(r * 2 * PX);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}"><defs><radialGradient id="r"><stop offset="0%" stop-color="#${color}" stop-opacity="${alpha}"/><stop offset="100%" stop-color="#${color}" stop-opacity="0"/></radialGradient></defs><circle cx="${px / 2}" cy="${px / 2}" r="${px / 2}" fill="url(#r)"/></svg>`;
  slide.addImage({ data: await png(svg), ...box(cx - r, cy - r, r * 2, r * 2) });
}
```

## 3. Text helpers
```js
// Measured text (MEASURE is injected by the runtime with the review's own font metrics).
// fitH: the height a box of width w needs for text at size; fitSize: the largest size ≤ size that fits w × h.
// lh is the box's lineSpacingMultiple (1 = single): pass the same value the addText call carries, nothing else.
const fitH = (text, w, size, font = T.sans, { bold = false, lh = 1 } = {}) => MEASURE(text, { font, size, bold, width: w, lineHeight: lh }).height + 0.06;
function fitSize(text, w, h, size, font = T.sans, { bold = false, lh = 1, min = 12 } = {}) {
  let s = size;
  while (s > min && fitH(text, w, s, font, { bold, lh }) > h) s -= 1;
  return s;
}
// Kicker: Latin only gets tracking (charSpacing); Hangul never does (design.md §7).
function kicker(slide, text, x = M, y = 0.6, color = T.accent) {
  const latin = !/[\u1100-\u11FF\u3130-\u318F\uAC00-\uD7AF\u3040-\u30FF\u4E00-\u9FFF]/.test(text);
  slide.addText(latin ? text.toUpperCase() : text, { ...box(x, y, 6, 0.3), fontFace: latin ? T.data : T.sans, fontSize: TYPE.kicker, bold: true, color,
    ...(latin ? { charSpacing: 4 } : {}), margin: 0 });
}
// Signature mark: the family's small repeated device on content slides, opposite the kicker (design.md §3, §4.0).
// text: a real section numeral ('02'), a running module tag ('A · 인프라'), or one deck-wide word. Display face, accent color.
// Not a per-slide running number: a mark that encodes nothing is decoration.
function mark(slide, text, { color = T.accent, y = 0.55 } = {}) {
  if (!F.chrome.includes('mark') && !F.chrome.includes('tags')) return;
  slide.addText(text, { ...box(W - M - 2.5, y, 2.5, 0.35), fontFace: T.display, fontSize: TYPE.kicker + 3, bold: true, color, align: 'right', margin: 0, valign: 'middle' });
}
// Title: the box is measured, and the size steps down (to 24) when the text would need more than maxLines.
function title(slide, text, { x = M, y = 1.0, w = W - 2 * M, size = TYPE.title, color = T.ink, align = 'left', maxLines = 2 } = {}) {
  let s = size;
  while (s > 24 && MEASURE(text, { font: T.display, size: s, bold: true, width: w, lineHeight: TYPE.lh.title }).lines > maxLines) s -= 2;
  const h = Math.max(0.6, fitH(text, w, s, T.display, { bold: true, lh: TYPE.lh.title }));
  slide.addText(text, { ...box(x, y, w, h), fontFace: T.display, fontSize: s, bold: true, color, align, margin: 0, valign: 'top', lineSpacingMultiple: TYPE.lh.title });
  return y + h;                                  // bottom edge, so content can register under it
}
// Paragraphs of inline runs: [[['plain ', {}], ['42%', { bold: true, color: T.accent }], [' of users', {}]], [...next paragraph]]
// The body sits in the light face; an emphasized run switches to the sans (regular weight) or bold, so weight carries the emphasis.
function emphasis(slide, paragraphs, x, y, w, h, size = TYPE.lead, color = T.body, { lh = TYPE.lh.body } = {}) {
  const runs = [];
  paragraphs.forEach((para, pi) => para.forEach(([text, o], ri) => runs.push({ text, options: {
    ...(o.bold || o.color ? { fontFace: T.sans } : {}),
    ...o,
    ...(ri === 0 ? { paraSpaceAfter: size * 0.8 } : {}),                            // paragraph options: first run
    ...(ri === para.length - 1 && pi < paragraphs.length - 1 ? { breakLine: true } : {}),  // paragraph break: last run
  } })));
  slide.addText(runs, { ...box(x, y, w, h), fontFace: T.light, fontSize: size, color, margin: 0, valign: 'top', lineSpacingMultiple: lh });
}
// Takeaway: closes a slide that has a claim to close (design.md §4.5). Not a habit on every dense slide.
function takeaway(slide, text, y, { x = M, w = W - 2 * M, h = 0.7 } = {}) {
  const size = fitSize(text, w - 0.5, h - 0.2, TYPE.lead, T.sans, { min: TYPE.caption });
  slide.addShape(S.rect, { ...box(x, y, w, h), fill: { color: T.tint }, line: { color: T.tint } });
  slide.addText(text, { ...box(x + 0.25, y, w - 0.5, h), fontFace: T.sans, fontSize: size, color: T.ink, margin: 0, valign: 'middle' });
}
function hero(slide, x, y, w, value, label, { color = T.accent, size = TYPE.hero, unit = '', labelColor = T.muted } = {}) {
  const runs = [{ text: value, options: { fontSize: size } }];
  if (unit) runs.push({ text: unit, options: { fontSize: Math.round(size * 0.4) } });
  const h = Math.max(1.12, size / 72 * 1.2);    // numeral box grows with the size; the label sits 0.05 in under it
  slide.addText(runs, { ...box(x, y, w, h), fontFace: T.data, bold: true, color, margin: 0, valign: 'bottom' });
  const lh = Math.max(0.45, fitH(label, w, TYPE.caption));
  slide.addText(label, { ...box(x, y + h + 0.05, w, lh), fontFace: T.sans, fontSize: TYPE.caption, color: labelColor, margin: 0, valign: 'top' });
  return y + h + 0.05 + lh;
}
// Bullets: dense leading, and a paragraph step (paraSpaceAfter) visibly larger than the line step.
function body(slide, x, y, w, h, lines, size = TYPE.body, color = T.body) {
  const s = fitSize(lines.join('\n'), w - 0.3, h - lines.length * size * 0.6 / 72, size, T.light, { lh: TYPE.lh.dense, min: TYPE.caption });
  slide.addText(lines.map((text, i) => ({ text, options: { bullet: true, paraSpaceAfter: Math.round(s * 0.6), breakLine: i < lines.length - 1 } })),
    { ...box(x, y, w, h), fontFace: T.light, fontSize: s, color, valign: 'top', margin: 0, lineSpacingMultiple: TYPE.lh.dense });
}
// Prose: h is the ceiling; the size steps down (to 12) until the text fits it. lh: TYPE.lh.body, or .breathing on a sparse slide.
function prose(slide, text, x, y, w, h, size = TYPE.body, color = T.body, { lh = TYPE.lh.body } = {}) {
  const s = fitSize(text, w, h, size, T.light, { lh });
  slide.addText(text, { ...box(x, y, w, h), fontFace: T.light, fontSize: s, color, valign: 'top', margin: 0, lineSpacingMultiple: lh });
}
// Caption / source line under a figure or picture: caption size, muted, registered to the figure's left edge.
function caption(slide, text, x, y, w, color = T.muted) {
  const h = Math.max(0.3, fitH(text, w, TYPE.caption, T.light));
  slide.addText(text, { ...box(x, y, w, h), fontFace: T.light, fontSize: TYPE.caption, color, margin: 0, valign: 'top' });
  return y + h;
}
// Specimen: the subject drawn, not described (design.md §4.0). Each row sets one sample of text in a given face,
// size, and weight with its label registered to the left; rows share a baseline grid. rows: [{ text, font, size, bold, label, color }].
// Use it for a weight ladder (same word in light / regular / bold), a size ramp (15 · 18 · 24 pt), or a pairing (display line over body line).
function specimen(slide, x, y, w, rows, { labelW = 1.6, gap = 0.35, labelColor = T.muted } = {}) {
  let cy = y;
  for (const r of rows) {
    const font = r.font || T.sans, size = r.size || TYPE.body, bold = r.bold === true;
    const h = Math.max(0.45, fitH(r.text, w - labelW - 0.2, size, font, { bold, lh: 1.2 }) + 0.05);
    slide.addText(r.label || '', { ...box(x, cy, labelW, 0.4), fontFace: T.data, fontSize: TYPE.caption - 1, color: labelColor, margin: 0, valign: 'top' });
    slide.addText(r.text, { ...box(x + labelW + 0.2, cy, w - labelW - 0.2, h), fontFace: font, fontSize: size, bold, color: r.color || T.ink, margin: 0, valign: 'top', lineSpacingMultiple: 1.2 });
    cy += h + gap;
  }
  return cy;                                     // bottom edge
}
// Ghost numeral: chapter mark behind content. Keep the box inside the canvas (w ≤ W - x).
function ghost(slide, text, x, y, size = 240, w = 5.5) {
  slide.addText(text, { ...box(x, y, w, size / 60), fontFace: T.data, fontSize: size, bold: true, color: 'FFFFFF', transparency: 88, margin: 0, valign: 'top' });
}
```

## 4. Shape helpers (native, editable in PowerPoint)
```js
function field(slide, x, y, w, h, tint = T.paperAlt, shape = S.rect) {    // page field or module surface
  slide.addShape(shape, { ...box(x, y, w, h), fill: { color: tint }, line: { color: tint } });
}
function hairline(slide, x, y, w, color = T.line) {
  slide.addShape(S.line, { ...box(x, y, w, 0), line: { color, width: 1 } });
}
function connector(slide, x1, y1, x2, y2, { color = T.muted, width = 1.5, arrow = 'triangle', dash = 'solid' } = {}) {
  slide.addShape(S.line, { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1),
    flipH: x2 < x1, flipV: y2 < y1, line: { color, width, endArrowType: arrow, dashType: dash } });
}
// Chevron run: each tip enters the next notch (overlap = notch depth).
function chevrons(slide, x, y, w, h, labels, { active = -1 } = {}) {
  const n = labels.length, notch = h * 0.25, cw = (w + notch * (n - 1)) / n;
  labels.forEach((label, i) => {
    const cx = x + i * (cw - notch), on = i === active;
    slide.addShape(S.chevron, { ...box(cx, y, cw, h), fill: { color: on ? T.accent : T.paperAlt }, line: { color: T.paper, width: 1.5 } });
    slide.addText(label, { ...box(cx + notch, y, cw - notch * 2, h), fontFace: T.sans, fontSize: 13, bold: on, color: on ? 'FFFFFF' : T.body, align: 'center', valign: 'middle', margin: 0 });
  });
}
function node(slide, cx, cy, d, n, { fill = T.accent } = {}) {
  slide.addShape(S.ellipse, { ...box(cx - d / 2, cy - d / 2, d, d), fill: { color: fill }, line: { color: fill } });
  slide.addText(String(n), { ...box(cx - d / 2, cy - d / 2, d, d), fontFace: T.data, fontSize: 14, bold: true, color: 'FFFFFF', align: 'center', valign: 'middle', margin: 0 });
}
function brace(slide, x, y, h, side = 'left') {
  slide.addShape(side === 'left' ? S.leftBrace : S.rightBrace, { ...box(x, y, 0.25, h), fill: { color: T.paper, transparency: 100 }, line: { color: T.muted, width: 1.5 } });
}
// Gauge: block-arc share with the value in the middle on a solid disc (the disc keeps the label's contrast measurable). share 0-1.
function gauge(slide, cx, cy, r, share, value, label, { track = T.paperAlt, disc = T.paper, valueColor = T.ink, labelColor = T.muted } = {}) {
  const sweep = Math.round(360 * share), inner = r * 0.82 * 2 - 0.12;
  slide.addShape(S.blockArc, { ...box(cx - r, cy - r, r * 2, r * 2), angleRange: [270, 269], arcThicknessRatio: 0.18, fill: { color: track }, line: { color: track } });
  slide.addShape(S.blockArc, { ...box(cx - r, cy - r, r * 2, r * 2), angleRange: [270, (270 + sweep) % 360], arcThicknessRatio: 0.18, fill: { color: T.accent }, line: { color: T.accent } });
  slide.addShape(S.ellipse, { ...box(cx - inner / 2, cy - inner / 2, inner, inner), fill: { color: disc }, line: { color: disc } });
  slide.addText(value, { ...box(cx - inner / 2, cy - 0.5, inner, 0.8), fontFace: T.data, fontSize: 40, bold: true, color: valueColor, align: 'center', valign: 'middle', margin: 0 });
  slide.addText(label, { ...box(cx - inner / 2, cy + 0.3, inner, 0.4), fontFace: T.sans, fontSize: 14, bold: true, color: labelColor, align: 'center', margin: 0 });
}
function callout(slide, x, y, w, h, text) {
  slide.addShape(S.wedgeRectCallout, { ...box(x, y, w, h), fill: { color: T.paper }, line: { color: T.line, width: 1 } });
  slide.addText(text, { ...box(x + 0.15, y, w - 0.3, h), fontFace: T.sans, fontSize: 12, color: T.body, valign: 'middle', margin: 0 });
}
// Custom silhouette: diagonal cut field or any polygon, points in inches relative to the box.
function polygon(slide, x, y, w, h, points, fill = T.dark) {
  slide.addShape(S.custGeom, { ...box(x, y, w, h), fill: { color: fill }, line: { color: fill },
    points: [...points.map((p, i) => ({ x: p[0], y: p[1], moveTo: i === 0 })), { close: true }] });
}
// The one elevated object on the slide (peers stay flat).
function lift(slide, x, y, w, h, tint = T.paper) {
  slide.addShape(S.roundRect, { ...box(x, y, w, h), rectRadius: 0.08, fill: { color: tint }, line: { color: tint },
    shadow: { type: 'outer', color: '000000', blur: 12, offset: 4, angle: 90, opacity: 0.10 } });
}
```
Other presets: `S.round1Rect`, `S.snip1Rect`, `S.snipRoundRect`, `S.trapezoid`, `S.parallelogram`, `S.hexagon`, `S.frame`, `S.corner`, `S.pie` + `angleRange`, `S.donut`, `S.rightArrow`, `S.leftRightArrow`, `S.bracePair`; `rotate` and `flipH` apply to all.

## 5. Chart helpers (E1, E2, E3) — native charts, editable data
```js
// Quiet chart: no gridlines, no legend, category labels only, values on the bars/points.
// series: [{ name, values }], labels: categories. accent: index of the one category to color (bars only).
// Stacked-bar labels must sit inside ('inEnd' | 'ctr' | 'inBase'); zero segments are hidden by the format code.
function chart(slide, x, y, w, h, { type = 'col', labels, series, accent = -1, max, min = 0, format = '#,##0', size = 11 } = {}) {
  const bar = type !== 'line';
  const base = { ...box(x, y, w, h), fontFace: T.sans, showLegend: false,
    catAxisLabelColor: T.muted, catAxisLabelFontSize: size, catAxisLabelFontFace: T.sans, catAxisLineShow: false,
    valAxisHidden: true, valAxisLineShow: false, valGridLine: { style: 'none' }, catGridLine: { style: 'none' },
    ...(max != null ? { valAxisMaxVal: max, valAxisMinVal: min } : {}),
    showValue: true, dataLabelColor: T.body, dataLabelFontSize: size, dataLabelFontFace: T.data, dataLabelFormatCode: format + ';;' };
  if (bar && accent >= 0 && series.length === 1) {
    const values = series[0].values;
    slide.addChart(pres.ChartType.bar, [
      { name: series[0].name, labels, values: values.map((v, i) => (i === accent ? 0 : v)) },
      { name: series[0].name + ' ·', labels, values: values.map((v, i) => (i === accent ? v : 0)) },
    ], { ...base, barDir: type === 'bar' ? 'bar' : 'col', barGrouping: 'stacked', barGapWidthPct: 60,
      chartColors: [T.paperAlt, T.accent], dataLabelPosition: 'inEnd', dataLabelColor: T.ink });
    return;
  }
  if (bar) {
    slide.addChart(pres.ChartType.bar, series.map((s) => ({ ...s, labels })), { ...base, barDir: type === 'bar' ? 'bar' : 'col',
      barGapWidthPct: 60, chartColors: [T.accent, T.muted, T.line], dataLabelPosition: 'outEnd' });
    return;
  }
  slide.addChart(pres.ChartType.line, series.map((s) => ({ ...s, labels })), { ...base, lineSize: 2.5, lineDataSymbol: 'none',
    chartColors: [T.accent, T.muted, T.line], dataLabelPosition: 't' });
}
// Small multiples: n identical charts on one row, one label above each, shared axis range (E3).
function smallMultiples(slide, x, y, w, h, panels, { type = 'col', max, gap = 0.3, format = '#,##0' } = {}) {
  const pw = (w - gap * (panels.length - 1)) / panels.length;
  const top = max ?? Math.max(...panels.flatMap((p) => p.series.flatMap((s) => s.values))) * 1.15;
  panels.forEach((p, i) => {
    const px = x + i * (pw + gap);
    slide.addText(p.title, { ...box(px, y, pw, 0.35), fontFace: T.sans, fontSize: 13, bold: true, color: T.ink, margin: 0 });
    chart(slide, px, y + 0.4, pw, h - 0.4, { type, labels: p.labels, series: p.series, max: top, accent: p.accent ?? -1, format });
  });
}
```

## 6. Relationship helpers (R3, R5, R14, R15)
```js
// Stepped process: blocks rising (dir 1) or falling (dir -1), connected edge to edge; the last block is the accent.
function steps(slide, items, { x = M, y = 5.3, w = 2.2, h = 1.3, dx = 2.45, dy = 0.85, dir = 1 } = {}) {
  items.forEach(([lead, note], i) => {
    const bx = x + i * dx, by = y - i * dy * dir, last = i === items.length - 1;
    slide.addShape(S.round1Rect, { ...box(bx, by, w, h), fill: { color: last ? T.accent : T.paperAlt }, line: { color: T.paper, width: 1 } });
    slide.addText([{ text: lead, options: { bold: true, breakLine: true } }, { text: note, options: { fontSize: 11.5, color: last ? 'FFFFFF' : T.muted } }],
      { ...box(bx + 0.2, by + 0.15, w - 0.4, h - 0.3), fontFace: T.sans, fontSize: 14, color: last ? 'FFFFFF' : T.ink, valign: 'top', margin: 0 });
    if (i < items.length - 1) connector(slide, bx + w, by + h / 2, bx + dx, by + h / 2 - dy * dir, { color: T.line, width: 1.5 });
  });
}
// Cycle: n block-arc segments with a small gap, labels outside at the mid-angle, a paper disc in the middle for a center label.
function cycle(slide, cx, cy, r, labels, { gap = 6, active = -1, thickness = 0.28 } = {}) {
  const n = labels.length, span = 360 / n;
  labels.forEach((label, i) => {
    const start = (270 + i * span + gap / 2) % 360, end = (270 + (i + 1) * span - gap / 2) % 360, on = i === active;
    slide.addShape(S.blockArc, { ...box(cx - r, cy - r, r * 2, r * 2), angleRange: [start, end], arcThicknessRatio: thickness, fill: { color: on ? T.accent : T.paperAlt }, line: { color: on ? T.accent : T.paperAlt } });
    const mid = (270 + (i + 0.5) * span) * Math.PI / 180, lx = cx + (r + 0.9) * Math.cos(mid), ly = cy + (r + 0.9) * Math.sin(mid);
    slide.addText(label, { ...box(lx - 1.1, ly - 0.3, 2.2, 0.6), fontFace: T.sans, fontSize: 14, bold: on, color: on ? T.accent : T.ink, align: 'center', valign: 'middle', margin: 0 });
  });
  const inner = r * (1 - thickness) * 2 - 0.12;
  slide.addShape(S.ellipse, { ...box(cx - inner / 2, cy - inner / 2, inner, inner), fill: { color: T.paper }, line: { color: T.paper } });
}
// Tiered stack: trapezoid tiers on one shared taper, widths monotonic; tier 0 is the top.
function tiers(slide, cx, y, labels, { topW = 3.2, step = 1.4, h = 0.95 } = {}) {
  labels.forEach((label, i) => {
    const w = topW + i * step, x = cx - w / 2, ty = y + i * h;
    slide.addShape(S.trapezoid, { ...box(x, ty, w, h), fill: { color: i === 0 ? T.accent : T.paperAlt }, line: { color: T.paper, width: 1.5 } });
    slide.addText(label, { ...box(x, ty + 0.1, w, h - 0.2), fontFace: T.sans, fontSize: 13, bold: i === 0, color: i === 0 ? 'FFFFFF' : T.ink, align: 'center', valign: 'middle', margin: 0 });
  });
}
// Overlapping sets: 2-3 translucent ellipses, owner labels outside, the shared meaning in the common region.
function sets(slide, cx, cy, d, labels, { overlap = 1.1, shared = '' } = {}) {
  const n = labels.length, stride = d - overlap, x0 = cx - (stride * (n - 1)) / 2;
  labels.forEach((label, i) => {
    const x = x0 + i * stride;
    slide.addShape(S.ellipse, { ...box(x - d / 2, cy - d / 2, d, d), fill: { color: i % 2 ? T.accentDeep : T.accent, transparency: 65 }, line: { color: T.paper, width: 1 } });
    slide.addText(label, { ...box(x - d / 2, cy + d / 2 + 0.1, d, 0.4), fontFace: T.sans, fontSize: 13, bold: true, color: T.ink, align: 'center', margin: 0 });
  });
  if (shared) slide.addText(shared, { ...box(cx - 1.2, cy - 0.35, 2.4, 0.7), fontFace: T.sans, fontSize: 12, color: T.ink, align: 'center', valign: 'middle', margin: 0 });
}
```
