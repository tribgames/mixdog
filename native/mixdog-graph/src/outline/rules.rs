// Rule loading: the bundled sources, the `# mixdog-kind:` markers and the
// load-time diagnostics.
//
// The three rule sources and their precedence are described in the module
// header of `src/outline.rs`. This file owns reading them: splitting each
// stream into single-rule documents, reading each document's kind marker,
// mirroring the TypeScript documents onto the Tsx grammar, and reporting every
// document that does not parse instead of dropping its rules.

use std::collections::{HashMap, HashSet};
use std::sync::{LazyLock, RwLock};

use ast_grep_outline::extractor::{parse_outline_rules, SerializableOutlineRule};
use ast_grep_outline::DEFAULT_OUTLINE_RULES;

use super::extractors::extractors_for;
use crate::scan_lang::{graph_lang_scan_langs, ScanLang};

/// Our parity rules (registered before the ast-grep defaults).
const PARITY_RULES: &str = include_str!("../outline_rules/parity.yml");
/// `rules/outline/*.yml`, concatenated by build.rs (may be empty).
const BUNDLED_RULES: &str = include_str!(concat!(env!("OUT_DIR"), "/outline_rules.yml"));

/// Default rules whose output shape does not fit the FileRecord contract and
/// which a `mixdog-*` rule replaces, or which only cost match time because
/// their symbols are dropped by `symbol_kind` anyway.
const DISABLED_DEFAULT_RULES: &[&str] = &[
    // The `export ...` wrappers report the export statement as the symbol:
    // the span starts at `export` instead of the declaration, and a
    // destructuring `export const { a, b } = x` is named after the whole
    // pattern. The declaration nodes inside are matched by the `mixdog-*`
    // rules (which also carry the isExported predicate the defaults hardcode).
    "ts-export-function",
    "ts-export-class",
    "ts-export-interface",
    "ts-export-type",
    "ts-export-enum",
    "ts-export-const",
    "ts-export-const-typed",
    "ts-export-let",
    "ts-export-let-typed",
    "ts-export-namespace",
    "ts-export-ambient-module",
    "tsx-export-function",
    "tsx-export-class",
    "tsx-export-interface",
    "tsx-export-type",
    "tsx-export-enum",
    "tsx-export-const",
    "tsx-export-const-typed",
    "tsx-export-let",
    "tsx-export-let-typed",
    "tsx-export-namespace",
    "tsx-export-ambient-module",
    "js-export-function",
    "js-export-class",
    "js-export-const",
    "js-export-let",
    // Replaced by the same-id rule in parity.yml (which reports the real
    // export flag); the default member rules keep attaching through the id.
    "ts-class",
    "ts-interface",
    "ts-enum",
    "tsx-class",
    "tsx-interface",
    "tsx-enum",
    "js-class",
    // Named after the whole `type (...)` block; `mixdog-go-type-spec` reports
    // one symbol per spec instead.
    "go-struct-type",
    "go-interface-type",
    "go-type",
    // Go const/var and C globals are not graph symbols; both rules walk every
    // declaration node to decide scope.
    "go-const",
    "go-var",
    "c-global-variable",
    // Module-level assignments are not graph symbols and the scope test runs
    // `stopBy: end` on every assignment in the file.
    "python-module-constant",
    "python-module-variable",
    // `import a.b as c` names the alias clause, and `from a.b.c import x` only
    // matches a single-segment module; `mixdog-python-import-*` report the
    // module path itself.
    "python-import",
    "python-import-from",
];

/// What a rule produces for the graph.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DeclaredKind {
    /// `# mixdog-kind: import` — an import edge, never a symbol.
    Import,
    /// Any other `# mixdog-kind:` token — the graph `kind` verbatim.
    Symbol(&'static str),
}

/// A rule file declares the graph kind of each rule in a comment directly
/// above it:
///
///   # mixdog-kind: function
///   id: lua-function
///
/// That keeps the kind vocabulary with the rule instead of in a Rust table a
/// rule author cannot see, and it is the only way to tell apart declarations
/// that share both an ast kind and an LSP symbol type (Zig struct vs union,
/// Elixir def vs defmacro). Rules WITHOUT the marker — ast-grep's defaults and
/// our `parity.yml` — resolve through `symbol_kind` instead.
fn declared_kind_of(doc: &str) -> Option<DeclaredKind> {
    let token = marker_value(doc, "# mixdog-kind:")?;
    if token.is_empty() {
        return None;
    }
    if token == "import" {
        return Some(DeclaredKind::Import);
    }
    Some(DeclaredKind::Symbol(intern_kind(token)))
}

