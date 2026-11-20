//! The maintenance actions of the `memory` tool besides `core`, `status` and `ingest_session`
//! (`memory-action-handlers.mjs` and `memory-action-handlers/*`): `search`, `dump_session_roots`,
//! `prune`, `purge`, `cycle1`, `flush`, `rebuild`, `backfill` and `manage`. The destructive ones keep
//! the confirm phrase they always asked for; nothing here asks more than before.
//!
//! The actions that read or delete rows need only the database; the ones that run cycle1, embed or
//! ingest transcripts need the pieces [`Maintenance`] holds, which the stack attaches when it builds
//! the memory runtime.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use futures::StreamExt;
use mixdog_js::{js_trim, json_number, slice_utf16, to_number, value_to_string};
use mixdog_rt::{DurabilityIo, LaneToken, MaintenanceIo};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::memory::clean::clean_memory_text;
use crate::memory::core::store::VALID_CATEGORIES;
use crate::memory::cycles::rows::PlanOptions;
use crate::memory::cycles::run::{Cycle1Options, Cycle1Result};
use crate::memory::cycles::{CycleConfig, CycleScheduler, log};
use crate::memory::error::{MemoryError, Result};
use crate::memory::ingest::embed_flush::RawEmbedFlush;
use crate::memory::pg::db::{Db, transaction};
use crate::memory::project::resolve_project_scope;
use crate::memory::reply::ToolReply;
use crate::memory::transcript::TranscriptIngest;
use crate::memory::transcript::discovery::{Active, is_skipped_watch_path, is_transcript_jsonl_name, mtime_ms};
use crate::memory::transcript::rows::cwd_from_transcript_path;

/// `actions[action]` of `handleMemoryAction`: a call without an action is `core` (the tool's own entry
/// adds it); any other name outside the table is unknown, and so is a null or empty one.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    Core,
    Status,
    Cycle1,
    Search,
    Flush,
    Rebuild,
    Prune,
    Backfill,
    IngestSession,
    DumpSessionRoots,
    Manage,
    Purge,
}

/// The action `args` names, or the name that is not one.
pub fn parse_action(args: &Value) -> std::result::Result<Action, String> {
    let name = match args.get("action") {
        None => "core".to_owned(),
        Some(Value::Null) => String::new(),
        Some(value) => value_to_string(value),
    };
    Ok(match name.as_str() {
        "core" => Action::Core,
        "status" => Action::Status,
        "cycle1" => Action::Cycle1,
        "search" => Action::Search,
        "flush" => Action::Flush,
        "rebuild" => Action::Rebuild,
        "prune" => Action::Prune,
        "backfill" => Action::Backfill,
        "ingest_session" => Action::IngestSession,
        "dump_session_roots" => Action::DumpSessionRoots,
        "manage" => Action::Manage,
        "purge" => Action::Purge,
        _ => return Err(name),
    })
}

/// The answer to an action outside the table.
pub fn unknown_action_reply(name: &str) -> ToolReply {
    ToolReply::error(format!("unknown memory action: {name}; valid: core, status. Mutation verbs belong in op."))
}

/// `String(value ?? '')`.
fn text_of(value: Option<&Value>) -> String {
    value.filter(|v| !v.is_null()).map(value_to_string).unwrap_or_default()
}

/// The first of `names` that `args` holds and is not null (`a ?? b ?? c`).
fn first_of<'a>(args: &'a Value, names: &[&str]) -> Option<&'a Value> {
    names.iter().find_map(|name| args.get(*name).filter(|v| !v.is_null()))
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// What an action that failed answers: the tool's own failure text.
pub fn failure_reply(error: &MemoryError) -> ToolReply {
    ToolReply::error(format!("memory failed: {}", error.message()))
}

/// `throwIfAborted(signal)`: the checkpoint between the steps of an action a cancelled caller no longer waits for.
fn checkpoint(cancel: &CancellationToken) -> Result<()> {
    if cancel.is_cancelled() { Err(MemoryError::rejected("aborted")) } else { Ok(()) }
}

/// A wait that a cancel ends at once (the signal handed to `awaitCycle1Run`).
async fn unless_cancelled<T>(cancel: &CancellationToken, work: impl std::future::Future<Output = Result<T>>) -> Result<T> {
    tokio::select! {
        biased;
        () = cancel.cancelled() => Err(MemoryError::rejected("aborted")),
        done = work => done,
    }
}

/// A failure that already is a sentence (a cycle's, an embedding's) without the store's prefix.
fn plain(error: MemoryError) -> MemoryError {
    match error {
        MemoryError::Runtime(text) => MemoryError::Rejected(text),
        other => MemoryError::Rejected(other.message()),
    }
}

/// One stored row of a session, as a chunk of its dump.
#[derive(Debug, Clone, PartialEq)]
struct Chunk {
    id: i64,
    root: bool,
    chunk_root: Option<i64>,
    ts: i64,
    source_turn: Option<i32>,
    category: Option<String>,
    summary: String,
    text: String,
}

const NO_TURN: i32 = 2_147_483_647;

/// `roleLine`.
fn role_line(role: &str, content: &str) -> String {
    format!("{role}: {}", clean_memory_text(content))
}

/// `buildSessionChunks`' order: source turn, then timestamp, then id.
fn sort_chunks(chunks: &mut [Chunk]) {
    chunks.sort_by(|a, b| a.source_turn.unwrap_or(NO_TURN).cmp(&b.source_turn.unwrap_or(NO_TURN)).then(a.ts.cmp(&b.ts)).then(a.id.cmp(&b.id)));
}

