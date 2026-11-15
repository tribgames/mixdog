//! The panel surface and the shell layout through the crate's public API: every case of `shell-layout.test.mjs`, and the
//! ownership and handover cases of `panel-epoch.test.mjs` and `panel-handoff.test.mjs` that do not need a picker factory
//! (the picker-specific ones are the pickers' own tests). The unit tests of each module sit beside it.

use mixdog_tui::surface::epoch::PanelValue;
use mixdog_tui::surface::latch::IndexModePanel;
use mixdog_tui::surface::layout::{
    CommitFollowUp, HintText, PanelTransition, PickerLayout, PromptBoxRect, QueuedCommand, ShellLayout, ShellLayoutInput,
    ShellRefs, ShellState, TextEntryPrompt, TranscriptTail, TranscriptViewport, commit_panel_transition, compute_shell_layout,
    record_transcript_tail,
};
use mixdog_tui::surface::owner::{PanelSurface, SurfaceEvent};
use mixdog_tui_widgets::picker::IndexMode;

fn base_input() -> ShellLayoutInput {
    ShellLayoutInput {
        panel_transition_epoch: 1,
        tui_ready: true,
        rows: 40,
        frame_columns: 100,
        prompt_hint_tone: "info".into(),
        text_entry_layout_rows: 1,
        prompt_content_columns: 96,
        ..ShellLayoutInput::default()
    }
}

fn base_refs() -> ShellRefs {
    ShellRefs { prompt_box_rect: Some(PromptBoxRect { x: 1, ..PromptBoxRect::default() }), ..ShellRefs::default() }
}

fn item(id: &str, kind: &str) -> TranscriptTail {
    TranscriptTail { id: Some(id.into()), kind: kind.into() }
}

fn state_with_items(items: &[(&str, &str)]) -> ShellState {
    ShellState {
        item_count: items.len(),
        latest_item: items.last().map(|(id, kind)| item(id, kind)),
        ..ShellState::default()
    }
}

/// The fields `CORE_KEYS` of the Node test, in its order.
#[derive(Debug, PartialEq, Eq)]
struct Core {
    input_box_hidden: bool,
    prompt_box_rows: usize,
    prompt_meta_rows: usize,
    queued_rows: usize,
    welcome_rows: usize,
    floating_panel_rows: usize,
    base_reserve: usize,
    bottom_cluster_rows: usize,
    bottom_reserve: usize,
    viewport_height: usize,
    transcript_guard_rows: usize,
    panel_close_mask_rows: usize,
    transcript_content_height: usize,
    panel_layout_signature: String,
}

fn core(layout: &ShellLayout) -> Core {
    Core {
        input_box_hidden: layout.input_box_hidden,
        prompt_box_rows: layout.prompt_box_rows,
        prompt_meta_rows: layout.prompt_meta_rows,
        queued_rows: layout.queued_rows,
        welcome_rows: layout.welcome_rows,
        floating_panel_rows: layout.floating_panel_rows,
        base_reserve: layout.base_reserve,
        bottom_cluster_rows: layout.bottom_cluster_rows,
        bottom_reserve: layout.bottom_reserve,
        viewport_height: layout.viewport_height,
        transcript_guard_rows: layout.transcript_guard_rows,
        panel_close_mask_rows: layout.panel_close_mask_rows,
        transcript_content_height: layout.transcript_content_height,
        panel_layout_signature: layout.panel_layout_signature.clone(),
    }
}

#[test]
fn idle_empty_transcript_reserves_banner_prompt_and_statusline_and_gives_the_rest_to_the_transcript() {
    let input = base_input();
    let mut refs = base_refs();
    let layout = compute_shell_layout(&input, &mut refs);
    assert_eq!(
        core(&layout),
        Core {
            input_box_hidden: false,
            prompt_box_rows: 3,
            prompt_meta_rows: 0,
            queued_rows: 0,
            welcome_rows: 11,
            floating_panel_rows: 0,
            base_reserve: 17,
            bottom_cluster_rows: 6,
            bottom_reserve: 17,
            viewport_height: 23,
            transcript_guard_rows: 1,
            panel_close_mask_rows: 0,
            transcript_content_height: 22,
            panel_layout_signature: "||||||input-visible|0|3|0|0|11".into(),
        }
    );
    assert_eq!(layout.max_floating_panel_rows, 22);
    assert_eq!(layout.picker_visible_rows, 8);
    assert!(layout.show_welcome_banner);
    assert_eq!(refs.transcript_viewport, Some(TranscriptViewport { top: 11, bottom: 32 }));
    assert_eq!(refs.frame_rows, 40);
    assert_eq!(refs.transcript_bottom_slack_rows, 1);
    assert_eq!(refs.prompt_box_rect, Some(PromptBoxRect { x: 1, ..PromptBoxRect::default() }), "a visible prompt keeps its measured rect");
    assert_eq!(layout.prompt_spinner_columns, 100);
    assert_eq!(layout.transient_status_width, 0);
}

