//! The Rust application view against what the Node one draws (tests/goldens/app_view.json, recorded by
//! tests/recorders/record-app-view.mjs from tests/cases/app_view.json):
//!
//! * the composed screens: `renderAppView` of App rendered with Ink at 80x24, 120x40 and 60x20 for an empty session, a
//!   streaming turn with the spinner and a toast, a picker, a question panel, a plain approval, queued commands, a long
//!   transcript scrolled and at its tail, the slash palette, the two text entries and wide glyphs. Every cell (glyph, width,
//!   style, link) and the cell the hardware cursor is parked at are compared;
//! * the pure functions of `app-format.mjs` and `text-entry-labels.mjs` the view uses.
//!
//! The recording was made with the ambiguous-width policy on, so the screens are only comparable when this process has it on
//! too (Windows, or `MIXDOG_TUI_AMBIGUOUS_WIDE=1`); with it off the screen test says so and stops. The theme is global, so the
//! tests that set it run one at a time.

use std::sync::Mutex;

use mixdog_term::frame::{Color, CursorPos, Grid, Style};
use mixdog_term::paint::Painter;
use mixdog_term::testing::grid_from_ink_frame_with;
use mixdog_tui::editor::Draft;
use mixdog_tui::surface::layout::{
    HintText, PickerLayout, QueuedCommand, ShellLayoutInput, ShellRefs, ShellState, StreamingTail, TextEntryPrompt, TranscriptTail, compute_shell_layout,
};
use mixdog_tui::transcript::window::heights::ItemHeights;
use mixdog_tui::transcript::window::render_window::RenderWindow;
use mixdog_tui::transcript::window::row_index::Items;
use mixdog_tui::transcript::window::visible_items::{overlay_hint_placement, visible_transcript_items};
use mixdog_tui::view::format::{center_line, provider_setup_has_usable_provider, tool_approval_description};
use mixdog_tui::view::labels::{provider_prompt_fields, settings_prompt_fields};
use mixdog_tui::view::panel::{PanelSlots, PaletteSlot, PickerSlot, TextEntrySlot, ToolApprovalSlot, fit_picker};
use mixdog_tui::view::rows::{MountInput, mount_rows};
use mixdog_tui::view::spinner::{LiveSpinner, SpinnerContext, spinner_props};
use mixdog_tui::view::{AppViewProps, render_app};
use mixdog_tui_style::set_theme;
use mixdog_tui_style::spinner_meta::Quiet;
use mixdog_tui_style::theme_color;
use mixdog_tui_widgets::Line;
use mixdog_tui_widgets::hint_overprint::prompt_status_key;
use mixdog_tui_widgets::palette::SlashCommand;
use mixdog_tui_widgets::picker::{PickerItem, PickerProps};
use mixdog_tui_widgets::sign_in_url::CopyStatus;
use mixdog_tui_widgets::spinner::{SpinnerProgress, render_spinner};
use mixdog_tui_widgets::statusline::{LocalLineArgs, build_local_snap_line};
use mixdog_tui_widgets::text_entry::TextEntryDraft;
use serde_json::{Value, json};

const GOLDEN: &str = include_str!("goldens/app_view.json");
const CASES: &str = include_str!("cases/app_view.json");

/// The clock of the recording, and the version the checkout it was made from has.
const NOW: f64 = 1_700_000_000_000.0;
const VERSION: &str = "1.4.5";

static THEME: Mutex<()> = Mutex::new(());

fn ambiguous_wide() -> bool {
    mixdog_termtext::display_width("\u{2460}") == 2
}

fn corpus() -> Vec<Value> {
    let golden: Value = serde_json::from_str(GOLDEN).expect("the golden parses");
    let cases: Vec<Value> = serde_json::from_str(CASES).expect("the cases parse");
    cases
        .into_iter()
        .map(|mut case| {
            let recorded = golden["cases"].as_array().unwrap().iter().find(|entry| entry["id"] == case["id"]).expect("a recording of every case");
            for key in ["frame", "cursor", "result"] {
                if let Some(value) = recorded.get(key) {
                    case[key] = value.clone();
                }
            }
            case
        })
        .collect()
}

fn plain_style(style: Style) -> Style {
    let plain = |color: Color| match color {
        Color::Literal(rgb) => Color::Rgb(rgb),
        other => other,
    };
    Style { fg: plain(style.fg), bg: plain(style.bg), ..style }
}

fn rows_of(grid: &Grid) -> Vec<String> {
    (0..grid.height).map(|y| grid.row_text(y)).collect()
}

