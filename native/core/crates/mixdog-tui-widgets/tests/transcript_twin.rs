//! The transcript components against what the Node components draw and compute (tests/goldens/transcript.json, recorded
//! by tests/recorders/record-ink-frames.mjs from tests/cases/transcript.json, which tests/recorders/gen-transcript-cases.mjs
//! writes): every frame is compared cell by cell (glyph, width, style and link) through the reader of Ink frames, and the
//! pure rules (applied skills, tool failures) are compared as data.
//!
//! The corpus holds the rows of the recorded session folds at widths 40, 80 and 120, every component at three widths and
//! three themes, and each prefix of five streaming assistant messages. The streaming frames are replayed in the order they
//! were recorded, so the caches of a stream hold what Node's held.
//!
//! The recording was made with the ambiguous-width policy on, so the frames are only comparable when this process has it on
//! too (Windows, or `MIXDOG_TUI_AMBIGUOUS_WIDE=1`); with it off the frame test says so and stops.

use mixdog_term::frame::{Color, Grid, Rgb};
use mixdog_term::testing::grid_from_ink_frame_with;
use mixdog_tui_widgets::Line;
use mixdog_tui_widgets::transcript::skills::{applied_skills_line, user_text_segments};
use mixdog_tui_widgets::transcript::tool_failures::{
    format_hook_denial_detail, is_fully_failed_tool_batch, is_hook_approval_denial_tool_item, should_suppress_fully_failed_tool_item,
    tool_item_result_text,
};
use mixdog_tui_widgets::transcript::{
    ItemCtx, render_ansi_text, render_assistant_message, render_item, render_markdown, render_notice, render_queued_commands,
    render_status_done, render_streaming_markdown, render_tool_hook_denial, render_turn_done, render_user_message,
};
use serde_json::{Value, json};

const GOLDEN: &str = include_str!("goldens/transcript.json");
const CASES: &str = include_str!("cases/transcript.json");
/// A property the recorder writes for `undefined`.
const UNDEFINED: &str = "__undefined__";
const NAN: &str = "__NaN__";

/// The recording (its format and width policy) and every case of the corpus with what Node recorded for it merged in.
fn corpus() -> (Value, Vec<Value>) {
    let golden: Value = serde_json::from_str(GOLDEN).expect("the golden parses");
    let cases: Vec<Value> = serde_json::from_str(CASES).expect("the cases parse");
    let merged = cases
        .into_iter()
        .map(|mut case| {
            let recorded = golden["cases"].as_array().unwrap().iter().find(|entry| entry["id"] == case["id"]).expect("a recording of every case");
            for key in ["frames", "result"] {
                if let Some(value) = recorded.get(key) {
                    case[key] = value.clone();
                }
            }
            case
        })
        .collect();
    (golden, merged)
}

/// Every cell of the grids is the same glyph in the same style under the same link (a continuation cell only has to be one:
/// Ink writes no bytes for it, so its style cannot be read back from a frame).
fn assert_same_grid(actual: &Grid, expected: &Grid, context: &str) {
    assert_eq!(actual.height, expected.height, "{context}: rows\nrust:\n{}\nnode:\n{}", rows_text(actual), rows_text(expected));
    for y in 0..expected.height {
        for x in 0..expected.width {
            let (a, e) = (actual.cell(x, y).unwrap(), expected.cell(x, y).unwrap());
            if a.is_continuation() || e.is_continuation() {
                assert_eq!(a.is_continuation(), e.is_continuation(), "{context}: continuation at ({x}, {y})\n{}\n{}", actual.row_text(y), expected.row_text(y));
                continue;
            }
            assert_eq!((a.text(), a.width), (e.text(), e.width), "{context}: glyph at ({x}, {y})\nrust: {}\nnode: {}", actual.row_text(y), expected.row_text(y));
            assert_eq!(a.style, e.style, "{context}: style at ({x}, {y}) of {:?}", e.text());
            assert_eq!(actual.link_url(a.link), expected.link_url(e.link), "{context}: link at ({x}, {y})");
        }
    }
}

