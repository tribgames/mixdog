//! The Rust shell layout and panel surface against what the Node ones do (tests/goldens/layout.json, recorded by
//! tests/recorders/record-layout.mjs): `computeShellLayout` over a generated grid of terminal sizes, panel kinds and modifiers
//! (every field of the layout object and the refs after it), the row reservation functions, the layout signature grammar, and
//! sequences of panel-surface operations (claims, paints, closes, defers, the usage generation, the Enter latch) replayed
//! step by step.
//!
//! The corpus keeps clear of the ambiguous-width glyphs the Windows display-width policy widens, so the comparison does not
//! depend on the platform the recording was made on.

use mixdog_tui::surface::epoch::PanelValue;
use mixdog_tui::surface::latch::IndexModePanel;
use mixdog_tui::surface::layout::{
    BtwPanel, HintText, LIVE_STATUS_ROWS, PANEL_BASE_ROWS, PANEL_CHROME_ROWS, PANEL_MAX_VISIBLE, PICKER_CHROME_ROWS, PanelTransition,
    PickerLayout, PromptBoxRect, QueuedCommand, SCROLL_HINT_ROWS, SLASH_PALETTE_ROWS, STATUSLINE_ROWS, ShellLayoutInput, ShellRefs, ShellState,
    StreamingTail, TextEntryPrompt, TranscriptTail, WELCOME_BANNER_ROWS, compute_shell_layout,
};
use mixdog_tui::surface::owner::{PanelClaim, PanelSurface, SurfaceEvent, UsageClaim};
use mixdog_tui::surface::prompt_rows::{PromptRowsCache, queued_band_rows};
use mixdog_tui::surface::signature::{is_instant_panel_close_transition, panel_kind_signature, panel_signature_flags};
use mixdog_tui_widgets::picker::IndexMode;
use mixdog_tui_widgets::text_layout::{text_entry_reserved_rows, wrapped_detail_rows};
use serde_json::{Value, json};

const GOLDEN: &str = include_str!("goldens/layout.json");

fn golden() -> Value {
    serde_json::from_str(GOLDEN).expect("the golden parses")
}

fn text(value: &Value, key: &str) -> String {
    value.get(key).and_then(Value::as_str).unwrap_or("").to_owned()
}

fn number(value: &Value, key: &str) -> usize {
    value.get(key).and_then(Value::as_u64).unwrap_or(0) as usize
}

fn flag(value: &Value, key: &str) -> bool {
    value.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn present<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    value.get(key).filter(|inner| !inner.is_null())
}

fn hint(value: Option<&Value>) -> Option<HintText> {
    value.map(|hint| HintText { text: text(hint, "text"), tone: text(hint, "tone") })
}

fn prompt(value: Option<&Value>) -> Option<TextEntryPrompt> {
    value.map(|prompt| TextEntryPrompt { kind: text(prompt, "kind"), detail: text(prompt, "detail") })
}

