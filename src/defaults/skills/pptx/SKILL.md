---
name: pptx
description: Use when creating, redesigning, or reviewing a PowerPoint deck (.pptx) with the office tool. Carries the authoring workflow (pptxgenjs script → render → critique → finalize), the design system (brief, style families, palette ladder, rhythm), and the file-corrupting library footguns. Load before the first office call for a deck.
metadata:
  requires: office
---

# PPTX authoring (office tool + pptxgenjs)

## Workflow with the office tool
1. Read `references/helper-kit.md` in this skill's folder before writing the script: it holds the helper functions and the layout menu the script builds on.
2. Write the brief (section 1) as a comment block, then the whole deck as one pptxgenjs script.
3. `office action:'author' path:<deck.pptx> script:<script>` — writes the file, opens the session, returns every slide rendered. Pass `overwrite:true` when re-authoring the same path.
4. Look at every rendered image. Fix defects in the script, never in the file, and author again.
5. `office action:'finalize' session:<id> design:{ reviewed:true, reviewToken, critique:[one entry per slide] }` — validates the package, saves, closes. The exact critique shape is in section 8.
6. `compose_slide` and the other `batch` operations exist for editing decks that already exist; a new deck is always authored as a script.

## 0. Script contract
- `const pptxgen = require('pptxgenjs'); const pres = new pptxgen();` once per file.
- Set `pres.layout = 'LAYOUT_WIDE'` (13.33 x 7.5 in) before adding slides. Coordinates are inches; anything past the edge is written but invisible.
- End with `await pres.writeFile({ fileName: OUTPUT });`. OUTPUT is injected; never hard-code a path.
- Speaker notes: `slide.addNotes('...')`. Never put notes in a text box.

## Library footguns (each one corrupts or silently breaks the file)
- Colors are 6 hex digits without '#'. Alpha in the hex corrupts the file; use `transparency: 0-100` on fills.
- Build a fresh options object for every add* call; the library rewrites option objects in place.
- Shadow `offset` must be >= 0. Cast upward with `angle: 270`.
- `letterSpacing` is ignored; the option is `charSpacing`.
- Bullets: `bullet: true` per item and `breakLine: true` on every item but the last. Never type a literal bullet character. Space paragraphs with `paraSpaceAfter`, not `lineSpacing`.
- `rectRadius` only applies to `ROUNDED_RECTANGLE`.
- Gradient fills are unsupported; use a gradient image as background.
- Text boxes carry internal padding; set `margin: 0` when text must align with a shape edge.
- Charts stay native via `addChart`. Style them: `showTitle`, `showValue`, `dataLabelPosition`, `chartColors`, quiet axes and gridlines, `showLegend:false` for one series.
- Stacked bar/column `dataLabelPosition` must be `ctr`, `inEnd`, or `inBase`; `outEnd` corrupts the file.
- A combo series on a secondary axis needs both `valAxes` and `catAxes` with two entries each, or PowerPoint drops the chart.
- Images: `addImage({ data: 'image/png;base64,' + buffer.toString('base64') })` or `{ path }`. Rasterize SVG with sharp at >= 256 px.

## 1. Write the brief before the script
Decide the whole visual system first and paste it as a comment block at the top of the script, so every re-author keeps the same decisions:
```
// BRIEF
// subject/audience/action: <what this deck must make someone do>
// style family: <one of the families below>
// hue: <angle or name> · ladder: ink/body/muted/paper/paperAlt/line · accent: <hex> (accentDeep <hex>)
// motif: <one repeated device> · page chrome: <kicker? page badge? none?>
// density: low|medium|high · rhythm: anchor, dense, breathing, dense, ... , anchor
// slide plan: 1 cover · 2 <layout> · 3 <layout> · ... · N closing
```
A deck without a brief drifts into a different look on every slide. If the request is thin, invent a defensible brief from the subject; never leave fields blank.

## 2. Style families (pick one, vary only inside it)
- swiss-grid: strict columns, restrained type, one saturated accent, hairline separators, no decoration off the grid. Technical decks, research, product briefs.
- editorial-contrast: serif display + sans body, asymmetric column split, oversized numerals or crops crossing a column edge, generous outer margins. Narratives, strategy, thought pieces.
- dark-launch: deep background throughout, large type, one luminous accent, images with a 40-55% dark overlay. Keynotes, launches, closing calls to action.
- soft-brief: neutral surfaces, quiet tinted cards, simple diagrams, low saturation. Business introductions, onboarding, status updates.
- matrix-analysis: tables, 2x2s, comparison columns, high label clarity, little illustration. Frameworks, evaluations, decisions.
An 8-10 slide deck uses at most five distinct layouts; the same layout never appears twice in a row.

