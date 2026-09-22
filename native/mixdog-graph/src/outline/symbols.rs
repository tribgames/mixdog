// Outline entries → the symbol records a FileRecord carries.
//
// The walk hands over items and members; this file decides which of them are
// graph symbols, deduplicates the declarations two rules both matched, orders
// them, resolves each one's parent from the SAME span list the call sites'
// `inSymbol` uses, and assembles the v2 record. `extract` is the entry point
// every consumer goes through.

use std::collections::{HashMap, HashSet};

use ast_grep_core::tree_sitter::StrDoc;
use ast_grep_core::{AstGrep, Node};
use serde::Serialize;

use super::extractors::{extractors_for, FileMeta, Walked, WalkedItem};
use super::imports::import_specs;
use super::kind_map::unified_kind;
use super::kinds::symbol_kind;
use super::rules::DeclaredKind;
use super::signature::{declaration_head, name_line};
use super::visibility::{is_exported, FileVisibility};
use crate::scan_lang::ScanLang;
use crate::tokens::KindRole;

/// One declaration in a FileRecord — SYMBOL RECORD v2.
///
///   `{ name, kind, startLine, endLine, startCol, endCol, exported?, sig?,
///      parent? }`
///
/// v2 replaces v1 in place; there is no dual support. Against v1 it
///   * drops `line` (the line the NAME sits on, which only differs from
///     `startLine` for a multi-line signature head): it is still computed, as
///     the key that deduplicates two rules matching one declaration, but it is
///     not part of the record. The JS consumer already reads
///     `symbol.line ?? symbol.startLine`.
///   * replaces the per-language `kind` vocabulary with ONE unified vocabulary
///     (`unified_kind`), which is a deliberate result change — see `KIND_MAP`.
///   * adds `exported` / `sig` / `parent`, each omitted when it carries
///     nothing (false / no meaningful head / top level).
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub struct SymbolInfo {
    pub name: String,
    /// Unified kind vocabulary — the same tokens in every language.
    pub kind: &'static str,
    /// 1-based start line of the declaration node.
    #[serde(rename = "startLine")]
    pub start_line: u32,
    /// 1-based end line of the declaration node.
    #[serde(rename = "endLine")]
    pub end_line: u32,
    /// 1-based character column of the declaration start.
    #[serde(rename = "startCol")]
    pub start_col: u32,
    /// Character column of the declaration end (exclusive end, 0-based, which
    /// is the 1-based column of the last character).
    #[serde(rename = "endCol")]
    pub end_col: u32,
    /// Visible outside the file/module it is declared in, per the
    /// language's own visibility rules (`is_exported`). Omitted when false.
    #[serde(skip_serializing_if = "is_not_set")]
    pub exported: bool,
    /// Declaration head on one line (`declaration_head`). Omitted when the
    /// head carries nothing beyond the name.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub sig: String,
    /// Name of the innermost enclosing SYMBOL. Omitted at top level — and a
    /// container that is not itself a symbol cannot be one: a Rust `impl`
    /// block is not extracted, so `impl Store { fn read() }` reports `read`
    /// with NO parent (only a `mod` gives Rust methods one), and the same
    /// holds for an anonymous `export default class { run() {} }`.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub parent: String,
}

fn is_not_set(flag: &bool) -> bool {
    !*flag
}

/// Symbols, import specs and call sites for one file.
///
/// `calls` is TRI-STATE and the distinction is part of the FileRecord
/// contract: `Some(vec![])` means "an extraction language parsed this file and
/// it has no call sites" (a known-empty answer the JS side must trust),
/// `None` means "no call extraction ran here" — a language with no rules, or a
/// tree that did not parse — which the JS side is free to answer some other
/// way. An empty `Vec` alone cannot express that difference.
#[derive(Default)]
pub struct Extraction {
    pub symbols: Vec<SymbolInfo>,
    pub imports: Vec<String>,
    pub calls: Option<Vec<crate::calls::CallInfo>>,
    /// Sorted unique identifier tokens (Stage 3-D). Empty when nothing was
    /// parsed, exactly like `symbols`.
    pub tokens: Vec<String>,
    /// java/kotlin `package`, from the declaration node.
    pub package_name: String,
    /// csharp `namespace`, from the declaration node.
    pub namespace_name: String,
    /// go `package`, from the package clause.
    pub go_package_name: String,
}

