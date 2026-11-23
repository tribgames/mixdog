//! Mouse input and selection (`src/tui/app/mouse-input/*`, `use-mouse-input.mjs`, `use-selection-focus.mjs`,
//! `use-selection-geometry.mjs`, `use-selection-paint.mjs` and `use-selection-paint/*`,
//! `use-copy-selection.mjs` and `use-interaction-refs.mjs`). The prompt box's drag selection is the editor's
//! ([`crate::editor::mouse_selection`]); this module decides which surface a press belongs to and drives it.
//!
//! [`Mouse`] is the state the Node hooks kept in refs (the drag, the last click, the paint throttle, the wheel acceleration,
//! the edge autoscroll) and the place and text of the selection in the content. Every entry point takes the host
//! ([`host::MouseHost`]: the render selection of `mixdog-term`, the prompt box's selection, the scroll engine, the clipboard)
//! and the clock in milliseconds. Node's timers are the caller's: it wakes at [`Mouse::next_deadline`] and calls
//! [`Mouse::tick`].
//!
//! * [`state`] - the drag, anchor span, last click and prompt box rect;
//! * [`config`] - the `MIXDOG_TUI_SELECTION_PAINT_MS` interval and the environment facts the gestures read;
//! * [`host`] - what the application provides;
//! * [`geometry`] - region ownership of a cell, drag point snapping, span rects;
//! * [`gestures`] - press, drag, release, right-click and shift/ctrl extend, multi-click;
//! * [`wheel`] - the wheel router (zoom passthrough, palette, overlay gate, acceleration);
//! * [`autoscroll`] - the held-at-edge autoscroll;
//! * [`paint`] - the clip, the publish and the motion throttle;
//! * [`focus`] - Shift+Arrow/Home/End moves of a released selection's focus end;
//! * [`follow`] - a selection as a place in the content and the text read there when it was made;
//! * [`copy`] - Ctrl+C, the selection's text;
//! * [`scroll`] - the selection side of a transcript scroll ([`scroll::SelectionScroll`]).

pub mod autoscroll;
pub mod config;
pub mod copy;
pub mod focus;
pub mod follow;
pub mod geometry;
pub mod gestures;
pub mod host;
pub mod paint;
pub mod scroll;
pub mod state;
pub mod wheel;

use mixdog_term::frame::Rgb;
use mixdog_term::{MouseKind, MouseReport};

use crate::transcript::scroll::tuning::WheelAccel;
use crate::transcript::window::selection_shift::{RowRange, transcript_viewport_row_range};

pub use config::MouseConfig;
pub use focus::FocusMove;
pub use host::{HintTone, MouseHost, PromptSelection, RenderStore, SelectionIo, SlashPalette};
pub use state::{AnchorSpan, Drag, LastClick, Point, PromptBoxRect, Region, SpanKind};

/// The mouse and selection state of one session (`useInteractionRefs` and the hook-scoped refs of the mouse hooks).
#[derive(Debug)]
pub struct Mouse {
    cfg: MouseConfig,
    /// `dragRef`: the in-progress or last mouse selection.
    pub drag: Drag,
    /// `lastClickRef`: the previous left press, `None` after anything that resets the multi-click sequence.
    pub last_click: Option<LastClick>,
    viewport: RowRange,
    frame_rows: f64,
    columns: usize,
    prompt_box: Option<PromptBoxRect>,
    wheel: WheelAccel,
    edge: autoscroll::EdgeAutoscroll,
    paint: paint::PaintState,
    follow: follow::Follow,
}

impl Mouse {
    pub fn new(cfg: MouseConfig) -> Self {
        Self {
            wheel: WheelAccel::new(&cfg.tuning),
            paint: paint::PaintState::new(cfg.paint_interval_ms),
            cfg,
            drag: Drag::default(),
            last_click: None,
            viewport: RowRange { top: 0, bottom: 0 },
            frame_rows: 24.0,
            columns: 0,
            prompt_box: None,
            edge: autoscroll::EdgeAutoscroll::default(),
            follow: follow::Follow::default(),
        }
    }