/// The trimmed value of the LAST `marker` comment line in one rule document
/// (`# mixdog-kind:`, `# mixdog-call-kind:`, `# mixdog-call-recv:`), or
/// `None` when the document carries no such line.
pub(crate) fn marker_value<'d>(doc: &'d str, marker: &str) -> Option<&'d str> {
    doc.lines()
        .filter_map(|line| line.trim().strip_prefix(marker))
        .last()
        .map(str::trim)
}

/// Graph kinds are `&'static str` in the FileRecord, and a rule file may name
/// a kind this crate has never seen (a new language's vocabulary). Interning
/// leaks at most one small string per distinct kind, once per process.
pub(super) fn intern_kind(token: &str) -> &'static str {
    static INTERNED: LazyLock<RwLock<HashSet<&'static str>>> =
        LazyLock::new(|| RwLock::new(HashSet::new()));
    if let Some(found) = INTERNED.read().expect("kind intern").get(token) {
        return found;
    }
    let mut guard = INTERNED.write().expect("kind intern");
    if let Some(found) = guard.get(token) {
        return found;
    }
    let leaked: &'static str = Box::leak(token.to_string().into_boxed_str());
    guard.insert(leaked);
    leaked
}

/// Split a multi-document YAML stream on column-zero `---` separators and
/// parse each document on its own, so one broken rule file cannot take the
/// whole bundle down, every error names its document, and the
/// `# mixdog-kind:` comment can be read per document.
///
/// A document must declare exactly ONE rule: the kind marker is a per-document
/// comment, so two rules in one document would silently share one kind. A
/// document with more is reported and its rules are loaded WITHOUT a declared
/// kind, which also trips the `# mixdog-kind:` coverage test for our own rule
/// files instead of shipping a wrong kind.
pub(super) fn parse_rule_stream(
    source: &str,
    origin: &str,
    rules: &mut Vec<SerializableOutlineRule<ScanLang>>,
    kinds: &mut HashMap<String, DeclaredKind>,
    errors: &mut Vec<String>,
) {
    for (index, doc) in split_yaml_documents(source).into_iter().enumerate() {
        parse_rule_document(doc, origin, index + 1, rules, kinds, errors);
    }
}

fn parse_rule_document(
    doc: &str,
    origin: &str,
    number: usize,
    rules: &mut Vec<SerializableOutlineRule<ScanLang>>,
    kinds: &mut HashMap<String, DeclaredKind>,
    errors: &mut Vec<String>,
) {
    if doc.trim().is_empty() {
        return;
    }
    match parse_outline_rules::<ScanLang>(doc) {
        Ok(parsed) => {
            if parsed.len() > 1 {
                let ids: Vec<&str> = parsed
                    .iter()
                    .map(|rule| rule.common().id.as_str())
                    .collect();
                errors.push(format!(
                    "{origin}: document {number}: {} rules in one YAML document ({}); \
                     split them with `---` so `# mixdog-kind:` binds to one rule",
                    parsed.len(),
                    ids.join(", ")
                ));
            } else if let Some(kind) = declared_kind_of(doc) {
                for rule in &parsed {
                    kinds.insert(rule.common().id.clone(), kind);
                }
            }
            rules.extend(parsed);
        }
        Err(error) => errors.push(format!("{origin}: document {number}: {error}")),
    }
}

/// `parity.yml` is written against the TypeScript grammar; `.tsx` files parse
/// with the separate `tsx` grammar and need the very same rules, so every
/// `language: TypeScript` document is loaded a second time with the language
/// line rewritten. Returns `None` for a document that is not TypeScript.
pub(crate) fn tsx_variant(doc: &str) -> Option<String> {
    let mut found = false;
    let mut out = String::with_capacity(doc.len());
    for line in doc.split_inclusive('\n') {
        if !found && line.trim_end() == "language: TypeScript" {
            found = true;
            out.push_str("language: Tsx");
            if line.ends_with('\n') {
                out.push('\n');
            }
            continue;
        }
        out.push_str(line);
    }
    found.then_some(out)
}

/// Parse our own rules, adding the derived TSX copy of every TypeScript
/// document right after it so both grammars keep identical rule order.
fn parse_parity_stream(
    source: &str,
    rules: &mut Vec<SerializableOutlineRule<ScanLang>>,
    kinds: &mut HashMap<String, DeclaredKind>,
    errors: &mut Vec<String>,
) {
    for (index, doc) in split_yaml_documents(source).into_iter().enumerate() {
        parse_rule_document(doc, "parity.yml", index + 1, rules, kinds, errors);
        if let Some(tsx) = tsx_variant(doc) {
            parse_rule_document(
                &tsx,
                "parity.yml (tsx copy)",
                index + 1,
                rules,
                kinds,
                errors,
            );
        }
    }
}

