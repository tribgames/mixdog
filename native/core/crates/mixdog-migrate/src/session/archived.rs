//! The archived results of reaped agent children (`store-summary-archived-agent.mjs`). A child whose record a terminal
//! reaper unlinked is read through the parents its metadata names (`agent-workers.json` links, then its
//! `session-summaries.json` + `.log` catalog row), from the newest completion notification a parent carries for it.
//! The migration keeps each such result in the parent that carries it, under the header's `archivedAgentResults`,
//! keyed by the child id; the store indexes them by child, so the read never scans other sessions.

use mixdog_js::js_trim;
use mixdog_js::time::date_parse;
use mixdog_js::to_number;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use mixdog_js::js_object_keys;

use super::source::AGENT_WORKERS;
use super::source::clean;
use super::source::is_session_id;
use crate::json;

/// `Object.values` of an id-keyed worker map, in JS key order.
fn index_rows_of(rows: &Map<String, Value>) -> Vec<Value> {
    js_object_keys(rows).into_iter().map(|k| rows[k.as_str()].clone()).collect()
}

/// A JS number as JSON: an integral value as an integer.
fn num(n: f64) -> Value {
    if n.fract() == 0.0 && n.abs() < 9_007_199_254_740_992.0 { json!(n as i64) } else { json!(n) }
}

pub const SESSION_SUMMARIES: &str = "session-summaries.json";
pub const SESSION_SUMMARIES_LOG: &str = "session-summaries.log";
/// The files the parent links are read from.
pub const LINK_FILES: [&str; 3] = [AGENT_WORKERS, SESSION_SUMMARIES, SESSION_SUMMARIES_LOG];
/// Under `retire/data/`: one item per child whose parents none migrates (`readArchivedAgentResult` answers null).
pub const DROPPED_PREFIX: &str = "archived-agent";
pub use mixdog_store::archived_agent::HEADER_KEY;
/// `SESSION_SUMMARY_INDEX_VERSION`.
const SUMMARY_INDEX_VERSION: f64 = 2.0;

fn parse(bytes: Option<&[u8]>) -> Option<Value> {
    json::parse_source(bytes?).ok().map(|parsed| parsed.value)
}

/// `listStoredAgentWorkerLinks` (`store-agent-worker-rows.mjs` `workerLinks`): `(sessionId, parent, owner)` per row.
fn worker_links(workers: Option<&[u8]>) -> Vec<(String, String, String)> {
    let Some(doc) = parse(workers) else { return Vec::new() };
    let rows: Vec<Value> = match doc.get("workers") {
        Some(Value::Array(rows)) => rows.clone(),
        Some(Value::Object(rows)) => index_rows_of(rows),
        _ => Vec::new(),
    };
    rows.iter()
        .filter(|row| row.is_object())
        .filter_map(|row| {
            let session = clean(row.get("sessionId"));
            let parent = clean(row.get("parentSessionId"));
            let owner = clean(row.get("ownerSessionId").filter(|v| json::js_truthy(Some(v))).or(row.get("parentSessionId")));
            if !is_session_id(&session) || (parent.is_empty() && owner.is_empty()) {
                return None;
            }
            let (parent, owner) = match (parent.is_empty(), owner.is_empty()) {
                (true, _) => (owner.clone(), owner),
                (_, true) => (parent.clone(), parent),
                _ => (parent, owner),
            };
            Some((session, parent, owner))
        })
        .collect()
}

/// The catalog rows by id (`ordinaryCatalog.loadIndex().rowsById`): the version-2 base with the delta log's upserts
/// and removals replayed over it (`applySummaryLogText`; a move only re-points storage fields).
fn catalog_rows(base: Option<&[u8]>, log: Option<&[u8]>) -> indexmap::IndexMap<String, Value> {
    let mut rows = indexmap::IndexMap::new();
    let Some(base) = parse(base) else { return rows };
    if base.get("version").map_or(f64::NAN, to_number) != SUMMARY_INDEX_VERSION {
        return rows;
    }
    for row in base.get("rows").and_then(Value::as_array).into_iter().flatten() {
        if let Some(id) = row.get("id").and_then(Value::as_str) {
            rows.insert(id.to_owned(), row.clone());
        }
    }
    let text = log.map(String::from_utf8_lossy).unwrap_or_default();
    for line in text.split('\n').filter(|line| !line.is_empty()) {
        let Ok(op) = json::parse_source(line.as_bytes()) else { continue };
        let op = op.value;
        if let Some(row) = op.get("u").filter(|u| u.get("id").is_some_and(Value::is_string)) {
            rows.insert(row["id"].as_str().unwrap_or_default().to_owned(), row.clone());
        } else if let Some(ids) = op.get("r").and_then(Value::as_array) {
            for id in ids.iter().filter_map(Value::as_str) {
                rows.shift_remove(id);
            }
        }
    }
    rows
}

