//! Text with SGR escapes as styled runs: the parser of `src/tui/components/AnsiText.jsx` (`parseAnsi` and
//! `applySgr`), without the theme.
//!
//! The JavaScript component turns SGR colours into theme colours while it parses (`30` and `90` are `theme.subtle`,
//! `31` and `91` `theme.error`, ...), and a 256-colour index below 16 through the same table. Here a colour stays
//! what the text said: `Indexed(n)` for the 16 named colours (`30..=37` and `40..=47` are 0 to 7, `90..=97` and
//! `100..=107` are 8 to 15) and for `38;5;n`, `Rgb` for `38;2;r;g;b`; the renderer maps an index below 16 to its
//! theme colour and an index from 16 up with [`xterm256_rgb`], exactly as the component did.
//!
//! What the port keeps from the component, quirk included: empty parameters are dropped (`1;;2` is `1;2`), an
//! unknown code is ignored, a `38`/`48` that cannot be decoded changes nothing and leaves its parameters to be read
//! as codes of their own, `22` clears bold and dim together, and a run is cut at every SGR sequence even when it
//! changes nothing. What it adds, as the plan of the port names: strikethrough (`9`, `29`) and OSC 8 hyperlinks
//! (each run carries the link open at it; the sequences are not left in the text). A truecolour component above 255
//! cannot be a `u8`: such a colour is treated as undecodable. The text is split into lines at `\n`, the style and
//! the link carrying over; empty runs are not produced.

/// A colour set by SGR.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SgrColor {
    Indexed(u8),
    Rgb(u8, u8, u8),
}

/// The attributes SGR sets.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SgrStyle {
    pub bold: bool,
    pub dim: bool,
    pub italic: bool,
    pub underline: bool,
    pub inverse: bool,
    pub strikethrough: bool,
    pub foreground: Option<SgrColor>,
    pub background: Option<SgrColor>,
}

/// An OSC 8 hyperlink: its parameters (`id=x:...`, possibly empty) and its target.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SgrLink {
    pub parameters: String,
    pub uri: String,
}

/// A stretch of text in one style.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StyledRun {
    pub text: String,
    pub style: SgrStyle,
    /// The hyperlink open over the text, if any.
    pub link: Option<SgrLink>,
}

/// One line of styled runs.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct StyledLine {
    pub runs: Vec<StyledRun>,
}

/// `xterm256Rgb(index)` of the component: the colour of a 256-colour index from 16 up (the 6x6x6 cube, then the
/// 24-step grey ramp); `None` below 16, which are the named colours.
pub fn xterm256_rgb(index: u8) -> Option<(u8, u8, u8)> {
    if index < 16 {
        return None;
    }
    if index >= 232 {
        let gray = 8 + (index - 232) * 10;
        return Some((gray, gray, gray));
    }
    let offset = index - 16;
    let level = |step: u8| if step == 0 { 0 } else { 55 + step * 40 };
    Some((level(offset / 36), level(offset / 6 % 6), level(offset % 6)))
}

/// The codes of one SGR sequence; a sequence with no codes is a reset.
fn parse_codes(parameters: &str) -> Vec<i64> {
    let codes: Vec<i64> = parameters
        .split(';')
        .filter(|part| !part.is_empty())
        .map(|part| part.parse::<i64>().unwrap_or(i64::MAX))
        .collect();
    if codes.is_empty() { vec![0] } else { codes }
}

/// `extendedColor(codes, index, ...)`: the colour of the `38`/`48` at `index` and how many codes after it it used.
fn extended_color(codes: &[i64], index: usize) -> Option<(SgrColor, usize)> {
    match codes.get(index + 1).copied() {
        Some(2) => {
            let component = |offset: usize| codes.get(index + offset).and_then(|&value| u8::try_from(value).ok());
            Some((SgrColor::Rgb(component(2)?, component(3)?, component(4)?), 4))
        }
        Some(5) => {
            let value = codes.get(index + 2).and_then(|&value| u8::try_from(value).ok())?;
            Some((SgrColor::Indexed(value), 2))
        }
        _ => None,
    }
}

fn named(code: i64, base: i64, bright_base: i64) -> Option<SgrColor> {
    if (base..base + 8).contains(&code) {
        u8::try_from(code - base).ok().map(SgrColor::Indexed)
    } else if (bright_base..bright_base + 8).contains(&code) {
        u8::try_from(code - bright_base + 8).ok().map(SgrColor::Indexed)
    } else {
        None
    }
}

