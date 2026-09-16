// Rule-driven call-site extraction.
//
// `calls` is the AST answer to "who calls what": every call site a file
// contains, with the callee name node's own position, so `code_graph`
// callers/callees stop guessing from text. It is produced by the SAME
// traversal that produces symbols and imports (`outline::LangExtractors`), so
// a file is parsed and walked exactly once.
//
// The wire shape is a positional tuple (see `CallInfo`) and `--langs` reports
// `callsFormat: 2`; `--outline` keeps the readable object form (`CallDebug`)
// because that mode exists for rule authors, not for the graph.
//
// RULES
// -----
// One YAML document per rule in `rules/calls/<lang>.yml`, bundled into the
// binary by build.rs exactly like `rules/outline/*.yml`, and parsed with the
// ast-grep OUTLINE rule schema (`role: item`) so rule authors write one rule
// dialect, not two. Every `language: TypeScript` document is also loaded as a
// `language: Tsx` copy, because `.ts` and `.tsx` are separate grammars.
//
// Three things a call rule must carry, on top of the outline schema:
//
//   * `# mixdog-call-kind: call | method | new` — a per-document comment
//     marker (the same shape as outline's `# mixdog-kind:`). `method` means a
//     receiver or qualifier is present, `new` is EXPLICIT constructor syntax
//     only (`new Foo()`, not `Foo()` in a language without `new`).
//   * `$NAME` — bound to the callee NAME NODE. The node decides `line`,
//     `col` and `endCol`; the rule's `name:` template decides the emitted
//     text (normally `$NAME`, i.e. the node's own text: the LAST segment of
//     the callee, `foo` for `a.b.foo()`).
//   * `$RECV` — optional, bound to the receiver/qualifier node. Present =>
//     `recv` is that node's source text; absent => `recv` is omitted.
//   * `# mixdog-call-recv: <text>` — optional literal receiver, used by the
//     grammars that keep a KEYWORD receiver as an anonymous token with no
//     node to bind (`this.ping()` in Dart and C#). It applies only when
//     `$RECV` is unbound, so a rule can never overwrite a real receiver.
//
// A rule that does not compile, holds more than one rule per document, misses
// the kind marker or never binds `$NAME` is reported through
// `outline::rule_errors()` / `language_rule_errors()` — the same
// `--langs ruleErrors` channel outline rules use — instead of silently
// emitting nothing.
//
// WHAT IS NOT A CALL
// ------------------
// Comments and string contents never match, because rules match AST nodes and
// neither carries call syntax. Declarations are not calls even in the
// languages whose grammar files them under a call node (Elixir `def`,
// `defmodule`); see rules/calls/elixir.yml. Call-syntax decorators and
// annotations (`@deco()`) DO contain a call node and are therefore call
// sites; bare ones (`@deco`) are not.

use std::collections::HashMap;
use std::sync::{Arc, LazyLock, RwLock};

use ast_grep_config::GlobalRules;
use ast_grep_core::replacer::{Content, Replacer};
use ast_grep_core::tree_sitter::StrDoc;
use ast_grep_core::{Matcher, Node};
use ast_grep_outline::extractor::{parse_outline_rules, ItemExtractor, SerializableOutlineRule};
use ast_grep_outline::options::OutlineEntryDetail;
use serde::Serialize;

use crate::outline::{split_yaml_documents, tsx_variant};
use crate::scan_lang::{graph_lang_scan_langs, ScanLang};

/// `rules/calls/*.yml`, concatenated by build.rs (may be empty).
const BUNDLED_CALL_RULES: &str = include_str!(concat!(env!("OUT_DIR"), "/call_rules.yml"));

/// The three call kinds a rule may declare.
const KINDS: [&str; 3] = ["call", "method", "new"];

/// Wire format version of the `calls` array, reported by `--langs` as
/// `callsFormat` so the consumer can tell the shapes apart.
pub const CALLS_FORMAT: u8 = 2;

/// Longest `recv` kept on the wire, in characters. A receiver is used for a
/// self-receiver test (`this`/`self`/…) and for display, so a multi-line
/// expression costs bytes without adding information.
const RECV_MAX_CHARS: usize = 64;

/// One call site in a FileRecord.
///
/// WIRE FORMAT v2 — a POSITIONAL TUPLE, not an object:
///
///   [name, line, col, kind, recv, inSymbol]
///
/// because the object form spent more bytes on repeated key names than on
/// data (one repo: 30.2 MB of a 41.8 MB walk, `inSymbol` alone 23.8%).
/// `kind` is `0` call / `1` method / `2` new, `recv` and `inSymbol` are `""`
/// when absent, and `endCol` is gone: it is always `col` + the character
/// length of `name`. `line` is 1-based, `col` is a 0-based CHARACTER column
/// of the callee name node (the column rule `SymbolInfo` uses).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CallInfo {
    /// Callee identifier, last segment only.
    pub name: String,
    pub line: u32,
    pub col: u32,
    /// Exclusive end column of the name node. Not serialized in v2 (it is
    /// `col + name.chars().count()`); kept for the `--outline` debug dump.
    pub end_col: u32,
    /// `call` | `method` | `new`.
    pub kind: &'static str,
    /// Receiver/qualifier source text, normalized; `""` when the call has none.
    pub recv: String,
    /// Innermost enclosing outline symbol, `""` at top level.
    pub in_symbol: String,
}

