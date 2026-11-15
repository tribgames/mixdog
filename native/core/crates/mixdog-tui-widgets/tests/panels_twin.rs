//! The floating panels against what the Node components draw (tests/goldens/panels.json, recorded by
//! tests/recorders/record-ink-frames.mjs from tests/cases/panels.json, which tests/recorders/gen-panels-cases.mjs writes):
//! every frame is compared cell by cell (glyph, width, style and link) through the VT test grid reader, the keys of a case
//! are replayed on the Rust state of the panel and the frame after each key is compared, the calls a key makes are compared
//! with what Node's handlers received, and a subset of the frames is compared again through the frame writer at the chalk
//! colour levels 1 and 2.
//!
//! The recording was made with the ambiguous-width policy on, so the frames are only comparable when this process has it on
//! too (Windows, or `MIXDOG_TUI_AMBIGUOUS_WIDE=1`); with it off the test says so and stops.
//!
//! Node's handlers are the recorder's spies, which return nothing: an `onInspect` therefore settles as "Preview
//! unavailable." and the replay settles every fetch the same way.

use mixdog_term::frame::{Color, FrameWriter, Grid, Style};
use mixdog_term::input::decode_key;
use mixdog_term::paint::Painter;
use mixdog_term::testing::{VtGrid, grid_from_ink_frame_with};
use mixdog_tui_widgets::panels::btw_panel::{BtwPanelProps, BtwPanelState, paint_btw_panel};
use mixdog_tui_widgets::panels::context_inspector::{InspectOutcome, InspectorEffect};
use mixdog_tui_widgets::panels::context_panel::{ContextPanelProps, ContextPanelState, paint_context_panel};
use mixdog_tui_widgets::panels::usage_panel::{UsagePanelProps, UsagePanelState, paint_usage_panel};
use serde_json::{Value, json};

const GOLDEN: &str = include_str!("goldens/panels.json");
const CASES: &str = include_str!("cases/panels.json");
/// A grid taller than any panel of the corpus: the rows after a panel must stay untouched.
const TALL: u16 = 80;

/// The recording (its format and width policy) and every case of the corpus with what Node recorded for it merged in.
fn corpus() -> (Value, Vec<Value>) {
    let golden: Value = serde_json::from_str(GOLDEN).expect("the golden parses");
    let cases: Vec<Value> = serde_json::from_str(CASES).expect("the cases parse");
    let merged = cases
        .into_iter()
        .map(|mut case| {
            let recorded = golden["cases"].as_array().unwrap().iter().find(|entry| entry["id"] == case["id"]).expect("a recording of every case");
            for key in ["frames", "calls", "levels"] {
                if let Some(value) = recorded.get(key) {
                    case[key] = value.clone();
                }
            }
            case
        })
        .collect();
    (golden, merged)
}

fn plain_style(style: Style) -> Style {
    let plain = |color: Color| match color {
        Color::Literal(rgb) => Color::Rgb(rgb),
        other => other,
    };
    Style { fg: plain(style.fg), bg: plain(style.bg), ..style }
}

/// Every cell of the first `rows` rows is the same glyph in the same style under the same link (a continuation cell only
/// has to be one: Ink writes no bytes for it, so its style cannot be read back from a frame).
fn assert_same_grid(actual: &Grid, expected: &Grid, context: &str) {
    assert_eq!(actual.width, expected.width, "{context}: width");
    for y in 0..expected.height {
        for x in 0..expected.width {
            let (a, e) = (actual.cell(x, y).unwrap(), expected.cell(x, y).unwrap());
            if a.is_continuation() || e.is_continuation() {
                assert_eq!(a.is_continuation(), e.is_continuation(), "{context}: continuation at ({x}, {y})\n{}\n{}", actual.row_text(y), expected.row_text(y));
                continue;
            }
            assert_eq!((a.text(), a.width), (e.text(), e.width), "{context}: glyph at ({x}, {y})\nrust: {}\nnode: {}", actual.row_text(y), expected.row_text(y));
            assert_eq!(plain_style(a.style), plain_style(e.style), "{context}: style at ({x}, {y}) of {:?}", e.text());
            assert_eq!(actual.link_url(a.link), expected.link_url(e.link), "{context}: link at ({x}, {y})");
        }
    }
    for y in expected.height..actual.height {
        assert!((0..actual.width).all(|x| actual.cell(x, y).unwrap().is_plain_blank()), "{context}: row {y} below the panel is not blank");
    }
}

