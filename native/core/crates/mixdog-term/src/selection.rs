//! Text selection over the grid, ported from the Ink fork: the selection overlay and the text harvest of
//! `output.js`, the word bounds of `selection-rect.js`, the line bounds and the cached results of `ink.js`
//! (`setSelection`, `getSelectionText`, `getSelectionRows`, `getWordRectAt`, `getLineRectAt`), and the paint queue of
//! `use-selection-paint.mjs` and `use-selection-paint/paint-queue.mjs`.
//!
//! A selection is a rectangle in absolute screen cells with a mode. The overlay replaces only the background of the
//! selected cells with one colour and keeps each cell's own foreground and attributes (so syntax colours, links and
//! dim text stay readable), and blank cells inherit the colour run to their left so the highlight is one uniform
//! run. The harvest reads the selected cells row by row: trailing blanks are trimmed, rows that are word-wrap
//! continuations of the row above are rejoined without a line break, and blank rows at either end are dropped.

use mixdog_js::{is_js_space, js_trim, js_trim_end};

use crate::frame::{Cell, Color, Grid, Rgb, Style};

/// How often a moving selection is repainted (`SELECTION_PAINT_INTERVAL_MS`).
pub const SELECTION_PAINT_INTERVAL_MS: u64 = 24;

/// The colour of the highlight when the theme gives none Ink can read (a light grey close to Windows Terminal's own).
pub const DEFAULT_SELECTION_BACKGROUND: Rgb = Rgb::new(245, 245, 245);

/// An inclusive rectangle of cells (`{x1, y1, x2, y2}`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CellSpan {
    pub x1: i32,
    pub y1: i32,
    pub x2: i32,
    pub y2: i32,
}

/// The shape of a selection.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SelectionMode {
    /// From the anchor to the focus along the text: the first row from the anchor to its end, the middle rows whole,
    /// the last row from its start to the focus.
    Linear,
    /// The rectangle between the two corners.
    Block,
}

/// The rectangle a drag selects, in absolute screen cells (`setSelection`'s argument).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SelectionRect {
    pub mode: SelectionMode,
    pub x1: i32,
    pub y1: i32,
    pub x2: i32,
    pub y2: i32,
    /// The first and last rows the highlight may touch.
    pub clip_y1: Option<i32>,
    pub clip_y2: Option<i32>,
    /// Whether the text under the rectangle is read back (off while a drag is still moving).
    pub capture_text: bool,
    /// The highlight colour.
    pub background: Rgb,
}

impl SelectionRect {
    /// A linear or block selection with the default highlight, the whole screen as its clip, and text capture on.
    pub fn new(mode: SelectionMode, x1: i32, y1: i32, x2: i32, y2: i32) -> Self {
        Self {
            mode,
            x1,
            y1,
            x2,
            y2,
            clip_y1: None,
            clip_y2: None,
            capture_text: true,
            background: DEFAULT_SELECTION_BACKGROUND,
        }
    }

    /// Whether two rectangles select the same region (`selectionRectsEqual`: the colours do not count).
    pub fn same_region(&self, other: &SelectionRect) -> bool {
        self.mode == other.mode
            && self.x1 == other.x1
            && self.y1 == other.y1
            && self.x2 == other.x2
            && self.y2 == other.y2
            && self.clip_y1 == other.clip_y1
            && self.clip_y2 == other.clip_y2
            && self.capture_text == other.capture_text
    }
}

/// `rgbStyle`: the colour of an `rgb(r, g, b)` value (each channel clamped to 0 to 255), or the default highlight for
/// anything else.
pub fn selection_background(value: &str) -> Rgb {
    parse_css_rgb(value).unwrap_or(DEFAULT_SELECTION_BACKGROUND)
}

/// `^rgb\(\s*(\d{1,3}),\s*(\d{1,3}),\s*(\d{1,3})\s*\)$`
fn parse_css_rgb(value: &str) -> Option<Rgb> {
    let inner = value.strip_prefix("rgb(")?.strip_suffix(')')?;
    let parts: Vec<&str> = inner.split(',').collect();
    if parts.len() != 3 {
        return None;
    }
    let mut channels = [0u8; 3];
    for (at, part) in parts.into_iter().enumerate() {
        let part = part.trim_start_matches(is_js_space);
        let part = if at == 2 { part.trim_end_matches(is_js_space) } else { part };
        if part.is_empty() || part.len() > 3 || !part.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        channels[at] = part.parse::<u16>().ok()?.min(255) as u8;
    }
    Some(Rgb::new(channels[0], channels[1], channels[2]))
}

