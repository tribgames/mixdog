//! The Rust mouse and selection code against what the Node one does (tests/goldens/mouse.json, recorded by
//! tests/recorders/record-mouse.mjs): scripted mouse report sequences over a fake rendered frame and a fake clock, with the drag,
//! the rects handed to the renderer, the scroll target, the remembered and stitched text, the prompt engine calls, the palette
//! steps, the zoom passthroughs, the repaints, the copied text and the hints compared after every step; and the port of
//! `use-mouse-input.test.mjs` and `use-selection-paint.test.mjs`.

use std::cell::Cell;
use std::rc::Rc;

use mixdog_js::{js_trim, js_trim_end};
use mixdog_term::selection::{CellSpan, SelectedRow, SelectionMode, SelectionRect};
use mixdog_term::{MouseKind, MouseReport};
use mixdog_tui::mouse::scroll::SelectionScroll;
use mixdog_tui::mouse::{HintTone, Mouse, MouseConfig, MouseHost, Point, PromptBoxRect, PromptSelection, Region, RenderStore, SelectionIo, SlashPalette, SpanKind};
use mixdog_tui::slash::commands::OverlayOwner;
use mixdog_tui::transcript::scroll::anchor::Geometry;
use mixdog_tui::transcript::scroll::coalesce::ScrollCoalescer;
use mixdog_tui::transcript::scroll::engine::{ScrollHost, TranscriptScroll};
use serde_json::{Map, Value, json};

const COLUMNS: usize = 40;
const VIEW_ROWS: usize = 10;
const FRAME_ROWS: i32 = 16;
const TOTAL_ROWS: i64 = 40;
const STATUSLINE_BAND_ROWS: usize = 2;
const WORDS: [&str; 5] = ["alpha", "beta", "gamma", "delta", "omega"];

// ── the fake frame (the same screen the recorder draws) ─────────────────────────────────────────────────────────────────

fn content_line(index: i64) -> String {
    if index % 11 == 5 {
        return String::new();
    }
    format!("l{index} {} {}-{} end", WORDS[(index % 5) as usize], WORDS[((index + 2) % 5) as usize], index * 7)
}

fn content_soft_wrap(index: i64) -> bool {
    index % 7 == 3 && !content_line(index).is_empty()
}

/// The rendered selection of the fake screen: what the renderer would read for the rect last published, at the scroll target now.
struct FakeStore {
    current: Option<SelectionRect>,
    cached_text: Option<String>,
    target: Rc<Cell<f64>>,
    repaints: usize,
    log: Vec<Value>,
}

impl FakeStore {
    fn new(target: Rc<Cell<f64>>) -> Self {
        Self { current: None, cached_text: None, target, repaints: 0, log: Vec::new() }
    }

    fn content_index(&self, y: i32) -> i64 {
        TOTAL_ROWS - VIEW_ROWS as i64 - self.target.get() as i64 + i64::from(y)
    }

    fn screen_line(&self, y: i32) -> String {
        let text = if (0..VIEW_ROWS as i32).contains(&y) {
            content_line(self.content_index(y))
        } else {
            match y {
                14 => "model gpt-x ctx 12% idle".to_owned(),
                15 => "branch main +3 -1 done".to_owned(),
                _ => String::new(),
            }
        };
        format!("{text:<width$}", width = COLUMNS)[..COLUMNS].to_owned()
    }

    fn soft_wrap(&self, y: i32) -> bool {
        (0..VIEW_ROWS as i32).contains(&y) && content_soft_wrap(self.content_index(y))
    }

