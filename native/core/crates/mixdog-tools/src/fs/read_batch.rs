//! The pure half of a batch `read`: how the entries are shaped before any file is touched
//! (`read-batch.mjs`, `batch-entries.mjs`), how the output budget is split
//! (`batch-dispatch.mjs`), how a shared union read is cut back into each caller's window
//! (`sliceReadBodyByLines`), and how the aggregate is rendered (`batch-render.mjs`,
//! `readRowsForModel`). The IO half is in `read.rs`.

use std::collections::HashMap;

use mixdog_core_api::domain::tool::ToolPart;

/// Windows of one file whose gap is at most this many lines share one disk read.
const COALESCE_GAP_LINES: u64 = 256;
/// Rows of a line window before the model-facing marker form: `<n>→<row>`.
const SEP: char = '→';

/// One requested window; `offset` is 0-based.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct WEntry {
    pub path: String,
    pub offset: u64,
    pub limit: u64,
}

/// A caller slot after coalescing: the entry it asked for, the union window its disk read covers
/// (when other windows of the file share it), and the window to cut back out of that read.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Slot {
    pub entry: WEntry,
    pub union: Option<(u64, u64)>,
    pub slice: Option<(u64, u64)>,
}

impl Slot {
    /// `childReadEntry`: what the child read is asked for.
    pub fn disk(&self) -> (u64, u64) {
        self.union.unwrap_or((self.entry.offset, self.entry.limit))
    }
}

/// `mergeOverlappingReadEntries`: explicit windows of one file that overlap become one entry in
/// the first member's slot; the other members are dropped.
pub(super) fn merge_overlapping(entries: Vec<WEntry>, key: &dyn Fn(&str) -> String) -> Vec<WEntry> {
    let mut by_path: Vec<(String, Vec<(usize, u64, u64)>)> = Vec::new();
    for (i, e) in entries.iter().enumerate() {
        let k = key(&e.path);
        let item = (i, e.offset, e.offset + e.limit.max(1));
        match by_path.iter_mut().find(|(p, _)| *p == k) {
            Some((_, items)) => items.push(item),
            None => by_path.push((k, vec![item])),
        }
    }
    let mut merged: HashMap<usize, (u64, u64)> = HashMap::new();
    let mut dropped: Vec<usize> = Vec::new();
    for (_, mut items) in by_path {
        if items.len() < 2 {
            continue;
        }
        items.sort_by(|a, b| a.1.cmp(&b.1).then(a.2.cmp(&b.2)).then(a.0.cmp(&b.0)));
        let mut runs: Vec<(u64, u64, Vec<usize>)> = Vec::new();
        for (index, offset, end) in items {
            match runs.last_mut() {
                Some(run) if offset < run.1 => {
                    run.1 = run.1.max(end);
                    run.2.push(index);
                }
                _ => runs.push((offset, end, vec![index])),
            }
        }
        for (offset, end, members) in runs {
            if members.len() < 2 {
                continue;
            }
            let head = *members.iter().min().expect("a run has members");
            merged.insert(head, (offset, end));
            dropped.extend(members.into_iter().filter(|m| *m != head));
        }
    }
    if merged.is_empty() {
        return entries;
    }
    entries
        .into_iter()
        .enumerate()
        .filter(|(i, _)| !dropped.contains(i))
        .map(|(i, e)| match merged.get(&i) {
            Some((offset, end)) => WEntry { path: e.path, offset: *offset, limit: end - offset },
            None => e,
        })
        .collect()
}

/// `coalesceObjectReadEntries` for explicit windows: nearby windows of one file are served from
/// one union read and cut back apart afterwards.
pub(super) fn coalesce(entries: Vec<WEntry>, key: &dyn Fn(&str) -> String) -> Vec<Slot> {
    let mut slots: Vec<Option<Slot>> = vec![None; entries.len()];
    let mut groups: Vec<(String, Vec<(usize, u64, u64)>)> = Vec::new();
    for (i, e) in entries.iter().enumerate() {
        let k = key(&e.path);
        let item = (i, e.offset, e.offset + e.limit);
        match groups.iter_mut().find(|(p, _)| *p == k) {
            Some((_, items)) => items.push(item),
            None => groups.push((k, vec![item])),
        }
    }
    for (_, mut items) in groups {
        items.sort_by(|a, b| a.1.cmp(&b.1).then(a.2.cmp(&b.2)));
        let mut clusters: Vec<(u64, u64, Vec<usize>)> = Vec::new();
        for (index, offset, end) in items {
            match clusters.last_mut() {
                Some(c) if offset <= c.1 + COALESCE_GAP_LINES => {
                    c.1 = c.1.max(end);
                    c.2.push(index);
                }
                _ => clusters.push((offset, end, vec![index])),
            }
        }
        for (offset, end, members) in clusters {
            let union = (members.len() > 1).then_some((offset, end - offset));
            for index in members {
                let entry = entries[index].clone();
                let slice = union.map(|_| (entry.offset, entry.limit));
                slots[index] = Some(Slot { entry, union, slice });
            }
        }
    }
    slots.into_iter().map(|s| s.expect("every entry is in a cluster")).collect()
}

