//! The Rust mouse and selection code against what the Node one does (tests/goldens/mouse.json, recorded by
//! tests/recorders/record-mouse.mjs): scripted mouse report sequences over a fake rendered frame and a fake clock, with the drag,
//! the rects handed to the renderer, the scroll target, the prompt engine calls, the palette steps, the zoom passthroughs, the
//! repaints, the copied text and the hints compared after every step; the port of `use-mouse-input.test.mjs`; and a selection
//! as a place in the content, against a fake frame and against the application's own frames.

use std::cell::{Cell, RefCell};
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::rc::Rc;
use std::sync::Arc;

use mixdog_js::js_trim_end;
use mixdog_term::frame::{Grid, Style};
use mixdog_term::selection::{CellSpan, SelectionMode, SelectionRect, read_selection};
use mixdog_term::{MouseKind, MouseReport};
use mixdog_tui::app::clock::Clock;
use mixdog_tui::app::store::AppStore;
use mixdog_tui::app::{AppOptions, AppState};
use mixdog_tui::handlers::host::GlobalKeyHost;
use mixdog_tui::mouse::follow::{DrawnItem, RowText};
use mixdog_tui::mouse::scroll::SelectionScroll;
use mixdog_tui::mouse::{
    FocusMove, HintTone, Mouse, MouseConfig, MouseHost, Point, PromptBoxRect, PromptSelection, Region, RenderStore, SelectionIo, SlashPalette, SpanKind,
};
use mixdog_tui::slash::commands::OverlayOwner;
use mixdog_tui::transcript::scroll::anchor::Geometry;
use mixdog_tui::transcript::scroll::coalesce::ScrollCoalescer;
use mixdog_tui::transcript::scroll::engine::{ScrollHost, TranscriptScroll};
use serde_json::{Map, Value, json};

const COLUMNS: usize = 40;
const VIEW_ROWS: usize = 10;
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

/// The fake screen at the scroll target now, and the rects the renderer was handed.
struct FakeStore {
    target: Rc<Cell<f64>>,
    repaints: usize,
    log: Vec<Value>,
}

