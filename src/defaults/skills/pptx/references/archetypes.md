# Slide archetypes

Owns whole-slide functions: one per `layouts.md` skeleton and per anchor. Each takes content only; the geometry is the skeleton's starting geometry, measured with `MEASURE` so text never overflows. Requires `device-kit.md` above it in the script. Every function returns the slide so a free-form extra (a callout, a second emphasis) can be added after; extras are the exception, not the pattern.

**Default — an archetype call is the whole slide**: kicker, title, evidence, and closing line all come from the argument. Override a starting position only with a reason in the plan line.

## 1. Anchors
```js
// Cover: dark field, ghost numeral or picture on the right third, title hanging from the left margin.
function cover({ kicker: k, title: t, subtitle = '', meta = '', ghost: g = '' }) {
  const s = anchor();
  if (g) ghost(s, g, 7.6, 1.0, 240, 5.2);
  kicker(s, k, M, 2.15, T.onDarkAccent);
  const bottom = title(s, t, { y: 2.55, w: 8.2, size: TYPE.cover, color: 'FFFFFF' });
  if (subtitle) slideText(s, subtitle, M, bottom + 0.25, 9, TYPE.lead, { color: T.onDark, font: T.light });
  if (meta) slideText(s, meta, M, H - 1.0, 8, TYPE.caption, { color: T.onDarkMuted, font: T.data });
  return s;
}
function section({ number, title: t }) {
  const s = anchor();
  ghost(s, number, 7.5, 1.2);
  slideText(s, number, M, 2.0, 3, 72, { color: T.onDarkAccent, font: T.data, bold: true });
  title(s, t, { y: 3.5, w: 8, size: TYPE.title, color: 'FFFFFF' });
  return s;
}
function closing({ title: t, ask = '', meta = '', ghost: g = '' }) {
  const s = anchor();
  if (g) ghost(s, g, 9.4, 2.4, 180, 3.4);
  kicker(s, 'Next', M, 2.15, T.onDarkAccent);
  const bottom = title(s, t, { y: 2.55, w: 9, size: TYPE.title, color: 'FFFFFF' });
  if (ask) slideText(s, ask, M, Math.max(bottom + 0.4, 4.6), 8, TYPE.lead, { color: T.onDarkAccent, bold: true });
  if (meta) slideText(s, meta, M, H - 1.0, 8, TYPE.caption, { color: T.onDarkMuted, font: T.data });
  return s;
}
// Measured single text box (height from MEASURE). Used by every archetype for lines that are not a kit role.
// Secondary lines (notes, captions, contexts) default to the light face; pass font: T.sans for a lead.
// A measured box (no h) is a paragraph and gets the dense leading; a fixed-height box is a label and stays single-spaced.
function slideText(s, text, x, y, w, size, { color = T.body, font = T.light, bold = false, align = 'left', lh, h } = {}) {
  lh ??= h ? 1 : TYPE.lh.dense;
  const face = bold && font === T.light ? T.sans : font;
  const height = h ?? fitH(text, w, size, face, { bold, lh });
  s.addText(text, { ...box(x, y, w, height), fontFace: face, fontSize: size, bold, color, align, margin: 0, valign: 'top', lineSpacingMultiple: lh });
  return y + height;
}
// Signature text for mark(): set once per deck (a deck word) or per section ('02 · 진단') before the section's slides.
let MARK = '';
// Kicker (only when it names a real section or topic; pass '' to omit) + signature mark + title on a content slide;
// returns the y where the content starts and sets FLOOR for this slide. place 'top' (deck default TITLE_PLACE): title
// at the head, content from ≥ 1.8 (0.75 + title without a kicker), FLOOR 6.6. 'low': content from 0.75, FLOOR 5.3,
// and the kicker + title sit in the bottom band — for a slide whose carrier owns the page (plan line names it).
// w: the title's width when something (a side picture, a column) owns the rest of the row.
function head(s, k, t, { maxLines = 2, place = TITLE_PLACE, w = W - 2 * M } = {}) {
  FLOOR = floorOf(place);
  if (MARK) mark(s, MARK);
  if (place === 'low') {
    if (k) kicker(s, k, M, FLOOR + 0.35);
    title(s, t, { y: FLOOR + 0.35 + (k ? 0.3 + 0.1 : 0), w: Math.min(w, W - 2 * M - 1.2), size: TYPE.section + 4, maxLines: k ? 1 : 2 });   // kicker box 0.3 + the 0.1 a kicker keeps above its title
    return 0.75;
  }
  if (k) kicker(s, k);
  return Math.max(1.8, title(s, t, { y: k ? 1.0 : 0.75, w, maxLines }) + GAP.between);
}
// Text block that keeps the authored texture (design.md §4.0): a string is prose, an array is a genuine list.
function textBlock(s, content, x, y, w, h, size = TYPE.body, color = T.body) {
  if (Array.isArray(content)) body(s, x, y, w, h, content, size, color);
  else prose(s, content, x, y, w, h, size, color);
}
```

