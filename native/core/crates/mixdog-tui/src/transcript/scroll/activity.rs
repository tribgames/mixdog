//! The transcript activity signatures (`use-transcript-activity.mjs`): the agent state revision key, the statusline
//! active-tool signature (the engine-published fast path and the local scan of pending tool cards) and the primitive
//! statusline stats projection. All read the store state as a JSON value.

use mixdog_view_model::tool_work_units::classify_tool_category;
use serde_json::{Map, Value, json};

/// Signature slots in order: shell, web search, agent.
const SIGNATURE_CATEGORIES: [&str; 3] = ["Shell", "Web Research", "Agent"];
/// Workers and jobs of the revision key are cut at this many each.
const REVISION_ENTRIES: usize = 20;

/// The statusline stats fields, each with the value it reads as when the state has none.
const STATS_FIELDS: [(&str, Option<i64>); 13] = [
    ("currentContextSource", None),
    ("currentEstimatedContextTokens", Some(0)),
    ("currentContextTokens", None),
    ("contextTokens", Some(0)),
    ("latestPromptTokens", Some(0)),
    ("latestInputTokens", Some(0)),
    ("latestCachedTokens", Some(0)),
    ("latestCacheWriteTokens", Some(0)),
    ("inputTokens", Some(0)),
    ("cachedTokens", Some(0)),
    ("cacheWriteTokens", Some(0)),
    ("promptTokens", Some(0)),
    ("turns", Some(0)),
];

/// A running tool kind on the statusline: how many calls and when the oldest started.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ActiveTool {
    pub count: f64,
    pub started_at: f64,
}

/// The statusline's running-tool segments; a kind with no calls is absent.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct ActiveTools {
    pub shell: Option<ActiveTool>,
    pub web_search: Option<ActiveTool>,
    pub agent: Option<ActiveTool>,
}

/// JavaScript's `Number(value)`; `NaN` for what is not a number.
fn js_number(value: Option<&Value>) -> f64 {
    match value {
        None => f64::NAN,
        Some(Value::Number(number)) => number.as_f64().unwrap_or(f64::NAN),
        Some(Value::Null) => 0.0,
        Some(Value::Bool(flag)) => f64::from(u8::from(*flag)),
        Some(Value::String(text)) => text.trim().parse::<f64>().unwrap_or(if text.trim().is_empty() { 0.0 } else { f64::NAN }),
        Some(_) => f64::NAN,
    }
}

/// `Number(value) || fallback`: a zero or `NaN` reads as the fallback.
fn number_or(value: Option<&Value>, fallback: f64) -> f64 {
    let number = js_number(value);
    if number == 0.0 || number.is_nan() { fallback } else { number }
}

fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|number| number != 0.0 && !number.is_nan()),
        Some(Value::String(text)) => !text.is_empty(),
        Some(_) => true,
    }
}

/// A number as JavaScript prints it inside a template string.
fn print_number(value: f64) -> String {
    if value.is_finite() && value.fract() == 0.0 && value.abs() < 1e21 { format!("{}", value as i64) } else { format!("{value}") }
}

fn slice_of<'a>(state: &'a Value, key: &str) -> &'a [Value] {
    state.get(key).and_then(Value::as_array).map_or(&[], |list| &list[..list.len().min(REVISION_ENTRIES)])
}

fn pick(entry: &Value, fields: &[&str]) -> Value {
    Value::Array(fields.iter().map(|field| entry.get(*field).cloned().unwrap_or(Value::Null)).collect())
}

/// `agentRevision`: a cheap change-detection key over the agent worker and job slices.
pub fn agent_revision(state: &Value) -> String {
    let workers: Vec<Value> = slice_of(state, "agentWorkers").iter().map(|worker| pick(worker, &["tag", "status", "stage", "sessionId"])).collect();
    let jobs: Vec<Value> =
        slice_of(state, "agentJobs").iter().map(|job| pick(job, &["task_id", "status", "tag", "sessionId", "startedAt", "finishedAt", "error"])).collect();
    // The members are written in the order the key has always had them: a map would sort them.
    format!("{{\"workers\":{},\"jobs\":{}}}", Value::Array(workers), Value::Array(jobs))
}

