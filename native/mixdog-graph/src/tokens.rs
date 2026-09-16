// Identifier tokens and file-level declaration metadata, straight from the
// grammar (Stage 3-D).
//
// WHAT `tokens` IS
// ----------------
// The per-file candidate index the JS side reads as `tokenSymbols`: before it
// searches for references to a symbol it asks "which files even mention this
// name?" and answers with `tokens.includes(name)`. So the contract is
//
//   a symbol name that OCCURS IN THE CODE of a file is in that file's tokens
//
// and nothing more: a name whose only occurrences are inside comments or
// string literals is NOT a mention of the symbol, and dropping it is the
// point of this stage, not a regression. Pre-Stage-3 the list came from a
// regex over the whole file text, which could not tell code from prose.
//
// HOW THE KIND SET IS DERIVED
// ---------------------------
// Tokens are collected during the ONE outline/call traversal, from nodes the
// grammar itself calls identifiers. The set is computed per grammar from its
// node-type table (`node_kind_count` / `node_kind_for_id` /
// `node_kind_is_named`), never from a hand-written per-language list:
//
//   a NAMED node kind carries identifiers when any `_`-separated word of its
//   kind name is one of: identifier, name, variable, word, constant,
//   constructor, alias, symbol, atom
//
// which selects `identifier`, `type_identifier`, `field_identifier`,
// `property_identifier`, `shorthand_property_identifier_pattern`,
// `simple_identifier` (kotlin/swift), `word` (bash command words),
// `variable_name` / `name` (php, bash), `constant` / `instance_variable` /
// `global_variable` (ruby), `constructor` / `variable` (haskell) and `alias`
// (elixir) in the grammars this binary links — and nothing else. Comment and
// string kinds (`comment`, `line_comment`, `string_content`,
// `string_fragment`, `template_literal`, `quoted_content`, …) share none of
// those words, so comments and string bodies are excluded BY CONSTRUCTION,
// while an identifier inside a string INTERPOLATION is a real node of one of
// the kinds above and is therefore counted.
//
// `symbol`/`atom` are on the list because a LITERAL NAME is an identifier
// occurrence, not prose: ruby's `attr_accessor :name` / `send(:run)`
// (`simple_symbol`, `hash_key_symbol`, `bare_symbol`, `delimited_symbol`),
// dart's `#name` (`symbol_literal`) and elixir's `apply(M, :run, [])`
// (`atom`, `quoted_atom`) all name a declaration the graph indexes, so a file
// that mentions one really does mention that symbol. Those two words match
// nothing else in the linked grammars (typescript's `symbol` and swift's
// `_hash_symbol` are ANONYMOUS keyword tokens, and objc's `atomic_declaration`
// splits into `atomic`/`declaration`).
//
// Anonymous tokens (keywords, punctuation) are excluded: they are not named
// kinds. Composite kinds that pass the word rule (`scoped_identifier`,
// `nested_identifier`) are matched too, which costs a re-scan of text their
// children already reported and changes no result, because the emitted tokens
// are deduplicated.
//
// TOKEN SHAPE
// -----------
// A matched node contributes the IDENTIFIER-SHAPED RUNS of its text, in the
// exact shape the old regex produced (`[$@]?[XID_Start_][XID_Continue]*[!?]?`,
// approximated with `char::is_alphabetic` / `is_alphanumeric` plus `_`). For
// the overwhelming majority of nodes the text IS one run; the rule matters for
// the compound leaves some grammars keep whole (`Foo.Bar` for an Elixir
// alias, `a.b` for a dotted name), which stay two tokens exactly as before.
//
// FILE METADATA
// -------------
// The same table also marks the declaration nodes that carry `packageName`,
// `namespaceName` and `goPackageName`, so those three fields come from the
// parse tree instead of a line regex. `topLevelTypes` deliberately does NOT:
// see the note on `TypePatterns` in `main.rs`.

use std::sync::{Arc, LazyLock, RwLock};

use ast_grep_core::tree_sitter::LanguageExt;
use std::collections::HashMap;

use crate::scan_lang::ScanLang;

/// Kind-name words that mark a node kind as identifier-carrying. Matched
/// against the `_`-separated words of the kind name, so `type_identifier`,
/// `variable_name`, `instance_variable` and `simple_symbol` all qualify while
/// `string_content`, `namespace` and `comment` do not.
const IDENTIFIER_WORDS: &[&str] = &[
    "identifier",
    "name",
    "variable",
    "word",
    "constant",
    "constructor",
    "alias",
    "symbol",
    "atom",
];

/// One file-level metadata field a declaration node can carry.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MetaField {
    /// `packageName` — java `package_declaration`, kotlin `package_header`.
    Package,
    /// `namespaceName` — csharp `namespace_declaration` and its file-scoped
    /// form.
    Namespace,
    /// `goPackageName` — go `package_clause`.
    GoPackage,
}

/// What the walk does with a node of this kind. One table lookup per visited
/// node decides both token collection and metadata capture.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KindRole {
    None,
    Identifier,
    Meta(MetaField),
}

