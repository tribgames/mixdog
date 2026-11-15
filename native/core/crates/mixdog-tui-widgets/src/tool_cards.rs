//! The tool execution cards (`ToolExecution.jsx` and `tool-execution/*`): filled by `nr-tui-widgets-toolcards`.

use serde_json::Value;

use crate::Line;

/// What a card needs to render: the columns it is laid out in.
#[derive(Clone, Copy, Debug)]
pub struct CardCtx {
    pub columns: usize,
}

/// One tool card (a view-model card) as lines; the number of lines is its exact height.
pub fn render_tool_card(_card: &Value, _ctx: &CardCtx) -> Vec<Line> {
    unimplemented!("filled by nr-tui-widgets-toolcards")
}
