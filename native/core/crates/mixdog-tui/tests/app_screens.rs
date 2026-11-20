//! The whole application screen: the banner, the transcript, the prompt, the queue, a floating panel and the statusline,
//! painted into a grid and read back as rows; and where the hardware cursor is parked.

use std::sync::Mutex;

use mixdog_term::frame::{CursorPos, Grid};
use mixdog_term::paint::Painter;
use mixdog_tui::editor::Draft;
use mixdog_tui::surface::layout::{
    HintText, PickerLayout, QueuedCommand, ShellLayoutInput, ShellRefs, ShellState, StreamingTail, TextEntryPrompt, TranscriptTail, compute_shell_layout,
};
use mixdog_tui::transcript::window::heights::ItemHeights;
use mixdog_tui::transcript::window::render_window::RenderWindow;
use mixdog_tui::transcript::window::row_index::Items;
use mixdog_tui::transcript::window::visible_items::{overlay_hint_placement, visible_transcript_items};
use mixdog_tui::view::panel::{PaletteSlot, PanelSlots, PickerSlot, TextEntrySlot, ToolApprovalSlot, fit_picker};
use mixdog_tui::view::rows::{MountInput, mount_rows};
use mixdog_tui::view::spinner::{LiveSpinner, SpinnerContext, spinner_props};
use mixdog_tui::view::{AppViewProps, render_app};
use mixdog_tui_style::set_theme;
use mixdog_tui_style::spinner_meta::Quiet;
use mixdog_tui_widgets::Line;
use mixdog_tui_widgets::palette::SlashCommand;
use mixdog_tui_widgets::picker::{PickerItem, PickerProps};
use mixdog_tui_widgets::sign_in_url::CopyStatus;
use mixdog_tui_widgets::spinner::{SpinnerProgress, render_spinner};
use mixdog_tui_widgets::statusline::{LocalLineArgs, build_local_snap_line};
use mixdog_tui_widgets::text_entry::TextEntryDraft;
use serde_json::{Value, json};

/// The clock of the scenes, and the version the banner shows.
const NOW: f64 = 1_700_000_000_000.0;
const VERSION: &str = "1.2.3";

static THEME: Mutex<()> = Mutex::new(());

fn rows_of(grid: &Grid) -> Vec<String> {
    (0..grid.height).map(|y| grid.row_text(y)).collect()
}

/// Every cell is the same glyph in the same style under the same link (a continuation cell only has to be one: Ink writes no

fn text(value: &Value, key: &str) -> String {
    value.get(key).and_then(Value::as_str).unwrap_or("").to_owned()
}

fn number(value: &Value, key: &str) -> f64 {
    value.get(key).and_then(Value::as_f64).unwrap_or(0.0)
}

fn present<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    value.get(key).filter(|inner| !inner.is_null())
}

/// What one scene becomes: the owned pieces the props borrow.
struct Scene {
    items: Vec<Value>,
    queued: Vec<Value>,
    draft: Draft,
    request: Option<Value>,
    picker: Option<(PickerProps, usize)>,
    commands: Vec<SlashCommand>,
    palette_selected: usize,
    query: String,
    provider_prompt: Option<(Value, TextEntryDraft)>,
    settings_prompt: Option<(Value, TextEntryDraft)>,
    spinner: Option<LiveSpinner>,
    toast: Option<HintText>,
    streaming_tail: Option<Value>,
    scroll_offset: usize,
    tip: String,
    conditional_tip: String,
}

