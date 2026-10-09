# HTML route

Owns the default route for a new deck: the model designs the slides in HTML and CSS and passes the document as `author`'s `script` (a source that opens with `<` is read as HTML), a local Chrome or Edge lays them out, and `author` reads back what the browser drew and writes native, editable PowerPoint objects — text boxes that keep the browser's line breaks, shapes, lines, tables, charts, and pictures. Everything else in the skill (the brief, the gates, the audit, render, finalize, `direction.md`, `composition.md`, `writing.md`) applies unchanged; `kit-index.md` and the kit are the script route's and are not read here.

Rule strength as in `direction.md`.

## 1. When
**Default — HTML for a new deck**: models lay pages out in CSS far better than in coordinates, and the browser settles Hangul line breaks (`word-break: keep-all`) the way a reader expects. **The script route** (a pptxgenjs script in the same `script` field) stays for a deck that wants the kit's measured devices, or when no local browser exists (`author` then fails with `html_failed` naming the launch error).

## 2. Document contract
**Hard rule — the canvas**: one HTML document; every page is one `<section class="slide">` exactly 1920 × 1080 px, laid out with absolute positions or flex/grid inside it. The runtime shows one slide at a time whatever the CSS does with the others, and refuses a slide of another size with the size it measured. 1 px = 0.5 pt on the 13.333 × 7.5 in page. → runtime `html_failed`
**Hard rule — the brief is an HTML comment**: `<!-- BRIEF` … `-->` before the first slide, one `key: value` per line with the keys of SKILL.md §3 (`subject/audience/action`, `directions`, `style`, `facts`, `sources`, `slide plan`, plus `images` and `image style` below); a continuation line is indented. The plan gate and the facts gate read it exactly as they read a script's `//` lines. → runtime `plan_gate`, `facts_gate`
**Hard rule — pictures are local**: `<img src>` is a file beside the deck (the path resolves from the deck's folder) or a `data:` URI; a web URL is refused.
Speaker notes: `<aside class="notes">…</aside>` inside the slide.
Artifacts beside the deck: `<deck>.pptx.mixdog-source.html` (the source as laid out), `.mixdog-html-page-N.png` (the browser's pages), and after `render` `.mixdog-compare-page-N.png` (HTML left, PPTX right) in `render.compare`.

## 3. What converts
| CSS / HTML | PowerPoint |
|---|---|
| an element with its own text (and inline `<b>`, `<span>`, `<mark>`) | one text box: runs keep face, size, weight (≥ 600 → bold), italic, colour and alpha, letter-spacing; the browser's line breaks become soft breaks; padding becomes the inset |
| an inline run with a `background` (`<mark>`) | a highlight on that run |
| `background-color` (with alpha), `border` all four sides alike, `border-radius` (px or `50%`) | a rect, rounded rect, or ellipse (a square with a full radius) |
| a text element that has its own background or border (a pill, a chip, a numbered disc) | one shape carrying its text, centred as the browser centred it |
| a border on some sides only | a line per side |
| one outer `box-shadow` | the shape's outer shadow (hard or soft) |
| `<table>` | a native table: cell text, type, fills, padding, rules, `colspan` |
| `data-chart='{…}'` on an empty element | a native, editable chart in the element's box (§5) |
| inline `<svg>` | a picture rasterized at 2.5× the placed size |
| `<i data-icon="name">` | the offline Lucide icon as a picture, stroked in the element's CSS `color` (§6) |
| `<img>` with `object-fit`, `object-position` and `border-radius` | a picture with that crop and those corners baked in |
| paint PowerPoint has no native form for — `linear-/radial-/conic-gradient` and `background-image` (grain, patterns), `clip-path`, `mask-image`, `filter`, several or inset `box-shadow`s, dashed or dotted borders, `transform` on a box, `::before`/`::after` decoration — on the page itself or any element | that element's own paint (children and text hidden) photographed from the browser at 2× on a transparent page and placed as a picture where it drew, shadows and turned corners included; a box of text keeps a native fill in the picture's mean colour under it, and its words stay native text on top |
| a box of text turned by `transform: rotate()` | the same text box (and its fill) rotated natively about its centre |
| `opacity` | the alpha of every colour the element and its children paint, and the transparency of its pictures |

So the CSS techniques that make a page — a gradient field, a diagonal band, an edge that fades out, a paper grain, a tilted label, a bar drawn by `::before` — carry over as drawn; text, charts, and tables stay editable. A captured decoration is a picture: it is not edited in PowerPoint, so keep words, numbers, and data out of it.

**Not converted** (the author gets a warning in `logs` where it can be detected): `mix-blend-mode` and `backdrop-filter` (drawn without the layers behind them), `transform` on a container with children (the children are set upright), `transform-origin` other than the centre, text inside a pseudo-element (it becomes part of the picture), anything inside a `data-chart` element.

## 4. Text
- Set `word-break: keep-all; overflow-wrap: break-word` on the slide and `text-wrap: balance` on headlines, `text-wrap: pretty` on prose; wrap a name that must not break (`GPT-5.6 Sol`, `macOS x64와 ARM64`) in `white-space: nowrap`.
- Choose installed faces that cover the language and fit the intended use. The optional face examples in `concepts.md` §5 are not a whitelist. A recipient without a face gets a substitute: disclose the risk or use portable faces, then check the actual render.
- Weight has two steps in PowerPoint: 400 and 700 (a 500 becomes regular).
- Line height: the converter places every line on the browser's baseline within 1 px for Noto Sans KR, Noto Serif KR and Malgun Gothic from `line-height` 0.9 to 1.5; tighter than 0.9 is unmeasured. Tight display type (0.9-1.05 on 100 px+ headlines, −0.01 to −0.02 em tracking on Latin only) is available; body copy keeps 1.4-1.6.
- Sizes: body 24 px (12 pt) or more, captions and chrome 20 px (10 pt) or more; no tracking on Hangul beyond 0.05 em.
- Text read against a colour sits on a native box (a `div` with that `background`), never directly on an `<svg>` or `<img>`: the contrast check reads the box under the text, and a picture is no box.

## 5. Charts
```html
<div class="chart" style="position:absolute;left:860px;top:360px;width:964px;height:140px"
  data-chart='{"type":"bar","labels":["Mixdog","Codex CLI"],"values":[18.5,34.3],
               "colors":["<accent>","<muted>"],"max":40,"format":"0.0\"k\"","labelColor":"<ink>","size":11}'></div>
```
`type`: `bar` (horizontal), `col`, `line`, `area`, `pie`, `doughnut`. `values` for one series or `series: [{ name, values }]` with `legend: true` for several. `colors` 6-digit hex per category (one series) or per series. `max`/`min` fix the value scale, `format` the label number format, `size` the label size in pt, `gap` the bar gap %, `stacked`, `valueAxis: true` to show the value axis, `grid: "HEX"` for gridlines, `hole` for a doughnut. Values are copied from the brief's facts line. Give a bar chart about 70 px of height per category so PowerPoint keeps every category label. `categoryAxis: false` hides the category labels (when the page labels the columns itself).

**Default — annotate on the data**: `plot: { x, y, w, h }` pins the inner plot area as fractions of the chart box, so an inline `<svg>` written after the chart can sit exactly on the data — a shaded excursion, a dashed threshold, a bracket with its label, a direct series label instead of a legend. With the box at (X, Y, W, H) and the plot at (px, py, pw, ph): the plot spans x from X + px·W for pw·W, y from Y + py·H for ph·H; in a bar, column, or line chart of n categories, category i centres at x = X + px·W + (i + 0.5)·pw·W / n; value v lands at y = Y + py·H + ph·H · (1 − (v − min) / (max − min)), so give `min` and `max`. The same arithmetic aligns a chart under a row of HTML columns (`plot.x: 0, plot.w: 1` puts category i under column i of n equal columns).

## 6. Icons and SVG
`<i data-icon="coins" data-sw="1.75" style="width:44px;height:44px;color:#C77F00"></i>` places an icon from the offline set; an unknown name fails with the nearest names. An inline `<svg>` carries what CSS boxes cannot: rings and gauges, dumbbells, connectors and arrows, funnels, isometric figures, patterns, illustrations. Rules: write stroke dash lengths in user units (a ring filled to a share of 2πr, never `pathLength`); keep text out of SVG (it would not be editable, and the rasterizer's faces differ); give the svg a `data-alt` sentence; put the svg before the text that sits over it (document order is paint order).

## 7. Pictures and generated images
**Default — plan pictures in the brief**: an `images:` line lists each picture with its page, route, ratio, and the text-safe zone — `images: I1 slide 1 right third — ai — 3:4 — no text · I2 slide 5 — svg — isometric layers · I3 slide 7 — capture — desktop window`. Routes: `ai` (the `image` skill; `media action:'list'` once at the start decides whether it exists), `svg` (drawn in the HTML), `user` (a supplied file), `capture` (a real screenshot). An `image style:` line (light, material, abstraction, palette roles) is repeated verbatim in every generation prompt so the pictures read as one family.
**Hard rule — a generated picture never stands in for evidence**: figures, charts, tables, product UI, and screenshots are never generated; a generated picture is mood, metaphor, or illustration, recorded with its lane, model, and prompt in the slide's `aside.notes`.

## 8. One-shot design pass
Start from the source material, reader, and viewing conditions. Choose the reading path, type, palette, spacing, and carriers that explain this content, then write the HTML/CSS. A concept id, signature motif, fixed margin, colour ratio, or layout rotation is not required. `concepts.md`, `direction.md`, and `composition.md` are optional inspiration, not a checklist.

Preserve meaningful relationships: labels belong with their values, chart scales and units must be honest, and a comparison must retain the conditions being compared. Use repetition for comparable pages and whitespace for hierarchy where useful. A sparse statement, a dense reference page, and an intentionally repeated series are all valid when readable and complete. Do not add cards, texture, illustrations, or extra layouts just to satisfy a score.

**Hard rule — related positions come from one source and are declared**: a marker on a line, a shape inside a shape, a connector between two blocks, a column that lines up with the row above it, a label centred on its shape — each is computed, never typed as a separate guess: flex or grid for rows and columns, `calc()` on shared custom properties for a gap's centre, related shapes in one SVG from one set of numbers, a line or band that carries markers drawn as an SVG `<line>`, `<polyline>` or `<path>` (a clipped box has no centre line). Then the relation is declared on the element, and the browser proves it before the deck lands:
| Declaration | Holds when |
|---|---|
| `data-on="#road"` | the element's centre lies on the centre line of that SVG line or path |
| `data-inside="#ring"` | it lies wholly within that shape (circles by their radii) |
| `data-between="#a #b"` | it is centred in the gap between the two blocks, on their shared midline |
| `data-align="left #a, cy #b"` | the named edges or centres (`left right top bottom cx cy`) equal the other element's |
| `data-label="#disc"` | it is centred on that shape |
Ids are the slide's own. Undeclared, the page is still read for the misses a declaration would have caught: peer blocks in one container and one column or row whose visible edges or centres sit 3-24 px apart, a shape whose centre is inside another but which reaches up to 24 px past its edge, a small connector in the gap between two blocks but off its centre, a marker (64 px or less) set on a line, band, or drawing with no relation declared, and words that run partly onto an SVG drawing or a round shape (read against its real fill and stroke, not its frame) or come within 8 px of one several times their size — words wholly on a shape are its label, and a chip or card painted under the words hides what is beneath; a drawing the size of the page is ground. Each is fixed in the HTML or, when the offset is the design, marked `data-free` on the element. Any finding refuses the deck (`reason: geometry_gate`, the findings per slide with their offsets in px); nothing lands until it holds. The eye never certifies a geometric relation the gate can measure. → runtime `geometry_gate`

Before rendering, check that each page answers its intended question and preserves the source content. Judge stylistic choices by this request, not a blacklist of colours, fonts, or shapes. After conversion, inspect the actual Office pages rather than treating attractive HTML or a clean lint report as proof.

## 9. Review
`author` returns the audit, the rendered pages, and `render.compare`. Fix what the audit measures and what the pair shows (a line that broke differently, a glyph off its disc, a label PowerPoint dropped) in the HTML and author again — **Default — fix by editing the kept `<deck>.pptx.mixdog-source.html`** with the edit tool and calling `author path:<deck.pptx>` with no `script` (no `overwrite` needed); send the whole document again only when most of it changes; the two-round limit of SKILL.md §2 step 6 applies. Then finalize as SKILL.md §5.
**Hard rule — drift is read, not eyeballed**: `render.drift` (`html_render_drift`) lists, per page, every text, picture, drawing, captured decoration, and filled box PowerPoint drew more than 3 px (of the 1920 canvas) from where the browser put it — `dy` the vertical move of its ink, `dx` the move of its aligned edge; a non-text item is reported when both its edges moved (`dx`/`dy`) or it changed size (`dw`/`dh`); items over a chart are not read, since the browser draws no chart. An empty `pages` list is the evidence the render matches; a listed item is opened in its compare pair and answered in the HTML or reported with the deck. Pages rendered two to an image are not read (`unreadPages`): render them in batches of 12 or fewer. → runtime `html_render_drift`
**Default — display type needs room below**: PowerPoint's text box for a line set at the browser's baseline ends lower than the CSS line box — about 0.09 em lower at `line-height` 1.2 and 0.2 em at 0.95-1.0 — so text set on the next block with no gap overlaps it in the PPTX even where the glyphs clear. Leave that much margin under 60 px+ type (0.2 em under a tight headline or numeral). → runtime `shape_overlap`
**Default — text stays clear of the edges it does not sit in**: a headline whose last line dips onto the panel under it, or a label that half-crosses a band, reads as a collision. Keep text wholly inside a surface or clear of it by 8 px or more. → runtime `text_crosses_edge`
