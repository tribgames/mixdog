//! Stateless continuation of a Responses conversation. The provider state is
//! a JSON slot the agent persists between turns (`providerState[state_key]`);
//! it records which messages the previous request already covered and the
//! encrypted reasoning of earlier responses. [`resume`] reads it into what the
//! next request needs, [`next_slot`] writes the slot after a response. The
//! slot's field names are the persisted shape and do not change.

use std::collections::BTreeMap;

use mixdog_core_api::domain::provider::Message;
use mixdog_core_api::domain::provider::Role;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

/// What differs between routes sharing the wire.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct ContinuationSpec {
    /// The key of this route's slot in the provider state.
    pub state_key: String,
    /// Tag history entries with the replay owner (otherwise untagged).
    pub tag_history_owner: bool,
    /// The route serves no server-side state: imported state naming a
    /// previous response or `store: true` is refused. The label names the
    /// route in the error.
    pub stateless_only: Option<String>,
    /// An extra `key: value` the slot records (the transport of the turn).
    pub marker: Option<(String, String)>,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ResetReason {
    ModelChanged,
    MissingSeenMessageCount,
    SeenMessageCountOutOfRange,
}

impl ResetReason {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ModelChanged => "model_changed",
            Self::MissingSeenMessageCount => "missing_seen_message_count",
            Self::SeenMessageCountOutOfRange => "seen_message_count_out_of_range",
        }
    }
}

/// Imported server-side state on a route that serves none.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct StatelessOnly {
    pub route: String,
}

impl std::fmt::Display for StatelessOnly {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{} Responses is stateless: imported previous_response_id / store:true continuation state is not supported",
            self.route
        )
    }
}

impl std::error::Error for StatelessOnly {}

/// What the next request resumes from.
#[derive(Clone, PartialEq, Debug, Default)]
pub struct Continuation {
    pub previous_response_id: Option<String>,
    /// First message the request still has to send.
    pub start_index: usize,
    pub reset_reason: Option<ResetReason>,
    /// Same-owner encrypted reasoning by message index.
    pub reasoning_by_index: BTreeMap<usize, Vec<Value>>,
}

fn integer(value: &Value) -> Option<i64> {
    value.as_i64().or_else(|| {
        value
            .as_f64()
            .filter(|n| n.fract() == 0.0 && n.abs() < 9e15)
            .map(|n| n as i64)
    })
}

/// The slot's reasoning history as `(message index, items)`, owner-filtered.
fn history(slot: &Value, seen: Option<i64>, replay_owner: &str) -> BTreeMap<usize, Vec<Value>> {
    let entries: Vec<Value> = match slot.get("encryptedReasoningHistory") {
        Some(Value::Array(entries)) => entries.clone(),
        _ => match slot.get("encryptedReasoningItems") {
            Some(items @ Value::Array(_)) => {
                let mut entry = Map::new();
                entry.insert("messageIndex".into(), json!(seen.unwrap_or(0)));
                entry.insert("items".into(), items.clone());
                if let Some(owner) = slot.get("owner") {
                    entry.insert("owner".into(), owner.clone());
                }
                vec![Value::Object(entry)]
            }
            _ => Vec::new(),
        },
    };
    let mut by_index: BTreeMap<usize, Vec<Value>> = BTreeMap::new();
    for entry in entries {
        let Some(index) = entry.get("messageIndex").and_then(integer).and_then(|i| usize::try_from(i).ok()) else {
            continue;
        };
        let Some(items) = entry.get("items").and_then(Value::as_array) else {
            continue;
        };
        // Owner-tagged reasoning never replays under another owner.
        if let Some(owner) = entry.get("owner")
            && owner.as_str() != Some(replay_owner)
        {
            continue;
        }
        by_index.entry(index).or_default().extend(items.iter().cloned());
    }
    by_index
}