/// One harvested row: its absolute screen row, its text, and whether the row is a word-wrap continuation of the row
/// above.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SelectedRow {
    pub y: i32,
    pub text: String,
    pub soft_wrap: bool,
}

/// What reading a selection gives back.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SelectionHarvest {
    /// The text of the selection; `None` when the rectangle does not capture text (the earlier text stays).
    pub text: Option<String>,
    /// The per-row harvest, outer blank rows dropped, kept even when text capture is off so a selection taller than
    /// the viewport can be stitched.
    pub rows: Vec<SelectedRow>,
}

/// Applies the highlight of `rect` to `grid` and reads the selected text. `soft_wrap[y]` says that row `y` continues
/// the row above because the text wrapped at a word.
pub fn apply_selection(grid: &mut Grid, soft_wrap: &[bool], rect: &SelectionRect) -> SelectionHarvest {
    let height = i32::from(grid.height);
    let width = i32::from(grid.width);
    let linear = rect.mode == SelectionMode::Linear;
    let backwards = linear && (rect.y1 > rect.y2 || (rect.y1 == rect.y2 && rect.x1 > rect.x2));
    let (start, end) = if backwards { ((rect.x2, rect.y2), (rect.x1, rect.y1)) } else { ((rect.x1, rect.y1), (rect.x2, rect.y2)) };
    let clip_y1 = rect.clip_y1.unwrap_or(0);
    let clip_y2 = rect.clip_y2.unwrap_or(height - 1);
    let y1 = clip_y1.max(0).max(if linear { start.1 } else { rect.y1.min(rect.y2) });
    let y2 = (height - 1).min(clip_y2).min(if linear { end.1 } else { rect.y1.max(rect.y2) });
    let line_mode = linear && y1 != y2;
    let highlight = Color::Literal(rect.background);
    let wraps = |y: i32| usize::try_from(y).ok().and_then(|at| soft_wrap.get(at)).copied().unwrap_or(false);

    let mut rows: Vec<SelectedRow> = Vec::new();
    for y in y1..=y2 {
        let sw = wraps(y);
        let (raw_x1, raw_x2) = if linear {
            if line_mode {
                (if y == start.1 { start.0 } else { 0 }, if y == end.1 { end.0 } else { width - 1 })
            } else {
                (start.0.min(end.0), start.0.max(end.0))
            }
        } else {
            (rect.x1.min(rect.x2), rect.x1.max(rect.x2))
        };
        let x1 = raw_x1.min(raw_x2).max(0);
        let x2 = (width - 1).min(raw_x1.max(raw_x2));
        let mut text = String::new();
        // The foreground and attributes of the last styled cell of the row, for blank cells that carry none.
        let mut carry = Style::default();
        let cells = grid.row_mut(y as u16);
        for x in x1..=x2 {
            let Some(cell) = cells.get_mut(x as usize) else { break };
            text.push_str(cell.text());
            // A hyperlink is a style entry in Ink's cells, so a cell that carries only a link counts as styled
            // (and, like every other cell of the row, keeps its own link: a blank cell never takes a neighbour's).
            let kept = Style { bg: Color::Default, inverse: false, ..cell.style };
            let styled = kept.has_foreground_or_attribute() || cell.link != 0;
            if styled {
                carry = kept;
            }
            let effective = if styled || !js_trim(cell.text()).is_empty() { kept } else { carry };
            cell.style = Style { bg: highlight, inverse: false, ..effective };
        }
        let next_continues = y < y2 && wraps(y + 1);
        let trimmed = js_trim_end(&text);
        let text = if next_continues && trimmed.len() < text.len() {
            format!("{trimmed} ")
        } else {
            trimmed.to_owned()
        };
        rows.push(SelectedRow { y, text, soft_wrap: sw });
    }
    while rows.first().is_some_and(|row| js_trim(&row.text).is_empty()) {
        rows.remove(0);
    }
    while rows.last().is_some_and(|row| js_trim(&row.text).is_empty()) {
        rows.pop();
    }
    let text = rect.capture_text.then(|| {
        let mut logical: Vec<String> = Vec::new();
        for row in &rows {
            match logical.last_mut() {
                Some(last) if row.soft_wrap => last.push_str(&row.text),
                _ => logical.push(row.text.clone()),
            }
        }
        logical.iter().map(|line| js_trim_end(line)).collect::<Vec<_>>().join("\n")
    });
    SelectionHarvest { text, rows }
}

