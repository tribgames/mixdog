//! The application view (`src/tui/app/app-view.jsx` and its parts): the widgets composed in the top-to-bottom order of the
//! app on a painter, a pure function of the props the application state hands it. The prompt box content is
//! [`crate::editor::render`].
//!
//! The screen is one column of the terminal's rows and one column short of its width (the last column is kept free: terminals
//! may clip or wrap their final cell):
//!
//! ```text
//! welcome banner        empty transcript only: 3 blank rows, the logo, a blank row, the version line
//! transcript viewport   the layout's height, bottom-anchored, clipping: the item column scrolled by its offset, then the
//!                       welcome prompt hint, the panel-close mask, the overlay hint band and the guard band
//! floating panel        the reserved rows, bottom-aligned, clipped from the top
//! prompt meta row       live spinner at the left, the toast or hint at the right, then a blank row
//! queued commands
//! prompt box            rounded border around the editor
//! statusline            two rows
//! ```
//!
//! * [`rows`]: mounting the items of the window as lines (the hint of the prompt overprinted on the last drawn item) and the
//!   viewport with its trailing bands; [`bands`]: the hint cell and the welcome hint row.
//! * [`panel`]: the slot above the prompt and its priority; [`prompt`]: the box around the editor; [`spinner`]: the spinner
//!   props of the prompt meta row; [`welcome`]: the banner and the boot splash.
//! * [`format`], [`labels`]: the formatting helpers of the shell and the labels of the text-entry panel by kind.
//! * [`hint`], [`chrome`]: the welcome-screen hint probes and the terminal chrome (debounced resize, extended keys, input
//!   gate), which are state the run loop steps.
//!
//! The view paints; it holds no state. What the wiring does: computes the shell layout ([`crate::surface::layout`]), mounts the
//! rows ([`rows::mount_rows`]), fits an open picker ([`panel::fit_picker`]), renders the spinner row with the widget's progress
//! state, builds [`AppViewProps`], calls [`render_app`] on a painter over the frame grid, and hands [`AppFrame::cursor`] to the
//! frame writer and [`AppFrame::prompt_box`] to the editor (which publishes the box rect for the mouse handler).

pub mod bands;
pub mod chrome;
pub mod format;
pub mod hint;
pub mod labels;
pub mod panel;
pub mod prompt;
pub mod rows;
pub mod spinner;
pub mod welcome;

use mixdog_js::string_to_number;
use mixdog_term::frame::{CursorPos, Rect};
use mixdog_term::paint::Painter;
use mixdog_tui_widgets::Line;
use mixdog_tui_widgets::statusline::{STATUSLINE_BAND_ROWS, paint_statusline_band, workflow_mode_label};
use mixdog_tui_widgets::transcript::render_queued_commands;
use serde_json::Value;

use self::bands::paint_hint_cell;
use self::panel::{PanelPaint, PanelSlots, blocks_prompt, paint_floating_panel};
use self::prompt::paint_prompt_box;
use self::rows::{MountedRows, paint_viewport};
use self::welcome::paint_welcome_banner;
use crate::editor::Draft;
use crate::editor::prompt::BoxLayout;
use crate::surface::layout::{ShellLayout, WELCOME_BANNER_ROWS};
use crate::transcript::window::visible_items::OverlayHint;

/// Where the selection of the slash palette moves (`stepPaletteIndex`'s direction): to an end, one row (wrapping) or by a
/// number of rows (clamped).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum PaletteMove {
    Home,
    End,
    Left,
    Right,
    Rows(f64),
}

impl PaletteMove {
    /// The move a direction word names; any other text is `Number(text) || 0` rows.
    pub fn parse(direction: &str) -> Self {
        match direction {
            "home" => Self::Home,
            "end" => Self::End,
            "left" => Self::Left,
            "right" => Self::Right,
            other => Self::Rows(string_to_number(other)),
        }
    }
}

