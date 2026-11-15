//! The prompt box of the application view: the rounded border around the editor content (`app-view.jsx`, with the content of
//! `components/PromptInput.jsx` from [`crate::editor::render`]) and the cell the hardware cursor is parked at.

use mixdog_term::frame::{Rect, Style};
use mixdog_term::paint::{Painter, RoundBorder};
use mixdog_tui_style::{Key, theme_color};
use mixdog_tui_widgets::{grid_color, themed};

use crate::editor::Draft;
use crate::editor::editing::Caret;
use crate::editor::helpers::HintTone;
use crate::editor::prompt::BoxLayout;
use crate::editor::render::{PromptView, render_prompt};

/// What painting the box tells the host: where the editable content is (the editor publishes it for the mouse handler and
/// computes the caret from it) and the caret cell inside it, when the box is an edit target.
#[derive(Clone, Copy, Debug)]
pub struct PromptPaint {
    pub layout: BoxLayout,
    pub caret: Option<Caret>,
}

/// Paints the box of `box_rows` rows with its top-left cell at `(0, y)`, `frame_columns` wide: the border, then the draft in
/// the content area (one border cell and one padding cell in from each side). The hint is empty here (the app passes none).
/// `enabled` is whether the prompt is a real, active edit target (the caret is returned only then).
pub fn paint_prompt_box(painter: &mut Painter, y: i32, frame_columns: usize, box_rows: usize, draft: &Draft, enabled: bool) -> PromptPaint {
    let width = frame_columns.saturating_sub(4).max(1);
    let content_rows = box_rows.saturating_sub(2);
    if y >= 0 && box_rows > 0 {
        painter.border(Rect::new(0, y as u16, frame_columns as u16, box_rows as u16), &RoundBorder::all(themed(Key::PromptBorder)));
    }
    let view = PromptView { draft, mask: false, hint: "", hint_tone: HintTone::Info, width, caret_enabled: enabled };
    let render = render_prompt(&view);
    let (x, top) = (2, y + 1);
    if y >= 0 && content_rows > 0 {
        let previous = painter.push_clip(Rect::new(x as u16, top as u16, width as u16, content_rows as u16));
        for (row, spans) in render.rows.iter().enumerate() {
            let mut at = x;
            for span in spans {
                let style = Style { fg: grid_color(theme_color(span.fg)), bg: span.bg.map_or_else(Default::default, |key| grid_color(theme_color(key))), ..Style::default() };
                at += painter.line(at, top + row as i32, &span.text, style) as i32;
            }
        }
        painter.pop_clip(previous);
    }
    PromptPaint { layout: BoxLayout { top, left: x, width, height: content_rows }, caret: render.caret }
}
