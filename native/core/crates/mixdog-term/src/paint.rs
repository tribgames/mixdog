//! The width-aware painter: styled text, fills, borders and the right-aligned hint, drawn into a [`Grid`] inside a clip
//! rectangle.
//!
//! This is the drawing half of what Ink's `output.js` and `render-border.js` did. Text may carry SGR and OSC 8
//! escapes (the markdown and highlight crates hand over ANSI strings); it is fitted to its width with the Ink wrap
//! modes of `mixdog_termtext::wrap::wrap_text`, and each grapheme cluster takes the cells of the display-width policy
//! (at least one: Ink gives a zero-width cluster a cell too). Text replaces what was in the cells under it, style
//! included, the way an Ink write does; nothing is drawn outside the clip, and a wide glyph the clip cuts through is
//! left out whole, so a half glyph never shows.

use mixdog_termtext::ansi::{AnsiToken, tokenize};
use mixdog_termtext::display_width;
use mixdog_termtext::grapheme::graphemes_with_widths;
use mixdog_termtext::wrap::{WrapMode, wrap_text};

use crate::frame::{Grid, Rect, Style, apply_sgr, parse_hyperlink};

/// How Ink fits text into its width (`wrap="wrap" | "hard" | "truncate-end" | "truncate-middle" | "truncate-start"`).
pub type TextWrap = WrapMode;

/// The glyphs of `cli-boxes` `round`.
const TOP_LEFT: &str = "\u{256d}";
const TOP_RIGHT: &str = "\u{256e}";
const BOTTOM_LEFT: &str = "\u{2570}";
const BOTTOM_RIGHT: &str = "\u{256f}";
const HORIZONTAL: &str = "\u{2500}";
const VERTICAL: &str = "\u{2502}";

/// A round border: the style of each side that is drawn (`None` leaves the side out, as `borderTop={false}` does).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct RoundBorder {
    pub top: Option<Style>,
    pub bottom: Option<Style>,
    pub left: Option<Style>,
    pub right: Option<Style>,
}

impl RoundBorder {
    /// All four sides in one style.
    pub fn all(style: Style) -> Self {
        Self { top: Some(style), bottom: Some(style), left: Some(style), right: Some(style) }
    }
}

/// Draws into a grid, inside a clip.
pub struct Painter<'g> {
    grid: &'g mut Grid,
    clip: Rect,
}

/// Which of the `total` rows `wrap_text` made of `text` continue the row above because the text wrapped there, not because
/// the text had a line break (the soft rows of Ink's `output.js`). Only the wrapping modes make them; a count that does not
/// agree with the wrapped text marks nothing.
fn soft_wrapped_rows(text: &str, max_width: usize, mode: TextWrap, total: usize) -> Vec<bool> {
    if !matches!(mode, TextWrap::Wrap | TextWrap::Hard) {
        return Vec::new();
    }
    let mut flags = Vec::with_capacity(total);
    for line in text.split('\n') {
        let rows = wrap_text(line, max_width, mode).split('\n').count();
        for row in 0..rows {
            flags.push(row > 0);
        }
    }
    if flags.len() == total { flags } else { Vec::new() }
}

impl<'g> Painter<'g> {
    /// A painter over the whole grid.
    pub fn new(grid: &'g mut Grid) -> Self {
        let clip = Rect::new(0, 0, grid.width, grid.height);
        Self { grid, clip }
    }

    /// A painter over the part of the grid inside `clip`.
    pub fn clipped(grid: &'g mut Grid, clip: Rect) -> Self {
        let whole = Rect::new(0, 0, grid.width, grid.height);
        Self { clip: clip.intersect(&whole), grid }
    }

    pub fn clip(&self) -> Rect {
        self.clip
    }

    /// Narrows the clip to its intersection with `rect` (nested `overflow="hidden"` boxes clip to the intersection of
    /// every ancestor) and returns the clip it replaced.
    pub fn push_clip(&mut self, rect: Rect) -> Rect {
        let previous = self.clip;
        self.clip = self.clip.intersect(&rect);
        previous
    }

    /// Restores a clip [`Painter::push_clip`] returned.
    pub fn pop_clip(&mut self, previous: Rect) {
        self.clip = previous;
    }

    pub fn grid(&self) -> &Grid {
        self.grid
    }

