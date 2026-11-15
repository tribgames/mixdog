//! The stitch buffer of a transcript selection (`use-selection-stitch.mjs`). It accumulates the harvested selection rows across
//! scroll positions so Ctrl+C copies the full drag even after it scrolled past the viewport. Rows are keyed by the
//! scroll-invariant content row, the screen row less the scroll target at harvest time; the value is the row text and whether
//! the row is a soft-wrap continuation. Only transcript drags accumulate.

use std::collections::BTreeMap;

use mixdog_js::{js_trim, js_trim_end};
use mixdog_term::selection::SelectedRow;

use super::Mouse;
use super::host::RenderStore;
use super::state::Region;

/// The text stitched from the buffer and whether it covers the selection without a hole.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Stitched {
    pub text: String,
    pub complete: bool,
}

#[derive(Debug, Default)]
pub(super) struct StitchBuffer {
    rows: BTreeMap<i64, (String, bool)>,
    /// A harvest waits for the next frame. The scroll offset at the paint that asked for it, not whatever the offset is when
    /// it runs (a scroll in between would mis-key the rows); the latest request wins.
    harvest_pending: bool,
    harvest_scroll: f64,
}

impl StitchBuffer {
    fn store_rows(&mut self, rows: &[SelectedRow], scroll: f64) {
        let scroll = if scroll.is_nan() { 0.0 } else { scroll };
        for row in rows {
            self.rows.insert((f64::from(row.y) - scroll).round() as i64, (row.text.clone(), row.soft_wrap));
        }
    }

    pub(super) fn cancel_harvest(&mut self) {
        self.harvest_pending = false;
    }
}

impl Mouse {
    /// `clearStitchBuffer`: a fresh anchor drops the rows stitched from a prior selection, so the new drag reconstructs only
    /// its own content.
    pub fn clear_stitch_buffer(&mut self) {
        self.stitch.rows.clear();
        self.stitch.harvest_pending = false;
    }

    /// `harvestStitchRowsSoon`: harvests the rows under the selection after the next frame. Runs on every transcript selection
    /// paint and on scroll-shift repaints, so rows revealed only mid-scroll are captured; a later harvest of a key overwrites,
    /// which handles partial and full endpoint rows on retraction.
    pub(super) fn harvest_stitch_rows_soon(&mut self, scroll_target: f64) {
        if self.drag.region != Some(Region::Transcript) {
            return;
        }
        self.stitch.harvest_scroll = scroll_target;
        self.stitch.harvest_pending = true;
    }

    /// The deferred harvest, run by [`Self::after_frame`].
    pub(super) fn run_stitch_harvest<S: RenderStore + ?Sized>(&mut self, store: &mut S) {
        if !std::mem::take(&mut self.stitch.harvest_pending) || self.drag.region != Some(Region::Transcript) {
            return;
        }
        if let Some(rows) = store.render_selection_rows() {
            let scroll = self.stitch.harvest_scroll;
            self.stitch.store_rows(&rows, scroll);
        }
    }

    /// `harvestStitchRowsNow`: snapshots the rows currently under the selection, keyed by the given pre-scroll offset. Called
    /// right before a scroll moves those rows out of view: the deferred harvest could never see rows a fast drag or wheel
    /// scrolled past between paint and the next frame. The renderer harvests the rows unconditionally, even on a motion paint
    /// that does not capture text, so this works mid-drag.
    pub fn harvest_stitch_rows_now<S: RenderStore + ?Sized>(&mut self, store: &mut S, scroll: f64) {
        if self.drag.region != Some(Region::Transcript) {
            return;
        }
        if let Some(rows) = store.render_selection_rows() {
            self.stitch.store_rows(&rows, scroll);
        }
    }

    /// `getStitchedSelectionText`: maps the current rect and scroll target onto the content-key range and joins the buffered
    /// rows in key order. `complete` holds only when the harvested keys cover the selection's whole range without a hole
    /// (interior and both endpoints): a gap (a scrolled-off row that was never harvested) would yield a mangled, shorter copy.
    /// Soft-wrap continuation rows join the previous logical line without a newline, blank inner rows stay as empty lines, and
    /// trailing whitespace is trimmed once per logical line.
    pub fn stitched_selection_text(&self, scroll_target: f64) -> Stitched {
        let empty = Stitched::default();
        if self.stitch.rows.is_empty() || self.drag.region != Some(Region::Transcript) {
            return empty;
        }
        let Some(rect) = &self.drag.rect else { return empty };
        let scroll = if scroll_target.is_nan() { 0.0 } else { scroll_target };
        let lo = (f64::from(rect.y1.min(rect.y2)) - scroll).round() as i64;
        let hi = (f64::from(rect.y1.max(rect.y2)) - scroll).round() as i64;
        let rows: Vec<&(String, bool)> = self.stitch.rows.range(lo..=hi).map(|(_, row)| row).collect();
        if rows.is_empty() {
            return empty;
        }
        // The keys are unique and within [lo, hi], so a count equal to the range size means every selected row is present.
        let complete = rows.len() as i64 == hi - lo + 1;
        let mut logical: Vec<String> = Vec::new();
        for (text, soft_wrap) in rows {
            match logical.last_mut() {
                Some(last) if *soft_wrap => last.push_str(text),
                _ => logical.push(text.clone()),
            }
        }
        let text = logical.iter().map(|line| js_trim_end(line)).collect::<Vec<_>>().join("\n");
        if js_trim(&text).is_empty() { empty } else { Stitched { text, complete } }
    }
}
