//! The spinner, the statusline band and the local line against what the Node components draw and compute:
//!
//! * `goldens/spinner-progress.json`, recorded by `recorders/record-spinner-progress.mjs`: the display values the real
//!   `useSpinnerProgress` hook returns for scripted ticks, and the frames the real `Spinner` draws (Ink, a frozen clock
//!   per tick) compared cell by cell (glyph, width, style and link) through the VT test grid reader.
//! * `goldens/status.json`, recorded by `recorders/record-ink-frames.mjs` from `cases/status.json`: the frames of the
//!   real `StatusLine` (which shows the local line at mount) and the results of the local-line and visibility functions.
//!
//! The recording was made with the ambiguous-width policy on, so the frames are only comparable when this process has it
//! on too (Windows, or `MIXDOG_TUI_AMBIGUOUS_WIDE=1`); with it off the frame tests say so and stop. The theme is global,
//! so the tests that set it run one at a time.

use std::sync::Mutex;

use mixdog_term::frame::{Color, Grid, Style};
use mixdog_term::paint::Painter;
use mixdog_term::testing::grid_from_ink_frame_with;
use mixdog_tui_style::set_theme;
use mixdog_tui_style::spinner_meta::Quiet;
use mixdog_tui_widgets::Line;
use mixdog_tui_widgets::spinner::{
    ProgressInput, SpinnerProgress, SpinnerProps, SpinnerVisibility, StreamingTail, TranscriptTail, is_completed_transcript_tail_appended_this_commit,
    is_live_spinner_meta_visible, render_spinner, spinner_rows,
};
use mixdog_tui_widgets::statusline::{
    LocalLineArgs, build_local_snap_line, local_boot_status_line, local_status_line_l2, normalize_status_line, paint_statusline_band, workflow_mode_label,
};
use serde_json::Value;

const SPINNER_GOLDEN: &str = include_str!("goldens/spinner-progress.json");
const STATUS_GOLDEN: &str = include_str!("goldens/status.json");
const STATUS_CASES: &str = include_str!("cases/status.json");

static THEME: Mutex<()> = Mutex::new(());

fn ambiguous_wide() -> bool {
    mixdog_termtext::display_width("\u{2460}") == 2
}

fn plain_style(style: Style) -> Style {
    let plain = |color: Color| match color {
        Color::Literal(rgb) => Color::Rgb(rgb),
        other => other,
    };
    Style { fg: plain(style.fg), bg: plain(style.bg), ..style }
}

/// Every cell is the same glyph in the same style under the same link (a continuation cell only has to be one: Ink
/// writes no bytes for it, so its style cannot be read back from a frame).
fn assert_same_grid(actual: &Grid, expected: &Grid, context: &str) {
    assert_eq!(actual.width, expected.width, "{context}: width");
    assert_eq!(actual.height, expected.height, "{context}: rows\nrust: {:?}\nnode: {:?}", rows_of(actual), rows_of(expected));
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

fn rows_of(grid: &Grid) -> Vec<String> {
    (0..grid.height).map(|y| grid.row_text(y)).collect()
}

fn grid_of_lines(lines: &[Line], columns: u16) -> Grid {
    let mut grid = Grid::new(columns, lines.len() as u16);
    let mut painter = Painter::new(&mut grid);
    for (row, line) in lines.iter().enumerate() {
        painter.line(0, row as i32, &line.0, Style::default());
    }
    grid
}

fn number(value: &Value, key: &str) -> f64 {
    match value.get(key) {
        Some(Value::Number(n)) => n.as_f64().unwrap(),
        _ => 0.0,
    }
}

fn text(value: &Value, key: &str) -> String {
    value.get(key).and_then(Value::as_str).unwrap_or("").to_owned()
}

fn flag(value: &Value, key: &str) -> bool {
    value.get(key).and_then(Value::as_bool).unwrap_or(false)
}

/// JavaScript truthiness of a corpus value.
fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|n| n != 0.0),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

// ---- spinner ---------------------------------------------------------------------------------------------------------

