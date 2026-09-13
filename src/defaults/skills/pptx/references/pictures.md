# Pictures

Owns selected pictures — supplied, accessible authorized product assets, or generated: picture families, crop and tone, generation, and placement. Loaded on that trigger (`SKILL.md` §1); a deck without pictures never reads this file. Canvas and rule strength as in `composition.md`.

## 0. Generated pictures (when the user supplied none)
The `image` skill makes the picture; this file only decides where it goes. Load `image`, follow its call order (`list` → `generate kind:'image'` → inspect), and pass what the deck knows: `path:<beside the deck>.png` and `aspect:<the frame ratio from §2>`. No signed-in lane means no generated pictures, and the deck says so instead of substituting a photo library it does not have.

The cover decision follows the subject and available authorized assets (`direction.md` §4), not whether generation is signed in. This file starts after asset selection. Content pages take a picture when it explains or demonstrates the claim; the deck never fills pages to reach a picture count.

**Default — choose the asset by its job**: use an actual screenshot, object photograph, source figure, or document excerpt when the claim concerns that artifact. Use a native diagram for relationships and a generated illustration for a clearly identified explanation or atmosphere. A generic photograph does not become relevant by matching the palette; omit it when the subject reads better without it. Generated imagery never stands in for observed evidence.
**Default — what the deck hands the media prompt**: the `Asset:` line ("deck cover, full-bleed background"), the style's treatment as `Style:` (editorial: muted documentary photograph, shallow depth; dark-tech: macro of a lit surface on black; swiss-minimal: single object on a plain field; soft-rounded: soft daylight, pastel), the palette temperature (`direction.md` §5) as `Mood:`, and the calm zone as `Composition:`. A cover is a field for copy, so the image skill's no-text / no-faces exclusions apply. The subject comes from the brief, never the deck's topic word.
**Hard rule — the prompt never mentions type**: the calm zone is described as empty space ("the upper left quarter completely empty and dark"), never as where copy, a title, or "one line of type" will sit — a model reads that as text to draw and letters it in (probe 2026-09-04: "one line of type at center-left" produced a captioned picture). `Avoid:` spells the exclusion out: no text of any kind, no letters, no numbers, no labels, no signage. → manual (inspect the file before placing it)
**Hard rule — a generated picture is treated as a picture**: it recedes under type through `scrim()` / `wash()` like any other, is named in the plan line's carriers, and its lane/model and prompt go into the slide's speaker notes so a reader knows it is synthetic. → manual
**Default — one image language per deck**: every generated picture shares lighting, lens, material, and abstraction level; the `Style:` line is written once and reused verbatim. The exclusion list always carries text, typography, logo, watermark, QR code, page number, chart labels, and fake UI chrome — a picture never draws what the slide will draw.
**Default — placement follows relevance**: name the specific detail the picture must reveal before choosing its frame. Preserve that detail in the crop, keep comparison frames at a comparable scale, and attach concise annotations to the evidence rather than a detached explanatory paragraph. Unneeded assets are left out; reuse is justified by the argument, not a filler quota. Keep real UI and document excerpts legible and distinguish explanatory reconstructions from original evidence.

## 1. Placing a picture (contract)
**Hard rule — a picture is cropped to its frame before it is placed, never stretched**: `picture()` crops with sharp; `addImage` with a file path and a frame of another ratio is a defect. → runtime `image_aspect_distorted`
**Hard rule — text over a picture sits on a scrim**: a `scrim()` or `spotlight()` goes between the picture and any text on it; text straight on a picture fails the readability check at finalize. → runtime `low_visual_contrast` (render); scrim presence → manual
**Default — preserve useful detail**: use only treatments that support the asset's job. Multiple treatments are allowed when they improve integration without obscuring evidence.
**Default — presence follows the job**: a cover or atmosphere picture recedes (`transparency: 55-70` or `wash()`); an evidence picture keeps full presence and gets annotation instead.

## 2. Picture families (Reference — starting geometry, not slots)
Three families; the modifiers in §3 and the lenses in `composition.md` §2 do the rest. Frame ratios are what `aspect:` gets when the picture is generated.