/// What Ink's instance holds about the selection between renders: the rectangle, the text under it as of the last
/// render, and the per-row harvest.
#[derive(Clone, Debug, Default)]
pub struct SelectionState {
    rect: Option<SelectionRect>,
    text: Option<String>,
    rows: Option<Vec<SelectedRow>>,
}

impl SelectionState {
    /// `setSelection`: returns whether the rectangle changed (an equal one is a no-op, so no frame is requested).
    pub fn set_selection(&mut self, rect: Option<SelectionRect>) -> bool {
        if self.rect == rect {
            return false;
        }
        self.rect = rect;
        true
    }

    pub fn selection(&self) -> Option<&SelectionRect> {
        self.rect.as_ref()
    }

    /// Called on every render with the frame's grid before it is written: applies the highlight and refreshes the
    /// cached text and rows. A rectangle that does not capture text leaves the cached text as it was; no rectangle
    /// clears both.
    pub fn apply(&mut self, grid: &mut Grid, soft_wrap: &[bool]) {
        match self.rect {
            Some(rect) => {
                let harvest = apply_selection(grid, soft_wrap, &rect);
                if let Some(text) = harvest.text {
                    self.text = Some(text);
                }
                self.rows = Some(harvest.rows);
            }
            None => {
                self.text = None;
                self.rows = None;
            }
        }
    }

    /// `getSelectionText`: the text under the selection as of the last render.
    pub fn selection_text(&self) -> Option<&str> {
        self.text.as_deref()
    }

    /// `getSelectionRows`: the per-row harvest of the last render.
    pub fn selection_rows(&self) -> Option<&[SelectedRow]> {
        self.rows.as_deref()
    }
}

// ---- word and line bounds ----------------------------------------------------------------------------------------

/// What a cell holds, for finding where a word ends.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CellClass {
    Blank,
    Word,
    Symbol,
}

/// The punctuation terminals count as word-forming by default (iTerm2's set) and the backslash, for Windows paths.
const WORD_PUNCTUATION: [char; 7] = ['_', '/', '.', '-', '+', '~', '\\'];

/// Blank (empty or a space), word-forming (a letter or digit, or a glyph carrying word punctuation), or a symbol.
pub fn cell_class(value: Option<&str>) -> CellClass {
    let Some(value) = value.filter(|v| !v.is_empty() && *v != " ") else { return CellClass::Blank };
    if value.chars().any(|c| c.is_alphabetic() || c.is_numeric() || WORD_PUNCTUATION.contains(&c)) {
        CellClass::Word
    } else {
        CellClass::Symbol
    }
}

fn value(cells: &[Cell], column: i32) -> Option<&str> {
    usize::try_from(column).ok().and_then(|at| cells.get(at)).map(Cell::text)
}

/// The glyph occupying `column` as inclusive head and tail columns. A continuation cell is an empty cell directly
/// after a non-blank glyph; any other empty cell is padding and stands alone.
fn glyph_at(cells: &[Cell], column: i32) -> (i32, i32) {
    let continues = |index: i32| index > 0 && value(cells, index) == Some("") && cell_class(value(cells, index - 1)) != CellClass::Blank;
    let head = if continues(column) { column - 1 } else { column };
    (head, if continues(head + 1) { head + 1 } else { head })
}

/// `wordRectAt`: the inclusive rectangle of the word at `(x, y)`, or `None` for a blank cell or one out of range.
/// Expansion stops where the cell class changes, in whole glyphs, so a wide character is never split.
pub fn word_rect_at(grid: &Grid, x: i32, y: i32) -> Option<CellSpan> {
    let cells = grid.row(u16::try_from(y).ok()?);
    if cells.is_empty() {
        return None;
    }
    let origin = glyph_at(cells, x);
    let word_class = cell_class(value(cells, origin.0));
    if word_class == CellClass::Blank {
        return None;
    }
    let mut first = origin.0;
    while first > 0 {
        let previous = glyph_at(cells, first - 1);
        if cell_class(value(cells, previous.0)) != word_class {
            break;
        }
        first = previous.0;
    }
    let mut last = origin.1;
    while last + 1 < cells.len() as i32 {
        let next = glyph_at(cells, last + 1);
        if cell_class(value(cells, next.0)) != word_class {
            break;
        }
        last = next.1;
    }
    Some(CellSpan { x1: first, y1: y, x2: last, y2: y })
}

