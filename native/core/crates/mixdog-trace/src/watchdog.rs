//! What the agent progress watchdog writes when it aborts a turn: `recordAgentWatchdogAbort` and
//! `recordAgentWatchdogAbortRow` (`agent-runtime/agent-progress-watchdog.mjs`). Two records: the
//! `stall_abort` trace row (gone in ship mode like every trace row) and the `kind:"stall_abort"`
//! row of `tool-failures.jsonl`, which stays on in ship mode so a stop can be audited.

use std::sync::LazyLock;

use mixdog_js::JsRegex;
use mixdog_js::json_number;
use mixdog_js::to_number;
use mixdog_js::value_to_string;
use serde_json::Map;
use serde_json::Value;

use crate::builders::Args;
use crate::builders::stall_abort_record;
use crate::record::truthy;

/// The two records of one abort.
#[derive(Debug)]
pub struct WatchdogAbort {
    pub trace: Args,
    pub failure: Value,
}

fn re(pattern: &str) -> JsRegex {
    JsRegex::new_static(pattern, "")
}

static LIMIT: LazyLock<JsRegex> = LazyLock::new(|| re(r"\((\d+)ms"));
static FIRST_TRANSPORT: LazyLock<JsRegex> = LazyLock::new(|| re(r"^agent first transport stale"));
static FIRST_SEMANTIC: LazyLock<JsRegex> = LazyLock::new(|| re(r"^agent first semantic response stale"));
static IDLE: LazyLock<JsRegex> = LazyLock::new(|| re(r"^agent task stale \(\d+ms without stream/tool progress\)"));
static CHECKS_FAILED: LazyLock<JsRegex> = LazyLock::new(|| re(r"^agent progress checks failed"));

/// `watchdogAbortKind(message)`: `(window, form, limit)`.
fn abort_kind(message: &str) -> (Value, &'static str, Option<f64>) {
    let limit = LIMIT
        .captures(message)
        .and_then(|c| c.get(1).and_then(|d| d.parse::<f64>().ok()))
        .filter(|n| *n != 0.0);
    let window = |w: &str| Value::String(w.into());
    if FIRST_TRANSPORT.is_match(message) {
        (window("first_response"), "first_transport", limit)
    } else if FIRST_SEMANTIC.is_match(message) {
        (window("first_output"), "first_semantic", limit)
    } else if IDLE.is_match(message) {
        (window("idle"), "idle_progress", limit)
    } else if CHECKS_FAILED.is_match(message) {
        (window("idle"), "checks_failed", None)
    } else {
        (Value::Null, "other", None)
    }
}

fn or_null(value: Option<&Value>) -> Value {
    match value {
        Some(v) if truthy(v) => v.clone(),
        _ => Value::Null,
    }
}

fn nullish(value: Option<&Value>) -> Value {
    value.cloned().unwrap_or(Value::Null)
}

fn put(map: &mut Args, key: &str, value: Value) {
    map.insert(key.into(), value);
}

/// `resolveWatchdogAbortClock`: the timestamp the stop was measured from and which clock it is.
fn resolve_clock(snapshot: Option<&Value>, policy: Option<&Value>, anchor_ts: Option<&Value>) -> (Value, Value) {
    let field = |name: &str| Value::String(name.into());
    if let (Some(s), Some(_)) = (snapshot, policy) {
        let pick = |key: &str| s.get(key).filter(|v| truthy(v)).cloned();
        if s.get("waitingForFirstSemantic").is_some_and(truthy) {
            if let Some(at) = pick("modelRequestStartedAt") {
                return (at, field("model_request_started_at"));
            }
            if let Some(at) = pick("askStartedAt") {
                return (at, field("ask_started_at"));
            }
        }
        if let Some(at) = pick("lastProgressAt") {
            return (at, field("last_progress_at"));
        }
        if let Some(at) = pick("firstActivityAt") {
            return (at, field("first_activity_at"));
        }
    }
    match anchor_ts.filter(|v| truthy(v)) {
        Some(at) => (at.clone(), field("anchor_ts")),
        None => (Value::Null, Value::Null),
    }
}