**Reference — what the frontier picture page is** (24 picture pages among 400 across thirteen decks, September 2026): twenty of them are *artifacts in a row* — three or four product screenshots, gameplay stills, press clippings, or document excerpts on one baseline across the body, each in its frame (a phone, a browser bar, a hairline) with a caption under it (Spotify's four phones on the green field, Krafton's stills grid, Bond's side-by-side captures, Evans's clipping collage); the picture covers 15-30% of the page and the page reads at 0.5-0.9 ink because the captions carry the argument. A full-bleed photograph under a scrim appears on covers and section marks, almost never on a body page. So a picture page is an evidence page: `tiles()` for the row, `clippings()` for the collage, a caption per artifact that says what it proves, and the title that says what the row shows together.
**Reference — how the frontier photograph sits and is toned** (tile reads of the same 24 picture pages plus the Samsung, NVIDIA, Sequoia, Coatue, and Kakao decks, `picture-measure.mjs`, September 2026): the photographic region covers a median 0.25 of the canvas on a picture page (0.05-0.94; the artifact rows 0.5-0.7 of their box is actual picture, the rest is frame and caption), and sits as a *band* across the width (Samsung: the top 28-44% of every body page, fading into the paper over its lower third — luminance ramp 0.6-0.7; Bond and Coatue: the body band under the title), or as an *inset* on one side (left 9 / right 5 of 24); a full-bleed photograph appears only on a cover or section mark (Kakao p4, Krafton p23: 0.9 of the canvas). Text over the photograph is 0.00-0.02 of the picture's tiles — copy sits beside the picture or on a scrim, never on the image. The photographs are toned, not raw: saturation 0.16-0.46 (median 0.31) and luminance 0.35-0.55 in the picture tiles, where a stock photograph reads 0.6-0.8 — a muted, mid-dark image that native type can sit beside. Our earlier scenario pictures (a gradient with one shape) read 0.01-0.12 photographic and 0.17-0.5 fill: the page had a coloured plane where the reference has a photograph. So the picture is a real photograph (supplied, or generated per §0 in one image language), toned with `treat()`, placed as a band with `fade()` or an inset, with the copy beside it.

| Family | Variants and starting geometry | Frame |
|---|---|---|
| **single picture** — one picture and the copy that reads it | *side*: full height at one edge, w 5.5-6.2, copy in the remaining column (the reading direction chooses the side). *band*: `cover` across a band (top y 0-2.6, middle 2.4-4.9, bottom 4.9-H) with `fade()` over its last 45% into the paper, copy columns in the rest, the title outside the band — the title through `head()` (or `kicker()` a within step above `title()`), and a sub or lead line between the title and a ruled `columns()` row, or `ruled: false`: a hairline within 0.55 in under a title reads as its underline (`decorative_stripe`). *framed figure*: under `head()`, box(M + 0.4, top, 6.6, avail(top)) with a hairline `outline()` inset 0.08, caption under its left edge, the claim beside — the frame runs from the body top to the foot like a chart's, never a fixed 1.9 / 4.4 that crosses the head band in presentation mode (body top 2.07) or the foot (6.27). *inset*: a large picture box(M, top, 8.8, avail(top)) with a `lift()`-framed detail overlapping its lower-right. *edge bleed*: the picture crosses one canvas edge (x 8.4 to W + 0.5) so it enters the page; the claim owns the other side. *strip + large type*: a picture strip w 2.2 at one edge, type at `TYPE.cover` (36 / 42 / 56 pt) across the rest | side, strip `9:16` · band `21:9` · framed, inset `4:3` · bleed `3:4` |
| **picture as canvas** — the picture is the page, type sits on its calm zone | *full bleed*: `picture()` over the canvas, `scrim()` on the text side, kicker + title + one line at (M, 2.2-4.8) or a poster stack lower-left (cover, section). *cut*: a `polygon()` plane cut on a diagonal carries the copy over the picture; the contour follows the reading direction. *receded*: the picture at `transparency` 55-70 or under `wash()`, one statement at cover scale on top — its kicker and meta line in `T.onDark` (`poster({ kickerColor: T.onDark, lineColor: T.onDark })`; the accent kicker measures 4.0:1 on the accent wash, under the 4.5:1 floor) | `16:9` |
| **several pictures** — they argue together | *tiles* (`tiles()`): 3-4 artifacts on one baseline across the body, h so the frames and the captions under them end above the foot (about 3.0 under a sub line, 3.4 without — `tiles()` measures the captions first and refuses a row past the foot with the h that fits named), each in its frame — `phone` for an app screen, `browser` for a web capture, `plain` for a still — with a label and a caption under it; the reference picture page. *clippings* (`clippings()`): 3-5 cuttings offset along a diagonal, later ones over earlier, the one that matters last and largest. *diptych / triptych*: 2-3 on one baseline, widths from `spans()` (equal only when equality is the message), one caption each or one spanning line. *before / after*: two equal frames, state labels above, one difference note under, an arrow only when transformation is the point. *sequence*: 3-5 aligned by height (h ≈ 2.6), widths from each picture's ratio, `node()` numbers, captions on one side. *collage*: one dominant (≥ 55% of the field) plus 2-3 supporting with 0.25 gaps, captions on the dominant one. *stack*: ≤ 3 offset 0.4 in x and y, the last one lifted, the claim beside. *mosaic*: 2×3 tiles where one tile is a `field()` holding the claim. *serpentine*: 2-3 bands where picture and copy swap sides so the eye runs a Z. *annotated*: one picture with `node()` markers at (fx, fy) and leader `connector()`s to short labels in a side column, or `callout()`s on the picture; *radial*: a round picture at the center with 4-6 leaders to labels at content-driven angles | panels `1:1` or `4:5` · annotated `16:9` · radial `1:1` |

