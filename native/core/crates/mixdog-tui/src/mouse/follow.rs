//! A released selection is a place in the content and a text, both taken when the selection is made.
//!
//! The place decides where the highlight is drawn and when the selection ends. A transcript selection runs between two ends,
//! each the row of an item (the item's id and the row inside the whole item) and a column. An end takes its place from the
//! frame on screen when its row is pointed at: the anchor end at the press, the other at the release. The rows between the
//! ends are the rows of the items between them, whether a frame renders them or not. Every frame places the selection where
//! it renders those rows: an end the frame does not render lies off screen on its side. The selection ends when the place is
//! gone: another session, an end's item out of the transcript or without that row, a width that wrapped its rows anew. An end
//! pointed at a row of no item moves to the nearest row of one, and a transcript selection with no such row is none.
//!
//! The text is what the selected content reads at the release, whole: every selected row of every item between the ends is
//! read from the content then, an item the frame does not render (or renders in part, or under the hint of the prompt) being
//! rendered for it. Nothing reads it again: a copy gives that text for as long as the selection lasts. A gesture that changes
//! the selection (a shift or right press that extends it, Shift+Arrow) makes it anew and takes its text by the same reading.
//!
//! The highlight is drawn on the place only while the place reads what was selected. When the rows of an item changed so
//! that its selected rows read otherwise (a re-flow above them, the item expanded), the selection stays and is not
//! highlighted: no highlight is ever on other text. Cells the clock drives (the elapsed time of a running tool card) are not
//! such a change: the item is compared as it reads at a fixed time.
//!
//! A streaming message keeps its id when it settles, and its rows count from the first row of the whole message however much
//! of it the live window renders, so a selection in it stays on its rows while the window moves and after the message settled.
//!
//! A statusline selection is rows and columns of the band: it follows the band, its text is what the band showed at the
//! release, its highlight stays on its cells, and it ends when the band no longer has those rows.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

use mixdog_term::selection::{SelectedRow, SelectionRect, logical_text, settle_rows};
use mixdog_termtext::grapheme::graphemes_with_widths;

use super::Mouse;
use super::host::{RenderStore, SelectionIo};
use super::state::Region;

/// What a row of an item reads, across the whole row, and whether the row continues the one above.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RowText {
    pub text: String,
    pub soft_wrap: bool,
}

/// An item as a frame rendered it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DrawnItem {
    /// The screen row the first row of the whole item is on, or would be on when the frame did not render it.
    pub top: i32,
    /// The first row the frame rendered (above 0 for a message rendered through the live window).
    pub first: usize,
    /// The rows of the whole item.
    pub rows: usize,
    /// A value that differs from the frame before when the item was rendered anew.
    pub stamp: usize,
}

/// A row of the content.
#[derive(Clone, Debug)]
struct Place {
    id: String,
    /// Where the item was last found in the transcript.
    index: usize,
    row: usize,
}

#[derive(Debug)]
struct End {
    place: Place,
    x: i32,
    /// The screen row less the scroll target: the count the drag's own anchor is kept in.
    key: i64,
}

#[derive(Debug)]
enum Anchor {
    /// The ends in the order of the rect's corners; the first is the end the selection was started from.
    Content { session: String, columns: usize, ends: [End; 2] },
    /// The rows of the rect's corners counted from the first row of the band.
    Band { rows: [i32; 2] },
}

/// The selected rows of one item as they read when the selection was made, and whether the last frame that rendered the item
/// still read them so.
#[derive(Debug)]
struct Read {
    id: Option<String>,
    /// One mark per selected row from the first, of its selected columns.
    marks: Vec<u64>,
    /// The mark of the rows as they read at a fixed time, for an item with cells the clock drives.
    still: Option<u64>,
    /// The rendering the verdict was reached on, and the frame that was.
    stamp: usize,
    first: usize,
    frame: u64,
    reads: bool,
}

#[derive(Debug, Default)]
pub(super) struct Follow {
    anchor: Option<Anchor>,
    /// The row the selection is extended from, by its key, as content: the row of the press, then the first end.
    origin: Option<(i64, Place)>,
    /// What a copy gives: the text of the selection as its content read when it was made.
    text: Option<String>,
    /// Per item from the first end's to the last end's.
    reads: Vec<Read>,
    /// The rows scrolled since the last painted frame: a rect made now counts its rows that far from the frame on screen.
    pub(super) scrolled: f64,
    /// The last frame draws no highlight for the selection: it renders none of it, or what it renders reads otherwise.
    pub(super) hidden: bool,
    frame: u64,
}