/// Reads the route's slot against the transcript about to be sent. A slot that
/// no longer fits (another model, a message count the transcript cannot
/// match) is dropped, and the whole transcript goes out again.
pub fn resume(
    spec: &ContinuationSpec,
    replay_owner: &str,
    slot: Option<&Value>,
    model: &str,
    messages: &[Message],
) -> Result<Continuation, StatelessOnly> {
    let Some(slot) = slot.filter(|s| !s.is_null()) else {
        return Ok(Continuation::default());
    };
    let mut previous = slot
        .get("previousResponseId")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .map(str::to_owned);
    let mut stateless = slot.get("store") == Some(&json!(false));
    if let Some(route) = &spec.stateless_only
        && (previous.is_some() || slot.get("store") == Some(&json!(true)))
    {
        return Err(StatelessOnly { route: route.clone() });
    }
    let mut reset_reason = None;
    let state_model = slot.get("model").and_then(Value::as_str).unwrap_or("");
    if (previous.is_some() || stateless) && !model.is_empty() && !state_model.is_empty() && state_model != model {
        previous = None;
        stateless = false;
        reset_reason = Some(ResetReason::ModelChanged);
    }
    let seen = slot.get("seenMessageCount").and_then(integer);
    if (previous.is_some() || stateless)
        && !seen.is_some_and(|s| s >= 0 && usize::try_from(s).is_ok_and(|s| s <= messages.len()))
    {
        previous = None;
        stateless = false;
        reset_reason = Some(if seen.is_none() {
            ResetReason::MissingSeenMessageCount
        } else {
            ResetReason::SeenMessageCountOutOfRange
        });
    }
    let mut start_index = 0;
    if previous.is_some() {
        start_index = seen.and_then(|s| usize::try_from(s).ok()).unwrap_or(0).min(messages.len());
        if messages.get(start_index).is_some_and(|m| m.role == Role::Assistant) {
            start_index += 1;
        }
    }
    Ok(Continuation {
        previous_response_id: previous,
        start_index,
        reset_reason,
        reasoning_by_index: if stateless { history(slot, seen, replay_owner) } else { BTreeMap::new() },
    })
}

/// A finished response, as far as the slot is concerned.
pub struct TurnResult<'a> {
    pub response_id: Option<&'a str>,
    /// The response's output items in order.
    pub output: &'a [Value],
    /// The requested model id, not an alias the server answered with.
    pub model: &'a str,
    /// Messages the request covered (the response's own index).
    pub message_count: usize,
    pub updated_at_ms: u64,
}

/// Output reasoning items that carry encrypted content.
pub fn encrypted_reasoning_items(output: &[Value]) -> Vec<Value> {
    output
        .iter()
        .filter(|item| {
            item.get("type").and_then(Value::as_str) == Some("reasoning")
                && item
                    .get("encrypted_content")
                    .and_then(Value::as_str)
                    .is_some_and(|e| !e.is_empty())
        })
        .cloned()
        .collect()
}

/// The route's slot after `turn`: earlier history carried forward, this
/// turn's encrypted reasoning appended at the turn's message index.
pub fn next_slot(spec: &ContinuationSpec, replay_owner: &str, prior: Option<&Value>, turn: &TurnResult<'_>) -> Value {
    let items = encrypted_reasoning_items(turn.output);
    let mut history: Vec<Value> = prior
        .and_then(|slot| slot.get("encryptedReasoningHistory"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if !items.is_empty() {
        let mut entry = Map::new();
        entry.insert("messageIndex".into(), json!(turn.message_count));
        entry.insert("items".into(), Value::Array(items.clone()));
        if spec.tag_history_owner {
            entry.insert("owner".into(), json!(replay_owner));
        }
        history.push(Value::Object(entry));
    }
    let mut slot = Map::new();
    slot.insert("previousResponseId".into(), Value::Null);
    slot.insert("responseId".into(), turn.response_id.map_or(Value::Null, |id| json!(id)));
    slot.insert("store".into(), json!(false));
    if spec.tag_history_owner {
        slot.insert("owner".into(), json!(replay_owner));
    }
    slot.insert("encryptedReasoningItems".into(), Value::Array(items));
    slot.insert("encryptedReasoningHistory".into(), Value::Array(history));
    slot.insert("seenMessageCount".into(), json!(turn.message_count));
    slot.insert("model".into(), json!(turn.model));
    slot.insert("updatedAt".into(), json!(turn.updated_at_ms));
    if let Some((key, value)) = &spec.marker {
        slot.insert(key.clone(), json!(value));
    }
    Value::Object(slot)
}

/// `provider_state` with the route's slot replaced.
pub fn with_slot(provider_state: Option<&Value>, spec: &ContinuationSpec, slot: Value) -> Value {
    let mut state = provider_state.and_then(Value::as_object).cloned().unwrap_or_default();
    state.insert(spec.state_key.clone(), slot);
    Value::Object(state)
}
