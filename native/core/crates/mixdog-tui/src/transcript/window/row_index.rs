//! The row index of the transcript (`buildTranscriptRowIndex`, `buildTranscriptRowIndexIncremental`,
//! `transcriptItemsWithStableTail` of `transcript-window.mjs`): the rows of every item and their running sum.
//!
//! While the tail streams only its row changes between flushes, so the settled prefix is built once per structure revision
//! and a flush replaces the last row in place ([`IncrementalRowIndex`]); Node appended an immutable view to a cached prefix,
//! here the one index is truncated to the prefix and the new tail row pushed.

use serde_json::Value;

use super::heights::{HeightParams, ItemHeights, is_streaming_tail, item_id, item_kind};

/// The settled items and the live tail after them: the items of the transcript without copying the settled ones
/// (`transcriptItemsWithStableTail`).
#[derive(Clone, Copy, Debug)]
pub struct Items<'a> {
    pub settled: &'a [Value],
    /// The streaming assistant message drawn after the settled items.
    pub tail: Option<&'a Value>,
}

impl<'a> Items<'a> {
    pub fn new(settled: &'a [Value], tail: Option<&'a Value>) -> Self {
        Self { settled, tail }
    }

    pub fn len(&self) -> usize {
        self.settled.len() + usize::from(self.tail.is_some())
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub fn get(&self, index: usize) -> Option<&'a Value> {
        self.settled.get(index).or_else(|| (index == self.settled.len()).then_some(self.tail).flatten())
    }

    /// The kind of the item above `index`, if any.
    pub fn prev_kind(&self, index: usize) -> Option<&'a str> {
        index.checked_sub(1).and_then(|above| self.get(above)).map(item_kind)
    }

    /// `trailingStreamingItem`: the last item when it is a streaming assistant message (the live tail), with its index.
    pub fn streaming_tail(&self) -> Option<(usize, &'a Value)> {
        let last = self.len().checked_sub(1)?;
        self.get(last).filter(|item| is_streaming_tail(item)).map(|item| (last, item))
    }
}

/// The rows of each item and their prefix sums: `prefix_rows[i]` is the row where item `i` starts and has `len + 1` entries.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RowIndex {
    pub rows: Vec<usize>,
    pub prefix_rows: Vec<usize>,
    pub total_rows: usize,
}

impl RowIndex {
    pub fn len(&self) -> usize {
        self.rows.len()
    }

    pub fn is_empty(&self) -> bool {
        self.rows.is_empty()
    }

    fn with_capacity(count: usize) -> Self {
        let mut prefix_rows = Vec::with_capacity(count + 1);
        prefix_rows.push(0);
        Self { rows: Vec::with_capacity(count), prefix_rows, total_rows: 0 }
    }

    fn push(&mut self, rows: usize) {
        self.rows.push(rows);
        self.total_rows += rows;
        self.prefix_rows.push(self.total_rows);
    }

    fn truncate(&mut self, count: usize) {
        self.rows.truncate(count);
        self.prefix_rows.truncate(count + 1);
        self.total_rows = self.prefix_rows.last().copied().unwrap_or(0);
    }
}

/// `buildTranscriptRowIndex`: every item's height, in order.
pub fn build_row_index(items: &Items, heights: &mut ItemHeights, params: &HeightParams) -> RowIndex {
    let mut index = RowIndex::with_capacity(items.len());
    for at in 0..items.len() {
        if let Some(item) = items.get(at) {
            let rows = heights.rows(item, items.prev_kind(at), params);
            index.push(rows);
        }
    }
    index
}

/// What the cached settled prefix was built for.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Shape {
    columns: usize,
    tool_expanded: bool,
    prefix_len: usize,
    prefix_revision: u64,
    /// The id of the streaming tail; none for a build without one (which caches the whole index).
    tail: Option<Option<String>>,
}

/// The row index kept across flushes of a streaming tail.
#[derive(Debug, Default)]
pub struct IncrementalRowIndex {
    shape: Option<Shape>,
    index: RowIndex,
}

impl IncrementalRowIndex {
    /// Forgets the cached prefix (a session switch).
    pub fn clear(&mut self) {
        self.shape = None;
        self.index = RowIndex::default();
    }

    /// `buildTranscriptRowIndexIncremental` behind the memo of `useTranscriptGeometry`: with no streaming tail the index built
    /// for the same revision, width, expansion and length is kept (a whole build otherwise); with one, the settled prefix built
    /// for the same revision, width, expansion, length and tail id is kept and only the tail's row is replaced. Any other
    /// change rebuilds the whole index, so the prefix is always what a whole build produces. `prefix_revision` is the engine's
    /// monotonic structure revision: it proves the settled items unchanged without walking them.
    pub fn build(&mut self, items: &Items, heights: &mut ItemHeights, params: &HeightParams, prefix_revision: u64) -> &RowIndex {
        let Some((tail_at, tail)) = items.streaming_tail() else {
            let shape = Shape { columns: params.columns, tool_expanded: params.tool_output_expanded, prefix_len: items.len(), prefix_revision, tail: None };
            if self.shape.as_ref() != Some(&shape) || self.index.rows.len() != items.len() {
                self.index = build_row_index(items, heights, params);
                self.shape = Some(shape);
            }
            return &self.index;
        };
        let shape =
            Shape { columns: params.columns, tool_expanded: params.tool_output_expanded, prefix_len: tail_at, prefix_revision, tail: Some(item_id(tail)) };
        if self.shape.as_ref() == Some(&shape) && self.index.rows.len() > tail_at {
            self.index.truncate(tail_at);
        } else {
            self.index = build_row_index(items, heights, params);
            self.index.truncate(tail_at);
            self.shape = Some(shape);
        }
        let rows = heights.rows(tail, items.prev_kind(tail_at), params);
        self.index.push(rows);
        &self.index
    }