enum Placed {
    /// The screen rows of the rect's two corners, and whether the rows rendered there read what was selected.
    At([i32; 2], bool),
    Hidden,
    Gone,
}

/// The selection in reading order: the item, the row and the column of its first and last cells.
#[derive(Clone, Copy)]
struct Span {
    first: (usize, usize, i32),
    last: (usize, usize, i32),
}

impl Span {
    /// The span of `ends` and which of them is the first.
    fn of(ends: &[End; 2]) -> (Self, usize) {
        let order = |end: &End| (end.place.index, end.place.row, end.x);
        let a = usize::from(order(&ends[0]) > order(&ends[1]));
        (Self { first: order(&ends[a]), last: order(&ends[1 - a]) }, a)
    }

    /// The first and last selected rows of the item at `index`; the last is `usize::MAX` for the item's own last row.
    fn rows(&self, index: usize) -> (usize, usize) {
        (if index == self.first.0 { self.first.1 } else { 0 }, if index == self.last.0 { self.last.1 } else { usize::MAX })
    }

    /// The first and last selected columns of row `row` of the item at `index`.
    fn columns(&self, index: usize, row: usize) -> (i32, i32) {
        (
            if (index, row) == (self.first.0, self.first.1) { self.first.2 } else { 0 },
            if (index, row) == (self.last.0, self.last.1) { self.last.2 } else { i32::MAX },
        )
    }
}

fn mark(text: &str) -> u64 {
    let mut hasher = DefaultHasher::new();
    text.hash(&mut hasher);
    hasher.finish()
}

fn mark_rows(rows: &[RowText]) -> u64 {
    let mut hasher = DefaultHasher::new();
    for row in rows {
        row.text.hash(&mut hasher);
    }
    hasher.finish()
}

fn key_of(y: i32, target: f64) -> i64 {
    i64::from(y) - if target.is_nan() { 0 } else { target.round() as i64 }
}

/// The part of a row's text in columns `x1..=x2`.
fn columns_of(text: &str, x1: i32, x2: i32) -> &str {
    let mut column = 0i32;
    let mut span: Option<(usize, usize)> = None;
    for glyph in graphemes_with_widths(text) {
        if column >= x1 && column <= x2 {
            let from = span.map_or(glyph.start, |(from, _)| from);
            span = Some((from, glyph.start + glyph.text.len()));
        }
        column += glyph.width.clamp(1, 2) as i32;
    }
    span.map_or("", |(from, to)| &text[from..to])
}

impl Mouse {
    /// The released transcript or statusline selection.
    fn released_selection(&self) -> Option<(SelectionRect, Region)> {
        let region = self.drag.region.filter(|region| matches!(region, Region::Transcript | Region::Status))?;
        if self.drag.active {
            return None;
        }
        self.drag.rect.map(|rect| (rect, region))
    }

    /// A row counted as the next frame will draw it is this many rows further down than on the frame on screen.
    fn since_frame(&self) -> i32 {
        if self.follow.scrolled.is_nan() { 0 } else { self.follow.scrolled.round() as i32 }
    }

    /// The content on row `y`, as the frame on screen has it.
    fn place_on_frame<S: RenderStore + ?Sized>(&self, store: &mut S, y: i32) -> Option<Place> {
        let (index, row) = store.content_row_at(y - self.since_frame())?;
        Some(Place { id: store.item_id_at(index)?, index, row })
    }

    /// The content on row `y`: the row the selection is extended from keeps the place it had, wherever its item is now.
    fn place_of<S: RenderStore + ?Sized>(&self, store: &mut S, y: i32, target: f64) -> Option<Place> {
        match &self.follow.origin {
            Some((key, place)) if *key == key_of(y, target) => {
                let index = store.find_item(&place.id, place.index)?;
                Some(Place { index, ..place.clone() })
            }
            _ => self.place_on_frame(store, y),
        }
    }

