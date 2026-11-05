//! The exec's one view of the thread feed: every notification of the run's thread, in feed order,
//! becomes zero or more [`Obs`] (what Node's engine callbacks reported). The core hands the feed to
//! the client library's thread reducer, so the tap is that reducer; its folded state is the
//! snapshot unchanged.

use std::sync::Arc;

use mixdog_app_server_client::api::RpcNotification;
use mixdog_app_server_client::api::ThreadReducer;
use mixdog_protocol::MaybeBlob;
use mixdog_protocol::ThreadItem;
use serde_json::Value;
use tokio::sync::mpsc;

use super::lifecycle::ResultInfo;
use super::lifecycle::ToolCall;
use super::lifecycle::ToolKind;
use super::lifecycle::ToolResult;
use super::lifecycle::ToolTiming;
use super::usage::UsageDelta;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TurnStatus {
    Completed,
    Failed(String),
    Interrupted,
}

#[derive(Debug, Clone)]
pub enum Obs {
    ModelRequestStarted,
    Usage(UsageDelta),
    Reasoning(String),
    Assistant(String),
    ToolObserved(ToolCall),
    ToolResult(ToolResult),
    BatchStarted,
    BatchCompleted { iteration: f64, calls: f64, elapsed_ms: Option<f64> },
    Stage { stage: String, detail: Option<Value> },
    Notification { content: String, meta: Value },
    TurnEnd { status: TurnStatus, result: ResultInfo },
    /// A notification of a known method that does not fit its contract.
    Malformed(String),
}

pub struct FeedTap {
    tx: mpsc::UnboundedSender<Obs>,
}

impl FeedTap {
    pub fn new() -> (Arc<Self>, mpsc::UnboundedReceiver<Obs>) {
        let (tx, rx) = mpsc::unbounded_channel();
        (Arc::new(Self { tx }), rx)
    }
}

impl ThreadReducer for FeedTap {
    fn initial(&self, snapshot: &Value) -> Value {
        snapshot.clone()
    }

    fn apply(&self, state: &Value, notification: &RpcNotification) -> Value {
        for obs in observe(notification) {
            // A closed receiver means the run has ended; nothing is left to observe for.
            let _ = self.tx.send(obs);
        }
        state.clone()
    }
}

fn number(value: Option<&Value>) -> f64 {
    value.map_or(f64::NAN, mixdog_js::to_number)
}

/// `num(v)` of `session-stats.mjs`: a non-finite value is 0.
fn finite(value: Option<&Value>) -> f64 {
    let n = number(value);
    if n.is_finite() { n } else { 0.0 }
}

fn text_of(value: Option<&Value>) -> String {
    value.and_then(Value::as_str).unwrap_or_default().to_owned()
}

fn timing_of(run: &Value) -> Option<ToolTiming> {
    let timing = run.get("timing")?;
    let mark = |key: &str| timing.get(key).map(|value| number(Some(value))).filter(|n| n.is_finite());
    Some(ToolTiming {
        dispatch_started_at: mark("dispatchStartedAt"),
        execution_started_at: mark("executionStartedAt"),
        execution_completed_at: mark("executionCompletedAt"),
        postprocess_started_at: mark("postprocessStartedAt"),
        result_completed_at: mark("resultCompletedAt"),
    })
}

fn inline<T: Clone>(body: &MaybeBlob<T>) -> Result<T, String> {
    match body {
        MaybeBlob::Inline(value) => Ok(value.clone()),
        MaybeBlob::Blob(_) => Err("a body arrived as an unresolved blob stub".into()),
    }
}

fn item_of(params: &Value) -> Result<ThreadItem, String> {
    serde_json::from_value(params.get("item").cloned().unwrap_or(Value::Null)).map_err(|err| format!("item: {err}"))
}

fn tool_started(item: &ThreadItem, params: &Value) -> Option<Obs> {
    let ThreadItem::ToolCall { id, name, input, run, .. } = item else { return None };
    let _ = params;
    Some(Obs::ToolObserved(ToolCall { id: run.call_id.clone().unwrap_or_else(|| id.to_string()), name: name.clone(), arguments: input.clone() }))
}

