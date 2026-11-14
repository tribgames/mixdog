//! The pure half of a batch `read`: how the entries are shaped before any file is touched
//! (`read-batch.mjs`, `batch-entries.mjs`), how the output budget is split
//! (`batch-dispatch.mjs`), how a shared union read is cut back into each caller's window
//! (`sliceReadBodyByLines`), and how the aggregate is rendered (`batch-render.mjs`,
//! `readRowsForModel`). The IO half is in `read.rs`.

use std::collections::HashMap;

use mixdog_core_api::domain::tool::ToolPart;
use mixdog_protocol::JsonValue;

use super::read_state::LineRange;
use super::read_state::merge_ranges;

/// Windows of one file whose gap is at most this many lines share one disk read.
const COALESCE_GAP_LINES: u64 = 256;
/// Rows of a line window before the model-facing marker form: `<n>→<row>`.
const SEP: char = '→';

/// A JS number as `String(n)` prints it.
pub(super) fn js_num(v: f64) -> String {
    if v.fract() == 0.0 && v.abs() < 1e21 { format!("{}", v as i128) } else { format!("{v}") }
}

fn js_opt(v: Option<f64>) -> String {
    v.map(js_num).unwrap_or_default()
}

/// A JSON value as a JS template literal prints it.
pub(super) fn js_str(v: &JsonValue) -> String {
    match v {
        JsonValue::String(s) => s.clone(),
        JsonValue::Number(n) => n.as_f64().map_or_else(|| n.to_string(), js_num),
        JsonValue::Bool(b) => b.to_string(),
        other => other.to_string(),
    }
}

/// One entry of a batch as Node shapes it (`{path, mode?, n?, offset?, limit?, full?}`), with the
/// bookkeeping coalescing adds (`_unionOffset`, `_unionLimit`, `_needsPerEntrySlice`, `_orig*`).
/// `offset` is 0-based; a `limit` of 0 reads to the end of the file.
#[derive(Clone, Debug, Default)]
pub(super) struct BEntry {
    pub path: String,
    pub mode: Option<String>,
    pub n: Option<JsonValue>,
    pub offset: Option<f64>,
    pub limit: Option<f64>,
    pub full: Option<bool>,
    /// The union window the disk read covers (`_unionOffset`, `_unionLimit`; limit 0 = to the end).
    pub union: Option<(u64, u64)>,
    pub needs_slice: bool,
    pub orig_offset: Option<f64>,
    pub orig_limit: Option<f64>,
    /// `tail: N` until it is read off the file (`ReadTool::resolve_tail`).
    pub tail: Option<u64>,
    /// The window is the public guard's default (the caller named neither an offset nor a limit), so a notebook,
    /// which refuses a named range, still reads.
    pub injected: bool,
}

impl BEntry {
    /// `isFullModeReadEntry`.
    pub fn is_full_mode(&self) -> bool {
        matches!(self.mode.as_deref(), None | Some("full"))
    }

    /// `entryIsImplicitDefaultRead`: the caller named neither an offset nor a limit.
    fn implicit(&self) -> bool {
        self.limit.is_none() && self.offset.is_none()
    }

    /// `readEntryLineWindow`: where the entry starts and where it ends (`None` = the end of the file).
    pub fn line_window(&self) -> (u64, Option<u64>) {
        let offset = self.offset.filter(|o| o.is_finite()).map_or(0, |o| o.trunc().max(0.0) as u64);
        let limit = if self.full == Some(true) || self.limit == Some(0.0) {
            None
        } else {
            Some(self.limit.map_or(2000, |l| l.trunc().max(1.0) as u64))
        };
        (offset, limit.map(|l| offset.saturating_add(l)))
    }

    /// `childReadEntry`: what the child read is asked for.
    pub fn child(&self) -> BEntry {
        let mut e = self.clone();
        if let Some((offset, limit)) = self.union {
            e.offset = Some(offset as f64);
            e.limit = Some(limit as f64);
        }
        if e.is_full_mode() && e.offset.is_none() && e.limit.is_none() && e.full != Some(true) {
            e.offset = Some(0.0);
            e.limit = Some(2000.0);
        }
        e
    }
}