/// `renderSessionChunks`: one labelled block per chunk.
fn render_chunks(chunks: &[Chunk]) -> String {
    if chunks.is_empty() {
        return "(no results)".to_owned();
    }
    chunks
        .iter()
        .enumerate()
        .map(|(index, chunk)| {
            let label = if chunk.root {
                let category = chunk.category.as_deref().filter(|c| !c.is_empty()).map(|c| format!(" category={c}")).unwrap_or_default();
                format!("# chunk {} root={}{category}", index + 1, chunk.id)
            } else {
                let kind = if chunk.chunk_root.is_none() { "# raw_pending" } else { "# raw_terminal" };
                format!("{kind} {} id={}", index + 1, chunk.id)
            };
            let summary = if chunk.summary.is_empty() { String::new() } else { format!("summary: {}\n", chunk.summary) };
            js_trim(&format!("{label}\n{summary}{}", chunk.text)).to_owned()
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

/// `dumpSessionRootChunks`: the session's roots with the members each owns, then (unless
/// `includeRaw` is false) the raw leaves that belong to no chunk, as one transcript-ordered text.
pub async fn dump_session_roots(db: &Db, args: &Value) -> Result<ToolReply> {
    let truthy_text = |name: &str| args.get(name).filter(|v| truthy(v)).map(value_to_string);
    let session_id = js_trim(&truthy_text("sessionId").or_else(|| truthy_text("session_id")).unwrap_or_default()).to_owned();
    if session_id.is_empty() {
        return Ok(ToolReply::error("(no current session)"));
    }
    let asked = to_number(args.get("limit").unwrap_or(&Value::Null));
    let limit = (if asked.is_nan() || asked == 0.0 { 1000.0 } else { asked }).clamp(1.0, 1000.0).floor() as i64;
    let include_raw = args.get("includeRaw") != Some(&Value::Bool(false));
    let roots = db
        .query(
            "SELECT id, ts, content, source_turn, element, category, summary
             FROM entries
             WHERE session_id = $1 AND is_root = 1
             ORDER BY COALESCE(source_turn, 2147483647) ASC, ts ASC, id ASC
             LIMIT $2",
            &[&session_id, &limit],
        )
        .await?;
    let root_ids: Vec<i64> = roots.iter().map(|row| row.get("id")).collect();
    let members = if root_ids.is_empty() {
        Vec::new()
    } else {
        db.query(
            "SELECT role, content, chunk_root
             FROM entries
             WHERE chunk_root = ANY($1::bigint[]) AND is_root = 0
             ORDER BY chunk_root ASC, COALESCE(source_turn, 2147483647) ASC, ts ASC, id ASC",
            &[&root_ids],
        )
        .await?
    };
    let mut chunks = Vec::new();
    for root in &roots {
        let id: i64 = root.get("id");
        let member_text = members
            .iter()
            .filter(|m| m.get::<_, i64>("chunk_root") == id)
            .map(|m| role_line(&m.get::<_, String>("role"), &m.get::<_, String>("content")))
            .collect::<Vec<_>>()
            .join("\n");
        let parts = [root.get::<_, Option<String>>("element"), root.get::<_, Option<String>>("summary")];
        let summary = parts.iter().flatten().map(|v| js_trim(v)).filter(|v| !v.is_empty()).collect::<Vec<_>>().join(" — ");
        let text = if member_text.is_empty() { clean_memory_text(&root.get::<_, String>("content")) } else { member_text };
        chunks.push(Chunk {
            id,
            root: true,
            chunk_root: None,
            ts: root.get("ts"),
            source_turn: root.get("source_turn"),
            category: root.get("category"),
            summary,
            text,
        });
    }
    if include_raw {
        let raws = db
            .query(
                "SELECT id, ts, role, content, source_turn, chunk_root
                 FROM entries
                 WHERE session_id = $1
                   AND is_root = 0
                   AND (chunk_root IS NULL OR chunk_root = id)
                 ORDER BY COALESCE(source_turn, 2147483647) ASC, ts ASC, id ASC
                 LIMIT $2",
                &[&session_id, &limit],
            )
            .await?;
        for raw in &raws {
            chunks.push(Chunk {
                id: raw.get("id"),
                root: false,
                chunk_root: raw.get("chunk_root"),
                ts: raw.get("ts"),
                source_turn: raw.get("source_turn"),
                category: None,
                summary: String::new(),
                text: role_line(&raw.get::<_, String>("role"), &raw.get::<_, String>("content")),
            });
        }
    }
    sort_chunks(&mut chunks);
    Ok(ToolReply::ok(render_chunks(&chunks)))
}

/// JavaScript truthiness of a JSON value.
pub(crate) fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::String(text) => !text.is_empty(),
        Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        _ => true,
    }
}

// ---- prune, purge -----------------------------------------------------------------------------

/// `prune`: unclassified entries older than `maxDays` (30 by default), after the confirm phrase.
pub async fn prune(db: &Db, args: &Value) -> Result<ToolReply> {
    if args.get("confirm").and_then(Value::as_str) != Some("PRUNE OLD ENTRIES") {
        return Ok(ToolReply::error("prune requires confirm: \"PRUNE OLD ENTRIES\" (permanently deletes unclassified entries older than maxDays)"));
    }
    let asked = first_of(args, &["maxDays"]).map_or(30.0, to_number);
    let days = if asked.is_nan() { asked } else { asked.max(1.0) };
    if days.is_nan() {
        return Err(MemoryError::rejected("pruneOldEntries: maxAgeDays must be positive, got NaN"));
    }
    let cutoff = (now_ms() as f64 - days * 86_400_000.0).floor() as i64;
    let deleted = db
        .execute(
            "DELETE FROM entries
             WHERE ts < $1
               AND (
                 chunk_root IS NULL
                 OR (is_root = 0 AND chunk_root = id AND status = 'archived')
               )",
            &[&cutoff],
        )
        .await?;
    // The trace schema may not exist yet; its dangling references are only tidied when it does.
    let _ = db
        .execute(
            "UPDATE trace.trace_events SET entry_id = NULL
             WHERE entry_id IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM memory.entries WHERE id = trace.trace_events.entry_id)",
            &[],
        )
        .await;
    Ok(ToolReply::ok(format!("prune: deleted {deleted} unclassified entries older than {} days", value_to_string(&json_number(days)))))
}

/// `purge`: every generated entry, after the confirm phrase; curated core memory stays.
pub async fn purge(db: &Db, args: &Value) -> Result<ToolReply> {
    if args.get("confirm").and_then(Value::as_str) != Some("DELETE ALL MEMORY") {
        return Ok(ToolReply::error("purge requires confirm: \"DELETE ALL MEMORY\""));
    }
    let pre: i64 = db.query("SELECT COUNT(*) c FROM entries", &[]).await?[0].get(0);
    let core: i64 = db.query("SELECT COUNT(*) c FROM core_entries", &[]).await?[0].get(0);
    if let Err(error) = db.execute("DELETE FROM entries", &[]).await {
        return Ok(ToolReply::error(format!("purge failed: {}", error.message())));
    }
    Ok(ToolReply::ok(format!("purged generated memory entries (count={pre}); user core preserved (core_entries={core})")))
}

// ---- cycle1 ----------------------------------------------------------------------------------

/// The overrides `cycle1` takes from its arguments: each is pinned at the top level of the config,
/// where the plan reads it first.
const CYCLE1_OVERRIDES: [(&str, &[&str]); 5] = [
    ("min_batch", &["min_batch"]),
    ("session_cap", &["session_cap"]),
    ("batch_size", &["batch_size"]),
    ("window_size", &["window_size", "windowSize"]),
    ("rows_per_session", &["rows_per_session", "rowsPerSession", "max_rows_per_session", "maxRowsPerSession"]),
];

/// `cycle1ConfigFromArgs`.
fn cycle1_config_from_args(args: &Value, base: Value) -> Value {
    let mut config = base;
    let object = config.as_object_mut().expect("the cycle1 config is an object");
    for (key, names) in CYCLE1_OVERRIDES {
        let number = first_of(args, names).map_or(f64::NAN, to_number);
        if number.is_finite() && number > 0.0 {
            object.insert(key.to_owned(), json_number(number));
        }
    }
    let session = js_trim(&text_of(first_of(args, &["sessionId", "session_id"]))).to_owned();
    if !session.is_empty() {
        object.insert("session_id".to_owned(), Value::String(session));
    }
    let concurrency = args.get("concurrency").map_or(f64::NAN, to_number);
    if concurrency.is_finite() && concurrency > 0.0 {
        object.insert("concurrency".to_owned(), json_number(concurrency.floor().min(8.0)));
    }
    config
}

