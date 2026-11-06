//! The heartbeat's digest (mixy-heartbeat.mjs `composeDigest`, `readSessionTail`): the bounded
//! lines of what happened since the last check, built with no model, and the quoting rules that
//! keep other sessions' words data.

use async_trait::async_trait;
use mixdog_js::{js_trim_end, js_words, slice_utf16, utf16_len};
use mixdog_tools::exec::escape_harness_tags;
use serde_json::Value;

use super::state::{HOUR_MS, HeartbeatState, millis};
use crate::bots::routine::RoutineKind;

/// A failing routine is reported once, then at most this often while it still fails.
pub const REPEAT_MS: i64 = 6 * HOUR_MS;
/// A routine failing this many times in a row wakes Mixy without the Maintainer.
pub const FAILURES_TO_WAKE: u32 = 3;
/// `ROUTINE_LIMITS.pauseAfterFailures`: a routine that switched itself off.
pub const PAUSE_AFTER_FAILURES: u32 = 5;
const MAX_ROUTINE_LINES: usize = 10;
const MAX_TASK_LINES: usize = 8;
const MAX_SESSION_LINES: usize = 8;
const TEXT_LIMIT: usize = 120;
const DIGEST_LIMIT: usize = 4000;
/// A review reads a session's latest `TAIL_ITEMS` transcript items and takes the latest
/// `TAIL_MESSAGES` user and assistant messages after its cursor, each cut to `TAIL_TEXT_LIMIT`.
pub const TAIL_ITEMS: usize = 40;
const TAIL_MESSAGES: usize = 12;
const TAIL_TEXT_LIMIT: usize = 400;

/// `cut(escapeHarnessTags(oneLine(value)), max)` of `bot-status.mjs`: text a bot or session
/// wrote as one line, tag-shaped text escaped, bounded to `max` UTF-16 units.
pub fn quoted_text(value: &str, max: usize) -> String {
    let one_line = js_words(value).collect::<Vec<_>>().join(" ");
    let escaped = escape_harness_tags(&one_line);
    if utf16_len(&escaped) > max {
        let head = slice_utf16(&escaped, max.saturating_sub(1));
        format!("{}…", js_trim_end(&head))
    } else {
        escaped
    }
}