## 2. Statement archetypes
```js
// S1 — one claim in air. claim: emphasis paragraphs ([[text, opts], ...]) or a string.
function S1({ kicker: k, claim, attribution = '', dark = false }) {
  const s = dark ? breathing() : content();
  if (k) kicker(s, k, M, 0.6, dark ? T.onDarkAccent : T.accent);
  // The statement enters high (y 1.6) and the air follows it (design.md §4.5: proportions follow information weight).
  hairline(s, M, 1.45, 4, dark ? T.onDarkAccent : T.line);
  const paragraphs = typeof claim === 'string' ? [[[claim, {}]]] : claim;
  const plain = paragraphs.map((p) => p.map(([t]) => t).join('')).join('\n');
  const size = fitSize(plain, 10.4, 3.8, TYPE.section, T.light, { lh: TYPE.lh.body, min: TYPE.lead });
  const h = fitH(plain, 10.4, size, T.light, { lh: TYPE.lh.body }) + 0.3 + (paragraphs.length - 1) * size * 0.8 / 72;   // + paragraph steps
  emphasis(s, paragraphs, M, 1.7, 10.4, h, size, dark ? T.onDark : T.ink);
  if (attribution) slideText(s, attribution, M, 1.7 + h + 0.3, 8, TYPE.caption, { color: dark ? T.onDarkMuted : T.muted });
  return s;
}
// S2 — hero number with its meaning beside it.
function S2({ kicker: k, value, label, unit = '', explanation }) {
  const s = content();
  if (k) kicker(s, k);
  vrule(s, 6.7, 1.9, 3.0, T.line);
  hero(s, M, 1.7, 5.5, value, label, { size: 96, unit });
  const paragraphs = typeof explanation === 'string' ? [[[explanation, {}]]] : explanation;
  emphasis(s, paragraphs, 7.2, 1.9, 5.5, 4.0, TYPE.body);
  return s;
}
// S3 — pull quote on a dark field.
function S3({ quote, attribution }) {
  const s = breathing();
  s.addText('“', { ...box(M - 0.1, 1.0, 1.6, lineH(120, T.data) + 0.1), fontFace: T.data, fontSize: 120, bold: true, color: T.onDarkAccent, margin: 0 });
  const size = fitSize(quote, 10.6, 2.4, TYPE.section + 3, T.display, { bold: true, lh: 1.3, min: TYPE.lead });
  const bottom = slideText(s, quote, M + 0.9, 2.6, 10.6, size, { color: 'FFFFFF', font: T.display, bold: true, lh: 1.3 });
  slideText(s, attribution, M + 0.9, bottom + 0.3, 9.5, TYPE.caption, { color: T.onDarkMuted, lh: 1.4 });
  return s;
}
// S5 — ghost numeral behind a claim (chapter mark).
function S5({ number, kicker: k, claim }) {
  const s = anchor();
  ghost(s, number, 7.5, 1.2);
  kicker(s, k, M, 2.15, T.onDarkAccent);
  title(s, claim, { y: 2.6, w: 7, size: TYPE.section, color: 'FFFFFF', maxLines: 4 });
  return s;
}
function vrule(s, x, y, h, color = T.accent) { s.addShape(S.line, { ...box(x, y, 0, h), line: { color, width: 3 } }); }
```

