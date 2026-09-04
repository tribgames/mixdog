---
name: pptx
description: Use when creating, redesigning, or reviewing a PowerPoint deck (.pptx) with the office tool. Carries the authoring process (direction → page brief → pptxgenjs script → render → receipt → finalize), the load routing for its references, and the library boundaries the runtime cannot absorb; the deck-level decisions are references/direction.md, the page composition vocabulary references/composition.md, the code references/kit.md, picture work references/pictures.md. Load before the first office call for a deck.
metadata:
  requires: office
---

# PPTX authoring (office tool + pptxgenjs)

The model designs; the runtime measures. Every slide is composed by the author from the kit's primitives — there is no slide type to pick and no function that draws a whole slide. The runtime checks what can be measured (fit, bounds, contrast, package validity, facts) and reports the rest as information the author weighs. This file owns the process, the brief contract, and the gate; every design decision lives in one reference.

## 1. Load routing
| File | Owns | Read when |
|---|---|---|
| `references/direction.md` | reading mode, argument mode, visual styles, three directions and the pick, palette from a seed, typography | always, before the brief |
| `references/composition.md` | the page brief, relationship atoms, composition lenses, page recipes, starting structures, spacing, rhythm, text, device menu, machine tells | always, before the slide plan |
| `references/kit.md` | tokens, `palette()`, `typography()`, masters, measured text, layout by weight, shapes, charts (line, area, bar, bullet, waterfall, dumbbell, doughnut, radar, scatter, bubble), tables | always, before the script |
| `references/pictures.md` | picture contract, picture families, modifiers, picture kit | when the user supplied pictures, when the style is photo-editorial, or when the plan gives a slide a generated picture |

## 2. Workflow
1. Read the always-loaded references; add `pictures.md` on its trigger. A deck that wants a cover picture and has none generates it with the `media` tool (load the `image` skill; `pictures.md` §0); with no image lane signed in, the cover takes a gradient field or a ghost numeral and the summary says so.
2. Ground: with source material, read it and write the fact sheet (each figure with its page or cell) before any outline; then the outline as assertion titles that read as one argument in sequence.
   **Hard rule — copy is rewritten, never reinvented**: slide copy is condensed from the source in the deck's language with the source's own vocabulary; entity names, product names, figures, and abbreviations stay in their original form; a figure the source does not contain is not on the slide. → manual
3. Direct: write three whole-deck directions and select one (`direction.md` §4); the palette comes from a seed hue, the type from `typography()`.
4. Plan each slide before any geometry (`composition.md` §0): job, relationship, move, composition move in words, carriers, texture, rhythm. Compare a page field, outline carrier, nested field, or continuity against cards and equal columns before deciding. Content over the mode's budget is split or cut, never squeezed.
5. Script: the brief (§3) as a comment block, then one pptxgenjs script on the kit. Each slide is drawn spine → nodes → connectors → labels → garnish with the kit primitives; every text box is measured (`MEASURE` through the kit helpers).
6. `office action:'author' path:<deck.pptx> script:<script>` — writes the file, opens the session, returns every slide rendered, one contact sheet of the whole deck, and the composition receipt (per slide: charts, tables, pictures, drawn shapes and their presets, fields, text boxes, background role, and `observe` — air, quadrant air, largest object share, visual footprint, text columns and stray boxes, fill areas, largest-type top, visual centroid and its offset from center, and after a render the pixel-read `renderAir`; `deck.rhythm` lists air, largest-type tops, centroid x, and render air in sequence). `overwrite:true` when re-authoring the same path.
   **Default — measure before rendering**: a render costs 30-40 s per loop; fit and bounds do not need one. Author with `render:false`, run `action:'qa'` on the session, fix the script, and repeat until qa reports no Hard hit — then author once with the render (default) for the visual read. A defect the render alone can show (registration, a scrim, a leftover corner) is still fixed from the render.
