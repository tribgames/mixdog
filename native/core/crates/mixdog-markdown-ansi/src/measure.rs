//! Row measurement of rendered text. Filled by nr-tui-md-format.

/// The rows the rendered lines occupy at `columns` columns.
pub fn measure_rendered_rows(_lines: &[String], _columns: usize) -> usize {
    unimplemented!("filled by nr-tui-md-format")
}

/// The rows one line occupies at `columns` columns once wrapped.
pub fn wrapped_line_rows(_line: &str, _columns: usize) -> usize {
    unimplemented!("filled by nr-tui-md-format")
}