/// `stepPaletteIndex(index, direction, total)`: the new selected row. Home and end jump, one row wraps around, larger steps
/// clamp to the list; an empty list selects row 0.
pub fn step_palette_index(index: usize, direction: PaletteMove, total: usize) -> usize {
    if total == 0 {
        return 0;
    }
    let step = match direction {
        PaletteMove::Home => return 0,
        PaletteMove::End => return total - 1,
        PaletteMove::Left => -1.0,
        PaletteMove::Right => 1.0,
        // `Number(direction) || 0`.
        PaletteMove::Rows(rows) if rows.is_nan() => 0.0,
        PaletteMove::Rows(rows) => rows,
    };
    if step == 1.0 || step == -1.0 {
        return ((index as i64 + step as i64).rem_euclid(total as i64)) as usize;
    }
    (index as f64 + step).clamp(0.0, (total - 1) as f64) as usize
}

/// Everything one frame of the application view reads.
#[derive(Clone, Copy)]
pub struct AppViewProps<'a> {
    /// The terminal's columns and rows (`resizeState`); the frame is one column narrower.
    pub columns: usize,
    pub rows: usize,
    pub layout: &'a ShellLayout,
    pub cwd: &'a str,
    /// The version the welcome banner shows.
    pub version: &'a str,
    /// The items of the window as lines ([`rows::mount_rows`]).
    pub transcript: &'a MountedRows,
    pub overlay: &'a OverlayHint,
    pub panels: PanelSlots<'a>,
    /// The prompt draft the editor holds.
    pub draft: &'a Draft,
    /// The session is closing: the prompt is not an edit target.
    pub exiting: bool,
    /// The post-mount input gate is open ([`chrome::TerminalChrome::is_ready`]).
    pub tui_ready: bool,
    /// The spinner row of the prompt meta row, rendered with the widget ([`mixdog_tui_widgets::spinner::render_spinner`] over
    /// [`spinner::spinner_props`]); none without a live spinner.
    pub spinner: &'a [Line],
    /// `state.queued`: the entries of the queued steering commands.
    pub queued: &'a [Value],
    /// The statusline text (two lines of SGR text, the footer's current line) and the workflow it labels.
    pub footer: &'a str,
    pub workflow: Option<&'a Value>,
}

/// What the frame tells the host.
#[derive(Clone, Copy, Debug)]
pub struct AppFrame {
    /// The cell the hardware cursor is parked at: the caret of the prompt when it is an edit target, else that of the text
    /// entry panel; none hides the cursor.
    pub cursor: Option<CursorPos>,
    /// The content box of the prompt, when the input box is shown ([`crate::editor::PromptEditor::cursor_anchor`] publishes
    /// it for the mouse handler).
    pub prompt_box: Option<BoxLayout>,
    /// What the floating panel took.
    pub panel: Option<PanelPaint>,
}

fn cursor_at(col: i32, row: i32) -> Option<CursorPos> {
    Some(CursorPos { col: u16::try_from(col).ok()?, row: u16::try_from(row).ok()? })
}

