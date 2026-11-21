//! The boundary of an in-place model switch goes on the switch anchor message, once, as a
//! display-only `model_switch` record naming the stored anchor row, which the transcript folds
//! onto that row on restore and shows live after it.

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
use super::transcript::live_divider_model_switch;
use super::transcript::live_model_switch;
use mixdog_core_ports::ports::route::model_switch_anchor_index;

enum Anchor {
    Settled(bool),
    At { ordinal: u64, turn: Option<String>, item: Option<mixdog_protocol::ThreadItem> },
}

async fn locate_anchor(directory: &SessionDirectory, thread: &ThreadId, iid: &str, message: &Value, entry: &ModelSwitchEntry) -> Result<Anchor, CoreError> {
    let same = |body: &Value| {
        body.pointer("/meta/modelSwitches")
            .and_then(Value::as_array)
            .is_some_and(|switches| switches.iter().any(|s| s.get("at") == Some(&json!(entry.at)) && s.get("modelId") == Some(&json!(entry.model_id))))
    };
    match directory.history_row(thread, iid).await? {
        Some((ordinal, anchor)) => {
            if matches!(&anchor.body, Slot::Inline(body) if same(body)) {
                return Ok(Anchor::Settled(true));
            }
            let item = match live_model_switch(&anchor, entry) {
                Some(Shown::Item(item)) => Some(item),
                _ => None,
            };
            Ok(Anchor::At { ordinal, turn: anchor.turn.map(|t| t.as_str().to_owned()), item })
        }
        None => {
            let Some(compaction) = directory.compaction_entry(thread, iid).await? else {
                return Ok(Anchor::Settled(false));
            };
            if same(message) {
                return Ok(Anchor::Settled(true));
            }
            let item = match live_divider_model_switch(&compaction.cid, entry) {
                Some(Shown::Item(item)) => Some(item),
                _ => None,
            };
            Ok(Anchor::At { ordinal: compaction.ordinal, turn: None, item })
        }
    }
}

/// Records `boundary` (`{provider, modelId, at}`) on the thread's switch anchor. `false` when
/// there is no stored message to mark; `true` also when the anchor already holds the same
/// switch (same time and model).
pub async fn record_model_switch(directory: &SessionDirectory, thread: &ThreadId, boundary: &Value) -> Result<bool, CoreError> {
    let entry: ModelSwitchEntry = serde_json::from_value(boundary.clone())
        .map_err(|_| CoreError::InvalidParams { path: "boundary".into(), expected: "{provider, modelId, at}".into() })?;
    let context = directory.model_context(thread).read().await?;
    let messages: Vec<Value> = context.iter().map(|(_, message)| message.clone()).collect();
    let Some(index) = model_switch_anchor_index(&messages) else {
        return Ok(false);
    };
    let iid = context[index].0.as_str().to_owned();
    let (ordinal, turn, item) = match locate_anchor(directory, thread, &iid, &messages[index], &entry).await? {
        Anchor::Settled(recorded) => return Ok(recorded),
        Anchor::At { ordinal, turn, item } => (ordinal, turn, item),
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