    /// The index of the last build.
    pub fn index(&self) -> &RowIndex {
        &self.index
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn params(columns: usize) -> HeightParams {
        HeightParams { columns, tool_output_expanded: false }
    }

    fn settled(count: usize) -> Vec<Value> {
        (0..count).map(|n| json!({"id": format!("u{n}"), "kind": "user", "text": format!("line {n}")})).collect()
    }

    #[test]
    fn items_put_the_tail_after_the_settled_ones() {
        let settled = settled(2);
        let tail = json!({"id": "a", "kind": "assistant", "streaming": true, "text": "x"});
        let items = Items::new(&settled, Some(&tail));
        assert_eq!(items.len(), 3);
        assert_eq!(items.get(2).and_then(|item| item.get("id")), Some(&json!("a")));
        assert_eq!(items.prev_kind(0), None);
        assert_eq!(items.prev_kind(2), Some("user"));
        assert_eq!(items.streaming_tail().map(|(at, _)| at), Some(2));
        assert!(Items::new(&settled, None).streaming_tail().is_none());
    }

    #[test]
    fn the_prefix_rows_are_the_running_sum() {
        let settled = settled(4);
        let mut heights = ItemHeights::default();
        let index = build_row_index(&Items::new(&settled, None), &mut heights, &params(40));
        assert_eq!(index.prefix_rows.len(), 5);
        assert_eq!(index.prefix_rows[0], 0);
        assert_eq!(index.total_rows, index.rows.iter().sum::<usize>());
        assert!(index.rows.iter().all(|rows| *rows >= 1));
    }

    #[test]
    fn a_streaming_flush_replaces_only_the_tail_row_and_matches_a_whole_build() {
        let settled = settled(30);
        let mut heights = ItemHeights::default();
        let mut incremental = IncrementalRowIndex::default();
        for words in [1usize, 40, 200] {
            let text = vec!["word"; words].join(" ");
            let tail = json!({"id": "stream", "kind": "assistant", "streaming": true, "text": text});
            let items = Items::new(&settled, Some(&tail));
            let built = incremental.build(&items, &mut heights, &params(40), 7).clone();
            let whole = build_row_index(&items, &mut ItemHeights::default(), &params(40));
            assert_eq!(built.prefix_rows.len(), 32);
            assert_eq!(built.prefix_rows[..31], whole.prefix_rows[..31]);
            assert!(built.rows[30] >= 1);
        }
    }

    #[test]
    fn a_new_revision_or_width_rebuilds_the_prefix() {
        let mut settled = settled(3);
        let tail = json!({"id": "stream", "kind": "assistant", "streaming": true, "text": "x"});
        let mut heights = ItemHeights::default();
        let mut incremental = IncrementalRowIndex::default();
        let before = incremental.build(&Items::new(&settled, Some(&tail)), &mut heights, &params(40), 1).clone();
        settled[1] = json!({"id": "u1", "kind": "user", "text": "wide ".repeat(80)});
        let same_revision = incremental.build(&Items::new(&settled, Some(&tail)), &mut heights, &params(40), 1).clone();
        assert_eq!(same_revision.rows[1], before.rows[1], "the revision proves the prefix unchanged, so it is not walked");
        let next_revision = incremental.build(&Items::new(&settled, Some(&tail)), &mut heights, &params(40), 2).clone();
        assert!(next_revision.rows[1] > before.rows[1]);
        let narrower = incremental.build(&Items::new(&settled, Some(&tail)), &mut heights, &params(20), 2).clone();
        assert!(narrower.rows[1] > next_revision.rows[1]);
    }

    #[test]
    fn a_settled_transcript_is_walked_once_per_revision() {
        let mut settled = settled(3);
        let mut heights = ItemHeights::default();
        let mut incremental = IncrementalRowIndex::default();
        let before = incremental.build(&Items::new(&settled, None), &mut heights, &params(40), 1).clone();
        settled[1] = json!({"id": "u1", "kind": "user", "text": "wide ".repeat(80)});
        let same_revision = incremental.build(&Items::new(&settled, None), &mut heights, &params(40), 1).clone();
        assert_eq!(same_revision, before, "the revision proves the items unchanged, so they are not walked");
        let next_revision = incremental.build(&Items::new(&settled, None), &mut heights, &params(40), 2).clone();
        assert!(next_revision.rows[1] > before.rows[1]);
        assert_eq!(next_revision, build_row_index(&Items::new(&settled, None), &mut heights, &params(40)));
    }

    #[test]
    fn with_no_streaming_tail_the_index_is_a_whole_build() {
        let settled = settled(3);
        let mut heights = ItemHeights::default();
        let mut incremental = IncrementalRowIndex::default();
        let index = incremental.build(&Items::new(&settled, None), &mut heights, &params(40), 1).clone();
        assert_eq!(index, build_row_index(&Items::new(&settled, None), &mut heights, &params(40)));
        assert_eq!(incremental.index(), &index);
    }
}