/// `mergeOverlappingReadEntries`: explicit windows of one file that overlap become one entry in
/// the first member's slot; the other members are dropped.
pub(super) fn merge_overlapping(entries: Vec<BEntry>, key: &dyn Fn(&str) -> String) -> Vec<BEntry> {
    let explicit = |e: &BEntry| {
        e.is_full_mode() && e.full != Some(true) && e.offset.is_some_and(f64::is_finite) && e.limit.is_some_and(|l| l.is_finite() && l > 0.0)
    };
    let mut by_path: Vec<(String, Vec<(usize, u64, u64)>)> = Vec::new();
    for (i, e) in entries.iter().enumerate() {
        if !explicit(e) {
            continue;
        }
        let offset = e.offset.unwrap_or(0.0).trunc().max(0.0) as u64;
        let item = (i, offset, offset.saturating_add(e.limit.unwrap_or(1.0).trunc().max(1.0) as u64));
        let k = key(&e.path);
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
            Some((offset, end)) => BEntry { offset: Some(*offset as f64), limit: Some((end - offset) as f64), ..e },
            None => e,
        })
        .collect()
}

/// `coalesceObjectReadEntries`: nearby full-mode windows of one file are served from one union read
/// and cut back apart afterwards. An entry that names no window never shares a read with one that does.
pub(super) fn coalesce_object(entries: Vec<BEntry>, key: &dyn Fn(&str) -> String) -> Vec<BEntry> {
    struct Item {
        index: usize,
        offset: u64,
        end: Option<u64>,
    }
    struct Cluster {
        offset: u64,
        end: Option<u64>,
        items: Vec<Item>,
        has_implicit: bool,
        has_explicit: bool,
    }
    let mut out: Vec<Option<BEntry>> = vec![None; entries.len()];
    let mut groups: Vec<(String, Vec<Item>)> = Vec::new();
    for (index, entry) in entries.iter().enumerate() {
        if !entry.is_full_mode() {
            out[index] = Some(entry.clone());
            continue;
        }
        let (offset, end) = entry.line_window();
        let k = key(&entry.path);
        let item = Item { index, offset, end };
        match groups.iter_mut().find(|(p, _)| *p == k) {
            Some((_, items)) => items.push(item),
            None => groups.push((k, vec![item])),
        }
    }
    for (_, mut items) in groups {
        items.sort_by(|a, b| {
            a.offset.cmp(&b.offset).then_with(|| match (a.end, b.end) {
                (None, None) => std::cmp::Ordering::Equal,
                (None, _) => std::cmp::Ordering::Greater,
                (_, None) => std::cmp::Ordering::Less,
                (Some(x), Some(y)) => x.cmp(&y),
            })
        });
        let mut clusters: Vec<Cluster> = Vec::new();
        for item in items {
            let implicit = entries[item.index].implicit();
            let explicit = !implicit;
            let can_merge = clusters.last().is_some_and(|c| {
                (c.end.is_none() || item.offset <= c.end.unwrap_or(0).saturating_add(COALESCE_GAP_LINES))
                    && !(c.has_implicit && explicit)
                    && !(implicit && c.has_explicit)
                    && !(implicit && c.has_implicit)
            });
            if !can_merge {
                clusters.push(Cluster { offset: item.offset, end: item.end, has_implicit: implicit, has_explicit: explicit, items: vec![item] });
                continue;
            }
            if let Some(c) = clusters.last_mut() {
                c.has_implicit |= implicit;
                c.has_explicit |= explicit;
                if let Some(end) = c.end {
                    c.end = item.end.map(|e| e.max(end));
                }
                c.items.push(item);
            }
        }
        for cluster in clusters {
            if cluster.items.len() == 1 {
                let index = cluster.items[0].index;
                out[index] = Some(entries[index].clone());
                continue;
            }
            let union_limit = cluster.end.map_or(0, |end| end - cluster.offset);
            for item in &cluster.items {
                let entry = &entries[item.index];
                let offset = entry.offset.filter(|o| o.is_finite()).map_or(item.offset, |o| o.trunc().max(0.0) as u64);
                let limit = match (entry.limit, item.end) {
                    (Some(l), _) => l,
                    (None, None) => 0.0,
                    (None, Some(end)) => end.saturating_sub(item.offset).max(1) as f64,
                };
                out[item.index] = Some(BEntry {
                    offset: Some(offset as f64),
                    limit: Some(limit),
                    union: Some((cluster.offset, union_limit)),
                    needs_slice: true,
                    orig_offset: entry.offset,
                    orig_limit: entry.limit,
                    ..entry.clone()
                });
            }
        }
    }
    out.into_iter().map(|e| e.expect("every entry is in a group or kept")).collect()
}