/// `config?.cycle1 || {}`.
fn cycle1_base(config: &Arc<dyn CycleConfig>) -> Value {
    match config.memory_section().get("cycle1") {
        Some(section @ Value::Object(_)) => section.clone(),
        _ => json!({}),
    }
}

/// `cycle1SummaryText`.
fn cycle1_summary(result: &Cycle1Result) -> String {
    let timed_out = if result.timed_out_waiting { " timedOut=true" } else { "" };
    format!(
        "cycle1: chunks={} processed={} skipped_chunks={} omitted={} prefiltered={} failed_rows={} invalid_chunks={} pending={} inFlight={}{timed_out}",
        result.chunks,
        result.processed,
        result.skipped,
        result.omitted_row_ids.len(),
        result.prefiltered_row_ids.len(),
        result.failed_row_ids.len(),
        result.invalid_chunks.len(),
        result.pending_rows.unwrap_or(0),
        result.skipped_in_flight,
    )
}

// ---- rebuild ----------------------------------------------------------------------------------

/// The classification columns cleared before demotion: demoting the roots first and cleaning
/// `is_root = 1` afterwards would miss exactly the rows just demoted.
const REBUILD_RESET: &str = "
UPDATE entries
SET element = NULL, category = NULL, summary = NULL,
    status = 'pending', score = NULL, last_seen_at = NULL,
    embedding = NULL, summary_hash = NULL,
    reviewed_at = NULL, duplicate_of = NULL,
    error_count = 0
WHERE is_root = 1;
UPDATE entries SET chunk_root = NULL, is_root = 0 WHERE chunk_root = id;
UPDATE entries SET chunk_root = NULL WHERE is_root = 0;
UPDATE entries
SET status = NULL,
    element = NULL, category = NULL, summary = NULL,
    score = NULL, last_seen_at = NULL,
    embedding = NULL, summary_hash = NULL,
    reviewed_at = NULL, duplicate_of = NULL,
    error_count = 0
WHERE is_root = 0;";

/// The whole reset in one transaction, so a failure part-way leaves the rows as they were.
async fn reset_classification(db: &Db) -> Result<()> {
    transaction(db, async |tx| Ok(tx.batch_execute(REBUILD_RESET).await?)).await
}

/// How many times the rebuild waits for a run in flight before it resets.
const DRAIN_ROUNDS: usize = 8;

// ---- backfill ---------------------------------------------------------------------------------

/// `normalizeBackfillWindow`.
pub fn normalize_backfill_window(value: &str) -> &'static str {
    match js_trim(value).to_lowercase().as_str() {
        "none" | "off" | "disabled" | "0" => "none",
        "1d" | "1day" | "1-day" | "1 day" | "day" | "today" => "1d",
        "3d" | "3days" | "3-day" | "3 day" => "3d",
        "7d" | "7days" | "7-day" | "7 day" | "week" => "7d",
        "30d" | "30days" | "30-day" | "30 day" | "month" => "30d",
        _ => "all",
    }
}

/// `normalizeBackfillScope`.
pub fn normalize_backfill_scope(value: &str) -> &'static str {
    match js_trim(value).to_lowercase().as_str() {
        "workspace" | "project" | "current" => "workspace",
        _ => "all",
    }
}

/// `resolveBackfillSinceMs`.
fn backfill_since_ms(window: &str, now: i64) -> Option<f64> {
    let days = match window {
        "1d" => 1.0,
        "3d" => 3.0,
        "7d" => 7.0,
        "30d" => 30.0,
        _ => return None,
    };
    Some(now as f64 - days * 86_400_000.0)
}

/// The transcripts under `root/<project>/` modified at or after `since`, unreadable directories and
/// vanished files skipped (`selectBackfillTranscripts`' scan).
async fn scan_transcripts(lane: MaintenanceIo, root: &Path, since: Option<f64>) -> Vec<Active> {
    let root = root.to_owned();
    let job = lane
        .submit_wait(&mixdog_rt::CancellationToken::new(), move |lane| {
            let Ok(top) = mixdog_statefile::list_dir(lane, &root) else { return Vec::new() };
            let mut files = Vec::new();
            for dir in top {
                if is_skipped_watch_path(&dir) {
                    continue;
                }
                let full = root.join(&dir);
                let Ok(inner) = mixdog_statefile::list_dir(lane, &full) else { continue };
                for file in inner.into_iter().filter(|f| is_transcript_jsonl_name(f)) {
                    let path = full.join(&file);
                    let Some(mtime) = mixdog_statefile::metadata(lane, &path).ok().as_ref().and_then(mtime_ms) else { continue };
                    if since.is_some_and(|since| mtime < since) {
                        continue;
                    }
                    files.push(Active { path, mtime });
                }
            }
            files
        })
        .await;
    match job {
        Ok(job) => job.await.unwrap_or_default(),
        Err(_) => Vec::new(),
    }
}

fn normalized_path(path: &Path) -> PathBuf {
    let absolute = std::path::absolute(path).unwrap_or_else(|_| path.to_owned());
    if cfg!(windows) { PathBuf::from(absolute.to_string_lossy().to_lowercase()) } else { absolute }
}

/// Whether `candidate` is `workspace` or inside it.
fn within(workspace: &Path, candidate: &Path) -> bool {
    normalized_path(candidate).starts_with(normalized_path(workspace))
}

/// The files a backfill takes: newest first up to `limit`, then oldest first. `workspace` keeps only
/// the transcripts whose session directory lies inside it.
async fn select_transcripts(lane: MaintenanceIo, root: &Path, since: Option<f64>, limit: Option<f64>, workspace: Option<&Path>) -> Vec<PathBuf> {
    let mut files = scan_transcripts(lane, root, since).await;
    if let Some(workspace) = workspace {
        let mut kept = Vec::new();
        for file in files {
            if let Ok(Some(cwd)) = cwd_from_transcript_path(lane, &file.path).await
                && within(workspace, &cwd)
            {
                kept.push(file);
            }
        }
        files = kept;
    }
    files.sort_by(|a, b| b.mtime.total_cmp(&a.mtime));
    if let Some(limit) = limit.filter(|limit| *limit > 0.0) {
        files.truncate(limit as usize);
    }
    files.into_iter().rev().map(|f| f.path).collect()
}

const FULL_BACKFILL_MAX_ITERS: usize = 30;
const BACKFILL_CONCURRENCY: usize = 3;

async fn count_unclassified(db: &Db) -> Result<i64> {
    Ok(db.query("SELECT COUNT(*) c FROM entries WHERE chunk_root IS NULL", &[]).await?[0].get(0))
}