pub(super) struct Candidate {
    pub(super) name: String,
    /// Pre-Stage-3 (per-language) kind; mapped through `KIND_MAP` on the way
    /// out, and the key the language's `exported` rule keys on.
    pub(super) kind: &'static str,
    /// Line the NAME sits on: the deduplication key, not a record field.
    pub(super) line: u32,
    pub(super) start_line: u32,
    pub(super) start_col: u32,
    pub(super) end_line: u32,
    pub(super) end_col: u32,
    pub(super) start_byte: usize,
    pub(super) span: usize,
    /// `isExported` (item) / `isPublic` (member) as the matched rule reported
    /// it. One input of `is_exported`, not the answer.
    pub(super) rule_exported: bool,
    /// Matched by a MEMBER rule (a declaration inside a container item), not
    /// by an item rule. `isPublic` is a container-visibility flag, which is
    /// not the same statement as a module export.
    pub(super) member: bool,
}

impl Candidate {
    fn end_byte(&self) -> usize {
        self.start_byte + self.span
    }
}

/// Graph kind of one outline entry, or `None` when it is not a graph symbol.
/// The rule's own `# mixdog-kind:` wins; otherwise the built-in table maps the
/// ast-grep default rules and our parity rules.
fn entry_kind(
    graph_lang: &str,
    declared: Option<DeclaredKind>,
    entry: &ast_grep_outline::model::OutlineEntry<'_>,
) -> Option<&'static str> {
    if entry.name.is_empty() {
        return None;
    }
    // `#field` / `#method()` are private class members, which the graph never
    // carried (the old queries keyed on `property_identifier`).
    if matches!(graph_lang, "typescript" | "javascript") && entry.name.starts_with('#') {
        return None;
    }
    match declared {
        Some(DeclaredKind::Import) => None,
        Some(DeclaredKind::Symbol(kind)) => Some(kind),
        None => symbol_kind(graph_lang, &entry.ast_kind, entry.symbol_type),
    }
}

/// Parse `text` and return the graph symbols and raw import specs.
/// `graph_lang` is the FileRecord language id, `lang` the grammar to parse
/// with (they differ for `.tsx`, which the graph calls typescript).
pub fn extract(text: &str, graph_lang: &str, lang: ScanLang) -> Extraction {
    let extractors = extractors_for(lang);
    // No compiled rules for this grammar: nothing was extracted, so `calls`
    // stays unknown rather than claiming an empty answer.
    if extractors.is_empty() {
        return Extraction::default();
    }
    // An empty source of an extraction language IS parsed, and its answer is
    // "no call sites" — a known empty list, not an unknown one.
    if text.is_empty() {
        return Extraction {
            calls: Some(Vec::new()),
            ..Extraction::default()
        };
    }
    let Ok(ast) = AstGrep::<StrDoc<ScanLang>>::try_new(text, lang) else {
        return Extraction::default();
    };
    let walked = extractors.extract(ast.root(), text);
    map_items(walked, text, graph_lang)
}

/// Occurrences of `symbol` as an IDENTIFIER in `text`, as 1-based
/// `(line, column)` pairs. The standalone `mixdog-graph <root> <symbol>`
/// search mode is built on this: a match is a node of one of the grammar's
/// identifier kinds whose text is exactly the symbol, so comments and string
/// bodies can never produce one while a string INTERPOLATION still does.
pub fn identifier_hits(text: &str, lang: ScanLang, symbol: &str) -> Vec<(u32, u32)> {
    if text.is_empty() || symbol.is_empty() {
        return Vec::new();
    }
    let kinds = crate::tokens::kinds_for(lang);
    let Ok(ast) = AstGrep::<StrDoc<ScanLang>>::try_new(text, lang) else {
        return Vec::new();
    };
    let mut hits = Vec::new();
    let mut stack = vec![ast.root()];
    while let Some(node) = stack.pop() {
        if self_is_symbol(&node, text, symbol) && kinds.role(node.kind_id()) == KindRole::Identifier
        {
            let start = node.start_pos();
            hits.push((start.line() as u32 + 1, start.column(&node) as u32 + 1));
        }
        for child in node.children() {
            stack.push(child);
        }
    }
    hits
}

