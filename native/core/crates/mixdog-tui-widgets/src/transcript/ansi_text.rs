//! `components/AnsiText.jsx`: text with SGR escapes drawn as styled spans, so an inner reset falls back to the default
//! colour of the text instead of the terminal profile's.
//!
//! The spans come from [`mixdog_termtext::spans::parse_sgr`]. The component reads the live theme while it parses: the
//! named foregrounds (`30` to `37`, `90` to `97`, and a 256-colour index below 16) are theme colours, the magenta and
//! cyan families and every named background are `ansi:` names that Ink's `colorize` does not know, so they paint
//! nothing, and an index from 16 up is the xterm cube or ramp. Strikethrough (`9`) is not read by the component and
//! is not drawn here either.

use mixdog_term::frame::{Color, Rgb, Style};
use mixdog_term::paint::TextWrap;
use mixdog_termtext::spans::{SgrColor, SgrStyle, parse_sgr, xterm256_rgb};
use mixdog_tui_style::{Key, Palette, current_palette};

use super::layout::TextBox;
use crate::grid_color;

/// The foreground an SGR colour has in the component: the theme colour of a named one, no colour for the `ansi:` names.
fn foreground(color: SgrColor, palette: &Palette) -> Color {
    let key = match color {
        SgrColor::Rgb(r, g, b) => return Color::Rgb(Rgb::new(r, g, b)),
        SgrColor::Indexed(index) if index >= 16 => {
            return xterm256_rgb(index).map_or(Color::Default, |(r, g, b)| Color::Rgb(Rgb::new(r, g, b)));
        }
        SgrColor::Indexed(0 | 8) => Key::Subtle,
        SgrColor::Indexed(1 | 9) => Key::Error,
        SgrColor::Indexed(2 | 10) => Key::Success,
        SgrColor::Indexed(3 | 11) => Key::Warning,
        SgrColor::Indexed(4 | 12) => Key::Code,
        SgrColor::Indexed(7) => Key::Text,
        SgrColor::Indexed(15) => Key::StatusText,
        SgrColor::Indexed(_) => return Color::Default,
    };
    grid_color(palette[key])
}

/// The background an SGR colour has in the component: only a truecolour or an index from 16 up paints.
fn background(color: SgrColor) -> Color {
    match color {
        SgrColor::Rgb(r, g, b) => Color::Rgb(Rgb::new(r, g, b)),
        SgrColor::Indexed(index) => xterm256_rgb(index).map_or(Color::Default, |(r, g, b)| Color::Rgb(Rgb::new(r, g, b))),
    }
}

/// The style of a span: the colour the text started in unless the span sets one.
fn span_style(style: &SgrStyle, default_color: Color, palette: &Palette) -> Style {
    Style {
        fg: style.foreground.map_or(default_color, |color| foreground(color, palette)),
        bg: style.background.map_or(Color::Default, background),
        bold: style.bold,
        dim: style.dim,
        italic: style.italic,
        underline: style.underline,
        inverse: style.inverse,
        strikethrough: false,
    }
}

/// `text` written in `style`: the style opened before it and closed after it, each of its lines on its own.
fn styled_text(text: &str, style: Style) -> String {
    let (mut open, mut close): (Vec<String>, Vec<&str>) = (Vec::new(), Vec::new());
    if style.dim {
        open.push("2".to_owned());
    }
    for (base, color, reset) in [(38, style.fg, "39"), (48, style.bg, "49")] {
        if let Color::Rgb(rgb) | Color::Literal(rgb) = color {
            open.push(format!("{base};2;{};{};{}", rgb.r, rgb.g, rgb.b));
            close.push(reset);
        }
    }
    for (flag, code, reset) in [(style.bold, "1", "22"), (style.italic, "3", "23"), (style.underline, "4", "24"), (style.inverse, "7", "27")] {
        if flag {
            open.push(code.to_owned());
            if !close.contains(&reset) {
                close.push(reset);
            }
        }
    }
    if style.dim && !close.contains(&"22") {
        close.push("22");
    }
    if open.is_empty() {
        return text.to_owned();
    }
    let (open, close) = (format!("\x1b[{}m", open.join(";")), format!("\x1b[{}m", close.join(";")));
    text.split('\n').map(|line| if line.is_empty() { String::new() } else { format!("{open}{line}{close}") }).collect::<Vec<_>>().join("\n")
}

