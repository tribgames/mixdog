// The unified kind vocabulary (Stage 3-C) and the per-language map into it.
//
// `kinds` answers in the language's own words; this table is the one place
// that turns those words into the single vocabulary every language reports in,
// and `--langs` publishes it per language so a parity run can prove every
// changed kind is a declared pair.

use std::collections::{BTreeMap, HashMap};
use std::sync::LazyLock;

/// The ONE kind vocabulary every language reports in (Stage 3-C). Lowercase,
/// language-neutral, closed: a rule may not invent a token outside this list,
/// and `KIND_MAP` maps every per-language Stage-2 kind into it.
///
/// `package`, `field`, `property`, `enumMember` are part of the vocabulary but
/// unused today: no Stage-2 kind maps to them because struct fields, class
/// properties and enum members were never graph symbols. `impl` is reached by
/// Dart extensions and Haskell instances; Rust `impl` blocks stay NON-symbols
/// (Stage 2 dropped them and emitting them now would be a new symbol, not a
/// kind change).
pub const KIND_VOCABULARY: &[&str] = &[
    "module",
    "namespace",
    "package",
    "class",
    "struct",
    "interface",
    "trait",
    "enum",
    "enumMember",
    "type",
    "function",
    "method",
    "constructor",
    "field",
    "property",
    "variable",
    "constant",
    "macro",
    "event",
    "protocol",
    "impl",
];

/// `Stage-2 kind → unified kind`, per language. This table IS the contract the
/// parity tool checks: a `KIND_CHANGE` is legitimate exactly when it is one of
/// these pairs, and `--langs` publishes it per language as `kinds`.
///
/// It must be TOTAL: every kind the Stage-2 extraction can emit for a language
/// — from a rule's `# mixdog-kind:` marker, from `kind_by_ast_kind`, or from
/// `kind_by_symbol_type` — has a row here, which
/// `kind_map_covers_every_emitted_kind` proves per language against the
/// grammars themselves.
///
/// Choices that are not a rename:
///   * `binding` → `variable` (ts/js): `const`/`let`/`var` declarators are all
///     one kind in the graph, and the vocabulary's `constant` is reserved for
///     languages that mark constness in the declaration itself.
///   * rust `const` → `constant`, rust `static` → `variable`: a `static` is a
///     mutable-in-principle global, a `const` is not.
///   * `record` (java/csharp) → `class`: a record IS a class in both.
///   * kotlin/scala `object` → `class`: a singleton object declares a type
///     with members; the vocabulary has no `object`.
///   * swift `actor` → `class`: a reference type with methods.
///   * dart `mixin` → `trait` (a named set of methods mixed into a class) and
///     dart `extension` → `impl` (methods attached to an existing type, which
///     is what `impl` means).
///   * zig `union` → `struct`: a container type with declared fields; the
///     vocabulary has no `union`.
///   * solidity `contract`/`library` → `class`, `event` → `event`. There is no
///     `pragma` row because there is no pragma rule any more: a compiler
///     directive declares nothing (see `rules/outline/solidity.yml`).
///   * haskell `data`/`newtype`/`type` → `type` (all three declare a type),
///     `class` → `trait` (a type class is Haskell's trait), `instance` →
///     `impl` (an instance IS the implementation of a class for a type).
///   * hcl: `module` → `module`; `variable`/`output`/`locals` → `variable`
///     (all three declare named values of the configuration);
///     `resource`/`data` → `struct` — they declare a NAMED TYPED OBJECT
///     (`aws_s3_bucket.logs`), not a value, so `variable` would be wrong;
///     `provider` → `namespace` (a named configuration scope for a plugin).
///     `field` stays reserved for block ATTRIBUTES, which are not symbols yet.
pub const KIND_MAP: &[(&str, &[(&str, &str)])] = &[
    (
        "typescript",
        &[
            ("function", "function"),
            ("class", "class"),
            ("interface", "interface"),
            ("enum", "enum"),
            ("type", "type"),
            ("method", "method"),
            ("binding", "variable"),
            ("namespace", "namespace"),
        ],
    ),
    (
        "javascript",
        &[
            ("function", "function"),
            ("class", "class"),
            ("method", "method"),
            ("binding", "variable"),
        ],
    ),
    ("python", &[("function", "function"), ("class", "class")]),
    (
        "go",
        &[
            ("function", "function"),
            ("method", "method"),
            ("type", "type"),
        ],
    ),
    (
        "rust",
        &[
            ("function", "function"),
            ("struct", "struct"),
            ("enum", "enum"),
            ("trait", "trait"),
            ("module", "module"),
            ("type", "type"),
            ("macro", "macro"),
            ("const", "constant"),
            ("static", "variable"),
        ],
    ),
    (
        "java",
        &[
            ("class", "class"),
            ("interface", "interface"),
            ("enum", "enum"),
            ("method", "method"),
            ("constructor", "constructor"),
            ("record", "class"),
        ],
    ),
    (
        "kotlin",
        &[
            ("function", "function"),
            ("class", "class"),
            ("object", "class"),
        ],
    ),
    (
        "csharp",
        &[
            ("class", "class"),
            ("interface", "interface"),
            ("struct", "struct"),
            ("enum", "enum"),
            ("method", "method"),
            ("constructor", "constructor"),
            ("record", "class"),
            ("local-function", "function"),
        ],
    ),
    (
        "c",
        &[
            ("function", "function"),
            ("struct", "struct"),
            ("enum", "enum"),
        ],
    ),
    (
        "cpp",
        &[
            ("function", "function"),
            ("class", "class"),
            ("struct", "struct"),
            ("method", "method"),
        ],
    ),
    (
        "ruby",
        &[
            ("method", "method"),
            ("class", "class"),
            ("module", "module"),
        ],
    ),
    (
        "php",
        &[
            ("function", "function"),
            ("class", "class"),
            ("method", "method"),
            ("interface", "interface"),
            ("enum", "enum"),
            ("trait", "trait"),
        ],
    ),
    (
        "swift",
        &[
            ("function", "function"),
            ("class", "class"),
            ("struct", "struct"),
            ("enum", "enum"),
            ("protocol", "protocol"),
            ("actor", "class"),
        ],
    ),
    (
        "scala",
        &[
            ("function", "function"),
            ("class", "class"),
            ("trait", "trait"),
            ("object", "class"),
        ],
    ),
    ("bash", &[("function", "function")]),
    ("lua", &[("function", "function")]),
    ("r", &[("function", "function")]),
    (
        "dart",
        &[
            ("function", "function"),
            ("method", "method"),
            ("class", "class"),
            ("enum", "enum"),
            ("mixin", "trait"),
            ("extension", "impl"),
        ],
    ),
    (
        "objc",
        &[
            ("function", "function"),
            ("method", "method"),
            ("class", "class"),
            ("protocol", "protocol"),
        ],
    ),
    (
        "elixir",
        &[
            ("module", "module"),
            ("function", "function"),
            ("macro", "macro"),
        ],
    ),
    (
        "zig",
        &[
            ("function", "function"),
            ("struct", "struct"),
            ("enum", "enum"),
            ("union", "struct"),
        ],
    ),
    (
        "solidity",
        &[
            ("function", "function"),
            ("contract", "class"),
            ("library", "class"),
            ("interface", "interface"),
            ("struct", "struct"),
            ("enum", "enum"),
            ("event", "event"),
        ],
    ),
    (
        "haskell",
        &[
            ("module", "module"),
            ("function", "function"),
            ("data", "type"),
            ("newtype", "type"),
            ("type", "type"),
            ("class", "trait"),
            ("instance", "impl"),
        ],
    ),
    (
        "hcl",
        &[
            ("module", "module"),
            ("variable", "variable"),
            ("output", "variable"),
            ("locals", "variable"),
            ("resource", "struct"),
            ("data", "struct"),
            ("provider", "namespace"),
        ],
    ),
];