fn input_of(spec: &Value) -> (ShellLayoutInput, ShellRefs) {
    let state = &spec["state"];
    let items = state["items"].as_array().expect("items");
    let latest_item = items.last().map(|item| TranscriptTail { id: item.get("id").and_then(Value::as_str).map(str::to_owned), kind: text(item, "kind") });
    let queued = state["queued"]
        .as_array()
        .expect("queued")
        .iter()
        .map(|item| QueuedCommand { display_text: text(item, "displayText"), text: text(item, "text") })
        .collect();
    let streaming_tail = present(state, "streamingTail").map(|tail| StreamingTail {
        kind: text(tail, "kind"),
        streaming: flag(tail, "streaming"),
        text: text(tail, "text"),
    });
    let input = ShellLayoutInput {
        provider_prompt: prompt(present(spec, "providerPrompt")),
        settings_prompt: prompt(present(spec, "settingsPrompt")),
        tool_approval: present(spec, "toolApproval").cloned(),
        picker: present(spec, "picker").map(|picker| PickerLayout { kind: text(picker, "kind"), fill_available: flag(picker, "fillAvailable") }),
        context_panel: flag(spec, "contextPanel"),
        usage_panel: flag(spec, "usagePanel"),
        btw_panel: present(spec, "btwPanel").map(|panel| BtwPanel { done: text(panel, "status") == "done", text: text(panel, "text") }),
        slash_palette_open: flag(spec, "slashPaletteOpen"),
        tui_ready: flag(spec, "tuiReady"),
        state: ShellState {
            item_count: items.len(),
            latest_item,
            queued,
            spinner_active: flag(state, "spinner"),
            command_status_active: flag(state, "commandStatus"),
            latest_toast: hint(present(state, "toast")),
            progress_hint: hint(present(state, "progressHint")),
            streaming_tail,
            transcript_view_active: flag(state, "transcriptView"),
        },
        rows: number(spec, "rows"),
        frame_columns: number(spec, "frameColumns"),
        prompt_hint: text(spec, "promptHint"),
        prompt_hint_tone: text(spec, "promptHintTone"),
        text_entry_layout_rows: number(spec, "textEntryLayoutRows"),
        onboarding_active: flag(spec, "onboardingActive"),
        conditional_welcome_prompt_hint: text(spec, "conditionalWelcomePromptHint"),
        welcome_prompt_hint_dismissed: flag(spec, "welcomePromptHintDismissed"),
        welcome_prompt_hint: text(spec, "welcomePromptHintRef"),
        panel_transition_epoch: number(spec, "panelTransitionEpoch") as u64,
        prompt_layout_value: text(spec, "promptValue"),
        prompt_content_columns: number(spec, "promptContentColumns"),
    };
    let panel_transition = present(spec, "transition")
        .map(|transition| PanelTransition {
            signature: text(transition, "signature"),
            reserve: number(transition, "reserve"),
            clear_rows: number(transition, "clearRows"),
            guard_rows: number(transition, "guardRows"),
            epoch: number(transition, "epoch") as u64,
            tail_id: transition.get("tailId").and_then(Value::as_str).map(str::to_owned),
        })
        .unwrap_or_default();
    let refs = ShellRefs {
        panel_transition,
        panel_close_ink_mask_rows: number(spec, "panelCloseInkMaskRows"),
        project_boot_input_latch: flag(spec, "projectBootInputLatch"),
        prompt_box_rect: flag(spec, "promptBoxRect").then_some(PromptBoxRect { x: 1, ..PromptBoxRect::default() }),
        ..ShellRefs::default()
    };
    (input, refs)
}

/// The Rust field name of a Node layout key (`WELCOME_ROWS` is `welcome_rows`, `panelLayoutSignature` is
/// `panel_layout_signature`).
fn snake(key: &str) -> String {
    if key.contains('_') {
        return key.to_ascii_lowercase();
    }
    let mut out = String::new();
    for ch in key.chars() {
        if ch.is_ascii_uppercase() {
            out.push('_');
            out.push(ch.to_ascii_lowercase());
        } else {
            out.push(ch);
        }
    }
    out
}

#[test]
fn the_constants_are_the_ones_node_names() {
    let golden = golden();
    let constants = &golden["constants"];
    for (key, value) in [
        ("SCROLL_HINT_ROWS", SCROLL_HINT_ROWS),
        ("LIVE_STATUS_ROWS", LIVE_STATUS_ROWS),
        ("STATUSLINE_ROWS", STATUSLINE_ROWS),
        ("PANEL_MAX_VISIBLE", PANEL_MAX_VISIBLE),
        ("PANEL_CHROME_ROWS", PANEL_CHROME_ROWS),
        ("PANEL_BASE_ROWS", PANEL_BASE_ROWS),
        ("PICKER_CHROME_ROWS", PICKER_CHROME_ROWS),
        ("WELCOME_BANNER_ROWS", WELCOME_BANNER_ROWS),
        ("SLASH_PALETTE_ROWS", SLASH_PALETTE_ROWS),
    ] {
        assert_eq!(constants[key].as_u64(), Some(value as u64), "{key}");
    }
}

