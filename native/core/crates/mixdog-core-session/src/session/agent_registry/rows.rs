//! The worker index's row and tombstone rules, as 1.4.5 `agent-tool` applies them
//! (`worker-rows.mjs`, `worker-index/row-shape.mjs`, `runtime/shared/agent-reap-state.mjs`,
//! `terminal-reaper/row-helpers.mjs`). Rows, sessions and tombstones stay JSON objects, the
//! shape Node reads them in.

use mixdog_agent::agent_tool::scope::Owner;
use mixdog_agent::agent_tool::scope::Scope;
use mixdog_agent::agent_tool::scope::SessionFacts;
use mixdog_agent::agent_tool::scope::TagRecord;
use mixdog_agent::agent_tool::scope::clean;
use mixdog_agent::agent_tool::scope::positive_int;
use mixdog_agent::agent_tool::stamp::iso_from_ms;
use serde_json::Map;
use serde_json::Value;

pub type Row = Map<String, Value>;

/// The per-row and per-tombstone work the worker index does, counted so a test can show that
/// reading an unchanged index does none (the status recompute runs on every session activity
/// change, `decisions.md` "Node daemon hot paths found by profiling" 1).
#[cfg(any(test, feature = "test-support"))]
pub(super) mod work {
    use std::cell::Cell;

    #[derive(Clone, Copy, Default, PartialEq, Eq, Debug)]
    pub struct Counts {
        pub tombstones_normalized: usize,
        pub tombstones_keyed: usize,
        pub rows_normalized: usize,
        pub rows_tested: usize,
        /// A row a read handed out or kept as a copy of its own.
        pub rows_copied: usize,
        /// A tombstone a read handed out or kept as a copy of its own.
        pub tombstones_copied: usize,
        /// A row tested against a caller's scope.
        pub rows_scoped: usize,
        /// A row a refresh bound, checked for staleness, or a listing turned into a session.
        pub rows_visited: usize,
        /// A bound tag a refresh's unbinding pass or a listing's tag pass looked at.
        pub tags_visited: usize,
        /// A session record looked at to find one session (a header copied, a stored row compared).
        pub sessions_visited: usize,
        /// A worker map a reload built into the maps it compares with.
        pub maps_rebuilt: usize,
        /// A worker map a reload compared with the one it holds.
        pub maps_compared: usize,
        /// A stored session a reload compared with the one it holds.
        pub sessions_compared: usize,
        /// A loaded session's stamp taken to learn whether it changed (`LiveSessions::stamp`).
        pub stamps_taken: usize,
        /// Reloads that read the store (not counted in [`Counts::total`]).
        pub reloads: usize,
    }

    impl Counts {
        /// Every per-row, per-tombstone and per-tag operation counted.
        pub fn total(&self) -> usize {
            self.tombstones_normalized
                + self.tombstones_keyed
                + self.rows_normalized
                + self.rows_tested
                + self.rows_copied
                + self.tombstones_copied
                + self.rows_scoped
                + self.rows_visited
                + self.tags_visited
                + self.sessions_visited
                + self.maps_rebuilt
                + self.maps_compared
                + self.sessions_compared
                + self.stamps_taken
        }
    }

    thread_local! {
        static COUNTS: Cell<Counts> = const {
            Cell::new(Counts {
                tombstones_normalized: 0,
                tombstones_keyed: 0,
                rows_normalized: 0,
                rows_tested: 0,
                rows_copied: 0,
                tombstones_copied: 0,
                rows_scoped: 0,
                rows_visited: 0,
                tags_visited: 0,
                sessions_visited: 0,
                maps_rebuilt: 0,
                maps_compared: 0,
                sessions_compared: 0,
                stamps_taken: 0,
                reloads: 0,
            })
        };
    }

    pub fn note(count: impl FnOnce(&mut Counts)) {
        COUNTS.with(|cell| {
            let mut counts = cell.get();
            count(&mut counts);
            cell.set(counts);
        });
    }

    #[cfg_attr(not(test), allow(dead_code, reason = "used by this crate's unit tests; compiled for test-support so the hooks around it behave as in a test build"))]
    pub fn counts() -> Counts {
        COUNTS.with(Cell::get)
    }
}