fn spinner_props(props: &Value) -> SpinnerProps {
    let defaults = SpinnerProps::default();
    SpinnerProps {
        verb: props.get("verb").and_then(Value::as_str).map_or(defaults.verb, str::to_owned),
        started_at: number(props, "startedAt"),
        output_tokens: number(props, "outputTokens"),
        tokens: number(props, "tokens"),
        thinking: flag(props, "thinking"),
        thinking_active_since: number(props, "thinkingActiveSince"),
        thinking_ms: number(props, "thinkingMs"),
        effort: text(props, "effort"),
        quiet: props.get("quiet").filter(|quiet| quiet.is_object()).map(|quiet| Quiet {
            since: number(quiet, "since"),
            wait: text(quiet, "wait"),
            tool: quiet.get("tool").and_then(Value::as_str).map(str::to_owned),
            warn_ms: number(quiet, "warnMs"),
        }),
        has_active_tools: flag(props, "hasActiveTools"),
        paused: flag(props, "paused"),
        interruptible: flag(props, "interruptible"),
        mode: props.get("mode").and_then(Value::as_str).map_or(defaults.mode, str::to_owned),
        columns: props.get("columns").and_then(Value::as_f64).unwrap_or(defaults.columns),
        margin_top: props.get("marginTop").and_then(Value::as_u64).map_or(defaults.margin_top, |rows| rows as usize),
    }
}

#[test]
fn the_progress_of_the_hook_is_what_the_rust_state_machine_computes() {
    let golden: Value = serde_json::from_str(SPINNER_GOLDEN).expect("the golden parses");
    let scripts = golden["progress"].as_array().unwrap();
    assert!(scripts.len() >= 8, "the corpus is read: {}", scripts.len());
    for script in scripts {
        let id = script["id"].as_str().unwrap();
        let ticks = script["ticks"].as_array().unwrap();
        let mut progress = SpinnerProgress::new(number(&ticks[0], "now"), number(&ticks[0], "startedAt"));
        for (index, (tick, expected)) in ticks.iter().zip(script["out"].as_array().unwrap()).enumerate() {
            let started_at = number(tick, "startedAt");
            let now = number(tick, "now");
            let raw_elapsed_ms = if started_at != 0.0 { (now - started_at).max(0.0) } else { 0.0 };
            let reduced_motion = flag(tick, "reducedMotion");
            let output_tokens = if tick["outputTokens"].is_null() { f64::NAN } else { number(tick, "outputTokens") };
            let mode = tick.get("mode").and_then(Value::as_str).unwrap_or("responding");
            let display = progress.advance(&ProgressInput {
                now,
                started_at,
                raw_elapsed_ms,
                frame: if reduced_motion { 0.0 } else { (raw_elapsed_ms / 130.0).floor() },
                output_tokens,
                tokens: number(tick, "tokens"),
                paused: flag(tick, "paused"),
                has_active_tools: flag(tick, "hasActiveTools"),
                mode,
                reduced_motion,
            });
            let context = format!("{id} tick {index}");
            assert_eq!(display.elapsed_ms, number(expected, "elapsedMs"), "{context}: elapsedMs");
            assert_eq!(display.stalled_intensity, number(expected, "stalledIntensity"), "{context}: stalledIntensity");
            assert_eq!(display.displayed_output_tokens, number(expected, "displayedOutputTokens"), "{context}: displayedOutputTokens");
        }
    }
}

