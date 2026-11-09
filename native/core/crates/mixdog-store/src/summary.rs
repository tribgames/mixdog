//! The catalog list row: one builder, used by the live catalog upsert and by
//! `project_index`. It mirrors 1.4.5 `_sessionSummary`
//! (`store-summary-index.mjs`) over the folded header; the message-derived fields
//! (`messageCount`, `realTurnCount`, `incomingTail`, `preview`, `lastMessagePreview`,
//! `lastMessageRoutine`) come from `MessageStats`, the per-session state the projection
//! keeps.

use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use crate::fold::Fold;
// `Fold` is only the source of a `CatalogHead`.
use crate::sqlite::CatalogRow;

/// The message-derived part of the row.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct MessageStats {
    pub count: u64,
    pub real: u64,
    pub incoming: Option<Vec<u64>>,
    pub preview: String,
    pub last: String,
    pub last_routine: Value,
}

pub(crate) fn get<'a>(h: &'a Map<String, Value>, k: &str) -> Option<&'a Value> {
    h.get(k)
}

/// JS truthiness of a JSON value.
pub(crate) fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// `value || null`.
fn or_null(v: Option<&Value>) -> Value {
    if truthy(v) { v.cloned().unwrap_or(Value::Null) } else { Value::Null }
}

/// `String(value || '').trim()` for strings and numbers.
pub(crate) fn clean(v: Option<&Value>) -> String {
    if !truthy(v) {
        return String::new();
    }
    let s = match v {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.to_string(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(other) => other.to_string(),
        None => String::new(),
    };
    mixdog_js::js_trim(&s).to_owned()
}

/// `positiveNumber(value, fallback)`.
fn positive(v: Option<&Value>, fallback: f64) -> f64 {
    let n = match v {
        Some(v @ (Value::Number(_) | Value::String(_) | Value::Bool(_))) => mixdog_js::to_number(v),
        _ => f64::NAN,
    };
    if n.is_finite() && n > 0.0 { n } else { fallback }
}

use mixdog_js::json_number as num;

pub(crate) fn is_stored_session_id(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// `isRootLeadSession`: a Lead whose owner/parent link is none or itself.
pub fn is_root_lead_session(h: &Map<String, Value>) -> bool {
    let parent = [get(h, "ownerSessionId"), get(h, "parentSessionId")]
        .into_iter()
        .map(clean)
        .find(|id| is_stored_session_id(id))
        .unwrap_or_default();
    clean(get(h, "agent")).to_lowercase() == "lead" && (parent.is_empty() || parent == clean(get(h, "id")))
}

/// `store-summary-visibility.mjs` `sessionVisibility`.
pub fn session_visibility(h: &Map<String, Value>) -> &'static str {
    if is_root_lead_session(h) {
        return "ordinary";
    }
    let parent = [get(h, "ownerSessionId"), get(h, "parentSessionId")]
        .into_iter()
        .map(clean)
        .find(|id| is_stored_session_id(id))
        .unwrap_or_default();
    let id = clean(get(h, "id"));
    let declared = {
        let v = get(h, "visibility").filter(|v| truthy(Some(v))).or_else(|| get(h, "sessionVisibility"));
        clean(v).to_lowercase()
    };
    let agent_child = clean(get(h, "owner")).to_lowercase() == "agent" && !parent.is_empty() && parent != id;
    if declared == "agent-only" || agent_child { "agent-only" } else { "ordinary" }
}

/// `store-summary-fields.mjs` `workspaceSummary`.
pub fn workspace_summary(v: Option<&Value>) -> Option<Value> {
    let w = v?.as_object()?;
    let text = |k: &str| match w.get(k) {
        Some(Value::String(s)) => mixdog_js::js_trim(s).to_owned(),
        _ => String::new(),
    };
    let or_null = |k: &str| {
        let t = text(k);
        if t.is_empty() { Value::Null } else { Value::String(t) }
    };
    let (project_path, cwd) = (text("projectPath"), text("cwd"));
    if project_path.is_empty() || cwd.is_empty() || project_path.contains('\0') || cwd.contains('\0') {
        return None;
    }
    let transition = w.get("transition").and_then(Value::as_object);
    let state = transition
        .and_then(|t| t.get("state"))
        .and_then(Value::as_str)
        .filter(|s| ["idle", "provisioning", "switching", "removing", "recovery"].contains(s))
        .unwrap_or("idle");
    let tx_id = if state == "idle" {
        None
    } else {
        transition
            .and_then(|t| t.get("txId"))
            .and_then(Value::as_str)
            .map(|s| mixdog_js::js_trim(s).to_owned())
            .filter(|s| !s.is_empty())
    };
    let revision = w
        .get("revision")
        .and_then(Value::as_f64)
        .filter(|r| r.fract() == 0.0 && *r >= 0.0 && *r <= 9_007_199_254_740_991.0)
        .unwrap_or(0.0);
    Some(json!({
        "projectPath": project_path,
        "repoCommonDir": or_null("repoCommonDir"),
        "cwd": cwd,
        "worktreeId": or_null("worktreeId"),
        "branch": or_null("branch"),
        "baseCommit": or_null("baseCommit"),
        "mergeTarget": or_null("mergeTarget"),
        "revision": num(revision),
        "transition": match tx_id {
            Some(tx) => json!({"state": state, "txId": tx}),
            None => json!({"state": "idle", "txId": null}),
        },
    }))
}

/// `_desktopSessionSummary(value, cwd)`.
fn desktop_session(v: Option<&Value>, cwd: Option<&Value>) -> Value {
    let Some(d) = v.and_then(Value::as_object) else { return Value::Null };
    match d.get("classification").and_then(Value::as_str) {
        Some("task") => json!({"classification": "task", "projectPath": null}),
        Some("project") => {
            let clean_path = |p: Option<&Value>| match p {
                Some(Value::String(s)) => {
                    let t = mixdog_js::js_trim(s);
                    (!t.is_empty() && !t.contains('\0')).then(|| t.to_owned())
                }
                _ => None,
            };
            match clean_path(d.get("projectPath")).or_else(|| clean_path(cwd)) {
                Some(p) => json!({"classification": "project", "projectPath": p}),
                None => Value::Null,
            }
        }
        _ => Value::Null,
    }
}

fn import_key(h: &Map<String, Value>) -> Value {
    let key = match get(h, "importKey") {
        Some(Value::String(s)) => Some(s.as_str()),
        _ => get(h, "importOrigin").and_then(|o| o.get("key")).and_then(Value::as_str),
    };
    match key {
        Some(k) if !mixdog_js::js_trim(k).is_empty() => json!(k),
        _ => Value::Null,
    }
}

fn compact_count(h: &Map<String, Value>) -> Value {
    let c = get(h, "compaction").and_then(|c| c.get("compactCount")).and_then(Value::as_f64);
    match c {
        Some(c) if c.fract() == 0.0 && (0.0..=9_007_199_254_740_991.0).contains(&c) => num(c),
        _ => json!(0),
    }
}

/// The header-side input of a catalog row: what the fold knows besides the messages.
#[derive(Debug, Clone, PartialEq)]
pub struct CatalogHead {
    pub session: String,
    pub log_id: String,
    pub base_session: Option<String>,
    pub header: Map<String, Value>,
}

impl CatalogHead {
    pub fn of(fold: &Fold) -> CatalogHead {
        CatalogHead {
            session: fold.session.clone(),
            log_id: fold.log_id.clone(),
            base_session: fold.base.as_ref().map(|b| b.session.as_str().to_owned()),
            header: fold.header.clone(),
        }
    }
}

/// The catalog row of `head` with `stats` (the list row JSON is `_sessionSummary`'s
/// shape). `now` is `Date.now()` for a header without `updatedAt`.
pub fn catalog_row(head: &CatalogHead, stats: &MessageStats, now: f64) -> CatalogRow {
    let h = &head.header;
    let str_field = |k: &str| get(h, k).and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_owned);
    let updated_at = positive(get(h, "updatedAt"), now);
    let last_used = positive(get(h, "lastUsedAt"), 0.0);
    let desktop = desktop_session(get(h, "desktopSession"), get(h, "cwd"));
    let parent = or_null(get(h, "parentSessionId"));
    let owner_session = if truthy(get(h, "ownerSessionId")) { or_null(get(h, "ownerSessionId")) } else { parent.clone() };
    let visibility = session_visibility(h);
    let mut s = Map::new();
    s.insert("id".into(), json!(head.session));
    s.insert("updatedAt".into(), num(updated_at));
    s.insert("lastUsedAt".into(), num(last_used));
    s.insert("createdAt".into(), num(positive(get(h, "createdAt"), 0.0)));
    s.insert("lastHeartbeatAt".into(), num(positive(get(h, "lastHeartbeatAt"), 0.0)));
    let closed = get(h, "closed") == Some(&Value::Bool(true));
    s.insert("closed".into(), json!(closed));
    let status = if truthy(get(h, "status")) { clean(get(h, "status")) } else if closed { "closed".into() } else { "idle".into() };
    s.insert("status".into(), json!(status));
    s.insert("owner".into(), if truthy(get(h, "owner")) { get(h, "owner").cloned().unwrap_or(Value::Null) } else { json!("user") });
    s.insert("agent".into(), or_null(get(h, "agent")));
    s.insert("sessionMode".into(), json!(crate::agent_mode::session_mode_of(h)));
    for k in ["sourceType", "sourceName", "scopeKey"] {
        s.insert(k.into(), or_null(get(h, k)));
    }
    s.insert("parentSessionId".into(), parent.clone());
    s.insert("ownerSessionId".into(), owner_session.clone());
    s.insert("visibility".into(), json!(visibility));
    let pid = positive(get(h, "clientHostPid"), 0.0);
    s.insert("clientHostPid".into(), if pid > 0.0 { num(pid) } else { Value::Null });
    s.insert("cwd".into(), if truthy(get(h, "cwd")) { get(h, "cwd").cloned().unwrap_or_default() } else { json!("") });
    s.insert("desktopSession".into(), desktop.clone());
    if let Some(w) = workspace_summary(get(h, "workspace")) {
        s.insert("workspace".into(), w);
    }
    for k in ["provider", "model"] {
        s.insert(k.into(), or_null(get(h, k)));
    }
    s.insert(
        "presetName".into(),
        if truthy(get(h, "presetName")) { or_null(get(h, "presetName")) } else { or_null(get(h, "profileId")) },
    );
    s.insert("effort".into(), or_null(get(h, "effort")));
    s.insert("fast".into(), json!(get(h, "fast") == Some(&Value::Bool(true))));
    if get(h, "autoEffort") == Some(&Value::Bool(false)) {
        s.insert("autoEffort".into(), json!(false));
    }
    s.insert(
        "modelParameters".into(),
        match get(h, "modelParameters") {
            Some(v @ Value::Object(_)) => v.clone(),
            Some(Value::Array(a)) => Value::Object(a.iter().enumerate().map(|(i, v)| (i.to_string(), v.clone())).collect()),
            _ => Value::Null,
        },
    );
    s.insert("agentTag".into(), or_null(get(h, "agentTag")));
    s.insert(
        "task_id".into(),
        if truthy(get(h, "task_id")) { or_null(get(h, "task_id")) } else { or_null(get(h, "taskId")) },
    );
    for k in ["permission", "permissionMode", "toolPermission"] {
        s.insert(k.into(), or_null(get(h, k)));
    }
    s.insert(
        "schemaAllowedTools".into(),
        match get(h, "schemaAllowedTools") {
            Some(Value::Array(a)) => Value::Array(
                a.iter()
                    .map(|v| match v {
                        Value::String(s) => json!(s),
                        Value::Null => json!("null"),
                        other => json!(other.to_string()),
                    })
                    .collect(),
            ),
            _ => Value::Null,
        },
    );
    s.insert("taskType".into(), or_null(get(h, "taskType")));
    s.insert("messageCount".into(), json!(stats.count));
    if let Some(tail) = &stats.incoming {
        s.insert("incomingTail".into(), json!(tail));
    }
    s.insert("compactCount".into(), compact_count(h));
    s.insert("realTurnCount".into(), json!(stats.real));
    let title_raw = match get(h, "title") {
        Some(Value::String(t)) => t.clone(),
        _ => String::new(),
    };
    s.insert("title".into(), json!(crate::title::clean_summary_preview(&title_raw, 100)));
    s.insert("preview".into(), json!(stats.preview));
    s.insert("lastMessagePreview".into(), json!(stats.last));
    s.insert("lastMessageRoutine".into(), stats.last_routine.clone());
    s.insert(
        "generation".into(),
        match get(h, "generation") {
            Some(v @ Value::Number(_)) => v.clone(),
            _ => json!(0),
        },
    );
    s.insert("storageMtimeMs".into(), num(positive(get(h, "storageMtimeMs"), 0.0)));
    s.insert("storageSize".into(), num(positive(get(h, "storageSize"), 0.0)));
    s.insert("detachedReason".into(), or_null(get(h, "detachedReason")));
    s.insert("importKey".into(), import_key(h));
    s.insert(
        "inheritedFromSessionId".into(),
        match get(h, "inheritedFromSessionId") {
            Some(Value::String(v)) if !mixdog_js::js_trim(v).is_empty() => json!(mixdog_js::js_trim(v)),
            _ => Value::Null,
        },
    );
    let as_str = |v: &Value| v.as_str().map(str::to_owned);
    CatalogRow {
        id: head.session.clone(),
        log_id: head.log_id.clone(),
        base_session: head.base_session.clone(),
        activity: if last_used > 0.0 { last_used } else { updated_at },
        created_at: Some(positive(get(h, "createdAt"), 0.0)).filter(|v| *v > 0.0),
        updated_at: Some(updated_at),
        closed,
        archived_at: Some(positive(get(h, "archivedAt"), 0.0)).filter(|v| *v > 0.0),
        cwd: str_field("cwd"),
        visibility: Some(visibility.to_owned()),
        owner_session_id: as_str(&owner_session),
        parent_session_id: as_str(&parent),
        agent: str_field("agent"),
        source_type: str_field("sourceType"),
        classification: desktop.get("classification").and_then(Value::as_str).map(str::to_owned),
        archived: positive(get(h, "archivedAt"), 0.0) > 0.0,
        title: str_field("title"),
        preview: Some(stats.preview.clone()).filter(|p| !p.is_empty()),
        project_path: desktop.get("projectPath").and_then(Value::as_str).map(str::to_owned),
        model: str_field("model"),
        source_name: str_field("sourceName"),
        summary: Value::Object(s).to_string(),
        worker: crate::worker::WorkerKeys::of(h),
        agent_tag: crate::worker::TagKeys::of(&head.session, h),
        deleted: is_deleted(h),
        user_name: if get(h, "titleSource").and_then(Value::as_str) == Some("user") { str_field("title") } else { None },
    }
}

/// The header key of the delete mark (FORMAT.md §5.1 `meta`): `true` once `thread/delete`
/// removed the session. The log keeps it, so a rebuilt index holds it too.
pub const DELETED: &str = "deleted";

/// Whether the header carries the delete mark.
pub fn is_deleted(header: &Map<String, Value>) -> bool {
    header.get(DELETED) == Some(&Value::Bool(true))
}
