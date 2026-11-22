//! The thirteen mode answers over a built graph. A mode handler gets the resolved anchor
//! (`rel`/`node` for a file, `scope_prefix` for a directory) and returns its text.

use std::{cmp::Ordering, collections::HashMap, path::Path};

use super::args::Args;
use super::graph::{Graph, Node};
use super::hits::{
    FindOptions, Hit, compare_native_declarations, declaration_outside_scope, find_hits, find_symbol_across_graph, native_hit, pick_declaration,
};
use super::outline::outline_rows;
use super::refs::{Scope, TransitiveOptions, format_callees, format_callers, format_references, format_transitive_callers, importer_references};
use super::symbols::Sym;
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
    /// Node names the graph root by the explicit `cwd` argument as written (`baseCwd = args.cwd.trim()`) when the
    /// call ran there, else by the resolved root.
    fn cwd_text(&self) -> String {
        match self.args.cwd.as_deref().map(str::trim) {
            Some(raw) if super::roots::path_key(&super::roots::abs_from(self.default_cwd, raw)) == super::roots::path_key(self.cwd) => raw.to_owned(),
            _ => self.cwd.to_string_lossy().into_owned(),
        }
    }

    fn scope(&self) -> Scope<'_> {
        Scope { file_rel: self.rel.as_deref(), prefix: self.scope_prefix.as_deref() }
    }

    fn language(&self) -> Option<&str> {
        self.args.language.as_deref()
    }
}

pub(super) fn file_not_found(mode: &str, norm_file: Option<&str>, graph: &Graph) -> String {
    let shown = norm_file.unwrap_or("(missing file)");
    append_same_basename_hint(format!("Error: code_graph {mode}: file not found in graph: {shown}"), norm_file, graph)
}