/// `recordAgentWatchdogAbort(ctx)`. `a` holds the context's fields (absent = undefined):
/// `sessionId`, `agent`, `error` (an object; its `message` string is used), `snapshot`, `policy`
/// (`idleStaleMs`), `now` (default `now_ms`), `anchorTs`, `iteration`, `observation`
/// (`source`, `lastReadOkAt`, `readPendingSince`, `lastReadError`), `registrationId`,
/// `comparedClock` (`at`, `field`), and `buildVersion` (Node's `PACKAGE_VERSION`). `None` where Node
/// returns without writing (no session id, no error).
pub fn watchdog_abort_records(a: &Args, now_ms: i64) -> Option<WatchdogAbort> {
    if !a.get("sessionId").is_some_and(truthy) {
        return None;
    }
    let error = a.get("error").filter(|e| truthy(e))?;
    let snapshot = a.get("snapshot").filter(|v| truthy(v));
    let policy = a.get("policy").filter(|v| truthy(v));
    let observation = a.get("observation").filter(|v| truthy(v));
    let (clock_at, clock_field) = match a.get("comparedClock").filter(|v| truthy(v)) {
        Some(c) => (nullish(c.get("at")), nullish(c.get("field"))),
        None => resolve_clock(snapshot, policy, a.get("anchorTs")),
    };
    let now = match a.get("now") {
        Some(Value::Number(n)) => n.as_f64().unwrap_or(now_ms as f64),
        _ => now_ms as f64,
    };
    let elapsed = if truthy(&clock_at) {
        json_number((now - to_number(&clock_at)).max(0.0))
    } else {
        Value::Null
    };
    let snap = |key: &str| snapshot.and_then(|s| s.get(key));
    let message = error
        .get("message")
        .and_then(Value::as_str)
        .map_or_else(|| value_to_string(error), str::to_string);

    let mut trace_args = Map::new();
    for key in ["sessionId", "iteration", "agent"] {
        if let Some(v) = a.get(key) {
            trace_args.insert(key.into(), v.clone());
        }
    }
    trace_args.insert("elapsed_ms".into(), elapsed.clone());
    trace_args.insert("message".into(), Value::String(message));
    trace_args.insert("stage".into(), nullish(snap("stage")));
    let trace = stall_abort_record(&trace_args);

    let own_message = error.get("message").and_then(Value::as_str).unwrap_or("");
    let (window, form, limit) = abort_kind(own_message);
    let limit_ms = match limit {
        Some(n) => json_number(n),
        None => nullish(policy.and_then(|p| p.get("idleStaleMs"))),
    };
    let session_id = Value::String(value_to_string(&a["sessionId"]));
    let boolean = |key: &str| Value::Bool(snap(key).is_some_and(truthy));
    let obs = |key: &str| or_null(observation.and_then(|o| o.get(key)));
    let mut row = Map::new();
    put(&mut row, "ts", Value::from(now_ms));
    put(&mut row, "kind", Value::String("stall_abort".into()));
    put(&mut row, "category", Value::String("agent-stall".into()));
    put(&mut row, "build_version", or_null(a.get("buildVersion")));
    put(&mut row, "registration_id", or_null(a.get("registrationId")));
    put(&mut row, "session_id", session_id);
    put(&mut row, "iteration", nullish(a.get("iteration")));
    put(&mut row, "agent", or_null(a.get("agent")));
    put(&mut row, "stage", nullish(snap("stage")));
    put(&mut row, "window", window);
    put(&mut row, "limit_ms", limit_ms);
    put(&mut row, "form", Value::String(form.into()));
    put(&mut row, "compared_field", clock_field);
    put(&mut row, "compared_at", clock_at);
    put(&mut row, "elapsed_ms", elapsed);
    put(&mut row, "snapshot_present", Value::Bool(snapshot.is_some()));
    put(
        &mut row,
        "snapshot_source",
        if snapshot.is_some() {
            match observation.and_then(|o| o.get("source")).filter(|v| truthy(v)) {
                Some(v) => v.clone(),
                None => Value::String("direct".into()),
            }
        } else {
            Value::Null
        },
    );
    put(&mut row, "last_read_ok_at", obs("lastReadOkAt"));
    put(&mut row, "read_pending_since", obs("readPendingSince"));
    put(&mut row, "last_read_error", obs("lastReadError"));
    put(&mut row, "ask_started_at", or_null(snap("askStartedAt")));
    put(&mut row, "model_request_started_at", or_null(snap("modelRequestStartedAt")));
    put(&mut row, "waiting_for_transport", if snapshot.is_some() { boolean("waitingForTransport") } else { Value::Null });
    put(&mut row, "waiting_for_first_semantic", if snapshot.is_some() { boolean("waitingForFirstSemantic") } else { Value::Null });
    put(&mut row, "awaiting_user", or_null(snap("awaitingUser")));
    put(&mut row, "last_progress_at", or_null(snap("lastProgressAt")));
    put(&mut row, "last_keepalive_at", or_null(snap("lastKeepaliveAt")));
    put(&mut row, "anchor_ts", or_null(a.get("anchorTs")));
    put(&mut row, "current_tool", or_null(snap("currentTool")));
    Some(WatchdogAbort { trace, failure: Value::Object(row) })
}
