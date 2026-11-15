//! The height of one transcript item (`estimateTranscriptItemRowsCached`, `streamingEstimateRows`, `measuredTranscriptRows`
//! of `transcript-window.mjs` and the rules of `transcript-row-estimate.mjs`), exact: the item renders through the
//! transcript widgets and its number of lines is its height.
//!
//! Three rules of Node's estimate are kept because the row table depends on them, not on how the height is obtained:
//!
//! * a failed tool batch that has nothing to read takes no row, every other item at least one;
//! * while an assistant message streams its height never falls below the highest it reached in this run (the settled/live
//!   split of the markdown moves per token, and a one-row dip would shift the transcript when a newline settles); a change of
//!   width or of tool expansion resets the water line, and a settled message forgets it;
//! * the live tail's height is recomputed only when its text, width or expansion changed (the last 8 streams are kept).
//!
//! The caches are bounded: heights by entry count, rendered lines by the number of lines they hold. An entry is keyed by a
//! fingerprint of the whole item (every field that can change a row, with no list of fields to keep in step with the
//! widgets), the width, the expansion, the kind of the row above and, for lines, the theme version.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use mixdog_js::value_to_string;
use mixdog_markdown_ansi::stream::streaming_layout_text;
use mixdog_tui_style::get_theme_version;
use mixdog_tui_widgets::Line;
use mixdog_tui_widgets::transcript::tool_failures::should_suppress_fully_failed_tool_item;
use mixdog_tui_widgets::transcript::{ItemCtx, render_item, render_item_flagged};
use serde_json::Value;

/// Entries of the height cache (a key and a count each).
const ROW_CACHE_MAX_ENTRIES: usize = 65_536;
/// Lines held by the rendered-lines cache; a settled item with more lines than this is not kept.
const LINE_CACHE_MAX_LINES: usize = 60_000;
/// Streams whose latest estimate is kept (`STREAMING_TAIL_ESTIMATE_LRU_MAX`).
const STREAMING_TAIL_ESTIMATE_LRU_MAX: usize = 8;
/// A clock far past any `startedAt`: a pending tool card is laid out as the card it becomes, never as its blank placeholder,
/// so a height never depends on the time it is asked at.
const SETTLED_CLOCK_MS: f64 = 1.0e15;

/// What a height depends on besides the item.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct HeightParams {
    /// The columns of the frame.
    pub columns: usize,
    /// The transcript-wide switch that expands every tool card.
    pub tool_output_expanded: bool,
}

/// `item.id` as a key; none for an absent or null id.
pub fn item_id(item: &Value) -> Option<String> {
    item.get("id").filter(|id| !id.is_null()).map(value_to_string)
}

/// `item.kind` as text; empty when absent.
pub fn item_kind(item: &Value) -> &str {
    item.get("kind").and_then(Value::as_str).unwrap_or("")
}

/// JavaScript truthiness of a property.
pub(crate) fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(Value::String(text)) => !text.is_empty(),
        Some(_) => true,
    }
}

/// Whether the item is a streaming assistant message (the growing tail).
pub fn is_streaming_tail(item: &Value) -> bool {
    item_kind(item) == "assistant" && truthy(item.get("streaming"))
}

/// A tool card that is not done (`toolItemPendingForRows`): its clock-driven parts change on every tick, so its lines are
/// never kept.
fn is_pending_tool(item: &Value) -> bool {
    if item_kind(item) != "tool" {
        return false;
    }
    let number = |key: &str| item.get(key).map_or(0.0, mixdog_js::to_number);
    let wanted = if truthy(item.get("count")) { number("count") } else { 1.0 };
    let count = wanted.max(1.0);
    let done = if truthy(item.get("completedCount")) {
        number("completedCount")
    } else if item.get("result").is_none_or(Value::is_null) {
        0.0
    } else {
        count
    };
    done.clamp(0.0, count) < count
}

/// A fingerprint of every field of the item. Equal items have equal fingerprints; items that differ in any field differ with
/// the probability of a 64-bit collision.
pub fn item_fingerprint(item: &Value) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in item.to_string().as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

/// What a cached height or line set is valid for.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct RowKey {
    fingerprint: u64,
    columns: usize,
    expanded: bool,
    prev_kind: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct LineKey {
    row: RowKey,
    theme_version: u64,
}

/// A map that drops its least recently used entries once the weight of what it holds passes a cap.
struct Bounded<K, V> {
    max_weight: usize,
    weight_of: fn(&V) -> usize,
    weight: usize,
    tick: u64,
    entries: HashMap<K, (u64, V)>,
}

impl<K: std::hash::Hash + Eq + Clone, V> Bounded<K, V> {
    fn new(max_weight: usize, weight_of: fn(&V) -> usize) -> Self {
        Self { max_weight, weight_of, weight: 0, tick: 0, entries: HashMap::new() }
    }