/// Every cell is the same glyph in the same style under the same link (a continuation cell only has to be one: Ink writes no
/// bytes for it, so its style cannot be read back from a frame).
fn assert_same_grid(actual: &Grid, expected: &Grid, context: &str) {
    assert_eq!(actual.width, expected.width, "{context}: width");
    assert_eq!(actual.height, expected.height, "{context}: rows\nrust: {:#?}\nnode: {:#?}", rows_of(actual), rows_of(expected));
    for y in 0..expected.height {
        for x in 0..expected.width {
            let (a, e) = (actual.cell(x, y).unwrap(), expected.cell(x, y).unwrap());
            if a.is_continuation() || e.is_continuation() {
                assert_eq!(a.is_continuation(), e.is_continuation(), "{context}: continuation at ({x}, {y})\nrust: {}\nnode: {}", actual.row_text(y), expected.row_text(y));
                continue;
            }
            assert_eq!((a.text(), a.width), (e.text(), e.width), "{context}: glyph at ({x}, {y})\nrust: {}\nnode: {}", actual.row_text(y), expected.row_text(y));
            assert_eq!(plain_style(a.style), plain_style(e.style), "{context}: style at ({x}, {y}) of {:?}", e.text());
            assert_eq!(actual.link_url(a.link), expected.link_url(e.link), "{context}: link at ({x}, {y})");
        }
    }
}

fn text(value: &Value, key: &str) -> String {
    value.get(key).and_then(Value::as_str).unwrap_or("").to_owned()
}

fn number(value: &Value, key: &str) -> f64 {
    value.get(key).and_then(Value::as_f64).unwrap_or(0.0)
}

fn present<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    value.get(key).filter(|inner| !inner.is_null())
}

/// What one scene of the cases becomes: the owned pieces the props borrow.
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
            .map(|panel| panel["commands"].as_array().unwrap().iter().map(|command| SlashCommand::new(&text(command, "name"), &text(command, "description"))).collect())
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
        let latest_item = self.items.last().map(|item| TranscriptTail { id: item.get("id").and_then(Value::as_str).map(str::to_owned), kind: text(item, "kind") });
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
    let window = RenderWindow { start_index: 0, end_index: scene.items.len(), bottom_spacer_rows: 0, total_rows: 0, max_scroll_rows: 0, effective_scroll_offset: scene.scroll_offset };
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
        let props = spinner_props(&SpinnerContext { live, thinking: false, effort: "high", web_search_active: false, approval_pending: scene.request.is_some(), busy: true, spinner_active: true, columns: layout.prompt_spinner_columns });
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

#[test]
fn the_composed_screens_are_what_the_node_app_draws_cell_by_cell_cursor_included() {
    if !ambiguous_wide() {
        eprintln!("the screens were recorded with the ambiguous-width policy on; this process has it off");
        return;
    }
    let _theme = THEME.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    set_theme("basic");
    let mut checked = 0;
    for case in corpus().iter().filter(|case| case["kind"] == "screen") {
        let id = case["id"].as_str().unwrap();
        let columns = case["columns"].as_u64().unwrap() as u16;
        let (grid, cursor) = render_screen(case);
        let expected = grid_from_ink_frame_with(case["frame"].as_str().unwrap(), columns, true);
        assert_same_grid(&grid, &expected, id);
        let node_cursor = present(case, "cursor").map(|cell| CursorPos { col: cell["x"].as_u64().unwrap() as u16, row: cell["y"].as_u64().unwrap() as u16 });
        assert_eq!(cursor, node_cursor, "{id}: the hardware cursor");
        checked += 1;
    }
    assert!(checked >= 40, "the corpus is read: {checked}");
}

#[test]
fn the_pure_functions_of_the_shell_are_what_the_node_modules_return() {
    let _theme = THEME.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    set_theme("basic");
    let mut checked = 0;
    for case in corpus().iter().filter(|case| case["kind"] == "fn") {
        let id = case["id"].as_str().unwrap();
        let args = case["args"].as_array().unwrap();
        let expected = &case["result"];
        let actual = match (case["module"].as_str().unwrap(), case["name"].as_str().unwrap()) {
            ("appFormat", "centerLine") => json!(center_line(args[0].as_str().unwrap(), args[1].as_u64().unwrap() as usize, args[2].as_u64().unwrap() as usize)),
            ("appFormat", "promptStatusColor") => json!(theme_color(prompt_status_key(args[0].as_str().unwrap())).css()),
            ("appFormat", "toolApprovalDescription") => json!(tool_approval_description(&args[0])),
            ("appFormat", "providerSetupHasUsableProvider") => json!(provider_setup_has_usable_provider(&args[0])),
            ("textEntryLabels", "providerPromptFields") => {
                let fields = provider_prompt_fields(&args[0]);
                json!({ "title": fields.title, "hint": fields.hint, "promptLabel": fields.prompt_label })
            }
            ("textEntryLabels", "settingsPromptFields") => {
                let fields = settings_prompt_fields(args[0].as_str().unwrap());
                json!({ "actionLabel": fields.action_label, "promptLabel": fields.prompt_label })
            }
            (module, name) => panic!("{id}: no Rust function for {module}.{name}"),
        };
        assert_eq!(&actual, expected, "{id}");
        checked += 1;
    }
    assert!(checked >= 40, "the corpus is read: {checked}");
}