/// `call` → 0, `method` → 1, `new` → 2.
pub fn kind_code(kind: &str) -> u8 {
    match kind {
        "method" => 1,
        "new" => 2,
        _ => 0,
    }
}

impl Serialize for CallInfo {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeTuple;
        let mut tuple = serializer.serialize_tuple(6)?;
        tuple.serialize_element(&self.name)?;
        tuple.serialize_element(&self.line)?;
        tuple.serialize_element(&self.col)?;
        tuple.serialize_element(&kind_code(self.kind))?;
        tuple.serialize_element(&self.recv)?;
        tuple.serialize_element(&self.in_symbol)?;
        tuple.end()
    }
}

/// The readable object form, for `--outline` only: rule authors validate
/// rules against real sources there, and a tuple is unreadable. It carries
/// the derived `endCol` and the `kind` token instead of its code.
#[derive(Serialize, Debug, Clone)]
pub struct CallDebug<'a> {
    pub name: &'a str,
    pub line: u32,
    pub col: u32,
    #[serde(rename = "endCol")]
    pub end_col: u32,
    pub kind: &'static str,
    #[serde(skip_serializing_if = "str::is_empty")]
    pub recv: &'a str,
    #[serde(rename = "inSymbol")]
    pub in_symbol: &'a str,
}

impl<'a> From<&'a CallInfo> for CallDebug<'a> {
    fn from(call: &'a CallInfo) -> Self {
        Self {
            name: &call.name,
            line: call.line,
            col: call.col,
            end_col: call.end_col,
            kind: call.kind,
            recv: &call.recv,
            in_symbol: &call.in_symbol,
        }
    }
}

/// Receiver text as it goes on the wire: whitespace runs (including the
/// newlines of a multi-line receiver expression) collapse to one space, and
/// anything longer than `RECV_MAX_CHARS` is cut to 63 characters plus `…`.
fn normalize_recv(text: &str) -> String {
    let mut collapsed = String::with_capacity(text.len());
    let mut space = false;
    for ch in text.trim().chars() {
        if ch.is_whitespace() {
            space = true;
            continue;
        }
        if space && !collapsed.is_empty() {
            collapsed.push(' ');
        }
        space = false;
        collapsed.push(ch);
    }
    if collapsed.chars().count() <= RECV_MAX_CHARS {
        return collapsed;
    }
    let mut out: String = collapsed.chars().take(RECV_MAX_CHARS - 1).collect();
    out.push('…');
    out
}

/// A matched call before `inSymbol` resolution.
pub struct RawCall {
    pub name: String,
    /// Already normalized; `""` when the call has no receiver.
    pub recv: String,
    pub kind: &'static str,
    pub line: u32,
    pub col: u32,
    pub end_col: u32,
    /// Byte offset of the name node start: the position `inSymbol`
    /// containment and the duplicate check key on.
    pub name_start: usize,
}

// ---------------------------------------------------------------- rule load

/// One loaded call rule: the rule itself, its declared kind, and the literal
/// receiver its `# mixdog-call-recv:` marker supplies (if any).
struct CallRule {
    rule: SerializableOutlineRule<ScanLang>,
    kind: &'static str,
    recv: Option<&'static str>,
}

struct LoadedCallRules {
    rules: Vec<CallRule>,
    errors: Vec<String>,
}

/// `# mixdog-call-kind: call|method|new`, the per-document kind marker.
fn call_kind_of(doc: &str) -> Result<&'static str, String> {
    let mut found: Option<&str> = None;
    for line in doc.lines() {
        if let Some(rest) = line.trim().strip_prefix("# mixdog-call-kind:") {
            found = Some(rest.trim());
        }
    }
    let Some(token) = found else {
        return Err("no `# mixdog-call-kind: call|method|new` marker".to_string());
    };
    KINDS
        .iter()
        .find(|kind| **kind == token)
        .copied()
        .ok_or_else(|| format!("unknown call kind `{token}`; use call, method or new"))
}

/// `# mixdog-call-recv: <text>`, the optional literal-receiver marker. The
/// text is leaked once per rule document at load time, which happens once per
/// process.
fn call_recv_of(doc: &str) -> Option<&'static str> {
    let mut found: Option<&str> = None;
    for line in doc.lines() {
        if let Some(rest) = line.trim().strip_prefix("# mixdog-call-recv:") {
            found = Some(rest.trim());
        }
    }
    let token = found?;
    if token.is_empty() {
        return None;
    }
    Some(Box::leak(token.to_string().into_boxed_str()))
}

fn parse_call_document(
    doc: &str,
    origin: &str,
    number: usize,
    rules: &mut Vec<CallRule>,
    errors: &mut Vec<String>,
) {
    if doc.trim().is_empty() {
        return;
    }
    let kind = match call_kind_of(doc) {
        Ok(kind) => kind,
        Err(error) => {
            errors.push(format!("{origin}: document {number}: {error}"));
            return;
        }
    };
    // The name node is what `line`/`col`/`endCol` report, so a rule that never
    // binds it can only produce positionless calls: refuse it at load time
    // rather than dropping its matches one by one at walk time.
    if !doc.contains("$NAME") {
        errors.push(format!(
            "{origin}: document {number}: call rule does not bind `$NAME` to the callee name node"
        ));
        return;
    }
    match parse_outline_rules::<ScanLang>(doc) {
        Ok(parsed) => {
            if parsed.len() != 1 {
                let ids: Vec<&str> = parsed.iter().map(|rule| rule.common().id.as_str()).collect();
                errors.push(format!(
                    "{origin}: document {number}: {} rules in one YAML document ({}); \
                     split them with `---` so `# mixdog-call-kind:` binds to one rule",
                    parsed.len(),
                    ids.join(", ")
                ));
                return;
            }
            let recv = call_recv_of(doc);
            for rule in parsed {
                match rule {
                    SerializableOutlineRule::Item(_) => rules.push(CallRule { rule, kind, recv }),
                    SerializableOutlineRule::Member(_) => errors.push(format!(
                        "{origin}: document {number}: call rule `{}` uses `role: member`; \
                         call rules are always `role: item`",
                        rule.common().id
                    )),
                }
            }
        }
        Err(error) => errors.push(format!("{origin}: document {number}: {error}")),
    }
}