    /// A press starts a new selection on row `y`: the one before is dropped, and the row is taken as content while the frame
    /// that shows it is on screen.
    pub(super) fn begin_selection<S: SelectionIo + ?Sized>(&mut self, store: &mut S, region: Region, y: i32) {
        self.drop_selection();
        if region == Region::Transcript {
            self.follow.origin = self.place_on_frame(store, y).map(|place| (key_of(y, store.scroll_target()), place));
        }
    }

    fn drop_selection(&mut self) {
        self.follow.anchor = None;
        self.follow.hidden = false;
        self.follow.text = None;
        self.follow.reads.clear();
        self.follow.origin = None;
    }

    /// The drag's rect was set. A released selection is made: it takes its place in the content (a statusline one its rows of
    /// the band, a transcript one the rows of its two ends, the rect drawn back to them where an end lay on no item) and its
    /// text, read whole from the content now. False for a transcript selection that lies on no item at all, which is no
    /// selection.
    pub(super) fn anchor_selection<S: SelectionIo + ?Sized>(&mut self, store: &mut S) -> bool {
        let origin = self.follow.origin.take();
        self.drop_selection();
        let Some((rect, region)) = self.released_selection() else {
            if self.drag.rect.is_some() {
                self.follow.origin = origin;
            }
            return true;
        };
        self.follow.origin = origin;
        let Some(session) = store.frame_session().map(str::to_owned) else { return true };
        if region == Region::Status {
            let top = self.region_rows(Some(region)).top as i32;
            self.follow.text = store.frame_selection_text(&rect);
            self.follow.anchor = Some(Anchor::Band { rows: [rect.y1 - top, rect.y2 - top] });
            return true;
        }
        let target = store.scroll_target();
        let forward = (rect.y1, rect.x1) <= (rect.y2, rect.x2);
        let last_column = (self.columns as i32 - 1).max(0);
        let mut points = [(rect.x1, rect.y1), (rect.x2, rect.y2)];
        let mut places = [self.place_of(store, rect.y1, target), self.place_of(store, rect.y2, target)];
        for end in 0..2 {
            let other = points[1 - end].1;
            let step = (other - points[end].1).signum();
            while places[end].is_none() && points[end].1 != other {
                // The end is on a row of no item: it moves toward the other end and takes the row it lands on whole.
                points[end] = (if (end == 0) == forward { 0 } else { last_column }, points[end].1 + step);
                places[end] = self.place_of(store, points[end].1, target);
            }
        }
        let [Some(first), Some(second)] = places else { return false };
        let ends =
            [End { place: first, x: points[0].0, key: key_of(points[0].1, target) }, End { place: second, x: points[1].0, key: key_of(points[1].1, target) }];
        let Some(text) = self.read_selection(store, Span::of(&ends).0) else { return false };
        if points != [(rect.x1, rect.y1), (rect.x2, rect.y2)] {
            let drawn = SelectionRect { x1: points[0].0, y1: points[0].1, x2: points[1].0, y2: points[1].1, ..rect };
            self.drag.rect = self.with_selection_clip(Some(drawn), false);
        }
        self.follow.text = Some(text);
        self.follow.origin = Some((ends[0].key, ends[0].place.clone()));
        self.follow.anchor = Some(Anchor::Content { session, columns: store.frame_columns(), ends });
        true
    }

    /// The text of `span` as the content reads now, every row of it, and what each item's rows are told by afterwards. None
    /// when the content no longer has the row of an end.
    fn read_selection<S: RenderStore + ?Sized>(&mut self, store: &mut S, span: Span) -> Option<String> {
        let mut rows: Vec<SelectedRow> = Vec::new();
        let mut reads = Vec::with_capacity(span.last.0 - span.first.0 + 1);
        for index in span.first.0..=span.last.0 {
            let (lo, hi) = span.rows(index);
            let read = store.item_rows_text(index, lo, hi).unwrap_or_default();
            if (index == span.first.0 && read.is_empty()) || (index == span.last.0 && read.len() != hi - lo + 1) {
                return None;
            }
            let mut marks = Vec::with_capacity(read.len());
            for (offset, row) in read.iter().enumerate() {
                let (x1, x2) = span.columns(index, lo + offset);
                let text = columns_of(&row.text, x1, x2);
                marks.push(mark(text));
                rows.push(SelectedRow { y: rows.len() as i32, text: text.to_owned(), soft_wrap: row.soft_wrap });
            }
            let still = store.still_rows(index, lo, hi).map(|rows| mark_rows(&rows));
            reads.push(Read { id: store.item_id_at(index), marks, still, stamp: 0, first: 0, frame: 0, reads: true });
        }
        self.follow.reads = reads;
        Some(logical_text(&settle_rows(rows)))
    }

