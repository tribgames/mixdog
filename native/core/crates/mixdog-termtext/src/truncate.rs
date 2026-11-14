//! `cli-truncate`: fit a string into a width with an ellipsis. The interface is declared here;
//! `nr-tui-termtext-ansi-wrap` fills it in.

/// Where the text is cut.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TruncatePosition {
    Start,
    Middle,
    End,
}

/// `cliTruncate(text, columns, { position })`.
pub fn truncate(_text: &str, _columns: usize, _position: TruncatePosition) -> String {
    unimplemented!("nr-tui-termtext-ansi-wrap")
}