fn load_rules() -> LoadedCallRules {
    let mut rules = Vec::new();
    let mut errors = Vec::new();
    for (index, doc) in split_yaml_documents(BUNDLED_CALL_RULES).into_iter().enumerate() {
        parse_call_document(doc, "rules/calls", index + 1, &mut rules, &mut errors);
        // `.tsx` parses with its own grammar and needs the identical rule.
        if let Some(tsx) = tsx_variant(doc) {
            parse_call_document(&tsx, "rules/calls (tsx copy)", index + 1, &mut rules, &mut errors);
        }
    }
    LoadedCallRules { rules, errors }
}

static RULES: LazyLock<LoadedCallRules> = LazyLock::new(load_rules);

/// Call-rule load diagnostics that belong to no single language. Merged into
/// `outline::rule_errors()`, which is what `--langs` and `--outline` print.
pub fn load_errors() -> &'static [String] {
    &RULES.errors
}

/// Compile diagnostics for one graph language's call rules.
pub fn language_rule_errors(graph_lang: &str) -> Vec<String> {
    graph_lang_scan_langs(graph_lang)
        .iter()
        .flat_map(|lang| extractors_for(*lang).errors.clone())
        .collect()
}

/// Number of loaded call rules for one graph language (reporting/tests).
pub fn rule_count(graph_lang: &str) -> usize {
    graph_lang_scan_langs(graph_lang)
        .iter()
        .map(|lang| extractors_for(*lang).items.len())
        .max()
        .unwrap_or(0)
}

// ------------------------------------------------------------- compilation

/// Compiled call rules for one grammar, indexed by node kind.
pub struct CallExtractors {
    items: Vec<ItemExtractor<ScanLang>>,
    /// `# mixdog-call-kind:` per item extractor.
    kinds: Vec<&'static str>,
    /// `# mixdog-call-recv:` per item extractor (literal fallback receiver).
    recvs: Vec<Option<&'static str>>,
    /// node kind id → extractor indices, in rule order.
    by_kind: Vec<Vec<usize>>,
    /// Rules of this grammar that parsed but cannot run.
    errors: Vec<String>,
}

impl CallExtractors {
    /// `rules` is the loaded bundle (`RULES.rules`) in production; the
    /// parameter exists so a test can compile a deliberately broken rule set
    /// without touching the process-wide bundle.
    fn compile(lang: ScanLang, rules: &[CallRule]) -> Self {
        let globals = GlobalRules::default();
        let mut items = Vec::new();
        let mut kinds = Vec::new();
        let mut recvs = Vec::new();
        let mut errors = Vec::new();
        for entry in rules {
            if entry.rule.common().language != lang {
                continue;
            }
            let id = entry.rule.common().id.clone();
            let SerializableOutlineRule::Item(item) = entry.rule.clone() else {
                continue;
            };
            match ItemExtractor::try_from(item, &globals, OutlineEntryDetail::Name) {
                Ok(extractor) => {
                    items.push(extractor);
                    kinds.push(entry.kind);
                    recvs.push(entry.recv);
                }
                Err(error) => {
                    errors.push(format!("{lang}: call rule `{id}` does not compile: {error}"))
                }
            }
        }

        let mut by_kind: Vec<Vec<usize>> = Vec::new();
        for (index, extractor) in items.iter().enumerate() {
            // The walk indexes rules by node kind; a rule without one can
            // never be reached and is an authoring error, not a silent no-op.
            let Some(node_kinds) = extractor.common.rule.matcher.potential_kinds() else {
                errors.push(format!(
                    "{lang}: call rule `{}` has no `kind:` to index on; it can never match",
                    extractor.common.rule.id
                ));
                continue;
            };
            for node_kind in &node_kinds {
                while by_kind.len() <= node_kind {
                    by_kind.push(Vec::new());
                }
                by_kind[node_kind].push(index);
            }
        }

        Self {
            items,
            kinds,
            recvs,
            by_kind,
            errors,
        }
    }

    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }

    /// First call rule that matches this node, in rule order.
    pub fn match_at<'t>(&self, node: &Node<'t, StrDoc<ScanLang>>) -> Option<RawCall> {
        let indices = self.by_kind.get(node.kind_id() as usize)?;
        for &index in indices {
            let extractor = &self.items[index];
            let Some(node_match) = extractor.match_node(node) else {
                continue;
            };
            // `$NAME` is checked at load time, so an unbound one here means
            // the rule's own alternative branch did not bind it.
            let Some(name_node) = node_match.get_env().get_match("NAME") else {
                continue;
            };
            let bytes = extractor.common.name.generate_replacement(&node_match);
            let name = <String as Content>::encode_bytes(&bytes).trim().to_string();
            if name.is_empty() {
                continue;
            }
            let start = name_node.start_pos();
            let end = name_node.end_pos();
            return Some(RawCall {
                name,
                recv: node_match
                    .get_env()
                    .get_match("RECV")
                    .map(|node| normalize_recv(&node.text()))
                    .or_else(|| self.recvs[index].map(str::to_string))
                    .unwrap_or_default(),
                kind: self.kinds[index],
                line: start.line() as u32 + 1,
                col: start.column(name_node) as u32,
                end_col: end.column(name_node) as u32,
                name_start: name_node.range().start,
            });
        }
        None
    }
}

