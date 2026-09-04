# Kit

Owns the code: primitives that draw what `composition.md` names, sized with `MEASURE` so text never overflows. The kit is a toolbox, not a slide catalog — no function here draws a whole slide, and every position is the author's. Adapt the tokens to the brief; keep the functions; draw every repeated element through one function so the deck stays consistent. Picture helpers are in `pictures.md` §4.

**Hard rule — paragraph options sit on the first run**: the runtime keeps one `a:pPr` per paragraph (the first). `bullet`, `align`, `paraSpaceAfter`, `lineSpacingMultiple` go on the text box or on a paragraph's first run; `breakLine: true` on a paragraph's last run. → runtime (absorbed: the normalizer keeps the first `pPr`; nothing to check)

## 1. Tokens, palette, type, masters
```js
const pptxgen = require('pptxgenjs');
const sharp = require('sharp');
const pres = new pptxgen();
pres.layout = 'LAYOUT_WIDE';
const W = 13.33, H = 7.5, M = 0.6;            // canvas + outer margin (inches); safe area x M..W-M, y M..H-M
const S = pres.ShapeType;                      // camelCase presets: S.chevron, S.blockArc, S.round1Rect, S.leftBrace, S.wedgeRectCallout, S.custGeom
const box = (x, y, w, h) => ({ x, y, w, h });
const PX = 160;                                 // raster density: inches × PX = pixels (≥ 2× placed size)
const GAP = { within: 0.12, between: 0.45 };   // two spacing steps (composition.md §6): within binds, between separates

// Palette from one seed hue (direction.md §5). hsl(h 0-360, s 0-1, l 0-1) → 6-digit hex without '#'.
function hsl(h, s, l) {
  const k = (n) => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
  const f = (n) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))));
  return [f(0), f(8), f(4)].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();
}
// WCAG contrast between two hex colors; the ladder is derived by contrast, not by fixed lightness, so a
// luminous hue (green, yellow) darkens its accent and muted steps until the text contrast holds.
function contrast(a, b) {
  const lum = (hex) => { const c = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
// Lower l from `start` until color(h, s, l) reaches `min` contrast against every background in `against`.
function darkenUntil(h, s, start, against, min) {
  let l = start;
  while (l > 0.08 && against.some((bg) => contrast(hsl(h, s, l), bg) < min)) l -= 0.01;
  return hsl(h, s, l);
}
// The ladder: neutrals within the hue, one saturated accent (optionally on a second hue), tinted extremes.
// Guarantees: body and muted ≥ 4.5:1 on paper and paperAlt; white ≥ 3:1 on accent; accent ≥ 4.5:1 on paper (an emphasis run stays readable).
function palette({ hue = 205, accentHue = hue, accentSat = 0.72, accentLight = 0.42 } = {}) {
  const paper = hsl(hue, 0.25, 0.975), paperAlt = hsl(hue, 0.18, 0.92), tint = hsl(accentHue, 0.35, 0.89), dark = hsl(hue, 0.42, 0.10);
  const accent = darkenUntil(accentHue, accentSat, accentLight, ['FFFFFF', paper, tint], 4.5);
  return {
    ink: hsl(hue, 0.30, 0.13), body: darkenUntil(hue, 0.22, 0.30, [paperAlt], 7), muted: darkenUntil(hue, 0.12, 0.45, [paperAlt, tint], 4.5),
    line: hsl(hue, 0.16, 0.86), paper, paperAlt, tint,
    dark, darkAlt: hsl(hue, 0.34, 0.17),
    onDark: hsl(hue, 0.20, 0.94), onDarkMuted: hsl(hue, 0.14, 0.72), onDarkAccent: hsl(accentHue, 0.62, 0.74),
    accent, accentDeep: darkenUntil(accentHue, accentSat, accentLight - 0.1, ['FFFFFF', paper], 6),
  };
}
const T = { ...palette({ hue: 205 }), display: '', sans: '', light: '', data: '' };   // seed from the brief; faces set by typography()

// Type scale (direction.md §6): the reading mode sets the body anchor; every role derives from it.
const MODE = 'balanced';                        // presentation 24 · balanced 18 · text 15 (body pt); the brief's reading mode
function typeScale(mode) {
  const b = { presentation: 24, balanced: 18, text: 15 }[mode] ?? 18;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Math.round(v)));
  return {
    body: b, lead: Math.round(b * 1.2), caption: clamp(b * 0.7, 10.5, 16), kicker: clamp(b * 0.62, 10, 14),
    section: Math.round(b * 1.5), title: clamp(b * 2, 28, 44), cover: clamp(b * 2.6, 36, 56), hero: Math.round(b * 3.6),
  };
}
const TYPE = typeScale(MODE);
// Diagram type: labels inside chevrons, nodes, tiers and the notes under them follow the mode (balanced 14 / 11.5).
const DIAG = { label: TYPE.caption + 1, note: Math.max(9.5, TYPE.caption - 1.5) };

// Typography roles (direction.md §6). script: 'ko' | 'ja' | 'zh' | 'latin'; pairing: 'serif' | 'weight' | 'concord';
// fonts: 'noto' (provisioned with the Office capability; the default) | 'safe' (Office system faces, when recipients lack Noto).
function typography({ script = 'ko', pairing = 'weight', fonts = 'noto' } = {}) {
  const serif = pairing === 'serif';
  const latin = fonts === 'noto'
    ? { display: serif ? 'Noto Serif' : 'Noto Sans', sans: 'Noto Sans', light: 'Noto Sans', data: 'Arial' }
    : { display: serif ? 'Cambria' : 'Calibri', sans: 'Calibri', light: 'Calibri Light', data: 'Arial' };
  const cjk = {
    ko: ['Noto Sans KR', 'Noto Serif KR', 'Malgun Gothic', 'Malgun Gothic Semilight'],
    ja: ['Noto Sans JP', 'Noto Serif JP', 'Yu Gothic', 'Yu Gothic'],
    zh: ['Noto Sans SC', 'Noto Serif SC', 'Microsoft YaHei', 'Microsoft YaHei'],
  }[script];
  if (!cjk) return Object.assign(T, latin);
  const [sans, serifFace, safeSans, safeLight] = cjk;
  return Object.assign(T, fonts === 'noto'
    ? { display: serif ? serifFace : sans, sans, light: sans, data: 'Arial' }
    : { display: safeSans, sans: safeSans, light: safeLight, data: safeSans });
}
typography({ script: 'ko', pairing: 'weight', fonts: 'noto' });

// Page chrome lives on masters, not on slides: the background and, when the deck wants it, the page number.
function master(name, background, { number = true, color = T.muted } = {}) {
  pres.defineSlideMaster({ title: name, background: { color: background },
    ...(number ? { slideNumber: { x: W - M - 1, y: H - 0.5, w: 1, h: 0.3, fontFace: T.data, fontSize: 9, color, align: 'right' } } : {}) });
}
master('LIGHT', T.paper);
master('DARK', T.dark, { color: T.onDarkMuted });
master('QUIET', T.dark, { number: false });    // cover and closing
const light = () => pres.addSlide({ masterName: 'LIGHT' });
const dark = () => pres.addSlide({ masterName: 'DARK' });
const quiet = () => pres.addSlide({ masterName: 'QUIET' });
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
// Icon by name from the offline set (ICON is injected: 256 Lucide stroke icons — ICON.names lists them; an
// unknown name throws with the nearest), or a 24-unit fill path of your own. Optionally inside a tinted disc.
async function icon(slide, x, y, d, name, { tint = T.paperAlt, color = T.accent, disc = true, stroke = 2 } = {}) {
  if (disc) slide.addShape(S.ellipse, { ...box(x, y, d, d), fill: { color: tint }, line: { color: tint } });
  const inset = disc ? 0.25 : 0, px = Math.round(d * (1 - inset * 2) * PX);
  const svg = /^[Mm]/.test(name)
    ? `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 24 24"><path d="${name}" fill="#${color}"/></svg>`
    : ICON.svg(name, { color, size: px, strokeWidth: stroke });
  slide.addImage({ data: await png(svg), ...box(x + d * inset, y + d * inset, d * (1 - inset * 2), d * (1 - inset * 2)) });
}
// A row of icon-led items: icon in a disc, bold header, measured description — widths by weight.
async function iconRow(slide, x, y, w, items, { d = 0.6, gap = 0.35, size = TYPE.body } = {}) {
  const cols = spans(x, w, items.map((it) => weightOf({ label: it.label, detail: it.detail })), { gap });
  let bottom = y;
  for (let i = 0; i < items.length; i += 1) {
    const { label, detail, icon: name } = items[i], c = cols[i];
    await icon(slide, c.x, y, d, name);
    const lb = text(slide, label, c.x, y + d + GAP.within, c.w, size, { color: T.ink, font: T.sans, bold: true, lh: 1.2 });
    bottom = Math.max(bottom, detail ? text(slide, detail, c.x, lb + 0.06, c.w, TYPE.caption, { lh: 1.35 }) : lb);
  }
  return bottom;
}
// Soft radial glow behind a hero element (dark-tech, cover motif).
async function glow(slide, cx, cy, r, color = T.accent, alpha = 0.35) {
  const px = Math.round(r * 2 * PX);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}"><defs><radialGradient id="r"><stop offset="0%" stop-color="#${color}" stop-opacity="${alpha}"/><stop offset="100%" stop-color="#${color}" stop-opacity="0"/></radialGradient></defs><circle cx="${px / 2}" cy="${px / 2}" r="${px / 2}" fill="url(#r)"/></svg>`;
  slide.addImage({ data: await png(svg), ...box(cx - r, cy - r, r * 2, r * 2) });
}
```

## 3. Measured text
`MEASURE` is injected by the runtime with the review's own font metrics; every text box here is sized with it, never by guessing. `lh` is the box's `lineSpacingMultiple` (1 = single); PowerPoint lays every face out at 1.2 em per single line, Hangul and Latin alike. Leading is the author's call per box (`direction.md` §6); the helpers only default it.
```js
// fitH: the height a box of width w needs for text at size; fitSize: the largest size ≤ size that fits w × h.
const fitH = (text, w, size, font = T.sans, { bold = false, lh = 1 } = {}) => MEASURE(text, { font, size, bold, width: w, lineHeight: lh }).height + 0.06;
const lineH = (size, font = T.sans, lh = 1) => size / 72 * 1.2 * lh;   // PowerPoint's single pitch, every face
const textW = (text, size, font = T.sans, bold = false) => MEASURE(text, { font, size, bold }).width;
function fitSize(text, w, h, size, font = T.sans, { bold = false, lh = 1, min = 12 } = {}) {
  let s = size;
  while (s > min && fitH(text, w, s, font, { bold, lh }) > h) s -= 1;
  return s;
}
// The general measured text box. Returns the bottom edge so the next element registers under it.
// Defaults: light face, lh 1.2 for lead size and above, 1.35 under it; pass lh, font, bold, align, valign, h (fixed height) as the page needs.
function text(slide, str, x, y, w, size, { color = T.body, font = T.light, bold = false, align = 'left', valign = 'top', lh, h } = {}) {
  lh ??= h ? 1 : (size >= TYPE.lead ? 1.2 : 1.35);
  const face = bold && font === T.light ? T.sans : font;
  const height = h ?? fitH(str, w, size, face, { bold, lh });
  slide.addText(str, { ...box(x, y, w, height), fontFace: face, fontSize: size, bold, color, align, valign, margin: 0, lineSpacingMultiple: lh });
  return y + height;
}
// Title: display face, bold; the size steps down (to 24) when the text would need more than maxLines. Returns the bottom edge.
function title(slide, str, { x = M, y = 1.0, w = W - 2 * M, size = TYPE.title, color = T.ink, align = 'left', maxLines = 2, lh = 1.15 } = {}) {
  let s = size;
  while (s > 24 && MEASURE(str, { font: T.display, size: s, bold: true, width: w, lineHeight: lh }).lines > maxLines) s -= 2;
  const h = Math.max(0.6, fitH(str, w, s, T.display, { bold: true, lh }));
  slide.addText(str, { ...box(x, y, w, h), fontFace: T.display, fontSize: s, bold: true, color, align, margin: 0, valign: 'top', lineSpacingMultiple: lh });
  return y + h;
}
// Kicker: a real section or topic name above a title. Latin gets tracking (charSpacing); Hangul never does.
function kicker(slide, str, x = M, y = 0.6, color = T.accent, w = 6) {
  const latin = !/[\u1100-\u11FF\u3130-\u318F\uAC00-\uD7AF\u3040-\u30FF\u4E00-\u9FFF]/.test(str);
  slide.addText(latin ? str.toUpperCase() : str, { ...box(x, y, w, 0.3), fontFace: latin ? T.data : T.sans, fontSize: TYPE.kicker, bold: true, color,
    ...(latin ? { charSpacing: 4 } : {}), margin: 0 });
}
// Paragraphs of inline runs: [[['plain ', {}], ['42%', { bold: true, color: T.accent }], [' of users', {}]], [...next paragraph]].
// The body sits in the light face; an emphasized run switches to the sans or bold so weight carries the emphasis.
// PowerPoint lets a mixed-weight Korean line overshoot its box by 2-4 pt; the box carries a 7 pt right inset so the text zone stays w.
function emphasis(slide, paragraphs, x, y, w, h, size = TYPE.lead, color = T.body, { lh = 1.35, font = T.light } = {}) {
  const inset = 7;
  const runs = [];
  paragraphs.forEach((para, pi) => para.forEach(([str, o], ri) => runs.push({ text: str, options: {
    ...(o.bold || o.color ? { fontFace: T.sans } : {}),
    ...o,
    ...(ri === 0 && pi < paragraphs.length - 1 ? { paraSpaceAfter: size * 0.8 } : {}),   // the step between paragraphs, never trailing space
    ...(ri === para.length - 1 && pi < paragraphs.length - 1 ? { breakLine: true } : {}),
  } })));
  slide.addText(runs, { ...box(x, y, w + inset / 72, h), fontFace: font, fontSize: size, color, margin: [0, inset, 0, 0], valign: 'top', lineSpacingMultiple: lh });
}
// Hero numeral with its label under it (0.05 in). Returns the bottom edge of the label.
function hero(slide, x, y, w, value, label, { color = T.accent, size = TYPE.hero, unit = '', labelColor = T.muted, labelSize = TYPE.caption } = {}) {
  const runs = [{ text: value, options: { fontSize: size } }];
  if (unit) runs.push({ text: unit, options: { fontSize: Math.round(size * 0.4) } });
  const h = Math.max(1.12, lineH(size, T.data) + 0.04);
  slide.addText(runs, { ...box(x, y, w, h), fontFace: T.data, bold: true, color, margin: 0, valign: 'bottom' });
  if (!label) return y + h;
  const lh = fitH(label, w, labelSize);
  slide.addText(label, { ...box(x, y + h + 0.05, w, lh), fontFace: T.sans, fontSize: labelSize, color: labelColor, margin: 0, valign: 'top' });
  return y + h + 0.05 + lh;
}
// A genuine list: one text box, bullets on each item, a paragraph step visibly larger than the line step.
function bullets(slide, x, y, w, h, items, size = TYPE.body, color = T.body, { lh = 1.35, font = T.light } = {}) {
  const s = fitSize(items.join('\n'), w - 0.3, h - items.length * size * 0.6 / 72, size, font, { lh, min: TYPE.caption });
  slide.addText(items.map((str, i) => ({ text: str, options: { bullet: true, paraSpaceAfter: Math.round(s * 0.6), breakLine: i < items.length - 1 } })),
    { ...box(x, y, w, h), fontFace: font, fontSize: s, color, valign: 'top', margin: 0, lineSpacingMultiple: lh });
}
// Prose: h is the ceiling; the size steps down (to 12) until the text fits it.
function prose(slide, str, x, y, w, h, size = TYPE.body, color = T.body, { lh = 1.45, font = T.light } = {}) {
  const s = fitSize(str, w, h, size, font, { lh });
  slide.addText(str, { ...box(x, y, w, h), fontFace: font, fontSize: s, color, valign: 'top', margin: 0, lineSpacingMultiple: lh });
}
// Caption / source line under a figure or picture: caption size, muted, registered to the figure's left edge.
function caption(slide, str, x, y, w, color = T.muted) {
  return text(slide, str, x, y, w, TYPE.caption, { color, lh: 1.2 });
}
// Takeaway band: one sentence closing a page that has a claim to close; sits near the lower safe margin.
function takeaway(slide, str, y = H - M - 0.75, { x = M, w = W - 2 * M, h = 0.7, tint = T.tint, color = T.ink } = {}) {
  const size = fitSize(str, w - 0.5, h - 0.2, TYPE.lead, T.sans, { min: TYPE.caption });
  slide.addShape(S.rect, { ...box(x, y, w, h), fill: { color: tint }, line: { color: tint } });
  slide.addText(str, { ...box(x + 0.25, y, w - 0.5, h), fontFace: T.sans, fontSize: size, color, margin: 0, valign: 'middle' });
}
// Specimen: the subject drawn, not described. rows: [{ text, font, size, bold, label, color }] on one baseline grid.
function specimen(slide, x, y, w, rows, { labelW = 1.6, gap = 0.35, labelColor = T.muted } = {}) {
  let cy = y;
  for (const r of rows) {
    const font = r.font || T.sans, size = r.size || TYPE.body, bold = r.bold === true;
    const h = Math.max(0.45, fitH(r.text, w - labelW - 0.2, size, font, { bold, lh: 1.2 }) + 0.05);
    slide.addText(r.label || '', { ...box(x, cy, labelW, 0.4), fontFace: T.data, fontSize: TYPE.caption - 1, color: labelColor, margin: 0, valign: 'top' });
    slide.addText(r.text, { ...box(x + labelW + 0.2, cy, w - labelW - 0.2, h), fontFace: font, fontSize: size, bold, color: r.color || T.ink, margin: 0, valign: 'top', lineSpacingMultiple: 1.2 });
    cy += h + gap;
  }
  return cy;
}
// Ghost numeral: a chapter mark behind content. Keep the box inside the canvas (w ≤ W - x).
function ghost(slide, str, x, y, size = 240, w = 5.5, { color = 'FFFFFF', transparency = 88 } = {}) {
  slide.addText(str, { ...box(x, y, w, lineH(size, T.data) + 0.05), fontFace: T.data, fontSize: size, bold: true, color, transparency, margin: 0, valign: 'top' });
}
```

## 4. Layout by weight (composition.md §6)
```js
// Content weight of a peer: an explicit `weight`, else the length of what it says; an active peer counts more.
const weightOf = (item, { active = false } = {}) => (Number(item?.weight)
  || Math.max(1, [item?.value, item?.label, item?.detail, item?.context, item?.text].filter(Boolean).join(' ').length)) * (active ? 1.35 : 1);
