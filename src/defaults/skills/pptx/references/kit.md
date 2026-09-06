# Kit

Owns the code: primitives that draw what `composition.md` names, sized with `MEASURE` so text never overflows. The kit is a toolbox, not a slide catalog — no function here draws a whole slide, and every position is the author's. Draw every repeated element through one function so the deck stays consistent. Chart and table helpers are in `charts.md`, picture helpers in `pictures.md` §4.

**The runtime runs every code block of this file, `charts.md`, and `pictures.md` before the script** — the script never pastes them. A script opens with the brief, then one `deck({ hue, accentHue?, mode, script, pairing, fonts })` call that sets the palette, the faces, the type scale, the zones, and the masters, then the slides. Read the blocks for the signatures and defaults; redefine a helper in the script when a page needs a different one (a later declaration wins). A script that creates its own `pres` runs without the prelude.

**Hard rule — paragraph options sit on the first run**: the runtime keeps one `a:pPr` per paragraph (the first). `bullet`, `align`, `paraSpaceAfter`, `lineSpacingMultiple` go on the text box or on a paragraph's first run; `breakLine: true` on a paragraph's last run. → runtime (absorbed: the normalizer keeps the first `pPr`; nothing to check)

## 1. Tokens, palette, type, specs, masters
```js
const pptxgen = require('pptxgenjs');
const sharp = require('sharp');
const pres = new pptxgen();
pres.layout = 'LAYOUT_WIDE';
const W = 13.33, H = 7.5;                       // canvas (inches)
const S = pres.ShapeType;                      // camelCase presets: S.chevron, S.blockArc, S.round1Rect, S.leftBrace, S.wedgeRectCallout, S.custGeom
const box = (x, y, w, h) => ({ x, y, w, h });
const PX = 160;                                 // raster density: inches × PX = pixels (≥ 2× placed size)
// Spacing ladder (composition.md §6): five rungs, decided once per deck like the palette and the type scale. Every
// distance in a script is a relation named on the ladder or a measured result; a literal inch that is neither is
// the drift a reader feels.
const SPACE = { hair: 0.06, tight: 0.12, snug: 0.25, gap: 0.45, wide: 0.6 };
// Relations on the ladder — a script names the relation, never the number:
//   GAP.bind     a numeral over its own label, a kicker over its title — the one sub-within case
//   GAP.within   a thing and what belongs to it: a heading over its paragraph, an icon over its label
//   GAP.between  peers and blocks: stats in a band, stages under a run, a figure and its takeaway
//   GUTTER       the one column gap: spans(), splitAt(), the deck seam, small multiples
//   PAD          the one inset from a field, card, callout, or plane edge to its content
//   M            the page margin; safe area x M..W-M, y M..H-M
const GAP = { bind: SPACE.hair, within: SPACE.tight, between: SPACE.gap };
const GUTTER = SPACE.gap;
const PAD = SPACE.snug;
const M = SPACE.wide;
const RADIUS = 0.08;                            // the one corner radius for lifted or rounded fields
// inner: the content box of a region after the inset — write inner(L) never L.x + 0.15.
const inner = (r, pad = PAD) => ({ x: r.x + pad, y: (r.y ?? 0) + pad, w: r.w - pad * 2, h: r.h != null ? r.h - pad * 2 : undefined });

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
// The accent hue a seed pairs with (direction.md §5): a cool seed takes a warm accent (navy 225 → coral 15, indigo 250 → gold 40),
// a green or teal seed amber, a berry seed gold, a warm seed teal or navy. Pass accentHue: hue for a single-hue deck
// (swiss-minimal, brutalist, blueprint, a brand that owns one color) or any hue the brief names.
function counterHue(h) {
  h = ((h % 360) + 360) % 360;
  if (h >= 190 && h < 290) return (h + 150) % 360;
  if (h >= 80 && h < 190) return Math.round(20 + (h - 80) / 10);
  if (h >= 290 && h < 340) return (h + 65) % 360;
  return (h + 190) % 360;
}
// The ladder: neutrals within the seed hue, one saturated accent on the counter hue (the only saturated color on type and
// fields), tinted extremes, three line strengths, and the four state colors.
// Guarantees: body and muted ≥ 4.5:1 on paper and paperAlt; white ≥ 3:1 on accent; accent ≥ 4.5:1 on paper (an emphasis run
// stays readable); every state text ≥ 4.5:1 on paper, paperAlt, and its own weak field; every state solid ≥ 3:1 on paper.
function palette({ hue = 205, accentHue = counterHue(hue), accentSat = 0.72, accentLight = 0.42 } = {}) {
  const paper = hsl(hue, 0.25, 0.975), paperAlt = hsl(hue, 0.18, 0.92), tint = hsl(accentHue, 0.35, 0.89), dark = hsl(hue, 0.42, 0.10);
  const accent = darkenUntil(accentHue, accentSat, accentLight, ['FFFFFF', paper, tint], 4.5);
  // State colors (direction.md §5): four fixed meanings on fixed hues, each in three forms — `solid` fills a mark (a dot,
  // a delta, a bar; never under type), `weak` is the field under a state word (a verdict cell, a badge, a callout), `text`
  // is the word itself on paper, paperAlt, or weak. The text form is dark and restrained (S 0.30) so the deck's one
  // saturated hue on type stays the accent; the saturated form is the mark. A state's word or glyph always accompanies it.
  const state = Object.fromEntries(Object.entries({ positive: 150, warning: 40, critical: 5, informative: 215 }).map(([name, h]) => {
    const weak = hsl(h, 0.45, 0.92);
    return [name, { solid: darkenUntil(h, 0.65, 0.48, [paper], 3), weak, text: darkenUntil(h, 0.30, 0.34, [paper, paperAlt, weak], 4.5) }];
  }));
  return {
    ink: hsl(hue, 0.30, 0.13), body: darkenUntil(hue, 0.22, 0.30, [paperAlt], 7), muted: darkenUntil(hue, 0.12, 0.45, [paperAlt, tint], 4.5),
    // Three line strengths (composition.md §6): subtle between repeated items, line at a section boundary, strong as an outline that owns a region.
    lineSubtle: hsl(hue, 0.14, 0.91), line: hsl(hue, 0.16, 0.86), lineStrong: hsl(hue, 0.18, 0.72),
    paper, paperAlt, tint,
    dark, darkAlt: hsl(hue, 0.34, 0.17),
    onDark: hsl(hue, 0.20, 0.94), onDarkMuted: hsl(hue, 0.14, 0.72), onDarkAccent: hsl(accentHue, 0.62, 0.74),
    accent, accentDeep: darkenUntil(accentHue, accentSat, accentLight - 0.1, ['FFFFFF', paper], 6),
    onAccent: 'FFFFFF',                        // type on an accent surface; the only white in the ladder — scripts never write a hex literal
    state,
  };
}
const T = { ...palette({ hue: 205 }), display: '', sans: '', light: '', data: '' };   // deck() seeds it from the brief; faces set by typography()

// Type scale (direction.md §6): the reading mode sets the body anchor; every role derives from it.
let MODE = 'balanced';                          // presentation 24 · balanced 18 · text 15 (body pt); deck() sets it from the brief
function typeScale(mode) {
  const b = { presentation: 24, balanced: 18, text: 15 }[mode] ?? 18;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Math.round(v)));
  return {
    body: b, lead: Math.round(b * 1.2), caption: clamp(b * 0.7, 10.5, 16), kicker: clamp(b * 0.62, 10, 14),
    section: Math.round(b * 1.5), title: clamp(b * 2, 28, 44), cover: clamp(b * 2.6, 36, 56), hero: Math.round(b * 3.6),
    stat: Math.round(b * 2.7),                 // the numeral of a band of peers (statBand): smaller than a hero because there are several
    poster: clamp(b * 5.5, 84, 132),           // the one display size past hero: a cover or closing numeral, a poster word
  };
}
let TYPE = typeScale(MODE);
// Diagram type: labels inside chevrons, nodes, tiers and the notes under them follow the mode (balanced 14 / 11.5).
let DIAG = { label: TYPE.caption + 1, note: Math.max(9.5, TYPE.caption - 1.5) };
// Roles (direction.md §6): a role is size + face + weight + color + leading as one unit, so a caption is the same
// caption on every slide. role('caption') resolves against the current T and TYPE; text() and flow() take a role
// name in place of a size. A role's field may be overridden per box (color on a dark field, align) — the size never.
const ROLES = {
  poster:  () => ({ size: TYPE.poster,  font: T.data,    bold: true,  color: T.ink,    lh: 1.0 }),
  hero:    () => ({ size: TYPE.hero,    font: T.data,    bold: true,  color: T.accent, lh: 1.0 }),
  stat:    () => ({ size: TYPE.stat,    font: T.data,    bold: true,  color: T.accent, lh: 1.0 }),
  cover:   () => ({ size: TYPE.cover,   font: T.display, bold: true,  color: T.ink,    lh: 1.1 }),
  title:   () => ({ size: TYPE.title,   font: T.display, bold: true,  color: T.ink,    lh: 1.15 }),
  section: () => ({ size: TYPE.section, font: T.display, bold: true,  color: T.ink,    lh: 1.15 }),
  lead:    () => ({ size: TYPE.lead,    font: T.light,   bold: false, color: T.body,   lh: 1.35 }),
  body:    () => ({ size: TYPE.body,    font: T.light,   bold: false, color: T.body,   lh: 1.35 }),
  prose:   () => ({ size: TYPE.body,    font: T.light,   bold: false, color: T.body,   lh: 1.45 }),
  strong:  () => ({ size: TYPE.body,    font: T.sans,    bold: true,  color: T.ink,    lh: 1.2 }),
  caption: () => ({ size: TYPE.caption, font: T.light,   bold: false, color: T.muted,  lh: 1.2 }),
  kicker:  () => ({ size: TYPE.kicker,  font: T.sans,    bold: true,  color: T.accent, lh: 1.0 }),
  label:   () => ({ size: DIAG.label,   font: T.sans,    bold: true,  color: T.ink,    lh: 1.2 }),
  note:    () => ({ size: DIAG.note,    font: T.light,   bold: false, color: T.body,   lh: 1.35 }),
};
function role(name) { const r = ROLES[name]; if (!r) throw new Error(`role: unknown "${name}" — one of ${Object.keys(ROLES).join(', ')}`); return r(); }

// Component specs (composition.md §9): a carrier's anatomy declared once — slots (what it is made of), variants (the
// forms it comes in), definitions (the values every form takes, resolved against the current T, TYPE, and DIAG when a
// helper draws). badge(), callout(), chevrons(), hero() / statBand(), and table() read their sizes, faces, fields, and
// lines here instead of carrying literals, so the same carrier has the same anatomy on every slide; a deck that needs
// a different one redefines the entry once (SPEC.badge.definitions = () => ({ ... })) before the slides, never per call.
const SPEC = {
  badge: { slots: ['field', 'label'], variants: { tone: ['neutral', 'accent', 'positive', 'warning', 'critical', 'informative'] },
    definitions: () => ({ h: 0.32, radius: 0.5, size: TYPE.kicker, font: T.sans }) },
  callout: { slots: ['field', 'text'], variants: { tone: ['neutral', 'positive', 'warning', 'critical', 'informative'], form: ['wedge', 'plain'] },
    definitions: () => ({ size: DIAG.label, font: T.sans, width: 1, neutral: { fill: T.paper, color: T.body, line: T.lineStrong } }) },
  chevrons: { slots: ['stage', 'label'], variants: { state: ['default', 'active'] },
    definitions: () => ({ notch: 0.25, size: DIAG.label, font: T.sans, seam: T.paper, fill: { default: T.paperAlt, active: T.accent }, color: { default: T.body, active: T.onAccent } }) },
  stat: { slots: ['value', 'unit', 'label', 'detail'], variants: { scale: ['hero', 'poster', 'band'] },
    definitions: () => ({ size: { hero: TYPE.hero, poster: TYPE.poster, band: TYPE.stat }, unit: 0.4, color: T.accent, label: { size: TYPE.caption, color: T.muted }, detail: { role: 'caption', color: T.body } }) },
  table: { slots: ['header', 'cell', 'verdict'], variants: { banding: ['plain', 'banded'], verdict: ['neutral', 'positive', 'warning', 'critical', 'informative'] },
    definitions: () => ({ rowH: 0.55, size: TYPE.body, font: T.sans, margin: [0.10, 0.16, 0.10, 0.16], header: { fill: T.paperAlt, color: T.ink }, border: { type: 'solid', color: T.lineSubtle, pt: 0.5 } }) },
};
function spec(name) {
  const s = SPEC[name];
  if (!s) throw new Error(`spec: unknown "${name}" — one of ${Object.keys(SPEC).join(', ')}`);
  return { slots: s.slots, variants: s.variants, ...s.definitions() };
}
// tone: the field + type pair a toned carrier takes — neutral ink on tint, accent white on the accent, a state its word
// on its weak field (direction.md §5: the solid form never sits under type).
function tone(name = 'neutral') {
  if (name === 'neutral') return { fill: T.tint, color: T.ink };
  if (name === 'accent') return { fill: T.accent, color: T.onAccent };
  const s = T.state?.[name];
  if (!s) throw new Error(`tone: unknown "${name}" — one of neutral, accent, ${Object.keys(T.state || {}).join(', ')}`);
  return { fill: s.weak, color: s.text };
}

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

// The one setup call a script makes right after its brief: the palette from the seed (the accent on the counter hue
// unless accentHue is given), the faces from the script and pairing, the scale and zones from the reading mode.
// titleLines: the deck's longest content title in lines (zones()). Returns T. The masters take these colors when the
// first slide is added, so deck() runs before any light() / dark() / quiet().
function deck({ hue = 205, accentHue, accentSat, accentLight, mode = 'balanced', script = 'ko', pairing = 'weight', fonts = 'noto', titleLines = 1 } = {}) {
  Object.assign(T, palette({ hue, accentHue, accentSat, accentLight }));
  typography({ script, pairing, fonts });
  MODE = mode;
  TYPE = typeScale(mode);
  DIAG = { label: TYPE.caption + 1, note: Math.max(9.5, TYPE.caption - 1.5) };
  Z = zones(mode, { titleLines });
  return T;
}

// Page chrome lives on masters, not on slides: the background and, when the deck wants it, the page number.
// The three masters are defined from the final palette when the first slide is added, never before deck() ran.
function master(name, background, { number = true, color = T.muted } = {}) {
  pres.defineSlideMaster({ title: name, background: { color: background },
    ...(number ? { slideNumber: { x: W - M - 1, y: H - 0.5, w: 1, h: 0.3, fontFace: T.data, fontSize: 9, color, align: 'right' } } : {}) });
}
let MASTERS = false;
function masters() {
  if (MASTERS) return;
  MASTERS = true;
  master('LIGHT', T.paper);
  master('DARK', T.dark, { color: T.onDarkMuted });
  master('QUIET', T.dark, { number: false });    // cover and closing
}
const light = () => (masters(), pres.addSlide({ masterName: 'LIGHT' }));
const dark = () => (masters(), pres.addSlide({ masterName: 'DARK' }));
const quiet = () => (masters(), pres.addSlide({ masterName: 'QUIET' }));
```

