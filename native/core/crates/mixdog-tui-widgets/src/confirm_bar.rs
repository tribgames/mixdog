//! `components/ConfirmBar.jsx`: the horizontal text-button bar of the onboarding steps. It owns no keyboard state: the
//! picker manages the focused button.

use mixdog_term::frame::{Rect, Style};
use mixdog_term::paint::Painter;
use mixdog_tui_style::Key;

use crate::panel_cell_text::cells;
use crate::{selected_style, themed};

/// A button descriptor.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConfirmButton {
    pub value: String,
    pub label: String,
}

impl ConfirmButton {
    pub fn new(value: &str, label: &str) -> Self {
        Self { value: value.to_owned(), label: label.to_owned() }
    }

    fn text(&self) -> String {
        format!("[ {} ]", self.label)
    }
}

/// `clampConfirmFocus(index, count)`: a focus index in the button range, or -1 for list focus.
pub fn clamp_confirm_focus(index: i64, count: usize) -> i64 {
    if count == 0 || index < 0 {
        return -1;
    }
    index.min(count as i64 - 1)
}

/// The cells of the bar: each button is its label in brackets with a cell of padding on both sides, and one cell apart.
pub fn confirm_bar_width(buttons: &[ConfirmButton]) -> usize {
    buttons.iter().enumerate().map(|(index, button)| usize::from(index > 0) + cells(&button.text()) + 2).sum()
}

/// Paints the bar on row `y` from `x`; `focused` is the highlighted button (-1 for none). Returns the rows it took
/// (none for no buttons).
pub fn paint_confirm_bar(painter: &mut Painter, x: i32, y: i32, buttons: &[ConfirmButton], focused: i64) -> u16 {
    if buttons.is_empty() {
        return 0;
    }
    let mut at = x;
    for (index, button) in buttons.iter().enumerate() {
        at += i32::from(index > 0);
        let text = button.text();
        let box_width = cells(&text) + 2;
        let is_focused = index as i64 == focused;
        let style = if is_focused { Style { bold: true, ..selected_style() } } else { themed(Key::Subtle) };
        if is_focused && at >= 0 && y >= 0 {
            painter.fill(Rect::new(at as u16, y as u16, box_width as u16, 1), Style { bg: style.bg, ..Style::default() });
        }
        painter.line(at + 1, y, &text, style);
        at += box_width as i32;
    }
    1
}

#[cfg(test)]
mod tests {
    use super::*;

    fn buttons() -> Vec<ConfirmButton> {
        vec![ConfirmButton::new("back", "Back"), ConfirmButton::new("next", "Next")]
    }

    #[test]
    fn focus_is_clamped_into_the_buttons_or_is_list_focus() {
        assert_eq!(clamp_confirm_focus(3, 2), 1);
        assert_eq!(clamp_confirm_focus(-1, 2), -1);
        assert_eq!(clamp_confirm_focus(0, 0), -1);
        assert_eq!(clamp_confirm_focus(1, 2), 1);
    }

    #[test]
    fn the_bar_is_the_brackets_the_padding_and_one_cell_between_buttons() {
        // "[ Back ]" is 8 cells, "[ Next ]" 8; each has 2 of padding; one apart.
        assert_eq!(confirm_bar_width(&buttons()), 10 + 1 + 10);
        assert_eq!(confirm_bar_width(&[]), 0);
    }
}
