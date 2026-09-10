# Desktop and web localization audit

## Scope

The existing twelve display languages: English, Korean, Japanese, Simplified
Chinese, Traditional Chinese, Spanish, French, German, Italian, Brazilian
Portuguese, Russian, and Vietnamese. Includes renderer UI, native dialogs and
menus, pre-React installation/pairing/recovery screens, and push notifications.
CLI/TUI localization and new languages are explicitly excluded.

## Findings and changes

- The initial catalog check reported 78 Korean problems and 728 problems in
  each of the other ten non-English catalogs. These included missing keys and
  a damaged Korean interpolation token.
- Catalog JSON is now the translation source of truth. Offline synchronization
  shares extraction with the checker instead of maintaining a second, 15,000-line
  seed catalog. Existing dynamic/legacy keys are retained.
- Native dialog keys are extracted from their actual callers rather than a
  manually maintained allowlist. File-picker and workspace-dialog labels now
  use the selected display language; paths and file extensions remain literal.
- Boot recovery and the installation/pairing guide use a small generated
  projection of the same catalogs before i18next or React loads. Translated
  strings are assigned through `textContent`, never interpolated into HTML.
- The renderer, native dialogs, boot script and worker use the same locale
  selection contract. Explicit Chinese scripts take precedence over regions;
  invalid preferences use the ordered supported system languages.
- Failed catalog loads switch back to English consistently, including document
  language and the language published to push notifications. Failed preference
  writes are reported rather than triggering a reload that loses the selection.
- UI dates, numbers, compact token counts, USD amounts and duration units follow
  the active display language. Protocol values, date input values, Git's compact
  numeric commit byline, file extensions, and raw diagnostics stay unchanged.
- Counted messages support the locale's CLDR plural categories. English has a
  small explicit singular map; synchronization no longer strips valid plurals.
- Reviewed Git actions distinguish staging from deletion, checkout from
  payment, and squash from its unrelated everyday meanings. Destructive-action
  warnings and the related count/placeholder variants retain their meaning.
- Accessibility labels include `alt` and `aria-description`. Queue text,
  conversation titles, paths, code and transcript content remain literal.

## Translation provenance and limits

Korean missing UI text was edited directly. Additional locale drafts were
completed using the optional `translate-missing.mjs` maintenance tool and
reviewed for critical warnings and interpolation. This tool sends only missing
English UI phrases to Google Translate; it is never invoked by synchronization,
checks, builds, or the application. It protects placeholders and technical
literals, validates each batch, and retains completed batches on failure.
Machine-assisted coverage is not a claim of native-speaker copy review for all
languages. Provider/server diagnostics and user-authored content are not
translated wholesale.

## Maintenance

From `apps/desktop`:

1. Use English source keys and explicit `t()` for new renderer text, `nativeT()`
   for native dialogs, or `earlyUiT()` for pre-React UI. Do not interpolate user
   content into translation keys.
2. Run `npm run i18n:sync`. Missing translations remain visibly empty; sync
   neither calls a network service nor fills them with English to pass a check.
3. Edit the locale catalogs, then run `npm run i18n:sync` again to regenerate
   native/boot projections.
4. Run `npm run i18n:check` and the relevant behavior tests.

`scripts/i18n/boot.template.js` owns the boot implementation.
`src/renderer/public/boot.js`, `public/ui-language.js`, and the native catalog
projections are generated artifacts, not independent implementations.
For counted messages, add the English singular contract to `ui-plurals.json`
and provide the categories requested by synchronization for each language.

## Verification coverage

Targeted tests cover all supported renderer languages, native file dialogs,
boot recovery, the actual pre-React installation guide, push fallback, locale
selection, storage and catalog-load failures, plural selection, formatting,
accessibility, literal user content, and HTML injection resistance. Catalog
checks cover extraction, missing/empty values, interpolation, and generated
artifact freshness. Type checks and a renderer build cover module compatibility.

Validation results: the catalog checker passed for 11 translated locales ×
2,500 base keys (plus locale-specific plural variants). Both desktop TypeScript
checks and the Electron main/preload/renderer production build passed.
