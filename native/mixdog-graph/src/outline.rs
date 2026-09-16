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

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::Path;
use std::sync::{Arc, LazyLock, RwLock};

use ast_grep_config::GlobalRules;
use ast_grep_core::tree_sitter::StrDoc;
use ast_grep_core::{AstGrep, Matcher, Node};
use ast_grep_outline::extractor::{
    parse_outline_rules, ItemExtractor, MemberExtractor, SerializableOutlineRule,
};
use ast_grep_outline::model::{OutlineItem, SymbolType};
use ast_grep_outline::options::{
    OutlineEntryDetail, OutlineExtractorOptions, OutlineMemberOptions,
};
use ast_grep_outline::DEFAULT_OUTLINE_RULES;
use serde::Serialize;

use crate::scan_lang::{graph_lang_scan_langs, ScanLang};
use crate::tokens::{GrammarKinds, KindRole, MetaField};

/// Our parity rules (registered before the ast-grep defaults).
const PARITY_RULES: &str = include_str!("outline_rules/parity.yml");
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

// ---------------------------------------------------------------- rule load

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
    let mut found: Option<&str> = None;
    for line in doc.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("# mixdog-kind:") {
            found = Some(rest.trim());
        }
    }
    let token = found?;
    if token.is_empty() {
        return None;
    }
    if token == "import" {
        return Some(DeclaredKind::Import);
    }
    Some(DeclaredKind::Symbol(intern_kind(token)))
}

/// Graph kinds are `&'static str` in the FileRecord, and a rule file may name
/// a kind this crate has never seen (a new language's vocabulary). Interning
/// leaks at most one small string per distinct kind, once per process.
fn intern_kind(token: &str) -> &'static str {
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
fn parse_rule_stream(
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
    rules: Vec<SerializableOutlineRule<ScanLang>>,
    kinds: HashMap<String, DeclaredKind>,
    errors: Vec<String>,
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

static RULES: LazyLock<LoadedRules> = LazyLock::new(load_rules);

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

// ------------------------------------------------------------- compilation

/// One matched item with the rule-declared kinds resolved alongside it.
pub struct WalkedItem<'t> {
    pub item: OutlineItem<'t>,
    declared: Option<DeclaredKind>,
    /// Parallel to `item.members`.
    member_declared: Vec<Option<DeclaredKind>>,
}

/// Compiled item/member extractors for one language, indexed by node kind.
pub struct LangExtractors {
    items: Vec<ItemExtractor<ScanLang>>,
    /// node kind id → item extractor indices, in rule order.
    item_by_kind: Vec<Vec<usize>>,
    /// per item extractor: index into `member_scopes`, if it has member rules.
    item_scope: Vec<Option<usize>>,
    /// per item extractor: `# mixdog-kind:` declared by its rule file.
    item_kinds: Vec<Option<DeclaredKind>>,
    members: Vec<MemberExtractor<ScanLang>>,
    /// one scope per item rule id that member rules point at.
    member_scopes: Vec<HashMap<u16, Vec<usize>>>,
    member_kinds: Vec<Option<DeclaredKind>>,
    /// Call rules of this language, applied by the same walk so a file is
    /// parsed and traversed exactly once for symbols, imports and calls.
    calls: Arc<crate::calls::CallExtractors>,
    /// Grammar-derived node-kind roles: which kinds are identifier tokens and
    /// which are the package/namespace declaration of this language.
    kinds: Arc<GrammarKinds>,
    /// Rules of this language that parsed but cannot run.
    errors: Vec<String>,
}

/// One walk: outline items (symbols + import edges), call sites, identifier
/// tokens and the file-level declaration metadata — everything a FileRecord
/// needs from the source tree, from a single traversal.
#[derive(Default)]
pub struct Walked<'t> {
    pub items: Vec<WalkedItem<'t>>,
    pub calls: Vec<crate::calls::RawCall>,
    /// Unique identifier-like texts, borrowed from the source (Stage 3-D).
    pub tokens: HashSet<&'t str>,
    pub meta: FileMeta,
}

/// `packageName` / `namespaceName` / `goPackageName` as the parse tree
/// reports them. A file can hold more than one namespace declaration, so each
/// field keeps the one that starts EARLIEST — the same "first one in the
/// file" answer the pre-Stage-3 line regex gave.
#[derive(Default)]
pub struct FileMeta {
    package: Option<(usize, String)>,
    namespace: Option<(usize, String)>,
    go_package: Option<(usize, String)>,
}

impl FileMeta {
    fn note(&mut self, field: MetaField, start: usize, name: String) {
        let slot = match field {
            MetaField::Package => &mut self.package,
            MetaField::Namespace => &mut self.namespace,
            MetaField::GoPackage => &mut self.go_package,
        };
        if slot.as_ref().is_none_or(|(at, _)| start < *at) {
            *slot = Some((start, name));
        }
    }

    fn take(slot: Option<(usize, String)>) -> String {
        slot.map(|(_, name)| name).unwrap_or_default()
    }
}

impl LangExtractors {
    fn compile(
        lang: ScanLang,
        rules: &[SerializableOutlineRule<ScanLang>],
        declared: &HashMap<String, DeclaredKind>,
    ) -> Self {
        let globals = GlobalRules::default();
        // Names only: signatures are not part of the FileRecord contract and
        // rendering them would cost a template expansion per symbol.
        let options = OutlineExtractorOptions {
            detail: OutlineEntryDetail::Name,
            members: Some(OutlineMemberOptions {
                detail: OutlineEntryDetail::Name,
                ..Default::default()
            }),
            ..Default::default()
        };
        let mut items = Vec::new();
        let mut item_kinds: Vec<Option<DeclaredKind>> = Vec::new();
        let mut members = Vec::new();
        let mut member_kinds: Vec<Option<DeclaredKind>> = Vec::new();
        let mut member_parents: Vec<Vec<String>> = Vec::new();
        // A rule that fails to compile (unknown node kind for this grammar, bad
        // pattern) is skipped so one broken rule cannot blank out a whole
        // language — but it is REPORTED, never dropped in silence.
        let mut errors: Vec<String> = Vec::new();
        for rule in rules {
            if rule.common().language != lang {
                continue;
            }
            let kind = declared.get(&rule.common().id).copied();
            let id = rule.common().id.clone();
            match rule.clone() {
                SerializableOutlineRule::Item(item) => {
                    match ItemExtractor::try_from(item, &globals, options.detail) {
                        Ok(extractor) => {
                            items.push(extractor);
                            item_kinds.push(kind);
                        }
                        Err(error) => errors.push(format!(
                            "{lang}: item rule `{id}` does not compile: {error}"
                        )),
                    }
                }
                SerializableOutlineRule::Member(member) => {
                    let parents = member.parent_rule_ids.clone();
                    match MemberExtractor::try_from(member, &globals, options.detail) {
                        Ok(extractor) => {
                            members.push(extractor);
                            member_kinds.push(kind);
                            member_parents.push(parents);
                        }
                        Err(error) => errors.push(format!(
                            "{lang}: member rule `{id}` does not compile: {error}"
                        )),
                    }
                }
            }
        }

        let mut item_by_kind: Vec<Vec<usize>> = Vec::new();
        for (index, extractor) in items.iter().enumerate() {
            // The walk indexes rules by node kind, so a rule without one (a
            // bare pattern rule) can never be reached and is a rule-authoring
            // error, not a silent no-op.
            let Some(kinds) = extractor.common.rule.matcher.potential_kinds() else {
                errors.push(format!(
                    "{lang}: item rule `{}` has no `kind:` to index on; it can never match",
                    extractor.common.rule.id
                ));
                continue;
            };
            for kind in &kinds {
                while item_by_kind.len() <= kind {
                    item_by_kind.push(Vec::new());
                }
                item_by_kind[kind].push(index);
            }
        }

        // Member rules are grouped by the item rule id they attach to.
        let mut scope_by_parent: HashMap<&str, usize> = HashMap::new();
        let mut member_scopes: Vec<HashMap<u16, Vec<usize>>> = Vec::new();
        for (index, extractor) in members.iter().enumerate() {
            let Some(kinds) = extractor.common.rule.matcher.potential_kinds() else {
                errors.push(format!(
                    "{lang}: member rule `{}` has no `kind:` to index on; it can never match",
                    extractor.common.rule.id
                ));
                continue;
            };
            for parent in &member_parents[index] {
                let scope = match scope_by_parent.get(parent.as_str()) {
                    Some(scope) => *scope,
                    None => {
                        member_scopes.push(HashMap::new());
                        let scope = member_scopes.len() - 1;
                        // SAFETY of the key lifetime: `member_parents` outlives
                        // the map, which is dropped at the end of this fn.
                        scope_by_parent.insert(
                            Box::leak(parent.clone().into_boxed_str()) as &'static str,
                            scope,
                        );
                        scope
                    }
                };
                for kind in &kinds {
                    member_scopes[scope]
                        .entry(kind as u16)
                        .or_default()
                        .push(index);
                }
            }
        }
        let item_scope = items
            .iter()
            .map(|item| scope_by_parent.get(item.common.rule.id.as_str()).copied())
            .collect();

        Self {
            items,
            item_by_kind,
            item_scope,
            item_kinds,
            members,
            member_scopes,
            member_kinds,
            calls: crate::calls::extractors_for(lang),
            kinds: crate::tokens::kinds_for(lang),
            errors,
        }
    }

    fn is_empty(&self) -> bool {
        self.items.is_empty()
    }

