// Compiling one language's rules, and the single traversal that applies them.
//
// The walk contract — every node is visited, item rules are indexed by node
// kind, member rules are tried inside their owning item, and the descent never
// stops — is described in the TRAVERSAL section of `src/outline.rs`. Symbols,
// import edges, call sites, identifier tokens and the file-level
// package/namespace metadata all come out of this one pass.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, LazyLock, RwLock};

use ast_grep_config::GlobalRules;
use ast_grep_core::tree_sitter::StrDoc;
use ast_grep_core::{Matcher, Node};
use ast_grep_outline::extractor::{ItemExtractor, MemberExtractor, SerializableOutlineRule};
use ast_grep_outline::model::OutlineItem;
use ast_grep_outline::options::{
    OutlineEntryDetail, OutlineExtractorOptions, OutlineMemberOptions,
};

use super::rules::{DeclaredKind, RULES};
use crate::scan_lang::ScanLang;
use crate::tokens::{GrammarKinds, KindRole, MetaField};

/// One matched item with the rule-declared kinds resolved alongside it.
pub struct WalkedItem<'t> {
    pub item: OutlineItem<'t>,
    pub(super) declared: Option<DeclaredKind>,
    /// Parallel to `item.members`.
    pub(super) member_declared: Vec<Option<DeclaredKind>>,
}

/// Member rule indices by node kind id, one map per member scope.
type MemberScopes = Vec<HashMap<u16, Vec<usize>>>;

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
    member_scopes: MemberScopes,
    member_kinds: Vec<Option<DeclaredKind>>,
    /// Call rules of this language, applied by the same walk so a file is
    /// parsed and traversed exactly once for symbols, imports and calls.
    calls: Arc<crate::calls::CallExtractors>,
    /// Grammar-derived node-kind roles: which kinds are identifier tokens and
    /// which are the package/namespace declaration of this language.
    kinds: Arc<GrammarKinds>,
    /// Rules of this language that parsed but cannot run.
    pub(super) errors: Vec<String>,
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
    pub(super) package: Option<(usize, String)>,
    pub(super) namespace: Option<(usize, String)>,
    pub(super) go_package: Option<(usize, String)>,
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

    pub(super) fn take(slot: Option<(usize, String)>) -> String {
        slot.map(|(_, name)| name).unwrap_or_default()
    }
}

/// Item rules indexed by the node kinds they can match, in rule order: the
/// walk looks one node kind up here instead of trying every rule.
fn index_items_by_kind(
    lang: ScanLang,
    items: &[ItemExtractor<ScanLang>],
    errors: &mut Vec<String>,
) -> Vec<Vec<usize>> {
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
    item_by_kind
}

/// Member rules grouped into one scope per item rule id they attach to, with
/// the map from that rule id to its scope the items then point at. The scope
/// keys borrow `member_parents`, which outlives the returned map.
fn index_member_scopes<'a>(
    lang: ScanLang,
    members: &[MemberExtractor<ScanLang>],
    member_parents: &'a [Vec<String>],
    errors: &mut Vec<String>,
) -> (MemberScopes, HashMap<&'a str, usize>) {
    let mut scope_by_parent: HashMap<&'a str, usize> = HashMap::new();
    let mut member_scopes: MemberScopes = Vec::new();
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
                    scope_by_parent.insert(parent.as_str(), scope);
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
    (member_scopes, scope_by_parent)
}

impl LangExtractors {
    pub(super) fn compile(
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

        let item_by_kind = index_items_by_kind(lang, &items, &mut errors);
        let (member_scopes, scope_by_parent) =
            index_member_scopes(lang, &members, &member_parents, &mut errors);
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

    pub(super) fn is_empty(&self) -> bool {
        self.items.is_empty()
    }

    /// Identifier tokens and the file's package/namespace declaration from one
    /// visited node: they ride the same walk, one table lookup per node, with
    /// no second pass over the source.
    fn harvest_node<'t>(
        &self,
        node: &Node<'t, StrDoc<ScanLang>>,
        kind: u16,
        text: &'t str,
        tokens: &mut HashSet<&'t str>,
        meta: &mut FileMeta,
    ) {
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
                if let Some(name) = meta_name(node, text) {
                    meta.note(field, range.start, name);
                }
            }
        }
    }

    /// Item/member/call rules for one file, in rule order. `text` is the very
    /// source the tree was parsed from: node ranges index into it, so tokens
    /// and metadata are borrowed slices rather than copies.
    pub(super) fn extract<'t>(
        &self,
        root: Node<'t, StrDoc<ScanLang>>,
        text: &'t str,
    ) -> Walked<'t> {
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
            self.harvest_node(&node, kind, text, &mut tokens, &mut meta);
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::outline::rules::parse_rule_stream;
    use crate::outline::test_support::tokens;
    use crate::scan_lang::scan_lang_for_ext;

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
}