/// JS truthiness of a stored value.
fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// One session or task session with news.
#[derive(Clone, Debug, PartialEq)]
pub struct Entry {
    pub id: String,
    pub bot: String,
    pub title: String,
    pub preview: String,
    /// A group-room seat (sessions only).
    pub room: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct RoutineFact {
    pub kind: RoutineKind,
    pub name: String,
    pub enabled: bool,
    pub failures: u32,
}

/// What happened since a watermark.
#[derive(Clone, Debug, PartialEq, Default)]
pub struct Facts {
    pub sessions: Vec<Entry>,
    pub tasks: Vec<Entry>,
    pub approvals: u64,
    pub routines: Vec<RoutineFact>,
}

/// A routine line the digest carries.
#[derive(Clone, Debug, PartialEq)]
pub struct ReportedRoutine {
    pub key: String,
    pub paused: bool,
    pub severe: bool,
    pub text: String,
}

/// The line a review is made of and the session behind it.
#[derive(Clone, Debug, PartialEq)]
pub struct Subject {
    pub index: usize,
    pub id: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Digest {
    pub lines: Vec<String>,
    pub subjects: Vec<Subject>,
    pub routines: Vec<ReportedRoutine>,
    /// Routines to close: a success, or gone.
    pub closed: Vec<String>,
    pub approvals: u64,
}

fn plural(count: usize, one: &str, many: &str) -> String {
    if count == 1 { one.to_owned() } else { many.to_owned() }
}

fn more_tasks(count: usize) -> String {
    format!("{count} more task session{} finished", plural(count, "", "s"))
}

fn more_sessions(count: usize) -> String {
    format!("{count} more session{} had new activity", plural(count, "", "s"))
}

/// Builds the digest lines.
struct Lines {
    lines: Vec<String>,
    size: usize,
    reserved: usize,
}

impl Lines {
    fn add(&mut self, text: String) -> bool {
        let len = utf16_len(&text);
        if self.size + len + 1 + self.reserved > DIGEST_LIMIT {
            return false;
        }
        self.size += len + 1;
        self.lines.push(text);
        true
    }
}

/// Room for an overflow line at its longest, held back from every detailed line.
fn room(rows: &[Entry], more: fn(usize) -> String) -> usize {
    if rows.is_empty() { 0 } else { utf16_len(&more(rows.len())) + 1 }
}

/// The digest lines of `facts` (bounded) over `state` (read only), the routine items among them
/// and the routines to close. Sessions and tasks past the bounds are counted in one line each.
pub fn compose_digest(facts: &Facts, state: &HeartbeatState, at: i64) -> Digest {
    let mut routines = Vec::new();
    let mut closed = Vec::new();
    let mut known = std::collections::HashSet::new();
    for routine in &facts.routines {
        let key = format!("{}:{}", routine.kind.word(), routine.name);
        known.insert(key.clone());
        let failures = routine.failures;
        if failures < 1 {
            if state.routines.contains_key(&key) {
                closed.push(key);
            }
            continue;
        }
        let paused = !routine.enabled && failures >= PAUSE_AFTER_FAILURES;
        // Switched off by the user: nothing to report.
        if !routine.enabled && !paused {
            continue;
        }
        let entry = state.routines.get(&key);
        let reported_paused = truthy(entry.and_then(|e| e.get("paused")));
        let due = if paused {
            !reported_paused
        } else {
            entry.is_none_or(|e| at - millis(e.get("at")) >= REPEAT_MS)
        };
        if !due {
            continue;
        }
        routines.push(ReportedRoutine {
            key,
            paused,
            severe: failures >= FAILURES_TO_WAKE || (paused && !reported_paused),
            text: format!(
                "{} \"{}\" failed {failures}x in a row{}",
                routine.kind.word(),
                quoted_text(&routine.name, 64),
                if paused { " and switched itself off" } else { "" }
            ),
        });
    }
    for key in state.routines.keys() {
        if !known.contains(key) {
            closed.push(key.clone());
        }
    }
    let (tasks, sessions) = (&facts.tasks, &facts.sessions);
    let mut out = Lines { lines: Vec::new(), size: 0, reserved: room(tasks, more_tasks) + room(sessions, more_sessions) };
    let reported: Vec<ReportedRoutine> =
        routines.into_iter().take(MAX_ROUTINE_LINES).filter(|routine| out.add(routine.text.clone())).collect();
    let approvals = facts.approvals;
    // Only more approvals than the last handled check saw are news: the same ones never wake
    // Mixy twice.
    if approvals > state.approvals {
        out.add(format!("{approvals} approval{} waiting for the user", plural(approvals as usize, "", "s")));
    }
    let mut subjects = Vec::new();
    let mut show = |out: &mut Lines, rows: &[Entry], limit: usize, line: &dyn Fn(&Entry) -> String, more: fn(usize) -> String| {
        let mut shown = 0;
        for row in rows {
            if shown >= limit || !out.add(line(row)) {
                break;
            }
            shown += 1;
            subjects.push(Subject { index: out.lines.len() - 1, id: row.id.clone() });
        }
        out.reserved -= room(rows, more);
        if rows.len() > shown {
            out.add(more(rows.len() - shown));
        }
    };
    show(
        &mut out,
        tasks,
        MAX_TASK_LINES,
        &|task| {
            let preview =
                if task.preview.is_empty() { String::new() } else { format!(", last: \"{}\"", quoted_text(&task.preview, TEXT_LIMIT)) };
            format!("task session {} of bot {} finished: \"{}\"{preview}", task.id, task.bot, quoted_text(&task.title, TEXT_LIMIT))
        },
        more_tasks,
    );
    show(
        &mut out,
        sessions,
        MAX_SESSION_LINES,
        &|session| {
            let owner = if session.bot.is_empty() { String::new() } else { format!(" (bot {})", session.bot) };
            let preview = if session.preview.is_empty() {
                String::new()
            } else {
                format!(", last: \"{}\"", quoted_text(&session.preview, TEXT_LIMIT))
            };
            let place = if session.room { "group room " } else { "" };
            format!("new activity in {place}{}{owner}: \"{}\"{preview}", session.id, quoted_text(&session.title, TEXT_LIMIT))
        },
        more_sessions,
    );
    Digest { lines: out.lines, subjects, routines: reported, closed, approvals }
}

/// What a digest line says of the messages a review left out (`skippedNote`): `skipped` is
/// negative when the cursor was not found.
pub fn skipped_note(skipped: i64, exact: bool) -> String {
    if skipped < 0 {
        return "older messages since the last check could not be found, so some were not reviewed".into();
    }
    if skipped == 0 {
        return if exact { String::new() } else { "older messages since the last check may not have been reviewed".into() };
    }
    let count = format!("{}{skipped}", if exact { "" } else { "at least " });
    let one = skipped == 1 && exact;
    format!(
        "{count} older message{} since the last check {} not reviewed",
        if one { "" } else { "s" },
        if one { "was" } else { "were" }
    )
}

/// Whether a heartbeat turn's reply is exactly the quiet sentinel.
pub fn is_quiet_reply(reply: &str) -> bool {
    mixdog_js::js_trim(reply) == crate::bots::routine::HEARTBEAT_QUIET
}

/// One transcript item of a session read.
#[derive(Clone, Debug, PartialEq)]
pub struct TranscriptItem {
    pub id: Option<String>,
    pub kind: String,
    pub text: String,
}

/// The newest `limit` items of a session's transcript, oldest first.
#[derive(Clone, Debug, PartialEq, Default)]
pub struct TranscriptPage {
    pub items: Vec<TranscriptItem>,
    pub has_older: bool,
}

#[async_trait]
pub trait SessionReader: Send + Sync {
    /// One read of the session's latest `limit` transcript items (`readSession` with
    /// `transcriptRange: { offset: 0, limit }`); an `Err` when the session cannot be read.
    async fn read_tail(&self, session_id: &str, limit: usize) -> Result<TranscriptPage, String>;
}

/// A session's latest conversation for a review, oldest first.
#[derive(Clone, Debug, PartialEq)]
pub struct Tail {
    pub rows: Vec<String>,
    /// The id of the newest item; empty when the items carry none.
    pub head: String,
    /// The older messages in the page left unreviewed: exact when the cursor is in the page,
    /// else a lower bound; `-1` when the supplied cursor is gone (compacted away).
    pub skipped: i64,
    pub exact: bool,
}

/// `readSessionTail`: one read of the latest `TAIL_ITEMS` items (never more, however many tool
/// calls they hold); `rows` is a line per user or assistant message after item `after`, the
/// newest `TAIL_MESSAGES` of them.
pub async fn read_session_tail(reader: &dyn SessionReader, id: &str, after: &str) -> Result<Tail, String> {
    let page = reader.read_tail(id, TAIL_ITEMS).await?;
    let ids: Vec<&str> = page.items.iter().map(|item| item.id.as_deref().unwrap_or("")).collect();
    let head = ids.iter().rfind(|id| !id.is_empty()).copied().unwrap_or("").to_owned();
    let seen = if after.is_empty() { None } else { ids.iter().rposition(|id| *id == after) };
    let from = seen.map_or(0, |at| at + 1);
    let all: Vec<String> = page.items[from..]
        .iter()
        .filter(|item| item.kind == "user" || item.kind == "assistant")
        .filter_map(|item| {
            let text = quoted_text(&item.text, TAIL_TEXT_LIMIT);
            (!text.is_empty()).then(|| format!("{}: \"{text}\"", item.kind))
        })
        .collect();
    let keep_from = all.len().saturating_sub(TAIL_MESSAGES);
    let skipped = keep_from as i64;
    let rows = all[keep_from..].to_vec();
    if !after.is_empty() && seen.is_none() && !page.has_older {
        return Ok(Tail { rows, head, skipped: -1, exact: false });
    }
    let exact = if after.is_empty() { !page.has_older } else { seen.is_some() };
    Ok(Tail { rows, head, skipped, exact })
}