7. Read every render against §6 and the receipt against the plan. **Default — absence needs a reason**: a slide whose receipt contradicts its plan line (a chart promised, none drawn; a diagram named, only text boxes), or a deck-wide zero (no native chart, no preset contour, no field, no emphasis run) gets one line: what carries that job instead and why it serves the reader better. Style, speed, and "text was enough" are not reasons; a slide without one is repaired. Fix defects in the script, never in the file, and author again; one or two loops is normal.
   **Default — the art director reads the sheet, not the slides**: before the fix list, look only at the contact sheet and `deck.rhythm` and write one line per slide naming the single move that would most improve it as a page in this sequence (a title that could sit low or inside the field, a stray column, a quadrant that reads as leftover, two adjacent slides with the same move, a density line that never dips, a centroid that drifts to the same side on every slide). The observations are numbers, not verdicts: `quadrantAir` 0.9 in one corner beside 0.1 elsewhere is a fact to weigh against the plan line, and a breathing slide is meant to read that way. Make at most the two moves that change the reading; the rest are noted, not chased.
   **Hard rule — the loop converges**: each loop fixes every Hard hit and at most two Soft hits; a re-author that introduces a new Hard hit is reverted to the previous script; a defect that survives two loops is reported with the deck, not hidden by a third pass of taste edits. → manual
8. `office action:'finalize' session:<id> design:{ reviewed:true, reviewToken, critique:[...] }` — validates the package, saves, closes.
9. The `batch` slide and shape operations edit decks that already exist (§7); a new deck is always authored as a script, and a new page in an existing deck is a duplicated source page, never a runtime-composed one.

## 3. Brief (contract)
```
// BRIEF
// subject/audience/action: <what this deck must make someone do>
// reading mode: presentation | balanced | text · argument mode: pyramid | narrative | instructional | showcase | briefing
// directions: A <style · seed hue · pairing · motif — one-sentence note> · B <…> · C <…> · selected: <A|B|C> · why: <one clause>
// style: <direction.md §3 id or custom> · palette: hue <deg> [· accent hue <deg>] · accent: <hex> · type: MODE <mode> → body <pt> · script: ko | ja | zh | latin · pairing: serif | weight | concord · fonts: noto | safe
// motif: <the selected style's device on anchors> · rhythm: anchor, dense, breathing, dense, ... , anchor
// facts: F1 <value> — <source> · F2 <value> — <source> · ...
// slide plan: 1 job: cover · move: <what the reader now holds> · composition: <the page move in words> · carriers: <…>
//   2 job: evidence · relationship: contrast · move: <…> · composition: <…> · carriers: chart, takeaway · texture: prose · rhythm: dense
//   ... N job: closing · move: <…> · composition: <…> · carriers: statement
```
**Default — the plan states intent**: every slide's plan line names its job, relationship, move, composition move, carriers, texture, and rhythm before any geometry exists, so the design is decided before it is drawn. The runtime reads the carriers back and reports, as information only, a slide that does not seem to carry what it named (`plan_promise_missing`) or a slide count that differs (`plan_count_mismatch`); neither blocks nor counts as a polish target. A thin request gets a defensible brief invented from the subject, never blank fields. The `facts:`, `directions:`, and `slide plan:` lines may wrap across comment lines; each continuation line is read as more ` · ` items.
**Hard rule — every figure has a fact**: `facts:` lists each number the deck will show, with its source (a page, a cell, a URL, or "user brief"). Dates and slide numbers are exempt. A chart series is one fact listing its values in order (`F3 운영비 1Q–6Q 10.5 10.8 9.1 7.9 7.0 6.5 — 재무팀 시트 B4:G4`); the values in the script's `chart()` call are copied from that line. With source material, the fact sheet is written first; without it, the facts come from the request and say so. → runtime `number_without_fact`, `facts_missing`