fn rows_text(grid: &Grid) -> String {
    (0..grid.height).map(|y| grid.row_text(y)).collect::<Vec<_>>().join("\n")
}

fn defined<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    value.get(key).filter(|found| found.as_str() != Some(UNDEFINED))
}

fn text<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    defined(value, key).and_then(Value::as_str)
}

fn uint(value: &Value, key: &str) -> Option<usize> {
    defined(value, key).and_then(Value::as_u64).map(|n| n as usize)
}

fn flag(value: &Value, key: &str) -> bool {
    defined(value, key).and_then(Value::as_bool).unwrap_or(false)
}

/// A JavaScript number prop (`"__NaN__"` is NaN), or the default of an absent one.
fn number(value: &Value, key: &str, default: f64) -> f64 {
    match defined(value, key) {
        None => default,
        Some(Value::String(text)) if text == NAN => f64::NAN,
        Some(found) => found.as_f64().unwrap_or(0.0),
    }
}

/// `rgb(r,g,b)` of the corpus.
fn colour(value: Option<&str>) -> Color {
    let Some(inner) = value.and_then(|text| text.strip_prefix("rgb(")).and_then(|text| text.strip_suffix(')')) else { return Color::Default };
    let parts: Vec<u8> = inner.split(',').map(|part| part.trim().parse().unwrap()).collect();
    Color::Rgb(Rgb::new(parts[0], parts[1], parts[2]))
}

fn hint(props: &Value) -> Option<(&str, &str, f64)> {
    let message = text(props, "rightMessage")?;
    Some((message, text(props, "rightTone").unwrap_or("info"), number(props, "rightMessageWidth", 24.0)))
}

fn item_ctx(props: &Value) -> ItemCtx {
    let mut ctx = ItemCtx::new(uint(props, "columns").unwrap());
    ctx.prev_kind = text(props, "prevKind").map(str::to_owned);
    ctx.tool_output_expanded = flag(props, "toolOutputExpanded");
    ctx.right_message = text(props, "rightMessage").unwrap_or("").to_owned();
    ctx.right_tone = text(props, "rightTone").unwrap_or("info").to_owned();
    ctx.right_message_width = number(props, "rightMessageWidth", 24.0);
    ctx.streaming_window_rows = uint(props, "streamingWindowRows").unwrap_or(0);
    ctx
}

/// What the Rust component renders for the props of a frame case.
fn render(case: &Value) -> Vec<Line> {
    let props = &case["props"];
    let columns = case["columns"].as_u64().unwrap() as usize;
    match case["component"].as_str().unwrap() {
        "AnsiText" => render_ansi_text(text(props, "children").unwrap_or(""), colour(text(props, "defaultColor")), columns),
        "Markdown" => render_markdown(text(props, "children").unwrap_or(""), flag(props, "trimPartialFences"), uint(props, "columns"), columns),
        "StreamingMarkdown" => {
            let streaming = defined(props, "streaming").and_then(Value::as_bool).unwrap_or(true);
            render_streaming_markdown(text(props, "children").unwrap_or(""), uint(props, "columns"), text(props, "streamKey"), streaming, columns)
        }
        "UserMessage" => render_user_message(text(props, "text"), flag(props, "attached"), uint(props, "columns").unwrap(), defined(props, "appliedSkills")),
        "AssistantMessage" => render_assistant_message(
            text(props, "text").unwrap_or(""),
            flag(props, "streaming"),
            uint(props, "columns").unwrap(),
            text(props, "assistantId"),
            uint(props, "streamingWindowRows").unwrap_or(0),
        ),
        "NoticeMessage" => render_notice(text(props, "text").unwrap_or(""), text(props, "tone"), uint(props, "columns").unwrap()),
        "TurnDone" => render_turn_done(
            number(props, "elapsedMs", 0.0),
            text(props, "status").unwrap_or("done"),
            number(props, "toolCount", 0.0),
            text(props, "verb").unwrap_or(""),
            uint(props, "marginTop").unwrap_or(1) as u16,
            hint(props),
            columns,
        ),
        "StatusDone" => render_status_done(
            text(props, "label").unwrap_or(""),
            text(props, "detail").unwrap_or(""),
            uint(props, "marginTop").unwrap_or(1) as u16,
            hint(props),
            columns,
        ),
        "QueuedCommands" => {
            let queued = props.get("queued").and_then(Value::as_array).cloned().unwrap_or_default();
            render_queued_commands(&queued, uint(props, "columns").unwrap(), flag(props, "compact"))
        }
        "ToolHookDenialCard" => render_tool_hook_denial(&props["item"], uint(props, "columns").unwrap()),
        "Item" => render_item(&props["item"], &item_ctx(props)),
        other => panic!("no mapping for {other}"),
    }
}