    fn rows(&self) -> Option<Vec<SelectedRow>> {
        let rect = self.current.as_ref()?;
        let backwards = rect.y1 > rect.y2 || (rect.y1 == rect.y2 && rect.x1 > rect.x2);
        let (start, end) = if backwards { ((rect.x2, rect.y2), (rect.x1, rect.y1)) } else { ((rect.x1, rect.y1), (rect.x2, rect.y2)) };
        let clip1 = rect.clip_y1.unwrap_or(0);
        let clip2 = rect.clip_y2.unwrap_or(FRAME_ROWS - 1);
        let y1 = clip1.max(0).max(start.1);
        let y2 = (FRAME_ROWS - 1).min(clip2).min(end.1);
        let line_mode = y1 != y2;
        let mut rows: Vec<SelectedRow> = Vec::new();
        for y in y1..=y2 {
            let (rx1, rx2) = if line_mode {
                (if y == start.1 { start.0 } else { 0 }, if y == end.1 { end.0 } else { COLUMNS as i32 - 1 })
            } else {
                (start.0.min(end.0), start.0.max(end.0))
            };
            let x1 = rx1.min(rx2).max(0);
            let x2 = (COLUMNS as i32 - 1).min(rx1.max(rx2));
            let raw = if x1 > x2 { String::new() } else { self.screen_line(y)[x1 as usize..=x2 as usize].to_owned() };
            let trimmed = js_trim_end(&raw);
            let next_continues = y < y2 && self.soft_wrap(y + 1);
            let text = if next_continues && trimmed.len() < raw.len() { format!("{trimmed} ") } else { trimmed.to_owned() };
            rows.push(SelectedRow { y, text, soft_wrap: self.soft_wrap(y) });
        }
        while rows.first().is_some_and(|row| js_trim(&row.text).is_empty()) {
            rows.remove(0);
        }
        while rows.last().is_some_and(|row| js_trim(&row.text).is_empty()) {
            rows.pop();
        }
        Some(rows)
    }
}

impl RenderStore for FakeStore {
    fn word_rect_at(&mut self, x: i32, y: i32) -> Option<CellSpan> {
        let line = self.screen_line(y);
        let bytes = line.as_bytes();
        if x < 0 || x >= COLUMNS as i32 || bytes[x as usize] == b' ' {
            return None;
        }
        let (mut x1, mut x2) = (x as usize, x as usize);
        while x1 > 0 && bytes[x1 - 1] != b' ' {
            x1 -= 1;
        }
        while x2 < COLUMNS - 1 && bytes[x2 + 1] != b' ' {
            x2 += 1;
        }
        Some(CellSpan { x1: x1 as i32, y1: y, x2: x2 as i32, y2: y })
    }

    fn line_rect_at(&mut self, y: i32) -> Option<CellSpan> {
        let line = self.screen_line(y);
        let trimmed = js_trim_end(&line);
        (!trimmed.is_empty()).then(|| CellSpan { x1: 0, y1: y, x2: trimmed.len() as i32 - 1, y2: y })
    }

    fn set_render_selection(&mut self, rect: Option<&SelectionRect>) {
        self.current = rect.copied();
        self.log.push(rect.map_or(Value::Null, rect_json));
    }

    fn render_selection_text(&mut self) -> Option<String> {
        let rect = self.current?;
        if !rect.capture_text {
            return self.cached_text.clone();
        }
        let mut logical: Vec<String> = Vec::new();
        for row in self.rows()? {
            match logical.last_mut() {
                Some(last) if row.soft_wrap => last.push_str(&row.text),
                _ => logical.push(row.text),
            }
        }
        let text = logical.iter().map(|line| js_trim_end(line)).collect::<Vec<_>>().join("\n");
        self.cached_text = Some(text.clone());
        Some(text)
    }

    fn render_selection_rows(&mut self) -> Option<Vec<SelectedRow>> {
        self.rows()
    }

    fn force_render_repaint(&mut self) {
        self.repaints += 1;
    }
}

struct FakePrompt {
    enabled: bool,
    has: bool,
    log: Vec<Value>,
}

impl PromptSelection for FakePrompt {
    fn offset_at_cell(&mut self, row: usize, col: usize) -> usize {
        row * 100 + col
    }
    fn has_selection(&mut self) -> bool {
        self.has
    }
    fn clear(&mut self) {
        self.log.push(json!(["clear"]));
    }
    fn anchor_at(&mut self, offset: usize) {
        self.log.push(json!(["anchorAt", offset]));
    }
    fn extend_to(&mut self, offset: Option<usize>, immediate: bool) {
        self.log.push(json!(["extendTo", offset, immediate]));
    }
    fn select_word_at(&mut self, offset: usize) {
        self.log.push(json!(["selectWordAt", offset]));
    }
    fn select_line_at(&mut self, offset: usize) {
        self.log.push(json!(["selectLineAt", offset]));
    }
}

/// A transcript with no older or newer history to page.
struct NoHistory;

impl ScrollHost for NoHistory {
    fn history_before(&self) -> bool {
        false
    }
    fn history_after(&self) -> bool {
        false
    }
    fn restore_older(&mut self) -> bool {
        false
    }
    fn restore_newer(&mut self) -> bool {
        false
    }
}

/// The selection scroll hooks plus a note of the scroll target the fake screen is drawn at.
struct Tracked<'a> {
    target: &'a Cell<f64>,
    selection: SelectionScroll<'a, FakeStore, NoHistory>,
}