#[test]
fn an_option_picker_hides_the_prompt_box_and_takes_the_panel_rows() {
    let input = ShellLayoutInput {
        picker: Some(PickerLayout { kind: "model".into(), fill_available: false }),
        state: state_with_items(&[("a", "user")]),
        prompt_layout_value: "hello".into(),
        ..base_input()
    };
    let mut refs = base_refs();
    let layout = compute_shell_layout(&input, &mut refs);
    assert_eq!(
        core(&layout),
        Core {
            input_box_hidden: true,
            prompt_box_rows: 0,
            prompt_meta_rows: 0,
            queued_rows: 0,
            welcome_rows: 0,
            floating_panel_rows: 17,
            base_reserve: 3,
            bottom_cluster_rows: 20,
            bottom_reserve: 20,
            viewport_height: 20,
            transcript_guard_rows: 1,
            panel_close_mask_rows: 0,
            transcript_content_height: 19,
            panel_layout_signature: "|picker:model:fit|||||input-hidden|17|0|0|0|0".into(),
        }
    );
    assert_eq!(layout.picker_visible_rows, 11);
    assert_eq!(layout.desired_floating_panel_rows, 17);
    assert_eq!(refs.prompt_box_rect, None, "a hidden prompt drops its stale rect");
}

#[test]
fn a_live_spinner_plus_queued_prompts_reserve_the_meta_band_and_the_queued_band() {
    let state = ShellState {
        spinner_active: true,
        queued: vec![
            QueuedCommand { text: "a".into(), ..QueuedCommand::default() },
            QueuedCommand { display_text: "b".into(), ..QueuedCommand::default() },
        ],
        ..state_with_items(&[("u1", "user")])
    };
    let input = ShellLayoutInput { state, prompt_layout_value: "x".into(), ..base_input() };
    let mut refs = base_refs();
    let layout = compute_shell_layout(&input, &mut refs);
    assert_eq!(
        core(&layout),
        Core {
            input_box_hidden: false,
            prompt_box_rows: 3,
            prompt_meta_rows: 2,
            queued_rows: 2,
            welcome_rows: 0,
            floating_panel_rows: 0,
            base_reserve: 10,
            bottom_cluster_rows: 10,
            bottom_reserve: 10,
            viewport_height: 30,
            transcript_guard_rows: 1,
            panel_close_mask_rows: 0,
            transcript_content_height: 29,
            panel_layout_signature: "||||||input-visible|0|3|2|2|0".into(),
        }
    );
    assert!(layout.queued_visible);
    assert!(!layout.queued_compact);
    assert!(layout.prompt_meta_visible);
    assert!(layout.live_spinner);
    assert!(!layout.overlay_hint_requested);
    assert_eq!(refs.transcript_viewport, Some(TranscriptViewport { top: 0, bottom: 28 }));
}

#[test]
fn a_toast_on_the_empty_transcript_carves_an_in_viewport_hint_row_and_sizes_the_hint_slot() {
    let state = ShellState { latest_toast: Some(HintText { text: "oops".into(), tone: "error".into() }), ..ShellState::default() };
    let input = ShellLayoutInput { state, ..base_input() };
    let layout = compute_shell_layout(&input, &mut base_refs());
    assert_eq!(layout.input_hint, "oops");
    assert_eq!(layout.input_hint_tone, "error");
    assert!(layout.overlay_hint_requested);
    assert_eq!(layout.overlay_hint_band_rows, 1);
    assert_eq!(layout.transcript_content_height, 21);
    assert_eq!(layout.spinner_hint_width, 42);
    assert_eq!(layout.guard_hint_width, 42);
    assert_eq!(layout.transient_status_width, 42);
    assert_eq!(layout.prompt_spinner_columns, 100);
    assert_eq!(layout.welcome_prompt_hint_rows, 0);
}

