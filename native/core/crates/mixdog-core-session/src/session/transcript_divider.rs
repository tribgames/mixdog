//! The compaction divider row of the display history: the constant label Node shows
//! (`COMPACTION_DIVIDER_LABEL`) with the compaction's own time and no stats.

use mixdog_protocol::ThreadItem;
use mixdog_store::schema::record::ModelSwitchEntry;
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
    row.insert("id".into(), json!(format!("{DIVIDER_ID}{cid}")));
    row.insert("kind".into(), json!("statusdone"));
    row.insert("label".into(), json!(DIVIDER_LABEL));
    row.insert("status".into(), json!("compacted"));
    if let Some(at) = at {
        row.insert("at".into(), Value::from(at));
    }
    item_of(row, &Ctx { turn: None, message: None, counts_prompt: false, source: None })
}

/// What begins the id of a divider's item, before its compaction's `cid`.
const DIVIDER_ID: &str = "divider:";

/// The compaction a divider's item id names.
pub fn divider_cid(id: &str) -> Option<&str> {
    id.strip_prefix(DIVIDER_ID).filter(|cid| !cid.is_empty())
}

/// The items of one compaction boundary, in order: its divider, then the model switches anchored on its replacement.
/// They are one occurrence of the transcript, at the compaction's own record.
pub fn boundary_items(cid: &str, at: Option<i64>, switches: &[ModelSwitchEntry]) -> Vec<ThreadItem> {
    std::iter::once(divider_item(cid, at)).chain(super::transcript_boundary::divider_model_switches(cid, switches)).collect()
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

    /// A boundary is its divider, with no detail, then the switches on its replacement, under ids that begin with the
    /// divider's.
    #[test]
    fn a_boundary_is_its_divider_then_its_switches() {
        let switch = ModelSwitchEntry { provider: "p".into(), model_id: "m".into(), at: 7 };
        let items = boundary_items("k1", Some(5), std::slice::from_ref(&switch));
        assert_eq!(items.len(), 2);
        let ThreadItem::ContextCompaction { id, meta, .. } = &items[0] else { panic!("the divider first") };
        assert_eq!((id.as_str(), meta.detail.as_deref(), meta.at), ("divider:k1", None, Some(5)));
        assert_eq!(divider_cid(id.as_str()), Some("k1"));
        assert!(items.iter().all(|item| item.id().as_str().starts_with("divider:k1")));
        assert_eq!(boundary_items("k1", Some(5), &[]), vec![divider_item("k1", Some(5))]);
        assert_eq!(divider_cid("divider:"), None);
        assert_eq!(divider_cid("itm_1"), None);
    }
}
