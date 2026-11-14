//! ANSI-aware wrapping (wrap-ansi and the Ink text wrapper). The interface is declared here;
//! `nr-tui-termtext-ansi-wrap` fills it in.

/// The options of `wrapAnsi(text, columns, options)`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WrapOptions {
    /// Break words longer than a line.
    pub hard: bool,
    /// Wrap at word boundaries (the default) or only where a line is full.
    pub word_wrap: bool,
    /// Trim the white space a wrap leaves at a line's start (the default).
    pub trim: bool,
}

impl Default for WrapOptions {
    fn default() -> Self {
        Self { hard: false, word_wrap: true, trim: true }
    }
}

/// How Ink's text component fits text into a width.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WrapMode {
    Wrap,
    Hard,
    TruncateStart,
    TruncateMiddle,
    TruncateEnd,
}

/// `wrapAnsi(text, columns, options)`.
pub fn wrap_ansi(_text: &str, _columns: usize, _options: WrapOptions) -> String {
    unimplemented!("nr-tui-termtext-ansi-wrap")
}

/// The lines of `text` cut at `columns` cells, escapes carried across the cuts.
pub fn hard_wrap_ansi_lines(_text: &str, _columns: usize) -> Vec<String> {
    unimplemented!("nr-tui-termtext-ansi-wrap")
}

/// Ink's `wrapText(text, maxWidth, wrapType)`.
pub fn wrap_text(_text: &str, _max_width: usize, _mode: WrapMode) -> String {
    unimplemented!("nr-tui-termtext-ansi-wrap")
}
