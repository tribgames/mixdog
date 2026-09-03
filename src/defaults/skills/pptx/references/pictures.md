# Pictures

Owns everything that exists only when the deck carries pictures — supplied by the user or generated: the picture skeletons, the tone and crop modifiers, generation, and the kit functions that place them. Loaded on that trigger (`SKILL.md` §1); a deck without pictures never reads this file. Geometry conventions and the canvas are the same as `layouts.md`.

## 0. Generated pictures (when the user supplied none)
The `image` skill makes the picture; this file only decides where it goes in a deck. Load `image`, follow its call order (`list` → `generate kind:'image'` → inspect), and pass what the deck knows: `path:<beside the deck>.png` and `aspect:<the P skeleton's frame ratio>`. No signed-in lane means no generated pictures, and the deck says so instead of substituting a photo library it does not have.

**Default — where a generated picture earns its place**: the cover (P1/P5), one section anchor, and a photo-editorial family that needs one per slide. Evidence slides keep charts and tables; a generated picture never stands in for evidence.
**Default — what the deck hands the media prompt**: the `Asset:` line ("deck cover, full-bleed, type on the left"), the family's treatment as `Style:` (`editorial`: muted documentary photograph, shallow depth; `dark-tech`: macro of a lit surface on black; `swiss-minimal`: single object on a plain field; `soft-rounded`: soft daylight, pastel), the palette temperature (§design.md 6) as `Mood:`, and the calm zone for type as `Composition:`. A cover is a field for copy, so the image skill's no-text / no-faces exclusions apply. The subject comes from the brief, never the deck's topic word.
**Hard rule — a generated picture is treated as a picture**: it recedes under type through `scrim()` / `wash()` like any other, is named in the plan line as its P skeleton, and its lane/model and prompt go into the speaker notes of the slide so a reader knows it is synthetic (the image skill's provenance rule, landed here). → manual

## 1. Placing a picture (contract)
```js
// Fill a frame without distortion; round:true makes a circle. Async: `await picture(...)`.
// The crop happens here with sharp: pptxgenjs's sizing:'cover' writes an empty srcRect for a file path, so a
// picture whose ratio differs from the frame would be stretched, not cropped (review: image_aspect_distorted).
async function picture(slide, path, x, y, w, h, { round = false, transparency = 0 } = {}) {
  const pw = Math.max(2, Math.round(w * PX)), ph = Math.max(2, Math.round(h * PX));
  const buf = await sharp(path).resize(pw, ph, { fit: 'cover', position: 'attention' }).png().toBuffer();
  slide.addImage({ data: 'image/png;base64,' + buf.toString('base64'), ...box(x, y, w, h), rounding: round, transparency });
}
```
**Hard rule — a picture is cropped to its frame before it is placed, never stretched**: `picture()` crops; `addImage` with a file path and a frame of another ratio is a defect. → runtime `image_aspect_distorted`
**Hard rule — text over a picture sits on a scrim**: a `scrim()` or `spotlight()` goes between the picture and any text on it; text straight on a picture fails the readability check at finalize. → runtime `low_visual_contrast` (render); scrim presence → manual
**Hard rule — one modifier per picture**: a crop and one tone treatment at most; a flat plate is never a tone. → manual
**Default — presence follows the job (may override when the picture is the evidence)**: a cover or atmosphere picture recedes (`transparency: 55-70` or `wash()`); an evidence picture keeps full presence and gets annotation instead.

## 2. Picture skeletons (P)
**Reference — not a constraint**: options to combine or replace with a clearer composition. Ids go in the brief's slide plan.

| Id | Skeleton | Starting geometry |
|---|---|---|
| P1 | Full-bleed title field | picture `cover` over the canvas; `scrim()` on the text side; kicker + title 44 pt + one line at (M, 2.2-4.8), or a poster stack lower-left. Cover, section |
| P2 | Side picture | picture at box(0, 0, 6.2, H) full height, or box(M, 1.7, 5.6, 5.0) contained; copy at x 6.8-7.2 width 5.5; reading direction chooses the side |
| P3 | Edge-bleed picture | picture crosses one canvas edge (x 8.4 to W + 0.5, or y -0.5) so it enters the page; the other side holds the claim |
| P4 | Picture band | picture `cover` in a band (top y 0-2.6, middle y 2.4-4.9, bottom y 4.9-H); copy columns in the remaining field; the title stays outside the band |
| P5 | Diagonal transition | `polygon()` cut along a diagonal separating the picture from the copy field; the contour follows the reading direction |
| P6 | Framed figure with caption | picture at box(M + 0.4, 1.9, 6.6, 4.4) with a hairline frame (`S.rect`, no fill, `line: { color: T.line }`) inset 0.08; caption 12 pt muted under its left edge |
| P7 | Slim strip + large type | picture strip w 2.2 full height at one edge; 40-54 pt type across the rest |
| P8 | Diptych / triptych | 2-3 pictures on one baseline sharing one argument, gaps 0.3, content-driven widths (equal only when equality is the message); one caption each or one spanning line |
| P9 | Before / after | two equal frames side by side, state labels above each, one difference note under; a `connector()` arrow between them only when transformation is the point |
| P10 | Picture sequence | 3-5 pictures aligned by height (h 2.6), widths from content, `node()` numbers at each top-left; captions on one shared side |
| P11 | Z serpentine | three bands (h 1.6, gap 0.3); picture and copy alternate sides so the eye follows a Z |
| P12 | Inset | large picture at box(M, 1.6, 8.8, 5.0) and a `lift()`-framed smaller picture overlapping its lower-right at box(8.0, 4.6, 4.2, 2.4) |
| P13 | Overlapping stack | at most 3 pictures offset 0.4 in x and y, later ones on top, one lifted |
| P14 | Asymmetric collage | one dominant picture (≥ 55% of the field) plus 2-3 supporting ones with 0.25 gaps; captions attach to the dominant one |
| P15 | Side hero + staggered evidence | full-height picture w 5.5 at one side; 3 `field()` blocks on the other side stepping 0.4 in x each, bold lead + one line |
| P16 | Mosaic with a text cell | 2×3 tiles where one tile is a `field()` in the accent or paperAlt holding the claim |
| P17 | 3×3 field with central figure | central picture or diagram at box(4.6, 2.2, 4.1, 3.5); the eight cells around it carry labels, small data, or callouts pointing inward |
| P18 | Radial callouts | central picture d 3.4 at (W/2, 4.3); 4-6 `connector()` leaders to short labels at content-driven angles |
| E6 | Annotated picture | picture `cover` at box(M, 1.6, 8.6, 5.2); 2-4 `callout()` or leader `connector()` + short labels from the right column x 9.5; `node()` numbers on the picture when order matters |

## 3. Modifiers
**Reference — not a constraint**: add one only for a job.
| Modifier | Job | Kit |
|---|---|---|
| Crop | circle, rounded, or polygon silhouette | `rounding: true`; `maskImage(path, w, h, { radius })` or `{ points }` (fractions of the frame: `[[0,0],[1,0],[0.85,1],[0,1]]` is a trapezoid cut) |
| Directional scrim | text beside or over the picture | `scrim(slide, x, y, w, h, side)` — 0.85 → 0.30 → 0, darkest on the text side |
| Spotlight / vignette | focus on one region; atmosphere | `spotlight(slide, x, y, w, h, { fx, fy })`, `vignette(...)` |
| Brand wash | the picture joins the palette instead of fighting it | `wash(slide, x, y, w, h, T.accentDeep, angle)` |
| Framing / depth | hairline frame, `lift()` on one object, or an offset `field()` 0.25 in behind the picture as a shadow plane |
| Continuity | the same crop family across a chapter; the cover modifier repeated smaller on section and closing slides |

## 4. Kit
Add these to the script beside `device-kit.md` §2 (`png`, `gradientField`, `box`, `PX`, `T` are defined there).
```js
// Directional scrim over a picture. side: 'left' | 'right' | 'bottom'.
async function scrim(slide, x, y, w, h, side = 'left', color = T.dark) {
  const angle = side === 'bottom' ? 270 : side === 'right' ? 180 : 0;
  await gradientField(slide, x, y, w, h, [[0, color, 0.85], [55, color, 0.30], [100, color, 0]], angle);
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
// Radial spotlight: clear at the focus (fx, fy in 0-1), darkening outward.
async function spotlight(slide, x, y, w, h, { fx = 0.5, fy = 0.5, color = T.dark, alpha = 0.6 } = {}) {
  const pw = Math.round(w * PX), ph = Math.round(h * PX);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${pw}" height="${ph}"><defs><radialGradient id="s" cx="${fx * 100}%" cy="${fy * 100}%" r="60%"><stop offset="0%" stop-color="#${color}" stop-opacity="0"/><stop offset="100%" stop-color="#${color}" stop-opacity="${alpha}"/></radialGradient></defs><rect width="${pw}" height="${ph}" fill="url(#s)"/></svg>`;
  slide.addImage({ data: await png(svg), ...box(x, y, w, h) });
}
const vignette = (slide, x, y, w, h, color = T.dark) => spotlight(slide, x, y, w, h, { color, alpha: 0.58 });
// Brand wash: the deck hue over a picture.
async function wash(slide, x, y, w, h, color = T.accentDeep, angle = 0) {
  await gradientField(slide, x, y, w, h, [[0, color, 0.8], [100, color, 0.1]], angle);
}
```
