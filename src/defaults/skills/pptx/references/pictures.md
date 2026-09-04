# Pictures

Owns everything that exists only when the deck carries pictures — supplied by the user or generated: the picture families a page can be built on, the tone and crop modifiers, generation, and the kit functions that place them. Loaded on that trigger (`SKILL.md` §1); a deck without pictures never reads this file. Canvas and rule strength as in `composition.md`.

## 0. Generated pictures (when the user supplied none)
The `image` skill makes the picture; this file only decides where it goes. Load `image`, follow its call order (`list` → `generate kind:'image'` → inspect), and pass what the deck knows: `path:<beside the deck>.png` and `aspect:<the frame ratio from §2>`. No signed-in lane means no generated pictures, and the deck says so instead of substituting a photo library it does not have.

**Default — where a generated picture earns its place**: the cover, one section anchor, and a photo-editorial style that needs one per slide. Evidence slides keep charts and tables; a generated picture never stands in for evidence.
**Default — what the deck hands the media prompt**: the `Asset:` line ("deck cover, full-bleed background"), the style's treatment as `Style:` (editorial: muted documentary photograph, shallow depth; dark-tech: macro of a lit surface on black; swiss-minimal: single object on a plain field; soft-rounded: soft daylight, pastel), the palette temperature (`direction.md` §5) as `Mood:`, and the calm zone as `Composition:`. A cover is a field for copy, so the image skill's no-text / no-faces exclusions apply. The subject comes from the brief, never the deck's topic word.
**Hard rule — the prompt never mentions type**: the calm zone is described as empty space ("the upper left quarter completely empty and dark"), never as where copy, a title, or "one line of type" will sit — a model reads that as text to draw and letters it in (probe 2026-09-04: "one line of type at center-left" produced a captioned picture). `Avoid:` spells the exclusion out: no text of any kind, no letters, no numbers, no labels, no signage. → manual (inspect the file before placing it)
**Hard rule — a generated picture is treated as a picture**: it recedes under type through `scrim()` / `wash()` like any other, is named in the plan line's carriers, and its lane/model and prompt go into the slide's speaker notes so a reader knows it is synthetic. → manual
**Default — one image language per deck**: every generated picture shares lighting, lens, material, and abstraction level; the `Style:` line is written once and reused verbatim. The exclusion list always carries text, typography, logo, watermark, QR code, page number, chart labels, and fake UI chrome — a picture never draws what the slide will draw.
**Default — placement follows relevance**: a supplied picture goes on the slide whose claim it evidences, chosen by what it shows; a picture with no slide that needs it is left out; the same picture appears at most twice in a deck (the cover crop returning smaller on the closing is the second), never as filler.

## 1. Placing a picture (contract)
**Hard rule — a picture is cropped to its frame before it is placed, never stretched**: `picture()` crops with sharp; `addImage` with a file path and a frame of another ratio is a defect. → runtime `image_aspect_distorted`
**Hard rule — text over a picture sits on a scrim**: a `scrim()` or `spotlight()` goes between the picture and any text on it; text straight on a picture fails the readability check at finalize. → runtime `low_visual_contrast` (render); scrim presence → manual
**Hard rule — one modifier per picture**: a crop and one tone treatment at most; a flat plate is never a tone. → manual
**Default — presence follows the job**: a cover or atmosphere picture recedes (`transparency: 55-70` or `wash()`); an evidence picture keeps full presence and gets annotation instead.