/// Per-grammar kind table, computed once per language and shared after.
pub struct GrammarKinds {
    roles: Vec<KindRole>,
    has_meta: bool,
}

impl GrammarKinds {
    fn build(lang: ScanLang) -> Self {
        let ts_lang = lang.get_ts_language();
        let count = ts_lang.node_kind_count();
        let mut roles = vec![KindRole::None; count];
        let mut has_meta = false;
        for id in 0..count {
            let kind_id = id as u16;
            // Anonymous tokens are keywords and punctuation, never identifier
            // occurrences, and never a declaration node.
            if !ts_lang.node_kind_is_named(kind_id) {
                continue;
            }
            let Some(name) = ts_lang.node_kind_for_id(kind_id) else {
                continue;
            };
            if let Some(field) = meta_field_for(lang.id(), name) {
                roles[id] = KindRole::Meta(field);
                has_meta = true;
            } else if is_identifier_kind(name) {
                roles[id] = KindRole::Identifier;
            }
        }
        Self { roles, has_meta }
    }

    #[inline]
    pub fn role(&self, kind_id: u16) -> KindRole {
        self.roles
            .get(kind_id as usize)
            .copied()
            .unwrap_or(KindRole::None)
    }

    /// True when this grammar has any `packageName`/`namespaceName`/
    /// `goPackageName` declaration node at all.
    pub fn has_meta(&self) -> bool {
        self.has_meta
    }
}

/// A node kind carries identifiers when one of the `_`-separated words of its
/// name is an identifier word. A leading `_` (tree-sitter's hidden-rule
/// marker) is not part of the name.
fn is_identifier_kind(kind: &str) -> bool {
    kind.trim_start_matches('_')
        .split('_')
        .any(|word| IDENTIFIER_WORDS.contains(&word))
}

/// The declaration node kinds that carry file-level metadata. This is a
/// per-language node-kind table, not a text pattern: the node IS the package
/// or namespace declaration, so no line shape has to be guessed.
fn meta_field_for(lang_id: &str, kind: &str) -> Option<MetaField> {
    match (lang_id, kind) {
        ("java", "package_declaration") => Some(MetaField::Package),
        ("kotlin", "package_header") => Some(MetaField::Package),
        ("csharp", "namespace_declaration" | "file_scoped_namespace_declaration") => {
            Some(MetaField::Namespace)
        }
        ("go", "package_clause") => Some(MetaField::GoPackage),
        _ => None,
    }
}

static TABLES: LazyLock<RwLock<HashMap<ScanLang, Arc<GrammarKinds>>>> =
    LazyLock::new(|| RwLock::new(HashMap::new()));

/// Kind table for `lang`, built on first use and shared after.
pub fn kinds_for(lang: ScanLang) -> Arc<GrammarKinds> {
    if let Some(found) = TABLES.read().expect("kind table").get(&lang) {
        return Arc::clone(found);
    }
    let built = Arc::new(GrammarKinds::build(lang));
    TABLES
        .write()
        .expect("kind table")
        .insert(lang, Arc::clone(&built));
    built
}

fn is_ident_start(ch: char) -> bool {
    ch.is_alphabetic() || ch == '_'
}

fn is_ident_continue(ch: char) -> bool {
    ch.is_alphanumeric() || ch == '_'
}

/// Identifier-shaped runs of one node's text, in the token shape the record
/// has always carried: an optional `$`/`@` sigil, an identifier start, the
/// identifier body, and one optional `!`/`?` suffix (ruby predicates, rust
/// macro calls). Emitted as borrowed slices of `text`, so collecting them
/// allocates nothing until the record is built.
pub fn identifier_runs<'t>(text: &'t str, mut emit: impl FnMut(&'t str)) {
    let mut cursor = 0usize;
    while cursor < text.len() {
        let Some(ch) = text[cursor..].chars().next() else {
            break;
        };
        let step = ch.len_utf8();
        let (begin, mut at) = if ch == '$' || ch == '@' {
            // A sigil only starts a run when an identifier follows it.
            let after = cursor + step;
            match text[after..].chars().next() {
                Some(next) if is_ident_start(next) => (cursor, after + next.len_utf8()),
                _ => {
                    cursor += step;
                    continue;
                }
            }
        } else if is_ident_start(ch) {
            (cursor, cursor + step)
        } else {
            cursor += step;
            continue;
        };
        while let Some(next) = text[at..].chars().next() {
            if !is_ident_continue(next) {
                break;
            }
            at += next.len_utf8();
        }
        if let Some(next) = text[at..].chars().next() {
            if next == '!' || next == '?' {
                at += next.len_utf8();
            }
        }
        emit(&text[begin..at]);
        cursor = at;
    }
}

