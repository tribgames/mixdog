//! The transcript components (`Message.jsx`, `TranscriptItem.jsx`, `TurnDone.jsx`, `QueuedCommands.jsx`, `Markdown.jsx`,
//! `MarkdownTable.jsx`, `AnsiText.jsx`): filled by `nr-tui-widgets-transcript`, which adds the `pub mod` lines of its
//! files here. Until then the entry point only has its signature.

use serde_json::Value;

use crate::Line;

/// What an item needs to render: the columns it is laid out in.
#[derive(Clone, Copy, Debug)]
pub struct ItemCtx {
    pub columns: usize,
}

/// One transcript item (a store item object) as lines; the number of lines is its exact height.
pub fn render_item(_item: &Value, _ctx: &ItemCtx) -> Vec<Line> {
    unimplemented!("filled by nr-tui-widgets-transcript")
}