/// `TAG_TOMBSTONE_TTL_MS`: tombstones and released markers count this long.
pub const TAG_TOMBSTONE_TTL_MS: f64 = 7.0 * 24.0 * 60.0 * 60.0 * 1000.0;
/// `MAX_TAG_TOMBSTONES`.
pub const MAX_TAG_TOMBSTONES: usize = 500;
/// `SETTLED_ROW_RETENTION_MS`.
pub const SETTLED_ROW_RETENTION_MS: f64 = 24.0 * 60.0 * 60.0 * 1000.0;
/// `CLOSE_PROVENANCE_VERSION`.
pub const CLOSE_PROVENANCE_VERSION: f64 = 1.0;
/// `PROCESS_RESTART_FAILURE`.
const PROCESS_RESTART_FAILURE: &str = "process-restart";
/// `ACTIVE_STAGES` (`tool-def.mjs`).
pub const ACTIVE_STAGES: [&str; 6] = ["connecting", "requesting", "streaming", "tool_running", "running", "cancelling"];

/// JavaScript truthiness of a JSON value (`undefined` is `None`).
pub fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) | Some(Value::Bool(false)) => false,
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Number(n)) => n.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(_) => true,
    }
}

/// `row.a || row.b`.
pub fn either<'a>(row: &'a Row, a: &str, b: &str) -> Option<&'a Value> {
    let first = row.get(a);
    if truthy(first) { first } else { row.get(b) }
}

fn text_or_null(value: String) -> Value {
    if value.is_empty() { Value::Null } else { Value::String(value) }
}

fn pid_value(pid: Option<u64>) -> Value {
    pid.map_or(Value::Null, Value::from)
}

/// `Date.parse(text)`, 0 for an invalid or zero time (`|| 0`).
fn parse_or_zero(text: &str) -> f64 {
    let parsed = mixdog_js::time::date_parse(text);
    if parsed.is_nan() { 0.0 } else { parsed }
}

/// `stampMs`: a positive number as is; text that is a number (not an ISO date) as that
/// number; else the time it parses to; 0 when none.
pub fn stamp_ms(value: Option<&Value>) -> f64 {
    if let Some(Value::Number(n)) = value {
        let n = n.as_f64().unwrap_or(0.0);
        return if n.is_finite() && n > 0.0 { n } else { 0.0 };
    }
    let text = clean(value);
    if text.is_empty() {
        return 0.0;
    }
    let numeric = mixdog_js::string_to_number(&text);
    let iso_year = text.len() >= 5 && text.as_bytes()[..4].iter().all(u8::is_ascii_digit) && text.as_bytes()[4] == b'-';
    if numeric.is_finite() && numeric > 0.0 && !iso_year {
        return numeric;
    }
    let parsed = mixdog_js::time::date_parse(&text);
    if parsed.is_finite() && parsed > 0.0 { parsed } else { 0.0 }
}

/// `new Date(ms).toISOString()`.
pub fn iso(ms: f64) -> String {
    iso_from_ms(ms as i64)
}

/// `isLeadPoolAgent`.
pub fn is_lead_pool_agent(value: Option<&Value>) -> bool {
    clean(value).to_lowercase() == "lead"
}

/// `isTerminalWorkerStatus`.
pub fn is_terminal_worker_status(status: &str) -> bool {
    matches!(
        mixdog_js::js_trim(status).to_lowercase().as_str(),
        "idle" | "closed" | "complete" | "completed" | "done" | "success" | "fail" | "failed" | "error" | "cancelled"
            | "canceled" | "killed" | "timeout"
    )
}

/// `isTerminalRow`: `isTerminalWorkerStatus(row.status || row.stage)`.
pub fn is_terminal_row(row: &Row) -> bool {
    is_terminal_worker_status(&clean(either(row, "status", "stage")))
}

/// `WORKING_WORKER_STATUS`.
fn is_working_status(status: &str) -> bool {
    let lower = status.to_lowercase();
    if let Some(rest) = lower.strip_prefix("tool") {
        let rest = rest.strip_prefix(['-', '_']).or_else(|| rest.strip_prefix(|c: char| mixdog_js::is_js_space(c))).unwrap_or(rest);
        return rest == "running";
    }
    matches!(lower.as_str(), "connecting" | "requesting" | "streaming" | "running" | "queued" | "pending" | "starting" | "cancelling")
}