## 3. Evidence archetypes
```js
// E1 — chart as spine. chart: chart() options; hero: { value, label }; takeaway: string.
function E1({ kicker: k, title: t, chart: c, hero: h, note = '', takeaway: tk }) {
  const s = content();
  const top = head(s, k, t);
  chart(s, M, top, 8.2, FLOOR - 0.8 - top, c);
  const bottom = hero(s, 9.4, top, 3.3, h.value, h.label);
  if (note) {                                                        // the note belongs to the hero; it fits by size, never by clipping
    const room = FLOOR - 0.8 - bottom - GAP.within, size = fitSize(note, 3.3, room, TYPE.caption, T.light, { lh: 1.4, min: 12 });
    slideText(s, note, 9.4, bottom + GAP.within, 3.3, size, { lh: 1.4, h: fitH(note, 3.3, size, T.light, { lh: 1.4 }) });
  }
  takeaway(s, tk, FLOOR - 0.6);
  return s;
}
// E2 — chart with a side rail. rail: { lead, bullets }.
function E2({ kicker: k, title: t, chart: c, rail }) {
  const s = content();
  const top = head(s, k, t);
  chart(s, M, top, 7.6, FLOOR - top, c);
  field(s, 8.6, top, 4.1, FLOOR - top);
  const bottom = slideText(s, rail.lead, 8.9, top + 0.3, 3.5, TYPE.body, { color: T.ink, bold: true, lh: 1.3 });
  textBlock(s, rail.prose ?? rail.bullets, 8.9, bottom + GAP.within, 3.5, FLOOR - 0.3 - bottom - GAP.within, TYPE.caption + 1);
  return s;
}
// E3 — small multiples. panels: [{ title, labels, series, accent }], comparison: string.
function E3({ kicker: k, title: t, panels, max, format = '#,##0', comparison }) {
  const s = content();
  const top = head(s, k, t);
  const cmpH = fitH(comparison, W - 2 * M, TYPE.body, T.light);
  smallMultiples(s, M, top, W - 2 * M, FLOOR - cmpH - GAP.between - top, panels, { max, format });
  slideText(s, comparison, M, FLOOR - cmpH, W - 2 * M, TYPE.body, { h: cmpH });   // the comparison closes the panels (between)
  return s;
}
// E4 — stat band. stats: [{ value, label, context, unit }] (3-5).
function E4({ kicker: k, title: t, stats, takeaway: tk = '' }) {
  const s = content();
  const top = head(s, k, t);
  // Columns by weight: a stat marked lead:true (else the first) and a longer context earn more width (design.md §8).
  const weights = stats.map((st) => weightOf({ label: st.label, context: st.context }));
  const leadAt = Math.max(0, stats.findIndex((st) => st.lead === true));
  weights[leadAt] = Math.max(...weights) * 1.15;                        // the stat the slide is about is the widest
  const cols = spans(M, W - 2 * M, weights);
  let bottom = top;
  stats.forEach((st, i) => { bottom = Math.max(bottom, hero(s, cols[i].x, top, cols[i].w, st.value, st.label, { unit: st.unit || '' })); });
  // The context belongs to its numeral (within); the rule under the band separates the band from the contexts' field.
  const floor = tk ? FLOOR - 0.8 : FLOOR;
  stats.forEach((st, i) => slideText(s, st.context, cols[i].x, bottom + GAP.within, cols[i].w - 0.05, TYPE.caption, { lh: 1.35, h: floor - bottom - GAP.within }));
  if (tk) takeaway(s, tk, FLOOR - 0.6);
  return s;
}
// E5 — table with a verdict column. columns: header labels; rows: string[][]; verdict: index of the verdict column; highlight: value(s) that get the tint.
function E5({ kicker: k, title: t, columns, rows, verdict = columns.length - 1, highlight = [], colW, source = '' }) {
  const s = content();
  const top = head(s, k, t);
  const rowH = Math.min(0.62, (FLOOR - 0.5 - top) / (rows.length + 1));
  const head_ = (c) => ({ text: c, options: { bold: true, color: 'FFFFFF', fill: { color: T.accent }, fontFace: T.sans, fontSize: TYPE.caption } });
  const cell = (v, i, o = {}) => ({ text: v, options: { fontFace: T.light, fontSize: rowH < 0.5 ? TYPE.caption - 1 : TYPE.caption, color: T.body, fill: { color: i % 2 ? T.paperAlt : T.paper }, ...o } });
  const table = [columns.map(head_), ...rows.map((r, i) => r.map((v, ci) => {
    if (ci === 0) return cell(v, i, { bold: true, color: T.ink });
    if (ci === verdict) { const on = [].concat(highlight).includes(v); return cell(v, i, { bold: true, color: on ? T.accent : T.ink, fill: { color: on ? T.tint : (i % 2 ? T.paperAlt : T.paper) } }); }
    return cell(v, i);
  }))];
  // Column widths from the longest cell in each column (gap 0: a table's seams are its columns), unless colW is given.
  const widths = colW || spans(M, W - 2 * M, columns.map((c, ci) => Math.max(String(c).length, ...rows.map((r) => String(r[ci] ?? '').length))), { gap: 0, minRatio: 0.55, maxRatio: 2.2 }).map((c) => c.w);
  s.addTable(table, { x: M, y: top, w: W - 2 * M, colW: widths, rowH, border: { type: 'solid', color: T.line, pt: 0.75 }, margin: [0.05, 0.12, 0.05, 0.12], valign: 'middle' });
  if (source) slideText(s, source, M, top + rowH * (rows.length + 1) + GAP.within, 11, Math.max(12, TYPE.caption - 1), { color: T.muted });   // belongs to the table; never under 12 pt
  return s;
}
// E7 — one proportion as a gauge, meaning beside it.
function E7({ kicker: k, title: t, share, value, label, meaning, place }) {
  const s = content();
  const top = head(s, k, t, { place });
  const cy = (top + FLOOR) / 2;                                   // the gauge owns the field; the meaning sits on its centre line
  gauge(s, 3.4, cy, 1.6, share, value, label);
  const paragraphs = typeof meaning === 'string' ? [[[meaning, {}]]] : meaning;
  emphasis(s, paragraphs, 5.6 + GAP.between * 2, cy - 1.2, W - M - 5.6 - GAP.between * 2, 2.4, TYPE.lead);
  return s;
}
// E8 — specimen: the subject drawn. rows: specimen() rows; claim: prose (string) or emphasis paragraphs at the right; note: one line under.
function E8({ kicker: k = '', title: t, rows, claim = '', note = '', rowsW = 7.8 }) {
  const s = content();
  const top = head(s, k, t);
  const bottom = specimen(s, M, top, rowsW, rows);
  if (claim) {
    const paragraphs = typeof claim === 'string' ? [[[claim, {}]]] : claim;
    emphasis(s, paragraphs, M + rowsW + GAP.between, top, W - M - (M + rowsW + GAP.between), FLOOR - 0.2 - top, TYPE.body);
  }
  if (note) slideText(s, note, M, bottom + GAP.within + 0.1, rowsW, TYPE.caption, { color: T.muted });   // the note belongs to the specimen
  return s;
}
```