#[test]
fn every_layout_of_the_grid_agrees_with_node() {
    let golden = golden();
    let fields: Vec<&str> = golden["fields"].as_array().expect("fields").iter().map(|field| field.as_str().expect("field name")).collect();
    let cases = golden["layouts"].as_array().expect("layouts");
    assert!(cases.len() > 500, "the grid is there");
    for (index, case) in cases.iter().enumerate() {
        let (input, mut refs) = input_of(&case["input"]);
        let layout = compute_shell_layout(&input, &mut refs);
        let rust = serde_json::to_value(&layout).expect("the layout serialises");
        let label = |what: &str| format!("case {index} {what} (rows {} columns {})", input.rows, input.frame_columns);
        for (field, expected) in fields.iter().zip(case["values"].as_array().expect("values")) {
            assert_eq!(&rust[snake(field)], expected, "{}", label(field));
        }
        let objects = &case["objects"];
        assert_eq!(rust["live_spinner"], objects["liveSpinner"], "{}", label("liveSpinner"));
        assert_eq!(rust["latest_toast"], objects["latestToast"], "{}", label("latestToast"));
        assert_eq!(rust["progress_hint"], objects["progressHint"], "{}", label("progressHint"));
        assert_eq!(rust["latest_transcript_item"], objects["latestTranscriptItem"], "{}", label("latestTranscriptItem"));
        assert_eq!(rust["text_entry_prompt"], objects["textEntryPrompt"], "{}", label("textEntryPrompt"));

        let recorded = &case["refs"];
        assert_eq!(refs.panel_close_ink_mask_rows, number(recorded, "panelCloseInkMaskRows"), "{}", label("panelCloseInkMaskRows"));
        assert_eq!(refs.project_boot_input_latch, flag(recorded, "projectBootInputLatch"), "{}", label("projectBootInputLatch"));
        assert_eq!(refs.welcome_prompt_hint_visible, flag(recorded, "welcomePromptHintVisible"), "{}", label("welcomePromptHintVisible"));
        assert_eq!(refs.transcript_bottom_slack_rows, number(recorded, "transcriptBottomSlackRows"), "{}", label("transcriptBottomSlackRows"));
        let viewport = refs.transcript_viewport.map(|viewport| json!({ "top": viewport.top, "bottom": viewport.bottom }));
        assert_eq!(viewport.unwrap_or(Value::Null), recorded["transcriptViewport"], "{}", label("transcriptViewport"));
        assert_eq!(refs.frame_rows, number(recorded, "frameRows"), "{}", label("frameRows"));
        assert_eq!(refs.prompt_box_rect.is_some(), flag(recorded, "promptBoxRect"), "{}", label("promptBoxRect"));
        let transition = &refs.panel_transition;
        let after = &recorded["transition"];
        assert_eq!(transition.signature, text(after, "signature"), "{}", label("transition.signature"));
        assert_eq!(transition.reserve, number(after, "reserve"), "{}", label("transition.reserve"));
        assert_eq!(transition.clear_rows, number(after, "clearRows"), "{}", label("transition.clearRows"));
        assert_eq!(transition.guard_rows, number(after, "guardRows"), "{}", label("transition.guardRows"));
        assert_eq!(transition.epoch, number(after, "epoch") as u64, "{}", label("transition.epoch"));
        assert_eq!(transition.tail_id.as_deref(), after["tailId"].as_str(), "{}", label("transition.tailId"));
    }
}

#[test]
fn the_row_functions_agree_with_node() {
    let golden = golden();
    let rows = &golden["rows"];
    for case in rows["promptContentRows"].as_array().expect("prompt rows") {
        let (value, width) = (text(case, "text"), number(case, "width"));
        assert_eq!(PromptRowsCache::default().content_rows(&value, width), number(case, "rows"), "promptContentRows {value:?} at {width}");
    }
    for case in rows["queuedBandRows"].as_array().expect("queued rows") {
        let (value, width) = (text(case, "text"), number(case, "width"));
        assert_eq!(queued_band_rows(&value, width), number(case, "rows"), "queuedBandRows {value:?} at {width}");
    }
    for case in rows["wrappedDetailRows"].as_array().expect("detail rows") {
        let (value, width) = (text(case, "text"), number(case, "width"));
        assert_eq!(wrapped_detail_rows(&value, width), number(case, "rows"), "wrappedDetailRows {value:?} at {width}");
    }
    for case in rows["textEntryReservedRows"].as_array().expect("reserved rows") {
        let (value, width, max) = (text(case, "text"), number(case, "width"), number(case, "max"));
        assert_eq!(text_entry_reserved_rows(&value, width, max), number(case, "rows"), "textEntryReservedRows {value:?} at {width} max {max}");
    }
}

#[test]
fn the_signature_grammar_agrees_with_node() {
    let golden = golden();
    let signature = &golden["signature"];
    for case in signature["flags"].as_array().expect("flags") {
        let value = text(case, "signature");
        let flags = panel_signature_flags(&value);
        assert_eq!(flags.slash, flag(&case["flags"], "slash"), "{value:?}");
        assert_eq!(flags.picker_kind, text(&case["flags"], "pickerKind"), "{value:?}");
        assert_eq!(flags.text_kind, text(&case["flags"], "textKind"), "{value:?}");
        assert_eq!(panel_kind_signature(&value), text(case, "kind"), "{value:?}");
    }
    for case in signature["instant"].as_array().expect("instant") {
        let (prev, next, initial) = (text(case, "prev"), text(case, "next"), flag(case, "initial"));
        assert_eq!(is_instant_panel_close_transition(&prev, &next, initial), flag(case, "instant"), "{prev:?} to {next:?} initial {initial}");
    }
}

#[derive(Clone, Debug, PartialEq)]
struct Panel {
    kind: String,
    title: String,
    mode: Option<IndexMode>,
}

