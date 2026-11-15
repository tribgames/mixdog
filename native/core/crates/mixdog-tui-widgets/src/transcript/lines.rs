//! A painted grid as the lines the transcript hands on: each row is text carrying SGR and OSC 8 escapes, trailing plain
//! blanks cut (Ink trims a line's end; a blank that carries a background is kept).

use mixdog_term::frame::{Color, Grid, Style};

use crate::Line;

/// The SGR parameters that set `style` from the default style, empty for the default.
fn style_codes(style: Style) -> String {
    let mut codes: Vec<String> = Vec::new();
    for (flag, code) in [
        (style.bold, "1"),
        (style.dim, "2"),
        (style.italic, "3"),
        (style.underline, "4"),
        (style.inverse, "7"),
        (style.strikethrough, "9"),
    ] {
        if flag {
            codes.push(code.to_owned());
        }
    }
    for (color, basic, bright, extended) in [(style.fg, 30u16, 90u16, 38), (style.bg, 40, 100, 48)] {
        match color {
            Color::Default => {}
            Color::Indexed(index) if index < 8 => codes.push((basic + u16::from(index)).to_string()),
            Color::Indexed(index) if index < 16 => codes.push((bright + u16::from(index) - 8).to_string()),
            Color::Indexed(index) => codes.push(format!("{extended};5;{index}")),
            Color::Rgb(rgb) | Color::Literal(rgb) => codes.push(format!("{extended};2;{};{};{}", rgb.r, rgb.g, rgb.b)),
        }
    }
    codes.join(";")
}

/// Row `y` of `grid` as one line.
fn row_line(grid: &Grid, y: u16) -> String {
    let row = grid.row(y);
    let end = row.iter().rposition(|cell| !cell.is_plain_blank()).map_or(0, |at| at + 1);
    let mut out = String::new();
    let mut style = Style::default();
    let mut link = 0u32;
    for cell in &row[..end] {
        if cell.is_continuation() {
            continue;
        }
        if cell.link != link {
            match grid.link_url(cell.link) {
                Some(url) => out.push_str(&format!("\x1b]8;;{url}\x07")),
                None => out.push_str("\x1b]8;;\x07"),
            }
            link = cell.link;
        }
        if cell.style != style {
            out.push_str("\x1b[0m");
            let codes = style_codes(cell.style);
            if !codes.is_empty() {
                out.push_str(&format!("\x1b[{codes}m"));
            }
            style = cell.style;
        }
        out.push_str(cell.text());
    }
    if link != 0 {
        out.push_str("\x1b]8;;\x07");
    }
    if style != Style::default() {
        out.push_str("\x1b[0m");
    }
    out
}

/// Every row of the grid as a line.
pub(crate) fn grid_lines(grid: &Grid) -> Vec<Line> {
    (0..grid.height).map(|y| Line(row_line(grid, y))).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use mixdog_term::frame::{Rect, Rgb};
    use mixdog_term::paint::Painter;

    #[test]
    fn a_row_keeps_styles_links_and_wide_glyphs_and_drops_trailing_blanks() {
        let mut grid = Grid::new(12, 2);
        let mut painter = Painter::new(&mut grid);
        painter.line(0, 0, "a\x1b[1;38;2;1;2;3mb\x1b[0m \x1b]8;;http://x\x07\u{754c}\x1b]8;;\x07", Style::default());
        let lines = grid_lines(&grid);
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[1].0, "");
        assert_eq!(lines[0].0, "a\x1b[0m\x1b[1;38;2;1;2;3mb\x1b[0m \x1b]8;;http://x\x07\u{754c}\x1b]8;;\x07");
    }

    #[test]
    fn a_background_blank_is_kept_and_read_back_as_the_same_cells() {
        let mut grid = Grid::new(6, 1);
        let band = Style { bg: Color::Rgb(Rgb::new(9, 8, 7)), ..Style::default() };
        Painter::new(&mut grid).fill(Rect::new(0, 0, 4, 1), band);
        let line = grid_lines(&grid).remove(0).0;
        assert_eq!(line, "\x1b[0m\x1b[48;2;9;8;7m    \x1b[0m");
        let back = mixdog_term::testing::grid_from_ink_frame_with(&line, 6, false);
        assert_eq!(back.cell(3, 0).unwrap().style, band);
        assert!(back.cell(4, 0).unwrap().is_plain_blank());
    }
}
