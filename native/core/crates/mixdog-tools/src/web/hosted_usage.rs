//! The spend of a hosted web search, as the asking turn hears it
//! (`session-runtime/native-web-search-usage.mjs`). The search runs as its own
//! provider send under a derived session id, so the main stream never reports
//! it; a turn that wants the spend registers a sink under its own session id and
//! receives the same delta shape `onUsageDelta` carries.
//!
//! Each registration is its own entry that only its own release removes, so
//! overlapping turns on one session id never restore or drop each other. The
//! session lock serializes turns, so the most recent live entry belongs to the
//! turn that is running.

use std::collections::HashMap;
use std::panic::AssertUnwindSafe;
use std::sync::Arc;
use std::sync::Mutex;

use mixdog_core_api::domain::provider::Usage;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

/// What a turn hears: one usage delta (`usageDeltaEvent` plus `source` and
/// `agentRole`). A sink that needs to wait spawns its own work; a panic in it
/// never reaches the search.
pub type UsageSink = Arc<dyn Fn(Value) + Send + Sync>;

#[derive(Default)]
pub struct NativeSearchUsageSinks {
    entries: Mutex<HashMap<String, Vec<(u64, UsageSink)>>>,
    next: Mutex<u64>,
}

/// Removes exactly the entry it was made for, when dropped.
pub struct Release {
    sinks: Option<(Arc<NativeSearchUsageSinks>, String, u64)>,
}

impl Drop for Release {
    fn drop(&mut self) {
        let Some((sinks, session, id)) = self.sinks.take() else { return };
        let mut entries = sinks.entries.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(live) = entries.get_mut(&session) {
            live.retain(|(entry, _)| *entry != id);
            if live.is_empty() {
                entries.remove(&session);
            }
        }
    }
}

impl NativeSearchUsageSinks {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Adds an owned entry for `session_id`; an empty id registers nothing.
    pub fn register(self: &Arc<Self>, session_id: &str, sink: UsageSink) -> Release {
        if session_id.is_empty() {
            return Release { sinks: None };
        }
        let id = {
            let mut next = self.next.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            *next += 1;
            *next
        };
        let mut entries = self.entries.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        entries.entry(session_id.to_owned()).or_default().push((id, sink));
        Release { sinks: Some((Arc::clone(self), session_id.to_owned(), id)) }
    }

    /// `reportNativeWebSearchUsage`: the newest live sink of the owning session
    /// hears the delta; nobody listening, or no usage, is a no-op.
    pub fn report(&self, owner_session_id: Option<&str>, delta: impl FnOnce() -> Value) {
        let sink = {
            let entries = self.entries.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            owner_session_id.and_then(|owner| entries.get(owner)).and_then(|live| live.last()).map(|(_, sink)| Arc::clone(sink))
        };
        if let Some(sink) = sink {
            // Telemetry must never fail the search.
            let _ = std::panic::catch_unwind(AssertUnwindSafe(|| sink(delta())));
        }
    }
}

/// The first reasoning count the raw usage names, in the order Node reads them.
fn raw_reasoning(raw: &Value) -> Option<u64> {
    let count = |value: Option<&Value>| value.and_then(Value::as_u64);
    [
        raw.pointer("/output_tokens_details/reasoning_tokens"),
        raw.pointer("/output_tokens_details/thinking_tokens"),
        raw.pointer("/completion_tokens_details/reasoning_tokens"),
        raw.pointer("/completion_tokens_details/thinking_tokens"),
        raw.get("thinking_tokens"),
        raw.get("thinkingTokens"),
        raw.get("thoughtsTokenCount"),
        raw.get("thoughts_token_count"),
    ]
    .into_iter()
    .find_map(count)
}

/// `usageDeltaEvent({ sessionId, iterationIndex: 0, requestedModel, model, usage })`
/// with the search's `source` and `agentRole`. `input_inclusive` is whether the
/// provider's `input_tokens` already holds the cached portion; the prompt total
/// is then the input itself, else the input plus the cache reads and writes.
pub fn usage_delta(session_id: &str, requested_model: &str, model: &str, usage: &Usage, input_inclusive: bool, ts: i64) -> Value {
    let prompt = if input_inclusive {
        usage.input_tokens
    } else {
        usage.input_tokens + usage.cache_read_tokens + usage.cache_write_tokens
    };
    // A count the provider named; Rust's `Usage` cannot tell an absent count
    // from a zero one, so a zero falls back to the raw object.
    let reasoning = Some(usage.reasoning_tokens).filter(|count| *count > 0).or_else(|| usage.raw.as_ref().and_then(raw_reasoning));
    let mut delta = Map::new();
    delta.insert("sessionId".into(), json!(session_id));
    delta.insert("iterationIndex".into(), json!(0));
    delta.insert("source".into(), json!("native_web_search"));
    delta.insert("requestedModel".into(), json!(requested_model));
    delta.insert("model".into(), json!(model));
    delta.insert("deltaInput".into(), json!(usage.input_tokens));
    delta.insert("deltaOutput".into(), json!(usage.output_tokens));
    delta.insert("deltaToolCalls".into(), json!(0));
    delta.insert("reasoningTokens".into(), json!(reasoning));
    delta.insert("reasoningTokensComplete".into(), json!(reasoning.is_some()));
    delta.insert("deltaPrompt".into(), json!(prompt));
    delta.insert("requestMs".into(), json!(0));
    delta.insert("promptKnown".into(), json!(true));
    delta.insert("deltaCachedRead".into(), json!(usage.cache_read_tokens));
    delta.insert("deltaCacheWrite".into(), json!(usage.cache_write_tokens));
    delta.insert("contextInputTokens".into(), json!(usage.input_tokens));
    delta.insert("contextOutputTokens".into(), json!(usage.output_tokens));
    delta.insert("contextPromptTokens".into(), json!(prompt));
    delta.insert("contextCachedReadTokens".into(), json!(usage.cache_read_tokens));
    delta.insert("contextCacheWriteTokens".into(), json!(usage.cache_write_tokens));
    delta.insert("contextMeasuredTokens".into(), Value::Null);
    delta.insert("ts".into(), json!(ts));
    delta.insert("agentRole".into(), json!("web-search"));
    Value::Object(delta)
}