/// `renderAppView(ctx)`: paints one frame into `painter` (a painter over the whole grid) and returns where the cursor goes.
pub fn render_app(props: &AppViewProps<'_>, painter: &mut Painter) -> AppFrame {
    let layout = props.layout;
    let frame_columns = props.columns.saturating_sub(1).max(1);
    let root = painter.push_clip(Rect::new(0, 0, u16::try_from(frame_columns).unwrap_or(u16::MAX), u16::try_from(props.rows).unwrap_or(u16::MAX)));

    // The children of the root column, top to bottom: the banner, the viewport (the only one that gives rows back when the
    // sum is too tall) and the bottom bar.
    let welcome_rows = if layout.show_welcome_banner { WELCOME_BANNER_ROWS } else { 0 };
    if layout.show_welcome_banner {
        paint_welcome_banner(painter, 0, frame_columns, props.cwd, props.version);
    }
    let queued_lines =
        if layout.queued_visible && !layout.input_box_hidden { render_queued_commands(props.queued, frame_columns, layout.queued_compact) } else { Vec::new() };
    let meta_rows = if layout.prompt_meta_visible { 2 } else { 0 };
    let prompt_cluster_rows = if layout.input_box_hidden { 0 } else { meta_rows + queued_lines.len() + layout.prompt_box_rows };
    let bottom_rows = layout.panel_transition_clear_rows + layout.floating_panel_rows + prompt_cluster_rows + usize::from(STATUSLINE_BAND_ROWS);
    let viewport_height = layout.viewport_height.min(props.rows.saturating_sub(welcome_rows + bottom_rows));
    paint_viewport(painter, welcome_rows as i32, viewport_height, frame_columns, layout, props.overlay, props.transcript);

    let mut y = (welcome_rows + viewport_height + layout.panel_transition_clear_rows) as i32;
    let mut panel = None;
    if layout.floating_panel_rows > 0 {
        panel = paint_floating_panel(painter, &props.panels, layout, frame_columns, y);
        y += layout.floating_panel_rows as i32;
    }
    let mut cursor = panel.and_then(|painted| painted.cursor).and_then(|(col, row)| cursor_at(col, row));
    let mut prompt_box = None;
    if !layout.input_box_hidden {
        if layout.prompt_meta_visible {
            paint_meta_row(painter, y, frame_columns, props);
            y += meta_rows as i32;
        }
        for line in &queued_lines {
            painter.line(0, y, &line.0, Default::default());
            y += 1;
        }
        let enabled = !(props.exiting || blocks_prompt(&props.panels) || !props.tui_ready);
        let painted = paint_prompt_box(painter, y, frame_columns, layout.prompt_box_rows, props.draft, enabled);
        if let Some(caret) = painted.caret {
            cursor = cursor_at(painted.layout.left + caret.col as i32, painted.layout.top + caret.row as i32);
        }
        prompt_box = Some(painted.layout);
        y += layout.prompt_box_rows as i32;
    }
    if let (Ok(top), Ok(width)) = (u16::try_from(y), u16::try_from(frame_columns)) {
        paint_statusline_band(painter, 0, top, width, props.footer, &workflow_mode_label(props.workflow));
    }
    painter.pop_clip(root);
    AppFrame { cursor, prompt_box, panel }
}

/// The meta row above the prompt: the live reasoning at the left (clipped to what the hint leaves) and the short-lived
/// copy, error or info status at the right, then the blank spacer row under it.
fn paint_meta_row(painter: &mut Painter, y: i32, frame_columns: usize, props: &AppViewProps<'_>) {
    let layout = props.layout;
    let has_hint = !layout.input_hint.is_empty();
    // The hint cell is its text width plus a cell of margin on each side; the spinner box takes the rest.
    let spinner_width = if has_hint { frame_columns.saturating_sub(layout.transient_status_width.max(1) + 2) } else { frame_columns };
    if let (Some(line), true) = (props.spinner.first(), spinner_width > 0 && y >= 0) {
        let previous = painter.push_clip(Rect::new(0, y as u16, u16::try_from(spinner_width).unwrap_or(u16::MAX), 1));
        painter.line(0, y, &line.0, Default::default());
        painter.pop_clip(previous);
    }
    if has_hint {
        paint_hint_cell(painter, frame_columns, y, &layout.input_hint, &layout.input_hint_tone, layout.transient_status_width);
    }
}

#[cfg(test)]
mod tests {
    use mixdog_term::frame::Grid;
    use serde_json::json;

    use super::*;
    use crate::transcript::window::heights::ItemHeights;
    use crate::transcript::window::render_window::RenderWindow;
    use crate::transcript::window::row_index::Items;

    #[test]
    fn palette_navigation_wraps_jumps_to_the_ends_and_clamps_numbers() {
        let mut index = 1;
        for (direction, expected) in [("home", 0), ("left", 2), ("right", 0), ("end", 2), ("-5", 0), ("5", 2), ("bad", 2)] {
            index = step_palette_index(index, PaletteMove::parse(direction), 3);
            assert_eq!(index, expected, "{direction}");
        }
        assert_eq!(step_palette_index(2, PaletteMove::End, 0), 0);
        assert_eq!(step_palette_index(0, PaletteMove::Rows(-3.0), 5), 0);
        assert_eq!(step_palette_index(0, PaletteMove::Rows(2.0), 5), 2);
    }

