//! The thirteen mode answers over a built graph. A mode handler gets the resolved anchor
//! (`rel`/`node` for a file, `scope_prefix` for a directory) and returns its text.

use std::path::Path;

use super::args::Args;
use super::graph::{Graph, MAX_FILES, Node};
use super::hits::{
    FindOptions, Hit, declaration_outside_scope, find_hits, find_symbol_across_graph,
    native_hit, pick_declaration,
};
use super::outline::outline_rows;
use super::refs::{
    Scope, TransitiveOptions, caller_target_rels, format_callees, format_callers,
    format_references, format_transitive_callers, reference_entries,
};
use super::util::{cap_list, name_cmp};

const LIST_CAP: usize = 200;

pub(super) struct Ctx<'a> {
    pub args: &'a Args,
    pub cwd: &'a Path,
    /// The caller's own cwd; differs from `cwd` when the call was re-rooted.
    pub default_cwd: &'a Path,
    pub graph: &'a Graph,
    pub norm_file: Option<&'a str>,
    pub rel: Option<String>,
    pub node: Option<&'a Node>,
    pub scope_prefix: Option<String>,
}

impl Ctx<'_> {
    fn cwd_text(&self) -> String {
        self.cwd.to_string_lossy().into_owned()
    }

    fn scope(&self) -> Scope<'_> {
        Scope {
            file_rel: self.rel.as_deref(),
            prefix: self.scope_prefix.as_deref(),
        }
    }

    fn language(&self) -> Option<&str> {
        self.args.language.as_deref()
    }
}

pub(super) fn file_not_found(mode: &str, norm_file: Option<&str>, graph: &Graph) -> String {
    let shown = norm_file.unwrap_or("(missing file)");
    append_same_basename_hint(
        format!("Error: code_graph {mode}: file not found in graph: {shown}"),
        norm_file,
        graph,
    )
}

pub(super) fn append_same_basename_hint(message: String, norm_file: Option<&str>, graph: &Graph) -> String {
    let raw = norm_file.unwrap_or("").replace('\\', "/");
    let base = raw.rsplit('/').next().unwrap_or("").to_lowercase();
    if base.is_empty() {
        return message;
    }
    let matches: Vec<&str> = graph
        .nodes
        .iter()
        .map(|n| n.rel.as_str())
        .filter(|rel| rel.rsplit('/').next().unwrap_or("").to_lowercase() == base)
        .take(3)
        .collect();
    let why = " — the file exists on disk but is not indexed (excluded dir like dist/vendor, unsupported type, or graph file cap); use grep/read on it directly.";
    if matches.is_empty() {
        return format!("{message}{why}");
    }
    let listed = matches
        .iter()
        .map(|m| format!("\"{m}\""))
        .collect::<Vec<_>>()
        .join(", ");
    format!("{message}{why} If you meant the indexed source, same filename is indexed at: {listed}.")
}

fn required_symbol(mode: &str, args: &Args) -> Result<String, String> {
    args.symbol
        .clone()
        .ok_or_else(|| format!("code_graph {mode}: \"symbol\" is required."))
}

/// A file's outline, optionally narrowed to the rows that mention a keyword.
pub(super) fn filter_symbol_outline(node: &Node, args: &Args) -> String {
    let keywords = args.symbol_list();
    let items = outline_rows(node, None, 0);
    if items.is_empty() {
        return "(no symbols)".to_string();
    }
    if keywords.is_empty() {
        return cap_list(items, LIST_CAP).join("\n");
    }
    let needles: Vec<String> = keywords.iter().map(|k| k.to_lowercase()).collect();
    let lines: Vec<String> = items
        .into_iter()
        .filter(|line| {
            let lower = line.to_lowercase();
            needles.iter().any(|n| lower.contains(n))
        })
        .collect();
    if lines.is_empty() {
        let quoted = keywords
            .iter()
            .map(|k| serde_json::to_string(k).unwrap_or_default())
            .collect::<Vec<_>>()
            .join(", ");
        return format!("(no symbols matching {quoted})");
    }
    cap_list(lines, LIST_CAP).join("\n")
}