/// `applySgr(state, codes)`.
fn apply_sgr(style: &mut SgrStyle, codes: &[i64]) {
    let mut index = 0;
    while index < codes.len() {
        match codes[index] {
            0 => *style = SgrStyle::default(),
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
            38 => {
                if let Some((color, used)) = extended_color(codes, index) {
                    style.foreground = Some(color);
                    index += used;
                }
            }
            48 => {
                if let Some((color, used)) = extended_color(codes, index) {
                    style.background = Some(color);
                    index += used;
                }
            }
            39 => style.foreground = None,
            49 => style.background = None,
            code => {
                if let Some(color) = named(code, 30, 90) {
                    style.foreground = Some(color);
                } else if let Some(color) = named(code, 40, 100) {
                    style.background = Some(color);
                }
            }
        }
        index += 1;
    }
}

/// An SGR sequence `ESC [ [0-9;]* m` at the start of `rest`: its parameters and its length.
fn sgr_at(rest: &str) -> Option<(&str, usize)> {
    let body = rest.strip_prefix("\u{1b}[")?;
    let count = body.bytes().take_while(|b| b.is_ascii_digit() || *b == b';').count();
    (body.as_bytes().get(count) == Some(&b'm')).then(|| (&body[..count], 2 + count + 1))
}

/// An OSC 8 sequence `ESC ] 8 ; params ; uri (BEL | ESC \)` at the start of `rest`: the link (none when the URI
/// is empty, which closes) and the length of the sequence.
fn link_at(rest: &str) -> Option<(Option<SgrLink>, usize)> {
    let body = rest.strip_prefix("\u{1b}]8;")?;
    let stop = body.find(['\u{7}', '\u{1b}'])?;
    let terminator = if body[stop..].starts_with('\u{7}') {
        1
    } else if body[stop..].starts_with("\u{1b}\\") {
        2
    } else {
        return None;
    };
    let (parameters, uri) = body[..stop].split_once(';')?;
    let link = (!uri.is_empty()).then(|| SgrLink { parameters: parameters.to_owned(), uri: uri.to_owned() });
    Some((link, 4 + stop + terminator))
}

/// Adds `text` to the lines, a line break at every `\n`.
fn push_text(lines: &mut Vec<StyledLine>, text: &str, style: SgrStyle, link: &Option<SgrLink>) {
    for (at, part) in text.split('\n').enumerate() {
        if at > 0 {
            lines.push(StyledLine::default());
        }
        if !part.is_empty()
            && let Some(line) = lines.last_mut()
        {
            line.runs.push(StyledRun { text: part.to_owned(), style, link: link.clone() });
        }
    }
}

/// The lines of `text`, its SGR escapes turned into styles and its OSC 8 links into the `link` of the runs.
pub fn parse_sgr(text: &str) -> Vec<StyledLine> {
    let mut lines = vec![StyledLine::default()];
    let mut style = SgrStyle::default();
    let mut link: Option<SgrLink> = None;
    let mut plain_start = 0;
    let mut at = 0;
    while let Some(offset) = text[at..].find('\u{1b}') {
        let start = at + offset;
        let rest = &text[start..];
        if let Some((parameters, length)) = sgr_at(rest) {
            push_text(&mut lines, &text[plain_start..start], style, &link);
            apply_sgr(&mut style, &parse_codes(parameters));
            at = start + length;
            plain_start = at;
        } else if let Some((opened, length)) = link_at(rest) {
            push_text(&mut lines, &text[plain_start..start], style, &link);
            link = opened;
            at = start + length;
            plain_start = at;
        } else {
            at = start + 1;
        }
    }
    push_text(&mut lines, &text[plain_start..], style, &link);
    lines
}

#[cfg(test)]
mod tests {
    use super::*;

    fn runs(text: &str) -> Vec<Vec<(String, SgrStyle)>> {
        parse_sgr(text).into_iter().map(|line| line.runs.into_iter().map(|run| (run.text, run.style)).collect()).collect()
    }

    #[test]
    fn plain_text_is_one_run() {
        assert_eq!(runs("abc"), [[("abc".to_owned(), SgrStyle::default())]]);
        assert_eq!(parse_sgr(""), [StyledLine::default()]);
    }

    #[test]
    fn named_colours_and_their_reset() {
        let lines = runs("a\x1b[31mb\x1b[39mc\x1b[92md\x1b[44me\x1b[49m");
        let colours: Vec<(Option<SgrColor>, Option<SgrColor>)> =
            lines[0].iter().map(|(_, style)| (style.foreground, style.background)).collect();
        assert_eq!(
            colours,
            [
                (None, None),
                (Some(SgrColor::Indexed(1)), None),
                (None, None),
                (Some(SgrColor::Indexed(10)), None),
                (Some(SgrColor::Indexed(10)), Some(SgrColor::Indexed(4))),
            ]
        );
    }