    pub fn config(&self) -> &MouseConfig {
        &self.cfg
    }

    /// `transcriptViewportRef`: the screen rows of the transcript viewport, from the last layout.
    pub fn set_transcript_viewport(&mut self, top: f64, bottom: f64) {
        self.viewport = transcript_viewport_row_range(Some(top), Some(bottom));
    }

    /// `frameRowsRef` and `frameColumns`: the terminal size of the last frame. A width of 0 is unknown (80 columns).
    pub fn set_frame(&mut self, rows: f64, columns: usize) {
        self.frame_rows = rows;
        self.columns = columns;
    }

    /// `promptBoxRectRef`: where the prompt box sits, or `None` while it is not laid out.
    pub fn set_prompt_box_rect(&mut self, rect: Option<PromptBoxRect>) {
        self.prompt_box = rect;
    }

    /// The highlight colour of the theme (`selectionHighlightBackground`, else `selectionBackground`), which every painted
    /// rect carries to the renderer.
    pub fn set_selection_background(&mut self, background: Rgb) {
        self.paint.set_background(background);
    }

    /// One mouse report of the terminal: a wheel notch goes to the wheel router, everything else to the button gestures.
    pub fn handle_report<H: MouseHost + ?Sized>(&mut self, report: &MouseReport, host: &mut H, now_ms: u64) {
        match report.kind {
            MouseKind::WheelUp | MouseKind::WheelDown => self.route_wheel(report, host, now_ms),
            _ => self.route_button(report, host, now_ms),
        }
    }

    /// Recovery for a drag whose release never arrived (the button was let go outside the window, or the release was
    /// swallowed while mouse tracking was off): any keystroke ends the gesture through the release path. Returns whether a
    /// drag was settled.
    pub fn settle_stuck_drag<H: MouseHost + ?Sized>(&mut self, host: &mut H, now_ms: u64) -> bool {
        if !self.drag.active {
            return false;
        }
        let last = self.drag.last.unwrap_or(Point { x: 0, y: 0 });
        self.finalize_active_drag(host, last.x, last.y, now_ms);
        self.finish_windows_mouse_gesture(host);
        true
    }

    /// The earliest time (the caller's millisecond clock) [`Self::tick`] has work to do.
    pub fn next_deadline(&self) -> Option<u64> {
        [self.paint.deadline(), self.edge.deadline()].into_iter().flatten().min()
    }

    /// Runs what is due at `now_ms`: the trailing motion paint and the edge autoscroll step.
    pub fn tick<H: MouseHost + ?Sized>(&mut self, host: &mut H, now_ms: u64) {
        self.fire_paint_timer(host, now_ms);
        self.edge_tick(host, now_ms);
    }

    /// Whether a transcript or status grid selection is live (`gridSelectionActiveRef`): a released, non-empty rect.
    pub fn grid_selection_active(&self) -> bool {
        let drag = &self.drag;
        if drag.active || !matches!(drag.region, Some(Region::Transcript | Region::Status)) {
            return false;
        }
        drag.rect.as_ref().is_some_and(|rect| !geometry::rect_is_degenerate(rect))
    }

    /// The session is closing or the view is replaced: every timer and pending capture is dropped.
    pub fn dispose(&mut self) {
        self.paint.dispose();
        self.edge.stop();
    }

    /// `finishWindowsMouseGesture`: Windows Terminal's native selection overlay survives incremental frames, so an app-owned
    /// gesture that completed asks for one full repaint, never on drag motion.
    pub(crate) fn finish_windows_mouse_gesture<S: RenderStore + ?Sized>(&self, store: &mut S) {
        if self.cfg.windows_terminal {
            store.force_render_repaint();
        }
    }
}
