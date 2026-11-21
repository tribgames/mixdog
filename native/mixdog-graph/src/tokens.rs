// Identifier tokens and file-level declaration metadata from the grammar.
//
// `tokens` is the per-file candidate index the JS side reads as `tokenSymbols`
// (`tokens.includes(name)`): a symbol name that occurs in the code of a file is
// in its tokens; a name only in comments or string literals is not.
//
// A named node kind carries identifiers when any `_`-separated word of its
// kind name is one of IDENTIFIER_WORDS, derived per grammar from its node-type
// table. Comment and string kinds share none of those words; an identifier in
// a string interpolation is its own node and is counted. `symbol` and `atom`
// are listed because literal names (ruby `:run`, dart `#name`, elixir `:run`)
// name indexed declarations. Anonymous tokens are excluded; composite kinds
// such as `scoped_identifier` re-scan their children's text, which changes no
// result because emitted tokens are deduplicated.
//
// File metadata (`packageName`, `namespaceName`, `goPackageName`) comes from
// the declaration nodes marked in the same table. `topLevelTypes` does not:
// see `resolve/top_level_types.rs`.
use std::sync::{Arc, LazyLock, RwLock};

use ast_grep_core::tree_sitter::LanguageExt;
use std::collections::HashMap;

use crate::scan_lang::{ScanLang, cached_for_lang};

const IDENTIFIER_WORDS: &[&str] = &["identifier", "name", "variable", "word", "constant", "constructor", "alias", "symbol", "atom"];

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
        for (id, role) in roles.iter_mut().enumerate() {
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
                *role = KindRole::Meta(field);
                has_meta = true;
            } else if is_identifier_kind(name) {
                *role = KindRole::Identifier;
            }
        }
        Self { roles, has_meta }
    }

    #[inline]
    pub fn role(&self, kind_id: u16) -> KindRole {
        self.roles.get(kind_id as usize).copied().unwrap_or(KindRole::None)
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
    kind.trim_start_matches('_').split('_').any(|word| IDENTIFIER_WORDS.contains(&word))
}

/// The declaration node kinds that carry file-level metadata. This is a
/// per-language node-kind table, not a text pattern: the node IS the package
/// or namespace declaration, so no line shape has to be guessed.
fn meta_field_for(lang_id: &str, kind: &str) -> Option<MetaField> {
    match (lang_id, kind) {
        ("java", "package_declaration") => Some(MetaField::Package),
        ("kotlin", "package_header") => Some(MetaField::Package),
        ("csharp", "namespace_declaration" | "file_scoped_namespace_declaration") => Some(MetaField::Namespace),
        ("go", "package_clause") => Some(MetaField::GoPackage),
        _ => None,
    }
}

static TABLES: LazyLock<RwLock<HashMap<ScanLang, Arc<GrammarKinds>>>> = LazyLock::new(|| RwLock::new(HashMap::new()));

/// Kind table for `lang`, built on first use and shared after.
pub fn kinds_for(lang: ScanLang) -> Arc<GrammarKinds> {
    cached_for_lang(&TABLES, lang, "kind table", || GrammarKinds::build(lang))
}

fn is_ident_start(ch: char) -> bool {
    ch.is_alphabetic() || ch == '_'
}

fn is_ident_continue(ch: char) -> bool {
    ch.is_alphanumeric() || ch == '_'
}

/// Identifier-shaped runs of `text`: optional `$`/`@` sigil, identifier start
/// and body, optional `!`/`?` suffix (ruby predicates, rust macro calls).
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
        at = run_end(text, at);
        emit(&text[begin..at]);
        cursor = at;
    }
}

/// True when `text` is exactly one identifier run. PHP `variable_name` is `$`
/// plus a `name` child, so `$count` has no node of its own.
pub fn is_single_run(text: &str) -> bool {
    let mut chars = text.char_indices();
    let Some((_, first)) = chars.next() else {
        return false;
    };
    let at = if first == '$' || first == '@' {
        match chars.next() {
            Some((index, next)) if is_ident_start(next) => index + next.len_utf8(),
            _ => return false,
        }
    } else if is_ident_start(first) {
        first.len_utf8()
    } else {
        return false;
    };
    run_end(text, at) == text.len()
}

/// End of the identifier run whose first character ends at `at`: the
/// identifier body, then one optional `!`/`?` suffix.
fn run_end(text: &str, mut at: usize) -> usize {
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
    at
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
            assert!(!is_identifier_kind(kind), "{kind} must not carry identifiers");
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
                let count = (0..u16::MAX).take_while(|id| (*id as usize) < kinds.roles.len()).filter(|id| kinds.role(*id) == KindRole::Identifier).count();
                assert!(count > 0, "{}: grammar {lang} has no identifier kind", info.id);
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