fn item_completed(params: &Value) -> Result<Option<Obs>, String> {
    Ok(match item_of(params)? {
        ThreadItem::AgentMessage { text, .. } => Some(Obs::Assistant(inline(&text)?)),
        ThreadItem::Reasoning { summary, content, .. } => {
            let parts = if content.is_empty() { summary } else { content };
            Some(Obs::Reasoning(parts.concat()))
        }
        ThreadItem::ToolCall { id, name, output, run, meta, .. } => {
            let content = match (&run.result, &output) {
                (Some(result), _) => Value::String(inline(result)?),
                (None, Some(output)) => inline(output)?,
                (None, None) => Value::Null,
            };
            let failed = run.is_error == Some(true) || matches!(meta.status, Some(mixdog_protocol::ItemStatus::Failed));
            let skipped = matches!(meta.status, Some(mixdog_protocol::ItemStatus::Declined));
            let raw_item = params.get("item").unwrap_or(&Value::Null);
            Some(Obs::ToolResult(ToolResult {
                call_id: run.call_id.clone().unwrap_or_else(|| id.to_string()),
                name: Some(name),
                content,
                is_error: failed,
                kind: if failed {
                    ToolKind::Error
                } else if skipped {
                    ToolKind::Skipped
                } else {
                    ToolKind::Normal
                },
                timing: raw_item.get("run").and_then(timing_of),
            }))
        }
        _ => None,
    })
}

fn turn_end(params: &Value) -> Result<Obs, String> {
    let turn = params.get("turn").ok_or("turn/completed without a turn")?;
    let status = match turn.get("status").and_then(Value::as_str) {
        Some("completed") => TurnStatus::Completed,
        Some("interrupted") => TurnStatus::Interrupted,
        Some("failed") => TurnStatus::Failed(
            turn.pointer("/error/message").and_then(Value::as_str).unwrap_or("execution failed").to_owned(),
        ),
        other => return Err(format!("turn/completed with status {other:?}")),
    };
    let reason = |key: &str| turn.get(key).and_then(Value::as_str).map(str::to_owned);
    Ok(Obs::TurnEnd { status, result: ResultInfo { stop_reason: reason("stopReason"), termination_reason: reason("terminationReason") } })
}

fn usage_delta(params: &Value) -> Obs {
    let usage = params.get("usage").unwrap_or(&Value::Null);
    Obs::Usage(UsageDelta {
        model: usage.get("model").and_then(Value::as_str).map(str::to_owned),
        input: finite(usage.get("deltaInput")),
        cached_read: finite(usage.get("deltaCachedRead")),
        cache_write: finite(usage.get("deltaCacheWrite")),
        output: finite(usage.get("deltaOutput")),
    })
}

/// The observations of one thread-feed notification.
pub fn observe(notification: &RpcNotification) -> Vec<Obs> {
    let params = notification.params.clone().unwrap_or(Value::Null);
    let fail = |err: String| vec![Obs::Malformed(format!("{}: {err}", notification.method))];
    match notification.method.as_str() {
        "item/started" => match item_of(&params) {
            Ok(item) => tool_started(&item, &params).into_iter().collect(),
            Err(err) => fail(err),
        },
        "item/completed" => match item_completed(&params) {
            Ok(obs) => obs.into_iter().collect(),
            Err(err) => fail(err),
        },
        "turn/completed" => match turn_end(&params) {
            Ok(obs) => vec![obs],
            Err(err) => fail(err),
        },
        "thread/tokenUsage/updated" => vec![usage_delta(&params)],
        "thread/modelRequest/updated" => match params.get("status").and_then(Value::as_str) {
            Some("started") => vec![Obs::ModelRequestStarted],
            _ => Vec::new(),
        },
        "thread/toolBatch/updated" => match params.get("status").and_then(Value::as_str) {
            Some("started") => vec![Obs::BatchStarted],
            Some("completed") => vec![Obs::BatchCompleted {
                iteration: finite(params.get("iteration")),
                calls: finite(params.get("calls")),
                elapsed_ms: params.get("elapsedMs").map(|value| number(Some(value))).filter(|n| n.is_finite()),
            }],
            other => fail(format!("status {other:?}")),
        },
        "thread/stage/updated" => vec![Obs::Stage {
            stage: text_of(params.get("stage")),
            detail: params.get("detail").cloned().filter(|detail| !detail.is_null()),
        }],
        "thread/notification" => vec![Obs::Notification { content: text_of(params.get("content")), meta: params.get("meta").cloned().unwrap_or(Value::Null) }],
        _ => Vec::new(),
    }
}