## 2. Gradients (native) and raster helpers (sharp turns an SVG string into a PNG the deck can place)
```js
// Native gradient, editable in PowerPoint: a shape whose marked solid fill the runtime saves as a:gradFill — no raster.
// stops: [[offset 0-100, hex, alpha 0-1], ...] with stop 0 on the side the type sits; angle 0 = left→right, 90 = top→bottom.
// radial: { fx, fy } (focus in 0-1 of the box) runs stop 0 at the focus out to stop 100 at the edge. Alpha stops make a
// scrim, a wash, or a glow (pictures.md §4); a two-stop opaque run is a cover or section field.
function gradient(slide, x, y, w, h, stops, angle = 0, { radial = null, shape = S.rect } = {}) {
  const spec = { stops: stops.map(([o, c, a = 1]) => [o, c, a]), angle, ...(radial ? { radial } : {}) };
  slide.addShape(shape, { ...box(x, y, w, h), fill: { color: stops[0][1] }, line: { color: stops[0][1] },
    objectName: 'mixdog-gradient:' + encodeURIComponent(JSON.stringify(spec)) });
}
// gradientField: the same gradient under its older name (scripts await it).
async function gradientField(slide, x, y, w, h, stops, angle = 0) { gradient(slide, x, y, w, h, stops, angle); }
async function png(svg) {
  const buf = await sharp(Buffer.from(svg)).png().toBuffer();
  return 'image/png;base64,' + buf.toString('base64');
}
// Icon by name from the offline set (ICON is injected: 256 Lucide stroke icons — ICON.names lists them; an unknown
// name throws with the nearest), or a 24-unit fill path of your own. d: a size band — glyph 0.3 (inline with a text
// line, a list prefix) · marker 0.45 (a stage or row mark) · disc 0.6 (an icon-led item in its tinted disc) · hero 1.0
// (the one icon a page is about) — or a number, read as the band it fits (composition.md §9). The stroke follows the
// band so a small icon does not close up and a large one does not thin out; the disc is the default from the disc band up.
const ICON_SIZE = { glyph: 0.3, marker: 0.45, disc: 0.6, hero: 1.0 };
const ICON_STROKE = { glyph: 2.5, marker: 2.25, disc: 2, hero: 1.5 };
function iconBand(d) {
  if (typeof d === 'string') { if (!(d in ICON_SIZE)) throw new Error(`icon: unknown size band "${d}" — one of ${Object.keys(ICON_SIZE).join(', ')}`); return d; }
  return Object.keys(ICON_SIZE).find((band) => d <= ICON_SIZE[band] + 0.01) || 'hero';
}
async function icon(slide, x, y, d, name, { tint = T.paperAlt, color = T.accent, disc, stroke } = {}) {
  const band = iconBand(d);
  d = typeof d === 'string' ? ICON_SIZE[d] : d;
  disc ??= band === 'disc' || band === 'hero';
  stroke ??= ICON_STROKE[band];
  if (disc) slide.addShape(S.ellipse, { ...box(x, y, d, d), fill: { color: tint }, line: { color: tint } });
  const inset = disc ? 0.25 : 0, px = Math.round(d * (1 - inset * 2) * PX);
  const svg = /^[Mm]/.test(name)
    ? `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 24 24"><path d="${name}" fill="#${color}"/></svg>`
    : ICON.svg(name, { color, size: px, strokeWidth: stroke });
  slide.addImage({ data: await png(svg), ...box(x + d * inset, y + d * inset, d * (1 - inset * 2), d * (1 - inset * 2)) });
}
// A row of icon-led items: icon in a disc, bold header, measured description — widths by weight.
// label / detail: role names (default strong / caption); a row that owns the body zone takes lead / body and a larger d.
async function iconRow(slide, x, y, w, items, { d = 0.6, gap = GUTTER, label: labelRole = 'strong', detail: detailRole = 'caption' } = {}) {
  const cols = spans(x, w, items.map((it) => weightOf({ label: it.label, detail: it.detail })), { gap });
  let bottom = y;
  for (let i = 0; i < items.length; i += 1) {
    const { label, detail, icon: name } = items[i], c = cols[i];
    await icon(slide, c.x, y, d, name);
    const lb = text(slide, label, c.x, y + d + GAP.within, c.w, labelRole, { bold: true });
    bottom = Math.max(bottom, detail ? text(slide, detail, c.x, lb + GAP.within, c.w, detailRole, { color: T.body, lh: 1.35 }) : lb);
  }
  return bottom;
}
// Soft radial glow behind a hero element (dark-tech, cover motif): a native radial gradient on an ellipse.
async function glow(slide, cx, cy, r, color = T.accent, alpha = 0.35) {
  gradient(slide, cx - r, cy - r, r * 2, r * 2, [[0, color, alpha], [100, color, 0]], 0, { radial: { fx: 0.5, fy: 0.5 }, shape: S.ellipse });
}
```

## 3. Measured text
`MEASURE` is injected by the runtime with the review's own font metrics; every text box here is sized with it, never by guessing. `lh` is the box's `lineSpacingMultiple` (1 = single); PowerPoint lays every face out at 1.2 em per single line, Hangul and Latin alike. Leading is the author's call per box (`direction.md` §6); the helpers only default it.

**Default — Hangul wraps by the eojeol**: PowerPoint breaks Korean at any character (정답/률, 그라디언/트, a one-syllable last line), so every kit text helper pre-breaks Hangul text where the last whole word fits (`wrapKo`, `wrapRuns`) and writes the break as a soft break (`a:br`) inside one paragraph. Author-written `\n` breaks are kept; a word wider than its zone is left to PowerPoint. **Default — a shrinking box lands on the scale**: `fitSize` steps down through the deck's type scale and diagram sizes (22 → 18 → 14 → 13), never to a free number 1 pt under.
```js
// fitH: the height a box of width w needs for text at size; fitSize: the largest scale step ≤ size that fits w × h.
const fitH = (text, w, size, font = T.sans, { bold = false, lh = 1 } = {}) => MEASURE(text, { font, size, bold, width: w, lineHeight: lh }).height + 0.06;
const lineH = (size, font = T.sans, lh = 1) => size / 72 * 1.2 * lh;   // PowerPoint's single pitch, every face
const textW = (text, size, font = T.sans, bold = false) => MEASURE(text, { font, size, bold }).width;
// Hangul wraps by the eojeol (the space-delimited word), never inside one. The break goes into the text where the
// last whole word fits, measured at 98 % of the zone against the renderer's rounding; author-written breaks stay;
// a word wider than the zone is left to PowerPoint. Latin already wraps at spaces; Japanese and Chinese carry none.
const HANGUL = /[\uAC00-\uD7A3\u1100-\u11FF\u3130-\u318F]/;
const NO_BREAK_BEFORE = /^[,.:;!?%)\]}」』’”…·]/;   // a closing mark never starts a line
const WRAP_MARGIN = 0.98;
function wrapKo(str, w, size, font = T.sans, bold = false) {
  const s = String(str ?? '');
  if (!HANGUL.test(s) || !(w > 0)) return s;
  const limit = w * WRAP_MARGIN, width = (t) => MEASURE(t, { font, size, bold }).width;
  return s.split('\n').map((para) => {
    const lines = [];
    let line = '';
    for (const word of para.split(' ').filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (line && !NO_BREAK_BEFORE.test(word) && width(next) > limit) { lines.push(line); line = word; } else line = next;
    }
    lines.push(line);
    return lines.join('\n');
  }).join('\n');
}
// A pre-broken string as one paragraph with soft breaks (a:br), so paragraph spacing and bullets stay where the
// author put them; a string without a break passes through unchanged.
const runsOf = (str) => (String(str).includes('\n')
  ? String(str).split('\n').map((line, i) => (i ? { text: line, options: { softBreakBefore: true } } : { text: line }))
  : str);
