//! The records the mouse hooks shared through refs (`use-interaction-refs.mjs`).

use mixdog_term::selection::SelectionRect;

/// The surface a selection belongs to: the press decides it, motion and release stay in it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Region {
    /// The transcript viewport (grid selection that scrolls).
    Transcript,
    /// The statusline band (grid selection that never scrolls).
    Status,
    /// The prompt box (the editor's own selection engine).
    Prompt,
}

/// A grid cell (0-based).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Point {
    pub x: i32,
    pub y: i32,
}

/// Whether a multi-click selection snaps to words or to lines.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SpanKind {
    Word,
    Line,
}

/// The first word or line of a double or triple click: a later drag extends by whole words or lines from it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AnchorSpan {
    pub lo: Point,
    pub hi: Point,
    pub kind: SpanKind,
}

/// `dragRef`: an in-progress mouse text selection.
#[derive(Clone, Debug, Default)]
pub struct Drag {
    /// Where the drag began.
    pub anchor: Option<Point>,
    /// The transcript scroll target at the press: the anchor is re-projected from it while the transcript scrolls.
    pub anchor_scroll: f64,
    /// The latest cell.
    pub last: Option<Point>,
    /// The button is held.
    pub active: bool,
    /// The rect last published, clipped to the region's rows.
    pub rect: Option<mixdog_term::selection::SelectionRect>,
    pub region: Option<Region>,
    /// `Some` for a word or line selection, `None` for an ordinary character drag.
    pub anchor_span: Option<AnchorSpan>,
}

impl Drag {
    /// `newDragState`: a fresh drag anchored at `(x, y)`.
    pub(crate) fn pressed(x: i32, y: i32, active: bool, region: Region, anchor_scroll: f64, anchor_span: Option<AnchorSpan>) -> Self {
        let at = Point { x, y };
        Self { anchor: Some(at), anchor_scroll, last: Some(at), active, rect: None, region: Some(region), anchor_span }
    }

    /// The rect of the drag, if any.
    pub fn rect(&self) -> Option<&SelectionRect> {
        self.rect.as_ref()
    }
}

/// `lastClickRef`: the previous left press and how many consecutive qualifying presses it ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LastClick {
    pub x: i32,
    pub y: i32,
    pub t_ms: u64,
    pub count: u32,
}

/// `promptBoxRectRef`: the prompt box as measured by the prompt input.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PromptBoxRect {
    pub top: i32,
    pub left: i32,
    pub height: i32,
    pub content_width: i32,
}
