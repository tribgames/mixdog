//! Usage queries: identifier references, AST call sites (callers, transitive callers) and
//! callees. Calls come from the parse tree only; a file without call data contributes none.

use std::collections::{HashMap, HashSet};

use mixdog_graph::calls::CallInfo;
use regex::Regex;

use super::exports::exposing_files;
use super::graph::{Graph, Node};
use super::hits::{callee_declaration, find_hits, occurrences};
use super::outline::{parent_index, symbol_path};
use super::util::{head_chars, identifier_occurrences, name_cmp};

const SELF_RECEIVERS: [&str; 7] = ["", "this", "self", "super", "Self", "cls", "me"];
const CONTAINER_KINDS: [&str; 10] = ["module", "namespace", "package", "class", "struct", "interface", "trait", "enum", "protocol", "impl"];
const FUNCTION_LIKE_KINDS: [&str; 3] = ["function", "method", "constructor"];

#[derive(Clone, Copy, Default)]
pub(super) struct Scope<'a> {
    pub file_rel: Option<&'a str>,
    pub prefix: Option<&'a str>,
}

impl Scope<'_> {
    pub fn contains(&self, rel: &str) -> bool {
        if let Some(file) = self.file_rel {
            return rel == file;
        }
        if let Some(prefix) = self.prefix {
            return rel == prefix.trim_end_matches('/') || rel.starts_with(prefix);
        }
        true
    }
}

impl<'a> Scope<'a> {
    /// The scope callers are searched in: `file_rel` only names where the symbol is declared.
    pub fn for_callers(self) -> Scope<'a> {
        Scope { file_rel: None, prefix: self.prefix }
    }
}

/// Mentions of `symbol` in the files that reach this file's declaration of it: its importers and
/// the re-export forwarders that carry the name onward. Importers that declare the name themselves
/// do not resolve to this file.
pub(super) fn importer_references(graph: &Graph, rel: &str, symbol: &str) -> Vec<RefEntry> {
    let targets = exposing_files(graph, &[rel.to_string()], symbol);
    let mut out = Vec::new();
    for node in &graph.nodes {
        if node.rel == rel {
            continue;
        }
        let mut names: HashSet<&str> = targets.get(&node.rel).into_iter().flatten().map(String::as_str).collect();
        for imported in &node.resolved_imports {
            names.extend(targets.get(imported).into_iter().flatten().map(String::as_str));
        }
        for name in names {
            if !(node.tokens.is_empty() || node.has_token(name)) {
                continue;
            }
            for (line, col) in occurrences(node, name) {
                out.push(RefEntry { file: node.rel.clone(), line, col });
            }
        }
    }
    out
}

pub(super) struct RefEntry {
    pub file: String,
    pub line: u32,
    pub col: u32,
}

/// Identifier mentions of `symbol` (declarations and imports included), capped.
pub(super) fn reference_entries(graph: &Graph, symbol: &str, language: Option<&str>, scope: Scope<'_>) -> (Vec<RefEntry>, bool) {
    let cap = reference_hit_cap(std::env::var("REFERENCE_HIT_CAP").ok().as_deref());
    let mut out = Vec::new();
    for node in graph.token_candidates(symbol, language).filter(|n| scope.contains(&n.rel)) {
        for (line, col) in occurrences(node, symbol) {
            if out.len() as f64 >= cap {
                return (out, true);
            }
            out.push(RefEntry { file: node.rel.clone(), line, col });
        }
    }
    (out, false)
}

/// `Math.max(1, Number(process.env.REFERENCE_HIT_CAP) || 200)`, read at each scan: a fraction stands
/// (a cap of 2.5 keeps three mentions), anything that is no number or is 0 is 200.
fn reference_hit_cap(raw: Option<&str>) -> f64 {
    let number = raw.map_or(f64::NAN, mixdog_js::string_to_number);
    let number = if number.is_nan() || number == 0.0 { 200.0 } else { number };
    number.max(1.0)
}

fn to_byte_column(line: &str, char_col: u32) -> u32 {
    if char_col < 1 {
        return char_col;
    }
    let prefix: String = line.chars().take(char_col as usize - 1).collect();
    prefix.len() as u32 + 1
}

