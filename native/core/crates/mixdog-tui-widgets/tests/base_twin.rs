//! The base widgets against what the Node components draw and compute (tests/goldens/base.json, recorded by
//! tests/recorders/record-ink-frames.mjs from tests/cases/base.json): every frame is compared cell by cell (glyph, width,
//! style and link) through the VT test grid reader, the keys of a case are replayed on the Rust state machines and the
//! frame after each key is compared, the calls a key makes are compared with what Node's handlers received, a subset of
//! the frames is compared again through the frame writer at the chalk colour levels 1 and 2, and the pure functions are
//! compared as data.
//!
//! The recording was made with the ambiguous-width policy on, so the frames are only comparable when this process has it
//! on too (Windows, or `MIXDOG_TUI_AMBIGUOUS_WIDE=1`); with it off the frame test says so and stops.

use mixdog_term::frame::{Color, FrameWriter, Grid, Rect, Style};
use mixdog_term::input::{KeyFlags, decode_key};
use mixdog_term::paint::Painter;
use mixdog_term::testing::{VtGrid, grid_from_ink_frame_with};
use mixdog_tui_style::theme::Color as ThemeColor;
use mixdog_tui_widgets::confirm_bar::{ConfirmButton, clamp_confirm_focus, paint_confirm_bar};
use mixdog_tui_widgets::hint_overprint::{clean_right_message, paint_item_right_hint};
use mixdog_tui_widgets::palette::{PaletteProps, SlashCommand, paint_palette};
use mixdog_tui_widgets::panel_cell_text::{pad_panel_cells, truncate_panel_text};
use mixdog_tui_widgets::picker::layout::{FooterInput, clamp_item_index, clamp_label_width, clamp_meta_width};
use mixdog_tui_widgets::picker::state::{PickerAction, PickerKeyContext, PickerState};
use mixdog_tui_widgets::picker::{Footer, IndexMode, MetaPart, PickerItem, PickerProps, effective_visible_limit, paint_picker};
use mixdog_tui_widgets::question::{
    Draft, Question, QuestionAction, QuestionState, answer_for, append_capped, build_answers, initial_cursor, option_layout,
    paint_question, plan_question_view, question_help, question_panel_rows,
};
use mixdog_tui_widgets::sign_in_url::{CopyMethod, CopyStatus, SignInUrlLayout, copy_url, paint_sign_in_url, sign_in_url_layout};
use mixdog_tui_widgets::text_entry::{
    TextEntryDraft, TextEntryProps, flatten_for_single_line, paint_text_entry, single_line, window_single_line,
};
use mixdog_tui_widgets::text_layout::{caret_position, slice_visual_row_window, text_entry_reserved_rows, wrapped_detail_rows, wrapped_text_rows};
use serde_json::{Value, json};

const GOLDEN: &str = include_str!("goldens/base.json");
const CASES: &str = include_str!("cases/base.json");
/// A grid taller than any widget of the corpus: the rows after a widget must stay untouched.
const TALL: u16 = 80;

