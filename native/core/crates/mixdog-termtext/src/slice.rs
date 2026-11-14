//! `slice-ansi`: a cell range of a string with its escapes kept. The interface is declared here;
//! `nr-tui-termtext-ansi-wrap` fills it in.

/// `sliceAnsi(text, start, end)`: the cells from `start` up to `end` (the end of the text when `None`).
pub fn slice_ansi(_text: &str, _start: usize, _end: Option<usize>) -> String {
    unimplemented!("nr-tui-termtext-ansi-wrap")
}