/// `workerStageForStatus`.
pub fn worker_stage_for_status(status: &str, runtime_stage: Option<&str>) -> String {
    let stage = mixdog_js::js_trim(runtime_stage.unwrap_or_default()).to_owned();
    let status = mixdog_js::js_trim(status).to_owned();
    if !is_working_status(&status) {
        return if stage.is_empty() { status } else { stage };
    }
    let lower = stage.to_lowercase();
    if ACTIVE_STAGES.contains(&lower.as_str()) || lower == "resource_wait" { stage } else { status }
}

/// `workerRowTime`.
pub fn worker_row_time(row: &Row) -> f64 {
    let first = ["updatedAt", "finishedAt", "lastUsedAt", "createdAt"].into_iter().map(|k| row.get(k)).find(|v| truthy(*v)).flatten();
    match first {
        Some(value) => parse_or_zero(&mixdog_js::value_to_string(value)),
        None => 0.0,
    }
}

/// `agentTagOf`.
pub fn agent_tag_of(session: &Row) -> String {
    clean(session.get("agentTag"))
}

/// The ownership fields a session or row carries.
pub fn owner_of(row: &Row) -> Owner {
    Owner {
        parent_session_id: clean(row.get("parentSessionId")),
        owner_session_id: clean(row.get("ownerSessionId")),
        client_host_pid: positive_int(row.get("clientHostPid")),
    }
}

/// `sessionMatchesContext` / `rowMatchesContext`.
pub fn matches_scope(row: &Row, scope: &Scope) -> bool {
    scope.owns(&owner_of(row))
}

/// `normalizeWorkerRows` for one row: `None` for a row without a tag or session id, or a
/// Lead pool row.
pub fn normalize_row(row: &Row) -> Option<Row> {
    #[cfg(any(test, feature = "test-support"))]
    work::note(|c| c.rows_normalized += 1);
    let text = |key: &str| text_or_null(clean(row.get(key)));
    let mut out = Row::new();
    out.insert("tag".into(), Value::String(clean(row.get("tag"))));
    out.insert("sessionId".into(), Value::String(clean(row.get("sessionId"))));
    out.insert("parentSessionId".into(), text("parentSessionId"));
    out.insert("ownerSessionId".into(), text_or_null(clean(either(row, "ownerSessionId", "parentSessionId"))));
    for key in ["agent", "provider", "model", "preset", "effort"] {
        out.insert(key.into(), text(key));
    }
    out.insert("fast".into(), match row.get("fast") {
        Some(Value::Bool(b)) => Value::Bool(*b),
        _ => Value::Null,
    });
    if row.get("autoEffort") == Some(&Value::Bool(false)) {
        out.insert("autoEffort".into(), Value::Bool(false));
    }
    let status = clean(row.get("status"));
    let stage = clean(row.get("stage"));
    let stage = if !stage.is_empty() { stage } else if !status.is_empty() { status.clone() } else { "idle".into() };
    out.insert("status".into(), Value::String(if status.is_empty() { "idle".into() } else { status }));
    out.insert("stage".into(), Value::String(stage));
    for key in ["createdAt", "updatedAt", "lastUsedAt", "finishedAt", "turnStartedAt", "reapAt"] {
        out.insert(key.into(), text(key));
    }
    out.insert("clientHostPid".into(), pid_value(positive_int(row.get("clientHostPid"))));
    out.insert("runtimePid".into(), pid_value(positive_int(row.get("runtimePid"))));
    out.insert("cwd".into(), text("cwd"));
    out.insert("task_id".into(), text_or_null(clean(either(row, "task_id", "taskId"))));
    for key in ["error", "failureReason", "restartNotified", "permission", "toolPermission"] {
        out.insert(key.into(), text(key));
    }
    out.insert("messages".into(), Value::from(positive_int(row.get("messages")).unwrap_or(0)));
    out.insert("tools".into(), Value::from(positive_int(row.get("tools")).unwrap_or(0)));
    if row.get("awaitingUser").and_then(Value::as_str) == Some("approval") {
        out.insert("awaitingUser".into(), Value::String("approval".into()));
    }
    if row.get("released") == Some(&Value::Bool(true)) {
        out.insert("released".into(), Value::Bool(true));
    }
    let keep = !is_lead_pool_agent(out.get("agent")) && !clean(out.get("tag")).is_empty() && !clean(out.get("sessionId")).is_empty();
    keep.then_some(out)
}

