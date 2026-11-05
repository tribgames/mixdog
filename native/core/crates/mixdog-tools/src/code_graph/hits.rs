//! Symbol hits: where a name is declared or mentioned, ranked, and the `find_symbol` /
//! `symbol_search` answers built from them. Declarations come from the native symbol record
//! only; mentions are identifier nodes of the parse tree.

use std::cmp::Ordering;

use mixdog_graph::outline::{SymbolInfo, identifier_hits};

use super::graph::{Graph, MAX_FILES, Node};
use super::outline::{parent_index, symbol_path};
use super::util::{head_chars, name_cmp};

#[derive(Clone, Debug)]
pub(super) struct Hit {
    pub rel: String,
    pub lang: &'static str,
    pub line: u32,
    pub col: u32,
    pub end_line: Option<u32>,
    pub declaration_like: bool,
    pub match_count: usize,
    pub content: String,
    pub name_path: Option<String>,
    pub kind: Option<&'static str>,
    pub sig: Option<String>,
    pub exported: bool,
}

impl Hit {
    fn apply_facts(&mut self, sym: &SymbolInfo) {
        self.kind = Some(if sym.kind.is_empty() { "symbol" } else { sym.kind });
        let sig = sym.sig.trim();
        self.sig = (!sig.is_empty()).then(|| sig.to_string());
        self.exported = sym.exported;
    }

    pub fn location(&self) -> String {
        let col = if self.col == 0 { 1 } else { self.col };
        match self.end_line {
            Some(end) if end >= self.line => format!("{}:{}-{end}:{col}", self.rel, self.line),
            _ => format!("{}:{}:{col}", self.rel, self.line),
        }
    }

    /// `export class`, `function`: the marker the outline rows use.
    pub fn facts(&self) -> String {
        match self.kind {
            Some(kind) => format!("{}{kind}", if self.exported { "export " } else { "" }),
            None => String::new(),
        }
    }
}

fn is_type_declaration_rel(rel: &str) -> bool {
    let lower = rel.to_lowercase();
    [".d.ts", ".d.mts", ".d.cts"].iter().any(|e| lower.ends_with(e))
}

fn module_stem(rel: &str) -> String {
    let base = rel.rsplit('/').next().unwrap_or("");
    let lower = base.to_lowercase();
    for ext in [".d.ts", ".d.mts", ".d.cts"] {
        if let Some(stem) = lower.strip_suffix(ext) {
            return stem.to_string();
        }
    }
    for ext in [".mjs", ".cjs", ".js", ".jsx", ".mts", ".cts", ".ts", ".tsx"] {
        if let Some(stem) = lower.strip_suffix(ext) {
            return stem.to_string();
        }
    }
    lower
}

fn dir_of(rel: &str) -> String {
    rel.rfind('/')
        .map_or("", |i| &rel[..i])
        .to_lowercase()
}

/// `.d.ts` next to the implementation it types.
pub(super) fn is_type_face_of(impl_rel: &str, type_rel: &str) -> bool {
    dir_of(impl_rel) == dir_of(type_rel) && module_stem(impl_rel) == module_stem(type_rel)
}

fn rel_rank(hit: &Hit) -> (bool, bool, usize) {
    (
        is_type_declaration_rel(&hit.rel),
        hit.rel.starts_with("src/"),
        hit.rel.split('/').count(),
    )
}

pub(super) fn compare_hits(a: &Hit, b: &Hit) -> Ordering {
    let (ta, sa, da) = rel_rank(a);
    let (tb, sb, db) = rel_rank(b);
    b.declaration_like
        .cmp(&a.declaration_like)
        .then(ta.cmp(&tb))
        .then(sb.cmp(&sa))
        .then(da.cmp(&db))
        .then(b.match_count.cmp(&a.match_count))
        .then_with(|| name_cmp(&a.rel, &b.rel))
        .then(a.line.cmp(&b.line))
}

fn sorted(mut hits: Vec<Hit>) -> Vec<Hit> {
    hits.sort_by(compare_hits);
    hits
}

