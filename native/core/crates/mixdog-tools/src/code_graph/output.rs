//! What `executeCodeGraphTool` wraps around every answer (`code-graph/dispatch.mjs`): the warning
//! about files the graph could not index, then the output budget (`capLineOrientedToolOutput`
//! with `_codeGraphBudgetFooter`, `shared/tool-output-limit.mjs`).
#![allow(
    clippy::disallowed_methods,
    reason = "blocking filesystem reads; the whole call runs as one maintenance-lane job (CodeGraphTool::call)"
)]

use std::path::{Path, PathBuf};

use mixdog_graph::lang::lang_for;
use serde_json::Value;

use super::args::Args;
use super::graph::{Graph, Node};
use super::roots::abs_from;
use crate::fs::common::{cap_marker, format_cap_size};

/// The files a call's graphs held unindexed (`options._parseWarnings`), keyed by absolute path
/// in the order first seen.
#[derive(Default)]
pub(super) struct Warnings(Vec<(PathBuf, String)>);

impl Warnings {
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// `collectGraphParseWarnings` for the graph a section of `mode` answers from. An outline
    /// (`symbols`) or `find_symbol` of one existing file in an indexed language is answered
    /// from that file alone, and Node's one-file graph records no parse error; every other
    /// section reads the whole graph.
    pub fn collect(&mut self, mode: &str, anchor: Option<&str>, base: &Path, root: &Path, graph: &Graph) {
        let one_file = anchor
            .map(|a| abs_from(base, a))
            .is_some_and(|p| p.is_file() && p.extension().and_then(|s| s.to_str()).and_then(lang_for).is_some());
        if one_file && matches!(mode, "symbols" | "find_symbol") {
            return;
        }
        graph.nodes.iter().for_each(|node| self.note(root, node));
    }

    fn note(&mut self, root: &Path, node: &Node) {
        if node.parse_error.is_empty() {
            return;
        }
        let (abs, text) = (root.join(&node.rel), format!("{}: {}", node.rel, node.parse_error));
        match self.0.iter_mut().find(|(seen, _)| *seen == abs) {
            Some(slot) => slot.1 = text,
            None => self.0.push((abs, text)),
        }
    }

    /// `raw` under the warning that results are partial (the first five files named).
    fn prefix(&self, raw: String) -> String {
        if self.0.is_empty() {
            return raw;
        }
        let shown: Vec<&str> = self.0.iter().take(5).map(|(_, text)| text.as_str()).collect();
        format!("[warning] {} source file(s) could not be indexed; graph results are partial:\n{}\n{raw}", self.0.len(), shown.join("\n"))
    }
}

/// `executeCodeGraphTool`'s result for the dispatcher's `raw` text.
pub(super) fn wrap(raw: String, warnings: &Warnings, args: &Args) -> String {
    cap(warnings.prefix(raw), args)
}

/// `CODE_GRAPH_OUTPUT_MAX_BYTES`'s default.
const DEFAULT_MAX_BYTES: usize = 30 * 1024;
const MAX_BYTES_ENV: &str = "MIXDOG_CODE_GRAPH_OUTPUT_MAX_BYTES";

/// `positiveEnvInt`: `parseInt` of the variable when that is a positive number, else the default.
fn max_bytes() -> usize {
    std::env::var(MAX_BYTES_ENV)
        .ok()
        .and_then(|raw| {
            let raw = raw.trim_start();
            let digits: String = raw.strip_prefix('+').unwrap_or(raw).chars().take_while(char::is_ascii_digit).collect();
            digits.parse::<usize>().ok()
        })
        .filter(|bytes| *bytes > 0)
        .unwrap_or(DEFAULT_MAX_BYTES)
}

/// `answer` within the budget: whole lines kept, the omitted tail replaced by a footer naming
/// what to re-query.
fn cap(answer: String, args: &Args) -> String {
    cap_to(answer, max_bytes(), args)
}