impl ScrollHost for Tracked<'_> {
    fn history_before(&self) -> bool {
        self.selection.history_before()
    }
    fn history_after(&self) -> bool {
        self.selection.history_after()
    }
    fn restore_older(&mut self) -> bool {
        self.selection.restore_older()
    }
    fn restore_newer(&mut self) -> bool {
        self.selection.restore_newer()
    }
    fn selection_before_scroll(&mut self, target_before: f64) {
        self.selection.selection_before_scroll(target_before);
    }
    fn selection_after_scroll(&mut self, applied_delta: f64, target: f64) {
        self.target.set(target);
        self.selection.selection_after_scroll(applied_delta, target);
    }
}

/// The application the mouse code is hosted by: the fake frame, the scroll engine with its coalescer, the prompt engine, the
/// palette, the clipboard and the hint band.
struct World {
    store: FakeStore,
    prompt: FakePrompt,
    scroll: TranscriptScroll,
    coalescer: ScrollCoalescer,
    coalesce_ms: u64,
    target: Rc<Cell<f64>>,
    now: u64,
    palette: SlashPalette,
    overlay: OverlayOwner,
    slash_index: i64,
    slash_log: Vec<i64>,
    zoom: usize,
    hints: Vec<Value>,
    clipboard: Vec<String>,
    clipboard_fail: Option<String>,
}

impl World {
    fn new(target0: f64, prompt_enabled: bool, coalesce_ms: u64) -> Self {
        let target = Rc::new(Cell::new(target0));
        let heights = [10usize, 10, 10, 10];
        let mut prefix = vec![0usize];
        for height in heights {
            prefix.push(prefix.last().copied().unwrap_or(0) + height);
        }
        let geom = Geometry {
            total_rows: prefix.last().copied().unwrap_or(0),
            ids: (0..heights.len()).map(|index| json!(format!("i{index}"))).collect(),
            prefix_rows: Some(prefix),
            view_rows: VIEW_ROWS,
            render_offset: 0.0,
        };
        let scroll = TranscriptScroll {
            max_scroll_rows: geom.total_rows - VIEW_ROWS,
            following: target0 == 0.0,
            geom,
            target: target0,
            position: target0,
            scroll_offset: target0 as usize,
            ..TranscriptScroll::default()
        };
        Self {
            store: FakeStore::new(Rc::clone(&target)),
            prompt: FakePrompt { enabled: prompt_enabled, has: false, log: Vec::new() },
            scroll,
            coalescer: ScrollCoalescer::default(),
            coalesce_ms,
            target,
            now: 1000,
            palette: SlashPalette::default(),
            overlay: OverlayOwner::default(),
            slash_index: 2,
            slash_log: Vec::new(),
            zoom: 0,
            hints: Vec::new(),
            clipboard: Vec::new(),
            clipboard_fail: None,
        }
    }

    /// `scrollTranscriptRows`: scrolls now, the selection following.
    fn scroll_now(&mut self, mouse: &mut Mouse, rows: f64) {
        let mut inner = NoHistory;
        let mut tracked = Tracked {
            target: &self.target,
            selection: SelectionScroll { mouse, store: &mut self.store, inner: &mut inner, now_ms: self.now },
        };
        self.scroll.scroll_rows(&mut tracked, rows, false);
        self.target.set(self.scroll.target);
    }
}

impl RenderStore for World {
    fn word_rect_at(&mut self, x: i32, y: i32) -> Option<CellSpan> {
        self.store.word_rect_at(x, y)
    }
    fn line_rect_at(&mut self, y: i32) -> Option<CellSpan> {
        self.store.line_rect_at(y)
    }
    fn set_render_selection(&mut self, rect: Option<&SelectionRect>) {
        self.store.set_render_selection(rect);
    }
    fn render_selection_text(&mut self) -> Option<String> {
        self.store.render_selection_text()
    }
    fn render_selection_rows(&mut self) -> Option<Vec<SelectedRow>> {
        self.store.render_selection_rows()
    }
    fn force_render_repaint(&mut self) {
        self.store.force_render_repaint();
    }
}

impl SelectionIo for World {
    fn scroll_target(&self) -> f64 {
        self.scroll.target
    }
}

