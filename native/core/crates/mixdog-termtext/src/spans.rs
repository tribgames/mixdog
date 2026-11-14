//! Text with SGR escapes as styled runs. The interface is declared here; `nr-tui-termtext-ansi-wrap` fills it in.

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

/// A stretch of text in one style.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StyledRun {
    pub text: String,
    pub style: SgrStyle,
}

/// One line of styled runs.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct StyledLine {
    pub runs: Vec<StyledRun>,
}

/// The lines of `text`, its SGR escapes turned into styles.
pub fn parse_sgr(_text: &str) -> Vec<StyledLine> {
    unimplemented!("nr-tui-termtext-ansi-wrap")
}