fn explainer_summary(ctx: &Ctx<'_>, node: &Node) -> String {
    let imports_all = &node.resolved_imports;
    let imports: Vec<&str> = imports_all.iter().take(8).map(String::as_str).collect();
    let outline = outline_rows(node, Some(ctx.args.depth.unwrap_or(1.0)), 120);
    let head: String = node.text.split('\n').take(6).collect::<Vec<_>>().join("\n");
    let head: String = super::util::head_chars(head.trim(), 420).to_string();
    let mut parts = vec![format!("file: {}", node.rel), format!("language: {}", node.lang)];
    if !outline.is_empty() {
        parts.push(format!("outline:\n{}", outline.join("\n")));
    }
    if !imports.is_empty() {
        let more = imports_all.len() - imports.len();
        parts.push(format!(
            "imports: {}{}",
            imports.join(", "),
            if more > 0 {
                format!(", … +{more} more (mode:imports for full list)")
            } else {
                String::new()
            }
        ));
    }
    if outline.is_empty() && !head.is_empty() {
        parts.push(format!("head:\n{head}"));
    }
    parts.join("\n")
}

pub(super) fn overview(ctx: &Ctx<'_>) -> String {
    if ctx.rel.is_some() && ctx.node.is_none() {
        return file_not_found("overview", ctx.norm_file, ctx.graph);
    }
    if let Some(node) = ctx.node {
        return explainer_summary(ctx, node);
    }
    let scoped: Vec<&Node> = ctx
        .graph
        .nodes
        .iter()
        .filter(|n| match ctx.scope_prefix.as_deref() {
            Some(p) => n.rel == p.trim_end_matches('/') || n.rel.starts_with(p),
            None => true,
        })
        .collect();
    if let Some(prefix) = &ctx.scope_prefix
        && scoped.is_empty()
    {
        return format!("(no indexed files under {prefix})");
    }
    let mut by_lang: Vec<(&str, usize)> = Vec::new();
    for n in &scoped {
        match by_lang.iter_mut().find(|(l, _)| *l == n.lang) {
            Some(entry) => entry.1 += 1,
            None => by_lang.push((n.lang, 1)),
        }
    }
    by_lang.sort_by_key(|entry| std::cmp::Reverse(entry.1));
    let mut lines: Vec<String> = Vec::new();
    if let Some(prefix) = &ctx.scope_prefix {
        lines.push(format!("scope\t{prefix}"));
    }
    lines.push(format!("files\t{}", scoped.len()));
    lines.push(format!(
        "edges\t{}",
        scoped.iter().map(|n| n.resolved_imports.len()).sum::<usize>()
    ));
    lines.extend(by_lang.iter().map(|(l, c)| format!("{l}\t{c}")));
    if ctx.graph.truncated {
        lines.push(format!("WARN: graph truncated at CODE_GRAPH_MAX_FILES={MAX_FILES} — some files under cwd were not indexed"));
    }
    lines.join("\n")
}

pub(super) fn imports(ctx: &Ctx<'_>) -> String {
    let Some(node) = ctx.node else {
        return file_not_found("imports", ctx.norm_file, ctx.graph);
    };
    let resolved: Vec<&String> = node.resolved_imports.iter().take(LIST_CAP).collect();
    let raw: Vec<&String> = node.raw_imports.iter().take(LIST_CAP).collect();
    let mut parts: Vec<String> = Vec::new();
    if !resolved.is_empty() {
        parts.push(resolved.iter().map(|s| s.as_str()).collect::<Vec<_>>().join("\n"));
    }
    if !raw.is_empty() {
        parts.push(format!(
            "# raw\n{}",
            raw.iter().map(|s| s.as_str()).collect::<Vec<_>>().join("\n")
        ));
    }
    if node.resolved_imports.len() > resolved.len() || node.raw_imports.len() > raw.len() {
        parts.push(format!(
            "[truncated — showing first {LIST_CAP} of {} resolved / {} raw imports]",
            node.resolved_imports.len(),
            node.raw_imports.len()
        ));
    }
    if parts.is_empty() {
        "(no imports)".to_string()
    } else {
        parts.join("\n\n")
    }
}

struct Neighbors {
    imports: Vec<String>,
    dependents: Vec<String>,
    related: Vec<String>,
}