pub(crate) fn split_yaml_documents(source: &str) -> Vec<&str> {
    let mut docs = Vec::new();
    let mut start = 0usize;
    let mut offset = 0usize;
    for line in source.split_inclusive('\n') {
        if line.trim_end() == "---" {
            docs.push(&source[start..offset]);
            start = offset + line.len();
        }
        offset += line.len();
    }
    docs.push(&source[start..]);
    docs
}

pub struct LoadedRules {
    pub(super) rules: Vec<SerializableOutlineRule<ScanLang>>,
    pub(super) kinds: HashMap<String, DeclaredKind>,
    pub(super) errors: Vec<String>,
}

fn load_rules() -> LoadedRules {
    let mut rules = Vec::new();
    let mut kinds = HashMap::new();
    let mut errors = Vec::new();
    parse_parity_stream(PARITY_RULES, &mut rules, &mut kinds, &mut errors);
    // Defaults are filtered on their own: a parity rule may REPLACE a default
    // rule by reusing its id (so the default's member rules keep attaching to
    // it), and dropping by id must not take the replacement with it.
    let mut defaults = Vec::new();
    parse_rule_stream(
        DEFAULT_OUTLINE_RULES,
        "ast-grep defaults",
        &mut defaults,
        &mut kinds,
        &mut errors,
    );
    // Upstream defaults stay loaded for every language parity.yml touches:
    // dropping them per language was measured and loses symbols in ALL of them
    // (rust 888, csharp 307, python 231, kotlin 12, swift 11, c 8, ruby 8,
    // java 6, php 5, cpp 4, go 3, ts 1) plus the whole `import` statement
    // vocabulary of ts/js. parity.yml is the OVERRIDE layer, not a fork; only
    // the individual default rules listed above are switched off.
    defaults.retain(|rule| !DISABLED_DEFAULT_RULES.contains(&rule.common().id.as_str()));
    rules.extend(defaults);

    parse_rule_stream(
        BUNDLED_RULES,
        "rules/outline",
        &mut rules,
        &mut kinds,
        &mut errors,
    );

    LoadedRules {
        rules,
        kinds,
        errors,
    }
}

pub(super) static RULES: LazyLock<LoadedRules> = LazyLock::new(load_rules);

/// Outline and call rule-load diagnostics together: broken rule documents,
/// documents holding more than one rule, and call rules without a kind marker
/// or `$NAME`. Empty on a healthy build; surfaced by `--langs` and
/// `--outline` so rule authors see their own mistakes instead of a silently
/// smaller graph.
pub fn rule_errors() -> &'static [String] {
    static ALL: LazyLock<Vec<String>> = LazyLock::new(|| {
        let mut errors = RULES.errors.clone();
        errors.extend(crate::calls::load_errors().iter().cloned());
        errors
    });
    &ALL
}

/// Compile diagnostics for one graph language: outline AND call rules that
/// parsed but cannot run (unknown node kind for this grammar, bad pattern, or
/// no `kind:` to index the walk on). Compiling is cached, so this is cheap
/// after the first call for the language.
pub fn language_rule_errors(graph_lang: &str) -> Vec<String> {
    let mut errors: Vec<String> = graph_lang_scan_langs(graph_lang)
        .iter()
        .flat_map(|lang| extractors_for(*lang).errors.clone())
        .collect();
    errors.extend(crate::calls::language_rule_errors(graph_lang));
    errors
}

