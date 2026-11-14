//! Splitting a string into text and escape sequences. The interface is declared here; `nr-tui-termtext-ansi-wrap`
//! fills it in.

/// A piece of a string: visible text, or one escape sequence (SGR, cursor, OSC 8 hyperlink).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AnsiToken {
    Text(String),
    Escape(String),
}

/// The tokens of `text`, in order; joined again they give `text`.
pub fn tokenize(_text: &str) -> Vec<AnsiToken> {
    unimplemented!("nr-tui-termtext-ansi-wrap")
}