/// True when `text` is EXACTLY one identifier run, so a node with this text
/// carries a token of its own beyond whatever identifier children it wraps.
/// PHP is the case that needs it: `variable_name` is `$` + a `name` child, so
/// the sigil form `$count` — the shape the record has always carried and the
/// shape a PHP reference search asks for — has no node of its own to visit.
/// Scans one run from the start and bails at the first character that is not
/// part of it, so a composite node's long text costs nothing.
pub fn is_single_run(text: &str) -> bool {
    let mut chars = text.char_indices();
    let Some((_, first)) = chars.next() else {
        return false;
    };
    let mut at = if first == '$' || first == '@' {
        match chars.next() {
            Some((index, next)) if is_ident_start(next) => index + next.len_utf8(),
            _ => return false,
        }
    } else if is_ident_start(first) {
        first.len_utf8()
    } else {
        return false;
    };
    while let Some(next) = text[at..].chars().next() {
        if !is_ident_continue(next) {
            break;
        }
        at += next.len_utf8();
    }
    if let Some(next) = text[at..].chars().next() {
        if next == '!' || next == '?' {
            at += next.len_utf8();
        }
    }
    at == text.len()
}

/// True when `text` is a dotted identifier path (`com.acme.app`, `main`), the
/// shape a package or namespace name has. Used to pick the name node out of a
/// declaration's children without depending on a per-grammar field name.
pub fn is_dotted_path(text: &str) -> bool {
    if text.is_empty() {
        return false;
    }
    text.split('.').all(|segment| {
        let mut chars = segment.chars();
        match chars.next() {
            Some(first) if first.is_ascii_alphabetic() || first == '_' => {}
            _ => return false,
        }
        chars.all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn runs(text: &str) -> Vec<&str> {
        let mut out = Vec::new();
        identifier_runs(text, |run| out.push(run));
        out
    }

    #[test]
    fn identifier_runs_keep_the_old_token_shape() {
        assert_eq!(runs("answer"), vec!["answer"]);
        assert_eq!(runs("$scope"), vec!["$scope"]);
        assert_eq!(runs("@ivar"), vec!["@ivar"]);
        assert_eq!(runs("valid?"), vec!["valid?"]);
        assert_eq!(runs("save!"), vec!["save!"]);
        // Compound leaves split into the same tokens the old regex produced.
        assert_eq!(runs("Foo.Bar"), vec!["Foo", "Bar"]);
        assert_eq!(runs("r#type"), vec!["r", "type"]);
        assert_eq!(runs("--flag"), vec!["flag"]);
        assert_eq!(runs("2fast"), vec!["fast"]);
        assert_eq!(runs("한글_ident"), vec!["한글_ident"]);
        assert!(runs("$ 1 + 2").is_empty());
    }

    #[test]
    fn identifier_word_rule_selects_identifier_kinds_only() {
        for kind in [
            "identifier",
            "type_identifier",
            "field_identifier",
            "property_identifier",
            "shorthand_property_identifier_pattern",
            "simple_identifier",
            "variable_name",
            "name",
            "word",
            "constant",
            "instance_variable",
            "constructor",
            "variable",
            "alias",
            "simple_symbol",
            "hash_key_symbol",
            "bare_symbol",
            "symbol_literal",
            "atom",
            "quoted_atom",
        ] {
            assert!(is_identifier_kind(kind), "{kind} must carry identifiers");
        }
        for kind in [
            "comment",
            "line_comment",
            "block_comment",
            "string_content",
            "string_fragment",
            "template_literal",
            "quoted_content",
            "namespace",
            "number",
            "escape_sequence",
            "raw_string_literal",
            "atomic_declaration",
        ] {
            assert!(
                !is_identifier_kind(kind),
                "{kind} must not carry identifiers"
            );
        }
    }

    #[test]
    fn every_extraction_grammar_has_identifier_kinds() {
        for info in crate::scan_lang::LANG_INFOS {
            if info.extract_extensions.is_empty() {
                continue;
            }
            for lang in crate::scan_lang::graph_lang_scan_langs(info.id) {
                let kinds = kinds_for(lang);
                let count = (0..u16::MAX)
                    .take_while(|id| (*id as usize) < kinds.roles.len())
                    .filter(|id| kinds.role(*id) == KindRole::Identifier)
                    .count();
                assert!(
                    count > 0,
                    "{}: grammar {lang} has no identifier kind",
                    info.id
                );
            }
        }
    }

    #[test]
    fn single_run_marks_the_nodes_that_carry_a_token_of_their_own() {
        // php `variable_name`, ruby `@ivar`: one run, sigil included.
        assert!(is_single_run("$count"));
        assert!(is_single_run("@name"));
        assert!(is_single_run("value"));
        assert!(is_single_run("valid?"));
        // Composite spans are not: their identifiers are their children's.
        assert!(!is_single_run("$count = compute($seed)"));
        assert!(!is_single_run("Foo.Bar"));
        assert!(!is_single_run("a::b"));
        assert!(!is_single_run("$ "));
        assert!(!is_single_run(""));
    }

    #[test]
    fn dotted_paths_match_the_package_name_shape() {
        assert!(is_dotted_path("com.acme.app"));
        assert!(is_dotted_path("main"));
        assert!(is_dotted_path("_private"));
        assert!(!is_dotted_path("@Annotation"));
        assert!(!is_dotted_path("com acme"));
        assert!(!is_dotted_path("com..acme"));
        assert!(!is_dotted_path(""));
    }
}
