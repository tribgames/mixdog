//! The frame writer's output replayed into the VT test grid: what `scripts/tui-frame-harness.mjs` asserted of Ink's
//! incremental log-update (a marker line keeps its absolute row from frame to frame, frames that shrink leave nothing
//! behind, a frame one row shorter than the screen does not move the bottom rows, a resize repaints cleanly), plus the
//! properties the cell diff adds: the screen always equals the frame, an unchanged frame writes nothing, every frame
//! is one synchronized update, and a style never leaks into cells an erase leaves.

use mixdog_term::frame::{Cell, Color, CursorPos, FrameWriter, Grid, Rgb, Style};
use mixdog_term::testing::VtGrid;

const ROWS: u16 = 40;
const COLS: u16 = 120;

/// The harness's `frame()`: `height` rows, the status line on the last one, the prompt above it, the slash palette
/// above the prompt when open, `t<row>` on the others.
fn frame(height: u16, palette: bool, cols: u16) -> Grid {
    let mut grid = Grid::new(cols, height);
    let status = height - 1;
    let prompt = status - 1;
    for row in 0..height {
        let text = if row == status {
            "STATUSLINE".to_owned()
        } else if row == prompt {
            "PROMPT>".to_owned()
        } else if palette && row + 1 == prompt {
            "SLASHPALETTE".to_owned()
        } else {
            format!("t{row}")
        };
        for (x, ch) in text.chars().enumerate() {
            grid.put_glyph(x as i32, i32::from(row), &ch.to_string(), 1, Style::default(), 0);
        }
    }
    grid
}

fn plain(style: Style) -> Style {
    let flat = |color: Color| match color {
        Color::Literal(rgb) => Color::Rgb(rgb),
        other => other,
    };
    Style { fg: flat(style.fg), bg: flat(style.bg), ..style }
}

/// The screen holds exactly `frame` in its top rows and blank cells below.
fn assert_screen_is(screen: &VtGrid, frame: &Grid, context: &str) {
    let shown = screen.grid();
    assert_eq!(shown.width, frame.width, "{context}: width");
    for y in 0..shown.height {
        for x in 0..shown.width {
            let want = if y < frame.height { frame.cell(x, y).unwrap().clone() } else { Cell::blank() };
            let got = shown.cell(x, y).unwrap();
            if want.is_continuation() {
                assert!(got.is_continuation(), "{context}: continuation at ({x}, {y})");
                continue;
            }
            assert_eq!((got.text(), got.width), (want.text(), want.width), "{context}: glyph at ({x}, {y})");
            assert_eq!(plain(got.style), plain(want.style), "{context}: style at ({x}, {y})");
            assert_eq!(shown.link_url(got.link), frame.link_url(want.link), "{context}: link at ({x}, {y})");
        }
    }
}

struct Session {
    writer: FrameWriter<Vec<u8>>,
    screen: VtGrid,
    replayed: usize,
}

impl Session {
    fn new(rows: u16, cols: u16) -> Self {
        Self { writer: FrameWriter::new(Vec::new(), 3), screen: VtGrid::new(cols, rows), replayed: 0 }
    }

    /// Writes a frame, replays what it wrote, and returns the bytes.
    fn show(&mut self, grid: &Grid, cursor: Option<CursorPos>) -> Vec<u8> {
        self.writer.write_frame(grid, cursor).unwrap();
        let written = self.writer.get_ref()[self.replayed..].to_vec();
        self.replayed = self.writer.get_ref().len();
        self.screen.feed(&written);
        written
    }
}

#[test]
fn the_marker_lines_keep_their_absolute_rows_whether_the_palette_is_open_or_not() {
    let mut session = Session::new(ROWS, COLS);
    for (index, palette) in [true, false, false, true, false].into_iter().enumerate() {
        let grid = frame(ROWS, palette, COLS);
        session.show(&grid, None);
        assert_eq!(session.screen.find_row("PROMPT>"), Some(ROWS - 2), "frame {index}");
        assert_eq!(session.screen.find_row("STATUSLINE"), Some(ROWS - 1), "frame {index}");
        assert_eq!(session.screen.find_row("SLASHPALETTE").is_some(), palette, "frame {index}");
        assert_screen_is(&session.screen, &grid, &format!("frame {index}"));
    }
}

#[test]
fn a_frame_one_row_short_of_the_screen_leaves_no_stale_row_and_the_next_full_frame_restores_it() {
    let mut session = Session::new(ROWS, COLS);
    let mut previous: Option<u16> = None;
    for (index, height) in [ROWS, ROWS - 1, ROWS - 1, ROWS, ROWS].into_iter().enumerate() {
        let grid = frame(height, false, COLS);
        session.show(&grid, None);
        assert_eq!(session.screen.find_row("PROMPT>"), Some(height - 2), "frame {index}");
        assert_eq!(session.screen.find_row("STATUSLINE"), Some(height - 1), "frame {index}");
        assert_screen_is(&session.screen, &grid, &format!("frame {index}"));
        // The marker never visits a row other than the one its frame puts it on (no bounce through a third row).
        let prompt = session.screen.find_row("PROMPT>");
        if let (Some(before), Some(now)) = (previous, prompt) {
            assert!(before.abs_diff(now) <= 1, "frame {index}: the prompt jumped from {before} to {now}");
        }
        previous = prompt;
    }
}

