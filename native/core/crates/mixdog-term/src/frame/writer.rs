//! The frame writer: a grid in, the bytes that turn the screen into it out.
//!
//! The screen is addressed by absolute position, never by a walk relative to where the cursor rests, so a row that
//! did not change is simply not written and the cursor origin cannot drift (what the Windows consoles' scrolling
//! desynchronised in Ink's relative walk). Only runs of changed cells are written, each after a cursor move to its
//! first cell; a changed row whose tail is blank ends in an erase to the end of the line; the style is reset before
//! every erase and at the end of the frame, and a hyperlink is closed around runs of equal link. A frame that changed
//! anything is wrapped in a synchronized update (`ESC [ ? 2026 h` ... `ESC [ ? 2026 l`), and the hardware cursor is
//! hidden while the frame is drawn and then shown at the requested cell (where terminals anchor IME composition) or
//! left hidden.
//!
//! Colours are written at the level the session was started with (`mixdog_tui_style::color_level`, detected once at
//! start as chalk does at import): truecolor, the nearest 256-colour or 16-colour entry, or none.

use std::io::{self, Write};

use mixdog_termtext::{StringWidthOptions, string_width};
use mixdog_tui_style::color::{BG_CLOSE, BOLD_OPEN, DIM_OPEN, FG_CLOSE};

use super::{Cell, Color, Grid, Rgb, Style};

const BEGIN_SYNCHRONIZED: &str = "\x1b[?2026h";
const END_SYNCHRONIZED: &str = "\x1b[?2026l";
const HIDE_CURSOR: &str = "\x1b[?25l";
const SHOW_CURSOR: &str = "\x1b[?25h";
const RESET: &str = "\x1b[0m";
const ERASE_LINE_END: &str = "\x1b[K";
const ERASE_LINE: &str = "\x1b[2K";
/// ansi-escapes `clearTerminal`: erase the screen and the scrollback, home the cursor.
const CLEAR_TERMINAL: &str = "\x1b[2J\x1b[3J\x1b[H";
const LINK_CLOSE: &str = "\x1b]8;;\x1b\\";
/// Unchanged cells between two changed ones that are written over rather than skipped with a cursor move.
const MERGE_GAP: usize = 3;

/// Where the hardware cursor goes: 0-based cell.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CursorPos {
    pub col: u16,
    pub row: u16,
}

/// What one frame cost.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct WriteStats {
    pub bytes: usize,
}

/// What the screen is known to hold, row by row.
#[derive(Clone, Copy)]
enum Base<'a> {
    /// Nothing is known (the first frame): every cell is written.
    Unknown,
    /// The screen was just cleared.
    Blank,
    /// The last frame.
    Previous(&'a Grid),
}

/// Writes frames to a terminal as minimal diffs.
pub struct FrameWriter<W: Write> {
    out: W,
    level: i32,
    synchronized: bool,
    previous: Option<Grid>,
    previous_cursor: Option<CursorPos>,
    cursor_visible: Option<bool>,
    clear_next: bool,
}

impl<W: Write> FrameWriter<W> {
    /// A writer at a colour level (0 none, 1 sixteen colours, 2 256 colours, 3 truecolor). Frames are wrapped in a
    /// synchronized update.
    pub fn new(out: W, color_level: i32) -> Self {
        Self {
            out,
            level: color_level,
            synchronized: true,
            previous: None,
            previous_cursor: None,
            cursor_visible: None,
            clear_next: false,
        }
    }

    /// Whether frames are wrapped in a synchronized update (off for a stream that is not a terminal).
    pub fn set_synchronized(&mut self, on: bool) {
        self.synchronized = on;
    }

    pub fn color_level(&self) -> i32 {
        self.level
    }

    /// The frame the screen holds now, if one was written.
    pub fn screen(&self) -> Option<&Grid> {
        self.previous.as_ref()
    }

    pub fn get_ref(&self) -> &W {
        &self.out
    }

    pub fn into_inner(self) -> W {
        self.out
    }

    /// The terminal changed size: the next frame clears the screen and writes everything.
    pub fn resize(&mut self) {
        self.clear_next = true;
    }