    /// Whether the rows the frame rendered of the item at `index`, the `slot`th of the selection, read what was selected.
    /// The verdict of the frame before stands while the item was not rendered anew.
    fn item_reads<S: RenderStore + ?Sized>(&mut self, store: &mut S, index: usize, slot: usize, item: DrawnItem, span: Span, anew: bool) -> bool {
        let frame = self.follow.frame;
        let entry = &mut self.follow.reads[slot];
        if !anew && entry.stamp == item.stamp && entry.first == item.first && entry.frame + 1 == frame {
            entry.frame = frame;
            return entry.reads;
        }
        let (lo, hi) = span.rows(index);
        let known = entry.id.as_deref().is_none_or(|id| store.find_item(id, index) == Some(index));
        // An item selected to its last row has the rows it had.
        let mut same = known && (hi != usize::MAX || item.rows == lo + entry.marks.len());
        if same {
            for row in lo.max(item.first)..item.rows.min(lo + entry.marks.len()) {
                let (x1, x2) = span.columns(index, row);
                let now = store.content_row_text(index, row).map(|read| mark(columns_of(&read.text, x1, x2)));
                if now != Some(entry.marks[row - lo]) {
                    same = false;
                    break;
                }
            }
        }
        if !same
            && known
            && let Some(still) = entry.still
        {
            // Cells the clock drives changed in place: the rows are the selected ones when they read the same at a fixed time.
            same = store.still_rows(index, lo, hi).is_some_and(|rows| mark_rows(&rows) == still);
        }
        entry.stamp = item.stamp;
        entry.first = item.first;
        entry.frame = frame;
        entry.reads = same;
        same
    }

    /// Where the frame on screen draws a transcript selection, and whether what it renders there reads what was selected.
    fn place_range<S: SelectionIo + ?Sized>(&mut self, store: &mut S, session: &str, columns: &mut usize, ends: &mut [End; 2]) -> Placed {
        if store.frame_session() != Some(session) {
            return Placed::Gone;
        }
        for end in ends.iter_mut() {
            match store.find_item(&end.place.id, end.place.index) {
                Some(index) => end.place.index = index,
                None => return Placed::Gone,
            }
        }
        let (span, a) = Span::of(ends);
        let b = 1 - a;
        let (first_index, first_row) = (span.first.0, span.first.1);
        let (last_index, last_row) = (span.last.0, span.last.1);
        let width = store.frame_columns();
        let anew = width != *columns;
        // The items between the ends are the ones that were read.
        let aligned = self.follow.reads.len() == last_index - first_index + 1;
        let mut reads = aligned;
        // A selected row the frame does not render cannot be told to read as it did.
        let mut untold = false;
        let mut drawn: [Option<DrawnItem>; 2] = [None, None];
        let mut any = false;
        match store.drawn_items().filter(|(_, count)| *count > 0) {
            Some((start, count)) => {
                let end = start + count - 1;
                untold |= first_index < start || last_index > end;
                for index in first_index.max(start)..=last_index.min(end) {
                    let Some(item) = store.drawn_item(index) else {
                        untold = true;
                        continue;
                    };
                    any = true;
                    if index == first_index {
                        drawn[0] = Some(item);
                    }
                    if index == last_index {
                        drawn[1] = Some(item);
                    }
                    // The item no longer has the row an end is on.
                    if (index == first_index && first_row >= item.rows) || (index == last_index && last_row >= item.rows) {
                        return Placed::Gone;
                    }
                    untold |= item.first > span.rows(index).0;
                    if aligned {
                        reads &= self.item_reads(store, index, index - first_index, item, span, anew);
                    }
                }
            }
            None => untold = true,
        }
        if anew {
            // Another width: rows that read as before were not wrapped anew; rows that cannot be read cannot be told.
            if untold || !reads {
                return Placed::Gone;
            }
            *columns = width;
        }
        let (top, bottom) = (self.viewport.top as i32, self.viewport.bottom as i32);
        let y_of = |item: Option<DrawnItem>, row: usize| item.map(|item| item.top + row as i32);
        // An end the frame did not render is off screen on its side of the rows it did.
        let (y_first, y_last) = match (y_of(drawn[0], first_row), y_of(drawn[1], last_row)) {
            (Some(first), Some(last)) => (first, last),
            (Some(first), None) => (first, bottom.max(first) + 1),
            (None, Some(last)) => (top.min(last) - 1, last),
            (None, None) if any => (top - 1, bottom + 1),
            (None, None) => return Placed::Hidden,
        };
        let mut at = [0; 2];
        at[a] = y_first;
        at[b] = y_last;
        Placed::At(at, reads)
    }