/// Every child the link files name, with the parent ids `parentSessionIds` gives it, in its order: each worker link's
/// parent and owner, then the catalog row's, once each, without the child itself, valid ids only.
pub fn parents(workers: Option<&[u8]>, summaries: Option<&[u8]>, log: Option<&[u8]>) -> Vec<(String, Vec<String>)> {
    let links = worker_links(workers);
    let rows = catalog_rows(summaries, log);
    let mut children: Vec<String> = Vec::new();
    for child in links.iter().map(|(c, _, _)| c).chain(rows.keys()) {
        if !children.contains(child) {
            children.push(child.clone());
        }
    }
    children
        .into_iter()
        .map(|child| {
            let mut named: Vec<String> = Vec::new();
            for (_, parent, owner) in links.iter().filter(|(c, _, _)| *c == child) {
                named.extend([parent.clone(), owner.clone()]);
            }
            if let Some(row) = rows.get(&child) {
                named.extend([clean(row.get("parentSessionId")), clean(row.get("ownerSessionId"))]);
            }
            let mut out: Vec<String> = Vec::new();
            for id in named {
                if id != child && is_session_id(&id) && !out.contains(&id) {
                    out.push(id);
                }
            }
            (child, out)
        })
        .collect()
}

/// `/Async agent task .* finished\./` on the text before the result marker.
fn names_a_finished_task(text: &str) -> bool {
    text.split(['\n', '\r', '\u{2028}', '\u{2029}']).any(|line| {
        const HEAD: &str = "Async agent task ";
        line.find(HEAD).is_some_and(|at| line[at + HEAD.len()..].contains(" finished."))
    })
}

/// `/^([A-Za-z][A-Za-z0-9_]*):\s*(.*?)\s*$/`.
fn header_line(line: &str) -> Option<(&str, &str)> {
    let (key, rest) = line.split_once(':')?;
    let mut chars = key.chars();
    if !chars.next().is_some_and(|c| c.is_ascii_alphabetic()) || !chars.all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return None;
    }
    let value = js_trim(rest);
    (!value.contains(['\r', '\u{2028}', '\u{2029}'])).then_some((key, value))
}

/// `archivedAgentNotification(content, sessionId)`: the result a parent's message carries for `child`.
fn notification(content: &str, child: &str) -> Option<Map<String, Value>> {
    const MARKER: &str = "\n\nResult:\n";
    let at = content.find(MARKER)?;
    if !names_a_finished_task(&content[..at]) {
        return None;
    }
    let lines: Vec<&str> = content[at + MARKER.len()..]
        .split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
        .map(|line| match line.strip_prefix('>') {
            Some(rest) => rest.strip_prefix(|c: char| js_trim(&c.to_string()).is_empty()).unwrap_or(rest),
            None => line,
        })
        .collect();
    let divider = lines.iter().position(|line| js_trim(line).is_empty())?;
    let mut headers: Map<String, Value> = Map::new();
    for line in &lines[..divider] {
        if let Some((key, value)) = header_line(line) {
            headers.insert(key.to_owned(), json!(value));
        }
    }
    let text = |key: &str| clean(headers.get(key));
    if headers.get("surface").and_then(Value::as_str) != Some("agent") || headers.get("sessionId").and_then(Value::as_str) != Some(child) {
        return None;
    }
    let status = text("status").to_lowercase();
    if !matches!(status.as_str(), "completed" | "failed" | "cancelled") {
        return None;
    }
    let body = js_trim(&lines[divider + 1..].join("\n")).to_owned();
    if body.is_empty() {
        return None;
    }
    let tag = clean(headers.get("tag").filter(|v| json::js_truthy(Some(v))).or(headers.get("label")));
    let finished = date_parse(&text("finished"));
    let mut out = Map::new();
    out.insert("body".into(), json!(body));
    out.insert("status".into(), json!(status));
    out.insert("tag".into(), json!(tag));
    out.insert("agent".into(), json!(text("agent")));
    out.insert("provider".into(), json!(text("provider")));
    out.insert("model".into(), json!(text("model")));
    out.insert("effort".into(), json!(text("effort")));
    out.insert("fast".into(), json!(text("fast").to_lowercase() == "true"));
    out.insert("finishedAt".into(), json!(if finished.is_finite() && finished != 0.0 { finished } else { 0.0 }));
    Some(out)
}