#[test]
fn the_spinner_row_draws_what_the_node_spinner_draws() {
    if !ambiguous_wide() {
        eprintln!("the spinner frames were recorded with the ambiguous-width policy on; this process has it off");
        return;
    }
    let _theme = THEME.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let golden: Value = serde_json::from_str(SPINNER_GOLDEN).expect("the golden parses");
    let scripts = golden["frames"].as_array().unwrap();
    assert!(scripts.len() >= 14, "the corpus is read: {}", scripts.len());
    for script in scripts {
        let id = script["id"].as_str().unwrap();
        set_theme(script["theme"].as_str().unwrap());
        let reduced_motion = script["reducedMotion"].as_bool().unwrap();
        let columns = script["columns"].as_u64().unwrap() as u16;
        let ticks = script["ticks"].as_array().unwrap();
        let merged = |tick: &Value| {
            let mut props = script["props"].as_object().unwrap().clone();
            props.extend(tick["props"].as_object().unwrap().clone());
            Value::Object(props)
        };
        let first = merged(&ticks[0]);
        let mut progress = SpinnerProgress::new(number(&ticks[0], "now"), number(&first, "startedAt"));
        for (index, (tick, frame)) in ticks.iter().zip(script["frames"].as_array().unwrap()).enumerate() {
            let props = spinner_props(&merged(tick));
            let rows = render_spinner(&mut progress, &props, number(tick, "now"), reduced_motion);
            assert_eq!(rows.len(), spinner_rows(&props));
            let expected = grid_from_ink_frame_with(frame.as_str().unwrap(), columns, true);
            // A tick that changes the width draws in the new width, the grid the frame was read into keeps the case's.
            assert_same_grid(&grid_of_lines(&rows, columns), &expected, &format!("{id} tick {index}"));
        }
    }
    set_theme("basic");
}

// ---- statusline ------------------------------------------------------------------------------------------------------

/// What the local line is built from, owned.
struct OwnedLocalArgs {
    model: String,
    effort: String,
    fast: bool,
    ultra: bool,
    stats: Option<Value>,
    context_window: f64,
    display_context_window: f64,
    raw_context_window: f64,
    workers: Vec<Value>,
    jobs: Vec<Value>,
    tools: Option<Value>,
}

impl OwnedLocalArgs {
    fn of(value: &Value) -> Self {
        let list = |key: &str| value.get(key).and_then(Value::as_array).cloned().unwrap_or_default();
        Self {
            model: text(value, "model"),
            effort: text(value, "effort"),
            fast: flag(value, "fast"),
            ultra: flag(value, "ultra"),
            stats: value.get("stats").filter(|stats| !stats.is_null()).cloned(),
            context_window: number(value, "contextWindow"),
            display_context_window: number(value, "displayContextWindow"),
            raw_context_window: number(value, "rawContextWindow"),
            workers: list("agentWorkers"),
            jobs: list("agentJobs"),
            tools: value.get("activeTools").filter(|tools| !tools.is_null()).cloned(),
        }
    }

    fn args(&self) -> LocalLineArgs<'_> {
        LocalLineArgs {
            model: &self.model,
            effort: &self.effort,
            fast: self.fast,
            ultra: self.ultra,
            stats: self.stats.as_ref(),
            context_window: self.context_window,
            display_context_window: self.display_context_window,
            raw_context_window: self.raw_context_window,
            agent_workers: &self.workers,
            agent_jobs: &self.jobs,
            active_tools: self.tools.as_ref(),
            shell_status: None,
            // The recording runs at 120 columns.
            terminal_columns: None,
        }
    }
}

fn corpus() -> Vec<Value> {
    let golden: Value = serde_json::from_str(STATUS_GOLDEN).expect("the golden parses");
    let cases: Vec<Value> = serde_json::from_str(STATUS_CASES).expect("the cases parse");
    cases
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
        .collect()
}

#[test]
fn the_statusline_band_draws_what_the_node_status_line_draws() {
    if !ambiguous_wide() {
        eprintln!("the status line frames were recorded with the ambiguous-width policy on; this process has it off");
        return;
    }
    let _theme = THEME.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut checked = 0;
    for case in corpus().iter().filter(|case| case["kind"] == "frame") {
        let id = case["id"].as_str().unwrap();
        set_theme(case.get("theme").and_then(Value::as_str).unwrap_or("basic"));
        let columns = case["columns"].as_u64().unwrap() as u16;
        let props = &case["props"];
        // At mount the hook shows the local line built from the props (an initial line is never shown).
        let owned = OwnedLocalArgs::of(props);
        let footer = build_local_snap_line(&owned.args(), "", 0.0);
        let label = workflow_mode_label(props.get("workflow"));
        let mut grid = Grid::new(columns, 2);
        assert_eq!(paint_statusline_band(&mut Painter::new(&mut grid), 0, 0, columns, &footer, &label), 2);
        let expected = grid_from_ink_frame_with(case["frames"][0].as_str().unwrap(), columns, true);
        assert_same_grid(&grid, &expected, id);
        checked += 1;
    }
    set_theme("basic");
    assert!(checked >= 20, "the corpus is read: {checked}");
}