#[test]
fn shrinking_frames_leave_nothing_behind() {
    let mut session = Session::new(ROWS, COLS);
    for height in [ROWS, ROWS - 1, ROWS - 3, ROWS - 3, 12, 3, ROWS] {
        let grid = frame(height, height % 2 == 0, COLS);
        session.show(&grid, None);
        assert_screen_is(&session.screen, &grid, &format!("height {height}"));
        for y in height..ROWS {
            assert_eq!(session.screen.row_text(y), "", "height {height}: row {y} is stale");
        }
    }
}

#[test]
fn a_resize_clears_and_repaints_in_both_directions() {
    let mut session = Session::new(ROWS, COLS);
    session.show(&frame(ROWS, true, COLS), None);
    for (rows, cols) in [(30, 100), (ROWS, COLS), (20, 60)] {
        session.writer.resize();
        session.screen.resize(cols, rows);
        let grid = frame(rows, false, cols);
        let bytes = session.show(&grid, None);
        assert!(String::from_utf8_lossy(&bytes).contains("\x1b[2J"), "{rows}x{cols}: the screen is cleared");
        assert_screen_is(&session.screen, &grid, &format!("{rows}x{cols}"));
        assert_eq!(session.screen.find_row("SLASHPALETTE"), None);
    }
    // A change of width alone is a resize even if the caller did not say so.
    let grid = frame(20, false, 70);
    session.screen.resize(70, 20);
    session.show(&grid, None);
    assert_screen_is(&session.screen, &grid, "width only");
}

#[test]
fn an_unchanged_frame_writes_nothing_a_changed_row_writes_little_and_every_frame_is_one_synchronized_update() {
    let mut session = Session::new(ROWS, COLS);
    let mut grid = frame(ROWS, false, COLS);
    assert!(!session.show(&grid, None).is_empty());
    assert!(session.show(&grid, None).is_empty());
    grid.put_glyph(3, 5, "X", 1, Style::default(), 0);
    let bytes = session.show(&grid, None);
    assert!(bytes.len() < 64, "one changed cell wrote {} bytes", bytes.len());
    assert_eq!(session.screen.synchronized_updates(), 2);
    assert!(!session.screen.in_synchronized_update());
    grid.put_glyph(0, 7, "Z", 1, Style::default(), 0);
    session.show(&grid, Some(CursorPos { col: 2, row: 3 }));
    assert_eq!(session.screen.synchronized_updates(), 3);
}

#[test]
fn the_cursor_is_where_the_caller_put_it_after_every_frame_and_hidden_without_one() {
    let mut session = Session::new(ROWS, COLS);
    let mut grid = frame(ROWS, false, COLS);
    session.show(&grid, Some(CursorPos { col: 8, row: ROWS - 2 }));
    assert_eq!(session.screen.cursor(), (8, ROWS - 2));
    assert!(session.screen.cursor_visible());
    grid.put_glyph(20, 0, "q", 1, Style::default(), 0);
    session.show(&grid, Some(CursorPos { col: 8, row: ROWS - 2 }));
    assert_eq!(session.screen.cursor(), (8, ROWS - 2));
    assert!(session.screen.cursor_visible());
    session.show(&grid, Some(CursorPos { col: 9, row: ROWS - 2 }));
    assert_eq!(session.screen.cursor(), (9, ROWS - 2));
    grid.put_glyph(21, 0, "r", 1, Style::default(), 0);
    session.show(&grid, None);
    assert!(!session.screen.cursor_visible());
    // A cursor asked for beyond the grid is placed on its last cell.
    session.show(&grid, Some(CursorPos { col: 500, row: 500 }));
    assert_eq!(session.screen.cursor(), (COLS - 1, ROWS - 1));
}

#[test]
fn a_style_does_not_leak_into_cells_an_erase_leaves_or_into_the_next_row() {
    let mut session = Session::new(10, 30);
    let loud = Style { fg: Color::Rgb(Rgb::new(255, 0, 0)), bg: Color::Rgb(Rgb::new(0, 0, 255)), bold: true, ..Style::default() };
    let mut grid = Grid::new(30, 10);
    for x in 0..30 {
        grid.put_glyph(x, 2, "#", 1, loud, 0);
    }
    for x in 0..5 {
        grid.put_glyph(x, 3, "a", 1, loud, 0);
    }
    session.show(&grid, None);
    // The loud rows become short plain ones: the erased tail must be plain blank cells.
    let mut next = Grid::new(30, 10);
    for (x, ch) in "short".chars().enumerate() {
        next.put_glyph(x as i32, 2, &ch.to_string(), 1, Style::default(), 0);
    }
    session.show(&next, None);
    assert_screen_is(&session.screen, &next, "after the erase");
    for y in 0..10 {
        for x in 0..30 {
            let cell = session.screen.grid().cell(x, y).unwrap();
            if y == 2 && x < 5 {
                continue;
            }
            assert!(cell.is_plain_blank(), "({x}, {y}) kept a style: {cell:?}");
        }
    }
}