/// Innermost symbol around a position, preferring one that owns a body.
fn enclosing_symbol(node: &Node, line: u32, col: Option<u32>) -> Option<usize> {
    let mut candidates: Vec<usize> = node
        .symbols
        .iter()
        .enumerate()
        .filter(|(_, s)| {
            if s.start_line > line || s.end_line < line {
                return false;
            }
            if let Some(col) = col {
                if s.start_line == line && col < s.start_col {
                    return false;
                }
                if s.end_line == line && col > s.end_col {
                    return false;
                }
            }
            true
        })
        .map(|(i, _)| i)
        .collect();
    candidates.sort_by(|a, b| {
        let (a, b) = (&node.symbols[*a], &node.symbols[*b]);
        b.start_line.cmp(&a.start_line).then(b.start_col.cmp(&a.start_col))
    });
    candidates.iter().copied().find(|i| FUNCTION_LIKE_KINDS.contains(&node.symbols[*i].kind.to_lowercase().as_str())).or(candidates.first().copied())
}

fn position_path(node: &Node, line: u32, col: Option<u32>) -> String {
    match enclosing_symbol(node, line, col) {
        Some(i) => symbol_path(node, &parent_index(&node.symbols), i),
        None => String::new(),
    }
}

/// How a mention reads: declaration, import, call or a plain reference.
fn reference_kind(line: &str, symbol: &str, lang: &str) -> &'static str {
    let spots = identifier_occurrences(line, symbol, Some(lang));
    let declares = Regex::new(
        r"\b(?:function|class|interface|type|enum|record|struct|union|namespace|module|package|trait|impl|object|const|let|var|val|typedef|def|fn|fun)\s+$",
    )
    .expect("static pattern");
    let go_func = Regex::new(r"\bfunc(?:\s*\([^)]*\))?\s+$").expect("static pattern");
    if spots.iter().any(|s| {
        let before = &line[..*s];
        declares.is_match(before) || go_func.is_match(before)
    }) {
        return "declaration";
    }
    let import = Regex::new(r"\bimport\b").expect("static pattern");
    if let Some(m) = import.find(line)
        && spots.iter().any(|s| *s >= m.end())
    {
        return "import";
    }
    if spots.iter().any(|s| line[s + symbol.len()..].trim_start().starts_with('(')) {
        return "call";
    }
    "reference"
}

struct Entry {
    file: String,
    line: u32,
    col: u32,
    kind: &'static str,
    caller: String,
    owner: String,
    line_text: String,
}

fn call_caller_path(node: &Node, call: &CallInfo) -> String {
    if call.in_symbol.is_empty() {
        return String::new();
    }
    let covering: Vec<usize> = node
        .symbols
        .iter()
        .enumerate()
        .filter(|(_, s)| s.name == call.in_symbol && s.start_line <= call.line && s.end_line >= call.line)
        .map(|(i, _)| i)
        .collect();
    let mut innermost: Option<usize> = None;
    for i in covering {
        if innermost.is_none_or(|b| node.symbols[i].start_line > node.symbols[b].start_line) {
            innermost = Some(i);
        }
    }
    match innermost {
        Some(i) => symbol_path(node, &parent_index(&node.symbols), i),
        None => call.in_symbol.clone(),
    }
}

fn entry_from_call(node: &Node, call: &CallInfo) -> Entry {
    let caller = call_caller_path(node, call);
    Entry {
        file: node.rel.clone(),
        line: call.line,
        col: call.col + 1,
        kind: "call",
        owner: caller.clone(),
        caller,
        line_text: node.read().lines().get(call.line as usize - 1).map_or("", |s| s.trim()).to_string(),
    }
}

fn sort_entries(entries: &mut [Entry], by_caller: bool) {
    entries.sort_by(|a, b| {
        name_cmp(&a.file, &b.file)
            .then_with(|| if by_caller { name_cmp(&a.caller, &b.caller) } else { std::cmp::Ordering::Equal })
            .then(a.line.cmp(&b.line))
            .then(a.col.cmp(&b.col))
    });
}

