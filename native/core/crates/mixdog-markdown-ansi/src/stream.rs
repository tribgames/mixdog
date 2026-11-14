//! Streaming markdown (`streaming-markdown.mjs`, `stream-fence.mjs`): the settled part of a growing text and its live
//! tail. Filled by nr-tui-md-stream.

use std::sync::Arc;

use crate::lexer::Token;

/// The tokens of the settled part of `text`, cached per `stream_key`, and the live tail that is not settled yet.
pub fn resolve_streaming_markdown_parts(_text: &str, _stream_key: &str) -> (Arc<Vec<Token>>, String) {
    unimplemented!("filled by nr-tui-md-stream")
}