/// `dedupeUnionWindows`: the slots that need their own disk read, and for each slot the read it is
/// served from.
pub(super) fn dedupe(slots: &[Slot]) -> (Vec<usize>, Vec<usize>) {
    let mut seen: HashMap<String, usize> = HashMap::new();
    let mut firsts = Vec::new();
    let mut map = Vec::with_capacity(slots.len());
    for (i, slot) in slots.iter().enumerate() {
        let (offset, limit) = slot.disk();
        let key = format!("{}|{offset}|{limit}", slot.entry.path);
        let at = *seen.entry(key).or_insert_with(|| {
            firsts.push(i);
            firsts.len() - 1
        });
        map.push(at);
    }
    (firsts, map)
}

/// `batchBodyBudget`: the body bytes a batch may return, after a reserve for the headers.
pub(super) fn body_budget(paths: &[&str], read_call_budget: usize) -> f64 {
    let reserve = paths
        .iter()
        .map(|p| (if p.is_empty() { "(missing-path)".len() } else { p.replace('\\', "/").len() }) + 128)
        .sum::<usize>()
        .max(2048)
        .min(read_call_budget / 2);
    (read_call_budget - reserve).max(256) as f64
}

/// `estimateTaskBytes`: rendered bytes a read is expected to need; `None` size (not a file) is
/// unbounded.
pub(super) fn estimate_bytes(size: Option<u64>, limit: u64) -> f64 {
    let Some(size) = size else { return f64::INFINITY };
    let size = size as f64;
    let lines = (size / 40.0).max(1.0);
    let mut need = size + (size / 20.0) * 8.0;
    if limit > 0 {
        need *= (limit as f64 / lines).min(1.0);
    }
    need.ceil() + 1024.0
}

/// `allocateBudgets`: water-filling. A task needing less than the equal share gets what it needs;
/// the rest is spread over the larger ones.
pub(super) fn allocate_budgets(needs: &[f64], total: f64) -> Vec<f64> {
    let mut budgets = vec![0.0; needs.len()];
    let mut open: Vec<usize> = (0..needs.len()).collect();
    let mut remaining = total;
    while !open.is_empty() {
        let share = (remaining / open.len() as f64).floor();
        let (small, large): (Vec<usize>, Vec<usize>) = open.iter().partition(|i| needs[**i] <= share);
        if small.is_empty() {
            for i in &open {
                budgets[*i] = share;
            }
            break;
        }
        for i in &small {
            budgets[*i] = needs[*i];
            remaining -= needs[*i];
        }
        open = large;
    }
    budgets
}

fn row_number(line: &str) -> Option<(u64, &str)> {
    let digits = line.bytes().take_while(u8::is_ascii_digit).count();
    if digits == 0 {
        return None;
    }
    let rest = &line[digits..];
    let sep = rest.chars().next()?;
    matches!(sep, '\t' | '│' | '→').then(|| (line[..digits].parse().unwrap_or(u64::MAX), rest))
}

/// `windowMarker` with no total.
fn marker(from: u64, to: u64, next: Option<u64>) -> String {
    match next {
        Some(n) => format!("[lines {from}-{to}; offset:{n} for more]"),
        None => format!("[lines {from}-{to}]"),
    }
}