#[test]
fn a_live_spinner_shares_the_hint_slot_width_and_leaves_room_for_its_separator() {
    let state = ShellState {
        spinner_active: true,
        latest_toast: Some(HintText { text: "oops".into(), tone: "error".into() }),
        ..ShellState::default()
    };
    let layout = compute_shell_layout(&ShellLayoutInput { state, ..base_input() }, &mut base_refs());
    assert_eq!(layout.spinner_hint_width, 42);
    assert_eq!(layout.guard_hint_width, 42);
    assert_eq!(layout.transient_status_width, 42);
    assert_eq!(layout.prompt_spinner_columns, 57);
}

#[test]
fn closing_the_slash_palette_on_the_empty_screen_masks_the_reclaimed_rows_for_one_commit() {
    let mut refs = base_refs();
    refs.panel_transition = PanelTransition { signature: "||||slash||input-visible|14|3|0|0|11".into(), reserve: 31, ..PanelTransition::default() };
    let layout = compute_shell_layout(&base_input(), &mut refs);
    assert!(layout.panel_layout_changed);
    assert_eq!(refs.panel_close_ink_mask_rows, 25);
    assert_eq!(layout.panel_close_ink_mask_rows, 25);
    assert_eq!(layout.panel_transition_clear_rows, 0);
    assert_eq!(layout.panel_transition_guard_rows, 0);
    assert_eq!(refs.panel_transition.epoch, 1);
    assert_eq!(layout.viewport_height, 23);
    assert_eq!(layout.panel_close_mask_rows, 21);
    assert_eq!(layout.transcript_content_height, 1);
}

#[test]
fn opening_the_slash_palette_on_the_empty_screen_borrows_one_guard_row() {
    let mut refs = base_refs();
    refs.panel_transition = PanelTransition { signature: "||||||input-visible|0|3|0|0|11".into(), reserve: 17, ..PanelTransition::default() };
    let layout = compute_shell_layout(&ShellLayoutInput { slash_palette_open: true, ..base_input() }, &mut refs);
    assert!(layout.has_floating_panel);
    assert!(!layout.input_box_hidden);
    assert!(layout.slash_keeps_welcome_banner);
    assert_eq!(layout.floating_panel_rows, 14);
    assert_eq!(layout.panel_transition_guard_rows, 1);
    assert_eq!(refs.panel_transition.guard_rows, 1);
    assert_eq!(layout.transcript_guard_rows, 2);
    assert_eq!(layout.viewport_height, 40 - 31);
    assert_eq!(layout.transcript_content_height, 7);
    assert_eq!(refs.panel_close_ink_mask_rows, 0);
}

#[test]
fn prompt_row_only_churn_while_a_spinner_meta_band_collapses_onto_a_fresh_done_row_masks_nothing() {
    let mut refs = base_refs();
    refs.panel_transition = PanelTransition {
        signature: "||||||input-visible|0|3|2|0|0".into(),
        reserve: 8,
        tail_id: Some("u1".into()),
        ..PanelTransition::default()
    };
    let input = ShellLayoutInput { state: state_with_items(&[("u1", "user"), ("d1", "turndone")]), ..base_input() };
    let layout = compute_shell_layout(&input, &mut refs);
    assert_eq!(layout.panel_layout_signature, "||||||input-visible|0|3|0|0|0");
    assert!(layout.panel_layout_changed);
    assert_eq!(refs.panel_close_ink_mask_rows, 0, "the done row already backfills the vacated meta rows");
    assert_eq!(layout.transcript_content_height, 33);
}

#[test]
fn a_sign_in_url_in_a_text_entry_prompt_only_takes_the_rows_the_terminal_leaves() {
    let url = format!("https://claude.ai/oauth/authorize?{}", "q".repeat(433));
    for rows in [24, 14, 12] {
        let input = ShellLayoutInput {
            rows,
            frame_columns: 40,
            provider_prompt: Some(TextEntryPrompt { kind: "oauth-code".into(), detail: url.clone() }),
            ..base_input()
        };
        let layout = compute_shell_layout(&input, &mut base_refs());
        assert!(layout.has_text_entry_prompt, "rows {rows}");
        assert!(layout.text_entry_detail_rows <= layout.text_entry_url_max_rows, "rows {rows}");
        assert!(layout.floating_panel_rows <= layout.max_floating_panel_rows, "rows {rows}");
        assert_eq!(layout.text_entry_rows, 6 + layout.text_entry_content_rows + layout.text_entry_detail_rows, "rows {rows}");
    }
}