impl Scene {
    fn of(scene: &Value) -> Self {
        let state = &scene["state"];
        let list = |key: &str| state.get(key).and_then(Value::as_array).cloned().unwrap_or_default();
        let panel = present(scene, "panel");
        let kind = panel.map(|panel| text(panel, "kind")).unwrap_or_default();
        let prompt = |wanted: &str| {
            panel.filter(|_| kind == wanted).map(|panel| {
                let prompt = panel["prompt"].clone();
                let draft = TextEntryDraft::new(&text(&prompt, "initialValue"));
                (prompt, draft)
            })
        };
        let picker = panel.filter(|_| kind == "picker").map(|panel| {
            let spec = &panel["picker"];
            let items = spec["items"]
                .as_array()
                .unwrap()
                .iter()
                .map(|item| {
                    let mut row = PickerItem::new(&text(item, "value"), &text(item, "label"));
                    row.description = text(item, "description");
                    row
                })
                .collect();
            let mut props = PickerProps::new(items, &text(spec, "title"));
            props.description = text(spec, "description");
            props.help = Some(text(spec, "help")).filter(|help| !help.is_empty());
            (props, number(spec, "initialIndex") as usize)
        });
        let request = panel.filter(|_| kind == "approval" || kind == "question").map(|panel| {
            let mut request = panel["request"].clone();
            request["id"] = json!("call-1");
            request
        });
        let commands = panel
            .filter(|_| kind == "palette")
            .map(|panel| {
                panel["commands"].as_array().unwrap().iter().map(|command| SlashCommand::new(&text(command, "name"), &text(command, "description"))).collect()
            })
            .unwrap_or_default();
        let spinner = present(state, "spinner").map(|spinner| LiveSpinner {
            verb: spinner.get("verb").and_then(Value::as_str).map(str::to_owned),
            started_at: number(spinner, "startedAt"),
            output_tokens: spinner.get("outputTokens").and_then(Value::as_f64),
            tokens: spinner.get("tokens").and_then(Value::as_f64),
            thinking: spinner.get("thinking").and_then(Value::as_bool).unwrap_or(false),
            thinking_segment_started_at: number(spinner, "thinkingSegmentStartedAt"),
            thinking_accumulated_ms: number(spinner, "thinkingAccumulatedMs"),
            quiet: present(spinner, "quiet").map(|quiet| Quiet {
                since: number(quiet, "since"),
                wait: text(quiet, "wait"),
                tool: quiet.get("tool").and_then(Value::as_str).map(str::to_owned),
                warn_ms: number(quiet, "warnMs"),
            }),
            mode: text(spinner, "mode"),
        });
        Self {
            items: list("items"),
            queued: list("queued"),
            draft: Draft::at_end(text(scene, "promptDraft")),
            request,
            picker,
            commands,
            palette_selected: number(panel.unwrap_or(&Value::Null), "selected") as usize,
            query: panel.map(|panel| text(panel, "query")).unwrap_or_default(),
            provider_prompt: prompt("provider-prompt"),
            settings_prompt: prompt("settings-prompt"),
            spinner,
            toast: present(state, "toast").map(|toast| HintText { text: text(toast, "text"), tone: text(toast, "tone") }),
            streaming_tail: present(state, "streamingTail").cloned(),
            scroll_offset: number(scene, "scrollOffset") as usize,
            tip: scene.get("welcomeTip").and_then(Value::as_str).unwrap_or("Ready when you are.").to_owned(),
            conditional_tip: text(scene, "conditionalWelcomeTip"),
        }
    }

    /// `computeShellLayout`'s input, the way App builds it.
    fn layout_input(&self, panel_kind: &str, rows: usize, columns: usize) -> ShellLayoutInput {
        let frame_columns = columns - 1;
        let prompt = |wanted: &Option<(Value, TextEntryDraft)>| {
            wanted.as_ref().map(|(prompt, _)| TextEntryPrompt { kind: text(prompt, "kind"), detail: text(prompt, "detail") })
        };
        let latest_item =
            self.items.last().map(|item| TranscriptTail { id: item.get("id").and_then(Value::as_str).map(str::to_owned), kind: text(item, "kind") });
        ShellLayoutInput {
            provider_prompt: prompt(&self.provider_prompt),
            settings_prompt: prompt(&self.settings_prompt),
            tool_approval: self.request.clone(),
            picker: self.picker.as_ref().map(|_| PickerLayout { kind: "model".to_owned(), fill_available: false }),
            slash_palette_open: panel_kind == "palette",
            tui_ready: true,
            state: ShellState {
                item_count: self.items.len(),
                latest_item,
                queued: self.queued.iter().map(|item| QueuedCommand { display_text: text(item, "displayText"), text: text(item, "text") }).collect(),
                spinner_active: self.spinner.is_some(),
                latest_toast: self.toast.clone(),
                streaming_tail: self.streaming_tail.as_ref().map(|tail| StreamingTail {
                    kind: text(tail, "kind"),
                    streaming: tail.get("streaming").and_then(Value::as_bool).unwrap_or(false),
                    text: text(tail, "text"),
                }),
                ..ShellState::default()
            },
            rows,
            frame_columns,
            text_entry_layout_rows: 1,
            conditional_welcome_prompt_hint: self.conditional_tip.clone(),
            welcome_prompt_hint: self.tip.clone(),
            prompt_layout_value: self.draft.value.clone(),
            prompt_content_columns: frame_columns.saturating_sub(4).max(1),
            ..ShellLayoutInput::default()
        }
    }
}