    #[test]
    fn the_floating_panels_keep_their_priority() {
        let request = json!({ "name": "bash" });
        let value = json!({});
        let approval = panel::ToolApprovalSlot { request: &request, selected: 0, question: None };
        let draft = mixdog_tui_widgets::text_entry::TextEntryDraft::default();
        let prompt = panel::TextEntrySlot { prompt: &value, draft: &draft, status: Default::default() };
        let mut slots = PanelSlots { settings_prompt: Some(prompt), ..PanelSlots::default() };
        assert_eq!(slots.showing(), Some(panel::PanelKind::SettingsPrompt));
        slots.provider_prompt = Some(prompt);
        assert_eq!(slots.showing(), Some(panel::PanelKind::ProviderPrompt));
        slots.tool_approval = Some(approval);
        assert_eq!(slots.showing(), Some(panel::PanelKind::ToolApproval));
        assert_eq!(PanelSlots::default().showing(), None);
    }

    fn frame_of(
        layout: &ShellLayout,
        panels: PanelSlots<'_>,
        items: &[Value],
        draft: &Draft,
        spinner: &[Line],
        rows: usize,
        columns: usize,
    ) -> (Grid, AppFrame) {
        let list = Items::new(items, None);
        let window =
            RenderWindow { start_index: 0, end_index: items.len(), bottom_spacer_rows: 0, total_rows: 0, max_scroll_rows: 0, effective_scroll_offset: 0 };
        let overlay = OverlayHint { attach_item_index: None, tail_pinned: true, on_last_item: false, fallback_row: false };
        let mounted = rows::mount_rows(
            &mut ItemHeights::default(),
            &rows::MountInput {
                items: &list,
                window: &window,
                layout,
                frame_columns: columns - 1,
                tool_output_expanded: false,
                streaming_tail_id: None,
                overlay: &overlay,
                now_ms: 0.0,
            },
        );
        let props = AppViewProps {
            columns,
            rows,
            layout,
            cwd: "C:/work",
            version: "1.2.3",
            transcript: &mounted,
            overlay: &overlay,
            panels,
            draft,
            exiting: false,
            tui_ready: true,
            spinner,
            queued: &[],
            footer: "model line\nsecond line",
            workflow: None,
        };
        let mut grid = Grid::new(columns as u16, rows as u16);
        let frame = render_app(&props, &mut Painter::new(&mut grid));
        (grid, frame)
    }

    fn base_layout() -> ShellLayout {
        ShellLayout { prompt_box_rows: 3, viewport_height: 8, transcript_content_height: 8, ..ShellLayout::default() }
    }

    #[test]
    fn the_frame_stacks_the_transcript_the_prompt_box_and_the_statusline_and_parks_the_cursor_in_the_box() {
        let layout = base_layout();
        let items = [json!({ "kind": "user", "id": "u1", "text": "hello" })];
        let draft = Draft::at_end("abc");
        let (grid, frame) = frame_of(&layout, PanelSlots::default(), &items, &draft, &[], 14, 40);
        // 8 viewport rows, a 3-row prompt box, 2 statusline rows: the box starts at row 8.
        assert!((0..8).any(|row| grid.row_text(row).contains("hello")));
        assert!(grid.row_text(8).starts_with('\u{256d}'));
        assert!(grid.row_text(9).contains("abc"));
        assert!(grid.row_text(11).contains("model line"));
        assert!(grid.row_text(12).contains("second line"));
        assert_eq!(frame.cursor, Some(CursorPos { col: 5, row: 9 }));
        assert_eq!(frame.prompt_box.map(|b| (b.top, b.left, b.width, b.height)), Some((9, 2, 35, 1)));
    }

    #[test]
    fn a_prompt_that_is_not_an_edit_target_parks_no_cursor_and_a_hidden_input_box_is_not_drawn() {
        let mut layout = base_layout();
        let draft = Draft::at_end("abc");
        let approval_request = json!({ "name": "bash" });
        let panels =
            PanelSlots { tool_approval: Some(panel::ToolApprovalSlot { request: &approval_request, selected: 0, question: None }), ..PanelSlots::default() };
        let (_, frame) = frame_of(&layout, panels, &[], &draft, &[], 14, 40);
        assert_eq!(frame.cursor, None);
        layout.input_box_hidden = true;
        let (grid, frame) = frame_of(&layout, PanelSlots::default(), &[], &draft, &[], 14, 40);
        assert!(frame.prompt_box.is_none() && frame.cursor.is_none());
        assert!(!(0..14).any(|row| grid.row_text(row).starts_with('\u{256d}')));
    }