/// `sliceReadBodyByLines`: cut one caller's window `[off+1, off+lim]` out of a union read's body.
pub(super) fn slice_read_body(body: &str, off: u64, lim: u64, base: u64) -> String {
    let first_line = off + 1;
    let last_line = off + lim;
    let mut kept: Vec<&str> = Vec::new();
    let mut footer_idx: Option<usize> = None;
    let (mut min_seen, mut max_seen) = (u64::MAX, 0_u64);
    let mut seen_any = false;
    let lines: Vec<&str> = body.split('\n').collect();
    for (i, line) in lines.iter().enumerate() {
        if line.starts_with("[lines ") || line.starts_with("[read complete") {
            footer_idx = Some(i);
            continue;
        }
        if let Some((n, _)) = row_number(line) {
            seen_any = true;
            min_seen = min_seen.min(n);
            max_seen = max_seen.max(n);
            if n >= first_line && n <= last_line {
                kept.push(line);
            }
        } else if kept.is_empty() && footer_idx.is_none() && !seen_any {
            kept.push(line);
        }
    }
    let total: Option<u64> = footer_idx.and_then(|i| {
        let line = lines[i];
        let at = line.find("of ")?;
        let digits: String = line[at + 3..].chars().take_while(char::is_ascii_digit).collect();
        digits.parse().ok()
    });
    if kept.is_empty() && seen_any && min_seen <= max_seen {
        if let Some(total) = total.filter(|t| first_line > *t) {
            return format!("(no lines in range; file has {total} lines)");
        }
        let total_note = total.map(|t| format!(" of {t}")).unwrap_or_default();
        return format!(
            "(lines {first_line}-{last_line} were NOT returned — the coalesced read stopped after covering lines {min_seen}-{max_seen}{total_note}; re-read this file with offset:{} limit:{lim})",
            off + base
        );
    }
    let kept_first = kept.iter().find_map(|l| row_number(l).map(|(n, _)| n));
    let kept_last = kept.iter().rev().find_map(|l| row_number(l).map(|(n, _)| n));
    let requested_last = match total {
        Some(t) => last_line.min(t),
        None => last_line,
    };
    let emitted_start = kept_first.unwrap_or(first_line);
    let emitted_last = kept_last.map_or(requested_last, |k| requested_last.min(k));
    let more = total.map_or(true, |t| emitted_last < t);
    let footer = marker(emitted_start, emitted_last, more.then_some(emitted_last + base));
    let mut out = kept.join("\n");
    if !kept.is_empty() {
        out.push('\n');
    }
    out + &footer
}

/// `readRowsForModel`: numbered rows become one `[lines a-b]` marker per consecutive run, followed
/// by the bare rows. A footer naming exactly the same run adds nothing and is dropped.
pub(super) fn rows_for_model(text: &str) -> String {
    if !text.contains(SEP) {
        return text.to_owned();
    }
    let lines: Vec<&str> = text.split('\n').collect();
    let row = |line: &str| -> Option<(u64, usize)> {
        let digits = line.bytes().take_while(u8::is_ascii_digit).count();
        (digits > 0 && line[digits..].starts_with(SEP)).then(|| (line[..digits].parse().unwrap_or(u64::MAX), digits + SEP.len_utf8()))
    };
    let mut out: Vec<String> = Vec::new();
    let mut i = 0;
    let mut changed = false;
    while i < lines.len() {
        let Some((start, skip)) = row(lines[i]) else {
            out.push(lines[i].to_owned());
            i += 1;
            continue;
        };
        let mut bodies = vec![lines[i][skip..].to_owned()];
        i += 1;
        while i < lines.len() {
            match row(lines[i]) {
                Some((n, skip)) if n == start + bodies.len() as u64 => {
                    bodies.push(lines[i][skip..].to_owned());
                    i += 1;
                }
                _ => break,
            }
        }
        let mark = format!("[lines {start}-{}]", start + bodies.len() as u64 - 1);
        out.push(mark.clone());
        out.extend(bodies);
        if i < lines.len() && lines[i] == mark {
            i += 1;
        }
        changed = true;
    }
    if changed { out.join("\n") } else { text.to_owned() }
}

/// What one batch entry came back as.
#[derive(Clone, Debug)]
pub(super) enum CBody {
    /// A flat string (Node's text result): numbered rows, an error, a preview, a document.
    Str(String),
    /// Structured content (an image result); `failed` is Node's `isError`.
    Rich { parts: Vec<ToolPart>, failed: bool },
}

impl CBody {
    fn text(&self) -> String {
        match self {
            Self::Str(s) => s.clone(),
            Self::Rich { parts, .. } => parts
                .iter()
                .filter_map(|p| if let ToolPart::Text(t) = p { Some(t.as_str()) } else { None })
                .filter(|t| !t.is_empty())
                .collect::<Vec<_>>()
                .join("\n"),
        }
    }
}

fn regex(cell: &'static std::sync::OnceLock<regex::Regex>, pattern: &str) -> &'static regex::Regex {
    cell.get_or_init(|| regex::Regex::new(pattern).expect("a fixed pattern"))
}

/// `classifyResultKind(..) === 'error'`.
pub(super) fn is_error_text(text: &str) -> bool {
    static ERROR: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    regex(&ERROR, r"(?i)^(?:error(?:\s+\[code\b|\s*:)|\[error)").is_match(text.trim_start())
}
fn failed(body: &CBody) -> bool {
    match body {
        CBody::Rich { failed, .. } if *failed => true,
        _ => is_error_text(&body.text()),
    }
}

fn status(body: &CBody) -> &'static str {
    if failed(body) {
        "error"
    } else if body.text().trim_start().starts_with("[path absent]") {
        "absent"
    } else {
        "ok"
    }
}

