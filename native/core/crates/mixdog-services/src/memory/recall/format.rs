//! Rendering of recall rows into the text a model reads: one line per entry
//! (or per member turn), newest-first or chronological, grouped by session for
//! browses, with near-duplicate bodies collapsed to `#id` stubs.

use mixdog_js::{js_trim, JsRegex, slice_utf16, utf16_len};
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;


use crate::memory::clean::clean_memory_text;
use crate::memory::recall::period::{Clock, Window, format_local_minute, format_ts};
use crate::memory::recall::row::{Row, compare_newest_first, compare_oldest_first};

const NO_RESULTS: &str = "(no results)";

#[derive(Debug, Clone)]
pub struct RenderOptions {
    pub recency_order: bool,
    pub chronological_order: bool,
    pub pending_marks: bool,
    /// None disables the per-line body cap.
    pub max_body_chars: Option<usize>,
    pub compact_timestamps: bool,
    pub preserve_source: bool,
    pub include_root_source: bool,
    pub source_window: Option<Window>,
}

impl Default for RenderOptions {
    fn default() -> Self {
        Self {
            recency_order: false,
            chronological_order: false,
            pending_marks: true,
            max_body_chars: Some(8000),
            compact_timestamps: false,
            preserve_source: false,
            include_root_source: false,
            source_window: None,
        }
    }
}

static LEGACY_SOURCE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^(?:transcript|session):", "i"));

pub fn search_haystack(row: &Row) -> String {
    format!("{} {} {}", row.content(), row.element(), row.summary()).to_lowercase()
}

fn role_tag(role: &str) -> String {
    match role {
        "user" => "u".into(),
        "assistant" => "a".into(),
        "" => "?".into(),
        other => other.to_owned(),
    }
}

fn event_mark(row: &Row, enabled: bool) -> String {
    if !enabled {
        return String::new();
    }
    let element = clean_memory_text(row.historical_root_element.as_deref().unwrap_or_default());
    let summary = clean_memory_text(row.historical_root_summary.as_deref().unwrap_or_default());
    if element.is_empty() && summary.is_empty() {
        return String::new();
    }
    let parts: Vec<&str> = [element.as_str(), summary.as_str()].into_iter().filter(|p| !p.is_empty()).collect();
    format!(" [event: {}]", parts.join(" — "))
}

fn standalone_body(row: &Row, preserve_source: bool) -> String {
    let (element, summary) = (row.element(), row.summary());
    if !element.is_empty() || !summary.is_empty() {
        let tail = if summary.is_empty() { String::new() } else { format!(" — {summary}") };
        return format!("{element}{tail}");
    }
    if preserve_source || row.compact_raw { row.content().to_owned() } else { clean_memory_text(row.content()) }
}

/// Raw rows spread among the ranked rows at an even stride.
pub fn interleave_raw_rows(hybrid: Vec<Row>, raw: Vec<Row>) -> Vec<Row> {
    if raw.is_empty() {
        return hybrid;
    }
    let stride = ((hybrid.len() as f64 / (raw.len() + 1) as f64).round() as usize).max(1);
    let mut raw = raw.into_iter();
    let mut out = Vec::new();
    let mut pending = raw.next();
    for (i, row) in hybrid.into_iter().enumerate() {
        out.push(row);
        if (i + 1) % stride == 0
            && let Some(next) = pending.take() {
                out.push(next);
                pending = raw.next();
            }
    }
    out.extend(pending);
    out.extend(raw);
    out
}

struct Renderer<'a> {
    clock: &'a Clock,
    compact: bool,
    body_limit: Option<usize>,
}

impl Renderer<'_> {
    fn collected(row: &Row) -> bool {
        row.time_source.as_deref() == Some("collected")
    }

    fn stamp(&self, row: &Row) -> String {
        if !self.compact {
            return format!("[{}] ", format_ts(self.clock, row.ts));
        }
        if Self::collected(row) { String::new() } else { format!("[{}] ", format_local_minute(self.clock, row.ts)) }
    }

    fn bound(&self, text: &str) -> String {
        match self.body_limit {
            Some(limit) if utf16_len(text) > limit => slice_utf16(text, limit),
            _ => text.to_owned(),
        }
    }

    fn time_source_mark(&self, row: &Row) -> &'static str {
        if Self::collected(row) {
            return if self.compact { "" } else { " [time=collected]" };
        }
        if row.time_source.is_none() && LEGACY_SOURCE.is_match(row.source_ref.as_deref().unwrap_or_default()) {
            return " [time=legacy; event-time=unverified]";
        }
        ""
    }
}