/// What a backfill reports.
#[derive(Debug, Default)]
struct BackfillReport {
    window: &'static str,
    scope: &'static str,
    files: usize,
    ingested: usize,
    cycle1_iters: usize,
    unclassified: i64,
    errors: Vec<(&'static str, String)>,
}

impl BackfillReport {
    fn reply(&self) -> ToolReply {
        let error = if self.errors.is_empty() {
            String::new()
        } else {
            format!(" error={}", self.errors.iter().map(|(stage, error)| format!("{stage}: {error}")).collect::<Vec<_>>().join("; "))
        };
        let text = format!(
            "backfill: window={} scope={} files={} ingested={} cycle1_iters={} unclassified={}{error}",
            self.window, self.scope, self.files, self.ingested, self.cycle1_iters, self.unclassified
        );
        if self.errors.is_empty() { ToolReply::ok(text) } else { ToolReply::error(text) }
    }
}

/// Ends the backfill's whole-action mutex however the action ends.
struct BackfillTurn<'a>(&'a AtomicBool);

impl Drop for BackfillTurn<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

// ---- manage -----------------------------------------------------------------------------------

/// `trimOrNull`.
fn trim_or_none(value: Option<&Value>) -> Option<String> {
    let text = js_trim(&text_of(value)).to_owned();
    (!text.is_empty()).then_some(text)
}

/// `numericId`: a positive whole number.
fn numeric_id(value: Option<&Value>) -> Option<i64> {
    let id = to_number(value.unwrap_or(&Value::Null));
    (id.is_finite() && id > 0.0 && id.fract() == 0.0).then_some(id as i64)
}

/// A generated record's score at the moment it is written: every category has the one grade and no
/// age yet (`computeEntryScore(category, now, now)`; the row trigger recomputes it on later reads).
const FRESH_SCORE: f32 = 1.6;

fn invalid_category(op: &str, category: &str) -> ToolReply {
    ToolReply::error(format!("manage {op}: invalid category \"{category}\". Valid: {}", VALID_CATEGORIES.join(", ")))
}

async fn manage_delete(db: &Db, args: &Value) -> Result<ToolReply> {
    let Some(id) = numeric_id(args.get("id")) else {
        return Ok(ToolReply::error("manage delete requires numeric id"));
    };
    let Some(info) = db.query_opt("SELECT category, element, is_root FROM entries WHERE id = $1", &[&id]).await? else {
        return Ok(ToolReply::error(format!("manage delete: no entry with id={id}")));
    };
    let removed = if info.get::<_, i16>("is_root") == 1 {
        db.execute("DELETE FROM entries WHERE id = $1 OR chunk_root = $2", &[&id, &id]).await
    } else {
        db.execute("DELETE FROM entries WHERE id = $1", &[&id]).await
    };
    Ok(match removed {
        Ok(rows) => {
            let category = info.get::<_, Option<String>>("category").unwrap_or_else(|| "-".to_owned());
            ToolReply::ok(format!("deleted (id={id}, rows={rows}): [{category}] {}", info.get::<_, Option<String>>("element").unwrap_or_default()))
        }
        Err(error) => ToolReply::error(format!("manage delete failed: {}", error.message())),
    })
}