/// Call sites and plain identifier usages of a symbol, one row each.
pub(super) fn format_references(graph: &Graph, symbol: &str, language: Option<&str>, scope: Scope<'_>, limit: usize) -> String {
    let (mentions, _) = reference_entries(graph, symbol, language, scope);
    let files: Vec<&str> = {
        let mut seen = Vec::new();
        for m in &mentions {
            if !seen.contains(&m.file.as_str()) {
                seen.push(m.file.as_str());
            }
        }
        seen
    };
    let mut call_entries = Vec::new();
    for rel in &files {
        let Some(node) = graph.node(rel) else { continue };
        let calls = node.calls();
        for call in calls.iter().flat_map(|c| c.iter()).filter(|c| c.name == symbol) {
            call_entries.push(entry_from_call(node, call));
        }
    }
    let call_positions: HashSet<(String, u32, u32)> = call_entries.iter().map(|e| (e.file.clone(), e.line, e.col)).collect();
    let mut entries: Vec<Entry> = Vec::new();
    for m in &mentions {
        let Some(node) = graph.node(&m.file) else { continue };
        let source = node.read();
        let raw = source.lines().get(m.line as usize - 1).map_or("", |s| s.as_str());
        let text = raw.trim();
        if text.is_empty() || call_positions.contains(&(m.file.clone(), m.line, m.col)) {
            continue;
        }
        if reference_kind(text, symbol, node.lang) != "reference" {
            continue;
        }
        entries.push(Entry {
            file: m.file.clone(),
            line: m.line,
            col: m.col,
            kind: "reference",
            caller: String::new(),
            owner: position_path(node, m.line, Some(to_byte_column(raw, m.col))),
            line_text: text.to_string(),
        });
    }
    entries.extend(call_entries);
    sort_entries(&mut entries, false);
    if entries.is_empty() {
        return "(no references)".to_string();
    }
    let mut rows: Vec<String> = entries
        .iter()
        .take(limit)
        .map(|e| {
            let owner = if e.owner.is_empty() { String::new() } else { format!("\towner={}", e.owner) };
            format!("{}:{}:{}\t{}{owner}\t{}", e.file, e.line, e.col, e.kind, head_chars(&e.line_text, 80))
        })
        .collect();
    if entries.len() > limit {
        rows.push(format!("... +{} more references", entries.len() - limit));
    }
    rows.join("\n")
}

/// Files that declare `symbol`: the anchors of the caller rule.
pub(super) fn caller_target_rels(graph: &Graph, symbol: &str, language: Option<&str>, scope: Scope<'_>) -> Vec<String> {
    let hits = find_hits(graph, symbol, language);
    if hits.is_empty() {
        return Vec::new();
    }
    let anchored = scope.file_rel.is_some() || scope.prefix.is_some();
    let scoped: Vec<_> = if anchored { hits.iter().filter(|h| scope.contains(&h.rel)).collect() } else { Vec::new() };
    let pool: Vec<_> = if scoped.is_empty() { hits.iter().collect() } else { scoped };
    let declaring: Vec<_> = pool.iter().filter(|h| h.declaration_like).copied().collect();
    let chosen: Vec<_> = if declaring.is_empty() { pool.into_iter().take(1).collect() } else { declaring };
    let mut rels: Vec<String> = Vec::new();
    for h in chosen {
        if !rels.contains(&h.rel) {
            rels.push(h.rel.clone());
        }
    }
    rels
}

fn caller_entries(graph: &Graph, symbol: &str, target_rels: &[String], language: Option<&str>, scope: Scope<'_>) -> Vec<Entry> {
    if target_rels.is_empty() || symbol.is_empty() {
        return Vec::new();
    }
    let targets = exposing_files(graph, target_rels, symbol);
    let mut found: Vec<(&Node, CallInfo)> = Vec::new();
    for node in &graph.nodes {
        if language.is_some_and(|l| node.lang != l) || !scope.contains(&node.rel) {
            continue;
        }
        // The names the file's own module and the modules it imports expose the symbol under.
        let mut names: HashSet<&str> = targets.get(&node.rel).into_iter().flatten().map(String::as_str).collect();
        let mut imports_target = false;
        for imported in &node.resolved_imports {
            if let Some(exposed) = targets.get(imported) {
                imports_target = true;
                names.extend(exposed.iter().map(String::as_str));
            }
        }
        if node.resolved_imports.is_empty() && !node.raw_imports.is_empty() {
            names.insert(symbol);
        }
        // A call is an identifier of the file: read the sources of the files that carry one of the names only.
        if names.is_empty() || !(node.tokens.is_empty() || names.iter().any(|n| node.has_token(n))) {
            continue;
        }
        let Some(calls) = node.calls() else { continue };
        for call in calls.iter().filter(|c| names.contains(c.name.as_str())) {
            if call.kind == "method" && !SELF_RECEIVERS.contains(&call.recv.as_str()) && !imports_target {
                continue;
            }
            found.push((node, call.clone()));
        }
    }
    found.sort_by(|a, b| {
        name_cmp(&a.0.rel, &b.0.rel).then_with(|| name_cmp(&a.1.in_symbol, &b.1.in_symbol)).then(a.1.line.cmp(&b.1.line)).then(a.1.col.cmp(&b.1.col))
    });
    let mut entries: Vec<Entry> = found.into_iter().map(|(node, call)| entry_from_call(node, &call)).collect();
    sort_entries(&mut entries, true);
    entries
}

