//! Transcript rows: an item as the row the UI shows, and the merge of runs of finished tool rows into aggregate cards (the rows
//! of `packages/protocol-client/src/rows.ts`). The row logic is the reducer task's; until it lands an item is its own row and the
//! merge leaves the rows as they are.

use serde_json::Value;

/// Rows folded per step of a long snapshot (`ITEMS_PER_STEP` of session-state.ts).
pub const ITEMS_PER_STEP: usize = 16;

/// The row of one item; `None` for an item that shows no row.
pub fn row_of(item: &Value) -> Option<Value> {
    item.is_object().then(|| item.clone())
}

/// The transcript the UI reads: `rows` with runs of finished tool rows merged into aggregate cards.
pub fn merge_tool_rows(rows: Vec<Value>) -> Vec<Value> {
    rows
}

/// `merge_tool_rows` for a long transcript, one chunk of at most `ITEMS_PER_STEP` rows per step, so a fold is budgeted in turns.
pub fn merge_tool_rows_steps(rows: Vec<Value>) -> Vec<Vec<Value>> {
    rows.chunks(ITEMS_PER_STEP).map(<[Value]>::to_vec).collect()
}
