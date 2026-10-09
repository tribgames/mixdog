# Office Use runtime

Implementation of the `office` tool: create, edit, validate, render, review, and
finalize Word, Excel, PowerPoint, PDF, and CSV/TSV documents, with or without
Microsoft Office installed.

## Layout

| Folder | Role |
| --- | --- |
| `(root)` | Public surface only: `index.mjs` (tool executor), `tool-defs.mjs`, `capabilities.mjs`. Test suites and `office-test-support.mjs` also live here. |
| `authoring/` | The `author` action — the only way a deck is made: `pptx-script-contract.mjs` (what a script may require and how long it may run; the model-facing guide is the built-in `pptx` skill in `src/defaults/skills/pptx`), `pptx-script-runner.mjs` (runs a pptxgenjs script in-process with a scoped `require`, injecting `MEASURE` and `ICON`), `pptx-script-normalize.mjs` (paragraph properties, hanging punctuation, accent-series merge), `pptx-html-runner.mjs` + `pptx-html-measure.mjs` + `pptx-html-build.mjs` (the HTML input: a local Chrome/Edge lays the slides out, the measurement becomes native text boxes, shapes, tables, charts, and pictures, and the browser's pages are kept for the HTML-beside-PPTX comparison), `pptx-author-action.mjs` (writes the deck, opens an `authored` session, renders, returns the composition receipt and contact sheet), `pptx-receipt.mjs`, `pptx-contact-sheet.mjs`, `pptx-icons.mjs` + `pptx-icons.json` (offline Lucide subset built by `npm run office:icons`), `pptx-brief.mjs`. Sits beside the root and imports `core`. |
| `core/` | Sessions, transactions, journal, snapshot pagination, tabular sessions, and the action pipeline (`office-actions-*.mjs`). |
| `com/` | Windows-native path: `com-adapter.mjs` plus the PowerShell hosts `office-com-host.ps1` and `office-com-session-host.ps1`. |
| `portable/` | OOXML read/write without Office, package validation, XLSX contracts, the backend-neutral XLSX audits shared by portable `issues`, Excel's `issues` merge, and the quality review (`xlsx-audit-support.mjs` cell reading and the capped issue list, `xlsx-sheet-hygiene.mjs` every-profile hygiene and layout information, `xlsx-formula-audit.mjs` the financial-model discipline and the orchestration), the workbook conventions summary a snapshot carries (`xlsx-conventions.mjs`), LibreOffice recalculation with its error summary (`portable-soffice.mjs` holds one private user profile for the life of the process, runs conversions one at a time behind it, and drops the profile after a failed run; `xlsx-recalculate.mjs` asks LibreOffice first and falls back to `xlsx-formula-engine.mjs`, which evaluates the formulas in this process and refuses — never guesses — the ones it cannot read; `portable-shared-formulas.mjs` gives every cell a shared or array formula covers the formula it actually holds, so a filled-down column is never read as pasted numbers), the sheet content audits (`portable-sheet-audits.mjs`: percent scale, column fit, protected inputs, unreadable ink, a hardcode inside a row of formulas), the leftover scan (`placeholder-scan.mjs`: template wording and tools' citation markers, read on slides, a document's body, headers and footers, and PDF pages), `convertLegacyOffice` in `portable-soffice.mjs` (a `.doc`/`.xls`/`.ppt` saved once as its package beside the original when `open` meets one), text and image metrics. |
| `pdf/` | `pdf-adapter.mjs` (session surface: snapshot, batch — including the marks `highlight`, `add_link`, `preview_fields` — validate, issues; re-exports `createPdf`), `pdf-writer.mjs` (blocks → pages, tables, page numbers), `pdf-forms.mjs` (field lint, add, describe, fill), `pdf-draw.mjs` (colors, page sizes, wrapping, images), `pdf-fonts.mjs` (system Unicode font fallback shared by create, marks, forms, and OCR), `pdf-analysis.mjs` (text layout with rules, boxes, and links, ruled and aligned tables, images, OCR), `pdf-search.mjs` (text search over a layout: lines from runs, glyph-width placement, whole words), `pdf-safety.mjs` (active-content report: JavaScript, Launch, non-web links), `pdf-render.mjs`, `pdf-security.mjs` (qpdf), `document-preview.mjs`. |
| `design/` | Design tokens, content model, composition, creative direction for the Word and Excel composers (`compose_document`, `compose_sheet`); `design-discipline.mjs` owns the safe typeface list, palette repair (tinted dark fields, WCAG contrast, paired accent tints), and the brief rules; `docx/`, `xlsx/` format compilers; `library/` template library with the bundled `templates/`. Decks are never composed here — a slide is authored by the model as a script (`authoring/`), and `compose_slide` is refused with that route. |
| `quality/` | Reviews and gates: `assurance-*.mjs` (trust, structure, rendered pages, checklist), aesthetics, design review, scoring, visual diff. |
| `bench/` | Benchmarks behind `npm run bench:office*`; `bench-support.mjs` holds the shared tool-call helpers. |
| `shared/` | Tiny helpers used across folders: `values.mjs` (`plainObject`, `clone`, `stableValue`, `sha256`, `clamp`, `compact`, `imageBuffer`), `page-sizes.mjs` (the paper sizes PDF create and Word `set_page` share), `column-widths.mjs` (the widths a Word or PDF table given none takes from its text), and `asar-path.mjs`. |

## Dependency direction

```
(root) -> authoring -> core -> { com, portable, pdf, design, quality }
design  -> portable, shared          quality -> design, portable, shared
pdf     -> portable                  bench   -> (root) and any folder
```

Folders never import upward: `design` must not import `quality`, and nothing
below `core` imports `core` or the root. `shared` imports nothing from Office.
Large modules are split by concern and keep a facade with the original name
(`core/office-actions.mjs`, `quality/assurance.mjs`) so consumers do not change.

## Model-facing results

Every tool result passes through `finalizeOfficeResult` (`core/office-core.mjs`)
before a model reads it. It drops only what the same result already carries or
what reads the same absent: a pre-fix issue list nothing fixed, a visual review
repeated at the top, empty lists and nulls, a trust report that found nothing,
a Word or workbook value equal to the document default, COM sentinels, raw page
measurements the issues were derived from, a passed package check's detail
(validator version, reopen fingerprint, default security, the parts Office adds
whenever it saves), each reader's own bookkeeping (character offsets, enumeration
numbers, a PDF viewport matrix and engine face ids), scores a measured qa could
not earn without a render, a delimited file's design, a profile palette an opened
document never applied, and guidance, a design, or receipt
structure a session already delivered (`modelReviewOnce`, `designOnce`,
`receiptForDelivery`). The stored
transaction review, snapshots, and every internal caller keep the full objects;
the digests copy and never mutate them. A field a caller needs back belongs in
the result, not in a digest exception.