static KIND_LOOKUP: LazyLock<HashMap<(&'static str, &'static str), &'static str>> =
    LazyLock::new(|| {
        let mut map = HashMap::new();
        for (lang, kinds) in KIND_MAP {
            for (old, new) in *kinds {
                map.insert((*lang, *old), *new);
            }
        }
        map
    });

/// Unified kind for one per-language Stage-2 kind. A kind with no row falls
/// back to itself, which keeps a brand-new rule visible instead of blank —
/// `kind_map_covers_every_emitted_kind` fails the build before that can ship.
pub fn unified_kind(graph_lang: &str, kind: &'static str) -> &'static str {
    KIND_LOOKUP
        .get(&(graph_lang, kind))
        .copied()
        .unwrap_or(kind)
}

/// The published `old kind → unified kind` map of one language (`--langs`).
pub fn kind_map_for(graph_lang: &str) -> BTreeMap<&'static str, &'static str> {
    KIND_MAP
        .iter()
        .filter(|(lang, _)| *lang == graph_lang)
        .flat_map(|(_, kinds)| kinds.iter().copied())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use ast_grep_outline::model::SymbolType;

    use crate::outline::kinds::{kind_by_ast_kind, kind_by_symbol_type};
    use crate::outline::rules::{DeclaredKind, RULES};
    use crate::outline::symbols::extract;
    use crate::scan_lang::{scan_lang_for_ext, ScanLang};

    /// Every graph language of one grammar (`Tsx` serves `typescript`).
    fn graph_langs_of(lang: ScanLang) -> Vec<&'static str> {
        crate::scan_lang::LANG_INFOS
            .iter()
            .filter(|info| !info.extract_extensions.is_empty())
            .filter(|info| crate::scan_lang::graph_lang_scan_langs(info.id).contains(&lang))
            .map(|info| info.id)
            .collect()
    }

    /// Every LSP category an outline rule can carry.
    const EVERY_SYMBOL_TYPE: &[SymbolType] = &[
        SymbolType::File,
        SymbolType::Module,
        SymbolType::Namespace,
        SymbolType::Package,
        SymbolType::Class,
        SymbolType::Method,
        SymbolType::Property,
        SymbolType::Field,
        SymbolType::Constructor,
        SymbolType::Enum,
        SymbolType::Interface,
        SymbolType::Function,
        SymbolType::Variable,
        SymbolType::Constant,
        SymbolType::String,
        SymbolType::Number,
        SymbolType::Boolean,
        SymbolType::Array,
        SymbolType::Object,
        SymbolType::Key,
        SymbolType::Null,
        SymbolType::EnumMember,
        SymbolType::Struct,
        SymbolType::Event,
        SymbolType::Operator,
        SymbolType::TypeParameter,
    ];

    /// The kind map has to be TOTAL: a kind the extraction can emit and the
    /// map does not carry would ship through `unified_kind`'s fallback as a
    /// per-language token, i.e. exactly the vocabulary Stage 3-C removes.
    ///
    /// The three sources of a kind are checked against the real inputs:
    /// every `# mixdog-kind:` marker of the loaded rule bundle, every LSP
    /// category (`kind_by_symbol_type`), and every NODE KIND OF THE GRAMMAR
    /// each language parses with (`kind_by_ast_kind`) — so a new grammar node
    /// or a new rule cannot silently escape the map.
    #[test]
    fn kind_map_covers_every_emitted_kind() {
        let mapped = |lang: &str, kind: &str| KIND_LOOKUP.contains_key(&(lang, kind));

        for rule in &RULES.rules {
            let Some(DeclaredKind::Symbol(kind)) = RULES.kinds.get(&rule.common().id).copied()
            else {
                continue;
            };
            for lang in graph_langs_of(rule.common().language) {
                assert!(
                    mapped(lang, kind),
                    "rule `{}` declares kind `{kind}` for {lang}, which KIND_MAP does not map",
                    rule.common().id
                );
            }
        }

        for info in crate::scan_lang::LANG_INFOS {
            if info.extract_extensions.is_empty() {
                continue;
            }
            for symbol_type in EVERY_SYMBOL_TYPE {
                if let Some(kind) = kind_by_symbol_type(info.id, *symbol_type) {
                    assert!(
                        mapped(info.id, kind),
                        "{}: symbolType {symbol_type:?} yields unmapped kind `{kind}`",
                        info.id
                    );
                }
            }
            for lang in crate::scan_lang::graph_lang_scan_langs(info.id) {
                let grammar = ast_grep_core::tree_sitter::LanguageExt::get_ts_language(&lang);
                for id in 0..grammar.node_kind_count() {
                    let Some(ast_kind) = grammar.node_kind_for_id(id as u16) else {
                        continue;
                    };
                    let Some(Some(kind)) = kind_by_ast_kind(info.id, ast_kind) else {
                        continue;
                    };
                    assert!(
                        mapped(info.id, kind),
                        "{}: node kind `{ast_kind}` yields unmapped kind `{kind}`",
                        info.id
                    );
                }
            }
        }
    }

    /// The vocabulary is closed, the map only speaks it, and every language
    /// that reports symbols publishes a map through `--langs`.
    #[test]
    fn kind_map_targets_stay_inside_the_vocabulary() {
        for (lang, kinds) in KIND_MAP {
            for (old, new) in *kinds {
                assert!(
                    KIND_VOCABULARY.contains(new),
                    "{lang}: `{old}` maps to `{new}`, which is not in the vocabulary"
                );
            }
        }
        for info in crate::scan_lang::LANG_INFOS {
            let published = kind_map_for(info.id);
            assert_eq!(
                published.is_empty(),
                info.extract_extensions.is_empty(),
                "{}: `--langs` must publish a kind map exactly for graph languages",
                info.id
            );
        }
        // And the mapping is what the record actually carries.
        assert_eq!(unified_kind("rust", "const"), "constant");
        assert_eq!(unified_kind("hcl", "resource"), "struct");
        assert_eq!(kind_map_for("dart").get("extension"), Some(&"impl"));
    }

    /// Every kind that reaches a RECORD is in the one vocabulary. The map
    /// tests prove the table; this one proves the emitted result, because
    /// `unified_kind` falls back to the per-language token when a kind is
    /// missing from the map.
    #[test]
    fn every_fixture_kind_is_in_the_vocabulary() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
        let mut pending = vec![root];
        let mut symbols = 0usize;
        while let Some(dir) = pending.pop() {
            let Ok(entries) = std::fs::read_dir(&dir) else {
                continue;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    pending.push(path);
                    continue;
                }
                let Some(ext) = path.extension().and_then(|ext| ext.to_str()) else {
                    continue;
                };
                let (Some(lang), Some(graph_lang)) =
                    (scan_lang_for_ext(ext), crate::lang::lang_for(ext))
                else {
                    continue;
                };
                let Ok(text) = std::fs::read_to_string(&path) else {
                    continue;
                };
                for symbol in extract(&text, graph_lang, lang).symbols {
                    assert!(
                        KIND_VOCABULARY.contains(&symbol.kind),
                        "{}: `{}` is outside the vocabulary",
                        path.display(),
                        symbol.kind
                    );
                    symbols += 1;
                }
            }
        }
        assert!(
            symbols > 200,
            "fixture corpus carried only {symbols} symbols"
        );
    }
}