## 2. Picture families (Reference — starting geometry, not slots)
Three families; the modifiers in §3 and the lenses in `composition.md` §2 do the rest. Frame ratios are what `aspect:` gets when the picture is generated.
| Family | Variants and starting geometry | Frame |
|---|---|---|
| **single picture** — one picture and the copy that reads it | *side*: full height at one edge, w 5.5-6.2, copy in the remaining column (the reading direction chooses the side). *band*: `cover` across a band (top y 0-2.6, middle 2.4-4.9, bottom 4.9-H), copy columns in the rest, the title outside the band. *framed figure*: box(M + 0.4, 1.9, 6.6, 4.4) with a hairline `outline()` inset 0.08, caption under its left edge, the claim beside. *inset*: a large picture box(M, 1.6, 8.8, 5.0) with a `lift()`-framed detail overlapping its lower-right. *edge bleed*: the picture crosses one canvas edge (x 8.4 to W + 0.5) so it enters the page; the claim owns the other side. *strip + large type*: a picture strip w 2.2 at one edge, 40-54 pt type across the rest | side, strip `9:16` · band `21:9` · framed, inset `4:3` · bleed `3:4` |
| **picture as canvas** — the picture is the page, type sits on its calm zone | *full bleed*: `picture()` over the canvas, `scrim()` on the text side, kicker + title + one line at (M, 2.2-4.8) or a poster stack lower-left (cover, section). *cut*: a `polygon()` plane cut on a diagonal carries the copy over the picture; the contour follows the reading direction. *receded*: the picture at `transparency` 55-70 or under `wash()`, one statement at cover scale on top | `16:9` |
| **several pictures** — they argue together | *diptych / triptych*: 2-3 on one baseline, widths from `spans()` (equal only when equality is the message), one caption each or one spanning line. *before / after*: two equal frames, state labels above, one difference note under, an arrow only when transformation is the point. *sequence*: 3-5 aligned by height (h ≈ 2.6), widths from each picture's ratio, `node()` numbers, captions on one side. *collage*: one dominant (≥ 55% of the field) plus 2-3 supporting with 0.25 gaps, captions on the dominant one. *stack*: ≤ 3 offset 0.4 in x and y, the last one lifted, the claim beside. *mosaic*: 2×3 tiles where one tile is a `field()` holding the claim. *serpentine*: 2-3 bands where picture and copy swap sides so the eye runs a Z. *annotated*: one picture with `node()` markers at (fx, fy) and leader `connector()`s to short labels in a side column, or `callout()`s on the picture; *radial*: a round picture at the center with 4-6 leaders to labels at content-driven angles | panels `1:1` or `4:5` · annotated `16:9` · radial `1:1` |

## 3. Modifiers
**Reference — not a constraint**: add one only for a job.
| Modifier | Job | Kit |
|---|---|---|
| Crop | circle, rounded, or polygon silhouette | `rounding: true`; `maskImage(path, w, h, { radius })` or `{ points }` (fractions of the frame: `[[0,0],[1,0],[0.85,1],[0,1]]` is a trapezoid cut) |
| Directional scrim | text beside or over the picture | `scrim(slide, x, y, w, h, side)` — 0.85 → 0.30 → 0, darkest on the text side |
| Spotlight / vignette | focus on one region; atmosphere | `spotlight(slide, x, y, w, h, { fx, fy })`, `vignette(...)` |
| Brand wash | the picture joins the palette instead of fighting it | `wash(slide, x, y, w, h, T.accentDeep, angle)` |
| Framing / depth | hairline frame (`outline()`), `lift()` on one object, or an offset `field()` 0.25 in behind the picture as a shadow plane |
| Continuity | the same crop family across a chapter; the cover modifier repeated smaller on section and closing slides |

## 4. Kit
Add these to the script after `kit.md` (`png`, `gradientField`, `box`, `PX`, `T` are defined there).
```js
// Fill a frame without distortion; round:true makes a circle. Async: `await picture(...)`.
// pptxgenjs's sizing:'cover' writes an empty srcRect for a file path, so the crop happens here with sharp.
async function picture(slide, path, x, y, w, h, { round = false, transparency = 0 } = {}) {
  const pw = Math.max(2, Math.round(w * PX)), ph = Math.max(2, Math.round(h * PX));
  const buf = await sharp(path).resize(pw, ph, { fit: 'cover', position: 'attention' }).png().toBuffer();
  slide.addImage({ data: 'image/png;base64,' + buf.toString('base64'), ...box(x, y, w, h), rounding: round, transparency });
}
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