static COMPILED: LazyLock<RwLock<HashMap<ScanLang, Arc<CallExtractors>>>> =
    LazyLock::new(|| RwLock::new(HashMap::new()));

/// Compiled call extractors for `lang`, compiled on first use and shared after.
pub fn extractors_for(lang: ScanLang) -> Arc<CallExtractors> {
    if let Some(found) = COMPILED.read().expect("call cache").get(&lang) {
        return Arc::clone(found);
    }
    let compiled = Arc::new(CallExtractors::compile(lang, &RULES.rules));
    COMPILED
        .write()
        .expect("call cache")
        .insert(lang, Arc::clone(&compiled));
    compiled
}

/// One declaration span of a file: `(start byte, end byte, name)`.
pub type SymbolSpan<'a> = (usize, usize, &'a str);

/// One ordered containment sweep over the declaration spans of a file.
///
/// Declaration spans nest, so the innermost span containing a position is the
/// top of a stack that opens spans in start order and closes them when they
/// end. `spans` must be sorted by (start ASC, end DESC) — the order in which
/// nested declarations are written — and the queries must ask for
/// non-decreasing positions, which makes the whole file one linear pass.
///
/// Both consumers sweep in source order: `finish` resolves each call site's
/// `inSymbol` (`innermost_at`), and `outline::map_items` resolves each
/// symbol's `parent` (`enclosing_of`) from the very same span list, so a call
/// and the declaration it sits in always agree on who encloses them.
pub struct ContainmentSweep<'a> {
    spans: &'a [SymbolSpan<'a>],
    /// Indices into `spans`, innermost last.
    open: Vec<usize>,
    next: usize,
}

impl<'a> ContainmentSweep<'a> {
    pub fn new(spans: &'a [SymbolSpan<'a>]) -> Self {
        Self {
            spans,
            open: Vec::new(),
            next: 0,
        }
    }

    /// Innermost span containing `at`, or `None` at top level.
    pub fn innermost_at(&mut self, at: usize) -> Option<&'a str> {
        while self.next < self.spans.len() && self.spans[self.next].0 <= at {
            self.open.push(self.next);
            self.next += 1;
        }
        self.close(at);
        self.top()
    }

    /// POSITION IN `spans` of the innermost span STRICTLY enclosing
    /// `spans[index]`. Only the spans that precede it in sort order are
    /// opened, so neither the span itself nor a span nested inside it that
    /// starts at the same byte can answer.
    ///
    /// The position, not the name: the outline reads the enclosing
    /// declaration's KIND from it as well (a declaration inside a function
    /// body is local, whatever its own modifiers say).
    pub fn enclosing_of(&mut self, index: usize) -> Option<usize> {
        while self.next < index {
            self.open.push(self.next);
            self.next += 1;
        }
        self.close(self.spans[index].0);
        self.open.last().copied()
    }

    fn close(&mut self, at: usize) {
        while self
            .open
            .last()
            .is_some_and(|&index| self.spans[index].1 <= at)
        {
            self.open.pop();
        }
    }

    fn top(&self) -> Option<&'a str> {
        self.open.last().map(|&index| self.spans[index].2)
    }
}