/// The string an Ink `<Text>` holds for `AnsiText`'s spans: every span in its own style over `default_color`, a hyperlink
/// kept around the text it covers.
pub(crate) fn ansi_text_string(text: &str, default_color: Color) -> String {
    let palette = current_palette();
    parse_sgr(text)
        .iter()
        .map(|line| {
            line.runs
                .iter()
                .map(|run| {
                    let styled = styled_text(&run.text, span_style(&run.style, default_color, &palette));
                    match &run.link {
                        Some(link) => format!("\x1b]8;{};{}\x07{styled}\x1b]8;;\x07", link.parameters, link.uri),
                        None => styled,
                    }
                })
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// `<AnsiText defaultColor>` in a box `width` cells wide (`wrap` is Ink's default).
pub(crate) fn ansi_text_box(text: &str, default_color: Color, width: usize) -> TextBox {
    TextBox::new(ansi_text_string(text, default_color), Style::default(), TextWrap::Wrap, width)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rgb(r: u8, g: u8, b: u8) -> Color {
        Color::Rgb(Rgb::new(r, g, b))
    }

    #[test]
    fn a_reset_falls_back_to_the_default_colour() {
        let text = ansi_text_string("\x1b[1mBold\x1b[22m plain", rgb(4, 5, 6));
        assert_eq!(text, "\x1b[38;2;4;5;6;1mBold\x1b[39;22m\x1b[38;2;4;5;6m plain\x1b[39m");
    }

    #[test]
    fn truecolour_and_256_colour_codes_keep_their_colour() {
        assert!(ansi_text_string("\x1b[38;2;1;2;3mx\x1b[39m y", rgb(4, 5, 6)).starts_with("\x1b[38;2;1;2;3mx\x1b[39m"));
        assert!(ansi_text_string("\x1b[38;5;196mred", Color::Default).contains("38;2;255;0;0"));
        assert!(ansi_text_string("\x1b[48;5;21mbg", Color::Default).contains("48;2;0;0;255"));
        assert!(ansi_text_string("\x1b[48;2;7;8;9mbg\x1b[49m plain", Color::Default).contains("48;2;7;8;9"));
    }

    #[test]
    fn named_colours_are_theme_colours_and_the_ansi_names_paint_nothing() {
        let palette = current_palette();
        let error = grid_color(palette[Key::Error]);
        assert_eq!(span_style(&parse_sgr("\x1b[31mx")[0].runs[0].style, Color::Default, &palette).fg, error);
        assert_eq!(span_style(&parse_sgr("\x1b[91mx")[0].runs[0].style, Color::Default, &palette).fg, error);
        assert_eq!(span_style(&parse_sgr("\x1b[35mx")[0].runs[0].style, rgb(1, 1, 1), &palette).fg, Color::Default);
        assert_eq!(span_style(&parse_sgr("\x1b[41mx")[0].runs[0].style, Color::Default, &palette).bg, Color::Default);
        assert_eq!(span_style(&parse_sgr("\x1b[38;5;1mx")[0].runs[0].style, Color::Default, &palette).fg, error);
    }

    #[test]
    fn an_unknown_code_and_an_escape_only_text_leave_no_text() {
        assert_eq!(ansi_text_string("\x1b[999mplain", Color::Default), "plain");
        assert_eq!(ansi_text_string("\x1b[31m", Color::Default), "");
        assert_eq!(ansi_text_box("\x1b[31m", Color::Default, 10).rows(), 0);
    }

    #[test]
    fn a_hyperlink_stays_around_its_text_and_lines_are_styled_one_by_one() {
        let text = ansi_text_string("\x1b]8;;http://x.y\x07\x1b[1mab\ncd\x1b[22m\x1b]8;;\x07", Color::Default);
        assert_eq!(text, "\x1b]8;;http://x.y\x07\x1b[1mab\x1b[22m\x1b]8;;\x07\n\x1b]8;;http://x.y\x07\x1b[1mcd\x1b[22m\x1b]8;;\x07");
    }

    #[test]
    fn a_style_closes_only_what_it_opened() {
        let style = Style { bold: true, dim: true, underline: true, ..Style::default() };
        assert_eq!(styled_text("x", style), "\x1b[2;1;4mx\x1b[22;24m");
    }
}