#[cfg(test)]
#[allow(clippy::disallowed_methods, reason = "test setup writes transcript files")]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::memory::pg::db::Schema;
    use crate::memory::schema::ensure_memory_schema;
    use crate::memory::tests::support::TestPg;

    #[test]
    fn an_action_outside_the_table_is_unknown_and_a_missing_one_is_core() {
        assert_eq!(parse_action(&json!({ "op": "list" })), Ok(Action::Core));
        assert_eq!(parse_action(&json!({ "action": "flush" })), Ok(Action::Flush));
        assert_eq!(parse_action(&json!({ "action": "dump_session_roots" })), Ok(Action::DumpSessionRoots));
        assert_eq!(parse_action(&json!({ "action": "drop_everything" })), Err("drop_everything".into()));
        assert_eq!(parse_action(&json!({ "action": null })), Err(String::new()));
        for name in ["core", "status", "cycle1", "search", "flush", "rebuild", "prune", "backfill", "ingest_session", "dump_session_roots", "manage", "purge"] {
            assert!(parse_action(&json!({ "action": name })).is_ok(), "{name}");
        }
        let reply = unknown_action_reply("drop_everything");
        assert!(reply.is_error);
        assert_eq!(reply.text, "unknown memory action: drop_everything; valid: core, status. Mutation verbs belong in op.");
    }

    #[test]
    fn the_cycle1_overrides_are_pinned_at_the_top_level_and_the_concurrency_is_capped() {
        let args = json!({ "min_batch": 3, "windowSize": "40", "maxRowsPerSession": 7, "sessionId": " s1 ", "concurrency": 20.9, "batch_size": -1, "session_cap": "x" });
        let config = cycle1_config_from_args(&args, json!({ "batch_size": 50, "interval": "10m" }));
        assert_eq!(
            config,
            json!({ "batch_size": 50, "interval": "10m", "min_batch": 3, "window_size": 40, "rows_per_session": 7, "session_id": "s1", "concurrency": 8 })
        );
        assert_eq!(cycle1_config_from_args(&json!({}), json!({})), json!({}));
    }

    #[test]
    fn the_cycle1_summary_counts_what_the_run_left_out() {
        let result = Cycle1Result {
            chunks: 4,
            processed: 9,
            skipped: 1,
            omitted_row_ids: vec![1, 2],
            failed_row_ids: vec![3],
            pending_rows: Some(12),
            timed_out_waiting: true,
            ..Cycle1Result::default()
        };
        assert_eq!(
            cycle1_summary(&result),
            "cycle1: chunks=4 processed=9 skipped_chunks=1 omitted=2 prefiltered=0 failed_rows=1 invalid_chunks=0 pending=12 inFlight=false timedOut=true"
        );
    }

    #[test]
    fn the_backfill_window_and_scope_are_normalised_like_the_old_driver() {
        assert_eq!(normalize_backfill_window(" Week "), "7d");
        assert_eq!(normalize_backfill_window("3 day"), "3d");
        assert_eq!(normalize_backfill_window("off"), "none");
        assert_eq!(normalize_backfill_window("whenever"), "all");
        assert_eq!(normalize_backfill_scope("Current"), "workspace");
        assert_eq!(normalize_backfill_scope("everything"), "all");
        assert_eq!(backfill_since_ms("1d", 100_000_000), Some(100_000_000.0 - 86_400_000.0));
        assert_eq!(backfill_since_ms("all", 1), None);
        assert_eq!(backfill_since_ms("none", 1), None);
    }

    #[test]
    fn a_workspace_holds_itself_and_what_is_inside_it() {
        let workspace = Path::new(if cfg!(windows) { "C:\\work\\app" } else { "/work/app" });
        let inside = workspace.join("packages").join("a");
        let outside = workspace.parent().unwrap().join("other");
        assert!(within(workspace, workspace));
        assert!(within(workspace, &inside));
        assert!(!within(workspace, &outside));
    }

    #[test]
    fn the_session_chunks_are_ordered_by_turn_then_time_and_labelled() {
        let root = Chunk {
            id: 7,
            root: true,
            chunk_root: None,
            ts: 5,
            source_turn: Some(2),
            category: Some("fact".into()),
            summary: "el — sum".into(),
            text: "user: hi".into(),
        };
        let pending =
            Chunk { id: 9, root: false, chunk_root: None, ts: 1, source_turn: None, category: None, summary: String::new(), text: "user: later".into() };
        let terminal = Chunk {
            id: 8,
            root: false,
            chunk_root: Some(8),
            ts: 9,
            source_turn: Some(1),
            category: None,
            summary: String::new(),
            text: "assistant: first".into(),
        };
        let mut chunks = vec![pending, root, terminal];
        sort_chunks(&mut chunks);
        assert_eq!(chunks.iter().map(|c| c.id).collect::<Vec<_>>(), [8, 7, 9]);
        assert_eq!(
            render_chunks(&chunks),
            "# raw_terminal 1 id=8\nassistant: first\n\n# chunk 2 root=7 category=fact\nsummary: el — sum\nuser: hi\n\n# raw_pending 3 id=9\nuser: later"
        );
        assert_eq!(render_chunks(&[]), "(no results)");
    }

    async fn store() -> (TestPg, Db) {
        let pg = TestPg::start().await;
        let db = pg.db(Schema::Memory).await;
        ensure_memory_schema(&db, 384, &Value::Null).await.expect("schema");
        (pg, db)
    }

    async fn count(db: &Db, sql: &str) -> i64 {
        db.query(sql, &[]).await.expect("count")[0].get(0)
    }

    #[tokio::test]
    async fn prune_and_purge_need_their_phrase_and_purge_keeps_the_curated_core() {
        let (_pg, db) = store().await;
        let day = 86_400_000_i64;
        let old = now_ms() - 40 * day;
        db.execute("INSERT INTO entries(ts, role, content, source_ref) VALUES ($1, 'user', 'old raw', 'a'), ($2, 'user', 'new raw', 'b')", &[&old, &now_ms()])
            .await
            .unwrap();
        db.execute("INSERT INTO core_entries(element, summary, category, created_at, updated_at) VALUES ('e', 's', 'fact', 1, 1)", &[]).await.unwrap();
        assert!(prune(&db, &json!({})).await.unwrap().is_error);
        assert!(purge(&db, &json!({ "confirm": "delete all memory" })).await.unwrap().is_error);
        assert_eq!(count(&db, "SELECT COUNT(*) FROM entries").await, 2);
        let pruned = prune(&db, &json!({ "confirm": "PRUNE OLD ENTRIES", "maxDays": 30 })).await.unwrap();
        assert_eq!(pruned.text, "prune: deleted 1 unclassified entries older than 30 days");
        assert_eq!(count(&db, "SELECT COUNT(*) FROM entries").await, 1);
        let core = count(&db, "SELECT COUNT(*) FROM core_entries").await;
        let purged = purge(&db, &json!({ "confirm": "DELETE ALL MEMORY" })).await.unwrap();
        assert_eq!(purged.text, format!("purged generated memory entries (count=1); user core preserved (core_entries={core})"));
        assert_eq!(count(&db, "SELECT COUNT(*) FROM entries").await, 0);
        assert_eq!(count(&db, "SELECT COUNT(*) FROM core_entries").await, core);
    }

    #[tokio::test]
    async fn the_session_dump_lists_roots_with_their_members_and_the_raw_leaves() {
        let (_pg, db) = store().await;
        db.execute(
            "INSERT INTO entries(ts, role, content, source_ref, session_id, source_turn) VALUES
             (1, 'user', 'hello there', 'r1', 's1', 1), (2, 'assistant', 'general reply', 'r2', 's1', 2), (3, 'user', 'still raw', 'r3', 's1', 3), (4, 'user', 'other', 'r4', 's2', 1)",
            &[],
        )
        .await
        .unwrap();
        let root: i64 = db.query("SELECT id FROM entries WHERE source_ref = 'r1'", &[]).await.unwrap()[0].get(0);
        db.execute("UPDATE entries SET is_root = 1, chunk_root = $1, element = 'greeting', category = 'fact', summary = 'said hello' WHERE id = $1", &[&root])
            .await
            .unwrap();
        db.execute("UPDATE entries SET chunk_root = $1 WHERE source_ref = 'r2'", &[&root]).await.unwrap();
        let reply = dump_session_roots(&db, &json!({ "sessionId": "s1" })).await.unwrap();
        assert_eq!(
            reply.text,
            format!(
                "# chunk 1 root={root} category=fact\nsummary: greeting — said hello\nassistant: general reply\n\n# raw_pending 2 id={}\nuser: still raw",
                db.query("SELECT id FROM entries WHERE source_ref = 'r3'", &[]).await.unwrap()[0].get::<_, i64>(0)
            )
        );
        let rootless = dump_session_roots(&db, &json!({ "session_id": "s1", "includeRaw": false })).await.unwrap();
        assert!(!rootless.text.contains("raw_pending"));
        let none = dump_session_roots(&db, &json!({})).await.unwrap();
        assert!(none.is_error && none.text == "(no current session)");
    }

    #[tokio::test]
    async fn the_backfill_takes_the_newest_files_of_the_window_oldest_first_and_skips_agent_transcripts() {
        let dir = tempfile::tempdir().expect("temp dir");
        let project = dir.path().join("proj");
        std::fs::create_dir_all(&project).expect("project dir");
        std::fs::create_dir_all(dir.path().join("tmp")).expect("skipped dir");
        let write = |path: PathBuf, age_secs: u64| {
            std::fs::write(&path, "{}\n").expect("transcript");
            let file = std::fs::File::options().write(true).open(&path).expect("open");
            file.set_modified(std::time::SystemTime::now() - std::time::Duration::from_secs(age_secs)).expect("mtime");
        };
        write(project.join("old.jsonl"), 10 * 86_400);
        write(project.join("mid.jsonl"), 3_600);
        write(project.join("new.jsonl"), 60);
        write(project.join("agent-x.jsonl"), 60);
        write(project.join("notes.txt"), 60);
        write(dir.path().join("tmp").join("skip.jsonl"), 60);
        let lane = mixdog_rt::testing::tokens().maintenance_io;
        let names = |paths: Vec<PathBuf>| paths.iter().map(|p| p.file_name().unwrap().to_string_lossy().into_owned()).collect::<Vec<_>>();
        let all = select_transcripts(lane, dir.path(), None, None, None).await;
        assert_eq!(names(all), ["old.jsonl", "mid.jsonl", "new.jsonl"]);
        let week = select_transcripts(lane, dir.path(), backfill_since_ms("7d", now_ms()), None, None).await;
        assert_eq!(names(week), ["mid.jsonl", "new.jsonl"]);
        let newest = select_transcripts(lane, dir.path(), None, Some(2.0), None).await;
        assert_eq!(names(newest), ["mid.jsonl", "new.jsonl"]);
    }
    fn maintenance(db: &Db) -> Maintenance {
        let tokens = mixdog_rt::testing::tokens();
        Maintenance::new(
            None,
            Arc::new(RawEmbedFlush::new(db.clone(), None)),
            crate::memory::transcript::TranscriptIngest::new(
                db.clone(),
                crate::memory::transcript::TranscriptIo { maintenance: tokens.maintenance_io, durability: tokens.durability_io },
                Arc::new(now_ms),
            ),
            None,
            tokens.maintenance_io,
            tokens.durability_io,
        )
    }
    #[tokio::test]
    async fn manage_adds_edits_and_deletes_a_root_and_the_chunk_it_owns() {
        let (_pg, db) = store().await;
        let m = maintenance(&db);
        let reply = m.manage(&db, &json!({ "op": "add", "element": "deploy", "summary": "ships on friday", "category": "Rule" })).await.unwrap();
        assert!(!reply.is_error && reply.text.starts_with("added (id=") && reply.text.ends_with("[rule] deploy — ships on friday"), "{}", reply.text);
        let id: i64 = db.query("SELECT id FROM entries WHERE is_root = 1", &[]).await.unwrap()[0].get(0);
        assert_eq!(count(&db, "SELECT COUNT(*) FROM entries WHERE chunk_root = id AND status = 'pending' AND content = 'deploy — ships on friday'").await, 1);
        let bad = m.manage(&db, &json!({ "op": "add", "element": "x", "category": "nonsense" })).await.unwrap();
        assert!(bad.is_error && bad.text.starts_with("manage add: invalid category \"nonsense\". Valid: rule, constraint"));
        let edited = m.manage(&db, &json!({ "op": "edit", "id": id, "summary": "ships on monday", "category": "decision" })).await.unwrap();
        assert_eq!(edited.text, format!("edited (id={id}): [decision] deploy — ships on monday"));
        assert_eq!(count(&db, "SELECT COUNT(*) FROM entries WHERE content = 'deploy — ships on monday' AND category = 'decision'").await, 1);
        let none = m.manage(&db, &json!({ "op": "edit", "id": id })).await.unwrap();
        assert_eq!(none.text, "manage edit requires at least one field: element, summary, category");
        db.execute("INSERT INTO entries(ts, role, content, source_ref, chunk_root) VALUES (1, 'user', 'member', 'm1', $1)", &[&id]).await.unwrap();
        let gone = m.manage(&db, &json!({ "op": "delete", "id": id })).await.unwrap();
        assert_eq!(gone.text, format!("deleted (id={id}, rows=2): [decision] deploy"));
        assert_eq!(m.manage(&db, &json!({ "op": "delete", "id": id })).await.unwrap().text, format!("manage delete: no entry with id={id}"));
        assert_eq!(m.manage(&db, &json!({ "op": "sideways" })).await.unwrap().text, "manage requires op: \"add\" | \"edit\" | \"delete\"");
        assert_eq!(
            m.manage(&db, &json!({ "op": "add", "status": "active" })).await.unwrap().text,
            "manage: history importance classification is no longer supported"
        );
    }
    #[tokio::test]
    async fn a_cancelled_caller_ends_a_backfill_at_its_first_step_and_frees_the_mutex() {
        let (_pg, db) = store().await;
        let m = maintenance(&db);
        let cancel = CancellationToken::new();
        cancel.cancel();
        let ended = m.backfill(&db, &json!({}), &cancel).await;
        assert_eq!(ended.unwrap_err().message(), "aborted");
        // The mutex was released: a live caller is not told a backfill is in progress.
        let live = m.backfill(&db, &json!({ "window": "none" }), &CancellationToken::new()).await.unwrap();
        assert!(live.text.starts_with("backfill: window=none"), "{}", live.text);
        let waiting = unless_cancelled(&cancel, std::future::pending::<Result<()>>()).await;
        assert_eq!(waiting.unwrap_err().message(), "aborted");
    }
    #[tokio::test]
    async fn the_rebuild_reset_clears_every_classification_and_demotes_the_roots() {
        let (_pg, db) = store().await;
        db.execute("INSERT INTO entries(ts, role, content, source_ref) VALUES (1, 'user', 'a', 'a'), (2, 'user', 'b', 'b')", &[]).await.unwrap();
        let ids: Vec<i64> = db.query("SELECT id FROM entries ORDER BY id", &[]).await.unwrap().iter().map(|r| r.get(0)).collect();
        db.execute(
            "UPDATE entries SET chunk_root = $1, is_root = 1, element = 'e', category = 'fact', summary = 's', status = 'active' WHERE id = $1",
            &[&ids[0]],
        )
        .await
        .unwrap();
        db.execute("UPDATE entries SET chunk_root = $1 WHERE id = $2", &[&ids[0], &ids[1]]).await.unwrap();
        reset_classification(&db).await.unwrap();
        assert_eq!(count(&db, "SELECT COUNT(*) FROM entries WHERE is_root = 0 AND chunk_root IS NULL AND status IS NULL AND element IS NULL AND category IS NULL AND summary IS NULL").await, 2);
        let m = maintenance(&db);
        assert!(m.rebuild(&db, &json!({ "confirm": "nope" }), &CancellationToken::new()).await.unwrap().is_error);
        let refused = m.rebuild(&db, &json!({ "confirm": "REBUILD MEMORY" }), &CancellationToken::new()).await;
        assert_eq!(refused.unwrap_err().message(), "memory cycles are not running in this process");
    }
}

