//! The empty-transcript header and the boot splash that is painted at the same place before the first frame
//! (`src/tui/app/app-view/welcome-banner.jsx`, `paintBootSplash` of `src/tui/index.jsx`): the block-letter logo, then the
//! line with the version and the working directory.

use mixdog_term::frame::Style;
use mixdog_term::paint::{Painter, TextWrap};
use mixdog_termtext::display_width;
use mixdog_tui_style::color::Styler;
use mixdog_tui_style::theme::Color as ThemeColor;
use mixdog_tui_style::{Key, theme_color};
use mixdog_tui_widgets::themed;

use super::format::center_line;
use crate::surface::layout::WELCOME_BANNER_ROWS;

/// The rows of the logo and whether each one is drawn in the accent colour (the first two are the text colour).
pub const LOGO_ROWS: [(&str, bool); 5] = [
    ("███╗   ███╗██╗██╗  ██╗██████╗  ██████╗  ██████╗ ", false),
    ("████╗ ████║██║╚██╗██╔╝██╔══██╗██╔═══██╗██╔════╝ ", false),
    ("██╔████╔██║██║ ╚███╔╝ ██║  ██║██║   ██║██║  ███╗", true),
    ("██║╚██╔╝██║██║ ██╔██╗ ██║  ██║██║   ██║██║   ██║", true),
    ("██║ ╚═╝ ██║██║██╔╝ ██╗██████╔╝╚██████╔╝╚██████╔╝", true),
];

/// The line under the logo: the agent, the version and the working directory.
pub fn subtitle(version: &str, cwd: &str) -> String {
    format!("mixdog coding agent \u{b7} v{version} \u{b7} {cwd}")
}

/// Paints the banner with its top at row `y`, `frame_columns` wide: three blank rows, the logo, a blank row and the subtitle
/// (centred with a margin of four, dimmed). Returns the rows it reserves ([`WELCOME_BANNER_ROWS`]).
pub fn paint_welcome_banner(painter: &mut Painter, y: i32, frame_columns: usize, cwd: &str, version: &str) -> usize {
    let first = y + 3;
    for (offset, (line, accent)) in LOGO_ROWS.iter().enumerate() {
        let style = Style { bold: true, ..themed(if *accent { Key::Logo } else { Key::Text }) };
        painter.text(0, first + offset as i32, &center_line(line, frame_columns, 0), style, frame_columns, TextWrap::Wrap);
    }
    painter.text(0, first + 6, &center_line(&subtitle(version, cwd), frame_columns, 4), themed(Key::Inactive), frame_columns, TextWrap::Wrap);
    WELCOME_BANNER_ROWS
}

/// `ansiFg(color)`: the foreground code of a palette colour, empty for a transparent one.
fn foreground(styler: Styler, color: ThemeColor) -> String {
    match color {
        ThemeColor::Rgb(r, g, b) => styler.rgb_sgr(f64::from(r), f64::from(g), f64::from(b), false),
        ThemeColor::Transparent => String::new(),
    }
}

/// Whether the terminal is Windows-like (Windows itself, or Windows Terminal reached through another host): its last column
/// is kept free, so the splash is one column narrower.
pub fn windows_like_terminal(var: impl Fn(&str) -> Option<String>) -> bool {
    cfg!(windows) || var("WT_SESSION").is_some_and(|value| !value.is_empty())
}

/// `paintBootSplash()`: the escape sequence that paints the logo and the subtitle into the alternate screen at the rows and
/// columns of the banner (the first frame then overprints it in place), and parks the cursor at home so that frame paints
/// top-down. The bottom picker and prompt are not painted: the first frame may hide or move them while the project picker
/// settles.
pub fn boot_splash(columns: usize, windows_like: bool, cwd: &str, version: &str, styler: Styler) -> String {
    let frame_columns = columns.max(1).saturating_sub(usize::from(windows_like)).max(1);
    let center = |text: &str, reserve: usize| {
        let free = frame_columns as i64 - reserve as i64 - display_width(text) as i64;
        format!("{}{text}", " ".repeat((free / 2).max(0) as usize))
    };
    let text = foreground(styler, theme_color(Key::Text));
    let accent = Some(foreground(styler, theme_color(Key::Logo))).filter(|code| !code.is_empty()).unwrap_or_else(|| text.clone());
    let subtle = foreground(styler, theme_color(Key::Inactive));
    let (bold, reset) = ("\x1b[1m", "\x1b[0m");
    // Row 4 is the banner's top margin of three rows.
    let mut out = String::from("\x1b[4;1H");
    for (index, (line, _)) in LOGO_ROWS.iter().enumerate() {
        let fg = if index < 2 { &text } else { &accent };
        out.push_str(&format!("{bold}{fg}{}{reset}\r\n", center(line, 0)));
    }
    out.push_str("\r\n");
    out.push_str(&format!("{subtle}{}{reset}", center(&subtitle(version, cwd), 4)));
    out.push_str("\x1b[H");
    out
}

#[cfg(test)]
mod tests {
    use mixdog_term::frame::Grid;
    use mixdog_term::testing::VtGrid;

    use super::*;

    #[test]
    fn the_logo_is_five_rows_and_the_last_three_are_the_accent() {
        assert_eq!(LOGO_ROWS.iter().filter(|(_, accent)| *accent).count(), 3);
        assert!(!LOGO_ROWS[0].1 && !LOGO_ROWS[1].1);
    }

    #[test]
    fn the_banner_takes_its_eleven_rows_and_draws_the_logo_below_a_three_row_margin() {
        let mut grid = Grid::new(80, 12);
        let rows = paint_welcome_banner(&mut Painter::new(&mut grid), 0, 79, "C:/work", "1.2.3");
        assert_eq!(rows, 11);
        assert!(grid.row_text(2).trim().is_empty());
        assert!(grid.row_text(3).contains('\u{2588}'));
        assert!(grid.row_text(7).contains('\u{2588}'));
        assert!(grid.row_text(8).trim().is_empty());
        assert!(grid.row_text(9).contains("mixdog coding agent \u{b7} v1.2.3 \u{b7} C:/work"));
        assert!(grid.row_text(10).trim().is_empty());
    }

    #[test]
    fn the_splash_lands_where_the_banner_is_and_parks_the_cursor_at_home() {
        let styler = Styler::new(true, true);
        let splash = boot_splash(80, false, "C:/work", "1.2.3", styler);
        assert!(splash.starts_with("\x1b[4;1H") && splash.ends_with("\x1b[H"));
        let mut vt = VtGrid::new(80, 24);
        vt.feed(splash.as_bytes());
        // The logo starts on row 4 (index 3) and the subtitle is two rows under its last row.
        assert!(vt.row_text(3).contains('\u{2588}'));
        assert!(vt.row_text(9).contains("mixdog coding agent"));
        assert_eq!(vt.cursor(), (0, 0));
        // A Windows-like terminal keeps its last column free: one column narrower.
        let narrow = boot_splash(80, true, "C:/work", "1.2.3", styler);
        assert_ne!(narrow, splash);
        assert!(boot_splash(1, false, "", "", styler).contains("\r\n"));
    }

    #[test]
    fn windows_terminal_is_windows_like_wherever_it_runs() {
        assert!(windows_like_terminal(|name| (name == "WT_SESSION").then(|| "x".to_owned())));
        assert_eq!(windows_like_terminal(|_| None), cfg!(windows));
        assert_eq!(windows_like_terminal(|_| Some(String::new())), cfg!(windows));
    }
}