/// Resolve `inSymbol` and emit the contract order.
///
/// `symbols` are the file's declaration spans, already sorted for
/// `ContainmentSweep` (start ASC, end DESC) by the caller that also uses them
/// to resolve symbol parents.
pub fn finish(mut raw: Vec<RawCall>, symbols: &[SymbolSpan<'_>]) -> Vec<CallInfo> {
    raw.sort_by(|a, b| {
        (a.line, a.col, &a.name, a.kind).cmp(&(b.line, b.col, &b.name, b.kind))
    });
    // One name node is one call site: a second rule matching the same callee
    // (a nested node that re-reports it) never doubles the list.
    raw.dedup_by(|a, b| a.line == b.line && a.col == b.col && a.name == b.name);

    let mut sweep = ContainmentSweep::new(symbols);
    let mut calls = Vec::with_capacity(raw.len());
    for call in &mut raw {
        let in_symbol = sweep
            .innermost_at(call.name_start)
            .map(str::to_string)
            .unwrap_or_default();
        calls.push(CallInfo {
            name: std::mem::take(&mut call.name),
            line: call.line,
            col: call.col,
            end_col: call.end_col,
            kind: call.kind,
            recv: std::mem::take(&mut call.recv),
            in_symbol,
        });
    }
    calls
}

#[cfg(test)]
mod tests {
    use crate::outline::extract;
    use crate::scan_lang::scan_lang_for_ext;

    /// `(name, line, col, endCol, kind, recv, inSymbol)` for one source.
    fn calls(
        graph_lang: &str,
        ext: &str,
        source: &str,
    ) -> Vec<(String, u32, u32, u32, &'static str, String, String)> {
        let lang = scan_lang_for_ext(ext).expect("test extension has a language");
        extract(source, graph_lang, lang)
            .calls
            .expect("an extraction language answers with a list")
            .into_iter()
            .map(|call| {
                (
                    call.name,
                    call.line,
                    call.col,
                    call.end_col,
                    call.kind,
                    call.recv,
                    call.in_symbol,
                )
            })
            .collect()
    }

    fn named(calls: &[(String, u32, u32, u32, &'static str, String, String)]) -> Vec<String> {
        calls
            .iter()
            .map(|(name, _, _, _, kind, recv, _)| format!("{kind} {name} {recv}").trim_end().to_string())
            .collect()
    }

    #[test]
    fn typescript_plain_call_reports_the_callee_name_node() {
        let found = calls("typescript", "ts", "run();\n");
        assert_eq!(
            found,
            vec![(
                "run".to_string(),
                1,
                0,
                3,
                "call",
                String::new(),
                String::new()
            )]
        );
    }

    #[test]
    fn typescript_method_call_carries_the_receiver() {
        let found = calls("typescript", "ts", "const x = a.b.foo(1);\n");
        // Last segment only, and the receiver is the qualifier source text.
        assert_eq!(
            found,
            vec![(
                "foo".to_string(),
                1,
                14,
                17,
                "method",
                "a.b".to_string(),
                "x".to_string()
            )]
        );
    }

    #[test]
    fn typescript_new_expression_is_kind_new() {
        assert_eq!(
            named(&calls("typescript", "ts", "new Widget();\nnew a.Widget();\n")),
            // Last segment only, qualifier as the receiver, kind still `new`.
            vec!["new Widget", "new Widget a"]
        );
    }

    #[test]
    fn typescript_in_symbol_is_the_innermost_enclosing_symbol() {
        let source = "function outer() {\n  function inner() {\n    run();\n  }\n  helper();\n}\ntop();\n";
        let found: Vec<(String, String)> = calls("typescript", "ts", source)
            .into_iter()
            .map(|(name, _, _, _, _, _, in_symbol)| (name, in_symbol))
            .collect();
        assert_eq!(
            found,
            vec![
                ("run".to_string(), "inner".to_string()),
                ("helper".to_string(), "outer".to_string()),
                ("top".to_string(), String::new()),
            ]
        );
    }

    #[test]
    fn typescript_comments_and_strings_never_yield_calls() {
        let source = "// hidden();\n/* also(); */\nconst quoted = \"nope()\";\nconst t = `also(${real()})`;\n";
        assert_eq!(named(&calls("typescript", "ts", source)), vec!["call real"]);
    }

    #[test]
    fn python_call_method_and_decorator_kinds() {
        let source = "@deco()\ndef run(self):\n    inner()\n    self.ping()\n    Widget()\n";
        assert_eq!(
            named(&calls("python", "py", source)),
            vec![
                "call deco",
                "call inner",
                // Python has no constructor syntax: `Widget()` stays a call.
                "method ping self",
                "call Widget",
            ]
        );
    }

    #[test]
    fn python_bare_decorator_is_not_a_call() {
        let source = "@deco\ndef run():\n    pass\n";
        assert!(calls("python", "py", source).is_empty());
    }

    #[test]
    fn python_in_symbol_and_comment_exclusion() {
        let source = "# hidden()\nclass Store:\n    def read(self):\n        load()\n\nload()\n";
        let found: Vec<(String, String)> = calls("python", "py", source)
            .into_iter()
            .map(|(name, _, _, _, _, _, in_symbol)| (name, in_symbol))
            .collect();
        assert_eq!(
            found,
            vec![
                ("load".to_string(), "read".to_string()),
                ("load".to_string(), String::new()),
            ]
        );
    }

    #[test]
    fn character_columns_count_characters_not_bytes() {
        // The `μ` before the call is two bytes but one column.
        let found = calls("typescript", "ts", "const m = \"μ\"; run();\n");
        let (_, _, col, end_col, _, _, _) = &found[0];
        assert_eq!((*col, *end_col), (15, 18));
    }

    /// `Some(vec![])` (parsed, no call sites) and `None` (nothing extracted)
    /// are different answers: the FileRecord omits the key only for `None`,
    /// and the consumer falls back to its text heuristic only then.
    #[test]
    fn a_parsed_file_without_calls_answers_with_an_empty_list() {
        let ts = scan_lang_for_ext("ts").expect("ts");
        assert_eq!(
            extract("export const answer = 42;\n", "typescript", ts).calls,
            Some(Vec::new())
        );
        assert_eq!(extract("", "typescript", ts).calls, Some(Vec::new()));
        assert_eq!(
            extract("# only a comment\n", "python", scan_lang_for_ext("py").expect("py")).calls,
            Some(Vec::new())
        );
    }

    /// Wire v2: a positional tuple with a numeric kind, no `endCol`, and
    /// `""` for an absent receiver.
    #[test]
    fn calls_serialize_as_positional_tuples() {
        let lang = scan_lang_for_ext("ts").expect("ts");
        let calls = extract("run();\nnew Widget();\na.b();\n", "typescript", lang)
            .calls
            .expect("list");
        assert_eq!(
            serde_json::to_string(&calls).unwrap(),
            r#"[["run",1,0,0,"",""],["Widget",2,4,2,"",""],["b",3,2,1,"a",""]]"#
        );
        // `endCol` is derivable and therefore not on the wire.
        assert_eq!(calls[0].end_col, calls[0].col + 3);
    }

    /// The tuple is positional, so every element has to be there in order
    /// even when it is empty — and every string goes through JSON escaping,
    /// because a callee name can carry a quote or a backslash in the
    /// languages whose identifiers are not ASCII words.
    #[test]
    fn call_tuples_escape_strings_and_keep_empty_fields() {
        let calls = vec![
            super::CallInfo {
                name: "quote\"x".to_string(),
                line: 1,
                col: 0,
                end_col: 7,
                kind: "call",
                recv: String::new(),
                in_symbol: String::new(),
            },
            super::CallInfo {
                name: "back\\slash".to_string(),
                line: 2,
                col: 3,
                end_col: 13,
                kind: "method",
                recv: "a\"b\\c".to_string(),
                in_symbol: "outer".to_string(),
            },
            super::CallInfo {
                name: "nl\nname".to_string(),
                line: 3,
                col: 0,
                end_col: 7,
                kind: "new",
                recv: "line\nbreak".to_string(),
                in_symbol: String::new(),
            },
        ];
        // Order is [name, line, col, kind, recv, inSymbol]; an absent receiver
        // and a top-level call are `""`, never a dropped element, or every
        // later field would shift one position left.
        assert_eq!(
            serde_json::to_string(&calls).unwrap(),
            r#"[["quote\"x",1,0,0,"",""],["back\\slash",2,3,1,"a\"b\\c","outer"],["nl\nname",3,0,2,"line\nbreak",""]]"#
        );
        // One line per record on the wire: an escaped newline must not become
        // a real one.
        assert!(!serde_json::to_string(&calls).unwrap().contains('\n'));
    }

    #[test]
    fn receivers_collapse_whitespace_and_truncate() {
        // A multi-line receiver costs bytes without adding information.
        let source = "const x = foo({\n  a: 1,\n  b: 2,\n}).bar();\n";
        let found = calls("typescript", "ts", source);
        let (_, _, _, _, kind, recv, _) = &found[1];
        assert_eq!(*kind, "method");
        assert_eq!(recv, "foo({ a: 1, b: 2, })");

        let long = format!("const y = {}.run();\n", "a".repeat(80));
        let found = calls("typescript", "ts", &long);
        let (_, _, _, _, _, recv, _) = &found[0];
        assert_eq!(recv.chars().count(), 64);
        assert!(recv.ends_with('…') && recv.starts_with(&"a".repeat(63)));
    }

    /// The cap is 64 CHARACTERS, and the cut lands on a character boundary:
    /// with CJK (3 bytes) or non-BMP emoji (4 bytes) receivers a byte-indexed
    /// cut would either panic or emit half a code point.
    #[test]
    fn receiver_truncation_counts_characters_not_bytes() {
        // 80 Hangul syllables: 80 chars, 240 bytes.
        let cjk = "가".repeat(80);
        let found = calls("typescript", "ts", &format!("const y = {cjk}.run();\n"));
        let (_, _, _, _, _, recv, _) = &found[0];
        assert_eq!(recv.chars().count(), 64);
        assert_eq!(recv.len(), 63 * 3 + "…".len(), "cut on a char boundary");
        assert_eq!(*recv, format!("{}…", "가".repeat(63)));

        // A string-literal receiver of non-BMP emoji: 4 bytes per character,
        // and the quote inside `recv` also has to survive JSON escaping.
        let emoji = "🙂".repeat(80);
        let found = calls("typescript", "ts", &format!("const z = \"{emoji}\".trim();\n"));
        let (_, _, _, _, _, recv, _) = &found[0];
        assert_eq!(recv.chars().count(), 64);
        assert_eq!(*recv, format!("\"{}…", "🙂".repeat(62)));
        assert!(recv.chars().all(|ch| ch == '"' || ch == '🙂' || ch == '…'));
        let json = serde_json::to_string(&extract(
            &format!("const z = \"{emoji}\".trim();\n"),
            "typescript",
            scan_lang_for_ext("ts").expect("ts"),
        )
        .calls
        .expect("list"))
        .expect("serializes");
        assert!(json.contains(r#"\"🙂"#), "{json}");

        // A receiver exactly at the cap is kept whole.
        let exact = "나".repeat(64);
        let found = calls("typescript", "ts", &format!("const w = {exact}.run();\n"));
        assert_eq!(found[0].5, exact);
    }

    /// tree-sitter-rust leaves macro arguments as an unparsed `token_tree`,
    /// so calls written inside a macro are only reachable relationally.
    #[test]
    fn rust_macro_arguments_still_report_their_calls() {
        let source = "fn main() {\n    assert_eq!(foo(), 1);\n    let v = vec![f()];\n    println!(\"{}\", g());\n}\n";
        assert_eq!(
            named(&calls("rust", "rs", source)),
            vec![
                "call assert_eq",
                "call foo",
                "call vec",
                "call f",
                "call println",
                "call g",
            ]
        );
    }

    /// `cfg(not(windows))` / `cfg_attr(test, allow(..))` are configuration
    /// predicates inside an attribute's token tree, not calls. And a macro
    /// name is reported exactly once — by the macro rule; the token-tree rule
    /// never sees it, not even for a macro nested in another macro's
    /// arguments (`matches` sits behind its own `!`).
    #[test]
    fn rust_attribute_predicates_are_not_calls_and_macro_names_are_not_doubled() {
        let source = "#![cfg_attr(test, allow(dead_code))]\n#[cfg(not(windows))]\n#[cfg(all(test, feature = \"x\"))]\nfn main() {\n    assert!(matches!(mode(), Mode::On));\n}\n";
        assert_eq!(
            named(&calls("rust", "rs", source)),
            vec!["call assert", "call mode"]
        );
    }

    /// A parenthesised or awaited receiver is still a receiver.
    #[test]
    fn parenthesised_and_awaited_receivers_are_reported() {
        let source = "async function run() {\n  (await import('x')).foo();\n  (await load()).baz();\n}\n";
        for (lang, ext) in [("typescript", "ts"), ("javascript", "mjs")] {
            assert_eq!(
                named(&calls(lang, ext, source)),
                vec![
                    "method foo (await import('x'))",
                    "call load",
                    "method baz (await load())",
                ],
                "{lang}"
            );
        }
    }

    #[test]
    fn a_language_without_rules_answers_unknown() {
        // Scan-only languages have no outline rules, so nothing is extracted
        // and the call list stays unknown instead of a false known-empty.
        for (graph_lang, ext) in [("css", "css"), ("yaml", "yaml"), ("json", "json")] {
            let lang = scan_lang_for_ext(ext).expect("scan language");
            if !crate::outline::has_rules(graph_lang) {
                assert_eq!(
                    extract("a { b: c }\n", graph_lang, lang).calls,
                    None,
                    "{graph_lang}"
                );
            }
        }
    }

    #[test]
    fn every_call_rule_file_compiles_for_every_extraction_language() {
        assert!(super::load_errors().is_empty(), "{:?}", super::load_errors());
        for info in crate::scan_lang::LANG_INFOS {
            if !info.extract() {
                continue;
            }
            let errors = super::language_rule_errors(info.id);
            assert!(errors.is_empty(), "{}: {errors:?}", info.id);
            assert!(
                super::rule_count(info.id) > 0,
                "{}: no call rules loaded",
                info.id
            );
        }
    }

    /// The turbofish wraps the WHOLE callee in a `generic_function`, so
    /// `x.parse::<T>()` and `path::fn::<T>()` hide their name node one level
    /// deeper than the plain shapes do. Without the generic rules every
    /// `.collect::<Vec<_>>()` in a Rust file is silently missing.
    #[test]
    fn rust_turbofish_calls_keep_their_name_node() {
        let source = "fn probe(text: &str) {\n    let a = text.parse::<u32>();\n    let b = serde_json::from_str::<Vec<u32>>(text);\n    let c = plain::<u32>(1);\n}\n";
        assert_eq!(
            named(&calls("rust", "rs", source)),
            vec!["method parse text", "method from_str serde_json", "call plain"]
        );
        // The name node is the identifier alone: the type arguments are not
        // part of `name`, and `endCol` stops before `::<`.
        let parse = &calls("rust", "rs", source)[0];
        assert_eq!((parse.1, parse.2, parse.3), (2, 17, 22));
    }

    /// A C# callee with type arguments is a `generic_name`, and a
    /// null-conditional invocation puts the callee under the
    /// `conditional_access_expression` the invocation calls. Both shapes used
    /// to answer wrong (`GetService<IFoo>` as the name) or not at all.
    #[test]
    fn csharp_generic_and_null_conditional_calls() {
        let source = "class H {\n  void Go(S sp) {\n    sp.GetService<IFoo>();\n    Resolve<IBar>(2);\n    sp?.Maybe();\n    sp.Items?.Count();\n  }\n}\n";
        assert_eq!(
            named(&calls("csharp", "cs", source)),
            vec![
                "method GetService sp",
                "call Resolve",
                "method Maybe sp",
                "method Count sp.Items",
            ]
        );
        let generic = &calls("csharp", "cs", source)[0];
        assert_eq!((generic.1, generic.2, generic.3), (3, 7, 17));
    }

    /// A constructor name is the LAST segment of the type and never carries
    /// its type arguments — the shapes that hide the name node behind a
    /// qualifier, a template/generic wrapper, or both.
    #[test]
    fn qualified_and_generic_constructors_name_the_last_segment() {
        assert_eq!(
            named(&calls(
                "csharp",
                "cs",
                "class H { void Go() { var a = new System.Collections.Generic.List<int>(); } }\n"
            )),
            vec!["new List"]
        );
        assert_eq!(
            named(&calls(
                "java",
                "java",
                "class P { void go() { var a = new java.util.ArrayList<String>(); var b = new java.util.HashMap(); } }\n"
            )),
            vec!["new ArrayList", "new HashMap"]
        );
        assert_eq!(
            named(&calls(
                "cpp",
                "cpp",
                "void go() { auto *v = new std::vector<std::string>(); }\n"
            )),
            vec!["new vector"]
        );
    }

    /// `finish()` collapses only the SAME name node reported twice by
    /// overlapping rules. Two genuine calls that share a line keep their own
    /// entries, because their name nodes sit at different columns.
    #[test]
    fn duplicate_collapse_never_merges_two_genuine_calls() {
        assert_eq!(
            calls("typescript", "ts", "f(f(x));\n")
                .iter()
                .map(|call| (call.0.clone(), call.2))
                .collect::<Vec<_>>(),
            vec![("f".to_string(), 0), ("f".to_string(), 2)]
        );
        // A chain that calls the same method twice: same name, same line, two
        // receivers, two columns.
        assert_eq!(
            calls("typescript", "ts", "a.b().b();\n")
                .iter()
                .map(|call| (call.0.clone(), call.2, call.5.clone()))
                .collect::<Vec<_>>(),
            vec![
                ("b".to_string(), 2, "a".to_string()),
                ("b".to_string(), 6, "a.b()".to_string()),
            ]
        );
    }

    /// `inSymbol` is span containment, so it has to survive spans that nest
    /// three deep, siblings that share one line, and symbols whose whole span
    /// is a single line.
    #[test]
    fn in_symbol_resolves_nested_and_single_line_spans() {
        let source = "class Store {\n  read() {\n    function inner() { deep(); }\n    inner();\n  }\n}\nfunction a() { x(); } function b() { y(); }\n";
        let found: Vec<(String, String)> = calls("typescript", "ts", source)
            .into_iter()
            .map(|(name, _, _, _, _, _, in_symbol)| (name, in_symbol))
            .collect();
        assert_eq!(
            found,
            vec![
                // function inside a method inside a class
                ("deep".to_string(), "inner".to_string()),
                ("inner".to_string(), "read".to_string()),
                // two single-line sibling spans on one line
                ("x".to_string(), "a".to_string()),
                ("y".to_string(), "b".to_string()),
            ]
        );
    }

    /// Malformed rule DOCUMENTS are reported at load time — this is the list
    /// `load_errors()` hands to `outline::rule_errors()`, which `--langs` and
    /// `--outline` print as `ruleErrors`.
    #[test]
    fn malformed_call_documents_are_reported_at_load_time() {
        let body = "language: TypeScript\nrole: item\nsymbolType: function\nrule:\n  kind: call_expression\n  has:\n    field: function\n    kind: identifier\n    pattern: $NAME\nname: $NAME\n";
        let cases = [
            (format!("id: no-marker\n{body}"), "mixdog-call-kind"),
            (
                format!("# mixdog-call-kind: invoke\nid: bad-kind\n{body}"),
                "unknown call kind",
            ),
            (
                "# mixdog-call-kind: call\nid: no-name\nlanguage: TypeScript\nrole: item\nsymbolType: function\nrule:\n  kind: call_expression\nname: callee\n".to_string(),
                "$NAME",
            ),
            (
                // `--- # note` is not a column-zero separator, so both rules
                // land in one document and would share one kind marker.
                format!("# mixdog-call-kind: call\nid: one\n{body}--- # note\nid: two\n{body}"),
                "one YAML document",
            ),
        ];
        for (doc, expected) in cases {
            let mut rules = Vec::new();
            let mut errors = Vec::new();
            super::parse_call_document(&doc, "test.yml", 1, &mut rules, &mut errors);
            assert_eq!(errors.len(), 1, "{doc}\n{errors:?}");
            assert!(errors[0].contains(expected), "{}", errors[0]);
            assert!(rules.is_empty(), "a rejected document loads no rule");
        }
    }

    /// A call rule that PARSES but cannot run (unknown node kind for this
    /// grammar, or no `kind:` for the walk to index on) is reported per
    /// language — `outline::language_rule_errors` forwards exactly these
    /// strings, and that is what `--langs` prints as the language's
    /// `ruleErrors`. The healthy rules in the same bundle keep running, and
    /// symbol extraction — compiled from the outline rules, not these — is
    /// untouched.
    #[test]
    fn a_broken_call_rule_is_reported_and_symbol_extraction_survives() {
        let lang = scan_lang_for_ext("ts").expect("ts");
        let mut rules = Vec::new();
        let mut errors = Vec::new();
        for (index, doc) in [
            "# mixdog-call-kind: call\nid: broken-kind\nlanguage: TypeScript\nrole: item\nsymbolType: function\nrule:\n  kind: no_such_node_kind\n  has:\n    field: function\n    pattern: $NAME\nname: $NAME\n",
            "# mixdog-call-kind: call\nid: unindexable\nlanguage: TypeScript\nrole: item\nsymbolType: function\nrule:\n  any:\n    - kind: call_expression\n    - regex: '^handler$'\nname: $NAME\n",
            "# mixdog-call-kind: call\nid: works\nlanguage: TypeScript\nrole: item\nsymbolType: function\nrule:\n  kind: call_expression\n  has:\n    field: function\n    kind: identifier\n    pattern: $NAME\nname: $NAME\n",
        ]
        .into_iter()
        .enumerate()
        {
            super::parse_call_document(doc, "test.yml", index + 1, &mut rules, &mut errors);
        }
        assert!(errors.is_empty(), "documents parse: {errors:?}");

        let compiled = super::CallExtractors::compile(lang, &rules);
        // The healthy rule still runs …
        assert_eq!(compiled.items.len(), 1, "{:?}", compiled.errors);
        assert!(!compiled.is_empty());
        // … and both unusable rules are named in the per-language diagnostics.
        let reported = compiled.errors.join("\n");
        assert!(
            reported.contains("broken-kind") && reported.contains("unindexable"),
            "both broken call rules must be reported: {reported}"
        );

        // A language whose call rules are ALL unusable still extracts symbols.
        let none = super::CallExtractors::compile(lang, &[]);
        assert!(none.is_empty());
        let extraction = extract("export class Widget { run() { helper(); } }\n", "typescript", lang);
        assert!(
            extraction.symbols.iter().any(|symbol| symbol.name == "Widget"),
            "symbol extraction is independent of the call rules"
        );
    }
}
