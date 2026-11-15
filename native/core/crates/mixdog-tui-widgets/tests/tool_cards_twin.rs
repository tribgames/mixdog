//! The tool cards against what the Node component draws (tests/goldens/tool_cards.json, recorded by
//! tests/recorders/record-tool-cards.mjs from tests/cases/tool_cards.json, which gen-tool-cards-cases.mjs writes): every
//! frame is compared cell by cell (glyph, width, style and link) through the VT test grid reader, and the functions that
//! post-process an expanded body are compared as the strings they return.
//!
//! The recording was made with the ambiguous-width policy on, so the frames are only comparable when this process has it
//! on too (Windows, or `MIXDOG_TUI_AMBIGUOUS_WIDE=1`); with it off the frame test says so and stops.

use mixdog_term::frame::{Color, Grid, Style};
use mixdog_term::testing::grid_from_ink_frame_with;
use mixdog_tui_widgets::tool_cards::output_format::{format_expanded_result, resolve_max_render_lines, wrap_expanded_result_lines};
use mixdog_tui_widgets::tool_cards::{CardCtx, render_tool_card};
use serde_json::Value;

const GOLDEN: &str = include_str!("goldens/tool_cards.json");
const CASES: &str = include_str!("cases/tool_cards.json");

/// Every case of the corpus with what Node recorded for it merged in.
fn corpus() -> (Value, Vec<Value>) {
    let golden: Value = serde_json::from_str(GOLDEN).expect("the golden parses");
    let cases: Vec<Value> = serde_json::from_str(CASES).expect("the cases parse");
    let merged = cases
        .into_iter()
        .map(|mut case| {
            let recorded = golden["cases"].as_array().unwrap().iter().find(|entry| entry["id"] == case["id"]).expect("a recording of every case");
            for key in ["frame", "result"] {
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

/// Every cell is the same glyph in the same style under the same link (a continuation cell only has to be one).
fn assert_same_grid(actual: &Grid, expected: &Grid, context: &str) {
    assert_eq!(actual.height, expected.height, "{context}: rows\nrust:\n{}\nnode:\n{}", rows_of(actual), rows_of(expected));
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
}

fn rows_of(grid: &Grid) -> String {
    (0..grid.height).map(|y| grid.row_text(y)).collect::<Vec<_>>().join("\n")
}

fn strings(value: &Value) -> Vec<String> {
    value.as_array().unwrap().iter().map(|item| item.as_str().unwrap().to_owned()).collect()
}

fn frame_case(wide: bool, case: &Value) {
    let columns = case["columns"].as_u64().unwrap() as usize;
    let ctx = CardCtx { columns, now_ms: case["now"].as_f64().unwrap_or(20_000.0), max_render_lines: 600 };
    let lines = render_tool_card(&case["props"], &ctx);
    let frame = lines.iter().map(|line| line.0.as_str()).collect::<Vec<_>>().join("\n");
    let actual = grid_from_ink_frame_with(&frame, columns as u16, wide);
    let expected = grid_from_ink_frame_with(case["frame"].as_str().unwrap(), columns as u16, wide);
    assert_same_grid(&actual, &expected, case["id"].as_str().unwrap());
}

fn fn_case(case: &Value) {
    let args = case["args"].as_array().unwrap();
    let id = case["id"].as_str().unwrap();
    let flag = |options: &Value, key: &str| options.get(key).and_then(Value::as_bool).unwrap_or(false);
    let rust = match case["name"].as_str().unwrap() {
        "formatExpandedResult" => {
            let path_arg = args[1].get("pathArg").and_then(Value::as_str).unwrap_or("");
            format_expanded_result(args[0].as_str().unwrap(), path_arg, flag(&args[1], "isShell"))
        }
        "wrapExpandedResultLines" => {
            let env = |name: &str| case.get("env").and_then(|env| env.get(name)).and_then(Value::as_str);
            let rows = resolve_max_render_lines(env("MIXDOG_TUI_TOOL_OUTPUT_MAX_RENDER_LINES"), env("MIXDOG_TUI_EXPANDED_MAX_ROWS"));
            wrap_expanded_result_lines(&strings(&args[0]), args[1].as_u64().unwrap() as usize, flag(&args[2], "isShell"), rows)
        }
        other => panic!("{id}: no mapping for {other}"),
    };
    assert_eq!(rust, strings(&case["result"]), "{id}");
}

#[test]
fn the_tool_cards_draw_what_the_node_component_draws() {
    if mixdog_termtext::display_width("\u{2460}") != 2 {
        eprintln!("tool_cards_twin: the ambiguous-width policy is off in this process; the recording was made with it on (set MIXDOG_TUI_AMBIGUOUS_WIDE=1)");
        return;
    }
    let (golden, cases) = corpus();
    let wide = golden["ambiguousWide"].as_bool().unwrap();
    let (mut frames, mut functions) = (0, 0);
    let mut failures: Vec<String> = Vec::new();
    for case in &cases {
        mixdog_tui_style::set_theme(case.get("theme").and_then(Value::as_str).unwrap_or("basic"));
        let run = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| match case["kind"].as_str().unwrap() {
            "frame" => frame_case(wide, case),
            _ => fn_case(case),
        }));
        match case["kind"].as_str().unwrap() {
            "frame" => frames += 1,
            _ => functions += 1,
        }
        if let Err(payload) = run {
            let message = payload.downcast_ref::<String>().cloned().or_else(|| payload.downcast_ref::<&str>().map(|text| (*text).to_owned())).unwrap_or_default();
            failures.push(format!("{}: {message}", case["id"].as_str().unwrap()));
        }
    }
    let ids: Vec<&str> = failures.iter().map(|failure| failure.split(':').next().unwrap_or("")).collect();
    assert!(
        failures.is_empty(),
        "{} of {} cases differ ({}); the first:\n{}",
        failures.len(),
        frames + functions,
        ids.join(", "),
        failures.iter().take(3).cloned().collect::<Vec<_>>().join("\n\n")
    );
    assert!(frames >= 170 && functions >= 30, "the corpus is read: {frames} frame cases, {functions} function cases");
}