impl FakeStore {
    fn new(target: Rc<Cell<f64>>) -> Self {
        Self { target, repaints: 0, log: Vec::new() }
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
        self.log.push(rect.map_or(Value::Null, rect_json));
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
        let mut tracked = Tracked { target: &self.target, selection: SelectionScroll { mouse, store: &mut self.store, inner: &mut inner, now_ms: self.now } };
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
    target: f64,
    /// The frame on screen, for the tests of a selection as a place in the content; how often it was asked anything, how
    /// many rows of content were read from it and how many items were rendered for their rows.
    frame: Option<Doc>,
    asked: Cell<usize>,
    reads: usize,
    renders: usize,
    clipboard: Vec<String>,
    hints: Vec<(String, HintTone)>,
}

/// A transcript item of a fake frame: its id, the rows of the whole item, and the first of them the frame rendered (above 0
/// for a streaming message rendered through the live window).
type Item = (&'static str, Vec<String>, usize);

/// A painted frame of the rig's 40 by 24 screen: the transcript items in order; which of them are mounted and the screen row
/// of the first rendered row of the first mounted one; the rows painted outside the transcript.
#[derive(Clone)]
struct Doc {
    session: &'static str,
    columns: usize,
    items: Vec<Item>,
    mounted: std::ops::Range<usize>,
    top: i32,
    chrome: Vec<(i32, &'static str)>,
    /// The items whose digits the clock drives: at a fixed time their rows read without them.
    clocked: Vec<&'static str>,
}

impl Doc {
    /// The mounted items with their index and the screen row of their first rendered row.
    fn placed(&self) -> Vec<(usize, i32)> {
        let mut top = self.top;
        self.mounted
            .clone()
            .map(|index| {
                let at = top;
                top += (self.items[index].1.len() - self.items[index].2) as i32;
                (index, at)
            })
            .collect()
    }

    /// The rows outside the transcript as the layout painted them.
    fn chrome_grid(&self) -> Grid {
        let mut grid = Grid::new(40, 24);
        for (y, text) in &self.chrome {
            for (x, glyph) in text.chars().enumerate() {
                grid.put_glyph(x as i32, *y, &glyph.to_string(), 1, Style::default(), 0);
            }
        }
        grid
    }
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
    fn force_render_repaint(&mut self) {}
    fn frame_session(&self) -> Option<&str> {
        self.asked.set(self.asked.get() + 1);
        self.frame.as_ref().map(|doc| doc.session)
    }
    fn frame_columns(&self) -> usize {
        self.asked.set(self.asked.get() + 1);
        self.frame.as_ref().map_or(0, |doc| doc.columns)
    }
    fn content_row_at(&mut self, y: i32) -> Option<(usize, usize)> {
        self.asked.set(self.asked.get() + 1);
        let doc = self.frame.as_ref()?;
        let rendered = |index: usize| (doc.items[index].1.len() - doc.items[index].2) as i32;
        let (index, top) = doc.placed().into_iter().find(|(index, top)| y >= *top && y < *top + rendered(*index))?;
        Some((index, doc.items[index].2 + (y - top) as usize))
    }
    fn item_id_at(&mut self, index: usize) -> Option<String> {
        self.asked.set(self.asked.get() + 1);
        self.frame.as_ref()?.items.get(index).map(|(id, _, _)| (*id).to_owned())
    }
    fn find_item(&mut self, item: &str, index: usize) -> Option<usize> {
        self.asked.set(self.asked.get() + 1);
        let doc = self.frame.as_ref()?;
        let known = doc.items.get(index).is_some_and(|(id, _, _)| *id == item);
        known.then_some(index).or_else(|| doc.items.iter().position(|(id, _, _)| *id == item))
    }
    fn drawn_items(&mut self) -> Option<(usize, usize)> {
        self.asked.set(self.asked.get() + 1);
        self.frame.as_ref().map(|doc| (doc.mounted.start, doc.mounted.len()))
    }
    fn drawn_item(&mut self, index: usize) -> Option<DrawnItem> {
        self.asked.set(self.asked.get() + 1);
        let doc = self.frame.as_ref()?;
        let (_, top) = doc.placed().into_iter().find(|(at, _)| *at == index)?;
        let (_, rows, first) = &doc.items[index];
        // The item was rendered anew when its rows or the window over them changed.
        let mut hasher = DefaultHasher::new();
        (rows, first).hash(&mut hasher);
        Some(DrawnItem { top: top - *first as i32, first: *first, rows: rows.len(), stamp: hasher.finish() as usize | 1 })
    }
    fn content_row_text(&mut self, index: usize, row: usize) -> Option<RowText> {
        self.asked.set(self.asked.get() + 1);
        self.reads += 1;
        let doc = self.frame.as_ref()?;
        let (_, rows, first) = &doc.items[index];
        (doc.mounted.contains(&index) && row >= *first).then(|| rows.get(row)).flatten().map(|text| RowText { text: text.clone(), soft_wrap: false })
    }
    fn item_rows_text(&mut self, index: usize, lo: usize, hi: usize) -> Option<Vec<RowText>> {
        self.asked.set(self.asked.get() + 1);
        let doc = self.frame.as_ref()?;
        let (_, rows, first) = doc.items.get(index)?;
        if !doc.mounted.contains(&index) || lo < *first {
            self.renders += 1;
        }
        let read: Vec<RowText> =
            rows.iter().skip(lo).take(hi.saturating_sub(lo).saturating_add(1)).map(|text| RowText { text: text.clone(), soft_wrap: false }).collect();
        self.reads += read.len();
        Some(read)
    }
    fn still_rows(&mut self, index: usize, lo: usize, hi: usize) -> Option<Vec<RowText>> {
        self.asked.set(self.asked.get() + 1);
        let doc = self.frame.as_ref()?;
        let (id, rows, _) = doc.items.get(index)?;
        let still = |text: &String| RowText { text: text.chars().filter(|glyph| !glyph.is_ascii_digit()).collect(), soft_wrap: false };
        doc.clocked.contains(id).then(|| rows.iter().skip(lo).take(hi.saturating_sub(lo).saturating_add(1)).map(still).collect())
    }
    fn frame_selection_text(&mut self, rect: &SelectionRect) -> Option<String> {
        self.asked.set(self.asked.get() + 1);
        read_selection(&self.frame.as_ref()?.chrome_grid(), &[], rect).text
    }
}

impl SelectionIo for Probe {
    fn scroll_target(&self) -> f64 {
        self.target
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
    fn write_clipboard(&mut self, text: &str) -> Result<(), String> {
        self.clipboard.push(text.to_owned());
        Ok(())
    }
    fn show_selection_copy_hint(&mut self, message: &str, tone: HintTone) {
        self.hints.push((message.to_owned(), tone));
    }
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
    let host = Probe {
        selections: Vec::new(),
        scrolls: Vec::new(),
        words: Vec::new(),
        lines: Vec::new(),
        prompt: Some(prompt),
        target: 5.0,
        frame: None,
        asked: Cell::new(0),
        reads: 0,
        renders: 0,
        clipboard: Vec::new(),
        hints: Vec::new(),
    };
    Rig { mouse, host, now: 10_000 }
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

// ── a released selection is a place in the content ───────────────────────────────────────────────────────────────────────

/// An item rendered whole: `count` rows reading `  <name> <n>`.
fn item(id: &'static str, name: &str, count: usize) -> Item {
    (id, (0..count).map(|n| format!("  {name} {n}")).collect(), 0)
}

/// The answer the selections are made in: forty rows, the thirty-sixth reading `row-70 here`.
fn answer() -> Item {
    let mut answer = item("a", "line", 40);
    answer.1[35] = "  row-70 here".to_owned();
    answer
}

/// A frame whose transcript viewport is the first ten rows of the screen.
fn doc(items: Vec<Item>, mounted: std::ops::Range<usize>, top: i32) -> Doc {
    Doc { session: "s1", columns: 40, items, mounted, top, chrome: Vec::new(), clocked: Vec::new() }
}

impl Rig {
    /// Paints `frame`: the mouse reads it before it takes its highlight.
    fn paint(&mut self, frame: Doc) {
        self.host.frame = Some(frame);
        self.mouse.selection_after_frame(&mut self.host, self.now);
    }

    /// A drag along row `y` from column `x1` to column `x2`, released there.
    fn select(&mut self, x1: i32, x2: i32, y: i32) {
        self.press(LEFT, x1, y);
        self.press(LEFT | MOTION, x2, y);
        self.release(LEFT, x2, y);
    }

    /// The transcript scrolled `rows` toward older rows, as the scroll engine tells the mouse.
    fn scrolled(&mut self, rows: f64) {
        self.host.target += rows;
        let target = self.host.target;
        self.mouse.selection_after_scroll(&mut self.host, rows, target, self.now);
    }

    /// The highlight the renderer holds.
    fn highlight(&self) -> Option<(i32, i32, i32, i32)> {
        self.host.selections.last().copied().flatten().map(|rect| (rect.x1, rect.y1, rect.x2, rect.y2))
    }

    /// What Ctrl+C puts on the clipboard.
    fn copied(&mut self) -> Option<String> {
        self.host.clipboard.clear();
        self.mouse.copy_selection(&mut self.host);
        self.host.clipboard.last().cloned()
    }
}

/// A rig that painted `frame`.
fn painted(frame: Doc) -> Rig {
    let mut rig = rig(None);
    rig.paint(frame);
    rig
}

/// A rig that painted `frame` and then selected columns `x1..=x2` of row `y`.
fn selected(frame: Doc, x1: i32, x2: i32, y: i32) -> Rig {
    let mut rig = painted(frame);
    rig.select(x1, x2, y);
    rig
}

/// `row-70` selected on screen row 5 of the followed tail of the answer.
fn selected_on_row_five() -> Rig {
    let mut rig = selected(doc(vec![answer()], 0..1, -30), 2, 7, 5);
    assert_eq!(rig.copied().as_deref(), Some("row-70"), "the text is read from the frame the selection was made on");
    rig
}

#[test]
fn a_released_selection_moves_with_its_text_when_rows_are_added_below_it_at_the_followed_tail() {
    let mut rig = selected_on_row_five();
    rig.paint(doc(vec![answer()], 0..1, -30));
    assert_eq!(rig.rect(), Some((2, 5, 7, 5)), "an unchanged frame leaves the selection");
    // Two rows appended to the answer while the view follows the tail: its rows are drawn two rows higher.
    let mut grown = answer();
    grown.1.extend(["  more 0".to_owned(), "  more 1".to_owned()]);
    rig.paint(doc(vec![grown], 0..1, -32));
    assert_eq!(rig.rect(), Some((2, 3, 7, 3)));
    assert_eq!(rig.highlight(), Some((2, 3, 7, 3)), "the highlight is on the row the copy reads");
    assert_eq!(rig.copied().as_deref(), Some("row-70"));
}

#[test]
fn a_released_selection_stays_on_its_text_when_rows_change_above_it() {
    let mut rig = selected_on_row_five();
    // Three rows inserted above while the view is pinned to the tail (older history loaded): the count of rows says the text
    // moved, the frame draws it where it was.
    rig.paint(doc(vec![item("older", "old", 3), answer()], 0..2, -33));
    assert_eq!(rig.rect(), Some((2, 5, 7, 5)));
    // A message above settled two rows shorter while the reader reads older rows: the answer is drawn two rows lower.
    rig.paint(doc(vec![item("older", "old", 1), answer()], 0..2, -29));
    assert_eq!(rig.rect(), Some((2, 7, 7, 7)));
    assert_eq!(rig.highlight(), Some((2, 7, 7, 7)));
}

#[test]
fn a_released_selection_follows_its_text_when_the_viewport_moves() {
    let mut rig = selected_on_row_five();
    rig.mouse.set_transcript_viewport(1.0, 10.0);
    rig.paint(doc(vec![answer()], 0..1, -29));
    assert_eq!(rig.rect(), Some((2, 6, 7, 6)));
    assert_eq!(rig.highlight(), Some((2, 6, 7, 6)));
}

#[test]
fn a_released_selection_is_cleared_when_its_place_is_gone_and_kept_with_its_text_when_its_rows_read_otherwise() {
    let mut rewrapped = answer();
    rewrapped.1[35] = "  row-".to_owned();
    rewrapped.1.insert(36, "  70 here".to_owned());
    let mut shorter = answer();
    shorter.1.truncate(30);
    let gone: [(&str, Doc); 4] = [
        ("another session", Doc { session: "s2", ..doc(vec![answer()], 0..1, -30) }),
        ("its item removed by a compaction", doc(vec![item("summary", "line", 40)], 0..1, -30)),
        ("its item no longer has that row", doc(vec![shorter], 0..1, -20)),
        ("a width that wraps its rows anew", Doc { columns: 30, ..doc(vec![rewrapped], 0..1, -31) }),
    ];
    for (case, frame) in gone {
        let mut rig = selected_on_row_five();
        rig.paint(frame);
        assert_eq!(rig.rect(), None, "{case}");
        assert_eq!(rig.host.selections.last(), Some(&None), "{case}: the highlight is cleared with it");
        assert_eq!(rig.copied(), None, "{case}: nothing is left to copy");
    }

    let mut changed = answer();
    changed.1[35] = "  other here".to_owned();
    let kept: [(&str, Doc, Option<(i32, i32, i32, i32)>); 2] = [
        ("its own row reads other text", doc(vec![changed], 0..1, -30), None),
        ("another width that leaves its rows as they were", Doc { columns: 50, ..doc(vec![answer()], 0..1, -30) }, Some((2, 5, 7, 5))),
    ];
    for (case, frame, highlight) in kept {
        let mut rig = selected_on_row_five();
        rig.paint(frame);
        assert_eq!(rig.rect(), Some((2, 5, 7, 5)), "{case}: the selection keeps its place");
        assert_eq!(rig.highlight(), highlight, "{case}: the highlight is on its row only while the row reads what was selected");
        assert_eq!(rig.copied().as_deref(), Some("row-70"), "{case}: the copy is what was selected");
    }
}

#[test]
fn a_re_flow_above_the_selection_inside_its_item_leaves_the_copy_as_selected_and_no_highlight_on_other_text() {
    let mut rig = selected_on_row_five();
    // A row came in above the selection inside the answer (a code fence closed): `row-70` is one row further down, and the
    // row it was on reads `  line 34`.
    let mut reflowed = answer();
    reflowed.1.insert(10, "  fence".to_owned());
    for _ in 0..2 {
        rig.paint(doc(vec![reflowed.clone()], 0..1, -31));
        assert!(rig.mouse.grid_selection_active(), "the selection stays");
        assert_eq!(rig.host.selections.last(), Some(&None), "its place reads other text: nothing is highlighted");
        assert_eq!(rig.copied().as_deref(), Some("row-70"), "Ctrl+C copies what was selected");
    }
    // The rows read what was selected again: the highlight is back on them.
    rig.paint(doc(vec![answer()], 0..1, -30));
    assert_eq!(rig.highlight(), Some((2, 5, 7, 5)));
    assert_eq!(rig.copied().as_deref(), Some("row-70"));
}

#[test]
fn a_selection_over_a_cell_the_clock_drives_keeps_its_highlight_and_copies_the_text_at_the_release() {
    // A running card's elapsed time inside the selection.
    let frame = |row: String| {
        let mut card = answer();
        card.1[35] = row;
        Doc { clocked: vec!["a"], ..doc(vec![card], 0..1, -30) }
    };
    let mut rig = selected(frame("  elapsed 0s".to_owned()), 2, 11, 5);
    for seconds in 1..=5 {
        rig.paint(frame(format!("  elapsed {seconds}s")));
        assert_eq!(rig.rect(), Some((2, 5, 11, 5)));
        assert_eq!(rig.highlight(), Some((2, 5, 11, 5)), "the cell changed in place: the highlight stays");
        assert_eq!(rig.copied().as_deref(), Some("elapsed 0s"), "the copy is the text at the release");
    }
    // The card's row reads something else than its clock: the selection stays without a highlight.
    rig.paint(frame("  finished 5s".to_owned()));
    assert_eq!(rig.rect(), Some((2, 5, 11, 5)));
    assert_eq!(rig.host.selections.last(), Some(&None));
    assert_eq!(rig.copied().as_deref(), Some("elapsed 0s"));
}

#[test]
fn an_extend_across_items_that_were_never_mounted_copies_their_text_whole() {
    let items = || vec![item("i0", "i0", 10), item("i1", "i1", 10), item("i2", "i2", 10), item("i3", "i3", 10)];
    // `i0 4` selected on the first item, the only one mounted, thirty rows above where the transcript is scrolled to next.
    let mut rig = painted(doc(items(), 0..1, 0));
    rig.host.target = 35.0;
    rig.select(2, 5, 4);
    assert_eq!(rig.copied().as_deref(), Some("i0 4"));
    // Scrolled thirty rows toward the tail: the frame mounts the last item only.
    rig.scrolled(-30.0);
    rig.paint(doc(items(), 3..4, 0));
    assert_eq!(rig.host.selections.last(), Some(&None));
    assert_eq!(rig.copied().as_deref(), Some("i0 4"));
    // A right press on row 6 of the last item extends the selection to it: the rows of the two items between, which no
    // frame ever mounted, and of the first, which this frame does not, are rendered for their text.
    rig.now += 1000;
    rig.host.renders = 0;
    rig.press(RIGHT, 5, 6);
    let mut lines = vec!["i0 4".to_owned()];
    lines.extend((5..10).map(|n| format!("  i0 {n}")));
    lines.extend((0..10).map(|n| format!("  i1 {n}")));
    lines.extend((0..10).map(|n| format!("  i2 {n}")));
    lines.extend((0..7).map(|n| format!("  i3 {n}")));
    assert_eq!(rig.copied(), Some(lines.join("\n")));
    assert_eq!(rig.host.renders, 3, "one rendering per item the frame does not show");
    // The frames after it read nothing more of the items they do not render, and the copy stays.
    rig.paint(doc(items(), 3..4, 0));
    assert_eq!(rig.highlight().map(|(_, _, x2, y2)| (x2, y2)), Some((5, 6)), "the part on screen is highlighted");
    assert_eq!(rig.host.renders, 3);
    assert_eq!(rig.copied(), Some(lines.join("\n")));
}

#[test]
fn a_shift_arrow_move_takes_the_text_of_the_selection_it_leaves() {
    let mut rig = selected_on_row_five();
    assert!(rig.mouse.move_selection_focus(&mut rig.host, FocusMove::Left, rig.now));
    assert_eq!(rig.rect(), Some((2, 5, 6, 5)));
    assert_eq!(rig.copied().as_deref(), Some("row-7"));
}

#[test]
fn a_selection_whose_item_is_loaded_but_not_mounted_is_kept_off_screen_with_no_highlight_and_copied_whole() {
    let mut rig = selected_on_row_five();
    // The view moved to a later item: the answer is loaded and not rendered, and its screen rows show the later item.
    rig.paint(doc(vec![answer(), item("later", "later", 40)], 1..2, -30));
    assert!(rig.mouse.grid_selection_active(), "the selection is kept");
    assert_eq!(rig.host.selections.last(), Some(&None), "no row shows its text: nothing is highlighted");
    assert_eq!(rig.copied().as_deref(), Some("row-70"), "Ctrl+C copies what was selected");
    // Back in view, it is highlighted where the answer's row is drawn.
    rig.paint(doc(vec![answer(), item("later", "later", 40)], 0..2, -32));
    assert_eq!(rig.rect(), Some((2, 3, 7, 3)));
    assert_eq!(rig.highlight(), Some((2, 3, 7, 3)));
}

#[test]
fn a_scroll_in_the_same_read_as_the_release_does_not_displace_the_selection() {
    // The release and a wheel step arrive in one read: the scroll is handled before any frame is painted.
    let mut rig = selected_on_row_five();
    rig.scrolled(3.0);
    assert_eq!(rig.rect(), Some((2, 8, 7, 8)), "the scroll shifts the rect by its rows");
    // The frame after it: the view is three rows up and the answer grew two rows meanwhile, so `row-70` is drawn on row 6.
    let mut grown = answer();
    grown.1.extend(["  more 0".to_owned(), "  more 1".to_owned()]);
    rig.paint(doc(vec![grown], 0..1, -29));
    assert_eq!(rig.rect(), Some((2, 6, 7, 6)));
    assert_eq!(rig.highlight(), Some((2, 6, 7, 6)));
    assert_eq!(rig.copied().as_deref(), Some("row-70"));

    // The wheel step first and the whole drag after it, in one read: the rect counts its rows as the next frame draws them,
    // three rows from the frame on screen, and its ends are the content that frame has there (`  line 32` on its row 2).
    let mut late = painted(doc(vec![answer()], 0..1, -30));
    late.scrolled(3.0);
    late.select(2, 7, 5);
    assert_eq!(late.copied().as_deref(), Some("line 3"));
    late.paint(doc(vec![answer()], 0..1, -27));
    assert_eq!(late.rect(), Some((2, 5, 7, 5)));
    assert_eq!(late.highlight(), Some((2, 5, 7, 5)));
    assert_eq!(late.copied().as_deref(), Some("line 3"));
}

#[test]
fn an_unmounted_item_is_not_placed_by_the_rows_the_layout_shifted() {
    let mut rig = selected_on_row_five();
    // Four rows scrolled, which shifts the rect to row 9; the frame that follows no longer renders the answer and draws a
    // later item on that row.
    rig.scrolled(4.0);
    rig.paint(doc(vec![answer(), item("later", "later", 60)], 1..2, -20));
    assert_eq!(rig.host.selections.last(), Some(&None), "the row the shift names shows other text: it is not highlighted");
    assert!(rig.mouse.grid_selection_active());
    assert_eq!(rig.copied().as_deref(), Some("row-70"), "the copy is the selected text, as the missing highlight says");
    // Rendered again, the selection is where the answer's row is, whatever the rect was shifted to meanwhile.
    rig.scrolled(-2.0);
    rig.paint(doc(vec![answer(), item("later", "later", 60)], 0..2, -33));
    assert_eq!(rig.rect(), Some((2, 2, 7, 2)));
    assert_eq!(rig.highlight(), Some((2, 2, 7, 2)));
    assert_eq!(rig.copied().as_deref(), Some("row-70"));
}

#[test]
fn a_selection_on_one_of_two_equal_lines_stays_on_its_own_when_rows_are_added_above_the_pinned_view() {
    let mut twins = item("a", "line", 40);
    twins.1[33] = "  same line".to_owned();
    twins.1[35] = "  same line".to_owned();
    let mut rig = selected(doc(vec![twins.clone()], 0..1, -30), 2, 10, 5);
    assert_eq!(rig.copied().as_deref(), Some("same line"));
    // Two rows added above while the view is pinned to the tail: the total says the text moved two rows up, where the other
    // `same line` is drawn; the selected one is drawn where it was.
    rig.paint(doc(vec![item("older", "old", 2), twins.clone()], 0..2, -32));
    assert_eq!(rig.rect(), Some((2, 5, 10, 5)));
    assert_eq!(rig.highlight(), Some((2, 5, 10, 5)));
    // And it moves when its own line does, onto the row the other one was on.
    rig.paint(doc(vec![item("older", "old", 2), twins, item("next", "next", 2)], 0..3, -34));
    assert_eq!(rig.rect(), Some((2, 3, 10, 3)));
    assert_eq!(rig.highlight(), Some((2, 3, 10, 3)));
}

#[test]
fn a_selection_of_a_blank_line_stays_on_its_own_row() {
    let mut gaps = item("a", "line", 40);
    for row in [31, 34, 36] {
        gaps.1[row] = String::new();
    }
    // The blank row 34 of the answer, on screen row 4; rows 1 and 6 are blank too.
    let mut rig = selected(doc(vec![gaps.clone()], 0..1, -30), 0, 12, 4);
    rig.paint(doc(vec![item("older", "old", 3), gaps.clone()], 0..2, -33));
    assert_eq!(rig.rect(), Some((0, 4, 12, 4)), "rows added above the pinned view leave it on its row");
    assert_eq!(rig.highlight(), Some((0, 4, 12, 4)));
    rig.paint(doc(vec![item("older", "old", 3), gaps, item("next", "next", 2)], 0..3, -35));
    assert_eq!(rig.rect(), Some((0, 2, 12, 2)), "it follows its own row, not the nearest blank one");
    assert_eq!(rig.highlight(), Some((0, 2, 12, 2)));
}

#[test]
fn a_frame_without_a_released_selection_asks_the_frame_nothing_and_one_with_it_reads_its_rows_of_an_item_rendered_anew_only() {
    let frame = || doc(vec![answer(), item("later", "later", 40)], 0..2, -30);
    let mut rig = rig(None);
    for _ in 0..3 {
        rig.paint(frame());
    }
    assert_eq!(rig.host.asked.get(), 0, "no selection: no record is built and the frame is not asked anything");
    // A drag in progress follows its pointer: the frame that paints it is not asked either.
    rig.press(LEFT, 2, 5);
    rig.press(LEFT | MOTION, 7, 5);
    rig.host.asked.set(0);
    rig.paint(frame());
    assert_eq!(rig.host.asked.get(), 0);
    // The release reads its one row, from the frame on screen.
    rig.release(LEFT, 7, 5);
    assert_eq!((rig.host.reads, rig.host.renders), (1, 0));
    // The frame after it tells that the row reads what was selected; a frame that rendered the item as it was reads no row.
    rig.paint(frame());
    assert_eq!(rig.host.reads, 2);
    rig.paint(frame());
    assert_eq!(rig.host.reads, 2);
    // The item rendered anew, two of its forty rows changed, one of them selected: that row is read, no other, and the copy
    // is not read again.
    let mut anew = answer();
    anew.1[20] = "  changed above".to_owned();
    anew.1[35] = "  row-71 here".to_owned();
    rig.paint(doc(vec![anew, item("later", "later", 40)], 0..2, -30));
    assert_eq!((rig.host.reads, rig.host.renders), (3, 0));
    assert_eq!(rig.copied().as_deref(), Some("row-70"));
    // Cleared, the frames cost nothing again.
    rig.press(LEFT, 2, 12);
    rig.host.asked.set(0);
    rig.paint(frame());
    assert_eq!((rig.rect(), rig.host.asked.get()), (None, 0));
}

#[test]
fn a_selection_in_the_streaming_message_keeps_its_row_of_the_whole_message_while_the_live_window_moves_and_after_it_settles() {
    // The live window renders the last ten rows of the message: `first` rows of it lie before the window.
    let stream = |rows: usize, first: usize| -> Item {
        let mut stream = item("t", "word", rows);
        stream.2 = first;
        stream
    };
    let mut rig = selected(doc(vec![stream(30, 20)], 0..1, 0), 2, 8, 6);
    assert_eq!(rig.copied().as_deref(), Some("word 26"));
    // Two rows streamed in: the window starts two rows later and row 26 is drawn two rows higher.
    rig.paint(doc(vec![stream(32, 22)], 0..1, 0));
    assert_eq!(rig.highlight(), Some((2, 4, 8, 4)));
    assert_eq!(rig.copied().as_deref(), Some("word 26"));
    // The window moved past the row: it is off screen above, with no row of the screen highlighted, and still copied.
    rig.paint(doc(vec![stream(60, 50)], 0..1, 0));
    assert_eq!(rig.rect(), Some((2, -24, 8, -24)));
    assert_eq!(rig.copied().as_deref(), Some("word 26"));
    // The message settled under its id and is rendered whole; the turn's last line went under it.
    rig.paint(doc(vec![stream(60, 0), item("done", "done", 1)], 0..2, -51));
    assert_eq!(rig.rect(), Some((2, -25, 8, -25)));
    assert_eq!(rig.copied().as_deref(), Some("word 26"));
    // Read back to, it is highlighted on its row.
    rig.paint(doc(vec![stream(60, 0), item("done", "done", 1)], 0..2, -22));
    assert_eq!(rig.highlight(), Some((2, 4, 8, 4)));
    assert_eq!(rig.copied().as_deref(), Some("word 26"));
}

#[test]
fn a_statusline_selection_keeps_its_cells_of_the_band_and_copies_what_they_showed_at_the_release() {
    let status = |text: &'static str| Doc { chrome: vec![(22, text), (23, "branch main")], ..doc(vec![answer()], 0..1, -30) };
    let mut rig = selected(status("model gpt-x ctx 12%"), 0, 4, 22);
    assert_eq!(rig.mouse.drag.region, Some(Region::Status));
    assert_eq!(rig.copied().as_deref(), Some("model"));
    // The band's cells changed under the selection and the transcript moved: the selection stays on its cells, and its
    // text is what they showed.
    rig.paint(Doc { top: -35, ..status("ready gpt-x ctx 40%") });
    assert_eq!(rig.rect(), Some((0, 22, 4, 22)));
    assert_eq!(rig.highlight(), Some((0, 22, 4, 22)));
    assert_eq!(rig.copied().as_deref(), Some("model"));
}

#[test]
fn a_drag_that_scrolled_past_the_mounted_items_copies_every_row_between_its_ends() {
    let items = || vec![item("i0", "i0", 10), item("i1", "i1", 10), item("i2", "i2", 10), item("i3", "i3", 10)];
    // The drag starts on row 8 of the last item and is held up to its row 1.
    let mut rig = painted(doc(items(), 3..4, 0));
    rig.press(LEFT, 9, 8);
    rig.press(LEFT | MOTION, 6, 1);
    // A wheel jump of twenty rows while it is held: the frame now mounts the second item only, and the drag is released on
    // its row 1.
    rig.scrolled(20.0);
    rig.paint(doc(items(), 1..2, 0));
    rig.release(LEFT, 2, 1);
    // The second item's rows from the frame, the third item's, which no frame showed, and the last item's up to the row of
    // the press, rendered for their text.
    let mut lines = vec!["i1 1".to_owned()];
    lines.extend((2..10).map(|n| format!("  i1 {n}")));
    lines.extend((0..10).map(|n| format!("  i2 {n}")));
    lines.extend((0..9).map(|n| format!("  i3 {n}")));
    assert_eq!(rig.copied(), Some(lines.join("\n")));
    assert_eq!(rig.host.renders, 2);
}

#[test]
fn copy_reports_one_char_without_a_plural_and_nothing_to_copy_without_a_selection() {
    let mut one = answer();
    one.1[35] = "x".to_owned();
    let mut rig = selected(doc(vec![one], 0..1, -30), 0, 1, 5);
    rig.mouse.copy_selection(&mut rig.host);
    assert_eq!(rig.host.hints, vec![("copied 1 char".to_owned(), HintTone::Plain)]);
    assert_eq!(rig.host.clipboard, vec!["x".to_owned()]);

    let mut none = painted(doc(vec![answer()], 0..1, -30));
    none.mouse.copy_selection(&mut none.host);
    assert_eq!(none.host.hints, vec![("nothing to copy \u{b7} select text first".to_owned(), HintTone::Error)]);
    assert!(none.host.clipboard.is_empty());
    assert_eq!(none.mouse.next_deadline(), None, "one reading: nothing is tried again later");
}

// ── the same through the application's own frames ────────────────────────────────────────────────────────────────────────

/// A store whose published state the test replaces.
struct LiveStore(Rc<RefCell<Arc<Value>>>);

impl AppStore for LiveStore {
    fn call(&mut self, _action: &str, _args: &[Value]) -> Result<Value, String> {
        Ok(Value::Null)
    }
    fn has_method(&self, _name: &str) -> bool {
        true
    }
    fn state(&self) -> Arc<Value> {
        Arc::clone(&self.0.borrow())
    }
    fn tick(&mut self) -> bool {
        false
    }
    fn push_notice(&mut self, _text: &str, _level: &str) {}
    fn submit(&mut self, _prompt: &Value, _options: &Value) -> Result<bool, String> {
        Ok(true)
    }
    fn abort(&mut self, _options: &Value) -> Result<Value, String> {
        Ok(Value::Null)
    }
    fn restore_queued(&mut self, _current_text: &str) -> Result<Value, String> {
        Ok(Value::Null)
    }
    fn resolve_tool_approval(&mut self, _id: &str, _decision: &Value) -> Result<bool, String> {
        Ok(true)
    }
    fn onboarding_completed(&mut self) -> bool {
        true
    }
    fn dispose(&mut self, _reason: &str) -> bool {
        true
    }
}

/// The application over a state the test publishes, painted for a terminal of 80 by 30, with the last frame it painted.
struct Screen {
    app: AppState,
    state: Rc<RefCell<Arc<Value>>>,
    grid: Grid,
}

fn screen(state: Value) -> Screen {
    let state = Rc::new(RefCell::new(Arc::new(state)));
    let options = AppOptions { cwd: "C:/work".to_owned(), version: "1.2.3".to_owned(), force_onboarding: false, onboarding_completed: Some(true) };
    let mut app = AppState::new(Box::new(LiveStore(Rc::clone(&state))), Clock::new(1_000), options);
    app.mount();
    while app.run_background() {}
    app.chrome.tick_after_mount();
    let (grid, _) = app.render_frame(80, 30);
    Screen { app, state, grid }
}

impl Screen {
    fn frame(&mut self) {
        self.grid = self.app.render_frame(80, 30).0;
    }

    fn publish(&mut self, state: Value) {
        *self.state.borrow_mut() = Arc::new(state);
        self.frame();
    }

    fn text(&self) -> String {
        (0..self.grid.height).map(|y| self.grid.row_text(y)).collect::<Vec<_>>().join("\n")
    }

    /// The column and row where `needle` starts on the screen.
    fn find(&self, needle: &str) -> Option<(i32, i32)> {
        (0..self.grid.height).find_map(|y| {
            let row = self.grid.row_text(y);
            row.find(needle).map(|at| (row[..at].chars().count() as i32, i32::from(y)))
        })
    }

    fn mouse(&mut self, kind: MouseKind, button: i32, x: i32, y: i32) {
        self.app.on_mouse(&MouseReport { kind, button, col: x, row: y, shift: false, alt: false, ctrl: false });
    }

    /// A drag along row `y` from column `x1` to column `x2`, released there, and the frame after it.
    fn drag(&mut self, x1: i32, x2: i32, y: i32) {
        self.mouse(MouseKind::Press, LEFT, x1, y);
        self.mouse(MouseKind::Drag, LEFT | MOTION, x2, y);
        self.mouse(MouseKind::Release, LEFT, x2, y);
        self.frame();
    }

    /// Whether the cell carries the highlight: its background is not that of the row's last cell, which the frame never paints.
    fn highlighted(&self, x: i32, y: i32) -> bool {
        let background = |x: i32| self.grid.cell(x as u16, y as u16).map(|cell| cell.style.bg);
        background(x) != background(79)
    }

    /// The rows showing `needle` that are highlighted in column `x`.
    fn highlighted_rows(&self, needle: &str, x: i32) -> Vec<i32> {
        (0..self.grid.height).filter(|y| self.grid.row_text(*y).contains(needle)).map(i32::from).filter(|y| self.highlighted(x, *y)).collect()
    }

    fn selected_text(&mut self) -> Option<String> {
        self.app.selected_text()
    }
}

#[test]
fn a_selection_in_a_streaming_answer_stays_on_its_row_while_the_live_window_moves_and_after_the_message_settles() {
    // Nothing in the text is markdown to the renderer's probe (no hyphen, no blank line): only such a text is windowed.
    let text = |upto: usize| (1..=upto).map(|n| format!("row {n:03} of the streaming answer\n")).collect::<String>();
    let user = json!({ "id": "u1", "kind": "user", "text": "stream the rows" });
    let streaming = |upto: usize| {
        json!({
            "sessionId": "s1",
            "cwd": "C:/work",
            "items": [user.clone()],
            "streamingTail": { "id": "m1", "kind": "assistant", "streaming": true, "text": text(upto) },
        })
    };
    // A plain answer far longer than the screen, followed at its tail: the frame renders its last rows through the live window.
    let mut screen = screen(streaming(120));
    let first = screen.app.shown_live_window().map(|live| live.first);
    assert!(first.is_some_and(|first| first > 0), "the frame renders the answer through the live window: {first:?}\n{}", screen.text());
    let (x, y) = screen.find("row 117").unwrap_or_else(|| panic!("row 117 on the followed tail\n{}", screen.text()));
    screen.drag(x, x + 6, y);
    assert_eq!(screen.highlighted_rows("row ", x), vec![y], "{}", screen.text());
    assert_eq!(screen.selected_text().as_deref(), Some("row 117"));

    // Three lines streamed in: the window starts three rows later and the selected row is drawn three rows higher.
    screen.publish(streaming(123));
    assert_eq!(screen.app.shown_live_window().map(|live| live.first), first.map(|first| first + 3), "the window moved\n{}", screen.text());
    assert_eq!(screen.find("row 117"), Some((x, y - 3)), "{}", screen.text());
    assert_eq!(screen.highlighted_rows("row ", x), vec![y - 3], "{}", screen.text());
    assert_eq!(screen.selected_text().as_deref(), Some("row 117"));

    // The answer went on past it: the row is off screen, no row is highlighted and the copy is what was selected.
    screen.publish(streaming(200));
    assert_eq!(screen.find("row 117"), None, "{}", screen.text());
    assert_eq!(screen.highlighted_rows("row ", x), Vec::<i32>::new(), "{}", screen.text());
    assert_eq!(screen.selected_text().as_deref(), Some("row 117"));

    // The message settled under its id.
    screen.publish(json!({
        "sessionId": "s1",
        "cwd": "C:/work",
        "items": [user.clone(), { "id": "m1", "kind": "assistant", "text": text(200) }],
    }));
    assert_eq!(screen.highlighted_rows("row ", x), Vec::<i32>::new(), "{}", screen.text());
    assert_eq!(screen.selected_text().as_deref(), Some("row 117"));

    // Read back to, the row is highlighted where the settled message draws it, and no other.
    GlobalKeyHost::scroll_transcript_rows(&mut screen.app, 78);
    screen.frame();
    let (_, at) = screen.find("row 117").unwrap_or_else(|| panic!("row 117 after the scroll\n{}", screen.text()));
    assert_eq!(screen.highlighted_rows("row ", x), vec![at], "{}", screen.text());
    assert_eq!(screen.selected_text().as_deref(), Some("row 117"));
}

#[test]
fn a_re_flow_above_the_selection_in_a_settled_answer_leaves_the_copy_and_highlights_no_other_text() {
    let answer = |text: &str| {
        json!({
            "sessionId": "s1",
            "cwd": "C:/work",
            "items": [
                { "id": "u1", "kind": "user", "text": "answer me" },
                { "id": "m1", "kind": "assistant", "text": text },
            ],
        })
    };
    let mut screen = screen(answer("alpha words\nbeta words\ngamma words"));
    let (x, y) = screen.find("gamma words").unwrap_or_else(|| panic!("the answer's last row\n{}", screen.text()));
    screen.drag(x, x + 10, y);
    assert_eq!(screen.highlighted_rows("words", x), vec![y], "{}", screen.text());
    assert_eq!(screen.selected_text().as_deref(), Some("gamma words"));

    // The answer is rendered with one more row above the selected one: its place reads `beta words` now.
    screen.publish(answer("alpha words\nextra words\nbeta words\ngamma words"));
    assert!(screen.find("gamma words").is_some(), "{}", screen.text());
    assert_eq!(screen.highlighted_rows("words", x), Vec::<i32>::new(), "no row is highlighted\n{}", screen.text());
    assert_eq!(screen.selected_text().as_deref(), Some("gamma words"), "the copy is what was selected");
}

#[test]
fn a_selection_on_the_last_items_row_under_the_hint_of_the_prompt_is_kept_and_copies_the_content_not_the_hint() {
    let mut screen = screen(json!({
        "sessionId": "s1",
        "cwd": "C:/work",
        "items": [
            { "id": "u1", "kind": "user", "text": "answer me" },
            { "id": "m1", "kind": "assistant", "text": "first line of the answer\n\nlast line of the answer" },
        ],
    }));
    let (x, y) = screen.find("last line of the answer").unwrap_or_else(|| panic!("the answer's last row\n{}", screen.text()));
    // The whole row from the text's first cell to the last column, where the hint goes.
    screen.drag(x, 78, y);
    assert!(screen.highlighted(x, y), "{}", screen.text());
    assert_eq!(screen.selected_text().as_deref(), Some("last line of the answer"));

    // The copy hint is painted over the last row of the last item.
    MouseHost::show_selection_copy_hint(&mut screen.app, "copied 23 chars", HintTone::Plain);
    screen.frame();
    let row = screen.grid.row_text(y as u16);
    assert!(row.contains("last line of the answer") && row.contains("copied 23 chars"), "the hint is on the selected row\n{}", screen.text());
    assert!(screen.highlighted(x, y), "{}", screen.text());
    assert_eq!(screen.selected_text().as_deref(), Some("last line of the answer"));
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
