# Kit index

Generated from `kit.md`, `charts.md`, and `pictures.md` by `scripts/pptx-kit-index.mjs`; do not edit it by hand.
The runtime runs every code block of those three files before the script. Here each helper keeps its signature,
its defaults, and the guidance written above it; a body reads as `{ … }`. Open the helper in its own file only to
redefine it or when a default this index does not state decides the page.

# kit.md

## Kit

Owns the code: primitives that draw what `composition.md` names, sized with `MEASURE` so text never overflows. The kit is a toolbox, not a slide catalog — no function here draws a whole slide, and every position is the author's. Draw every repeated element through one function so the deck stays consistent. Chart and table helpers are in `charts.md`, picture helpers in `pictures.md` §4.

**The runtime runs every code block of this file, `charts.md`, and `pictures.md` before the script** — the script never pastes them. A script opens with the brief, then one `deck({ style, hue, accentHue?, accentMode?, mode, script, pairing, fonts })` call that sets the frame the style chooses, the palette, the faces, the type scale, the zones, and the masters, then the slides. Read the blocks for the signatures and defaults; redefine a helper in the script when a page needs a different one (a later declaration wins). A script that creates its own `pres` runs without the prelude.

**Hard rule — paragraph options sit on the first run**: the runtime keeps one `a:pPr` per paragraph (the first). `bullet`, `align`, `paraSpaceAfter`, `lineSpacingMultiple` go on the text box or on a paragraph's first run; `breakLine: true` on a paragraph's last run. → runtime (absorbed: the normalizer keeps the first `pPr`; nothing to check)

## 1. Tokens, palette, type, specs, masters

```js

const pptxgen = require('pptxgenjs');
const sharp = require('sharp');
const pres = new pptxgen();
pres.layout = 'LAYOUT_WIDE';
const W = 13.33, H = 7.5;
// canvas (inches)
const S = pres.ShapeType;
// camelCase presets: S.chevron, S.blockArc, S.round1Rect, S.leftBrace, S.wedgeRectCallout, S.custGeom
// A corner radius of 0 is a square corner. pptxgenjs writes no radius for rectRadius: 0, and PowerPoint and LibreOffice
// then draw the preset's own corner, a sixth of the short side: a swiss-minimal deck's lifted plane, cards, and steps
// (RADIUS 0) came out as soft rounded cards. Every slide draws such a shape as the rect it means.
{ …
const box = (x, y, w, h) => ({ x, y, w, h });
const PX = 160;
// raster density: inches × PX = pixels (≥ 2× placed size)
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
let RADIUS = 0.08;
// the one corner radius for lifted or rounded fields; the style sets it
// inner: the content box of a region after the inset — write inner(L) never L.x + 0.15.
const inner = (r, pad = PAD) => ({ x: r.x + pad, y: (r.y ?? 0) + pad, w: r.w - pad * 2, h: r.h != null ? r.h - pad * 2 : undefined });
// Palette from one seed hue (direction.md §5). hsl(h 0-360, s 0-1, l 0-1) → 6-digit hex without '#'.
function hsl(h, s, l) { … }
// WCAG contrast between two hex colors; the ladder is derived by contrast, not by fixed lightness, so a
// luminous hue (green, yellow) darkens its accent and muted steps until the text contrast holds.
function contrast(a, b) { … }
// Lower l from `start` until color(h, s, l) reaches `min` contrast against every background in `against`.
function darkenUntil(h, s, start, against, min) { … }
// Perceived chroma (OKLab, ×1000) of a hex. The same HSL saturation reads as a gray on one hue and as a beige on
// another, so every neutral below is specified by the chroma a reader sees rather than by S.
function chroma(hex) { … }
// neutral(h, l, c): the step at lightness l in hue h carrying c perceived chroma, darkened until it clears `min`
// contrast against every background in `against`. What a reader sees as a gray in the deck's own light.
function neutral(h, l, c, against = [], min = 0) { … }
// The accent hue a seed pairs with (direction.md §5): a cool seed takes a warm accent (navy 225 → coral 15, indigo 250 → gold 40),
// a green or teal seed amber, a berry seed gold, a warm seed teal or navy. Pass accentHue: hue for a single-hue deck
// (swiss-minimal, brutalist, blueprint, a brand that owns one color) or any hue the brief names.
function counterHue(h) { … }
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
// accentMode: where the accent sits against the seed when accentHue is not given — 'complement' (the default: counterHue),
// 'analogous' (seed + 30°), 'split' (counterHue + 30°), 'mono' (the seed itself). warmth (-1..1, default 0) leans every
// neutral (paper, type, lines, marks) toward amber (+) or blue (-) without moving the seed or the accent.
function accentFor(seed, mode) { … }
function warmHue(h, warmth) { … }
function palette({ hue: seed = 205, accentHue: pickedHue, accentMode = 'complement', accentSat = 0.72, accentLight = 0.42, warmth = 0 } = {}) { … } // returns { ink, body, muted, lineSubtle, line, lineStrong, mark, markSoft, paper, paperAlt, tint, dark, darkAlt, onDark, onDarkMuted, onDarkAccent, accent, accentDeep, accentFill, accentLabel, onAccent, state }
const T = { ...palette({ hue: 205 }), display: '', sans: '', light: '', data: '' };
// deck() seeds it from the brief; faces set by typography()
// Type scale (direction.md §6): the reading mode sets the body anchor; every role derives from it.
let MODE = 'balanced';
// presentation 20 · balanced 15 · text 13 (body pt); deck() sets it from the brief
// Anchors from the reference corpus (ten decks, September 2026, text sizes read from the PDFs and normalised to a
// 540 pt canvas): analyst and IR pages set body at 10-14 pt (Naver 10, Kakao 10.5, Bond 11, NVIDIA 13.5, Coatue 14,
// Samsung 16) under a content title of 16-30 pt (median 22) — title / body 1.0-2.1, the hierarchy carried by weight,
// colour, and position more than by size — and their smallest type (sources, axis labels) is 7.5-12. A keynote
// (Sequoia) reads at body 20 under titles of 30-66. Our earlier scale (18 under 36-44) was one step larger than any
// of them and carried a fifth of their copy per page. The runtime floors stay: body 12 pt, one-line chrome 9 pt.
function typeScale(mode) { … } // returns { body, lead, caption, kicker, section, title, cover, hero, stat, poster }
let TYPE = typeScale(MODE);
// Diagram type: labels inside chevrons, nodes, tiers and the notes under them follow the mode (balanced 14 / 11.5).
let DIAG = { label: TYPE.caption + 1, note: Math.max(9.5, TYPE.caption - 1.5) };
// Roles (direction.md §6): a role is size + face + weight + color + leading as one unit, so a caption is the same
// caption on every slide. role('caption') resolves against the current T and TYPE; text() and flow() take a role
// name in place of a size. A role's field may be overridden per box (color on a dark field, align) — the size never.
const ROLES = { poster, hero, stat, cover, title, section, lead, body, prose, strong, caption, kicker, label, note };
function role(name) { … }
// Component specs (composition.md §9): a carrier's anatomy declared once — slots (what it is made of), variants (the
// forms it comes in), definitions (the values every form takes, resolved against the current T, TYPE, and DIAG when a
// helper draws). badge(), callout(), chevrons(), hero() / statBand(), and table() read their sizes, faces, fields, and
// lines here instead of carrying literals, so the same carrier has the same anatomy on every slide; a deck that needs
// a different one redefines the entry once (SPEC.badge.definitions = () => ({ ... })) before the slides, never per call.
const SPEC = { badge, callout, chevrons, stat, table, structure, cards } each { slots, variants, definitions };
function spec(name) { … } // returns { slots, variants, … }
// A spec carrier signs its shape: the receipt reads the name back (composition.md §9) and reports per slide and per deck
// how many of each carrier the deck holds, in which variants, and whether their anatomy (type size and face) stayed one.
const specName = (name, variant = '') => `mixdog-spec:${name}${variant ? `:${variant}` : ''}`;
// tone: the field + type pair a toned carrier takes — neutral ink on tint, accent the mark form of the accent with the
// type that reads on it (Kakao's yellow pill carries dark type; a blue one white), a state its word on its weak field
// (direction.md §5: the solid form never sits under type).
function tone(name = 'neutral') { … } // returns { fill, color }
// Typography roles (direction.md §6). script: 'ko' | 'ja' | 'zh' | 'latin'; pairing: 'serif' | 'weight' | 'concord';
// fonts: 'noto' (provisioned with the Office capability; the default) | 'safe' (Office system faces, when recipients lack Noto).
function typography({ script = 'ko', pairing = 'weight', fonts = 'noto' } = {}) { … }
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
function darkTheme(hue, accentHue = counterHue(hue)) { … }
// The style the brief names (direction.md §3) is mechanical here, not advice: it chooses the page chrome, the corner
// radius, the stroke a rule takes, the motif an anchor repeats, the theme, and whether the accent stays on the seed
// hue. Passed to deck(), two decks of the same content open on visibly different pages; left out, every deck repeats
// one frame — the title at the top left, the body under it, the source at the foot — whatever its brief called it.
// An entry may also carry palette knobs — accentMode ('complement' | 'analogous' | 'split' | 'mono'), accentSat,
// accentLight, warmth (-1..1) — and its type `pairing`; deck() reads them unless the call names its own. None of the
// built-in entries sets a knob, so they keep the counter-hue accent.
// `motifs` is the style's decoration set, not one device: an anchor that names no kind takes the next one, so the
// cover, the section marks, and the closing of one deck are not the same drawing three times (composition.md §3).
const STYLES = { swiss-minimal, editorial, photo-editorial, data-journalism, soft-rounded, dark-tech, glassmorphism, blueprint, brutalist, custom } each { chrome, radius, line, motifs, singleHue, pairing, titleBoost, theme };
const STYLE_DEFAULTS = { chrome: 'bare', radius: 0.08, line: 1, motifs: ['rings', 'arcs'], singleHue: false, theme: 'light' };
let STYLE = { name: 'custom', ...STYLE_DEFAULTS, ...STYLES.custom };
let LINE = STYLE.line;
// the stroke a rule, a hairline, or an outline takes unless its call names one
let MOTIFS = STYLE.motifs;
// the deck's decoration set (STYLES above)
let MOTIF = MOTIFS[0];
// its primary device — the one an anchor takes when it names a kind itself
let MOTIF_AT = 0;
// The next device in the deck's set. `motif(s, '', …)` takes it, so two anchors in a row never carry the same
// drawing; naming a kind (`motif(s, MOTIF, …)`) still wins when the echo is the point (a closing answering its cover).
function nextMotif() { … }
function deck({ style = 'custom', hue = 205, accentHue, accentMode, accentSat, accentLight, warmth, mode = 'balanced', script = 'ko', pairing, fonts = 'noto', titleLines = 1, chrome, theme } = {}) { … }
// Page chrome lives on masters, not on slides: the background and, when the deck wants it, the page number.
// The three masters are defined from the final palette when the first slide is added, never before deck() ran.
function master(name, background, { number = true, color = T.muted } = {}) { … }
let MASTERS = false;
function masters() { … }
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
function gradient(slide, x, y, w, h, stops, angle = 0, { radial = null, shape = S.rect } = {}) { … }
// gradientField: the same gradient under its older name (scripts await it).
async function gradientField(slide, x, y, w, h, stops, angle = 0) { … }
async function png(svg) { … }
// Place an SVG the script drew: the raster is what every reader sees, and the runtime attaches the SVG itself as the
// picture's vector source, so PowerPoint 2016 and later draw it sharp at any zoom (icon() does the same for the set).
// alt: what a reader who cannot see it is told — pptxgenjs otherwise stores the file name, which describes nothing.
async function vector(slide, svg, x, y, w, h, { alt, ...options } = {}) { … }
// Icon by name from the offline set (ICON is injected: 256 Lucide stroke icons — ICON.names lists them; an unknown
// name throws with the nearest), or a 24-unit fill path of your own. d: a size band — glyph 0.3 (inline with a text
// line, a list prefix) · marker 0.45 (a stage or row mark) · disc 0.6 (an icon-led item in its tinted disc) · hero 1.0
// (the one icon a page is about) — or a number, read as the band it fits (composition.md §9). The stroke follows the
// band so a small icon does not close up and a large one does not thin out; the disc is the default from the disc band up.
const ICON_SIZE = { glyph: 0.3, marker: 0.45, disc: 0.6, hero: 1.0 };
const ICON_STROKE = { glyph: 2.5, marker: 2.25, disc: 2, hero: 1.5 };
function iconBand(d) { … }
async function icon(slide, x, y, d, name, { tint = T.paperAlt, color = T.accent, disc, stroke, alt } = {}) { … }
// A row of icon-led items: icon in a disc, bold header, measured description — widths by weight.
// label / detail: role names (default strong / caption); a row that owns the body zone takes lead / body and a larger d.
// The foot guard every block helper shares (R104–R105): a block whose bottom edge would pass the body zone's bottom is
// refused with the shortfall and the fix named — the script stops, the file is not written — instead of being drawn
// over the source line for the review to miss (the review's edge and overlap windows start 0.4 in lower).
function footGuard(name, y, bottom, fix, limit = Z.body.bottom) { … }
async function iconRow(slide, x, y, w, items, { d = 0.6, gap = GUTTER, label: labelRole = 'strong', detail: detailRole = 'caption' } = {}) { … }
// Soft radial glow behind a hero element (dark-tech, cover motif): a native radial gradient on an ellipse.
// PowerPoint measures a path gradient to the far corner of the box, so a two-stop ramp leaves most of the disc at the
// first stop and the glow reads as a flat lit disc with an edge (rendered September 2026); the mid stop pulls the
// fall-off in so both PowerPoint and LibreOffice draw a soft halo.
async function glow(slide, cx, cy, r, color = T.accent, alpha = 0.35) { … }
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
async function orb(slide, cx, cy, d, { light: lit = T.accent, shade = T.dark, glowAlpha = 0.3 } = {}) { … }
// Motif: the deck's device drawn as a vector — rings (concentric circles), rays (diagonal bands), dots (a dot grid),
// arcs (quarter arcs nested on the box's bottom-right corner), waves (contour lines) — at full size on the cover, half
// on a section mark, a corner on the closing (direction.md §3; composition.md §3). One kind per deck, in the accent or
// the on-dark accent at low alpha; it sits behind the type (draw it first), never over it. Returns the placed box.
async function motif(slide, kind = '', x, y, w, h, { color = T.accent, alpha = 0.22, stroke = 3, count = 7 } = {}) { … }

```