/// The fields a whole-row write keeps from the stored row when it brings none.
const KEPT_FIELDS: [&str; 15] = [
    "parentSessionId",
    "ownerSessionId",
    "agent",
    "provider",
    "model",
    "preset",
    "effort",
    "fast",
    "clientHostPid",
    "runtimePid",
    "cwd",
    "task_id",
    "permission",
    "toolPermission",
    "turnStartedAt",
];

/// `applyWorkerRowUpsert` onto the stored row `prev`.
pub fn apply_upsert(prev: Option<&Row>, normalized: Row, now_iso: &str) -> Row {
    let empty = Row::new();
    let prev = prev.unwrap_or(&empty);
    let mut merged = prev.clone();
    for (key, value) in &normalized {
        merged.insert(key.clone(), value.clone());
    }
    let blank = |v: Option<&Value>| matches!(v, Some(Value::Null)) || matches!(v, Some(Value::String(s)) if s.is_empty());
    for field in KEPT_FIELDS {
        let kept = prev.get(field).filter(|v| !v.is_null() && v.as_str() != Some(""));
        if let (true, Some(kept)) = (blank(merged.get(field)), kept) {
            merged.insert(field.into(), kept.clone());
        }
    }
    if normalized.get("released") != Some(&Value::Bool(true)) {
        merged.shift_remove("released");
    }
    let created = [normalized.get("createdAt"), prev.get("createdAt")].into_iter().flatten().find(|v| truthy(Some(v))).cloned();
    merged.insert("createdAt".into(), created.unwrap_or_else(|| Value::String(now_iso.into())));
    let updated = normalized.get("updatedAt").filter(|v| truthy(Some(v))).cloned();
    merged.insert("updatedAt".into(), updated.unwrap_or_else(|| Value::String(now_iso.into())));
    merged
}

/// `workerRowFromSession`: the row a session contributes, `None` without a tag and id.
/// `extra` overrides the session's own fields; `runtime_stage` is the live runtime's.
pub fn row_from_session(session: &Row, fallback_tag: &str, extra: &Row, runtime_stage: Option<&str>, now_iso: &str) -> Option<Row> {
    let pick = |own: &str| clean(session.get(own));
    let over = |key: &str| clean(extra.get(key));
    let first = |values: [String; 2]| text_or_null(values.into_iter().find(|v| !v.is_empty()).unwrap_or_default());
    let tag = [agent_tag_of(session), mixdog_js::js_trim(fallback_tag).to_owned(), over("tag")].into_iter().find(|t| !t.is_empty())?;
    // `clean(session?.id || extra.sessionId)`.
    let session_id = if truthy(session.get("id")) { pick("id") } else { over("sessionId") };
    if session_id.is_empty() {
        return None;
    }
    let status = {
        let named = over("status");
        if !named.is_empty() {
            named
        } else if session.get("closed") == Some(&Value::Bool(true)) {
            "closed".into()
        } else {
            let own = pick("status");
            if own.is_empty() { "idle".into() } else { own }
        }
    };
    let stage = {
        let named = over("stage");
        if named.is_empty() { worker_stage_for_status(&status, runtime_stage) } else { named }
    };
    let mut row = Row::new();
    row.insert("tag".into(), Value::String(tag));
    row.insert("sessionId".into(), Value::String(session_id));
    row.insert("parentSessionId".into(), first([over("parentSessionId"), pick("parentSessionId")]));
    row.insert(
        "ownerSessionId".into(),
        first([clean(either(extra, "ownerSessionId", "parentSessionId")), clean(either(session, "ownerSessionId", "parentSessionId"))]),
    );
    row.insert("agent".into(), first([over("agent"), pick("agent")]));
    row.insert("provider".into(), first([over("provider"), pick("provider")]));
    row.insert("model".into(), first([over("model"), pick("model")]));
    row.insert("preset".into(), first([over("preset"), pick("presetName")]));
    row.insert("effort".into(), first([over("effort"), pick("effort")]));
    row.insert("fast".into(), match (extra.get("fast"), session.get("fast")) {
        (Some(Value::Bool(b)), _) => Value::Bool(*b),
        (_, Some(Value::Bool(true))) => Value::Bool(true),
        _ => Value::Null,
    });
    let auto_effort = match extra.get("autoEffort") {
        Some(v @ Value::Bool(_)) => Some(v),
        _ => session.get("autoEffort"),
    };
    if auto_effort == Some(&Value::Bool(false)) {
        row.insert("autoEffort".into(), Value::Bool(false));
    }
    row.insert("status".into(), Value::String(status));
    row.insert("stage".into(), Value::String(stage));
    let created = first([pick("createdAt"), over("createdAt")]);
    row.insert("createdAt".into(), if created.is_null() { Value::String(now_iso.into()) } else { created });
    let updated = over("updatedAt");
    row.insert("updatedAt".into(), Value::String(if updated.is_empty() { now_iso.into() } else { updated }));
    row.insert("lastUsedAt".into(), text_or_null(pick("lastUsedAt")));
    for key in ["finishedAt", "turnStartedAt", "reapAt"] {
        row.insert(key.into(), text_or_null(over(key)));
    }
    row.insert(
        "clientHostPid".into(),
        pid_value(positive_int(extra.get("clientHostPid")).or_else(|| positive_int(session.get("clientHostPid")))),
    );
    row.insert(
        "runtimePid".into(),
        Value::from(positive_int(extra.get("runtimePid")).unwrap_or_else(|| u64::from(std::process::id()))),
    );
    row.insert("cwd".into(), first([pick("cwd"), over("cwd")]));
    row.insert("task_id".into(), text_or_null(clean(either(extra, "task_id", "taskId"))));
    for key in ["error", "failureReason", "restartNotified"] {
        row.insert(key.into(), text_or_null(over(key)));
    }
    row.insert("permission".into(), text_or_null(pick("permission")));
    row.insert("toolPermission".into(), text_or_null(pick("toolPermission")));
    let count = |key: &str| Value::from(session.get(key).and_then(Value::as_array).map_or(0, Vec::len));
    row.insert("messages".into(), count("messages"));
    row.insert("tools".into(), count("tools"));
    Some(row)
}