// ---- search, dump_session_roots ----------------------------------------------------------------

/// The `search` action: `handleSearch(args)` itself, the ranked rows without the recall tool's cap.
pub fn search_reply(outcome: crate::memory::recall::RecallOutcome) -> ToolReply {
    let mut reply = if outcome.is_error { ToolReply::error(outcome.text) } else { ToolReply::ok(outcome.text) };
    if let (false, Some(cursor)) = (reply.is_error, &outcome.next_cursor) {
        reply = reply.with_field("nextCursor", cursor);
    }
    reply
}

/// `flushSearchEmbeddings`: the roots without a vector are embedded; an incomplete flush is an error,
/// never a quiet partial success. Answers how many were embedded.
async fn flush_embeddings(flush: &Arc<RawEmbedFlush>, cancel: &CancellationToken) -> Result<usize> {
    let done = flush.flush_roots(cancel).await.map_err(|error| MemoryError::rejected(error.to_string()))?;
    if done.timed_out || !done.failed.is_empty() {
        return Err(MemoryError::rejected(format!("embedding maintenance incomplete: failed={} timedOut={}", done.failed.len(), done.timed_out)));
    }
    Ok(done.succeeded)
}
/// The pieces the maintenance actions beyond the database need.
pub struct Maintenance {
    /// The scheduler cycle1 runs through and the memory section it reads, when this process runs cycles.
    pub cycles: Option<(CycleScheduler, Arc<dyn CycleConfig>)>,
    /// The database's one embedding flusher.
    pub flush: Arc<RawEmbedFlush>,
    pub transcripts: Arc<TranscriptIngest>,
    /// `<home>/projects`, where the session transcripts live.
    pub projects_root: Option<PathBuf>,
    pub maintenance: MaintenanceIo,
    pub durability: DurabilityIo,
    backfill_running: AtomicBool,
}
impl Maintenance {
    pub fn new(
        cycles: Option<(CycleScheduler, Arc<dyn CycleConfig>)>,
        flush: Arc<RawEmbedFlush>,
        transcripts: Arc<TranscriptIngest>,
        projects_root: Option<PathBuf>,
        maintenance: MaintenanceIo,
        durability: DurabilityIo,
    ) -> Self {
        Self { cycles, flush, transcripts, projects_root, maintenance, durability, backfill_running: AtomicBool::new(false) }
    }