impl MouseHost for World {
    fn prompt(&mut self) -> Option<&mut dyn PromptSelection> {
        if self.prompt.enabled { Some(&mut self.prompt) } else { None }
    }
    fn stop_smooth_scroll(&mut self) {
        self.scroll.stop_smooth_scroll();
    }
    fn queue_scroll_coalesced(&mut self, mouse: &mut Mouse, rows: f64) {
        if let Some(flush) = self.coalescer.queue(rows, self.now, self.coalesce_ms) {
            self.scroll_now(mouse, flush);
        }
    }
    fn scroll_transcript_rows(&mut self, mouse: &mut Mouse, rows: f64) {
        self.scroll_now(mouse, rows);
    }
    fn bottom_slack_rows(&self) -> f64 {
        self.scroll.bottom_slack_rows as f64
    }
    fn slash_palette(&self) -> SlashPalette {
        self.palette
    }
    fn overlay_owner(&self) -> OverlayOwner {
        self.overlay
    }
    fn step_slash_index(&mut self, wheel_dir: i32, count: usize) {
        self.slash_index = (self.slash_index - i64::from(wheel_dir)).clamp(0, count as i64 - 1);
        self.slash_log.push(self.slash_index);
    }
    fn passthrough_ctrl_wheel_zoom(&mut self) {
        self.zoom += 1;
    }
    fn write_clipboard(&mut self, text: &str) -> Result<(), String> {
        self.clipboard.push(text.to_owned());
        self.clipboard_fail.clone().map_or(Ok(()), Err)
    }
    fn show_selection_copy_hint(&mut self, message: &str, tone: HintTone) {
        self.hints.push(json!([message, if tone == HintTone::Error { "error" } else { "plain" }]));
    }
}

// ── the recording ───────────────────────────────────────────────────────────────────────────────────────────────────────


fn rect_json(rect: &SelectionRect) -> Value {
    let mut out = Map::new();
    out.insert("mode".into(), json!(if rect.mode == SelectionMode::Linear { "linear" } else { "block" }));
    out.insert("x1".into(), json!(rect.x1));
    out.insert("y1".into(), json!(rect.y1));
    out.insert("x2".into(), json!(rect.x2));
    out.insert("y2".into(), json!(rect.y2));
    if let Some(clip) = rect.clip_y1 {
        out.insert("clipY1".into(), json!(clip));
    }
    if let Some(clip) = rect.clip_y2 {
        out.insert("clipY2".into(), json!(clip));
    }
    if !rect.capture_text {
        out.insert("captureText".into(), json!(false));
    }
    Value::Object(out)
}








fn config(windows_terminal: bool) -> MouseConfig {
    MouseConfig::from_lookup(|name| (windows_terminal && name == "WT_SESSION").then(|| "recorded-wt-session".to_owned()), STATUSLINE_BAND_ROWS)
}


// ── use-mouse-input.test.mjs ────────────────────────────────────────────────────────────────────────────────────────────

const LEFT: i32 = 0;
const RIGHT: i32 = 2;
const MOTION: i32 = 32;
const CTRL: i32 = 16;

/// The host of `use-mouse-input.test.mjs`: a store whose word is the three cells around the pointer and whose line is the
/// whole row, a prompt engine mapping a cell to `row * 100 + col`, and a scroll that is only recorded.
struct Probe {
    selections: Vec<Option<SelectionRect>>,
    scrolls: Vec<f64>,
    words: Vec<(i32, i32)>,
    lines: Vec<i32>,
    prompt: Option<ProbePrompt>,
}

struct ProbePrompt {
    has: bool,
    clears: usize,
    calls: Vec<(String, usize, bool)>,
}

impl PromptSelection for ProbePrompt {
    fn offset_at_cell(&mut self, row: usize, col: usize) -> usize {
        row * 100 + col
    }
    fn has_selection(&mut self) -> bool {
        self.has
    }
    fn clear(&mut self) {
        self.clears += 1;
    }
    fn anchor_at(&mut self, offset: usize) {
        self.calls.push(("anchorAt".into(), offset, false));
    }
    fn extend_to(&mut self, offset: Option<usize>, immediate: bool) {
        self.calls.push(("extendTo".into(), offset.expect("an offset"), immediate));
    }
    fn select_word_at(&mut self, offset: usize) {
        self.calls.push(("selectWordAt".into(), offset, false));
    }
    fn select_line_at(&mut self, offset: usize) {
        self.calls.push(("selectLineAt".into(), offset, false));
    }
}