fn native_end_line(node: &Node, name: &str, decl_line: u32) -> Option<u32> {
    let mut exact = None;
    let mut nearest: Option<u32> = None;
    let mut nearest_dist = u32::MAX;
    for s in node.symbols.iter().filter(|s| s.name == name) {
        if s.start_line == decl_line && s.end_line >= decl_line {
            exact = Some(s.end_line);
        }
        let dist = s.start_line.abs_diff(decl_line);
        if dist < nearest_dist {
            nearest_dist = dist;
            nearest = (s.end_line >= s.start_line).then_some(s.end_line);
        }
    }
    exact.or(if nearest_dist <= 2 { nearest } else { None })
}

pub(super) fn native_hit(node: &Node, sym: &SymbolInfo) -> Option<Hit> {
    if sym.start_line < 1 {
        return None;
    }
    let mut hit = Hit {
        rel: node.rel.clone(),
        lang: node.lang,
        line: sym.start_line,
        col: sym.start_col.max(1),
        end_line: (sym.end_line >= sym.start_line).then_some(sym.end_line),
        declaration_like: true,
        match_count: 1,
        content: String::new(),
        name_path: None,
        kind: None,
        sig: None,
        exported: false,
    };
    hit.apply_facts(sym);
    Some(hit)
}

/// Identifier occurrences of `name` in a file, ascending.
pub(super) fn occurrences(node: &Node, name: &str) -> Vec<(u32, u32)> {
    let Some(scan) = node.scan_lang else {
        return Vec::new();
    };
    let mut hits = identifier_hits(&node.text, scan, name);
    hits.sort_unstable();
    hits
}

fn hits_on_node(node: &Node, name: &str, out: &mut Vec<Hit>) {
    let natives: Vec<&SymbolInfo> = node.symbols.iter().filter(|s| s.name == name).collect();
    let spots = occurrences(node, name);
    if spots.is_empty() {
        out.extend(natives.iter().filter_map(|s| native_hit(node, s)));
        return;
    }
    let lines = node.lines();
    let line_text = |l: u32| lines.get(l as usize - 1).map_or("", |s| s.trim());
    let decl_symbol = |line: u32| natives.iter().find(|s| s.start_line == line).copied();
    let mut declaration_like = false;
    let mut decl: Option<(u32, u32, &SymbolInfo)> = None;
    for (line, col) in &spots {
        if let Some(sym) = decl_symbol(*line) {
            declaration_like = true;
            if decl.is_none() {
                decl = Some((*line, *col, sym));
            }
        }
    }
    let (first_line, first_col) = spots[0];
    let (line, col) = decl.map_or((first_line, first_col), |(l, c, _)| (l, c));
    let end_line = native_end_line(node, name, line).filter(|e| *e >= line);
    let mut hit = Hit {
        rel: node.rel.clone(),
        lang: node.lang,
        line,
        col,
        end_line,
        declaration_like,
        match_count: spots.len(),
        content: line_text(line).to_string(),
        name_path: None,
        kind: None,
        sig: None,
        exported: false,
    };
    if let Some((_, _, sym)) = decl {
        hit.apply_facts(sym);
    }
    out.push(hit);
}

/// Hits of a name (or `a/b` name path) across the graph, best first.
pub(super) fn find_hits(graph: &Graph, symbol: &str, language: Option<&str>) -> Vec<Hit> {
    let clean = symbol.trim();
    if clean.is_empty() {
        return Vec::new();
    }
    let name_path = clean.trim_matches('/');
    let leaf = name_path.rsplit('/').next().unwrap_or("");
    if clean.contains('/') {
        let absolute = clean.starts_with('/');
        let mut hits = Vec::new();
        for node in graph.token_candidates(leaf, language) {
            let parents = parent_index(&node.symbols);
            for (i, sym) in node.symbols.iter().enumerate().filter(|(_, s)| s.name == leaf) {
                let path = symbol_path(node, &parents, i);
                if path != name_path && (absolute || !path.ends_with(&format!("/{name_path}"))) {
                    continue;
                }
                if let Some(mut hit) = native_hit(node, sym) {
                    hit.content = node
                        .lines()
                        .get(sym.start_line as usize - 1)
                        .map_or("", |s| s.trim())
                        .to_string();
                    hit.name_path = Some(path);
                    hits.push(hit);
                }
            }
        }
        return sorted(hits);
    }
    let mut hits = Vec::new();
    for node in graph.token_candidates(clean, language) {
        hits_on_node(node, clean, &mut hits);
    }
    sorted(hits)
}