/// `workerRowToSession`: the session a row stands for.
pub fn row_to_session(row: &Row) -> Row {
    let or_null = |value: Option<&Value>| value.filter(|v| truthy(Some(v))).cloned().unwrap_or(Value::Null);
    let mut s = Row::new();
    s.insert("id".into(), row.get("sessionId").cloned().unwrap_or(Value::Null));
    s.insert("parentSessionId".into(), or_null(either(row, "parentSessionId", "ownerSessionId")));
    s.insert("ownerSessionId".into(), or_null(row.get("ownerSessionId")));
    s.insert("agentTag".into(), row.get("tag").cloned().unwrap_or(Value::Null));
    for (to, from) in [("agent", "agent"), ("provider", "provider"), ("model", "model"), ("presetName", "preset"), ("effort", "effort")] {
        s.insert(to.into(), or_null(row.get(from)));
    }
    s.insert("fast".into(), Value::Bool(row.get("fast") == Some(&Value::Bool(true))));
    if row.get("autoEffort") == Some(&Value::Bool(false)) {
        s.insert("autoEffort".into(), Value::Bool(false));
    }
    let status = if truthy(row.get("status")) { row["status"].clone() } else { Value::String("idle".into()) };
    let stage = [row.get("stage"), row.get("status")].into_iter().flatten().find(|v| truthy(Some(v))).cloned();
    s.insert("status".into(), status);
    s.insert("stage".into(), stage.unwrap_or_else(|| Value::String("idle".into())));
    for key in ["createdAt", "updatedAt", "lastUsedAt", "reapAt", "clientHostPid", "cwd", "permission", "toolPermission"] {
        s.insert(key.into(), or_null(row.get(key)));
    }
    let count = |key: &str| {
        let n = row.get(key).map_or(0.0, mixdog_js::to_number);
        Value::from(if n > 0.0 { n } else { 0.0 })
    };
    s.insert("messageCount".into(), count("messages"));
    s.insert("toolCount".into(), count("tools"));
    s
}