/// Why a file the graph does not hold is not there, as far as the disk says: absence from the graph proves only that, so
/// "exists on disk" is said only of a path observed there, and a cause only when it is known (a type the graph does not
/// index, a file over the size limit, a graph that left files out).
fn not_in_graph(file: &str, graph: &Graph) -> String {
    let path = std::path::Path::new(file);
    let path = if path.is_absolute() { path.to_path_buf() } else { graph.root().join(file) };
    // A file the graph could not verify this time is unknown, not absent.
    if let Ok(rel) = path.strip_prefix(graph.root())
        && graph.unverified.iter().any(|u| *u == rel.to_string_lossy().replace('\\', "/"))
    {
        return " — the file changed while it was being read, so it is not in the graph this time; ask again.".to_owned();
    }
    match mixdog_fsio::metadata(&mixdog_fsio::Unlaned, &path) {
        Ok(meta) if meta.is_dir() => " — that path is a directory on disk, not a file; name a file in it.".to_owned(),
        Ok(meta) => {
            let cause = if path.extension().and_then(|e| e.to_str()).and_then(mixdog_graph::lang::lang_for).is_none() {
                "; its type is not one the graph indexes".to_owned()
            } else if meta.len() > mixdog_graph::MAX_FILE_BYTES {
                "; it is larger than the size the graph indexes".to_owned()
            } else {
                String::new()
            };
            format!(" — it exists on disk but is not in this graph{cause}; use grep/read on it directly.")
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => " — no file exists at that path on disk.".to_owned(),
        Err(e) => format!(" — it is not in this graph, and the disk could not be checked: {e}."),
    }
}

pub(super) fn append_same_basename_hint(message: String, norm_file: Option<&str>, graph: &Graph) -> String {
    let raw = norm_file.unwrap_or("").replace('\\', "/");
    let base = raw.rsplit('/').next().unwrap_or("").to_lowercase();
    if base.is_empty() {
        return message;
    }
    let matches: Vec<&str> =
        graph.nodes.iter().map(|n| n.rel.as_str()).filter(|rel| rel.rsplit('/').next().unwrap_or("").to_lowercase() == base).take(3).collect();
    let why = not_in_graph(norm_file.unwrap_or(""), graph);
    if matches.is_empty() {
        return format!("{message}{why}");
    }
    let listed = matches.iter().map(|m| format!("\"{m}\"")).collect::<Vec<_>>().join(", ");
    format!("{message}{why} If you meant the indexed source, same filename is indexed at: {listed}.")
}

fn required_symbol(mode: &str, args: &Args) -> Result<String, String> {
    args.symbol.clone().ok_or_else(|| format!("code_graph {mode}: \"symbol\" is required."))
}

/// A file's outline, optionally narrowed to the rows that mention a keyword.
pub(super) fn filter_symbol_outline(node: &Node, args: &Args) -> String {
    let keywords = args.symbol_list();
    let items = outline_rows(node, None, 0);
    if items.is_empty() {
        return "(no symbols)".to_string();
    }
    let cap = args.user_limit();
    let bound = |rows: Vec<String>| match cap {
        Some(limit) if rows.len() > limit => {
            let more = rows.len() - limit;
            let mut kept: Vec<String> = rows.into_iter().take(limit).collect();
            kept.push(format!("[+{more} more symbols — raise limit to see them]"));
            kept
        }
        Some(_) => rows,
        None => cap_list(rows, LIST_CAP),
    };
    if keywords.is_empty() {
        return bound(items).join("\n");
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
        let quoted = keywords.iter().map(|k| serde_json::to_string(k).unwrap_or_default()).collect::<Vec<_>>().join(", ");
        return format!("(no symbols matching {quoted})");
    }
    bound(lines).join("\n")
}

fn explainer_summary(ctx: &Ctx<'_>, node: &Node) -> String {
    let imports_all = &node.resolved_imports;
    let imports: Vec<&str> = imports_all.iter().take(8).map(String::as_str).collect();
    let outline = outline_rows(node, Some(ctx.args.depth.unwrap_or(1.0)), 120);
    let mut parts = vec![format!("file: {}", node.rel), format!("language: {}", node.lang)];
    if !outline.is_empty() {
        parts.push(format!("outline:\n{}", outline.join("\n")));
    }
    if !imports.is_empty() {
        let more = imports_all.len() - imports.len();
        parts.push(format!(
            "imports: {}{}",
            imports.join(", "),
            if more > 0 { format!(", … +{more} more (mode:imports for full list)") } else { String::new() }
        ));
    }
    if outline.is_empty() {
        let head = node.read().text().split('\n').take(6).collect::<Vec<_>>().join("\n");
        let head = super::util::head_chars(head.trim(), 420);
        if !head.is_empty() {
            parts.push(format!("head:\n{head}"));
        }
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
    lines.push(format!("edges\t{}", scoped.iter().map(|n| n.resolved_imports.len()).sum::<usize>()));
    lines.extend(by_lang.iter().map(|(l, c)| format!("{l}\t{c}")));
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
        parts.push(format!("# raw\n{}", raw.iter().map(|s| s.as_str()).collect::<Vec<_>>().join("\n")));
    }
    if node.resolved_imports.len() > resolved.len() || node.raw_imports.len() > raw.len() {
        parts.push(format!("[truncated — showing first {LIST_CAP} of {} resolved / {} raw imports]", node.resolved_imports.len(), node.raw_imports.len()));
    }
    if parts.is_empty() { "(no imports)".to_string() } else { parts.join("\n\n") }
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
    Neighbors { imports, dependents, related }
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
    if items.is_empty() { "(none)".to_string() } else { cap_list(items.to_vec(), LIST_CAP).join("\n") }
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
            if !s.name.is_empty() && !names.iter().any(|n| n == s.name) {
                names.push(s.name.to_owned());
            }
        }
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
        let refs = importer_references(ctx.graph, &node.rel, symbol);
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
        rows.push(Row { symbol: symbol.clone(), references: refs.len(), callers });
    }
    external_callers.sort();
    rows.sort_by(|a, b| b.references.cmp(&a.references).then_with(|| name_cmp(&a.symbol, &b.symbol)));
    let mut lines = vec![
        "# impact: importer-restricted name matches; not binding-resolved references.".to_string(),
        "# Counts include import/declaration occurrences and unrelated same-named identifiers.".to_string(),
        "# Aliases, namespace members, and unrecognized re-export paths may be missed.".to_string(),
        "# Zero matches does not establish that a symbol is unused; verify with grep/read.".to_string(),
        format!("file\t{}", node.rel),
        format!("language\t{}", node.lang),
        format!("imports\t{}", n.imports.len()),
        format!("dependents\t{}", n.dependents.len()),
        format!("related\t{}", n.related.len()),
        format!("scanned_symbols\t{}", symbols.len()),
        format!("external_name_matches\t{external_references}"),
        format!("matching_files\t{}", external_callers.len()),
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
        lines.push("# symbol name matches".to_string());
        let shown: Vec<String> = rows
            .iter()
            .map(|row| {
                let suffix = if row.callers.is_empty() { String::new() } else { format!(" -> {}", row.callers.join(", ")) };
                format!("{}\tname_matches={}\tfiles={}{suffix}", row.symbol, row.references, row.callers.len())
            })
            .collect();
        lines.extend(cap_list(shown, LIST_CAP));
    }
    if !external_callers.is_empty() {
        lines.push(String::new());
        lines.push("# matching files".to_string());
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
    let candidates: Vec<String> = ctx.args.symbols.iter().cloned().chain(ctx.args.symbol.clone()).filter(|s| !s.trim().is_empty()).collect();
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
        return Ok(Anchor { rel: Some(primary.rel.clone()), norm: Some(primary.rel.clone()), note: Some(note) });
    }
    let path_like =
        candidates.iter().find(|s| s.contains(['/', '\\']) || s.rsplit_once('.').is_some_and(|(_, ext)| mixdog_graph::lang::lang_for(ext).is_some()));
    if let Some(p) = path_like {
        let abs = super::roots::abs_from(ctx.cwd, p);
        let rel = super::dispatch::display_rel(&abs, ctx.cwd);
        if ctx.graph.node(&rel).is_some() {
            return Ok(Anchor { rel: Some(rel), norm: Some(p.clone()), note: Some(format!("# note: treated symbol '{p}' as file")) });
        }
    }
    Err(if candidates.is_empty() {
        "code_graph dependents: \"file\" is required (no file or symbol supplied)".to_string()
    } else {
        format!("code_graph dependents: dependents needs file:<path>; got symbol only (tried: {})", candidates.join(", "))
    })
}

