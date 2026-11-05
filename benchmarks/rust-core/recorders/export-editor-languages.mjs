// Exports the editor language tables of apps/desktop/src/shared/editor-languages.ts (a generated
// file) to JSON for the Rust workspace crate, which embeds it (`editorcfg.rs`): the language a
// path edits as selects the per-language overrides of `projectFs/readEditorSettings`.
//
//   node --experimental-transform-types benchmarks/rust-core/recorders/export-editor-languages.mjs <desktop repo root>
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const tree = process.argv[2];
if (!tree) throw new Error('usage: export-editor-languages.mjs <repo root>');
const module = await import(pathToFileURL(join(tree, 'apps/desktop/src/shared/editor-languages.ts')).href);
const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '../../../native/core/crates/mixdog-workspace/src/editor_languages.json');
writeFileSync(
  out,
  `${JSON.stringify({
    extensions: module.EDITOR_LANGUAGE_EXTENSIONS,
    names: module.EDITOR_LANGUAGE_NAMES,
    patterns: module.EDITOR_LANGUAGE_PATTERNS.map((p) => ({ scope: p.scope, languageId: p.languageId, source: p.regex.source, flags: p.regex.flags })),
  })}\n`
);
console.log('exported', Object.keys(module.EDITOR_LANGUAGE_EXTENSIONS).length, 'extensions');