/// `dedupeUnionWindows`: the entries that need their own disk read, and for each entry the read it
/// is served from (an index into the first list).
pub(super) fn dedupe(entries: &[BEntry]) -> (Vec<usize>, Vec<usize>) {
    let mut seen: HashMap<String, usize> = HashMap::new();
    let mut firsts = Vec::new();
    let mut map = Vec::with_capacity(entries.len());
    for (i, e) in entries.iter().enumerate() {
        let (offset, limit) = match e.union {
            Some((o, l)) => (js_num(o as f64), js_num(l as f64)),
            None => (js_opt(e.offset), js_opt(e.limit)),
        };
        let key = format!(
            "{}|{offset}|{limit}|{}|{}|{}",
            e.path,
            e.mode.clone().unwrap_or_default(),
            e.n.as_ref().map(js_str).unwrap_or_default(),
            e.full.map(|f| f.to_string()).unwrap_or_default()
        );
        let at = *seen.entry(key).or_insert_with(|| {
            firsts.push(i);
            firsts.len() - 1
        });
        map.push(at);
    }
    (firsts, map)
}

/// `primaryReadIndexes` for a string batch: an entry repeating an earlier one's resolved path and
/// options is served from that read. Returns the first list and each entry's place in it.
pub(super) fn primary_reads(entries: &[BEntry], key: &dyn Fn(&str) -> String) -> (Vec<usize>, Vec<usize>) {
    let mut seen: HashMap<String, usize> = HashMap::new();
    let mut firsts = Vec::new();
    let mut map = Vec::with_capacity(entries.len());
    for (i, e) in entries.iter().enumerate() {
        let at = if e.path.is_empty() {
            firsts.push(i);
            firsts.len() - 1
        } else {
            let k = format!(
                "{}|{}|{}|{}|{}|{}",
                key(&e.path),
                e.mode.clone().unwrap_or_default(),
                js_opt(e.offset),
                js_opt(e.limit),
                e.n.as_ref().map(js_str).unwrap_or_default(),
                e.full.map(|f| f.to_string()).unwrap_or_default()
            );
            *seen.entry(k).or_insert_with(|| {
                firsts.push(i);
                firsts.len() - 1
            })
        };
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
fn marker(from: u64, to: u64, total: Option<u64>, next: Option<u64>) -> String {
    let of = total.map(|t| format!(" of {t}")).unwrap_or_default();
    match next {
        Some(n) => format!("[lines {from}-{to}{of}; offset:{n} for more]"),
        None => format!("[lines {from}-{to}{of}]"),
    }
}

/// `sliceReadBodyByLines`: cut one caller's window `[off+1, off+lim]` out of a union read's body.
/// `lim` is `None` for an unbounded window (`limit:0`).
pub(super) fn slice_read_body(body: &str, off: u64, lim: Option<u64>, base: u64) -> String {
    let first_line = off + 1;
    let last_line = lim.map(|l| off.saturating_add(l));
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
            if n >= first_line && last_line.is_none_or(|l| n <= l) {
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
        let wanted = match last_line {
            Some(last) => format!("{first_line}-{last}"),
            None => format!("{first_line}+"),
        };
        let total_note = total.map(|t| format!(" of {t}")).unwrap_or_default();
        let limit_note = last_line.map(|last| format!(" limit:{}", last - first_line + 1)).unwrap_or_default();
        return format!(
            "(lines {wanted} were NOT returned — the coalesced read stopped after covering lines {min_seen}-{max_seen}{total_note}; re-read this file with offset:{}{limit_note})",
            off + base
        );
    }
    let kept_first = kept.iter().find_map(|l| row_number(l).map(|(n, _)| n));
    let kept_last = kept.iter().rev().find_map(|l| row_number(l).map(|(n, _)| n));
    let requested_last = match (total, last_line) {
        (Some(t), Some(l)) => l.min(t),
        (None, Some(l)) => l,
        (_, None) => kept_last.unwrap_or(first_line),
    };
    let emitted_start = kept_first.unwrap_or(first_line);
    let emitted_last = kept_last.map_or(requested_last, |k| requested_last.min(k));
    let more = total.map_or(last_line.is_some(), |t| emitted_last < t);
    let footer = marker(emitted_start, emitted_last, total, more.then_some(emitted_last + base));
    let mut out = kept.join("\n");
    if !kept.is_empty() {
        out.push('\n');
    }
    out + &footer
}

/// `renderedBatchReadRanges`: the line numbers a body shows, as ranges; else the footer's range.
pub(super) fn rendered_ranges(body: &str) -> Vec<LineRange> {
    let rows: Vec<LineRange> = body
        .split('\n')
        .filter_map(|l| row_number(l).map(|(n, _)| n))
        .filter(|n| *n > 0 && *n < (1 << 53))
        .map(|n| LineRange { start: n, end: Some(n) })
        .collect();
    if !rows.is_empty() {
        return merge_ranges(&rows);
    }
    static FOOTER: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    regex(&FOOTER, r"\[lines\s+(\d+)-(\d+)\s+of\s+\d+")
        .captures(body)
        .and_then(|c| Some(LineRange { start: c[1].parse().ok()?, end: Some(c[2].parse().ok()?) }))
        .map(|r| merge_ranges(&[r]))
        .unwrap_or_default()
}

/// The parts of `a` that lie inside `b`.
pub(super) fn intersect_ranges(a: &[LineRange], b: &[LineRange]) -> Vec<LineRange> {
    let mut out = Vec::new();
    for x in a {
        for y in b {
            let start = x.start.max(y.start);
            let end = match (x.end, y.end) {
                (Some(p), Some(q)) => Some(p.min(q)),
                (Some(p), None) | (None, Some(p)) => Some(p),
                (None, None) => None,
            };
            if end.map_or(true, |e| e >= start) {
                out.push(LineRange { start, end });
            }
        }
    }
    merge_ranges(&out)
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
/// A finished entry: the path to print, its body, which disk read produced it, and the mode (and
/// `n`) it was asked in.
pub(super) struct Resolved {
    pub path: String,
    pub body: CBody,
    pub producer: usize,
    pub mode: String,
    pub n: Option<String>,
}

impl Resolved {
    /// `modeOf`: `head n=3`, or just the mode.
    fn label(&self) -> String {
        match &self.n {
            Some(n) => format!("{} n={n}", self.mode),
            None => self.mode.clone(),
        }
    }

    /// `modeTagOf`: the default mode carries no information.
    fn tag(&self) -> String {
        let label = self.label();
        if label == "full" { String::new() } else { format!(" [{label}]") }
    }
}

fn header(results: &[Resolved]) -> String {
    static LINES: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let failed = results.iter().filter(|r| failed(&r.body)).count();
    let summaries: Vec<String> = results
        .iter()
        .filter(|r| r.mode == "count")
        .filter_map(|r| {
            let body = match &r.body {
                CBody::Str(s) => s.as_str(),
                CBody::Rich { .. } => return None,
            };
            let m = regex(&LINES, r"lines\t(\d+)").captures(body)?;
            Some(format!("{} has {} lines", r.path.replace('\\', "/"), &m[1]))
        })
        .collect();
    let summary = if summaries.is_empty() { String::new() } else { format!(" {}", summaries.join("; ")) };
    if failed > 0 {
        format!("read {} ({failed} failed){summary}", results.len())
    } else {
        format!("read {}{summary}", results.len())
    }
}

/// `reject_partial:true`: a batch with an entry that delivered nothing is refused whole.
pub(super) fn rejected(results: &[Resolved]) -> String {
    let undelivered: Vec<&Resolved> = results.iter().filter(|r| status(&r.body) != "ok").collect();
    let reasons = undelivered
        .iter()
        .map(|r| {
            let first = r.body.text();
            let first = first.split('\n').next().unwrap_or_default();
            let first = if first.is_empty() { "structured media read failed" } else { first };
            format!("{}: {first}", r.path.replace('\\', "/"))
        })
        .collect::<Vec<_>>()
        .join("; ");
    format!("Error: batch read rejected ({} of {} failed; reject_partial:true) — {reasons}", undelivered.len(), results.len())
}

/// Whether `reject_partial:true` refuses this batch.
pub(super) fn is_rejected(results: &[Resolved]) -> bool {
    results.iter().any(|r| status(&r.body) != "ok")
}

/// `renderBatchResults` when no entry is structured: one string, numbered rows still in it.
pub(super) fn render_text(results: &[Resolved]) -> String {
    let mut seen: Vec<(usize, &str, String, String)> = Vec::new();
    let blocks: Vec<String> = results
        .iter()
        .enumerate()
        .map(|(i, r)| {
            let text = r.body.text();
            let st = status(&r.body);
            let (label, tag) = (r.label(), r.tag());
            if let Some((idx, _, _, _)) = seen.iter().find(|(_, p, l, b)| *p == r.path && *l == label && *b == text) {
                return format!("{}{tag} [{st}] [= entry #{}, identical result omitted]", r.path, idx + 1);
            }
            seen.push((i, &r.path, label, text.clone()));
            format!("{}{tag} [{st}]{}\n{text}", r.path, truncated_suffix(&text))
        })
        .collect();
    format!("{}\n\n{}", header(results), blocks.join("\n\n"))
}

/// `renderRichBatch`: a batch holding a structured result stays structured.
pub(super) fn render_rich(results: &[Resolved]) -> Vec<ToolPart> {
    let mut parts = vec![ToolPart::Text(header(results))];
    let mut seen_text: Vec<(usize, &str, String, String)> = Vec::new();
    let mut seen_rich: Vec<(usize, usize, &str, String)> = Vec::new();
    for (i, r) in results.iter().enumerate() {
        let text = r.body.text();
        let (label, tag) = (r.label(), r.tag());
        let entry_header = format!("{}{tag} [{}]{}", r.path, status(&r.body), truncated_suffix(&text));
        let prior = match &r.body {
            CBody::Rich { .. } => seen_rich.iter().find(|(_, p, path, l)| *p == r.producer && *path == r.path && *l == label).map(|(idx, _, _, _)| *idx),
            CBody::Str(s) => seen_text.iter().find(|(_, path, l, b)| *path == r.path && *l == label && b == s).map(|(idx, _, _, _)| *idx),
        };
        if let Some(idx) = prior {
            parts.push(ToolPart::Text(format!("{entry_header} [= entry #{}, identical result omitted]", idx + 1)));
            continue;
        }
        match &r.body {
            CBody::Rich { parts: blocks, .. } => {
                seen_rich.push((i, r.producer, &r.path, label));
                parts.push(ToolPart::Text(entry_header));
                parts.extend(blocks.iter().cloned());
            }
            CBody::Str(s) => {
                seen_text.push((i, &r.path, label, s.clone()));
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
        assert_eq!(slice_read_body(body, 1, Some(1), 1), "2→b\n[lines 2-2; offset:3 for more]");
    }
}