/// One emitted line with the identity the order comparators use.
fn unit(row: &Row, text: String) -> (Row, String) {
    let identity =
        Row { id: row.id, core: row.core, ts: row.ts, source_turn: row.source_turn, session_id: row.session_id.clone(), ..Row::default() };
    (identity, text)
}

fn row_members(row: &Row, options: &RenderOptions) -> Vec<Row> {
    let members = row.member_list();
    let window = options.source_window.unwrap_or_default();
    let in_window = window.start_ms.is_none_or(|from| row.ts >= from) && window.end_ms.is_none_or(|to| row.ts <= to);
    let include_root = options.include_root_source
        && row.is_root == 1
        && in_window
        && !row.content().is_empty()
        && !members.iter().any(|m| m.id == row.id);
    let mut out = Vec::with_capacity(members.len() + 1);
    if include_root {
        out.push(row.clone());
    }
    out.extend(members.iter().cloned());
    out
}

fn row_units(row: &Row, render: &Renderer<'_>, options: &RenderOptions) -> Vec<(Row, String)> {
    if row.dup_stub {
        return vec![unit(
            row,
            format!(
                "[{}] (near-duplicate of #{} — collapsed){} #{}",
                format_ts(render.clock, row.ts),
                row.dup_of.unwrap_or_default(),
                render.time_source_mark(row),
                row.display_id()
            ),
        )];
    }
    if row.compact_body {
        return vec![unit(row, row.summary().to_owned())];
    }
    let members = row_members(row, options);
    if !members.is_empty() {
        return members
            .iter()
            .enumerate()
            .map(|(index, member)| {
                let source = member.content();
                let content = render.bound(&if options.preserve_source { source.to_owned() } else { clean_memory_text(source) });
                unit(
                    member,
                    format!(
                        "{}{}: {}{}{} #{}",
                        render.stamp(member),
                        role_tag(member.role()),
                        content,
                        event_mark(row, index == 0),
                        render.time_source_mark(member),
                        member.display_id()
                    ),
                )
            })
            .collect();
    }
    let role_prefix = if row.is_root == 0 && !row.role().is_empty() { format!("{}: ", role_tag(row.role())) } else { String::new() };
    let body = standalone_body(row, options.preserve_source);
    let pending = if options.pending_marks && row.is_root == 0 && row.chunk_root.is_none() { " [pending]" } else { "" };
    vec![unit(
        row,
        format!(
            "{}{}{}{}{}{} #{}",
            render.stamp(row),
            role_prefix,
            render.bound(&body),
            event_mark(row, true),
            pending,
            render.time_source_mark(row),
            row.display_id()
        ),
    )]
}

pub fn render_entry_lines(clock: &Clock, rows: &[Row], options: &RenderOptions) -> String {
    if rows.is_empty() {
        return NO_RESULTS.to_owned();
    }
    let render = Renderer { clock, compact: options.compact_timestamps, body_limit: options.max_body_chars };
    let mut units: Vec<(Row, String)> = rows.iter().flat_map(|row| row_units(row, &render, options)).collect();
    if options.chronological_order {
        units.sort_by(|a, b| compare_oldest_first(&a.0, &b.0));
    } else if options.recency_order {
        units.sort_by(|a, b| compare_newest_first(&a.0, &b.0));
    }
    units.into_iter().map(|(_, text)| text).collect::<Vec<_>>().join("\n")
}

fn normalized_row_text(row: &Row) -> String {
    if !row.member_list().is_empty() {
        return row.member_list().iter().map(|m| clean_memory_text(m.content())).collect::<Vec<_>>().join(" ").to_lowercase();
    }
    let (element, summary) = (row.element(), row.summary());
    if !element.is_empty() || !summary.is_empty() {
        format!("{element} {summary}").to_lowercase()
    } else {
        clean_memory_text(row.content()).to_lowercase()
    }
}

