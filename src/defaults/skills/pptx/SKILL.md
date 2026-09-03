---
name: pptx
description: Use when creating, redesigning, or reviewing a PowerPoint deck (.pptx) with the office tool. Carries the authoring process (brief → pptxgenjs script → render → QA → finalize), the load routing for its references, and the library boundaries the runtime cannot absorb; the design system is references/design.md, the skeleton catalog references/layouts.md, picture work references/pictures.md, the code references/device-kit.md. Load before the first office call for a deck.
metadata:
  requires: office
---

# PPTX authoring (office tool + pptxgenjs)

This file owns the process, the brief contract, and the QA gate. Every design decision lives in one reference; this file points, it does not paraphrase.

## 1. Load routing
| File | Owns | Read when |
|---|---|---|
| `references/design.md` | reading mode, argument mode, family presets, composition grammar, device recall, palette, typography, spacing, forbidden tells | always, before the brief |
| `references/layouts.md` | S·E·R skeletons with starting geometry and kit calls | always, before the slide plan |
| `references/device-kit.md` | tokens, masters, helper functions | always, before the script |
| `references/archetypes.md` | whole-slide functions per skeleton and anchor (content in, geometry measured) | always, before the script |
| `references/pictures.md` | P skeletons, picture modifiers, picture generation, picture helpers | when the user supplied picture files, when the family is photo-editorial, or when the plan gives the cover or a section a generated picture (P skeleton) |

## 2. Workflow
1. Read the always-loaded references; add `pictures.md` on its trigger. A deck that wants a cover picture and has none generates it with the `media` tool (load the `image` skill; pictures.md §0) before the script; if no image lane is signed in, the cover uses a ghost numeral or a gradient field and the summary says a picture was not available.
2. Ground first: with source material, read it and write the fact sheet (each figure with its page or cell) before any outline; then the outline as action titles that read as one argument when read in sequence; then the brief (§3) as a comment block, then the whole deck as one pptxgenjs script built on the kit and the archetypes.
3. `office action:'author' path:<deck.pptx> script:<script>` — writes the file, opens the session, returns every slide rendered. `overwrite:true` when re-authoring the same path.
4. Inspect every rendered image against §5. Fix defects in the script, never in the file, and author again; one or two loops is normal.
5. `office action:'finalize' session:<id> design:{ reviewed:true, reviewToken, critique:[...] }` — validates the package, saves, closes.
6. `compose_slide` and the other `batch` operations edit decks that already exist; a new deck is always authored as a script.

## 3. Brief (contract)
```
// BRIEF
// subject/audience/action: <what this deck must make someone do>
// reading mode: presentation | balanced | text · argument mode: pyramid | narrative | instructional | showcase | briefing
// family: <one of design.md §3> · why this family for this subject: <one clause> · palette from: <subject/temperature> · accent: <hex>
// type: MODE <reading mode> → body <pt> · korean: safe | noto | none · pairing: <serif | weight | concord> · delivery: Windows PowerPoint
// ladder: ink/body/muted/paper/paperAlt/line/tint · dark/darkAlt/onDark
// motif: <from the family preset> · signature (MARK on content slides): <section numeral | module tag | deck word> · chrome: <from the family preset, on the master>
// rhythm: anchor, dense, breathing, dense, ... , anchor
// facts: F1 <value> — <source> · F2 <value> — <source> · ...
// slide plan: 1 cover <skeleton> · move: <what the reader now holds> · 2 <atom · topology · skeleton id · carrier> · move: <...> · texture: prose | list | specimen · ... · N closing
```
**Hard rule — the plan is a contract the runtime reads**: every content slide's plan line names its move (`design.md` §4), its relationship atom, the topology axis, the skeleton id, the carrier, and its texture (prose, list, or a drawn specimen) before any geometry exists; the review checks that each slide carries what its skeleton id promises (`plan_promise_missing`) and that the deck has the planned slide count. A thin request gets a defensible brief invented from the subject, never blank fields. → runtime `plan_promise_missing`, `plan_count_mismatch`
**Hard rule — every figure has a fact**: `facts:` lists each number the deck will show, with its source (a page, a cell, a URL, or "user brief"). Dates and slide numbers are exempt. With source material, the fact sheet is written first, from the material, before the outline; without it, the facts come from the request and say so. → runtime `number_without_fact`, `facts_missing`