    /// Notes that row `y` of the grid continues the row above because a text wrapped there (the row is inside the clip).
    pub fn mark_soft_wrap(&mut self, y: i32) {
        if (i32::from(self.clip.y)..i32::from(self.clip.y) + i32::from(self.clip.height)).contains(&y) {
            self.grid.mark_soft_wrap(y);
        }
    }

    fn inside(&self, x: i32, y: i32) -> bool {
        x >= i32::from(self.clip.x) && y >= i32::from(self.clip.y) && (x as i64) < i64::from(self.clip.right()) && (y as i64) < i64::from(self.clip.bottom())
    }

    /// Fills a rectangle with blanks of one style (a box's background).
    pub fn fill(&mut self, rect: Rect, style: Style) {
        let area = rect.intersect(&self.clip);
        self.grid.fill(area, style);
    }

    /// Draws `text` with its top-left cell at `(x, y)`, fitted to `max_width` cells in `mode`, one line per row. `base`
    /// is the style the text starts in; escapes in the text change it. Returns the rows the text took.
    pub fn text(&mut self, x: i32, y: i32, text: &str, base: Style, max_width: usize, mode: TextWrap) -> u16 {
        // Ink fits a text only when its widest line is wider than the box (`render-node-to-output.js`): a text that fits is
        // written as it is, a carriage return before a line break included.
        let fits = text.split('\n').map(display_width).max().unwrap_or(0) <= max_width;
        let fitted = if fits { text.to_owned() } else { wrap_text(text, max_width, mode) };
        let soft = if fits { Vec::new() } else { soft_wrapped_rows(text, max_width, mode, fitted.split('\n').count()) };
        let clip_rows = i32::from(self.clip.y)..i32::from(self.clip.y) + i32::from(self.clip.height);
        let mut rows = 0u16;
        for (offset, line) in fitted.split('\n').enumerate() {
            let at_y = y + offset as i32;
            if soft.get(offset).copied().unwrap_or(false) && clip_rows.contains(&at_y) {
                self.grid.mark_soft_wrap(at_y);
            }
            match line.strip_suffix('\r').filter(|_| fits) {
                // chalk closes its styles before a `\r\n` and opens them again after it, so the carriage return is drawn
                // outside the text's own style (the box's background stays).
                Some(head) => {
                    let advanced = self.line(x, at_y, head, base);
                    let outside = Style { bg: base.bg, ..Style::default() };
                    self.glyph(x + advanced as i32, at_y, "\r", 1, outside, 0);
                }
                None => {
                    self.line(x, at_y, line, base);
                }
            }
            rows = rows.saturating_add(1);
        }
        rows
    }

    /// Draws one line (no line breaks) that may carry SGR and OSC 8 escapes. Returns the cells it advanced.
    pub fn line(&mut self, x: i32, y: i32, line: &str, base: Style) -> usize {
        let mut style = base;
        let mut link = 0u32;
        let mut at = x;
        for token in tokenize(line) {
            match token {
                AnsiToken::Escape(escape) => {
                    if let Some(body) = escape.strip_prefix("\x1b[").and_then(|rest| rest.strip_suffix('m')) {
                        let params: Vec<u16> = body.split([';', ':']).filter_map(|part| part.parse().ok()).collect();
                        apply_sgr(&mut style, &params);
                    } else if let Some(body) = escape.strip_prefix("\x1b]") {
                        let body = body.strip_suffix('\u{7}').or_else(|| body.strip_suffix("\x1b\\")).unwrap_or(body);
                        if let Some(url) = parse_hyperlink(body) {
                            link = if url.is_empty() { 0 } else { self.grid.intern_link(url) };
                        }
                    }
                }
                AnsiToken::Text(text) => {
                    for cluster in graphemes_with_widths(&text) {
                        let cells = cluster.width.clamp(1, 2);
                        self.glyph(at, y, cluster.text, cells, style, link);
                        at += cells as i32;
                    }
                }
            }
        }
        (at - x).max(0) as usize
    }

    /// One cluster, if every cell of it is inside the clip.
    fn glyph(&mut self, x: i32, y: i32, symbol: &str, cells: usize, style: Style, link: u32) {
        if self.inside(x, y) && self.inside(x + cells as i32 - 1, y) {
            self.grid.put_glyph(x, y, symbol, cells, style, link);
        }
    }

