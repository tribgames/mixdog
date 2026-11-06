//! The live-only rows a turn shows besides its records (Node's TUI pushes them into its items;
//! a restore shows none of them).

use mixdog_protocol::ThreadItem;
use serde_json::json;

use super::transcript_convert::Ctx;
use super::transcript_convert::item_of;
use super::transcript_rows::Row;

fn live_item(row: Row, turn: &str) -> ThreadItem {
    item_of(row, &Ctx { turn: Some(turn), message: None, counts_prompt: false, source: None })
}

/// A transcript notice (`pushNotice(text, tone, {transcript: true})`): `{kind: 'notice', id,
/// text, tone}`; `text` is already polished.
pub fn notice_item(id: &str, turn: &str, text: &str, tone: &str) -> ThreadItem {
    let mut row = Row::new();
    row.insert("kind".into(), json!("notice"));
    row.insert("id".into(), json!(id));
    row.insert("text".into(), json!(text));
    row.insert("tone".into(), json!(tone));
    live_item(row, turn)
}

/// [`notice_item`] shown outside any turn (`pushLiveSessionNotice`): the row has no turn.
pub fn idle_notice_item(id: &str, text: &str, tone: &str) -> ThreadItem {
    let mut row = Row::new();
    row.insert("kind".into(), json!("notice"));
    row.insert("id".into(), json!(id));
    row.insert("text".into(), json!(text));
    row.insert("tone".into(), json!(tone));
    item_of(row, &Ctx { turn: None, message: None, counts_prompt: false, source: None })
}

/// The compact marker (`applyCompactEvent`'s `doneItem`): `{kind: 'statusdone', id, label,
/// detail}`.
pub fn compact_marker_item(id: &str, turn: &str, label: &str, detail: &str) -> ThreadItem {
    let mut row = Row::new();
    row.insert("kind".into(), json!("statusdone"));
    row.insert("id".into(), json!(id));
    row.insert("label".into(), json!(label));
    row.insert("detail".into(), json!(detail));
    live_item(row, turn)
}
