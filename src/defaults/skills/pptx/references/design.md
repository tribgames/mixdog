# Design system

Owns the design decisions the brief records and the craft behind them. Each rule carries its strength: **Hard rule** (objective failure, with the trigger that fails it), **Default** (a sensible choice that saves re-deciding; override with a reason), **Reference** (vocabulary and options; no single right answer). An unlabeled line is a Default. `layouts.md` owns skeleton geometry, `pictures.md` owns picture work, `device-kit.md` owns code, `SKILL.md` owns process and the QA gate.

## 1. Reading mode (decides density before anything else)
**Default — derive from delivery (may override on request)**: live projection and launches lean presentation; async review, approval, and leave-behinds lean text.
| Mode | Carrier | Slide grammar | Rhythm |
|---|---|---|---|
| presentation | presenter + visuals | one claim per slide, keywords, one large visual or hero number; explanation goes to notes | more, sparser slides |
| balanced | slide + presenter | one primary claim with a concise explanation, structured evidence, or a necessary list | mixed |
| text | the slide alone, read close | complete sentences, short paragraphs, captions, tables; bullets only for genuinely parallel items | fewer, fuller slides |

## 2. Argument mode (decides slide order; one per deck, independent of style)
**Default — pyramid for anything that must land a recommendation; briefing for status and reference packs**.
| Mode | Skeleton | Slide-order tendency | Fits |
|---|---|---|---|
| pyramid | conclusion first, then structured support | cover → answer → 2-4 argument slides with evidence → implications → ask | decisions, analyses, board reports |
| narrative | situation → tension → resolution | cover → context → the problem sharpens → turning point → resolution → what changes | pitches, case studies |
| instructional | decompose, then step through | cover → map of parts → one slide per part → recap | training, explainers |
| showcase | presence leads, copy stays short | cover → hero visual/number → 3-5 reveal beats → closing image | launches, reveals |
| briefing | neutral, complete, scannable | cover → agenda → one topic per slide with even weight → summary | status updates, FAQs |

**Hard rule — a user-supplied outline keeps its facts and relationships**; the mode may regroup and retitle unless the user presented the outline as the final plan.

## 3. Style families (pick one; a family is a locked preset)
**Hard rule — one family per deck**: a device from another family's preset on any slide is system drift (QA hard 8). Expressive families that need prepared artwork (zine, memphis, chalkboard, pixel) are not available.

Each preset locks the display/body pairing, the motif, the page chrome, the carriers it reaches for, and what it forbids. The palette is never part of a preset: it comes from the subject (§6).
| Family | Type | Motif | Chrome | Carriers | Forbidden |
|---|---|---|---|---|---|
| swiss-minimal | Arial or Calibri both roles; titles 32-36 | one oversized geometric plane zoning the page | kicker + page number | asymmetric split flush to one axis, hero numeral at architectural scale, one diagonal rule as the grid break | rounded corners, shadows, gradients, icons in circles |
| editorial | serif display (Cambria) + sans body | oversized numeral or drop cap on anchors | kicker + page number | pull quote crossing columns, full-height vertical rule the content hangs from, asymmetric column split, figure crossing a column edge, hairline separators | filled cards, rounded fields, shadows, more than one accent |
| photo-editorial | sans display 44-54 + sans body | edge-bleed picture crop | page number only | full-bleed picture + directional scrim, caption registered to the picture edge, one line of large type on the calm zone | slides without a picture, framed pictures, text plates |
| data-journalism | Cambria numerals + sans body; hero numbers 54-60 | hero number at column scale | kicker + running source line + page number | native charts as the spine, small-multiple strips, sidebar cut into the grid, spanner rule dropping into a stat band | decorative shapes, pictures as filler, 3-D or gradient charts |
| soft-rounded | Calibri both roles; titles 30-32 | icons in tinted circles | kicker + page number | rounded tinted fields, simple connector diagrams, one lifted primary object, chevron runs | hairline-only separation, sharp corners, dark canvases |
| dark-tech | Arial display + Calibri body; dark throughout | glow behind one metric | kicker + page number | concentric orbit rings around a central number, hexagon node clusters, ghost numeral behind content, thin bracket frames | light canvases, warm pastel tints, shadows |
| glassmorphism | Arial both roles; dark radial field | hero panel off-axis over a radial bloom | page number only | translucent panels (`transparency 80-88` + bright hairline edge), overlapping discs, a glass ring around the key metric, panels stepped in depth | flat tinted cards, hairline grids |
| blueprint | Courier New labels + Calibri body; dark paper | grid field with measurement ticks | module tags + page number | dashed construction lines, leaders, isometric boxes from parallelograms | filled surfaces, pictures, rounded corners |
| brutalist | Arial Black-weight display 40-54 + Arial body | masthead numeral crossing column rules | page number only | heavy full-bleed rule bars, one grid cell inverted to solid ink as the focal cell, irregular column widths | tints, shadows, rounded corners, icons |

Korean text keeps Malgun Gothic for body in every family and may keep the family's Latin display face for numerals only.