pub(super) fn format_callers(graph: &Graph, symbol: &str, language: Option<&str>, scope: Scope<'_>, limit: usize) -> String {
    let targets = caller_target_rels(graph, symbol, language, scope);
    let entries = caller_entries(graph, symbol, &targets, language, scope.for_callers());
    if entries.is_empty() {
        return "(no callers)".to_string();
    }
    let mut rows = vec![
        "# caller-name matches (importer-restricted name matching; not binding-resolved)".to_string(),
        "# May include unrelated same-named identifiers; aliases, namespace members, and unrecognized re-export paths may be missed.".to_string(),
    ];
    rows.extend(entries.iter().take(limit).map(|e| {
        let caller = if e.caller.is_empty() { String::new() } else { format!("\tcaller={}", e.caller) };
        format!("{}:{}:{}\t{}{caller}\t{}", e.file, e.line, e.col, e.kind, head_chars(&e.line_text, 80))
    }));
    if entries.len() > limit {
        rows.push(format!("... +{} more call sites", entries.len() - limit));
    }
    rows.join("\n")
}

struct Level {
    indent: usize,
    label: String,
}

fn caller_names(graph: &Graph, symbol: &str, language: Option<&str>, scope: Scope<'_>) -> (Vec<(String, String, bool)>, usize) {
    const ANON_LEAF_MAX: usize = 6;
    let targets = caller_target_rels(graph, symbol, language, scope);
    let entries = caller_entries(graph, symbol, &targets, language, scope.for_callers());
    let mut named: Vec<(String, String, bool)> = Vec::new();
    let mut leaves: Vec<(String, String, bool)> = Vec::new();
    for e in &entries {
        let loc = format!("{}:{}", e.file, e.line);
        if !e.caller.is_empty() && e.caller != symbol {
            if !named.iter().any(|(n, _, _)| *n == e.caller) {
                named.push((e.caller.clone(), loc, false));
            }
        } else if e.caller.is_empty() && !leaves.iter().any(|(_, l, _)| *l == loc) {
            let snippet: String = e.line_text.split_whitespace().collect::<Vec<_>>().join(" ");
            let snippet = if snippet.is_empty() { "call".to_string() } else { snippet };
            leaves.push((format!("«{}»", head_chars(&snippet, 48)), loc, true));
        }
    }
    // Anonymous call sites past the bound are counted, never silently dropped.
    let omitted = if leaves.len() <= ANON_LEAF_MAX { 0 } else { leaves.len() };
    if omitted == 0 {
        named.extend(leaves);
    }
    (named, omitted)
}

pub(super) struct TransitiveOptions<'a> {
    pub language: Option<&'a str>,
    pub depth: usize,
    pub page_size: usize,
    pub page: usize,
    pub scope: Scope<'a>,
}

