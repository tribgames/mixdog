//! The compaction divider row of the display history: the constant label Node shows
//! (`COMPACTION_DIVIDER_LABEL`) with the compaction's own time and no stats.

use mixdog_protocol::ThreadItem;
use serde_json::Value;
use serde_json::json;

use super::transcript_convert::Ctx;
use super::transcript_convert::item_of;
use super::transcript_rows::Row;

/// The one label every compaction boundary row carries (`compaction-archive.mjs`).
pub const DIVIDER_LABEL: &str = "Conversation compacted";

/// The divider of compaction `cid`. `at` is the `compacted` record's `at`: a record written
/// before it existed has none, and its row then has no `at` either (Node sets `at` only
/// when the time is finite).
pub fn divider_item(cid: &str, at: Option<i64>) -> ThreadItem {
    let mut row = Row::new();
    row.insert("id".into(), json!(format!("divider:{cid}")));
    row.insert("kind".into(), json!("statusdone"));
    row.insert("label".into(), json!(DIVIDER_LABEL));
    row.insert("status".into(), json!("compacted"));
    if let Some(at) = at {
        row.insert("at".into(), Value::from(at));
    }
    item_of(row, &Ctx { turn: None, message: None, counts_prompt: false, source: None })
}

#[cfg(test)]
mod tests {
    use mixdog_protocol::ThreadItem;

    use super::*;

    #[test]
    fn divider_has_the_constant_label_and_only_a_known_time() {
        for at in [Some(1_793_464_852_009), None] {
            let ThreadItem::ContextCompaction { meta, summary, .. } = divider_item("k1", at) else {
                panic!("a divider is a context compaction item");
            };
            assert_eq!(summary, None);
            assert_eq!(meta.label.as_deref(), Some(DIVIDER_LABEL));
            assert_eq!(meta.at, at);
            assert_eq!(meta.detail, None);
        }
    }
}