fn self_is_symbol(node: &Node<'_, StrDoc<ScanLang>>, text: &str, symbol: &str) -> bool {
    text.get(node.range()).is_some_and(|slice| slice == symbol)
}

pub(super) fn map_items(walked: Walked<'_>, text: &str, graph_lang: &str) -> Extraction {
    let Walked {
        items,
        calls,
        tokens,
        meta: file_meta,
    } = walked;
    // Sorted unique: the consumer answers `tokens.includes(name)`, so order is
    // free, and sorting makes the emitted line stable and compressible.
    let mut tokens: Vec<&str> = tokens.into_iter().collect();
    tokens.sort_unstable();
    let tokens: Vec<String> = tokens.into_iter().map(str::to_string).collect();

    let (imports, candidates) = collect_declarations(&items, text, graph_lang);
    let (parent_of, calls) = resolve_containment(&candidates, calls);
    let meta = parent_meta(&candidates, &parent_of, graph_lang);
    let symbols = symbol_records(candidates, meta, text, graph_lang);
    Extraction {
        symbols,
        imports,
        calls: Some(calls),
        tokens,
        package_name: FileMeta::take(file_meta.package),
        namespace_name: FileMeta::take(file_meta.namespace),
        go_package_name: FileMeta::take(file_meta.go_package),
    }
}