pub(super) fn format_transitive_callers(graph: &Graph, root: &str, opts: TransitiveOptions<'_>) -> String {
    struct Walk<'g, 'o> {
        graph: &'g Graph,
        opts: &'o TransitiveOptions<'o>,
        expanded: HashSet<String>,
        collected: Vec<Level>,
    }
    impl Walk<'_, '_> {
        fn walk(&mut self, symbol: &str, level: usize) {
            if level >= self.opts.depth {
                return;
            }
            if self.expanded.contains(symbol) {
                self.collected.push(Level { indent: level + 1, label: format!("{symbol} … (callers expanded above)") });
                return;
            }
            self.expanded.insert(symbol.to_string());
            let (names, omitted) = caller_names(self.graph, symbol, self.opts.language, self.opts.scope);
            for (name, loc, leaf) in names {
                self.collected.push(Level { indent: level + 1, label: format!("{name}\t{loc}") });
                if !leaf {
                    self.walk(&name, level + 1);
                }
            }
            if omitted > 0 {
                self.collected.push(Level {
                    indent: level + 1,
                    label: format!("… {omitted} anonymous call-site name matches of {symbol} not listed here; use depth:1 to list them"),
                });
            }
        }
    }
    let mut walk = Walk { graph, opts: &opts, expanded: HashSet::new(), collected: Vec::new() };
    walk.walk(root, 0);
    let collected = walk.collected;
    if collected.is_empty() {
        return "(no callers)".to_string();
    }
    let size = opts.page_size.max(1);
    let page = opts.page.max(1);
    let total = collected.len();
    let last_page = total.div_ceil(size);
    let start = (page - 1).saturating_mul(size);
    let depth = opts.depth;
    if start >= total {
        return format!("# transitive callers of {root} (depth={depth}) — page {page} is past the end (total {total} node(s); last page is {last_page}).");
    }
    let slice = &collected[start..start.saturating_add(size).min(total)];
    let has_more = start + slice.len() < total;
    let mut lines = vec![
        format!(
            "# transitive callers of {root} (depth={depth}) — page {page}, nodes {}-{} of {total}; INDENTED children are ITS callers",
            start + 1,
            start + slice.len()
        ),
        root.to_string(),
    ];
    lines.extend(slice.iter().map(|e| format!("{}{}", "  ".repeat(e.indent), e.label)));
    lines.push(if has_more {
        format!("# NEXT — keep the same callers arguments and set page:{} for the next {size} node(s). Every node carries file:line.", page + 1)
    } else {
        "# END — end of collected caller-name matches, not a complete binding-resolved caller set. Verify with grep/read.".to_string()
    });
    lines.join("\n")
}

/// Calls made inside `symbol` of `node` (and, for a container, inside its members).
fn callee_sites(node: &Node, symbol: &str) -> Option<Vec<CallInfo>> {
    let calls = node.calls()?;
    let mut owned: HashSet<&str> = HashSet::from([symbol]);
    let containers: Vec<usize> =
        node.symbols.iter().enumerate().filter(|(_, s)| s.name == symbol && CONTAINER_KINDS.contains(&s.kind)).map(|(i, _)| i).collect();
    if !containers.is_empty() {
        let parents = parent_index(&node.symbols);
        for (i, s) in node.symbols.iter().enumerate() {
            if s.name.is_empty() || owned.contains(s.name.as_str()) {
                continue;
            }
            if super::outline::ancestors(&parents, i).iter().any(|a| containers.contains(a)) {
                owned.insert(s.name.as_str());
            }
        }
    }
    Some(calls.iter().filter(|c| owned.contains(c.in_symbol.as_str())).cloned().collect())
}

pub(super) fn format_callees(graph: &Graph, decl_rel: &str, symbol: &str, language: Option<&str>) -> String {
    const CAP: usize = 200;
    let Some(node) = graph.node(decl_rel) else {
        return "(no callees)".to_string();
    };
    let sites = callee_sites(node, symbol).unwrap_or_default();
    let mut seen: HashSet<(&str, &str, &str)> = HashSet::new();
    let unique: Vec<&CallInfo> = sites.iter().filter(|c| seen.insert((c.kind, c.recv.as_str(), c.name.as_str()))).collect();
    if unique.is_empty() {
        return "(no callees)".to_string();
    }
    let mut decls: HashMap<&str, Option<super::hits::Hit>> = HashMap::new();
    let mut rows = vec!["# callees".to_string()];
    for call in unique.iter().take(CAP) {
        let decl =
            decls.entry(call.name.as_str()).or_insert_with(|| callee_declaration(graph, &call.name, language, &node.rel)).as_ref().filter(|d| {
                d.declaration_like && (call.kind != "method" || call.recv.is_empty() || d.rel == node.rel || node.resolved_imports.contains(&d.rel))
            });
        let enclosing = if call.in_symbol.is_empty() { "(in ?)".to_string() } else { format!("(in {})", call.in_symbol) };
        let origin = format!("\tkind={}{}", call.kind, if call.recv.is_empty() { String::new() } else { format!(" recv={}", call.recv) });
        let decl_text = match decl {
            Some(d) => format!("decl {}:{}", d.rel, d.line),
            None => "decl (external/builtin)".to_string(),
        };
        rows.push(format!("{}\tcallsite {}:{}:{}\t{decl_text}\t{enclosing}{origin}", call.name, node.rel, call.line, call.col + 1));
    }
    if unique.len() > CAP {
        rows.push(format!("... +{} more callees (cap={CAP})", unique.len() - CAP));
    }
    rows.join("\n")
}