    /// Runs `action` (one of the cycle, embedding and manage actions) over `db`.
    /// A cycle1, flush, rebuild or backfill ends at its next step once `cancel` is cancelled.
    pub async fn run(&self, db: &Db, action: Action, args: &Value, cancel: &CancellationToken) -> Result<ToolReply> {
        match action {
            Action::Manage => self.manage(db, args).await,
            Action::Cycle1 => self.cycle1(args, cancel).await,
            Action::Flush => self.flush_action(cancel).await,
            Action::Rebuild => self.rebuild(db, args, cancel).await,
            Action::Backfill => self.backfill(db, args, cancel).await,
            other => unreachable!("{other:?} is served by the memory runtime itself"),
        }
    }

    fn cycles(&self) -> Result<&(CycleScheduler, Arc<dyn CycleConfig>)> {
        self.cycles.as_ref().ok_or_else(|| MemoryError::rejected("memory cycles are not running in this process"))
    }

    async fn cycle1(&self, args: &Value, cancel: &CancellationToken) -> Result<ToolReply> {
        let (scheduler, config) = self.cycles()?;
        let cycle1 = cycle1_config_from_args(args, cycle1_base(config));
        let deadline = to_number(args.get("_callerDeadlineMs").unwrap_or(&Value::Null));
        let plan = PlanOptions { caller_deadline_ms: (deadline.is_finite() && deadline > 0.0).then_some(deadline), ..PlanOptions::default() };
        checkpoint(cancel)?;
        let result =
            unless_cancelled(cancel, async { scheduler.await_cycle1_run(cycle1, Cycle1Options { plan, ..Cycle1Options::default() }).await.map_err(plain) })
                .await?;
        checkpoint(cancel)?;
        Ok(ToolReply::ok(cycle1_summary(&result)))
    }

    async fn flush_action(&self, cancel: &CancellationToken) -> Result<ToolReply> {
        let (scheduler, config) = self.cycles()?;
        checkpoint(cancel)?;
        let result = unless_cancelled(cancel, async { scheduler.await_cycle1_run(cycle1_base(config), Cycle1Options::default()).await.map_err(plain) }).await?;
        checkpoint(cancel)?;
        let embedded = flush_embeddings(&self.flush, cancel).await?;
        checkpoint(cancel)?;
        Ok(ToolReply::ok(format!("flush: cycle1 chunks={} processed={}, embeddings={embedded}", result.chunks, result.processed)))
    }

    async fn rebuild(&self, db: &Db, args: &Value, cancel: &CancellationToken) -> Result<ToolReply> {
        if args.get("confirm").and_then(Value::as_str) != Some("REBUILD MEMORY") {
            return Ok(ToolReply::error("rebuild requires confirm: \"REBUILD MEMORY\" (truncates classification columns and re-runs summarization)"));
        }
        let (scheduler, config) = self.cycles()?;
        let cycle1 = cycle1_base(config);
        checkpoint(cancel)?;
        // The run in flight ends before the reset, so no run reads rows half reset.
        for _ in 0..DRAIN_ROUNDS {
            if !scheduler.is_cycle1_running() {
                break;
            }
            let _ = unless_cancelled(cancel, async { Ok(scheduler.await_cycle1_run(cycle1.clone(), Cycle1Options::default()).await) }).await?;
        }
        checkpoint(cancel)?;
        reset_classification(db).await?;
        // A fresh run over the reset rows: nothing is in flight now, so this one starts, never joins.
        let result =
            unless_cancelled(cancel, async { scheduler.start_cycle1_run(cycle1, Cycle1Options::default()).await.map_err(MemoryError::rejected) }).await?;
        checkpoint(cancel)?;
        let embedded = flush_embeddings(&self.flush, cancel).await?;
        checkpoint(cancel)?;
        Ok(ToolReply::ok(format!("rebuild: cycle1 chunks={} processed={}, embeddings={embedded}", result.chunks, result.processed)))
    }

    async fn backfill(&self, db: &Db, args: &Value, cancel: &CancellationToken) -> Result<ToolReply> {
        // Claimed before any wait, so a burst of calls cannot all pass the check.
        if self.backfill_running.swap(true, Ordering::SeqCst) {
            return Ok(ToolReply::error("backfill already in progress"));
        }
        let _turn = BackfillTurn(&self.backfill_running);
        checkpoint(cancel)?;
        let window = args.get("window").filter(|v| !v.is_null()).map_or_else(|| "7d".to_owned(), value_to_string);
        let scope = args.get("scope").filter(|v| !v.is_null()).map_or_else(|| "all".to_owned(), value_to_string);
        let limit = args.get("limit").filter(|v| !v.is_null()).map(|v| to_number(v).max(1.0));
        let report = self.full_backfill(db, &window, &scope, limit, cancel).await?;
        checkpoint(cancel)?;
        Ok(report.reply())
    }

    /// `runFullBackfill`: the transcripts of the window are ingested, cycle1 runs over what is left
    /// unclassified until it stops shrinking, then the embeddings are flushed.
    async fn full_backfill(&self, db: &Db, window: &str, scope: &str, limit: Option<f64>, cancel: &CancellationToken) -> Result<BackfillReport> {
        let (window, scope) = (normalize_backfill_window(window), normalize_backfill_scope(scope));
        let mut report = BackfillReport { window, scope, ..BackfillReport::default() };
        let workspace = (scope == "workspace").then(|| std::env::current_dir().ok()).flatten();
        let selected = match &self.projects_root {
            Some(root) if scope != "workspace" || workspace.is_some() => {
                select_transcripts(self.maintenance, root, backfill_since_ms(window, now_ms()), limit, workspace.as_deref()).await
            }
            _ => Vec::new(),
        };
        report.files = selected.len();
        let outcomes: Vec<_> = futures::stream::iter(selected)
            .map(|path| async move {
                // A cancelled backfill ingests no further file; the checkpoint below ends it.
                if cancel.is_cancelled() {
                    return (path, Ok(0));
                }
                let cwd = cwd_from_transcript_path(self.maintenance, &path).await.ok().flatten();
                let ingested = self.transcripts.ingest_transcript_file(&path, cwd.as_deref()).await;
                (path, ingested)
            })
            .buffer_unordered(BACKFILL_CONCURRENCY)
            .collect()
            .await;
        checkpoint(cancel)?;
        for (path, outcome) in outcomes {
            match outcome {
                Ok(count) => report.ingested += count,
                Err(error) => {
                    log(&format!("[backfill] ingest failed ({}): {}\n", path.display(), error.message()));
                    report.errors.push(("ingest", error.message()));
                }
            }
        }
        let mut prev = count_unclassified(db).await?;
        if let Some((scheduler, config)) = &self.cycles {
            while prev > 0 && report.cycle1_iters < FULL_BACKFILL_MAX_ITERS {
                checkpoint(cancel)?;
                let run = unless_cancelled(cancel, async { Ok(scheduler.await_cycle1_run(cycle1_base(config), Cycle1Options::default()).await) }).await?;
                let result = match run {
                    Ok(result) => result,
                    Err(error) => {
                        let message = plain(error).message();
                        log(&format!("[backfill] cycle1 error (iter={}): {message}\n", report.cycle1_iters));
                        report.errors.push(("cycle1", message));
                        break;
                    }
                };
                report.cycle1_iters += 1;
                if result.processed == 0 {
                    break;
                }
                let next = count_unclassified(db).await?;
                if next >= prev {
                    break;
                }
                prev = next;
            }
        }
        checkpoint(cancel)?;
        if let Err(error) = flush_embeddings(&self.flush, cancel).await {
            checkpoint(cancel)?;
            log(&format!("[backfill] embedding error: {}\n", error.message()));
            report.errors.push(("embedding", error.message()));
        }
        report.unclassified = count_unclassified(db).await?;
        Ok(report)
    }