fn exact_duplicate_key(row: &Row) -> String {
    if !row.member_list().is_empty() {
        let members: Vec<(String, String)> =
            row.member_list().iter().map(|m| (m.role().to_owned(), clean_memory_text(m.content()))).collect();
        return serde_json::json!(["members", members]).to_string();
    }
    let plain = Row { compact_raw: false, ..row.clone() };
    serde_json::json!([row.role(), standalone_body(&plain, false)]).to_string()
}

fn collapse_exact_duplicate_rows(rows: Vec<Row>) -> Vec<Row> {
    if rows.len() < 2 {
        return rows;
    }
    let mut seen = HashSet::new();
    rows.into_iter().filter(|row| seen.insert(exact_duplicate_key(row))).collect()
}

static WORDS: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"[\p{L}\p{N}_]+", "u"));

fn row_shingles(row: &Row, min_tokens: usize) -> Option<HashSet<String>> {
    let text = normalized_row_text(row);
    let tokens: Vec<&str> = WORDS.find_iter(&text).map(|range| &text[range]).collect();
    if tokens.len() < min_tokens {
        return None;
    }
    if tokens.len() < 3 {
        return Some(tokens.iter().map(|t| (*t).to_owned()).collect());
    }
    Some(tokens.windows(3).map(|w| format!("{} {} {}", w[0], w[1], w[2])).collect())
}

fn duplicate_verdict(shingles: &HashSet<String>, kept: &[(i64, HashSet<String>)], drop_overlap: f64) -> (bool, f64, Option<i64>) {
    let (mut best_stub, mut best_id, mut drop) = (0.0f64, None, false);
    for (kept_id, other) in kept {
        let (small, large) = if shingles.len() <= other.len() { (shingles, other) } else { (other, shingles) };
        let inter = small.iter().filter(|g| large.contains(*g)).count() as f64;
        let containment = if small.is_empty() { 0.0 } else { inter / small.len() as f64 };
        let union = (shingles.len() + other.len()) as f64 - inter;
        let jaccard = if union > 0.0 { inter / union } else { 0.0 };
        let size_ratio = if large.is_empty() { 0.0 } else { small.len() as f64 / large.len() as f64 };
        if jaccard >= 0.85 || (containment >= drop_overlap && size_ratio >= 0.5) {
            drop = true;
        }
        if containment > best_stub {
            best_stub = containment;
            best_id = Some(*kept_id);
        }
    }
    (drop, best_stub, best_id)
}

/// Later rows that restate an earlier one are dropped, or become `#id` stubs
/// when they paraphrase it. Short bodies are never collapsed.
pub fn collapse_near_duplicate_rows(rows: Vec<Row>) -> Vec<Row> {
    const STUB_OVERLAP: f64 = 0.65;
    const DROP_OVERLAP: f64 = 0.9;
    const MIN_TOKENS: usize = 12;
    if rows.len() < 2 {
        return rows;
    }
    let mut kept: Vec<(i64, HashSet<String>)> = Vec::new();
    let mut out = Vec::new();
    for mut row in rows {
        let Some(shingles) = row_shingles(&row, MIN_TOKENS) else {
            out.push(row);
            continue;
        };
        let (drop, best_stub, best_id) = duplicate_verdict(&shingles, &kept, DROP_OVERLAP);
        if drop {
            continue;
        }
        if best_stub >= STUB_OVERLAP {
            row.dup_stub = true;
            row.dup_of = best_id;
            out.push(row);
            continue;
        }
        kept.push((row.id, shingles));
        out.push(row);
    }
    out
}

/// Compact digests are authoritative state: duplicates leave completely.
pub fn compact_digest_rows(rows: Vec<Row>, limit: usize) -> Vec<Row> {
    let cap = limit.max(1);
    collapse_near_duplicate_rows(collapse_exact_duplicate_rows(rows)).into_iter().filter(|r| !r.dup_stub).take(cap).collect()
}