#[test]
fn a_question_approval_reserves_the_tallest_question_and_hides_the_prompt() {
    let approval = serde_json::json!({
        "kind": "question",
        "args": { "questions": [
            { "question": "Which one?", "header": "Pick", "options": [{ "label": "A" }, { "label": "B" }] },
            { "question": "And then?", "header": "Next", "options": [{ "label": "X" }] }
        ]}
    });
    let input = ShellLayoutInput { tool_approval: Some(approval), state: state_with_items(&[("a", "user")]), ..base_input() };
    let layout = compute_shell_layout(&input, &mut base_refs());
    assert!(layout.input_box_hidden);
    assert!(layout.desired_floating_panel_rows > 0);
    assert!(layout.panel_layout_signature.starts_with("tool|"));
    let plain = serde_json::json!({ "kind": "bash", "args": {} });
    let plain_layout = compute_shell_layout(&ShellLayoutInput { tool_approval: Some(plain), state: state_with_items(&[("a", "user")]), ..base_input() }, &mut base_refs());
    assert_eq!(plain_layout.desired_floating_panel_rows, 6 + 2 + 3);
}

#[test]
fn a_commit_loop_keeps_the_prompt_still_while_typing_wraps_rows() {
    // The prompt grows by a wrapped row (no mask), then shrinks back: the shrink is masked in the same commit.
    let mut refs = base_refs();
    let tall = ShellLayoutInput { prompt_layout_value: "x".repeat(200), state: state_with_items(&[("u1", "user")]), ..base_input() };
    let short = ShellLayoutInput { prompt_layout_value: "x".into(), ..tall.clone() };

    let layout = compute_shell_layout(&short, &mut refs);
    assert_eq!(commit_panel_transition(&mut refs, &layout.panel_layout_signature, layout.bottom_cluster_rows, 0, 0), CommitFollowUp::None);
    record_transcript_tail(&mut refs, Some("u1"));

    let grown = compute_shell_layout(&tall, &mut refs);
    assert!(grown.panel_layout_changed);
    assert_eq!(grown.panel_close_ink_mask_rows, 0, "growth needs no clearance");
    commit_panel_transition(&mut refs, &grown.panel_layout_signature, grown.bottom_cluster_rows, 0, 0);

    let shrunk = compute_shell_layout(&short, &mut refs);
    assert!(shrunk.panel_layout_changed);
    assert_eq!(shrunk.panel_close_ink_mask_rows, grown.bottom_cluster_rows - shrunk.bottom_cluster_rows);
    assert_eq!(commit_panel_transition(&mut refs, &shrunk.panel_layout_signature, shrunk.bottom_cluster_rows, 0, 0), CommitFollowUp::BumpInkMaskEpoch);
    assert_eq!(refs.panel_close_ink_mask_rows, 0);
}

#[test]
fn the_project_picker_latches_the_boot_input_once_it_is_gone() {
    let mut refs = base_refs();
    refs.panel_transition.signature = "|picker:project:fit|||||input-hidden|17|0|0|0|0".into();
    let booting = ShellLayoutInput { tui_ready: false, ..base_input() };
    let layout = compute_shell_layout(&booting, &mut refs);
    assert!(refs.project_boot_input_latch);
    assert!(!layout.boot_settling, "the latch keeps the prompt visible");
    let mut fresh = base_refs();
    assert!(compute_shell_layout(&booting, &mut fresh).boot_settling);
}

// The ownership cases of panel-epoch.test.mjs and panel-handoff.test.mjs through the public API.

#[derive(Clone, Debug, PartialEq)]
struct Panel {
    kind: &'static str,
    title: &'static str,
    mode: Option<IndexMode>,
}