## 3. Measured text
`MEASURE` is injected by the runtime with the review's own font metrics; every text box here is sized with it, never by guessing. `lh` is the box's `lineSpacingMultiple` (1 = single); PowerPoint lays every face out at 1.2 em per single line, Hangul and Latin alike. Leading is the author's call per box (`direction.md` §6); the helpers only default it.

**Default — Hangul wraps by the eojeol**: PowerPoint breaks Korean at any character (정답/률, 그라디언/트, a one-syllable last line), so every kit text helper pre-breaks Hangul text where the last whole word fits (`wrapKo`, `wrapRuns`) and writes the break as a soft break (`a:br`) inside one paragraph; a numeral or determiner stays with its noun and a counter or bound noun with its word ("한 분기", "3.5조 원", "할 수"), and a last word left alone under a line of three or more takes the word before it along. Author-written `\n` breaks are kept; a word wider than its zone is left to PowerPoint. **Default — a shrinking box lands on the scale**: `fitSize` steps down through the deck's type scale and diagram sizes (22 → 18 → 14 → 13), never to a free number 1 pt under.

```js

// fitH: the height a box of width w needs for text at size; fitSize: the largest scale step ≤ size that fits w × h.
const fitH = (text, w, size, font = T.sans, { bold = false, lh = 1 } = {}) => MEASURE(text, { font, size, bold, width: w, lineHeight: lh }).height + 0.06;
const lineH = (size, font = T.sans, lh = 1) => size / 72 * 1.2 * lh;
// PowerPoint's single pitch, every face
const textW = (text, size, font = T.sans, bold = false) => MEASURE(text, { font, size, bold }).width;
// Hangul wraps by the eojeol (the space-delimited word), never inside one. The break goes into the text where the
// last whole word fits, measured at 98 % of the zone against the renderer's rounding; author-written breaks stay;
// a word wider than the zone is left to PowerPoint. Latin already wraps at spaces; Japanese and Chinese carry none.
const HANGUL = /[\uAC00-\uD7A3\u1100-\u11FF\u3130-\u318F]/;
const NO_BREAK_BEFORE = /^[,.:;!?%)\]}」』’”…·]/;
// a closing mark never starts a line
// Korean words that belong to their neighbour: a numeral or determiner before its noun ("한 / 분기", "두 / 기능") and
// a short adverb before its verb never end a line; a counter or bound noun after its word ("3.5조 / 원", "할 / 수")
// never starts one; and a number phrase of two words reads as one — a fraction, a date, a time, a sum in two groups
// ("3분의 / 1로" split a cover's claim, "10월 / 14일", "14시 / 30분", "12만 / 6천 원").
const BINDS_FORWARD = /^(?:한|두|세|네|몇|첫|새|옛|각|매|총|약|이|그|저|더|안|잘|못|꼭|또|좀|맨|온|딴|헌)$/;
// 맨 위, 온 가족, 딴 곳, 헌 옷
const BINDS_BACK = /^(?:원|명|개|건|곳|배|수|것|등|때|번|중)[,.:;!?)…]*$/;
const NUMBER_PHRASE = (left, right) => /\d(?:분의|월|시|조|억|만)$/.test(left) && /^\d/.test(right);
const breaksBetween = (left, right) =>
  !NO_BREAK_BEFORE.test(right) && !BINDS_FORWARD.test(left) && !BINDS_BACK.test(right) && !NUMBER_PHRASE(left, right);
const WRAP_MARGIN = 0.98;
function wrapKo(str, w, size, font = T.sans, bold = false) { … }
// A pre-broken string as one paragraph with soft breaks (a:br), so paragraph spacing and bullets stay where the
// author put them; a string without a break passes through unchanged.
const runsOf = (str) => (String(str).includes('\n')
  ? String(str).split('\n').map((line, i) => (i ? { text: line, options: { softBreakBefore: true } } : { text: line }))
  : str);
// runsWith: the wrapped string as runs with one phrase in its own options — the contrast phrase of a headline (11 of
// the 26 measured mock pages set a second phrase of the title in the serif italic or the accent: "Intelligence, / at
// the edge.", a coloured noun in the Korean and Chinese ones; a16z colours the load-bearing noun). The phrase is found
// after wrapping, a break inside it counting as its space, so the run survives the eojeol wrap.
function runsWith(str, phrase, options = {}) { … }
// Inline runs wrapped as one line stream: each word is measured in its own run's face, weight, and size, and the
// break is a soft break before the first word that would cross the zone. Paragraph options (bullet, paraSpaceAfter,
// breakLine) stay on the run that carried them; a run's later pieces carry only its type.
function wrapRuns(runs, w, size, font = T.light) { … }
// wrapKo's runt rule on inline runs: a paragraph's last line of one word takes the word before it along when that
// word ends a piece of the same type, the line above keeps three words or more and stays the longer line, and the
// pair fits the zone. A word in another run's type stays where it is: moving it would change its type.
function prettyEnds(pieces, limit, size, font) { … }
// The sizes a shrinking box may land on: the deck's scale and the diagram sizes, largest first.
const scaleSteps = () => [...new Set([...Object.values(TYPE), DIAG.label, DIAG.note])].sort((a, b) => b - a);
function fitSize(text, w, h, size, font = T.sans, { bold = false, lh = 1, min = 12 } = {}) { … }
// wordFit: the largest scale step ≤ size at which every word of str fits w — wrapKo never breaks inside a word, so a
// word wider than its zone is split by the renderer mid-word; a narrow unit (a satellite, a block) steps down instead.
function wordFit(str, w, size, font = T.sans, bold = false, { min = 12 } = {}) { … }
// glue / unglue: the contrast phrase (emph) travels through the eojeol wrap as one unit when it fits a line, so a
// headline never splits it across two lines ("첫 / 분기 흑자"); the no-break spaces are restored after the wrap.
const NBSP = '\u00A0';
// Japanese and Chinese carry no spaces and break between any two characters, so a no-break space cannot hold the
// phrase: "夜が変わると、昼の道路が / 空いた" split the contrast phrase. The line it would cross ends before it instead.
const KANA_HAN = /[\u3040-\u30FF\u3400-\u9FFF\uF900-\uFAFF]/;
function glue(str, phrase, w, size, font = T.sans, bold = false) { … }
const unglue = (s) => String(s).split(NBSP).join(' ');
// The general measured text box. Returns the bottom edge so the next element registers under it.
// size is a number or a role name ('caption', 'label', …): a role brings its face, weight, color, and leading;
// any of them may be overridden per box. Numeric size defaults: light face, lh 1.2 for lead size and above, 1.35 under it.
function text(slide, str, x, y, w, size, { color, font, bold, align = 'left', valign = 'top', lh, h, size: sizeOverride, objectName } = {}) { … }
// Title: display face, bold; the size steps down the scale (to 24) when the text would need more than maxLines. Returns the bottom edge.
// emph: one phrase of the title in the accent (composition.md §8 — a claim page's title, not every title).
function title(slide, str, { x = M, y = 1.0, w = W - 2 * M, size = TYPE.title, color = T.ink, align = 'left', maxLines = 2, lh = 1.15, emph = '', emphColor = T.accent } = {}) { … }
// Kicker: a real section or topic name above a title. Latin gets tracking (charSpacing); Hangul never does.
// The first kicker a page sets is the row the page's marks share: dateline() hangs its meta on it, so the corner
// marks of a display() page (its kicker 0.4 in lower than a head() kicker) sit on one line, not 12 pt apart.
const KICKER_ROW = new WeakMap();
function kicker(slide, str, x = M, y = 0.6, color = T.accent, w = 6, align = 'left') { … }
// Paragraphs of inline runs: [[['plain ', {}], ['42%', { bold: true, color: T.accent }], [' of users', {}]], [...next paragraph]].
// The body sits in the light face; an emphasized run switches to the sans or bold so weight carries the emphasis.
// `{ mark: true }` on a run sets it on the accent fill as a marker highlight (a16z's chapter claims, Coatue's key
// phrases): the load-bearing phrase of a claim, once per page, never a whole sentence.
// PowerPoint lets a mixed-weight Korean line overshoot its box by 2-4 pt; the box carries a 7 pt right inset so the text zone stays w.
function emphasis(slide, paragraphs, x, y, w, h, size = TYPE.lead, color = T.body, { lh = 1.35, font = T.light } = {}) { … }
// Hero numeral with its label bound under it (GAP.bind). scale: 'hero' (default) | 'poster' | 'band' (one of several peers,
// statBand()) — the size is the scale's (TYPE.hero / TYPE.poster / TYPE.stat through SPEC.stat); size overrides with a TYPE.* value only.
// minH: the numeral box's floor (1.12 in — the hero and band rows the reference pages measure); a card (cards()) passes
// a smaller one so the figure sits close under its opener.
function hero(slide, x, y, w, value, label, { scale = 'hero', size, color, unit = '', labelColor, labelSize, minH = 1.12 } = {}) { … }
// A genuine list: one text box, bullets on each item, a paragraph step visibly larger than the line step.
function bullets(slide, x, y, w, h, items, size = TYPE.body, color = T.body, { lh = 1.35, font = T.light } = {}) { … }
// Prose: h is the ceiling; the size steps down the scale (to 12) until the text fits it.
function prose(slide, str, x, y, w, h, size = TYPE.body, color = T.body, { lh = 1.45, font = T.light } = {}) { … }
// Caption / source line under a figure or picture: caption size, muted, registered to the figure's left edge.
function caption(slide, str, x, y, w, color = T.muted) { … }
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
function readingH(w, blocks, { gap = GAP.between, size = TYPE.body, lh = 1.4 } = {}) { … }
function reading(slide, x, y, w, blocks, { bottom = Z.body.bottom, gap = GAP.between, size = TYPE.body, lh = 1.4 } = {}) { … }
// Takeaway band: one sentence closing a page that has a claim to close; sits near the lower safe margin. The band is
// the deck's dark field with the sentence in the on-dark face, bold — the one saturated object on an evidence page after
// the accent, so the conclusion has the presence of the chart it closes (a light tint read as a footnote).
function takeaway(slide, str, y = Z.foot.takeaway, { x = Z.body.x, w = Z.body.w, h = 0.7, tint = T.dark, color = T.onDark, bold = true } = {}) { … }
// Specimen: the subject drawn, not described. rows: [{ text, font, size, bold, label, color }] on one baseline grid.
function specimen(slide, x, y, w, rows, { labelW = 1.6, gap = GAP.between, labelColor = T.muted } = {}) { … }
// Ghost numeral: a chapter mark behind content. Keep the box inside the canvas (w ≤ W - x).
function ghost(slide, str, x, y, size = 240, w = 5.5, { color = T.onAccent, transparency = 88 } = {}) { … }
// Typographic poster: the anchor a deck without pictures has — one phrase set at poster scale on the dark or accent
// field (Sequoia's section pages, Naver's green cover, the a16z chapter openers), a kicker above it, one line under it.
// The phrase is content (the section's claim, what the number means), never a label; it steps down the scale until it
// fits w in at most `maxLines` lines. The colours follow the field the page stands on — the on-dark pair on dark() /
// quiet() or under a painted full-canvas field, T.ink on paper — so a poster is never white type on white paper.
// Returns the bottom edge.
// emph: one phrase of the poster in the accent (emphColor) — the contrast phrase of the mock headlines (runsWith).
function poster(slide, str, { x = M, y = 1.6, w = W - 2 * M, size = TYPE.poster, maxLines = 3, color, kicker: k = '', kickerColor, line = '', lineColor, lineSize = TYPE.lead, lineLh = 1.3, font = T.display, lh = 1.05, emph = '', emphColor } = {}) { … }
// Balanced wrap (CSS text-wrap: balance) for a short display line: the narrowest measure that keeps the line count,
// so a two-line deck line splits evenly — "캐나다 로키 · 요세미티 · 시카고 11박 / 12일" left one word stranded under a
// full line. Returns the text with its breaks written in; the box keeps its own width.
function balanced(str, w, size, font = T.light, bold = false) { … }
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
// The colours are poster()'s: they follow the page's field, so display() on quiet() or dark() sets the on-dark pair
// (fixed paper defaults drew T.ink on the quiet page at 1.08:1 and the cover read as a blank dark slide).
function display(slide, str, { x = M, y = Z.head.display, w = (W - 2 * M) * 0.6, size = TYPE.cover, maxLines = 2, color, kicker: k = '', kickerColor, line = '', lineColor, lineSize = TYPE.body, lineLh = 1.35, font = T.display, lh = 1.1, emph = '', emphColor } = {}) { … }
// Dateline: the running meta at the top-right corner (a date, a document number, the section) in the data face at
// kicker size, muted — the fourth corner of the frame the mock pages close (a mark top-left, meta top-right, the
// source bottom-left, the page number bottom-right: their ink box spans 0.8-1.0 of the canvas against 0.68-0.8 on our
// text pages). One per page at most, only when the page has a real date or number to carry; the 'bands' chrome
// already puts the kicker in that corner. A date reads as chrome to the facts gate (2026.09, 2026-09-12, 2026년 9월);
// a document number that looks like a figure ("No. 0073") needs its fact like any other.
function dateline(slide, str, { y = KICKER_ROW.get(slide) ?? Z.head.kicker, w = 3.6, color = fieldOf(slide) === 'paper' ? T.muted : T.onDarkMuted } = {}) { … }
// Section numeral: the a16z chapter opener — the section's number at 200 pt or more in the on-dark accent, the
// section's claim beside it at section scale, one line under. The numeral says where the deck is; the claim carries
// the content, so the page is never a numeral alone. On dark() / quiet() with the defaults; on paper pass
// color: T.accent, claimColor: T.ink, lineColor: T.body. Returns the bottom edge.
function numeralBeat(slide, value, claim, { x = M, y = 1.4, w = W - 2 * M, size = 220, color, claimColor, line = '', lineColor } = {}) { … }

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
function zones(mode = MODE, { titleLines = 1, chrome = CHROME } = {}) { … } // returns { chrome, head: { kicker, top, display, bottom, band }, body: { top, bottom, x, w }, foot: { takeaway, source, band }, seam, rail: { x, w }, main: { x, w }, plane: { x, y, w, h } }
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
function head(slide, kickerText, titleText, { size = TYPE.title, color, kickerColor, w = Z.body.w, x = Z.body.x, sub = '', emph = '', emphColor } = {}) { … }
// foot: the foot of a page carries the source line and the page number on the open canvas — no field under them in
// either chrome (no reference deck tints its foot). Kept as the one place a page registers its foot, so source() and a
// full-bleed carrier still call it.
let FOOTED = new WeakSet();
function foot(slide) { … }
// source: the running source line on the foot; never moves. It stops short of the page number.
// The foot follows the chrome's column too: on a plane the source line starts beside the plane, not on it. A page drawn
// on the open canvas left of that column (a display() or poster() at the margin) keeps its foot on its own column:
// under the rail chrome the cover's source sat on the rail's main column, 3.9 in right of every other line on it.
const PAGE_COLUMN = new WeakMap();
function source(slide, str, { color = T.muted, x = PAGE_COLUMN.get(slide) ?? Z.body.x, w } = {}) { … }
// Content weight of a peer: an explicit `weight`, else the length of what it says; an active peer counts more.
const weightOf = (item, { active = false } = {}) => (Number(item?.weight)
  || Math.max(1, [item?.value, item?.label, item?.detail, item?.context, item?.text].filter(Boolean).join(' ').length)) * (active ? 1.35 : 1);
// spans: widths for a row of peers from their weights, clamped so the lightest stays readable and the heaviest does not swallow the row.
function spans(x, w, weights, { gap = GUTTER, minRatio = 0.7, maxRatio = 1.6 } = {}) { … }
// The axis a run of peers hangs on: mid(c) is one column's centre, band(cols, from, to) the region a bracket, a
// band, a rule, or an arrow spans across them. **A mark that belongs to a run takes its position from these** —
// spans() widths are weighted, so the centre of a run is never W / 2 and a hand-typed coordinate lands a few points
// off the axis its neighbours share (the runtime reports it as `axis_drift`).
const mid = (c) => c.x + c.w / 2;
const band = (cols, from = 0, to = cols.length - 1) => ({ x: cols[from].x, w: cols[to].x + cols[to].w - cols[from].x });
// splitAt: the seam of a two-plane slide from each side's weight; never the middle unless the weights are equal.
// Returns { left: { x, w }, right: { x, w } } — two named planes, not the array spans() returns for a row of peers.
function splitAt(x, w, leftWeight, rightWeight, { gap = GUTTER, min = 0.38, max = 0.62 } = {}) { … } // returns { left: { x, w }, right: { x, w } }
// shareDown: the vertical seam of a page that stacks a structure on a stage over a reading row (columns, a ruled
// list) — the row is measured first (columnsH, readingH) and the stage takes what is left between the
// body top and the foot, never a guessed 2.2 in that the render then reports as a hollow field or an overflow.
// Returns { stage: { y, h }, under: { y, h }, slack }: the stage's box, the row's box a between step under it, and
// the slack a maxStage cap left (0 without a cap). A structure with a natural height (a timeline, a step run at
// blockH) centres in a taller stage with its `h` option; lanes and steps spend the whole h. minStage is the floor
// under which the structure stops reading as the carrier (composition.md §6: a quarter of the canvas) — cut the
// row or move it to a rail instead of shrinking the stage.
function shareDown(top, underH, { bottom = Z.body.bottom, gap = GAP.between, minStage = 2.2, maxStage = Infinity } = {}) { … } // returns { stage: { y, h }, under: { y, h }, slack }
// Stat band: several numbers with one cause on one baseline (composition.md §4) — value (+ unit) over label over detail
// per peer, widths by weight, one rule under the band. stats: [{ value, unit?, label, detail?, weight? }]. Returns the
// bottom edge (under the rule). Anatomy from SPEC.stat at the band scale; scale: 'hero' for two or three large peers.
// The label is one line (the mock KPI strips run 9-11 px labels of two to four words under 32-58 px numerals): a label
// that wraps in its column reads as body text at caption size and the review reports small_font — move the rest to
// detail, or shorten it. Under a display() headline the band takes the headline's measure, not the full width.
function statBand(slide, x, y, w, stats, { scale = 'band', gap = GUTTER, ruled = true, bottom: limit = Z.body.bottom } = {}) { … }
// Cards: the KPI / bento row — several numbers that each own a frame (a dashboard, a product's key figures; the mock
// KPI cards, apple-bento-grid's stat cards). A grid of equal fields with one gap, every cell filled (a short last row
// widens its cards to the row's edge — the bento rule: no empty cell), one accent card at most (the figure the page
// is about; the rest sit on the tint). items: [{ value, unit?, label, detail?, badge?, icon?, accent? }] — a badge or
// an icon opens the card, the value at the band scale under it, the label bound, the detail as a caption. columns
// default min(4, n); h per card: a card carries an opener or a detail in a two-row grid (h ≈ 2.0 in a 4 in body),
// both only in a one-row grid (h ≥ 2.4) — the stack is opener 0.3 + value 0.7 + label 0.3 + detail 0.3 with the
// ladder's gaps inside PAD. Returns the bottom edge.
async function cards(slide, x, y, w, items, { columns, h = 2.2, gap } = {}) { … }
// flow: measured blocks stacked top-down inside one region; returns the bottom. A block is
// { text, role?, size?, font?, bold?, color?, lh?, h?, after? } or a function (y) => bottom for any kit call.
// The step after a block is GAP.within (it binds to the next: a heading over its paragraph); a block that closes a
// group says after: GAP.between. A block that would cross the region's bottom throws (never a silent drop):
// widen the zone, shorten the copy, or cut a block.
function flow(slide, x, y, w, blocks, { gap = GAP.within, bottom = H - M } = {}) { … }
// stack: a vertical flex for one region (composition.md §6, "fill the frame"). Blocks are flow blocks, plus
// { flex: (y, h) => void } for the one element that takes whatever height the measured blocks leave (a chart,
// a picture, a diagram), { spacer: true } for a flexible gap that hangs everything after it on the region's
// bottom, and { h, draw: (y, h) => void } for a fixed-height device. justify 'fill' (default) gives
// the leftover to the flex block; 'between' spreads it into the gaps when there is no flex block. The bottom is
// the zone's, so the column reaches the foot instead of stopping where the measure ran out. Returns the bottom.
function stack(slide, x, y, w, blocks, { bottom = Z.body.bottom, gap = GAP.within, justify = 'fill' } = {}) { … }

```