#[test]
fn force_full_repaint_clears_the_screen_and_writes_the_same_frame_again() {
    let mut session = Session::new(ROWS, COLS);
    let grid = frame(ROWS, true, COLS);
    session.show(&grid, Some(CursorPos { col: 3, row: 4 }));
    let before = session.writer.get_ref().len();
    let stats = session.writer.force_full_repaint().unwrap();
    let written = session.writer.get_ref()[before..].to_vec();
    session.replayed = session.writer.get_ref().len();
    assert_eq!(stats.bytes, written.len());
    assert!(String::from_utf8_lossy(&written).starts_with("\x1b[?2026h\x1b[?25l\x1b[0m\x1b[2J\x1b[3J\x1b[H"));
    session.screen.feed(&written);
    assert_screen_is(&session.screen, &grid, "after the forced repaint");
    assert_eq!(session.screen.cursor(), (3, 4));
    assert!(session.screen.scrollback().is_empty());
    // And it is a frame like another: the next identical one writes nothing.
    assert!(session.show(&grid, Some(CursorPos { col: 3, row: 4 })).is_empty());
}

/// A small deterministic generator for the frames of the next test.
struct Lcg(u64);

impl Lcg {
    fn next(&mut self, limit: u64) -> u64 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        (self.0 >> 33) % limit
    }
}

fn random_frame(rng: &mut Lcg, cols: u16, rows: u16) -> Grid {
    let mut grid = Grid::new(cols, rows);
    let link = grid.intern_link("https://example.com/x");
    let styles = [
        Style::default(),
        Style { bold: true, ..Style::default() },
        Style { fg: Color::Indexed(2), ..Style::default() },
        Style { fg: Color::Rgb(Rgb::new(200, 100, 50)), bg: Color::Indexed(4), ..Style::default() },
        Style { italic: true, underline: true, bg: Color::Rgb(Rgb::new(1, 2, 3)), ..Style::default() },
        Style { dim: true, inverse: true, strikethrough: true, ..Style::default() },
    ];
    let glyphs = ["a", "b", "Z", "9", " ", " ", "-", "日", "本", "語", "é"];
    for y in 0..rows {
        let mut x = 0;
        while x < cols {
            if rng.next(4) == 0 {
                x += 1;
                continue;
            }
            let glyph = glyphs[rng.next(glyphs.len() as u64) as usize];
            let cells = if glyph.chars().next().is_some_and(|c| c as u32 > 0x3000) { 2 } else { 1 };
            let style = styles[rng.next(styles.len() as u64) as usize];
            let linked = if rng.next(5) == 0 { link } else { 0 };
            grid.put_glyph(i32::from(x), i32::from(y), glyph, cells, style, linked);
            x += cells as u16;
        }
    }
    grid
}

#[test]
fn whatever_the_frames_the_replayed_screen_equals_the_frame() {
    let mut rng = Lcg(7);
    let (rows, cols) = (8, 33);
    let mut session = Session::new(rows, cols);
    let mut grid = random_frame(&mut rng, cols, rows);
    session.show(&grid, None);
    assert_screen_is(&session.screen, &grid, "first frame");
    for step in 0..120 {
        // Edit a few cells (some wide), or replace a row, or replace the whole frame.
        match rng.next(6) {
            0 => grid = random_frame(&mut rng, cols, rows),
            1 => {
                let fresh = random_frame(&mut rng, cols, rows);
                let y = rng.next(u64::from(rows)) as u16;
                for x in 0..cols {
                    let cell = fresh.cell(x, y).unwrap().clone();
                    grid.cells[usize::from(y) * usize::from(cols) + usize::from(x)] = cell;
                }
                grid.links.clone_from(&fresh.links);
            }
            _ => {
                for _ in 0..1 + rng.next(4) {
                    let (x, y) = (rng.next(u64::from(cols)) as i32, rng.next(u64::from(rows)) as i32);
                    let wide = rng.next(3) == 0 && x + 1 < i32::from(cols);
                    let (glyph, cells) = if wide { ("日", 2) } else { ("w", 1) };
                    let style = if rng.next(2) == 0 { Style { bold: true, ..Style::default() } } else { Style::default() };
                    grid.put_glyph(x, y, glyph, cells, style, 0);
                }
            }
        }
        // Whatever the edit left must still be a legal grid: no continuation without its head.
        for y in 0..rows {
            for x in 0..cols {
                let cell = grid.cell(x, y).unwrap();
                if cell.is_continuation() {
                    assert!(x > 0 && grid.cell(x - 1, y).unwrap().width == 2, "step {step}: orphan continuation");
                }
            }
        }
        session.show(&grid, None);
        assert_screen_is(&session.screen, &grid, &format!("step {step}"));
    }
}