/// The declaration a callee name resolves to: the same file's, else the best-ranked.
pub(super) fn callee_declaration(
    graph: &Graph,
    name: &str,
    language: Option<&str>,
    prefer_rel: &str,
) -> Option<Hit> {
    let clean = name.trim();
    let hits: Vec<Hit> = if clean.is_empty() || clean.contains('/') {
        find_hits(graph, name, language)
    } else {
        let mut hits = Vec::new();
        for node in graph
            .token_candidates(clean, language)
            .filter(|n| n.symbols.iter().any(|s| s.name == clean))
        {
            hits_on_node(node, clean, &mut hits);
        }
        sorted(hits)
    };
    pick_declaration(&hits, Some(prefer_rel))
}

pub(super) fn pick_declaration(hits: &[Hit], prefer_rel: Option<&str>) -> Option<Hit> {
    if let Some(prefer) = prefer_rel
        && let Some(h) = hits.iter().find(|h| h.rel == prefer && h.declaration_like)
    {
        return Some(h.clone());
    }
    let mut ranked = hits.to_vec();
    ranked.sort_by(compare_hits);
    ranked
        .iter()
        .find(|h| h.declaration_like)
        .or(ranked.first())
        .cloned()
}

/// Declaration body with line numbers.
pub(super) fn format_body(text: &str, start_line: u32, end_line: u32) -> String {
    let all: Vec<&str> = text.split('\n').collect();
    let start = start_line.max(1) as usize;
    let end = (end_line as usize).max(start).min(all.len());
    (start..=end)
        .filter_map(|n| all.get(n - 1).map(|l| format!("{n}: {l}")))
        .collect::<Vec<_>>()
        .join("\n")
}

/// End line of a brace-delimited declaration found by indentation, when the record has none.
fn infer_span_end(all: &[&str], start_line: u32) -> Option<u32> {
    let decl = all.get(start_line as usize - 1)?;
    let trimmed = decl.trim_end();
    let opener = trimmed.chars().last().filter(|c| matches!(c, '{' | '(' | '['))?;
    let indent = |s: &str| s.len() - s.trim_start_matches([' ', '\t']).len();
    let closer = |c: char| match c {
        '{' => '}',
        '(' => ')',
        _ => ']',
    };
    let decl_indent = indent(decl);
    let last = all.len().min(start_line as usize - 1 + 400);
    let mut expected = closer(opener);
    for (i, line) in all.iter().enumerate().take(last).skip(start_line as usize) {
        let first = line.trim_start_matches([' ', '\t']).chars().next();
        let Some(first) = first.filter(|c| matches!(c, '}' | ')' | ']')) else {
            continue;
        };
        if indent(line) > decl_indent || first != expected {
            continue;
        }
        let tail = line.trim_end();
        if let Some(reopen) = tail.chars().last().filter(|c| matches!(c, '{' | '(' | '['))
            && indent(line) == decl_indent
        {
            expected = closer(reopen);
            continue;
        }
        return Some(i as u32 + 1);
    }
    None
}

fn summary(hit: &Hit) -> String {
    hit.sig
        .clone()
        .unwrap_or_else(|| head_chars(&hit.content, 100).to_string())
}

/// A declaration reachable from the requested scope but outside it.
pub(super) struct Outside {
    pub rel: String,
    pub line: u32,
    pub lang: String,
    pub facts: String,
}

fn format_outside(o: &Outside) -> String {
    if o.line == 0 {
        return format!("{} (resolved from the import specifier)", o.rel);
    }
    let facts: Vec<&str> = [o.lang.as_str(), o.facts.as_str()]
        .into_iter()
        .filter(|s| !s.is_empty())
        .collect();
    let facts = if facts.is_empty() {
        String::new()
    } else {
        format!(" ({})", facts.join(", "))
    };
    format!("{}:{}{facts}", o.rel, o.line)
}

