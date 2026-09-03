# Device kit

Owns the code: the helper functions that realize `design.md` §5 devices and `layouts.md` skeletons. Adapt the tokens to the brief, keep the functions, and draw every repeated element through one function so the deck stays consistent. Picture helpers are in `pictures.md` §4.

**Hard rule — paragraph options sit on the first run**: the runtime keeps one `a:pPr` per paragraph (the first). `bullet`, `align`, `paraSpaceAfter`, `lineSpacingMultiple` go on the text box or on a paragraph's first run; `breakLine: true` on a paragraph's last run. A later run carrying them loses them silently.

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
  display: 'Cambria', sans: 'Calibri', data: 'Arial',   // Korean decks: display and sans = 'Malgun Gothic'
};
const box = (x, y, w, h) => ({ x, y, w, h });
const PX = 160;                                 // raster density: inches × PX = pixels (≥ 2× placed size)

// Page chrome lives on masters, not on slides: background, page number, and any
// element every slide of that role repeats. Add a master per background role.
pres.defineSlideMaster({ title: 'CONTENT', background: { color: T.paper },
  slideNumber: { x: W - M - 1, y: H - 0.5, w: 1, h: 0.3, fontFace: T.data, fontSize: 9, color: T.muted, align: 'right' } });
pres.defineSlideMaster({ title: 'BREATHING', background: { color: T.dark },
  slideNumber: { x: W - M - 1, y: H - 0.5, w: 1, h: 0.3, fontFace: T.data, fontSize: 9, color: T.onDarkMuted, align: 'right' } });
pres.defineSlideMaster({ title: 'ANCHOR', background: { color: T.dark } });
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
function kicker(slide, text, x = M, y = 0.6, color = T.accent) {
  slide.addText(text.toUpperCase(), { ...box(x, y, 6, 0.3), fontFace: T.data, fontSize: 11, bold: true, color, charSpacing: 4, margin: 0 });
}
function title(slide, text, { x = M, y = 1.0, w = W - 2 * M, size = 32, color = T.ink, align = 'left' } = {}) {
  const h = Math.max(0.6, text.split('\n').length * (size / 72) * 1.3);
  slide.addText(text, { ...box(x, y, w, h), fontFace: T.display, fontSize: size, bold: true, color, align, margin: 0, valign: 'top' });
}
// Paragraphs of inline runs: [[['plain ', {}], ['42%', { bold: true, color: T.accent }], [' of users', {}]], [...next paragraph]]
function emphasis(slide, paragraphs, x, y, w, h, size = 18, color = T.body) {
  const runs = [];
  paragraphs.forEach((para, pi) => para.forEach(([text, o], ri) => runs.push({ text, options: {
    ...o,
    ...(ri === 0 ? { paraSpaceAfter: size * 0.8 } : {}),                            // paragraph options: first run
    ...(ri === para.length - 1 && pi < paragraphs.length - 1 ? { breakLine: true } : {}),  // paragraph break: last run
  } })));
  slide.addText(runs, { ...box(x, y, w, h), fontFace: T.sans, fontSize: size, color, margin: 0, valign: 'top', lineSpacingMultiple: 1.3 });
}
function takeaway(slide, text, y, { x = M, w = W - 2 * M, h = 0.7 } = {}) {
  slide.addShape(S.rect, { ...box(x, y, w, h), fill: { color: T.tint }, line: { color: T.tint } });
  slide.addText(text, { ...box(x + 0.25, y, w - 0.5, h), fontFace: T.sans, fontSize: 17, color: T.ink, margin: 0, valign: 'middle' });
}
function hero(slide, x, y, w, value, label, { color = T.accent, size = 56, unit = '', labelColor = T.muted } = {}) {
  const runs = [{ text: value, options: { fontSize: size } }];
  if (unit) runs.push({ text: unit, options: { fontSize: Math.round(size * 0.4) } });
  const h = Math.max(1.12, size / 72 * 1.2);    // numeral box grows with the size; the label sits 0.05 in under it
  slide.addText(runs, { ...box(x, y, w, h), fontFace: T.data, bold: true, color, margin: 0, valign: 'bottom' });
  slide.addText(label, { ...box(x, y + h + 0.05, w, 0.45), fontFace: T.sans, fontSize: 13, color: labelColor, margin: 0, valign: 'top' });
}
function body(slide, x, y, w, h, lines, size = 14, color = T.body) {
  slide.addText(lines.map((text, i) => ({ text, options: { bullet: true, paraSpaceAfter: 8, breakLine: i < lines.length - 1 } })),
    { ...box(x, y, w, h), fontFace: T.sans, fontSize: size, color, valign: 'top', margin: 0 });
}
function prose(slide, text, x, y, w, h, size = 15, color = T.body) {
  slide.addText(text, { ...box(x, y, w, h), fontFace: T.sans, fontSize: size, color, valign: 'top', margin: 0, lineSpacingMultiple: 1.45 });
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
  slide.addText(value, { ...box(cx - r, cy - 0.5, r * 2, 0.8), fontFace: T.data, fontSize: 40, bold: true, color: valueColor, align: 'center', valign: 'middle', margin: 0 });
  slide.addText(label, { ...box(cx - r, cy + 0.3, r * 2, 0.4), fontFace: T.sans, fontSize: 14, bold: true, color: labelColor, align: 'center', margin: 0 });
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

## 5. Relationship helpers (R3, R5, R14, R15)
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