    /// Item/member/call rules for one file, in rule order. `text` is the very
    /// source the tree was parsed from: node ranges index into it, so tokens
    /// and metadata are borrowed slices rather than copies.
    fn extract<'t>(&self, root: Node<'t, StrDoc<ScanLang>>, text: &'t str) -> Walked<'t> {
        let mut items: Vec<WalkedItem<'t>> = Vec::new();
        let mut calls: Vec<crate::calls::RawCall> = Vec::new();
        let mut tokens: HashSet<&'t str> = HashSet::new();
        let mut meta = FileMeta::default();
        let has_calls = !self.calls.is_empty();
        // Explicit stack: source files nest deeply enough that recursion is a
        // stack-overflow risk on generated code.
        let mut stack: Vec<(Node<'t, StrDoc<ScanLang>>, Option<(usize, usize)>)> =
            vec![(root, None)];
        while let Some((node, scope)) = stack.pop() {
            let kind = node.kind_id();
            let mut next_scope = scope;
            let mut matched_member = false;
            if let Some((scope_index, owner)) = scope {
                if let Some(indices) = self.member_scopes[scope_index].get(&kind) {
                    for &index in indices {
                        if let Some(node_match) = self.members[index].match_node(&node) {
                            let owner_item = &mut items[owner];
                            owner_item
                                .item
                                .members
                                .push(self.members[index].extract(&node_match));
                            owner_item.member_declared.push(self.member_kinds[index]);
                            matched_member = true;
                            break;
                        }
                    }
                }
            }
            if !matched_member {
                if let Some(indices) = self.item_by_kind.get(kind as usize) {
                    for &index in indices {
                        if let Some(node_match) = self.items[index].match_node(&node) {
                            items.push(WalkedItem {
                                item: self.items[index].extract(&node_match, Vec::new()),
                                declared: self.item_kinds[index],
                                member_declared: Vec::new(),
                            });
                            next_scope =
                                self.item_scope[index].map(|scope| (scope, items.len() - 1));
                            break;
                        }
                    }
                }
            }
            // A node can be both a declaration and a call site (a decorator, a
            // binding initialised by a call), so calls are tried on every
            // node regardless of what matched above.
            if has_calls {
                if let Some(call) = self.calls.match_at(&node) {
                    calls.push(call);
                }
            }
            // Identifier tokens and the file's package/namespace declaration
            // ride the same visit: one table lookup per node, no second pass
            // over the source.
            match self.kinds.role(kind) {
                KindRole::None => {}
                // NO NAMED CHILDREN: a few composite kinds share an identifier
                // word with their token kinds (`variable_declarator`,
                // `variable_declaration`, php's `variable_name` wrapping a
                // `name`), and their text spans a whole expression. Their
                // identifier children are visited on their own, so skipping
                // the composites reports the same identifiers without
                // re-scanning the expression around them.
                //
                // The test is "no NAMED child", not "no child at all": a
                // grammar may spell an identifier node as a wrapper around one
                // ANONYMOUS token, which has no node of its own to visit.
                // Kotlin does exactly that for its soft keywords — `value`,
                // `expect`, `data`, `inner`, … are real identifiers in
                // `fun nested(value: String)`, and a leaf-only test dropped
                // every one of them.
                KindRole::Identifier if !node.children().any(|child| child.is_named()) => {
                    if let Some(slice) = text.get(node.range()) {
                        crate::tokens::identifier_runs(slice, |run| {
                            tokens.insert(run);
                        });
                    }
                }
                // A composite identifier node still contributes when its OWN
                // text is a single identifier run: php's `variable_name` wraps
                // a `name` child but spells the sigil form `$count`, which no
                // child node carries.
                KindRole::Identifier => {
                    if let Some(slice) = text.get(node.range()) {
                        if crate::tokens::is_single_run(slice) {
                            tokens.insert(slice);
                        }
                    }
                }
                KindRole::Meta(field) => {
                    let range = node.range();
                    if let Some(name) = meta_name(&node, text) {
                        meta.note(field, range.start, name);
                    }
                }
            }
            for child in node.children() {
                stack.push((child, next_scope));
            }
        }
        Walked {
            items,
            calls,
            tokens,
            meta,
        }
    }
}

/// Declared name of a package/namespace node: its first named child whose
/// text is a dotted identifier path. Reading the children instead of a field
/// name keeps this grammar-independent — java puts annotations before the
/// name, csharp puts the body after it, and both are skipped because neither
/// is a dotted path.
fn meta_name(node: &Node<'_, StrDoc<ScanLang>>, text: &str) -> Option<String> {
    for child in node.children() {
        if !child.is_named() {
            continue;
        }
        let slice = text.get(child.range())?;
        if crate::tokens::is_dotted_path(slice) {
            return Some(slice.to_string());
        }
    }
    None
}

static COMPILED: LazyLock<RwLock<HashMap<ScanLang, Arc<LangExtractors>>>> =
    LazyLock::new(|| RwLock::new(HashMap::new()));

/// Compiled extractors for `lang`, compiled on first use and shared after.
pub fn extractors_for(lang: ScanLang) -> Arc<LangExtractors> {
    if let Some(found) = COMPILED.read().expect("outline cache").get(&lang) {
        return Arc::clone(found);
    }
    let compiled = Arc::new(LangExtractors::compile(lang, &RULES.rules, &RULES.kinds));
    COMPILED
        .write()
        .expect("outline cache")
        .insert(lang, Arc::clone(&compiled));
    compiled
}

// ------------------------------------------------------------ symbol model

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

struct Candidate {
    name: String,
    /// Pre-Stage-3 (per-language) kind; mapped through `KIND_MAP` on the way
    /// out, and the key the language's `exported` rule keys on.
    kind: &'static str,
    /// Line the NAME sits on: the deduplication key, not a record field.
    line: u32,
    start_line: u32,
    start_col: u32,
    end_line: u32,
    end_col: u32,
    start_byte: usize,
    span: usize,
    /// `isExported` (item) / `isPublic` (member) as the matched rule reported
    /// it. One input of `is_exported`, not the answer.
    rule_exported: bool,
    /// Matched by a MEMBER rule (a declaration inside a container item), not
    /// by an item rule. `isPublic` is a container-visibility flag, which is
    /// not the same statement as a module export.
    member: bool,
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

fn map_items(walked: Walked<'_>, text: &str, graph_lang: &str) -> Extraction {
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
    let items = &items;
    // (byte offset, spec) so the emitted list stays in source order even
    // though the traversal visits siblings back to front.
    let mut imports: Vec<(usize, String)> = Vec::new();
    let mut seen_imports: HashSet<String> = HashSet::new();
    let mut candidates: Vec<Candidate> = Vec::new();
    let mut by_key: HashMap<(String, u32), usize> = HashMap::new();

    let push_candidate = |candidate: Candidate,
                          candidates: &mut Vec<Candidate>,
                          by_key: &mut HashMap<(String, u32), usize>| {
        let key = (candidate.name.clone(), candidate.line);
        match by_key.get(&key) {
            Some(&index) if keeps_existing(&candidates[index], &candidate) => {}
            Some(&index) => candidates[index] = candidate,
            None => {
                by_key.insert(key, candidates.len());
                candidates.push(candidate);
            }
        }
    };

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
    let imports = imports.into_iter().map(|(_, spec)| spec).collect();
    candidates.sort_by(|a, b| {
        (a.start_line, a.start_col, a.line, &a.name).cmp(&(
            b.start_line,
            b.start_col,
            b.line,
            &b.name,
        ))
    });

    // Containment order: nesting is a byte-span relation, not a line one, so
    // the sweep runs over the candidates sorted by (start ASC, end DESC).
    // `parent` and the calls' `inSymbol` share this ONE span list, which is
    // built from the same deduplicated candidates the record reports.
    let mut order: Vec<usize> = (0..candidates.len()).collect();
    order.sort_by_key(|&index| {
        (
            candidates[index].start_byte,
            std::cmp::Reverse(candidates[index].end_byte()),
        )
    });
    // The parent as an INDEX into `candidates`, not only as a name: the
    // visibility rules need the enclosing declaration's KIND too.
    let mut parent_of: Vec<Option<usize>> = vec![None; candidates.len()];
    let calls = {
        let spans: Vec<crate::calls::SymbolSpan<'_>> = order
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
        let mut sweep = crate::calls::ContainmentSweep::new(&spans);
        for (position, &index) in order.iter().enumerate() {
            if let Some(enclosing) = sweep.enclosing_of(position) {
                parent_of[index] = Some(order[enclosing]);
            }
        }
        crate::calls::finish(calls, &spans)
    };

    // `(parent name, is local)` per candidate: a declaration with a
    // FUNCTION-LIKE ancestor lives in that body and cannot be visible outside
    // the file in ANY language, whatever its modifiers or the export clause
    // say (`fun localHelper` inside a method, a C# local function, a `pub fn`
    // inside a `fn`).
    let meta: Vec<(String, bool)> = (0..candidates.len())
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
        .collect();

    let visibility = FileVisibility::of(graph_lang, text);
    let symbols = candidates
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
        .collect();
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

/// Line the declared name sits on. Identical to the declaration start line
/// except for signatures that put the name on a later line (`static void\nf()`).
/// Only the head of the declaration is scanned: a name that is not in it is
/// reported at the declaration start.
fn name_line(text: &str, start: usize, end: usize, start_line: u32, name: &str) -> u32 {
    const HEAD_BYTES: usize = 2048;
    if name.is_empty() || start >= text.len() {
        return start_line;
    }
    let mut head_end = end.min(text.len()).min(start + HEAD_BYTES);
    while head_end > start && !text.is_char_boundary(head_end) {
        head_end -= 1;
    }
    let head = &text[start..head_end];
    match word_index(head, name) {
        Some(index) => start_line + head[..index].matches('\n').count() as u32,
        None => start_line,
    }
}

fn is_word_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_' || byte >= 0x80
}

// --------------------------------------------------------------- kind table

/// Graph `kind` for one outline entry: the node kind decides first (it is the
/// most specific signal and survives rules that share a symbolType), then the
/// LSP symbol type. `None` drops the entry — the pre-Stage-2 queries never
/// emitted fields, properties, enum members or import statements as symbols.
pub fn symbol_kind(lang: &str, ast_kind: &str, symbol_type: SymbolType) -> Option<&'static str> {
    if let Some(kind) = kind_by_ast_kind(lang, ast_kind) {
        return kind;
    }
    kind_by_symbol_type(lang, symbol_type)
}

/// `Some(None)` = this node kind is never a symbol, `None` = no opinion.
fn kind_by_ast_kind(lang: &str, ast_kind: &str) -> Option<Option<&'static str>> {
    // Import/dependency statements are never symbols in any language.
    match ast_kind {
        "import_statement"
        | "import_from_statement"
        | "import_declaration"
        | "import_header"
        | "import_list"
        | "dotted_name"
        | "aliased_import"
        | "using_directive"
        | "use_declaration"
        | "namespace_use_declaration"
        | "preproc_include"
        | "preproc_import"
        | "module_import"
        | "require_expression"
        | "require_once_expression"
        | "include_expression"
        | "include_once_expression"
        | "import_or_export"
        | "part_directive"
        | "import_specification"
        | "builtin_function"
        | "function_call"
        | "command"
        | "call_expression" => return Some(None),
        _ => {}
    }
    let kind = match (lang, ast_kind) {
        ("typescript" | "javascript", "variable_declarator") => Some("binding"),
        ("typescript" | "javascript", "method_definition") => Some("method"),
        ("typescript" | "javascript", "class" | "class_declaration") => Some("class"),
        ("typescript", "abstract_class_declaration") => Some("class"),
        ("typescript", "type_alias_declaration") => Some("type"),
        ("typescript", "internal_module" | "module") => Some("namespace"),
        // `declare module 'pkg'` names a package, not a declared symbol; a
        // `declare namespace X` still reports the inner `internal_module`.
        ("typescript", "ambient_declaration") => None,
        ("typescript", "interface_declaration") => Some("interface"),
        ("typescript", "enum_declaration") => Some("enum"),
        (
            "typescript" | "javascript",
            "function_declaration"
            | "function_expression"
            | "generator_function"
            | "function_signature",
        ) => Some("function"),
        // A METHOD SIGNATURE — of an interface, of a type literal, or the
        // `abstract` form in a class — declares a method with no body, and is
        // the only declaration of that name. A PROPERTY signature is a data
        // field and stays a non-symbol.
        ("typescript", "method_signature" | "abstract_method_signature") => Some("method"),
        // A `pair` reaches this table only through the object-literal rule,
        // which matches function-valued properties alone.
        ("typescript" | "javascript", "pair") => Some("method"),
        // Enum bodies, class fields and interface data fields are no symbols.
        // A class field holds a VALUE, even when that value is a function
        // (`handle = () => {}`, `boundArrow: (a: number) => number = (a) =>
        // a + 1`): the object-literal rule above reads `pair` nodes, and a
        // class body has none. Reporting the field would need its own rule and
        // would put a second `method` on lines a class member rule already
        // owns, so an arrow-valued field stays what it is — a field.
        (
            "typescript" | "javascript",
            "public_field_definition"
            | "field_definition"
            | "property_signature"
            | "method_signature"
            | "property_identifier"
            | "enum_assignment",
        ) => None,
        ("python", "assignment") => None,
        ("go", "type_spec") => Some("type"),
        // An interface method element is a bodyless method declaration.
        ("go", "method_elem") => Some("method"),
        ("go", "type_declaration" | "const_spec" | "var_spec") => None,
        ("rust", "type_item") => Some("type"),
        ("rust", "macro_definition") => Some("macro"),
        ("rust", "const_item") => Some("const"),
        ("rust", "static_item") => Some("static"),
        ("rust", "mod_item") => Some("module"),
        ("rust", "function_item") => Some("function"),
        ("rust", "struct_item") => Some("struct"),
        ("rust", "enum_item") => Some("enum"),
        ("rust", "trait_item") => Some("trait"),
        // A trait method signature is a declaration with no body; Rust reports
        // every `fn` as `function`, in a trait as much as anywhere else.
        ("rust", "function_signature_item") => Some("function"),
        // `impl` blocks, fields and variants are not graph symbols.
        ("rust", "impl_item" | "field_declaration" | "enum_variant") => None,
        ("java", "record_declaration") => Some("record"),
        ("java", "field_declaration") => None,
        ("kotlin", "companion_object" | "secondary_constructor" | "property_declaration") => None,
        ("csharp", "record_declaration") => Some("record"),
        ("csharp", "local_function_statement") => Some("local-function"),
        (
            "csharp",
            "delegate_declaration"
            | "property_declaration"
            | "field_declaration"
            | "enum_member_declaration"
            | "variable_declarator",
        ) => None,
        ("c", "union_specifier" | "declaration" | "field_declaration" | "enumerator") => None,
        (
            "cpp",
            "union_specifier" | "declaration" | "field_declaration" | "enumerator"
            | "concept_definition",
        ) => None,
        // `require 'x'` is a plain method call, never a symbol.
        ("ruby", "assignment" | "call" | "command") => None,
        ("php", "trait_declaration") => Some("trait"),
        ("php", "property_declaration" | "enum_case") => None,
        ("swift", "init_declaration") => None,
        // A protocol requirement is a bodyless `func`, which Swift reports as
        // `function` like every other one.
        ("swift", "protocol_function_declaration") => Some("function"),
        ("dart", "mixin_declaration") => Some("mixin"),
        ("dart", "extension_declaration") => Some("extension"),
        _ => return None,
    };
    Some(kind)
}