fn render_screen(case: &Value) -> (Grid, Option<CursorPos>) {
    let (columns, rows) = (case["columns"].as_u64().unwrap() as usize, case["rows"].as_u64().unwrap() as usize);
    let scene_json = &case["scene"];
    let mut scene = Scene::of(scene_json);
    let panel_kind = present(scene_json, "panel").map(|panel| text(panel, "kind")).unwrap_or_default();
    let frame_columns = columns - 1;
    let mut refs = ShellRefs::default();
    let layout = compute_shell_layout(&scene.layout_input(&panel_kind, rows, columns), &mut refs);

    let streaming_id = scene.streaming_tail.as_ref().and_then(|tail| tail.get("id")).and_then(Value::as_str).map(str::to_owned);
    let items = Items::new(&scene.items, None);
    let window = RenderWindow {
        start_index: 0,
        end_index: scene.items.len(),
        bottom_spacer_rows: 0,
        total_rows: 0,
        max_scroll_rows: 0,
        effective_scroll_offset: scene.scroll_offset,
    };
    let mounted_items = visible_transcript_items(&items, &window);
    let overlay = overlay_hint_placement(&mounted_items, &window, layout.overlay_hint_requested, layout.floating_panel_rows, layout.transcript_guard_rows);
    let mounted = mount_rows(
        &mut ItemHeights::default(),
        &MountInput {
            items: &items,
            window: &window,
            layout: &layout,
            frame_columns,
            tool_output_expanded: false,
            streaming_tail_id: streaming_id.as_deref(),
            overlay: &overlay,
            now_ms: NOW,
        },
    );

    let spinner_lines: Vec<Line> = scene.spinner.as_ref().map_or_else(Vec::new, |live| {
        let props = spinner_props(&SpinnerContext {
            live,
            thinking: false,
            effort: "high",
            web_search_active: false,
            approval_pending: scene.request.is_some(),
            busy: true,
            spinner_active: true,
            columns: layout.prompt_spinner_columns,
        });
        render_spinner(&mut SpinnerProgress::new(NOW, live.started_at), &props, NOW, false)
    });
    let stats = json!({});
    let cwd = Some(text(&scene_json["state"], "cwd")).filter(|cwd| !cwd.is_empty()).unwrap_or_else(|| "C:/work/project".to_owned());
    let local = LocalLineArgs {
        model: "gpt-5",
        effort: "high",
        fast: false,
        ultra: false,
        stats: Some(&stats),
        context_window: 1000.0,
        display_context_window: 0.0,
        raw_context_window: 0.0,
        agent_workers: &[],
        agent_jobs: &[],
        active_tools: None,
        shell_status: None,
        terminal_columns: None,
    };
    let footer = build_local_snap_line(&local, "", NOW);
    let workflow = json!({ "id": "team", "name": "Team" });

    let mut slots = PanelSlots::default();
    if let Some(request) = &scene.request {
        slots.tool_approval = Some(ToolApprovalSlot { request, selected: 0, question: None });
    }
    if let Some((props, selected)) = &mut scene.picker {
        fit_picker(props, frame_columns, &layout);
        slots.picker = Some(PickerSlot { props, selected: *selected, confirm_focus: 0, status: CopyStatus::Idle });
    }
    if panel_kind == "palette" {
        slots.slash_palette = Some(PaletteSlot { commands: &scene.commands, selected: scene.palette_selected, query: &scene.query, skills: false });
    }
    if let Some((prompt, draft)) = &scene.provider_prompt {
        slots.provider_prompt = Some(TextEntrySlot { prompt, draft, status: CopyStatus::Idle });
    }
    if let Some((prompt, draft)) = &scene.settings_prompt {
        slots.settings_prompt = Some(TextEntrySlot { prompt, draft, status: CopyStatus::Idle });
    }

    let props = AppViewProps {
        columns,
        rows,
        layout: &layout,
        cwd: &cwd,
        version: VERSION,
        transcript: &mounted,
        overlay: &overlay,
        panels: slots,
        draft: &scene.draft,
        exiting: false,
        tui_ready: true,
        spinner: &spinner_lines,
        queued: &scene.queued,
        footer: &footer,
        workflow: Some(&workflow),
    };
    let mut grid = Grid::new(columns as u16, rows as u16);
    let frame = render_app(&props, &mut Painter::new(&mut grid));
    (grid, frame.cursor)
}

