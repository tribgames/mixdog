// Rule-driven symbol and import extraction.
//
// Every declaration and import edge in a FileRecord comes from ast-grep
// outline rules (`ast-grep-outline`), not from hand-written tree-sitter
// queries or import regexes. Three rule sources are bundled into the binary,
// in this precedence order (first item rule that matches a node wins):
//
//   1. `src/outline_rules/parity.yml` — our rules, registered FIRST, so they
//      win for any node an upstream default rule also matches. Every
//      `language: TypeScript` document is ALSO loaded as a `language: Tsx`
//      copy (`tsx_variant`), because `.ts` and `.tsx` are separate
//      tree-sitter grammars that need identical rules.
//   2. `DEFAULT_OUTLINE_RULES` — ast-grep's defaults (14 languages).
//   3. `rules/outline/*.yml` — concatenated at build time by build.rs.
//
// Every rule document holds exactly ONE rule (`parse_rule_stream` reports a
// document with more, because `# mixdog-kind:` is a per-document marker), and
// every rule that fails to compile — unknown node kind, bad pattern, or no
// `kind:` to index the walk on — is reported through `rule_errors()` /
// `language_rule_errors()` instead of being dropped in silence. A language is
// an extraction language exactly while it has at least one COMPILED item rule
// (`has_rules`), so a broken or deleted rule file turns a language off loudly
// rather than leaving it emitting nothing.
//
// TRAVERSAL
// ---------
// `ast_grep_outline::combined_extractor::CombinedExtractors` stops descending
// once an item matches, which is right for a code outline but wrong for the
// code graph: JS closures, Rust `mod`/`impl` bodies, nested classes and inner
// functions must all report symbols. So the traversal here visits EVERY node
// and applies the compiled item/member extractors directly:
//
//   * inside a matched item, that item's member rules are tried first, so the
//     outline keeps its item/member shape (`--outline` output);
//   * otherwise item rules are tried, first match wins (rule order = source
//     order above);
//   * the walk always descends, so nesting depth is unlimited.
//
// SYMBOL SHAPE
// ------------
// Items and members both flatten into `SymbolInfo` — symbol record v2:
// `{ name, kind, startLine, endLine, startCol, endCol, exported?, sig?,
// parent? }`. The reported span is the matched declaration node, which is the
// node the old `@def` query capture used.
//
// Two layers decide `kind`. `symbol_kind` (plus a rule's `# mixdog-kind:`)
// still produces the PER-LANGUAGE Stage-2 kind; `KIND_MAP` then maps it into
// the one unified vocabulary every language reports in. The mapping is the
// only intentional result change of Stage 3-C: the symbol set, the lines and
// the columns are exactly what Stage 2 reported, and `--langs` publishes the
// map per language so a parity run can prove every changed kind is a declared
// pair.
//
// `exported` is the language's own visibility rule (`is_exported`), `sig` the
// declaration head on one line (`declaration_head`), and `parent` the
// innermost enclosing symbol — resolved by the same containment sweep that
// gives the call sites their `inSymbol`, over the same span list.
//
// SOURCE-IMPORT CONTRACT
// ----------------------
// `rawImports` holds the import edges the FILE ITSELF declares — import/require
// syntax in the parsed source tree. Module specifiers that only appear INSIDE
// string contents are not edges, even when the string is later compiled as
// code: `apps/desktop/src/renderer/*.slow.test.mjs` passes a whole React
// component to esbuild through `stdin: { contents: "...import ... from
// './use-composer-focus'..." }`, and that specifier belongs to the generated
// bundle, not to the test file. The pre-Stage-2 regexes matched string bodies
// and therefore reported 4 such edges (use-composer-focus.ts,
// ComposerGoalDialog.tsx, ProjectListSection.tsx, SidebarUsage.tsx +
// usage-dashboard-store.ts/window-layout.ts); the rule-driven extraction does
// not, which is the contract, not a regression. `require`-like CALLS are still
// edges at any nesting depth, including `createRequire` aliases
// (`_require('../../lib/x.cjs')`) — see `mixdog-*-require` in parity.yml.
//
// MODULES
// -------
// One responsibility per file; this module is the entry point and the whole
// public surface — every name below is re-exported here, so `outline::extract`,
// `outline::run`, `outline::KIND_MAP` and the rest keep their paths.
//
//   * `rules`      — the three rule sources, the `# mixdog-kind:` markers and
//                    the load/compile diagnostics.
//   * `extractors` — compiling one language's rules, and the single traversal
//                    that yields items, calls, tokens and file metadata.
//   * `symbols`    — outline entries → `SymbolInfo` records: which entries are
//                    symbols, deduplication, order, parent resolution.
//   * `kinds`      — the per-language Stage-2 kind of one entry.
//   * `kind_map`   — the unified Stage-3 vocabulary and the map into it.
//   * `signature`  — the declaration head (`sig`) and the head text scans.
//   * `visibility` — `exported`, per language.
//   * `imports`    — import specs in the shape the resolvers expect.
//   * `cli`        — the `--outline` dump mode.

mod cli;
mod extractors;
mod imports;
mod kind_map;
mod kinds;
mod rules;
mod signature;
mod symbols;
mod visibility;

#[cfg(test)]
mod test_support;

pub use cli::run;
pub use extractors::{extractors_for, FileMeta, LangExtractors, Walked, WalkedItem};
pub use imports::{expand_elixir_alias_spec, expand_php_use_spec};
pub use kind_map::{kind_map_for, unified_kind, KIND_MAP, KIND_VOCABULARY};
pub use kinds::symbol_kind;
pub use rules::{has_rules, language_rule_errors, rule_errors, DeclaredKind, LoadedRules};
pub use symbols::{extract, identifier_hits, Extraction, SymbolInfo};

pub(crate) use extractors::index_by_kind;
pub(crate) use rules::{marker_value, split_yaml_documents, tsx_variant};
pub(crate) use signature::collapse_whitespace;