## 4. Script contract and library boundaries
- `const pptxgen = require('pptxgenjs'); const pres = new pptxgen();` once. Available modules: `pptxgenjs`, `sharp`, `node:fs`, `node:path`, `node:buffer`; no network and no photo library. Icons come from the injected `ICON` (256 offline Lucide stroke icons; `ICON.names` lists them, the kit's `icon()` / `iconRow()` place them) — a feature marker, a list prefix, or a stage glyph is an icon by name, never a Unicode emoji or a hand-drawn shape.
- `pres.layout = 'LAYOUT_WIDE'` (13.33 × 7.5 in) before masters and slides; coordinates in inches; end with `await pres.writeFile({ fileName: OUTPUT })` (OUTPUT is injected).
- Right after the tokens: `T = { ...palette({ hue, accentHue }), … }` from the brief's seed, `MODE` the brief's reading mode, `typography({ script, pairing, fonts })` the brief's type line. `fonts: 'noto'` is the default for every deck (Noto is provisioned with the Office capability); `'safe'` only when the user says the recipients lack Noto. Charts go through `chart()` / `smallMultiples()` so the data stays editable.
- `MEASURE(text, { font, size, bold, width, lineHeight })` is injected: it returns `{ lines, height, width }` in inches with the metrics the review uses; `lineHeight` is the box's `lineSpacingMultiple`. Every kit text helper sizes its box with it; a free-form `addText` is sized with `fitH` too, never by guessing.
- Leading, weights, and every position are the author's: the kit helpers default them and take `lh`, `font`, `bold`, `align` per box.
- Speaker notes: `slide.addNotes('...')`, never a text box.
- Pictures: user files (`{ path }`) through `picture()` or sharp-rasterized SVG (`{ data: 'image/png;base64,...' }`) at ≥ 2× the placed size in pixels.

The runtime absorbs what it can (one `a:pPr` per paragraph; package validation at finalize). What it cannot, the script must avoid:
| Boundary | Failure |
|---|---|
| Colors are 6 hex digits without `#`; alpha via `transparency` / shadow `opacity` | alpha in the hex corrupts the file |
| A fresh options object for every add* call | the library rewrites option objects in place |
| Shadow `offset` ≥ 0; cast upward with `angle: 270` | negative offset corrupts the file |
| Shadows on shapes and text are `type: 'outer'` only | `'inner'` on a shape writes a mismatched closing tag and corrupts the file |
| `charSpacing`, not `letterSpacing` | ignored silently |
| Bullets: `bullet: true` on each item's first run, `breakLine: true` on every item but the last; `paraSpaceAfter`, not `lineSpacing`, between items | literal bullet characters and lineSpacing double the spacing |
| `rectRadius` only on `roundRect`; other corners are their own presets | ignored silently |
| Solid shape fills only; a gradient is a rasterized SVG image (`gradientField`) | gradient fill options are dropped |
| `margin: 0` when text must align with a shape edge | boxes carry internal padding |
| Stacked bar/column `dataLabelPosition` in `ctr`, `inEnd`, `inBase` | `outEnd` corrupts the file → runtime `chart_stacked_label_position` |
| A secondary-axis combo needs `valAxes` and `catAxes` with two entries each | PowerPoint drops the chart → runtime `chart_axis_undeclared` |

## 5. Rule loop
A defect the render shows that no rule names is a missing rule, not a one-off. After the deck is finalized: add one line to the owning reference (`direction.md` for deck-level decisions, `composition.md` for page judgement, `kit.md` for code, `pictures.md` for pictures) with its strength label; a Hard rule also names its check (`→ runtime \`code\`` or `→ manual`), and a runtime check the reviewer could make but does not is reported as the next runtime change. Rules accumulate from reviews; they are never rewritten from taste, and no rule may push every deck toward one composition.

## 6. QA and finalize
Inspect every rendered slide in this order. Hard hits block finalize. Each item names the runtime codes that catch it (`office action:'qa'`); "manual" means only the rendered image shows it.

Hard:
1. Out of bounds: any element past the 13.33 × 7.5 canvas. → `shape_out_of_bounds`, `content_touches_page_edge`
2. Overflow: text past its container or clipped at a box edge. → `text_overflow`, `text_clipped`, `text_box_too_narrow`
3. Text overlap: two text blocks intersect; text through a shape or line. → `shape_overlap` (text through a line → manual)
4. Readability: contrast below 4.5:1 (3:1 for ≥ 18 pt or bold ≥ 14 pt); text on a picture without a scrim. → `low_contrast`, `low_visual_contrast` (scrim presence → manual)
5. Collision: shapes overlap where z-order breaks the meaning. → `shape_overlap`
6. Broken picture: empty, stretched, or blurred raster. → `image_aspect_distorted` (empty or blurred → manual)
7. Missing element: leftover placeholder copy; a figure with no fact. → `placeholder_text`, `unfilled_token`, `number_without_fact`
8. System drift: a color outside the ladder, a face outside the safe list, a second saturated hue. → `accent_hue_overuse`, `font_family_overuse`, `theme_background_drift`, `unsafe_font_family`
9. Editability: a chart drawn from rectangles; a paragraph as stacked single-line boxes. → `dead_vector_chart`, `text_fragmentation`

Advisory (information the runtime reports; the author decides, never a polish target): monotony readings such as the same composition on most slides, one background throughout, or few visual roles (`repeated_layout_grammar`, `repeated_render_composition`, `flat_visual_rhythm`, `visual_role_variety_low`, `card_grid_overuse`), a canvas the reviewer reads as inactive (`under_composed_slide`, `slide_visual_density_low`, `meaningful_visual_missing`), and the plan read-back (`plan_promise_missing`, `plan_count_mismatch`, `art_direction_candidates_missing`). A deliberate composition overrides all of them; the receipt (§2 step 7) is where the author answers them.

Soft (fix when the change is local):
- Line step under 1.05× the font size, or a hollow gap over 1.5 in inside one block (breathing slides exempt). → `text_spacing_tight`, `vertical_imbalance`
- Same-column x or same-row baselines differing by more than 0.05 in; peer gaps differing by more than 5%. → manual
- The most prominent element is not what the slide is about. → `emphasis_mismatch`
- Caption more than 0.5 in from its picture; margins under 0.5 in; blocks closer than 0.3 in. → `stat_label_detached`, `edge_margin`, `shapes_too_close`

Finalize with `design: { reviewed: true, reviewToken, critique }`: reviewToken from the last render; critique holds one entry per slide with `slide`, `verdict` ('pass'), five 1-5 scores as top-level fields (`hierarchy`, `balance`, `legibility`, `cohesion`, `evidence`), a slide-specific `note` of 40+ characters, `fixes`, and `checks`. A score of 3 or lower on any axis, or any failed check, marks the slide as still needing polish.

**Hard rule — checks are the slide's own questions**: `checks` holds at least three `{ item, pass }` entries per slide, each a binary question written from that slide's plan line and facts before looking at the render ("the accent bar is Q4, the category the title names", "the 38 → 0 figures match F1 and F4", "the takeaway states a consequence, not a topic"), then answered against the render. Generic questions ("is the slide readable") do not count; a `pass: false` blocks finalize until the script is fixed. → runtime `visual_critique_incomplete`, `visual_critique_needs_polish`

## 7. Editing an existing deck (template fill, partial rewrite, reuse)
The source deck is the design authority and a slide library, not an outline. `open` it, `snapshot` the roster (a snapshot is paged — follow `pagination.nextCursor` with `cursor:` until `hasMore` is false, or ask for `pages:[…]`), and plan before any edit: output page → source slide → kept / edited / new copy, with one line of reason per edited or dropped page, and the content mapping (which material goes where; what is dropped because no page holds it).
- **Structure before content**: `keep_slides`, `move_slide`, `duplicate_slide`, `delete_slide` first, then text and data edits; a page duplicated after editing clones the edits. After a structural batch the slides are renumbered to their new positions — re-`snapshot` before addressing `slide: n`. A kept page is never opened for writing — the validation baseline reports a changed master, layout, or theme part as `changed_protected_part`.
- **Match message to page structure**: a source page's layout already encodes a rhetorical shape (statement, lead-then-detail, comparison, progression, metric row); put each message on the page whose structure carries it, and drop the content or the page rather than force a fit. A new page copies the closest source page and empties its slide-local content.
- **Copy fits the slot, not the placeholder**: capacity comes from the box geometry and font size (`MEASURE`, `fit_text`), never from the old text's length. Overflow is resolved in this order: rewrite shorter → split onto another kept page → choose a larger source layout; shrinking type is last, and never deck-wide. → runtime `text_overflow`, `text_clipped`
- **Template slots ≠ source items**: fewer items than slots deletes the whole unused group (picture + text boxes), not just its text; more items than slots is a second page, never a smaller size. Placeholder wording never becomes content. → runtime `placeholder_text`, `unfilled_token`
- **Native data stays native**: `set_chart_data` / `set_table_data` edit the values; a chart is never replaced by a picture of one. Pictures go through `replace_image` into the existing frame, cropped to its ratio. → runtime `dead_vector_chart`, `image_aspect_distorted`
- **Finish the same way**: `qa` (with `autoFix:true` for fit repairs), `render`, inspect every edited page against §6, then `finalize` with the critique; the summary names which pages were kept untouched, edited, and added.