/// One pass over the walked items: every item and member that is a graph
/// symbol becomes a deduplicated `Candidate`, and every import item
/// contributes its raw specs.
///
/// Both lists leave in a fixed order — imports by their byte offset in the
/// source, candidates by `(start line, start col, name line, name)` — so the
/// record does not depend on the traversal's own visit order.
fn collect_declarations(
    items: &[WalkedItem<'_>],
    text: &str,
    graph_lang: &str,
) -> (Vec<String>, Vec<Candidate>) {
    // (byte offset, spec) so the emitted list stays in source order even
    // though the traversal visits siblings back to front.
    let mut imports: Vec<(usize, String)> = Vec::new();
    let mut seen_imports: HashSet<String> = HashSet::new();
    let mut candidates: Vec<Candidate> = Vec::new();
    let mut by_key: HashMap<(String, u32), usize> = HashMap::new();

    for walked in items {
        let item = &walked.item;
        let entry = &item.entry;
        if item.is_import {
            let slice = text
                .get(entry.range.byte_offset.clone())
                .unwrap_or_default();
            for spec in import_specs(graph_lang, &entry.ast_kind, &entry.name, slice) {
                if !spec.is_empty() && seen_imports.insert(spec.clone()) {
                    imports.push((entry.range.byte_offset.start, spec));
                }
            }
        }
        if let Some(kind) = entry_kind(graph_lang, walked.declared, entry) {
            push_candidate(
                candidate_for(
                    text,
                    &entry.name,
                    kind,
                    &entry.range,
                    item.is_exported,
                    false,
                ),
                &mut candidates,
                &mut by_key,
            );
        }
        for (index, member) in item.members.iter().enumerate() {
            let entry = &member.entry;
            let declared = walked.member_declared.get(index).copied().flatten();
            if let Some(kind) = entry_kind(graph_lang, declared, entry) {
                push_candidate(
                    candidate_for(
                        text,
                        &entry.name,
                        kind,
                        &entry.range,
                        member.is_public,
                        true,
                    ),
                    &mut candidates,
                    &mut by_key,
                );
            }
        }
    }

    imports.sort_by_key(|(offset, _)| *offset);
    candidates.sort_by(|a, b| {
        (a.start_line, a.start_col, a.line, &a.name).cmp(&(
            b.start_line,
            b.start_col,
            b.line,
            &b.name,
        ))
    });
    (
        imports.into_iter().map(|(_, spec)| spec).collect(),
        candidates,
    )
}

/// Keep ONE candidate per `(name, name line)`: two rules matching nested
/// nodes of one declaration are one symbol, and `keeps_existing` decides
/// which of the two spans the record reports.
fn push_candidate(
    candidate: Candidate,
    candidates: &mut Vec<Candidate>,
    by_key: &mut HashMap<(String, u32), usize>,
) {
    let key = (candidate.name.clone(), candidate.line);
    match by_key.get(&key) {
        Some(&index) if keeps_existing(&candidates[index], &candidate) => {}
        Some(&index) => candidates[index] = candidate,
        None => {
            by_key.insert(key, candidates.len());
            candidates.push(candidate);
        }
    }
}

/// Resolve each candidate's innermost enclosing candidate and the call sites'
/// `inSymbol` from ONE span list, built from the same deduplicated candidates
/// the record reports.
///
/// The parent comes back as an INDEX into `candidates`, not only as a name:
/// the visibility rules need the enclosing declaration's KIND too.
fn resolve_containment(
    candidates: &[Candidate],
    calls: Vec<crate::calls::RawCall>,
) -> (Vec<Option<usize>>, Vec<crate::calls::CallInfo>) {
    // Containment order: nesting is a byte-span relation, not a line one, so
    // the sweep runs over the candidates sorted by (start ASC, end DESC).
    let mut order: Vec<usize> = (0..candidates.len()).collect();
    order.sort_by_key(|&index| {
        (
            candidates[index].start_byte,
            std::cmp::Reverse(candidates[index].end_byte()),
        )
    });
    let mut parent_of: Vec<Option<usize>> = vec![None; candidates.len()];
    let spans: Vec<crate::spans::SymbolSpan<'_>> = order
        .iter()
        .map(|&index| {
            let candidate = &candidates[index];
            (
                candidate.start_byte,
                candidate.end_byte(),
                candidate.name.as_str(),
            )
        })
        .collect();
    let mut sweep = crate::spans::ContainmentSweep::new(&spans);
    for (position, &index) in order.iter().enumerate() {
        if let Some(enclosing) = sweep.enclosing_of(position) {
            parent_of[index] = Some(order[enclosing]);
        }
    }
    (parent_of, crate::calls::finish(calls, &spans))
}

/// `(parent name, is local)` per candidate: a declaration with a
/// FUNCTION-LIKE ancestor lives in that body and cannot be visible outside
/// the file in ANY language, whatever its modifiers or the export clause
/// say (`fun localHelper` inside a method, a C# local function, a `pub fn`
/// inside a `fn`).
fn parent_meta(
    candidates: &[Candidate],
    parent_of: &[Option<usize>],
    graph_lang: &str,
) -> Vec<(String, bool)> {
    (0..candidates.len())
        .map(|index| {
            let parent = parent_of[index]
                .map(|at| candidates[at].name.clone())
                .unwrap_or_default();
            let mut at = parent_of[index];
            let mut local = false;
            while let Some(enclosing) = at {
                if matches!(
                    unified_kind(graph_lang, candidates[enclosing].kind),
                    "function" | "method" | "constructor"
                ) {
                    local = true;
                    break;
                }
                at = parent_of[enclosing];
            }
            (parent, local)
        })
        .collect()
}

/// Render the ordered candidates into SYMBOL RECORD v2: the unified kind, the
/// language's own visibility answer, and the one-line declaration head.
fn symbol_records(
    candidates: Vec<Candidate>,
    meta: Vec<(String, bool)>,
    text: &str,
    graph_lang: &str,
) -> Vec<SymbolInfo> {
    let visibility = FileVisibility::of(graph_lang, text);
    candidates
        .into_iter()
        .zip(meta)
        .map(|(candidate, (parent, local))| {
            let head = declaration_head(
                text,
                candidate.start_byte,
                candidate.end_byte(),
                &candidate.name,
            );
            SymbolInfo {
                kind: unified_kind(graph_lang, candidate.kind),
                exported: is_exported(
                    graph_lang,
                    &candidate,
                    &head,
                    parent.is_empty(),
                    local,
                    text,
                    &visibility,
                ),
                // A head that is just the name again (a bare enum member, a
                // binding with neither type nor initializer) is no signature.
                sig: if head == candidate.name {
                    String::new()
                } else {
                    head
                },
                parent,
                name: candidate.name,
                end_line: candidate.end_line,
                start_line: candidate.start_line,
                start_col: candidate.start_col,
                end_col: candidate.end_col,
            }
        })
        .collect()
}

/// One declaration can match two rules on nested nodes (a named function
/// expression and the binding it is assigned to, a declaration node and the
/// specifier inside it). The old tree-sitter queries kept the first match in
/// document order, which is the node that STARTS EARLIEST, and — when two
/// nodes start at the same byte — the OUTERMOST one, i.e. the longer span.
fn keeps_existing(existing: &Candidate, candidate: &Candidate) -> bool {
    match existing.start_byte.cmp(&candidate.start_byte) {
        std::cmp::Ordering::Less => true,
        std::cmp::Ordering::Greater => false,
        std::cmp::Ordering::Equal => existing.span >= candidate.span,
    }
}

fn candidate_for(
    text: &str,
    name: &str,
    kind: &'static str,
    range: &ast_grep_outline::model::SourceRange,
    rule_exported: bool,
    member: bool,
) -> Candidate {
    let start_line = range.start.line as u32 + 1;
    Candidate {
        name: name.to_string(),
        kind,
        line: name_line(
            text,
            range.byte_offset.start,
            range.byte_offset.end,
            start_line,
            name,
        ),
        start_line,
        start_col: range.start.column as u32 + 1,
        end_line: range.end.line as u32 + 1,
        end_col: range.end.column as u32,
        start_byte: range.byte_offset.start,
        span: range
            .byte_offset
            .end
            .saturating_sub(range.byte_offset.start),
        rule_exported,
        member,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::outline::test_support::{kinds, named, record, records, symbols, tokens};
    use crate::scan_lang::scan_lang_for_ext;

    #[test]
    fn symbol_spans_are_the_declaration_node() {
        let symbols = symbols(
            "typescript",
            "ts",
            "export function run() {\n  return 1;\n}\n",
        );
        assert_eq!(symbols.len(), 1);
        let lang = scan_lang_for_ext("ts").unwrap();
        let extracted = extract(
            "export function run() {\n  return 1;\n}\n",
            "typescript",
            lang,
        );
        let symbol = &extracted.symbols[0];
        // `function`, not `export`, and the span covers the body.
        assert_eq!(
            (symbol.start_line, symbol.start_col, symbol.end_line),
            (1, 8, 3)
        );
    }

    #[test]
    fn imports_are_not_symbols() {
        assert!(kinds("ruby", "rb", "require 'json'\n").is_empty());
        assert!(kinds("typescript", "ts", "import a from './a';\n").is_empty());
        assert!(kinds("python", "py", "import os\n").is_empty());
    }

    #[test]
    fn private_class_members_are_not_symbols() {
        assert_eq!(
            kinds(
                "typescript",
                "ts",
                "class C {\n  #secret() {}\n  visible() {}\n}\n"
            ),
            named(&[("class", "C"), ("method", "visible")])
        );
    }

    #[test]
    fn the_earliest_outermost_candidate_wins_a_name_line_collision() {
        let at = |start: usize, span: usize| Candidate {
            name: "x".to_string(),
            kind: "function",
            line: 1,
            start_line: 1,
            start_col: 1,
            end_line: 1,
            end_col: 1,
            start_byte: start,
            span,
            rule_exported: false,
            member: false,
        };
        // Earliest start wins, whatever the spans are.
        assert!(keeps_existing(&at(0, 3), &at(5, 90)));
        assert!(!keeps_existing(&at(5, 90), &at(0, 3)));
        // Same start: the outermost (longer) span wins, in both arrival orders.
        assert!(keeps_existing(&at(4, 90), &at(4, 12)));
        assert!(!keeps_existing(&at(4, 12), &at(4, 90)));
    }

    /// A symbol name is an IDENTIFIER: something other code can write down to
    /// reference the declaration. Solidity's `pragma solidity ^0.8.19;` was
    /// the one rule that broke that — it reported the version expression, a
    /// name with a space in it — so a `.sol` file must now declare no such
    /// name, and no pragma symbol at all.
    #[test]
    fn solidity_declares_no_pragma_and_no_name_with_whitespace() {
        let source = "// SPDX-License-Identifier: MIT\n\
pragma solidity ^0.8.19;\n\
pragma experimental ABIEncoderV2;\n\
pragma abicoder v2;\n\
import \"./LibMath.sol\";\n\n\
library LibMath {\n    function add(uint256 a, uint256 b) internal pure returns (uint256) { return a + b; }\n}\n\n\
contract Vault {\n    event Deposited(address indexed who, uint256 amount);\n    function deposit(uint256 amount) public {}\n}\n";
        let found = records("solidity", "sol", source);
        assert_eq!(
            found.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(),
            vec!["LibMath", "add", "Vault", "Deposited", "deposit"]
        );
        for symbol in &found {
            assert!(
                !symbol.name.chars().any(char::is_whitespace),
                "solidity symbol name `{}` contains whitespace",
                symbol.name
            );
        }
        // The directive contributes no symbol; what the grammar does spell as
        // identifiers inside one (`pragma experimental ABIEncoderV2`) is still
        // an ordinary token, while the version pragma's `solidity` is an
        // anonymous keyword of the grammar and is not.
        let tokens = tokens("solidity", "sol", source);
        assert!(
            tokens.iter().any(|token| token == "experimental"),
            "{tokens:?}"
        );
        assert!(
            !tokens.iter().any(|token| token == "solidity"),
            "{tokens:?}"
        );
    }

    /// No language may report a symbol name with whitespace in it: the name is
    /// what a reference search looks for, and no identifier has a space.
    #[test]
    fn no_fixture_symbol_name_carries_whitespace() {
        let cases: &[(&str, &str, &str)] = &[
            (
                "solidity",
                "sol",
                "pragma solidity ^0.8.19;\ncontract A { function b() public {} }\n",
            ),
            ("typescript", "ts", "export class A { run(): void {} }\n"),
            ("rust", "rs", "pub fn run() {}\npub struct A;\n"),
            ("haskell", "hs", "module M where\nrun :: Int\nrun = 1\n"),
            (
                "hcl",
                "tf",
                "resource \"aws_instance\" \"web\" {\n  ami = \"x\"\n}\n",
            ),
        ];
        for (lang, ext, source) in cases {
            for symbol in records(lang, ext, source) {
                assert!(
                    !symbol.name.chars().any(char::is_whitespace),
                    "{lang}: symbol name `{}` contains whitespace",
                    symbol.name
                );
            }
        }
    }

    #[test]
    fn parent_is_the_innermost_enclosing_symbol() {
        let ts = records(
            "typescript",
            "ts",
            "export class Store {\n  read(): void {\n    function inner(): void {\n      class Deep { run(): void {} }\n    }\n  }\n}\nexport function top(): void {}\n",
        );
        let parent_of = |name: &str| record(&ts, name).parent.clone();
        assert_eq!(parent_of("Store"), "");
        assert_eq!(parent_of("read"), "Store");
        assert_eq!(parent_of("inner"), "read");
        assert_eq!(parent_of("Deep"), "inner");
        assert_eq!(parent_of("run"), "Deep");
        assert_eq!(parent_of("top"), "");

        // Two single-line siblings do not adopt each other.
        let siblings = records(
            "typescript",
            "ts",
            "function a() { function x() {} } function b() { function y() {} }\n",
        );
        assert_eq!(record(&siblings, "x").parent, "a");
        assert_eq!(record(&siblings, "y").parent, "b");

        // `parent` and the calls' `inSymbol` come from the same sweep, so a
        // call inside a declaration names the declaration that declares it.
        let lang = scan_lang_for_ext("py").unwrap();
        let extracted = extract(
            "class Service:\n    def run(self):\n        def helper():\n            return load()\n        return helper()\n",
            "python",
            lang,
        );
        assert_eq!(record(&extracted.symbols, "helper").parent, "run");
        assert_eq!(record(&extracted.symbols, "run").parent, "Service");
        let calls = extracted.calls.expect("python is an extraction language");
        let load = calls
            .iter()
            .find(|call| call.name == "load")
            .expect("load()");
        assert_eq!(load.in_symbol, "helper");
    }

    /// A function-valued property of an object literal is a `method` whose
    /// name is the property's — the only name a caller can reference. Data
    /// properties are not declarations and stay out.
    #[test]
    fn object_literal_function_properties_are_methods() {
        let source = r#"
export function createHost() {
  const host = {
    preflightSteps: createInputPreflight({ retries: 2 }),
    fill: async (ctx: string) => { void ctx; },
    foo: function () { return 1; },
    gen: function* () { yield 1; },
    named: function inner() { return 2; },
    wait(cmd: string) { return cmd; },
    get size() { return 1; },
    label: 'text',
    count: 3,
    items: [1, 2],
    made: new Set([1]),
    nested: { deep: (x: number) => x },
    alias: host.runCommand,
    generatedAt: new Date().toISOString(),
    index: resolve(dir, 'src/main.ts'),
    atMs: Math.round(elapsed),
  };
  return host;
}
"#;
        let ts = records("typescript", "ts", source);
        let listed: Vec<(&str, &str)> = ts
            .iter()
            .map(|symbol| (symbol.kind, symbol.name.as_str()))
            .collect();
        assert_eq!(
            listed,
            vec![
                ("function", "createHost"),
                ("method", "preflightSteps"),
                ("method", "fill"),
                ("method", "foo"),
                ("method", "gen"),
                // `named: function inner() {}` declares `inner`, which is
                // already the symbol of that function expression.
                ("function", "inner"),
                ("method", "wait"),
                ("method", "size"),
                ("method", "deep"),
            ]
        );
        // A call is only a factory when a NAMED function takes a
        // configuration object; `new Date().toISOString()`,
        // `resolve(dir, 'x')` and `Math.round(n)` compute VALUES.
        for data in [
            "label",
            "count",
            "items",
            "made",
            "alias",
            "generatedAt",
            "index",
            "atMs",
        ] {
            assert!(
                !ts.iter().any(|symbol| symbol.name == data),
                "`{data}` is a data property: {ts:?}"
            );
        }

        let preflight = record(&ts, "preflightSteps");
        // A member is never exported, and the parent is the innermost
        // enclosing SYMBOL — the object literal itself declares nothing.
        assert!(!preflight.exported);
        assert_eq!(preflight.parent, "createHost");
        assert_eq!(
            preflight.sig,
            "preflightSteps: createInputPreflight({ retries: 2 })"
        );
        assert_eq!(record(&ts, "fill").sig, "fill: async (ctx: string)");

        // The same shapes in JavaScript, where `pair` is the only form.
        let js = records(
            "javascript",
            "js",
            "const actions = {\n  submit: async (form) => form,\n  reset() { return 1; },\n  build: makeBuilder({ a: 1 }),\n  label: 'x',\n};\n",
        );
        assert_eq!(
            js.iter()
                .map(|symbol| (symbol.kind, symbol.name.as_str()))
                .collect::<Vec<_>>(),
            vec![
                ("variable", "actions"),
                ("method", "submit"),
                ("method", "reset"),
                ("method", "build"),
            ]
        );
        assert_eq!(record(&js, "submit").parent, "actions");

        // An `export { name }` clause names the module-level declaration, not
        // a method that happens to share the word.
        let clash = records(
            "typescript",
            "ts",
            "function run(): void {}\nconst api = { run: () => {} };\nexport { run };\n",
        );
        assert!(record(&clash, "run").exported, "the function is exported");
        assert!(
            clash
                .iter()
                .filter(|symbol| symbol.kind == "method")
                .all(|symbol| !symbol.exported),
            "{clash:?}"
        );
    }
}
