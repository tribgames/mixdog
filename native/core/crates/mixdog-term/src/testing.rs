//! A VT test grid for replaying frames, and the parser of recorded Ink frames.
//!
//! [`VtGrid`] is a small terminal on `vte`: it replays the bytes the frame writer produces (or Ink produced) and keeps
//! what a terminal shows, so a test compares screens instead of byte strings. It understands cursor movement (CUP, HVP,
//! CUU, CUD, CUF, CUB, CNL, CPL, CHA, VPA), erase (ED, EL, with the background of the current style as a terminal
//! erases), SGR, the private modes the frame writer uses (1049 and 47 and 1047 alternate screen, 2026 synchronized
//! update, 25 cursor visibility, 7 autowrap), DECSCUSR, OSC 8 hyperlinks, save and restore cursor, scrolling at the
//! bottom row, autowrap with the pending-wrap state, and wide and combining characters.
//!
//! [`grid_from_ink_frame`] reads a frame string as Ink recorded it (`FORCE_COLOR=3`) into a [`Grid`], for cell
//! comparisons against what the painter and the writer make.

use mixdog_termtext::grapheme::graphemes_with_widths;
use mixdog_termtext::{StringWidthOptions, display_width_with, string_width};
use vte::{Params, Parser, Perform};

use crate::frame::{Cell, Grid, Style, Symbol, apply_sgr, parse_hyperlink};

/// A terminal screen built by replaying terminal output.
pub struct VtGrid {
    parser: Parser,
    screen: Screen,
}

struct Screen {
    main: Grid,
    alt: Grid,
    use_alt: bool,
    cx: u16,
    cy: u16,
    pending_wrap: bool,
    style: Style,
    link_url: Option<String>,
    cursor_visible: bool,
    cursor_style: u16,
    autowrap: bool,
    synchronized: bool,
    synchronized_frames: u32,
    saved: Option<(u16, u16, Style)>,
    scrollback: Vec<String>,
    last_glyph: Option<(u16, u16)>,
}

impl VtGrid {
    /// A screen of `width` columns and `height` rows, cursor visible, in the main screen.
    pub fn new(width: u16, height: u16) -> Self {
        Self {
            parser: Parser::new(),
            screen: Screen {
                main: Grid::new(width, height),
                alt: Grid::new(width, height),
                use_alt: false,
                cx: 0,
                cy: 0,
                pending_wrap: false,
                style: Style::default(),
                link_url: None,
                cursor_visible: true,
                cursor_style: 0,
                autowrap: true,
                synchronized: false,
                synchronized_frames: 0,
                saved: None,
                scrollback: Vec::new(),
                last_glyph: None,
            },
        }
    }

    /// Replays terminal output.
    pub fn feed(&mut self, bytes: &[u8]) {
        self.parser.advance(&mut self.screen, bytes);
    }

    /// The screen being shown (the alternate screen while it is on).
    pub fn grid(&self) -> &Grid {
        self.screen.active()
    }

    /// The text of row `y` with the trailing blanks removed.
    pub fn row_text(&self, y: u16) -> String {
        self.grid().row_text(y).trim_end().to_owned()
    }

    /// The first row whose text contains `marker`.
    pub fn find_row(&self, marker: &str) -> Option<u16> {
        (0..self.grid().height).find(|&y| self.grid().row_text(y).contains(marker))
    }

    /// The text of every row, trailing blanks removed.
    pub fn dump(&self) -> Vec<String> {
        (0..self.grid().height).map(|y| self.row_text(y)).collect()
    }

    /// The cursor cell, `(column, row)`.
    pub fn cursor(&self) -> (u16, u16) {
        (self.screen.cx, self.screen.cy)
    }

    pub fn cursor_visible(&self) -> bool {
        self.screen.cursor_visible
    }

    /// The last DECSCUSR parameter (0 before any).
    pub fn cursor_style(&self) -> u16 {
        self.screen.cursor_style
    }

    pub fn in_alternate_screen(&self) -> bool {
        self.screen.use_alt
    }

    /// Whether a synchronized update (`?2026h`) is open.
    pub fn in_synchronized_update(&self) -> bool {
        self.screen.synchronized
    }