fn neighbors(node: &Node, graph: &Graph) -> Neighbors {
    let imports = node.resolved_imports.clone();
    let dependents = graph.dependents(&node.rel);
    let mut related: Vec<String> = imports.iter().chain(&dependents).cloned().collect();
    related.sort();
    related.dedup();
    Neighbors {
        imports,
        dependents,
        related,
    }
}

pub(super) fn related(ctx: &Ctx<'_>) -> String {
    let Some(node) = ctx.node else {
        return file_not_found("related", ctx.norm_file, ctx.graph);
    };
    let n = neighbors(node, ctx.graph);
    let mut lines = vec![
        format!("file\t{}", node.rel),
        format!("language\t{}", node.lang),
        format!("imports\t{}", n.imports.len()),
        format!("dependents\t{}", n.dependents.len()),
        format!("related\t{}", n.related.len()),
        String::new(),
        "# imports".to_string(),
    ];
    lines.push(list_or_none(&n.imports));
    lines.push(String::new());
    lines.push("# dependents".to_string());
    lines.push(list_or_none(&n.dependents));
    if !n.related.is_empty() {
        lines.push(String::new());
        lines.push("# related".to_string());
        lines.extend(cap_list(n.related, LIST_CAP));
    }
    lines.join("\n")
}

fn list_or_none(items: &[String]) -> String {
    if items.is_empty() {
        "(none)".to_string()
    } else {
        cap_list(items.to_vec(), LIST_CAP).join("\n")
    }
}

pub(super) fn impact(ctx: &Ctx<'_>) -> String {
    let Some(node) = ctx.node else {
        return file_not_found("impact", ctx.norm_file, ctx.graph);
    };
    let target = ctx.args.symbol.clone().unwrap_or_default();
    let n = neighbors(node, ctx.graph);
    let symbols: Vec<String> = if target.is_empty() {
        let mut names: Vec<String> = Vec::new();
        for s in &node.symbols {
            if !s.name.is_empty() && !names.contains(&s.name) {
                names.push(s.name.clone());
            }
        }
        names.truncate(8);
        names
    } else {
        vec![target.clone()]
    };
    struct Row {
        symbol: String,
        references: usize,
        callers: Vec<String>,
    }
    let mut rows: Vec<Row> = Vec::new();
    let mut external_callers: Vec<String> = Vec::new();
    let mut external_references = 0;
    for symbol in &symbols {
        let (entries, _) = reference_entries(ctx.graph, symbol, Some(node.lang), Scope::default());
        let refs: Vec<_> = entries.iter().filter(|e| e.file != node.rel).collect();
        if refs.is_empty() {
            continue;
        }
        let mut callers: Vec<String> = refs.iter().map(|e| e.file.clone()).collect();
        callers.sort();
        callers.dedup();
        for c in &callers {
            if !external_callers.contains(c) {
                external_callers.push(c.clone());
            }
        }
        external_references += refs.len();
        rows.push(Row {
            symbol: symbol.clone(),
            references: refs.len(),
            callers,
        });
    }
    external_callers.sort();
    rows.sort_by(|a, b| {
        b.references
            .cmp(&a.references)
            .then_with(|| name_cmp(&a.symbol, &b.symbol))
    });
    let mut lines = vec![
        format!("file\t{}", node.rel),
        format!("language\t{}", node.lang),
        format!("imports\t{}", n.imports.len()),
        format!("dependents\t{}", n.dependents.len()),
        format!("related\t{}", n.related.len()),
        format!("scanned_symbols\t{}", symbols.len()),
        format!("external_references\t{external_references}"),
        format!("external_callers\t{}", external_callers.len()),
    ];
    if !target.is_empty() {
        lines.push(format!("symbol\t{target}"));
    }
    if !n.related.is_empty() {
        lines.push(String::new());
        lines.push("# structural".to_string());
        lines.extend(cap_list(n.related, LIST_CAP));
    }
    if !rows.is_empty() {
        lines.push(String::new());
        lines.push(if target.is_empty() { "# top symbol impact" } else { "# symbol impact" }.to_string());
        for row in rows.iter().take(5) {
            let suffix = if row.callers.is_empty() {
                String::new()
            } else {
                format!(" -> {}", row.callers.join(", "))
            };
            lines.push(format!(
                "{}\trefs={}\tcallers={}{suffix}",
                row.symbol,
                row.references,
                row.callers.len()
            ));
        }
    }
    if !external_callers.is_empty() {
        lines.push(String::new());
        lines.push("# external callers".to_string());
        lines.extend(cap_list(external_callers, LIST_CAP));
    }
    lines.join("\n")
}

