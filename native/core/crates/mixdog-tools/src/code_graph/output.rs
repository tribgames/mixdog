//! What `executeCodeGraphTool` wraps around every answer (`code-graph/dispatch.mjs`): the warning
//! about files the graph could not index, then the output budget (`capLineOrientedToolOutput`
//! with `_codeGraphBudgetFooter`, `shared/tool-output-limit.mjs`).
#![allow(clippy::disallowed_methods, reason = "blocking filesystem reads; the whole call runs as one maintenance-lane job (CodeGraphTool::call)")]

use std::path::{Path, PathBuf};

use serde_json::Value;

use super::args::Args;
use super::graph::{Graph, Node};
use crate::fs::common::{cap_marker, format_cap_size};

/// The files a call's graphs held unindexed (`options._parseWarnings`), keyed by absolute path
/// in the order first seen.
#[derive(Default)]
pub(super) struct Warnings(Vec<(PathBuf, String)>, Option<String>);

impl Warnings {
    pub fn is_empty(&self) -> bool {
        self.0.is_empty() && self.1.is_none()
    }

    /// `collectGraphParseWarnings` for the graph a section answers from. An answer that was
    /// given from an independently verified one-file graph (`one_file`: the dispatcher built
    /// it with `Graph::build_single`, which refuses an unverifiable read) is exempt, as Node's
    /// one-file graph records no parse error; every answer from the whole graph is not,
    /// whatever its mode.
    pub fn collect(&mut self, one_file: bool, root: &Path, graph: &Graph) {
        if one_file {
            return;
        }
        // Every answer from a graph that had to leave files out says so, empty results and `imports` included: what concerns
        // a file that is not there is unknown, not absent. (The one place the reason is attached.)
        if graph.incomplete() {
            self.1 = Some(graph.incomplete_note());
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
    pub(super) fn prefix(&self, raw: String) -> String {
        let omitted = self.1.as_ref().map(|reason| format!("[warning] {reason}\n")).unwrap_or_default();
        if self.0.is_empty() {
            return format!("{omitted}{raw}");
        }
        let shown: Vec<&str> = self.0.iter().take(5).map(|(_, text)| text.as_str()).collect();
        format!("{omitted}[warning] {} source file(s) could not be indexed; graph results are partial:\n{}\n{raw}", self.0.len(), shown.join("\n"))
    }
}

/// `executeCodeGraphTool`'s result for the dispatcher's `raw` text.
#[cfg(test)]
pub(super) fn wrap(raw: String, warnings: &Warnings, args: &Args) -> String {
    wrap_with_status(raw, warnings, args, max_bytes()).0
}

pub(super) fn wrap_with_status(raw: String, warnings: &Warnings, args: &Args, cap: usize) -> (String, bool) {
    if let Some(offset) = args.node_offset
        && let Some(row) = raw.lines().skip_while(|line| caller_range(line).is_none()).nth(2).filter(|row| row.starts_with("  "))
    {
        return caller_chunk(row, offset, cap);
    }
    let answer = warnings.prefix(raw);
    let complete = answer.len() <= cap;
    (cap_to(answer, cap, args), complete)
}

fn caller_chunk(row: &str, offset: usize, cap: usize) -> (String, bool) {
    let Some(rest) = row.get(offset..) else {
        return ("Error: node_offset is past the entry or not a UTF-8 boundary; use a returned offset".to_owned(), false);
    };
    if rest.len() <= cap {
        return (rest.to_owned(), offset == 0);
    }
    let reserve = format!("\n[node_offset:{} for more]", row.len()).len();
    let chunk = &rest[..rest.floor_char_boundary(cap.saturating_sub(reserve))];
    if chunk.is_empty() {
        return ("Error: caller byte budget is too small for a recovery chunk".to_owned(), false);
    }
    (format!("{chunk}\n[node_offset:{} for more]", offset + chunk.len()), false)
}

/// `CODE_GRAPH_OUTPUT_MAX_BYTES`'s default.
const DEFAULT_MAX_BYTES: usize = 30 * 1024;
const MAX_BYTES_ENV: &str = "MIXDOG_CODE_GRAPH_OUTPUT_MAX_BYTES";

/// `positiveEnvInt`: `parseInt` of the variable when that is a positive number, else the default.
pub(super) fn max_bytes() -> usize {
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

/// Keep whole lines and replace the omitted tail with a footer naming what to re-query.
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
        let footer = page_footer(args, kept, &lines[mid..], cap).unwrap_or_else(|| footer(args, kept, cap));
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
    let footer = page_footer(args, &[], &lines, cap).unwrap_or_else(|| footer(args, &[], cap));
    let mut end = 0;
    for (at, c) in footer.char_indices() {
        if at + c.len_utf8() > cap {
            break;
        }
        end = at + c.len_utf8();
    }
    footer[..end].to_owned()
}

fn caller_range(line: &str) -> Option<(&str, usize, usize, usize)> {
    let (heading, nodes) = line.strip_prefix("# transitive callers of ")?.rsplit_once(", nodes ")?;
    let (symbol, _) = heading.rsplit_once(" (depth=")?;
    let (from, rest) = nodes.split_once('-')?;
    let (to, total) = rest.split_once(" of ")?;
    let (total, _) = total.split_once(';')?;
    Some((symbol, from.parse().ok()?, to.parse().ok()?, total.parse().ok()?))
}

/// Use absolute node numbers (`limit:1`) for all sections whose rows or NEXT
/// were cut. Keep the instructions scoped; a page number alone is ambiguous.
fn page_footer(args: &Args, kept: &[&str], omitted: &[&str], cap: usize) -> Option<String> {
    if args.mode != "callers" || args.depth.unwrap_or(1.0) < 2.0 {
        return None;
    }
    let lines = |index: usize| kept.get(index).or_else(|| omitted.get(index.saturating_sub(kept.len()))).copied();
    let symbols = args.symbol_list();
    let files = args.file_list();
    let federated = kept.iter().chain(omitted).filter(|line| line.starts_with("# project ")).count() > 1;
    let mut continuations = Vec::new();
    for (at, &line) in kept.iter().chain(omitted).enumerate() {
        let Some((symbol, first, last, total)) = caller_range(line) else { continue };
        // Only the contiguous indented node rows belong to this header.
        let end = at.saturating_add(2).saturating_add(last.saturating_sub(first).saturating_add(1));
        if end < kept.len() || (end == kept.len() && last == total) {
            continue;
        }
        let shown = kept.len().saturating_sub(at + 2);
        let mut resume = first.saturating_add(shown);
        let narrowed = symbols.len() <= 1 && files.len() <= 1;
        let row_too_large = resume <= last && lines(at + 2 + shown).is_some_and(|row| row.len() >= cap);
        let oversized = row_too_large || (shown == 0 && narrowed && args.user_limit() == Some(1));
        let recovery = oversized.then_some(resume);
        if oversized {
            resume = resume.saturating_add(1);
        }
        if resume > total && recovery.is_none() {
            continue;
        }
        let file = (0..at)
            .rev()
            .filter_map(lines)
            .find_map(|l| l.strip_prefix("# file ").or_else(|| l.strip_prefix("# callers ")).filter(|f| files.iter().any(|candidate| candidate == *f)));
        let mut target = String::new();
        if symbols.len() > 1 {
            target.push_str(&format!(" symbols:[{}]", Value::from(symbol)));
        }
        if files.len() > 1
            && let Some(file) = file
        {
            target.push_str(&format!(" files:[{}]", Value::from(file)));
        }
        if federated
            && files.is_empty()
            && let Some(cwd) =
                (0..at).rev().filter_map(lines).find_map(|line| line.strip_prefix("# project ")?.strip_suffix(']')?.rsplit_once(" [").map(|(_, cwd)| cwd))
        {
            target.push_str(&format!(" cwd:{}", Value::from(cwd)));
        }
        if let Some(page) = recovery {
            let next = if resume <= total { format!("; then page:{resume} without node_offset") } else { String::new() };
            continuations.push(format!("limit:1 page:{page}{target} node_offset:0{next}"));
        } else {
            continuations.push(format!("limit:1 page:{resume}{target}"));
        }
    }
    if continuations.is_empty() {
        return None;
    }
    let full = format!("[Continue callers: {}; keep other args]", continuations.join(" | "));
    if full.len() <= cap {
        return Some(full);
    }
    let compact = format!("[{}]", continuations.join(" | "));
    if compact.len() <= cap {
        return Some(compact);
    }
    // More scopes than can fit in a footer: replay the original page for each
    // scope separately, rather than silently losing the later sections.
    Some(if federated && files.is_empty() {
        "[Callers cut: rerun each symbol in each project at the original page/limit]".to_owned()
    } else {
        "[Callers cut: rerun each symbol/file pair at the original page/limit]".to_owned()
    })
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
        return cap_marker(&limit, &format!("{label} from index {current} not fully shown"), None, &format!("re-query {label}={rest} separately"));
    }
    let shown = match targets.first() {
        Some(target) => format!("remainder for {}={} omitted", &label[..label.len() - 1], Value::from(target.as_str())),
        None => "remainder omitted".to_owned(),
    };
    cap_marker(&limit, &shown, None, "add file/path scope, a narrower mode, or a smaller depth/limit")
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{Args, Warnings, cap_to, wrap_with_status};

    fn numbered_lines(count: usize) -> String {
        (1..=count).map(|n| format!("row {n:02} {}", "x".repeat(40))).collect::<Vec<_>>().join("\n")
    }

    #[test]
    fn an_answer_within_the_budget_is_returned_unchanged() {
        let answer = numbered_lines(3);
        let args = Args::parse(&json!({ "mode": "symbols", "files": "src/a.mjs" }));
        assert_eq!(cap_to(answer.clone(), answer.len(), &args), answer);
    }

    #[test]
    fn a_capped_callers_page_resumes_at_the_first_omitted_node_not_the_next_old_page() {
        let args = Args::parse(&json!({ "mode": "callers", "symbols": ["f"], "depth": 2, "limit": 3, "page": 2 }));
        let header = "# transitive callers of f (depth=2) — page 2, nodes 4-6 of 12; INDENTED children are ITS callers\nf";
        let first = "  one\tsrc/a.mjs:12";
        let second = format!("  {}\tsrc/a.mjs:13", "long".repeat(30));
        let answer = format!("{header}\n{first}\n{second}\n  three\tsrc/a.mjs:14\n# NEXT — keep the same callers arguments and set page:3");
        let shown = cap_to(answer, 200, &args);
        assert!(shown.contains(first), "{shown}");
        assert!(shown.ends_with("[Continue callers: limit:1 page:5; keep other args]"), "{shown}");
    }

    #[test]
    fn a_capped_caller_batch_preserves_oversized_and_later_nonempty_sections() {
        let args = Args::parse(&json!({ "mode": "callers", "symbols": ["f", "g"], "depth": 2, "limit": 1, "page": 2 }));
        let row = format!("  {}\tsrc/a.mjs:13", "あ".repeat(100));
        let answer = format!(
            "# callers f\n# transitive callers of f (depth=2) — page 2, nodes 2-2 of 4; details\nf\n{row}\n# NEXT\n\n# callers g\n# transitive callers of g (depth=2) — page 2, nodes 2-2 of 3; details\ng\n  other\tsrc/b.mjs:4\n# NEXT"
        );
        let (shown, complete) = wrap_with_status(answer.clone(), &Warnings::default(), &args, 175);
        assert!(!complete);
        assert!(shown.contains("page:2 symbols:[\"f\"] node_offset:0; then page:3"), "{shown}");
        assert!(shown.contains("page:2 symbols:[\"g\"]"), "{shown}");
        let raw = answer.split("\n\n").next().unwrap();
        let mut offset = 0;
        let mut recovered = String::new();
        while offset < row.len() {
            let args = Args::parse(&json!({ "mode": "callers", "symbols": ["f"], "depth": 2, "limit": 1, "page": 2, "node_offset": offset }));
            let (chunk, complete) = wrap_with_status(raw.to_owned(), &Warnings::default(), &args, 175);
            assert!(!complete);
            if let Some((text, next)) = chunk.rsplit_once("\n[node_offset:") {
                recovered.push_str(text);
                let next = next.strip_suffix(" for more]").unwrap().parse::<usize>().unwrap();
                assert!(next > offset && next == recovered.len());
                offset = next;
            } else {
                recovered.push_str(&chunk);
                break;
            }
        }
        assert_eq!(recovered, row);
    }

    #[test]
    fn an_answer_over_the_budget_keeps_whole_lines_and_names_what_was_left_out() {
        let answer = numbered_lines(20);
        let args = Args::parse(&json!({ "mode": "symbols", "files": "src/a.mjs" }));
        let capped = cap_to(answer.clone(), 400, &args);
        let footer =
            "[output capped at 400 bytes; remainder for file=\"src/a.mjs\" omitted; narrow: add file/path scope, a narrower mode, or a smaller depth/limit]";
        let kept = capped.strip_suffix(footer).and_then(|body| body.strip_suffix('\n')).expect("the footer closes the answer");
        assert!(capped.len() <= 400);
        assert!(answer.starts_with(kept) && kept.lines().count() >= 1 && kept.lines().count() < 20, "{capped}");
        assert!(answer.lines().take(kept.lines().count()).eq(kept.lines()), "only whole lines are kept");
        // One more line would have gone over the budget.
        let one_more = answer.lines().take(kept.lines().count() + 1).collect::<Vec<_>>().join("\n");
        assert!(one_more.len() + 1 + footer.len() > 400);
    }

    #[test]
    fn a_batch_answer_names_the_item_the_cut_fell_in_and_the_items_to_ask_again() {
        let section = |name: &str| format!("# find_symbol {name}\n# best declaration candidate\nsrc/a.mjs:1-3:17 ({name})\n");
        let answer = ["fn1", "fn2", "fn3"].map(section).join("\n");
        let args = Args::parse(&json!({ "mode": "find_symbol", "symbols": ["fn1", "fn2", "fn3"] }));
        // The whole first item, the second item's header line and a 117-byte footer (the one a three-digit cap gives here):
        // the budget the cut falls in the second item with.
        let cap = section("fn1").len() + 1 + section("fn2").lines().next().unwrap().len() + 1 + 117;
        let capped = cap_to(answer, cap, &args);
        assert!(capped.contains("# find_symbol fn2"), "{capped}");
        assert!(!capped.contains("# find_symbol fn3"), "{capped}");
        assert!(
            capped.ends_with(&format!(
                "[output capped at {cap} bytes; symbols from index 1 not fully shown; narrow: re-query symbols=[\"fn2\",\"fn3\"] separately]"
            )),
            "{capped}"
        );
    }

    #[test]
    fn a_budget_too_small_for_the_footer_cuts_the_footer_itself() {
        let args = Args::parse(&json!({ "mode": "symbols", "files": "src/a.mjs" }));
        let capped = cap_to(numbered_lines(5), 40, &args);
        assert_eq!(capped, "[output capped at 40 bytes; remainder fo");
    }
}