    /// How many synchronized updates were closed.
    pub fn synchronized_updates(&self) -> u32 {
        self.screen.synchronized_frames
    }

    /// The rows that scrolled off the top of the main screen, oldest first.
    pub fn scrollback(&self) -> &[String] {
        &self.screen.scrollback
    }

    /// The terminal was resized: the rows and columns both screens share are kept, the cursor is clamped.
    pub fn resize(&mut self, width: u16, height: u16) {
        for grid in [&mut self.screen.main, &mut self.screen.alt] {
            let mut next = Grid::new(width, height);
            next.links.clone_from(&grid.links);
            for y in 0..height.min(grid.height) {
                for x in 0..width.min(grid.width) {
                    if let (Some(cell), Some(target)) = (grid.cell(x, y), next.cell_mut(x, y)) {
                        *target = cell.clone();
                    }
                }
                // A wide glyph cut by the new edge becomes a blank.
                if let Some(last) = next.cell_mut(width.saturating_sub(1), y)
                    && last.width == 2
                {
                    *last = Cell::blank();
                }
            }
            *grid = next;
        }
        self.screen.cx = self.screen.cx.min(width.saturating_sub(1));
        self.screen.cy = self.screen.cy.min(height.saturating_sub(1));
        self.screen.pending_wrap = false;
    }
}

impl Screen {
    fn active(&self) -> &Grid {
        if self.use_alt { &self.alt } else { &self.main }
    }

    fn active_mut(&mut self) -> &mut Grid {
        if self.use_alt { &mut self.alt } else { &mut self.main }
    }

    fn width(&self) -> u16 {
        self.active().width
    }

    fn height(&self) -> u16 {
        self.active().height
    }

    /// A cell as an erase leaves it: blank, with the background of the current style.
    fn erased(&self) -> Cell {
        let mut cell = Cell::blank();
        cell.style.bg = self.style.bg;
        cell
    }

    fn link_id(&mut self) -> u32 {
        match self.link_url.clone() {
            Some(url) => self.active_mut().intern_link(&url),
            None => 0,
        }
    }

    fn line_feed(&mut self) {
        if self.cy + 1 >= self.height() {
            self.scroll_up();
        } else {
            self.cy += 1;
        }
    }

    fn scroll_up(&mut self) {
        let width = usize::from(self.width());
        if width == 0 {
            return;
        }
        let blank = self.erased();
        if !self.use_alt {
            let top: String = self.main.row(0).iter().map(Cell::text).collect();
            self.scrollback.push(top.trim_end().to_owned());
        }
        let grid = self.active_mut();
        grid.cells.rotate_left(width);
        let len = grid.cells.len();
        for cell in &mut grid.cells[len - width..] {
            *cell = blank.clone();
        }
    }

    fn reverse_index(&mut self) {
        if self.cy == 0 {
            let width = usize::from(self.width());
            let blank = self.erased();
            let grid = self.active_mut();
            grid.cells.rotate_right(width);
            for cell in &mut grid.cells[..width] {
                *cell = blank.clone();
            }
        } else {
            self.cy -= 1;
        }
    }

    fn print_cluster_width(c: char) -> usize {
        string_width(c.encode_utf8(&mut [0; 4]), StringWidthOptions::default())
    }

    fn put(&mut self, c: char) {
        let width = Self::print_cluster_width(c);
        if width == 0 {
            self.join_previous(c);
            return;
        }
        let columns = self.width();
        if self.pending_wrap || self.cx + width as u16 > columns {
            if self.autowrap {
                self.cx = 0;
                self.line_feed();
            } else {
                self.cx = columns.saturating_sub(width as u16);
            }
            self.pending_wrap = false;
        }
        let (style, link) = (self.style, self.link_id());
        let (x, y) = (self.cx, self.cy);
        self.active_mut().put_glyph(i32::from(x), i32::from(y), c.encode_utf8(&mut [0; 4]), width, style, link);
        self.last_glyph = Some((x, y));
        self.advance(width as u16);
    }