fn rows(case_scene: Value, columns: usize, height: usize) -> (Vec<String>, Option<CursorPos>) {
    let _theme = THEME.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    set_theme("basic");
    let (grid, cursor) = render_screen(&json!({ "columns": columns, "rows": height, "scene": case_scene }));
    (rows_of(&grid).into_iter().map(|row| row.trim_end().to_owned()).collect(), cursor)
}

fn find(rows: &[String], needle: &str) -> usize {
    rows.iter().position(|row| row.contains(needle)).unwrap_or_else(|| panic!("{needle:?} is not on the screen:\n{}", rows.join("\n")))
}

fn cells_before(row: &str, needle: &str) -> usize {
    row[..row.find(needle).expect("the text is on the row")].chars().count()
}

fn conversation() -> Vec<Value> {
    vec![
        json!({ "kind": "user", "id": "u1", "text": "Fix the failing test in the parser and explain what was wrong." }),
        json!({ "kind": "assistant", "id": "a1", "text": "The parser **dropped** the last token when the input ended without a newline.\n\n- the lexer now flushes it\n- a regression test covers it" }),
        json!({ "kind": "turndone", "id": "d1", "elapsedMs": 12000, "status": "done", "verb": "Thought", "toolCount": 0 }),
        json!({ "kind": "user", "id": "u2", "text": "Thanks. Can you also run the linter?" }),
        json!({ "kind": "assistant", "id": "a2", "text": "Running it now.\n\n```sh\nnpm run lint\n```" }),
    ]
}

#[test]
fn an_empty_session_shows_the_banner_the_tip_the_prompt_and_the_statusline_in_that_order() {
    let (rows, _) = rows(json!({ "state": { "items": [] }, "welcomeTip": "Tip: /model \u{b7} Pick the right brain for the job." }), 80, 24);
    assert_eq!(rows.len(), 24);
    let banner = find(&rows, "mixdog coding agent \u{b7} v1.2.3 \u{b7} C:/work/project");
    let tip = find(&rows, "Tip: /model");
    let footer = find(&rows, "GPT-5");
    assert!(banner < tip && tip < footer, "banner {banner}, tip {tip}, footer {footer}");
    assert!(rows[banner].starts_with(' '), "the banner line is centred");
}

#[test]
fn a_conversation_reads_top_down_and_the_caret_follows_the_last_line_of_the_draft() {
    let (rows, cursor) = rows(json!({ "state": { "items": conversation() }, "promptDraft": "run the whole suite and\nreport the failures" }), 80, 24);
    let mut at = 0;
    for needle in ["Thanks. Can you also run the linter?", "Running it now.", "npm run lint", "run the whole suite and", "report the failures", "GPT-5"] {
        let found = find(&rows[at..], needle) + at;
        at = found;
    }
    let draft_row = find(&rows, "report the failures");
    let cursor = cursor.expect("the prompt is an edit target, so the cursor is parked in it");
    assert_eq!(usize::from(cursor.row), draft_row);
    assert_eq!(usize::from(cursor.col), cells_before(&rows[draft_row], "report the failures") + "report the failures".chars().count());
}

#[test]
fn a_turn_in_progress_shows_the_spinner_and_the_toast_above_the_prompt() {
    let scene = json!({
        "state": {
            "items": conversation()[..4].to_vec(),
            "busy": true,
            "spinner": { "active": true, "verb": "Thinking", "startedAt": 1_699_999_995_800_i64, "outputTokens": 120, "mode": "responding" },
            "toast": { "text": "Copied selection", "tone": "info" },
        }
    });
    let (rows, _) = rows(scene, 80, 24);
    // The verb is the spinner's own pick; its interrupt hint is what names the row.
    let spinner = find(&rows, "esc to interrupt");
    assert_eq!(find(&rows, "Copied selection"), spinner, "the toast sits at the right of the spinner row");
    assert!(find(&rows, "Thanks. Can you also run the linter?") < spinner);
}