/// `dep:line` when the importer's source shows the import line, else `dep`.
fn import_line_ref(graph: &Graph, dep: &str, basename: &str, stem: &str) -> String {
    let Some(node) = graph.node(dep) else {
        return dep.to_string();
    };
    let importish = regex::Regex::new(r#"(?:^|\W)(?:import|require)\b|\bfrom\s*['"]"#).expect("static pattern");
    let source = node.read();
    for (i, line) in source.lines().iter().enumerate() {
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
        Anchor { rel: ctx.rel.clone(), norm: ctx.norm_file.map(str::to_string), note: None }
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
    let body = all.iter().take(LIST_CAP).map(|dep| import_line_ref(ctx.graph, dep, basename, stem)).collect::<Vec<_>>().join("\n");
    let out = match &anchor.note {
        Some(note) => format!("{note}\n{body}"),
        None => body,
    };
    Ok(if all.len() > LIST_CAP { format!("{out}\n[truncated — showing first {LIST_CAP} of {} dependents]", all.len()) } else { out })
}

pub(super) fn symbols(ctx: &Ctx<'_>) -> String {
    match ctx.node {
        Some(node) => filter_symbol_outline(node, ctx.args),
        None => file_not_found("symbols", ctx.norm_file, ctx.graph),
    }
}

pub(super) fn symbol_search(ctx: &Ctx<'_>) -> Result<String, String> {
    let limit = ctx.args.limit.unwrap_or(30.0).clamp(1.0, 100.0) as usize;
    let mut keywords: Vec<String> = ctx.args.symbols.iter().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
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
    spaced.split(|c: char| !c.is_ascii_alphanumeric()).filter(|t| !t.is_empty()).map(str::to_lowercase).collect()
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

fn contiguous_match_token_aligned(sym: &str, sym_lower: &str, key: &[char], lead: usize) -> bool {
    let len = key.len();
    let sym_lower: Vec<char> = sym_lower.chars().collect();
    let starts = token_start_offsets(sym);
    let mut from = 0;
    while from + len <= sym_lower.len() {
        let Some(idx) = (from..=sym_lower.len() - len).find(|i| sym_lower[*i..*i + len] == key[..]) else {
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

struct Entry<'a> {
    name: &'a str,
    lower_name: String,
    rank: Option<(usize, usize, usize)>,
    declaration: Option<(&'a Node, Sym<'a>)>,
}

fn compare_entries(a: &Entry<'_>, b: &Entry<'_>) -> Ordering {
    match (a.rank, b.rank) {
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        (ka, kb) => ka.cmp(&kb).then_with(|| a.lower_name.cmp(&b.lower_name)).then_with(|| b.name.cmp(a.name)),
    }
}

fn search_keyword(ctx: &Ctx<'_>, keyword: &str, limit: usize) -> String {
    let clean = keyword.trim();
    if clean.is_empty() {
        return "(no keyword)".to_string();
    }
    let cap = limit.clamp(1, 100);
    let lower_key = clean.to_lowercase();
    let key: Vec<char> = lower_key.chars().collect();
    let lead = key.iter().position(|c| c.is_ascii_lowercase() || c.is_ascii_digit()).unwrap_or(key.len());
    let key_tokens = tokenize_keyword(clean);
    let scope = ctx.scope();
    let language = ctx.language();
    let mut by_name: HashMap<&str, Entry<'_>> = HashMap::new();
    let nodes = ctx.node.map_or(ctx.graph.nodes.as_slice(), std::slice::from_ref);
    for node in nodes {
        if language.is_some_and(|l| node.lang != l) || !scope.contains(&node.rel) {
            continue;
        }
        for sym in &node.symbols {
            let name = sym.name.trim();
            let entry = match by_name.entry(name) {
                std::collections::hash_map::Entry::Occupied(entry) => entry.into_mut(),
                std::collections::hash_map::Entry::Vacant(entry) => {
                    let lower_name = name.to_lowercase();
                    let found = lower_name.find(&lower_key);
                    if !(found.is_some() && contiguous_match_token_aligned(name, &lower_name, &key, lead)
                        || key_tokens.len() >= 2 && ordered_token_match(&lower_name, &key_tokens))
                    {
                        continue;
                    }
                    let rank = found.map(|idx| (lower_name.chars().count(), usize::from(idx != 0), lower_name[..idx].chars().count()));
                    entry.insert(Entry { name, lower_name, rank, declaration: None })
                }
            };
            if sym.start_line > 0 && entry.declaration.is_none_or(|current| compare_native_declarations((node, sym), current).is_lt()) {
                entry.declaration = Some((node, sym));
            }
        }
    }
    let total = by_name.len();
    if total == 0 {
        let scope_label = ctx.rel.clone().or_else(|| ctx.scope_prefix.clone()).map(|s| format!(" scope={s}")).unwrap_or_default();
        return format!(
            "(no symbol keyword matches in cwd={}{scope_label})\ngraph: nodes={}{}",
            ctx.cwd_text(),
            ctx.graph.nodes.len(),
            language.map(|l| format!(", language={l}")).unwrap_or_default()
        );
    }
    let (mut resolved, mut unresolved): (Vec<_>, Vec<_>) = by_name.into_values().partition(|e| e.declaration.is_some());
    let resolved_total = resolved.len();
    if resolved_total > cap {
        resolved.select_nth_unstable_by(cap, compare_entries);
        resolved.truncate(cap);
    }
    resolved.sort_unstable_by(compare_entries);
    let mut lines = vec![format!("# search keyword={clean} matches={total} shown={}", resolved.len())];
    for e in resolved {
        let Some(hit) = e.declaration.and_then(|(node, sym)| native_hit(node, &sym)) else { continue };
        let facts = hit.facts();
        lines.push(format!(
            "{}\t{}{}{}",
            e.name,
            hit.location(),
            if facts.is_empty() { String::new() } else { format!("\t{facts}") },
            hit.sig.as_ref().map(|s| format!("\t{s}")).unwrap_or_default()
        ));
    }
    if resolved_total > cap {
        lines.push(format!("...+{} more resolved (cap={cap})", resolved_total - cap));
    }
    if !unresolved.is_empty() {
        unresolved.sort_unstable_by(compare_entries);
        lines.push(format!(
            "+{} unresolved name variants (token-only, no declaration — find_symbol will miss these; grep to locate): {}",
            unresolved.len(),
            unresolved.iter().map(|e| e.name).collect::<Vec<_>>().join(", ")
        ));
    }
    lines.join("\n")
}

// ── declaration lookup ─────────────────────────────────────────────────────

pub(super) fn find_symbol(ctx: &Ctx<'_>) -> Result<String, String> {
    // `findSymbolTool` checks the anchor before the symbol, and words the miss as its own tool's.
    if ctx.rel.is_some() && ctx.node.is_none() {
        let shown = ctx.norm_file.unwrap_or("(missing file)");
        return Ok(append_same_basename_hint(format!("Error: find_symbol: file not found in graph: {shown}"), ctx.norm_file, ctx.graph));
    }
    let symbol = ctx
        .args
        .symbol
        .clone()
        .ok_or_else(|| "find_symbol: provide \"symbols\" to locate declarations, or use mode:\"symbols\" with \"files\" for a file outline.".to_string())?;
    let limit = ctx.args.limit.unwrap_or(20.0).clamp(1.0, 50.0) as usize;
    let file_rel = ctx.rel.as_deref();
    let in_scope = |rel: &str| file_rel.is_none_or(|f| rel == f);
    let outside = if file_rel.is_some() { declaration_outside_scope(ctx.graph, &symbol, ctx.language(), &in_scope) } else { None };
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
        return Err(format!("code_graph references: language '{l}' has no adapter topLevelTypes and is not in supportedRegexLangs for this project"));
    }
    let narrowed = ctx.rel.is_some() || ctx.scope_prefix.is_some() || language.is_some();
    let lang = match scoped_call_context("references", ctx, &symbol)? {
        Ok(lang) => lang,
        Err(text) => return Ok(text),
    };
    let limit = ctx.args.user_limit().unwrap_or(200);
    let list = format_references(ctx.graph, &symbol, lang.as_deref(), ctx.scope(), limit);
    let list = if narrowed { list } else { super::hits::augment_no_hit(list, "(no references)", ctx.graph, &ctx.cwd_text(), &symbol) };
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
fn scoped_call_context(mode: &str, ctx: &Ctx<'_>, symbol: &str) -> Result<Result<Option<String>, String>, String> {
    let explicit = ctx.language().map(str::to_string);
    let narrowed = ctx.rel.is_some() || ctx.scope_prefix.is_some() || explicit.is_some();
    let resolved: Option<&Node> = if ctx.rel.is_some() {
        let Some(node) = ctx.node else {
            return Ok(Err(file_not_found(mode, ctx.norm_file, ctx.graph)));
        };
        if node.has_token(symbol) || node.read().text().contains(symbol) {
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
    let lang = explicit.or_else(|| (narrowed && resolved.is_some()).then(|| resolved.map(|n| n.lang.to_string())).flatten());
    Ok(Ok(lang))
}

pub(super) fn callers(ctx: &Ctx<'_>) -> Result<String, String> {
    let symbol = required_symbol("callers", ctx.args)?;
    // `files` only selects the declaration anchors; callers are searched project-wide, in any language unless
    // `language` says otherwise.
    let lang = if let Some(rel) = &ctx.rel {
        if ctx.node.is_none() {
            return Ok(file_not_found("callers", ctx.norm_file, ctx.graph));
        }
        let declared = find_hits(ctx.graph, &symbol, ctx.language()).iter().any(|h| &h.rel == rel && h.declaration_like);
        if !declared {
            return Ok(format!(
                "(no declaration named '{symbol}' found in the requested files)\n# These files select declaration anchors, not caller-search locations. Verify the declaration with find_symbol or grep."
            ));
        }
        ctx.language().map(str::to_string)
    } else {
        match scoped_call_context("callers", ctx, &symbol)? {
            Ok(lang) => lang,
            Err(text) => return Ok(text),
        }
    };
    let user_limit = ctx.args.user_limit();
    let depth = ctx.args.depth.map_or(1.0, |d| if d.is_finite() { d.floor() } else { 1.0 }).clamp(1.0, 5.0) as usize;
    let result = if depth > 1 {
        format_transitive_callers(
            ctx.graph,
            &symbol,
            TransitiveOptions {
                language: lang.as_deref(),
                depth,
                page_size: user_limit.unwrap_or(100),
                page: ctx.args.page.map_or(1, |p| p.max(1.0) as usize),
                scope: ctx.scope(),
            },
        )
    } else {
        format_callers(ctx.graph, &symbol, lang.as_deref(), ctx.scope(), user_limit.unwrap_or(200))
    };
    if result.trim() != "(no callers)" {
        return Ok(result);
    }
    Ok(format!(
        "(no caller name matches found)\n# Searched indexed declaration files, recognized importers/re-export paths, and unresolved-import candidates within the query scope.\n# This does not establish that '{symbol}' is unused. Aliases, shadowing, namespace members, and non-call uses are not fully resolved; verify with grep/read."
    ))
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