    fn advance(&mut self, by: u16) {
        let columns = self.width();
        if self.cx + by >= columns {
            self.cx = columns.saturating_sub(1);
            self.pending_wrap = true;
        } else {
            self.cx += by;
        }
    }

    /// A zero-width character joins the glyph before it; a cluster that grows to two cells takes the next cell.
    fn join_previous(&mut self, c: char) {
        let Some((x, y)) = self.last_glyph else { return };
        let Some(cell) = self.active().cell(x, y) else { return };
        let mut text = cell.text().to_owned();
        let was = cell.width;
        text.push(c);
        let widened = string_width(&text, StringWidthOptions::default()) >= 2 && was == 1;
        let (style, link) = (cell.style, cell.link);
        if widened && x + 1 < self.width() {
            self.active_mut().put_glyph(i32::from(x), i32::from(y), &text, 2, style, link);
            if !self.pending_wrap {
                self.advance(1);
            }
        } else if let Some(cell) = self.active_mut().cell_mut(x, y) {
            cell.symbol = Symbol::new(&text);
        }
    }

    fn erase_cells(&mut self, y: u16, from: u16, to_exclusive: u16) {
        let blank = self.erased();
        let width = self.width();
        let grid = self.active_mut();
        for x in from..to_exclusive.min(width) {
            // Erasing half of a wide glyph erases the other half too.
            if let Some(cell) = grid.cell(x, y).cloned() {
                if cell.width == 2 && x + 1 < width {
                    grid.row_mut(y)[usize::from(x) + 1] = blank.clone();
                }
                if cell.is_continuation() && x > 0 {
                    grid.row_mut(y)[usize::from(x) - 1] = blank.clone();
                }
            }
            grid.row_mut(y)[usize::from(x)] = blank.clone();
        }
    }

    fn switch_screen(&mut self, alt: bool, save: bool) {
        if alt == self.use_alt {
            return;
        }
        if alt {
            if save {
                self.saved = Some((self.cx, self.cy, self.style));
            }
            self.use_alt = true;
            let blank = Cell::blank();
            self.alt.cells.fill(blank);
            self.alt.links.clear();
        } else {
            self.use_alt = false;
            if save && let Some((x, y, style)) = self.saved.take() {
                self.cx = x;
                self.cy = y;
                self.style = style;
            }
        }
        self.pending_wrap = false;
        self.last_glyph = None;
    }

    fn set_mode(&mut self, mode: u16, on: bool) {
        match mode {
            1049 => self.switch_screen(on, true),
            47 | 1047 => self.switch_screen(on, false),
            25 => self.cursor_visible = on,
            7 => self.autowrap = on,
            2026 => {
                if !on && self.synchronized {
                    self.synchronized_frames += 1;
                }
                self.synchronized = on;
            }
            _ => {}
        }
    }
}

fn first(params: &Params, default: u16) -> u16 {
    nth(params, 0, default)
}

fn nth(params: &Params, index: usize, default: u16) -> u16 {
    match params.iter().nth(index).and_then(|p| p.first()).copied() {
        None | Some(0) => default,
        Some(value) => value,
    }
}

impl Perform for Screen {
    fn print(&mut self, c: char) {
        self.put(c);
    }

    fn execute(&mut self, byte: u8) {
        match byte {
            b'\n' | 0x0b | 0x0c => {
                self.line_feed();
                self.pending_wrap = false;
            }
            b'\r' => {
                self.cx = 0;
                self.pending_wrap = false;
            }
            0x08 => {
                self.cx = self.cx.saturating_sub(1);
                self.pending_wrap = false;
            }
            b'\t' => {
                let next = (self.cx / 8 + 1) * 8;
                self.cx = next.min(self.width().saturating_sub(1));
                self.pending_wrap = false;
            }
            _ => {}
        }
    }