impl RenderStore for Probe {
    fn word_rect_at(&mut self, x: i32, y: i32) -> Option<CellSpan> {
        self.words.push((x, y));
        Some(CellSpan { x1: x - 1, y1: y, x2: x + 1, y2: y })
    }
    fn line_rect_at(&mut self, y: i32) -> Option<CellSpan> {
        self.lines.push(y);
        Some(CellSpan { x1: 0, y1: y, x2: 39, y2: y })
    }
    fn set_render_selection(&mut self, rect: Option<&SelectionRect>) {
        self.selections.push(rect.copied());
    }
    fn render_selection_text(&mut self) -> Option<String> {
        None
    }
    fn render_selection_rows(&mut self) -> Option<Vec<SelectedRow>> {
        None
    }
    fn force_render_repaint(&mut self) {}
}

impl SelectionIo for Probe {
    fn scroll_target(&self) -> f64 {
        5.0
    }
}

impl MouseHost for Probe {
    fn prompt(&mut self) -> Option<&mut dyn PromptSelection> {
        self.prompt.as_mut().map(|prompt| prompt as &mut dyn PromptSelection)
    }
    fn stop_smooth_scroll(&mut self) {}
    fn queue_scroll_coalesced(&mut self, _mouse: &mut Mouse, rows: f64) {
        self.scrolls.push(rows);
    }
    fn scroll_transcript_rows(&mut self, _mouse: &mut Mouse, rows: f64) {
        self.scrolls.push(rows);
    }
    fn bottom_slack_rows(&self) -> f64 {
        0.0
    }
    fn slash_palette(&self) -> SlashPalette {
        SlashPalette::default()
    }
    fn overlay_owner(&self) -> OverlayOwner {
        OverlayOwner::default()
    }
    fn step_slash_index(&mut self, _wheel_dir: i32, _count: usize) {}
    fn passthrough_ctrl_wheel_zoom(&mut self) {}
    fn write_clipboard(&mut self, _text: &str) -> Result<(), String> {
        Ok(())
    }
    fn show_selection_copy_hint(&mut self, _message: &str, _tone: HintTone) {}
}

struct Rig {
    mouse: Mouse,
    host: Probe,
    now: u64,
}

fn rig(prompt_box: Option<PromptBoxRect>) -> Rig {
    let mut mouse = Mouse::new(config(false));
    mouse.set_frame(24.0, 40);
    mouse.set_transcript_viewport(0.0, 9.0);
    mouse.set_prompt_box_rect(prompt_box);
    let prompt = ProbePrompt { has: false, clears: 0, calls: Vec::new() };
    Rig { mouse, host: Probe { selections: Vec::new(), scrolls: Vec::new(), words: Vec::new(), lines: Vec::new(), prompt: Some(prompt) }, now: 10_000 }
}

impl Rig {
    /// A report at grid cell (x, y); `action` is `press` unless it says `release`.
    fn emit(&mut self, button: i32, x: i32, y: i32, release: bool) {
        let kind = if release {
            MouseKind::Release
        } else if button & MOTION != 0 {
            MouseKind::Drag
        } else {
            MouseKind::Press
        };
        let report = MouseReport { kind, button, col: x, row: y, shift: button & 4 != 0, alt: false, ctrl: button & CTRL != 0 };
        self.mouse.handle_report(&report, &mut self.host, self.now);
    }

    fn press(&mut self, button: i32, x: i32, y: i32) {
        self.emit(button, x, y, false);
    }

    fn release(&mut self, button: i32, x: i32, y: i32) {
        self.emit(button, x, y, true);
    }

    fn rect(&self) -> Option<(i32, i32, i32, i32)> {
        self.mouse.drag.rect.as_ref().map(|r| (r.x1, r.y1, r.x2, r.y2))
    }

    fn prompt(&mut self) -> &mut ProbePrompt {
        self.host.prompt.as_mut().expect("a prompt")
    }
}

#[test]
fn press_drag_and_release_in_the_transcript_build_a_linear_selection() {
    let mut rig = rig(None);
    rig.press(LEFT, 2, 1);
    assert!(rig.mouse.drag.active);
    assert_eq!(rig.mouse.drag.region, Some(Region::Transcript));
    assert_eq!(rig.mouse.drag.anchor_scroll, 5.0);
    assert!(rig.host.selections.is_empty(), "a plain press paints nothing");
    rig.now += 100;
    rig.press(LEFT | MOTION, 7, 3);
    assert_eq!(rig.rect(), Some((2, 1, 7, 3)));
    assert!(!rig.mouse.drag.rect.as_ref().expect("a rect").capture_text, "a motion paint does not capture text");
    rig.release(LEFT, 7, 3);
    assert_eq!(rig.rect(), Some((2, 1, 7, 3)));
    assert!(rig.mouse.drag.rect.as_ref().expect("a rect").capture_text);
    assert!(!rig.mouse.drag.active);
}