## 3. Modifiers
**Reference — not a constraint**: add one only for a job.
| Modifier | Job | Kit |
|---|---|---|
| Crop | circle, rounded, or polygon silhouette | `rounding: true`; `maskImage(path, w, h, { radius })` or `{ points }` (fractions of the frame: `[[0,0],[1,0],[0.85,1],[0,1]]` is a trapezoid cut) |
| Directional scrim | text beside or over the picture | `scrim(slide, x, y, w, h, side)` — 0.85 → 0.30 → 0, darkest on the text side |
| Spotlight / vignette | focus on one region; atmosphere | `spotlight(slide, x, y, w, h, { fx, fy })`, `vignette(...)` |
| Brand wash | the picture joins the palette instead of fighting it | `wash(slide, x, y, w, h, T.accentDeep, angle)` |
| Fade | the picture dissolves into the page on one side instead of ending at an edge — the Samsung band | `fade(slide, x, y, w, h, 'bottom', T.paper)` over the picture's last 35-45% |
| Tone | a raw photograph reads too saturated beside native type: mute it to the reference band, or carry it as the palette's duotone (dark-tech), with a little grain | `treat(path, { mute: 0.4, grain: 0.06 })` · `treat(path, { duotone: [T.dark, T.accent] })` → a buffer `picture()` takes |
| Spot illustration | a drawn object where no photograph exists — a blob, a ribbon, rings, a dot field, an isometric stack — in the palette, as a vector | `spot(slide, 'blob', x, y, w, h, { color, seed })` |
| Product render | the product itself as the beat's hero object on a dark field (NVIDIA, Apple): generated on a solid white or black background, cut out, placed whole on a soft accent glow on the right third | `render(slide, await cutout(path, { bg: 'white' }), x, y, w, h, { glow: T.accent, alt })` |
| Framing / depth | hairline frame (`outline()`), `lift()` on one object, or an offset `field()` 0.25 in behind the picture as a shadow plane |
| Continuity | the same crop family across a chapter; the cover modifier repeated smaller on section and closing slides |

