//! The one-row bands of the application view (`app-view/transcript-viewport/trailing-bands.jsx`): the right-aligned hint cell
//! the overlay band, the guard band and the prompt meta row share, and the welcome prompt hint row.

use mixdog_term::frame::Rect;
use mixdog_term::paint::{Painter, TextWrap};
use mixdog_tui_widgets::hint_overprint::prompt_status_key;
use mixdog_tui_widgets::themed;
use mixdog_tui_style::Key;

use super::format::center_line;

/// `hintCell({ inputHint, inputHintTone, width })`: the hint text right-aligned in a cell `width` wide (1 when there is no
/// width) with a cell of margin on each side, flush with the right edge of the frame, truncated at its end to the width.
pub fn paint_hint_cell(painter: &mut Painter, frame_columns: usize, y: i32, hint: &str, tone: &str, width: usize) {
    if y < 0 || hint.is_empty() {
        return;
    }
    let area = Rect::new(0, 0, frame_columns as u16, u16::MAX);
    painter.overprint_hint(y as u16, area, hint, width.max(1).min(frame_columns) as u16, themed(prompt_status_key(tone)));
}

/// `renderWelcomeHintRow`: the starter or conditional tip centred in one row with a margin of two.
pub fn paint_welcome_hint_row(painter: &mut Painter, y: i32, frame_columns: usize, text: &str) {
    painter.text(0, y, &center_line(text, frame_columns, 2), themed(Key::Inactive), frame_columns, TextWrap::TruncateEnd);
}