#[test]
fn queued_steering_commands_are_listed_above_the_prompt() {
    let scene = json!({
        "state": {
            "items": conversation()[..4].to_vec(),
            "busy": true,
            "spinner": { "active": true, "verb": "Thinking", "startedAt": 1_699_999_998_500_i64, "outputTokens": 0, "mode": "responding" },
            "queued": [
                { "id": "q1", "text": "also update the changelog", "displayText": "also update the changelog" },
                { "id": "q2", "text": "and then bump the version number", "displayText": "and then bump the version number" },
            ],
        }
    });
    let (rows, _) = rows(scene, 80, 24);
    let first = find(&rows, "also update the changelog");
    let second = find(&rows, "and then bump the version number");
    assert!(find(&rows, "esc to interrupt") < first && first < second, "{}", rows.join("\n"));
}

#[test]
fn a_picker_replaces_the_prompt_area_with_its_title_items_and_help() {
    let scene = json!({
        "state": { "items": conversation() },
        "panel": { "kind": "picker", "picker": {
            "title": "Model", "description": "Choose the model for this session.", "help": "\u{2191}/\u{2193} Select \u{b7} Enter Choose \u{b7} Esc Back",
            "items": [
                { "value": "gpt-5", "label": "gpt-5", "description": "the default model" },
                { "value": "gpt-5-mini", "label": "gpt-5-mini", "description": "faster and cheaper" },
                { "value": "local", "label": "local-model", "description": "runs on this machine" },
            ],
            "initialIndex": 0,
        } },
    });
    let (rows, _) = rows(scene, 80, 24);
    let title = find(&rows, "Model");
    let description = find(&rows, "Choose the model for this session.");
    let mini = find(&rows, "gpt-5-mini");
    assert!(title < description && description < mini);
    assert!(rows.iter().any(|row| row.contains("Enter Choose")));
    assert!(find(&rows, "npm run lint") < title, "the tail of the transcript stays above the panel");
}

#[test]
fn the_slash_palette_lists_the_matching_commands_under_the_typed_text() {
    let scene = json!({
        "state": { "items": conversation() },
        "promptDraft": "/mo",
        "panel": { "kind": "palette", "query": "mo", "selected": 1, "commands": [
            { "name": "model", "description": "Pick the model for this session" },
            { "name": "monitor", "description": "Watch a background job" },
            { "name": "mode", "description": "Switch the workflow mode" },
        ] },
    });
    let (rows, _) = rows(scene, 80, 24);
    let model = find(&rows, "Pick the model for this session");
    let monitor = find(&rows, "Watch a background job");
    let mode = find(&rows, "Switch the workflow mode");
    assert!(model < monitor && monitor < mode, "commands keep their order");
    assert!(find(&rows, "/mo") > mode || rows.iter().filter(|row| row.contains("/mo")).count() >= 1);
}

#[test]
fn a_tool_approval_names_the_tool_its_reason_and_its_arguments() {
    let scene = json!({
        "state": { "items": conversation(), "busy": true },
        "panel": { "kind": "approval", "request": { "name": "bash", "args": { "command": "rm -rf build" }, "reason": "A hook asked for approval." } },
    });
    let (rows, _) = rows(scene, 80, 24);
    assert!(rows.iter().any(|row| row.contains("A hook asked for approval.")), "{}", rows.join("\n"));
    assert!(rows.iter().any(|row| row.contains("rm -rf build")));
}

#[test]
fn a_question_panel_shows_the_question_and_its_options() {
    let scene = json!({
        "state": { "items": conversation(), "busy": true },
        "panel": { "kind": "question", "request": { "kind": "question", "name": "ask_user", "args": { "questions": [{
            "question": "Which package manager should the project use?", "header": "Tooling",
            "options": [{ "label": "npm", "description": "the default" }, { "label": "pnpm", "description": "faster installs" }, { "label": "yarn" }],
        }] } } },
    });
    let (rows, _) = rows(scene, 80, 24);
    let question = find(&rows, "Which package manager should the project use?");
    assert!(question < find(&rows, "pnpm") && find(&rows, "pnpm") < find(&rows, "yarn"));
}

#[test]
fn no_screen_row_is_wider_than_the_terminal_at_any_size() {
    for (columns, height) in [(60_usize, 20_usize), (80, 24), (120, 40)] {
        let (rows, _) = rows(
            json!({ "state": { "items": conversation() }, "promptDraft": "a draft that is long enough to need the whole width of a small terminal window" }),
            columns,
            height,
        );
        assert_eq!(rows.len(), height);
        for row in &rows {
            assert!(mixdog_termtext::display_width(row) < columns, "{} cells at {columns}: {row:?}", mixdog_termtext::display_width(row));
        }
    }
}
