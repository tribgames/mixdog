//! The two boxes every transcript component is made of: a text (an Ink `<Text>` in a box of a known width) and a column
//! of boxes (`flexDirection="column"` with an optional `gap`). Each knows its exact row count before it paints, which
//! is what the transcript window needs instead of an estimate.

use mixdog_term::frame::{Rect, Style};
use mixdog_term::paint::{Painter, TextWrap};

/// One transcript component laid out: how many rows it takes and how it paints itself with its top-left cell at `(x, y)`.
pub(crate) trait Block {
    fn rows(&self) -> u16;
    fn paint(&self, painter: &mut Painter, x: i32, y: i32);
}

/// The rectangle of a box at `(x, y)` that is `width` by `height` cells, cut to what a grid can hold.
pub(crate) fn rect(x: i32, y: i32, width: usize, height: u16) -> Rect {
    Rect::new(x.clamp(0, i32::from(u16::MAX)) as u16, y.clamp(0, i32::from(u16::MAX)) as u16, width.min(usize::from(u16::MAX)) as u16, height)
}

/// A `<Text>` in a box `width` cells wide: its string (SGR and OSC 8 escapes allowed), the style the string starts in and
/// how it is fitted. An empty string has no rows (Ink measures it 0 by 0).
#[derive(Clone, Debug)]
pub(crate) struct TextBox {
    text: String,
    style: Style,
    mode: TextWrap,
    width: usize,
    rows: u16,
}

impl TextBox {
    pub(crate) fn new(text: String, style: Style, mode: TextWrap, width: usize) -> Self {
        let rows = text_rows(&text, width, mode);
        Self { text, style, mode, width, rows }
    }

    pub(crate) fn rows(&self) -> u16 {
        self.rows
    }

    pub(crate) fn paint(&self, painter: &mut Painter, x: i32, y: i32) {
        if self.rows > 0 {
            painter.text(x, y, &self.text, self.style, self.width, self.mode);
        }
    }
}

/// The rows an Ink `<Text>` takes in `width` cells in `mode`; an empty text takes none.
pub(crate) fn text_rows(text: &str, width: usize, mode: TextWrap) -> u16 {
    if text.is_empty() { 0 } else { crate::fitted_rows(text, width, mode) }
}

/// A child of a [`Stack`].
#[derive(Clone, Debug)]
pub(crate) enum Node {
    Text(TextBox),
    Stack(Stack),
}

impl Node {
    pub(crate) fn rows(&self) -> u16 {
        match self {
            Node::Text(text) => text.rows(),
            Node::Stack(stack) => stack.rows(),
        }
    }

    pub(crate) fn paint(&self, painter: &mut Painter, x: i32, y: i32) {
        match self {
            Node::Text(text) => text.paint(painter, x, y),
            Node::Stack(stack) => stack.paint(painter, x, y),
        }
    }
}

/// A column of children one above the other, `gap` rows between each two of them (a child of no rows still has its gaps:
/// Yoga counts every child).
#[derive(Clone, Debug, Default)]
pub(crate) struct Stack {
    pub(crate) children: Vec<Node>,
    pub(crate) gap: u16,
}

impl Stack {
    pub(crate) fn new(gap: u16) -> Self {
        Self { children: Vec::new(), gap }
    }

    pub(crate) fn rows(&self) -> u16 {
        let total: u32 = self.children.iter().map(|child| u32::from(child.rows())).sum();
        let gaps = u32::from(self.gap) * self.children.len().saturating_sub(1) as u32;
        (total + gaps).min(u32::from(u16::MAX)) as u16
    }

    pub(crate) fn paint(&self, painter: &mut Painter, x: i32, y: i32) {
        let mut at = y;
        for child in &self.children {
            child.paint(painter, x, at);
            at += i32::from(child.rows()) + i32::from(self.gap);
        }
    }
}

impl Block for TextBox {
    fn rows(&self) -> u16 {
        TextBox::rows(self)
    }

    fn paint(&self, painter: &mut Painter, x: i32, y: i32) {
        TextBox::paint(self, painter, x, y);
    }
}

impl Block for Stack {
    fn rows(&self) -> u16 {
        Stack::rows(self)
    }

    fn paint(&self, painter: &mut Painter, x: i32, y: i32) {
        Stack::paint(self, painter, x, y);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(value: &str, width: usize) -> Node {
        Node::Text(TextBox::new(value.to_owned(), Style::default(), TextWrap::Wrap, width))
    }

    #[test]
    fn an_empty_text_has_no_rows_but_keeps_its_gaps() {
        let mut stack = Stack::new(1);
        stack.children = vec![text("a", 10), text("", 10), text("b", 10)];
        assert_eq!(stack.rows(), 1 + 1 + 0 + 1 + 1);
    }

    #[test]
    fn a_text_wraps_in_its_width() {
        assert_eq!(text_rows("one two three", 7, TextWrap::Wrap), 2);
        assert_eq!(text_rows("one two three", 7, TextWrap::TruncateEnd), 1);
        assert_eq!(text_rows("a\nb\nc", 9, TextWrap::Wrap), 3);
    }

    #[test]
    fn stacked_children_paint_below_each_other() {
        let mut grid = mixdog_term::frame::Grid::new(8, 4);
        let mut stack = Stack::new(1);
        stack.children = vec![text("top", 8), text("bottom", 8)];
        stack.paint(&mut Painter::new(&mut grid), 1, 0);
        assert_eq!(grid.row_text(0).trim_end(), " top");
        assert_eq!(grid.row_text(1).trim_end(), "");
        assert_eq!(grid.row_text(2).trim_end(), " bottom");
    }
}