struct Anchor {
    rel: Option<String>,
    norm: Option<String>,
    note: Option<String>,
}

fn infer_anchor(ctx: &Ctx<'_>) -> Result<Anchor, String> {
    let candidates: Vec<String> = ctx
        .args
        .symbols
        .iter()
        .cloned()
        .chain(ctx.args.symbol.clone())
        .filter(|s| !s.trim().is_empty())
        .collect();
    for s in &candidates {
        let hits = find_hits(ctx.graph, s, None);
        let usable: Vec<&Hit> = hits.iter().filter(|h| ctx.graph.node(&h.rel).is_some()).collect();
        let mut pool: Vec<&Hit> = if usable.is_empty() { hits.iter().collect() } else { usable };
        if pool.is_empty() {
            continue;
        }
        pool.sort_by(|a, b| name_cmp(&a.rel, &b.rel));
        let primary = pool.iter().find(|h| h.declaration_like).unwrap_or(&pool[0]);
        let mut note = format!("# note: dependents resolved from symbol '{s}' → {}", primary.rel);
        let mut others: Vec<&str> = Vec::new();
        for h in &pool {
            if h.rel != primary.rel && !others.contains(&h.rel.as_str()) {
                others.push(&h.rel);
            }
        }
        if !others.is_empty() {
            note.push_str(&format!("\n# note: '{s}' also defined in: {}", others.join(", ")));
        }
        return Ok(Anchor {
            rel: Some(primary.rel.clone()),
            norm: Some(primary.rel.clone()),
            note: Some(note),
        });
    }
    let path_like = candidates.iter().find(|s| {
        s.contains(['/', '\\'])
            || s.rsplit_once('.')
                .is_some_and(|(_, ext)| mixdog_graph::lang::lang_for(ext).is_some())
    });
    if let Some(p) = path_like {
        let abs = super::roots::abs_from(ctx.cwd, p);
        let rel = super::dispatch::display_rel(&abs, ctx.cwd);
        if ctx.graph.node(&rel).is_some() {
            return Ok(Anchor {
                rel: Some(rel),
                norm: Some(p.clone()),
                note: Some(format!("# note: treated symbol '{p}' as file")),
            });
        }
    }
    Err(if candidates.is_empty() {
        "code_graph dependents: \"file\" is required (no file or symbol supplied)".to_string()
    } else {
        format!(
            "code_graph dependents: dependents needs file:<path>; got symbol only (tried: {})",
            candidates.join(", ")
        )
    })
}