// Inline runs wrapped as one line stream: each word is measured in its own run's face, weight, and size, and the
// break is a soft break before the first word that would cross the zone. Paragraph options (bullet, paraSpaceAfter,
// breakLine) stay on the run that carried them; a run's later pieces carry only its type.
function wrapRuns(runs, w, size, font = T.light) {
  if (!runs.some((run) => HANGUL.test(String(run.text)))) return runs;
  const limit = w * WRAP_MARGIN, out = [];
  let used = 0, space = null;   // space: the blank waiting for the next word, and the piece it appends to when no break falls there
  for (const run of runs) {
    const o = run.options || {}, face = o.fontFace || font, bold = Boolean(o.bold), sz = o.fontSize || size;
    const width = (t) => MEASURE(t, { font: face, size: sz, bold }).width;
    const style = { ...o };
    for (const key of ['breakLine', 'paraSpaceAfter', 'paraSpaceBefore', 'bullet', 'softBreakBefore']) delete style[key];
    let piece = { text: '', options: { ...o, breakLine: false } };
    out.push(piece);
    for (const tok of String(run.text).split(/( +|\n)/).filter(Boolean)) {
      if (tok === '\n') { piece = { text: '', options: { ...style, softBreakBefore: true } }; out.push(piece); used = 0; space = null; continue; }   // an author's break
      if (/^ +$/.test(tok)) { space = { text: tok, width: width(tok), at: piece }; continue; }
      const wt = width(tok);
      if (space && used > 0 && !NO_BREAK_BEFORE.test(tok) && used + space.width + wt > limit) {
        piece = { text: tok, options: { ...style, softBreakBefore: true } };
        out.push(piece);
        used = wt;
      } else {
        if (space) { space.at.text += space.text; used += space.width; }
        piece.text += tok;
        used += wt;
      }
      space = null;
    }
    if (o.breakLine) { piece.options.breakLine = true; used = 0; }
  }
  if (space) space.at.text += space.text;
  return out.filter((piece) => piece.text || piece.options.breakLine);
}
// The sizes a shrinking box may land on: the deck's scale and the diagram sizes, largest first.
const scaleSteps = () => [...new Set([...Object.values(TYPE), DIAG.label, DIAG.note])].sort((a, b) => b - a);
function fitSize(text, w, h, size, font = T.sans, { bold = false, lh = 1, min = 12 } = {}) {
  const steps = [size, ...scaleSteps().filter((s) => s < size && s >= min)];
  for (const s of steps) if (fitH(wrapKo(text, w, s, font, bold), w, s, font, { bold, lh }) <= h) return s;
  return steps[steps.length - 1];
}
// The general measured text box. Returns the bottom edge so the next element registers under it.
// size is a number or a role name ('caption', 'label', …): a role brings its face, weight, color, and leading;
// any of them may be overridden per box. Numeric size defaults: light face, lh 1.2 for lead size and above, 1.35 under it.
function text(slide, str, x, y, w, size, { color, font, bold, align = 'left', valign = 'top', lh, h, size: sizeOverride } = {}) {
  if (typeof size === 'string') { const r = role(size); size = sizeOverride ?? r.size; color ??= r.color; font ??= r.font; bold ??= r.bold; lh ??= h ? 1 : r.lh; }
  color ??= T.body; font ??= T.light; bold ??= false;
  lh ??= h ? 1 : (size >= TYPE.lead ? 1.2 : 1.35);
  const face = bold && font === T.light ? T.sans : font;
  const wrapped = wrapKo(str, w, size, face, bold);
  const height = h ?? fitH(wrapped, w, size, face, { bold, lh });
  slide.addText(runsOf(wrapped), { ...box(x, y, w, height), fontFace: face, fontSize: size, bold, color, align, valign, margin: 0, lineSpacingMultiple: lh });
  return y + height;
}
// Title: display face, bold; the size steps down the scale (to 24) when the text would need more than maxLines. Returns the bottom edge.
function title(slide, str, { x = M, y = 1.0, w = W - 2 * M, size = TYPE.title, color = T.ink, align = 'left', maxLines = 2, lh = 1.15 } = {}) {
  const wrapped = (at) => wrapKo(str, w, at, T.display, true);
  const steps = [size, ...scaleSteps().filter((v) => v < size && v >= 24)];
  const s = steps.find((at) => MEASURE(wrapped(at), { font: T.display, size: at, bold: true, width: w, lineHeight: lh }).lines <= maxLines) ?? steps[steps.length - 1];
  const out = wrapped(s), h = Math.max(0.6, fitH(out, w, s, T.display, { bold: true, lh }));
  slide.addText(runsOf(out), { ...box(x, y, w, h), fontFace: T.display, fontSize: s, bold: true, color, align, margin: 0, valign: 'top', lineSpacingMultiple: lh });
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
  slide.addText(wrapRuns(runs, w, size, font), { ...box(x, y, w + inset / 72, h), fontFace: font, fontSize: size, color, margin: [0, inset, 0, 0], valign: 'top', lineSpacingMultiple: lh });
}
// Hero numeral with its label bound under it (GAP.bind). scale: 'hero' (default) | 'poster' | 'band' (one of several peers,
// statBand()) — the size is the scale's (TYPE.hero / TYPE.poster / TYPE.stat through SPEC.stat); size overrides with a TYPE.* value only.
function hero(slide, x, y, w, value, label, { scale = 'hero', size, color, unit = '', labelColor, labelSize } = {}) {
  const sp = spec('stat');
  size ??= sp.size[scale] ?? sp.size.hero; color ??= sp.color; labelColor ??= sp.label.color; labelSize ??= sp.label.size;
  const runs = [{ text: value, options: { fontSize: size } }];
  if (unit) runs.push({ text: unit, options: { fontSize: Math.round(size * sp.unit) } });
  const h = Math.max(1.12, lineH(size, T.data) + 0.04), bind = GAP.bind;
  slide.addText(runs, { ...box(x, y, w, h), fontFace: T.data, bold: true, color, margin: 0, valign: 'bottom' });
  if (!label) return y + h;
  const l = wrapKo(label, w, labelSize, T.sans), lh = fitH(l, w, labelSize);
  slide.addText(runsOf(l), { ...box(x, y + h + bind, w, lh), fontFace: T.sans, fontSize: labelSize, color: labelColor, margin: 0, valign: 'top' });
  return y + h + bind + lh;
}
// A genuine list: one text box, bullets on each item, a paragraph step visibly larger than the line step.
function bullets(slide, x, y, w, h, items, size = TYPE.body, color = T.body, { lh = 1.35, font = T.light } = {}) {
  const s = fitSize(items.join('\n'), w - 0.3, h - items.length * size * 0.6 / 72, size, font, { lh, min: TYPE.caption });
  const runs = items.flatMap((str, i) => wrapKo(str, w - 0.3, s, font).split('\n').map((line, j, lines) => ({ text: line, options: {
    ...(j === 0 ? { bullet: true, paraSpaceAfter: Math.round(s * 0.6) } : { softBreakBefore: true }),
    ...(j === lines.length - 1 && i < items.length - 1 ? { breakLine: true } : {}),
  } })));
  slide.addText(runs, { ...box(x, y, w, h), fontFace: font, fontSize: s, color, valign: 'top', margin: 0, lineSpacingMultiple: lh });
}
// Prose: h is the ceiling; the size steps down the scale (to 12) until the text fits it.
function prose(slide, str, x, y, w, h, size = TYPE.body, color = T.body, { lh = 1.45, font = T.light } = {}) {
  const s = fitSize(str, w, h, size, font, { lh });
  slide.addText(runsOf(wrapKo(str, w, s, font)), { ...box(x, y, w, h), fontFace: font, fontSize: s, color, valign: 'top', margin: 0, lineSpacingMultiple: lh });
}
// Caption / source line under a figure or picture: caption size, muted, registered to the figure's left edge.
function caption(slide, str, x, y, w, color = T.muted) {
  return text(slide, str, x, y, w, TYPE.caption, { color, lh: 1.2 });
}
// Takeaway band: one sentence closing a page that has a claim to close; sits near the lower safe margin.
function takeaway(slide, str, y = H - M - 0.75, { x = M, w = W - 2 * M, h = 0.7, tint = T.tint, color = T.ink } = {}) {
  const c = inner({ x, w }), size = fitSize(str, c.w, h - 0.2, TYPE.lead, T.sans, { min: TYPE.caption });
  slide.addShape(S.rect, { ...box(x, y, w, h), fill: { color: tint }, line: { color: tint } });
  slide.addText(runsOf(wrapKo(str, c.w, size, T.sans)), { ...box(c.x, y, c.w, h), fontFace: T.sans, fontSize: size, color, margin: 0, valign: 'middle' });
}
// Specimen: the subject drawn, not described. rows: [{ text, font, size, bold, label, color }] on one baseline grid.
function specimen(slide, x, y, w, rows, { labelW = 1.6, gap = GAP.between, labelColor = T.muted } = {}) {
  let cy = y;
  const tx = x + labelW + GAP.within, tw = w - labelW - GAP.within;
  for (const r of rows) {
    const font = r.font || T.sans, size = r.size || TYPE.body, bold = r.bold === true;
    const h = Math.max(0.45, fitH(r.text, tw, size, font, { bold, lh: 1.2 }) + 0.05);
    slide.addText(r.label || '', { ...box(x, cy, labelW, 0.4), fontFace: T.data, fontSize: DIAG.note, color: labelColor, margin: 0, valign: 'top' });
    slide.addText(r.text, { ...box(tx, cy, tw, h), fontFace: font, fontSize: size, bold, color: r.color || T.ink, margin: 0, valign: 'top', lineSpacingMultiple: 1.2 });
    cy += h + gap;
  }
  return cy;
}
// Ghost numeral: a chapter mark behind content. Keep the box inside the canvas (w ≤ W - x).
function ghost(slide, str, x, y, size = 240, w = 5.5, { color = T.onAccent, transparency = 88 } = {}) {
  slide.addText(str, { ...box(x, y, w, lineH(size, T.data) + 0.05), fontFace: T.data, fontSize: size, bold: true, color, transparency, margin: 0, valign: 'top' });
}
```

## 4. Zones and layout by weight (composition.md §6)
```js
// Optional header/body scaffold for related pages, not a compulsory layout for every content slide.
// Use shared zones when the pages share a structure; compose a dominant figure or relationship directly
// with the primitives when it needs a different title position or content field.
// titleLines: the deck's longest content title in lines (the brief decides; default 1). A two-line band under
// one-line titles leaves 0.7 in of dead air above every kicker — reserve two lines only when a title needs them.
function zones(mode = MODE, { titleLines = 1 } = {}) {
  const headTop = M + 0.3 + GAP.within;                                                     // room for the kicker above the title
  const headBottom = headTop + lineH(TYPE.title, T.display, 1.15) * titleLines + 0.06;   // the title's bottom edge (+ fitH's allowance)
  return {
    head: { kicker: M, top: headTop, bottom: headBottom },
    body: { top: headBottom + GAP.between, bottom: H - M - 0.2 },
    foot: { takeaway: H - M - 0.75, source: H - 0.78 },
    seam: splitAt(M, W - 2 * M, 7, 3),                        // the deck seam (GUTTER wide); re-assign once from the brief (e.g. 3:7) and reuse
  };
}
let Z = zones(MODE);
// head: kicker + assertion title on the deck's head band — the title's bottom sits on Z.head.bottom whether it
// runs one line or two, the kicker hangs a within step above the title's first line. Returns Z.body.top: the first
// body element sits exactly there (flow(s, x, Z.body.top, …)), never at Z.body.top + a hand offset.
// w: the column the title shares with the body under it — pass the same w to both so their right edges register.
function head(slide, kickerText, titleText, { size = TYPE.title, color = T.ink, kickerColor = T.accent, w = W - 2 * M, x = M } = {}) {
  const lh = 1.15, t = wrapKo(titleText, w, size, T.display, true), th = fitH(t, w, size, T.display, { bold: true, lh });
  const top = Z.head.bottom - th;
  if (top < Z.head.top - 0.01) throw new Error(`head: title needs ${(Z.head.top - top).toFixed(2)} in more than the head band — shorten it or break it in two lines`);
  slide.addText(runsOf(t), { ...box(x, top, w, th), fontFace: T.display, fontSize: size, bold: true, color, margin: 0, valign: 'bottom', lineSpacingMultiple: lh });
  if (kickerText) kicker(slide, kickerText, x, top - 0.3 - GAP.within, kickerColor);
  return Z.body.top;
}
// source: the running source line on the foot; never moves.
function source(slide, str, { color = T.muted, w = W - 2 * M - 0.9 } = {}) { text(slide, str, M, Z.foot.source, w, TYPE.caption, { color, font: T.data, lh: 1.1 }); }