#[test]
fn a_release_on_the_press_cell_clears_instead_of_painting_an_empty_rect() {
    let mut rig = rig(None);
    rig.press(LEFT, 4, 2);
    rig.release(LEFT, 4, 2);
    assert_eq!(rig.mouse.drag.rect, None);
    assert!(rig.host.selections.is_empty(), "nothing was ever painted, so nothing is cleared");
    assert!(!rig.mouse.drag.active);
}

#[test]
fn dragging_past_the_viewport_edge_snaps_the_point_and_scrolls_toward_the_edge() {
    let mut rig = rig(None);
    rig.press(LEFT, 2, 5);
    rig.press(LEFT | MOTION, 7, 12);
    assert_eq!(rig.rect(), Some((2, 5, 39, 9)));
    assert_eq!(rig.host.scrolls, vec![-3.0]);
    rig.now += 100;
    rig.press(LEFT | MOTION, 7, 4);
    assert_eq!(rig.rect(), Some((2, 5, 7, 4)));
    rig.release(LEFT, 7, 4);
}

#[test]
fn a_right_press_extends_a_character_selection_one_shot_and_ctrl_press_keeps_the_drag_armed() {
    let mut rig = rig(None);
    rig.press(LEFT, 2, 1);
    rig.press(LEFT | MOTION, 5, 2);
    rig.release(LEFT, 5, 2);
    let clears_before = rig.prompt().clears;
    rig.now += 1000;
    rig.press(RIGHT, 11, 5);
    assert_eq!(rig.rect(), Some((2, 1, 11, 5)));
    assert!(!rig.mouse.drag.active);
    assert_eq!(rig.mouse.drag.last, Some(Point { x: 11, y: 5 }));
    assert_eq!(rig.prompt().clears, clears_before + 1);
    assert_eq!(rig.mouse.last_click.map(|click| click.count), Some(1));
    rig.press(LEFT | CTRL, 20, 8);
    assert_eq!(rig.rect(), Some((2, 1, 20, 8)));
    assert!(rig.mouse.drag.active);
    assert_eq!(rig.mouse.drag.region, Some(Region::Transcript));
}

#[test]
fn a_right_press_with_nothing_extendable_is_ignored() {
    let mut rig = rig(None);
    rig.press(RIGHT, 3, 3);
    rig.press(LEFT, 4, 2);
    rig.release(LEFT, 4, 2);
    let selections_before = rig.host.selections.len();
    rig.press(RIGHT, 8, 3);
    assert_eq!(rig.host.selections.len(), selections_before);
    assert!(!rig.mouse.drag.active);
}

#[test]
fn double_and_triple_clicks_select_word_and_line_spans_that_later_extend_by_span() {
    let mut rig = rig(None);
    rig.press(LEFT, 6, 2);
    rig.release(LEFT, 6, 2);
    rig.now += 100;
    rig.press(LEFT, 7, 2);
    assert_eq!(rig.host.words, vec![(7, 2)]);
    assert_eq!(rig.rect(), Some((6, 2, 8, 2)));
    assert_eq!(rig.mouse.drag.anchor_span.map(|span| span.kind), Some(SpanKind::Word));
    rig.release(LEFT, 7, 2);
    assert_eq!(rig.rect(), Some((6, 2, 8, 2)), "a release inside the span keeps it");
    rig.now += 100;
    rig.press(LEFT, 7, 2);
    assert_eq!(rig.host.lines, vec![2]);
    assert_eq!(rig.mouse.drag.anchor_span.map(|span| span.kind), Some(SpanKind::Line));
    rig.release(LEFT, 7, 2);
    rig.press(RIGHT, 3, 8);
    assert_eq!(rig.rect(), Some((0, 2, 39, 8)), "the line span extends to the line under the pointer");
    assert!(!rig.mouse.drag.active);
}

#[test]
fn status_band_selections_anchor_without_scroll_and_extend_within_the_band() {
    let mut rig = rig(None);
    rig.press(LEFT, 1, 22);
    assert_eq!(rig.mouse.drag.region, Some(Region::Status));
    assert_eq!(rig.mouse.drag.anchor_scroll, 0.0);
    rig.press(LEFT | MOTION, 9, 23);
    rig.release(LEFT, 9, 23);
    assert_eq!(rig.rect(), Some((1, 22, 9, 23)));
    rig.press(RIGHT, 12, 22);
    assert_eq!(rig.rect(), Some((1, 22, 12, 22)));
}