## Packaging

`com/*.ps1` and `design/library/templates/*` are opened by external processes,
so they must stay outside the ASAR archive. `apps/desktop/scripts/prepare-runtime.mjs`
lists them as unpacked entries and `shared/asar-path.mjs` maps archive paths to
the physical sidecar at runtime. Moving these files means updating that list and
`apps/desktop/src/main/packaging.test.mjs`.

## Tests and benchmarks

### HTML-first design, native editable output

For new designed documents and report surfaces, the agent writes HTML/CSS for
the content and reader and sends it to `author`. PDF prints the browser layout;
Word, PowerPoint, and Excel map the supported layout to editable native content,
including live workbook formulas. Compare the converted pages with the HTML:
browser appearance alone does not prove fidelity or editability.

Concept catalogues, palettes, layout recipes, and rhythm metrics are optional
references, not style gates. The runtime retains factual, integrity, formula,
fit, and rendered-review checks. Native operations remain for existing-file
edits, templates, calculation/data sheets, and browser-unavailable fallbacks.
`compose_document`, `compose_sheet`, and `design.profile` remain opt-in presets.

The process is design → author → inspect actual pages → refine material issues.
A specimen or separate reviewer is optional when useful. A page review records
specific keep/fix observations, not required boolean declarations; it represents
agent judgement and never records user acceptance. Tests certify editing,
integrity and review-state behavior, not aesthetic quality.

Word formatting uses character-range edits across fragmented runs, with a
body-only first-match contract shared by COM and OOXML. Partial paragraph and
font edits preserve unspecified properties. `nameEastAsia` is independent of
the Latin face; `lineSpacing` is a minimum in points on both backends.

For Word, Excel and PDF, automated diagnostics never certify visual quality.
`finalize review:true` needs the current render token and one format-specific
page review in `design.critique` (`quality/document-acceptance.mjs`). Rendering
reports its actual renderer separately from the editing backend. Recalculation
invalidates pre-calculation Excel previews. Read-only sessions use `close`.

- `npm test -- src/runtime/office` runs the unit suites: `office-runtime-{contract,com,portable,pdf,pdf-marks,design}.test.mjs`
  (the PDF suite builds its own RC4-encrypted fixture, so no binary PDF is checked in),
  `xlsx-formula-audit` (the formula audit, conventions, recalculation summary, and style helpers without the runtime),
  `xlsx-portable-snapshot` (the portable workbook reader end to end),
  `portable-authoring`, `office-authoring`, `office-assurance`, `office-design-aesthetics`, `office-design-discipline`,
  `slide-quality`, `authoring/pptx-brief`, `authoring/pptx-receipt`, plus the desktop approval test; `pptx-skill-kit.slow`
  and `portable-authoring.slow` author real decks, and `portable-soffice.slow` drives real LibreOffice
  conversions (a failed run followed by a working one, and two renders asked for at once).
- `node scripts/run-office-live-tests.mjs` runs `office-live-runtime.test.mjs`, which needs Microsoft Office.
- `npm run bench:office`, `bench:office:contract`, `bench:office:assurance`, `bench:office:polish`,
  `bench:office:quality:live`.