/// Pending calls per signature slot for one unresolved tool card: an aggregate card carries a `categories` map, a standalone
/// card resolves its name and arguments.
fn pending_category_hits(item: &Value, count: f64) -> [f64; 3] {
    let mut hits = [0.0; 3];
    let mut add = |category: Option<&str>, calls: f64| {
        if let Some(slot) = category.and_then(|category| SIGNATURE_CATEGORIES.iter().position(|known| *known == category)) {
            hits[slot] += calls;
        }
    };
    let categories = item.get("categories").filter(|categories| categories.is_object() || categories.is_array());
    if let (true, Some(categories)) = (truthy(item.get("aggregate")), categories) {
        let entries: Vec<&Value> = match categories {
            Value::Object(map) => map.values().collect(),
            Value::Array(list) => list.iter().collect(),
            _ => Vec::new(),
        };
        for value in entries {
            let entry = value.as_object().map(|_| value);
            add(entry.and_then(|entry| entry.get("category")).and_then(Value::as_str), number_or(entry.and_then(|entry| entry.get("count")), 1.0).max(1.0));
        }
    } else if truthy(item.get("name")) {
        let name = item.get("name").and_then(Value::as_str).unwrap_or("");
        let args = item.get("args").filter(|args| truthy(Some(*args))).cloned().unwrap_or_else(|| json!({}));
        add(Some(classify_tool_category(name, &args).as_str()), count);
    }
    hits
}

/// `activeToolsSignature`: `count:startedAt` for shell, web search and agent joined with colons, or empty when no tool card is
/// pending. The engine publishes it incrementally (`activeToolSummary`) so the store need not scan every item per change; the
/// scan of the transcript tool cards is the fallback when it did not.
pub fn active_tools_signature(state: &Value) -> String {
    if let Some(summary) = state.get("activeToolSummary") {
        return match summary {
            Value::String(text) => text.clone(),
            value if truthy(Some(value)) => value.to_string(),
            _ => String::new(),
        };
    }
    let mut counts = [0.0_f64; 3];
    let mut starts = [0.0_f64; 3];
    for item in state.get("items").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]) {
        if item.get("kind").and_then(Value::as_str) != Some("tool") {
            continue;
        }
        let count = number_or(item.get("count"), 1.0).max(1.0);
        // An aggregate stays on the pure completed-count test: the engine sets `result` on every aggregate patch, even a partial
        // one. A standalone card is also done when a result landed, so a card that ended abnormally without bumping the count
        // cannot pin a phantom segment.
        let done = if truthy(item.get("aggregate")) {
            number_or(item.get("completedCount"), 0.0)
        } else {
            let fallback_done = if item.get("result").is_none_or(Value::is_null) { 0.0 } else { count };
            number_or(item.get("completedCount"), fallback_done).min(count).max(0.0)
        };
        if done >= count {
            continue;
        }
        let started = number_or(item.get("startedAt"), 0.0);
        for (slot, hits) in pending_category_hits(item, count).into_iter().enumerate() {
            if hits <= 0.0 {
                continue;
            }
            counts[slot] += hits;
            if started > 0.0 && (starts[slot] == 0.0 || started < starts[slot]) {
                starts[slot] = started;
            }
        }
    }
    if counts.iter().all(|total| *total == 0.0) {
        return String::new();
    }
    counts.iter().zip(starts).map(|(total, start)| format!("{}:{}", print_number(*total), print_number(start))).collect::<Vec<_>>().join(":")
}

/// `activeTools`: the segments of a signature; `None` for an empty one.
pub fn active_tools(signature: &str) -> Option<ActiveTools> {
    if signature.is_empty() {
        return None;
    }
    let numbers: Vec<f64> = signature
        .split(':')
        .take(6)
        .map(|part| {
            let number = js_number(Some(&Value::String(part.to_owned())));
            if number.is_nan() { 0.0 } else { number }
        })
        .collect();
    let at = |index: usize| numbers.get(index).copied().unwrap_or(0.0);
    let segment = |count: f64, started_at: f64| (count != 0.0).then_some(ActiveTool { count, started_at });
    Some(ActiveTools { shell: segment(at(0), at(1)), web_search: segment(at(2), at(3)), agent: segment(at(4), at(5)) })
}

/// `statuslineStats`: the primitive projection of the stats the statusline reads, with a missing field as its default.
pub fn statusline_stats(state: &Value) -> Value {
    let stats = state.get("stats");
    let mut projected = Map::new();
    for (field, default) in STATS_FIELDS {
        let value = stats.and_then(|stats| stats.get(field)).filter(|value| !value.is_null());
        projected.insert(field.to_owned(), value.cloned().unwrap_or_else(|| default.map_or(Value::Null, |default| json!(default))));
    }
    Value::Object(projected)
}
