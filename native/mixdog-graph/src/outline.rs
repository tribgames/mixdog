// Rule-driven symbol and import extraction.
//
// Every declaration and import edge in a FileRecord comes from ast-grep
// outline rules (`ast-grep-outline`). Three rule sources are bundled into the
// binary, in this precedence order (first item rule that matches a node wins):
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
// every rule that fails to compile is reported through `rule_errors()` /
// `language_rule_errors()` instead of being dropped. A language is an
// extraction language exactly while it has at least one COMPILED item rule
// (`has_rules`).
//
// TRAVERSAL
// ---------
// `ast_grep_outline::combined_extractor::CombinedExtractors` stops descending
// once an item matches, which is wrong for the code graph: JS closures, Rust
// `mod`/`impl` bodies, nested classes and inner functions must all report
// symbols. So the traversal visits EVERY node and applies the compiled
// item/member extractors directly:
//
//   * inside a matched item, that item's member rules are tried first, so the
//     outline keeps its item/member shape (`--outline` output);
//   * otherwise item rules are tried, first match wins (rule order = source
//     order above);
//   * the walk always descends, so nesting depth is unlimited.
//
// SYMBOL SHAPE
// ------------
// Items and members both flatten into `SymbolInfo`:
// `{ name, kind, startLine, endLine, startCol, endCol, exported?, sig?,
// parent? }`. The reported span is the matched declaration node.
//
// `symbol_kind` (plus a rule's `# mixdog-kind:`) produces the per-language
// kind; `KIND_MAP` maps it into the one unified vocabulary every language
// reports in, and `--langs` publishes the map per language.
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
// bundle, not to the test file. `require`-like CALLS are still edges at any
// nesting depth, including `createRequire` aliases
// (`_require('../../lib/x.cjs')`) — see `mixdog-*-require` in parity.yml.
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

pub use cli::{FileOutline, OutlineItem, OutlineMember, OutlineReport, outline_files, run};
pub use extractors::{FileMeta, LangExtractors, Walked, WalkedItem, extractors_for};
pub use imports::{expand_elixir_alias_spec, expand_php_use_spec};
pub use kind_map::{KIND_MAP, KIND_VOCABULARY, kind_map_for, unified_kind};
pub use kinds::symbol_kind;
pub use rules::{DeclaredKind, LoadedRules, has_rules, language_rule_errors, rule_errors};
pub use symbols::{Extraction, SymbolInfo, extract, identifier_hits};

pub(crate) use extractors::index_by_kind;
pub(crate) use rules::{marker_value, split_yaml_documents, tsx_variant};
pub(crate) use signature::collapse_whitespace;