fn flag(value: &Value, key: &str) -> bool {
    value.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn uint(value: &Value, key: &str) -> Option<usize> {
    value.get(key).and_then(Value::as_u64).map(|n| n as usize)
}

/// One frame to compare: the Rust grid painted for `rows`, and what it took.
type Render<'a> = dyn Fn(&mut Painter) -> u16 + 'a;

fn rust_grid(columns: u16, render: &Render<'_>) -> Grid {
    let mut tall = Grid::new(columns, TALL);
    let rows = render(&mut Painter::new(&mut tall));
    let mut grid = Grid::new(columns, rows);
    render(&mut Painter::new(&mut grid));
    grid
}

fn compare_frame(golden: &Value, case: &Value, index: usize, render: &Render<'_>, context: &str) -> Grid {
    let columns = case["columns"].as_u64().unwrap() as u16;
    let wide = golden["ambiguousWide"].as_bool().unwrap();
    let expected = grid_from_ink_frame_with(case["frames"][index].as_str().unwrap(), columns, wide);
    let mut tall = Grid::new(columns, TALL);
    let rows = render(&mut Painter::new(&mut tall));
    assert_eq!(rows, expected.height, "{context}: rows\nnode:\n{}", (0..expected.height).map(|y| expected.row_text(y)).collect::<Vec<_>>().join("\n"));
    assert_same_grid(&tall, &expected, context);
    rust_grid(columns, render)
}

/// A frame compared again through the frame writer at chalk's levels 1 and 2.
fn compare_levels(golden: &Value, case: &Value, index: usize, grid: &Grid, context: &str) {
    let Some(levels) = case.get("levels") else { return };
    let wide = golden["ambiguousWide"].as_bool().unwrap();
    for (level, key) in [(1, "1"), (2, "2")] {
        let expected = grid_from_ink_frame_with(levels[key][index].as_str().unwrap(), grid.width, wide);
        let mut writer = FrameWriter::new(Vec::new(), level);
        writer.write_frame(grid, None).unwrap();
        let mut screen = VtGrid::new(grid.width, grid.height);
        screen.feed(writer.get_ref());
        assert_same_grid(screen.grid(), &expected, &format!("{context} at colour level {level}"));
    }
}

/// The calls Node's handlers received, as the `[name, ...arguments]` lists the recorder keeps.
fn node_calls(case: &Value) -> Vec<Value> {
    case["calls"].as_array().cloned().unwrap_or_default()
}

fn key_sequence<'a>(case: &'a Value, index: usize) -> Option<&'a str> {
    case.get("keys").and_then(|keys| keys.get(index)).and_then(Value::as_str)
}

fn context_case(golden: &Value, case: &Value, id: &str) {
    let props = &case["props"];
    let rows: Vec<Value> = props.get("rows").and_then(Value::as_array).cloned().unwrap_or_default();
    let mut panel = ContextPanelProps::new(&rows);
    panel.columns = uint(props, "columns").unwrap();
    if let Some(title) = props.get("title").and_then(Value::as_str) {
        panel.title = title.to_owned();
    }
    panel.description = props.get("description").and_then(Value::as_str).unwrap_or("").to_owned();
    panel.detail = props.get("detail").filter(|detail| !detail.is_null());
    panel.panel_rows = uint(props, "panelRows").unwrap_or(0);
    panel.fill_height = flag(props, "fillHeight").then(|| case["rows"].as_u64().unwrap() as u16);
    let mut state = ContextPanelState::new();
    let mut calls: Vec<Value> = Vec::new();
    for index in 0..case["frames"].as_array().unwrap().len() {
        let context = format!("{id} frame {index}");
        state.sync(&panel);
        let render = |painter: &mut Painter| paint_context_panel(painter, 0, 0, &panel, &state);
        let grid = compare_frame(golden, case, index, &render, &context);
        compare_levels(golden, case, index, &grid, &context);
        let Some(sequence) = key_sequence(case, index) else { continue };
        let (input, key) = decode_key(sequence);
        match state.handle_key(&input, &key, &panel) {
            InspectorEffect::None => {}
            InspectorEffect::Refresh => calls.push(json!(["onRefresh"])),
            InspectorEffect::Inspect { id, revision, token } => {
                calls.push(json!(["onInspect", id, revision]));
                state.finish_inspect(token, InspectOutcome::Answer(None));
            }
        }
    }
    assert_eq!(calls, node_calls(case), "{id}: the handlers called");
}