/// `desktopSession(value, cwd)` (`store-summary-fields.mjs`).
fn desktop_session(value: Option<&Value>, cwd: &str) -> Value {
    let Some(value) = value.filter(|v| v.is_object()) else { return Value::Null };
    match value.get("classification").and_then(Value::as_str) {
        Some("task") => json!({ "classification": "task", "projectPath": null }),
        Some("project") => {
            let path = value.get("projectPath").and_then(Value::as_str).map(js_trim).filter(|p| !p.is_empty()).unwrap_or(cwd);
            if path.is_empty() { Value::Null } else { json!({ "classification": "project", "projectPath": path }) }
        }
        _ => Value::Null,
    }
}

/// `positiveNumber(value, fallback)`.
fn positive(value: Option<&Value>, fallback: f64) -> f64 {
    let n = value.map_or(f64::NAN, to_number);
    if n.is_finite() && n > 0.0 { n } else { fallback }
}

/// The results this session (`id`, its 1.4.5 `header` and `messages`) carries for the children `parents` names it a
/// parent of, which `migrates` says have no session of their own: per child, the newest notification of it as
/// `readArchivedAgentResult` takes it from this parent, with `at` (the time it compares parents by) and `rank` (this
/// parent's place in the child's parent order, which settles a tie in that order).
pub fn results(
    id: &str,
    header: &Map<String, Value>,
    messages: &[Value],
    parents: &[(String, Vec<String>)],
    migrates: impl Fn(&str) -> bool,
) -> Map<String, Value> {
    let mut out: Vec<(String, Value)> = Vec::new();
    for (child, named) in parents {
        let Some(rank) = named.iter().position(|p| p == id) else { continue };
        if migrates(child) {
            continue;
        }
        let found = messages.iter().rev().filter(|m| m.get("role").and_then(Value::as_str) == Some("user")).find_map(|m| {
            let content = m.get("content").and_then(Value::as_str).unwrap_or_default();
            notification(content, child).map(|entry| (m, entry))
        });
        let Some((message, mut entry)) = found else { continue };
        let finished = entry["finishedAt"].as_f64().unwrap_or_default();
        let fallback = if finished != 0.0 { finished } else { positive(header.get("updatedAt"), 0.0) };
        let at = positive(message.pointer("/meta/transcript/at"), fallback);
        entry.shift_remove("finishedAt");
        entry.insert("at".into(), num(at));
        entry.insert("rank".into(), json!(rank));
        entry.insert("cwd".into(), json!(clean(header.get("cwd"))));
        entry.insert("desktopSession".into(), desktop_session(header.get("desktopSession"), &clean(header.get("cwd"))));
        out.push((child.clone(), Value::Object(entry)));
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out.into_iter().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_header_line_is_a_word_a_colon_and_a_trimmed_value() {
        assert_eq!(header_line("sessionId:  sess_a  "), Some(("sessionId", "sess_a")));
        assert_eq!(header_line("1x: y"), None);
        assert_eq!(header_line("a-b: y"), None);
        assert_eq!(header_line("a: x\ry"), None);
    }

    #[test]
    fn the_finished_line_needs_text_between_the_task_and_finished() {
        assert!(names_a_finished_task("Async agent task t (completed) finished."));
        assert!(!names_a_finished_task("Async agent task finished."));
        assert!(!names_a_finished_task("Async agent task t\n finished."));
    }
}