// spans: widths for a row of peers from their weights, clamped so the lightest stays readable and the heaviest does not swallow the row.
function spans(x, w, weights, { gap = 0.3, minRatio = 0.7, maxRatio = 1.6 } = {}) {
  const n = weights.length, mean = weights.reduce((a, b) => a + b, 0) / n || 1;
  const norm = weights.map((v) => Math.min(maxRatio, Math.max(minRatio, (v || mean) / mean)));
  const total = norm.reduce((a, b) => a + b, 0), free = w - gap * (n - 1);
  let cx = x;
  return norm.map((v) => { const cw = free * v / total; const out = { x: cx, w: cw }; cx += cw + gap; return out; });
}
// splitAt: the seam of a two-plane slide from each side's weight; never the middle unless the weights are equal.
function splitAt(x, w, leftWeight, rightWeight, { gap = 0.3, min = 0.38, max = 0.62 } = {}) {
  const share = Math.min(max, Math.max(min, leftWeight / ((leftWeight + rightWeight) || 1)));
  const lw = (w - gap) * share;
  return { left: { x, w: lw }, right: { x: x + lw + gap, w: w - gap - lw } };
}
// flow: measured blocks stacked top-down inside one region; returns the bottom. A block is
// { text, size?, font?, bold?, color?, lh?, h?, after? } or a function (y) => bottom for any kit call.
// A block that would cross the region's bottom throws (never a silent drop): widen the zone, shorten the copy, or cut a block.
function flow(slide, x, y, w, blocks, { gap = 0.18, bottom = H - M } = {}) {
  let cy = y;
  blocks.forEach((b, i) => {
    if (!b) return;
    if (typeof b === 'function') { cy = b(cy) + gap; return; }
    const size = b.size || TYPE.body, font = b.font || (b.bold ? T.sans : T.light), lh = b.lh ?? (b.h ? 1 : 1.35);
    const h = b.h ?? fitH(b.text, w, size, font, { bold: !!b.bold, lh });
    if (cy + h > bottom + 0.01) throw new Error(`flow: block ${i + 1} of ${blocks.length} ("${String(b.text).slice(0, 24)}…") needs ${(cy + h - bottom).toFixed(2)} in past the region bottom ${bottom}`);
    slide.addText(b.text, { ...box(x, cy, w, h), fontFace: font, fontSize: size, bold: !!b.bold, color: b.color || T.body, margin: 0, valign: 'top', lineSpacingMultiple: lh });
    cy += h + (b.after ?? gap);
  });
  return cy;
}
```

## 5. Shapes (native, editable in PowerPoint)
```js
function field(slide, x, y, w, h, tint = T.paperAlt, shape = S.rect, extra = {}) {   // page field or module surface
  slide.addShape(shape, { ...box(x, y, w, h), fill: { color: tint }, line: { color: tint }, ...extra });
}
// Outline carrier: no fill, one coherent stroke — ownership without a heavy card.
function outline(slide, x, y, w, h, { color = T.line, width = 1, shape = S.rect, radius = 0, dash = 'solid' } = {}) {
  slide.addShape(shape, { ...box(x, y, w, h), fill: { color: T.paper, transparency: 100 }, line: { color, width, dashType: dash }, ...(radius ? { rectRadius: radius } : {}) });
}
// Badge / chip: compact status, tag, or category label. Ink on tint by default; white on the accent for the emphasized one.
function badge(slide, x, y, w, h, str, { fill = T.tint, color = T.ink, font = T.sans, size = TYPE.kicker } = {}) {
  slide.addShape(S.roundRect, { ...box(x, y, w, h), rectRadius: 0.5, fill: { color: fill }, line: { color: fill } });
  slide.addText(str, { ...box(x, y, w, h), fontFace: font, fontSize: size, bold: true, color, align: 'center', valign: 'middle', margin: 0 });
}
function hairline(slide, x, y, w, color = T.line) {   // horizontal rule
  slide.addShape(S.line, { ...box(x, y, w, 0), line: { color, width: 1 } });
}
function rule(slide, x, y, h, color = T.line, width = 1) {   // vertical rule the content hangs from
  slide.addShape(S.line, { ...box(x, y, 0, h), line: { color, width } });
}
function connector(slide, x1, y1, x2, y2, { color = T.muted, width = 1.5, arrow = 'triangle', dash = 'solid' } = {}) {
  slide.addShape(S.line, { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1),
    flipH: x2 < x1, flipV: y2 < y1, line: { color, width, endArrowType: arrow, dashType: dash } });
}
// Chevron run: each tip enters the next notch. widths: per-stage spans from spans() (weights), else equal — equal only when the stages carry equal weight.
function chevrons(slide, x, y, w, h, labels, { active = -1, widths = null, size = DIAG.label - 1 } = {}) {
  const n = labels.length, notch = h * 0.25;
  const ws = widths ? widths.map((c) => c.w) : labels.map(() => (w - notch) / n);
  let cx = x;
  labels.forEach((label, i) => {
    const cw = ws[i] + notch, on = i === active;
    slide.addShape(S.chevron, { ...box(cx, y, cw, h), fill: { color: on ? T.accent : T.paperAlt }, line: { color: T.paper, width: 1.5 } });
    slide.addText(label, { ...box(cx + notch, y, cw - notch * 2, h), fontFace: T.sans, fontSize: size, bold: on, color: on ? 'FFFFFF' : T.body, align: 'center', valign: 'middle', margin: 0 });
    cx += ws[i];
  });
}
function node(slide, cx, cy, d, str, { fill = T.accent, color = 'FFFFFF', size = DIAG.label } = {}) {
  slide.addShape(S.ellipse, { ...box(cx - d / 2, cy - d / 2, d, d), fill: { color: fill }, line: { color: fill } });
  slide.addText(String(str), { ...box(cx - d / 2, cy - d / 2, d, d), fontFace: T.data, fontSize: size, bold: true, color, align: 'center', valign: 'middle', margin: 0 });
}
function brace(slide, x, y, h, side = 'left', color = T.muted) {
  slide.addShape(side === 'left' ? S.leftBrace : S.rightBrace, { ...box(x, y, 0.25, h), fill: { color: T.paper, transparency: 100 }, line: { color, width: 1.5 } });
}
// Block-arc segment around (cx, cy): angles in degrees clockwise from 3 o'clock (270 = 12 o'clock). thickness 0-1 of the radius.
function arc(slide, cx, cy, r, start, end, { color = T.accent, thickness = 0.28 } = {}) {
  slide.addShape(S.blockArc, { ...box(cx - r, cy - r, r * 2, r * 2), angleRange: [start % 360, end % 360], arcThicknessRatio: thickness, fill: { color }, line: { color } });
}
// Gauge: one proportion (share 0-1) with the value on a solid disc in the middle.
function gauge(slide, cx, cy, r, share, value, label, { track = T.paperAlt, disc = T.paper, valueColor = T.ink, labelColor = T.muted } = {}) {
  const sweep = Math.round(360 * share), inner = r * 0.82 * 2 - 0.12;
  arc(slide, cx, cy, r, 270, 269, { color: track, thickness: 0.18 });
  arc(slide, cx, cy, r, 270, 270 + sweep, { thickness: 0.18 });
  slide.addShape(S.ellipse, { ...box(cx - inner / 2, cy - inner / 2, inner, inner), fill: { color: disc }, line: { color: disc } });
  const vs = Math.round(40 * r / 1.6), ls = Math.round(14 * Math.min(1.3, r / 1.6)), vh = lineH(vs, T.data) + 0.1;
  slide.addText(value, { ...box(cx - inner / 2, cy - vh * 0.7, inner, vh), fontFace: T.data, fontSize: vs, bold: true, color: valueColor, align: 'center', valign: 'middle', margin: 0 });
  slide.addText(label, { ...box(cx - inner / 2, cy + vh * 0.3 + 0.05, inner, lineH(ls, T.sans) + 0.1), fontFace: T.sans, fontSize: ls, bold: true, color: labelColor, align: 'center', margin: 0 });
}
function callout(slide, x, y, w, h, str, { size = DIAG.label - 1 } = {}) {
  slide.addShape(S.wedgeRectCallout, { ...box(x, y, w, h), fill: { color: T.paper }, line: { color: T.line, width: 1 } });
  slide.addText(str, { ...box(x + 0.15, y, w - 0.3, h), fontFace: T.sans, fontSize: size, color: T.body, valign: 'middle', margin: 0 });
}
// Custom silhouette: diagonal cut field or any polygon, points in inches relative to the box.
function polygon(slide, x, y, w, h, points, fill = T.dark) {
  slide.addShape(S.custGeom, { ...box(x, y, w, h), fill: { color: fill }, line: { color: fill },
    points: [...points.map((p, i) => ({ x: p[0], y: p[1], moveTo: i === 0 })), { close: true }] });
}
// The one elevated object on the slide (peers stay flat).
function lift(slide, x, y, w, h, tint = T.paper, { radius = 0.08 } = {}) {
  slide.addShape(S.roundRect, { ...box(x, y, w, h), rectRadius: radius, fill: { color: tint }, line: { color: tint },
    shadow: { type: 'outer', color: '000000', blur: 12, offset: 4, angle: 90, opacity: 0.10 } });
}
```
Other presets: `S.round1Rect`, `S.snip1Rect`, `S.snipRoundRect`, `S.trapezoid`, `S.parallelogram`, `S.hexagon`, `S.frame`, `S.corner`, `S.pie` + `angleRange`, `S.donut`, `S.rightArrow`, `S.leftArrow`, `S.downArrow`, `S.leftRightArrow`, `S.bracePair`, `S.triangle`; `rotate` and `flipH` apply to all.

## 6. Native charts and tables — editable data
```js
// Quiet chart: no gridlines, no legend, category labels only, values on the bars/points.
// type: col | bar | line | area | doughnut | radar | scatter | bubble (composition.md §9 maps the relationship to the form).
// series: [{ name, values }], labels: categories. scatter/bubble take pptxgenjs' own shape: series[0] = { name: 'X', values },
// then { name, values[, sizes] } per set; labels unused. accent: index of the one category to color (single series bars only) —
// drawn as two stacked series here, merged by the runtime into one series with a per-point fill, so "Edit data" shows one column.
// overlap: true draws a bullet — series[0] the track or target (muted), series[1] the actual (accent), bars laid over each other.
// Stacked-bar labels must sit inside ('inEnd' | 'ctr' | 'inBase'); zero segments are hidden by the format code.
function chart(slide, x, y, w, h, { type = 'col', labels, series, accent = -1, overlap = false, max, min = 0, format = '#,##0', size = TYPE.caption - 2 } = {}) {
  const bar = type === 'col' || type === 'bar';
  const base = { ...box(x, y, w, h), fontFace: T.sans, showLegend: false,
    catAxisLabelColor: T.muted, catAxisLabelFontSize: size, catAxisLabelFontFace: T.sans, catAxisLineShow: false,
    valAxisHidden: true, valAxisLineShow: false, valGridLine: { style: 'none' }, catGridLine: { style: 'none' },
    ...(max != null ? { valAxisMaxVal: max, valAxisMinVal: min } : {}),
    showValue: true, dataLabelColor: T.body, dataLabelFontSize: size, dataLabelFontFace: T.data, dataLabelFormatCode: format + ';;' };
  if (bar && overlap && series.length === 2) {
    slide.addChart(pres.ChartType.bar, series.map((s) => ({ ...s, labels })), { ...base, barDir: type === 'bar' ? 'bar' : 'col',
      barOverlapPct: 100, barGapWidthPct: 45, chartColors: [T.paperAlt, T.accent], showValue: false });
    return;
  }
  if (type === 'doughnut') {
    slide.addChart(pres.ChartType.doughnut, [{ name: series[0].name, labels, values: series[0].values }], { ...base, holeSize: 62,
      chartColors: [T.accent, T.muted, T.line, T.paperAlt, T.tint], dataLabelPosition: 'bestFit', dataLabelColor: T.ink, showLabel: false, showPercent: false });
    return;
  }
  if (type === 'radar') {
    slide.addChart(pres.ChartType.radar, series.map((s) => ({ ...s, labels })), { ...base, radarStyle: 'marker', lineSize: 2,
      chartColors: [T.accent, T.muted], showValue: false, ...(series.length > 1 ? { showLegend: true, legendPos: 'b', legendColor: T.body, legendFontSize: size, legendFontFace: T.sans } : {}) });
    return;
  }
  if (type === 'scatter' || type === 'bubble') {
    slide.addChart(type === 'bubble' ? pres.ChartType.bubble : pres.ChartType.scatter, series, { ...base, valAxisHidden: false, catAxisHidden: false,
      valAxisLineShow: true, catAxisLineShow: true, valAxisLineColor: T.line, catAxisLineColor: T.line, valAxisLabelColor: T.muted, valAxisLabelFontSize: size,
      lineSize: 0, lineDataSymbol: 'circle', lineDataSymbolSize: type === 'bubble' ? 12 : 9, chartColors: [T.accent, T.muted, T.line], showValue: false });
    return;
  }
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
    // One series is one color (PowerPoint would otherwise cycle a color per bar); the accent is reserved for `accent`.
    slide.addChart(pres.ChartType.bar, series.map((s) => ({ ...s, labels })), { ...base, barDir: type === 'bar' ? 'bar' : 'col',
      barGapWidthPct: 60, chartColors: series.length === 1 ? [T.muted] : [T.accent, T.muted, T.line], dataLabelPosition: 'outEnd', ...(series.length > 1 ? { showLegend: true, legendPos: 't', legendColor: T.body, legendFontSize: size, legendFontFace: T.sans } : {}) });
    return;
  }
  slide.addChart(type === 'area' ? pres.ChartType.area : pres.ChartType.line, series.map((s) => ({ ...s, labels })), { ...base, lineSize: 2.5, lineDataSymbol: 'none',
    chartColors: [T.accent, T.muted, T.line], dataLabelPosition: 't', ...(type === 'area' ? { chartColorsOpacity: 35 } : {}) });
}
// Waterfall: native stacked columns — an invisible base (the surface color) carries each bar to its running start.
// steps: [{ label, value }] with a negative value for a drop, and { label, total: true } for a closing bar at the running total.
// Values stay editable; the closing figure is labeled by the author (a hero or a takeaway), not by the chart.
function waterfall(slide, x, y, w, h, steps, { size = TYPE.caption - 2, surface = T.paper } = {}) {
  let run = 0; const labels = [], base = [], rise = [], drop = [];
  for (const s of steps) {
    labels.push(s.label);
    if (s.total) { base.push(0); rise.push(run); drop.push(0); continue; }
    if (s.value >= 0) { base.push(run); rise.push(s.value); drop.push(0); run += s.value; }
    else { run += s.value; base.push(run); rise.push(0); drop.push(-s.value); }
  }
  slide.addChart(pres.ChartType.bar, [
    { name: 'base', labels, values: base }, { name: 'up', labels, values: rise }, { name: 'down', labels, values: drop },
  ], { ...box(x, y, w, h), barDir: 'col', barGrouping: 'stacked', barGapWidthPct: 40, chartColors: [surface, T.accent, T.muted],
    fontFace: T.sans, showLegend: false, showValue: false, catAxisLabelColor: T.muted, catAxisLabelFontSize: size, catAxisLabelFontFace: T.sans,
    catAxisLineShow: false, valAxisHidden: true, valAxisLineShow: false, valGridLine: { style: 'none' }, catGridLine: { style: 'none' } });
}
// Dumbbell: two values per item joined by a rule — before/after, plan/actual, min/max. rows: [{ label, a, b }]; a muted, b accent.
// Drawn with rules and dots (not bars), so it is a diagram of two points, never a picture of a bar chart.
function dumbbell(slide, x, y, w, rows, { min, max, labelW = 2.2, rowH = 0.6, format = (v) => String(v), size = TYPE.caption } = {}) {
  const values = rows.flatMap((r) => [r.a, r.b]);
  const lo = min ?? Math.min(...values), hi = max ?? Math.max(...values);
  const x0 = x + labelW + 1.0, span = w - labelW - 2.0, d = 0.18;
  const at = (v) => x0 + ((v - lo) / ((hi - lo) || 1)) * span;
  rows.forEach((r, i) => {
    const cy = y + i * rowH + rowH / 2;
    slide.addText(r.label, { ...box(x, cy - 0.15, labelW, 0.3), fontFace: T.sans, fontSize: size, color: T.ink, margin: 0, valign: 'middle' });
    const xa = at(r.a), xb = at(r.b), lead = xb >= xa;
    slide.addShape(pres.ShapeType.line, { x: Math.min(xa, xb), y: cy, w: Math.abs(xb - xa), h: 0, line: { color: T.line, width: 2 } });
    slide.addShape(pres.ShapeType.ellipse, { x: xa - d / 2, y: cy - d / 2, w: d, h: d, fill: { color: T.muted }, line: { color: T.muted, width: 0 } });
    slide.addShape(pres.ShapeType.ellipse, { x: xb - d / 2, y: cy - d / 2, w: d, h: d, fill: { color: T.accent }, line: { color: T.accent, width: 0 } });
    slide.addText(format(r.a), { ...box(lead ? xa - 0.95 : xa + 0.15, cy - 0.15, 0.8, 0.3), fontFace: T.data, fontSize: size - 2, color: T.muted, align: lead ? 'right' : 'left', margin: 0, valign: 'middle' });
    slide.addText(format(r.b), { ...box(lead ? xb + 0.15 : xb - 0.95, cy - 0.15, 0.8, 0.3), fontFace: T.data, fontSize: size - 2, color: T.ink, bold: true, align: lead ? 'left' : 'right', margin: 0, valign: 'middle' });
  });
  return y + rows.length * rowH;
}
// Small multiples: n identical charts on one row, one label above each, shared axis range.
function smallMultiples(slide, x, y, w, h, panels, { type = 'col', max, gap = 0.3, format = '#,##0' } = {}) {
  const pw = (w - gap * (panels.length - 1)) / panels.length;
  const top = max ?? Math.max(...panels.flatMap((p) => p.series.flatMap((s) => s.values))) * 1.15;
  panels.forEach((p, i) => {
    const px = x + i * (pw + gap);
    slide.addText(p.title, { ...box(px, y, pw, 0.35), fontFace: T.sans, fontSize: DIAG.label - 1, bold: true, color: T.ink, margin: 0 });
    chart(slide, px, y + 0.4, pw, h - 0.4, { type, labels: p.labels, series: p.series, max: top, accent: p.accent ?? -1, format });
  });
}
// Table with an optional verdict column: header in the accent, alternate rows paperAlt, the verdict bold on the tint (never color-only).
function table(slide, x, y, w, header, rows, { colW, rowH = 0.55, verdict = -1, size = TYPE.caption } = {}) {
  const head = (t) => ({ text: t, options: { bold: true, color: 'FFFFFF', fill: { color: T.accent }, fontFace: T.sans, fontSize: size } });
  const cell = (t, i, j) => ({ text: t, options: { fontFace: T.sans, fontSize: size, color: j === 0 ? T.ink : T.body, bold: j === 0 || j === verdict,
    fill: { color: j === verdict ? T.tint : i % 2 ? T.paperAlt : T.paper } } });
  slide.addTable([header.map(head), ...rows.map((r, i) => r.map((t, j) => cell(t, i, j)))],
    { x, y, w, colW: colW || header.map(() => w / header.length), rowH, border: { type: 'solid', color: T.line, pt: 0.75 }, margin: [0.06, 0.12, 0.06, 0.12], valign: 'middle' });
  return y + rowH * (rows.length + 1);
}
```