/// A row, tombstone or session as the agent tool's record of a tag.
pub fn tag_record(row: &Row, tag_key: &str, id_key: &str) -> TagRecord {
    TagRecord {
        tag: clean(row.get(tag_key)),
        session_id: clean(row.get(id_key)),
        agent: clean(row.get("agent")),
        cwd: clean(row.get("cwd")),
        owner: owner_of(row),
    }
}

/// The facts of a session (`getLiveSession`'s answer).
pub fn session_facts(session: &Row) -> SessionFacts {
    SessionFacts { id: clean(session.get("id")), agent: clean(session.get("agent")), cwd: clean(session.get("cwd")), owner: owner_of(session) }
}

/// `isUnnotifiedRestartFailure`.
pub fn is_unnotified_restart_failure(row: &Row) -> bool {
    row.get("status").and_then(Value::as_str) == Some("failed")
        && row.get("failureReason").and_then(Value::as_str) == Some(PROCESS_RESTART_FAILURE)
        && !clean(row.get("ownerSessionId")).is_empty()
        && !truthy(row.get("restartNotified"))
}

// ---- tombstones ------------------------------------------------------------------------

/// `tagTombstoneKey`.
pub fn tombstone_key(row: &Row) -> String {
    #[cfg(any(test, feature = "test-support"))]
    work::note(|c| c.tombstones_keyed += 1);
    let parent = clean(either(row, "parentSessionId", "ownerSessionId"));
    let tag = clean(row.get("tag"));
    if parent.is_empty() {
        format!("{}\0{tag}", positive_int(row.get("clientHostPid")).unwrap_or(0))
    } else {
        format!("session:{parent}\0{tag}")
    }
}

/// `findTagTombstone(row, tombstones, tag)`.
pub fn find_tombstone<'a>(row: &Row, by_key: &'a std::collections::HashMap<String, Row>, tag: &str) -> Option<&'a Row> {
    let parent = clean(either(row, "parentSessionId", "ownerSessionId"));
    let by_parent = (!parent.is_empty()).then(|| by_key.get(&format!("session:{parent}\0{tag}"))).flatten();
    by_parent.or_else(|| by_key.get(&format!("{}\0{tag}", positive_int(row.get("clientHostPid")).unwrap_or(0))))
}

/// `tombstoneBlocksWork`.
pub fn blocks_work(row: &Row, tombstone: Option<&Row>) -> bool {
    #[cfg(any(test, feature = "test-support"))]
    work::note(|c| c.rows_tested += 1);
    let reaped_at = stamp_ms(tombstone.and_then(|t| t.get("reapedAt")));
    if reaped_at == 0.0 {
        return false;
    }
    stamp_ms(row.get("createdAt")).max(stamp_ms(row.get("turnStartedAt"))) <= reaped_at
}

/// `normalizeTagTombstones` for one stored tombstone of session `session_id`: `None` when it
/// has no tag or no time, or is past the TTL at `now`.
pub fn normalize_tombstone(raw: &Row, session_id: &str, now: f64) -> Option<Row> {
    #[cfg(any(test, feature = "test-support"))]
    work::note(|c| c.tombstones_normalized += 1);
    let parsed = parse_or_zero(&clean(raw.get("reapedAt")));
    let reaped_at = (parsed != 0.0).then(|| iso(parsed.min(now)));
    let mut t = Row::new();
    t.insert("tag".into(), Value::String(clean(raw.get("tag"))));
    t.insert("agent".into(), text_or_null(clean(raw.get("agent"))));
    t.insert("cwd".into(), text_or_null(clean(raw.get("cwd"))));
    t.insert("clientHostPid".into(), pid_value(positive_int(raw.get("clientHostPid"))));
    let own = clean(raw.get("sessionId"));
    t.insert("sessionId".into(), Value::String(if own.is_empty() { session_id.to_owned() } else { own }));
    for key in ["parentSessionId", "ownerSessionId"] {
        let value = clean(raw.get(key));
        if !value.is_empty() {
            t.insert(key.into(), Value::String(value));
        }
    }
    let reaped_at = reaped_at?;
    let live = !clean(t.get("tag")).is_empty() && parse_or_zero(&reaped_at) >= now - TAG_TOMBSTONE_TTL_MS;
    t.insert("reapedAt".into(), Value::String(reaped_at));
    live.then_some(t)
}

