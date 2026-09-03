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
| `references/pictures.md` | P skeletons, picture modifiers, picture helpers | only when the user supplied picture files |

## 2. Workflow
1. Read the always-loaded references; add `pictures.md` on its trigger.
2. Write the brief (§3) as a comment block, then the whole deck as one pptxgenjs script built on the kit.
3. `office action:'author' path:<deck.pptx> script:<script>` — writes the file, opens the session, returns every slide rendered. `overwrite:true` when re-authoring the same path.
4. Inspect every rendered image against §5. Fix defects in the script, never in the file, and author again; one or two loops is normal.
5. `office action:'finalize' session:<id> design:{ reviewed:true, reviewToken, critique:[...] }` — validates the package, saves, closes.
6. `compose_slide` and the other `batch` operations edit decks that already exist; a new deck is always authored as a script.

## 3. Brief (contract)
```
// BRIEF
// subject/audience/action: <what this deck must make someone do>
// reading mode: presentation | balanced | text · argument mode: pyramid | narrative | instructional | showcase | briefing
// family: <one of design.md §3> · palette from: <subject/temperature> · accent: <hex>
// ladder: ink/body/muted/paper/paperAlt/line/tint · dark/darkAlt/onDark
// motif: <from the family preset> · chrome: <from the family preset, on the master>
// rhythm: anchor, dense, breathing, dense, ... , anchor
// slide plan: 1 cover <skeleton> · 2 <atom · topology · skeleton id · carrier> · ... · N closing
```
**Hard rule**: every content slide's plan line names its relationship atom, the topology axis, the skeleton id, and the carrier before any geometry exists; a thin request gets a defensible brief invented from the subject, never blank fields.

## 4. Script contract and library boundaries
- `const pptxgen = require('pptxgenjs'); const pres = new pptxgen();` once. Available modules: `pptxgenjs`, `sharp`, `node:fs`, `node:path`, `node:buffer`; no network, no icon or photo library.
- `pres.layout = 'LAYOUT_WIDE'` (13.33 × 7.5 in) before masters and slides; coordinates in inches; end with `await pres.writeFile({ fileName: OUTPUT })` (OUTPUT is injected).
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

## 5. QA and finalize
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

Finalize with `design: { reviewed: true, reviewToken, critique }`: reviewToken from the last render; critique holds one entry per slide with `slide`, `verdict` ('pass'), five 1-5 scores as top-level fields (`hierarchy`, `balance`, `legibility`, `cohesion`, `evidence`), a slide-specific `note` of 40+ characters, and `fixes`. A score of 3 or lower on any axis marks the slide as still needing polish.
