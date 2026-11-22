//! The live-only rows a turn shows besides its records (Node's TUI pushes them into its items;
//! a restore shows none of them). A notice is not one of them: the transcript keeps it (`SessionActor::notice`).

use mixdog_protocol::ThreadItem;
use serde_json::json;

use super::transcript_convert::Ctx;
use super::transcript_convert::item_of;
use super::transcript_rows::Row;

fn live_item(row: Row, turn: &str) -> ThreadItem {
    item_of(row, &Ctx { turn: Some(turn), message: None, counts_prompt: false, source: None })
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