## 4. Script contract and library boundaries
- `const pptxgen = require('pptxgenjs'); const pres = new pptxgen();` once. Available modules: `pptxgenjs`, `sharp`, `node:fs`, `node:path`, `node:buffer`; no network, no icon or photo library.
- `pres.layout = 'LAYOUT_WIDE'` (13.33 × 7.5 in) before masters and slides; coordinates in inches; end with `await pres.writeFile({ fileName: OUTPUT })` (OUTPUT is injected).
- `MODE` and `family('<name>', { korean: 'safe' | 'noto' | false })` right after the tokens name the brief's reading mode and family: `TYPE = typeScale(MODE)` sizes every role and the family sets the Latin or Korean pairing and master chrome. `korean: 'noto'` only after the user confirmed the recipients have Noto KR, and finalize then carries `allowUnsafeFonts: true`. `MARK` holds the signature text `head()` stamps on content slides. Charts go through `chart()` / `smallMultiples()` so the data stays editable.
- `MEASURE(text, { font, size, bold, width, lineHeight })` is injected: it returns `{ lines, height, width }` in inches with the metrics the review uses; `lineHeight` is the box's `lineSpacingMultiple` (1 = single), applied to the face's own line height (Malgun Gothic runs 1.33 em per single line, Calibri 1.2). The kit's `fitH` / `fitSize` and every archetype size boxes with it; a free-form text box is sized with it too, never by guessing.
- Archetypes first: a content slide whose plan names a skeleton id is drawn with that archetype (`references/archetypes.md`) and gets only content; free-form composition with the kit is for a slide no archetype fits, and says so in the plan line.
- Speaker notes: `slide.addNotes('...')`, never a text box.
- Pictures: user files (`{ path }`) or sharp-rasterized SVG (`{ data: 'image/png;base64,...' }`) at ≥ 2× the placed size in pixels.

The runtime absorbs what it can (one `a:pPr` per paragraph; package validation at finalize). What it cannot, the script must avoid:
| Boundary | Failure |
|---|---|
| Colors are 6 hex digits without `#`; alpha via `transparency` / shadow `opacity` | alpha in the hex corrupts the file |
| A fresh options object for every add* call | the library rewrites option objects in place |
| Shadow `offset` ≥ 0; cast upward with `angle: 270` | negative offset corrupts the file |
| `charSpacing`, not `letterSpacing` | ignored silently |
| Bullets: `bullet: true` on each item's first run, `breakLine: true` on every item but the last; `paraSpaceAfter`, not `lineSpacing`, between items | literal bullet characters and lineSpacing double the spacing |
| `rectRadius` only on `roundRect`; other corners are their own presets | ignored silently |
| Solid shape fills only; a gradient is a rasterized SVG image | gradient fill options are dropped |
| `margin: 0` when text must align with a shape edge | boxes carry internal padding |
| Stacked bar/column `dataLabelPosition` in `ctr`, `inEnd`, `inBase` | `outEnd` corrupts the file |
| A secondary-axis combo needs `valAxes` and `catAxes` with two entries each | PowerPoint drops the chart |

## 5. Rule loop
A defect the render shows that no rule names is a missing rule, not a one-off. After the deck is finalized: add one line to the owning reference (`design.md` for judgement, `layouts.md` or `archetypes.md` for geometry, `device-kit.md` for code) with its strength label; a Hard rule also names its check (`→ runtime \`code\`` or `→ manual`), and a runtime check the reviewer could make but does not is reported as the next runtime change. Rules accumulate from reviews; they are never rewritten from taste.

## 6. QA and finalize
Inspect every rendered slide in this order. Hard hits block finalize.

Hard:
1. Out of bounds: any element past the 13.33 × 7.5 canvas.
2. Overflow: text past its container or clipped at a box edge.
3. Text overlap: two text blocks intersect; text through a shape or line.
4. Readability: contrast below 4.5:1 (3:1 for ≥ 18 pt or bold ≥ 14 pt); text on a picture without a scrim.
5. Collision: shapes overlap where z-order breaks the meaning.
6. Broken picture: empty, stretched, or blurred raster.
7. Missing element: something the slide plan promised is absent; leftover placeholder copy.
8. System drift: the same skeleton on adjacent slides or a third time, a color outside the ladder, a device from another family, all content slides on one background.

Soft (fix when the change is local):
- Line step under 1.05× the font size, or a hollow gap over 1.5 in inside one block (breathing slides exempt).
- Same-column x or same-row baselines differing by more than 0.05 in; peer gaps differing by more than 5%.
- The most prominent element is not what the slide is about.
- Caption more than 0.5 in from its picture; margins under 0.5 in; blocks closer than 0.3 in.

Finalize with `design: { reviewed: true, reviewToken, critique }`: reviewToken from the last render; critique holds one entry per slide with `slide`, `verdict` ('pass'), five 1-5 scores as top-level fields (`hierarchy`, `balance`, `legibility`, `cohesion`, `evidence`), a slide-specific `note` of 40+ characters, `fixes`, and `checks`. A score of 3 or lower on any axis, or any failed check, marks the slide as still needing polish.

**Hard rule — checks are the slide's own questions**: `checks` holds at least three `{ item, pass }` entries per slide, each a binary question written from that slide's plan line and facts before looking at the render ("the accent bar is Q4, the category the title names", "the 38 → 0 figures match F1 and F4", "the takeaway states a consequence, not a topic"), then answered against the render. Generic questions ("is the slide readable") do not count; a `pass: false` blocks finalize until the script is fixed. → runtime `visual_critique_incomplete`, `visual_critique_needs_polish`
