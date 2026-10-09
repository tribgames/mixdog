# Design concepts

Optional inspiration for decks, Word documents, PDFs, and Excel report sheets. The model designs from the request and content; it does not have to select an entry here. These examples group palette, type, headings, tables, emphasis, charts, chrome, and density to illustrate possibilities, not to prescribe templates or acceptable styles.

Every palette formula, face menu, ratio, and treatment below is a reference example. Adapt, combine, or ignore it; no catalogue id, prescribed colour scheme, or difference from an unrelated document is required.

## 1. How to use the examples
- Start with what the reader needs to understand, decide, or fill in and how they will use the file.
- Preserve supplied templates, brand requirements, and the conventions of files being edited.
- `concept:` may describe a design intent in free text or be omitted; it is not a quality gate.
- Share facts and requested identity across a package, while adapting each format's structure to its job.
- Reuse a layout when it helps comparison or a series; vary it when the content needs a different reading path. Novelty alone is not a goal.
- If comparing directions resolves a real uncertainty, compare representative rendered pages for reader understanding, not catalogue membership.
- Names such as `ink`, `line`, and `accent` in recipes mean roles in the author's palette, not compulsory values from this file.

## 2. Palette roles and deriving them
Roles: `paper` (the page ground), `ink` (body and headings), `muted` (captions, labels, sources), `line` (rules and hairlines), `tint` (a quiet field behind a callout, band, or banded row), `accent` (the one colour with one job — the claim, the key figure, the subject's mark), and optionally `accent2` (a second voice with its own job: the alert, the comparison series, the second subject). Hex is six digits; in CSS `#`, in office operations without. Contrast: body ink on paper ≥ 4.5:1, `muted` ≥ 4.5:1 for text, accent as text ≥ 4.5:1 (`direction.md` §5).

Start from a **seed hue** (the subject, the brand, the mood), then pick a scheme — vary it between concepts and artifacts, do not always take the complement:
| Scheme | accent hue vs seed | Reads as | Fits |
|---|---|---|---|
| mono | the seed itself, one saturation step above the neutrals | calm, disciplined | quiet-minimal, letter-memo, formal-report |
| analogous | seed ± 20-40° | cohesive, warm or cool throughout | formal-report, technical-reference, data-dashboard |
| complement | seed + 180° | high contrast, one loud mark | keynote-statement, brand-campaign, editorial-magazine |
| split | seed + 150° and + 210° (accent and accent2) | lively, still ordered | data-dashboard, brand-campaign, dark-tech |

Derivation, with the seed hue h: `paper` = h at S 2-8%, L 97-100% (a dark concept: S 10-25%, L 5-10%); `ink` = h at S 15-30%, L 8-16% (dark concept: L 90-96%); `muted` = h at S 10-20%, L 38-46% (dark: L 60-68%); `line` = h at S 8-15%, L 84-90% (dark: L 16-22%); `tint` = the accent's hue at S 25-45%, L 93-96% (dark: L 10-14%); `accent` = S 55-85%, L 32-48% for text use, the same hue a step brighter (L ≈ 50%) for a mark that carries no type; `accent2` the same recipe at its own hue. Neutrals are tinted toward the seed, never pure 000000/FFFFFF unless the concept is a statement or a form. A state colour (good / caution / bad) is a separate, fixed hue pair — green and red words beside their glyph — not the accent.

## 3. The concepts
Each entry: **Fits** (signals) · **Palette** (scheme and one example) · **Type** (Korean / Latin) · **Heading** · **Table** · **Emphasis** · **Chart** · **Chrome** · **Density**. Faces are installed with Windows/Office or are the provisioned Noto families (§5).

### formal-report
- **Fits**: a board, regulator, client, or committee reading at a desk; decisions, audits, annual or quarterly reports, proposals with evidence; the reader may file it.
- **Palette**: mono or analogous. `paper FFFFFF · ink 1C2321 · muted 5E6A66 · line D3DAD6 · tint E8F0ED · accent 1F5E4B` (seed 160°).
- **Type**: Korean Noto Sans KR or Malgun Gothic, headings bold; Latin Calibri or Segoe UI. A serif body (Noto Serif KR / Cambria) suits a legal or academic variant.
- **Heading**: numbered assertion headings, bold, a step per level; title block left-aligned with a rule under it.
- **Table**: bold header on a rule, hairlines between rows, figures right-aligned, a total row set apart; a tint band only on the header when the callout uses the same tint.
- **Emphasis**: a boxed note or tinted band for the conclusion — or none; the finding can lead as the first paragraph in bold.
- **Chart**: quiet bars/lines, direct value labels, the subject in `accent`, the rest `muted`/`line`.
- **Chrome**: running head and "n / N" folio are right for a long, filed document; a short one needs only a folio or nothing.
- **Density**: dense, 30-40 Hangul characters per line, generous heading space.

### editorial-magazine
- **Fits**: features, newsletters, thought-leadership, annual-review stories, explainers written to be read for pleasure; a point of view and a narrative, not a decision table.
- **Palette**: complement or split, one saturated accent used large. `paper FFFFFF · ink 161616 · muted 6A6A6A · line CFCFCB · tint F1EEE8 · accent C8102E · accent2 0B3C5D`.
- **Type**: serif display over sans body — Korean Noto Serif KR headings, Noto Sans KR body; Latin Georgia or Cambria headings, Calibri body. A large size contrast (headline 4× body on the opener).
- **Heading**: oversized opener, a deck line, section heads in the serif; drop cap or a numeral as the anchor; a short kicker is allowed where it names something, not over every heading.
- **Table**: open — no vertical rules, thin rule under the header only, generous row space; used sparingly.
- **Emphasis**: pull quote across the column, a margin note, an oversized numeral; no callout box.
- **Chart**: annotated on the data (a labelled event, a bracket), accent on the point the story turns on.
- **Chrome**: folio and section name small at the foot, or only on the inside edge; none on the opener.
- **Density**: airy, 2-column or measure-limited text with side column; images carry pages.

### data-dashboard
- **Fits**: operational status, KPI reviews, monitoring, a surface scanned in under a minute and returned to; many figures, few paragraphs.
- **Palette**: analogous with a warm `accent2` reserved for the alert. `paper F4F6F8 (canvas) · card FFFFFF · ink 0F1B2D · muted 5A677A · line DCE1E8 · tint E6EEF8 · accent 0A7EA4 · accent2 F2A33A`.
- **Type**: Korean Noto Sans KR / Malgun Gothic; Latin Segoe UI with tabular figures (`font-variant-numeric: tabular-nums`); big numerals in bold.
- **Heading**: small, functional labels over modules; the page title short.
- **Table**: compact rows, zebra or hairline, sparkline/bar cells, status cell with word + glyph; figures right-aligned.
- **Emphasis**: KPI cards (figure over label, delta beside it), the one off-target figure in `accent2`.
- **Chart**: several small charts on a grid sharing scales; direct labels; light grid allowed.
- **Chrome**: a header strip with period and refresh date; a footer source line; no folio on a one-screen sheet.
- **Density**: high; cards on a grid with a consistent gutter.

### quiet-minimal
- **Fits**: considered internal notes, design or research write-ups, product principles, anything where restraint signals confidence and the content is short.
- **Palette**: mono; the accent is barely above the neutrals or equals ink. `paper FFFFFF · ink 222222 · muted 8A8A8A · line E6E6E6 · tint F6F6F6 · accent 3A5A78`.
- **Type**: one family — Korean Noto Sans KR (regular body, bold heading); Latin Calibri Light / Segoe UI Light for headings where light weights exist, regular elsewhere.
- **Heading**: modest size, weight and space do the work; no rules, no labels.
- **Table**: no fills, one hairline under the header, wide row spacing; or a list instead of a table.
- **Emphasis**: a bold sentence or an indented paragraph; no boxes.
- **Chart**: single series, one accent point, no axis lines.
- **Chrome**: none, or a lone page number in `muted`.
- **Density**: low; wide margins, short lines, more white than ink.

### keynote-statement
- **Fits**: a pitch, a launch, a vision or all-hands deck, a poster or one-page announcement; one claim per page, read from a distance or in seconds.
- **Palette**: complement, high contrast, large flat fields. `paper FFFFFF · ink 0B0B0B · muted 6B6B6B · line E2E2E2 · tint FFF1EB · accent FF4F1F · accent2 FFD400` (or the inverted dark field with `ink` as paper).
- **Type**: Korean Noto Sans KR ExtraBold (its own family) for display, regular for support; Latin Arial Black or Bahnschrift display with Calibri support; headline-to-body ratio 4-5 on the statement pages only.
- **Heading**: the claim is the page; one or two lines, broken at a phrase.
- **Table**: avoided; a three-row comparison at most, large type.
- **Emphasis**: one phrase of the headline in `accent`, a numeral at hero size, a colour field behind a single sentence.
- **Chart**: one chart per page, one highlighted bar or point, the takeaway stated in the title.
- **Chrome**: none, or a tiny brand mark and number in the corner.
- **Density**: very low; 40-60% of the page deliberately empty.

### letter-memo
- **Fits**: correspondence, memos, notices, cover letters, minutes, policy statements; a person writes to a person and the text is the point.
- **Palette**: mono and nearly colourless; one restrained accent for the letterhead only. `paper FFFFFF · ink 202020 · muted 666666 · line BBBBBB · tint F3F3F3 · accent 6B2D3C`.
- **Type**: serif or conventional — Korean Noto Serif KR or 바탕 (Batang) body, or Malgun Gothic for a modern memo; Latin Cambria, Georgia, or Times New Roman.
- **Heading**: letterhead/sender block, then the subject line in bold; section labels (if any) are run-in bold.
- **Table**: a plain ruled grid for a schedule or a list of attendees; top and bottom rule only for short ones.
- **Emphasis**: bold or underline in the sentence; a numbered list for actions; no callouts.
- **Chart**: normally none.
- **Chrome**: sender block and date at the top, "n / N" only past one page; no running head.
- **Density**: moderate; letter proportions, 1.5-1.7 line height, signature space.

### technical-reference
- **Fits**: manuals, specs, API or process documentation, runbooks, standards, anything looked up rather than read through, with code, parameters, and warnings.
- **Palette**: analogous, cool-neutral with a warning hue. `paper FFFFFF · ink 1A1F24 · muted 5C6670 · line C9D1D9 · tint F0F3F6 (code ground) · accent 00796B · accent2 C2410C (warning)`.
- **Type**: Korean Noto Sans KR / Malgun Gothic; Latin Segoe UI body, Consolas for code, names, and parameters (the Korean text stays in its own face).
- **Heading**: numbered sections (1.2.3), bold, stable levels; every section findable.
- **Table**: full grid or banded rows, a header fill, a parameter / type / meaning layout; monospace in the name column.
- **Emphasis**: labelled notes (Note / Warning) as boxed notes with a left rule or glyph, code blocks on `tint`.
- **Chart**: schematic diagrams and flow charts in line work; value charts rare.
- **Chrome**: running head with document and version, folio "n / N", section name; contents list at the front.
- **Density**: high and regular; consistent rhythm so the eye can scan.

### form-intake
- **Fits**: applications, intake and registration forms, checklists, order sheets, inspection records, anything a person fills in.
- **Palette**: mostly neutral, high contrast, field fills that read as "type here". `paper FFFFFF · ink 1E1E1E · muted 666666 · line 8C8C8C · tint EAF2E3 (fill-in) · accent 2E6B34`.
- **Type**: Korean Malgun Gothic or Noto Sans KR; Latin Arial or Calibri; labels in `muted` small caps-free sentence case, entered values in `ink`.
- **Heading**: numbered groups of fields with a short instruction line.
- **Table**: the form is a table — label cell and entry cell, visible rules (`line`), entry cells on `tint`; checkboxes as real squares.
- **Emphasis**: required marks, a single instruction box, a signature line.
- **Chart**: none.
- **Chrome**: form title and id at top, page "n / N", a return-to line at the foot.
- **Density**: moderate; entry cells tall enough to write in; nothing decorative.

### brand-campaign
- **Fits**: brochures, campaign one-pagers, event programmes, product launches, invitations, certificates; the look is the message and a brand or mood exists.
- **Palette**: the brand's own colours as roles, else complement or split, with a large colour field. `paper FFFDFB · ink 1D1A31 · muted 635F78 · line E9E4EE · tint FDE9E1 · accent E4572E · accent2 17BEBB`.
- **Type**: the brand face when the recipient has it; otherwise Korean Noto Sans KR ExtraBold display over Noto Sans KR, or Noto Serif KR for a gentler brand; Latin Trebuchet MS, Century Gothic, or Georgia.
- **Heading**: display type with personality, set against a picture or colour field; sections can change field colour.
- **Table**: a styled list or two-column spec, a pricing grid with an accented column; rarely a data table.
- **Emphasis**: a colour field, a badge, a large numeral, a tilted or cropped shape; the call to action as a button-shaped block.
- **Chart**: infographic-style, illustrated, few numbers, brand colours.
- **Chrome**: logo/wordmark placement, a footer with contact; no running head.
- **Density**: varied by page; one page may be a single picture and a line.

### dark-tech
- **Fits**: engineering and product-technology audiences, developer tools, security, AI or infrastructure briefings, night-mode dashboards; screens rather than paper.
- **Palette**: dark ground, one luminous accent, `accent2` for a second series. `paper 0B0F14 · ink E8EDF2 · muted 8B97A5 · line 222B36 · tint 131A22 · accent 3DDC97 · accent2 7C5CFF`. Keep the accent off large fields and body text: it is the mark.
- **Type**: Korean Noto Sans KR; Latin Bahnschrift or Segoe UI, Consolas for labels, figures, and code.
- **Heading**: bold sans, tight leading, a short monospace label where it names a module or version (not over every heading).
- **Table**: no fills, `line` rules only, monospaced figures; header in `muted`.
- **Emphasis**: the accent on one figure or phrase, a thin bracket frame or glow behind one metric; a callout is a `tint` card with a 1 px `line` border.
- **Chart**: luminous lines on the dark ground, accent for the subject, `muted` for the rest.
- **Chrome**: small status line at the top or foot (version, date); page number in `muted`.
- **Density**: medium-high with generous dark margins. For print, invert to a light ground rather than printing the dark field.

## 4. Translation per format
For the chosen concept, the format carries the same roles with its own anatomy. `STYLE` is the nearest `kit.md` `STYLES` id for the script route (`deck({ style })`), and the HTML route's visual language to start from (`direction.md` §3).
| Concept | Deck (HTML, 1920 × 1080) | Word document | Flowing PDF | Designed PDF (`section.slide` pages) | Excel report sheet | STYLE |
|---|---|---|---|---|---|---|
| formal-report | assertion titles on paper, evidence slides with chart + commentary, text mode; accent on one object per page | numbered headings, boxed note or lead paragraph, ruled tables, running head + folio when long | `@page` running head + folio margin boxes, ruled tables, narrow column + side rail for captions | cover, key-figures page, evidence pages in the sheet's margins; folio in the slide | title block, metric strip, ruled table, one native chart; print area one page wide | data-journalism |
| editorial-magazine | serif headline over sans, rail or column text, pull-quote and numeral pages, one picture-led page | serif headings, pull quote, two-column section, open tables | `@page` folio at the foot only, columns, drop cap, no boxed notes | full-bleed opener, feature spreads with image and margin note | story-led report: headline cell, short insight cells beside the chart, few tables | editorial |
| data-dashboard | KPI card rows, small multiples, table + chart, balanced mode | landscape sections with KPI table strip, compact zebra tables, small charts | landscape `@page`, KPI strip, compact tables, header strip | one-screen dashboard page on a grid of cards | KPI cards, charts beside tables, conditional formats; the default archetype for a dashboard | data-journalism |
| quiet-minimal | few words per slide, wide margins, one accent point | one family, no boxes, space-only hierarchy, no running head | wide margins, no `@page` boxes or a lone folio | sparse pages, one idea each | plain title, a table with one hairline, gridlines off | swiss-minimal |
| keynote-statement | one claim per slide at display size, colour fields, hero numerals | a poster-like cover page then plain text; rarely long | one-page announcement: large type, a colour band; no margin boxes | full-bleed claim pages, a numeral or phrase in accent | a summary sheet with 3-4 oversized figures; no more | swiss-minimal |
| letter-memo | rarely a deck; a single "message" slide at most | letterhead block, subject line, plain paragraphs, signature, no running head | the same on letter/A4 with `@page` margins and a folio only past one page | rarely designed; a one-page notice with letterhead | rarely a sheet; a cover note row above a table | swiss-minimal |
| technical-reference | blueprint diagrams, code panels, text mode | numbered headings, labelled notes, monospace cells, contents field | running head with version, folio, contents list, code blocks on `tint` | architecture diagram pages, reference cards | parameter table, change log, one summary sheet; formulas stay native | blueprint |
| form-intake | rarely; a checklist slide | fields as tables (label / entry), real checkboxes, instruction box; fill with the native route when it is a template | printed form with ruled entry cells | not used for fillable forms (the browser prints controls as pictures) | input sheet: legend, example row, validation, unlocked fill cells | soft-rounded |
| brand-campaign | colour-field pages, picture-led, badge and big numeral, CTA closing | brochure-like cover, colour band headings, styled lists; limited by Word's flow | folded-leaflet style with named cover `@page`, bands, no margin boxes | full-bleed designed pages, field colours change per spread | a branded summary sheet with colour header and a few charts | photo-editorial |
| dark-tech | dark theme throughout, glow behind one metric, bracket frames | light variant: dark title band, light body (Word prints on white); `tint` code panels | light ground for print; dark cover page via named `@page` | dark pages for screen reading | dark header band and light grid, accent on the KPIs | dark-tech |
If the nearest STYLE does not fit the page, use `custom` and write the five columns of `direction.md` §3 yourself.

## 5. Face menu per script
Faces named here are installed with Windows/Office or are the provisioned Noto families. A PDF embeds the fonts it drew with, so any installed face is safe there. Word, PowerPoint, and Excel write the face name into the file: the runtime warns when a face is not one the recipient is sure to have (an advisory, not a block), and a recipient without it sees a substitute — say so in the delivery, or choose from the safe column.
| Script / pairing | Display / heading | Body | Figures, code | Notes |
|---|---|---|---|---|
| Korean sans | Noto Sans KR (700), Noto Sans KR ExtraBold, Malgun Gothic (bold) | Noto Sans KR, Malgun Gothic | same family; Consolas for code | one face for Hangul and digits so the two share a baseline |
| Korean serif | Noto Serif KR (700), 바탕 (Batang) | Noto Serif KR, 바탕 | same family | Hangul has no italic: use weight, colour, or a rule |
| Korean mixed | Noto Serif KR headings | Noto Sans KR body | Noto Sans KR | serif display over sans body (editorial); keep the two Latin faces in step with them |
| Latin sans | Segoe UI Semibold, Bahnschrift, Arial, Trebuchet MS, Century Gothic, Calibri | Calibri, Segoe UI, Arial | tabular figures; Consolas for code | Calibri and Segoe UI are in every Office install |
| Latin serif | Georgia, Cambria, Palatino Linotype, Times New Roman, Bookman Old Style | Cambria, Georgia | Georgia has old-style figures: use Cambria for tables | serif body suits letters and essays |
| Latin mixed | Georgia or Cambria heading | Calibri or Segoe UI body | Consolas for labels | the editorial pairing |
Set Latin and East Asian faces together (Word `name` + `nameEastAsia`, CSS `font-family` listing both). Pair them deliberately: a Latin face beside a Korean face renders figures in the Latin one, and a Hangul line next to Latin digits can print at two apparent sizes — in a Korean-led document with many figures, set both in the Korean face; a distinct Latin face is for headings and Latin-led content.