/// `dep:line` when the importer's source shows the import line, else `dep`.
fn import_line_ref(graph: &Graph, dep: &str, basename: &str, stem: &str) -> String {
    let Some(node) = graph.node(dep) else {
        return dep.to_string();
    };
    let importish = regex::Regex::new(r#"(?:^|\W)(?:import|require)\b|\bfrom\s*['"]"#)
        .expect("static pattern");
    for (i, line) in node.lines().iter().enumerate() {
        if !importish.is_match(line) {
            continue;
        }
        if line.contains(&format!("/{basename}"))
            || line.contains(&format!("/{stem}"))
            || line.contains(&format!("'{basename}'"))
            || line.contains(&format!("\"{basename}\""))
        {
            return format!("{dep}:{}", i + 1);
        }
    }
    dep.to_string()
}

pub(super) fn dependents(ctx: &Ctx<'_>) -> Result<String, String> {
    let anchor = if ctx.rel.is_some() || ctx.norm_file.is_some() {
        Anchor {
            rel: ctx.rel.clone(),
            norm: ctx.norm_file.map(str::to_string),
            note: None,
        }
    } else {
        infer_anchor(ctx)?
    };
    let Some(anchor_rel) = anchor.rel.as_deref().filter(|r| ctx.graph.node(r).is_some()) else {
        return Ok(file_not_found("dependents", anchor.norm.as_deref(), ctx.graph));
    };
    let all = ctx.graph.dependents(anchor_rel);
    if all.is_empty() {
        return Ok("(no dependents)".to_string());
    }
    let basename = anchor_rel.rsplit('/').next().unwrap_or(anchor_rel);
    let stem = basename.rsplit_once('.').map_or(basename, |(s, _)| s);
    let body = all
        .iter()
        .take(LIST_CAP)
        .map(|dep| import_line_ref(ctx.graph, dep, basename, stem))
        .collect::<Vec<_>>()
        .join("\n");
    let out = match &anchor.note {
        Some(note) => format!("{note}\n{body}"),
        None => body,
    };
    Ok(if all.len() > LIST_CAP {
        format!("{out}\n[truncated — showing first {LIST_CAP} of {} dependents]", all.len())
    } else {
        out
    })
}

pub(super) fn symbols(ctx: &Ctx<'_>) -> String {
    match ctx.node {
        Some(node) => filter_symbol_outline(node, ctx.args),
        None => file_not_found("symbols", ctx.norm_file, ctx.graph),
    }
}

pub(super) fn symbol_search(ctx: &Ctx<'_>) -> Result<String, String> {
    let limit = ctx.args.limit.unwrap_or(30.0).clamp(1.0, 100.0) as usize;
    let mut keywords: Vec<String> = ctx
        .args
        .symbols
        .iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    if keywords.is_empty() {
        keywords.extend(ctx.args.symbol.clone());
    }
    if keywords.is_empty() {
        return Err("code_graph symbol_search: \"symbol\" (or \"symbols[]\") is required.".to_string());
    }
    if ctx.rel.is_some() && ctx.node.is_none() {
        return Ok(file_not_found("symbol_search", ctx.norm_file, ctx.graph));
    }
    let search = |kw: &str| search_keyword(ctx, kw, limit);
    if keywords.len() == 1 {
        return Ok(search(&keywords[0]));
    }
    let mut seen: Vec<String> = Vec::new();
    let mut sections: Vec<String> = Vec::new();
    for kw in &keywords {
        let result = search(kw);
        if seen.contains(&result) {
            continue;
        }
        sections.push(format!("# symbol_search: {kw}\n{result}"));
        seen.push(result);
    }
    Ok(sections.join("\n\n"))
}

// ── keyword matching ───────────────────────────────────────────────────────

fn tokenize_keyword(s: &str) -> Vec<String> {
    let mut spaced = String::new();
    let mut prev: Option<char> = None;
    for c in s.chars() {
        if let Some(p) = prev
            && (p.is_ascii_lowercase() || p.is_ascii_digit())
            && c.is_ascii_uppercase()
        {
            spaced.push(' ');
        }
        spaced.push(c);
        prev = Some(c);
    }
    spaced
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|t| !t.is_empty())
        .map(str::to_lowercase)
        .collect()
}

fn token_start_offsets(sym: &str) -> Vec<usize> {
    let mut starts = Vec::new();
    let (mut prev_alnum, mut prev_upper) = (false, false);
    for (i, c) in sym.chars().enumerate() {
        if !c.is_ascii_alphanumeric() {
            prev_alnum = false;
            prev_upper = false;
            continue;
        }
        let upper = c.is_ascii_uppercase();
        if !prev_alnum || (upper && !prev_upper) {
            starts.push(i);
        }
        prev_alnum = true;
        prev_upper = upper;
    }
    starts
}