fn kind_by_symbol_type(lang: &str, symbol_type: SymbolType) -> Option<&'static str> {
    use SymbolType as S;
    match lang {
        "typescript" => match symbol_type {
            S::Function => Some("function"),
            S::Class => Some("class"),
            S::Interface => Some("interface"),
            S::Enum => Some("enum"),
            // ast-grep types a TS `type X = ...` alias as a struct.
            S::Struct => Some("type"),
            S::Method | S::Constructor => Some("method"),
            S::Constant | S::Variable => Some("binding"),
            S::Namespace => Some("namespace"),
            _ => None,
        },
        "javascript" => match symbol_type {
            S::Function => Some("function"),
            S::Class => Some("class"),
            S::Method | S::Constructor => Some("method"),
            S::Constant | S::Variable => Some("binding"),
            _ => None,
        },
        // Python class methods were plain functions before Stage 2.
        "python" => match symbol_type {
            S::Function | S::Method => Some("function"),
            S::Class => Some("class"),
            _ => None,
        },
        "go" => match symbol_type {
            S::Function => Some("function"),
            S::Method => Some("method"),
            S::Struct | S::Interface | S::TypeParameter => Some("type"),
            _ => None,
        },
        "rust" => match symbol_type {
            S::Function | S::Method => Some("function"),
            S::Struct => Some("struct"),
            S::Enum => Some("enum"),
            S::Interface => Some("trait"),
            S::Module => Some("module"),
            S::Constant => Some("const"),
            S::Variable => Some("static"),
            _ => None,
        },
        "java" => match symbol_type {
            S::Class => Some("class"),
            S::Interface => Some("interface"),
            S::Enum => Some("enum"),
            S::Method => Some("method"),
            S::Constructor => Some("constructor"),
            _ => None,
        },
        // The Kotlin grammar files a class, an interface and an enum under the
        // same declaration node, which the old query reported as `class`.
        "kotlin" => match symbol_type {
            S::Function | S::Method => Some("function"),
            S::Class | S::Interface | S::Enum => Some("class"),
            S::Object => Some("object"),
            _ => None,
        },
        "csharp" => match symbol_type {
            S::Class => Some("class"),
            S::Interface => Some("interface"),
            S::Struct => Some("struct"),
            S::Enum => Some("enum"),
            S::Method => Some("method"),
            S::Constructor => Some("constructor"),
            _ => None,
        },
        "c" => match symbol_type {
            S::Function => Some("function"),
            S::Struct => Some("struct"),
            S::Enum => Some("enum"),
            _ => None,
        },
        "cpp" => match symbol_type {
            S::Function => Some("function"),
            S::Class => Some("class"),
            S::Struct => Some("struct"),
            S::Method => Some("method"),
            _ => None,
        },
        "ruby" => match symbol_type {
            S::Function | S::Method => Some("method"),
            S::Class => Some("class"),
            S::Module => Some("module"),
            _ => None,
        },
        "php" => match symbol_type {
            S::Function => Some("function"),
            S::Class => Some("class"),
            S::Method => Some("method"),
            S::Interface => Some("interface"),
            S::Enum => Some("enum"),
            _ => None,
        },
        "swift" => match symbol_type {
            S::Function | S::Method => Some("function"),
            S::Class => Some("class"),
            S::Struct => Some("struct"),
            S::Enum => Some("enum"),
            S::Object => Some("actor"),
            S::Interface => Some("protocol"),
            _ => None,
        },
        "scala" => match symbol_type {
            S::Function | S::Method => Some("function"),
            S::Class => Some("class"),
            S::Object => Some("object"),
            S::Interface => Some("trait"),
            _ => None,
        },
        "bash" | "lua" | "r" => match symbol_type {
            S::Function | S::Method => Some("function"),
            _ => None,
        },
        "dart" => match symbol_type {
            S::Class => Some("class"),
            S::Enum => Some("enum"),
            S::Function => Some("function"),
            S::Method => Some("method"),
            _ => None,
        },
        "objc" => match symbol_type {
            S::Class => Some("class"),
            S::Interface => Some("protocol"),
            S::Method => Some("method"),
            S::Function => Some("function"),
            _ => None,
        },
        // Elixir def/defp are functions and defmacro/defmacrop are macros;
        // both are plain `call` nodes, so the rule tags the macro form with
        // the LSP `operator` category.
        "elixir" => match symbol_type {
            S::Module => Some("module"),
            S::Function => Some("function"),
            S::Operator => Some("macro"),
            _ => None,
        },
        // Zig container types share one declaration node; `object` is the
        // rule-level tag for a union.
        "zig" => match symbol_type {
            S::Function => Some("function"),
            S::Struct => Some("struct"),
            S::Enum => Some("enum"),
            S::Object => Some("union"),
            _ => None,
        },
        _ => None,
    }
}

// ----------------------------------------------------- unified kind mapping

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

// ------------------------------------------------------------- declaration head

/// Bytes of a declaration node scanned for its head. A head longer than this
/// is cut here; `SIG_MAX_CHARS` cuts it again after whitespace collapsing.
const HEAD_SCAN_BYTES: usize = 1024;
/// `sig` length cap in CHARACTERS, before the `…` marker.
const SIG_MAX_CHARS: usize = 160;

/// The declaration head of a symbol as one line: the source from the start of
/// the declaration node up to — and excluding — its body, with every
/// whitespace run (indentation and the newlines of a multi-line signature)
/// collapsed to a single space, cut to `SIG_MAX_CHARS` characters plus `…`.
///
/// The head ends at the first, at bracket depth zero, of
///   * `{` — a braced body (`fn f() {`, `class C {`, `resource "x" "y" {`),
///   * `=` — an initializer or an expression body (`def m(): Int = 1`,
///     `const x: Foo = 1`, which keeps the type annotation the value hides).
///     Two `=` do NOT end the head: one inside a type argument list
///     (`fn gen<T = u8>()`, a generic default) and one that is part of the
///     declared name (Ruby's `def name=(value)`). A FUNCTION-VALUED
///     initializer does not end it either — see `initializer_head_end`,
///   * `;` — the end of a bodyless declaration (`def m; end`),
///   * `:` that ends its line — a Python/Ruby-style block opener. A `:` with
///     more on the line is a type annotation (`function f(a: number): void`),
///   * a newline AFTER the name has appeared — the body of a keyword-delimited
///     language (`function f(a)\n … end`). Before the name it is part of the
///     signature (`static void\nlate_name(void)`), so it does not cut.
fn declaration_head(text: &str, start: usize, end: usize, name: &str) -> String {
    if start >= text.len() {
        return String::new();
    }
    let mut limit = end.min(text.len()).min(start + HEAD_SCAN_BYTES);
    while limit > start && !text.is_char_boundary(limit) {
        limit -= 1;
    }
    let window = &text[start..limit];
    let name_end = word_index(window, name).map(|at| at + name.len());
    let bytes = window.as_bytes();
    let mut depth: i32 = 0;
    // Type argument lists nest like brackets but `<` is also a comparison, so
    // only a `<` DIRECTLY after a name opens one (`Vec<T>`, `gen<T = u8>`);
    // `class Foo < Bar` and `a < b` never do. `=>` / `->` do not close one.
    let mut angle: i32 = 0;
    let mut cut = window.len();
    let mut index = 0usize;
    while index < bytes.len() {
        match bytes[index] {
            b'(' | b'[' => depth += 1,
            b')' | b']' => depth -= 1,
            b'<' if index > 0 && is_word_byte(bytes[index - 1]) => angle += 1,
            b'>' if angle > 0 && !matches!(bytes[index - 1], b'=' | b'-') => angle -= 1,
            b'{' if depth <= 0 => {
                cut = index;
                break;
            }
            b'{' => depth += 1,
            b'}' => depth -= 1,
            b';' if depth <= 0 => {
                cut = index;
                break;
            }
            // `=` opens an initializer or an expression body (`def m = 1`,
            // `int X => x`), but `==` / `!=` / `<=` / `>=` are part of the
            // declaration itself (`bool operator ==(Object other)`), a `=`
            // inside a type argument list is a generic default, and a `=` the
            // name itself ends in is Ruby's setter syntax.
            b'=' if depth <= 0
                && angle <= 0
                && !is_comparison(bytes, index)
                && !name_end.is_some_and(|at| index < at) =>
            {
                cut = initializer_head_end(window, index).unwrap_or(index);
                break;
            }
            b':' if depth <= 0 && rest_of_line_is_empty(bytes, index + 1) => {
                cut = index;
                break;
            }
            b'\n' if depth <= 0 && name_end.is_some_and(|at| index >= at) => {
                cut = index;
                break;
            }
            _ => {}
        }
        index += 1;
    }
    collapse_head(&window[..cut])
}

/// End of a FUNCTION-VALUED initializer's head, measured from the `=` at
/// `eq`, or `None` when the initializer is a plain value.
///
/// `const f = (a, b) => a + b`, `add = function(a, b) { … }` and
/// `handler = async (event) => …` declare a callable whose parameter list is
/// exactly the signature a reader wants, but the declaration node starts at
/// the BINDING, so cutting at the `=` would leave `f` — the name again, i.e.
/// no `sig` at all. The head therefore runs
///   * through the `=>` of an arrow (`f = (a, b) =>`), or
///   * up to the body of a function expression (`add = function(a, b)`).
///
/// Anything else — an object, a call, a conditional, a class expression — is
/// a VALUE and the head still ends at the `=`, which keeps
/// `const x: Foo = make()` reporting its type annotation.
fn initializer_head_end(window: &str, eq: usize) -> Option<usize> {
    let bytes = window.as_bytes();
    let mut index = skip_spaces(bytes, eq + 1);
    if starts_word_at(window, index, "async") {
        index = skip_spaces(bytes, index + "async".len());
    }
    let function_expression = starts_word_at(window, index, "function");
    let mut depth: i32 = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'(' | b'[' => depth += 1,
            b')' | b']' => depth -= 1,
            // The arrow itself ends the head, parameters and all.
            b'=' if depth <= 0 && bytes.get(index + 1) == Some(&b'>') => {
                return Some(index + 2);
            }
            // A body opens: a function expression's head is everything before
            // it, any other `{` at this depth is an object/class value.
            b'{' if depth <= 0 => return function_expression.then_some(index),
            b'{' => depth += 1,
            b'}' => depth -= 1,
            // The initializer ended without a parameter list in it.
            b';' | b',' | b'\n' if depth <= 0 => return None,
            _ => {}
        }
        index += 1;
    }
    None
}

fn skip_spaces(bytes: &[u8], from: usize) -> usize {
    let mut index = from;
    while index < bytes.len() && bytes[index].is_ascii_whitespace() {
        index += 1;
    }
    index
}

/// `text[at..]` starts with `word` as a whole word.
fn starts_word_at(text: &str, at: usize, word: &str) -> bool {
    text.get(at..).is_some_and(|rest| {
        rest.starts_with(word)
            && !rest
                .as_bytes()
                .get(word.len())
                .copied()
                .is_some_and(is_word_byte)
    })
}

/// The `=` at `index` belongs to a comparison operator, not to an assignment.
fn is_comparison(bytes: &[u8], index: usize) -> bool {
    let previous = index
        .checked_sub(1)
        .map(|at| bytes[at])
        .is_some_and(|byte| matches!(byte, b'=' | b'!' | b'<' | b'>'));
    previous || bytes.get(index + 1) == Some(&b'=')
}

/// Nothing but spaces (or a trailing comment) between `from` and the line end.
fn rest_of_line_is_empty(bytes: &[u8], from: usize) -> bool {
    let mut index = from;
    while index < bytes.len() && matches!(bytes[index], b' ' | b'\t' | b'\r') {
        index += 1;
    }
    index >= bytes.len() || matches!(bytes[index], b'\n' | b'#')
}

/// Whitespace-collapsed head, cut at a CHARACTER boundary: `SIG_MAX_CHARS`
/// characters plus `…`, never a byte slice through a multi-byte character.
fn collapse_head(head: &str) -> String {
    let mut out = String::with_capacity(head.len());
    let mut pending_space = false;
    for ch in head.trim().chars() {
        if ch.is_whitespace() {
            pending_space = !out.is_empty();
            continue;
        }
        if pending_space {
            out.push(' ');
            pending_space = false;
        }
        out.push(ch);
    }
    if out.chars().count() <= SIG_MAX_CHARS {
        return out;
    }
    let mut cut: String = out.chars().take(SIG_MAX_CHARS).collect();
    cut.push('…');
    cut
}

/// Byte index of `needle` in `haystack` as a whole word, or `None`.
fn word_index(haystack: &str, needle: &str) -> Option<usize> {
    if needle.is_empty() {
        return None;
    }
    let bytes = haystack.as_bytes();
    haystack.match_indices(needle).find_map(|(index, _)| {
        let before_ok = index == 0 || !is_word_byte(bytes[index - 1]);
        let after = index + needle.len();
        let after_ok = after >= bytes.len() || !is_word_byte(bytes[after]);
        (before_ok && after_ok).then_some(index)
    })
}

/// A modifier keyword stands in the declaration head as its own word.
fn has_modifier(head: &str, word: &str) -> bool {
    word_index(head, word).is_some()
}

fn has_any_modifier(head: &str, words: &[&str]) -> bool {
    words.iter().any(|word| has_modifier(head, word))
}

// --------------------------------------------------------------- exported