#[test]
fn a_press_outside_every_region_clears_all_selections() {
    let mut rig = rig(None);
    rig.press(LEFT, 2, 1);
    rig.press(LEFT, 2, 15);
    assert_eq!(rig.mouse.drag.rect, None);
    assert!(!rig.mouse.drag.active);
    assert_eq!(rig.mouse.drag.region, None);
}

#[test]
fn prompt_box_presses_anchor_drag_extend_and_multi_click_through_the_prompt_engine() {
    let mut rig = rig(Some(PromptBoxRect { top: 12, left: 2, height: 3, content_width: 30 }));
    rig.press(LEFT, 5, 13);
    assert_eq!(rig.prompt().calls, vec![("anchorAt".to_owned(), 103, false)]);
    rig.press(LEFT | MOTION, 8, 14);
    rig.release(LEFT, 8, 14);
    assert_eq!(rig.prompt().calls[1..], [("extendTo".to_owned(), 206, false), ("extendTo".to_owned(), 206, true)]);
    rig.now += 100;
    rig.press(LEFT, 5, 13);
    assert_eq!(rig.prompt().calls.last(), Some(&("selectWordAt".to_owned(), 103, false)));
    rig.release(LEFT, 5, 13);
    assert_eq!(rig.prompt().calls.last(), Some(&("selectWordAt".to_owned(), 103, false)), "the release does not collapse the word");
    rig.prompt().has = true;
    rig.press(RIGHT, 10, 12);
    assert_eq!(rig.prompt().calls.last(), Some(&("extendTo".to_owned(), 8, true)));
}

#[test]
fn settle_stuck_drag_finalizes_a_drag_whose_release_never_arrived() {
    let mut rig = rig(None);
    assert!(!rig.mouse.settle_stuck_drag(&mut rig.host, rig.now));
    rig.press(LEFT, 2, 1);
    rig.press(LEFT | MOTION, 6, 4);
    rig.now += 100;
    assert!(rig.mouse.settle_stuck_drag(&mut rig.host, rig.now));
    assert_eq!(rig.rect(), Some((2, 1, 6, 4)));
    assert!(!rig.mouse.drag.active);
}

// ── use-selection-paint.test.mjs ────────────────────────────────────────────────────────────────────────────────────────

#[test]
fn a_failing_selection_text_capture_leaves_the_remembered_text_alone() {
    // Node: the renderer went away while the text was read, and nothing became an unhandled rejection. Here the read has no
    // text to give, and the remembered text and the painted rect stay as they were.
    let mut rig = rig(None);
    rig.mouse.selection_text = "kept".to_owned();
    rig.press(LEFT, 0, 1);
    rig.press(LEFT | MOTION, 5, 1);
    rig.release(LEFT, 5, 1);
    for _ in 0..4 {
        rig.mouse.after_frame(&mut rig.host);
    }
    assert_eq!(rig.mouse.selection_text, "kept");
    assert_eq!(rig.rect(), Some((0, 1, 5, 1)));
}

#[test]
fn the_stitch_buffer_is_not_complete_over_a_hole_and_drops_with_a_new_anchor() {
    let mut world = World::new(0.0, false, 16);
    let mut mouse = Mouse::new(config(false));
    mouse.set_frame(f64::from(FRAME_ROWS), COLUMNS);
    mouse.set_transcript_viewport(0.0, 9.0);
    let press = |mouse: &mut Mouse, world: &mut World, kind: MouseKind, button: i32, x: i32, y: i32| {
        let report = MouseReport { kind, button, col: x, row: y, shift: false, alt: false, ctrl: false };
        mouse.handle_report(&report, world, 1000);
    };
    press(&mut mouse, &mut world, MouseKind::Press, LEFT, 3, 2);
    press(&mut mouse, &mut world, MouseKind::Drag, LEFT | MOTION, 10, 5);
    press(&mut mouse, &mut world, MouseKind::Release, LEFT, 10, 5);
    mouse.after_frame(&mut world);
    let stitched = mouse.stitched_selection_text(0.0);
    assert!(stitched.complete, "the rows under the whole selection were harvested");
    assert_eq!(stitched.text, mouse.selection_text);
    // A fresh press drops what the old selection stitched.
    press(&mut mouse, &mut world, MouseKind::Press, LEFT, 1, 8);
    assert_eq!(mouse.stitched_selection_text(0.0).text, "");
}