/// `getLineRectAt`: the rectangle from column 0 to the last cell that is not blank on row `y`, or `None` for a blank
/// or missing row.
pub fn line_rect_at(grid: &Grid, y: i32) -> Option<CellSpan> {
    let cells = grid.row(u16::try_from(y).ok()?);
    let is_blank = |text: &str| {
        let mut chars = text.chars();
        text.is_empty() || matches!((chars.next(), chars.next()), (Some(c), None) if is_js_space(c))
    };
    let x2 = cells.iter().rposition(|cell| !is_blank(cell.text()))?;
    Some(CellSpan { x1: 0, y1: y, x2: x2 as i32, y2: y })
}

// ---- the paint queue ---------------------------------------------------------------------------------------------

/// What publishing a selection rectangle asks of the renderer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PaintPublish {
    /// The rectangle to hand to the renderer (`None` clears the highlight).
    pub rect: Option<SelectionRect>,
    /// Read the selected text after the frame that paints it.
    pub remember_text: bool,
    /// Harvest the rows of the selection for stitching.
    pub harvest_stitch: bool,
}

/// What a throttled paint request comes to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Throttle {
    /// The rectangle is the one already painted.
    Unchanged,
    /// The interval had passed: paint now (`None` when publishing found nothing to do).
    Paint(Option<PaintPublish>),
    /// The rectangle waits for the trailing timer; the delay is set when this request armed it.
    Wait(Option<u64>),
}

/// The state machine behind `useSelectionPaint`: publishing a rectangle, and the motion throttle with its cancel and
/// flush guards. Time is milliseconds on any monotonic clock.
#[derive(Clone, Debug)]
pub struct PaintQueue {
    interval_ms: u64,
    rect: Option<SelectionRect>,
    painted_at: Option<u64>,
    pending: Option<SelectionRect>,
    timer_armed: bool,
}

impl Default for PaintQueue {
    fn default() -> Self {
        Self::new(SELECTION_PAINT_INTERVAL_MS)
    }
}

impl PaintQueue {
    pub fn new(interval_ms: u64) -> Self {
        Self { interval_ms, rect: None, painted_at: None, pending: None, timer_armed: false }
    }

    /// The rectangle last published.
    pub fn rect(&self) -> Option<&SelectionRect> {
        self.rect.as_ref()
    }

    /// Whether the trailing timer is armed (the caller owns the timer: it calls [`PaintQueue::fire_timer`]).
    pub fn timer_armed(&self) -> bool {
        self.timer_armed
    }

    /// `publishSelectionRect`: publishes `rect` (or the clear). Returns what the renderer is to do, `None` when the
    /// rectangle is the published one and no text capture is wanted.
    pub fn publish(&mut self, rect: Option<SelectionRect>, remember_text: bool, now_ms: u64) -> Option<PaintPublish> {
        let captures = rect.as_ref().is_some_and(|r| remember_text && r.capture_text);
        let equal = match (&self.rect, &rect) {
            (None, None) => true,
            (Some(a), Some(b)) => a.same_region(b),
            _ => false,
        };
        if equal {
            return captures.then_some(PaintPublish { rect, remember_text: true, harvest_stitch: true });
        }
        self.rect.clone_from(&rect);
        self.painted_at = Some(now_ms);
        let harvest_stitch = rect.is_some();
        Some(PaintPublish { rect, remember_text: captures, harvest_stitch })
    }

    /// `cancelPendingPaint`: drops the waiting rectangle and the timer, before any direct paint, so a stale rectangle
    /// cannot land over the current one.
    pub fn cancel_pending(&mut self) {
        self.timer_armed = false;
        self.pending = None;
    }

    /// `flushPendingPaint`: publishes a waiting rectangle now (without reading its text), so the next frame carries
    /// the newest rectangle of a fast drag.
    pub fn flush_pending(&mut self, now_ms: u64) -> Option<PaintPublish> {
        if !self.timer_armed && self.pending.is_none() {
            return None;
        }
        let pending = self.pending.take();
        self.timer_armed = false;
        pending.and_then(|rect| self.publish(Some(rect), false, now_ms))
    }