    async fn manage(&self, db: &Db, args: &Value) -> Result<ToolReply> {
        let op = js_trim(&text_of(args.get("op"))).to_lowercase();
        if !matches!(op.as_str(), "add" | "edit" | "delete") {
            return Ok(ToolReply::error("manage requires op: \"add\" | \"edit\" | \"delete\""));
        }
        if args.get("status").is_some() {
            return Ok(ToolReply::error("manage: history importance classification is no longer supported"));
        }
        match op.as_str() {
            "add" => self.manage_add(db, args).await,
            "edit" => self.manage_edit(db, args).await,
            _ => manage_delete(db, args).await,
        }
    }

    async fn manage_add(&self, db: &Db, args: &Value) -> Result<ToolReply> {
        let element = js_trim(&text_of(args.get("element"))).to_owned();
        let summary = js_trim(&text_of(first_of(args, &["summary", "element"]))).to_owned();
        let category = js_trim(&first_of(args, &["category"]).map_or_else(|| "fact".to_owned(), value_to_string)).to_lowercase();
        if element.is_empty() || summary.is_empty() {
            return Ok(ToolReply::error("manage add requires element and summary"));
        }
        if !VALID_CATEGORIES.contains(&category.as_str()) {
            return Ok(invalid_category("add", &category));
        }
        let now = now_ms();
        let source_ref = format!("manual:{now}-{}", std::process::id());
        let project = resolve_project_scope(self.durability, args.get("cwd").and_then(Value::as_str), None).await;
        let added = async {
            let project = project?;
            let content = format!("{element} — {summary}");
            // The row has to exist before it can name itself as its own chunk root.
            let id = transaction(db, async |tx| {
                let row = tx
                    .query_one(
                        "INSERT INTO entries(ts, role, content, source_ref, session_id, project_id)
                         VALUES ($1, 'system', $2, $3, NULL, $4)
                         RETURNING id",
                        &[&now, &content, &source_ref, &project],
                    )
                    .await?;
                let id: i64 = row.get(0);
                tx.execute(
                    "UPDATE entries
                     SET chunk_root = $1, is_root = 1, element = $2, category = $3, summary = $4,
                         status = 'pending', score = $5, last_seen_at = $6
                     WHERE id = $7",
                    &[&id, &element, &category, &summary, &FRESH_SCORE, &now, &id],
                )
                .await?;
                Ok(id)
            })
            .await?;
            self.flush.sync_root(id, &CancellationToken::new()).await.map_err(|error| MemoryError::rejected(error.to_string()))?;
            Ok::<_, MemoryError>(id)
        }
        .await;
        Ok(match added {
            Ok(id) => ToolReply::ok(format!("added (id={id}): [{category}] {element} — {}", slice_utf16(&summary, 200))),
            Err(error) => ToolReply::error(format!("manage add failed: {}", error.message())),
        })
    }

    async fn manage_edit(&self, db: &Db, args: &Value) -> Result<ToolReply> {
        let Some(id) = numeric_id(args.get("id")) else {
            return Ok(ToolReply::error("manage edit requires numeric id"));
        };
        let Some(existing) = db.query_opt("SELECT element, summary, category, is_root FROM entries WHERE id = $1", &[&id]).await? else {
            return Ok(ToolReply::error(format!("manage edit: no entry with id={id}")));
        };
        if existing.get::<_, i16>("is_root") != 1 {
            return Ok(ToolReply::error(format!("manage edit: id={id} is not a root")));
        }
        let new_element = trim_or_none(args.get("element"));
        let new_summary = trim_or_none(args.get("summary"));
        let new_category = trim_or_none(args.get("category")).map(|c| c.to_lowercase());
        if new_element.is_none() && new_summary.is_none() && new_category.is_none() {
            return Ok(ToolReply::error("manage edit requires at least one field: element, summary, category"));
        }
        if let Some(category) = new_category.as_deref().filter(|c| !VALID_CATEGORIES.contains(c)) {
            return Ok(invalid_category("edit", category));
        }
        let text_changed = new_element.is_some() || new_summary.is_some();
        let element = new_element.or_else(|| existing.get("element"));
        let summary = new_summary.or_else(|| existing.get("summary"));
        let category: Option<String> = new_category.or_else(|| existing.get("category"));
        // A category-only edit of a root without an element or summary keeps what is stored: empty
        // text composes to no content, never the word "null".
        let (element_text, summary_text) = (element.clone().unwrap_or_default(), summary.clone().unwrap_or_default());
        let suffix = if summary_text.is_empty() { String::new() } else { format!(" — {summary_text}") };
        let content = if element_text.is_empty() && summary_text.is_empty() { String::new() } else { format!("{element_text}{suffix}") };
        let now = now_ms();
        let written = transaction(db, async |tx| {
            // Editing either side ends the duplicate equivalence, not the chunks or their lineage.
            tx.execute("UPDATE entries SET duplicate_of = NULL WHERE duplicate_of = $1", &[&id]).await?;
            tx.execute(
                "UPDATE entries
                 SET element = $1, summary = $2, category = $3, score = $4,
                     last_seen_at = $5, content = $6, duplicate_of = NULL
                 WHERE id = $7",
                &[&element, &summary, &category, &FRESH_SCORE, &now, &content, &id],
            )
            .await?;
            Ok(())
        })
        .await;
        if let Err(error) = written {
            return Ok(ToolReply::error(format!("manage edit failed: {}", error.message())));
        }
        if text_changed && let Err(error) = self.flush.sync_root(id, &CancellationToken::new()).await {
            log(&format!("[memory.manage] embedding resync failed (id={id}): {error}\n"));
        }
        let tail = if summary_text.is_empty() { String::new() } else { format!(" — {}", slice_utf16(&summary_text, 200)) };
        Ok(ToolReply::ok(format!("edited (id={id}): [{}] {element_text}{tail}", category.as_deref().unwrap_or(""))))
    }
}