/// The header's truncation note, from a smart-read cap marker in the body.
fn truncated_suffix(text: &str) -> String {
    static MARKER: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    regex(&MARKER, r"\[output capped at [^;\]]+; lines \d+-\d+ of (\d+) omitted \((\d+) KB file\);")
        .captures(text)
        .map(|c| format!(" (truncated {}L/{}KB)", &c[1], &c[2]))
        .unwrap_or_default()
}
/// A finished entry: the path to print, its body, and which disk read produced it.
pub(super) struct Resolved {
    pub path: String,
    pub body: CBody,
    pub producer: usize,
}

fn header(results: &[Resolved]) -> String {
    let failed = results.iter().filter(|r| failed(&r.body)).count();
    if failed > 0 {
        format!("read {} ({failed} failed)", results.len())
    } else {
        format!("read {}", results.len())
    }
}

/// `renderBatchResults` when no entry is structured: one string, numbered rows still in it.
pub(super) fn render_text(results: &[Resolved]) -> String {
    let mut seen: Vec<(usize, &str, String)> = Vec::new();
    let blocks: Vec<String> = results
        .iter()
        .enumerate()
        .map(|(i, r)| {
            let text = r.body.text();
            let st = status(&r.body);
            if let Some((idx, _, _)) = seen.iter().find(|(_, p, b)| *p == r.path && *b == text) {
                return format!("{} [{st}] [= entry #{}, identical result omitted]", r.path, idx + 1);
            }
            seen.push((i, &r.path, text.clone()));
            format!("{} [{st}]{}\n{text}", r.path, truncated_suffix(&text))
        })
        .collect();
    format!("{}\n\n{}", header(results), blocks.join("\n\n"))
}

/// `renderRichBatch`: a batch holding a structured result stays structured.
pub(super) fn render_rich(results: &[Resolved]) -> Vec<ToolPart> {
    let mut parts = vec![ToolPart::Text(header(results))];
    let mut seen_text: Vec<(usize, &str, String)> = Vec::new();
    let mut seen_rich: Vec<(usize, usize, &str)> = Vec::new();
    for (i, r) in results.iter().enumerate() {
        let text = r.body.text();
        let entry_header = format!("{} [{}]{}", r.path, status(&r.body), truncated_suffix(&text));
        let prior = match &r.body {
            CBody::Rich { .. } => seen_rich.iter().find(|(_, p, path)| *p == r.producer && *path == r.path).map(|(idx, _, _)| *idx),
            CBody::Str(s) => seen_text.iter().find(|(_, path, b)| *path == r.path && b == s).map(|(idx, _, _)| *idx),
        };
        if let Some(idx) = prior {
            parts.push(ToolPart::Text(format!("{entry_header} [= entry #{}, identical result omitted]", idx + 1)));
            continue;
        }
        match &r.body {
            CBody::Rich { parts: blocks, .. } => {
                seen_rich.push((i, r.producer, &r.path));
                parts.push(ToolPart::Text(entry_header));
                parts.extend(blocks.iter().cloned());
            }
            CBody::Str(s) => {
                seen_text.push((i, &r.path, s.clone()));
                parts.push(ToolPart::Text(entry_header));
                parts.push(ToolPart::Text(s.clone()));
            }
        }
    }
    parts
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rows_for_model_drops_a_footer_that_repeats_its_marker() {
        assert_eq!(rows_for_model("1→a\n2→b\n[lines 1-2]"), "[lines 1-2]\na\nb");
        assert_eq!(rows_for_model("1→a\n3→c\n[lines 1-1; offset:2 for more]"), "[lines 1-1]\na\n[lines 3-3]\nc\n[lines 1-1; offset:2 for more]");
    }

    #[test]
    fn water_filling_gives_small_tasks_their_need() {
        assert_eq!(allocate_budgets(&[1048.0, 29000.0], 49152.0), vec![1048.0, 29000.0]);
        assert_eq!(allocate_budgets(&[f64::INFINITY, f64::INFINITY], 100.0), vec![50.0, 50.0]);
    }

    #[test]
    fn a_union_read_is_cut_back_to_each_window() {
        let body = "1→a\n2→b\n3→c\n[lines 1-3; offset:4 for more]";
        assert_eq!(slice_read_body(body, 1, 1, 1), "2→b\n[lines 2-2; offset:3 for more]");
    }
}