    /// `scheduleThrottledPaint`: paints now when the interval has passed since the last paint, otherwise keeps the
    /// rectangle for the trailing timer.
    pub fn schedule_throttled(&mut self, rect: Option<SelectionRect>, now_ms: u64) -> Throttle {
        let equal = match (&self.rect, &rect) {
            (None, None) => true,
            (Some(a), Some(b)) => a.same_region(b),
            _ => false,
        };
        if equal {
            return Throttle::Unchanged;
        }
        let elapsed = self.painted_at.map_or(u64::MAX, |at| now_ms.saturating_sub(at));
        if elapsed >= self.interval_ms {
            self.cancel_pending();
            return Throttle::Paint(self.publish(rect, false, now_ms));
        }
        self.pending = rect;
        if self.timer_armed {
            return Throttle::Wait(None);
        }
        self.timer_armed = true;
        Throttle::Wait(Some((self.interval_ms - elapsed).max(1)))
    }

    /// The trailing timer fired: publishes what was waiting (a waiting clear included).
    pub fn fire_timer(&mut self, now_ms: u64) -> Option<PaintPublish> {
        let pending = self.pending.take();
        self.timer_armed = false;
        self.publish(pending, false, now_ms)
    }
}

/// `clipSelectionRect`: the rectangle as the renderer takes it, clipped to the row band `(top, bottom)` of the region
/// being dragged and carrying the theme's highlight colour; `suppress_capture` is the `captureText: false` option.
pub fn clip_selection_rect(rect: &SelectionRect, band: (i32, i32), background: Rgb, suppress_capture: bool) -> SelectionRect {
    SelectionRect {
        clip_y1: Some(band.0),
        clip_y2: Some(band.0.max(band.1)),
        background,
        capture_text: if suppress_capture { false } else { rect.capture_text },
        ..*rect
    }
}

#[cfg(test)]
mod tests {
    use mixdog_termtext::grapheme::graphemes_with_widths;

    use super::*;

    fn grid_of(width: u16, lines: &[&str]) -> Grid {
        let mut grid = Grid::new(width, lines.len() as u16);
        for (y, line) in lines.iter().enumerate() {
            let mut x = 0;
            for g in graphemes_with_widths(line) {
                let cells = g.width.clamp(1, 2);
                grid.put_glyph(x, y as i32, g.text, cells, Style::default(), 0);
                x += cells as i32;
            }
        }
        grid
    }

    fn rect(mode: SelectionMode, x1: i32, y1: i32, x2: i32, y2: i32) -> SelectionRect {
        SelectionRect::new(mode, x1, y1, x2, y2)
    }

    #[test]
    fn a_linear_selection_rejoins_wrapped_rows_trims_padding_and_keeps_inner_blank_rows() {
        let mut grid = grid_of(20, &["alpha beta", "gamma", "", "tail"]);
        let harvest = apply_selection(&mut grid, &[false, true, false, false], &rect(SelectionMode::Linear, 0, 0, 19, 3));
        assert_eq!(harvest.text.as_deref(), Some("alpha beta gamma\n\ntail"));
        let rows: Vec<(i32, &str, bool)> = harvest.rows.iter().map(|r| (r.y, r.text.as_str(), r.soft_wrap)).collect();
        assert_eq!(rows, vec![(0, "alpha beta ", false), (1, "gamma", true), (2, "", false), (3, "tail", false)]);
        for x in [0, 5, 19] {
            assert_eq!(grid.cell(x, 0).unwrap().style.bg, Color::Literal(DEFAULT_SELECTION_BACKGROUND));
        }
    }

    #[test]
    fn a_block_selection_takes_the_columns_between_the_corners() {
        let mut grid = grid_of(8, &["abcdef", "ghijkl"]);
        let harvest = apply_selection(&mut grid, &[], &rect(SelectionMode::Block, 3, 1, 1, 0));
        assert_eq!(harvest.text.as_deref(), Some("bcd\nhij"));
        assert_eq!(grid.cell(0, 0).unwrap().style.bg, Color::Default);
        assert_eq!(grid.cell(4, 1).unwrap().style.bg, Color::Default);
    }

    #[test]
    fn a_backwards_linear_selection_reads_like_a_forwards_one() {
        let lines = ["0123456789", "abcdefghij"];
        let forwards = apply_selection(&mut grid_of(10, &lines), &[], &rect(SelectionMode::Linear, 2, 0, 5, 1));
        let backwards = apply_selection(&mut grid_of(10, &lines), &[], &rect(SelectionMode::Linear, 5, 1, 2, 0));
        assert_eq!(forwards.text.as_deref(), Some("23456789\nabcdef"));
        assert_eq!(forwards, backwards);
    }

