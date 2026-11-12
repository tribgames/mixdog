//! The archived result of a reaped agent child: the migration keeps it in each parent that carries a completion
//! notification of it, under the parent header's `archivedAgentResults[<child id>]` (`mixdog-migrate`
//! `session::archived`). Reading picks among the parents as `readArchivedAgentResult` does and answers its view.

use serde_json::Map;
use serde_json::Value;
use serde_json::json;

/// The parent header key.
pub const HEADER_KEY: &str = "archivedAgentResults";

/// The header key of a session the migration keeps only to host a worker index row whose session record is gone (Node lists
/// such a row with a null header): the row is listed, but no thread opens over it.
pub const WORKER_ROW_ONLY_KEY: &str = "workerRowOnly";

/// The entry `child` has in a parent header, if any.
pub fn entry<'a>(header: &'a Map<String, Value>, child: &str) -> Option<&'a Value> {
    header.get(HEADER_KEY)?.get(child)
}

/// The children a parent header carries a result of.
pub fn children(header: &Map<String, Value>) -> Vec<String> {
    header.get(HEADER_KEY).and_then(Value::as_object).map(|m| m.keys().cloned().collect()).unwrap_or_default()
}

/// `readArchivedAgentResult`: over the child's parents in their order, the newest entry wins and a later parent wins
/// a tie (`best.at > at` alone keeps the earlier); `None` when no parent carries one.
pub fn view(child: &str, entries: &[&Value]) -> Option<Value> {
    let mut ranked: Vec<&Value> = entries.to_vec();
    ranked.sort_by_key(|e| e["rank"].as_u64().unwrap_or_default());
    let mut best: Option<&Value> = None;
    for e in ranked {
        let at = e["at"].as_f64().unwrap_or_default();
        if best.is_some_and(|b| b["at"].as_f64().unwrap_or_default() > at) {
            continue;
        }
        best = Some(e);
    }
    let best = best?;
    let text = |k: &str| best[k].as_str().unwrap_or_default().to_owned();
    let mut item = Map::new();
    item.insert("id".into(), json!(format!("archived-agent-result:{child}")));
    item.insert("kind".into(), json!("assistant"));
    item.insert("text".into(), json!(format!("# Archived agent result\n\n{}", text("body"))));
    item.insert("status".into(), best["status"].clone());
    if best["at"].as_f64().is_some_and(|at| at != 0.0) {
        item.insert("at".into(), best["at"].clone());
    }
    for key in ["model", "provider", "agent"] {
        if !text(key).is_empty() {
            item.insert(key.into(), json!(text(key)));
        }
    }
    Some(json!({
        "sessionId": child,
        "items": [item],
        "provider": text("provider"),
        "model": text("model"),
        "effort": text("effort"),
        "fast": best["fast"].as_bool().unwrap_or(false),
        "cwd": text("cwd"),
        "desktopSession": best["desktopSession"].clone(),
        "workflow": null,
        "stats": { "currentContextTokens": 0, "currentEstimatedContextTokens": 0, "currentContextSource": null },
        "contextWindow": null,
        "rawContextWindow": null,
        "displayContextWindow": null,
        "autoCompactTokenLimit": null,
        "archivedAgentResult": true,
        "readOnlyDetachedAgent": false,
    }))
}