## 5. Shapes (native, editable in PowerPoint)

```js

function field(slide, x, y, w, h, tint = T.paperAlt, shape = S.rect, extra = {}) { … }
// Outline carrier: no fill, one coherent stroke (the strong line — it owns the region) — ownership without a heavy card.
function outline(slide, x, y, w, h, { color = T.lineStrong, width = LINE, shape = S.rect, radius = 0, dash = 'solid' } = {}) { … }
// Badge / chip: compact status, tag, or category label. tone: neutral (ink on tint) · accent (white on the accent, the one
// emphasized chip) · a state (its word on its weak field). Anatomy from SPEC.badge; h null takes the spec's height.
function badge(slide, x, y, w, h, str, { tone: toneName = 'neutral', fill, color, font, size } = {}) { … }
// Horizontal rule: T.line at a section boundary (default), T.lineSubtle between repeated items, T.lineStrong as a frame edge.
// Each rule is remembered per slide, so a block that opens on a rule can see one already standing just above it.
const HAIRLINES = new WeakMap();
function hairline(slide, x, y, w, color = T.line) { … }
// A rule within one gap above y that spans the same run: statBand() closes on a rule, and columns() under it opened on
// its own, two parallel hairlines a gap apart that read as a drawing mistake.
const ruledAbove = (slide, x, y, w) =>
  (HAIRLINES.get(slide) || []).some((r) => y - r.y >= -0.01 && y - r.y <= GAP.between + 0.01 && r.x <= x + 0.05 && r.x + r.w >= x + w - 0.05);
function rule(slide, x, y, h, color = T.line, width = LINE) { … }
function connector(slide, x1, y1, x2, y2, { color = T.mark, width = 1.5, arrow = 'triangle', dash = 'solid' } = {}) { … }
// Chevron run: each tip enters the next notch. widths: per-stage spans from spans() (weights), else equal — equal only when
// the stages carry equal weight. Anatomy from SPEC.chevrons (notch, face, size, the default and active stage).
function chevrons(slide, x, y, w, h, labels, { active = -1, widths = null, size } = {}) { … }
function node(slide, cx, cy, d, str, { fill = T.accentLabel.fill, color = T.accentLabel.color, size = DIAG.label } = {}) { … }
function brace(slide, x, y, h, side = 'left', color = T.mark) { … }
// Block-arc segment around (cx, cy): angles in degrees clockwise from 3 o'clock (270 = 12 o'clock). thickness 0-1 of the radius.
// The swept angle is what a reader measures, so it comes from end - start before the shape's angles wrap: a full turn draws a
// closed ring (a wrapped 360 would land on its own start and read as empty or full by renderer luck) and a zero sweep draws nothing.
function arc(slide, cx, cy, r, start, end, { color = T.accentFill, thickness = 0.28 } = {}) { … }
// Gauge: one proportion (share 0-1) with the value on a solid disc in the middle. A share past 1 reads as a full ring (the value
// text carries the overshoot: 112% is a closed ring labelled 112%), and 0 leaves the track empty.
function gauge(slide, cx, cy, r, share, value, label, { track = T.paperAlt, disc = T.paper, valueColor = T.ink, labelColor = T.muted } = {}) { … }
// Callout: an annotation attached to a region. tone: neutral (paper field, strong outline) or a state (its weak field, its
// word); form: 'wedge' (the pointer) or 'plain'. Anatomy from SPEC.callout.
function callout(slide, x, y, w, h, str, { tone: toneName = 'neutral', form = 'wedge', size } = {}) { … }
// Custom silhouette: diagonal cut field or any polygon, points in inches relative to the box.
function polygon(slide, x, y, w, h, points, fill = T.dark) { … }
// Depth is one shadow, spent once: the elevated object of a page (lift) and the active unit of a structure (§6) share
// it, so depth always says "this one" — a diagram language draws a shadow on any shape as a style (D2's `shadow`),
// a frontier page spends it on the state.
// LIFT() returns a fresh object every time: pptxgenjs rewrites the shadow it is handed in place, so one shared object
// used on a second shape carried already-converted values and the file no longer opened.
const LIFT = () => ({ type: 'outer', color: '000000', blur: 12, offset: 4, angle: 90, opacity: 0.10 });
// The one elevated object on the slide (peers stay flat).
function lift(slide, x, y, w, h, tint = T.paper, { radius = RADIUS } = {}) { … }
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
function stage(slide, x, y, w, h, { tint = T.paperAlt, pad = PAD } = {}) { … } // returns { …, cx, cy, r, ground, share }

```