## 3. Palette ladder
- One hue family per deck. Backgrounds and text sit within ±20° of the main hue; a second hue is allowed only as the accent or a ≤15% area support color.
- Build a neutral ladder plus one accent: ink (titles, L 10-20%), body (L 25-35%), muted (captions, L 40-55%), paperAlt (zebra rows, soft cards, L 88-93%), paper (content background, L 95-98%), line (1 pt hairlines). Then accent (S 60-90%, the only saturated color) and accentDeep (its darker sibling).
- Adjacent ladder steps differ by 10-25% lightness; closer is invisible, wider looks like a jump.
- Saturation by area: large fields ≤20%, text ≤25%, accent 60-90% on ≤10% of the canvas. Pure 000000/FFFFFF pairs read harsh; tint the dark toward the hue (e.g. 0B1B2B) and the light likewise (e.g. F4F7F9).
- Contrast: body text ≥4.5:1, text ≥18 pt or bold ≥14 pt ≥3:1, white on an accent block ≥3:1. Accent is never body text. Meaning never rides on color alone: label or shape it too.
- Temperature by subject: tech/finance cool blues (210-240°), education/growth greens (100-160°), health cyans (170-190°), creative/marketing warm oranges and pinks (10-40°), academic indigos (230-260°). Starting points (primary / secondary / accent): Midnight Executive 1E2761/CADCFC/FFFFFF; Forest & Moss 2C5F2D/97BC62/F5F5F5; Coral Energy F96167/F9E795/2F3C7E; Warm Terracotta B85042/E7E8D1/A7BEAE; Ocean Gradient 065A82/1C7293/21295C; Charcoal Minimal 36454F/F2F2F2/212121; Teal Trust 028090/00A896/02C39A; Berry & Cream 6D2E46/A26769/ECE2D0; Sage Calm 84B59F/69A297/50808E; Cherry Bold 990011/FCF6F5/2F3C7E. If the colors would work on any other deck, choose again.

## 4. Page rhythm and canvas
- Assign each slide a role: anchor (cover, section, closing: one statement, lots of air), dense (evidence, tables, grids), breathing (one hero number or one quote, no card grid). Alternate dense and breathing; open and close with anchors; sandwich dark anchors around light content or commit to dark throughout.
- Every slide carries a visual: native chart, image, an icon built from shapes, or a composed figure. Title plus bullets is a draft.
- Fill the frame with intent. Content spans the safe area's width and height; residual blank in one corner is a defect, while air around a focal element is design.
- Choose one motif (rounded frames, icons in tinted circles, an oversized numeral, a bracketed kicker) and repeat it on anchor slides. Repeated page chrome (kicker, footer label, page badge) is fine; a color bar or edge stripe alone is not a motif.
- Hierarchy is carried by size, weight, position, and space together; the most prominent element on the page must be the one the slide is about.

## 5. Refuse
- Cards inside cards, framed panels that carry no information, equal card grids on a breathing page.
- Accent lines under titles, header/footer bars, sidebar stripes, single-side card borders: machine-made filler. Separate with a tint, a hairline, a shadow, or an icon.
- Purple-blue SaaS gradients as the default answer; cream/beige defaults (F5F5DC, FAF0E6, FAEBD7, FFF8E1); rainbow decks with a new color per slide.
- A full-bleed image under title text without a 40-55% scrim; an image that is merely decorative.
- Text-only slides, centered paragraphs, low-contrast text, one styled slide beside plain ones, leftover placeholder copy.
- charSpacing on Hangul or CJK text (it looks broken); keep it for Latin kickers only.

## 6. Typography
- Safe families that render true-to-width everywhere: Arial, Calibri, Cambria, Times New Roman, Courier New, Bookman Old Style, Century Schoolbook, Malgun Gothic. Pair a serif display with a sans body for contrast at zero risk; Korean text uses Malgun Gothic for body and may keep a Latin display face for numerals.
- Never Aptos; older Office lacks it and previews substitute it unpredictably. Georgia, Trebuchet, Impact, Garamond, Consolas preview approximately: give them ~10% extra room and do not trust fit checks on them.
- Ladder: cover title 40-44 pt bold, slide title 32-36 pt bold, section header 20-24 pt bold, card title 16 pt bold, body 14-16 pt, captions 11-12 pt muted, hero numerals 54-72 pt, kicker 11 pt bold uppercase with charSpacing 4 (Latin only). Use the fewest roles that still read at thumbnail size; titles need at least 2x the body size.
- Left-align body text and lists; center only titles on anchor slides and single callouts. Break lines at phrase boundaries; a stranded single word on the last line means the box is the wrong width.

## 7. Spacing
- 0.5 in minimum from every slide edge; 0.3-0.5 in between blocks, applied consistently; related items sit closer than unrelated ones so spacing carries hierarchy.
- Baseline step inside a paragraph 1.15-1.3x the font size; the step into a new paragraph visibly larger; list items in between.
- Peer elements share one grid: same x for a column, same baseline for a row, equal gaps in a card row (within 5%).
- Do not let text overflow its box. Shrink the type, widen the box, or split the slide.

## 8. QA before finalize
1. Render and inspect every slide image, in this order: out-of-bounds and clipped text; overflow past a container; overlapping text or shapes; elements closer than 0.3 in; margins under 0.5 in; misaligned columns and uneven card gaps; contrast; text over a busy image without a scrim; leftover placeholder copy; the wrong element dominating the page.
2. Severity: P0 (unreadable, collision, overflow, broken image) and P1 (visual-system drift, unsafe color pair, missing scrim, layout repeated back to back) block finalize. P2 (spacing drift, weak hierarchy) gets fixed when the change is local. P3 (polish) is noted in the critique's fixes.
3. Fix the script, not the file. Author again with overwrite:true and render again; one or two loops is normal.
4. Finalize with `design: { reviewed: true, reviewToken, critique }` where reviewToken comes from the last render and critique holds one entry per slide: slide, verdict ('pass'), five 1-5 scores as top-level fields (hierarchy, balance, legibility, cohesion, evidence), a slide-specific note of 40+ characters, and fixes. A score of 3 or lower on any axis marks the slide as still needing polish.