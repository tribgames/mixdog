# Direction

Owns what the deck decides before any slide is drawn: who reads it and how (§1), how it argues (§2), how it looks (§3), which of three candidate directions it takes (§4), its colors (§5) and type (§6). Nothing here places a shape; `composition.md` owns the page, `kit.md` owns the code.

Rule strength: **Hard rule** (objective failure, with its check: `→ runtime \`code\`` when the review raises that code, `→ manual` when only the render shows it), **Default** (a sensible choice; override with a reason), **Reference** (vocabulary; no single right answer). An unlabeled line is a Default.

## 1. Reading mode — decides density before anything else
**Default — derive from delivery**: live projection and launches lean presentation; async review, approval, and leave-behinds lean text; hybrid review leans balanced.
| Mode | Carrier | Page grammar | Rhythm |
|---|---|---|---|
| presentation | presenter + visuals | one claim per slide, keywords, one large visual or hero number; explanation goes to notes | more, sparser slides |
| balanced | slide + presenter | one primary claim with a concise explanation, structured evidence, or a necessary list | mixed |
| text | the slide alone, read close | complete sentences, short paragraphs, captions, tables; bullets only for genuinely parallel items | fewer, fuller slides |

A presentation deck and a text deck from the same source differ in grammar, count, text volume, and rhythm — not only in type size.

## 2. Argument mode — decides slide order (one per deck, independent of style)
**Default — pyramid for anything that must land a recommendation; briefing for status and reference packs.**
| Mode | Skeleton | Slide-order tendency | Fits |
|---|---|---|---|
| pyramid | conclusion first, then structured support | cover → answer → 2-4 argument slides with evidence → implications → ask | decisions, analyses, board reports |
| narrative | situation → tension → resolution | cover → context → the problem sharpens → turning point → resolution → what changes | pitches, case studies |
| instructional | decompose, then step through | cover → map of parts → one slide per part → recap | training, explainers |
| showcase | presence leads, copy stays short | cover → hero visual/number → 3-5 reveal beats → closing image | launches, reveals |
| briefing | neutral, complete, scannable | cover → agenda → one topic per slide with even weight → summary | status updates, FAQs |

**Default — assertion titles**: a content slide's title is the finding, not the topic ("Retention, not acquisition, drives growth", never "Market overview"). Read in sequence, the titles are the argument.
**Hard rule — a user-supplied outline keeps its facts and relationships**; the mode may regroup and retitle unless the user presented the outline as the final plan. → runtime `number_without_fact` for figures; relationships → manual

## 3. Visual style — how it looks (no colors, no fonts)
A style is shape language, composition geometry, decoration density, whitespace, texture. It governs treatment and coherence; it never decides which carriers a slide may use, and it carries no HEX and no typeface (those come from §5 and §6).
**Hard rule — one style per deck**: a device from another style on any slide is drift. → manual

| Style | Shape language | Composition geometry (moves it reaches for) | Decoration | Texture / elevation |
|---|---|---|---|---|
| swiss-minimal | grid-locked, sharp corners, hairlines | one oversized geometric plane zoning the page; asymmetric split flush to one axis; hero numeral at architectural scale; one diagonal rule as the grid break | near zero | flat |
| editorial | rectilinear scaffold, columns, thin rules | oversized numeral or drop cap anchoring the page; pull quote crossing columns; full-height vertical rule the content hangs from; figure crossing a column edge | typographic (kickers, hairlines) | flat; rules and air separate |
| photo-editorial | the picture is the page | full-bleed picture + directional scrim; caption registered to the picture edge; one line of large type on the calm zone | none beyond type | picture depth only |
| data-journalism | columns and sidebars cut into the grid | native chart as the spine; small-multiple strips; spanner rule dropping into a stat band; running source line | hairlines, source lines | flat |
| soft-rounded | rounded fields, gentle radii | tinted rounded fields; simple connector diagrams; one lifted primary object; chevron runs | icons in tinted discs | gentle; one resting shadow |
| dark-tech | dark canvas, geometric precision | glow behind one metric; concentric rings around a central number; hexagon node clusters; ghost numeral behind content; thin bracket frames | glow, hairline brackets | luminous; no black shadows |
| glassmorphism | translucent panels on a radial field | hero panel off-axis over a bloom; overlapping discs; a glass ring around the key metric; panels stepped in depth | bright hairline edges | layered translucency |
| blueprint | schematic line work on dark paper | grid field with measurement ticks; dashed construction lines; leaders; isometric boxes from parallelograms | module tags | flat line work |
| brutalist | raw structure, heavy rules, irregular columns | masthead numeral crossing column rules; heavy full-bleed rule bars; one grid cell inverted to solid ink as the focal cell | none; weight is the decoration | flat, hard |
| custom | write the five columns yourself | — | — | — |

**Reference — choosing**: compare the subject's own edge, corner, opening, angle, or layering logic with each style's shape language before settling on rectangles and circles; a topic word never selects a row. Expressive print or hand-drawn looks (zine, memphis, chalkboard, pixel) need prepared artwork the runtime does not have.