impl PanelValue for Panel {
    fn kind(&self) -> &str {
        self.kind
    }
    fn title(&self) -> &str {
        self.title
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

const fn titled(title: &'static str) -> Panel {
    Panel { kind: "", title, mode: None }
}

type Surface = PanelSurface<Panel, &'static str, ()>;

#[test]
fn every_late_paint_shape_is_rejected_once_the_surface_changed_hands() {
    let mut surface = Surface::new();
    surface.set_picker(Some(titled("Settings")));
    surface.take_events();
    let mut own = surface.claim();
    let mut copy = own.clone();
    let deferred = own.defer();

    // Undisturbed, every use paints (the probe below is not vacuous): a plain paint, a copy of the claim, a deferred callback.
    assert!(own.paint(&mut surface, Some(titled("Settings"))));
    assert!(copy.paint(&mut surface, Some(titled("Settings"))));
    assert_eq!(own.run_deferred(&surface, deferred, || ()), Some(()));
    assert_eq!(surface.take_events().len(), 2);

    // Esc: the user takes the surface back, and the async work settles after it.
    surface.set_picker(None);
    surface.take_events();
    assert!(!own.paint(&mut surface, Some(titled("Settings"))));
    assert!(!copy.paint(&mut surface, Some(titled("Settings"))));
    assert_eq!(own.run_deferred(&surface, deferred, || ()), None);
    assert!(surface.take_events().is_empty());
    assert_eq!(surface.picker(), None);
}

#[test]
fn a_theme_selection_hands_directly_to_settings_without_a_null_panel() {
    let mut surface = Surface::new();
    surface.set_picker(Some(titled("Theme")));
    surface.take_events();
    let mut own = surface.claim();
    assert!(own.paint(&mut surface, Some(titled("Settings"))));
    assert!(own.paint(&mut surface, Some(titled("Settings"))));
    let painted: Vec<Option<&str>> = surface
        .take_events()
        .iter()
        .map(|event| match event {
            SurfaceEvent::Picker(panel) => panel.as_ref().map(|panel| panel.title),
            _ => panic!("only the picker is written"),
        })
        .collect();
    assert_eq!(painted, vec![Some("Settings"), Some("Settings")]);
}

#[test]
fn esc_on_a_slash_loading_panel_prevents_the_pending_picker_from_appearing_later() {
    let mut surface = Surface::new();
    let mut pending = surface.claim();
    surface.set_picker(Some(Panel { kind: "slash-loading:workflow", title: "Workflow", mode: None }));
    assert_eq!(surface.picker().map(|panel| panel.kind), Some("slash-loading:workflow"));
    // The loading panel's cancel hands the surface back.
    surface.set_picker(None);
    assert!(!pending.paint(&mut surface, Some(titled("Workflow"))));
    assert_eq!(surface.picker(), None);
}

#[test]
fn a_context_open_still_in_flight_cannot_reopen_what_esc_dismissed() {
    let mut surface = Surface::new();
    let mut opening = surface.claim();
    assert!(opening.context(&mut surface, Some("Context Usage")));
    assert!(surface.claim().context(&mut surface, None));
    assert!(!opening.context(&mut surface, Some("Context Usage")));
    assert_eq!(surface.context(), None);
    let mut reopening = surface.claim();
    assert!(reopening.context(&mut surface, Some("Context Usage")));
    assert_eq!(surface.context(), Some(&"Context Usage"));
}

#[test]
fn queued_prompt_edit_masks_but_a_promoted_user_row_backfills() {
    let mut refs = base_refs();
    let queued = |count: usize| ShellState {
        queued: (0..count).map(|n| QueuedCommand { text: format!("q{n}"), ..QueuedCommand::default() }).collect(),
        ..state_with_items(&[("u1", "user")])
    };
    let before = compute_shell_layout(&ShellLayoutInput { state: queued(2), ..base_input() }, &mut refs);
    commit_panel_transition(&mut refs, &before.panel_layout_signature, before.bottom_cluster_rows, 0, 0);
    record_transcript_tail(&mut refs, Some("u1"));

    // Removing a queued command without a tail append keeps the mask.
    let edited = compute_shell_layout(&ShellLayoutInput { state: queued(0), ..base_input() }, &mut refs);
    assert_eq!(edited.panel_close_ink_mask_rows, 2);

    // The same removal with the promoted user row appended in this commit is backfilled.
    refs.panel_close_ink_mask_rows = 0;
    refs.panel_transition.signature = before.panel_layout_signature.clone();
    refs.panel_transition.reserve = before.bottom_cluster_rows;
    let promoted_state = ShellState { latest_item: Some(item("u2", "user")), item_count: 2, ..ShellState::default() };
    let promoted = compute_shell_layout(&ShellLayoutInput { state: promoted_state, ..base_input() }, &mut refs);
    assert_eq!(promoted.panel_close_ink_mask_rows, 0);
}