    #[test]
    fn a_wide_glyph_counts_once_and_its_second_half_adds_nothing() {
        let mut grid = grid_of(8, &["日本語"]);
        let harvest = apply_selection(&mut grid, &[], &rect(SelectionMode::Block, 2, 0, 3, 0));
        assert_eq!(harvest.text.as_deref(), Some("本"));
        let mut grid = grid_of(8, &["日本語"]);
        let harvest = apply_selection(&mut grid, &[], &rect(SelectionMode::Block, 3, 0, 3, 0));
        assert_eq!(harvest.text.as_deref(), Some(""));
        assert!(harvest.rows.is_empty());
    }

    #[test]
    fn the_overlay_replaces_the_background_keeps_the_foreground_and_carries_it_across_blanks() {
        let mut grid = Grid::new(6, 1);
        let red_bold_on_blue = Style { fg: Color::Indexed(1), bold: true, bg: Color::Indexed(4), inverse: true, ..Style::default() };
        grid.put_glyph(0, 0, "a", 1, red_bold_on_blue, 0);
        grid.put_glyph(2, 0, "z", 1, Style::default(), 0);
        apply_selection(&mut grid, &[], &rect(SelectionMode::Block, 0, 0, 3, 0));
        let a = grid.cell(0, 0).unwrap().style;
        assert_eq!((a.fg, a.bold, a.inverse, a.bg), (Color::Indexed(1), true, false, Color::Literal(DEFAULT_SELECTION_BACKGROUND)));
        // The blank after it inherits the run; a visible glyph with no style is never recoloured.
        assert_eq!(grid.cell(1, 0).unwrap().style.fg, Color::Indexed(1));
        assert_eq!(grid.cell(2, 0).unwrap().style.fg, Color::Default);
        assert!(!grid.cell(2, 0).unwrap().style.bold);
    }

    #[test]
    fn the_clip_limits_the_rows_and_a_capture_free_rectangle_still_harvests_rows() {
        let mut grid = grid_of(6, &["one", "two", "six"]);
        let mut clipped = rect(SelectionMode::Block, 0, 0, 5, 2);
        clipped.clip_y1 = Some(1);
        clipped.clip_y2 = Some(1);
        clipped.capture_text = false;
        let harvest = apply_selection(&mut grid, &[], &clipped);
        assert_eq!(harvest.text, None);
        assert_eq!(harvest.rows.len(), 1);
        assert_eq!(harvest.rows[0].text, "two");
        assert_eq!(grid.cell(0, 0).unwrap().style.bg, Color::Default);
    }

    #[test]
    fn the_state_keeps_its_text_while_a_rectangle_does_not_capture_and_clears_with_no_rectangle() {
        let mut state = SelectionState::default();
        let mut grid = grid_of(6, &["hello"]);
        assert!(state.set_selection(Some(rect(SelectionMode::Block, 0, 0, 4, 0))));
        assert!(!state.set_selection(Some(rect(SelectionMode::Block, 0, 0, 4, 0))));
        state.apply(&mut grid, &[]);
        assert_eq!(state.selection_text(), Some("hello"));
        let mut moving = rect(SelectionMode::Block, 0, 0, 2, 0);
        moving.capture_text = false;
        state.set_selection(Some(moving));
        state.apply(&mut grid, &[]);
        assert_eq!(state.selection_text(), Some("hello"));
        assert_eq!(state.selection_rows().map(<[_]>::len), Some(1));
        state.set_selection(None);
        state.apply(&mut grid, &[]);
        assert_eq!((state.selection_text(), state.selection_rows()), (None, None));
    }

    #[test]
    fn word_bounds_stop_at_a_class_change_and_never_split_a_wide_glyph() {
        let grid = grid_of(24, &["see foo-bar/x.rs (ok)", "日本語 x"]);
        let span = |x1, x2| Some(CellSpan { x1, y1: 0, x2, y2: 0 });
        assert_eq!(word_rect_at(&grid, 6, 0), span(4, 15));
        assert_eq!(word_rect_at(&grid, 3, 0), None);
        let wide = |x, want: Option<(i32, i32)>| {
            assert_eq!(word_rect_at(&grid, x, 1), want.map(|(x1, x2)| CellSpan { x1, y1: 1, x2, y2: 1 }), "x={x}");
        };
        wide(0, Some((0, 5)));
        wide(1, Some((0, 5)));
        wide(5, Some((0, 5)));
        wide(6, None);
        wide(7, Some((7, 7)));
        assert_eq!(word_rect_at(&grid, 99, 1), None);
        assert_eq!(word_rect_at(&grid, 0, 9), None);
        assert_eq!(word_rect_at(&grid, -1, 0), None);
    }