/// File-level visibility state some languages need and a declaration node
/// does not carry: a TS/JS `export { … }` clause, Ruby's section markers and
/// Haskell's module export list. Every other language answers from the
/// declaration itself.
enum FileVisibility {
    None,
    /// Names an `export { a, b as c }` clause or an `export default a`
    /// statement makes visible, none of which touch the declaration itself.
    Script(HashSet<String>),
    /// `(byte offset, hides what follows)` for each bare `private` /
    /// `protected` / `public` line and each marker RESET (a class/module body
    /// opening, a dedented `end`).
    Ruby(Vec<(usize, bool)>),
    /// `Some(names)` = the module header has an export list and only those
    /// names leave the module; `None` = no export list, so everything does.
    Haskell(Option<HashSet<String>>),
}

impl FileVisibility {
    fn of(graph_lang: &str, text: &str) -> Self {
        match graph_lang {
            "typescript" | "javascript" => Self::Script(export_clause_names(text)),
            "ruby" => Self::Ruby(ruby_sections(text)),
            "haskell" => Self::Haskell(haskell_export_list(text)),
            _ => Self::None,
        }
    }

    /// The file states that `name` leaves the module, without saying so on
    /// the declaration.
    fn names(&self, name: &str) -> bool {
        match self {
            Self::Script(names) => names.contains(name),
            _ => false,
        }
    }
}

/// Is this declaration visible outside the file/module it lives in?
///
/// One rule per language, each the language's OWN notion of visibility:
///
/// | language | exported when |
/// |---|---|
/// | typescript, javascript | the declaration is inside an `export` (the rule's `isExported`) or an `export { … }` clause names it; a `method` never is |
/// | rust | the declaration head starts with `pub` (`pub`, `pub(crate)`, …), or a `macro_rules!` carries `#[macro_export]` |
/// | zig | the head carries `pub` |
/// | go | the name starts with an upper-case letter |
/// | python | module level (no parent) and the name has no `_` prefix |
/// | java, csharp | an explicit `public` modifier (both default to narrower) |
/// | kotlin, scala, swift | no `private`/`protected`/`internal`/`fileprivate` modifier (all default to visible) |
/// | php | no `private`/`protected` modifier (members default to public) |
/// | ruby | no enclosing `private`/`protected` section and no `private def` prefix |
/// | elixir | the defining form does not end in `p` (`def`/`defmacro` yes, `defp`/`defmacrop` no) |
/// | haskell | named in the module export list, or the module has no export list; the module header and every `instance` always |
/// | solidity | functions: `public`/`external`, or a FILE-LEVEL free function (which cannot carry a visibility modifier and is importable); every other declaration is part of the contract's surface |
/// | c, cpp, objc | no `static` storage class (a static declaration is file-local) |
/// | dart | the name has no `_` prefix (Dart privacy is name-based) |
/// | lua | not declared `local` |
/// | bash, r, hcl | always — these languages have no visibility at all |
///
/// Above all of them: a declaration INSIDE A FUNCTION BODY (`local`) is never
/// exported, in any language. A `pub fn` in a Rust function, a Kotlin local
/// `fun`, a C# local function and a Java local class are reachable from their
/// body and nowhere else, so no modifier and no export clause can lift them.
///
/// Only TypeScript/JavaScript read the rule's own flag, and only because
/// their rule files spell it out: an outline item rule that OMITS
/// `isExported` defaults to TRUE upstream, so the flag says nothing unless a
/// rule declares it. Every other language answers from the declaration head,
/// the name, or the file (`FileVisibility`).
///
/// Approximations, on purpose:
///   * CommonJS is not read: `module.exports = …` / `exports.x = …` are
///     ASSIGNMENTS, not declarations, so they are no symbols of their own and
///     they do not export the declaration they name either. Only the ES
///     module statements above do.
///   * java/csharp read the PUBLIC API surface, not file scope: package-private
///     and `internal` are visible to other files of the same package/assembly,
///     and are still reported as not exported.
///   * go reads the NAME, which is the language's own rule, so `Read` on an
///     unexported receiver (`func (s *store) Read()`) counts as exported.
///   * python ignores `__all__`: the `_` prefix convention is the declaration's
///     own statement, `__all__` is a separate runtime value.
///   * ruby matches the nearest preceding section marker, with class/module
///     bodies and dedented `end`s resetting it, not a full scope parse.
///   * a C++ in-class `private:` label is not read (only `static` is).
fn is_exported(
    graph_lang: &str,
    candidate: &Candidate,
    head: &str,
    top_level: bool,
    local: bool,
    text: &str,
    visibility: &FileVisibility,
) -> bool {
    let name = candidate.name.as_str();
    if local {
        return false;
    }
    match graph_lang {
        // Only a module-level `export` exports anything here. A METHOD never
        // is, whatever its `isPublic` flag says and whoever matched it: a
        // class member, an object-literal property, an interface signature —
        // none of them can carry an `export`, and an `export { name }` clause
        // of the same word names the module-level declaration, not the method.
        "typescript" | "javascript" => {
            !candidate.member
                && candidate.kind != "method"
                && (candidate.rule_exported || visibility.names(name))
        }
        // `#[macro_export]` is an attribute item ABOVE the declaration, so it
        // is the one export marker that is not in the head.
        "rust" => {
            has_modifier(head, "pub")
                || (candidate.kind == "macro" && macro_exported(text, candidate.start_byte))
        }
        "zig" => has_modifier(head, "pub"),
        "go" => name.starts_with(|ch: char| ch.is_uppercase()),
        "python" => top_level && !name.starts_with('_'),
        "java" | "csharp" => has_modifier(head, "public"),
        "kotlin" | "scala" | "swift" => {
            !has_any_modifier(head, &["private", "protected", "internal", "fileprivate"])
        }
        "php" => !has_any_modifier(head, &["private", "protected"]),
        "ruby" => match visibility {
            FileVisibility::Ruby(sections) => ruby_exported(text, sections, candidate.start_byte),
            _ => true,
        },
        // Elixir marks a private definition with a trailing `p` on the
        // defining form: `defp` / `defmacrop` / `defguardp` are private,
        // `def` / `defmacro` / `defmodule` / `defprotocol` are not.
        "elixir" => !head
            .split(|ch: char| !ch.is_alphanumeric() && ch != '_')
            .next()
            .is_some_and(|form| form.ends_with('p')),
        // The module header IS the file's identity and an instance is global
        // in Haskell: neither one is ever named in an export list.
        "haskell" => match (candidate.kind, visibility) {
            ("module" | "instance", _) => true,
            (_, FileVisibility::Haskell(Some(names))) => names.contains(name),
            _ => true,
        },
        // A contract function states its visibility; a FILE-LEVEL free
        // function may not carry one at all and is importable by any file.
        "solidity" => match candidate.kind {
            "function" => top_level || has_any_modifier(head, &["public", "external"]),
            _ => true,
        },
        "c" | "cpp" | "objc" => !has_modifier(head, "static"),
        "dart" => !name.starts_with('_'),
        // `local function helper()` is exactly Lua's file-private form.
        "lua" => !has_modifier(head, "local"),
        "bash" | "r" | "hcl" => true,
        _ => candidate.rule_exported,
    }
}

/// Local names a TS/JS file exports without touching their declarations:
/// `export { a, b as c }`, `export type { T }` and `export default a`.
///
/// `export { x } from './other'` is skipped — those names come from another
/// module and say nothing about a declaration of the same name here.
fn export_clause_names(text: &str) -> HashSet<String> {
    let mut names = HashSet::new();
    let bytes = text.as_bytes();
    for (start, _) in text.match_indices("export") {
        if !starts_word_at(text, start, "export")
            || start
                .checked_sub(1)
                .is_some_and(|before| is_word_byte(bytes[before]))
        {
            continue;
        }
        let mut at = skip_spaces(bytes, start + "export".len());
        if starts_word_at(text, at, "default") {
            // `export default expression;` exports a declaration only when
            // the expression IS one name (`export default Panel;`).
            let value_start = skip_spaces(bytes, at + "default".len());
            let value_end = text[value_start..]
                .find(|ch: char| !(ch.is_alphanumeric() || ch == '_' || ch == '$'))
                .map_or(text.len(), |offset| value_start + offset);
            let rest = text[value_end..].trim_start_matches([' ', '\t', '\r']);
            if value_end > value_start && (rest.starts_with(';') || rest.starts_with('\n')) {
                names.insert(text[value_start..value_end].to_string());
            }
            continue;
        }
        if starts_word_at(text, at, "type") {
            at = skip_spaces(bytes, at + "type".len());
        }
        if bytes.get(at) != Some(&b'{') {
            continue;
        }
        let Some(close) = text[at..].find('}').map(|offset| at + offset) else {
            continue;
        };
        // `export { … } from '…'` re-exports another module's names.
        if text[close + 1..].trim_start().starts_with("from") {
            continue;
        }
        for entry in text[at + 1..close].split(',') {
            let entry = entry.trim();
            let entry = entry.strip_prefix("type ").unwrap_or(entry).trim();
            let local = entry.split_whitespace().next().unwrap_or_default();
            if !local.is_empty() && local != "default" {
                names.insert(local.to_string());
            }
        }
    }
    names
}

/// The declaration at `start` is preceded by a `#[macro_export]` attribute.
fn macro_exported(text: &str, start: usize) -> bool {
    text[..start]
        .trim_end()
        .rsplit('\n')
        .next()
        .is_some_and(|line| line.trim_start().starts_with("#[macro_export]"))
}

/// Ruby's bare visibility markers as `(byte offset, hides what follows)`, in
/// source order, plus the RESETS that end a marker's reach: a marker belongs
/// to the class or module body it stands in, so opening another body
/// (`class Second`, `module M`, a reopened class) and closing the body it
/// lives in (an `end` indented LESS than the marker) both restore the
/// default, public visibility.
fn ruby_sections(text: &str) -> Vec<(usize, bool)> {
    let mut sections = Vec::new();
    let mut marker_indent: Option<usize> = None;
    let mut offset = 0usize;
    for line in text.split_inclusive('\n') {
        let trimmed = line.trim();
        let indent = line.len() - line.trim_start().len();
        match trimmed {
            "private" | "protected" => {
                sections.push((offset, true));
                marker_indent = Some(indent);
            }
            "public" => {
                sections.push((offset, false));
                marker_indent = Some(indent);
            }
            _ => {
                let opens_body = ["class", "module"]
                    .iter()
                    .any(|keyword| starts_word_at(trimmed, 0, keyword));
                let closes_body =
                    trimmed == "end" && marker_indent.is_some_and(|marker| indent < marker);
                if opens_body || closes_body {
                    sections.push((offset, false));
                    marker_indent = None;
                }
            }
        }
        offset += line.len();
    }
    sections
}

/// A Ruby method is private when the nearest preceding section marker hides
/// it, or when its own line starts with `private`/`protected` (`private def
/// helper`).
fn ruby_exported(text: &str, sections: &[(usize, bool)], start: usize) -> bool {
    let line_start = text[..start].rfind('\n').map_or(0, |index| index + 1);
    let prefix = text[line_start..start].trim_end();
    if prefix.ends_with("private") || prefix.ends_with("protected") {
        return false;
    }
    // `<=`, not `<`: a reset sits at the START of the `class`/`module` line
    // that the declaration itself opens, so it has to count for that
    // declaration too.
    match sections.partition_point(|(offset, _)| *offset <= start) {
        0 => true,
        count => !sections[count - 1].1,
    }
}

/// Names in a Haskell module's export list, or `None` when the header has no
/// export list (which exports everything). Every identifier inside the list is
/// collected, so `Class(method)` and `Type(..)` export their members too.
fn haskell_export_list(text: &str) -> Option<HashSet<String>> {
    let mut offset = 0usize;
    let mut header_start = None;
    for line in text.split_inclusive('\n') {
        if line.trim_start().starts_with("module ") {
            header_start = Some(offset + (line.len() - line.trim_start().len()));
            break;
        }
        offset += line.len();
    }
    let rest = &text[header_start?..];
    let bytes = rest.as_bytes();
    let mut depth = 0usize;
    let mut list_start = None;
    for (index, byte) in bytes.iter().enumerate() {
        match byte {
            b'(' => {
                depth += 1;
                if depth == 1 {
                    list_start = Some(index + 1);
                }
            }
            b')' => {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    let start = list_start?;
                    return Some(haskell_export_names(&rest[start..index]));
                }
            }
            _ => {
                // `where` before any parenthesis: no export list at all.
                if depth == 0 && rest[index..].starts_with("where") && index > 0 {
                    return None;
                }
            }
        }
    }
    None
}

fn haskell_export_names(list: &str) -> HashSet<String> {
    let mut names = HashSet::new();
    let mut current = String::new();
    for ch in list.chars() {
        if ch.is_alphanumeric() || ch == '_' || ch == '\'' {
            current.push(ch);
            continue;
        }
        if !current.is_empty() {
            names.insert(std::mem::take(&mut current));
        }
    }
    if !current.is_empty() {
        names.insert(current);
    }
    names
}

// ------------------------------------------------------------ import specs