    /// Where the frame on screen draws the selection.
    fn place_selection<S: SelectionIo + ?Sized>(&mut self, store: &mut S) -> Placed {
        let Some(mut anchor) = self.follow.anchor.take() else { return Placed::Gone };
        let placed = match &mut anchor {
            Anchor::Band { rows } => {
                let band = self.region_rows(self.drag.region);
                let height = (band.bottom - band.top) as i32;
                if rows.iter().any(|row| *row < 0 || *row > height) { Placed::Gone } else { Placed::At((*rows).map(|row| band.top as i32 + row), true) }
            }
            Anchor::Content { session, columns, ends } => self.place_range(store, session, columns, ends),
        };
        self.follow.anchor = Some(anchor);
        placed
    }

    /// The selection is placed with its corners on rows `at`: the drag's own anchor, which a later extend starts from, is
    /// kept on the row of the first corner.
    fn selection_drawn<S: SelectionIo + ?Sized>(&mut self, store: &S, was: &SelectionRect, at: [i32; 2]) {
        match self.follow.anchor.as_mut() {
            Some(Anchor::Content { ends, .. }) => {
                let target = store.scroll_target();
                let moved = key_of(at[0], target) - ends[0].key;
                for (end, y) in ends.iter_mut().zip(at) {
                    end.key = key_of(y, target);
                }
                self.drag.anchor_scroll -= moved as f64;
                if let Some((key, _)) = self.follow.origin.as_mut() {
                    *key += moved;
                }
            }
            Some(Anchor::Band { .. }) => {
                let moved = at[0] - was.y1;
                if let Some(point) = self.drag.anchor.as_mut() {
                    point.y += moved;
                }
                if let Some(span) = self.drag.anchor_span.as_mut() {
                    span.lo.y += moved;
                    span.hi.y += moved;
                }
            }
            None => {}
        }
    }

    /// A frame was laid out and is about to take its highlight: a released selection is placed where the frame renders its
    /// content and highlighted there while those rows read what was selected, without a highlight while the frame renders
    /// none of it, and ended when its place is gone. A drag in progress follows its pointer instead. With no released
    /// selection the frame is not asked anything.
    pub fn selection_after_frame<S: SelectionIo + ?Sized>(&mut self, store: &mut S, now_ms: u64) {
        self.follow.scrolled = 0.0;
        self.follow.frame += 1;
        let Some((rect, _)) = self.released_selection() else { return };
        match self.place_selection(store) {
            Placed::Gone => self.apply_selection_rect(store, None, now_ms),
            Placed::Hidden => {
                self.follow.hidden = true;
                self.cancel_pending_selection_paint();
                self.paint_selection_rect(store, None, now_ms);
            }
            Placed::At(at, reads) => {
                self.follow.hidden = !reads;
                let clipped = self.with_selection_clip(Some(SelectionRect { y1: at[0], y2: at[1], ..rect }), false);
                self.drag.rect.clone_from(&clipped);
                self.cancel_pending_selection_paint();
                self.paint_selection_rect(store, clipped.filter(|_| reads), now_ms);
                self.selection_drawn(store, &rect, at);
            }
        }
    }

    /// What a copy gives: the text of the released selection as its content read when it was made.
    pub fn selected_text(&self) -> Option<String> {
        self.released_selection()?;
        self.follow.anchor.as_ref()?;
        self.follow.text.clone()
    }
}
