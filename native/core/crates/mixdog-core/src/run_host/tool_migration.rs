use mixdog_agent::compact::pressure::invalidate_provider_context_baseline;
use mixdog_agent::env::Clock;
use mixdog_store::schema::record::HeaderChange;
use serde_json::{Map, Value, json};

use super::thinking_binding::rebind_to_changed_prefix;
use super::tool_exposure::TOOL_SURFACE_MIGRATION_INTENT;

fn set(change: &mut HeaderChange, key: &str, value: Value) {
    change.unset.retain(|k| k != key);
    change.set.insert(key.to_owned(), value);
}

fn unset(change: &mut HeaderChange, key: &str) {
    change.set.shift_remove(key);
    if !change.unset.iter().any(|k| k == key) {
        change.unset.push(key.to_owned());
    }
}

/// `invalidateForToolSurfaceMigration`: everything measured against the previous tool surface.
pub fn invalidate_for_tool_surface_migration(clock: &dyn Clock) -> HeaderChange {
    let mut change = HeaderChange { set: Map::new(), unset: Vec::new(), patch: Default::default() };
    unset(&mut change, "providerState");
    let baseline = invalidate_provider_context_baseline();
    for (key, value) in baseline.set {
        set(&mut change, &key, value);
    }
    for key in baseline.unset {
        unset(&mut change, &key);
    }
    set(&mut change, "updatedAt", json!(clock.now_ms()));
    change
}

/// A session whose surface was re-applied outside a request: its header change, and the rebound
/// transcript when there is one to rebind.
pub struct Migrated {
    pub change: HeaderChange,
    /// The transcript with the stored thinking stripped (an open tool round ended first), `None`
    /// when it is left as it is.
    pub messages: Option<Vec<Value>>,
}

pub fn mark_tool_surface_migrated(clock: &dyn Clock, intent: Option<&str>, transcript: Option<&[Value]>) -> Migrated {
    let mut change = invalidate_for_tool_surface_migration(clock);
    set(&mut change, "pendingCacheBreakIntent", json!(intent.unwrap_or(TOOL_SURFACE_MIGRATION_INTENT)));
    let messages = transcript.map(rebind_to_changed_prefix).filter(|(_, changed)| *changed).map(|(rows, _)| rows);
    Migrated { change, messages }
}

/// `hasUnansweredToolCalls`: the latest assistant tool turn still waits for a result, which is not a
/// safe boundary to migrate at.
pub fn has_unanswered_tool_calls(messages: &[Value]) -> bool {
    let Some(index) = messages.iter().rposition(|m| {
        m.get("role").and_then(Value::as_str) == Some("assistant") && m.get("toolCalls").and_then(Value::as_array).is_some_and(|c| !c.is_empty())
    }) else {
        return false;
    };
    let answered: Vec<&str> = messages[index + 1..]
        .iter()
        .filter(|m| m.get("role").and_then(Value::as_str) == Some("tool"))
        .filter_map(|m| m.get("toolCallId").and_then(Value::as_str))
        .collect();
    messages[index]["toolCalls"]
        .as_array()
        .into_iter()
        .flatten()
        .any(|call| call.get("id").and_then(Value::as_str).filter(|id| !id.is_empty()).is_some_and(|id| !answered.contains(&id)))
}

#[cfg(test)]
mod tests {}