## 4. Composition: relationship → topology → skeleton → carrier
**Hard rule — geometry comes last**: name the relationship the content carries, resolve its topology, choose a skeleton from `layouts.md`, then the carrier. A slide whose plan line names no relationship atom fails the brief check (`SKILL.md` §3).

### 4.1 Relationship atoms (Reference — vocabulary for the plan line)
| Atom | Meaning | Encode with | Topology axes to vary |
|---|---|---|---|
| order | sequence, progression, rank | position, numbering, direction, shared path | open or closed path; straight, bent, stepped, switchback, or coiled; level, rising, or falling; where the turns and the endpoint sit |
| link | dependency, exchange, influence | proximity when unmistakable, otherwise an edge | direct, hub, chain, split, merge, exchange, feedback; the fewest edges that carry the meaning |
| parent | one unit governs or decomposes into children | branching, indentation, nesting, scale | branch, indent, nest, radiate, scale |
| membership | units belong to a group, stage, lane | containment, shared field, band, repetition | enclose, band, lane, cluster, repeat, nest |
| contrast | peers, states, options compare | shared baseline, opposing regions, parallel framing | semantic axes, opposing or parallel fields, counterweight, before/after boundary |
| overlap | units share a subset or duty | intersecting regions with a legible common area | paired, chained, layered intersections |
| focal claim | one statement or number | scale and air | statement alone, hero number, pull quote, receded picture behind oversized type |
| evidence | a chart, table, or picture proves the claim | the evidence as the field | chart as spine with a takeaway, table with a verdict column, picture with annotation |

**Hard rule — counts never imply form**: a count of items never implies equal size, spacing, angle, or symmetry; closure, mirroring, centrality, and interlock require a meaning already in the content.

### 4.2 Carrier order
**Default — field before card (may override when peers need a page job)**: compare a page field (one surface organizing two or more zones), an outline carrier (a contour or oversized shape holding the content), a nested field, or cross-slide continuity before cards. Cards are for peer modules with a page job; an equal card grid without that job is the failure this section exists to prevent (QA: `card_grid_overuse`).

### 4.3 Construction order and registration
**Default**: spine → nodes → connectors → labels → garnish. The spine fixes entry and direction before any node is placed; nodes get one home each; only unresolved semantic links become connectors; labels attach visibly to what they explain; garnish is whatever can be removed without losing meaning.
**Hard rule — registration**: connectors end on node boundaries, chevron tips enter the next notch, seams meet across the full width, nested shapes keep a visible margin, one light source per slide. A connector crossing a node or a chevron covering the next stage is QA hard 5.

### 4.4 Validation before drawing
- Coverage: every relationship in the content is visible; none invented.
- Reading path: entry, progression, and endpoint are unambiguous.
- Removal: with color, icons, and garnish stripped, placement alone still communicates.
- Dominance: the most prominent element is what the slide is about.
- Visual: every content slide carries a chart, picture, shape construction, or hero number (QA: `meaningful_visual_missing`).

### 4.5 Variety and rhythm across the deck
**Hard rule — skeleton variety**: cover and closing aside, the same skeleton id appears at most twice per deck and never on adjacent slides (QA hard 8; runtime `card_grid_overuse` at three).
**Hard rule — rhythm**: content slides do not all share one background, density, and focal scale; at least one content slide changes the background field (a dark breathing slide in a light deck, or the reverse) or the runtime blocks finalize with `flat_visual_rhythm`.
**Default — roles alternate**: anchor (cover, section, closing: one statement, air, the motif at full size), dense (evidence, diagrams, comparisons), breathing (one hero number or quote, 40-60% of the canvas empty). Alternate dense and breathing; open and close with anchors.
**Default — one topology per relationship**: the same atom on two slides uses two different topology axes.
**Default — motif**: one motif from the family preset repeats on anchor slides; page chrome repeats on content slides through the master; a color bar or edge stripe alone is not a motif.

## 5. Device menu (recall; code in `device-kit.md`, pictures in `pictures.md`)
**Reference — not a constraint**:
| Device | Job |
|---|---|
| Gradient field or band | cover/section field, title backing, zone separation |
| Scrim, spotlight, vignette, wash | text over a picture; focus; brand tint (pictures.md) |
| Preset contour | carrier or accent: round1Rect, snip1Rect, trapezoid, parallelogram, hexagon, frame, corner, blockArc, pie, donut |
| Chevron or arrow run | steps, direction |
| Connector | relation, flow, leader; dashed for optional or draft |
| Brace / bracket | grouping without a box |
| Callout | annotation attached to a region |
| Icon | feature marker, list prefix; glyphs (✓ ✕ ● ◆ ▲ →) for the simplest cases |
| Hero number | metric, chapter mark |
| Inline emphasis | one load-bearing figure or noun per sentence; never connectives or every noun |
| Takeaway band | one-sentence conclusion closing a page |
| Elevated primary object | the one object above the page; peers stay flat |
| Gauge or share | one proportion |
| Custom silhouette | organic blob, wave edge, diagonal cut |
| Ghost numeral | chapter mark, dark-tech and editorial anchors |

**Hard rule — depth through restraint**: at most 2-3 floating objects per slide; resting shadow opacity 0.06-0.10; one weight tool per container (shadow, hairline, tint, or fill, never stacked). Text `glow` and `outline` on one display element per deck, never on body copy.