/// The recording (its format and width policy) and every case of the corpus with what Node recorded for it merged in.
fn corpus() -> (Value, Vec<Value>) {
    let golden: Value = serde_json::from_str(GOLDEN).expect("the golden parses");
    let cases: Vec<Value> = serde_json::from_str(CASES).expect("the cases parse");
    let merged = cases
        .into_iter()
        .map(|mut case| {
            let recorded = golden["cases"].as_array().unwrap().iter().find(|entry| entry["id"] == case["id"]).expect("a recording of every case");
            for key in ["frames", "calls", "levels", "result"] {
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
        assert!((0..actual.width).all(|x| actual.cell(x, y).unwrap().is_plain_blank()), "{context}: row {y} below the widget is not blank");
    }
}

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}

fn uint(value: &Value, key: &str) -> Option<usize> {
    value.get(key).and_then(Value::as_u64).map(|n| n as usize)
}

fn flag(value: &Value, key: &str) -> bool {
    value.get(key).and_then(Value::as_bool).unwrap_or(false)
}

/// `rgb(r,g,b)` of the corpus.
fn theme_color(value: Option<&Value>) -> Option<ThemeColor> {
    let text = value?.as_str()?;
    let inner = text.strip_prefix("rgb(")?.strip_suffix(')')?;
    let parts: Vec<u8> = inner.split(',').map(|part| part.trim().parse().unwrap()).collect();
    Some(ThemeColor::Rgb(parts[0], parts[1], parts[2]))
}

fn picker_item(value: &Value) -> PickerItem {
    PickerItem {
        value: text(value, "value").to_owned(),
        label: text(value, "label").to_owned(),
        label_suffix: text(value, "labelSuffix").to_owned(),
        label_suffix_color: theme_color(value.get("labelSuffixColor")),
        marker: text(value, "marker").to_owned(),
        marker_color: theme_color(value.get("markerColor")),
        checked: value.get("checked").and_then(Value::as_bool),
        meta: text(value, "meta").to_owned(),
        model_profile: text(value, "modelProfile").to_owned(),
        meta_parts: value.get("metaParts").and_then(Value::as_array).map(|parts| {
            parts.iter().map(|part| MetaPart { text: text(part, "text").to_owned(), width: part.get("width").and_then(Value::as_u64).unwrap_or(0) as usize }).collect()
        }),
        description: text(value, "description").to_owned(),
    }
}

fn footer_input(value: &Value) -> FooterInput {
    match value {
        Value::Object(_) => FooterInput::Object { glyph: text(value, "glyph").to_owned(), color: theme_color(value.get("color")), text: text(value, "text").to_owned() },
        other => FooterInput::Plain(other.as_str().unwrap_or("").to_owned()),
    }
}

fn confirm_buttons(list: Option<&Value>) -> Vec<ConfirmButton> {
    list.and_then(Value::as_array)
        .map(|buttons| buttons.iter().filter(|button| !button.is_null()).map(|button| ConfirmButton::new(text(button, "value"), text(button, "label"))).collect())
        .unwrap_or_default()
}

fn picker_props(case: &Value) -> (PickerProps, Option<usize>) {
    let props = &case["props"];
    let items = props["items"].as_array().unwrap().iter().map(picker_item).collect();
    let mut picker = PickerProps::new(items, text(props, "title"));
    picker.description = text(props, "description").to_owned();
    picker.detail = text(props, "detail").to_owned();
    picker.help = props.get("help").and_then(Value::as_str).map(str::to_owned);
    picker.columns = uint(props, "columns").unwrap();
    picker.label_width = uint(props, "labelWidth");
    picker.meta_width = uint(props, "metaWidth");
    if let Some(gap) = uint(props, "footerGapRows") {
        picker.footer_gap_rows = gap;
    }
    picker.index_mode = match text(props, "indexMode") {
        "always" => IndexMode::Always,
        "never" => IndexMode::Never,
        _ => IndexMode::Auto,
    };
    picker.fill_height = flag(props, "fillHeight").then(|| case["rows"].as_u64().unwrap() as u16);
    if let Some(count) = uint(props, "visibleCount") {
        picker.visible_count = count;
    }
    picker.loading = flag(props, "loading");
    picker.confirm_buttons = confirm_buttons(props.get("confirmBar").and_then(|bar| bar.get("buttons")));
    picker.footer = match props.get("footer") {
        None | Some(Value::Null) => Footer::None,
        Some(Value::String(line)) => Footer::text(line),
        Some(Value::Array(lines)) => Footer::Lines(lines.iter().map(footer_input).collect()),
        Some(other) => panic!("footer {other}"),
    };
    let spies = spies(case);
    picker.adjustable = ["onLeft", "onRight", "onTab"].iter().any(|name| spies.contains(&(*name).to_owned()));
    (picker, uint(props, "initialIndex"))
}

fn spies(case: &Value) -> Vec<String> {
    case.get("spies").and_then(Value::as_array).map(|list| list.iter().map(|name| name.as_str().unwrap().to_owned()).collect()).unwrap_or_default()
}

/// The `[name, ...]` calls Node's handlers received, reduced to the names (and the arguments a case compares).
fn node_calls(case: &Value) -> Vec<Value> {
    case["calls"].as_array().cloned().unwrap_or_default()
}

/// One frame to compare: the Rust grid painted for `rows`, and what it took.
type Render<'a> = dyn Fn(&mut Painter) -> u16 + 'a;

fn rust_grid(columns: u16, render: &Render<'_>) -> (u16, Grid) {
    let mut tall = Grid::new(columns, TALL);
    let rows = render(&mut Painter::new(&mut tall));
    let mut grid = Grid::new(columns, rows);
    render(&mut Painter::new(&mut grid));
    (rows, grid)
}

fn compare_frame(golden: &Value, case: &Value, index: usize, render: &Render<'_>, context: &str) -> Grid {
    let columns = case["columns"].as_u64().unwrap() as u16;
    let wide = golden["ambiguousWide"].as_bool().unwrap();
    let expected = grid_from_ink_frame_with(case["frames"][index].as_str().unwrap(), columns, wide);
    let mut tall = Grid::new(columns, TALL);
    let rows = render(&mut Painter::new(&mut tall));
    assert_eq!(rows, expected.height, "{context}: rows\nnode:\n{}", (0..expected.height).map(|y| expected.row_text(y)).collect::<Vec<_>>().join("\n"));
    assert_same_grid(&tall, &expected, context);
    rust_grid(columns, render).1
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

fn key_of(sequence: &str) -> (String, KeyFlags) {
    decode_key(sequence)
}

fn check_spied_calls(case: &Value, rust: &[Vec<Value>], context: &str) {
    let spied = spies(case);
    let expected: Vec<(String, Vec<Value>)> =
        node_calls(case).iter().map(|call| (call[0].as_str().unwrap().to_owned(), call.as_array().unwrap()[1..].to_vec())).collect();
    let actual: Vec<(String, Vec<Value>)> =
        rust.iter().filter(|call| spied.contains(&call[0].as_str().unwrap().to_owned())).map(|call| (call[0].as_str().unwrap().to_owned(), call[1..].to_vec())).collect();
    let names = |list: &[(String, Vec<Value>)]| list.iter().map(|(name, _)| name.clone()).collect::<Vec<_>>();
    assert_eq!(names(&actual), names(&expected), "{context}: the handlers called");
    for ((name, got), (_, want)) in actual.iter().zip(&expected) {
        // The arguments the corpus compares: the value of a chosen row, the copied URL, the answers sent.
        if matches!(name.as_str(), "onSelect" | "copyText" | "onSubmit" | "onHighlight") {
            assert_eq!(got.first(), want.first(), "{context}: the first argument of {name}");
        }
    }
}

fn picker_case(golden: &Value, case: &Value, id: &str) {
    let (props, initial) = picker_props(case);
    let mut state = PickerState::new(&props.items, initial);
    let mut status = CopyStatus::Idle;
    let mut calls: Vec<Vec<Value>> = Vec::new();
    let highlight = |state: &PickerState, calls: &mut Vec<Vec<Value>>| {
        if let Some(item) = props.items.get(state.selected_index) {
            calls.push(vec![json!("onHighlight"), json!(item.value)]);
        }
    };
    highlight(&state, &mut calls);
    let frames = case["frames"].as_array().unwrap();
    for index in 0..frames.len() {
        let context = format!("{id} frame {index}");
        let render = |painter: &mut Painter| paint_picker(painter, 0, 0, &props, state.selected_index, state.confirm_focus, status);
        let grid = compare_frame(golden, case, index, &render, &context);
        compare_levels(golden, case, index, &grid, &context);
        let Some(sequence) = case.get("keys").and_then(|keys| keys.get(index)).and_then(Value::as_str) else { continue };
        let (input, key) = key_of(sequence);
        let before = state.selected_index;
        let context_keys = PickerKeyContext {
            item_count: props.items.len(),
            effective_visible_limit: effective_visible_limit(&props, state.selected_index),
            confirm_buttons: props.confirm_buttons.len(),
            has_detail: !props.detail.trim().is_empty(),
        };
        // The clock only has to be later than the debounce of an earlier tab.
        let now = 10_000 + (index as u64) * 1_000;
        let action = state.handle_key(&input, &key, &context_keys, now);
        let value_of = |at: usize| props.items.get(at).map(|item| item.value.clone());
        match action {
            PickerAction::Select(at) => calls.push(vec![json!("onSelect"), json!(value_of(at))]),
            PickerAction::Cancel => calls.push(vec![json!("onCancel")]),
            PickerAction::Left(_) => calls.push(vec![json!("onLeft")]),
            PickerAction::Right(_) => calls.push(vec![json!("onRight")]),
            PickerAction::Tab(_) => calls.push(vec![json!("onTab")]),
            PickerAction::Confirm(at) => calls.push(vec![json!("confirmBar.onConfirm"), json!(at)]),
            PickerAction::Key(_) => calls.push(vec![json!("onKey")]),
            PickerAction::CopyUrl => {
                calls.push(vec![json!("copyText"), json!(props.detail.trim())]);
                status = copy_url(props.detail.trim(), |_| Ok(CopyMethod::System)).unwrap();
            }
            PickerAction::None => {}
        }
        if state.selected_index != before {
            highlight(&state, &mut calls);
        }
    }
    check_spied_calls(case, &calls, id);
}

fn confirm_bar_case(golden: &Value, case: &Value, id: &str) {
    let props = &case["props"];
    let buttons = confirm_buttons(props.get("buttons"));
    let focused = props.get("focusedIndex").and_then(Value::as_i64).unwrap_or(-1);
    let render = |painter: &mut Painter| paint_confirm_bar(painter, 0, 0, &buttons, focused);
    let grid = compare_frame(golden, case, 0, &render, id);
    compare_levels(golden, case, 0, &grid, id);
}

fn palette_case(golden: &Value, case: &Value, id: &str) {
    let props = &case["props"];
    let commands = props["commands"]
        .as_array()
        .unwrap()
        .iter()
        .map(|command| SlashCommand {
            name: text(command, "name").to_owned(),
            label: text(command, "label").to_owned(),
            usage: text(command, "usage").to_owned(),
            aliases: command.get("aliases").and_then(Value::as_array).map(|list| list.iter().map(|a| a.as_str().unwrap().to_owned()).collect()).unwrap_or_default(),
            alias_usage: command.get("aliasUsage").and_then(Value::as_array).map(|list| list.iter().map(|a| a.as_str().unwrap().to_owned()).collect()).unwrap_or_default(),
            show_alias_usage: command.get("showAliasUsage") != Some(&Value::Bool(false)),
            description: text(command, "description").to_owned(),
        })
        .collect();
    let mut palette = PaletteProps::new(commands);
    palette.selected_index = uint(props, "selectedIndex").unwrap_or(0);
    palette.columns = uint(props, "columns").unwrap();
    palette.query = text(props, "query").to_owned();
    if let Some(title) = props.get("title").and_then(Value::as_str) {
        palette.title = title.to_owned();
    }
    if let Some(description) = props.get("description").and_then(Value::as_str) {
        palette.description = description.to_owned();
    }
    if let Some(help) = props.get("help").and_then(Value::as_str) {
        palette.help = help.to_owned();
    }
    let render = |painter: &mut Painter| paint_palette(painter, 0, 0, &palette);
    let grid = compare_frame(golden, case, 0, &render, id);
    compare_levels(golden, case, 0, &grid, id);
}

fn hint_case(golden: &Value, case: &Value, id: &str) {
    let props = &case["props"];
    let children: Vec<&str> = case["children"].as_array().unwrap().iter().map(|line| line.as_str().unwrap()).collect();
    let columns = uint(props, "columns").unwrap() as u16;
    let tone = props.get("rightTone").and_then(Value::as_str).unwrap_or("info");
    let width = uint(props, "rightMessageWidth").unwrap_or(24) as u16;
    let message = text(props, "rightMessage");
    let render = |painter: &mut Painter| {
        for (row, line) in children.iter().enumerate() {
            painter.line(0, row as i32, line, Style::default());
        }
        let area = Rect::new(0, 0, columns, children.len() as u16);
        paint_item_right_hint(painter, area, 0, children.len() as u16, message, tone, width)
    };
    let grid = compare_frame(golden, case, 0, &render, id);
    compare_levels(golden, case, 0, &grid, id);
}

fn sign_in_case(golden: &Value, case: &Value, id: &str) {
    let props = &case["props"];
    let layout = &props["layout"];
    let layout = SignInUrlLayout {
        compact: flag(layout, "compact"),
        rows: uint(layout, "rows").unwrap(),
        hint: flag(layout, "hint"),
        label: text(layout, "label").to_owned(),
    };
    let status = match text(props, "status") {
        "copied" => CopyStatus::Copied,
        "sent" => CopyStatus::Sent,
        "failed" => CopyStatus::Failed,
        _ => CopyStatus::Idle,
    };
    let url = text(props, "url");
    let columns = uint(props, "columns").unwrap();
    let render = |painter: &mut Painter| paint_sign_in_url(painter, 0, 0, columns, url, &layout, status);
    let grid = compare_frame(golden, case, 0, &render, id);
    compare_levels(golden, case, 0, &grid, id);
}

fn question_case(golden: &Value, case: &Value, id: &str) {
    let props = &case["props"];
    let questions: Vec<Question> = props["questions"].as_array().unwrap().iter().map(Question::from_value).collect();
    let columns = uint(props, "columns").unwrap();
    let rows = uint(props, "rows");
    let mut state = QuestionState::new(&questions);
    let mut calls: Vec<Vec<Value>> = Vec::new();
    let frames = case["frames"].as_array().unwrap();
    for index in 0..frames.len() {
        let context = format!("{id} frame {index}");
        let render = |painter: &mut Painter| paint_question(painter, 0, 0, &questions, &state, columns, rows);
        let grid = compare_frame(golden, case, index, &render, &context);
        compare_levels(golden, case, index, &grid, &context);
        let Some(sequence) = case.get("keys").and_then(|keys| keys.get(index)).and_then(Value::as_str) else { continue };
        let (input, key) = key_of(sequence);
        match state.handle_key(&questions, &input, &key) {
            QuestionAction::Submit(answers) => {
                let list: Vec<Value> = answers.iter().map(|answer| answer.as_ref().map_or(Value::Null, |answer| answer.to_value())).collect();
                calls.push(vec![json!("onSubmit"), Value::Array(list)]);
            }
            QuestionAction::Dismiss => calls.push(vec![json!("onDismiss")]),
            QuestionAction::None => {}
        }
    }
    check_spied_calls(case, &calls, id);
    // The answers sent are compared whole.
    let sent = |list: &[Value]| list.iter().filter(|call| call[0] == "onSubmit").map(|call| call[1].clone()).collect::<Vec<_>>();
    let rust_calls: Vec<Value> = calls.iter().map(|call| Value::Array(call.clone())).collect();
    assert_eq!(sent(&rust_calls), sent(&node_calls(case)), "{id}: the answers sent");
}

fn text_entry_case(golden: &Value, case: &Value, id: &str) {
    let props = &case["props"];
    let mut entry = TextEntryProps::new(text(props, "title"));
    entry.hint = text(props, "hint").to_owned();
    entry.detail = text(props, "detail").to_owned();
    if let Some(rows) = props.get("urlMaxRows").and_then(Value::as_i64) {
        entry.url_max_rows = rows;
    }
    entry.mask = flag(props, "mask");
    entry.multiline = flag(props, "multiline");
    if let Some(rows) = uint(props, "maxContentRows") {
        entry.max_content_rows = rows;
    }
    entry.columns = uint(props, "columns").unwrap();
    if let Some(label) = props.get("actionLabel").and_then(Value::as_str) {
        entry.action_label = label.to_owned();
    }
    if let Some(label) = props.get("promptLabel").and_then(Value::as_str) {
        entry.prompt_label = label.to_owned();
    }
    let mut draft = TextEntryDraft::new(text(props, "initialValue"));
    let frames = case["frames"].as_array().unwrap();
    for index in 0..frames.len() {
        let last = index + 1 == frames.len();
        if index > 0 {
            // Only the draft the keys end with is known (the editing is the editor's), so the frames before it are skipped.
            if !last {
                continue;
            }
            let after = &case["draftAfterKeys"];
            draft.cursor = uint(after, "cursor").unwrap();
            draft.selection_anchor = uint(after, "selectionAnchor");
        }
        let context = format!("{id} frame {index}");
        let render = |painter: &mut Painter| paint_text_entry(painter, 0, 0, &entry, &draft, CopyStatus::Idle);
        let grid = compare_frame(golden, case, index, &render, &context);
        compare_levels(golden, case, index, &grid, &context);
    }
    // onContentRowsChange at mount: one row, or the rows the value reserves.
    let first = node_calls(case).into_iter().find(|call| call[0] == "onContentRowsChange").expect("a content rows call");
    let value = TextEntryDraft::new(text(props, "initialValue")).value;
    let visible: String = if entry.mask { value.chars().map(|ch| if ch == '\n' { "\n".to_owned() } else { "*".repeat(ch.len_utf16()) }).collect() } else { value };
    let reserved = if entry.multiline { text_entry_reserved_rows(&visible, entry.content_cells(), entry.max_content_rows) } else { 1 };
    assert_eq!(first[1], json!(reserved), "{id}: rows reserved");
}

#[test]
fn the_widgets_draw_what_the_node_components_draw() {
    if mixdog_termtext::display_width("\u{2460}") != 2 {
        eprintln!("base_twin: the ambiguous-width policy is off in this process; the recording was made with it on (set MIXDOG_TUI_AMBIGUOUS_WIDE=1)");
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
            "Picker" => picker_case(&golden, case, id),
            "ConfirmBar" => confirm_bar_case(&golden, case, id),
            "SlashCommandPalette" => palette_case(&golden, case, id),
            "ItemRightHintOverprint" => hint_case(&golden, case, id),
            "SignInUrl" => sign_in_case(&golden, case, id),
            "QuestionPanel" => question_case(&golden, case, id),
            "TextEntryPanel" => text_entry_case(&golden, case, id),
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
    assert!(checked >= 200, "the corpus is read: {checked} frame cases");
}

fn int_arg(value: &Value) -> i64 {
    value.as_i64().unwrap_or(0)
}

fn rows_arg(value: &Value) -> Option<usize> {
    value.as_u64().map(|rows| rows as usize)
}

fn draft_of(value: &Value) -> Draft {
    Draft {
        selected: value.get("selected").and_then(Value::as_array).map(|list| list.iter().filter_map(Value::as_u64).map(|n| n as usize).collect()).unwrap_or_default(),
        text: text(value, "text").to_owned(),
    }
}

fn layout_value(layout: &SignInUrlLayout) -> Value {
    json!({ "compact": layout.compact, "rows": layout.rows, "hint": layout.hint, "label": layout.label })
}

fn answer_value(answer: Option<mixdog_tui_widgets::question::Answer>) -> Value {
    answer.map_or(Value::Null, |answer| answer.to_value())
}

/// What the Rust function computes for a `fn` case, in the shape Node's function returned.
fn compute(case: &Value) -> Value {
    let args = case["args"].as_array().unwrap();
    let key = format!("{}.{}", text(case, "module"), text(case, "name"));
    let string = |at: usize| args[at].as_str().unwrap_or("").to_owned();
    let number = |at: usize| args[at].as_u64().unwrap_or(0) as usize;
    match key.as_str() {
        "confirmBar.clampConfirmFocus" => json!(clamp_confirm_focus(args[0].as_i64().unwrap_or(-1), number(1))),
        "pickerLayout.clampLabelWidth" => json!(clamp_label_width(args[0].as_u64().unwrap_or(0) as usize, number(1))),
        "pickerLayout.clampMetaWidth" => json!(clamp_meta_width(args[0].as_u64().map(|n| n as usize), number(1), number(2))),
        "pickerLayout.clampItemIndex" => json!(clamp_item_index(args[0].as_u64().unwrap_or(0) as usize, number(1))),
        "panelCellText.truncatePanelText" => json!(truncate_panel_text(&string(0), number(1))),
        "panelCellText.padPanelCells" => json!(pad_panel_cells(&string(0), number(1))),
        "signInUrlLayout.signInUrlLayout" => {
            let rows = if args[2] == "__Infinity__" { i64::MAX } else { int_arg(&args[2]) };
            layout_value(&sign_in_url_layout(&string(0), number(1), rows))
        }
        "questionModel.answerFor" => answer_value(answer_for(&Question::from_value(&args[0]), &draft_of(&args[1]))),
        "questionModel.buildAnswers" => {
            let questions: Vec<Question> = args[0].as_array().unwrap().iter().map(Question::from_value).collect();
            let drafts: Vec<Draft> = args[1].as_array().unwrap().iter().map(draft_of).collect();
            Value::Array(build_answers(&questions, &drafts).into_iter().map(answer_value).collect())
        }
        "questionModel.optionLayout" => {
            let layout = option_layout(&Question::from_value(&args[0]), number(1));
            json!({
                "rows": layout.rows.iter().map(|row| json!({ "label": row.label, "suffix": row.suffix, "detail": row.detail })).collect::<Vec<_>>(),
                "prefixCells": layout.prefix_cells,
                "avail": layout.avail,
                "indexCells": layout.index_cells,
            })
        }
        "questionModel.planQuestionView" => {
            let view = plan_question_view(&Question::from_value(&args[0]), number(1), rows_arg(&args[2]), number(3));
            json!({
                "qLines": view.q_lines,
                "items": view.items.iter().map(|index| json!({ "index": index, "lines": 1 })).collect::<Vec<_>>(),
                "above": view.above,
                "below": view.below,
            })
        }
        "questionModel.questionPanelRows" => {
            let questions: Vec<Question> = args[0].as_array().unwrap().iter().map(Question::from_value).collect();
            json!(question_panel_rows(&questions, number(1)))
        }
        "questionModel.initialCursor" => json!(initial_cursor(&Question::from_value(&args[0]))),
        "questionModel.questionHelp" => {
            let options = &args[0];
            json!(question_help(flag(options, "multi"), flag(options, "typing"), flag(options, "last"), uint(options, "count").unwrap(), uint(options, "questionCount").unwrap()))
        }
        "questionModel.appendCapped" => json!(append_capped(&string(0), &string(1))),
        "textEntryLayout.windowSingleLine" => {
            let window = window_single_line(&string(0), number(1), number(2));
            json!({ "text": window.text, "cuStart": window.cu_start, "cuEnd": window.cu_end, "caretCol": window.caret_col })
        }
        "textEntryLayout.flattenForSingleLine" => json!(flatten_for_single_line(&string(0))),
        "textEntryLayout.singleLine" => json!(single_line(&string(0))),
        "textLayout.wrappedTextRows" => json!(wrapped_text_rows(&string(0), number(1))),
        "textLayout.wrappedDetailRows" => json!(wrapped_detail_rows(&string(0), number(1))),
        "textLayout.sliceVisualRowWindow" => {
            let window = slice_visual_row_window(&string(0), number(1), number(2), number(3));
            json!({ "slice": window.slice, "sliceStart": window.slice_start, "sliceEnd": window.slice_end, "totalRows": window.total_rows })
        }
        "textLayout.textEntryReservedRows" => json!(text_entry_reserved_rows(&string(0), number(1), number(2))),
        "inputEditing.caretPosition" => {
            let trailing = args.get(3).and_then(Value::as_bool);
            let (row, col) = caret_position(&string(0), number(1), number(2), trailing);
            json!({ "row": row, "col": col })
        }
        "appFormat.cleanRightMessage" => json!(clean_right_message(&string(0))),
        other => panic!("no mapping for the function {other}"),
    }
}

#[test]
fn the_pure_functions_compute_what_the_node_functions_return() {
    let (_, cases) = corpus();
    let mut checked = 0;
    for case in &cases {
        if case["kind"] != "fn" {
            continue;
        }
        assert_eq!(compute(case), case["result"], "{}", case["id"]);
        checked += 1;
    }
    assert!(checked >= 120, "the corpus is read: {checked} function cases");
}