## 4. Kit
The runtime loads these after `kit.md` (`gradient`, `png`, `box`, `PX`, `T` come from there); read them for the signatures. The tone treatments are native gradients with alpha stops — editable in PowerPoint, no raster.
```js
// Fill a frame without distortion; round:true makes a circle. Async: `await picture(...)`.
// pptxgenjs's sizing:'cover' writes an empty srcRect for a file path, so the crop happens here with sharp.
// alt: one sentence on what the photo shows — a picture placed without it is reported as missing_alt_text,
// because the file name pptxgenjs would store tells a reader who cannot see it nothing.
async function picture(slide, path, x, y, w, h, { round = false, transparency = 0, alt } = {}) {
  const pw = Math.max(2, Math.round(w * PX)), ph = Math.max(2, Math.round(h * PX));
  const buf = await sharp(path).resize(pw, ph, { fit: 'cover', position: 'attention' }).png().toBuffer();
  slide.addImage({ data: 'image/png;base64,' + buf.toString('base64'), ...box(x, y, w, h), rounding: round, transparency,
    ...(alt ? { altText: alt } : {}) });
}
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
async function tiles(slide, x, y, w, items, { h = 3.4, frame = 'plain', gap = GUTTER, captionRole = 'body', captions } = {}) {
  captions ??= frame === 'phone' ? 'beside' : 'under';
  const cols = spans(x, w, items.map((it) => it.weight || 1), { gap });
  const roleH = (str, cw, name, lh) => { const r = role(name); const face = r.bold && r.font === T.light ? T.sans : r.font; return fitH(wrapKo(str, cw, r.size, face, r.bold), cw, r.size, face, { bold: r.bold, lh: lh ?? r.lh }); };
  const stack = captions === 'under'
    ? Math.max(0, ...items.map((it, i) => (it.label || it.caption ? GAP.within : 0) + (it.label ? roleH(it.label, cols[i].w, 'strong') + GAP.within : 0) + (it.caption ? roleH(it.caption, cols[i].w, captionRole, 1.35) : 0)))
    : 0;
  const over = y + h + stack - Z.body.bottom;
  if (over > 0.07) throw new Error(`tiles: the frames at h ${h.toFixed(2)} and the captions under them (${stack.toFixed(2)} in) end ${over.toFixed(2)} in past the foot — h ${(Z.body.bottom - y - stack).toFixed(2)} fits from this top, or shorten a caption`);
  let bottom = y;
  for (let i = 0; i < items.length; i += 1) {
    const it = items[i], c = cols[i];
    let px = c.x, py = y, pw = c.w, ph = h;
    if (frame === 'phone') {
      const bezel = 0.1, screenW = Math.min(c.w - bezel * 2, (h - bezel * 2) * 9 / 19.5);
      pw = screenW; ph = h - bezel * 2; px = c.x + bezel + (captions === 'beside' ? 0 : (c.w - screenW - bezel * 2) / 2); py = y + bezel;
      slide.addShape(S.roundRect, { ...box(px - bezel, y, pw + bezel * 2, h), fill: { color: T.ink }, line: { color: T.ink }, rectRadius: 0.22 });
    } else if (frame === 'browser') {
      const bar = 0.26;
      slide.addShape(S.roundRect, { ...box(c.x, y, c.w, h), fill: { color: T.paperAlt }, line: { color: T.line, width: 0.75 }, rectRadius: 0.06 });
      for (let k = 0; k < 3; k += 1) slide.addShape(S.ellipse, { ...box(c.x + 0.12 + k * 0.15, y + 0.085, 0.09, 0.09), fill: { color: T.muted }, line: { color: T.muted } });
      px = c.x + 0.04; py = y + bar; pw = c.w - 0.08; ph = h - bar - 0.04;
    }
    if (it.data) slide.addImage({ data: it.data, ...box(px, py, pw, ph), altText: it.alt || it.label || 'tile' });
    else await picture(slide, it.path, px, py, pw, ph, { alt: it.alt || it.label });
    const beside = captions === 'beside' && frame === 'phone';
    const tx = beside ? px + pw + 0.1 + GAP.within : c.x, tw = beside ? c.x + c.w - tx : c.w;
    let cy = beside ? y + 0.15 : y + h + GAP.within;
    if (it.label) cy = text(slide, it.label, tx, cy, tw, 'strong') + GAP.within;
    if (it.caption) cy = text(slide, it.caption, tx, cy, tw, captionRole, { color: T.body, lh: 1.35 });
    bottom = Math.max(bottom, beside ? y + h : cy);
  }
  return bottom;
}
// Clippings: press cuttings, documents, or captures as a collage (Evans, Bond) — 3-5 cards laid along a diagonal of
// the field from its top-left to its bottom-right, each with a hairline frame and a shadow plane, later ones over
// earlier ones, so the last (the one that matters) sits on top. items: [{ path | data, alt, w, h }] with their own
// sizes in inches; the field box(x, y, w, h) bounds them. Returns the field's bottom edge.
async function clippings(slide, x, y, w, h, items) {
  const n = items.length;
  // The collage sits on a 0.1 in grid: every card's corner on a grid line, every size a multiple of 0.2 in (so its
  // centre is on the grid too), and the shadow plane one grid step (0.1 in, 7.2 pt) below and right of its card.
  // Two same-kind edges (left with left, centre with centre, a shadow's with a card's) then either coincide or sit
  // at least 7.2 pt apart — past the 6 pt window in which the audit reads an edge as drifted off an axis the slide
  // shares (axis_drift). A diagonal at free sizes landed edges a few points apart wherever the sizes put them.
  const step = 0.1, off = step, snap = (v) => Math.round(v / step) * step, even = (v) => Math.max(2 * step, Math.round(v / (2 * step)) * 2 * step);
  const rects = items.map((it, i) => {
    const t = n > 1 ? i / (n - 1) : 0, cw = even(it.w), ch = even(it.h);
    return { x: snap(x + t * (w - cw)), y: snap(y + t * (h - ch) * 0.7 + (i % 2 ? 0 : (h - ch) * 0.3)), w: cw, h: ch };
  });
  for (let i = 0; i < n; i += 1) {
    const it = items[i], r = rects[i];
    field(slide, r.x + off, r.y + off, r.w, r.h, T.line);
    if (it.data) slide.addImage({ data: it.data, ...box(r.x, r.y, r.w, r.h), altText: it.alt || 'clipping' });
    else await picture(slide, it.path, r.x, r.y, r.w, r.h, { alt: it.alt });
    outline(slide, r.x, r.y, r.w, r.h, { color: T.lineStrong, width: 0.75 });
  }
  return y + h;
}
// Directional scrim over a picture, darkest on the text side. side: 'left' | 'right' | 'bottom' | 'top'.
async function scrim(slide, x, y, w, h, side = 'left', color = T.dark) {
  const angle = side === 'bottom' ? 270 : side === 'top' ? 90 : side === 'right' ? 180 : 0;
  gradient(slide, x, y, w, h, [[0, color, 0.85], [55, color, 0.30], [100, color, 0]], angle);
}
// Clip a picture to a rounded rectangle or polygon; returns a data URL for addImage at (w, h) inches.
async function maskImage(path, w, h, { radius = 0, points = null } = {}) {
  const pw = Math.round(w * PX), ph = Math.round(h * PX);
  const shape = points
    ? `<polygon points="${points.map(([px, py]) => `${px * pw},${py * ph}`).join(' ')}" fill="#fff"/>`
    : `<rect width="${pw}" height="${ph}" rx="${radius * PX}" fill="#fff"/>`;
  const mask = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${pw}" height="${ph}">${shape}</svg>`);
  const buf = await sharp(path).resize(pw, ph, { fit: 'cover' }).composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer();
  return 'image/png;base64,' + buf.toString('base64');
}
// Radial spotlight: clear at the focus (fx, fy in 0-1), darkening outward to alpha at the edge.
async function spotlight(slide, x, y, w, h, { fx = 0.5, fy = 0.5, color = T.dark, alpha = 0.6 } = {}) {
  gradient(slide, x, y, w, h, [[0, color, 0], [45, color, alpha * 0.35], [100, color, alpha]], 0, { radial: { fx, fy } });
}
const vignette = (slide, x, y, w, h, color = T.dark) => spotlight(slide, x, y, w, h, { color, alpha: 0.58 });
// Brand wash: the deck hue over a picture, strongest on the text side. Copy on the wash reads in T.onDark — the
// accent kicker (poster()'s default, tuned for T.dark) measures about 4.0:1 on the accent wash, under the 4.5:1
// floor — so a poster on a wash passes { kickerColor: T.onDark, lineColor: T.onDark } (rendered September 2026).
async function wash(slide, x, y, w, h, color = T.accentDeep, angle = 0) {
  gradient(slide, x, y, w, h, [[0, color, 0.8], [100, color, 0.1]], angle);
}
// Fade: the page colour runs into the picture from one side so the photograph dissolves into the page instead of
// ending at a hard edge — the Samsung band (a photograph across the top 28-44% of the page whose lower third fades to
// the paper, measured luminance ramp 0.6-0.7 across the band). Lay it over the picture's last 35-45% on that side.
// side: 'bottom' | 'top' | 'left' | 'right' (the opaque edge); color: the page colour the picture fades into.
async function fade(slide, x, y, w, h, side = 'bottom', color = T.paper) {
  const angle = side === 'bottom' ? 90 : side === 'top' ? 270 : side === 'right' ? 180 : 0;
  gradient(slide, x, y, w, h, [[0, color, 0], [55, color, 0.55], [100, color, 1]], angle);
}
// Tone treatment on the raster before placement. The frontier photograph sits muted and mid-dark on the page — the
// picture tiles of 24 reference picture pages read saturation 0.16-0.46 (median 0.31) and luminance 0.35-0.55, against
// 0.6-0.8 saturation for a raw stock photograph — and a dark-tech deck carries its photographs as a duotone in the
// palette. Returns a PNG buffer that picture(), tiles(), and clippings() take in place of a path (sharp reads both).
// { mute: 0-1 saturation removed (0.35-0.5 reaches the reference band), duotone: [shadow, highlight] hex — the
// palette's dark and accent for dark-tech, ink and paperAlt for editorial, grain: 0-1 film grain (0.05-0.1 is visible
// without reading as noise), contrast: 1 as is, out: a path to keep the treated file beside the deck }
async function treat(path, { mute = 0, duotone = null, grain = 0, contrast = 1, out } = {}) {
  const hex = (c) => [0, 2, 4].map((i) => parseInt(String(c).replace('#', '').slice(i, i + 2), 16));
  let img = sharp(path).rotate();
  const meta = await img.metadata();
  const longest = Math.max(meta.width || 1, meta.height || 1);
  if (longest > 2400) img = img.resize(Math.round((meta.width || 1) * (2400 / longest)));
  if (contrast !== 1) img = img.linear(contrast, 128 * (1 - contrast));
  if (mute && !duotone) img = img.modulate({ saturation: Math.max(0, 1 - mute) });
  const { data, info } = await img.removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const n = info.width * info.height;
  if (duotone) {
    const [dark, light] = duotone.map(hex);
    for (let i = 0; i < n; i += 1) {
      const t = (0.2126 * data[i * 3] + 0.7152 * data[i * 3 + 1] + 0.0722 * data[i * 3 + 2]) / 255;
      for (let c = 0; c < 3; c += 1) data[i * 3 + c] = Math.round(dark[c] + (light[c] - dark[c]) * t);
    }
  }
  if (grain) {
    let seed = 7; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const amp = grain * 56;
    for (let i = 0; i < n; i += 1) { const d = (rnd() - 0.5) * amp; for (let c = 0; c < 3; c += 1) data[i * 3 + c] = Math.max(0, Math.min(255, data[i * 3 + c] + d)); }
  }
  const buf = await sharp(data, { raw: { width: info.width, height: info.height, channels: 3 } }).png().toBuffer();
  if (out) require('node:fs').writeFileSync(out, buf);
  return buf;
}
// Cutout: a product render generated on a solid background (§3 — a model never gives real alpha; "transparent" burns a
// checkerboard) becomes an object with alpha. The background is what touches the frame's edges: a flood fill from the
// border over pixels within `tolerance` of `bg` goes clear, so a white highlight inside the product stays; the soft
// floor shadow a render usually carries clears with it up to the tolerance and the rest reads as the contact shadow.
// bg: 'white' | 'black' | hex; tolerance: the distance from bg that is background outright (a dark product on white
// takes 100+ so the grey floor shadow clears too); feather: the band above it that fades, so the edge and what is
// left of the shadow soften instead of cutting. Returns a PNG buffer (with alpha) that render() takes; out keeps the
// file beside the deck.
async function cutout(path, { bg = 'white', tolerance = 40, feather = 40, out } = {}) {
  const hex = (c) => [0, 2, 4].map((i) => parseInt(String(c).replace('#', '').slice(i, i + 2), 16));
  const b = bg === 'white' ? [255, 255, 255] : bg === 'black' ? [0, 0, 0] : hex(bg);
  const { data, info } = await sharp(path).rotate().removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const w = info.width, h = info.height, n = w * h, dist = new Uint8Array(n), clear = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) dist[i] = Math.max(Math.abs(data[i * 3] - b[0]), Math.abs(data[i * 3 + 1] - b[1]), Math.abs(data[i * 3 + 2] - b[2]));
  const queue = new Int32Array(n); let head = 0, tail = 0;
  const push = (i) => { if (dist[i] <= tolerance + feather && !clear[i]) { clear[i] = 1; queue[tail++] = i; } };
  for (let x = 0; x < w; x += 1) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y += 1) { push(y * w); push(y * w + w - 1); }
  while (head < tail) { const i = queue[head++], x = i % w; if (x > 0) push(i - 1); if (x < w - 1) push(i + 1); if (i >= w) push(i - w); if (i + w < n) push(i + w); }
  const rgba = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i += 1) {
    rgba[i * 4] = data[i * 3]; rgba[i * 4 + 1] = data[i * 3 + 1]; rgba[i * 4 + 2] = data[i * 3 + 2];
    rgba[i * 4 + 3] = !clear[i] ? 255 : dist[i] <= tolerance ? 0 : Math.round(255 * (dist[i] - tolerance) / feather);
  }
  const buf = await sharp(rgba, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
  if (out) require('node:fs').writeFileSync(out, buf);
  return buf;
}
// Render: the product as the beat's hero object — the NVIDIA and Apple pages put one device on the right third of a
// dark field, whole (never cropped), on a soft glow in the accent. The cutout is fitted inside the box and centred; the
// glow is a radial halo drawn under it (the orb's halo), 1.6 × the box. Named as a device, so the receipt reads a
// closing with its product as a beat, not a picture page. glow: the halo colour (null for none); alt: what it shows.
async function render(slide, source, x, y, w, h, { glow = T.accent, glowAlpha = 0.32, alt } = {}) {
  const pw = Math.round(w * PX), ph = Math.round(h * PX);
  if (glow) {
    const span = Math.max(w, h) * 1.6, px = Math.round(span * PX);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 100 100"><defs><radialGradient id="g" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="#${glow}" stop-opacity="${glowAlpha}"/><stop offset="0.45" stop-color="#${glow}" stop-opacity="${glowAlpha * 0.3}"/><stop offset="1" stop-color="#${glow}" stop-opacity="0"/></radialGradient></defs><circle cx="50" cy="50" r="50" fill="url(#g)"/></svg>`;
    slide.addImage({ data: await png(svg), ...box(x + w / 2 - span / 2, y + h / 2 - span / 2, span, span), altText: 'glow', objectName: 'mixdog-device:glow' });
  }
  const buf = await sharp(source).resize(pw, ph, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
  slide.addImage({ data: 'image/png;base64,' + buf.toString('base64'), ...box(x, y, w, h), ...(alt ? { altText: alt } : {}), objectName: 'mixdog-device:render' });
  return box(x, y, w, h);
}
// Spot illustration: the drawn object a page without a photograph stands on — the organic blob and ribbon of the
// Spotify pages, the ring and dot fields of the tech decks — as a vector (editable, sharp at any zoom) in the palette.
// kind: 'blob' (one soft organic shape) | 'ribbon' (a flowing band across the box) | 'rings' (concentric arcs open on
// one side) | 'dots' (a dot field that thins toward one corner) | 'stack' (three isometric blocks rising). seed varies
// the blob and ribbon so two pages never carry the same silhouette; alpha sets the ink for a background object.
async function spot(slide, kind, x, y, w, h, { color = T.accent, color2 = T.accentDeep, seed = 1, alpha = 1, alt } = {}) {
  const pw = Math.round(w * 100), ph = Math.round(h * 100);
  [color, color2] = [color, color2].map((c) => (/^[0-9a-f]{6}$/i.test(String(c)) ? `#${c}` : c));   // palette hexes carry no '#'; SVG needs it

  let s = seed * 9301 + 49297; const rnd = () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
  const smooth = (pts) => {   // closed Catmull-Rom → cubic path
    const n = pts.length; let d = `M${pts[0][0]},${pts[0][1]}`;
    for (let i = 0; i < n; i += 1) { const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n];
      d += ` C${p1[0] + (p2[0] - p0[0]) / 6},${p1[1] + (p2[1] - p0[1]) / 6} ${p2[0] - (p3[0] - p1[0]) / 6},${p2[1] - (p3[1] - p1[1]) / 6} ${p2[0]},${p2[1]}`; }
    return d + 'Z';
  };
  let body = '';
  if (kind === 'blob') {
    const cx = pw / 2, cy = ph / 2, pts = [];
    for (let i = 0; i < 9; i += 1) { const a = (i / 9) * Math.PI * 2, r = 0.36 + rnd() * 0.12; pts.push([cx + Math.cos(a) * r * pw, cy + Math.sin(a) * r * ph]); }
    body = `<path d="${smooth(pts)}" fill="${color}"/>`;
  } else if (kind === 'ribbon') {
    const top = [], bot = [];
    for (let i = 0; i <= 6; i += 1) { const px = (i / 6) * pw, base = ph * (0.35 + Math.sin(i * 1.1 + seed) * 0.15), t = ph * (0.18 + rnd() * 0.1); top.push([px, base - t]); bot.unshift([px, base + t]); }
    const pts = [...top, ...bot]; let d = `M${pts[0][0]},${pts[0][1]}`;
    for (let i = 1; i < pts.length; i += 1) { const a = pts[i - 1], b = pts[i]; d += ` C${(a[0] + b[0]) / 2},${a[1]} ${(a[0] + b[0]) / 2},${b[1]} ${b[0]},${b[1]}`; }
    body = `<path d="${d}Z" fill="${color}"/>`;
  } else if (kind === 'rings') {
    const cx = pw * 0.5, cy = ph * 0.5, R = Math.min(pw, ph) * 0.48;
    for (let i = 0; i < 5; i += 1) { const r = R * (1 - i * 0.18), sw = Math.max(2, R * 0.05); body += `<path d="M${cx + r},${cy} A${r},${r} 0 1 1 ${cx},${cy + r}" fill="none" stroke="${i % 2 ? color2 : color}" stroke-width="${sw}" stroke-linecap="round"/>`; }
  } else if (kind === 'dots') {
    const cols = 14, rows = Math.max(3, Math.round(cols * ph / pw)), dx = pw / cols, dy = ph / rows;
    for (let r = 0; r < rows; r += 1) for (let c = 0; c < cols; c += 1) { const f = 1 - (c / cols) * 0.7 - (r / rows) * 0.5; if (f <= 0.08) continue; body += `<circle cx="${(c + 0.5) * dx}" cy="${(r + 0.5) * dy}" r="${Math.min(dx, dy) * 0.24 * f}" fill="${color}"/>`; }
  } else if (kind === 'stack') {
    const u = Math.min(pw, ph) / 4, ox = pw / 2, oy = ph - u * 0.6;
    const cube = (bx, by, k) => { const p = (a, b) => `${bx + (a - b) * u * 0.866},${by - (a + b) * u * 0.5 - k * u}`; return `<path d="M${p(0, 0)} L${p(1, 0)} L${p(1, 1)} L${p(0, 1)}Z" fill="${color}" opacity="0.55"/><path d="M${p(0, 0)} L${p(1, 0)} L${bx + u * 0.866},${by - u * 0.5 - k * u + u} L${bx},${by - k * u + u}Z" fill="${color2}"/><path d="M${p(0, 0)} L${p(0, 1)} L${bx - u * 0.866},${by - u * 0.5 - k * u + u} L${bx},${by - k * u + u}Z" fill="${color}"/>`; };
    body = cube(ox, oy, 0) + cube(ox + u * 0.866, oy - u * 0.5, 0.2) + cube(ox, oy - u, 1.1);
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${pw}" height="${ph}" viewBox="0 0 ${pw} ${ph}"><g opacity="${alpha}">${body}</g></svg>`;
  await vector(slide, svg, x, y, w, h, { alt: alt || `${kind} illustration` });
}
```