fn usage_case(golden: &Value, case: &Value, id: &str) {
    let props = &case["props"];
    let mut panel = UsagePanelProps::new(props.get("dashboard"));
    panel.columns = uint(props, "columns").unwrap();
    panel.loading = flag(props, "loading");
    panel.panel_rows = uint(props, "panelRows").unwrap_or(0);
    panel.fill_height = flag(props, "fillHeight").then(|| case["rows"].as_u64().unwrap() as u16);
    let mut state = UsagePanelState::new();
    for index in 0..case["frames"].as_array().unwrap().len() {
        let context = format!("{id} frame {index}");
        let render = |painter: &mut Painter| paint_usage_panel(painter, 0, 0, &panel, &state);
        let grid = compare_frame(golden, case, index, &render, &context);
        compare_levels(golden, case, index, &grid, &context);
        let Some(sequence) = key_sequence(case, index) else { continue };
        let (_, key) = decode_key(sequence);
        state.handle_key(&key, &panel);
    }
}

fn btw_case(golden: &Value, case: &Value, id: &str) {
    let props = &case["props"];
    let mut panel = BtwPanelProps::new(&props["panel"]);
    panel.columns = uint(props, "columns").unwrap();
    panel.panel_rows = uint(props, "panelRows");
    let mut state = BtwPanelState::new();
    for index in 0..case["frames"].as_array().unwrap().len() {
        let context = format!("{id} frame {index}");
        state.sync(&panel);
        let render = |painter: &mut Painter| paint_btw_panel(painter, 0, 0, &panel, &state);
        let grid = compare_frame(golden, case, index, &render, &context);
        compare_levels(golden, case, index, &grid, &context);
        let Some(sequence) = key_sequence(case, index) else { continue };
        let (_, key) = decode_key(sequence);
        state.handle_key(&key, &panel);
    }
}

#[test]
fn the_panels_draw_what_the_node_components_draw() {
    if mixdog_termtext::display_width("\u{2460}") != 2 {
        eprintln!("panels_twin: the ambiguous-width policy is off in this process; the recording was made with it on (set MIXDOG_TUI_AMBIGUOUS_WIDE=1)");
        return;
    }
    let (golden, cases) = corpus();
    let mut checked = 0;
    let mut failures: Vec<String> = Vec::new();
    for case in &cases {
        if case["kind"] != "frame" {
            continue;
        }
        let id = case["id"].as_str().unwrap();
        mixdog_tui_style::set_theme(case.get("theme").and_then(Value::as_str).unwrap_or("basic"));
        let run = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| match case["component"].as_str().unwrap() {
            "ContextPanel" => context_case(&golden, case, id),
            "UsagePanel" => usage_case(&golden, case, id),
            "BtwPanel" => btw_case(&golden, case, id),
            other => panic!("{id}: no mapping for {other}"),
        }));
        if let Err(payload) = run {
            let message = payload.downcast_ref::<String>().cloned().or_else(|| payload.downcast_ref::<&str>().map(|text| (*text).to_owned())).unwrap_or_default();
            failures.push(format!("{id}: {message}"));
        }
        checked += 1;
    }
    let ids: Vec<&str> = failures.iter().map(|failure| failure.split(':').next().unwrap_or("")).collect();
    assert!(
        failures.is_empty(),
        "{} of {checked} frame cases differ ({}); the first:\n{}",
        failures.len(),
        ids.join(", "),
        failures.iter().take(3).cloned().collect::<Vec<_>>().join("\n\n")
    );
    assert!(checked >= 80, "the corpus is read: {checked} frame cases");
}