fn compare_frame(golden: &Value, case: &Value) {
    let id = case["id"].as_str().unwrap();
    let columns = case["columns"].as_u64().unwrap() as u16;
    let wide = golden["ambiguousWide"].as_bool().unwrap();
    let expected = grid_from_ink_frame_with(case["frames"][0].as_str().unwrap(), columns, wide);
    let lines = render(case);
    let actual = grid_from_ink_frame_with(&lines.iter().map(|line| line.0.as_str()).collect::<Vec<_>>().join("\n"), columns, wide);
    assert_same_grid(&actual, &expected, id);
}

#[test]
fn the_components_draw_what_the_node_components_draw() {
    if mixdog_termtext::display_width("\u{2460}") != 2 {
        eprintln!("transcript_twin: the ambiguous-width policy is off in this process; the recording was made with it on (set MIXDOG_TUI_AMBIGUOUS_WIDE=1)");
        return;
    }
    let (golden, cases) = corpus();
    let mut checked = 0;
    let mut failures: Vec<String> = Vec::new();
    for case in cases.iter().filter(|case| case["kind"] == "frame") {
        let id = case["id"].as_str().unwrap();
        mixdog_tui_style::set_theme(text(case, "theme").unwrap_or("basic"));
        let run = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| compare_frame(&golden, case)));
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
    assert!(checked >= 600, "the corpus is read: {checked} frame cases");
}

/// The value of a `fn` argument: `undefined` is none.
fn argument(args: &[Value], at: usize) -> Option<&Value> {
    args.get(at).filter(|value| value.as_str() != Some(UNDEFINED))
}

/// What the Rust function computes for a `fn` case, in the shape Node's function returned.
fn compute(case: &Value) -> Value {
    let args = case["args"].as_array().unwrap();
    let key = format!("{}.{}", case["module"].as_str().unwrap(), case["name"].as_str().unwrap());
    let item = argument(args, 0).cloned().unwrap_or(Value::Null);
    match key.as_str() {
        "userMessageSkills.appliedSkillsLine" => json!(applied_skills_line(argument(args, 0))),
        "userMessageSkills.userTextSegments" => {
            let source = argument(args, 0).and_then(Value::as_str).unwrap_or("");
            Value::Array(user_text_segments(source, argument(args, 1)).into_iter().map(|segment| json!({ "text": segment.text, "mention": segment.mention })).collect())
        }
        "transcriptToolFailures.toolItemResultText" => json!(tool_item_result_text(&item)),
        "transcriptToolFailures.isHookApprovalDenialToolItem" => json!(is_hook_approval_denial_tool_item(&item)),
        "transcriptToolFailures.isFullyFailedToolBatch" => json!(is_fully_failed_tool_batch(&item)),
        "transcriptToolFailures.shouldSuppressFullyFailedToolItem" => json!(should_suppress_fully_failed_tool_item(&item)),
        "transcriptToolFailures.formatHookDenialDetail" => {
            let source = match &item {
                Value::Null => String::new(),
                other => mixdog_js::value_to_string(other),
            };
            json!(format_hook_denial_detail(&source))
        }
        other => panic!("no mapping for the function {other}"),
    }
}

#[test]
fn the_pure_rules_compute_what_the_node_functions_return() {
    let (_, cases) = corpus();
    let mut checked = 0;
    for case in cases.iter().filter(|case| case["kind"] == "fn") {
        assert_eq!(compute(case), case["result"], "{}", case["id"]);
        checked += 1;
    }
    assert!(checked >= 150, "the corpus is read: {checked} function cases");
}
