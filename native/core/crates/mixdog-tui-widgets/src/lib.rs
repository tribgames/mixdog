//! The widgets of the terminal UI (`src/tui/components/*.jsx`).
//!
//! The widget contract: a widget is a pure function from its props (the props the `.jsx` receives, as typed structs)
//! and the columns to rows painted on a [`mixdog_term::paint::Painter`], and a second function gives the exact row
//! count of the same props (the layout code reserves rows from it). Keyboard handling is a pure state transition that
//! returns what the owner has to do; nothing here reads a clock, the clipboard or the terminal.
//!
//! * [`picker`], [`palette`], [`question`], [`confirm_bar`], [`sign_in_url`], [`text_entry`], [`hint_overprint`]: the
//!   panels and bars of this crate's first task.
//! * [`panel_cell_text`] and [`text_layout`]: the cell-width helpers the panels share.
//! * [`transcript`], [`tool_cards`], [`spinner`], [`statusline`], [`panels`]: filled by the widget tasks that follow.

use mixdog_term::frame::{Color, Rgb, Style};
use mixdog_term::paint::{Painter, TextWrap};
use mixdog_tui_style::theme::Color as ThemeColor;
use mixdog_tui_style::{Key, theme_color};

pub mod confirm_bar;
pub mod hint_overprint;
pub mod palette;
pub mod panel_cell_text;
pub mod panels;
pub mod picker;
pub mod question;
pub mod sign_in_url;
pub mod spinner;
pub mod statusline;
pub mod text_entry;
pub mod text_layout;
pub mod tool_cards;
pub mod transcript;

/// One painted row of a widget that renders to lines: text carrying SGR and OSC 8 escapes, no line break.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Line(pub String);

/// The grid colour of a palette value (`transparent` is the terminal's own colour).
pub fn grid_color(color: ThemeColor) -> Color {
    match color {
        ThemeColor::Rgb(r, g, b) => Color::Rgb(Rgb::new(r, g, b)),
        ThemeColor::Transparent => Color::Default,
    }
}

/// The style of text coloured with a key of the live theme (`<Text color={theme.key}>`).
pub fn themed(key: Key) -> Style {
    Style { fg: grid_color(theme_color(key)), ..Style::default() }
}

/// The style of a selected row (`color={theme.selectionText}` on `backgroundColor={theme.selectionBackground}`).
pub fn selected_style() -> Style {
    Style { fg: grid_color(theme_color(Key::SelectionText)), bg: grid_color(theme_color(Key::SelectionBackground)), ..Style::default() }
}

/// A piece of text with its own style, the children of a nested `<Text>`.
pub type Run = (String, Style);

/// `text` written in `style` as an SGR string, so a styled run can go through the width-aware fitting of the painter. The
/// run closes only what it opened, so the text after it keeps the style the line starts in, and each of its lines is styled
/// on its own (a nested `<Text>` colours line by line), so a run that spans a line break is styled on both sides of it.
fn styled(text: &str, style: Style) -> String {
    let (mut open, mut close): (Vec<String>, Vec<&str>) = (Vec::new(), Vec::new());
    if style.bold {
        open.push("1".to_owned());
        close.push("22");
    }
    for (base, color, reset) in [(38, style.fg, "39"), (48, style.bg, "49")] {
        match color {
            Color::Rgb(rgb) | Color::Literal(rgb) => open.push(format!("{base};2;{};{};{}", rgb.r, rgb.g, rgb.b)),
            Color::Indexed(index) => open.push(format!("{base};5;{index}")),
            Color::Default => continue,
        }
        close.push(reset);
    }
    if open.is_empty() {
        return text.to_owned();
    }
    let (open, close) = (format!("\x1b[{}m", open.join(";")), format!("\x1b[{}m", close.join(";")));
    text.split('\n').map(|line| if line.is_empty() { String::new() } else { format!("{open}{line}{close}") }).collect::<Vec<_>>().join("\n")
}

/// The runs joined into one SGR string.
pub fn runs_to_ansi(runs: &[Run]) -> String {
    runs.iter().map(|(text, style)| styled(text, *style)).collect()
}

/// The visible width of the runs under the display-width policy (Ink measures a `<Text>` that way).
pub fn runs_width(runs: &[Run]) -> usize {
    runs.iter().map(|(text, _)| mixdog_termtext::display_width(text)).sum()
}

