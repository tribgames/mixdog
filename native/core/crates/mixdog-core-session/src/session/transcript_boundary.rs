//! A display-only model-switch boundary, projected onto the item it anchors (Node's
//! `recordTranscriptBoundary(session, 'modelSwitches', …)` in `set-route.mjs`): the boundary is
//! kept in the anchor message's `meta.modelSwitches`, and the transcript shows it as a
//! "Model switched" row right after that message, live and after a restore.
//!
//! The store keeps the boundary as its own record naming the anchor item; a reader folds it
//! into the anchor's body with [`with_model_switch`] before the body is projected, so a restore
//! shows the row where Node shows it. The live path shows the same row, with the same id, by
//! [`model_switch_item`] when the boundary record commits.

use mixdog_protocol::ThreadItem;
use mixdog_store::schema::blob::Slot;
use mixdog_store::schema::record::Form;
use mixdog_store::schema::record::ItemRecord;
use mixdog_store::schema::record::ModelSwitchEntry;
use serde_json::Value;
use serde_json::json;

use super::transcript_convert::Ctx;
use super::transcript_convert::item_of;
use super::transcript_convert::message_items;
use super::transcript_rows::model_switch_id;
use super::transcript_rows::model_switch_row;
use crate::session::seams::Shown;

/// The anchor message with `entry` appended to its `meta.modelSwitches`; `None` when the
/// anchor already holds that switch (same time and model: the boundary is recorded once).
pub(super) fn with_model_switch(anchor: &Value, entry: &Value) -> Option<Value> {
    let switches = anchor.pointer("/meta/modelSwitches").and_then(Value::as_array).cloned().unwrap_or_default();
    if switches.iter().any(|s| s.get("at") == entry.get("at") && s.get("modelId") == entry.get("modelId")) {
        return None;
    }
    let mut folded = anchor.clone();
    let object = folded.as_object_mut()?;
    let meta = object.entry("meta").or_insert_with(|| json!({}));
    let meta = meta.as_object_mut()?;
    let mut switches = switches;
    switches.push(entry.clone());
    meta.insert("modelSwitches".into(), Value::Array(switches));
    Some(folded)
}

/// The anchor row as a reader shows it: its message body with the row's `model_switches`
/// (`HistoryRow.model_switches`, record order) folded into `meta.modelSwitches`, so projecting
/// it gives the rows Node restores. Only a model message carries them; the body must be inline
/// (a reader resolves its slots first).
pub(in crate::session) fn fold_model_switches(record: &mut ItemRecord, switches: &[ModelSwitchEntry]) {
    if record.form != Form::Message {
        return;
    }
    let Slot::Inline(body) = &mut record.body else { return };
    for entry in switches {
        let Ok(entry) = serde_json::to_value(entry) else { continue };
        if let Some(folded) = with_model_switch(body, &entry) {
            *body = folded;
        }
    }
}

/// The live row of a boundary record committed on `anchor` (as a reader shows it, its recorded
/// boundaries folded in): the row its restore shows, history position included; nothing when the
/// anchor's own row is not a model message.
pub(in crate::session) fn live_model_switch(anchor: &ItemRecord, entry: &ModelSwitchEntry) -> Option<Shown> {
    if anchor.form != Form::Message {
        return None;
    }
    let entry = serde_json::to_value(entry).ok()?;
    let live = model_switch_item(anchor.iid.as_str(), anchor.turn.as_ref().map(|t| t.as_str()), &entry)?;
    let Slot::Inline(body) = &anchor.body else { return Some(live) };
    let folded = with_model_switch(body, &entry).unwrap_or_else(|| body.clone());
    let mut record = anchor.clone();
    record.body = Slot::Inline(folded.clone());
    let id = live_id(&live);
    // Two switches at one time on one anchor share the id: the boundary just folded in is the last of them.
    message_items(&record, &folded).into_iter().rfind(|shown| live_id(shown) == id).or(Some(live))
}

fn live_id(shown: &Shown) -> &str {
    match shown {
        Shown::Item(item) | Shown::Update(item) => item.id().as_str(),
    }
}

