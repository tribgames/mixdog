# Page-world sources of the browser engine

Each `.js` file is the exact source text the TypeScript module under
`apps/desktop/src/main/browser/` exports today and runs inside the guest page.
The engine includes them with `include_str!("../assets/page/<name>.js")`.
`apps/desktop/src/main/browser/page-assets.test.mjs` asserts every file equals
its TypeScript source, so the copies cannot drift while the TypeScript runner
exists; `stable-rect.ts` stays in TypeScript for the host snapshot-scripts, and
the test keeps guarding its asset after the runner is gone.

Format:

- A file holding one source is that source, byte for byte, with no trailing
  newline.
- A file holding several sources starts each with a `//@@ <TypeScript export
  name>` line; the source runs to the next marker (the newline before it is not
  part of the source).
- Where the TypeScript composes text (a template literal interpolation) the
  asset carries a placeholder identifier `__MIXDOG_<NAME>__` that the engine
  replaces with the composed text: another asset, or `serde_json` output for a
  value (a JSON string or number literal, never raw text).

| File | Owning engine module | Placeholders |
| --- | --- | --- |
| `editability.js` | form-action preflight (editability check) | none |
| `file-drop.js` | upload by drop (drop guards: install, bound install, aim, take, bound take) | none |
| `ref-rect.js` | ref rect measurement (`BROWSER_REF_RECT`, `browserRefRectExpression`) | `__MIXDOG_STABLE_RECT__`, `__MIXDOG_REF_RECT__`, `__MIXDOG_REF__` |
| `stable-rect.js` | shared stable-rect measurement (used by ref-rect and ref-point-probe) | none |
| `scroll-text.js` | scroll text (match pass, apply pass) | `__MIXDOG_DOCUMENT_ROOTS__` (the document-roots function of the documents module), `__MIXDOG_WANTED__`, `__MIXDOG_TOKEN__` |
| `visual-locator.js` | visual locator | `__MIXDOG_QUERY__` (lower-cased trimmed query as JSON string), `__MIXDOG_MAXIMUM__` (clamped 1..50) |
| `payment-evidence.js` | payment evidence of the page | `__MIXDOG_HOSTS__` (JSON array of processor frame hosts) |
| `ref-point-probe.js` | ref point probe (hit-tested point of a ref) | `__MIXDOG_STABLE_RECT__`, `__MIXDOG_FRAME_HAS_TRANSFORM__` (the frame-transform function) |

The document-roots and frame-transform functions are not assets of this task;
their owners supply them to the placeholders above.