    /// Clears the screen and writes the frame it held, at once: after a resize, to dismiss Windows Terminal's native
    /// selection highlight (which survives in-place repaints), and when the session is replaced. Does nothing before
    /// the first frame beyond making that frame a full one.
    pub fn force_full_repaint(&mut self) -> io::Result<WriteStats> {
        self.clear_next = true;
        let Some(grid) = self.previous.take() else { return Ok(WriteStats::default()) };
        let cursor = self.previous_cursor;
        self.write_frame(&grid, cursor)
    }

    /// Ends the session's drawing: resets the style and shows the cursor.
    pub fn finish(&mut self) -> io::Result<()> {
        self.out.write_all(format!("{RESET}{SHOW_CURSOR}").as_bytes())?;
        self.out.flush()?;
        self.cursor_visible = Some(true);
        Ok(())
    }

    /// Writes what turns the screen into `grid` with the cursor at `cursor` (hidden for `None`). A frame equal to the
    /// screen with the cursor where it is writes nothing.
    pub fn write_frame(&mut self, grid: &Grid, cursor: Option<CursorPos>) -> io::Result<WriteStats> {
        let bytes = self.encode(grid, cursor);
        if bytes.is_empty() {
            return Ok(WriteStats::default());
        }
        self.out.write_all(&bytes)?;
        self.out.flush()?;
        Ok(WriteStats { bytes: bytes.len() })
    }

    /// The bytes of one frame, and the screen state after them.
    fn encode(&mut self, grid: &Grid, cursor: Option<CursorPos>) -> Vec<u8> {
        let cursor = cursor.map(|pos| CursorPos {
            col: pos.col.min(grid.width.saturating_sub(1)),
            row: pos.row.min(grid.height.saturating_sub(1)),
        });
        let previous = self.previous.take();
        let width_changed = previous.as_ref().is_some_and(|prev| prev.width != grid.width);
        let clear = self.clear_next || width_changed;
        let base = match (&previous, clear) {
            (_, true) => Base::Blank,
            (Some(prev), false) => Base::Previous(prev),
            (None, false) => Base::Unknown,
        };

        let mut body = Encoder::new(self.level, grid);
        if clear {
            body.push(RESET);
            body.push(CLEAR_TERMINAL);
        }
        let previous_height = match (&previous, clear) {
            (Some(prev), false) => prev.height,
            _ => 0,
        };
        for y in 0..grid.height {
            body.row(y, base);
        }
        for y in grid.height..previous_height {
            if let Base::Previous(prev) = base
                && !prev.row(y).iter().all(Cell::is_plain_blank)
            {
                body.cursor_to(y, 0);
                body.reset_style();
                body.push(ERASE_LINE);
            }
        }
        let wrote = !body.out.is_empty();
        body.reset_style();

        let cursor_changed = cursor != self.previous_cursor || self.cursor_visible.is_none();
        if !wrote && !cursor_changed {
            self.previous = previous;
            return Vec::new();
        }

        let mut framed = String::new();
        if self.synchronized {
            framed.push_str(BEGIN_SYNCHRONIZED);
        }
        if self.cursor_visible != Some(false) {
            framed.push_str(HIDE_CURSOR);
        }
        framed.push_str(&body.out);
        match cursor {
            Some(pos) => {
                framed.push_str(&format!("\x1b[{};{}H{SHOW_CURSOR}", u32::from(pos.row) + 1, u32::from(pos.col) + 1));
                self.cursor_visible = Some(true);
            }
            None => self.cursor_visible = Some(false),
        }
        if self.synchronized {
            framed.push_str(END_SYNCHRONIZED);
        }

        self.clear_next = false;
        self.previous_cursor = cursor;
        self.previous = Some(grid.clone());
        framed.into_bytes()
    }
}

/// Builds the body of a frame: the runs, with the style and hyperlink state carried between them.
struct Encoder<'a> {
    out: String,
    level: i32,
    grid: &'a Grid,
    style: Style,
    link: u32,
}

impl<'a> Encoder<'a> {
    fn new(level: i32, grid: &'a Grid) -> Self {
        Self { out: String::new(), level, grid, style: Style::default(), link: 0 }
    }

    fn push(&mut self, text: &str) {
        self.out.push_str(text);
    }

    fn cursor_to(&mut self, row: u16, col: u16) {
        self.out.push_str(&format!("\x1b[{};{}H", u32::from(row) + 1, u32::from(col) + 1));
    }

