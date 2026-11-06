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

/// The live row of a boundary record committed on `anchor`, with the id its restored row
/// carries; nothing when the anchor's own row is not a model message.
pub(in crate::session) fn live_model_switch(anchor: &ItemRecord, entry: &ModelSwitchEntry) -> Option<Shown> {
    if anchor.form != Form::Message {
        return None;
    }
    let entry = serde_json::to_value(entry).ok()?;
    model_switch_item(anchor.iid.as_str(), anchor.turn.as_ref().map(|t| t.as_str()), &entry)
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

    use mixdog_protocol::ThreadItem;

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
        let live = model_switch_item("a1", None, &entry).expect("live row");
        assert_eq!(restored.len(), 2, "the reply, then the switch row");
        assert_eq!(restored[1], live);
        assert_eq!(id_of(&live), "a1:model:200");
    }

    /// Node's recorded folds (`record-model-switch.mjs`): the anchor message after the boundary
    /// is recorded, and the rows a restore shows for the session.
    #[test]
    fn the_fold_and_the_rows_equal_nodes() {
        use crate::session::transcript::transcript_rows::Restored;
        use crate::session::transcript::transcript_rows::restore;

        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/migration/model-switch/cases.json");
        let fixture: Value = serde_json::from_slice(&std::fs::read(path).expect("cases.json")).expect("json");
        for case in fixture["cases"].as_array().expect("cases") {
            let name = case["name"].as_str().unwrap_or("?");
            let mut messages = case["messages"].as_array().expect("messages").clone();
            if let Some(anchor) = case["anchor"].as_u64() {
                for boundary in case["boundaries"].as_array().expect("boundaries") {
                    if let Some(folded) = with_model_switch(&messages[anchor as usize], boundary) {
                        messages[anchor as usize] = folded;
                    }
                }
                assert_eq!(messages[anchor as usize], case["after"][anchor as usize], "{name}: anchor");
            }
            let mut rows = Vec::new();
            for (index, message) in messages.iter().enumerate() {
                for restored in restore(&record(&format!("m{index}"), message), message) {
                    if let Restored::Row { mut row, .. } = restored {
                        row.shift_remove("id");
                        rows.push(Value::Object(row));
                    }
                }
            }
            let want: Vec<Value> = case["rows"]
                .as_array()
                .expect("rows")
                .iter()
                .map(|row| {
                    let mut row = row.clone();
                    row.as_object_mut().expect("row").shift_remove("id");
                    row
                })
                .filter(|row| row["kind"] == "statusdone" || row["kind"] == "assistant")
                .collect();
            let got: Vec<Value> =
                rows.into_iter().filter(|row| row["kind"] == "statusdone" || row["kind"] == "assistant").collect();
            assert_eq!(got, want, "{name}: rows");
        }
    }

    /// A reader's path: the anchor row plus its stored entries (`HistoryRow.model_switches`)
    /// show Node's rows, and the live row for the last entry is the restored row's twin.
    #[test]
    fn a_stored_anchor_row_shows_nodes_switch_rows() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/migration/model-switch/cases.json");
        let fixture: Value = serde_json::from_slice(&std::fs::read(path).expect("cases.json")).expect("json");
        let mut checked = 0;
        for case in fixture["cases"].as_array().expect("cases") {
            let name = case["name"].as_str().unwrap_or("?");
            let Some(anchor) = case["anchor"].as_u64() else { continue };
            let boundaries = case["boundaries"].as_array().expect("boundaries");
            let entries: Vec<ModelSwitchEntry> =
                boundaries.iter().filter_map(|b| serde_json::from_value(b.clone()).ok()).collect();
            let body = case["messages"][anchor as usize].clone();
            let mut row = record("anchor", &body);
            fold_model_switches(&mut row, &entries);
            let Slot::Inline(folded) = &row.body else { panic!("inline") };
            // A stored entry always names its model (`ModelSwitchEntry`), so a model-less boundary
            // (Node keeps it in meta but shows no row) never reaches a reader: nothing folds.
            if entries.len() == boundaries.len() {
                assert_eq!(folded, &case["after"][anchor as usize], "{name}: folded body");
            } else {
                assert_eq!(folded, &body, "{name}: a boundary the store cannot hold folds nothing");
            }
            let shown = message_items(&row, folded);
            let switched = case["rows"].as_array().expect("rows").iter().filter(|r| r["status"] == "model-switched").count();
            let got = shown.iter().filter(|s| matches!(s, Shown::Item(ThreadItem::StatusRow { .. }))).count();
            assert_eq!(got, switched, "{name}: switch rows");
            if let Some(last) = entries.last() {
                let live = live_model_switch(&row, last).expect("live row");
                assert!(shown.contains(&live), "{name}: live row equals the restored one");
            }
            checked += 1;
        }
        assert!(checked >= 4);
    }

    /// A boundary on the compaction summary (or its context ack) shows Node's rows: the summary
    /// bubble stays hidden and the "Model switched" rows follow; live and restored rows agree.
    #[test]
    fn a_summary_anchor_shows_nodes_switch_rows_after_the_divider() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/migration/model-switch/cases.json");
        let fixture: Value = serde_json::from_slice(&std::fs::read(path).expect("cases.json")).expect("json");
        let mut checked = 0;
        for case in fixture["cases"].as_array().expect("cases") {
            let name = case["name"].as_str().unwrap_or("?");
            let anchor = case["anchor"].as_u64().expect("anchor") as usize;
            let source = case["messages"][anchor]["meta"]["source"].as_str().unwrap_or("");
            if !matches!(source, "compact-summary" | "context-ack") {
                continue;
            }
            let entries: Vec<ModelSwitchEntry> =
                case["boundaries"].as_array().expect("boundaries").iter().filter_map(|b| serde_json::from_value(b.clone()).ok()).collect();
            let shown = divider_model_switches("k1", &entries);
            let strip = |mut row: Value| {
                row.as_object_mut().expect("row").shift_remove("id");
                row
            };
            let want: Vec<Value> = case["rows"].as_array().expect("rows").iter().cloned().map(strip).collect();
            assert!(want.iter().all(|row| row["kind"] == "statusdone"), "{name}: the summary bubble is hidden");
            assert_eq!(shown.len(), want.len(), "{name}: switch rows");
            for (item, node) in shown.iter().zip(&want) {
                let ThreadItem::StatusRow { kind, meta, .. } = item else { panic!("{name}: a status row") };
                assert_eq!(kind, "statusdone");
                assert_eq!(meta.label, node["label"].as_str().map(str::to_owned), "{name}: label");
                assert_eq!(meta.ext.get("status"), node.get("status"), "{name}: status");
                assert_eq!(meta.provider.as_deref(), node["provider"].as_str(), "{name}: provider");
                assert_eq!(meta.model_id.as_deref(), node["modelId"].as_str(), "{name}: model");
                assert_eq!(meta.at, node["at"].as_i64(), "{name}: at");
            }
            if let Some(last) = entries.last() {
                let live = live_divider_model_switch("k1", last).expect("live row");
                assert!(shown.iter().any(|item| *live_item(&live) == *item), "{name}: live row equals the restored one");
            }
            checked += 1;
        }
        assert!(checked >= 3);
    }

    fn live_item(shown: &Shown) -> &ThreadItem {
        match shown {
            Shown::Item(item) | Shown::Update(item) => item,
        }
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