    #[test]
    fn line_bounds_run_to_the_last_cell_that_is_not_blank() {
        let grid = grid_of(10, &["  hi  ", "", "日本"]);
        assert_eq!(line_rect_at(&grid, 0), Some(CellSpan { x1: 0, y1: 0, x2: 3, y2: 0 }));
        assert_eq!(line_rect_at(&grid, 1), None);
        assert_eq!(line_rect_at(&grid, 2), Some(CellSpan { x1: 0, y1: 2, x2: 2, y2: 2 }));
        assert_eq!(line_rect_at(&grid, 7), None);
    }

    #[test]
    fn the_highlight_colour_is_read_from_rgb_text_and_falls_back() {
        assert_eq!(selection_background("rgb(10, 20,30)"), Rgb::new(10, 20, 30));
        assert_eq!(selection_background("rgb( 1,2, 999 )"), Rgb::new(1, 2, 255));
        assert_eq!(selection_background("#102030"), DEFAULT_SELECTION_BACKGROUND);
        assert_eq!(selection_background("rgb(1 ,2,3)"), DEFAULT_SELECTION_BACKGROUND);
        assert_eq!(selection_background("rgb(1,2)"), DEFAULT_SELECTION_BACKGROUND);
    }

    #[test]
    fn the_paint_queue_publishes_throttles_and_flushes() {
        let a = rect(SelectionMode::Linear, 0, 0, 5, 0);
        let b = rect(SelectionMode::Linear, 0, 0, 6, 0);
        let c = rect(SelectionMode::Linear, 0, 0, 7, 0);
        let mut queue = PaintQueue::default();
        let first = queue.publish(Some(a), true, 100).unwrap();
        assert!(first.remember_text && first.harvest_stitch);
        assert_eq!(queue.publish(Some(a), false, 101), None);
        assert!(queue.publish(Some(a), true, 102).is_some_and(|p| p.remember_text && p.harvest_stitch));
        // Inside the interval the rectangle waits for the trailing timer; a later one replaces it.
        assert_eq!(queue.schedule_throttled(Some(b), 110), Throttle::Wait(Some(14)));
        assert_eq!(queue.schedule_throttled(Some(c), 112), Throttle::Wait(None));
        assert_eq!(queue.schedule_throttled(Some(a), 113), Throttle::Unchanged);
        let fired = queue.fire_timer(124).unwrap();
        assert_eq!(fired.rect, Some(c));
        assert!(!fired.remember_text && fired.harvest_stitch);
        assert!(!queue.timer_armed());
        // After the interval the paint is direct and drops anything waiting.
        queue.schedule_throttled(Some(b), 130);
        assert!(queue.timer_armed());
        assert!(matches!(queue.schedule_throttled(Some(a), 200), Throttle::Paint(Some(_))));
        assert!(!queue.timer_armed());
        // A flush publishes the waiting rectangle at once; a clear that waits is published by the timer.
        queue.schedule_throttled(Some(c), 205);
        assert_eq!(queue.flush_pending(206).map(|p| p.rect), Some(Some(c)));
        assert_eq!(queue.flush_pending(207), None);
        queue.schedule_throttled(None, 210);
        assert_eq!(queue.fire_timer(230).map(|p| p.rect), Some(None));
        assert_eq!(queue.rect(), None);
    }

    #[test]
    fn a_rectangle_is_clipped_to_the_band_of_its_region() {
        let base = rect(SelectionMode::Linear, 1, 2, 3, 4);
        let clipped = clip_selection_rect(&base, (5, 3), Rgb::new(1, 2, 3), true);
        assert_eq!((clipped.clip_y1, clipped.clip_y2), (Some(5), Some(5)));
        assert_eq!((clipped.background, clipped.capture_text), (Rgb::new(1, 2, 3), false));
        assert!(clip_selection_rect(&base, (0, 9), Rgb::new(1, 2, 3), false).capture_text);
    }
}
