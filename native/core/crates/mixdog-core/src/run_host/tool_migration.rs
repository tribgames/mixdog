//! What a tool-surface migration invalidates (Node `session/loop/tool-exposure-migration.mjs`:
//! `invalidateForToolSurfaceMigration`, `markToolSurfaceMigrated`, `hasUnansweredToolCalls`).
//!
//! The surface itself is rebuilt by `route_surface` / `tool_surface`; this is what a
//! changed request prefix invalidates besides: provider state, the prefix guard, the context
//! baseline and the cache-break tag. Historical tool calls are never rewritten.

use mixdog_agent::compact::pressure::invalidate_provider_context_baseline;
use mixdog_agent::env::Clock;
use mixdog_store::schema::record::HeaderChange;
use serde_json::{json, Map, Value};

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
    let mut change = HeaderChange { set: Map::new(), unset: Vec::new() };
    unset(&mut change, "providerState");
    unset(&mut change, "_providerPrefixGuardState");
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

/// `markToolSurfaceMigrated(session, intent)`: after a surface re-apply outside a request (resume,
/// provider switch, a workflow switch) changed the request prefix, the first send of the next turn
/// carries the tag. The stored thinking was bound to the previous prefix and can never be replayed
/// again; an open tool round a stopped turn left behind is ended first. Outside a turn only
/// (`transcript` is `None` during one): a running turn sends from its own working transcript,
/// whose latest tool round must keep its thinking.
pub fn mark_tool_surface_migrated(clock: &dyn Clock, intent: Option<&str>, transcript: Option<&[Value]>) -> Migrated {
    let mut change = invalidate_for_tool_surface_migration(clock);
    set(&mut change, "pendingCacheBreakIntent", json!(intent.unwrap_or(TOOL_SURFACE_MIGRATION_INTENT)));
    let messages = transcript.map(rebind_to_changed_prefix).filter(|(_, changed)| *changed).map(|(rows, _)| rows);
    Migrated { change, messages }
}

/// `hasUnansweredToolCalls`: the latest assistant tool turn still waits for a result, which is not a
/// safe boundary to migrate at.
pub fn has_unanswered_tool_calls(messages: &[Value]) -> bool {
    let Some(index) = messages
        .iter()
        .rposition(|m| m.get("role").and_then(Value::as_str) == Some("assistant") && m.get("toolCalls").and_then(Value::as_array).is_some_and(|c| !c.is_empty()))
    else {
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
mod tests {
    use super::*;

    struct Fixed;
    impl Clock for Fixed {
        fn now_ms(&self) -> i64 {
            1_793_939_969_114
        }
    }

    fn golden() -> Value {
        serde_json::from_str(include_str!("golden/tool_migration.json")).expect("fixture")
    }

    fn header() -> Map<String, Value> {
        json!({
            "id": "s", "provider": "xai", "providerState": { "a": 1 }, "_providerPrefixGuardState": { "b": 1 },
            "contextPressureBaselineTokens": 5, "contextPressureBaselineSource": "usage",
            "contextPressureUnanchoredReason": "r", "lastContextTokensStaleAfterCompact": false,
        })
        .as_object()
        .unwrap()
        .clone()
    }

    fn transcript() -> Vec<Value> {
        let think = json!({ "type": "thinking", "thinking": "hm", "signature": "s" });
        vec![
            json!({ "role": "user", "content": "q" }),
            json!({ "role": "assistant", "content": "", "toolCalls": [{ "id": "c1", "name": "read", "arguments": {} }], "thinkingBlocks": [think] }),
            json!({ "role": "tool", "toolCallId": "c1", "content": "ok" }),
        ]
    }

    /// Node's `markToolSurfaceMigrated`: outside a turn, during one, and with another intent.
    #[test]
    fn marking_a_migration_follows_node() {
        let golden = golden();
        for (name, intent, rebind) in [("outside_turn", None, true), ("during_turn", None, false), ("custom_intent", Some("custom_intent"), true)] {
            let rows = transcript();
            let migrated = mark_tool_surface_migrated(&Fixed, intent, rebind.then_some(rows.as_slice()));
            let mut applied = header();
            for key in &migrated.change.unset {
                applied.shift_remove(key);
            }
            for (key, value) in &migrated.change.set {
                applied.insert(key.clone(), value.clone());
            }
            let want = &golden[name];
            // Node's golden folds an unset and a nulled field into one marker.
            let field = |key: &str| applied.get(key).filter(|v| !v.is_null()).cloned().unwrap_or_else(|| json!("__deleted__"));
            assert_eq!(field("providerState"), want["providerState"], "{name}");
            assert_eq!(field("_providerPrefixGuardState"), want["guard"], "{name}");
            assert_eq!(field("contextPressureBaselineTokens"), want["baselineTokens"], "{name}");
            assert_eq!(field("contextPressureBaselineSource"), want["baselineSource"], "{name}");
            assert_eq!(field("contextPressureUnanchoredReason"), want["unanchored"], "{name}");
            assert_eq!(applied["lastContextTokensStaleAfterCompact"], want["stale"], "{name}");
            assert_eq!(field("pendingCacheBreakIntent"), want["intent"], "{name}");
            assert_eq!(want["updatedAtIsNumber"], true);
            let messages = migrated.messages.unwrap_or(rows);
            assert_eq!(json!(messages), want["messages"], "{name} messages");
        }
    }

    #[test]
    fn an_unanswered_tool_call_is_not_a_boundary() {
        let cases = golden()["unansweredCases"].clone();
        assert!(has_unanswered_tool_calls(cases["open"].as_array().unwrap()));
        for name in ["answered", "none", "notool", "empty"] {
            assert!(!has_unanswered_tool_calls(cases[name].as_array().unwrap()), "{name}");
        }
    }
}