/// True when the graph language id has at least one COMPILED item rule, i.e.
/// it can actually produce symbols. This is the gate the extraction registry
/// uses, so a language stops being a graph source language the moment its
/// rules are gone or stop compiling — and starts being one the moment
/// `rules/outline/*.yml` covers it.
pub fn has_rules(graph_lang: &str) -> bool {
    graph_lang_scan_langs(graph_lang)
        .iter()
        .any(|lang| !extractors_for(*lang).is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::outline::test_support::{kinds, named};
    use crate::scan_lang::scan_lang_for_ext;

    #[test]
    fn build_script_bundles_every_rule_file() {
        // build.rs concatenates `rules/outline/*.yml` into one stream; the
        // generated bundle must parse, tag every file it came from, and stay
        // empty-safe when the directory has no files.
        let mut rules = Vec::new();
        let mut kinds = HashMap::new();
        let mut errors = Vec::new();
        parse_rule_stream(BUNDLED_RULES, "bundle", &mut rules, &mut kinds, &mut errors);
        assert!(errors.is_empty(), "bundled rules must parse: {errors:?}");
        let files = BUNDLED_RULES
            .lines()
            .filter(|line| line.starts_with("# file: "))
            .count();
        // build.rs bundles exactly one marker per source file it concatenated.
        assert_eq!(
            files,
            env!("MIXDOG_OUTLINE_RULE_FILES")
                .parse::<usize>()
                .expect("rule file count"),
        );
        if !rules.is_empty() {
            assert!(files > 0, "a non-empty bundle must carry file markers");
            // Every authored rule declares its graph kind.
            for rule in &rules {
                assert!(
                    kinds.contains_key(&rule.common().id),
                    "rules/outline rule `{}` is missing a `# mixdog-kind:` marker",
                    rule.common().id
                );
            }
        }
    }

    #[test]
    fn every_extraction_language_has_compiled_rules() {
        // The registry says a language has graph extensions; this is the other
        // half of the contract — deleting or breaking `rules/outline/<lang>.yml`
        // has to fail here instead of silently emptying that language.
        for info in crate::scan_lang::LANG_INFOS {
            if info.extract_extensions.is_empty() {
                continue;
            }
            assert!(
                has_rules(info.id),
                "{} has graph extensions but no compiled outline rule",
                info.id
            );
            assert!(
                language_rule_errors(info.id).is_empty(),
                "{} has rules that do not compile: {:?}",
                info.id,
                language_rule_errors(info.id)
            );
        }
    }

    #[test]
    fn a_document_with_two_rules_is_rejected() {
        let mut rules = Vec::new();
        let mut kinds = HashMap::new();
        let mut errors = Vec::new();
        // `--- # note` is a YAML document separator that the column-zero split
        // does not recognise, so both rules land in one of our documents and
        // would otherwise share the single `# mixdog-kind:` marker.
        parse_rule_stream(
            "# mixdog-kind: class\nid: one\nlanguage: TypeScript\nrole: item\nsymbolType: class\nrule:\n  kind: class_declaration\nname: $NAME\n\
             --- # note\nid: two\nlanguage: TypeScript\nrole: item\nsymbolType: enum\nrule:\n  kind: enum_declaration\nname: $NAME\n",
            "test.yml",
            &mut rules,
            &mut kinds,
            &mut errors,
        );
        assert_eq!(errors.len(), 1, "{errors:?}");
        assert!(errors[0].contains("one YAML document"), "{}", errors[0]);
        // Rules stay loaded (no silent loss) but neither takes the marker.
        assert_eq!(rules.len(), 2);
        assert!(kinds.is_empty());
    }

    #[test]
    fn typescript_rules_are_mirrored_onto_the_tsx_grammar() {
        let ts = scan_lang_for_ext("ts").unwrap();
        let tsx = scan_lang_for_ext("tsx").unwrap();
        assert_ne!(ts, tsx);
        let ours = |lang| {
            RULES
                .rules
                .iter()
                .filter(|rule| rule.common().language == lang)
                .map(|rule| rule.common().id.clone())
                .filter(|id| {
                    id.starts_with("mixdog-ts-")
                        || matches!(id.as_str(), "ts-class" | "ts-interface" | "ts-enum")
                })
                .collect::<Vec<_>>()
        };
        assert!(!ours(ts).is_empty());
        assert_eq!(
            ours(ts),
            ours(tsx),
            "every parity rule exists for both grammars"
        );
        // And the mirrored rules actually run against a .tsx file.
        assert_eq!(
            kinds(
                "typescript",
                "tsx",
                "export class Panel {\n  render() { return null; }\n}\nexport const view = <div />;\n"
            ),
            named(&[("class", "Panel"), ("method", "render"), ("variable", "view")])
        );
    }

    #[test]
    fn yaml_documents_split_on_column_zero_separators() {
        let docs = split_yaml_documents("a: 1\n---\nb: 2\n---\n");
        assert_eq!(docs.len(), 3);
        assert_eq!(docs[0].trim(), "a: 1");
        assert_eq!(docs[1].trim(), "b: 2");
        assert!(docs[2].trim().is_empty());
    }

    #[test]
    fn rule_bundle_has_no_load_errors() {
        assert!(rule_errors().is_empty(), "{:?}", rule_errors());
    }

    #[test]
    fn declared_kind_marker_is_read_from_the_rule_document() {
        assert_eq!(
            declared_kind_of("# mixdog-kind: union\nid: x\n"),
            Some(DeclaredKind::Symbol("union"))
        );
        assert_eq!(
            declared_kind_of("# mixdog-kind: import\nid: x\n"),
            Some(DeclaredKind::Import)
        );
        assert_eq!(declared_kind_of("id: x\n"), None);
    }
}