// Content weight of a peer: an explicit `weight`, else the length of what it says; an active peer counts more.
const weightOf = (item, { active = false } = {}) => (Number(item?.weight)
  || Math.max(1, [item?.value, item?.label, item?.detail, item?.context, item?.text].filter(Boolean).join(' ').length)) * (active ? 1.35 : 1);
// spans: widths for a row of peers from their weights, clamped so the lightest stays readable and the heaviest does not swallow the row.
function spans(x, w, weights, { gap = GUTTER, minRatio = 0.7, maxRatio = 1.6 } = {}) {
  const n = weights.length, mean = weights.reduce((a, b) => a + b, 0) / n || 1;
  const norm = weights.map((v) => Math.min(maxRatio, Math.max(minRatio, (v || mean) / mean)));
  const total = norm.reduce((a, b) => a + b, 0), free = w - gap * (n - 1);
  let cx = x;
  return norm.map((v) => { const cw = free * v / total; const out = { x: cx, w: cw }; cx += cw + gap; return out; });
}
// splitAt: the seam of a two-plane slide from each side's weight; never the middle unless the weights are equal.
function splitAt(x, w, leftWeight, rightWeight, { gap = GUTTER, min = 0.38, max = 0.62 } = {}) {
  const share = Math.min(max, Math.max(min, leftWeight / ((leftWeight + rightWeight) || 1)));
  const lw = (w - gap) * share;
  return { left: { x, w: lw }, right: { x: x + lw + gap, w: w - gap - lw } };
}
// Stat band: several numbers with one cause on one baseline (composition.md §4) — value (+ unit) over label over detail
// per peer, widths by weight, one rule under the band. stats: [{ value, unit?, label, detail?, weight? }]. Returns the
// bottom edge (under the rule). Anatomy from SPEC.stat at the band scale; scale: 'hero' for two or three large peers.
function statBand(slide, x, y, w, stats, { scale = 'band', gap = GUTTER, ruled = true } = {}) {
  const sp = spec('stat'), cols = spans(x, w, stats.map((st) => weightOf(st)), { gap });
  let bottom = y;
  stats.forEach((st, i) => {
    const b = hero(slide, cols[i].x, y, cols[i].w, st.value, st.label, { scale, unit: st.unit || '' });
    bottom = Math.max(bottom, st.detail ? text(slide, st.detail, cols[i].x, b + GAP.within, cols[i].w, sp.detail.role, { color: sp.detail.color }) : b);
  });
  if (!ruled) return bottom;
  hairline(slide, x, bottom + GAP.between, w);
  return bottom + GAP.between;
}
// flow: measured blocks stacked top-down inside one region; returns the bottom. A block is
// { text, role?, size?, font?, bold?, color?, lh?, h?, after? } or a function (y) => bottom for any kit call.
// The step after a block is GAP.within (it binds to the next: a heading over its paragraph); a block that closes a
// group says after: GAP.between. A block that would cross the region's bottom throws (never a silent drop):
// widen the zone, shorten the copy, or cut a block.
function flow(slide, x, y, w, blocks, { gap = GAP.within, bottom = H - M } = {}) {
  let cy = y;
  blocks.forEach((b, i) => {
    if (!b) return;
    if (typeof b === 'function') { cy = b(cy) + gap; return; }
    const r = b.role ? role(b.role) : null;
    const size = b.size || r?.size || TYPE.body, bold = b.bold ?? r?.bold ?? false, font = b.font || r?.font || (bold ? T.sans : T.light), lh = b.lh ?? (b.h ? 1 : r?.lh ?? 1.35);
    const t = wrapKo(b.text, w, size, font, bold), h = b.h ?? fitH(t, w, size, font, { bold, lh });
    if (cy + h > bottom + 0.01) throw new Error(`flow: block ${i + 1} of ${blocks.length} ("${String(b.text).slice(0, 24)}…") needs ${(cy + h - bottom).toFixed(2)} in past the region bottom ${bottom}`);
    slide.addText(runsOf(t), { ...box(x, cy, w, h), fontFace: font, fontSize: size, bold, color: b.color || r?.color || T.body, margin: 0, valign: 'top', lineSpacingMultiple: lh });
    cy += h + (b.after ?? gap);
  });
  return cy;
}
// stack: a vertical flex for one region (composition.md §6, "fill the frame"). Blocks are flow blocks, plus
// { flex: (y, h) => void } for the one element that takes whatever height the measured blocks leave (a chart,
// a picture, a diagram), { spacer: true } for a flexible gap that hangs everything after it on the region's
// bottom, and { h, draw: (y, h) => void } for a fixed-height device. justify 'fill' (default) gives
// the leftover to the flex block; 'between' spreads it into the gaps when there is no flex block. The bottom is
// the zone's, so the column reaches the foot instead of stopping where the measure ran out. Returns the bottom.
function stack(slide, x, y, w, blocks, { bottom = Z.body.bottom, gap = GAP.within, justify = 'fill' } = {}) {
  const items = blocks.filter(Boolean).map((b) => {
    if (b.spacer) return { ...b, kind: 'flex', flex: () => {}, h: 0 };
    if (b.flex) return { ...b, kind: 'flex', h: 0 };
    const r = b.role ? role(b.role) : null;
    const size = b.size || r?.size || TYPE.body, bold = b.bold ?? r?.bold ?? false, font = b.font || r?.font || (bold ? T.sans : T.light), lh = b.lh ?? (b.h ? 1 : r?.lh ?? 1.35);
    const t = wrapKo(b.text, w, size, font, bold), h = b.h ?? fitH(t, w, size, font, { bold, lh });
    return { ...b, text: t, kind: b.draw ? 'draw' : 'text', h, size, bold, font, lh, color: b.color || r?.color || T.body };
  });
  const fixed = items.reduce((a, b) => a + b.h, 0), between = items.slice(0, -1).reduce((a, b) => a + (b.after ?? gap), 0);
  const free = bottom - y - fixed - between, flexCount = items.filter((b) => b.kind === 'flex').length;
  if (free < -0.01) throw new Error(`stack: content needs ${(-free).toFixed(2)} in more than the region ${y.toFixed(2)}..${bottom.toFixed(2)} — cut a block or widen the zone`);
  const spread = justify === 'between' && !flexCount && items.length > 1 ? free / (items.length - 1) : 0;
  let cy = y;
  items.forEach((b, i) => {
    const h = b.kind === 'flex' ? free / flexCount : b.h;
    if (b.kind === 'flex') b.flex(cy, h);
    else if (b.kind === 'draw') b.draw(cy, h);
    else slide.addText(runsOf(b.text), { ...box(x, cy, w, h), fontFace: b.font, fontSize: b.size, bold: b.bold, color: b.color, margin: 0, valign: 'top', lineSpacingMultiple: b.lh });
    cy += h + (i < items.length - 1 ? (b.after ?? gap) + spread : 0);
  });
  return cy;
}
```

## 5. Shapes (native, editable in PowerPoint)
```js
function field(slide, x, y, w, h, tint = T.paperAlt, shape = S.rect, extra = {}) {   // page field or module surface
  slide.addShape(shape, { ...box(x, y, w, h), fill: { color: tint }, line: { color: tint }, ...extra });
}
// Outline carrier: no fill, one coherent stroke (the strong line — it owns the region) — ownership without a heavy card.
function outline(slide, x, y, w, h, { color = T.lineStrong, width = 1, shape = S.rect, radius = 0, dash = 'solid' } = {}) {
  slide.addShape(shape, { ...box(x, y, w, h), fill: { color: T.paper, transparency: 100 }, line: { color, width, dashType: dash }, ...(radius ? { rectRadius: radius } : {}) });
}
// Badge / chip: compact status, tag, or category label. tone: neutral (ink on tint) · accent (white on the accent, the one
// emphasized chip) · a state (its word on its weak field). Anatomy from SPEC.badge; h null takes the spec's height.
function badge(slide, x, y, w, h, str, { tone: toneName = 'neutral', fill, color, font, size } = {}) {
  const sp = spec('badge'), t = tone(toneName);
  h ??= sp.h; fill ??= t.fill; color ??= t.color; font ??= sp.font; size ??= sp.size;
  slide.addShape(S.roundRect, { ...box(x, y, w, h), rectRadius: sp.radius, fill: { color: fill }, line: { color: fill } });
  slide.addText(str, { ...box(x, y, w, h), fontFace: font, fontSize: size, bold: true, color, align: 'center', valign: 'middle', margin: 0 });
}
// Horizontal rule: T.line at a section boundary (default), T.lineSubtle between repeated items, T.lineStrong as a frame edge.
function hairline(slide, x, y, w, color = T.line) {
  slide.addShape(S.line, { ...box(x, y, w, 0), line: { color, width: 1 } });
}
function rule(slide, x, y, h, color = T.line, width = 1) {   // vertical rule the content hangs from
  slide.addShape(S.line, { ...box(x, y, 0, h), line: { color, width } });
}
function connector(slide, x1, y1, x2, y2, { color = T.muted, width = 1.5, arrow = 'triangle', dash = 'solid' } = {}) {
  slide.addShape(S.line, { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1),
    flipH: x2 < x1, flipV: y2 < y1, line: { color, width, endArrowType: arrow, dashType: dash } });
}
// Chevron run: each tip enters the next notch. widths: per-stage spans from spans() (weights), else equal — equal only when
// the stages carry equal weight. Anatomy from SPEC.chevrons (notch, face, size, the default and active stage).
function chevrons(slide, x, y, w, h, labels, { active = -1, widths = null, size } = {}) {
  const sp = spec('chevrons'), n = labels.length, notch = h * sp.notch;
  const ws = widths ? widths.map((c) => c.w) : labels.map(() => (w - notch) / n);
  let cx = x;
  labels.forEach((label, i) => {
    const cw = ws[i] + notch, state = i === active ? 'active' : 'default';
    slide.addShape(S.chevron, { ...box(cx, y, cw, h), fill: { color: sp.fill[state] }, line: { color: sp.seam, width: 1.5 } });
    slide.addText(label, { ...box(cx + notch, y, cw - notch * 2, h), fontFace: sp.font, fontSize: size ?? sp.size, bold: state === 'active', color: sp.color[state], align: 'center', valign: 'middle', margin: 0 });
    cx += ws[i];
  });
}
function node(slide, cx, cy, d, str, { fill = T.accent, color = T.onAccent, size = DIAG.label } = {}) {
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
// Callout: an annotation attached to a region. tone: neutral (paper field, strong outline) or a state (its weak field, its
// word); form: 'wedge' (the pointer) or 'plain'. Anatomy from SPEC.callout.
function callout(slide, x, y, w, h, str, { tone: toneName = 'neutral', form = 'wedge', size } = {}) {
  const sp = spec('callout'), c = inner({ x, w });
  const t = toneName === 'neutral' ? sp.neutral : tone(toneName);
  slide.addShape(form === 'plain' ? S.rect : S.wedgeRectCallout, { ...box(x, y, w, h), fill: { color: t.fill }, line: { color: t.line ?? t.fill, width: sp.width } });
  slide.addText(str, { ...box(c.x, y, c.w, h), fontFace: sp.font, fontSize: size ?? sp.size, color: t.color, valign: 'middle', margin: 0 });
}
// Custom silhouette: diagonal cut field or any polygon, points in inches relative to the box.
function polygon(slide, x, y, w, h, points, fill = T.dark) {
  slide.addShape(S.custGeom, { ...box(x, y, w, h), fill: { color: fill }, line: { color: fill },
    points: [...points.map((p, i) => ({ x: p[0], y: p[1], moveTo: i === 0 })), { close: true }] });
}
// The one elevated object on the slide (peers stay flat).
function lift(slide, x, y, w, h, tint = T.paper, { radius = RADIUS } = {}) {
  slide.addShape(S.roundRect, { ...box(x, y, w, h), rectRadius: radius, fill: { color: tint }, line: { color: tint },
    shadow: { type: 'outer', color: '000000', blur: 12, offset: 4, angle: 90, opacity: 0.10 } });
}
```
Other presets: `S.round1Rect`, `S.snip1Rect`, `S.snipRoundRect`, `S.trapezoid`, `S.parallelogram`, `S.hexagon`, `S.frame`, `S.corner`, `S.pie` + `angleRange`, `S.donut`, `S.rightArrow`, `S.leftArrow`, `S.downArrow`, `S.leftRightArrow`, `S.bracePair`, `S.triangle`; `rotate` and `flipH` apply to all.