fn contiguous_match_token_aligned(sym: &str, lower_key: &str) -> bool {
    let len = lower_key.chars().count();
    if len == 0 {
        return false;
    }
    let sym_lower: Vec<char> = sym.to_lowercase().chars().collect();
    let key: Vec<char> = lower_key.chars().collect();
    let starts = token_start_offsets(sym);
    let lead = key
        .iter()
        .position(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        .unwrap_or(len);
    let mut from = 0;
    while from + len <= sym_lower.len() {
        let Some(idx) = (from..=sym_lower.len() - len).find(|i| sym_lower[*i..*i + len] == key[..])
        else {
            return false;
        };
        let end = idx + len;
        let effective = idx + lead;
        if starts.contains(&effective) {
            return true;
        }
        if !starts.iter().any(|s| *s > effective && *s < end) {
            return true;
        }
        from = idx + 1;
    }
    false
}

fn ordered_token_match(sym_lower: &str, tokens: &[String]) -> bool {
    let mut from = 0;
    for t in tokens {
        match sym_lower[from..].find(t.as_str()) {
            Some(i) => from += i + t.len(),
            None => return false,
        }
    }
    true
}

fn keyword_matches(name: &str, lower_key: &str, tokens: &[String]) -> bool {
    let sym = name.trim();
    if sym.is_empty() || lower_key.is_empty() {
        return false;
    }
    contiguous_match_token_aligned(sym, lower_key)
        || (tokens.len() >= 2 && ordered_token_match(&sym.to_lowercase(), tokens))
}

fn keyword_sort_key(name: &str, keyword: &str) -> Option<(usize, usize, usize)> {
    let lower_name = name.to_lowercase();
    let idx = lower_name.find(&keyword.to_lowercase())?;
    Some((
        lower_name.chars().count(),
        usize::from(idx != 0),
        lower_name[..idx].chars().count(),
    ))
}

struct Entry {
    name: String,
    hit: Option<Hit>,
}

fn compare_entries(a: &Entry, b: &Entry, keyword: &str) -> std::cmp::Ordering {
    match (keyword_sort_key(&a.name, keyword), keyword_sort_key(&b.name, keyword)) {
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => name_cmp(&a.name, &b.name),
        (Some(ka), Some(kb)) => ka.cmp(&kb).then_with(|| name_cmp(&a.name, &b.name)),
    }
}

fn search_keyword(ctx: &Ctx<'_>, keyword: &str, limit: usize) -> String {
    let clean = keyword.trim();
    if clean.is_empty() {
        return "(no keyword)".to_string();
    }
    let cap = limit.clamp(1, 100);
    let lower_key = clean.to_lowercase();
    let key_tokens = tokenize_keyword(clean);
    let scope = ctx.scope();
    let language = ctx.language();
    let mut by_name: Vec<(String, Vec<Hit>)> = Vec::new();
    for node in &ctx.graph.nodes {
        if language.is_some_and(|l| node.lang != l) || !scope.contains(&node.rel) {
            continue;
        }
        for sym in &node.symbols {
            let name = sym.name.trim();
            if !keyword_matches(name, &lower_key, &key_tokens) {
                continue;
            }
            let slot = match by_name.iter().position(|(n, _)| n == name) {
                Some(i) => i,
                None => {
                    by_name.push((name.to_string(), Vec::new()));
                    by_name.len() - 1
                }
            };
            if let Some(hit) = native_hit(node, sym) {
                by_name[slot].1.push(hit);
            }
        }
    }
    let mut entries: Vec<Entry> = by_name
        .into_iter()
        .map(|(name, hits)| Entry {
            hit: pick_declaration(&hits, None),
            name,
        })
        .collect();
    if entries.is_empty() {
        let scope_label = ctx
            .rel
            .clone()
            .or_else(|| ctx.scope_prefix.clone())
            .map(|s| format!(" scope={s}"))
            .unwrap_or_default();
        return format!(
            "(no symbol keyword matches in cwd={}{scope_label})\ngraph: nodes={}{}",
            ctx.cwd_text(),
            ctx.graph.nodes.len(),
            language.map(|l| format!(", language={l}")).unwrap_or_default()
        );
    }
    entries.sort_by(|a, b| {
        b.hit
            .is_some()
            .cmp(&a.hit.is_some())
            .then_with(|| compare_entries(a, b, clean))
    });
    let resolved: Vec<&Entry> = entries.iter().filter(|e| e.hit.is_some()).collect();
    let unresolved: Vec<&str> = entries
        .iter()
        .filter(|e| e.hit.is_none())
        .map(|e| e.name.as_str())
        .collect();
    let shown = &resolved[..resolved.len().min(cap)];
    let mut lines = vec![format!(
        "# search keyword={clean} matches={} shown={}",
        entries.len(),
        shown.len()
    )];
    for e in shown {
        let Some(hit) = &e.hit else { continue };
        let facts = hit.facts();
        lines.push(format!(
            "{}\t{}{}{}",
            e.name,
            hit.location(),
            if facts.is_empty() { String::new() } else { format!("\t{facts}") },
            hit.sig.as_ref().map(|s| format!("\t{s}")).unwrap_or_default()
        ));
    }
    if resolved.len() > shown.len() {
        lines.push(format!("...+{} more resolved (cap={cap})", resolved.len() - shown.len()));
    }
    if !unresolved.is_empty() {
        lines.push(format!(
            "+{} unresolved name variants (token-only, no declaration — find_symbol will miss these; grep to locate): {}",
            unresolved.len(),
            unresolved.join(", ")
        ));
    }
    if ctx.graph.truncated {
        lines.push(format!("WARN: graph truncated at CODE_GRAPH_MAX_FILES={MAX_FILES} — matches may be incomplete. Re-run with a narrower cwd."));
    }
    lines.join("\n")
}

// ── declaration lookup ─────────────────────────────────────────────────────

pub(super) fn find_symbol(ctx: &Ctx<'_>) -> Result<String, String> {
    // `findSymbolTool` checks the anchor before the symbol, and words the miss as its own tool's.
    if ctx.rel.is_some() && ctx.node.is_none() {
        let shown = ctx.norm_file.unwrap_or("(missing file)");
        return Ok(append_same_basename_hint(
            format!("Error: find_symbol: file not found in graph: {shown}"),
            ctx.norm_file,
            ctx.graph,
        ));
    }
    let symbol = ctx
        .args
        .symbol
        .clone()
        .ok_or_else(|| "find_symbol: provide \"symbol\" (to locate) or \"file\" (to list its symbols).".to_string())?;
    let limit = ctx.args.limit.unwrap_or(20.0).clamp(1.0, 50.0) as usize;
    let file_rel = ctx.rel.as_deref();
    let in_scope = |rel: &str| file_rel.is_none_or(|f| rel == f);
    let outside = if file_rel.is_some() {
        declaration_outside_scope(ctx.graph, &symbol, ctx.language(), &in_scope)
    } else {
        None
    };
    Ok(find_symbol_across_graph(
        ctx.graph,
        &symbol,
        &ctx.cwd_text(),
        FindOptions {
            language: ctx.language(),
            limit,
            file_rel,
            body: ctx.args.body != Some(false),
            outside,
            scope_note: (ctx.cwd != ctx.default_cwd).then(|| ctx.cwd_text()),
        },
    ))
}

pub(super) fn references(ctx: &Ctx<'_>) -> Result<String, String> {
    let symbol = required_symbol("references", ctx.args)?;
    let language = ctx.language();
    if let Some(l) = language
        && !ctx.graph.nodes.iter().any(|n| n.lang == l)
    {
        return Err(format!(
            "code_graph references: language '{l}' has no adapter topLevelTypes and is not in supportedRegexLangs for this project"
        ));
    }
    let narrowed = ctx.rel.is_some() || ctx.scope_prefix.is_some() || language.is_some();
    let lang = match scoped_call_context("references", ctx, &symbol)? {
        Ok(lang) => lang,
        Err(text) => return Ok(text),
    };
    let limit = ctx.args.user_limit().unwrap_or(200);
    let list = format_references(ctx.graph, &symbol, lang.as_deref(), ctx.scope(), limit);
    let list = if narrowed {
        list
    } else {
        super::hits::augment_no_hit(list, "(no references)", ctx.graph, &ctx.cwd_text(), &symbol)
    };
    let declaration = find_symbol_across_graph(
        ctx.graph,
        &symbol,
        &ctx.cwd_text(),
        FindOptions {
            language: lang.as_deref(),
            limit: 1,
            file_rel: ctx.rel.as_deref(),
            body: ctx.args.body == Some(true),
            outside: None,
            // Node's references mode passes no `defaultCwd`, so its declaration never notes a scope.
            scope_note: None,
        },
    );
    Ok(format!("# declaration\n{declaration}\n\n# references\n{list}"))
}

/// Resolve the language a scoped call query runs with, or the answer when the anchor does
/// not hold the symbol.
fn scoped_call_context(
    mode: &str,
    ctx: &Ctx<'_>,
    symbol: &str,
) -> Result<Result<Option<String>, String>, String> {
    let explicit = ctx.language().map(str::to_string);
    let narrowed = ctx.rel.is_some() || ctx.scope_prefix.is_some() || explicit.is_some();
    let resolved: Option<&Node> = if ctx.rel.is_some() {
        let Some(node) = ctx.node else {
            return Ok(Err(file_not_found(mode, ctx.norm_file, ctx.graph)));
        };
        if node.has_token(symbol) || node.text.contains(symbol) {
            Some(node)
        } else {
            return Ok(Err(format!(
                "Error: code_graph {mode}: symbol \"{symbol}\" not found in {}",
                ctx.norm_file.map(str::to_string).or(ctx.rel.clone()).unwrap_or_default()
            )));
        }
    } else {
        let hits = find_hits(ctx.graph, symbol, ctx.language());
        pick_declaration(&hits, None).and_then(|h| ctx.graph.node(&h.rel))
    };
    let lang = explicit.or_else(|| {
        (narrowed && resolved.is_some())
            .then(|| resolved.map(|n| n.lang.to_string()))
            .flatten()
    });
    Ok(Ok(lang))
}

pub(super) fn callers(ctx: &Ctx<'_>) -> Result<String, String> {
    let symbol = required_symbol("callers", ctx.args)?;
    let narrowed = ctx.rel.is_some() || ctx.scope_prefix.is_some() || ctx.language().is_some();
    let lang = match scoped_call_context("callers", ctx, &symbol)? {
        Ok(lang) => lang,
        Err(text) => return Ok(text),
    };
    let user_limit = ctx.args.user_limit();
    let depth = ctx
        .args
        .depth
        .map_or(1.0, |d| if d.is_finite() { d.floor() } else { 1.0 })
        .clamp(1.0, 5.0) as usize;
    if depth > 1 {
        return Ok(format_transitive_callers(
            ctx.graph,
            &symbol,
            &ctx.cwd_text(),
            TransitiveOptions {
                language: lang.as_deref(),
                depth,
                page_size: user_limit.unwrap_or(100),
                page: ctx.args.page.map_or(1, |p| p.max(1.0) as usize),
                scope: ctx.scope(),
            },
        ));
    }
    let result = format_callers(
        ctx.graph,
        &symbol,
        lang.as_deref(),
        ctx.scope(),
        user_limit.unwrap_or(200),
    );
    Ok(if narrowed {
        result
    } else {
        super::hits::augment_no_hit(result, "(no callers)", ctx.graph, &ctx.cwd_text(), &symbol)
    })
}

pub(super) fn callees(ctx: &Ctx<'_>) -> Result<String, String> {
    let symbol = required_symbol("callees", ctx.args)?;
    if ctx.rel.is_some() && ctx.node.is_none() {
        return Ok(file_not_found("callees", ctx.norm_file, ctx.graph));
    }
    let all = find_hits(ctx.graph, &symbol, ctx.language());
    let hits: Vec<Hit> = match &ctx.rel {
        Some(rel) => all.into_iter().filter(|h| &h.rel == rel).collect(),
        None => all,
    };
    let Some(decl) = hits.iter().find(|h| h.declaration_like).or(hits.first()) else {
        let scope_note = ctx.rel.as_ref().map(|r| format!(" file={r}")).unwrap_or_default();
        return Ok(format!("(no symbol matches in cwd={}{scope_note})", ctx.cwd_text()));
    };
    Ok(format_callees(ctx.graph, &decl.rel, &symbol, ctx.language()))
}

/// Used by the dispatcher to anchor caller scans (kept here with the other call helpers).
#[allow(dead_code)]
pub(super) fn target_rels(ctx: &Ctx<'_>, symbol: &str) -> Vec<String> {
    caller_target_rels(ctx.graph, symbol, ctx.language(), ctx.scope())
}
