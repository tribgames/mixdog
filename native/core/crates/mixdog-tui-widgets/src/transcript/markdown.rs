//! `components/Markdown.jsx` and `components/MarkdownTable.jsx`: markdown as a column of blocks, one blank row between two
//! blocks (`gap={1}`). A block is the ANSI text of a token drawn as spans ([`super::ansi_text`]), or a table drawn by the
//! table layout. While a message streams the settled blocks are laid out once (the stable chunks of the streaming split)
//! and only the live tail is lexed again.

use mixdog_markdown_ansi::render::{RenderOptions, render_token_ansi_segments};
use mixdog_markdown_ansi::stream::{resolve_streaming_markdown_parts, streaming_stable_chunks};
use mixdog_markdown_ansi::table::build_table_render;
use mixdog_term::frame::Style;
use mixdog_term::paint::TextWrap;
use mixdog_tui_style::{Key, theme_color};

use super::ansi_text::ansi_text_box;
use super::layout::{Node, Stack, TextBox};
use crate::{grid_color, themed};

/// `<Markdown columns trimPartialFences>` in a box `width` cells wide. `columns` is the width the blocks are laid out at
/// (a table, the length of a rule); without it a rule spans 80 columns and a table the width of the box (the terminal's
/// columns in Node).
pub(crate) fn markdown(content: &str, trim_partial_fences: bool, columns: Option<usize>, width: usize) -> Stack {
    let segments = render_token_ansi_segments(content, RenderOptions { width: columns.unwrap_or(0), trim_partial_fences });
    let text_color = grid_color(theme_color(Key::Text));
    let table_width = columns.unwrap_or(width);
    let mut stack = Stack::new(1);
    for segment in segments.iter() {
        let node = match segment.ansi() {
            Some(ansi) => Node::Text(ansi_text_box(ansi, text_color, width)),
            None => Node::Text(TextBox::new(build_table_render(segment.token(), table_width).join("\n"), Style::default(), TextWrap::Wrap, width)),
        };
        stack.children.push(node);
    }
    stack
}

/// `<StreamingMarkdown columns streamKey streaming>` in a box `width` cells wide: a finished text is one markdown block
/// whose unfinished closing fence is trimmed; a streaming one is its settled chunks, each a markdown block, and its live
/// tail (plain text drawn as it is when the whole text has no markdown syntax).
pub(crate) fn streaming_markdown(text: &str, columns: Option<usize>, stream_key: Option<&str>, streaming: bool, width: usize) -> Stack {
    if !streaming {
        let mut stack = Stack::new(0);
        stack.children.push(Node::Stack(markdown(text, true, columns, width)));
        return stack;
    }
    let parts = resolve_streaming_markdown_parts(text, stream_key);
    if parts.plain {
        let mut stack = Stack::new(0);
        stack.children.push(Node::Text(TextBox::new(parts.unstable_for_render.clone(), themed(Key::Text), TextWrap::Wrap, width)));
        return stack;
    }
    let mut stack = Stack::new(1);
    for chunk in streaming_stable_chunks(&parts) {
        stack.children.push(Node::Stack(markdown(&chunk, false, columns, width)));
    }
    if !parts.unstable_suffix.is_empty() {
        stack.children.push(Node::Stack(markdown(&parts.unstable_for_render, true, columns, width)));
    }
    stack
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_are_one_blank_row_apart() {
        let stack = markdown("first\n\nsecond", false, Some(40), 40);
        assert_eq!(stack.children.len(), 2);
        assert_eq!(stack.rows(), 3);
    }

    #[test]
    fn a_table_is_drawn_by_the_table_layout_at_the_width_of_the_box() {
        let stack = markdown("| a | b |\n|---|---|\n| 1 | 2 |", false, Some(30), 30);
        assert_eq!(stack.rows(), 5);
        assert_eq!(stack.children.len(), 1);
    }

    #[test]
    fn a_plain_streaming_text_is_one_text_and_a_finished_one_is_markdown() {
        let live = streaming_markdown("plain words that wrap", Some(10), Some("plain-test"), true, 10);
        assert_eq!(live.children.len(), 1);
        assert_eq!(live.rows(), 3);
        let done = streaming_markdown("# Title", Some(10), Some("plain-test"), false, 10);
        assert_eq!(done.rows(), 1);
    }

    #[test]
    fn a_streaming_text_keeps_its_settled_blocks_apart_from_the_live_tail() {
        let stack = streaming_markdown("**stable**\n\n```txt\nlive", Some(37), Some("md-test-open-fence"), true, 37);
        assert_eq!(stack.children.len(), 2);
    }

    #[test]
    fn an_empty_text_has_no_rows() {
        assert_eq!(markdown("", false, Some(20), 20).rows(), 0);
        assert_eq!(streaming_markdown("", Some(20), Some("md-test-empty"), true, 20).rows(), 0);
    }
}
