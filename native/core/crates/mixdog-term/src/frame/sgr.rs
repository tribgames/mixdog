//! Reading SGR parameters and OSC 8 hyperlinks into a [`Style`] and a url; shared by the painter (strings that carry
//! escapes), the VT test grid and the Ink frame parser.

use super::{Color, Rgb, Style};

/// Applies one SGR sequence (`ESC [ params m`, the parameters flattened to a list; an empty list is a reset) to a
/// style. Unknown parameters are ignored, as a terminal does.
pub fn apply_sgr(style: &mut Style, params: &[u16]) {
    if params.is_empty() {
        *style = Style::default();
        return;
    }
    let mut at = 0;
    while at < params.len() {
        let code = params[at];
        at += 1;
        match code {
            0 => *style = Style::default(),
            1 => style.bold = true,
            2 => style.dim = true,
            3 => style.italic = true,
            4 => style.underline = true,
            7 => style.inverse = true,
            9 => style.strikethrough = true,
            22 => {
                style.bold = false;
                style.dim = false;
            }
            23 => style.italic = false,
            24 => style.underline = false,
            27 => style.inverse = false,
            29 => style.strikethrough = false,
            30..=37 => style.fg = Color::Indexed((code - 30) as u8),
            38 => style.fg = extended_color(params, &mut at).unwrap_or(style.fg),
            39 => style.fg = Color::Default,
            40..=47 => style.bg = Color::Indexed((code - 40) as u8),
            48 => style.bg = extended_color(params, &mut at).unwrap_or(style.bg),
            49 => style.bg = Color::Default,
            90..=97 => style.fg = Color::Indexed((code - 90 + 8) as u8),
            100..=107 => style.bg = Color::Indexed((code - 100 + 8) as u8),
            _ => {}
        }
    }
}

/// `5;n` or `2;r;g;b` after a 38 or 48; `at` moves past what was read.
fn extended_color(params: &[u16], at: &mut usize) -> Option<Color> {
    let mode = *params.get(*at)?;
    *at += 1;
    match mode {
        5 => {
            let index = *params.get(*at)?;
            *at += 1;
            Some(Color::Indexed(index.min(255) as u8))
        }
        2 => {
            let channel = |offset: usize| params.get(*at + offset).map(|value| (*value).min(255) as u8);
            let (r, g, b) = (channel(0)?, channel(1)?, channel(2)?);
            *at += 3;
            Some(Color::Rgb(Rgb { r, g, b }))
        }
        _ => None,
    }
}

/// The target of an OSC 8 hyperlink: `osc` is the text between `ESC ]` and the terminator (`8;params;url`). `Some(url)`
/// opens a link (an empty url closes it); `None` is any other OSC.
pub fn parse_hyperlink(osc: &str) -> Option<&str> {
    let rest = osc.strip_prefix("8;")?;
    let (_, url) = rest.split_once(';')?;
    Some(url)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn applied(params: &[u16]) -> Style {
        let mut style = Style::default();
        apply_sgr(&mut style, params);
        style
    }

    #[test]
    fn attributes_open_and_close() {
        let style = applied(&[1, 3, 4, 9]);
        assert!(style.bold && style.italic && style.underline && style.strikethrough);
        let mut style = applied(&[1, 2, 7]);
        apply_sgr(&mut style, &[22, 27]);
        assert!(!style.bold && !style.dim && !style.inverse);
    }

    #[test]
    fn colours_in_every_form() {
        assert_eq!(applied(&[31]).fg, Color::Indexed(1));
        assert_eq!(applied(&[93]).fg, Color::Indexed(11));
        assert_eq!(applied(&[44]).bg, Color::Indexed(4));
        assert_eq!(applied(&[105]).bg, Color::Indexed(13));
        assert_eq!(applied(&[38, 5, 200]).fg, Color::Indexed(200));
        assert_eq!(applied(&[48, 2, 1, 2, 3]).bg, Color::Rgb(Rgb::new(1, 2, 3)));
        let style = applied(&[1, 38, 2, 255, 0, 10, 4]);
        assert_eq!(style.fg, Color::Rgb(Rgb::new(255, 0, 10)));
        assert!(style.bold && style.underline);
        let mut style = applied(&[31, 41]);
        apply_sgr(&mut style, &[39, 49]);
        assert_eq!(style, Style::default());
    }

    #[test]
    fn an_empty_list_and_zero_reset() {
        let mut style = applied(&[1, 31]);
        apply_sgr(&mut style, &[]);
        assert_eq!(style, Style::default());
        let mut style = applied(&[1, 31]);
        apply_sgr(&mut style, &[0, 3]);
        assert_eq!(style, Style { italic: true, ..Style::default() });
    }

    #[test]
    fn a_truncated_extended_colour_is_ignored() {
        assert_eq!(applied(&[38, 2, 1]).fg, Color::Default);
    }

    #[test]
    fn hyperlinks() {
        assert_eq!(parse_hyperlink("8;;https://example.com/a;b"), Some("https://example.com/a;b"));
        assert_eq!(parse_hyperlink("8;id=1;http://x"), Some("http://x"));
        assert_eq!(parse_hyperlink("8;;"), Some(""));
        assert_eq!(parse_hyperlink("0;title"), None);
    }
}