    fn csi_dispatch(&mut self, params: &Params, intermediates: &[u8], _ignore: bool, action: char) {
        let private = intermediates.first() == Some(&b'?');
        let (columns, rows) = (self.width(), self.height());
        match (action, intermediates) {
            ('h' | 'l', _) if private => {
                for param in params.iter() {
                    if let Some(mode) = param.first() {
                        self.set_mode(*mode, action == 'h');
                    }
                }
            }
            ('q', [b' ']) => self.cursor_style = nth(params, 0, 0),
            ('H' | 'f', []) => {
                self.cy = (first(params, 1) - 1).min(rows.saturating_sub(1));
                self.cx = (nth(params, 1, 1) - 1).min(columns.saturating_sub(1));
                self.pending_wrap = false;
            }
            ('A', []) => {
                self.cy = self.cy.saturating_sub(first(params, 1));
                self.pending_wrap = false;
            }
            ('B', []) => {
                self.cy = (self.cy + first(params, 1)).min(rows.saturating_sub(1));
                self.pending_wrap = false;
            }
            ('C', []) => {
                self.cx = (self.cx + first(params, 1)).min(columns.saturating_sub(1));
                self.pending_wrap = false;
            }
            ('D', []) => {
                self.cx = self.cx.saturating_sub(first(params, 1));
                self.pending_wrap = false;
            }
            ('E', []) => {
                self.cy = (self.cy + first(params, 1)).min(rows.saturating_sub(1));
                self.cx = 0;
                self.pending_wrap = false;
            }
            ('F', []) => {
                self.cy = self.cy.saturating_sub(first(params, 1));
                self.cx = 0;
                self.pending_wrap = false;
            }
            ('G', []) => {
                self.cx = (first(params, 1) - 1).min(columns.saturating_sub(1));
                self.pending_wrap = false;
            }
            ('d', []) => {
                self.cy = (first(params, 1) - 1).min(rows.saturating_sub(1));
                self.pending_wrap = false;
            }
            ('J', []) => {
                let mode = params.iter().next().and_then(|p| p.first()).copied().unwrap_or(0);
                let (cx, cy) = (self.cx, self.cy);
                match mode {
                    0 => {
                        self.erase_cells(cy, cx, columns);
                        for y in cy + 1..rows {
                            self.erase_cells(y, 0, columns);
                        }
                    }
                    1 => {
                        for y in 0..cy {
                            self.erase_cells(y, 0, columns);
                        }
                        self.erase_cells(cy, 0, cx + 1);
                    }
                    2 => {
                        for y in 0..rows {
                            self.erase_cells(y, 0, columns);
                        }
                    }
                    3 => self.scrollback.clear(),
                    _ => {}
                }
            }
            ('K', []) => {
                let mode = params.iter().next().and_then(|p| p.first()).copied().unwrap_or(0);
                let (cx, cy) = (self.cx, self.cy);
                match mode {
                    0 => self.erase_cells(cy, cx, columns),
                    1 => self.erase_cells(cy, 0, cx + 1),
                    2 => self.erase_cells(cy, 0, columns),
                    _ => {}
                }
            }
            ('m', []) => {
                let flat: Vec<u16> = params.iter().flat_map(|p| p.iter().copied()).collect();
                apply_sgr(&mut self.style, &flat);
            }
            ('s', []) => self.saved = Some((self.cx, self.cy, self.style)),
            ('u', []) => {
                if let Some((x, y, style)) = self.saved {
                    self.cx = x.min(columns.saturating_sub(1));
                    self.cy = y.min(rows.saturating_sub(1));
                    self.style = style;
                    self.pending_wrap = false;
                }
            }
            _ => {}
        }
    }

    fn esc_dispatch(&mut self, intermediates: &[u8], _ignore: bool, byte: u8) {
        if !intermediates.is_empty() {
            return;
        }
        match byte {
            b'7' => self.saved = Some((self.cx, self.cy, self.style)),
            b'8' => {
                if let Some((x, y, style)) = self.saved {
                    self.cx = x;
                    self.cy = y;
                    self.style = style;
                    self.pending_wrap = false;
                }
            }
            b'D' => self.line_feed(),
            b'M' => self.reverse_index(),
            b'E' => {
                self.cx = 0;
                self.line_feed();
            }
            _ => {}
        }
    }