/// Import spec(s) in the exact shape the resolvers expect, from the rule name
/// (already the spec node for most languages) plus the matched source text.
fn import_specs(lang: &str, ast_kind: &str, name: &str, text: &str) -> Vec<String> {
    let name = name.trim();
    match lang {
        "php" => match ast_kind {
            "namespace_use_declaration" | "use_declaration" => expand_php_use_spec(name),
            _ => single(strip_quotes(name)),
        },
        "elixir" => {
            let spec = leading_elixir_alias(name);
            if spec.is_empty() {
                Vec::new()
            } else {
                expand_elixir_alias_spec(spec)
            }
        }
        "rust" => match ast_kind {
            // `mod x;` is a `mod::x` edge for the resolver.
            "mod_item" => single(format!("mod::{name}")),
            _ => single(name.to_string()),
        },
        "scala" => single(leading_dotted_path(name)),
        "swift" => single(leading_dotted_path(name)),
        // `#include "a.h"` and `#include <a.h>` both resolve on the bare path;
        // an unquoted `#include MACRO` was never an import edge.
        "c" | "cpp" => match delimited_include(name, text) {
            Some(spec) => single(spec),
            None => Vec::new(),
        },
        "objc" => match ast_kind {
            "preproc_import" | "preproc_include" => match delimited_include(name, text) {
                Some(spec) => single(spec),
                None => Vec::new(),
            },
            _ => single(strip_quotes(name)),
        },
        "java" | "kotlin" | "csharp" => single(name.to_string()),
        "python" | "go" => single(strip_quotes(name)),
        _ => {
            let _ = text;
            single(strip_quotes(name))
        }
    }
}

fn single(spec: String) -> Vec<String> {
    let trimmed = spec.trim().to_string();
    if trimmed.is_empty() {
        Vec::new()
    } else {
        vec![trimmed]
    }
}

fn strip_quotes(spec: &str) -> String {
    let spec = spec.trim();
    let bytes = spec.as_bytes();
    if bytes.len() >= 2 {
        let first = bytes[0];
        let last = bytes[bytes.len() - 1];
        let quoted = matches!(first, b'"' | b'\'' | b'`') && first == last;
        if quoted {
            return spec[1..spec.len() - 1].to_string();
        }
    }
    spec.to_string()
}

/// `"a.h"` / `<a.h>` → `a.h`; `#include MACRO` is not an include edge. A rule
/// may strip the delimiters itself, so the directive text decides when the
/// name arrives bare.
fn delimited_include(spec: &str, directive: &str) -> Option<String> {
    let spec = spec.trim();
    if let Some(inner) = spec
        .strip_prefix('"')
        .and_then(|rest| rest.strip_suffix('"'))
        .or_else(|| {
            spec.strip_prefix('<')
                .and_then(|rest| rest.strip_suffix('>'))
        })
    {
        return Some(inner.to_string());
    }
    let quoted = directive.contains('"') || directive.contains('<');
    quoted.then(|| spec.to_string())
}

/// Leading `A.b.c` run of an import spec: Scala selector braces / wildcards
/// and Swift trailing tokens are not part of the resolvable path.
fn leading_dotted_path(spec: &str) -> String {
    let spec = spec.trim();
    let mut end = 0usize;
    for (index, ch) in spec.char_indices() {
        let ok = if index == 0 {
            ch.is_ascii_alphabetic() || ch == '_'
        } else {
            ch.is_ascii_alphanumeric() || ch == '_' || ch == '.'
        };
        if !ok {
            break;
        }
        end = index + ch.len_utf8();
    }
    let path = &spec[..end];
    let path = path.strip_suffix("._").unwrap_or(path);
    path.trim_end_matches('.').to_string()
}

/// Leading `Foo.Bar` / `Foo.{Bar, Baz}` alias of an Elixir import argument.
fn leading_elixir_alias(spec: &str) -> &str {
    let spec = spec.trim();
    if !spec.starts_with(|ch: char| ch.is_ascii_uppercase()) {
        return "";
    }
    let bytes = spec.as_bytes();
    let mut index = 0usize;
    while index < bytes.len() {
        let byte = bytes[index];
        if byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'.' {
            index += 1;
            continue;
        }
        if byte == b'{' {
            if let Some(close) = spec[index..].find('}') {
                return &spec[..index + close + 1];
            }
        }
        break;
    }
    &spec[..index]
}

/// `A\{B, C}` → `A\B`, `A\C`; a plain spec passes through.
pub fn expand_php_use_spec(spec: &str) -> Vec<String> {
    let spec = spec.trim();
    let Some(open) = spec.find('{') else {
        return vec![spec.to_string()];
    };
    let prefix = spec[..open].trim().trim_end_matches('\\');
    let inner = spec[open + 1..].trim().trim_end_matches('}').trim();
    inner
        .split(',')
        .filter_map(|part| {
            let mut name = part.trim();
            if let Some(index) = name.find(" as ") {
                name = name[..index].trim();
            }
            if name.is_empty() || name == "*" {
                return None;
            }
            Some(if prefix.is_empty() {
                name.to_string()
            } else {
                format!("{prefix}\\{name}")
            })
        })
        .collect()
}

/// `Foo.{Bar, Baz}` → `Foo.Bar`, `Foo.Baz`; a plain alias passes through.
pub fn expand_elixir_alias_spec(spec: &str) -> Vec<String> {
    let spec = spec.trim();
    let Some(open) = spec.find('{') else {
        return vec![spec.to_string()];
    };
    let prefix = spec[..open].trim().trim_end_matches('.');
    let inner = spec[open + 1..].trim().trim_end_matches('}').trim();
    inner
        .split(',')
        .filter_map(|part| {
            let name = part.trim();
            if name.is_empty() || name == "*" {
                return None;
            }
            Some(if prefix.is_empty() {
                name.to_string()
            } else {
                format!("{prefix}.{name}")
            })
        })
        .collect()
}

// ------------------------------------------------------------ `--outline`

#[derive(Serialize)]
struct PositionJson {
    line: usize,
    column: usize,
}

#[derive(Serialize)]
struct RangeJson {
    start: PositionJson,
    end: PositionJson,
    #[serde(rename = "byteOffset")]
    byte_offset: [usize; 2],
}

#[derive(Serialize)]
struct MemberJson {
    #[serde(rename = "symbolType")]
    symbol_type: SymbolType,
    name: String,
    #[serde(rename = "isPublic")]
    is_public: bool,
}

#[derive(Serialize)]
struct ItemJson {
    #[serde(rename = "symbolType")]
    symbol_type: SymbolType,
    name: String,
    range: RangeJson,
    #[serde(rename = "isImport")]
    is_import: bool,
    #[serde(rename = "isExported")]
    is_exported: bool,
    members: Vec<MemberJson>,
}

#[derive(Serialize)]
struct FileJson<'a> {
    file: String,
    lang: &'static str,
    items: Vec<ItemJson>,
    /// Call sites in the READABLE object form (`CallDebug`), not the
    /// positional wire tuple a FileRecord carries: `--outline` exists so rule
    /// authors can validate a rule against real sources, and a tuple hides
    /// which field is which.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    calls: Vec<crate::calls::CallDebug<'a>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Serialize)]
struct OutlineSummaryBody {
    files: usize,
    items: usize,
    errors: Vec<String>,
}

#[derive(Serialize)]
struct OutlineSummaryLine {
    summary: OutlineSummaryBody,
}

const USAGE: &str = "usage: mixdog-graph <cwd> --outline [--rules <path|->] [--files <rel>...]";

struct OutlineArgs {
    rules: Option<String>,
    files: Vec<String>,
}

fn parse_args(args: &[String]) -> Result<OutlineArgs, String> {
    let mut rules = None;
    let mut files = Vec::new();
    let mut index = 0usize;
    while index < args.len() {
        match args[index].as_str() {
            "--rules" => {
                index += 1;
                let Some(value) = args.get(index) else {
                    return Err(format!("--rules needs a path or `-`\n{USAGE}"));
                };
                rules = Some(value.clone());
                index += 1;
            }
            "--files" => {
                index += 1;
                while let Some(value) = args.get(index) {
                    if value.starts_with("--") {
                        break;
                    }
                    files.push(value.clone());
                    index += 1;
                }
            }
            other => return Err(format!("unknown outline argument `{other}`\n{USAGE}")),
        }
    }
    Ok(OutlineArgs { rules, files })
}