#[test]
fn copy_reports_one_char_without_a_plural_and_nothing_to_copy_after_the_retries() {
    let mut world = World::new(0.0, false, 16);
    let mut mouse = Mouse::new(config(false));
    mouse.set_frame(f64::from(FRAME_ROWS), COLUMNS);
    mouse.set_transcript_viewport(0.0, 9.0);
    mouse.selection_text = "x".to_owned();
    mouse.copy_selection(&mut world, 0, 1000);
    assert_eq!(world.hints, vec![json!(["copied 1 char", "plain"])]);
    assert_eq!(world.clipboard, vec!["x".to_owned()]);
    mouse.selection_text.clear();
    world.hints.clear();
    let mut now = 2000;
    mouse.copy_selection(&mut world, 0, now);
    while let Some(due) = mouse.next_deadline() {
        now = now.max(due);
        mouse.tick(&mut world, now);
    }
    assert_eq!(world.hints, vec![json!(["nothing to copy \u{b7} select text first", "error"])]);
    assert_eq!(now, 2000 + 3 * 24, "the first retry is immediate, the next ones wait 24 ms");
}

fn wheel(up: bool, ctrl: bool) -> MouseReport {
    MouseReport {
        kind: if up { MouseKind::WheelUp } else { MouseKind::WheelDown },
        button: (if up { 64 } else { 65 }) + if ctrl { CTRL } else { 0 },
        col: 0,
        row: 0,
        shift: false,
        alt: false,
        ctrl,
    }
}

fn wheel_world(target: f64) -> (World, Mouse) {
    let cfg = config(false);
    let coalesce_ms = cfg.tuning.coalesce_ms;
    let mut mouse = Mouse::new(cfg);
    mouse.set_frame(24.0, 40);
    mouse.set_transcript_viewport(0.0, (VIEW_ROWS - 1) as f64);
    (World::new(target, false, coalesce_ms), mouse)
}

/// Lets every pending coalesced scroll fire.
fn flush_scrolls(world: &mut World, mouse: &mut Mouse) {
    while let Some(due) = world.coalescer.deadline() {
        world.now = world.now.max(due);
        if let Some(rows) = world.coalescer.tick(world.now) {
            world.scroll_now(mouse, rows);
        }
    }
}

#[test]
fn a_wheel_notch_scrolls_toward_older_rows_when_up_and_toward_the_tail_when_down() {
    let (mut world, mut mouse) = wheel_world(5.0);
    mouse.route_wheel(&wheel(true, false), &mut world, 1_000);
    flush_scrolls(&mut world, &mut mouse);
    assert_eq!(world.scroll.target, 8.0, "one notch is three rows toward older rows");
    let (mut down, mut down_mouse) = wheel_world(20.0);
    down_mouse.route_wheel(&wheel(false, false), &mut down, 1_000);
    flush_scrolls(&mut down, &mut down_mouse);
    assert_eq!(down.scroll.target, 17.0, "and three rows toward the tail, outside the band that snaps to it");
}

#[test]
fn ctrl_wheel_is_left_to_the_terminals_zoom_and_never_scrolls() {
    let (mut world, mut mouse) = wheel_world(5.0);
    mouse.route_wheel(&wheel(true, true), &mut world, 1_000);
    flush_scrolls(&mut world, &mut mouse);
    assert_eq!((world.zoom, world.scroll.target), (1, 5.0));
}

#[test]
fn an_open_palette_takes_the_wheel_as_list_navigation() {
    let (mut world, mut mouse) = wheel_world(5.0);
    world.palette = SlashPalette { open: true, count: 3 };
    mouse.route_wheel(&wheel(true, false), &mut world, 1_000);
    mouse.route_wheel(&wheel(false, false), &mut world, 1_010);
    assert_eq!(world.slash_log, [1, 2], "up moves the highlight up, down moves it back");
    flush_scrolls(&mut world, &mut mouse);
    assert_eq!(world.scroll.target, 5.0, "the transcript does not scroll under the palette");
    world.palette = SlashPalette { open: true, count: 0 };
    mouse.route_wheel(&wheel(true, false), &mut world, 1_020);
    assert_eq!(world.slash_log.len(), 2, "an empty palette gives the wheel back to the transcript");
}

#[test]
fn an_overlay_that_owns_the_keys_blocks_the_transcript_scroll() {
    let (mut world, mut mouse) = wheel_world(5.0);
    world.overlay = OverlayOwner { picker: true, ..OverlayOwner::default() };
    mouse.route_wheel(&wheel(true, false), &mut world, 1_000);
    flush_scrolls(&mut world, &mut mouse);
    assert_eq!(world.scroll.target, 5.0);
}