## 6. Palette
**Hard rule — contrast**: body text ≥ 4.5:1; text ≥ 18 pt or bold ≥ 14 pt ≥ 3:1; white on an accent block ≥ 3:1 (QA hard 4). Accent is never body text. Meaning never rides on color alone.
**Hard rule — colors are 6 hex digits without `#`**; alpha in the hex corrupts the file (`transparency: 0-100` on fills and images, `opacity: 0-1` on shadows).
**Default — one hue family, neutral ladder plus one accent**: backgrounds and text within ±20° of the main hue; a second hue only as the accent or a ≤ 15% support color. Ladder: ink (L 10-20%), body (25-35%), muted (40-55%), paperAlt (88-93%), paper (95-98%), line (hairlines), tint (takeaway bands, 85-90%); dark (10-15%) and darkAlt for dark fields with onDark / onDarkMuted / onDarkAccent text; accent (S 60-90%, the only saturated color) and accentDeep. Adjacent steps differ by 10-25% lightness. Proportion starts at 60/30/10 (field/support/accent).
**Default — tint the extremes**: pure 000000/FFFFFF read harsh; tint the dark toward the hue (0B1B2B) and the light likewise (F4F7F9).
**Reference — temperature by subject**: tech/finance cool blues (210-240°), education/growth greens (100-160°), health cyans (170-190°), creative/marketing warm oranges and pinks (10-40°), academic indigos (230-260°). Starting points (primary / support / accent): Midnight Executive 1E2761/CADCFC/FFFFFF; Forest & Moss 2C5F2D/97BC62/F5F5F5; Coral Energy F96167/F9E795/2F3C7E; Warm Terracotta B85042/E7E8D1/A7BEAE; Ocean Gradient 065A82/1C7293/21295C; Charcoal Minimal 36454F/F2F2F2/212121; Teal Trust 028090/00A896/02C39A; Berry & Cream 6D2E46/A26769/ECE2D0; Sage Calm 84B59F/69A297/50808E; Cherry Bold 990011/FCF6F5/2F3C7E. If the colors would work on any other deck, choose again.

## 7. Typography
**Hard rule — safe families only**: Arial, Calibri, Cambria, Times New Roman, Courier New, Bookman Old Style, Century Schoolbook, Malgun Gothic render true-to-width everywhere; never Aptos (runtime `unsafe_font_family`). Georgia, Trebuchet, Impact, Garamond, Consolas preview approximately: give them 10% extra room and do not trust fit checks on them.
**Hard rule — no `charSpacing` on Hangul or CJK**; Latin kickers only.
**Hard rule — no text container narrower than 0.4 in**; rotate a wide box instead of using a slim one.
**Default — roles and sizes**: cover title 40-44 pt bold, slide title 32-36, section header 20-24, lead/takeaway 17-20, body 14-16, captions and source lines 11-12 muted, kicker 11 bold uppercase `charSpacing 4`, page number 9 muted (on the master), hero numerals 54-72, ghost numerals 180-240. Titles at least 2× the body size; the fewest roles that still read at thumbnail size.
**Default — leading**: titles 1.2-1.3×, body 1.3-1.5×, sparse body up to 2.0×; the step into a new paragraph is visibly larger than the line step.
**Default — alignment and wrapping**: left-align body and lists; center only anchor titles and single callouts. Korean wraps by character: break display lines at phrase boundaries with `\n` and give a box the width of its longest phrase; estimate a Hangul line at 0.95 × fontSize per character. A stranded word or character on the last line means the box is the wrong width.

## 8. Spacing
**Hard rule — edges and gaps**: 0.5 in minimum from every slide edge (page number and source line may sit at 0.4 in); blocks at least 0.3 in apart, except a numeral directly above its own label (0.05-0.1 in) and a kicker above its title (0.1 in). Closer is QA soft; text touching is QA hard 3.
**Default — one grid**: peers share the same x for a column and the same baseline for a row; equal gaps in a row within 5%. The title moves with the slide's role; it is not a fixed header band.
**Default — fill the frame with intent**: content spans the safe area; residual blank in one corner is a defect, while air around a focal element is design; breathing slides keep 40-60% empty on purpose; a hollow gap over 1.5 in inside one block is QA soft.

## 9. Forbidden — machine-made tells
- An equal card grid on every content slide, or any card grid without a page job; cards inside cards; framed panels carrying no information; a module grid on a breathing slide.
- Accent lines under titles, header/footer bars, sidebar stripes, single-side card borders (runtime `decorative_stripe`). Separate with a tint, a hairline between rows, a shadow, or an icon.
- Purple-blue SaaS gradients as the default answer; cream/beige defaults (F5F5DC, FAF0E6, FAEBD7, FFF8E1); rainbow decks with a new color per slide.
- A picture under title text without a scrim; a uniform overlay or black plate instead of a directional scrim; a picture that is merely decorative.
- Text-only slides, centered paragraphs, low-contrast text, one styled slide beside plain ones, shadows on every container, page chrome drawn on slides instead of the master.
