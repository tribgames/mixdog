//! The session side of `recordModelSwitchBoundary` (`model-route/set-route.mjs`): the
//! boundary of an in-place model switch goes on the switch anchor message
//! (`modelSwitchAnchorIndex` over the model conversation), once. Node appends it to the
//! anchor's `meta.modelSwitches`; here it is a display-only `model_switch` record naming the
//! stored anchor row (option (a)), which the transcript folds onto that row on restore and
//! shows live after it.

use mixdog_core_api::CoreError;
use mixdog_core_api::Reply;
use mixdog_core_api::ThreadHandle as _;
use mixdog_core_api::call::CallContext;
use mixdog_core_api::call::CoreRequest;
use mixdog_core_api::ids::Method;
use mixdog_core_api::ids::ThreadId;
use mixdog_store::schema::blob::Slot;
use mixdog_store::schema::record::ModelSwitchEntry;
use serde_json::Value;
use serde_json::json;

use super::SessionDirectory;
use super::seams::Shown;
use super::transcript::live_model_switch;
use crate::ports::route::model_switch_anchor_index;

/// Records `boundary` (`{provider, modelId, at}`) on the thread's switch anchor. `false` when
/// there is no stored message to mark; `true` also when the anchor already holds the same
/// switch (same time and model).
pub async fn record_model_switch(directory: &SessionDirectory, thread: &ThreadId, boundary: &Value) -> Result<bool, CoreError> {
    let entry: ModelSwitchEntry = serde_json::from_value(boundary.clone()).map_err(|_| CoreError::InvalidParams {
        path: "boundary".into(),
        expected: "{provider, modelId, at}".into(),
    })?;
    let context = directory.model_context(thread).read().await?;
    let messages: Vec<Value> = context.iter().map(|(_, message)| message.clone()).collect();
    let Some(index) = model_switch_anchor_index(&messages) else {
        return Ok(false);
    };
    let iid = context[index].0.as_str().to_owned();
    // `same`: the anchor as read carries its recorded boundaries in `meta.modelSwitches`.
    let same = |body: &Value| {
        body.pointer("/meta/modelSwitches").and_then(Value::as_array).is_some_and(|switches| {
            switches.iter().any(|s| s.get("at") == Some(&json!(entry.at)) && s.get("modelId") == Some(&json!(entry.model_id)))
        })
    };
    let (ordinal, turn, item) = match directory.history_row(thread, &iid).await? {
        Some((ordinal, anchor)) => {
            if matches!(&anchor.body, Slot::Inline(body) if same(body)) {
                return Ok(true);
            }
            let item = match live_model_switch(&anchor, &entry) {
                Some(Shown::Item(item)) => Some(item),
                _ => None,
            };
            (ordinal, anchor.turn.map(|t| t.as_str().to_owned()), item)
        }
        // The anchor is a compaction's replacement entry (the summary): it has no history row,
        // and its boundaries show on the compaction's divider.
        None => {
            let Some(compaction) = directory.compaction_entry(thread, &iid).await? else {
                return Ok(false);
            };
            if same(&messages[index]) {
                return Ok(true);
            }
            (compaction.ordinal, None, None)
        }
    };
    let ctx = CallContext::internal("route");
    let handle = directory.open_handle(thread, &ctx).await?;
    let params = json!({
        "threadId": thread,
        "anchor": { "iid": iid, "ordinal": ordinal },
        "entry": entry,
        "turn": turn,
        "item": item,
    });
    match handle.request(CoreRequest { method: Method("thread/boundary/record"), params, op: None, ctx }).await? {
        Reply::Value(_) => Ok(true),
        Reply::Subscribe(_) => Err(CoreError::Internal { incident_id: "session-boundary-subscribed".into() }),
    }
}