/// `--outline` entry point: dump the raw outline items per file so rule
/// authors can validate a rule file against real sources, including the
/// grammars the ast-grep CLI cannot load (objc/zig/r). Never writes files.
pub fn run(root: &Path, args: &[String]) -> Result<(), crate::scan::ScanError> {
    use crate::scan::ScanError;
    use std::io::Write;

    let args = parse_args(args).map_err(ScanError::Usage)?;
    let mut errors: Vec<String> = rule_errors().to_vec();
    let mut extra_kinds = RULES.kinds.clone();
    let extra = match args.rules.as_deref() {
        Some(spec) => {
            let text = crate::scan::read_rule_text(spec).map_err(ScanError::Usage)?;
            let mut parsed = Vec::new();
            let mut parse_errors = Vec::new();
            parse_rule_stream(
                &text,
                spec,
                &mut parsed,
                &mut extra_kinds,
                &mut parse_errors,
            );
            if !parse_errors.is_empty() {
                return Err(ScanError::Usage(parse_errors.join("\n")));
            }
            parsed
        }
        None => Vec::new(),
    };

    let files = if args.files.is_empty() {
        crate::scan::collect_scan_files(root).map_err(ScanError::Internal)?
    } else {
        crate::scan::selected_scan_files(root, &args.files).map_err(ScanError::Internal)?
    };

    // Extra rules are compiled per run and take precedence over the bundle.
    let mut combined: Vec<SerializableOutlineRule<ScanLang>> = Vec::new();
    if !extra.is_empty() {
        combined.extend(extra.iter().cloned());
        combined.extend(RULES.rules.iter().cloned());
    }
    let mut per_lang: HashMap<ScanLang, Arc<LangExtractors>> = HashMap::new();

    let stdout = std::io::stdout();
    let mut handle = std::io::BufWriter::new(stdout.lock());
    let mut item_count = 0usize;
    let mut file_count = 0usize;
    for file in &files {
        let extractors = match per_lang.get(&file.lang) {
            Some(found) => Arc::clone(found),
            None => {
                let compiled = if combined.is_empty() {
                    extractors_for(file.lang)
                } else {
                    Arc::new(LangExtractors::compile(file.lang, &combined, &extra_kinds))
                };
                // Rules that parsed but cannot run are the rule author's
                // problem: report them once per language.
                for error in &compiled.errors {
                    errors.push(error.clone());
                }
                per_lang.insert(file.lang, Arc::clone(&compiled));
                compiled
            }
        };
        if extractors.is_empty() {
            continue;
        }
        file_count += 1;
        let graph_lang = file
            .path
            .extension()
            .and_then(|ext| ext.to_str())
            .and_then(crate::scan_lang::graph_lang_for_ext)
            .unwrap_or_default();
        let (items, calls, error) = match std::fs::read_to_string(&file.path) {
            Ok(text) => match AstGrep::<StrDoc<ScanLang>>::try_new(&text, file.lang) {
                Ok(ast) => {
                    let walked = extractors.extract(ast.root(), &text);
                    let json = outline_json(&walked.items);
                    let calls = map_items(walked, &text, graph_lang)
                        .calls
                        .unwrap_or_default();
                    (json, calls, None)
                }
                Err(error) => (
                    Vec::new(),
                    Vec::new(),
                    Some(format!("parse failed: {error}")),
                ),
            },
            Err(error) => (
                Vec::new(),
                Vec::new(),
                Some(format!("read failed: {error}")),
            ),
        };
        if let Some(error) = &error {
            errors.push(format!("{}: {error}", file.rel));
        }
        item_count += items.len();
        let record = FileJson {
            file: file.rel.clone(),
            lang: file.lang.id(),
            items,
            calls: calls.iter().map(Into::into).collect(),
            error,
        };
        let line = serde_json::to_string(&record)
            .map_err(|error| ScanError::Internal(format!("serialize failed: {error}")))?;
        writeln!(handle, "{line}")
            .map_err(|error| ScanError::Internal(format!("stdout write failed: {error}")))?;
    }
    let summary = OutlineSummaryLine {
        summary: OutlineSummaryBody {
            files: file_count,
            items: item_count,
            errors,
        },
    };
    let line = serde_json::to_string(&summary)
        .map_err(|error| ScanError::Internal(format!("serialize failed: {error}")))?;
    writeln!(handle, "{line}")
        .map_err(|error| ScanError::Internal(format!("stdout write failed: {error}")))?;
    handle
        .flush()
        .map_err(|error| ScanError::Internal(format!("stdout flush failed: {error}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scan_lang::scan_lang_for_ext;

    /// `(kind, name, startLine)` for one source, in emission order.
    fn symbols(graph_lang: &str, ext: &str, source: &str) -> Vec<(&'static str, String, u32)> {
        let lang = scan_lang_for_ext(ext).expect("fixture extension has a language");
        extract(source, graph_lang, lang)
            .symbols
            .into_iter()
            .map(|symbol| (symbol.kind, symbol.name, symbol.start_line))
            .collect()
    }

    fn kinds(graph_lang: &str, ext: &str, source: &str) -> Vec<(&'static str, String)> {
        symbols(graph_lang, ext, source)
            .into_iter()
            .map(|(kind, name, _)| (kind, name))
            .collect()
    }

    fn imports(graph_lang: &str, ext: &str, source: &str) -> Vec<String> {
        let lang = scan_lang_for_ext(ext).expect("fixture extension has a language");
        extract(source, graph_lang, lang).imports
    }

    fn named(pairs: &[(&str, &str)]) -> Vec<(&'static str, String)> {
        pairs
            .iter()
            .map(|(kind, name)| (intern_kind(kind), (*name).to_string()))
            .collect()
    }

    #[test]
    fn typescript_kinds_match_the_graph_vocabulary() {
        let source = r#"
export function run(): void {}
export class Store { read(): void {} }
export interface Options { flag: boolean }
export type Handler = () => void;
export enum Mode { Fast }
export const LIMIT = 1;
let counter = 0;
var legacy = 2;
export namespace Shapes { }
declare function ambient(): void;
export abstract class Base { abstract run(): void }
const expr = function named() {};
function* gen() {}
"#;
        assert_eq!(
            kinds("typescript", "ts", source),
            named(&[
                ("function", "run"),
                ("class", "Store"),
                ("method", "read"),
                ("interface", "Options"),
                ("type", "Handler"),
                ("enum", "Mode"),
                ("variable", "LIMIT"),
                ("variable", "counter"),
                ("variable", "legacy"),
                ("namespace", "Shapes"),
                ("function", "ambient"),
                ("class", "Base"),
                // `abstract run(): void` is a bodyless method DECLARATION.
                ("method", "run"),
                ("variable", "expr"),
                // A named function EXPRESSION is a symbol; `function* gen()`
                // is a `generator_function_declaration`, which the pre-Stage-2
                // query did not match either.
                ("function", "named"),
            ])
        );
    }

    #[test]
    fn javascript_reports_nested_declarations() {
        let source = r#"
export function outer() {
  function inner() {}
  class Nested { run() {} }
  return new Nested();
}
const store = { method() {} };
"#;
        assert_eq!(
            kinds("javascript", "js", source),
            named(&[
                ("function", "outer"),
                ("function", "inner"),
                ("class", "Nested"),
                ("method", "run"),
                ("variable", "store"),
                ("method", "method"),
            ])
        );
    }

    #[test]
    fn python_methods_are_functions() {
        let source = "class Store:\n    def read(self):\n        def inner():\n            pass\n        return inner\n\ndef top():\n    pass\n";
        assert_eq!(
            kinds("python", "py", source),
            named(&[
                ("class", "Store"),
                ("function", "read"),
                ("function", "inner"),
                ("function", "top"),
            ])
        );
    }

    #[test]
    fn go_reports_one_symbol_per_type_spec() {
        let source = "package p\n\ntype (\n\tA struct{}\n\tB int\n)\n\ntype C interface{}\n\nfunc F() {}\n\nfunc (a A) M() {}\n";
        assert_eq!(
            kinds("go", "go", source),
            named(&[
                ("type", "A"),
                ("type", "B"),
                ("type", "C"),
                ("function", "F"),
                ("method", "M"),
            ])
        );
    }

    #[test]
    fn rust_keeps_the_full_declaration_vocabulary() {
        let source = r#"
pub const LIMIT: usize = 1;
static REG: u8 = 0;
pub type Pairs = u8;
pub struct S { f: u8 }
pub enum E { A }
pub trait T { fn t(&self); }
impl S { pub fn new() -> Self { fn helper() {} helper(); Self { f: 0 } } }
mod inner { pub fn nested() {} }
macro_rules! shout { () => {} }
"#;
        assert_eq!(
            kinds("rust", "rs", source),
            named(&[
                ("constant", "LIMIT"),
                ("variable", "REG"),
                ("type", "Pairs"),
                ("struct", "S"),
                ("enum", "E"),
                ("trait", "T"),
                // A trait method signature is a `function`, like a trait
                // method WITH a body.
                ("function", "t"),
                ("function", "new"),
                ("function", "helper"),
                ("module", "inner"),
                ("function", "nested"),
                ("macro", "shout"),
            ])
        );
    }

    #[test]
    fn jvm_and_dotnet_kinds() {
        let java = "package p;\npublic class C {\n  C() {}\n  void m() {}\n  interface I { void i(); }\n  enum E { A }\n  record R(int a) { int r() { return a; } }\n}\n";
        assert_eq!(
            kinds("java", "java", java),
            named(&[
                ("class", "C"),
                ("constructor", "C"),
                ("method", "m"),
                ("interface", "I"),
                ("method", "i"),
                ("enum", "E"),
                // a java record IS a class
                ("class", "R"),
                ("method", "r"),
            ])
        );

        let kotlin =
            "class C {\n  fun m() {}\n}\ninterface I\nenum class E { A }\nobject O\nfun top() {}\n";
        assert_eq!(
            kinds("kotlin", "kt", kotlin),
            named(&[
                ("class", "C"),
                ("function", "m"),
                ("class", "I"),
                ("class", "E"),
                // a kotlin `object` declares a type with members
                ("class", "O"),
                ("function", "top"),
            ])
        );

        let csharp = "class C {\n  C() {}\n  void M() { void Local() {} Local(); }\n}\ninterface I {}\nstruct S {}\nenum E { A }\nrecord R(int A);\n";
        assert_eq!(
            kinds("csharp", "cs", csharp),
            named(&[
                ("class", "C"),
                ("constructor", "C"),
                ("method", "M"),
                ("function", "Local"),
                ("interface", "I"),
                ("struct", "S"),
                ("enum", "E"),
                ("class", "R"),
            ])
        );
    }

    #[test]
    fn c_family_kinds() {
        let c = "struct S { int a; };\nenum E { A };\nint f(void) { return 0; }\nchar *g(void) { return 0; }\n";
        assert_eq!(
            kinds("c", "c", c),
            named(&[
                ("struct", "S"),
                ("enum", "E"),
                ("function", "f"),
                ("function", "g"),
            ])
        );

        let cpp = "class C { public: void m() {} };\nstruct S {};\nvoid C::out() {}\nint *p() { return 0; }\n";
        assert_eq!(
            kinds("cpp", "cpp", cpp),
            named(&[
                ("class", "C"),
                ("method", "m"),
                ("struct", "S"),
                ("function", "out"),
                ("function", "p"),
            ])
        );

        let objc = "@protocol P\n- (void)p;\n@end\n@interface A : NSObject\n- (void)a;\n@end\n@implementation A\n- (void)a {}\n@end\nint f(void) { return 0; }\n";
        assert_eq!(
            kinds("objc", "m", objc),
            named(&[
                ("protocol", "P"),
                ("method", "p"),
                ("class", "A"),
                // declaration in @interface, definition in @implementation
                ("method", "a"),
                ("class", "A"),
                ("method", "a"),
                ("function", "f"),
            ])
        );
    }

    #[test]
    fn script_and_functional_kinds() {
        assert_eq!(
            kinds("ruby", "rb", "module M\n  class C\n    def m; end\n    def self.s; end\n  end\nend\ndef top; end\n"),
            named(&[
                ("module", "M"),
                ("class", "C"),
                ("method", "m"),
                ("method", "s"),
                ("method", "top"),
            ])
        );

        assert_eq!(
            kinds("php", "php", "<?php\ninterface I {}\ntrait T {}\nenum E { case A; public function l(): string { return 'a'; } }\nclass C { public function m() {} }\nfunction f() {}\n"),
            named(&[
                ("interface", "I"),
                ("trait", "T"),
                ("enum", "E"),
                ("method", "l"),
                ("class", "C"),
                ("method", "m"),
                ("function", "f"),
            ])
        );

        assert_eq!(
            kinds("swift", "swift", "protocol P {}\nstruct S {}\nenum E {}\nclass C { func m() {} }\nactor A {}\nfunc top() {}\n"),
            named(&[
                ("protocol", "P"),
                ("struct", "S"),
                ("enum", "E"),
                ("class", "C"),
                ("function", "m"),
                // a swift actor is a reference type with methods
                ("class", "A"),
                ("function", "top"),
            ])
        );

        assert_eq!(
            kinds(
                "scala",
                "scala",
                "trait T\nclass C { def m(): Int = 1 }\nobject O { def o(): Int = 2 }\n"
            ),
            named(&[
                ("trait", "T"),
                ("class", "C"),
                ("function", "m"),
                ("class", "O"),
                ("function", "o"),
            ])
        );

        assert_eq!(
            kinds("bash", "sh", "f() { :; }\nfunction g() { :; }\n"),
            named(&[("function", "f"), ("function", "g")])
        );

        assert_eq!(
            kinds(
                "lua",
                "lua",
                "function f() end\nfunction M.g() end\nfunction M:h() end\n"
            ),
            named(&[("function", "f"), ("function", "g"), ("function", "h"),])
        );

        assert_eq!(
            kinds("r", "r", "f <- function(x) x\ng = function(x) x\n"),
            named(&[("function", "f"), ("function", "g")])
        );

        assert_eq!(
            kinds("dart", "dart", "class C { void m() {} }\nmixin M {}\nenum E { a }\nextension X on C {}\nvoid top() {}\n"),
            named(&[
                ("class", "C"),
                ("method", "m"),
                // dart: a mixin is a trait, an extension is an impl block
                ("trait", "M"),
                ("enum", "E"),
                ("impl", "X"),
                ("function", "top"),
            ])
        );

        assert_eq!(
            kinds("elixir", "ex", "defmodule M do\n  def f(a), do: a\n  defp g(a), do: a\n  defmacro h(a), do: a\nend\n"),
            named(&[
                ("module", "M"),
                ("function", "f"),
                ("function", "g"),
                ("macro", "h"),
            ])
        );

        assert_eq!(
            kinds("zig", "zig", "pub const S = struct { pub fn f() void {} };\nconst E = enum { a };\nconst U = union { a: u8 };\npub fn top() void {}\n"),
            named(&[
                ("struct", "S"),
                ("function", "f"),
                ("enum", "E"),
                // zig union: a container type with declared fields
                ("struct", "U"),
                ("function", "top"),
            ])
        );
    }

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

    /// The name line is no longer a record field (v2 dropped it), but it is
    /// still the key that deduplicates two rules matching one declaration, so
    /// a name on a later line than the declaration start must still resolve.
    #[test]
    fn name_line_follows_a_multiline_signature() {
        let source = "static void\nlate_name(void) {\n}\n";
        assert_eq!(name_line(source, 0, source.len(), 1, "late_name"), 2);
        let extracted = extract(source, "c", scan_lang_for_ext("c").unwrap());
        let symbol = &extracted.symbols[0];
        assert_eq!((symbol.name.as_str(), symbol.start_line), ("late_name", 1));
    }

    #[test]
    fn import_specs_keep_the_resolver_contract() {
        assert_eq!(
            imports(
                "javascript",
                "js",
                "import a from './a.js';\nexport { b } from './b.js';\nconst c = require('node:fs');\nconst d = await import('./d.js');\n"
            ),
            vec!["./a.js", "./b.js", "node:fs", "./d.js"]
        );
        assert_eq!(
            imports(
                "python",
                "py",
                "from __future__ import annotations\nimport os, sys\nimport a.b.c as abc\nfrom pkg.sub import thing\nfrom .rel import other\n"
            ),
            vec!["__future__", "os", "sys", "a.b.c", "pkg.sub", ".rel"]
        );
        assert_eq!(
            imports(
                "go",
                "go",
                "package p\nimport \"fmt\"\nimport (\n\t\"errors\"\n)\n"
            ),
            vec!["fmt", "errors"]
        );
        assert_eq!(
            imports(
                "rust",
                "rs",
                "use std::fmt;\npub use crate::api::X;\nmod helpers;\nmod inline { }\n"
            ),
            vec!["std::fmt", "mod::helpers"]
        );
        assert_eq!(
            imports(
                "java",
                "java",
                "import static java.util.Collections.emptyList;\nimport java.util.List;\n"
            ),
            vec!["static java.util.Collections.emptyList", "java.util.List"]
        );
        assert_eq!(
            imports("kotlin", "kt", "import a.b.C as D\nimport a.b.E\n"),
            vec!["a.b.C as D", "a.b.E"]
        );
        assert_eq!(
            imports("csharp", "cs", "using System;\nusing static System.Math;\nusing Alias = System.Text.StringBuilder;\n"),
            vec!["System", "static System.Math", "Alias = System.Text.StringBuilder"]
        );
        assert_eq!(
            imports(
                "c",
                "c",
                "#include <stdio.h>\n#include \"local.h\"\n#include MACRO\n"
            ),
            vec!["stdio.h", "local.h"]
        );
        assert_eq!(
            imports("ruby", "rb", "require 'json'\nrequire_relative 'helper'\n"),
            vec!["json", "helper"]
        );
        assert_eq!(
            imports(
                "php",
                "php",
                "<?php\nuse App\\User;\nuse App\\{Post, Comment};\nrequire 'helpers.php';\n"
            ),
            vec!["App\\User", "App\\Post", "App\\Comment", "helpers.php"]
        );
        assert_eq!(
            imports(
                "swift",
                "swift",
                "import Foundation\nimport class UIKit.UIView\n"
            ),
            vec!["Foundation", "UIKit.UIView"]
        );
        assert_eq!(
            imports(
                "scala",
                "scala",
                "import a.b.C\nimport a.b.{D, E}\nimport a.b._\n"
            ),
            vec!["a.b.C", "a.b"]
        );
        assert_eq!(
            imports("bash", "sh", "source ./lib/a.sh\n. ./lib/b.sh\n"),
            vec!["./lib/a.sh", "./lib/b.sh"]
        );
        assert_eq!(
            imports(
                "lua",
                "lua",
                "local a = require('x.y')\nlocal b = require \"z\"\n"
            ),
            vec!["x.y", "z"]
        );
        assert_eq!(
            imports(
                "dart",
                "dart",
                "import 'package:m/a.dart';\nexport 'b.dart';\npart 'c.dart';\n"
            ),
            vec!["package:m/a.dart", "b.dart", "c.dart"]
        );
        assert_eq!(
            imports(
                "objc",
                "m",
                "#import <Foundation/Foundation.h>\n#import \"Store.h\"\n@import UIKit;\n"
            ),
            vec!["Foundation/Foundation.h", "Store.h", "UIKit"]
        );
        assert_eq!(
            imports(
                "elixir",
                "ex",
                "defmodule M do\n  alias A.B\n  alias A.{C, D}\n  import E\nend\n"
            ),
            vec!["A.B", "A.C", "A.D", "E"]
        );
        assert_eq!(
            imports(
                "zig",
                "zig",
                "const std = @import(\"std\");\nconst h = @import(\"./h.zig\");\n"
            ),
            vec!["std", "./h.zig"]
        );
        assert_eq!(
            imports(
                "r",
                "r",
                "library(dplyr)\nrequire(\"stringr\")\nsource(\"./h.R\")\n"
            ),
            vec!["dplyr", "stringr", "./h.R"]
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
    fn a_rule_that_cannot_compile_is_reported_not_dropped() {
        let lang = scan_lang_for_ext("ts").unwrap();
        let mut rules = Vec::new();
        let mut kinds = HashMap::new();
        let mut errors = Vec::new();
        // `no_such_node_kind` is not in the TypeScript grammar, and the
        // regex-only rule has no node kind for the walk to index on.
        parse_rule_stream(
            "id: broken-kind\nlanguage: TypeScript\nrole: item\nsymbolType: class\nrule:\n  kind: no_such_node_kind\n  has:\n    field: name\n    pattern: $NAME\nname: $NAME\n\
             ---\nid: unindexable\nlanguage: TypeScript\nrole: item\nsymbolType: function\nrule:\n  any:\n    - kind: function_declaration\n    - regex: '^handler$'\nname: handler\n\
             ---\nid: works\nlanguage: TypeScript\nrole: item\nsymbolType: class\nrule:\n  kind: class_declaration\n  has:\n    field: name\n    pattern: $NAME\nname: $NAME\n",
            "test.yml",
            &mut rules,
            &mut kinds,
            &mut errors,
        );
        assert!(errors.is_empty(), "documents parse: {errors:?}");
        let compiled = LangExtractors::compile(lang, &rules, &kinds);
        // The healthy rule still runs …
        assert_eq!(compiled.items.len(), 1, "{:?}", compiled.errors);
        assert!(!compiled.is_empty());
        // … and both unusable rules are named in the diagnostics: the unknown
        // node kind, and the rule ast-grep cannot reduce to a set of kinds
        // (which is exactly the rule shape the kind-indexed walk cannot reach).
        let reported = compiled.errors.join("\n");
        assert!(
            reported.contains("broken-kind") && reported.contains("unindexable"),
            "both broken rules must be reported: {reported}"
        );
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

    /// Full v2 records, in emission order.
    fn records(graph_lang: &str, ext: &str, source: &str) -> Vec<SymbolInfo> {
        let lang = scan_lang_for_ext(ext).expect("fixture extension has a language");
        extract(source, graph_lang, lang).symbols
    }

    fn record<'a>(symbols: &'a [SymbolInfo], name: &str) -> &'a SymbolInfo {
        symbols
            .iter()
            .find(|symbol| symbol.name == name)
            .unwrap_or_else(|| panic!("no symbol `{name}` in {symbols:?}"))
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

    fn tokens(graph_lang: &str, ext: &str, source: &str) -> Vec<String> {
        let lang = scan_lang_for_ext(ext).expect("fixture extension has a language");
        extract(source, graph_lang, lang).tokens
    }

    /// An identifier that the grammar does not spell as a plain leaf is still
    /// an identifier occurrence, and the token list is the file's candidate
    /// index — so every one of these has to be in it.
    #[test]
    fn tokens_cover_identifiers_the_grammar_does_not_spell_as_leaves() {
        let has = |list: &[String], name: &str| list.iter().any(|token| token == name);

        // Kotlin soft keywords are identifier nodes wrapping ONE anonymous
        // token: `value`, `expect` and friends are ordinary names here.
        let kotlin = tokens(
            "kotlin",
            "kt",
            "class Holder {\n  fun nested(value: String) = value.trim()\n  data class Pair2(val expect: Int, val actual: Int)\n}\n",
        );
        for name in ["value", "expect", "actual", "Pair2", "nested"] {
            assert!(
                has(&kotlin, name),
                "kotlin tokens miss `{name}`: {kotlin:?}"
            );
        }

        // A ruby symbol literal NAMES a declaration (`attr_accessor :label`,
        // `send(:run)`), so it is a mention of that name.
        let ruby = tokens(
            "ruby",
            "rb",
            "class Holder\n  attr_accessor :label\n  def run\n    send(:run)\n    { key_sym: 1 }\n  end\nend\n",
        );
        for name in ["label", "run", "key_sym"] {
            assert!(has(&ruby, name), "ruby tokens miss `{name}`: {ruby:?}");
        }

        // Elixir atoms are the same construct.
        let elixir = tokens(
            "elixir",
            "ex",
            "defmodule Holder do\n  def run(arg), do: apply(Mod, :callable, [arg, :tagged])\nend\n",
        );
        for name in ["callable", "tagged"] {
            assert!(
                has(&elixir, name),
                "elixir tokens miss `{name}`: {elixir:?}"
            );
        }

        // PHP spells the sigil form as a parent of the bare `name`, and a PHP
        // reference search asks for `$count`; both forms are carried.
        let php = tokens(
            "php",
            "php",
            "<?php\nclass Holder {\n  public $count = 0;\n  function bump($step) { return $this->count + $step; }\n}\n",
        );
        for name in ["$count", "count", "$step", "step", "bump"] {
            assert!(has(&php, name), "php tokens miss `{name}`: {php:?}");
        }

        // …and a comment or a string body is still not a mention.
        let ts = tokens(
            "typescript",
            "ts",
            "// commentOnly\nconst label = 'stringOnly';\nconst t = `${interpolated}`;\n",
        );
        assert!(has(&ts, "interpolated"), "{ts:?}");
        assert!(!has(&ts, "commentOnly"), "{ts:?}");
        assert!(!has(&ts, "stringOnly"), "{ts:?}");
    }

    #[test]
    fn exported_follows_each_language_visibility_rule() {
        let ts = records(
            "typescript",
            "ts",
            "export function shown(): void {}\nfunction hidden(): void {}\nexport class Panel { method(): void {} }\nconst local = 1;\nexport const shared = 2;\n",
        );
        assert!(record(&ts, "shown").exported);
        assert!(!record(&ts, "hidden").exported);
        assert!(record(&ts, "Panel").exported);
        // a class member is not an export of its own
        assert!(!record(&ts, "method").exported);
        assert!(!record(&ts, "local").exported);
        assert!(record(&ts, "shared").exported);

        let python = records(
            "python",
            "py",
            "def public_one():\n    pass\n\ndef _private():\n    pass\n\nclass Service:\n    def method(self):\n        pass\n",
        );
        assert!(record(&python, "public_one").exported);
        assert!(!record(&python, "_private").exported);
        assert!(record(&python, "Service").exported);
        // module level only: a method is not a module export
        assert!(!record(&python, "method").exported);

        let rust = records(
            "rust",
            "rs",
            "pub fn shown() {}\nfn hidden() {}\npub(crate) struct Crated;\nconst LOCAL: u8 = 1;\npub const SHARED: u8 = 2;\n",
        );
        assert!(record(&rust, "shown").exported);
        assert!(!record(&rust, "hidden").exported);
        assert!(record(&rust, "Crated").exported);
        assert!(!record(&rust, "LOCAL").exported);
        assert!(record(&rust, "SHARED").exported);

        let go = records(
            "go",
            "go",
            "package p\n\nfunc Exported() {}\n\nfunc unexported() {}\n\ntype Public struct{}\n\ntype private struct{}\n",
        );
        assert!(record(&go, "Exported").exported);
        assert!(!record(&go, "unexported").exported);
        assert!(record(&go, "Public").exported);
        assert!(!record(&go, "private").exported);

        // Languages without any visibility syntax report every symbol.
        let bash = records("bash", "sh", "helper() { :; }\n");
        assert!(record(&bash, "helper").exported);

        // Ruby's `private` section hides what follows it, inside the class.
        let ruby = records(
            "ruby",
            "rb",
            "class Store\n  def open; end\n\n  private\n\n  def secret; end\nend\n",
        );
        assert!(record(&ruby, "open").exported);
        assert!(!record(&ruby, "secret").exported);

        // Haskell: the export list decides, and the header itself always goes.
        let haskell = records(
            "haskell",
            "hs",
            "module Demo (shown) where\n\nshown :: Int\nshown = 1\n\nhidden :: Int\nhidden = 2\n",
        );
        assert!(record(&haskell, "Demo").exported);
        assert!(record(&haskell, "shown").exported);
        assert!(!record(&haskell, "hidden").exported);
        let open = records(
            "haskell",
            "hs",
            "module Demo where\n\nshown :: Int\nshown = 1\n",
        );
        assert!(record(&open, "shown").exported);

        // C: a `static` function is file-local.
        let c = records(
            "c",
            "c",
            "int shared(void) { return 0; }\nstatic int local(void) { return 0; }\n",
        );
        assert!(record(&c, "shared").exported);
        assert!(!record(&c, "local").exported);

        // Elixir: `defp` is private, `def` is not.
        let elixir = records(
            "elixir",
            "ex",
            "defmodule M do\n  def shown(a), do: a\n  defp hidden(a), do: a\n  defmacrop quiet(a), do: a\nend\n",
        );
        assert!(record(&elixir, "shown").exported);
        assert!(!record(&elixir, "hidden").exported);
        assert!(!record(&elixir, "quiet").exported);

        // Solidity: a function needs `public`/`external`.
        let solidity = records(
            "solidity",
            "sol",
            "contract C {\n  function open() external {}\n  function shut() private {}\n}\n",
        );
        assert!(record(&solidity, "C").exported);
        assert!(record(&solidity, "open").exported);
        assert!(!record(&solidity, "shut").exported);
    }

    /// The statements a FILE makes about a declaration — a TS export clause,
    /// a Ruby section, a Rust attribute — and the one thing no statement can
    /// lift: a declaration that lives inside a function body.
    #[test]
    fn exported_reads_file_level_statements_and_never_lifts_a_local() {
        let clause = records(
            "typescript",
            "ts",
            "const alpha = 1;\nfunction beta() {}\nclass Panel {}\ntype Shape = { a: number };\nconst hidden = 2;\nexport { alpha, beta as bee, type Shape };\nexport default Panel;\nexport { elsewhere } from \"./other.js\";\n",
        );
        assert!(record(&clause, "alpha").exported);
        assert!(
            record(&clause, "beta").exported,
            "`beta as bee` exports beta"
        );
        assert!(record(&clause, "Shape").exported);
        assert!(
            record(&clause, "Panel").exported,
            "`export default X` exports X"
        );
        assert!(!record(&clause, "hidden").exported);

        // A declaration inside a function body is local, whatever it says.
        let kotlin = records(
            "kotlin",
            "kt",
            "class Holder {\n    fun visible(): Int {\n        fun localHelper(y: Int) = y\n        return localHelper(1)\n    }\n}\n",
        );
        assert!(record(&kotlin, "visible").exported);
        assert!(!record(&kotlin, "localHelper").exported);
        let rust = records(
            "rust",
            "rs",
            "pub fn outer() {\n    pub fn nested() {}\n}\n#[macro_export]\nmacro_rules! shout { () => {}; }\nmacro_rules! quiet { () => {}; }\n",
        );
        assert!(record(&rust, "outer").exported);
        assert!(
            !record(&rust, "nested").exported,
            "a `pub fn` in a body is unreachable"
        );
        assert!(record(&rust, "shout").exported, "#[macro_export]");
        assert!(!record(&rust, "quiet").exported);

        // A Ruby section belongs to the body it stands in: reopening a class
        // and leaving the class body both end its reach.
        let ruby = records(
            "ruby",
            "rb",
            "class First\n  private\n\n  def hidden; end\nend\n\nclass Second\n  def visible; end\n\n  class Nested\n    def deep; end\n  end\nend\n\ndef top_level; end\n",
        );
        assert!(!record(&ruby, "hidden").exported);
        assert!(record(&ruby, "Second").exported);
        assert!(record(&ruby, "visible").exported);
        assert!(record(&ruby, "deep").exported);
        assert!(record(&ruby, "top_level").exported);

        // A Solidity free function carries no visibility modifier at all and
        // is importable; Lua's `local function` is its file-private form.
        let solidity = records(
            "solidity",
            "sol",
            "contract C {\n  function shut() private {}\n}\nfunction free(uint256 a) pure returns (uint256) { return a; }\n",
        );
        assert!(record(&solidity, "free").exported);
        assert!(!record(&solidity, "shut").exported);
        let lua = records(
            "lua",
            "lua",
            "function open(a)\n  return a\nend\n\nlocal function shut(a)\n  return a\nend\n",
        );
        assert!(record(&lua, "open").exported);
        assert!(!record(&lua, "shut").exported);
    }

    #[test]
    fn sig_keeps_generic_defaults_and_function_initializers() {
        let ts = records(
            "typescript",
            "ts",
            "export function gen<T = string, U extends keyof T = keyof T>(v: T): U | undefined {\n  return undefined;\n}\nexport type Alias<T = number> = { a: T };\nexport const arrow = (a: string, b: number): boolean => a.length > b;\nexport const wrapped = async (x: number) => x + 1;\nexport const made = function named(a: number) { return a; };\nexport const value = { a: 1 };\n",
        );
        // A generic default is part of the signature, not an initializer.
        assert_eq!(
            record(&ts, "gen").sig,
            "function gen<T = string, U extends keyof T = keyof T>(v: T): U | undefined"
        );
        assert_eq!(record(&ts, "Alias").sig, "type Alias<T = number>");
        // A function-valued binding reports the callable it declares …
        assert_eq!(
            record(&ts, "arrow").sig,
            "arrow = (a: string, b: number): boolean =>"
        );
        assert_eq!(record(&ts, "wrapped").sig, "wrapped = async (x: number) =>");
        assert_eq!(record(&ts, "made").sig, "made = function named(a: number)");
        // … while a value initializer still ends the head at the `=`, which
        // leaves the bare name, i.e. no signature at all.
        assert_eq!(record(&ts, "value").sig, "");

        let rust = records(
            "rust",
            "rs",
            "pub struct Wrapper<T = String> { inner: T }\n",
        );
        assert_eq!(
            record(&rust, "Wrapper").sig,
            "pub struct Wrapper<T = String>"
        );

        // The `=` of a Ruby setter is part of the NAME, so it cannot cut …
        let ruby = records(
            "ruby",
            "rb",
            "class Store\n  def name=(value); @name = value; end\nend\n",
        );
        assert_eq!(record(&ruby, "name=").sig, "def name=(value)");
        // … and `class Child < Parent` is a superclass, not a type argument
        // list that would swallow the rest of the head.
        let ruby_super = records("ruby", "rb", "class Child < Parent\n  def go; end\nend\n");
        assert_eq!(record(&ruby_super, "Child").sig, "class Child < Parent");

        // Kotlin's `=` opens an expression BODY: cutting there is right.
        let kotlin = records(
            "kotlin",
            "kt",
            "fun expressionBody(a: Int, b: Int) = a + b\n",
        );
        assert_eq!(
            record(&kotlin, "expressionBody").sig,
            "fun expressionBody(a: Int, b: Int)"
        );
        // R assigns its functions with `<-` or `=`; both keep the parameters.
        let r = records("r", "r", "add = function(a, b) {\n  a + b\n}\n");
        assert_eq!(record(&r, "add").sig, "add = function(a, b)");
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

    #[test]
    fn sig_is_the_declaration_head_on_one_line() {
        let ts = records(
            "typescript",
            "ts",
            "export function resolve(\n  input: string,\n  base: string,\n): string {\n  return input;\n}\nexport const limit: number = 4;\nexport const plain = 5;\n",
        );
        // The multi-line signature collapses; the body is not part of it.
        assert_eq!(
            record(&ts, "resolve").sig,
            "function resolve( input: string, base: string, ): string"
        );
        // A binding keeps its type annotation and drops the value …
        assert_eq!(record(&ts, "limit").sig, "limit: number");
        // … and a binding with neither is just its name, so there is no sig.
        assert_eq!(record(&ts, "plain").sig, "");

        // Python cuts at the `:` that opens the block, not at an annotation.
        let python = records(
            "python",
            "py",
            "def read(path: str) -> bytes:\n    return b''\n\nclass Store:\n    pass\n",
        );
        assert_eq!(record(&python, "read").sig, "def read(path: str) -> bytes");
        assert_eq!(record(&python, "Store").sig, "class Store");

        // Rust keeps the whole head including generics and the return type.
        let rust = records("rust", "rs", "pub fn run<R: Read>(input: &mut R) -> Result<()> {\n    Ok(())\n}\npub const LIMIT: usize = 1;\n");
        assert_eq!(
            record(&rust, "run").sig,
            "pub fn run<R: Read>(input: &mut R) -> Result<()>"
        );
        assert_eq!(record(&rust, "LIMIT").sig, "pub const LIMIT: usize");

        // A keyword-delimited body ends the head at the newline after the name.
        let lua = records("lua", "lua", "function greet(name)\n  return name\nend\n");
        assert_eq!(record(&lua, "greet").sig, "function greet(name)");

        // Go's type spec head is the spec, not the body.
        let go = records(
            "go",
            "go",
            "package p\n\ntype Store struct {\n\tname string\n}\n",
        );
        assert_eq!(record(&go, "Store").sig, "Store struct");
    }

    #[test]
    fn sig_truncates_at_a_character_boundary() {
        // 200 multi-byte characters in the parameter name: the cut must land
        // on a character, never inside one of the 3-byte sequences.
        let wide = "각".repeat(200);
        let source = format!("function run(\n  {wide}: string,\n) {{\n  return 1;\n}}\n");
        let symbols = records("typescript", "ts", &source);
        let sig = &record(&symbols, "run").sig;
        assert!(sig.ends_with('…'), "{sig}");
        assert_eq!(sig.chars().count(), SIG_MAX_CHARS + 1);
        // A round trip through the string type proves the boundary held.
        assert_eq!(String::from_utf8(sig.as_bytes().to_vec()).unwrap(), *sig);
        assert!(sig.starts_with("function run( 각각각"));

        // A head exactly at the cap keeps every character and no marker.
        let name = "a".repeat(SIG_MAX_CHARS - "function ()".len());
        let exact = format!("function {name}() {{}}\n");
        let symbols = records("typescript", "ts", &exact);
        let sig = &record(&symbols, &name).sig;
        assert_eq!(sig.chars().count(), SIG_MAX_CHARS);
        assert!(!sig.ends_with('…'));
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

    /// Every language that can declare a method WITHOUT a body reports it:
    /// an interface/protocol/trait requirement is the only declaration of that
    /// name, and it keeps the kind that language gives a method with a body.
    #[test]
    fn bodyless_method_declarations_are_symbols() {
        let ts = records(
            "typescript",
            "ts",
            "export interface Host {\n  preflightSteps?(cmd: string): Promise<void>;\n  flag: boolean;\n}\ntype Lit = { onTick(n: number): void; value: number };\nabstract class Base { abstract doIt(): void; }\n",
        );
        assert_eq!(
            ts.iter()
                .map(|symbol| (symbol.kind, symbol.name.as_str(), symbol.parent.as_str()))
                .collect::<Vec<_>>(),
            vec![
                ("interface", "Host", ""),
                ("method", "preflightSteps", "Host"),
                ("type", "Lit", ""),
                ("method", "onTick", "Lit"),
                ("class", "Base", ""),
                ("method", "doIt", "Base"),
            ]
        );
        assert_eq!(
            record(&ts, "preflightSteps").sig,
            "preflightSteps?(cmd: string): Promise<void>"
        );

        // A signature declared in one language keeps that language's own kind
        // for methods: go/dart/objc/java/csharp/php `method`, rust/scala/
        // swift/kotlin/haskell/solidity `function`.
        let cases: &[(&str, &str, &str, &str, &str)] = &[
            (
                "go",
                "go",
                "package p\ntype Reader interface {\n\tRead(p []byte) (int, error)\n}\n",
                "method",
                "Read",
            ),
            (
                "rust",
                "rs",
                "pub trait Handler {\n    fn handle(&self) -> bool;\n}\n",
                "function",
                "handle",
            ),
            (
                "swift",
                "swift",
                "protocol Service {\n    func start()\n}\n",
                "function",
                "start",
            ),
            (
                "dart",
                "dart",
                "abstract class Service {\n  void start();\n}\n",
                "method",
                "start",
            ),
            (
                "scala",
                "scala",
                "trait Service {\n  def start(): Unit\n}\n",
                "function",
                "start",
            ),
            (
                "java",
                "java",
                "public interface Service {\n  void start();\n}\n",
                "method",
                "start",
            ),
            (
                "csharp",
                "cs",
                "public interface IService {\n  void Start();\n}\n",
                "method",
                "Start",
            ),
            (
                "kotlin",
                "kt",
                "interface Service {\n    fun start()\n}\n",
                "function",
                "start",
            ),
            (
                "php",
                "php",
                "<?php\ninterface Service {\n  public function start();\n}\n",
                "method",
                "start",
            ),
            (
                "objc",
                "m",
                "@protocol Service <NSObject>\n- (void)start;\n@end\n",
                "method",
                "start",
            ),
            (
                "solidity",
                "sol",
                "interface IService {\n    function start() external;\n}\n",
                "function",
                "start",
            ),
            (
                "haskell",
                "hs",
                "module M where\nclass Service a where\n  start :: a -> IO ()\n",
                "function",
                "start",
            ),
        ];
        for (graph_lang, ext, source, kind, name) in cases {
            let symbols = records(graph_lang, ext, source);
            let found = record(&symbols, name);
            assert_eq!(found.kind, intern_kind(kind), "{graph_lang}: {symbols:?}");
            assert!(!found.parent.is_empty(), "{graph_lang}: {symbols:?}");
            assert!(!found.sig.is_empty(), "{graph_lang}: {symbols:?}");
        }

        // A bodied declaration of the same language keeps its span and kind:
        // the signature rules add symbols, they do not take one over.
        let dart = records(
            "dart",
            "dart",
            "abstract class Service {\n  void start();\n  void stop() {}\n}\n",
        );
        let stop = record(&dart, "stop");
        assert_eq!(
            (stop.kind, stop.start_line, stop.end_line),
            ("method", 3, 3)
        );
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

fn outline_json(items: &[WalkedItem<'_>]) -> Vec<ItemJson> {
    let mut out: Vec<ItemJson> = items
        .iter()
        .map(|walked| {
            let item = &walked.item;
            let mut members: Vec<&ast_grep_outline::model::OutlineMember<'_>> =
                item.members.iter().collect();
            members.sort_by_key(|member| member.entry.range.byte_offset.start);
            ItemJson {
                symbol_type: item.entry.symbol_type,
                name: item.entry.name.to_string(),
                range: RangeJson {
                    start: PositionJson {
                        line: item.entry.range.start.line,
                        column: item.entry.range.start.column,
                    },
                    end: PositionJson {
                        line: item.entry.range.end.line,
                        column: item.entry.range.end.column,
                    },
                    byte_offset: [
                        item.entry.range.byte_offset.start,
                        item.entry.range.byte_offset.end,
                    ],
                },
                is_import: item.is_import,
                is_exported: item.is_exported,
                members: members
                    .into_iter()
                    .map(|member| MemberJson {
                        symbol_type: member.entry.symbol_type,
                        name: member.entry.name.to_string(),
                        is_public: member.is_public,
                    })
                    .collect(),
            }
        })
        .collect();
    out.sort_by_key(|item| item.range.byte_offset[0]);
    out
}