    /// Closes the open hyperlink and returns the style to the default.
    fn reset_style(&mut self) {
        if self.link != 0 {
            self.out.push_str(LINK_CLOSE);
            self.link = 0;
        }
        if self.style != Style::default() {
            self.out.push_str(RESET);
            self.style = Style::default();
        }
    }

    /// Writes the runs of row `y` that differ from what the screen holds.
    fn row(&mut self, y: u16, base: Base<'_>) {
        let grid = self.grid;
        let cells = grid.row(y);
        let width = cells.len();
        let differs = |x: usize| match base {
            Base::Unknown => true,
            Base::Blank => !cells[x].is_plain_blank(),
            Base::Previous(prev) => prev.cell(x as u16, y).is_none_or(|old| !same_cell(old, prev, &cells[x], grid)),
        };
        let mut runs: Vec<(usize, usize)> = Vec::new();
        let mut x = 0;
        while x < width {
            if !differs(x) {
                x += 1;
                continue;
            }
            let mut last = x;
            let mut probe = x + 1;
            while probe < width && probe <= last + 1 + MERGE_GAP {
                if differs(probe) {
                    last = probe;
                }
                probe += 1;
            }
            let mut start = x;
            let mut end = last + 1;
            if start > 0 && cells[start].is_continuation() {
                start -= 1;
            }
            if end < width && cells[end - 1].width == 2 {
                end += 1;
            }
            if let Some(previous) = runs.last_mut()
                && start <= previous.1
            {
                previous.1 = previous.1.max(end);
            } else {
                runs.push((start, end));
            }
            x = end;
        }
        for (start, end) in runs {
            self.run(y, cells, start, end);
        }
    }

    fn run(&mut self, y: u16, cells: &[Cell], start: usize, end: usize) {
        let width = cells.len();
        // A run that reaches the end of the row and finishes in blank cells ends in an erase instead.
        let blank_from = if end == width {
            let tail = cells.iter().rev().take_while(|cell| cell.is_plain_blank()).count();
            Some((width - tail).max(start)).filter(|from| *from < width)
        } else {
            None
        };
        let stop = blank_from.unwrap_or(end);
        self.cursor_to(y, start as u16);
        for cell in &cells[start..stop] {
            if cell.is_continuation() {
                continue;
            }
            self.set_style(cell.style);
            self.set_link(cell.link);
            self.out.push_str(cell.text());
            if cell.width == 2 && string_width(cell.text(), StringWidthOptions::default()) == 1 {
                // The display-width policy widens this glyph, but the terminal advances one cell: a real blank
                // keeps the next glyph from landing on the glyph's second half.
                self.out.push(' ');
            }
        }
        if blank_from.is_some() {
            self.reset_style();
            self.out.push_str(ERASE_LINE_END);
        }
    }

    fn set_link(&mut self, link: u32) {
        let link = if self.grid.link_url(link).is_some() { link } else { 0 };
        if link == self.link {
            return;
        }
        if self.link != 0 {
            self.out.push_str(LINK_CLOSE);
        }
        if let Some(url) = self.grid.link_url(link) {
            self.out.push_str("\x1b]8;;");
            self.out.push_str(url);
            self.out.push_str("\x1b\\");
        }
        self.link = link;
    }