    #[test]
    fn extended_colours() {
        let style = runs("\x1b[38;5;196;48;2;1;2;3mx")[0][0].1;
        assert_eq!(style.foreground, Some(SgrColor::Indexed(196)));
        assert_eq!(style.background, Some(SgrColor::Rgb(1, 2, 3)));
        // An undecodable 38 changes nothing and its parameters are read as codes of their own: 5 is ignored, 1 is bold.
        let style = runs("\x1b[38;5;300;1mx")[0][0].1;
        assert_eq!(style.foreground, None);
        assert!(style.bold);
        assert_eq!(runs("\x1b[38;2;1;2mx")[0][0].1.foreground, None);
        assert_eq!(runs("\x1b[38;2;999;2;3mx")[0][0].1.foreground, None);
    }

    #[test]
    fn attributes_and_their_resets() {
        let style = runs("\x1b[1;2;3;4;7;9mx")[0][0].1;
        assert!(style.bold && style.dim && style.italic && style.underline && style.inverse && style.strikethrough);
        let style = runs("\x1b[1;2;3;4;7;9;22;23;24;27;29mx")[0][0].1;
        assert_eq!(style, SgrStyle::default());
        let style = runs("\x1b[1;31m\x1b[0mx")[0][0].1;
        assert_eq!(style, SgrStyle::default());
        assert_eq!(runs("\x1b[1;31m\x1b[mx")[0][0].1, SgrStyle::default());
    }

    #[test]
    fn empty_parameters_are_dropped_and_unknown_codes_ignored() {
        assert!(runs("\x1b[;1;;mx")[0][0].1.bold);
        assert!(runs("\x1b[1;;3mx")[0][0].1.italic);
        assert_eq!(runs("\x1b[5;8;53mx")[0][0].1, SgrStyle::default());
    }

    #[test]
    fn a_run_is_cut_at_every_sequence() {
        let lines = runs("a\x1b[1mb\x1b[1mc");
        assert_eq!(lines[0].len(), 3);
    }

    #[test]
    fn lines_carry_the_style() {
        let lines = runs("\x1b[1mab\ncd\n\nef");
        assert_eq!(lines.len(), 4);
        assert!(lines[1][0].1.bold);
        assert!(lines[2].is_empty());
        assert_eq!(lines[3][0].0, "ef");
    }

    #[test]
    fn sequences_that_are_not_sgr_stay_in_the_text() {
        assert_eq!(runs("a\x1b[2Kb")[0][0].0, "a\x1b[2Kb");
        assert_eq!(runs("a\x1bb")[0][0].0, "a\x1bb");
        assert_eq!(runs("a\x1b[1:2mb")[0][0].0, "a\x1b[1:2mb");
    }

    #[test]
    fn hyperlinks_become_the_link_of_their_runs() {
        let lines = parse_sgr("a\x1b]8;id=1;http://u/a;b\x07b\x1b[1mc\x1b]8;;\x07d");
        let shape: Vec<(&str, Option<&str>)> =
            lines[0].runs.iter().map(|run| (run.text.as_str(), run.link.as_ref().map(|l| l.uri.as_str()))).collect();
        assert_eq!(shape, [("a", None), ("b", Some("http://u/a;b")), ("c", Some("http://u/a;b")), ("d", None)]);
        assert_eq!(lines[0].runs[1].link.as_ref().map(|l| l.parameters.as_str()), Some("id=1"));
        let terminated = parse_sgr("\x1b]8;;http://u\x1b\\x");
        assert_eq!(terminated[0].runs[0].link.as_ref().map(|l| l.uri.as_str()), Some("http://u"));
    }

    #[test]
    fn the_256_colour_cube_and_ramp() {
        assert_eq!(xterm256_rgb(15), None);
        assert_eq!(xterm256_rgb(16), Some((0, 0, 0)));
        assert_eq!(xterm256_rgb(21), Some((0, 0, 255)));
        assert_eq!(xterm256_rgb(196), Some((255, 0, 0)));
        assert_eq!(xterm256_rgb(231), Some((255, 255, 255)));
        assert_eq!(xterm256_rgb(232), Some((8, 8, 8)));
        assert_eq!(xterm256_rgb(255), Some((238, 238, 238)));
    }
}