## 4. Relationship archetypes
```js
// R1 — chevron run. stages: [{ label, detail }], active: index.
function R1({ kicker: k, title: t, stages, active = -1, takeaway: tk = '' }) {
  const s = content();
  const top = head(s, k, t);
  // Stage widths by weight: the active stage and a longer detail earn more (design.md §8); the chevrons follow the same spans.
  const weights = stages.map((st) => weightOf({ label: st.label, detail: st.detail }));
  if (active >= 0) weights[active] = Math.max(...weights) * 1.15;      // the stage the slide is about is the widest
  const cols = spans(M, W - 2 * M - 1.15 * 0.25, weights, { gap: 0 });
  const ch = 1.05, numY = top + ch + GAP.between, detailY = numY + lineH(TYPE.section, T.data) + 0.05 + GAP.within;   // number belongs to its detail
  chevrons(s, M, top, W - 2 * M, ch, stages.map((st) => st.label), { active, widths: cols });
  stages.forEach((st, i) => {
    slideText(s, String(i + 1), cols[i].x + 0.15, numY, cols[i].w - 0.45, TYPE.section, { color: T.accent, font: T.data, bold: true, h: lineH(TYPE.section, T.data) + 0.05 });
    slideText(s, st.detail, cols[i].x + 0.15, detailY, cols[i].w - 0.45, TYPE.caption, { lh: 1.35, h: (tk ? FLOOR - 0.8 : FLOOR) - detailY });
  });
  if (tk) takeaway(s, tk, FLOOR - 0.6);
  return s;
}
// R2 — timeline. events: [{ x, label, detail }] with x in inches (dates stay uneven); present: index.
function R2({ kicker: k, title: t, events, present = events.length - 1, note = '', place }) {
  const s = content();
  const top = head(s, k, t, { place });
  const ly = top + (FLOOR - top) * 0.42;                          // the line sits above centre: labels and details hang below it
  hairline(s, M, ly, W - 2 * M);
  events.forEach((e, i) => {
    node(s, e.x, ly, 0.55, i + 1, { fill: i === present ? T.accent : T.muted });
    const lh = fitH(e.label, 2, TYPE.body, T.sans, { bold: true }), labelY = ly + 0.275 + GAP.within + 0.1;
    slideText(s, e.label, e.x - 1, labelY, 2, TYPE.body, { color: T.ink, bold: true, align: 'center', h: lh });
    if (e.detail) slideText(s, e.detail, e.x - 1, labelY + lh + GAP.within, 2, TYPE.caption, { color: T.muted, align: 'center', lh: 1.3, h: fitH(e.detail, 2, TYPE.caption, T.light, { lh: 1.3 }) });   // detail belongs to its label
  });
  if (note) slideText(s, note, M, FLOOR - 0.5, 10, TYPE.body, { h: 0.5 });
  return s;
}
// R3 — stepped process. items: [[lead, note], ...] (3-5).
function R3({ kicker: k, title: t, lead = '', items, dir = 1 }) {
  const s = content();
  const top = head(s, k, t);
  if (lead) slideText(s, lead, M, top, 10, TYPE.body, { color: T.muted });
  const dx = Math.min(2.45, (W - 2 * M - 2.2) / Math.max(1, items.length - 1));
  const base = FLOOR - 1.2;                                        // the last step lands above the floor
  steps(s, items, { y: dir === 1 ? base : base - 0.85 * (items.length - 1), dx, dir });
  return s;
}
// R5 — cycle. labels: 3-6; center: { lead, note }.
function R5({ kicker: k, title: t, labels, active = -1, center = null, aside = null, place }) {
  const s = content();
  const top = head(s, k, t, { place });
  const cx = aside ? 4.6 : W / 2, cy = (top + FLOOR) / 2, r = Math.min(1.85, (FLOOR - top) / 2 - 0.5);
  cycle(s, cx, cy, r, labels, { active });
  if (center) {
    const leadH = lineH(TYPE.lead, T.display) + 0.05;
    slideText(s, center.lead, cx - 1, cy - leadH, 2, TYPE.lead, { color: T.ink, font: T.display, bold: true, align: 'center', h: leadH });
    slideText(s, center.note, cx - 1, cy + 0.05, 2, TYPE.caption, { color: T.muted, align: 'center', h: lineH(TYPE.caption, T.light) + 0.05 });   // note belongs to the lead
  }
  if (aside) emphasis(s, typeof aside === 'string' ? [[[aside, {}]]] : aside, 8.4, top + 0.2, W - M - 8.4, FLOOR - top - 0.4, TYPE.body);
  return s;
}
// R6 — hub and spokes. hub: { label, note }; spokes: [{ label, note, deg, dashed }] with deg the angle from the hub.
function R6({ kicker: k, title: t, hub, spokes, note = '', place }) {
  const s = content();
  const top = head(s, k, t, { place });
  const hx = W / 2 + 0.2, hy = (top + FLOOR) / 2, hd = 1.9, sd = 1.2, r = Math.min(2.1, (FLOOR - top) / 2 - sd / 2 - 0.1);
  for (const sp of spokes) {
    const a = sp.deg * Math.PI / 180, cx = hx + r * Math.cos(a), cy = hy + r * Math.sin(a), ux = Math.cos(a), uy = Math.sin(a);
    connector(s, cx - ux * sd / 2, cy - uy * sd / 2, hx + ux * hd / 2, hy + uy * hd / 2, { color: T.line, width: 1.5, arrow: 'none' });
    s.addShape(S.ellipse, { ...box(cx - sd / 2, cy - sd / 2, sd, sd), fill: { color: sp.dashed ? T.paperAlt : T.paper }, line: { color: sp.dashed ? T.muted : T.accent, width: 1.5, dashType: sp.dashed ? 'dash' : 'solid' } });
    s.addText(sp.label, { ...box(cx - sd / 2, cy - sd / 2, sd, sd), fontFace: T.sans, fontSize: TYPE.kicker, bold: true, color: T.ink, align: 'center', valign: 'middle', margin: 0 });
    if (sp.note) {
      const right = Math.cos(a) >= 0;
      slideText(s, sp.note, right ? cx + sd / 2 + 0.15 : cx - sd / 2 - 2.75, cy - 0.25, 2.6, TYPE.caption, { color: T.muted, align: right ? 'left' : 'right', h: 0.5 });
    }
  }
  s.addShape(S.ellipse, { ...box(hx - hd / 2, hy - hd / 2, hd, hd), fill: { color: T.accent }, line: { color: T.accent } });
  s.addText([{ text: hub.label, options: { bold: true, breakLine: true } }, { text: hub.note || '', options: { fontSize: TYPE.kicker } }], { ...box(hx - hd / 2, hy - hd / 2, hd, hd), fontFace: T.sans, fontSize: TYPE.body, color: 'FFFFFF', align: 'center', valign: 'middle', margin: 0 });
  if (note) slideText(s, note, M, FLOOR - 0.6, 4.6, TYPE.caption, { color: T.muted, lh: 1.3, h: 0.6 });
  return s;
}
// R7 — split / merge. sources: string[] (left column); target: string; reverse: true for a split.
function R7({ kicker: k, title: t, sources, target, reverse = false }) {
  const s = content();
  const top = head(s, k, t);
  const gap = GAP.between, h = Math.min(0.9, (FLOOR - top - gap * (sources.length - 1)) / sources.length), y0 = top, ty = y0 + ((sources.length - 1) * (h + gap)) / 2;   // sources are peers (between)
  const sx = reverse ? 8.5 : M, tx = reverse ? M : 8.5;
  sources.forEach((src, i) => {
    const y = y0 + i * (h + gap);
    s.addShape(S.roundRect, { ...box(sx, y, 2.8, h), rectRadius: 0.08, fill: { color: T.paperAlt }, line: { color: T.paperAlt } });
    s.addText(src, { ...box(sx + 0.2, y, 2.4, h), fontFace: T.sans, fontSize: TYPE.body, color: T.ink, valign: 'middle', margin: 0 });
    if (reverse) connector(s, tx + 3, ty + h / 2, sx, y + h / 2, { color: T.muted });
    else connector(s, sx + 2.8, y + h / 2, tx, ty + h / 2, { color: T.muted });
  });
  s.addShape(S.roundRect, { ...box(tx, ty, 3, h), rectRadius: 0.08, fill: { color: T.accent }, line: { color: T.accent } });
  s.addText(target, { ...box(tx + 0.2, ty, 2.6, h), fontFace: T.sans, fontSize: TYPE.body, bold: true, color: 'FFFFFF', valign: 'middle', margin: 0 });
  return s;
}
// R11 — brace groups. groups: [{ name, file, items }]; aside: { value, label, note } hero at the right (optional).
function R11({ kicker: k, title: t, groups, aside = null }) {
  const s = content();
  let y = head(s, k, t) + 0.15;
  const iw = aside ? 5.4 : 9.5;
  // The item size steps down (to the caption size) until every group fits above the safe-area bottom.
  let size = TYPE.body;
  const groupH = (g, sz) => fitH(g.items.join('\n'), iw, sz, T.light, { lh: TYPE.lh.body }) + 0.1;
  while (size > TYPE.caption && groups.reduce((sum, g) => sum + groupH(g, size), 0) + GAP.between * (groups.length - 1) > FLOOR - y) size -= 1;
  for (const g of groups) {
    const h = groupH(g, size);
    slideText(s, g.name, M, y, 1.7, TYPE.body, { color: T.accent, font: T.data, bold: true, align: 'right', h: 0.45 });
    if (g.file) slideText(s, g.file, M, y + 0.45, 1.7, TYPE.kicker, { color: T.muted, align: 'right', h: Math.max(0.3, h - 0.45) });
    brace(s, M + 1.85, y, h);
    s.addText(g.items.map((it, i) => ({ text: it, options: { breakLine: i < g.items.length - 1 } })), { ...box(M + 2.3, y, iw, h), fontFace: T.light, fontSize: size, color: T.body, valign: 'top', margin: 0, lineSpacingMultiple: TYPE.lh.body });
    y += h + GAP.between;
  }
  if (aside) {
    const bottom = hero(s, 9.4, 2.2, 3.3, aside.value, aside.label, { size: 96 });
    if (aside.note) slideText(s, aside.note, 9.4, bottom + 0.2, 3.3, TYPE.caption, { lh: 1.4 });
  }
  return s;
}
// R12 — two planes. left/right: { label, prose } or { label, bullets } (texture as authored); changed: 'right' | 'left' gets the lift.
function R12({ kicker: k, title: t, left, right, changed = 'right', takeaway: tk = '' }) {
  const s = content();
  const top = head(s, k, t);
  // The seam follows weight: the changed side and the longer text earn more width; the middle only when both weigh the same (design.md §8).
  const wt = (side, on) => weightOf({ text: [].concat(side.prose ?? side.bullets ?? []).join(' ') }, { active: on });
  const { left: L, right: R } = splitAt(M, W - 2 * M, wt(left, changed === 'left'), wt(right, changed === 'right'));
  const ph = (tk ? FLOOR - 1.0 : FLOOR) - top, textY = top + 0.25 + 0.4 + GAP.within;   // the plane's label binds to its text
  (changed === 'left' ? lift : field)(s, L.x, top, L.w, ph, changed === 'left' ? 'FFFFFF' : undefined);
  (changed === 'right' ? lift : field)(s, R.x, top, R.w, ph, changed === 'right' ? 'FFFFFF' : undefined);
  slideText(s, left.label, L.x + 0.35, top + 0.25, L.w - 0.7, TYPE.kicker, { color: changed === 'left' ? T.accent : T.body, font: T.data, bold: true, h: 0.4 });
  slideText(s, right.label, R.x + 0.35, top + 0.25, R.w - 0.7, TYPE.kicker, { color: changed === 'right' ? T.accent : T.body, font: T.data, bold: true, h: 0.4 });
  textBlock(s, left.prose ?? left.bullets, L.x + 0.35, textY, L.w - 0.7, top + ph - 0.3 - textY, TYPE.body, changed === 'left' ? T.ink : T.body);
  textBlock(s, right.prose ?? right.bullets, R.x + 0.35, textY, R.w - 0.7, top + ph - 0.3 - textY, TYPE.body, changed === 'right' ? T.ink : T.body);
  if (tk) takeaway(s, tk, FLOOR - 0.6);
  return s;
}
// R13 — 2×2 field. axes: { x, y }; split: { x, y } in inches (the semantic threshold); items: [{ label, x, y }].
function R13({ kicker: k, title: t, axes, split = { x: M + 4.5, y: null }, items }) {
  const s = content();
  const top = head(s, k, t);
  const sy = split.y ?? top + (FLOOR - top) * 0.58;               // the semantic threshold; off-centre by default (design.md §8)
  field(s, M, top, W - 2 * M, FLOOR - top);
  s.addShape(S.line, { ...box(split.x, top, 0, FLOOR - top), line: { color: T.line, width: 1 } });
  hairline(s, M, sy, W - 2 * M);
  for (const it of items) slideText(s, it.label, it.x, it.y, 3, TYPE.body, { color: T.ink, bold: true, h: 0.5 });
  slideText(s, axes.x + ' →', W - M - 2, FLOOR - 0.4, 1.8, TYPE.caption, { color: T.muted, align: 'right', h: 0.3 });
  slideText(s, '↑ ' + axes.y, M + 0.1, top + 0.1, 3, TYPE.caption, { color: T.muted, h: 0.3 });
  return s;
}
// R14 — tiered stack. tiers: string[] top to base; aside: { lead, bullets } optional.
function R14({ kicker: k, title: t, tiers: labels, aside = null }) {
  const s = content();
  const top = head(s, k, t);
  tiers(s, aside ? 4.4 : W / 2, top, labels, { topW: 3.0, step: 1.45, h: Math.min(1.0, (FLOOR - 0.2 - top) / labels.length) });
  if (aside) {
    const bottom = slideText(s, aside.lead, 9.1, top, 3.6, TYPE.body, { color: T.ink, bold: true, lh: 1.3 });
    textBlock(s, aside.prose ?? aside.bullets, 9.1, bottom + GAP.within, 3.6, FLOOR - 0.3 - bottom - GAP.within, TYPE.caption + 1);   // the text belongs to its lead
  }
  return s;
}
// R15 — overlapping sets. labels: 2-3; shared: the common meaning.
function R15({ kicker: k, title: t, labels, shared = '', note = '', place }) {
  const s = content();
  const top = head(s, k, t, { place });
  const noteH = note ? fitH(note, 10, TYPE.body, T.light) : 0;
  const cy = (top + FLOOR - noteH - (note ? GAP.between : 0)) / 2;
  sets(s, W / 2, cy, Math.min(3.0, cy - top - 0.1), labels, { shared });
  if (note) slideText(s, note, M, FLOOR - noteH, 10, TYPE.body, { h: noteH });
  return s;
}
```