    /// Moves the terminal's style to `wanted` (what the cell holds, at the session's colour level) with the closing
    /// and opening codes chalk writes.
    fn set_style(&mut self, wanted: Style) {
        let wanted = at_level(wanted, self.level);
        if wanted == self.style {
            return;
        }
        let mut current = self.style;
        let mut codes = String::new();
        if (current.bold && !wanted.bold) || (current.dim && !wanted.dim) {
            codes.push_str("\x1b[22m");
            current.bold = false;
            current.dim = false;
        }
        for (on, wanted_on, close) in [
            (current.italic, wanted.italic, "\x1b[23m"),
            (current.underline, wanted.underline, "\x1b[24m"),
            (current.inverse, wanted.inverse, "\x1b[27m"),
            (current.strikethrough, wanted.strikethrough, "\x1b[29m"),
        ] {
            if on && !wanted_on {
                codes.push_str(close);
            }
        }
        if wanted.fg == Color::Default && current.fg != Color::Default {
            codes.push_str(FG_CLOSE);
            current.fg = Color::Default;
        }
        if wanted.bg == Color::Default && current.bg != Color::Default {
            codes.push_str(BG_CLOSE);
            current.bg = Color::Default;
        }
        if wanted.bold && !current.bold {
            codes.push_str(BOLD_OPEN);
        }
        if wanted.dim && !current.dim {
            codes.push_str(DIM_OPEN);
        }
        for (wanted_on, on, open) in [
            (wanted.italic, current.italic, "\x1b[3m"),
            (wanted.underline, current.underline, "\x1b[4m"),
            (wanted.inverse, current.inverse, "\x1b[7m"),
            (wanted.strikethrough, current.strikethrough, "\x1b[9m"),
        ] {
            if wanted_on && !on {
                codes.push_str(open);
            }
        }
        if wanted.fg != current.fg
            && let Some(parameters) = color_parameters(wanted.fg, false, self.level)
        {
            codes.push_str(&format!("\x1b[{parameters}m"));
        }
        if wanted.bg != current.bg
            && let Some(parameters) = color_parameters(wanted.bg, true, self.level)
        {
            codes.push_str(&format!("\x1b[{parameters}m"));
        }
        self.out.push_str(&codes);
        self.style = wanted;
    }
}

/// Whether a cell of the last frame shows what a cell of the new one does. Link ids are per grid (each frame interns its
/// own table), so the urls are compared, not the ids.
fn same_cell(old: &Cell, previous: &Grid, new: &Cell, grid: &Grid) -> bool {
    old.symbol == new.symbol
        && old.width == new.width
        && old.style == new.style
        && previous.link_url(old.link) == grid.link_url(new.link)
}

/// What a style comes to at a colour level: at level 0 chalk writes no styling at all (the selection highlight, which
/// is a literal colour, still shows).
fn at_level(style: Style, level: i32) -> Style {
    if level > 0 {
        return style;
    }
    let bg = if matches!(style.bg, Color::Literal(_)) { style.bg } else { Color::Default };
    Style { bg, ..Style::default() }
}