fn cap_to(answer: String, cap: usize, args: &Args) -> String {
    if answer.len() <= cap {
        return answer;
    }
    // `split(/\r?\n/)`
    let mut lines: Vec<&str> = answer.split('\n').collect();
    let last = lines.len() - 1;
    for line in &mut lines[..last] {
        *line = line.strip_suffix('\r').unwrap_or(line);
    }
    let (mut lo, mut hi) = (0usize, lines.len());
    let mut best = String::new();
    while lo <= hi {
        let mid = (lo + hi) / 2;
        let kept = &lines[..mid];
        let footer = footer(args, kept, cap);
        let candidate = if kept.is_empty() { footer } else { format!("{}\n{footer}", kept.join("\n")) };
        if candidate.len() <= cap {
            best = candidate;
            lo = mid + 1;
        } else if mid == 0 {
            break;
        } else {
            hi = mid - 1;
        }
    }
    if !best.is_empty() {
        return best;
    }
    let footer = footer(args, &[], cap);
    let mut end = 0;
    for (at, c) in footer.char_indices() {
        if at + c.len_utf8() > cap {
            break;
        }
        end = at + c.len_utf8();
    }
    footer[..end].to_owned()
}

/// `_codeGraphBudgetFooter`: a batch call names the item it was inside of when the cut came.
fn footer(args: &Args, kept: &[&str], cap: usize) -> String {
    let limit = format_cap_size(cap);
    let symbols = args.symbol_list();
    let (label, targets) = if symbols.is_empty() { ("files", args.file_list()) } else { ("symbols", symbols) };
    if targets.len() > 1 {
        let mode = if args.mode == "search" { "symbol_search" } else { args.mode.as_str() };
        let header = format!("# {mode} ");
        let mut current = 0;
        for line in kept {
            if let Some(name) = line.strip_prefix(&header).filter(|name| !name.is_empty())
                && let Some(index) = targets.iter().position(|target| target == name)
            {
                current = index;
            }
        }
        let rest = Value::from(targets[current..].to_vec()).to_string();
        return cap_marker(
            &limit,
            &format!("{label} from index {current} not fully shown"),
            None,
            &format!("re-query {label}={rest} separately"),
        );
    }
    let shown = match targets.first() {
        Some(target) => format!("remainder for {}={} omitted", &label[..label.len() - 1], Value::from(target.as_str())),
        None => "remainder omitted".to_owned(),
    };
    cap_marker(&limit, &shown, None, "add file/path scope, a narrower mode, or a smaller depth/limit")
}

#[cfg(test)]
mod tests {
    use serde_json::Value;

    use super::{Args, cap_to};

    /// `fixtures/tools/code_graph_cap/*.json`: the answer `executeCodeGraphTool` built (`full`)
    /// and what it returned under the recorded byte budget (`capped`).
    const GOLDENS: [(&str, &str); 6] = [
        ("single-file", include_str!("../../../../fixtures/tools/code_graph_cap/single-file.json")),
        ("batch-symbols", include_str!("../../../../fixtures/tools/code_graph_cap/batch-symbols.json")),
        ("batch-files", include_str!("../../../../fixtures/tools/code_graph_cap/batch-files.json")),
        ("search-batch", include_str!("../../../../fixtures/tools/code_graph_cap/search-batch.json")),
        ("tiny-cap", include_str!("../../../../fixtures/tools/code_graph_cap/tiny-cap.json")),
        ("under-cap", include_str!("../../../../fixtures/tools/code_graph_cap/under-cap.json")),
    ];

    #[test]
    fn the_budget_matches_the_node_goldens() {
        for (name, text) in GOLDENS {
            let case: Value = serde_json::from_str(text).unwrap();
            let cap = usize::try_from(case["cap"].as_u64().unwrap()).unwrap();
            let got = cap_to(case["full"].as_str().unwrap().to_owned(), cap, &Args::parse(&case["input"]));
            assert_eq!(got, case["capped"].as_str().unwrap(), "{name}");
        }
    }
}