Other presets: `S.round1Rect`, `S.snip1Rect`, `S.snipRoundRect`, `S.trapezoid`, `S.parallelogram`, `S.hexagon`, `S.frame`, `S.corner`, `S.pie` + `angleRange`, `S.donut`, `S.rightArrow`, `S.leftArrow`, `S.downArrow`, `S.leftRightArrow`, `S.bracePair`, `S.triangle`; `rotate` and `flipH` apply to all.

## 6. Structures — relationship carriers (composition.md §4)
A structure is the geometry a relationship atom takes: an order on a spine, a hub with its satellites, levels on one taper, items on two axes. Each helper draws one structure inside a region the author chose — spine first, nodes at content-driven positions, connectors only where a link is real, labels registered to their unit (composition.md §5) — and returns the bottom edge. None draws a title, a kicker, or a takeaway: the page stays the author's, and the structure is the carrier the page hangs on, at a quarter of the canvas or more (composition.md §6). Every label reads `SPEC.structure` (one node size, one edge, one label face) and signs its kind, so the receipt reports which structures a deck used (`receipt.deck.specs.structure.variants`) and a deck that repeats one kind on every page can see it. A stage is a string or `{ label, detail?, active?, weight?, icon? }`; `active` is the one state the page is about, never a habit. A unit of a hub, a step run, or a merge carries what a frontier node carries — an icon from the set over (or before) the label, the detail under it when the unit is tall enough, and the active unit alone raised on the page's one shadow (`LIFT`) — so the structure reads as objects with a hierarchy, not as labelled discs; the reference diagrams (the mock galleries, Coatue's process page) put an icon and a line of detail in every node and spend depth on one. A lane's unit and a quadrant's item carry the same face (the icon before the label in a lane, a marker disc with the icon at the position in a quadrant, a detail under the label). `hub()`, `steps()`, `merge()`, `lanes()`, and `quadrants()` draw the icons, so they are awaited for their bottom edge.

```js

const stageOf = (st) => (typeof st === 'string' ? { label: st } : st);
// A unit's face: the optional icon at glyph size in the state's type colour, the label in the spec face, the detail as
// a note under it when the unit is at least an inch tall. layout: 'stack' (icon over the label — a disc) | 'row'
// (icon before the label — a block). One text box carries the label and the detail, as labelBlock does.
// The size a unit's label is set at, from `size` down the scale: a word wider than the unit is broken inside the word
// by the renderer ("신용관 / 리" in a 1 in satellite), so the longest word fits; in a stack the label hangs from the
// centre axis and has the lower half of the disc ("고객 지원" set in two lines under an icon ran 9 pt past a 1 in
// satellite), so its lines fit that half, down to 10 pt.
function unitLabelSize(s, lw, h, size, { stack = false, font = spec('structure').font, bold = true } = {}) { … }
async function unitFace(slide, x, y, w, h, kind, s, { state = 'default', layout = 'stack', size, color, iconD = ICON_SIZE.glyph } = {}) { … }
// A structure's label: the spec face and size, the state's color, wrapped by the eojeol, signed with its kind.
function slabel(slide, str, x, y, w, h, kind, { state = 'default', color, bold = state === 'active', align = 'center', valign = 'middle', size, font } = {}) { … }
// A label with its detail under it in one text box (the label bold in the spec face, the detail a note); the height
// is measured first so a structure can reserve the room before it draws. labelBlock returns the bottom edge.
// With a detail the block carries a 2 pt paragraph step and two sizes in one box, which the renderers measure a few
// points taller than the sum of the lines — the allowance keeps the LibreOffice read inside the box.
const labelBlockH = (w, label, detail) => …;
function labelBlock(slide, x, y, w, kind, label, detail, { state = 'default', align = 'left', valign = 'top' } = {}) { … }
// Timeline: a level order on one spine — nodes at content-driven x (widths by weight), labels alternating above and
// below the spine so long labels never collide; y is the top of the region, the spine sits under the upper labels.
// A node is a dot unless the stage names its `when` (a date, a version); numbering is the author's call and carries
// information only when the order does. Returns the bottom edge. `h`: the stage's height — the timeline's natural
// block (upper labels, spine, lower labels) is centred in it, so a stage sized by shareDown() carries the spine
// through its middle instead of a spine pinned to the top and a hollow field under the labels.
function timeline(slide, x, y, w, stages, { alternate = true, labelW = 3.0, ground = T.paper, h } = {}) { … }
// Steps: a rising (or falling) order on a diagonal — each block one tread up from the last, connectors edge to edge.
// A block carries its icon before the label and its detail under it (blockH 1.3 leaves the room); the active block
// stands on the page's shadow. Awaited for the bottom edge.
async function steps(slide, x, y, w, h, stages, { rising = true, blockH = 1.3, ground = T.paper } = {}) { … }
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
async function hub(slide, cx, cy, center, satellites, opts = {}) { … }
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
function loop(slide, cx, cy, r, stages, opts = {}) { … }
// Merge (many into one) or split (one into many): the many in a column, the one vertically centered on the other side,
// connectors from unit edge to unit edge across the region. side: 'merge' (many on the left) | 'split' (many on the right).
// Each of the many carries its icon before the label (a unit an inch tall carries its detail too); the active one
// stands on the page's shadow; the one is a string or a stage. Awaited for the bottom edge.
async function merge(slide, x, y, w, h, many, one, { side = 'merge', colW = 3.2, oneW = 3.2, unitH = 0.9 } = {}) { … }
// Tiers: levels of one hierarchy on one taper — the top tier the narrowest, widths monotonic, labels inside.
// taper: the top edge as a share of the base width.
function tiers(slide, x, y, w, h, stages, { taper = 0.45, gap = SPACE.hair } = {}) { … }
// Swimlanes: who does what, when — lanes sharing seams, each unit at its lane and its span of the track (`at`, `span`
// in 0-1 of the track width). rows: [{ name, items: [{ label, at, span, active?, icon?, detail? }] }].
// A unit carries its icon before the label (a bar with a glyph reads as a task, a bare bar as a span); `unitH: 1.0`
// gives it the room for its detail; the active unit alone stands on the page's shadow. Awaited for the bottom edge.
async function lanes(slide, x, y, w, h, rows, { labelW = 1.6, unitH = 0.7 } = {}) { … }
// Quadrants: items on two axes — one field with two rules crossing at the threshold, the axis names at the rules'
// ends, the quadrant names in the corners, each item a dot at its values with its label beside it. An item with an
// `icon` is a marker disc carrying it (the frontier 2×2 puts a logo or a glyph at every position, never a bare dot),
// and a `detail` is the note under its label; the active icon item alone stands on the page's shadow. Awaited for the bottom edge.
// axes: { x: [low, high], y: [low, high] }; at: the threshold in 0-1 (the middle by default); names: four corner
// names in reading order (top-left, top-right, bottom-left, bottom-right); items: [{ label, x, y, active?, icon?, detail? }] in 0-1.
async function quadrants(slide, x, y, w, h, { axes = { x: ['', ''], y: ['', ''] }, at = [0.5, 0.5], names = [], items = [] } = {}) { … }
// Overlap: shared and separate meaning — two or three translucent ellipses, each set named toward its outer side, the
// shared meaning in the common region. Returns the bottom edge.
function venn(slide, cx, cy, sets, { d = 3.0, overlap = 1.1, shared = '' } = {}) { … }
// Quote: someone else's words — an oversized mark in the accent, the quote at reading scale beside and below it, the
// attribution under. Returns the bottom edge.
function quote(slide, x, y, w, str, attribution, { size = Math.round(TYPE.lead * 1.3), color = T.ink, mark = 120 } = {}) { … }
// Agenda: the section beat the way Coatue and consulting decks draw it — the deck's sections listed on the dark field
// (quiet() or dark()), the current one lit (onDark, bold, a short rule in the on-dark accent before it), the others
// onDarkMuted at a step down, the step between them the only separator (a full-width rule under a line of type reads
// as an underline, composition.md §10) — so a reader sees where the deck is without a numeral that carries no
// information. items: the section names; active: the index of the one this beat opens. Returns the bottom.
function agenda(slide, items, active, { x = M + 0.4, y = 1.6, w = W - 2 * M - 0.8, gap = GAP.between, size = TYPE.section } = {}) { … }
// Ruled list: the Sequoia text page (a third of its 52 pages) — a short label at the left names the frame ("Prepare
// your mind", "Leadership principles"), a vertical rule, and three to six short lines at lead size beside it, the
// content. One per page, or two stacked a between step apart; the lines are one text box. Returns the bottom edge.
function ruledList(slide, x, y, w, label, items, { labelW = 2.6, size = TYPE.lead, lh = 1.6, color = T.body } = {}) { … }
// Columns: two or three text columns on one top line (Naver's reading beside its chart, the Sequoia 2×2 without
// boxes, the Coatue principles page) — a hairline over the row, a bold title over a short paragraph or a list in
// each column, widths by weight. cols: [{ title, text | items, weight? }]. Returns the bottom edge.
// columnsH: the height a columns() row takes at these options, measured before the page is shared out (shareDown
// gives the stage above it what the row leaves). columns() measures with the same function, so the two agree.
// A column's prose is `text`; `body` is the same line under another name (the template fill and the page plans call
// it that), so a column written either way draws the same and neither spelling is dropped in silence.
const columnProse = (c) => c.text ?? c.body ?? '';
const columnHeights = (track, cols, { size, lh, ruled }) => …;
function columnsH(x, w, cols, { gap = GUTTER, size = TYPE.body, lh = 1.5, ruled = true } = {}) { … }
function columns(slide, x, y, w, cols, { gap = GUTTER, size = TYPE.body, lh = 1.5, ruled = true, bottom: limit = Z.body.bottom } = {}) { … }
// Brace groups: named groups of items in one column — each group's items one text box, a brace spanning them at the
// left, the name at the brace tip; no boxes. groups: [{ name, items: [] }]. Returns the bottom edge.
function braceGroups(slide, x, y, w, groups, { labelW = 1.7, size = TYPE.body, lh = 1.5 } = {}) { … }

```
# charts.md

## Native charts and tables

Read this file when the slide plan names a chart or table carrier. The runtime
loads its code after `kit.md`, so the script calls these helpers without
pasting them; they depend on the kit's tokens, measurement, text, and shape
primitives. Data remains editable in PowerPoint.

```js

// Chart text belongs to the deck's reading scale. Assign colors to meanings
// explicitly (for example prior year neutral, current year accent), not series order.
// type: col | bar | line | area | doughnut | radar | scatter | bubble (composition.md §9 maps the relationship to the form).
// series: [{ name, values }], labels: categories. scatter/bubble take pptxgenjs' own shape: series[0] = { name: 'X', values },
// then { name, values[, sizes] } per set; labels unused. accent: with several series (bars or lines), the index of the
// series the title names, which alone takes the accent (default the last); with one series of bars, the index of the one category to color —
// drawn as two stacked series here, merged by the runtime into one series with a per-point fill, so "Edit data" shows one column.
// Its default is the last category: the reference IR and analyst charts (Samsung, Kakao, Naver, Sequoia, September 2026)
// draw every bar in a light gray and the current period — the bar the title is about — in the bright accent, with dark
// value labels above the bars and no axis or grid; accent: null draws one gray series, accent: i names another category.
// Colours by meaning, not by series order: the accent goes to the series or bar the title names, gray to the rest.
// overlap: true draws a bullet — series[0] the track or target (muted), series[1] the actual (accent), bars laid over each other.
// note: { at, text } annotates one column (single-series 'col' only): the plot area is pinned (PLOT) so the bar's
// position is known, a leader rises from above its value label to a short label at the top of the frame.
// Stacked-bar labels must sit inside ('inEnd' | 'ctr' | 'inBase'); zero segments are hidden by the format code.
const PLOT = { x: 0.03, y: 0.14, w: 0.94, h: 0.72 };
// plot area as fractions of the chart frame when a note pins it
// field: a tint under the plot area (a16z draws every chart on a grey field so the plot reads as one object on the
// page — its largest; the IR decks leave it on the paper): `field: T.paperAlt` for the a16z reading, none by default.
// axis: how the reader gets the values. 'labels' — every mark carries its value and the value axis is hidden (the IR
// pages: one series, up to six categories). 'grid' — the data-journalism reading (the FiveThirtyEight, Urban Institute
// and LA Times chart themes, measured September 2026: a value axis in the muted colour at 10-12 pt, thin horizontal
// gridlines in a pale grey, no label on every mark, the category baseline drawn): more categories or several series,
// where a label on every bar is noise. Default by the data: labels for one series of ≤ 6 categories (a line of ≤ 8
// points), grid otherwise; stacked forms keep their inside labels.
// The label format defaults to the data's own precision (up to two places): '#,##0' printed a 0.4-1.8% failure rate
// as 0, 1, 2, 0 — a line whose every label contradicted its title.
function valueFormat(values) { … }
function chart(slide, x, y, w, h, { type = 'col', labels, series, accent, overlap = false, max, min = 0, format, size = TYPE.caption + 1, note = null,
  colors, legend, legendPos = 'b', plot, categoryLabels = true, showValues = true, grouping = 'clustered',
  valueColor = T.body, categoryColor = T.muted, field = null, axis = null } = {}) { … }
// Waterfall: native stacked columns — an invisible base (the surface color) carries each bar to its running start.
// steps: [{ label, value }] with a negative value for a drop, and { label, total: true } for a closing bar at the running total.
// Values stay editable; the closing figure is labeled by the author (a hero or a takeaway), not by the chart.
// The walk reads as up to three kinds of bar, each kind it draws named where the chart starts: the totals (the opening
// figure and any { total: true } step) in the dark neutral, the rises in the accent, the drops in the light neutral — and every bar
// carries its figure (+380, −120, 4,200) over it, so the change is read from the number, not from the colour alone.
// The first step is the opening total. names: the legend words; Korean or English by the labels' script.
// Returns the bottom edge, like every other carrier, so a reading registers under it.
function waterfall(slide, x, y, w, h, steps, { size = DIAG.note, surface = T.paper, format = (v) => Number(v).toLocaleString('en-US'), names, floor } = {}) { … }
// Dumbbell: two values per item joined by a rule — before/after, plan/actual, min/max. rows: [{ label, a, b }]; a muted, b accent.
// Drawn with rules and dots (not bars), so it is a diagram of two points, never a picture of a bar chart.
function dumbbell(slide, x, y, w, rows, { min, max, labelW, rowH = 0.6, format = (v) => String(v), size = TYPE.caption } = {}) { … }
// Small multiples: n identical charts on one row, one label above each, shared axis range. The panels are the same
// shape across groups, so the categories are usually one row-wide `labels` — a panel may still carry its own.
// A panel names itself with `label` (or `title`); without categories the row is refused here, with the fix named,
// instead of failing inside the chart call on a missing array.
function smallMultiples(slide, x, y, w, h, panels, { type = 'col', max, gap = GUTTER, format, labels = null } = {}) { … }
// The table's pitch: the type and the row height one table takes — dense sets the caption step (never under 12 pt) at
// 2.0 × its size, the default the body step at SPEC.table's 2.2 ×. table() and tableRows() read the same pair.
function tablePitch(dense = false, size) { … } // returns { size, rowH }
// tableRows: how many body rows a height holds at the table's pitch (one header row plus the body) — decided at plan
// time so the table's granularity fills its column (monthly rows instead of quarterly, every division instead of the
// top three, `tableRows(avail(top))` rows) rather than three rows over a bare field: the reference tables run ten to
// fifteen rows in the body column, and a table that stops at a third of its column is the page's largest object only on paper.
function tableRows(h, { dense = false, size } = {}) { … }
// tableColW: the widths a table takes when the author names none — the rule a Word or PDF table follows. Equal columns
// while every cell fits its column on one line; otherwise each column its longest line and the rest shared evenly, or,
// when the lines cannot all fit, its longest word, then its whole line for a column whose line costs no more than an
// even share of what is left (cheapest first), and the remainder where the text is longest. Equal columns broke
// "서울 중앙 허브" over three lines beside four columns of short figures and ran the table into its source line.
// `measure(text, row, column)` is one line's width in inches, padding included; row -1 is the header.
function tableColW(matrix, w, measure) { … }
// A table is a readable page object, not a tiny appendix squeezed below a chart.
// Anatomy from SPEC.table (row pitch 2.2 × body — the Kakao and Samsung IR tables run 1.9-2.1 × their type): the header
// on the basement surface, row rules in the subtle line (repeated items), the verdict column bold on the tint — or, with
// tones: ['positive', 'warning', ...] one per body row, each verdict word on its state's weak field in its state text.
// Numbers align right on their own (a cell that reads as a figure — "2,028", "-14%", "4.3%pt", "1.6배"); the header
// above a numeric column aligns with it; alignments[j] overrides. The reference IR devices: highlightCol outlines the
// current-period column in the mark form of the accent (Samsung's navy box, Kakao's red one); groupRows (zero-based
// body rows) set a total or subtotal row bold on the basement surface; subRows indent a child row and mute it.
// The grouped IR table (LG 2Q25 p.3, measured September 2026: five divisions × Sales / OP / margin = 15 body rows on
// the right half of the page at 2.0 × the type, the current quarter's column tinted with its header in the accent,
// a stronger rule between groups): `groups: [{ name, sub?, rows: [[...cells without the first column]] }]` builds the
// body — the group's name spans its rows as one merged cell (its `sub` under it in the muted face), the rows inside
// a group are separated by the subtle rule and the groups by the section rule. `dense: true` sets the type to the
// caption step (never under 12 pt) and the pitch to 2.0 × — ten to fifteen rows in the body column, the reference
// density. `highlightStyle: 'filled'` tints the highlighted column's body cells and paints its header in the accent
// (LG, Samsung); 'outline' (the default) draws the four rules alone (Kakao).
function table(slide, x, y, w, header, rows, { colW, rowH, verdict = -1, tones = [], size,
  headerFill, headerColor, banded = false, alignments = [], highlightRows = [], emphasisCells = [], border,
  highlightCol = -1, highlightStyle = 'outline', groupRows = [], subRows = [], groups = null, dense = false } = {}) { … }

```
# pictures.md

## Pictures
## 0. Generated pictures (when the user supplied none)
## 1. Placing a picture (contract)
## 2. Picture families (Reference — starting geometry, not slots)
## 3. Modifiers
## 4. Kit

```js

// Fill a frame without distortion; round:true makes a circle. Async: `await picture(...)`.
// pptxgenjs's sizing:'cover' writes an empty srcRect for a file path, so the crop happens here with sharp.
// alt: one sentence on what the photo shows — a picture placed without it is reported as missing_alt_text,
// because the file name pptxgenjs would store tells a reader who cannot see it nothing.
async function picture(slide, path, x, y, w, h, { round = false, transparency = 0, alt } = {}) { … }
// Tiles: the picture page the reference decks draw most (§2) — three or four artifacts on one baseline across the
// body, each in its frame with a label and a caption under it, so the row fills the body and the captions carry the
// argument. items: [{ path | data, alt, label?, caption?, weight? }] (data: a PNG data URL, e.g. from png(svg) for a
// drawn schematic — say so in the caption). frame: 'plain' (default) | 'phone' (a dark rounded device around a 9:19.5
// screen at the column's left) | 'browser' (a chrome bar with three dots over the capture). h: the frame height.
// captions: 'under' (default for plain and browser — the text stacks under the frame) | 'beside' (default for phone —
// the label and caption sit in the column beside the narrow screen, so the row has no empty gutters between devices).
// Returns the bottom edge. Measured before the draw: a row whose frames and stacked captions would end past the foot
// is refused with the height that fits named (the same contract as reading() and columns()) — never drawn over the
// source line for the audit to find.
async function tiles(slide, x, y, w, items, { h = 3.4, frame = 'plain', gap = GUTTER, captionRole = 'body', captions } = {}) { … }
// Clippings: press cuttings, documents, or captures as a collage (Evans, Bond) — 3-5 cards laid along a diagonal of
// the field from its top-left to its bottom-right, each with a hairline frame and a shadow plane, later ones over
// earlier ones, so the last (the one that matters) sits on top. items: [{ path | data, alt, w, h }] with their own
// sizes in inches; the field box(x, y, w, h) bounds them. Returns the field's bottom edge.
async function clippings(slide, x, y, w, h, items) { … }
// Directional scrim over a picture, darkest on the text side. side: 'left' | 'right' | 'bottom' | 'top'.
async function scrim(slide, x, y, w, h, side = 'left', color = T.dark) { … }
// Clip a picture to a rounded rectangle or polygon; returns a data URL for addImage at (w, h) inches.
async function maskImage(path, w, h, { radius = 0, points = null } = {}) { … }
// Radial spotlight: clear at the focus (fx, fy in 0-1), darkening outward to alpha at the edge.
async function spotlight(slide, x, y, w, h, { fx = 0.5, fy = 0.5, color = T.dark, alpha = 0.6 } = {}) { … }
const vignette = (slide, x, y, w, h, color = T.dark) => spotlight(slide, x, y, w, h, { color, alpha: 0.58 });
// Brand wash: the deck hue over a picture, strongest on the text side. Copy on the wash reads in T.onDark — the
// accent kicker (poster()'s default, tuned for T.dark) measures about 4.0:1 on the accent wash, under the 4.5:1
// floor — so a poster on a wash passes { kickerColor: T.onDark, lineColor: T.onDark } (rendered September 2026).
async function wash(slide, x, y, w, h, color = T.accentDeep, angle = 0) { … }
// Fade: the page colour runs into the picture from one side so the photograph dissolves into the page instead of
// ending at a hard edge — the Samsung band (a photograph across the top 28-44% of the page whose lower third fades to
// the paper, measured luminance ramp 0.6-0.7 across the band). Lay it over the picture's last 35-45% on that side.
// side: 'bottom' | 'top' | 'left' | 'right' (the opaque edge); color: the page colour the picture fades into.
async function fade(slide, x, y, w, h, side = 'bottom', color = T.paper) { … }
// Tone treatment on the raster before placement. The frontier photograph sits muted and mid-dark on the page — the
// picture tiles of 24 reference picture pages read saturation 0.16-0.46 (median 0.31) and luminance 0.35-0.55, against
// 0.6-0.8 saturation for a raw stock photograph — and a dark-tech deck carries its photographs as a duotone in the
// palette. Returns a PNG buffer that picture(), tiles(), and clippings() take in place of a path (sharp reads both).
// { mute: 0-1 saturation removed (0.35-0.5 reaches the reference band), duotone: [shadow, highlight] hex — the
// palette's dark and accent for dark-tech, ink and paperAlt for editorial, grain: 0-1 film grain (0.05-0.1 is visible
// without reading as noise), contrast: 1 as is, out: a path to keep the treated file beside the deck }
async function treat(path, { mute = 0, duotone = null, grain = 0, contrast = 1, out } = {}) { … }
// Cutout: a product render generated on a solid background (§3 — a model never gives real alpha; "transparent" burns a
// checkerboard) becomes an object with alpha. The background is what touches the frame's edges: a flood fill from the
// border over pixels within `tolerance` of `bg` goes clear, so a white highlight inside the product stays; the soft
// floor shadow a render usually carries clears with it up to the tolerance and the rest reads as the contact shadow.
// bg: 'white' | 'black' | hex; tolerance: the distance from bg that is background outright (a dark product on white
// takes 100+ so the grey floor shadow clears too); feather: the band above it that fades, so the edge and what is
// left of the shadow soften instead of cutting. Returns a PNG buffer (with alpha) that render() takes; out keeps the
// file beside the deck.
async function cutout(path, { bg = 'white', tolerance = 40, feather = 40, out } = {}) { … }
// Render: the product as the beat's hero object — the NVIDIA and Apple pages put one device on the right third of a
// dark field, whole (never cropped), on a soft glow in the accent. The cutout is fitted inside the box and centred; the
// glow is a radial halo drawn under it (the orb's halo), 1.6 × the box. Named as a device, so the receipt reads a
// closing with its product as a beat, not a picture page. glow: the halo colour (null for none); alt: what it shows.
async function render(slide, source, x, y, w, h, { glow = T.accent, glowAlpha = 0.32, alt } = {}) { … }
// Spot illustration: the drawn object a page without a photograph stands on — the organic blob and ribbon of the
// Spotify pages, the ring and dot fields of the tech decks — as a vector (editable, sharp at any zoom) in the palette.
// kind: 'blob' (one soft organic shape) | 'ribbon' (a flowing band across the box) | 'rings' (concentric arcs open on
// one side) | 'dots' (a dot field that thins toward one corner) | 'stack' (three isometric blocks rising). seed varies
// the blob and ribbon so two pages never carry the same silhouette; alpha sets the ink for a background object.
async function spot(slide, kind, x, y, w, h, { color = T.accent, color2 = T.accentDeep, seed = 1, alpha = 1, alt } = {}) { … }

```