impl PanelValue for Panel {
    fn kind(&self) -> &str {
        &self.kind
    }
    fn title(&self) -> &str {
        &self.title
    }
}

impl IndexModePanel for Panel {
    fn index_mode(&self) -> Option<IndexMode> {
        self.mode
    }
    fn with_index_mode(self, mode: IndexMode) -> Self {
        Self { mode: Some(mode), ..self }
    }
}

fn mode_of(name: Option<&str>) -> Option<IndexMode> {
    name.map(|name| match name {
        "always" => IndexMode::Always,
        "auto" => IndexMode::Auto,
        "never" => IndexMode::Never,
        other => panic!("unknown index mode {other}"),
    })
}

fn mode_name(mode: Option<IndexMode>) -> Value {
    match mode {
        None => Value::Null,
        Some(IndexMode::Always) => json!("always"),
        Some(IndexMode::Auto) => json!("auto"),
        Some(IndexMode::Never) => json!("never"),
    }
}

fn panel_of(value: &Value) -> Panel {
    Panel { kind: text(value, "kind"), title: text(value, "title"), mode: mode_of(value.get("indexMode").and_then(Value::as_str)) }
}

fn view(panel: Option<&Panel>) -> Value {
    panel.map_or(Value::Null, |panel| json!({ "kind": panel.kind, "title": panel.title, "indexMode": mode_name(panel.mode) }))
}

#[test]
fn every_surface_sequence_replays_as_node_ran_it() {
    let golden = golden();
    for (n, sequence) in golden["surface"].as_array().expect("sequences").iter().enumerate() {
        let mut surface: PanelSurface<Panel, String, u64> = PanelSurface::new();
        let mut claims: Vec<PanelClaim> = Vec::new();
        let mut usage_claims: Vec<UsageClaim> = Vec::new();
        let mut deferred = Vec::new();
        let mut paints = 0;
        for (index, step) in sequence["steps"].as_array().expect("steps").iter().enumerate() {
            let op = step["op"].as_str().expect("op");
            let claim = number(step, "claim");
            let panel = || panel_of(&step["panel"]);
            let mut result: Option<bool> = None;
            match op {
                "set" => surface.set_picker(Some(panel())),
                "setNull" => surface.set_picker(None),
                "rebuild" => surface.update_picker(|previous| previous.cloned()),
                "claim" => claims.push(surface.claim()),
                "enter" => surface.with_enter_latch(number(step, "at") as u64, |surface| surface.set_picker(Some(panel()))),
                "tick" => surface.tick(number(step, "to") as u64),
                "render" => surface.commit_render(),
                "supersede" => {
                    surface.supersede();
                }
                "claimUsage" => usage_claims.push(surface.claim_usage()),
                "closeUsage" => surface.close_usage(),
                "paintUsage" => result = Some(usage_claims[claim].paint(&mut surface, Some(number(step, "value") as u64))),
                "paint" => result = Some(claims[claim].paint(&mut surface, Some(panel()))),
                "paintNull" => result = Some(claims[claim].paint(&mut surface, None)),
                "context" => result = Some(claims[claim].context(&mut surface, Some(text(step, "value")))),
                "contextNull" => result = Some(claims[claim].context(&mut surface, None)),
                "close" => result = Some(claims[claim].close(&mut surface)),
                "defer" => deferred.push((claim, claims[claim].defer())),
                "run" => {
                    let (owner, token) = deferred[number(step, "deferred")];
                    result = Some(claims[owner].run_deferred(&surface, token, || ()).is_some());
                }
                other => panic!("unknown operation {other}"),
            }
            paints += surface.take_events().iter().filter(|event| matches!(event, SurfaceEvent::Picker(_))).count();
            let label = format!("sequence {n} step {index} ({op})");
            if let Some(result) = result {
                assert_eq!(Some(result), step["result"].as_bool(), "{label} result");
            }
            assert_eq!(view(surface.picker()), step["picker"], "{label} picker");
            assert_eq!(view(surface.live_picker()), step["live"], "{label} live picker");
            assert_eq!(surface.context().map_or(Value::Null, |context| json!(context)), step["context"], "{label} context");
            assert_eq!(surface.usage().map_or(Value::Null, |usage| json!(usage)), step["usage"], "{label} usage");
            assert_eq!(surface.epoch().current(), step["epoch"].as_u64().expect("epoch"), "{label} epoch");
            assert_eq!(surface.latch().is_armed(), flag(step, "latch"), "{label} latch");
            assert_eq!(paints as u64, step["paints"].as_u64().expect("paints"), "{label} paints");
        }
    }
}