    #[test]
    fn the_meta_row_has_the_spinner_at_the_left_and_the_hint_at_the_right_over_a_blank_row() {
        let layout = ShellLayout {
            prompt_meta_visible: true,
            input_hint: "Copied".to_owned(),
            input_hint_tone: "info".to_owned(),
            transient_status_width: 6,
            viewport_height: 6,
            transcript_content_height: 6,
            prompt_box_rows: 3,
            ..ShellLayout::default()
        };
        let spinner = [Line("working".to_owned())];
        let (grid, _) = frame_of(&layout, PanelSlots::default(), &[], &Draft::empty(), &spinner, 14, 40);
        let meta = grid.row_text(6);
        assert!(meta.starts_with("working") && meta.trim_end().ends_with("Copied"), "{meta:?}");
        assert!(grid.row_text(7).trim().is_empty());
        assert!(grid.row_text(8).starts_with('\u{256d}'));
    }

    #[test]
    fn the_queued_commands_show_above_the_prompt_box_only_when_visible_and_with_the_input_box() {
        let queued = [json!({ "id": "q1", "text": "later please", "displayText": "later please" })];
        let layout = ShellLayout { queued_visible: true, viewport_height: 5, transcript_content_height: 5, prompt_box_rows: 3, ..ShellLayout::default() };
        let render = |layout: &ShellLayout| {
            let list = Items::new(&[], None);
            let window = RenderWindow { start_index: 0, end_index: 0, bottom_spacer_rows: 0, total_rows: 0, max_scroll_rows: 0, effective_scroll_offset: 0 };
            let overlay = OverlayHint { attach_item_index: None, tail_pinned: true, on_last_item: false, fallback_row: false };
            let mounted = rows::mount_rows(
                &mut ItemHeights::default(),
                &rows::MountInput {
                    items: &list,
                    window: &window,
                    layout,
                    frame_columns: 39,
                    tool_output_expanded: false,
                    streaming_tail_id: None,
                    overlay: &overlay,
                    now_ms: 0.0,
                },
            );
            let draft = Draft::empty();
            let props = AppViewProps {
                columns: 40,
                rows: 12,
                layout,
                cwd: "",
                version: "",
                transcript: &mounted,
                overlay: &overlay,
                panels: PanelSlots::default(),
                draft: &draft,
                exiting: false,
                tui_ready: true,
                spinner: &[],
                queued: &queued,
                footer: "",
                workflow: None,
            };
            let mut grid = Grid::new(40, 12);
            render_app(&props, &mut Painter::new(&mut grid));
            (0..12).map(|row| grid.row_text(row)).collect::<Vec<_>>()
        };
        let shown = render(&layout);
        assert!(shown[5].contains("later please") && shown[6].starts_with('╭'), "{shown:?}");
        let hidden = render(&ShellLayout { input_box_hidden: true, ..layout.clone() });
        assert!(!hidden.iter().any(|row| row.contains("later please")));
        let not_visible = render(&ShellLayout { queued_visible: false, ..layout });
        assert!(!not_visible.iter().any(|row| row.contains("later please")));
    }

    #[test]
    fn the_welcome_banner_sits_above_the_viewport_and_the_viewport_gives_back_rows_that_do_not_fit() {
        let layout =
            ShellLayout { show_welcome_banner: true, viewport_height: 20, transcript_content_height: 20, prompt_box_rows: 3, ..ShellLayout::default() };
        let (grid, _) = frame_of(&layout, PanelSlots::default(), &[], &Draft::empty(), &[], 24, 60);
        assert!(grid.row_text(3).contains('\u{2588}'));
        // 24 rows: 11 banner, 3 prompt box, 2 statusline leave 8 for the viewport, so the box starts at row 19.
        assert!(grid.row_text(19).starts_with('\u{256d}'));
    }
}