    fn get(&mut self, key: &K) -> Option<&V> {
        self.tick += 1;
        let tick = self.tick;
        self.entries.get_mut(key).map(|entry| {
            entry.0 = tick;
            &entry.1
        })
    }

    fn insert(&mut self, key: K, value: V) {
        let weight = (self.weight_of)(&value);
        if weight > self.max_weight {
            return;
        }
        self.tick += 1;
        if let Some((_, old)) = self.entries.insert(key, (self.tick, value)) {
            self.weight -= (self.weight_of)(&old);
        }
        self.weight += weight;
        if self.weight > self.max_weight {
            self.evict();
        }
    }

    /// Drops the oldest entries until the weight is three quarters of the cap.
    fn evict(&mut self) {
        let mut by_age: Vec<(u64, K)> = self.entries.iter().map(|(key, (tick, _))| (*tick, key.clone())).collect();
        by_age.sort_unstable_by_key(|(tick, _)| *tick);
        let target = self.max_weight / 4 * 3;
        for (_, key) in by_age {
            if self.weight <= target {
                break;
            }
            if let Some((_, value)) = self.entries.remove(&key) {
                self.weight -= (self.weight_of)(&value);
            }
        }
    }

    fn clear(&mut self) {
        self.entries.clear();
        self.weight = 0;
    }
}

/// The highest height a streaming message reached in this run, and what it was measured for.
#[derive(Clone, Copy, Debug)]
struct HighWater {
    rows: usize,
    columns: usize,
    tool_expanded: bool,
}

/// The latest height of a streaming message and the text it was computed from.
struct TailEstimate {
    text: String,
    columns: usize,
    tool_expanded: bool,
    rows: usize,
}

/// The caches of the heights of one transcript window.
pub struct ItemHeights {
    rows: Bounded<RowKey, usize>,
    lines: Bounded<LineKey, Arc<Vec<Line>>>,
    /// Per cached line, whether a text wrapped into it (the selection joins such lines).
    soft_wrap: Bounded<LineKey, Arc<Vec<bool>>>,
    high_water: HashMap<String, HighWater>,
    /// The latest estimate per stream id, oldest first.
    tail_estimates: Vec<(String, TailEstimate)>,
}

impl Default for ItemHeights {
    fn default() -> Self {
        Self {
            rows: Bounded::new(ROW_CACHE_MAX_ENTRIES, |_| 1),
            lines: Bounded::new(LINE_CACHE_MAX_LINES, |lines| lines.len().max(1)),
            soft_wrap: Bounded::new(LINE_CACHE_MAX_LINES, |flags| flags.len().max(1)),
            high_water: HashMap::new(),
            tail_estimates: Vec::new(),
        }
    }
}

fn item_ctx(params: &HeightParams, prev_kind: Option<&str>, now_ms: f64) -> ItemCtx {
    ItemCtx { prev_kind: prev_kind.map(str::to_owned), tool_output_expanded: params.tool_output_expanded, now_ms, ..ItemCtx::new(params.columns) }
}

fn row_key(item: &Value, prev_kind: Option<&str>, params: &HeightParams) -> RowKey {
    RowKey { fingerprint: item_fingerprint(item), columns: params.columns, expanded: params.tool_output_expanded, prev_kind: prev_kind.map(str::to_owned) }
}

impl ItemHeights {
    /// The rows an item takes (`estimateTranscriptItemRowsCached` behind `buildTranscriptRowIndex`): none for a suppressed
    /// failed batch, the never-shrinking height for a streaming assistant message, otherwise the exact height, at least one
    /// row. `prev_kind` is the kind of the row above (a user message after a user message stacks flush).
    pub fn rows(&mut self, item: &Value, prev_kind: Option<&str>, params: &HeightParams) -> usize {
        if item.is_null() {
            return 1;
        }
        if should_suppress_fully_failed_tool_item(item) {
            return 0;
        }
        if is_streaming_tail(item) {
            return self.streaming_rows(item, params);
        }
        if item_kind(item) == "assistant" {
            // Settled: the water line and the latest estimate of this id no longer apply.
            self.forget_stream(item_id(item).as_deref());
        }
        let key = row_key(item, prev_kind, params);
        if let Some(rows) = self.rows.get(&key) {
            return *rows;
        }
        let rows = render_item(item, &item_ctx(params, prev_kind, SETTLED_CLOCK_MS)).len().max(1);
        self.rows.insert(key, rows);
        rows
    }

    /// The rendered lines of an item at the moment `now_ms`, kept for the next ask while nothing that shapes them changed.
    /// A streaming message and a pending tool card change with every flush or tick and are rendered each time.
    pub fn lines(&mut self, item: &Value, prev_kind: Option<&str>, params: &HeightParams, streaming_window_rows: usize, now_ms: f64) -> Arc<Vec<Line>> {
        self.lines_flagged(item, prev_kind, params, streaming_window_rows, now_ms).0
    }