## 4. Three directions, one selected
**Default — author three whole-deck directions, then pick**: each direction is one coherent design — reading mode, argument mode, style, palette seed, type pairing, motif — with a one-sentence note on why it fits this subject and audience. The three are plainly different designs, not three names for one; where the request fixes a component, the open components carry the difference. Choose the strongest fit and say why in one clause. The brief records all three and the selection (`SKILL.md` §3). The runtime reads the selection back as information only (`art_direction_candidates_missing` is advisory).
**Default — anchors carry a picture**: the cover and one section or breathing slide take a supplied or generated picture whenever a picture can be had (`pictures.md` §0 — the `media` tool when an image lane is signed in); a text-only anchor is the fallback, and the summary says which it was. Content slides carry icons from the offline set where a marker helps (`composition.md` §9), never as decoration.
**Default — the motif**: one device from the selected style repeats on anchor slides (cover, section, closing) and recurs on content slides only when it says something true (a real section numeral, a module tag, a deck word). A color bar or edge stripe alone is never a motif. → runtime `decorative_stripe` for stripes

## 5. Palette — from the subject, through one seed
**Hard rule — contrast**: body text ≥ 4.5:1; text ≥ 18 pt or bold ≥ 14 pt ≥ 3:1; white on an accent block ≥ 3:1. Accent is never body text. Meaning never rides on color alone. → runtime `low_contrast` (saved colors), `low_visual_contrast` (render); color-only meaning → manual
**Hard rule — colors are 6 hex digits without `#`**; alpha in the hex corrupts the file (`transparency: 0-100` on fills and images, `opacity: 0-1` on shadows). → runtime package validation fails at finalize
**Default — one hue family, neutral ladder plus one accent**: the kit's `palette({ hue, accentHue, accentSat })` derives the whole ladder from one seed hue — ink, body, muted, line, paper, paperAlt, tint, dark, darkAlt, onDark, onDarkMuted, onDarkAccent, accent, accentDeep — with adjacent steps 10-25% apart in lightness and backgrounds within ±20° of the hue. A second hue enters only as the accent (`accentHue`) or a ≤ 15% support color. Proportion starts at 60/30/10 (field / support / accent). The extremes are tinted, never 000000/FFFFFF.
**Default — saturation by area**: large fields S ≤ 20%, text S ≤ 25%, the accent S 60-90% and only on small areas; projected decks read 10-15% more saturated than the screen.
**Reference — temperature by subject**: tech/finance cool blues (hue 205-240), education/growth greens (100-160), health cyans (170-190), creative/marketing warm oranges and pinks (10-40), academic indigos (230-260). Seeds that have worked: navy 225 + ice accent 210; forest 125 + moss 90; coral 358 + navy 230; terracotta 8 + sage 150; teal 185 + mint 165; berry 335 + cream 40; slate 210 + cherry 350. If the colors would work on any other deck, choose again.

## 6. Typography
**Hard rule — safe families only**: Noto Sans, Noto Serif, Noto Sans KR, Noto Serif KR, Noto Sans/Serif SC · TC · JP, Arial, Calibri, Calibri Light, Cambria, Times New Roman, Courier New, Bookman Old Style, Century Schoolbook, Malgun Gothic (+ Semilight), Microsoft YaHei, Yu Gothic. Never Aptos or Segoe UI. Georgia, Trebuchet, Impact, Garamond, Consolas preview approximately: 10% extra room and no trust in fit checks. → runtime `unsafe_font_family`, `font_family_overuse`
**Hard rule — no `charSpacing` on Hangul or CJK**; Latin kickers only (the kit's `kicker()` decides by script). → manual
**Default — Noto everywhere**: `typography({ script, pairing, fonts: 'noto' })` sets the display, sans, light, and data faces: Latin Noto Sans / Noto Serif with Arial for figures; Korean Noto Sans KR / Noto Serif KR; Japanese and Chinese their Noto families. `fonts: 'safe'` (Calibri/Cambria, Malgun Gothic) only when the user says the recipients lack Noto. Pairing: `serif` (serif display over sans body — editorial, data-journalism), `weight` (one family, bold display over regular body — most styles), `concord` (one family, one weight step — swiss, brutalist).
**Default — the scale comes from the reading mode**: `TYPE = typeScale(MODE)` derives every role from one body anchor — presentation 24 pt, balanced 18 pt, text 15 pt: body 1×, lead 1.2×, caption 0.7×, kicker 0.62×, section 1.5×, title 2×, cover 2.6×, hero 3.6×. Titles at least 2× the body; the fewest roles that still read at thumbnail size. A one-off display size (a ghost numeral, a poster word) is the author's call; a fourth body size is drift.
**Default — three weights, not two**: prose in the light face (`T.light`), emphasis in the regular sans (`T.sans`), display and hero bold. Weight and size together separate roles; a role that differs by size alone from its neighbor is merged into it.
**Reference — leading**: starting ranges, not rules — titles 1.1-1.25, body 1.35-1.5, sparse or breathing text up to 1.8, captions and footers 1.1-1.2. The paragraph step (`paraSpaceAfter` ≈ 0.6-0.8 × size) is visibly larger than the line step. Every kit text helper takes `lh`; the author sets it per box.
**Default — alignment and wrapping**: left-align body and lists; center only anchor titles and single callouts. Korean wraps by character: break display lines at phrase boundaries with `\n` and size the box to the longest phrase (a Hangul line ≈ 0.95 × fontSize per character). A stranded word on the last line means the box is the wrong width.