/// The SGR parameters of a colour at a level (`None` when nothing is written).
fn color_parameters(color: Color, background: bool, level: i32) -> Option<String> {
    let base = if background { 48 } else { 38 };
    match color {
        Color::Default => None,
        Color::Literal(Rgb { r, g, b }) => Some(format!("{base};2;{r};{g};{b}")),
        _ if level <= 0 => None,
        Color::Indexed(index) if index < 8 => Some((u16::from(index) + base - 8).to_string()),
        Color::Indexed(index) if index < 16 => Some((u16::from(index) - 8 + if background { 100 } else { 90 }).to_string()),
        Color::Indexed(index) => Some(format!("{base};5;{index}")),
        Color::Rgb(Rgb { r, g, b }) => {
            let wrapped = mixdog_tui_style::color_level::ink_colorize("\u{1}", &format!("rgb({r},{g},{b})"), background, level)?;
            let (open, _) = wrapped.split_once('\u{1}')?;
            Some(open.strip_prefix("\x1b[")?.strip_suffix('m')?.to_owned())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::VtGrid;

    fn write(grid: &Grid, writer: &mut FrameWriter<Vec<u8>>, cursor: Option<CursorPos>) -> Vec<u8> {
        let before = writer.get_ref().len();
        writer.write_frame(grid, cursor).unwrap();
        writer.get_ref()[before..].to_vec()
    }

    fn text_grid(lines: &[&str], width: u16) -> Grid {
        let mut grid = Grid::new(width, lines.len() as u16);
        for (y, line) in lines.iter().enumerate() {
            for (x, ch) in line.chars().enumerate() {
                grid.put_glyph(x as i32, y as i32, &ch.to_string(), 1, Style::default(), 0);
            }
        }
        grid
    }

    #[test]
    fn an_unchanged_frame_writes_nothing_and_a_changed_cell_writes_only_its_run() {
        let mut writer = FrameWriter::new(Vec::new(), 3);
        let mut grid = text_grid(&["hello world", "second row!"], 20);
        write(&grid, &mut writer, None);
        assert!(write(&grid, &mut writer, None).is_empty());
        grid.put_glyph(6, 0, "W", 1, Style::default(), 0);
        let bytes = String::from_utf8(write(&grid, &mut writer, None)).unwrap();
        assert!(bytes.starts_with("\x1b[?2026h"), "{bytes:?}");
        assert!(bytes.ends_with("\x1b[?2026l"), "{bytes:?}");
        assert!(bytes.contains("\x1b[1;7HW"), "{bytes:?}");
        assert!(!bytes.contains("second"), "{bytes:?}");
    }

    #[test]
    fn a_changed_row_with_a_blank_tail_is_reset_then_erased() {
        let mut writer = FrameWriter::new(Vec::new(), 3);
        let mut grid = text_grid(&["abcdef"], 6);
        write(&grid, &mut writer, None);
        let red = Style { fg: Color::Indexed(1), ..Style::default() };
        grid.put_glyph(3, 0, "X", 1, red, 0);
        grid.put_glyph(4, 0, " ", 1, Style::default(), 0);
        grid.put_glyph(5, 0, " ", 1, Style::default(), 0);
        let bytes = String::from_utf8(write(&grid, &mut writer, None)).unwrap();
        assert!(bytes.contains("\x1b[31mX\x1b[0m\x1b[K"), "{bytes:?}");
    }

    #[test]
    fn colours_follow_the_level() {
        let style = Style { fg: Color::Rgb(Rgb::new(255, 136, 0)), bg: Color::Literal(Rgb::new(1, 2, 3)), ..Style::default() };
        let mut grid = Grid::new(4, 1);
        grid.put_glyph(0, 0, "x", 1, style, 0);
        for (level, want_fg) in [(3, "\x1b[38;2;255;136;0m"), (2, "\x1b[38;5;214m"), (1, "\x1b[93m")] {
            let mut writer = FrameWriter::new(Vec::new(), level);
            let bytes = String::from_utf8(write(&grid, &mut writer, None)).unwrap();
            assert!(bytes.contains(want_fg), "level {level}: {bytes:?}");
            assert!(bytes.contains("\x1b[48;2;1;2;3m"), "level {level}: {bytes:?}");
        }
        let mut writer = FrameWriter::new(Vec::new(), 0);
        let bytes = String::from_utf8(write(&grid, &mut writer, None)).unwrap();
        assert!(!bytes.contains("38;"), "{bytes:?}");
        assert!(bytes.contains("\x1b[48;2;1;2;3m"), "{bytes:?}");
    }

    #[test]
    fn hyperlinks_are_opened_and_closed_around_runs_of_equal_link() {
        let mut grid = Grid::new(10, 1);
        let link = grid.intern_link("https://example.com/");
        grid.put_glyph(1, 0, "a", 1, Style::default(), link);
        grid.put_glyph(2, 0, "b", 1, Style::default(), link);
        grid.put_glyph(3, 0, "c", 1, Style::default(), 0);
        let mut writer = FrameWriter::new(Vec::new(), 3);
        let bytes = String::from_utf8(write(&grid, &mut writer, None)).unwrap();
        assert!(bytes.contains("\x1b]8;;https://example.com/\x1b\\ab\x1b]8;;\x1b\\c"), "{bytes:?}");
    }

    #[test]
    fn a_cell_whose_link_id_now_names_another_url_is_rewritten() {
        let mut writer = FrameWriter::new(Vec::new(), 3);
        let mut first = Grid::new(4, 1);
        let link = first.intern_link("https://a.example/");
        first.put_glyph(0, 0, "x", 1, Style::default(), link);
        write(&first, &mut writer, None);
        let mut second = Grid::new(4, 1);
        let link = second.intern_link("https://b.example/");
        second.put_glyph(0, 0, "x", 1, Style::default(), link);
        let bytes = String::from_utf8(write(&second, &mut writer, None)).unwrap();
        assert!(bytes.contains("\x1b]8;;https://b.example/\x1b\\x"), "{bytes:?}");
        assert!(write(&second, &mut writer, None).is_empty());
    }

    #[test]
    fn the_cursor_is_hidden_while_drawing_and_shown_at_the_requested_cell() {
        let mut writer = FrameWriter::new(Vec::new(), 3);
        let mut grid = text_grid(&["ab"], 6);
        let first = String::from_utf8(write(&grid, &mut writer, Some(CursorPos { col: 2, row: 0 }))).unwrap();
        assert!(first.contains("\x1b[?25l"), "{first:?}");
        assert!(first.ends_with("\x1b[1;3H\x1b[?25h\x1b[?2026l"), "{first:?}");
        // Only the cursor moves: no cells are written.
        let moved = String::from_utf8(write(&grid, &mut writer, Some(CursorPos { col: 1, row: 0 }))).unwrap();
        assert_eq!(moved, "\x1b[?2026h\x1b[?25l\x1b[1;2H\x1b[?25h\x1b[?2026l");
        // The same cursor again: nothing.
        assert!(write(&grid, &mut writer, Some(CursorPos { col: 1, row: 0 })).is_empty());
        grid.put_glyph(0, 0, "z", 1, Style::default(), 0);
        let hidden = String::from_utf8(write(&grid, &mut writer, None)).unwrap();
        assert!(hidden.contains("\x1b[?25l") && !hidden.contains("\x1b[?25h"), "{hidden:?}");
    }

    #[test]
    fn a_wide_glyph_is_written_whole_and_the_replay_matches_the_grid() {
        let mut grid = Grid::new(8, 2);
        grid.put_glyph(1, 0, "日", 2, Style::default(), 0);
        grid.put_glyph(4, 1, "界", 2, Style { bold: true, ..Style::default() }, 0);
        let mut writer = FrameWriter::new(Vec::new(), 3);
        let bytes = write(&grid, &mut writer, None);
        let mut vt = VtGrid::new(8, 2);
        vt.feed(&bytes);
        assert_eq!(vt.grid().row_text(0).trim_end(), " 日");
        assert_eq!(vt.grid().cell(1, 0).map(|c| c.width), Some(2));
        assert_eq!(vt.grid().cell(4, 1).map(|c| (c.width, c.style.bold)), Some((2, true)));
        // Overwriting the glyph's second half rewrites the whole glyph's cells.
        grid.put_glyph(2, 0, "x", 1, Style::default(), 0);
        let bytes = write(&grid, &mut writer, None);
        vt.feed(&bytes);
        assert_eq!(vt.grid().row_text(0).trim_end(), "  x");
    }

    #[test]
    fn a_policy_widened_glyph_gets_a_real_blank_after_it() {
        let mut grid = Grid::new(6, 1);
        grid.put_glyph(0, 0, "\u{2460}", 2, Style::default(), 0);
        grid.put_glyph(2, 0, "z", 1, Style::default(), 0);
        let mut writer = FrameWriter::new(Vec::new(), 3);
        let bytes = String::from_utf8(write(&grid, &mut writer, None)).unwrap();
        assert!(bytes.contains("\u{2460} z"), "{bytes:?}");
    }

    #[test]
    fn a_shorter_frame_erases_the_rows_it_no_longer_has_and_a_width_change_clears_the_screen() {
        let mut writer = FrameWriter::new(Vec::new(), 3);
        write(&text_grid(&["one", "two", "three"], 10), &mut writer, None);
        let bytes = String::from_utf8(write(&text_grid(&["one", "two"], 10), &mut writer, None)).unwrap();
        assert!(bytes.contains("\x1b[3;1H\x1b[2K"), "{bytes:?}");
        let bytes = String::from_utf8(write(&text_grid(&["one", "two"], 12), &mut writer, None)).unwrap();
        assert!(bytes.contains("\x1b[2J\x1b[3J\x1b[H"), "{bytes:?}");
    }

    #[test]
    fn force_full_repaint_clears_and_rewrites_the_frame_the_screen_holds() {
        let mut writer = FrameWriter::new(Vec::new(), 3);
        let grid = text_grid(&["keep me"], 10);
        write(&grid, &mut writer, None);
        let before = writer.get_ref().len();
        let stats = writer.force_full_repaint().unwrap();
        let bytes = String::from_utf8(writer.get_ref()[before..].to_vec()).unwrap();
        assert_eq!(stats.bytes, bytes.len());
        assert!(bytes.contains("\x1b[0m\x1b[2J\x1b[3J\x1b[H"), "{bytes:?}");
        assert!(bytes.contains("keep me"), "{bytes:?}");
        assert_eq!(writer.screen(), Some(&grid));
    }
}