fn compute(case: &Value) -> Value {
    let args = case["args"].as_array().unwrap();
    let arg = |index: usize| args.get(index).filter(|value| value.as_str() != Some("__undefined__"));
    let string = |index: usize| arg(index).and_then(Value::as_str).unwrap_or("").to_owned();
    match format!("{}.{}", case["module"].as_str().unwrap(), case["name"].as_str().unwrap()).as_str() {
        "localLine.workflowModeLabel" => Value::String(workflow_mode_label(arg(0))),
        "localLine.localStatusLineL2" => Value::String(local_status_line_l2(&OwnedLocalArgs::of(&args[0]).args(), args[1].as_f64().unwrap())),
        "localLine.localBootStatusLine" => Value::String(local_boot_status_line(&OwnedLocalArgs::of(&args[0]).args(), 0.0)),
        "localLine.normalizeStatusLine" => Value::String(normalize_status_line(&string(0))),
        "localLine.buildLocalSnapLine" => Value::String(build_local_snap_line(&OwnedLocalArgs::of(&args[0]).args(), &string(1), 0.0)),
        "liveSpinnerVisibility.isLiveSpinnerMetaVisible" => {
            let input = &args[0];
            let item = |value: Option<&Value>| value.filter(|item| item.is_object());
            let latest = item(input.get("latestTranscriptItem")).map(|item| (text(item, "kind"), item.get("id").and_then(Value::as_str).map(str::to_owned)));
            let tail = item(input.get("streamingTail")).map(|tail| (text(tail, "kind"), flag(tail, "streaming"), text(tail, "text")));
            Value::Bool(is_live_spinner_meta_visible(&SpinnerVisibility {
                input_box_hidden: flag(input, "inputBoxHidden"),
                slash_palette_open: flag(input, "slashPaletteOpen"),
                live_spinner: truthy(input.get("liveSpinner")),
                live_spinner_is_command: flag(input, "liveSpinnerIsCommand"),
                latest_transcript_item: latest.as_ref().map(|(kind, id)| TranscriptTail { kind, id: id.as_deref() }),
                streaming_tail: tail.as_ref().map(|(kind, streaming, text)| StreamingTail { kind, streaming: *streaming, text }),
                transcript_view_active: flag(input, "transcriptViewActive"),
            }))
        }
        "liveSpinnerVisibility.isCompletedTranscriptTailAppendedThisCommit" => {
            let latest = arg(0).filter(|item| item.is_object()).map(|item| (text(item, "kind"), item.get("id").and_then(Value::as_str).map(str::to_owned)));
            Value::Bool(is_completed_transcript_tail_appended_this_commit(
                latest.as_ref().map(|(kind, id)| TranscriptTail { kind, id: id.as_deref() }),
                arg(1).and_then(Value::as_str),
            ))
        }
        other => panic!("no mapping for the function {other}"),
    }
}

#[test]
fn the_local_line_and_the_visibility_rules_compute_what_the_node_functions_return() {
    let _theme = THEME.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    // The function cases were recorded in the basic theme.
    set_theme("basic");
    let mut checked = 0;
    for case in corpus().iter().filter(|case| case["kind"] == "fn") {
        assert_eq!(compute(case), case["result"], "{}", case["id"]);
        checked += 1;
    }
    assert!(checked >= 60, "the corpus is read: {checked}");
}