    fn osc_dispatch(&mut self, params: &[&[u8]], _bell_terminated: bool) {
        let joined: Vec<String> = params.iter().map(|p| String::from_utf8_lossy(p).into_owned()).collect();
        if let Some(url) = parse_hyperlink(&joined.join(";")) {
            self.link_url = (!url.is_empty()).then(|| url.to_owned());
        }
    }
}

/// Reads an Ink frame string (`FORCE_COLOR=3`: SGR colours as truecolor, OSC 8 links) into a grid of `width` columns
/// and one row per line, with the glyph widths of the process's display-width policy.
pub fn grid_from_ink_frame(frame: &str, width: u16) -> Grid {
    grid_from_ink_frame_with(frame, width, mixdog_termtext::display_width("\u{2460}") == 2)
}

/// [`grid_from_ink_frame`] with the display-width policy stated: `wide` widens the enclosed alphanumerics and arrows.
pub fn grid_from_ink_frame_with(frame: &str, width: u16, wide: bool) -> Grid {
    let lines: Vec<&str> = if frame.is_empty() { Vec::new() } else { frame.split('\n').collect() };
    let mut grid = Grid::new(width, lines.len() as u16);
    for (y, line) in lines.iter().enumerate() {
        read_ink_line(&mut grid, y as i32, line, wide);
    }
    grid
}