/// The tombstone list readers see: newest first, at most [`MAX_TAG_TOMBSTONES`].
pub fn order_tombstones(mut rows: Vec<Row>) -> Vec<Row> {
    rows.sort_by(|a, b| {
        let (a, b) = (parse_or_zero(&clean(a.get("reapedAt"))), parse_or_zero(&clean(b.get("reapedAt"))));
        b.partial_cmp(&a).unwrap_or(std::cmp::Ordering::Equal)
    });
    rows.truncate(MAX_TAG_TOMBSTONES);
    rows
}

/// `recoverTagTombstoneOwner`: the owner a legacy (owner-less) tombstone's session had,
/// when exactly one session can be it; `None` otherwise.
pub fn recover_owner(row: &Row, sessions: &[Row]) -> Option<Row> {
    if !clean(either(row, "parentSessionId", "ownerSessionId")).is_empty() {
        return None;
    }
    let pid = positive_int(row.get("clientHostPid"))?;
    let reaped_at = stamp_ms(row.get("reapedAt"));
    if reaped_at == 0.0 {
        return None;
    }
    let own = clean(row.get("sessionId"));
    let tag = clean(row.get("tag"));
    let candidates: Vec<&Row> = sessions
        .iter()
        .filter(|s| {
            let id = clean(s.get("id"));
            let created = stamp_ms(s.get("createdAt"));
            !id.is_empty()
                && (own.is_empty() || own == id)
                && agent_tag_of(s) == tag
                && positive_int(s.get("clientHostPid")) == Some(pid)
                && !clean(either(s, "parentSessionId", "ownerSessionId")).is_empty()
                && created > 0.0
                && created <= reaped_at
        })
        .collect();
    let [session] = candidates.as_slice() else { return None };
    let mut out = row.clone();
    out.insert("sessionId".into(), Value::String(clean(session.get("id"))));
    out.insert("parentSessionId".into(), Value::String(clean(either(session, "parentSessionId", "ownerSessionId"))));
    out.insert("ownerSessionId".into(), Value::String(clean(either(session, "ownerSessionId", "parentSessionId"))));
    Some(out)
}

/// `resumableAfterReap`.
pub fn resumable_after_reap(record: &Row) -> bool {
    if record.get("closeProvenance").and_then(Value::as_f64) != Some(CLOSE_PROVENANCE_VERSION) {
        return false;
    }
    let closed_at = stamp_ms(record.get("ownerClosedAt"));
    !(closed_at > 0.0 && closed_at >= stamp_ms(record.get("lastTurnCompletedAt")))
}

// ---- retention -------------------------------------------------------------------------

/// `sessionActivityAt`.
pub fn session_activity_at(record: &Row) -> f64 {
    ["updatedAt", "finishedAt", "lastUsedAt", "createdAt"].into_iter().map(|k| stamp_ms(record.get(k))).fold(0.0, f64::max)
}

/// `settledRetentionDeadline`, with `reap_ms` the provider's `resolveAgentTerminalReapMs`.
pub fn settled_retention_deadline(reap_ms: &dyn Fn(&str) -> f64, record: &Row) -> f64 {
    let settled = session_activity_at(record);
    if settled <= 0.0 {
        return f64::INFINITY;
    }
    let floor = settled + SETTLED_ROW_RETENTION_MS;
    let stamped = stamp_ms(record.get("reapAt"));
    if stamped > 0.0 {
        return floor.max(stamped);
    }
    let end = settled + reap_ms(&clean(record.get("provider")));
    if end.is_nan() { f64::INFINITY } else { floor.max(end) }
}

/// `pastSettledRetention`.
pub fn past_settled_retention(reap_ms: &dyn Fn(&str) -> f64, record: &Row, now: f64) -> bool {
    let settled = session_activity_at(record);
    if settled <= 0.0 || now - settled < SETTLED_ROW_RETENTION_MS {
        return false;
    }
    now >= settled_retention_deadline(reap_ms, record)
}

/// `nonterminalReapDeadline`.
pub fn nonterminal_reap_deadline(reap_ms: &dyn Fn(&str) -> f64, row: &Row) -> f64 {
    let time = worker_row_time(row);
    if time <= 0.0 {
        return 0.0;
    }
    time + reap_ms(&clean(row.get("provider")))
}