fn short_session_label(sid: &str) -> String {
    let sid = js_trim(sid);
    if utf16_len(sid) <= 20 { return sid.to_owned() }
    let tail: Vec<char> = sid.chars().rev().take(16).collect();
    format!("…{}", tail.into_iter().rev().collect::<String>())
}

#[derive(Debug, Clone)]
pub struct SessionMeta {
    pub min_ts: i64,
    pub max_ts: i64,
    pub fetched_count: usize,
    pub shown_count: usize,
    pub query_filtered: bool,
}

fn span_header_suffix(clock: &Clock, min_ts: i64, max_ts: i64, n: usize) -> String {
    let min = format_local_minute(clock, min_ts);
    let max = format_local_minute(clock, max_ts);
    let start = &min[5..];
    let end = if min[..10] == max[..10] { &max[11..] } else { &max[5..] };
    format!("({start} ~ {end}, {n} entries)")
}

fn span_group_suffix(clock: &Clock, rows: &[Row], meta: Option<&SessionMeta>) -> String {
    let all_ts: Vec<i64> = rows.iter().flat_map(|r| std::iter::once(r.ts).chain(r.member_list().iter().map(|m| m.ts))).collect();
    let mut suffix = format!(" ({} entries)", rows.len());
    if let Some(meta) = meta {
        suffix = format!(" {}", span_header_suffix(clock, meta.min_ts, meta.max_ts, rows.len()));
    } else if let (Some(min), Some(max)) = (all_ts.iter().min(), all_ts.iter().max()) {
        suffix = format!(" {}", span_header_suffix(clock, *min, *max, rows.len()));
    }
    let note = meta
        .filter(|m| m.query_filtered)
        .map(|m| format!(" · query-filtered {}/{} rows", m.shown_count, m.fetched_count))
        .unwrap_or_default();
    format!("{suffix}{note}")
}

#[derive(Debug, Clone, Default)]
pub struct GroupedOptions {
    pub current_session_id: String,
    pub recency_order: bool,
    pub span_headers: bool,
    pub preserve_source: bool,
    pub include_root_source: bool,
}

/// Session-grouped rendering for browses spanning several sessions.
pub fn render_session_grouped_lines(
    clock: &Clock,
    rows: &[Row],
    session_meta: &[(String, SessionMeta)],
    options: &GroupedOptions,
) -> String {
    let render_options = RenderOptions {
        recency_order: options.recency_order,
        preserve_source: options.preserve_source,
        include_root_source: options.include_root_source,
        ..RenderOptions::default()
    };
    let has_meta = options.span_headers && !session_meta.is_empty();
    if rows.is_empty() && !has_meta {
        return NO_RESULTS.to_owned();
    }
    let mut order: Vec<String> = Vec::new();
    let mut groups: HashMap<String, Vec<Row>> = HashMap::new();
    if has_meta {
        for (sid, _) in session_meta {
            if !groups.contains_key(sid) {
                order.push(sid.clone());
                groups.insert(sid.clone(), Vec::new());
            }
        }
    }
    for row in rows {
        let sid = js_trim(row.session());
        let key = if sid.is_empty() { "(no session)".to_owned() } else { sid.to_owned() };
        if !groups.contains_key(&key) {
            order.push(key.clone());
        }
        groups.entry(key).or_default().push(row.clone());
    }
    if !options.span_headers && order.len() <= 1 {
        return render_entry_lines(clock, rows, &render_options);
    }
    let current = js_trim(&options.current_session_id);
    let mut parts = Vec::new();
    for sid in &order {
        let group = &groups[sid];
        let mark = if !current.is_empty() && sid == current { " (current)" } else { "" };
        let label = if sid == "(no session)" { sid.clone() } else { format!("session {}", short_session_label(sid)) };
        let meta = session_meta.iter().find(|(id, _)| id == sid).map(|(_, m)| m);
        let suffix = if options.span_headers { span_group_suffix(clock, group, meta) } else { String::new() };
        parts.push(format!("## {label}{mark}{suffix}"));
        let body = render_entry_lines(clock, group, &render_options);
        if body != NO_RESULTS {
            parts.push(body);
        }
    }
    parts.join("\n")
}