/// The declaration a scoped query points at but the scope excludes: first the module the
/// scope's files import it from, then any other declaration the graph knows.
pub(super) fn declaration_outside_scope(
    graph: &Graph,
    symbol: &str,
    language: Option<&str>,
    in_scope: &dyn Fn(&str) -> bool,
) -> Option<Outside> {
    for node in graph.nodes.iter().filter(|n| in_scope(&n.rel)) {
        for target in &node.resolved_imports {
            let Some(known) = graph.node(target) else {
                continue;
            };
            if let Some(sym) = known.symbols.iter().find(|s| s.name == symbol) {
                let mut hit = native_hit(known, sym)?;
                hit.apply_facts(sym);
                return Some(Outside {
                    rel: known.rel.clone(),
                    line: sym.start_line,
                    lang: known.lang.to_string(),
                    facts: hit.facts(),
                });
            }
        }
    }
    find_hits(graph, symbol, language)
        .into_iter()
        .find(|h| h.declaration_like && !in_scope(&h.rel))
        .map(|h| Outside {
            facts: h.facts(),
            rel: h.rel,
            line: h.line,
            lang: h.lang.to_string(),
        })
}

pub(super) struct FindOptions<'a> {
    pub language: Option<&'a str>,
    pub limit: usize,
    pub file_rel: Option<&'a str>,
    pub body: bool,
    pub outside: Option<Outside>,
    /// Shown as `# scope: cwd=…` when the answer's root differs from the caller's.
    pub scope_note: Option<String>,
}

