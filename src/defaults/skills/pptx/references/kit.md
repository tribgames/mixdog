# Kit

Owns the code: primitives that draw what `composition.md` names, sized with `MEASURE` so text never overflows. The kit is a toolbox, not a slide catalog — no function here draws a whole slide, and every position is the author's. Draw every repeated element through one function so the deck stays consistent. Chart and table helpers are in `charts.md`, picture helpers in `pictures.md` §4.

**The runtime runs every code block of this file, `charts.md`, and `pictures.md` before the script** — the script never pastes them. A script opens with the brief, then one `deck({ style, hue, accentHue?, mode, script, pairing, fonts })` call that sets the frame the style chooses, the palette, the faces, the type scale, the zones, and the masters, then the slides. Read the blocks for the signatures and defaults; redefine a helper in the script when a page needs a different one (a later declaration wins). A script that creates its own `pres` runs without the prelude.

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
let RADIUS = 0.08;                              // the one corner radius for lifted or rounded fields; the style sets it
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
// Perceived chroma (OKLab, ×1000) of a hex. The same HSL saturation reads as a gray on one hue and as a beige on
// another, so every neutral below is specified by the chroma a reader sees rather than by S.
function chroma(hex) {
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return Math.hypot(1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s) * 1000;
}
// neutral(h, l, c): the step at lightness l in hue h carrying c perceived chroma, darkened until it clears `min`
// contrast against every background in `against`. What a reader sees as a gray in the deck's own light.
function neutral(h, l, c, against = [], min = 0) {
  const at = (L) => { let lo = 0, hi = 1; for (let i = 0; i < 14; i += 1) { const mid = (lo + hi) / 2; if (chroma(hsl(h, mid, L)) < c) lo = mid; else hi = mid; } return hsl(h, (lo + hi) / 2, L); };
  let l0 = l, hex = at(l0);
  while (l0 > 0.08 && against.some((bg) => contrast(hex, bg) < min)) { l0 -= 0.01; hex = at(l0); }
  return hex;
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
// The ladder: type and surfaces within the seed hue, one saturated accent on the counter hue (the only saturated color on
// type and fields), tinted extremes, three line strengths, the object neutrals, and the four state colors.
// **One neutral ladder, and it is the seed's**: type, surfaces, rules, braces, connectors, tracks, and every bar the accent
// does not own share the seed hue, so the deck shows one gray and one accent — never two tinted grays 150° apart (a brown
// bar under blue-gray type). A filled area reads more chromatic than type at the same chroma, so the object neutrals carry
// roughly half the chroma of `muted`: at that level a warm seed gives a warm gray, not a beige, and the accent stays the
// only color on the page.
// Guarantees: body and muted ≥ 4.5:1 on paper and paperAlt; white ≥ 3:1 on accent; accent ≥ 4.5:1 on paper (an emphasis run
// stays readable); every state text ≥ 4.5:1 on paper, paperAlt, and its own weak field; every state solid ≥ 3:1 on paper.
// **The accent has two forms.** `accent` is the type form: darkened until it reads as a word on paper (4.5:1), which on a
// yellow, green, or orange hue lands near L 0.3 — a mud no reference deck paints a bar with. `accentFill` is the mark form:
// the bright, saturated step (S ≥ 0.78, L ≈ 0.5, ≥ 2:1 on paper) that the reference decks put on the one bar, disc, pill,
// or band that matters (Kakao 60°/1.0/0.6, Naver 135°/0.75/0.6, Coatue 210°/0.75/0.5, NVIDIA 75°/0.75/0.4, Evans
// 0°/0.75/0.6, measured September 2026 — their marks sit at 1.3-2.6:1 against paper; the 3:1 UI-control threshold turns
// every warm or yellow hue into mud, and a bar is not a control). `accentLabel` is the { fill, color } pair a
// type-bearing mark takes (a badge, an active chevron, a numbered node): the bright fill where white or ink reads on it
// at 4.5:1 (a yellow pill carries dark type, a green one white), else the type form of the accent under white (a mid
// amber or blue can host neither at 12 pt). Charts, arcs, dots, and bars fill with accentFill; a word in the accent,
// a kicker, an emphasis run, a hero numeral keep `accent`.
function palette({ hue = 205, accentHue = counterHue(hue), accentSat = 0.72, accentLight = 0.42 } = {}) {
  const paper = hsl(hue, 0.25, 0.975), paperAlt = hsl(hue, 0.18, 0.92), tint = hsl(accentHue, 0.35, 0.89), dark = hsl(hue, 0.42, 0.10);
  const accent = darkenUntil(accentHue, accentSat, accentLight, ['FFFFFF', paper, tint], 4.5);
  const ink = hsl(hue, 0.30, 0.13);
  const accentFill = darkenUntil(accentHue, Math.max(accentSat, 0.78), 0.5, [paper, paperAlt], 2);
  const onAccentFill = contrast('FFFFFF', accentFill) >= 4.5 ? 'FFFFFF' : contrast(ink, accentFill) >= 4.5 ? ink : null;
  const accentLabel = onAccentFill ? { fill: accentFill, color: onAccentFill } : { fill: accent, color: 'FFFFFF' };
  // State colors (direction.md §5): four fixed meanings on fixed hues, each in three forms — `solid` fills a mark (a dot,
  // a delta, a bar; never under type), `weak` is the field under a state word (a verdict cell, a badge, a callout), `text`
  // is the word itself on paper, paperAlt, or weak. The text form is dark and restrained (S 0.30) so the deck's one
  // saturated hue on type stays the accent; the saturated form is the mark. A state's word or glyph always accompanies it.
  const state = Object.fromEntries(Object.entries({ positive: 150, warning: 40, critical: 5, informative: 215 }).map(([name, h]) => {
    const weak = hsl(h, 0.45, 0.92);
    return [name, { solid: darkenUntil(h, 0.65, 0.48, [paper], 3), weak, text: darkenUntil(h, 0.30, 0.34, [paper, paperAlt, weak], 4.5) }];
  }));
  return {
    ink, body: darkenUntil(hue, 0.22, 0.30, [paperAlt], 7), muted: darkenUntil(hue, 0.12, 0.45, [paperAlt, tint], 4.5),
    // Three line strengths (composition.md §6): subtle between repeated items, line at a section boundary, strong as an outline that owns a region.
    lineSubtle: neutral(hue, 0.91, 5), line: neutral(hue, 0.86, 8), lineStrong: neutral(hue, 0.72, 14),
    // The object neutrals: mark is the unemphasized figure (a bar the accent does not own, a brace, a connector, a dot),
    // markSoft its lighter partner (a track, a third series). Both read as gray beside the accent, never as another color.
    mark: neutral(hue, 0.45, 11, [paper, paperAlt, tint], 4.5), markSoft: neutral(hue, 0.80, 7),
    paper, paperAlt, tint,
    dark, darkAlt: hsl(hue, 0.34, 0.17),
    onDark: hsl(hue, 0.20, 0.94), onDarkMuted: hsl(hue, 0.14, 0.72), onDarkAccent: hsl(accentHue, 0.62, 0.74),
    accent, accentDeep: darkenUntil(accentHue, accentSat, accentLight - 0.1, ['FFFFFF', paper], 6),
    accentFill, accentLabel,                   // the mark form of the accent; the { fill, color } pair of a mark that carries type
    onAccent: 'FFFFFF',                        // type on an accent surface; the only white in the ladder — scripts never write a hex literal
    state,
  };
}
const T = { ...palette({ hue: 205 }), display: '', sans: '', light: '', data: '' };   // deck() seeds it from the brief; faces set by typography()

// Type scale (direction.md §6): the reading mode sets the body anchor; every role derives from it.
let MODE = 'balanced';                          // presentation 20 · balanced 15 · text 13 (body pt); deck() sets it from the brief
// Anchors from the reference corpus (ten decks, September 2026, text sizes read from the PDFs and normalised to a
// 540 pt canvas): analyst and IR pages set body at 10-14 pt (Naver 10, Kakao 10.5, Bond 11, NVIDIA 13.5, Coatue 14,
// Samsung 16) under a content title of 16-30 pt (median 22) — title / body 1.0-2.1, the hierarchy carried by weight,
// colour, and position more than by size — and their smallest type (sources, axis labels) is 7.5-12. A keynote
// (Sequoia) reads at body 20 under titles of 30-66. Our earlier scale (18 under 36-44) was one step larger than any
// of them and carried a fifth of their copy per page. The runtime floors stay: body 12 pt, one-line chrome 9 pt.
function typeScale(mode) {
  const b = { presentation: 20, balanced: 15, text: 13 }[mode] ?? 15;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Math.round(v)));
  return {
    body: b, lead: Math.round(b * 1.2), caption: clamp(b * 0.75, 10, 14), kicker: clamp(b * 0.65, 9, 12),
    section: clamp(b * 2.2, 28, 44), title: clamp(b * 1.8, 22, 36), cover: clamp(b * 2.8, 36, 56), hero: Math.round(b * 3.6),
    stat: Math.round(b * 2.7),                 // the numeral of a band of peers (statBand): smaller than a hero because there are several
    poster: clamp(b * 6, 84, 132),             // the one display size past hero: a cover or closing numeral, a poster word
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
    definitions: () => ({ notch: 0.25, size: DIAG.label, font: T.sans, seam: T.paper, fill: { default: T.paperAlt, active: T.accentLabel.fill }, color: { default: T.body, active: T.accentLabel.color } }) },
  stat: { slots: ['value', 'unit', 'label', 'detail'], variants: { scale: ['hero', 'poster', 'band'] },
    definitions: () => ({ size: { hero: TYPE.hero, poster: TYPE.poster, band: TYPE.stat }, unit: 0.4, color: T.accent, label: { size: TYPE.caption, color: T.muted }, detail: { role: 'caption', color: T.body } }) },
  table: { slots: ['header', 'cell', 'verdict'], variants: { banding: ['plain', 'banded'], verdict: ['neutral', 'positive', 'warning', 'critical', 'informative'] },
    // Row pitch follows the type (2.2 × body: 0.46 in at 15 pt): the Kakao and Samsung IR tables run 1.9-2.1 × theirs.
    definitions: () => ({ rowH: Math.max(0.36, Math.round(TYPE.body * 2.2 / 72 * 100) / 100), size: TYPE.body, font: T.sans, margin: [0.08, 0.16, 0.08, 0.16], header: { fill: T.paperAlt, color: T.ink }, border: { type: 'solid', color: T.lineSubtle, pt: 0.5 } }) },
  // The relationship structures (§6): one node size, one edge color, one label face across a timeline, a hub, a tier —
  // the kind is the variant the receipt reports, so a deck can see which structures it used and which it repeated.
  structure: { slots: ['node', 'label', 'edge'], variants: { kind: ['timeline', 'steps', 'hub', 'loop', 'merge', 'tiers', 'lanes', 'quadrants', 'venn', 'quote', 'braceGroups', 'agenda'], state: ['default', 'active'] },
    // Structure labels read at body size: a frontier diagram's nodes carry 18-20 pt type and the node is a page object
    // (a 2.7 in disc, not a 0.4 in dot) — a structure at caption size reads as an annotation, not as the page's carrier.
    // Measured (Coatue process page, September 2026): numbered discs 0.45 in, step blocks 2.7 × 0.85 in in the mark form
    // of the accent with white 18 pt labels, the row on a pale context band 1.6 in tall, 1-1.5 pt dark connectors with
    // filled heads, and a card under each step holding 3-5 icon-led lines — the diagram is two-thirds of the page.
    definitions: () => ({ size: Math.min(TYPE.body, 18), note: Math.min(TYPE.caption, 13), font: T.sans, node: 0.46, edge: T.mark, fill: { default: T.paperAlt, active: T.accentLabel.fill }, color: { default: T.ink, active: T.accentLabel.color } }) },
  // The KPI / bento card (cards()): one gap on the ladder, the one radius, the tint under every card but the accent one
  // (apple-bento-grid, MIT: 6 px gaps at 1200 px, every cell filled, three or four accents at most across a grid —
  // here one, the figure the page is about).
  cards: { slots: ['field', 'opener', 'value', 'label', 'detail'], variants: { tone: ['default', 'accent'] },
    definitions: () => ({ gap: GAP.within, radius: RADIUS, tint: T.paperAlt, accent: T.accentLabel, value: T.accent, label: T.muted }) },
};
function spec(name) {
  const s = SPEC[name];
  if (!s) throw new Error(`spec: unknown "${name}" — one of ${Object.keys(SPEC).join(', ')}`);
  return { slots: s.slots, variants: s.variants, ...s.definitions() };
}
// A spec carrier signs its shape: the receipt reads the name back (composition.md §9) and reports per slide and per deck
// how many of each carrier the deck holds, in which variants, and whether their anatomy (type size and face) stayed one.
const specName = (name, variant = '') => `mixdog-spec:${name}${variant ? `:${variant}` : ''}`;
// tone: the field + type pair a toned carrier takes — neutral ink on tint, accent the mark form of the accent with the
// type that reads on it (Kakao's yellow pill carries dark type; a blue one white), a state its word on its weak field
// (direction.md §5: the solid form never sits under type).
function tone(name = 'neutral') {
  if (name === 'neutral') return { fill: T.tint, color: T.ink };
  if (name === 'accent') return { fill: T.accentLabel.fill, color: T.accentLabel.color };
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
// style: the frame (STYLES above) — its chrome, corner radius, rule stroke, motif, theme, and accent policy in one id
// from direction.md §3; chrome: overrides the chrome it chose. The five chromes are 'bare', 'bands', 'rail' (the title
// on the main column, the kicker in the left rail), 'plane' (a full-height dark plane carries the head and the body
// takes the column beside it) and 'masthead' (the title flush to the page top over one heavy full-bleed bar).
// titleLines: the deck's longest content title in lines (zones()). chrome: 'bare' (the default for every mode) puts the
// title on the open canvas with the kicker above it — nine of the ten reference decks (Bond, Evans, BCG, NVIDIA, Kakao,
// Naver, Coatue, Sequoia, YC) carry their title on paper with no band, and the source as one small line at the foot;
// 'bands' draws the Samsung IR head band — a dark field from the page top holding the title in onDark and the kicker at
// its right — and no foot band. A pale tinted band on every page is not a reference pattern: pale fields cover ≤ 2% of
// a reference page (Coatue 1.3%, Samsung 1.6%, BCG 2.1%) against 27% on our earlier banded pages. Returns T. The masters
// take these colors when the first slide is added, so deck() runs before any light() / dark() / quiet().
let CHROME = 'bare';
// theme 'dark' (Krafton 2Q25: charcoal on every page, white type, one bright accent, the marks in light greys — a
// deck dark throughout is a theme, and its dark pages are body pages, not beats): the paper and ink roles swap once,
// here, so every helper draws dark from the same tokens — paper → dark, paperAlt → darkAlt, tint → a dark tint of
// the accent, ink and body → onDark, muted → onDarkMuted, the three lines and the two marks → greys that read on
// dark, the type form of the accent → onDarkAccent; the beats (dark(), quiet(), the takeaway) go a step darker than
// the body so a section mark still reads as one. A state word keeps its solid form on dark (its text form is made
// for paper). light() then draws the theme's body page; a script never chooses colours per slide.
function darkTheme(hue) {
  const body = hsl(hue, 0.42, 0.10), beat = hsl(hue, 0.45, 0.06);
  Object.assign(T, {
    paper: body, paperAlt: hsl(hue, 0.34, 0.16), tint: hsl(hue, 0.30, 0.22),
    ink: T.onDark, body: T.onDark, muted: T.onDarkMuted,
    lineSubtle: hsl(hue, 0.20, 0.20), line: hsl(hue, 0.18, 0.28), lineStrong: hsl(hue, 0.16, 0.44),
    mark: hsl(hue, 0.12, 0.64), markSoft: hsl(hue, 0.14, 0.34),
    accent: T.onDarkAccent, accentDeep: T.onDarkAccent,
    dark: beat, darkAlt: hsl(hue, 0.36, 0.11),
    state: Object.fromEntries(Object.entries(T.state || {}).map(([name, s]) => [name, { ...s, text: s.solid, weak: hsl({ positive: 150, warning: 40, critical: 5, informative: 215 }[name] ?? hue, 0.35, 0.20) }])),
  });
}
// The style the brief names (direction.md §3) is mechanical here, not advice: it chooses the page chrome, the corner
// radius, the stroke a rule takes, the motif an anchor repeats, the theme, and whether the accent stays on the seed
// hue. Passed to deck(), two decks of the same content open on visibly different pages; left out, every deck repeats
// one frame — the title at the top left, the body under it, the source at the foot — whatever its brief called it.
// `motifs` is the style's decoration set, not one device: an anchor that names no kind takes the next one, so the
// cover, the section marks, and the closing of one deck are not the same drawing three times (composition.md §3).
const STYLES = {
  'swiss-minimal': { chrome: 'bare', radius: 0, line: 1, motifs: ['rays', 'dots'], singleHue: true, pairing: 'weight', titleBoost: 1.15 },
  editorial: { chrome: 'rail', radius: 0, line: 1, motifs: ['waves', 'rings'], pairing: 'serif' },
  'photo-editorial': { chrome: 'plane', radius: 0, line: 1, motifs: ['arcs', 'waves'], pairing: 'serif' },
  'data-journalism': { chrome: 'bands', radius: 0, line: 1, motifs: ['dots', 'rays'], pairing: 'weight' },
  'soft-rounded': { chrome: 'bare', radius: 0.16, line: 0.75, motifs: ['rings', 'arcs'], pairing: 'concord' },
  'dark-tech': { chrome: 'plane', radius: 0.08, line: 1, motifs: ['rings', 'rays'], theme: 'dark', pairing: 'weight' },
  glassmorphism: { chrome: 'bare', radius: 0.2, line: 0.75, motifs: ['rings', 'waves'], theme: 'dark', pairing: 'concord' },
  blueprint: { chrome: 'bands', radius: 0, line: 1, motifs: ['dots', 'rings'], theme: 'dark', pairing: 'weight' },
  brutalist: { chrome: 'masthead', radius: 0, line: 3, motifs: ['rays', 'dots'], singleHue: true, pairing: 'weight', titleBoost: 1.3 },
  // custom: the frame the kit drew before the styles existed — write the five columns of direction.md §3 yourself.
  custom: { chrome: 'bare', radius: 0.08, line: 1, motifs: ['rings', 'arcs'] },
};
const STYLE_DEFAULTS = { chrome: 'bare', radius: 0.08, line: 1, motifs: ['rings', 'arcs'], singleHue: false, theme: 'light' };
let STYLE = { name: 'custom', ...STYLE_DEFAULTS, ...STYLES.custom };
let LINE = STYLE.line;     // the stroke a rule, a hairline, or an outline takes unless its call names one
let MOTIFS = STYLE.motifs; // the deck's decoration set (STYLES above)
let MOTIF = MOTIFS[0];     // its primary device — the one an anchor takes when it names a kind itself
let MOTIF_AT = 0;
// The next device in the deck's set. `motif(s, '', …)` takes it, so two anchors in a row never carry the same
// drawing; naming a kind (`motif(s, MOTIF, …)`) still wins when the echo is the point (a closing answering its cover).
function nextMotif() { const kind = MOTIFS[MOTIF_AT % MOTIFS.length]; MOTIF_AT += 1; return kind; }
function deck({ style = 'custom', hue = 205, accentHue, accentSat, accentLight, mode = 'balanced', script = 'ko', pairing, fonts = 'noto', titleLines = 1, chrome, theme } = {}) {
  const preset = STYLES[style];
  if (!preset) throw new Error(`deck: unknown style "${style}" — one of ${Object.keys(STYLES).join(', ')}`);
  STYLE = { name: style, ...STYLE_DEFAULTS, ...preset };
  RADIUS = STYLE.radius;
  LINE = STYLE.line;
  MOTIFS = STYLE.motifs ?? [STYLE.motif];
  MOTIF = MOTIFS[0];
  MOTIF_AT = 0;
  // A single-hue style (swiss-minimal, brutalist, blueprint) keeps the accent on the seed; the rest take the counter hue.
  Object.assign(T, palette({ hue, accentHue: accentHue ?? (STYLE.singleHue ? hue : undefined), accentSat, accentLight }));
  if ((theme ?? STYLE.theme) === 'dark') darkTheme(hue);
  // The face pairing is the style's too (an editorial page sets its display in the serif, a masthead in the sans),
  // unless the brief names one here.
  typography({ script, pairing: pairing ?? STYLE.pairing ?? 'weight', fonts });
  MODE = mode;
  TYPE = typeScale(mode);
  // A style may carry its display scale apart from the body: the brutalist masthead and the swiss hero run larger
  // than an analyst page at the same reading mode, and that ratio is the style's, not a per-deck guess.
  if (STYLE.titleBoost && STYLE.titleBoost !== 1) for (const role of ['title', 'section', 'cover']) TYPE[role] = Math.round(TYPE[role] * STYLE.titleBoost);
  DIAG = { label: TYPE.caption + 1, note: Math.max(9.5, TYPE.caption - 1.5) };
  CHROME = chrome ?? STYLE.chrome;
  Z = zones(mode, { titleLines, chrome: CHROME });
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
// The field a page stands on, remembered as it is opened and again when a full-canvas surface is painted over it.
// A helper whose colours differ on paper and on a dark page reads this instead of defaulting to one of them: the
// poster kept its on-dark defaults on a light page and drew white type on white paper at 1.08:1.
const FIELD = new WeakMap();
const onField = (slide, kind) => (FIELD.set(slide, kind), slide);
const fieldOf = (slide) => FIELD.get(slide) || 'paper';
const light = () => (masters(), onField(pres.addSlide({ masterName: 'LIGHT' }), 'paper'));
const dark = () => (masters(), onField(pres.addSlide({ masterName: 'DARK' }), 'dark'));
const quiet = () => (masters(), onField(pres.addSlide({ masterName: 'QUIET' }), 'dark'));
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
// Place an SVG the script drew: the raster is what every reader sees, and the runtime attaches the SVG itself as the
// picture's vector source, so PowerPoint 2016 and later draw it sharp at any zoom (icon() does the same for the set).
// alt: what a reader who cannot see it is told — pptxgenjs otherwise stores the file name, which describes nothing.
async function vector(slide, svg, x, y, w, h, { alt, ...options } = {}) {
  slide.addImage({ data: await png(svg), ...box(x, y, w, h), ...options, ...(alt ? { altText: alt } : {}),
    objectName: 'mixdog-svg:' + encodeURIComponent(svg) });
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
async function icon(slide, x, y, d, name, { tint = T.paperAlt, color = T.accent, disc, stroke, alt } = {}) {
  const band = iconBand(d);
  d = typeof d === 'string' ? ICON_SIZE[d] : d;
  disc ??= band === 'disc' || band === 'hero';
  stroke ??= ICON_STROKE[band];
  if (disc) slide.addShape(S.ellipse, { ...box(x, y, d, d), fill: { color: tint }, line: { color: tint } });
  const inset = disc ? 0.25 : 0, px = Math.round(d * (1 - inset * 2) * PX);
  // A path starts with a move command and a number ("M12 2…"); a name that merely begins with m (moon, map-pin, mail)
  // is an icon of the set — read as a path it drew an empty picture and the unit's glyph vanished in every reader.
  const svg = /^[Mm]\s*-?[\d.]/.test(name)
    ? `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 24 24"><path d="${name}" fill="#${color}"/></svg>`
    : ICON.svg(name, { color, size: px, strokeWidth: stroke });
  // The raster is the fallback; the runtime attaches this SVG as the picture's vector source, so the icon stays sharp
  // at any zoom in PowerPoint 2016 and later (older readers and the preview draw the PNG).
  // alt names what the mark stands for (iconRow passes its label); without it a reader hears the file name.
  slide.addImage({ data: await png(svg), ...box(x + d * inset, y + d * inset, d * (1 - inset * 2), d * (1 - inset * 2)),
    altText: alt || (/^[Mm]/.test(name) ? 'icon' : `${name} icon`), objectName: 'mixdog-svg:' + encodeURIComponent(svg) });
}
// A row of icon-led items: icon in a disc, bold header, measured description — widths by weight.
// label / detail: role names (default strong / caption); a row that owns the body zone takes lead / body and a larger d.
// The foot guard every block helper shares (R104–R105): a block whose bottom edge would pass the body zone's bottom is
// refused with the shortfall and the fix named — the script stops, the file is not written — instead of being drawn
// over the source line for the review to miss (the review's edge and overlap windows start 0.4 in lower).
function footGuard(name, y, bottom, fix, limit = Z.body.bottom) {
  if (bottom > limit + 0.07) throw new Error(`${name}: the block from ${y.toFixed(2)} ends ${(bottom - limit).toFixed(2)} in past the foot (${limit.toFixed(2)}) — ${fix}`);
  return bottom;
}
async function iconRow(slide, x, y, w, items, { d = 0.6, gap = GUTTER, label: labelRole = 'strong', detail: detailRole = 'caption' } = {}) {
  const cols = spans(x, w, items.map((it) => weightOf({ label: it.label, detail: it.detail })), { gap });
  let bottom = y;
  for (let i = 0; i < items.length; i += 1) {
    const { label, detail, icon: name } = items[i], c = cols[i];
    await icon(slide, c.x, y, d, name, { alt: label });
    const lb = text(slide, label, c.x, y + d + GAP.within, c.w, labelRole, { bold: true });
    bottom = Math.max(bottom, detail ? text(slide, detail, c.x, lb + GAP.within, c.w, detailRole, { color: T.body, lh: 1.35 }) : lb);
  }
  return footGuard('iconRow', y, bottom, 'shorten a detail, drop an item, or start the row higher');
}
// Soft radial glow behind a hero element (dark-tech, cover motif): a native radial gradient on an ellipse.
// PowerPoint measures a path gradient to the far corner of the box, so a two-stop ramp leaves most of the disc at the
// first stop and the glow reads as a flat lit disc with an edge (rendered September 2026); the mid stop pulls the
// fall-off in so both PowerPoint and LibreOffice draw a soft halo.
async function glow(slide, cx, cy, r, color = T.accent, alpha = 0.35) {
  gradient(slide, cx - r, cy - r, r * 2, r * 2, [[0, color, alpha], [40, color, alpha * 0.35], [100, color, 0]], 0, { radial: { fx: 0.5, fy: 0.5 }, shape: S.ellipse });
}
// blend: the hex colour t of the way from a to b (0 = a, 1 = b) — a ramp's intermediate stop, a shaded form of a fill.
const blend = (a, b, t) => [0, 2, 4].map((i) => Math.round(parseInt(a.slice(i, i + 2), 16) * (1 - t) + parseInt(b.slice(i, i + 2), 16) * t).toString(16).padStart(2, '0')).join('').toUpperCase();
// Orb: the one hero object of a beat without a picture — the lit sphere the mock covers stand on the right third
// (measured September 2026: 13 of 26 rendered gallery pages carry one object there, 0.26-0.67 of the canvas; a motif
// at 0.25 alpha reads as background and a beat without an object measures 0). Drawn as a raster — an SVG radial
// gradient rendered by sharp at PX and placed as the PNG alone, no vector source attached: a native path gradient
// renders differently in PowerPoint and LibreOffice (PowerPoint centres the focus and compresses the ramp), and
// PowerPoint's own SVG renderer drew the radial gradient as a flat disc (both rendered September 2026); the object must
// be the same sphere in every reader, and a soft gradient loses nothing to the raster. The light form at the
// upper-left focus falls to the shade at the rim, over a soft halo in the same image; drawn before the type, beside
// it, never under it. d: a third of the page height at least (2.6 in), half on a cover (3.6-4.2 in). One per beat,
// the same object at half size on the closing (composition.md §3). Returns the sphere's box (the halo extends 0.4 d
// beyond it on each side).
async function orb(slide, cx, cy, d, { light: lit = T.accent, shade = T.dark, glowAlpha = 0.3 } = {}) {
  const span = d * 1.8, px = Math.round(span * PX), r = (d / 2 / span) * 100;
  const stop = (offset, color, opacity = 1) => `<stop offset="${offset}" stop-color="#${color}"${opacity < 1 ? ` stop-opacity="${opacity}"` : ''}/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 100 100"><defs>`
    + `<radialGradient id="halo" cx="50%" cy="50%" r="50%">${stop(0, lit, glowAlpha)}${stop(0.4, lit, glowAlpha * 0.35)}${stop(1, lit, 0)}</radialGradient>`
    + `<radialGradient id="body" cx="35%" cy="30%" r="72%">${stop(0, lit)}${stop(0.35, blend(lit, shade, 0.35))}${stop(0.7, blend(lit, shade, 0.85))}${stop(1, shade)}</radialGradient>`
    + `</defs><circle cx="50" cy="50" r="50" fill="url(#halo)"/><circle cx="50" cy="50" r="${r.toFixed(3)}" fill="url(#body)"/></svg>`;
  // Named as a device: the receipt reads a picture as evidence, and a cover with its sphere is a beat, not a picture page.
  slide.addImage({ data: await png(svg), ...box(cx - span / 2, cy - span / 2, span, span), altText: 'sphere', objectName: 'mixdog-device:orb' });
  return box(cx - d / 2, cy - d / 2, d, d);
}
// Motif: the deck's device drawn as a vector — rings (concentric circles), rays (diagonal bands), dots (a dot grid),
// arcs (quarter arcs nested on the box's bottom-right corner), waves (contour lines) — at full size on the cover, half
// on a section mark, a corner on the closing (direction.md §3; composition.md §3). One kind per deck, in the accent or
// the on-dark accent at low alpha; it sits behind the type (draw it first), never over it. Returns the placed box.
async function motif(slide, kind = '', x, y, w, h, { color = T.accent, alpha = 0.22, stroke = 3, count = 7 } = {}) {
  kind = kind || nextMotif();   // no kind named: the next device in the deck's set (STYLES above)
  // Rendered side by side (fifteen anchors, September 2026): rings, arcs, and waves read at a 3 px stroke; rays and
  // dots vanish at contact-sheet scale under 4 px, so those two draw heavier.
  const pw = Math.round(w * PX), ph = Math.round(h * PX), sw = (kind === 'rays' || kind === 'dots' ? stroke * 1.6 : stroke) * PX / 96;
  const paint = `stroke="#${color}" stroke-opacity="${alpha}" fill="none" stroke-width="${sw}"`;
  let body = '';
  if (kind === 'rings') for (let i = 1; i <= count; i += 1) body += `<circle cx="${pw / 2}" cy="${ph / 2}" r="${Math.min(pw, ph) / 2 * i / count - sw}" ${paint}/>`;
  else if (kind === 'rays') for (let i = 0; i <= count; i += 1) { const t = (i / count) * (pw + ph); body += `<line x1="${t}" y1="0" x2="${t - ph}" y2="${ph}" ${paint}/>`; }
  else if (kind === 'dots') { const step = Math.max(pw, ph) / (count * 2); for (let gy = step / 2; gy < ph; gy += step) for (let gx = step / 2; gx < pw; gx += step) body += `<circle cx="${gx}" cy="${gy}" r="${sw * 1.5}" fill="#${color}" fill-opacity="${alpha}"/>`; }
  else if (kind === 'arcs') for (let i = 1; i <= count; i += 1) { const r = Math.max(pw, ph) * i / count; body += `<path d="M ${pw} ${ph - r} A ${r} ${r} 0 0 0 ${pw - r} ${ph}" ${paint}/>`; }
  else if (kind === 'waves') for (let i = 0; i <= count; i += 1) { const yy = ph * i / count, a = ph / (count * 2); body += `<path d="M 0 ${yy} C ${pw / 4} ${yy - a}, ${pw * 3 / 4} ${yy + a}, ${pw} ${yy}" ${paint}/>`; }
  else throw new Error(`motif: unknown kind "${kind}" — one of rings, rays, dots, arcs, waves`);
  await vector(slide, `<svg xmlns="http://www.w3.org/2000/svg" width="${pw}" height="${ph}" viewBox="0 0 ${pw} ${ph}">${body}</svg>`, x, y, w, h, { alt: `${kind} motif` });
  return box(x, y, w, h);
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
// runsWith: the wrapped string as runs with one phrase in its own options — the contrast phrase of a headline (11 of
// the 26 measured mock pages set a second phrase of the title in the serif italic or the accent: "Intelligence, / at
// the edge.", a coloured noun in the Korean and Chinese ones; a16z colours the load-bearing noun). The phrase is found
// after wrapping, a break inside it counting as its space, so the run survives the eojeol wrap.
function runsWith(str, phrase, options = {}) {
  const s = String(str), p = String(phrase || '').trim();
  if (!p) return runsOf(s);
  const re = new RegExp(p.split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[ \\n]+'));
  const m = re.exec(s);
  if (!m) return runsOf(s);
  const runs = [];
  for (const [text, o] of [[s.slice(0, m.index), {}], [m[0], options], [s.slice(m.index + m[0].length), {}]]) {
    if (!text) continue;
    text.split('\n').forEach((line, i) => { if (i || line) runs.push({ text: line, options: { ...o, ...(i ? { softBreakBefore: true } : {}) } }); });
  }
  return runs;
}
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
function text(slide, str, x, y, w, size, { color, font, bold, align = 'left', valign = 'top', lh, h, size: sizeOverride, objectName } = {}) {
  if (typeof size === 'string') { const r = role(size); size = sizeOverride ?? r.size; color ??= r.color; font ??= r.font; bold ??= r.bold; lh ??= h ? 1 : r.lh; }
  color ??= T.body; font ??= T.light; bold ??= false;
  lh ??= h ? 1 : (size >= TYPE.lead ? 1.2 : 1.35);
  const face = bold && font === T.light ? T.sans : font;
  const wrapped = wrapKo(str, w, size, face, bold);
  const height = h ?? fitH(wrapped, w, size, face, { bold, lh });
  slide.addText(runsOf(wrapped), { ...box(x, y, w, height), fontFace: face, fontSize: size, bold, color, align, valign, margin: 0, lineSpacingMultiple: lh, ...(objectName ? { objectName } : {}) });
  return y + height;
}
// Title: display face, bold; the size steps down the scale (to 24) when the text would need more than maxLines. Returns the bottom edge.
// emph: one phrase of the title in the accent (composition.md §8 — a claim page's title, not every title).
function title(slide, str, { x = M, y = 1.0, w = W - 2 * M, size = TYPE.title, color = T.ink, align = 'left', maxLines = 2, lh = 1.15, emph = '', emphColor = T.accent } = {}) {
  const wrapped = (at) => wrapKo(str, w, at, T.display, true);
  const steps = [size, ...scaleSteps().filter((v) => v < size && v >= 24)];
  const s = steps.find((at) => MEASURE(wrapped(at), { font: T.display, size: at, bold: true, width: w, lineHeight: lh }).lines <= maxLines) ?? steps[steps.length - 1];
  const out = wrapped(s), h = Math.max(0.6, fitH(out, w, s, T.display, { bold: true, lh }));
  slide.addText(emph ? runsWith(out, emph, { color: emphColor }) : runsOf(out), { ...box(x, y, w, h), fontFace: T.display, fontSize: s, bold: true, color, align, margin: 0, valign: 'top', lineSpacingMultiple: lh });
  return y + h;
}
// Kicker: a real section or topic name above a title. Latin gets tracking (charSpacing); Hangul never does.
function kicker(slide, str, x = M, y = 0.6, color = T.accent, w = 6, align = 'left') {
  const latin = !/[\u1100-\u11FF\u3130-\u318F\uAC00-\uD7AF\u3040-\u30FF\u4E00-\u9FFF]/.test(str);
  slide.addText(latin ? str.toUpperCase() : str, { ...box(x, y, w, 0.3), fontFace: latin ? T.data : T.sans, fontSize: TYPE.kicker, bold: true, color, align,
    ...(latin ? { charSpacing: 4 } : {}), margin: 0 });
}
// Paragraphs of inline runs: [[['plain ', {}], ['42%', { bold: true, color: T.accent }], [' of users', {}]], [...next paragraph]].
// The body sits in the light face; an emphasized run switches to the sans or bold so weight carries the emphasis.
// `{ mark: true }` on a run sets it on the accent fill as a marker highlight (a16z's chapter claims, Coatue's key
// phrases): the load-bearing phrase of a claim, once per page, never a whole sentence.
// PowerPoint lets a mixed-weight Korean line overshoot its box by 2-4 pt; the box carries a 7 pt right inset so the text zone stays w.
function emphasis(slide, paragraphs, x, y, w, h, size = TYPE.lead, color = T.body, { lh = 1.35, font = T.light } = {}) {
  const inset = 7;
  const runs = [];
  paragraphs.forEach((para, pi) => para.forEach(([str, { mark, ...o }], ri) => runs.push({ text: str, options: {
    ...(o.bold || o.color || mark ? { fontFace: T.sans } : {}),
    ...(mark ? { highlight: T.accentFill, color: T.ink, bold: true } : {}),
    ...o,
    ...(ri === 0 && pi < paragraphs.length - 1 ? { paraSpaceAfter: size * 0.8 } : {}),   // the step between paragraphs, never trailing space
    ...(ri === para.length - 1 && pi < paragraphs.length - 1 ? { breakLine: true } : {}),
  } })));
  slide.addText(wrapRuns(runs, w, size, font), { ...box(x, y, w + inset / 72, h), fontFace: font, fontSize: size, color, margin: [0, inset, 0, 0], valign: 'top', lineSpacingMultiple: lh });
}
// Hero numeral with its label bound under it (GAP.bind). scale: 'hero' (default) | 'poster' | 'band' (one of several peers,
// statBand()) — the size is the scale's (TYPE.hero / TYPE.poster / TYPE.stat through SPEC.stat); size overrides with a TYPE.* value only.
// minH: the numeral box's floor (1.12 in — the hero and band rows the reference pages measure); a card (cards()) passes
// a smaller one so the figure sits close under its opener.
function hero(slide, x, y, w, value, label, { scale = 'hero', size, color, unit = '', labelColor, labelSize, minH = 1.12 } = {}) {
  const sp = spec('stat');
  size ??= sp.size[scale] ?? sp.size.hero; color ??= sp.color; labelColor ??= sp.label.color; labelSize ??= sp.label.size;
  // A figure never wraps: "47,210" broken after "47,21" stops being a number, and the extra line grows out of the
  // bottom-anchored box across whatever sits above it. Step the numeral down its scale until the whole run fits w.
  const runWidth = (at) => textW(String(value), at, T.data, true) + (unit ? textW(unit, Math.round(at * sp.unit), T.data, true) : 0);
  const steps = [size, ...scaleSteps().filter((v) => v < size && v >= TYPE.body)];
  size = steps.find((at) => runWidth(at) <= w) ?? steps[steps.length - 1];
  const runs = [{ text: value, options: { fontSize: size } }];
  if (unit) runs.push({ text: unit, options: { fontSize: Math.round(size * sp.unit) } });
  const h = Math.max(minH, fitH(String(value) + unit, w, size, T.data, { bold: true }) - 0.02), bind = GAP.bind;
  slide.addText(runs, { ...box(x, y, w, h), fontFace: T.data, bold: true, color, margin: 0, valign: 'bottom', objectName: specName('stat', scale) });
  if (!label) return y + h;
  const l = wrapKo(label, w, labelSize, T.sans), lh = fitH(l, w, labelSize);
  slide.addText(runsOf(l), { ...box(x, y + h + bind, w, lh), fontFace: T.sans, fontSize: labelSize, color: labelColor, margin: 0, valign: 'top' });
  return y + h + bind + lh;
}
// A genuine list: one text box, bullets on each item, a paragraph step visibly larger than the line step.
function bullets(slide, x, y, w, h, items, size = TYPE.body, color = T.body, { lh = 1.35, font = T.light } = {}) {
  // The list steps down the scale but never under the runtime's 12 pt body floor: a caption-size step (10-11 pt) is
  // one-line chrome, not a list.
  const s = fitSize(items.join('\n'), w - 0.3, h - items.length * size * 0.6 / 72, size, font, { lh, min: Math.max(12, TYPE.caption) });
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
// Reading rail: the commentary beside a carrier the way a16z, Coatue, and LG's IR pages fill the column next to a
// chart — two to four short readings, each a label in the data face over a paragraph at body size, a subtle rule
// between them. blocks: [{ label, text }] (a string is a paragraph with no label). The rail is the page's second
// column, not a caption: it runs from the body top toward `bottom` and carries 150-300 characters in balanced or
// text mode (a 4.4 in rail measures about 240 / 290 in one labelled reading, 180 / 220 in two; presentation mode's
// 20 pt body holds 90-110 in the same rail — widen the rail or let the carrier's labels carry the rest), which is what
// lifts a body page from one sentence beside its chart to the 330+ characters the reference pages carry
// (composition.md §8). Returns the bottom edge.
// readingH: the height reading() takes for these blocks at these options — measured before the page is shared out
// (shareDown) or a reading is registered to the row it reads (a dumbbell row, a lane: y = rowTop + (rowH − h) / 2 puts
// the reading's middle on the row's axis, where a top-aligned block sat a few points off it and read as drift).
function readingH(w, blocks, { gap = GAP.between, size = TYPE.body, lh = 1.4 } = {}) {
  return blocks.reduce((h, b, i) => {
    const { label = '', text: str = '' } = typeof b === 'string' ? { text: b } : b;
    return h + (i ? gap : 0) + (label ? lineH(TYPE.kicker, T.data, 1.1) + 0.06 + GAP.within : 0) + fitH(wrapKo(str, w, size, T.light), w, size, T.light, { lh });
  }, 0);
}
function reading(slide, x, y, w, blocks, { bottom = Z.body.bottom, gap = GAP.between, size = TYPE.body, lh = 1.4 } = {}) {
  let cy = y;
  blocks.forEach((b, i) => {
    const { label = '', text: str = '' } = typeof b === 'string' ? { text: b } : b;
    if (i) hairline(slide, x, cy - gap / 2, w, T.lineSubtle);
    if (label) { text(slide, label, x, cy, w, TYPE.kicker, { color: T.accent, font: T.data, bold: true, lh: 1.1 }); cy += lineH(TYPE.kicker, T.data, 1.1) + 0.06 + GAP.within; }   // the label's box (fitH's allowance) plus a within step: under 6 pt reads as a collision
    // One size for every reading on the page: a column that steps down on its own beside one that does not reads as
    // two decks. Content over the column is cut or moved, never squeezed or run into the foot (composition.md §4).
    const s = size;
    const wrapped = wrapKo(str, w, s, T.light), h = fitH(wrapped, w, s, T.light, { lh });
    if (cy + h > bottom + 0.07) throw new Error(`reading: block ${i + 1} ("${String(label || str).slice(0, 24)}") in the column at (${x.toFixed(2)}, ${y.toFixed(2)}) w ${w.toFixed(2)} needs ${(cy + h - bottom).toFixed(2)} in more than it holds at ${s} pt — cut a reading, shorten it, or widen the column`);   // 0.06 is fitH's box allowance, not text
    slide.addText(runsOf(wrapped), { ...box(x, cy, w, h), fontFace: T.light, fontSize: s, color: T.body, valign: 'top', margin: 0, lineSpacingMultiple: lh });
    cy += h + gap;
  });
  return cy - gap;
}
// Takeaway band: one sentence closing a page that has a claim to close; sits near the lower safe margin. The band is
// the deck's dark field with the sentence in the on-dark face, bold — the one saturated object on an evidence page after
// the accent, so the conclusion has the presence of the chart it closes (a light tint read as a footnote).
function takeaway(slide, str, y = Z.foot.takeaway, { x = Z.body.x, w = Z.body.w, h = 0.7, tint = T.dark, color = T.onDark, bold = true } = {}) {
  const c = inner({ x, w }), size = fitSize(str, c.w, h - 0.2, TYPE.lead, T.sans, { bold, min: TYPE.caption });
  slide.addShape(S.rect, { ...box(x, y, w, h), fill: { color: tint }, line: { color: tint } });
  slide.addText(runsOf(wrapKo(str, c.w, size, T.sans, bold)), { ...box(c.x, y, c.w, h), fontFace: T.sans, fontSize: size, bold, color, margin: 0, valign: 'middle' });
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
  // The bottom edge of the last row, not the gap after it: the next block registers a between step under the
  // specimen itself (a trailing gap read as 0.45 in of content and left an empty band over the foot — R100).
  return footGuard('specimen', y, rows.length ? cy - gap : cy, 'drop a row or start the specimen higher');
}
// Ghost numeral: a chapter mark behind content. Keep the box inside the canvas (w ≤ W - x).
function ghost(slide, str, x, y, size = 240, w = 5.5, { color = T.onAccent, transparency = 88 } = {}) {
  slide.addText(str, { ...box(x, y, w, lineH(size, T.data) + 0.05), fontFace: T.data, fontSize: size, bold: true, color, transparency, margin: 0, valign: 'top' });
}
// Typographic poster: the anchor a deck without pictures has — one phrase set at poster scale on the dark or accent
// field (Sequoia's section pages, Naver's green cover, the a16z chapter openers), a kicker above it, one line under it.
// The phrase is content (the section's claim, what the number means), never a label; it steps down the scale until it
// fits w in at most `maxLines` lines. The colours follow the field the page stands on — the on-dark pair on dark() /
// quiet() or under a painted full-canvas field, T.ink on paper — so a poster is never white type on white paper.
// Returns the bottom edge.
// emph: one phrase of the poster in the accent (emphColor) — the contrast phrase of the mock headlines (runsWith).
function poster(slide, str, { x = M, y = 1.6, w = W - 2 * M, size = TYPE.poster, maxLines = 3, color, kicker: k = '', kickerColor, line = '', lineColor, lineSize = TYPE.lead, lineLh = 1.3, font = T.display, lh = 1.05, emph = '', emphColor } = {}) {
  // The colours follow the field the page stands on (the master it was opened with, or a full-canvas surface painted
  // over it); a colour named in the call still wins.
  const paper = fieldOf(slide) === 'paper';
  color ??= paper ? T.ink : T.onDark;
  kickerColor ??= paper ? T.accent : T.onDarkAccent;
  lineColor ??= paper ? T.body : T.onDarkMuted;
  emphColor ??= paper ? T.accent : T.onDarkAccent;
  if (k) kicker(slide, k, x, y - 0.3 - GAP.within, kickerColor, Math.min(w, 8));
  const wrapped = (at) => wrapKo(str, w, at, font, true);
  const steps = [size, ...scaleSteps().filter((v) => v < size && v >= TYPE.title)];
  // Three fits at once: the line count, a measure of at least eight ems (a narrower box carries one or two words a
  // line — the audit's text_box_too_narrow), and room under the phrase for its line above the lower margin.
  const room = H - M - y - (line ? lineH(lineSize, T.light, lineLh) * 2 + GAP.between : 0);
  const fits = (at) => w * 72 / at >= 8 && MEASURE(wrapped(at), { font, size: at, bold: true, width: w, lineHeight: lh }).lines <= maxLines && fitH(wrapped(at), w, at, font, { bold: true, lh }) <= room;
  const s = steps.find(fits) ?? steps[steps.length - 1];
  const out = wrapped(s), h = fitH(out, w, s, font, { bold: true, lh });
  slide.addText(emph ? runsWith(out, emph, { color: emphColor }) : runsOf(out), { ...box(x, y, w, h), fontFace: font, fontSize: s, bold: true, color, margin: 0, valign: 'top', lineSpacingMultiple: lh });
  return line ? text(slide, line, x, y + h + GAP.between, Math.min(w, 8), lineSize, { color: lineColor, font: T.light, lh: lineLh }) : y + h;
}
// Display headline on paper: the editorial hero page. Measured September 2026 across 26 rendered mock pages of a
// styles gallery (Linear, Stripe, Apple, NYT, Anthropic idioms): the headline runs 58-78 px of a 720 px page — 43-58 pt
// on this canvas, 4-5 × the body — on two lines over 45-60% of the width, a deck paragraph at 15-17 px under it, then a
// strip of three or four numerals at 32-58 px or one hero object on the right third, and meta in the four corners. The
// text pages that read as frontier measure 0.02-0.09 largest object, the same as ours: the scale, the strip, and the
// corners are what separate them, not a card. poster() with the paper defaults: TYPE.cover, T.ink, the deck line at
// body size (the mock deck paragraph is 1 × the body, two or three lines — a lead-size deck under a cover-size title
// pushed the strip off the page in presentation mode) in the body colour, the measure 60% of the canvas. The
// headline takes a quarter of the page at two lines, so what follows is measured from the returned bottom: a
// `statBand()` at the band scale, a `ruledList()`, or `columns()`, never a second paragraph. Returns the bottom edge.
function display(slide, str, { x = M, y = Z.head.display, w = (W - 2 * M) * 0.6, size = TYPE.cover, maxLines = 2, color = T.ink, kicker: k = '', kickerColor = T.accent, line = '', lineColor = T.body, lineSize = TYPE.body, lineLh = 1.35, font = T.display, lh = 1.1, emph = '', emphColor = T.accent } = {}) {
  return poster(slide, str, { x, y, w, size, maxLines, color, kicker: k, kickerColor, line, lineColor, lineSize, lineLh, font, lh, emph, emphColor });
}
// Dateline: the running meta at the top-right corner (a date, a document number, the section) in the data face at
// kicker size, muted — the fourth corner of the frame the mock pages close (a mark top-left, meta top-right, the
// source bottom-left, the page number bottom-right: their ink box spans 0.8-1.0 of the canvas against 0.68-0.8 on our
// text pages). One per page at most, only when the page has a real date or number to carry; the 'bands' chrome
// already puts the kicker in that corner. A date reads as chrome to the facts gate (2026.09, 2026-09-12, 2026년 9월);
// a document number that looks like a figure ("No. 0073") needs its fact like any other.
function dateline(slide, str, { y = Z.head.kicker, w = 3.6, color = T.muted } = {}) {
  if (Z.chrome === 'bands') throw new Error('dateline: the bands chrome carries the kicker at the top-right — pass the meta to source() instead');
  kicker(slide, str, W - M - w, y, color, w, 'right');
}
// Section numeral: the a16z chapter opener — the section's number at 200 pt or more in the on-dark accent, the
// section's claim beside it at section scale, one line under. The numeral says where the deck is; the claim carries
// the content, so the page is never a numeral alone. On dark() / quiet() with the defaults; on paper pass
// color: T.accent, claimColor: T.ink, lineColor: T.body. Returns the bottom edge.
function numeralBeat(slide, value, claim, { x = M, y = 1.4, w = W - 2 * M, size = 220, color, claimColor, line = '', lineColor } = {}) {
  // The beat is usually a dark field, but it is not only that: on paper the dark-field colours draw a white numeral on
  // a white page (measured 1.1:1 — invisible, and reported as low_contrast). The colours follow the field the page
  // stands on, as poster() does; a colour named in the call still wins.
  const paper = fieldOf(slide) === 'paper';
  color ??= paper ? T.accent : T.onDarkAccent;
  claimColor ??= paper ? T.ink : T.onDark;
  lineColor ??= paper ? T.body : T.onDarkMuted;
  // The numeral's box is measured, never lineH: at 200 pt PowerPoint's own line box for the data face runs past 1.2 em.
  const nw = textW(String(value), size, T.data, true) * 1.1 + 0.3, nh = fitH(String(value), nw, size, T.data, { bold: true, lh: 1.1 });   // PowerPoint's own bound of a 200 pt run outgrows the measured width by a few percent
  slide.addText(String(value), { ...box(x, y, nw, nh), fontFace: T.data, fontSize: size, bold: true, color, margin: 0, valign: 'top', lineSpacingMultiple: 1.1 });
  const cx = x + nw + GAP.between, cw = w - nw - GAP.between;
  // The claim's size steps down the scale until the column beside the numeral is eight ems wide (presentation mode's
  // 44 pt section size beside a 220 pt numeral leaves a measure of one or two words a line).
  const claimSize = [TYPE.section, ...scaleSteps().filter((v) => v < TYPE.section && v >= TYPE.lead)].find((at) => cw * 72 / at >= 8) ?? TYPE.lead;
  const b = text(slide, claim, cx, y + nh * 0.22, cw, claimSize, { color: claimColor, font: T.display, bold: true, lh: 1.15 });
  return line ? text(slide, line, cx, b + GAP.within, cw, TYPE.lead, { color: lineColor, font: T.light, lh: 1.3 }) : Math.max(b, y + nh);
}
```

## 4. Zones and layout by weight (composition.md §6)
```js
// Optional header/body scaffold for related pages, not a compulsory layout for every content slide.
// Use shared zones when the pages share a structure; compose a dominant figure or relationship directly
// with the primitives when it needs a different title position or content field.
// titleLines: the deck's longest content title in lines (the brief decides; default 1). A two-line band under
// one-line titles leaves 0.7 in of dead air above every kicker — reserve two lines only when a title needs them.
// chrome 'bands': the dark head band runs from the page top to Z.head.band (T.dark; head() draws it) and the foot is
// the source line above Z.foot.band with no field under it; the body lives between. 'bare' (the default): the title
// sits on the open canvas with room for a kicker above it. Z.rail / Z.main: the asymmetric grid frontier analyst decks hang on — a
// 2.2 in rail at the left for the legend, the kicker, a hero figure, and the main column for the carrier; head()
// with x: Z.main.x, w: Z.main.w puts the title on the same column.
function zones(mode = MODE, { titleLines = 1, chrome = CHROME } = {}) {
  const bands = chrome === 'bands', masthead = chrome === 'masthead', plane = chrome === 'plane';
  // A band or a masthead needs no kicker room above the title (its own field, or the page edge, is the margin); on the
  // open canvas the kicker sits at the margin and the title starts a kicker line under it — the reference title tops
  // sit 5-17% down the page.
  const headTop = bands || masthead ? M - 0.15 : M + 0.3 + GAP.within - 0.15;
  const headBottom = headTop + lineH(TYPE.title, T.display, 1.15) * titleLines + 0.06;   // the title's bottom edge (+ fitH's allowance)
  const headBand = headBottom + PAD;
  const footBand = H - 0.78 - GAP.within;
  const rail = 2.2, planeW = 4.4;
  // The column the body owns under this chrome: the safe width on the open canvas, the main column beside an editorial
  // rail, and the page beside the plane when the chrome carries the title on one. head() and the carriers register to
  // it, so choosing a style moves the whole page instead of only its title.
  const column = chrome === 'rail'
    ? { x: M + rail + GUTTER, w: W - 2 * M - rail - GUTTER }
    : plane
      ? { x: planeW + GUTTER, w: W - M - planeW - GUTTER }
      : { x: M, w: W - 2 * M };
  return {
    chrome,
    // display: where a display() headline's first line starts on the open canvas (a kicker line under the head top) —
    // the rail beside an editorial hero registers its first label there, never at `Z.head.top + 0.3` typed by hand.
    head: { kicker: M, top: headTop, display: headTop + 0.3, bottom: headBottom, band: headBand },
    // The body ends a between step above the source line in either chrome, so a carrier drawn to Z.body.bottom never
    // touches the source (the runtime reads under 6 pt between text boxes as a collision). x and w are the column the
    // chrome left for it — beside a plane the carrier starts past the plane's edge, never under it.
    body: { top: (bands ? headBand : plane ? headTop : headBottom) + GAP.between, bottom: bands ? footBand - GAP.within : H - 0.78 - GAP.between, x: column.x, w: column.w },
    // The foot holds two things and they stack: the source line sits last, and
    // the takeaway band ends a within step above it. Defaults that overlapped
    // put the band over the source on any page that carried both, and a hair
    // gap there reads as a collision to the spacing check (under 6 pt).
    foot: { takeaway: (bands ? footBand : H - 0.78) - 0.7 - GAP.within, source: H - 0.78, band: footBand },
    seam: splitAt(M, W - 2 * M, 7, 3),                        // the deck seam (GUTTER wide); re-assign once from the brief (e.g. 3:7) and reuse
    rail: { x: M, w: rail },
    main: { x: M + rail + GUTTER, w: W - 2 * M - rail - GUTTER },
    plane: { x: 0, y: 0, w: planeW, h: H },                   // the full-height plane the 'plane' chrome carries its head on
  };
}
let Z = zones(MODE);
// avail: the height left under `top` before the foot — measured first, then the blocks are chosen to fit it
// (composition.md §4): the count of readings, the rows of a table, the height a stage or a chart takes are all
// `avail(top)` shared out, never a guess the runtime later reports as an overflow or a hollow band.
const avail = (top, { bottom = Z.body.bottom } = {}) => Math.max(0, bottom - top);
// head: the assertion title, with an optional sub line (the qualification or the reading of the title, lead size, light)
// under it. 'bare' (the default) bottom-aligns the title on Z.head.bottom and hangs the kicker a within step above it —
// the reference pages put the kicker there as a small coloured label or pill (Kakao's yellow pill, NVIDIA's green sub
// line). With chrome 'bands' the dark band is drawn first, the title sits at Z.head.top in onDark across the whole
// column (one line at title size is the norm; a second line extends the band), and the kicker — a real section name —
// sits at the band's right in onDarkAccent, the way Samsung's IR band carries its running mark. Returns the body top:
// the first body element sits exactly there (flow(s, x, top, …)), never at top + a hand offset.
// w: the column the title shares with the body under it — pass the same w to both so their right edges register.
function head(slide, kickerText, titleText, { size = TYPE.title, color, kickerColor, w = Z.body.w, x = Z.body.x, sub = '', emph = '', emphColor } = {}) {
  const bands = Z.chrome === 'bands', plane = Z.chrome === 'plane', masthead = Z.chrome === 'masthead', rail = Z.chrome === 'rail';
  const onField = bands || plane;   // the head sits on the deck's dark field, so its type is the on-dark pair
  color ??= onField ? T.onDark : T.ink;
  kickerColor ??= onField ? T.onDarkAccent : T.accent;
  emphColor ??= kickerColor;
  // The plane carries the title in its own narrow column, so the title is measured against the plane, not the body.
  // A masthead carries its kicker at the right of the title's own line, so the title measures against what is left
  // beside it — a full-width box would sit under the kicker and the two read as one block.
  // A head that hangs its kicker at the right edge (a band, a masthead) shortens the title box by that much: a
  // full-width title box runs under the kicker, and the two read as one line crossing itself.
  const tx = plane ? M : x, tw = plane ? Z.plane.w - 2 * M : (masthead || bands) && kickerText ? w - 3.6 : w;
  const lh = 1.15, t = wrapKo(titleText, tw, size, T.display, true), th = fitH(t, tw, size, T.display, { bold: true, lh });
  // The sub line reads at body size: the reference subs (NVIDIA's green line, Kakao's, the bento subtitle) sit at or
  // under the body, and a lead-size sub pushed the body top to 28-36% of the page against their 11-20%.
  const s = sub ? wrapKo(sub, tw, TYPE.body, T.light) : '', sh = sub ? fitH(s, tw, TYPE.body, T.light, { lh: 1.25 }) : 0;
  // Where the title sits: at the band's top, flush to the page edge on a masthead, a kicker line down the plane, and
  // bottom-aligned on the head zone on the open canvas.
  const top = bands || masthead ? Z.head.top : plane ? M + 0.95 : Z.head.bottom - th;
  if (!plane && top < Z.head.top - 0.01) throw new Error(`head: title needs ${(Z.head.top - top).toFixed(2)} in more than the head band — shorten it or break it in two lines`);
  const bottom = top + th + (sub ? GAP.within + sh : 0);
  const bandBottom = Math.max(Z.head.band, bottom + PAD);
  if (bands) field(slide, 0, 0, W, bandBottom, T.dark);
  if (plane) field(slide, Z.plane.x, Z.plane.y, Z.plane.w, Z.plane.h, T.dark);
  slide.addText(emph ? runsWith(t, emph, { color: emphColor }) : runsOf(t), { ...box(tx, top, tw, th), fontFace: T.display, fontSize: size, bold: true, color, margin: 0, valign: bands || plane || masthead ? 'top' : 'bottom', lineSpacingMultiple: lh });
  if (sub) slide.addText(runsOf(s), { ...box(tx, top + th + GAP.within, tw, sh), fontFace: T.light, fontSize: TYPE.body, color: onField ? T.onDarkMuted : T.body, margin: 0, valign: 'top', lineSpacingMultiple: 1.25 });
  if (kickerText) {
    if (bands || masthead) kicker(slide, kickerText, W - M - 3.2, top + 0.04, kickerColor, 3.2, 'right');
    else if (rail) kicker(slide, kickerText, Z.rail.x, top + 0.04, kickerColor, Z.rail.w);   // the editorial rail carries the running mark beside the title
    // The kicker's box never leaves the column its title owns: a default-width one on a plane ran past the plane's
    // edge onto the paper, where its on-dark colour read at 2.2:1 and it collided with the first block beside it.
    else kicker(slide, kickerText, tx, top - 0.3 - GAP.within, kickerColor, Math.min(tw, 6));
  }
  // A masthead closes its head with one heavy full-bleed bar in the style's stroke; the body starts under the bar.
  let barBottom = bottom;
  if (masthead) {
    const barH = Math.max(0.05, (LINE * 2) / 72);
    field(slide, 0, bottom + GAP.within, W, barH, T.ink);
    barBottom = bottom + GAP.within + barH;
  }
  // 'bare' with a sub line: the sub hangs under the bottom-aligned title, so the body starts a pad under the sub (the
  // NVIDIA and Kakao pages open their carrier about 0.3 in under the sub line), not at the zone. On a plane the title
  // never pushes the body down: the carrier beside it starts at the body top whatever the title's length.
  return bands ? bandBottom + GAP.between : masthead ? barBottom + GAP.between : plane ? Z.body.top : Math.max(Z.body.top, bottom + PAD);
}
// foot: the foot of a page carries the source line and the page number on the open canvas — no field under them in
// either chrome (no reference deck tints its foot). Kept as the one place a page registers its foot, so source() and a
// full-bleed carrier still call it.
let FOOTED = new WeakSet();
function foot(slide) {
  if (FOOTED.has(slide)) return;
  FOOTED.add(slide);
}
// source: the running source line on the foot; never moves. It stops short of the page number.
// The foot follows the chrome's column too: on a plane the source line starts beside the plane, not on it.
function source(slide, str, { color = T.muted, w = Z.body.w - 0.9 } = {}) { foot(slide); text(slide, str, Z.body.x, Z.foot.source, w, TYPE.caption, { color, font: T.data, lh: 1.1 }); }

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
// The axis a run of peers hangs on: mid(c) is one column's centre, band(cols, from, to) the region a bracket, a
// band, a rule, or an arrow spans across them. **A mark that belongs to a run takes its position from these** —
// spans() widths are weighted, so the centre of a run is never W / 2 and a hand-typed coordinate lands a few points
// off the axis its neighbours share (the runtime reports it as `axis_drift`).
const mid = (c) => c.x + c.w / 2;
const band = (cols, from = 0, to = cols.length - 1) => ({ x: cols[from].x, w: cols[to].x + cols[to].w - cols[from].x });
// splitAt: the seam of a two-plane slide from each side's weight; never the middle unless the weights are equal.
// Returns { left: { x, w }, right: { x, w } } — two named planes, not the array spans() returns for a row of peers.
function splitAt(x, w, leftWeight, rightWeight, { gap = GUTTER, min = 0.38, max = 0.62 } = {}) {
  const share = Math.min(max, Math.max(min, leftWeight / ((leftWeight + rightWeight) || 1)));
  const lw = (w - gap) * share;
  return { left: { x, w: lw }, right: { x: x + lw + gap, w: w - gap - lw } };
}
// shareDown: the vertical seam of a page that stacks a structure on a stage over a reading row (columns, a ruled
// list) — the row is measured first (columnsH, readingH) and the stage takes what is left between the
// body top and the foot, never a guessed 2.2 in that the render then reports as a hollow field or an overflow.
// Returns { stage: { y, h }, under: { y, h }, slack }: the stage's box, the row's box a between step under it, and
// the slack a maxStage cap left (0 without a cap). A structure with a natural height (a timeline, a step run at
// blockH) centres in a taller stage with its `h` option; lanes and steps spend the whole h. minStage is the floor
// under which the structure stops reading as the carrier (composition.md §6: a quarter of the canvas) — cut the
// row or move it to a rail instead of shrinking the stage.
function shareDown(top, underH, { bottom = Z.body.bottom, gap = GAP.between, minStage = 2.2, maxStage = Infinity } = {}) {
  const free = bottom - top - gap - underH;
  if (free < minStage - 0.01) throw new Error(`shareDown: the stage under ${top.toFixed(2)} gets ${free.toFixed(2)} in (floor ${minStage}) because the row under it measures ${underH.toFixed(2)} — shorten the row's copy, drop a column, or move it to a rail`);
  const h = Math.min(free, maxStage);
  return { stage: { y: top, h }, under: { y: top + h + gap, h: underH }, slack: free - h };
}
// Stat band: several numbers with one cause on one baseline (composition.md §4) — value (+ unit) over label over detail
// per peer, widths by weight, one rule under the band. stats: [{ value, unit?, label, detail?, weight? }]. Returns the
// bottom edge (under the rule). Anatomy from SPEC.stat at the band scale; scale: 'hero' for two or three large peers.
// The label is one line (the mock KPI strips run 9-11 px labels of two to four words under 32-58 px numerals): a label
// that wraps in its column reads as body text at caption size and the review reports small_font — move the rest to
// detail, or shorten it. Under a display() headline the band takes the headline's measure, not the full width.
function statBand(slide, x, y, w, stats, { scale = 'band', gap = GUTTER, ruled = true, bottom: limit = Z.body.bottom } = {}) {
  const sp = spec('stat'), cols = spans(x, w, stats.map((st) => weightOf(st)), { gap });
  let bottom = y;
  stats.forEach((st, i) => {
    const b = hero(slide, cols[i].x, y, cols[i].w, st.value, st.label, { scale, unit: st.unit || '' });
    bottom = Math.max(bottom, st.detail ? text(slide, st.detail, cols[i].x, b + GAP.within, cols[i].w, sp.detail.role, { color: sp.detail.color }) : b);
  });
  // A band under a display() headline in presentation mode (hero 72 pt) reached the foot: its labels sat on the
  // source line and the review reported edge_margin. Past the foot the script stops here with the fix named — the
  // file is not written, so nothing drawn above ships.
  footGuard('statBand', y, bottom, `at the ${scale} scale: drop the scale to 'band', cut a peer's detail, or start it higher (a shorter headline)`, limit);
  if (!ruled) return bottom;
  hairline(slide, x, bottom + GAP.between, w);
  return bottom + GAP.between;
}
// Cards: the KPI / bento row — several numbers that each own a frame (a dashboard, a product's key figures; the mock
// KPI cards, apple-bento-grid's stat cards). A grid of equal fields with one gap, every cell filled (a short last row
// widens its cards to the row's edge — the bento rule: no empty cell), one accent card at most (the figure the page
// is about; the rest sit on the tint). items: [{ value, unit?, label, detail?, badge?, icon?, accent? }] — a badge or
// an icon opens the card, the value at the band scale under it, the label bound, the detail as a caption. columns
// default min(4, n); h per card: a card carries an opener or a detail in a two-row grid (h ≈ 2.0 in a 4 in body),
// both only in a one-row grid (h ≥ 2.4) — the stack is opener 0.3 + value 0.7 + label 0.3 + detail 0.3 with the
// ladder's gaps inside PAD. Returns the bottom edge.
async function cards(slide, x, y, w, items, { columns, h = 2.2, gap } = {}) {
  const sp = spec('cards'), n = items.length, cols = Math.max(1, Math.min(columns ?? Math.min(4, n), n)), bsp = spec('badge');
  gap ??= sp.gap;
  if (items.filter((it) => it.accent).length > 1) throw new Error('cards: one accent card at most — the figure the page is about; the rest sit on the tint');
  const rows = Math.ceil(n / cols);
  footGuard('cards', y, y + rows * h + (rows - 1) * gap, `h ${((Z.body.bottom - y - (rows - 1) * gap) / rows).toFixed(2)} fits ${rows} row${rows > 1 ? 's' : ''} from this top, or fewer cards per row`);
  let bottom = y;
  for (let start = 0; start < n; start += cols) {
    const row = items.slice(start, start + cols), ry = y + (start / cols) * (h + gap), lanes = spans(x, w, row.map(() => 1), { gap });
    for (let i = 0; i < row.length; i += 1) {
      const it = row[i], c = lanes[i], on = Boolean(it.accent), ink = on ? sp.accent.color : T.ink;
      field(slide, c.x, ry, c.w, h, on ? sp.accent.fill : sp.tint, S.roundRect, { rectRadius: sp.radius, objectName: specName('cards', on ? 'accent' : 'default') });
      const b = inner({ x: c.x, y: ry, w: c.w, h });
      let cy = b.y;
      if (it.badge) { badge(slide, b.x, cy, textW(it.badge, bsp.size, bsp.font, true) + 0.3, null, it.badge, on ? { fill: T.paper, color: T.ink } : { tone: 'accent' }); cy += bsp.h + GAP.within; }
      else if (it.icon) { await icon(slide, b.x, cy, 'glyph', it.icon, { disc: false, color: on ? ink : sp.value, alt: it.label }); cy += ICON_SIZE.glyph + GAP.within; }
      const vb = hero(slide, b.x, cy, b.w, it.value, it.label, { scale: 'band', unit: it.unit || '', color: on ? ink : sp.value, labelColor: on ? ink : sp.label, minH: 0.5 });
      if (it.detail) text(slide, it.detail, b.x, vb + GAP.within, b.w, 'caption', { color: on ? ink : T.body, h: Math.max(0.2, b.y + b.h - vb - GAP.within) });
    }
    bottom = ry + h;
  }
  return bottom;
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
  // A surface that covers the page is the page's field from here on, whatever master it was opened with.
  if (w * h >= W * H * 0.9) onField(slide, contrast(tint, T.onDark) >= contrast(tint, T.ink) ? 'dark' : 'paper');
}
// Outline carrier: no fill, one coherent stroke (the strong line — it owns the region) — ownership without a heavy card.
function outline(slide, x, y, w, h, { color = T.lineStrong, width = LINE, shape = S.rect, radius = 0, dash = 'solid' } = {}) {
  slide.addShape(shape, { ...box(x, y, w, h), fill: { color: T.paper, transparency: 100 }, line: { color, width, dashType: dash }, ...(radius ? { rectRadius: radius } : {}) });
}
// Badge / chip: compact status, tag, or category label. tone: neutral (ink on tint) · accent (white on the accent, the one
// emphasized chip) · a state (its word on its weak field). Anatomy from SPEC.badge; h null takes the spec's height.
function badge(slide, x, y, w, h, str, { tone: toneName = 'neutral', fill, color, font, size } = {}) {
  const sp = spec('badge'), t = tone(toneName);
  h ??= sp.h; fill ??= t.fill; color ??= t.color; font ??= sp.font; size ??= sp.size;
  slide.addShape(S.roundRect, { ...box(x, y, w, h), rectRadius: sp.radius, fill: { color: fill }, line: { color: fill } });
  slide.addText(str, { ...box(x, y, w, h), fontFace: font, fontSize: size, bold: true, color, align: 'center', valign: 'middle', margin: 0, objectName: specName('badge', toneName) });
}
// Horizontal rule: T.line at a section boundary (default), T.lineSubtle between repeated items, T.lineStrong as a frame edge.
function hairline(slide, x, y, w, color = T.line) {
  slide.addShape(S.line, { ...box(x, y, w, 0), line: { color, width: LINE } });
}
function rule(slide, x, y, h, color = T.line, width = LINE) {   // vertical rule the content hangs from
  slide.addShape(S.line, { ...box(x, y, 0, h), line: { color, width } });
}
function connector(slide, x1, y1, x2, y2, { color = T.mark, width = 1.5, arrow = 'triangle', dash = 'solid' } = {}) {
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
    slide.addText(label, { ...box(cx + notch, y, cw - notch * 2, h), fontFace: sp.font, fontSize: size ?? sp.size, bold: state === 'active', color: sp.color[state], align: 'center', valign: 'middle', margin: 0, objectName: specName('chevrons', state) });
    cx += ws[i];
  });
}
function node(slide, cx, cy, d, str, { fill = T.accentLabel.fill, color = T.accentLabel.color, size = DIAG.label } = {}) {
  slide.addShape(S.ellipse, { ...box(cx - d / 2, cy - d / 2, d, d), fill: { color: fill }, line: { color: fill } });
  slide.addText(String(str), { ...box(cx - d / 2, cy - d / 2, d, d), fontFace: T.data, fontSize: size, bold: true, color, align: 'center', valign: 'middle', margin: 0 });
}
function brace(slide, x, y, h, side = 'left', color = T.mark) {
  slide.addShape(side === 'left' ? S.leftBrace : S.rightBrace, { ...box(x, y, 0.25, h), fill: { color: T.paper, transparency: 100 }, line: { color, width: 1.5 } });
}
// Block-arc segment around (cx, cy): angles in degrees clockwise from 3 o'clock (270 = 12 o'clock). thickness 0-1 of the radius.
// The swept angle is what a reader measures, so it comes from end - start before the shape's angles wrap: a full turn draws a
// closed ring (a wrapped 360 would land on its own start and read as empty or full by renderer luck) and a zero sweep draws nothing.
function arc(slide, cx, cy, r, start, end, { color = T.accentFill, thickness = 0.28 } = {}) {
  const turn = end - start, deg = (a) => ((a % 360) + 360) % 360;
  const sweep = turn === 0 ? 0 : Math.min(deg(turn) || 359.9, 359.9);
  if (sweep <= 0) return;
  slide.addShape(S.blockArc, { ...box(cx - r, cy - r, r * 2, r * 2), angleRange: [deg(start), deg(start + sweep)], arcThicknessRatio: thickness, fill: { color }, line: { color } });
}
// Gauge: one proportion (share 0-1) with the value on a solid disc in the middle. A share past 1 reads as a full ring (the value
// text carries the overshoot: 112% is a closed ring labelled 112%), and 0 leaves the track empty.
function gauge(slide, cx, cy, r, share, value, label, { track = T.paperAlt, disc = T.paper, valueColor = T.ink, labelColor = T.muted } = {}) {
  const sweep = 360 * Math.min(1, Math.max(0, Number(share) || 0)), inner = r * 0.82 * 2 - 0.12;
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
  slide.addText(str, { ...box(c.x, y, c.w, h), fontFace: sp.font, fontSize: size ?? sp.size, color: t.color, valign: 'middle', margin: 0, objectName: specName('callout', toneName) });
}
// Custom silhouette: diagonal cut field or any polygon, points in inches relative to the box.
function polygon(slide, x, y, w, h, points, fill = T.dark) {
  slide.addShape(S.custGeom, { ...box(x, y, w, h), fill: { color: fill }, line: { color: fill },
    points: [...points.map((p, i) => ({ x: p[0], y: p[1], moveTo: i === 0 })), { close: true }] });
}
// Depth is one shadow, spent once: the elevated object of a page (lift) and the active unit of a structure (§6) share
// it, so depth always says "this one" — a diagram language draws a shadow on any shape as a style (D2's `shadow`),
// a frontier page spends it on the state.
// LIFT() returns a fresh object every time: pptxgenjs rewrites the shadow it is handed in place, so one shared object
// used on a second shape carried already-converted values and the file no longer opened.
const LIFT = () => ({ type: 'outer', color: '000000', blur: 12, offset: 4, angle: 90, opacity: 0.10 });
// The one elevated object on the slide (peers stay flat).
function lift(slide, x, y, w, h, tint = T.paper, { radius = RADIUS } = {}) {
  slide.addShape(S.roundRect, { ...box(x, y, w, h), rectRadius: radius, fill: { color: tint }, line: { color: tint }, shadow: LIFT() });
}
// Stage: the context field a structure stands on — the pale band under a frontier process row, the card every block
// of a bento page sits in. It spans its column from the body top to the foot, so the page's largest object is the
// stage and the structure inside it reads as the carrier rather than as a mark on open paper (a loop or a hub drawn
// on the bare canvas measured a tenth of the page; the reference pages give a structure a third or more —
// composition.md §6). Returns the inner box and the geometry the structures take from it: cx/cy the centre; r the
// inner radius (half the shorter side) a structure spends — `loop(slide, st, …)` and `hub(slide, st, …)` take their
// radii from it (a loop keeps its outside labels on the stage with `st.r - 1.0`, a hub puts its satellites' centres
// on `st.r - d / 2`); w for a timeline, a dumbbell, or lanes; ground for the structure's `ground` option, so its
// default units switch to paper on the tinted field instead of vanishing. The rail beside a stage starts at `st.y`
// (the inner top, a pad under the field's edge), so its first label registers with the structure's top, never at
// `top + 0.42` found by eye.
function stage(slide, x, y, w, h, { tint = T.paperAlt, pad = PAD } = {}) {
  // The floor under which the structure on it stops reading as the carrier (composition.md §6: a quarter of the
  // canvas): refused before the draw with the share named, so the author widens the column or shares the height down
  // (shareDown) instead of reading page_underfill after the render.
  const share = (w * h) / (W * H);
  if (share < 0.22) throw new Error(`stage: ${w.toFixed(2)} × ${h.toFixed(2)} in is ${share.toFixed(2)} of the canvas — a structure needs a quarter to read as the carrier; give it the column from the body top to the foot (avail(top)) or share the height with shareDown()`);
  field(slide, x, y, w, h, tint);
  const c = inner({ x, y, w, h }, pad);
  return { ...c, cx: c.x + c.w / 2, cy: c.y + c.h / 2, r: Math.min(c.w, c.h) / 2, ground: tint, share: Number(((w * h) / (W * H)).toFixed(2)) };
}
```
Other presets: `S.round1Rect`, `S.snip1Rect`, `S.snipRoundRect`, `S.trapezoid`, `S.parallelogram`, `S.hexagon`, `S.frame`, `S.corner`, `S.pie` + `angleRange`, `S.donut`, `S.rightArrow`, `S.leftArrow`, `S.downArrow`, `S.leftRightArrow`, `S.bracePair`, `S.triangle`; `rotate` and `flipH` apply to all.

## 6. Structures — relationship carriers (composition.md §4)
A structure is the geometry a relationship atom takes: an order on a spine, a hub with its satellites, levels on one taper, items on two axes. Each helper draws one structure inside a region the author chose — spine first, nodes at content-driven positions, connectors only where a link is real, labels registered to their unit (composition.md §5) — and returns the bottom edge. None draws a title, a kicker, or a takeaway: the page stays the author's, and the structure is the carrier the page hangs on, at a quarter of the canvas or more (composition.md §6). Every label reads `SPEC.structure` (one node size, one edge, one label face) and signs its kind, so the receipt reports which structures a deck used (`receipt.deck.specs.structure.variants`) and a deck that repeats one kind on every page can see it. A stage is a string or `{ label, detail?, active?, weight?, icon? }`; `active` is the one state the page is about, never a habit. A unit of a hub, a step run, or a merge carries what a frontier node carries — an icon from the set over (or before) the label, the detail under it when the unit is tall enough, and the active unit alone raised on the page's one shadow (`LIFT`) — so the structure reads as objects with a hierarchy, not as labelled discs; the reference diagrams (the mock galleries, Coatue's process page) put an icon and a line of detail in every node and spend depth on one. A lane's unit and a quadrant's item carry the same face (the icon before the label in a lane, a marker disc with the icon at the position in a quadrant, a detail under the label). `hub()`, `steps()`, `merge()`, `lanes()`, and `quadrants()` draw the icons, so they are awaited for their bottom edge.
```js
const stageOf = (st) => (typeof st === 'string' ? { label: st } : st);
// A unit's face: the optional icon at glyph size in the state's type colour, the label in the spec face, the detail as
// a note under it when the unit is at least an inch tall. layout: 'stack' (icon over the label — a disc) | 'row'
// (icon before the label — a block). One text box carries the label and the detail, as labelBlock does.
async function unitFace(slide, x, y, w, h, kind, s, { state = 'default', layout = 'stack', size, color, iconD = ICON_SIZE.glyph } = {}) {
  const sp = spec('structure'), at = size ?? sp.size, col = color ?? sp.color[state], bold = true;
  const row = layout === 'row', stack = !row && Boolean(s.icon), lx = row && s.icon ? x + iconD + GAP.within : x, lw = w - (lx - x);
  const detail = h >= (row ? 1.0 : 1.4) && s.detail ? wrapKo(s.detail, lw, sp.note, T.light) : '';
  const lines = wrapKo(s.label, lw, at, sp.font, bold);
  // The icon registers to the unit, not to a measured line: in a row it is centred on the block (an icon centred on
  // the label line sat 3.5 pt off the stage's middle and read as drift); in a stack its bottom edge is the unit's
  // centre axis (a group centred as a whole put the icon's top 5 pt off the spokes' axis), the label under it.
  if (s.icon) await icon(slide, row ? x : x + (w - iconD) / 2, row ? y + (h - iconD) / 2 : y + h / 2 - iconD, iconD, s.icon, { disc: false, color: col, alt: s.label });
  const runs = lines.split('\n').map((line, i) => ({ text: line, options: { bold, ...(i ? { softBreakBefore: true } : {}) } }));
  if (detail) { runs[runs.length - 1].options.breakLine = true; detail.split('\n').forEach((line, i) => runs.push({ text: line, options: { fontSize: sp.note, fontFace: T.light, bold: false, color: state === 'active' ? col : T.body, ...(i ? { softBreakBefore: true } : {}) } })); }
  // The text box is the unit's box (its edges the shape's, so it adds no edge of its own to the page's axes); in a
  // stack the icon's half is the box's top inset and the lines hang from the centre axis. pptxgenjs reads a text
  // margin array as [left, right, bottom, top] in points — the top is the fourth entry, not the first.
  slide.addText(runs, { ...box(lx, y, lw, h), fontFace: sp.font, fontSize: at, color: col, align: row ? 'left' : 'center', valign: stack ? 'top' : 'middle', margin: [0, 0, 0, stack ? (h / 2 + GAP.bind) * 72 : 0], lineSpacingMultiple: 1.15, objectName: specName('structure', kind) });
}
// A structure's label: the spec face and size, the state's color, wrapped by the eojeol, signed with its kind.
function slabel(slide, str, x, y, w, h, kind, { state = 'default', color, bold = state === 'active', align = 'center', valign = 'middle', size, font } = {}) {
  const sp = spec('structure'), face = font ?? sp.font, at = size ?? sp.size;
  slide.addText(runsOf(wrapKo(str, w, at, face, bold)), { ...box(x, y, w, h), fontFace: face, fontSize: at, bold, color: color ?? sp.color[state], align, valign, margin: 0, objectName: specName('structure', kind) });
}
// A label with its detail under it in one text box (the label bold in the spec face, the detail a note); the height
// is measured first so a structure can reserve the room before it draws. labelBlock returns the bottom edge.
// With a detail the block carries a 2 pt paragraph step and two sizes in one box, which the renderers measure a few
// points taller than the sum of the lines — the allowance keeps the LibreOffice read inside the box.
const labelBlockH = (w, label, detail) => { const sp = spec('structure'); return fitH(wrapKo(label, w, sp.size, sp.font, true), w, sp.size, sp.font, { bold: true, lh: 1.2 }) + (detail ? fitH(wrapKo(detail, w, sp.note, T.light), w, sp.note, T.light, { lh: 1.3 }) + 5 / 72 : 0); };
function labelBlock(slide, x, y, w, kind, label, detail, { state = 'default', align = 'left', valign = 'top' } = {}) {
  const sp = spec('structure'), h = labelBlockH(w, label, detail), d = detail ? wrapKo(detail, w, sp.note, T.light) : '';
  const runs = wrapKo(label, w, sp.size, sp.font, true).split('\n').map((line, i) => ({ text: line, options: { bold: true, ...(i ? { softBreakBefore: true } : d ? { paraSpaceAfter: 2 } : {}) } }));
  if (d) { runs[runs.length - 1].options.breakLine = true; d.split('\n').forEach((line, i) => runs.push({ text: line, options: { fontSize: sp.note, fontFace: T.light, bold: false, color: T.body, ...(i ? { softBreakBefore: true } : {}) } })); }
  slide.addText(runs, { ...box(x, y, w, h), fontFace: sp.font, fontSize: sp.size, color: state === 'active' ? T.accent : T.ink, align, valign, margin: 0, lineSpacingMultiple: 1.2, objectName: specName('structure', kind) });
  return y + h;
}
// Timeline: a level order on one spine — nodes at content-driven x (widths by weight), labels alternating above and
// below the spine so long labels never collide; y is the top of the region, the spine sits under the upper labels.
// A node is a dot unless the stage names its `when` (a date, a version); numbering is the author's call and carries
// information only when the order does. Returns the bottom edge. `h`: the stage's height — the timeline's natural
// block (upper labels, spine, lower labels) is centred in it, so a stage sized by shareDown() carries the spine
// through its middle instead of a spine pinned to the top and a hollow field under the labels.
function timeline(slide, x, y, w, stages, { alternate = true, labelW = 3.0, ground = T.paper, h } = {}) {
  const sp = onGround(spec('structure'), ground), st = stages.map(stageOf), cols = spans(x, w, st.map((s) => weightOf(s, { active: s.active })), { gap: 0 });
  const up = (i) => alternate && i % 2 === 1, sep = alternate ? GAP.within : GAP.between;
  const lw = (i) => Math.min(labelW, cols[i].w - sep), lx = (i) => Math.min(Math.max(mid(cols[i]) - lw(i) / 2, x), x + w - lw(i));
  const hs = st.map((s, i) => labelBlockH(lw(i), s.label, s.detail));
  const above = Math.max(0, ...hs.filter((_, i) => up(i))), below = Math.max(0, ...hs.filter((_, i) => !up(i)));
  const natural = above + (above ? GAP.within : 0) + sp.node + (below ? GAP.within : 0) + below;
  if (h > natural) y += (h - natural) / 2;
  const sy = y + above + (above ? GAP.within : 0) + sp.node / 2;
  slide.addShape(S.line, { ...box(x, sy, w, 0), line: { color: sp.edge, width: 1.5 } });
  let bottom = sy + sp.node / 2;
  st.forEach((s, i) => {
    const state = s.active ? 'active' : 'default';
    node(slide, mid(cols[i]), sy, sp.node, s.when ?? '', { fill: sp.fill[state], color: sp.color[state], size: sp.note });
    if (up(i)) labelBlock(slide, lx(i), sy - sp.node / 2 - GAP.within - hs[i], lw(i), 'timeline', s.label, s.detail, { state, align: 'center', valign: 'bottom' });
    else bottom = Math.max(bottom, labelBlock(slide, lx(i), sy + sp.node / 2 + GAP.within, lw(i), 'timeline', s.label, s.detail, { state, align: 'center' }));
  });
  return bottom;
}
// Steps: a rising (or falling) order on a diagonal — each block one tread up from the last, connectors edge to edge.
// A block carries its icon before the label and its detail under it (blockH 1.3 leaves the room); the active block
// stands on the page's shadow. Awaited for the bottom edge.
async function steps(slide, x, y, w, h, stages, { rising = true, blockH = 1.3, ground = T.paper } = {}) {
  // Under 0.7 in a block cannot hold a label between its pads (a detail needs 1.0 in and drops out below it; 0.8 in
  // keeps the label alone). Refused before the draw with the fix named.
  if (h < 0.7) throw new Error(`steps: ${h.toFixed(2)} in is under the 0.7 in floor a block needs for its label — give the run more height (shareDown)`);
  const sp = onGround(spec('structure'), ground), st = stages.map(stageOf), n = st.length, bw = (w - GUTTER * (n - 1)) / n, bh = Math.min(blockH, h), rise = n > 1 ? (h - bh) / (n - 1) : 0;
  const at = (i) => ({ x: x + i * (bw + GUTTER), y: rising ? y + h - bh - i * rise : y + i * rise });
  st.forEach((s, i) => { if (i < n - 1) { const a = at(i), b = at(i + 1); connector(slide, a.x + bw, a.y + bh / 2, b.x, b.y + bh / 2, { color: sp.edge }); } });
  for (let i = 0; i < n; i += 1) {
    const s = st[i], p = at(i), state = s.active ? 'active' : 'default';
    slide.addShape(S.roundRect, { ...box(p.x, p.y, bw, bh), rectRadius: RADIUS, fill: { color: sp.fill[state] }, line: { color: sp.fill[state] }, ...(s.active ? { shadow: LIFT() } : {}) });
    await unitFace(slide, p.x + PAD, p.y, bw - PAD * 2, bh, 'steps', s, { state, layout: 'row', size: bh >= 0.9 ? TYPE.body : sp.size });
  }
  return y + h;
}
// Hub and spokes: one center, many satellites at content-driven angles (`angle` per satellite, degrees clockwise from
// 3 o'clock; else an even spread from `start`). Spokes end on the node edges and sit under the nodes.
// ground: the colour under a structure (a stage's tint). On the tinted field the structure's default units switch to
// paper so they stand on it instead of dissolving into it; the active unit keeps the accent.
const onGround = (sp, ground) => (String(ground).toUpperCase() === String(T.paperAlt).toUpperCase() ? { ...sp, fill: { ...sp.fill, default: T.paper } } : sp);
// A satellite carries its icon over the label (and its detail under it from d 1.0 up); the active satellite stands on
// the page's shadow. center is a string or a stage (its icon in the hub). Awaited for the bottom edge.
// Stage form — hub(slide, st, center, satellites, opts) with the box stage() returned: the ring's geometry comes from
// the stage instead of three typed radii — the satellites' outer edge on the stage's inner radius (r = st.r − d / 2),
// a satellite 1.0-1.5 in from the radius, the hub sized so the satellites sit against it (the frontier hub pages:
// the centre a band larger than a satellite, no stub spokes). Any of r / d / hubD passed still wins.
async function hub(slide, cx, cy, center, satellites, opts = {}) {
  if (cx && typeof cx === 'object') {
    const stg = cx; opts = satellites || {}; satellites = center; center = cy; cx = stg.cx; cy = stg.cy;
    // Under 1.6 in of inner radius the satellites (≥ 1.0 in) leave no hub between them: the stage needs 3.6 in on its shorter side.
    if (stg.r < 1.6) throw new Error(`hub: the stage's inner radius ${stg.r.toFixed(2)} in is under the 1.6 in floor — a stage at least 3.6 in tall, or fewer things beside it`);
    const n = satellites.length, d = opts.d ?? Math.min(1.5, Math.max(1.0, stg.r * 0.5)), r = opts.r ?? stg.r - d / 2;
    // The hub's edge a step (0.12 in, over the 6 pt the spacing check wants between text boxes) short of the
    // satellites' inner edges: they read as sitting against it, no overlap, and no stub spokes (drawn from reach
    // 0.25). n only bounds d so five or more satellites never touch each other.
    opts = { ground: stg.ground, d: Math.min(d, 2 * (stg.r - d / 2) * Math.sin(Math.PI / n) * 0.9), r, hubD: Math.max(1.4, 2 * (r - d / 2 - 0.12)), ...opts };
  }
  const { r = 2.3, d = 1.5, hubD = 2.2, start = -90, ground = T.paper } = opts;
  const sp = onGround(spec('structure'), ground), st = satellites.map(stageOf), n = st.length, hc = stageOf(center);
  const angle = (s, i) => ((s.angle ?? start + i * 360 / n) * Math.PI) / 180;
  // A spoke is drawn when there is a spoke to see: satellites that sit against the hub (a stage-filling hub, r ≈ hubD / 2
  // + d / 2) show the link by touching it, and a stub under a quarter inch between them only adds edges the page's axes trip on.
  const reach = r - d / 2 - hubD / 2;
  if (reach >= 0.25) st.forEach((s, i) => { const a = angle(s, i), ux = Math.cos(a), uy = Math.sin(a); connector(slide, cx + ux * hubD / 2, cy + uy * hubD / 2, cx + ux * (r - d / 2), cy + uy * (r - d / 2), { color: sp.edge, arrow: 'none' }); });
  for (let i = 0; i < n; i += 1) {
    const s = st[i], a = angle(s, i), state = s.active ? 'active' : 'default', sx = cx + Math.cos(a) * r, sy = cy + Math.sin(a) * r;
    slide.addShape(S.ellipse, { ...box(sx - d / 2, sy - d / 2, d, d), fill: { color: sp.fill[state] }, line: { color: sp.fill[state] }, ...(s.active ? { shadow: LIFT() } : {}) });
    await unitFace(slide, sx - d / 2 + d * 0.12, sy - d / 2, d * 0.76, d, 'hub', s, { state });
  }
  slide.addShape(S.ellipse, { ...box(cx - hubD / 2, cy - hubD / 2, hubD, hubD), fill: { color: T.ink }, line: { color: T.ink } });
  await unitFace(slide, cx - hubD / 2 + hubD * 0.12, cy - hubD / 2, hubD * 0.76, hubD, 'hub', hc, { color: T.paper, size: TYPE.body, iconD: ICON_SIZE.marker });   // the centre's icon a band up: it is the structure's hero
  return cy + r + d / 2;
}
// Loop: a closed order as block-arc segments around a center, each label outside its segment at the mid-angle, an
// optional word in the middle (the state the loop is about). Returns the bottom edge.
// ground: the colour under the loop (a stage's tint) — on the tinted field the quiet segments switch to paper so the
// ring stands on the stage instead of dissolving into it. thickness is the block arc's ratio of the radius (0-1).
// track: the quiet segments' colour when the page needs the ring to carry colour (T.tint, the light accent tint, breaks
// a run of quiet pages — composition.md §7 — while the active segment in the accent still stands out and the labels
// outside the ring keep their contrast on the stage; T.accentFill would make every segment read active).
// Stage form — loop(slide, st, stages, opts): the ring's radius comes from the stage — the outside labels (reach
// r + 0.5, a 0.5 in line) end on the stage's inner radius, so r = st.r − 1.0 and the loop fills the stage top to
// bottom instead of a ring a hand-typed radius left floating in the field.
function loop(slide, cx, cy, r, stages, opts = {}) {
  if (cx && typeof cx === 'object') { const stg = cx; opts = { ground: stg.ground, ...(r || {}) }; stages = cy; r = stg.r - 1.0; cx = stg.cx; cy = stg.cy; }
  // A ring under 0.6 in radius is a mark, not a carrier (the stage form needs a stage at least 3.2 in on its shorter side).
  if (r < 0.6) throw new Error(`loop: radius ${r.toFixed(2)} in is under the 0.6 in floor — a stage at least 3.2 in tall (r = st.r − 1.0 for the outside labels), or the loop on its own column`);
  const { center = '', thickness = 0.28, gap = 6, labelW = 2.0, ground = T.paper, track: trackColor } = opts;
  const sp = spec('structure'), st = stages.map(stageOf), span = 360 / st.length, lh = 0.5, reach = r + 0.5;
  // The quiet segments' colour follows the ground: paperAlt on paper, paper on the paperAlt stage, and the strong line
  // grey on any other tint (an accent-tinted stage read paperAlt segments as low contrast) — unless `track` names it.
  const same = (a, b) => String(a).toUpperCase() === String(b).toUpperCase();
  const tinted = same(ground, T.paperAlt), track = trackColor || (tinted ? T.paper : same(ground, T.paper) ? T.paperAlt : T.lineStrong);
  st.forEach((s, i) => {
    const on = Boolean(s.active), state = on ? 'active' : 'default';
    arc(slide, cx, cy, r, 270 + i * span + gap / 2, 270 + (i + 1) * span - gap / 2, { color: on ? T.accent : track, thickness });
    const a = (270 + (i + 0.5) * span) * Math.PI / 180, c = Math.cos(a), sn = Math.sin(a), px = cx + reach * c, py = cy + reach * sn;
    const lx = c < -0.3 ? px - labelW : c > 0.3 ? px : px - labelW / 2, ly = sn < -0.3 ? py - lh : sn > 0.3 ? py : py - lh / 2;
    slabel(slide, s.label, lx, ly, labelW, lh, 'loop', { state, color: on ? T.accent : T.ink, align: c < -0.3 ? 'right' : c > 0.3 ? 'left' : 'center' });
  });
  if (center) { const d = r * (1 - thickness) * 2 - 0.12; slide.addShape(S.ellipse, { ...box(cx - d / 2, cy - d / 2, d, d), fill: { color: T.paper }, line: { color: T.paper } }); slabel(slide, center, cx - d / 2, cy - d / 2, d, d, 'loop', { bold: true, size: TYPE.lead }); }
  return cy + reach + lh;
}
// Merge (many into one) or split (one into many): the many in a column, the one vertically centered on the other side,
// connectors from unit edge to unit edge across the region. side: 'merge' (many on the left) | 'split' (many on the right).
// Each of the many carries its icon before the label (a unit an inch tall carries its detail too); the active one
// stands on the page's shadow; the one is a string or a stage. Awaited for the bottom edge.
async function merge(slide, x, y, w, h, many, one, { side = 'merge', colW = 3.2, oneW = 3.2, unitH = 0.9 } = {}) {
  const sp = spec('structure'), st = many.map(stageOf), n = st.length, oc = stageOf(one);
  const uh = Math.min(unitH, (h - GAP.between * (n - 1)) / n), sy = y + (h - (uh * n + GAP.between * (n - 1))) / 2;
  const manyX = side === 'merge' ? x : x + w - colW, oneX = side === 'merge' ? x + w - oneW : x, oneH = Math.min(1.4, h), oneY = y + (h - oneH) / 2;
  for (let i = 0; i < n; i += 1) {
    const s = st[i], uy = sy + i * (uh + GAP.between), state = s.active ? 'active' : 'default';
    if (side === 'merge') connector(slide, manyX + colW, uy + uh / 2, oneX, oneY + oneH / 2, { color: sp.edge });
    else connector(slide, oneX + oneW, oneY + oneH / 2, manyX, uy + uh / 2, { color: sp.edge });
    slide.addShape(S.roundRect, { ...box(manyX, uy, colW, uh), rectRadius: RADIUS, fill: { color: sp.fill[state] }, line: { color: sp.fill[state] }, ...(s.active ? { shadow: LIFT() } : {}) });
    await unitFace(slide, manyX + PAD, uy, colW - PAD * 2, uh, 'merge', s, { state, layout: 'row', size: uh >= 0.7 ? TYPE.body : sp.size });
  }
  slide.addShape(S.roundRect, { ...box(oneX, oneY, oneW, oneH), rectRadius: RADIUS, fill: { color: T.ink }, line: { color: T.ink } });
  await unitFace(slide, oneX + PAD, oneY, oneW - PAD * 2, oneH, 'merge', oc, { layout: 'row', color: T.paper, size: TYPE.body });
  return y + h;
}
// Tiers: levels of one hierarchy on one taper — the top tier the narrowest, widths monotonic, labels inside.
// taper: the top edge as a share of the base width.
function tiers(slide, x, y, w, h, stages, { taper = 0.45, gap = SPACE.hair } = {}) {
  const sp = spec('structure'), st = stages.map(stageOf), n = st.length, th = (h - gap * (n - 1)) / n, widthAt = (t) => w * (taper + (1 - taper) * t);
  st.forEach((s, i) => {
    const ty = y + i * (th + gap), w0 = widthAt(i / n), w1 = widthAt((i + 1) / n), state = s.active ? 'active' : 'default';
    polygon(slide, x, ty, w, th, [[(w - w0) / 2, 0], [(w + w0) / 2, 0], [(w + w1) / 2, th], [(w - w1) / 2, th]], sp.fill[state]);
    slabel(slide, s.label, x + (w - w0) / 2 + GAP.within, ty + GAP.within, w0 - GAP.within * 2, th - GAP.within * 2, 'tiers', { state, size: th >= 0.8 ? TYPE.body : sp.size });
  });
  return y + h;
}
// Swimlanes: who does what, when — lanes sharing seams, each unit at its lane and its span of the track (`at`, `span`
// in 0-1 of the track width). rows: [{ name, items: [{ label, at, span, active?, icon?, detail? }] }].
// A unit carries its icon before the label (a bar with a glyph reads as a task, a bare bar as a span); `unitH: 1.0`
// gives it the room for its detail; the active unit alone stands on the page's shadow. Awaited for the bottom edge.
async function lanes(slide, x, y, w, h, rows, { labelW = 1.6, unitH = 0.7 } = {}) {
  const n = rows.length, laneH = h / n, tx = x + labelW, tw = w - labelW, uh = Math.min(unitH, laneH - 0.3);
  // A lane under 0.8 in squeezes its unit under 0.5 in — below the icon-and-label height with no field around it
  // (C3 rendered clean at 0.81; the floor is the last height that did).
  if (laneH < 0.8) throw new Error(`lanes: ${n} lanes in ${h.toFixed(2)} in give ${laneH.toFixed(2)} in each — 0.8 in is the floor; give the lanes more height (shareDown) or drop a lane`);
  for (let i = 0; i < n; i += 1) {
    const lane = rows[i], ly = y + i * laneH;
    if (i % 2 === 0) field(slide, x, ly, w, laneH, T.paperAlt);
    slabel(slide, lane.name, x + GAP.within, ly + (laneH - uh) / 2, labelW - GAP.within * 2, uh, 'lanes', { align: 'left', bold: true });
    for (const it of lane.items || []) {   // units register to the track: a unit ending at span 1 ends on the track's edge
      const u = stageOf(it), on = Boolean(u.active), state = on ? 'active' : 'default', ux = tx + tw * (u.at ?? 0), uw = Math.max(0.6, tw * (u.span ?? 0.25)), uy = ly + (laneH - uh) / 2;
      slide.addShape(S.roundRect, { ...box(ux, uy, uw, uh), rectRadius: RADIUS, fill: { color: on ? T.accent : T.paper }, line: { color: on ? T.accent : T.lineStrong, width: 1 }, ...(on ? { shadow: LIFT() } : {}) });
      await unitFace(slide, ux + GAP.within, uy, uw - GAP.within * 2, uh, 'lanes', u, { state, layout: 'row' });
    }
    if (i) hairline(slide, x, ly, w, T.line);
  }
  return y + h;
}
// Quadrants: items on two axes — one field with two rules crossing at the threshold, the axis names at the rules'
// ends, the quadrant names in the corners, each item a dot at its values with its label beside it. An item with an
// `icon` is a marker disc carrying it (the frontier 2×2 puts a logo or a glyph at every position, never a bare dot),
// and a `detail` is the note under its label; the active icon item alone stands on the page's shadow. Awaited for the bottom edge.
// axes: { x: [low, high], y: [low, high] }; at: the threshold in 0-1 (the middle by default); names: four corner
// names in reading order (top-left, top-right, bottom-left, bottom-right); items: [{ label, x, y, active?, icon?, detail? }] in 0-1.
async function quadrants(slide, x, y, w, h, { axes = { x: ['', ''], y: ['', ''] }, at = [0.5, 0.5], names = [], items = [] } = {}) {
  const share = (w * h) / (W * H);   // the field is the quadrants' own stage: the same quarter floor (composition.md §6)
  if (share < 0.22) throw new Error(`quadrants: ${w.toFixed(2)} × ${h.toFixed(2)} in is ${share.toFixed(2)} of the canvas — the 2×2 needs a quarter to read; give it the column from the body top to the foot`);
  const sp = onGround(spec('structure'), T.paperAlt), c = inner({ x, y, w, h }), fx = c.x + c.w * at[0], fy = c.y + c.h * (1 - at[1]), noteH = 0.3;
  field(slide, x, y, w, h);
  rule(slide, fx, c.y, c.h, T.lineStrong); hairline(slide, c.x, fy, c.w, T.lineStrong);
  // A note's box is its measured width (never a fixed 2.5 in), so the axis name and the corner name on one edge never share a box.
  const notes = [];   // the axis and corner notes' boxes: an item's label takes the side of its marker that leaves them
  // The two axis rules are obstacles of their own: a label may cross one only when every free spot does, and then it
  // stands on a knockout of the field so the rule breaks around the words (an item on the boundary — "혼합" at 0.55/0.45 —
  // had its label and detail written straight across the horizontal rule).
  const rules = [{ x: fx - 0.02, y: c.y, w: 0.04, h: c.h }, { x: c.x, y: fy - 0.02, w: c.w, h: 0.04 }];
  const note = (str, nx, ny, align, bold = false) => { if (!str) return; const font = bold ? T.sans : T.data, nw = textW(str, sp.note, font, bold) + 0.1, bx = align === 'right' ? nx - nw : nx; notes.push({ x: bx, y: ny, w: nw, h: noteH }); slabel(slide, str, bx, ny, nw, noteH, 'quadrants', { size: sp.note, color: T.muted, align, bold, font }); };
  const shared = (b, list = notes) => list.reduce((sum, n) => sum + Math.max(0, Math.min(b.x + b.w, n.x + n.w) - Math.max(b.x, n.x)) * Math.max(0, Math.min(b.y + b.h, n.y + n.h) - Math.max(b.y, n.y)), 0);
  note(axes.x[0], c.x, fy - noteH - GAP.bind, 'left'); note(axes.x[1], c.x + c.w, fy - noteH - GAP.bind, 'right');
  note(axes.y[1], fx + GAP.within, c.y, 'left'); note(axes.y[0], fx + GAP.within, c.y + c.h - noteH, 'left');
  [[c.x, c.y, 'left'], [c.x + c.w, c.y, 'right'], [c.x, c.y + c.h - noteH, 'left'], [c.x + c.w, c.y + c.h - noteH, 'right']]
    .forEach(([nx, ny, align], i) => note(names[i], nx, ny, align, true));
  // Every marker is placed before any label, so a label avoids the other items' markers as well as the notes.
  const marks = items.map((it) => { const u = stageOf(it), on = Boolean(u.active), d = u.icon ? ICON_SIZE.disc : 0.22; return { u, on, state: on ? 'active' : 'default', d, px: c.x + c.w * (u.x ?? 0.5), py: c.y + c.h * (1 - (u.y ?? 0.5)) }; });
  for (const m of marks) {
    const fill = m.u.icon ? sp.fill[m.state] : m.on ? T.accent : T.mark;
    slide.addShape(S.ellipse, { ...box(m.px - m.d / 2, m.py - m.d / 2, m.d, m.d), fill: { color: fill }, line: { color: fill }, ...(m.on && m.u.icon ? { shadow: LIFT() } : {}) });
    if (m.u.icon) await icon(slide, m.px - m.d * 0.28, m.py - m.d * 0.28, m.d * 0.56, m.u.icon, { disc: false, color: sp.color[m.state], alt: m.u.label });
    notes.push({ x: m.px - m.d / 2, y: m.py - m.d / 2, w: m.d, h: m.d });
  }
  for (const { u, on, state, d, px, py } of marks) {
    // The label's box is its measured width and lines: a fixed 2.2 in strip beside a dot near the top rule reached the
    // axis note on the other side of the vertical rule and read as an overlap. A detail may wrap at 2.6 in.
    const lw = Math.min(2.6, Math.max(textW(u.label, sp.size, sp.font, on), u.detail ? textW(u.detail, sp.note, T.light) : 0)) + 0.1, reach = d / 2 + 0.09, bh = labelBlockH(lw, u.label, u.detail);
    // The label takes the first free position around its marker — right, left, under, over (the scatter label's
    // four) — free meaning inside the field and sharing nothing with a note, another marker, or a label already
    // placed (a detail under "대전" near the top-right corner reached the corner name, then the label of "서울");
    // when none is free, the one sharing least. Under and over sit a within step off the marker, never tight.
    const cx = Math.min(Math.max(px - lw / 2, c.x), c.x + c.w - lw);
    const spots = [
      { x: px + reach, y: py - bh / 2, align: 'left', fits: px + reach + lw <= c.x + c.w },
      { x: px - reach - lw, y: py - bh / 2, align: 'right', fits: px - reach - lw >= c.x },
      { x: cx, y: py + d / 2 + GAP.within, align: 'center', fits: py + d / 2 + GAP.within + bh <= c.y + c.h },
      { x: cx, y: py - d / 2 - GAP.within - bh, align: 'center', fits: py - d / 2 - GAP.within - bh >= c.y },
    ].filter((k) => k.fits).map((k) => ({ ...k, w: lw, h: bh, cost: shared({ ...k, w: lw, h: bh }), onRule: shared({ ...k, w: lw, h: bh }, rules) }));
    const free = spots.filter((k) => k.cost === 0).sort((a, b) => a.onRule - b.onRule);
    const at = free[0] ?? [...spots].sort((a, b) => a.cost - b.cost)[0] ?? { x: px + reach, y: py - bh / 2, w: lw, h: bh, align: 'left', onRule: 1 };
    notes.push(at);
    if (at.onRule > 0) field(slide, at.x - 0.04, at.y - 0.02, lw + 0.08, bh + 0.04);
    labelBlock(slide, at.x, at.y, lw, 'quadrants', u.label, u.detail, { state, align: at.align });
  }
  return y + h;
}
// Overlap: shared and separate meaning — two or three translucent ellipses, each set named toward its outer side, the
// shared meaning in the common region. Returns the bottom edge.
function venn(slide, cx, cy, sets, { d = 3.0, overlap = 1.1, shared = '' } = {}) {
  const sp = spec('structure'), st = sets.slice(0, 3).map(stageOf), n = st.length, fills = [T.accent, T.mark, T.markSoft], off = d - overlap;
  const centers = n < 3 ? st.map((_, i) => [cx + (i - (n - 1) / 2) * off, cy]) : [[cx - off / 2, cy + off * 0.29], [cx + off / 2, cy + off * 0.29], [cx, cy - off * 0.58]];
  centers.forEach(([px, py], i) => slide.addShape(S.ellipse, { ...box(px - d / 2, py - d / 2, d, d), fill: { color: fills[i], transparency: 65 }, line: { color: fills[i], transparency: 40 } }));
  centers.forEach(([px, py], i) => { const ux = (px - cx) / (off || 1), uy = (py - cy) / (off || 1); slabel(slide, st[i].label, px + ux * d * 0.18 - 0.9, py + uy * d * 0.18 - 0.25, 1.8, 0.5, 'venn', { bold: true }); });
  // Where the shared meaning is written depends on where the sets' own names are: two sets name themselves on the
  // centre line, so the shared label sits a line under them (it used to run straight through both); three sets stand
  // around the centre and leave it free, which is where the common region is.
  if (shared) slabel(slide, shared, cx - 0.8, n < 3 ? cy + 0.35 : cy - 0.25, 1.6, 0.5, 'venn', { bold: true, size: sp.note });
  return Math.max(...centers.map(([, py]) => py)) + d / 2;
}
// Quote: someone else's words — an oversized mark in the accent, the quote at reading scale beside and below it, the
// attribution under. Returns the bottom edge.
function quote(slide, x, y, w, str, attribution, { size = Math.round(TYPE.lead * 1.3), color = T.ink, mark = 120 } = {}) {
  const mw = textW('“', mark, T.display, true) + 0.2, mh = lineH(mark, T.display) + 0.06;   // the mark's own box: its glyph width, its line height
  slide.addText('“', { ...box(x - 0.1, y, mw, mh), fontFace: T.display, fontSize: mark, bold: true, color: T.accent, margin: 0, valign: 'top' });
  const qx = x - 0.1 + mw + GAP.within, qw = w - (qx - x), b = text(slide, str, qx, y + 1.3, qw, size, { color, font: T.light, lh: 1.35, objectName: specName('structure', 'quote') });
  return attribution ? text(slide, `— ${attribution}`, qx, b + GAP.between, qw, TYPE.caption, { color: T.muted, font: T.data }) : b;
}
// Agenda: the section beat the way Coatue and consulting decks draw it — the deck's sections listed on the dark field
// (quiet() or dark()), the current one lit (onDark, bold, a short rule in the on-dark accent before it), the others
// onDarkMuted at a step down, the step between them the only separator (a full-width rule under a line of type reads
// as an underline, composition.md §10) — so a reader sees where the deck is without a numeral that carries no
// information. items: the section names; active: the index of the one this beat opens. Returns the bottom.
function agenda(slide, items, active, { x = M + 0.4, y = 1.6, w = W - 2 * M - 0.8, gap = GAP.between, size = TYPE.section } = {}) {
  let cy = y;
  items.forEach((label, i) => {
    const on = i === active, sz = on ? size : Math.round(size * 0.8), lh = 1.15;
    const h = fitH(label, w - 1.2, sz, T.display, { bold: on, lh });
    if (on) slide.addShape(S.line, { ...box(x, cy + h / 2, 0.7, 0), line: { color: T.onDarkAccent, width: 2.5 } });
    text(slide, label, x + 1.2, cy, w - 1.2, sz, { color: on ? T.onDark : T.onDarkMuted, bold: on, font: T.display, lh, h, objectName: specName('structure', 'agenda') });
    cy += h + gap;
  });
  return cy;
}
// Ruled list: the Sequoia text page (a third of its 52 pages) — a short label at the left names the frame ("Prepare
// your mind", "Leadership principles"), a vertical rule, and three to six short lines at lead size beside it, the
// content. One per page, or two stacked a between step apart; the lines are one text box. Returns the bottom edge.
function ruledList(slide, x, y, w, label, items, { labelW = 2.6, size = TYPE.lead, lh = 1.6, color = T.body } = {}) {
  const lx = x + labelW + GAP.between, lw = w - labelW - GAP.between;
  const wrapped = items.map((t) => wrapKo(t, lw, size, T.light)), h = fitH(wrapped.join('\n'), lw, size, T.light, { lh });
  footGuard('ruledList', y, y + h, 'cut a line, shorten the lines, or start the list higher');
  text(slide, label, x, y, labelW, 'strong', { size: TYPE.lead, font: T.display, lh: 1.2 });
  rule(slide, x + labelW + GAP.between / 2, y, h, T.lineStrong, 1);
  slide.addText(wrapped.flatMap((t, i) => t.split('\n').map((line, j, lines) => ({ text: line, options: { ...(j ? { softBreakBefore: true } : {}), ...(j === lines.length - 1 && i < wrapped.length - 1 ? { breakLine: true } : {}) } }))),
    { ...box(lx, y, lw, h), fontFace: T.light, fontSize: size, color, valign: 'top', margin: 0, lineSpacingMultiple: lh });
  return y + h;
}
// Columns: two or three text columns on one top line (Naver's reading beside its chart, the Sequoia 2×2 without
// boxes, the Coatue principles page) — a hairline over the row, a bold title over a short paragraph or a list in
// each column, widths by weight. cols: [{ title, text | items, weight? }]. Returns the bottom edge.
// columnsH: the height a columns() row takes at these options, measured before the page is shared out (shareDown
// gives the stage above it what the row leaves). columns() measures with the same function, so the two agree.
// A column's prose is `text`; `body` is the same line under another name (the template fill and the page plans call
// it that), so a column written either way draws the same and neither spelling is dropped in silence.
const columnProse = (c) => c.text ?? c.body ?? '';
const columnHeights = (track, cols, { size, lh, ruled }) => cols.map((c, i) => {
  const col = track[i];
  let h = ruled ? GAP.within : 0;
  if (c.title) h += fitH(wrapKo(c.title, col.w, TYPE.lead, T.display, true), col.w, TYPE.lead, T.display, { bold: true, lh: 1.2 }) + GAP.within;
  if (c.items) h += fitH(c.items.map((t) => wrapKo(t, col.w, size, T.light)).join('\n'), col.w, size, T.light, { lh });
  else if (columnProse(c)) h += fitH(wrapKo(columnProse(c), col.w, size, T.light), col.w, size, T.light, { lh: 1.45 });
  return h;
});
function columnsH(x, w, cols, { gap = GUTTER, size = TYPE.body, lh = 1.5, ruled = true } = {}) {
  return Math.max(...columnHeights(spans(x, w, cols.map((c) => c.weight || 1), { gap }), cols, { size, lh, ruled }));
}
function columns(slide, x, y, w, cols, { gap = GUTTER, size = TYPE.body, lh = 1.5, ruled = true, bottom: limit = Z.body.bottom } = {}) {
  const track = spans(x, w, cols.map((c) => c.weight || 1), { gap });
  // Measured before anything is drawn: a column that would run past the foot is reported with its shortfall (the
  // same contract as reading()), never drawn over the source line for the audit to find.
  const measured = columnHeights(track, cols, { size, lh, ruled });
  const tallest = Math.max(...measured), over = y + tallest - limit;
  if (over > 0.07) {
    const which = measured.indexOf(tallest);
    throw new Error(`columns: column ${which + 1} ("${String(cols[which].title || columnProse(cols[which]) || '').slice(0, 24)}") at (${x.toFixed(2)}, ${y.toFixed(2)}) needs ${over.toFixed(2)} in more than the ${(limit - y).toFixed(2)} in left above the foot at ${size} pt — shorten the copy, drop a column's lines, or start the row higher (avail(top) says how much there is)`);
  }
  // The rule over the row is dropped when the row starts directly under the head's title (within 0.6 in of the head
  // zone's bottom and no sub line between): there it reads as the title's underline, which the design review names
  // decorative_stripe (a thin rule within 40 pt under ≥ 24 pt text sharing its columns). The row keeps its inset so
  // columnsH() and the drawn height agree. Text mode's 23 pt title is under the review's size, so its rule stays.
  const underTitle = TYPE.title >= 24 && y - Z.head.bottom < 0.6;
  if (ruled && !underTitle) hairline(slide, x, y, w, T.line);
  let bottom = y;
  cols.forEach((c, i) => {
    const col = track[i];
    let cy = y + (ruled ? GAP.within : 0);
    if (c.title) cy = text(slide, c.title, col.x, cy, col.w, 'strong', { size: TYPE.lead, font: T.display, lh: 1.2 }) + GAP.within;
    if (c.items) {
      const wrapped = c.items.map((t) => wrapKo(t, col.w, size, T.light)).join('\n'), h = fitH(wrapped, col.w, size, T.light, { lh });
      slide.addText(runsOf(wrapped), { ...box(col.x, cy, col.w, h), fontFace: T.light, fontSize: size, color: T.body, valign: 'top', margin: 0, lineSpacingMultiple: lh });
      cy += h;
    } else if (columnProse(c)) cy = text(slide, columnProse(c), col.x, cy, col.w, size, { color: T.body, lh: 1.45 });
    bottom = Math.max(bottom, cy);
  });
  return bottom;
}
// Brace groups: named groups of items in one column — each group's items one text box, a brace spanning them at the
// left, the name at the brace tip; no boxes. groups: [{ name, items: [] }]. Returns the bottom edge.
function braceGroups(slide, x, y, w, groups, { labelW = 1.7, size = TYPE.body, lh = 1.5 } = {}) {   // items read at body size: a structure is the page's carrier, never under the 12 pt floor
  const ix = x + labelW + 0.6, iw = w - labelW - 0.6;
  const heights = groups.map((g) => fitH(g.items.map((t) => wrapKo(t, iw, size, T.light)).join('\n'), iw, size, T.light, { lh }));
  footGuard('braceGroups', y, y + heights.reduce((a, b) => a + b, 0) + GAP.between * (groups.length - 1), 'cut an item, drop a group, or start the column higher');
  let cy = y;
  groups.forEach((g) => {
    const wrapped = g.items.map((t) => wrapKo(t, iw, size, T.light)), h = fitH(wrapped.join('\n'), iw, size, T.light, { lh });
    slabel(slide, g.name, x, cy, labelW, Math.min(h, 0.6), 'braceGroups', { align: 'right', valign: 'top', color: T.accent, bold: true, size: TYPE.body });
    brace(slide, x + labelW + 0.15, cy, h);
    slide.addText(wrapped.flatMap((t, i) => t.split('\n').map((line, j, lines) => ({ text: line, options: { ...(j ? { softBreakBefore: true } : {}), ...(j === lines.length - 1 && i < wrapped.length - 1 ? { breakLine: true } : {}) } }))),
      { ...box(ix, cy, iw, h), fontFace: T.light, fontSize: size, color: T.body, valign: 'top', margin: 0, lineSpacingMultiple: lh });
    cy += h + GAP.between;
  });
  return cy - GAP.between;
}
```