/// The anchor id of a boundary on a compaction's replacement entry (the summary, the context
/// ack): the entry has no history row, so its rows hang off the compaction's divider.
fn divider_anchor(cid: &str) -> String {
    format!("divider:{cid}")
}

/// The rows of the boundaries `Divider.model_switches` holds for compaction `cid`, shown right
/// after its divider. Node marks them on the summary (or the context ack) message, whose own
/// bubble is hidden, and shows the same "Model switched" row after it; a switch recorded twice
/// (same time and model) shows once.
pub(in crate::session) fn divider_model_switches(cid: &str, switches: &[ModelSwitchEntry]) -> Vec<ThreadItem> {
    let anchor = divider_anchor(cid);
    let mut seen: Vec<(i64, &str)> = Vec::new();
    let mut items = Vec::new();
    for entry in switches {
        if seen.contains(&(entry.at, entry.model_id.as_str())) {
            continue;
        }
        seen.push((entry.at, entry.model_id.as_str()));
        if let Some(Shown::Item(item)) = divider_switch_item(&anchor, entry) {
            items.push(item);
        }
    }
    items
}

/// The live row of a boundary committed on a replacement entry of compaction `cid`: the row
/// [`divider_model_switches`] shows after a restore, with its id.
pub(in crate::session) fn live_divider_model_switch(cid: &str, entry: &ModelSwitchEntry) -> Option<Shown> {
    divider_switch_item(&divider_anchor(cid), entry)
}

fn divider_switch_item(anchor: &str, entry: &ModelSwitchEntry) -> Option<Shown> {
    let entry = serde_json::to_value(entry).ok()?;
    model_switch_item(anchor, None, &entry)
}

/// The live row of a committed boundary on the item `anchor_iid`, with the id its restored row
/// carries. None when the boundary names no provider and model.
pub(super) fn model_switch_item(anchor_iid: &str, turn: Option<&str>, entry: &Value) -> Option<Shown> {
    let id = model_switch_id(anchor_iid, entry)?;
    let row = model_switch_row(id, entry)?;
    let ctx = Ctx { turn, message: None, counts_prompt: false, source: None };
    Some(Shown::Item(item_of(row, &ctx)))
}

#[cfg(test)]
mod tests {
    #![allow(clippy::disallowed_methods, reason = "test setup: reads the recorded fixture")]
    use mixdog_store::schema::blob::Slot;
    use mixdog_store::schema::record::ItemRecord;

    use super::*;
    use crate::session::transcript::transcript_convert::message_items;

    fn record(iid: &str, body: &Value) -> ItemRecord {
        let mut record: ItemRecord = serde_json::from_value(json!({
            "iid": iid, "form": "message", "model": true, "visible": true,
            "refs": [], "body": { "inline": {} },
        }))
        .expect("record shape");
        record.body = Slot::Inline(body.clone());
        record
    }

    fn id_of(shown: &Shown) -> &str {
        match shown {
            Shown::Item(item) | Shown::Update(item) => item.id().as_str(),
        }
    }

    #[test]
    fn the_live_row_and_the_restored_row_are_the_same_item() {
        let anchor = json!({ "role": "assistant", "content": "done" });
        let entry = json!({ "provider": "openai", "modelId": "next", "at": 200 });
        let folded = with_model_switch(&anchor, &entry).expect("a new switch");
        let restored = message_items(&record("a1", &folded), &folded);
        let stored: ModelSwitchEntry = serde_json::from_value(entry.clone()).expect("a stored entry");
        let live = live_model_switch(&record("a1", &anchor), &stored).expect("live row");
        assert_eq!(restored.len(), 2, "the reply, then the switch row");
        assert_eq!(restored[1], live);
        assert_eq!(id_of(&live), "a1:model:200");
    }

    #[test]
    fn a_switch_is_recorded_once_and_a_bare_boundary_shows_nothing() {
        let entry = json!({ "provider": "openai", "modelId": "next", "at": 200 });
        let folded = with_model_switch(&json!({ "role": "assistant", "content": "x" }), &entry).unwrap();
        assert!(with_model_switch(&folded, &entry).is_none());
        assert_eq!(folded["meta"]["modelSwitches"], json!([entry]));
        assert!(model_switch_item("a1", None, &json!({ "provider": "openai", "at": 1 })).is_none());
    }
}