    /// Draws a round border along the edge of `rect`.
    pub fn border(&mut self, rect: Rect, border: &RoundBorder) {
        if rect.width == 0 || rect.height == 0 {
            return;
        }
        let (x, y) = (i32::from(rect.x), i32::from(rect.y));
        let (width, height) = (i32::from(rect.width), i32::from(rect.height));
        let inner = (width - i32::from(border.left.is_some()) - i32::from(border.right.is_some())).max(0) as usize;
        let horizontal = |left: Option<&'static str>, right: Option<&'static str>| -> Vec<&'static str> {
            let mut glyphs = Vec::new();
            glyphs.extend(left);
            glyphs.extend(std::iter::repeat_n(HORIZONTAL, inner));
            glyphs.extend(right);
            glyphs
        };
        let vertical_rows = height - i32::from(border.top.is_some()) - i32::from(border.bottom.is_some());
        let first_row = y + i32::from(border.top.is_some());
        if let Some(style) = border.top {
            let glyphs = horizontal(border.left.map(|_| TOP_LEFT), border.right.map(|_| TOP_RIGHT));
            for (at, glyph) in glyphs.into_iter().enumerate() {
                self.glyph(x + at as i32, y, glyph, 1, style, 0);
            }
        }
        if let Some(style) = border.left {
            for row in 0..vertical_rows.max(0) {
                self.glyph(x, first_row + row, VERTICAL, 1, style, 0);
            }
        }
        if let Some(style) = border.right {
            for row in 0..vertical_rows.max(0) {
                self.glyph(x + width - 1, first_row + row, VERTICAL, 1, style, 0);
            }
        }
        if let Some(style) = border.bottom {
            let glyphs = horizontal(border.left.map(|_| BOTTOM_LEFT), border.right.map(|_| BOTTOM_RIGHT));
            for (at, glyph) in glyphs.into_iter().enumerate() {
                self.glyph(x + at as i32, y + height - 1, glyph, 1, style, 0);
            }
        }
    }

    /// Overprints a right-aligned hint on an existing row, without taking a row: a box `box_width` cells wide with one
    /// cell of margin on each side, flush with the right edge of `area`, the text truncated at its end to fit and
    /// aligned to the box's right. Only the text's own cells are written; the row keeps everything else.
    pub fn overprint_hint(&mut self, row: u16, area: Rect, text: &str, box_width: u16, style: Style) {
        if text.is_empty() || row < area.y || u32::from(row) >= area.bottom() {
            return;
        }
        let box_width = usize::from(box_width.max(1));
        let fitted = wrap_text(text, box_width, WrapMode::TruncateEnd);
        let fitted = fitted.lines().next().unwrap_or("");
        let box_x = area.right() as i32 - 1 - box_width as i32;
        let shown = display_width(fitted).min(box_width);
        let start = box_x + (box_width - shown) as i32;
        let previous = self.push_clip(area);
        self.line(start, i32::from(row), fitted, style);
        self.pop_clip(previous);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::frame::{Color, Rgb};

    fn red() -> Style {
        Style { fg: Color::Indexed(1), ..Style::default() }
    }

    #[test]
    fn text_replaces_the_cells_under_it_and_escapes_change_the_style() {
        let mut grid = Grid::new(12, 2);
        grid.fill(Rect::new(0, 0, 12, 2), Style { bg: Color::Rgb(Rgb::new(9, 9, 9)), ..Style::default() });
        let mut painter = Painter::new(&mut grid);
        painter.line(1, 0, "ab\x1b[31mcd\x1b[0me", Style { bold: true, ..Style::default() });
        assert_eq!(grid.row_text(0).trim_end(), " abcde");
        assert!(grid.cell(1, 0).unwrap().style.bold);
        assert_eq!(grid.cell(1, 0).unwrap().style.bg, Color::Default);
        assert_eq!(grid.cell(3, 0).unwrap().style.fg, Color::Indexed(1));
        assert!(grid.cell(3, 0).unwrap().style.bold);
        assert_eq!(grid.cell(5, 0).unwrap().style, Style::default());
        assert_eq!(grid.cell(8, 0).unwrap().style.bg, Color::Rgb(Rgb::new(9, 9, 9)));
    }

    #[test]
    fn wide_glyphs_take_two_cells_and_a_clip_never_shows_half_of_one() {
        let mut grid = Grid::new(8, 1);
        let mut painter = Painter::clipped(&mut grid, Rect::new(1, 0, 4, 1));
        painter.line(0, 0, "日本語", Style::default());
        // 日 would cover cells 0 and 1: cut by the clip, left out. 本 covers 2 and 3, 語 would start at 4 and end at 5.
        assert_eq!(grid.cell(0, 0).unwrap().text(), " ");
        assert_eq!(grid.cell(1, 0).unwrap().text(), " ");
        assert_eq!(grid.cell(2, 0).unwrap().text(), "本");
        assert_eq!(grid.cell(2, 0).unwrap().width, 2);
        assert!(grid.cell(3, 0).unwrap().is_continuation());
        assert_eq!(grid.cell(4, 0).unwrap().text(), " ");
    }

    #[test]
    fn overwriting_half_of_a_wide_glyph_blanks_the_other_half() {
        let mut grid = Grid::new(6, 1);
        Painter::new(&mut grid).line(0, 0, "日本", Style::default());
        Painter::new(&mut grid).line(1, 0, "x", Style::default());
        assert_eq!(grid.row_text(0).trim_end(), " x本");
    }

    #[test]
    fn hyperlinks_in_text_become_cell_links() {
        let mut grid = Grid::new(8, 1);
        Painter::new(&mut grid).line(0, 0, "a\x1b]8;;http://h/\x07b\x1b]8;;\x07c", Style::default());
        let link = grid.cell(1, 0).unwrap().link;
        assert_eq!(grid.link_url(link), Some("http://h/"));
        assert_eq!(grid.cell(0, 0).unwrap().link, 0);
        assert_eq!(grid.cell(2, 0).unwrap().link, 0);
    }

    #[test]
    fn long_text_wraps_and_truncates_by_mode() {
        let mut grid = Grid::new(10, 4);
        let mut painter = Painter::new(&mut grid);
        let rows = painter.text(0, 0, "aaaa bbbb cccc", Style::default(), 9, TextWrap::Wrap);
        assert_eq!(rows, 2);
        assert_eq!(grid.row_text(0).trim_end(), "aaaa bbbb");
        // Ink wraps with trim off: the space the line broke at opens the next row.
        assert_eq!(grid.row_text(1).trim_end(), " cccc");
        let mut painter = Painter::new(&mut grid);
        let rows = painter.text(0, 2, "0123456789abcdef", Style::default(), 8, TextWrap::TruncateEnd);
        assert_eq!(rows, 1);
        assert_eq!(grid.row_text(2).trim_end(), "0123456\u{2026}");
    }

    #[test]
    fn a_round_border_with_all_sides_and_with_the_top_left_out() {
        let mut grid = Grid::new(6, 4);
        Painter::new(&mut grid).border(Rect::new(0, 0, 6, 4), &RoundBorder::all(red()));
        assert_eq!(grid.row_text(0), "\u{256d}\u{2500}\u{2500}\u{2500}\u{2500}\u{256e}");
        assert_eq!(grid.row_text(1), "\u{2502}    \u{2502}");
        assert_eq!(grid.row_text(3), "\u{2570}\u{2500}\u{2500}\u{2500}\u{2500}\u{256f}");
        assert_eq!(grid.cell(0, 1).unwrap().style, red());
        let mut grid = Grid::new(5, 3);
        let border = RoundBorder { top: None, bottom: Some(red()), left: Some(red()), right: None };
        Painter::new(&mut grid).border(Rect::new(0, 0, 5, 3), &border);
        assert_eq!(grid.row_text(0).trim_end(), "\u{2502}");
        assert_eq!(grid.row_text(2), "\u{2570}\u{2500}\u{2500}\u{2500}\u{2500}");
    }

    #[test]
    fn a_hint_overprints_a_row_flush_right_with_a_margin_and_keeps_the_rest() {
        let mut grid = Grid::new(30, 2);
        let mut painter = Painter::new(&mut grid);
        painter.line(0, 1, "turn finished", Style::default());
        painter.overprint_hint(1, Rect::new(0, 0, 30, 2), "12.3s", 10, red());
        // The box spans cells 19..29 (a margin cell at 29), the text is right-aligned in it.
        assert_eq!(grid.row_text(1).trim_end(), format!("turn finished{}12.3s", " ".repeat(11)));
        assert_eq!(grid.cell(24, 1).unwrap().text(), "1");
        assert_eq!(grid.cell(24, 1).unwrap().style, red());
        assert_eq!(grid.row_text(0).trim_end(), "");
    }
}