    /// [`ItemHeights::lines`] and, per line, whether it continues the line above because the text wrapped there.
    pub fn lines_flagged(
        &mut self,
        item: &Value,
        prev_kind: Option<&str>,
        params: &HeightParams,
        streaming_window_rows: usize,
        now_ms: f64,
    ) -> (Arc<Vec<Line>>, Arc<Vec<bool>>) {
        let ctx = ItemCtx { streaming_window_rows, ..item_ctx(params, prev_kind, now_ms) };
        if is_streaming_tail(item) || is_pending_tool(item) {
            let (lines, flags) = render_item_flagged(item, &ctx);
            return (Arc::new(lines), Arc::new(flags));
        }
        let key = LineKey { row: row_key(item, prev_kind, params), theme_version: get_theme_version() };
        let cached_lines = self.lines.get(&key).cloned();
        let cached_flags = self.soft_wrap.get(&key).cloned();
        if let (Some(lines), Some(flags)) = (cached_lines, cached_flags) {
            return (lines, flags);
        }
        let (lines, flags) = render_item_flagged(item, &ctx);
        let (lines, flags) = (Arc::new(lines), Arc::new(flags));
        self.lines.insert(key.clone(), Arc::clone(&lines));
        self.soft_wrap.insert(key, Arc::clone(&flags));
        (lines, flags)
    }

    /// `streamingEstimateRows`: the exact height of the trimmed live text, held at the highest this stream reached.
    fn streaming_rows(&mut self, item: &Value, params: &HeightParams) -> usize {
        let id = item_id(item);
        let exact_text = item.get("text").filter(|text| !text.is_null()).map(value_to_string).unwrap_or_default();
        if let Some(id) = &id {
            if let Some(at) = self.tail_estimates.iter().position(|(key, _)| key == id) {
                let cached = &self.tail_estimates[at].1;
                if cached.text == exact_text && cached.columns == params.columns && cached.tool_expanded == params.tool_output_expanded {
                    let entry = self.tail_estimates.remove(at);
                    let rows = entry.1.rows;
                    self.tail_estimates.push(entry);
                    return rows;
                }
            }
        }
        let mut estimate_item = item.clone();
        if let Some(text) = item.get("text").and_then(Value::as_str) {
            let trimmed = streaming_layout_text(text);
            if trimmed != text {
                estimate_item["text"] = Value::String(trimmed.to_owned());
            }
        }
        let quantized = render_item(&estimate_item, &item_ctx(params, None, SETTLED_CLOCK_MS)).len().max(1);
        let Some(id) = id else { return quantized };
        let rows = match self.high_water.get_mut(&id) {
            Some(prev) if prev.columns == params.columns && prev.tool_expanded == params.tool_output_expanded => {
                prev.rows = prev.rows.max(quantized);
                prev.rows
            }
            _ => {
                self.high_water.insert(id.clone(), HighWater { rows: quantized, columns: params.columns, tool_expanded: params.tool_output_expanded });
                quantized
            }
        };
        self.cache_tail_estimate(id, TailEstimate { text: exact_text, columns: params.columns, tool_expanded: params.tool_output_expanded, rows });
        rows
    }

    /// `cacheStreamingTailEstimate`: keeps the latest estimate of at most 8 streams; an evicted stream loses its water line
    /// too, so a later reuse of the id does not inherit the geometry of an unrelated stream.
    fn cache_tail_estimate(&mut self, id: String, estimate: TailEstimate) {
        self.tail_estimates.retain(|(key, _)| *key != id);
        self.tail_estimates.push((id, estimate));
        while self.tail_estimates.len() > STREAMING_TAIL_ESTIMATE_LRU_MAX {
            let (oldest, _) = self.tail_estimates.remove(0);
            self.high_water.remove(&oldest);
        }
    }

    fn forget_stream(&mut self, id: Option<&str>) {
        if let Some(id) = id {
            self.high_water.remove(id);
            self.tail_estimates.retain(|(key, _)| key != id);
        }
    }

    /// `hasStreamingRowStateToPrune`.
    pub fn has_streaming_state_to_prune(&self) -> bool {
        !self.high_water.is_empty() || !self.tail_estimates.is_empty()
    }

    /// `pruneStreamingMeasuredRowsById`: drops the streaming state of every id that is no longer live.
    pub fn prune_streaming(&mut self, live_ids: &HashSet<String>) {
        self.high_water.retain(|id, _| live_ids.contains(id));
        self.tail_estimates.retain(|(id, _)| live_ids.contains(id));
    }

    /// Forgets everything: a resumed session replaces the transcript.
    pub fn reset(&mut self) {
        self.rows.clear();
        self.lines.clear();
        self.prune_streaming(&HashSet::new());
    }
}
