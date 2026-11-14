//! Token to ANSI (`format-token.mjs`). The interface the renderer's other modules are written against; the body is
//! filled by nr-tui-md-format.

use crate::lexer::Token;

/// What `formatToken` is given besides the token.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FormatOptions {
    pub columns: usize,
    pub theme_version: u64,
    pub streaming: bool,
}

/// `formatToken(token, options)`: the ANSI text of one block token.
pub fn format_token(_token: &Token, _options: &FormatOptions) -> String {
    unimplemented!("filled by nr-tui-md-format")
}