fn read_ink_line(grid: &mut Grid, y: i32, line: &str, wide: bool) {
    let mut style = Style::default();
    let mut link = 0u32;
    let mut x = 0i32;
    let mut pad = 0usize;
    let mut rest = line;
    while !rest.is_empty() {
        if let Some(after) = rest.strip_prefix("\x1b[") {
            let end = after.find(|c: char| ('@'..='~').contains(&c)).map_or(after.len(), |at| at + 1);
            let (body, tail) = after.split_at(end);
            if let Some(params) = body.strip_suffix('m') {
                // An empty parameter list is a reset, as in a terminal.
                let params: Vec<u16> = params.split(';').filter_map(|p| p.parse().ok()).collect();
                apply_sgr(&mut style, &params);
            }
            rest = tail;
        } else if let Some(after) = rest.strip_prefix("\x1b]") {
            let (body, tail) = match (after.find('\u{7}'), after.find("\x1b\\")) {
                (Some(bel), Some(st)) if st < bel => (&after[..st], &after[st + 2..]),
                (Some(bel), _) => (&after[..bel], &after[bel + 1..]),
                (None, Some(st)) => (&after[..st], &after[st + 2..]),
                (None, None) => (after, ""),
            };
            if let Some(url) = parse_hyperlink(body) {
                link = if url.is_empty() { 0 } else { grid.intern_link(url) };
            }
            rest = tail;
        } else {
            let end = rest.find('\x1b').unwrap_or(rest.len());
            if end == 0 {
                // An escape that is neither a CSI nor an OSC: skipped.
                rest = &rest[1..];
                continue;
            }
            let (text, tail) = rest.split_at(end);
            for cluster in graphemes_with_widths(text) {
                if pad > 0 {
                    if cluster.text == " " {
                        pad -= 1;
                        continue;
                    }
                    pad = 0;
                }
                let cells = display_width_with(cluster.text, wide).clamp(1, 2);
                grid.put_glyph(x, y, cluster.text, cells, style, link);
                if cells == 2 {
                    pad = cells.saturating_sub(string_width(cluster.text, StringWidthOptions::default())).min(1);
                }
                x += cells as i32;
            }
            rest = tail;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::frame::{Color, Rgb};

    #[test]
    fn cursor_moves_text_and_erase() {
        let mut vt = VtGrid::new(10, 3);
        vt.feed(b"\x1b[2;3Hab\x1b[1;1Hxyz\x1b[3;4Hq");
        assert_eq!(vt.dump(), vec!["xyz", "  ab", "   q"]);
        vt.feed(b"\x1b[2;3H\x1b[K\x1b[1;2H\x1b[1K");
        assert_eq!(vt.dump(), vec!["  z", "", "   q"]);
        vt.feed(b"\x1b[2J");
        assert_eq!(vt.dump(), vec!["", "", ""]);
    }

    #[test]
    fn sgr_and_links_land_on_cells_and_erase_uses_the_current_background() {
        let mut vt = VtGrid::new(8, 2);
        vt.feed(b"\x1b[1;38;2;1;2;3mA\x1b[0m\x1b]8;;http://x/\x1b\\L\x1b]8;;\x1b\\N");
        let a = vt.grid().cell(0, 0).unwrap();
        assert!(a.style.bold);
        assert_eq!(a.style.fg, Color::Rgb(Rgb::new(1, 2, 3)));
        let link = vt.grid().cell(1, 0).unwrap().link;
        assert_eq!(vt.grid().link_url(link), Some("http://x/"));
        assert_eq!(vt.grid().cell(2, 0).unwrap().link, 0);
        vt.feed(b"\x1b[2;1H\x1b[44m\x1b[K");
        assert_eq!(vt.grid().cell(3, 1).unwrap().style.bg, Color::Indexed(4));
        vt.feed(b"\x1b[0m\x1b[2;1H\x1b[0m\x1b[K");
        assert!(vt.grid().cell(3, 1).unwrap().is_plain_blank());
    }

    #[test]
    fn modes_are_tracked() {
        let mut vt = VtGrid::new(6, 2);
        vt.feed(b"main\x1b[?1049h\x1b[H\x1b[?25l\x1b[2 qalt\x1b[?2026h");
        assert!(vt.in_alternate_screen() && !vt.cursor_visible() && vt.in_synchronized_update());
        assert_eq!(vt.cursor_style(), 2);
        assert_eq!(vt.row_text(0), "alt");
        vt.feed(b"\x1b[?2026l\x1b[?1049l\x1b[?25h");
        assert_eq!(vt.row_text(0), "main");
        assert!(vt.cursor_visible() && !vt.in_alternate_screen());
        assert_eq!(vt.synchronized_updates(), 1);
    }

    #[test]
    fn wide_glyphs_wrap_and_the_bottom_row_scrolls() {
        let mut vt = VtGrid::new(4, 2);
        vt.feed("ab日".as_bytes());
        assert_eq!(vt.grid().cell(2, 0).unwrap().width, 2);
        vt.feed("界x".as_bytes());
        assert_eq!(vt.row_text(1), "界x");
        vt.feed(b"\r\n\r\nz");
        assert_eq!(vt.scrollback(), ["ab日", "界x"]);
        assert_eq!(vt.row_text(1), "z");
    }

    #[test]
    fn a_combining_mark_joins_and_a_variation_selector_widens() {
        let mut vt = VtGrid::new(6, 1);
        vt.feed("e\u{301}x".as_bytes());
        assert_eq!(vt.grid().cell(0, 0).unwrap().text(), "e\u{301}");
        assert_eq!(vt.grid().cell(1, 0).unwrap().text(), "x");
    }

    #[test]
    fn an_ink_frame_becomes_a_grid() {
        let frame = "\x1b[31mred\x1b[39m \x1b]8;;http://u\x07日本\x1b]8;;\x07!\x1b[0m\nplain";
        let grid = grid_from_ink_frame_with(frame, 12, false);
        assert_eq!(grid.height, 2);
        assert_eq!(grid.cell(0, 0).unwrap().style.fg, Color::Indexed(1));
        assert_eq!(grid.cell(3, 0).unwrap().style.fg, Color::Default);
        assert_eq!(grid.cell(4, 0).unwrap().width, 2);
        assert!(grid.cell(5, 0).unwrap().is_continuation());
        assert_eq!(grid.link_url(grid.cell(4, 0).unwrap().link), Some("http://u"));
        assert_eq!(grid.cell(8, 0).unwrap().text(), "!");
        assert_eq!(grid.cell(8, 0).unwrap().link, 0);
        assert_eq!(grid.row_text(1).trim_end(), "plain");
    }

    #[test]
    fn a_policy_widened_glyph_swallows_its_literal_blank() {
        let grid = grid_from_ink_frame_with("\u{2460} z", 6, true);
        assert_eq!(grid.cell(0, 0).unwrap().width, 2);
        assert!(grid.cell(1, 0).unwrap().is_continuation());
        assert_eq!(grid.cell(2, 0).unwrap().text(), "z");
    }
}