/// Paints runs one after the other on row `y` from `x`, without fitting them. Returns the cells advanced.
pub fn paint_runs(painter: &mut Painter, x: i32, y: i32, runs: &[Run]) -> usize {
    let mut at = x;
    for (text, style) in runs {
        at += painter.line(at, y, text, *style) as i32;
    }
    (at - x).max(0) as usize
}


/// The width of a flex item that holds one `<Text>`: the widest of its lines.
pub(crate) fn text_width(text: &str) -> usize {
    text.split('\n').map(mixdog_termtext::display_width).max().unwrap_or(0)
}

/// The rows an Ink `<Text>` takes in `width` cells in `mode`.
pub(crate) fn fitted_rows(text: &str, width: usize, mode: TextWrap) -> u16 {
    mixdog_termtext::wrap::wrap_text(text, width, mode).split('\n').count() as u16
}

/// The width Yoga asks a text for first: the text as it is when it fits, else its widest line wrapped (or truncated) to the
/// width (a wrapped line keeps its trailing blank, so the line can be the whole width).
pub(crate) fn basis(text: &str, width: usize, mode: TextWrap) -> usize {
    let natural = text_width(text);
    if natural <= width {
        return natural;
    }
    mixdog_termtext::wrap::wrap_text(text, width, mode).split('\n').map(mixdog_termtext::display_width).max().unwrap_or(0)
}

/// Where a row of two `<Text>` children puts them when both fit.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Justify {
    /// The first at the left and the second flush right (`justifyContent="space-between"`).
    Between,
    /// One after the other from the left.
    Start,
}

/// How a row (`<Box flexDirection="row">`) of two `<Text>` children is laid out in `width` cells.
///
/// Both fit: placed as `justify` says. Otherwise Yoga shrinks both in proportion to the width each asked for,
/// `basis * width / sum`; a text node is then laid out from the floor of its left edge to the ceiling of its right edge, so
/// the first is `ceil(share)` wide and the second starts at `floor(share)` and ends at the right edge (the two may overlap
/// by a cell, and the second overprints the first). Each wraps (or truncates) in the width it ends up with.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Split {
    pub left_cells: usize,
    pub right_x: usize,
    pub right_cells: usize,
    pub rows: u16,
}

/// The wrap modes of the two texts of a row.
pub(crate) type Modes = (TextWrap, TextWrap);

pub(crate) fn split_row(left: &str, right: &str, width: usize, modes: Modes, justify: Justify) -> Split {
    let (left_basis, right_basis) = (basis(left, width, modes.0), basis(right, width, modes.1));
    let (left_cells, right_cells, right_x, rows) = if left_basis + right_basis <= width {
        let rows = fitted_rows(left, left_basis, modes.0).max(fitted_rows(right, right_basis, modes.1));
        (left_basis, right_basis, if justify == Justify::Between { width - right_basis } else { left_basis }, rows)
    } else {
        // Yoga compares with a tolerance of 1e-4 when it decides whether an edge is on a whole cell.
        let share = left_basis as f64 * width as f64 / (left_basis + right_basis) as f64;
        let right_x = ((share + 1e-4).floor() as usize).min(width);
        // The height of a row is the taller text measured at the width Yoga gave it, which is the fraction itself; the
        // text is then painted in the whole cells it is laid out in (see above).
        let rows = measured_rows(left, share, modes.0).max(measured_rows(right, width as f64 - share, modes.1));
        ((share - 1e-4).ceil() as usize, width - right_x, right_x, rows)
    };
    Split { left_cells, right_x, right_cells, rows: rows.max(1) }
}

/// The rows an Ink `<Text>` is measured at in a (fractional) `width`.
fn measured_rows(text: &str, width: f64, mode: TextWrap) -> u16 {
    mixdog_termtext::wrap::wrap_text_fractional(text, width, mode).split('\n').count() as u16
}

/// Paints a [`split_row`] with its two texts and returns its rows.
pub(crate) fn paint_split(painter: &mut Painter, x: i32, y: i32, split: &Split, left: &Run, right: &Run, modes: Modes) -> u16 {
    painter.text(x, y, &left.0, left.1, split.left_cells, modes.0);
    painter.text(x + split.right_x as i32, y, &right.0, right.1, split.right_cells, modes.1);
    split.rows
}
