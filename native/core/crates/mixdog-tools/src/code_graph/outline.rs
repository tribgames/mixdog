//! Outline rows and the containment tree of a file's symbol record.
//!
//! Row grammar (fixed for every language): `{indent}[export ]{kind} {name} (L{start}[-{end}])[  {sig}]`.

use mixdog_graph::outline::SymbolInfo;

use super::graph::Node;
use super::util::one_line;

const DEPTH_MAX: usize = 16;

fn range_contains(outer: &SymbolInfo, inner: &SymbolInfo) -> bool {
    if outer.start_line > inner.start_line || outer.end_line < inner.end_line {
        return false;
    }
    if outer.start_line == inner.start_line && outer.end_line == inner.end_line {
        return outer.start_col < inner.start_col;
    }
    true
}

/// For each symbol, the symbol that owns it. `parent` names the owner; a file that declares
/// the name several times is disambiguated by span. Nothing is guessed from spans alone.
pub(super) fn parent_index(symbols: &[SymbolInfo]) -> Vec<Option<usize>> {
    symbols
        .iter()
        .enumerate()
        .map(|(i, symbol)| {
            if symbol.parent.is_empty() {
                return None;
            }
            let candidates: Vec<usize> = symbols
                .iter()
                .enumerate()
                .filter(|(j, s)| *j != i && s.name == symbol.parent)
                .map(|(j, _)| j)
                .collect();
            let mut owner: Option<usize> = None;
            for &c in &candidates {
                if !range_contains(&symbols[c], symbol) {
                    continue;
                }
                if owner.is_none_or(|o| symbols[c].start_line > symbols[o].start_line) {
                    owner = Some(c);
                }
            }
            if owner.is_none() && candidates.len() == 1 {
                owner = Some(candidates[0]);
            }
            owner
        })
        .collect()
}

/// Owners from the outermost down to (not including) `idx`.
pub(super) fn ancestors(parents: &[Option<usize>], idx: usize) -> Vec<usize> {
    let mut chain = Vec::new();
    let mut seen = vec![idx];
    let mut current = parents[idx];
    while let Some(c) = current {
        if seen.contains(&c) || chain.len() >= DEPTH_MAX {
            break;
        }
        chain.insert(0, c);
        seen.push(c);
        current = parents[c];
    }
    chain
}

/// `Outer/inner` path of a symbol.
pub(super) fn symbol_path(node: &Node, parents: &[Option<usize>], idx: usize) -> String {
    ancestors(parents, idx)
        .into_iter()
        .chain(std::iter::once(idx))
        .map(|i| node.symbols[i].name.as_str())
        .collect::<Vec<_>>()
        .join("/")
}

pub(super) fn row_label(symbol: &SymbolInfo) -> String {
    let start = symbol.start_line;
    let range = if symbol.end_line > start {
        format!("{start}-{}", symbol.end_line)
    } else {
        start.to_string()
    };
    let kind = if symbol.kind.is_empty() {
        "symbol"
    } else {
        symbol.kind
    };
    let name = one_line(&symbol.name);
    let sig = one_line(&symbol.sig);
    let redundant = sig.is_empty() || sig == name || sig == format!("{kind} {name}");
    format!(
        "{}{kind} {name} (L{range}){}",
        if symbol.exported { "export " } else { "" },
        if redundant {
            String::new()
        } else {
            format!("  {sig}")
        }
    )
}

/// Rows ordered by (line, column). `depth` drops rows nested deeper; `cap` bounds the count
/// and announces the cut.
pub(super) fn outline_rows(node: &Node, depth: Option<f64>, cap: usize) -> Vec<String> {
    let parents = parent_index(&node.symbols);
    let max_depth = depth.map(|d| {
        let n = if d.is_finite() { d.floor() } else { 0.0 };
        n.clamp(0.0, 5.0) as usize
    });
    let mut rows: Vec<(usize, &SymbolInfo, usize)> = node
        .symbols
        .iter()
        .enumerate()
        .filter(|(_, s)| !s.name.is_empty() && s.start_line >= 1)
        .map(|(i, s)| (i, s, ancestors(&parents, i).len()))
        .filter(|(_, _, level)| max_depth.is_none_or(|m| *level <= m))
        .collect();
    rows.sort_by_key(|(_, s, _)| (s.start_line, s.start_col));
    let lines: Vec<String> = rows
        .iter()
        .map(|(_, s, level)| format!("{}{}", "  ".repeat(*level), row_label(s)))
        .collect();
    if cap > 0 && lines.len() > cap {
        let more = lines.len() - cap;
        let mut kept: Vec<String> = lines.into_iter().take(cap).collect();
        kept.push(format!(
            "… +{more} more (mode:symbols for the full outline)"
        ));
        return kept;
    }
    lines
}
