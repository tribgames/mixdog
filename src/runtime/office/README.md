# Office Use runtime

Implementation of the `office` tool: create, edit, validate, render, review, and
finalize Word, Excel, PowerPoint, PDF, and CSV/TSV documents, with or without
Microsoft Office installed.

## Layout

| Folder | Role |
| --- | --- |
| `(root)` | Public surface only: `index.mjs` (tool executor), `tool-defs.mjs`, `capabilities.mjs`. Test suites and `office-test-support.mjs` also live here. |
| `core/` | Sessions, transactions, journal, snapshot pagination, tabular sessions, and the action pipeline (`office-actions-*.mjs`, `office-candidate-actions.mjs`). |
| `com/` | Windows-native path: `com-adapter.mjs` plus the PowerShell hosts `office-com-host.ps1` and `office-com-session-host.ps1`. |
| `portable/` | OOXML read/write without Office, package validation, XLSX contracts, text and image metrics. |
| `pdf/` | PDF adapter, analysis (text layout, OCR, tables), page rendering, document preview. |
| `design/` | Design tokens, content model, composition, creative direction, layout grammar; `pptx/`, `docx/`, `xlsx/` format compilers; `library/` template library with the bundled `templates/`. |
| `quality/` | Reviews and gates: `assurance-*.mjs` (trust, structure, rendered pages, checklist), aesthetics, design review, scoring, visual diff. |
| `bench/` | Benchmarks behind `npm run bench:office*`; `bench-support.mjs` holds the shared tool-call helpers. |
| `shared/` | Tiny helpers used across folders: `values.mjs` (`plainObject`, `clone`, `stableValue`, `sha256`, `clamp`, `compact`, `imageBuffer`) and `asar-path.mjs`. |

## Dependency direction

```
(root) -> core -> { com, portable, pdf, design, quality }
design  -> portable, shared          quality -> design, portable, shared
pdf     -> portable                  bench   -> (root) and any folder
```

Folders never import upward: `design` must not import `quality`, and nothing
below `core` imports `core` or the root. `shared` imports nothing from Office.
Large modules are split by concern and keep a facade with the original name
(`core/office-actions.mjs`, `quality/assurance.mjs`) so consumers do not change.

## Packaging

`com/*.ps1` and `design/library/templates/*` are opened by external processes,
so they must stay outside the ASAR archive. `apps/desktop/scripts/prepare-runtime.mjs`
lists them as unpacked entries and `shared/asar-path.mjs` maps archive paths to
the physical sidecar at runtime. Moving these files means updating that list and
`apps/desktop/src/main/packaging.test.mjs`.

## Tests and benchmarks

- `npm run test:office` runs the unit suites: `office-runtime-{contract,com,portable,pdf,design}.test.mjs`,
  `portable-authoring`, `office-assurance`, `office-design-aesthetics`, `office-freeform-pipeline`,
  `slide-quality`, plus the desktop approval test.
- `node scripts/run-office-live-tests.mjs` runs `office-live-runtime.test.mjs`, which needs Microsoft Office.
- `npm run bench:office`, `bench:office:contract`, `bench:office:assurance`, `bench:office:polish`,
  `bench:office:quality:live`, `bench:office:freeform:live`.
