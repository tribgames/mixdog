//! Tables (`MarkdownTable`): the rows of a table token laid out for a width. Filled by nr-tui-md-format.

use crate::lexer::Token;

/// The lines of the table `token` at `columns` columns.
pub fn build_table_render(_token: &Token, _columns: usize) -> Vec<String> {
    unimplemented!("filled by nr-tui-md-format")
}