pub(super) fn find_symbol_across_graph(
    graph: &Graph,
    symbol: &str,
    cwd: &str,
    opts: FindOptions<'_>,
) -> String {
    let all = find_hits(graph, symbol, opts.language);
    let hits: Vec<&Hit> = all
        .iter()
        .filter(|h| opts.file_rel.is_none_or(|f| h.rel == f))
        .collect();
    let outside_line = opts
        .outside
        .as_ref()
        .map(|o| format!("declared outside the requested files: {}", format_outside(o)))
        .unwrap_or_default();
    if hits.is_empty() {
        let mut lines = vec![format!(
            "(no symbol matches in cwd={cwd}{})",
            opts.file_rel
                .map(|f| format!(" file={f}"))
                .unwrap_or_default()
        )];
        lines.push(format!(
            "graph: nodes={}{}",
            graph.nodes.len(),
            opts.language
                .map(|l| format!(", language={l}"))
                .unwrap_or_default()
        ));
        if graph.truncated {
            lines.push(format!("WARN: graph truncated at CODE_GRAPH_MAX_FILES={MAX_FILES} — symbol may exist in an un-indexed file. Re-run with a narrower cwd."));
        }
        if !outside_line.is_empty() {
            lines.push(outside_line);
        }
        return lines.join("\n");
    }
    let top: Vec<&Hit> = hits.iter().take(opts.limit.max(1)).copied().collect();
    let primary = top[0];
    let decl_hits: Vec<&Hit> = hits.iter().filter(|h| h.declaration_like).copied().collect();
    let impl_decls: Vec<&Hit> = decl_hits
        .iter()
        .filter(|h| !is_type_declaration_rel(&h.rel))
        .copied()
        .collect();
    let type_faces: Vec<&Hit> = decl_hits
        .iter()
        .filter(|h| {
            is_type_declaration_rel(&h.rel)
                && impl_decls.iter().any(|i| is_type_face_of(&i.rel, &h.rel))
        })
        .copied()
        .collect();
    let rivals: Vec<&Hit> = decl_hits
        .iter()
        .filter(|h| !type_faces.iter().any(|t| std::ptr::eq(*t, **h)))
        .copied()
        .collect();
    let decl_count = rivals.len();
    let mut lines: Vec<String> = Vec::new();
    if decl_count > 1 {
        lines.push(format!(
            "⚠ {decl_count} declarations found — verify which one you intend"
        ));
        lines.push(String::new());
    }
    if primary.declaration_like && decl_count <= 1 {
        lines.push(if graph.truncated {
            "# best declaration candidate (GRAPH TRUNCATED — may not be canonical; re-run with a narrower cwd to confirm)".to_string()
        } else {
            "# best declaration candidate".to_string()
        });
        let name_path = primary
            .name_path
            .as_ref()
            .map(|p| format!(", path={p}"))
            .unwrap_or_default();
        let facts = primary.facts();
        lines.push(format!(
            "{} ({}{}, matches={}{name_path})",
            primary.location(),
            primary.lang,
            if facts.is_empty() {
                String::new()
            } else {
                format!(", {facts}")
            },
            primary.match_count
        ));
        let mut body_emitted = false;
        if opts.body
            && let Some(node) = graph.node(&primary.rel).filter(|n| !n.text.is_empty())
        {
            let all_lines: Vec<&str> = node.text.split('\n').collect();
            let start = primary.line.max(1);
            let end = primary
                .end_line
                .filter(|e| *e >= start)
                .or_else(|| infer_span_end(&all_lines, start))
                .unwrap_or(start);
            lines.push(format_body(&node.text, start, end));
            body_emitted = true;
        }
        let text = summary(primary);
        if !body_emitted && !text.is_empty() {
            lines.push(format!(
                "{}{text}",
                if primary.sig.is_some() { "signature: " } else { "" }
            ));
        }
    }
    let candidates: Vec<&Hit> = if decl_count > 1 {
        rivals.iter().take(opts.limit.max(1)).copied().collect()
    } else if !primary.declaration_like {
        top.iter()
            .filter(|h| !type_faces.iter().any(|t| std::ptr::eq(*t, **h)))
            .copied()
            .collect()
    } else {
        Vec::new()
    };
    if !candidates.is_empty() && hits.len() > 1 {
        if lines.last().is_some_and(|l| !l.is_empty()) {
            lines.push(String::new());
        }
        lines.push("# candidates".to_string());
    }
    for (idx, hit) in candidates.iter().enumerate() {
        let kind = if hit.declaration_like { "decl" } else { "ref" };
        let facts = hit.facts();
        let detail = if decl_count > 1 {
            hit.sig.clone().unwrap_or_default()
        } else {
            summary(hit)
        };
        let suffix = if detail.is_empty() {
            String::new()
        } else {
            format!(" — {detail}")
        };
        let path = hit
            .name_path
            .as_ref()
            .map(|p| format!(" path={p}"))
            .unwrap_or_default();
        let number = if hits.len() > 1 {
            format!("{}. ", idx + 1)
        } else {
            String::new()
        };
        lines.push(format!(
            "{number}{} [{kind}{}, {}, matches={}]{path}{suffix}",
            hit.location(),
            if facts.is_empty() {
                String::new()
            } else {
                format!(", {facts}")
            },
            hit.lang,
            hit.match_count
        ));
    }
    if decl_count > 1 && decl_count > candidates.len() {
        lines.push(format!(
            "  ... {} more declarations; narrow file or raise limit",
            decl_count - candidates.len()
        ));
    }
    for hit in type_faces.iter().take(3) {
        let detail = summary(hit);
        lines.push(format!(
            "type declaration: {} [{}]{}",
            hit.location(),
            hit.lang,
            if detail.is_empty() {
                String::new()
            } else {
                format!(" — {detail}")
            }
        ));
    }
    if decl_count == 0 {
        lines.push(String::new());
        lines.push(if outside_line.is_empty() {
            format!(
                "(no user declaration found; likely a global/builtin identifier — all {} hits are references)",
                hits.len()
            )
        } else {
            format!(
                "{outside_line}\n(the {} hit(s) in the requested scope are imports/references)",
                hits.len()
            )
        });
    }
    if graph.truncated && (!primary.declaration_like || decl_count > 1) {
        lines.push(format!(
            "WARN: graph truncated at CODE_GRAPH_MAX_FILES={MAX_FILES} — some files not indexed"
        ));
    }
    if hits.len() > 1
        && let Some(note) = opts.scope_note
    {
        lines.push(format!("\n# scope: cwd={note}"));
    }
    lines.join("\n")
}

/// `(no references)` / `(no callers)` answered with whether the name exists at all.
pub(super) fn augment_no_hit(
    result: String,
    empty_token: &str,
    graph: &Graph,
    cwd: &str,
    symbol: &str,
) -> String {
    if result.trim() != empty_token {
        return result;
    }
    let trunc = if graph.truncated {
        format!(", graph truncated at {MAX_FILES} files")
    } else {
        String::new()
    };
    match find_hits(graph, symbol, None).first() {
        Some(decl) => format!(
            "{empty_token}\n# '{symbol}' IS defined ({}) but is genuinely unreferenced in this graph — present, not missing. No re-scope / grep needed.",
            decl.location()
        ),
        None => format!(
            "{empty_token}\n# '{symbol}' not present in graph rooted at {cwd} ({} files indexed{trunc}). If it should exist, the target is likely outside this cwd — pass an explicit 'cwd' (repo root) or 'file' anchor, or switch Project with the session tool (set-project).",
            graph.nodes.len()
        ),
    }
}
