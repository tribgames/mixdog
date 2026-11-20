//! The Rust handlers against what the Node code does (tests/goldens/handlers.json, recorded by
//! tests/recorders/record-handlers.mjs): the approval keys, the grid-selection chords, history navigation, the paste pipeline,
//! the keystroke-time draft sync, the queued-message restore, the history scan and the history file layout; and the ports of
//! `use-prompt-handlers.test.mjs`, `use-prompt-draft-flow.test.mjs` and the global key input over a recording host.
//!
//! The recorder is run on a Node checkout (`node tests/recorders/record-handlers.mjs --tree <checkout> --check
//! tests/goldens/handlers.json`); this test only reads the recording.

mod slash_support;

use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet};

use mixdog_term::KeyFlags;
use mixdog_term::os::Platform;
use mixdog_term::paste::{ImageAttachment, PastedImage, PromptContent};
use mixdog_tui::app::AppCtx;
use mixdog_tui::editor::draft::Draft;
use mixdog_tui::editor::helpers::HintTone;
use mixdog_tui::editor::interrupt::InterruptResult;
use mixdog_tui::editor::prompt::{DraftOverride, EscapePhase, HistoryDirection, PaletteReply, PasteSource};
use mixdog_tui::handlers::draft_flow::{
    accept_slash_palette, apply_prompt_draft_change, cancel_provider_prompt, cancel_settings_prompt, cancel_slash_palette, complete_slash_palette,
};
use mixdog_tui::handlers::escape::handle_prompt_escape;
use mixdog_tui::handlers::global_keys::{ApprovalDecision, GlobalKeyOutcome, SelectionMove, ToolApproval, handle_global_key};
use mixdog_tui::handlers::history_nav::{HistoryNav, handle_prompt_history_navigate};
use mixdog_tui::handlers::interrupt::{InterruptOutcome, finish_interrupt, handle_prompt_interrupt, on_busy_changed};
use mixdog_tui::handlers::paste::{PasteIo, PasteResult, handle_prompt_paste};
use mixdog_tui::handlers::queue_restore::RestoredQueue;
use mixdog_tui::handlers::{GlobalKeyHost, PromptHost, PromptState, Reply};
use mixdog_tui::pickers::PickerKind;
use mixdog_tui::slash::commands::{OverlayOwner, SLASH_COMMANDS};
use mixdog_tui::slash::host::{Opener, PromptSurface, SlashHost, SlashState, SubmitOptions, TextPrompt, Tone};
use mixdog_tui::slash::palette::PaletteItem;
use mixdog_tui::surface::latch::EnterLatch;
use mixdog_tui::surface::{SurfaceClaim, SurfaceKind};
use mixdog_tui::transcript::window::selection_shift::SelectionRect;
use serde_json::{Value, json};
use slash_support::Fake;

fn str_of(value: &Value) -> &str {
    value.as_str().unwrap_or_default()
}

fn tone_name(tone: HintTone) -> &'static str {
    match tone {
        HintTone::Info => "info",
        HintTone::Error => "error",
        HintTone::Warn => "warn",
        HintTone::Cancel => "cancel",
        HintTone::Plain => "plain",
    }
}

// ---- the recording host ----------------------------------------------------------------------------------------------

/// A [`PromptHost`] over the slash fake: the prompt state is real, every other effect is a logged event in the shape the
/// recorder logs it in.
struct H {
    f: Fake,
    p: PromptState,
    events: Vec<Value>,
    usage: bool,
    context: bool,
    btw: bool,
    selector_opens: usize,
    selector_result: bool,
    busy: bool,
    remembered: Vec<String>,
    abort: Option<Reply<Option<InterruptOutcome>>>,
    abort_generations: Vec<u64>,
    restore: Option<Reply<Option<RestoredQueue>>>,
    queued: Vec<Value>,
    live: RefCell<Option<Draft>>,
    live_follows_override: bool,
    history: Vec<String>,
    palette_item: Option<PaletteItem>,
    latch: EnterLatch,
    login_cancels: usize,
    cancel_return: Option<bool>,
    platform: Platform,
    clip_text: Result<String, String>,
    clip_image: Result<Option<ImageAttachment>, String>,
    // the global key host
    approval: Option<ToolApproval>,
    picker: bool,
    selection_text: Option<String>,
    drag_region: Option<String>,
    drag_rect: Option<SelectionRect>,
    copy_error: Option<String>,
    grid_active: bool,
    scroll_focus: OverlayOwner,
    rows: Option<usize>,
    windows: bool,
}

impl H {
    fn new() -> Self {
        Self {
            f: Fake::new(),
            p: PromptState::new(),
            events: Vec::new(),
            usage: false,
            context: false,
            btw: false,
            selector_opens: 0,
            selector_result: true,
            busy: false,
            remembered: Vec::new(),
            abort: None,
            abort_generations: Vec::new(),
            restore: None,
            queued: Vec::new(),
            live: RefCell::new(None),
            live_follows_override: false,
            history: Vec::new(),
            palette_item: None,
            latch: EnterLatch::new(),
            login_cancels: 0,
            cancel_return: None,
            platform: Platform::current(),
            clip_text: Ok(String::new()),
            clip_image: Ok(None),
            approval: None,
            picker: false,
            selection_text: None,
            drag_region: None,
            drag_rect: None,
            copy_error: None,
            grid_active: false,
            scroll_focus: OverlayOwner::default(),
            rows: None,
            windows: false,
        }
    }

    fn log(&mut self, event: Value) {
        self.events.push(event);
    }

    /// The events whose first element is `name`.
    fn named(&self, name: &str) -> Vec<Value> {
        self.events.iter().filter(|event| event[0] == name).cloned().collect()
    }

    fn hints(&self) -> Vec<(String, String)> {
        self.named("hint").iter().map(|event| (str_of(&event[1]).to_owned(), str_of(&event[2]).to_owned())).collect()
    }
}

fn attachment(name: &str) -> ImageAttachment {
    ImageAttachment { content: "AA".to_owned(), media_type: "image/png".to_owned(), filename: name.to_owned(), source_path: String::new(), metadata_text: None }
}

impl AppCtx for H {
    fn store_call(&mut self, action: &str, args: Value) -> Result<Value, String> {
        self.f.store_call(action, args)
    }

    fn claim_surface(&mut self, kind: SurfaceKind) -> SurfaceClaim {
        self.f.claim_surface(kind)
    }

    fn open_picker(&mut self, kind: PickerKind) -> SurfaceClaim {
        self.f.open_picker(kind)
    }
}

impl SlashHost for H {
    fn state(&self) -> SlashState {
        self.f.state()
    }

    fn push_notice(&mut self, text: &str, tone: Tone) {
        self.f.push_notice(text, tone)
    }

    fn push_notice_ttl(&mut self, text: &str, tone: Tone, ttl_ms: u64) {
        self.f.push_notice_ttl(text, tone, ttl_ms)
    }

    fn now_ms(&self) -> u64 {
        self.f.now_ms()
    }

    fn has_store_method(&self, name: &str) -> bool {
        self.f.has_store_method(name)
    }

    fn clear_context_panel(&mut self) {
        self.f.clear_context_panel()
    }

    fn close_usage_panel(&mut self) {
        self.f.close_usage_panel()
    }

    fn paint_loading_frame(&mut self, command: &str, title: &str) -> Option<SurfaceClaim> {
        self.f.paint_loading_frame(command, title)
    }

    fn owns_surface(&self, claim: SurfaceClaim) -> bool {
        self.f.owns_surface(claim)
    }

    fn close_surface(&mut self, claim: SurfaceClaim) {
        self.f.close_surface(claim)
    }

    fn paint_stop_confirm(&mut self, claim: SurfaceClaim, title: &str, commands: &[String]) {
        self.f.paint_stop_confirm(claim, title, commands)
    }

    fn open(&mut self, opener: Opener, options: Value) -> Result<(), String> {
        self.f.open(opener, options)
    }

    fn open_with_return(&mut self, opener: Opener, options: Value, target: &TextPrompt) -> Result<(), String> {
        self.f.open_with_return(opener, options, target)
    }

    fn register_project(&mut self, path: &str) -> Result<(), String> {
        self.f.register_project(path)
    }

    fn enter_project(&mut self, target: &str) {
        self.f.enter_project(target)
    }

    fn login_mcp_server(&mut self, name: &str) {
        self.f.login_mcp_server(name)
    }

    fn logout_mcp_server(&mut self, name: &str) {
        self.f.logout_mcp_server(name)
    }

    fn btw_ask(&mut self, question: &str) {
        self.f.btw_ask(question)
    }

    fn run_doctor(&mut self) -> Result<(), String> {
        self.f.run_doctor()
    }

    fn request_exit(&mut self) {
        self.f.request_exit()
    }

    fn force_render_repaint(&mut self) {
        self.f.force_render_repaint()
    }

    fn supersede_panel_epoch(&mut self) -> u64 {
        self.f.supersede_panel_epoch()
    }

    fn is_panel_epoch_current(&self, token: u64) -> bool {
        self.f.is_panel_epoch_current(token)
    }

    fn write_token(&self, surface: PromptSurface) -> u64 {
        self.f.write_token(surface)
    }

    fn set_write_token(&mut self, surface: PromptSurface, token: u64) {
        self.f.set_write_token(surface, token)
    }

    fn provider_prompt(&self) -> Option<TextPrompt> {
        self.f.provider_prompt()
    }

    fn settings_prompt(&self) -> Option<TextPrompt> {
        self.f.settings_prompt()
    }

    fn set_prompt(&mut self, surface: PromptSurface, next: Option<TextPrompt>) {
        self.f.set_prompt(surface, next)
    }

    fn mark_prompt_submitting(&mut self, surface: PromptSurface, target: &TextPrompt) {
        self.f.mark_prompt_submitting(surface, target)
    }

    fn oauth_submitting(&self) -> bool {
        self.f.oauth_submitting()
    }

    fn set_oauth_submitting(&mut self, value: bool) {
        self.f.set_oauth_submitting(value)
    }

    fn oauth_complete_code(&mut self, target: &TextPrompt, code: &str) -> Result<(), String> {
        self.f.oauth_complete_code(target, code)
    }

    fn oauth_success_return(&mut self, target: &TextPrompt) -> bool {
        self.f.oauth_success_return(target)
    }

    fn oauth_failure_return(&mut self, target: &TextPrompt, error: &str) {
        self.f.oauth_failure_return(target, error)
    }

    fn provider_after_save(&mut self, target: &TextPrompt) -> bool {
        self.f.provider_after_save(target)
    }

    fn clear_model_caches(&mut self, scope: &str) {
        self.f.clear_model_caches(scope)
    }

    fn pasted_images(&self) -> BTreeMap<u64, PastedImage> {
        self.f.pasted_images()
    }

    fn pasted_texts(&self) -> BTreeMap<u64, String> {
        self.f.pasted_texts()
    }

    fn clear_pasted_images(&mut self, ids: Option<&BTreeSet<u64>>) {
        self.f.clear_pasted_images(ids)
    }

    fn clear_pasted_texts(&mut self, ids: Option<&BTreeSet<u64>>) {
        self.f.clear_pasted_texts(ids)
    }

    fn arm_transcript_follow(&mut self) {
        self.f.arm_transcript_follow()
    }

    fn store_submit(&mut self, method: &str, content: &PromptContent, options: Option<&SubmitOptions>) -> Result<Value, String> {
        self.f.store_submit(method, content, options)
    }
}

impl PasteIo for H {
    fn platform(&self) -> Platform {
        self.platform
    }

    fn paste_cwd(&self) -> String {
        "/work".to_owned()
    }

    fn read_image_from_path(&mut self, raw_path: &str) -> Result<Option<ImageAttachment>, String> {
        // The recorder's `attachImagePath`: a missing file is not an image, a broken one fails, anything else attaches.
        if raw_path.contains("missing") {
            return Ok(None);
        }
        if raw_path.contains("boom") {
            return Err("boom".to_owned());
        }
        Ok(Some(attachment(raw_path.rsplit('/').next().unwrap_or(raw_path))))
    }

    fn read_clipboard_text(&mut self) -> Result<String, String> {
        self.clip_text.clone()
    }

    fn read_clipboard_image(&mut self) -> Result<Option<ImageAttachment>, String> {
        self.clip_image.clone()
    }
}

impl PromptHost for H {
    fn prompt(&mut self) -> &mut PromptState {
        &mut self.p
    }

    fn sync_prompt_layout_rows(&mut self, text: &str) {
        self.log(json!(["layout", text]));
        self.live_follows_override = true;
    }

    fn dismiss_welcome_prompt_hint(&mut self) {
        self.log(json!(["welcome"]));
    }

    fn usage_panel_open(&self) -> bool {
        self.usage
    }

    fn context_panel_open(&self) -> bool {
        self.context
    }

    fn btw_panel_open(&self) -> bool {
        self.btw
    }

    fn close_btw_panel(&mut self) {
        self.log(json!(["closeBtw"]));
    }

    fn open_message_selector(&mut self) -> bool {
        self.selector_opens += 1;
        self.selector_result
    }

    fn store_busy(&self) -> bool {
        self.busy
    }

    fn remember_prompt_history(&mut self, text: &str) -> Result<(), String> {
        self.remembered.push(text.to_owned());
        Ok(())
    }

    fn abort(&mut self, generation: u64) -> Reply<Option<InterruptOutcome>> {
        self.abort_generations.push(generation);
        self.abort.take().unwrap_or(Reply::Ready(Ok(None)))
    }

    fn restore_queued(&mut self) -> Reply<Option<RestoredQueue>> {
        self.restore.take().unwrap_or(Reply::Ready(Ok(None)))
    }

    fn queued(&self) -> Vec<Value> {
        self.queued.clone()
    }

    fn current_draft(&self) -> Option<Draft> {
        if self.live_follows_override
            && let Some(published) = &self.p.draft_override
        {
            return Some(Draft {
                value: published.draft.value.clone(),
                cursor: published.draft.cursor.unwrap_or(0),
                selection_anchor: published.draft.selection_anchor,
            });
        }
        self.live.borrow().clone()
    }

    fn recent_prompt_history(&self) -> Vec<String> {
        self.history.clone()
    }

    fn selected_palette_item(&self) -> Option<PaletteItem> {
        self.palette_item.clone()
    }

    fn enter_latch(&mut self) -> &mut EnterLatch {
        &mut self.latch
    }

    fn cancel_provider_login(&mut self, _target: &TextPrompt) {
        self.login_cancels += 1;
    }

    fn provider_cancel_return(&mut self, _target: &TextPrompt) -> bool {
        match self.cancel_return {
            Some(_) => {
                self.log(json!(["cancelReturn"]));
                true
            }
            None => false,
        }
    }

    fn show_prompt_hint(&mut self, text: &str, tone: HintTone, dismiss_ms: Option<u64>) {
        self.log(json!(["hint", text, tone_name(tone)]));
        let now = self.f.now_ms();
        self.p.hint.show(text, tone, dismiss_ms, now);
    }

    fn clear_prompt_hint(&mut self) {
        self.log(json!(["hintClear"]));
        self.p.hint.clear();
    }
}

impl GlobalKeyHost for H {
    fn settle_stuck_drag(&mut self) {
        self.log(json!(["settleDrag"]));
    }

    fn tool_approval(&self) -> Option<ToolApproval> {
        self.approval.clone()
    }

    fn resolve_tool_approval(&mut self, id: &str, decision: ApprovalDecision) {
        self.log(json!(["approval", id, decision.approved, decision.reason]));
    }

    fn picker_open(&self) -> bool {
        self.picker
    }

    fn prompt_selection_text(&self) -> Option<String> {
        self.selection_text.clone()
    }

    fn drag_region(&self) -> Option<String> {
        self.drag_region.clone()
    }

    fn drag_rect(&self) -> Option<SelectionRect> {
        self.drag_rect.clone()
    }

    fn copy_to_clipboard(&mut self, text: &str) -> Result<(), String> {
        self.log(json!(["copy", text]));
        self.copy_error.clone().map_or(Ok(()), Err)
    }

    fn copy_selection(&mut self) {
        self.log(json!(["copySelection"]));
    }

    fn toggle_expand(&mut self) {
        self.log(json!(["toggleExpand"]));
    }

    fn grid_selection_active(&self) -> bool {
        self.grid_active
    }

    fn move_selection_focus(&mut self, direction: SelectionMove) -> bool {
        self.log(json!(["moveFocus", direction.as_str()]));
        true
    }

    fn scroll_focus(&self) -> OverlayOwner {
        self.scroll_focus
    }

    fn rows(&self) -> Option<usize> {
        self.rows
    }

    fn scroll_transcript_rows(&mut self, delta: i64) {
        self.log(json!(["scroll", delta]));
    }

    fn reset_transcript_scroll(&mut self) {
        self.log(json!(["resetScroll"]));
    }

    fn reset_drag(&mut self) {
        self.log(json!(["resetDrag"]));
    }

    fn clear_prompt_mouse_selection(&mut self) {
        self.log(json!(["clearPromptSelection"]));
    }

    fn clear_selection_rect(&mut self) {
        self.log(json!(["clearRect"]));
    }

    fn is_windows(&self) -> bool {
        self.windows
    }
}

fn paste_host() -> H {
    H::new()
}

// ---- ports of use-prompt-handlers.test.mjs ---------------------------------------------------------------------------------

#[test]
fn paste_inserts_short_text_raw_folds_large_text_and_resolves_image_paths_into_attachment_refs() {
    let mut host = paste_host();
    let paste = |host: &mut H, text: &str| handle_prompt_paste(host, text, PasteSource::Paste);
    assert_eq!(paste(&mut host, "short text"), PasteResult::Raw);
    let many_short = (0..12).map(|n| format!("line {n}")).collect::<Vec<_>>().join("\n");
    assert_eq!(paste(&mut host, &many_short), PasteResult::Raw, "many short lines under the limit stay raw");
    assert!(host.p.buffers.texts.entries().is_empty());

    let big = "x".repeat(1001);
    assert_eq!(paste(&mut host, &big), PasteResult::Insert("[Pasted text #1 +1 lines]".to_owned()));
    assert_eq!(host.p.buffers.texts.entries().get(&1), Some(&big));

    assert_eq!(paste(&mut host, "before\n/tmp/p/a.png\nafter"), PasteResult::Insert("before\n[Image #1]\nafter".to_owned()));
    assert_eq!(host.hints().last(), Some(&("attached a.png".to_owned(), "plain".to_owned())));
    assert_eq!(paste(&mut host, "/tmp/p/missing.png"), PasteResult::Insert("/tmp/p/missing.png".to_owned()), "an unreadable image path stays plain text");
    assert_eq!(host.p.buffers.images.entries().len(), 1);
    assert_eq!(paste(&mut host, "/tmp/p/boom.png"), PasteResult::Insert("/tmp/p/boom.png".to_owned()), "a failing image read stays plain text and says so");
    assert_eq!(host.hints().last(), Some(&("image attach failed: boom".to_owned(), "warn".to_owned())));
}

#[test]
fn the_clipboard_shortcut_reads_the_clipboard_and_a_paste_with_text_is_not_read_again() {
    let mut host = paste_host();
    host.clip_text = Ok("from clipboard".to_owned());
    assert_eq!(handle_prompt_paste(&mut host, "", PasteSource::ClipboardShortcut), PasteResult::Insert("from clipboard".to_owned()));
    assert_eq!(handle_prompt_paste(&mut host, "typed", PasteSource::ClipboardShortcut), PasteResult::Raw);
    assert_eq!(PasteResult::Raw.into_reply(), mixdog_tui::editor::prompt::PasteReply::Fallback);
    assert_eq!(PasteResult::Nothing.into_reply(), mixdog_tui::editor::prompt::PasteReply::Drop);
}

#[test]
fn history_navigation_through_the_handler_clears_the_hint_and_marks_the_draft_change() {
    let mut host = H::new();
    host.history = ["third", "second", "first"].iter().map(|text| (*text).to_owned()).collect();
    host.p.hint.show("old", HintTone::Info, None, 0);
    let navigate = |host: &mut H, direction, text: &str, empty: bool| handle_prompt_history_navigate(host, direction, text, empty);
    assert_eq!(navigate(&mut host, HistoryDirection::Down, "draft", false), None, "down while inactive does nothing");
    assert_eq!(navigate(&mut host, HistoryDirection::Up, "draft", false).as_deref(), Some("third"));
    assert_eq!(host.p.history_nav, HistoryNav { active: true, index: 0, seed: "draft".into(), last_value: "third".into() });
    assert!(host.p.history_draft_change);
    assert!(!host.p.hint.is_live(), "every navigation clears the prompt hint");
    assert_eq!(navigate(&mut host, HistoryDirection::Up, "third", false).as_deref(), Some("second"));
    assert_eq!(navigate(&mut host, HistoryDirection::Down, "second", false).as_deref(), Some("third"));
    assert_eq!(navigate(&mut host, HistoryDirection::Down, "third", false).as_deref(), Some("draft"));
    assert!(!host.p.history_nav.active, "below the newest entry the walk is over");
    assert_eq!(navigate(&mut host, HistoryDirection::Down, "anything", true), None);
}

#[test]
fn escape_closes_overlays_first_then_arms_and_executes_the_clear_and_select_phases() {
    let mut usage = H::new();
    usage.usage = true;
    assert!(handle_prompt_escape(&mut usage, "", EscapePhase::Before));
    assert_eq!(usage.f.log.iter().filter(|entry| entry[0] == "closeUsage").count(), 1);

    let mut btw = H::new();
    btw.btw = true;
    assert!(handle_prompt_escape(&mut btw, "", EscapePhase::Before));
    assert_eq!(btw.named("closeBtw").len(), 1);

    let mut context = H::new();
    context.context = true;
    assert!(handle_prompt_escape(&mut context, "", EscapePhase::Before));
    assert_eq!(context.f.log.iter().filter(|entry| entry[0] == "clearContext").count(), 1);

    let mut host = H::new();
    assert!(!handle_prompt_escape(&mut host, "", EscapePhase::Before), "no overlay: the editor goes on");
    assert!(handle_prompt_escape(&mut host, "text", EscapePhase::ClearArm));
    assert_eq!(host.hints().last().map(|hint| hint.0.as_str()), Some("Esc again to clear"));
    assert_eq!(host.p.hint.dismiss_at(), Some(1000), "the armed hint stays up for the escape window");
    assert!(handle_prompt_escape(&mut host, "", EscapePhase::SelectArm));
    assert_eq!(host.hints().last().map(|hint| hint.0.as_str()), Some("Esc again to pick a message"));

    // Select: the queue first, then the selector.
    assert!(handle_prompt_escape(&mut host, "", EscapePhase::Select));
    assert_eq!(host.selector_opens, 1);
    host.selector_result = false;
    assert!(!handle_prompt_escape(&mut host, "", EscapePhase::Select), "the selector's answer is the key's");

    host.queued = vec![json!({"id": "1", "text": "queued"})];
    host.restore = Some(Reply::Ready(Ok(Some(RestoredQueue { count: 1, text: "queued".into(), ..RestoredQueue::default() }))));
    host.selector_opens = 0;
    assert!(handle_prompt_escape(&mut host, "", EscapePhase::Select), "an editable follow-up wins over the selector");
    assert_eq!(host.selector_opens, 0);
    assert_eq!(host.p.value, "queued");

    host.p.buffers.register_text("pasted");
    assert!(!handle_prompt_escape(&mut host, "typed", EscapePhase::Clear));
    assert_eq!(host.remembered, ["typed"]);
    assert!(host.p.buffers.texts.entries().is_empty() && host.p.buffers.images.entries().is_empty());

    host.queued.clear();
    assert!(!handle_prompt_escape(&mut host, "", EscapePhase::Empty));
}

fn aborted(restore_text: &str) -> InterruptOutcome {
    InterruptOutcome { result: InterruptResult { aborted: Some(true), restore_text: restore_text.into() }, ..InterruptOutcome::default() }
}

#[test]
fn a_synchronous_interrupt_restores_the_submitted_prompt_and_its_attachments_only_into_an_empty_draft() {
    let mut host = H::new();
    let image = PastedImage { id: 1, content: "AA".into(), media_type: None, metadata_text: None };
    let mut outcome = aborted(" again ");
    outcome.pasted_images = Some(BTreeMap::from([(1, image.clone())]));
    outcome.discard_pasted_images = Some(BTreeMap::from([(1, PastedImage { id: 1, content: "old".into(), ..image.clone() })]));
    host.p.buffers.images.install(&BTreeMap::from([(1, PastedImage { id: 1, content: "old".into(), ..image.clone() })]), true);
    host.abort = Some(Reply::Ready(Ok(Some(outcome))));
    host.p.hint.show("old", HintTone::Info, None, 0);
    assert_eq!(handle_prompt_interrupt(&mut host, "").as_deref(), Some("again"));
    assert_eq!(host.p.buffers.images.entries().get(&1), Some(&image), "the discarded entry went and the restored one was installed");
    assert!(!host.p.hint.is_live());

    host.abort = Some(Reply::Ready(Ok(Some(aborted("again")))));
    assert_eq!(handle_prompt_interrupt(&mut host, "typing"), None, "a replacement draft is never overwritten");

    let mut not_aborted = aborted("never");
    not_aborted.result.aborted = Some(false);
    not_aborted.discard_pasted_images = Some(BTreeMap::from([(1, image.clone())]));
    host.abort = Some(Reply::Ready(Ok(Some(not_aborted))));
    assert_eq!(handle_prompt_interrupt(&mut host, ""), None);
    assert_eq!(host.p.buffers.images.entries().len(), 1, "a non-aborted result discards nothing more");

    host.abort = Some(Reply::Ready(Ok(None)));
    assert_eq!(handle_prompt_interrupt(&mut host, ""), None);

    host.abort = Some(Reply::Ready(Err("boom".into())));
    assert_eq!(handle_prompt_interrupt(&mut host, ""), None);
    assert_eq!(host.f.notices().last(), Some(&("interrupt failed: boom".to_owned(), "error".to_owned())));
}

#[test]
fn an_asynchronous_interrupt_waits_for_the_turn_to_go_idle_before_restoring_the_draft() {
    let mut host = H::new();
    host.busy = true;
    host.abort = Some(Reply::Pending);
    assert_eq!(handle_prompt_interrupt(&mut host, ""), None);
    let generation = host.abort_generations[0];
    let mut outcome = aborted("later");
    outcome.pasted_texts = Some(BTreeMap::from([(7, "seven".to_owned())]));
    finish_interrupt(&mut host, generation, Ok(Some(outcome)));
    assert!(host.p.draft_override.is_none(), "still busy: the restore is parked");
    assert!(host.p.interrupt.has_parked_restore());

    host.busy = false;
    on_busy_changed(&mut host);
    let published = host.p.draft_override.clone().expect("the restore is applied once idle");
    assert_eq!(published.draft.value, "later");
    assert_eq!(host.named("layout"), [json!(["layout", "later"])]);
    assert_eq!(host.p.buffers.texts.entries().get(&7).map(String::as_str), Some("seven"));
    assert!(!host.p.interrupt.has_parked_restore());
}

#[test]
fn a_newer_interrupt_invalidates_a_parked_restore_and_a_late_answer_of_an_older_one() {
    let mut host = H::new();
    host.busy = true;
    host.abort = Some(Reply::Pending);
    handle_prompt_interrupt(&mut host, "");
    let first = host.abort_generations[0];
    finish_interrupt(&mut host, first, Ok(Some(aborted("first"))));
    assert!(host.p.interrupt.has_parked_restore());

    host.abort = Some(Reply::Pending);
    handle_prompt_interrupt(&mut host, "");
    assert!(!host.p.interrupt.has_parked_restore(), "the newer interrupt dropped what was parked");
    finish_interrupt(&mut host, first, Ok(Some(aborted("stale"))));
    host.busy = false;
    on_busy_changed(&mut host);
    assert!(host.p.draft_override.is_none(), "the late answer of the older interrupt applies to nothing");
    let latest = host.p.interrupt.generation();
    finish_interrupt(&mut host, latest, Err("late".into()));
    assert_eq!(host.f.notices().last(), Some(&("interrupt failed: late".to_owned(), "error".to_owned())));
}

// ---- ports of use-prompt-draft-flow.test.mjs -------------------------------------------------------------------------------

fn palette_host() -> H {
    let mut host = H::new();
    let compact = SLASH_COMMANDS.iter().find(|command| command.name == "compact").expect("compact is registered");
    host.palette_item = Some(PaletteItem::Command(compact));
    host
}

#[test]
fn cancel_paths_and_palette_accept_reach_the_prompt_setters_pickers_and_dispatcher() {
    let mut host = palette_host();
    host.f.provider = Some(TextPrompt::new("oauth-code"));
    host.f.settings = Some(TextPrompt::new("project-new"));
    host.cancel_return = Some(true);
    host.f.set_oauth_submitting(true);

    cancel_provider_prompt(&mut host);
    assert!(!host.f.oauth_submitting());
    assert_eq!(host.login_cancels, 1);
    assert_eq!(host.named("cancelReturn").len(), 1);
    assert_eq!(host.f.closed_prompts("provider"), 1);

    cancel_settings_prompt(&mut host);
    assert_eq!(host.f.closed_prompts("settings"), 1);
    assert_eq!(host.f.opened(), [("project".to_owned(), json!({}))]);

    host.f.script("compact", Ok(json!({"changed": true})));
    assert_eq!(accept_slash_palette(&mut host, "/compact", None), PaletteReply::Accepted);
    assert!(host.latch.is_armed(), "the picker latch is armed by the accept");
    assert!(host.latch.expires_at_ms().is_some());
}

#[test]
fn settings_prompt_cancels_return_to_the_picker_they_were_reached_from() {
    for (kind, opener) in [
        ("project-create-confirm", "project"),
        ("project-rename", "project"),
        ("core-add", "memory"),
        ("core-edit", "memory"),
        ("core-delete-confirm", "memory"),
    ] {
        let mut host = H::new();
        host.f.settings = Some(TextPrompt::new(kind));
        cancel_settings_prompt(&mut host);
        assert_eq!(host.f.opened(), [(opener.to_owned(), json!({}))], "{kind}");
    }
    let mut host = H::new();
    host.f.settings = Some(TextPrompt::new("autoclear-provider"));
    cancel_settings_prompt(&mut host);
    assert_eq!(host.f.opened(), [("autoclear".to_owned(), json!({"advanced": true}))]);
    let mut host = H::new();
    host.f.settings = Some(TextPrompt::new("other"));
    cancel_settings_prompt(&mut host);
    assert!(host.f.opened().is_empty());
    assert_eq!(host.f.closed_prompts("settings"), 1, "any settings prompt is closed");
}

#[test]
fn a_provider_prompt_without_a_return_runs_its_after_save() {
    let mut host = H::new();
    let mut prompt = TextPrompt::new("oauth-code");
    prompt.fields.insert("_afterSave".to_owned(), json!(true));
    host.f.provider = Some(prompt);
    cancel_provider_prompt(&mut host);
    assert!(host.f.log.iter().any(|entry| entry[0] == "afterSave"), "{:?}", host.f.log);
}

#[test]
fn palette_rows_complete_and_cancel_as_the_node_flow_does() {
    let mut host = palette_host();
    assert_eq!(complete_slash_palette(&mut host, "/comp", None), PaletteReply::Text("/compact ".to_owned()));
    assert_eq!(
        complete_slash_palette(&mut host, "/COMPACT", None),
        PaletteReply::Text("/compact ".to_owned()),
        "a typed spelling of the name stays as typed (lowercased)"
    );
    host.palette_item = Some(PaletteItem::Skill { name: "review".into(), label: "$review".into(), description: String::new() });
    assert_eq!(complete_slash_palette(&mut host, "use $rev now", Some(8)), PaletteReply::Draft { value: "use $review  now".to_owned(), cursor: 12 });
    assert_eq!(accept_slash_palette(&mut host, "no mention", None), PaletteReply::Declined);
    host.palette_item = None;
    assert_eq!(accept_slash_palette(&mut host, "/x", None), PaletteReply::Declined);
    assert_eq!(complete_slash_palette(&mut host, "/x", None), PaletteReply::Accepted);
    cancel_slash_palette(&mut host, "/mod");
    assert_eq!(host.p.slash_dismissed_for, "/mod");
}

// ---- the global key handler ------------------------------------------------------------------------------------------------

fn key(configure: impl FnOnce(&mut KeyFlags)) -> KeyFlags {
    let mut flags = KeyFlags::default();
    configure(&mut flags);
    flags
}

fn rect(x1: i64, y1: i64, x2: i64, y2: i64) -> SelectionRect {
    SelectionRect { mode: None, x1, y1, x2, y2, clip_y1: None, clip_y2: None, capture_text: None }
}

#[test]
fn an_approval_key_resolves_the_approval_before_anything_else() {
    let mut host = H::new();
    host.approval = Some(ToolApproval { id: "a1".into(), kind: "tool".into() });
    assert_eq!(handle_global_key(&mut host, "y", &KeyFlags::default()), GlobalKeyOutcome::Consumed);
    assert_eq!(host.named("approval"), [json!(["approval", "a1", true, "approved by user"])]);
    handle_global_key(&mut host, "", &key(|k| k.escape = true));
    assert_eq!(host.named("approval").last(), Some(&json!(["approval", "a1", false, "denied by user"])));
    host.approval = Some(ToolApproval { id: "q".into(), kind: "question".into() });
    host.events.clear();
    assert_eq!(handle_global_key(&mut host, "y", &KeyFlags::default()), GlobalKeyOutcome::Pass);
    assert!(host.named("approval").is_empty(), "a question approval is answered only inside its panel");
}

#[test]
fn ctrl_c_copies_the_prompt_selection_then_the_grid_selection_and_never_interrupts() {
    let ctrl_c = key(|k| k.ctrl = true);
    let mut host = H::new();
    host.selection_text = Some("a😀".to_owned());
    assert_eq!(handle_global_key(&mut host, "c", &ctrl_c), GlobalKeyOutcome::Consumed);
    assert_eq!(host.named("copy"), [json!(["copy", "a😀"])]);
    assert_eq!(host.hints().last(), Some(&("copied 3 chars".to_owned(), "plain".to_owned())), "the count is UTF-16 units");

    host.selection_text = Some("x".to_owned());
    handle_global_key(&mut host, "C", &ctrl_c);
    assert_eq!(host.hints().last().map(|hint| hint.0.as_str()), Some("copied 1 char"));

    host.copy_error = Some("no clipboard".to_owned());
    handle_global_key(&mut host, "c", &ctrl_c);
    assert_eq!(host.hints().last(), Some(&("copy failed: no clipboard".to_owned(), "error".to_owned())));

    let mut host = H::new();
    host.drag_rect = Some(rect(0, 0, 4, 0));
    host.drag_region = Some("transcript".into());
    host.selection_text = Some("prompt text".to_owned());
    handle_global_key(&mut host, "c", &ctrl_c);
    assert_eq!(host.named("copySelection").len(), 1, "the last drag was in the transcript");

    let mut host = H::new();
    handle_global_key(&mut host, "c", &ctrl_c);
    assert_eq!(host.hints().last().map(|hint| hint.0.as_str()), Some("select text to copy \u{b7} Esc interrupts"));
    let mut windows = H::new();
    windows.windows = true;
    handle_global_key(&mut windows, "c", &ctrl_c);
    assert!(windows.hints().is_empty(), "Windows Terminal's own copy shortcut is the same key");
}

#[test]
fn a_grid_selection_chord_moves_the_focus_only_while_a_selection_is_live() {
    let mut host = H::new();
    let shift_right = key(|k| {
        k.shift = true;
        k.right_arrow = true;
    });
    assert_eq!(handle_global_key(&mut host, "", &shift_right), GlobalKeyOutcome::Pass, "no live selection: the prompt gets it");
    host.grid_active = true;
    assert_eq!(handle_global_key(&mut host, "", &shift_right), GlobalKeyOutcome::Consumed);
    assert_eq!(host.named("moveFocus"), [json!(["moveFocus", "right"])]);
    assert_eq!(handle_global_key(&mut host, "\x1b[1;2A", &KeyFlags::default()), GlobalKeyOutcome::Consumed);
    host.picker = true;
    host.events.clear();
    assert_eq!(handle_global_key(&mut host, "", &shift_right), GlobalKeyOutcome::Pass, "a picker owns the keys");
    assert!(host.named("moveFocus").is_empty());
}

#[test]
fn escape_closes_a_panel_then_pages_and_the_final_escape_clears_the_selections() {
    let escape = key(|k| k.escape = true);
    let mut host = H::new();
    host.usage = true;
    assert_eq!(handle_global_key(&mut host, "", &escape), GlobalKeyOutcome::Consumed);
    host.usage = false;
    host.context = true;
    assert_eq!(handle_global_key(&mut host, "", &escape), GlobalKeyOutcome::Consumed);
    assert_eq!(host.f.log.iter().filter(|entry| entry[0] == "closeUsage").count(), 1);
    assert_eq!(host.f.log.iter().filter(|entry| entry[0] == "clearContext").count(), 1);

    host.context = false;
    host.events.clear();
    assert_eq!(handle_global_key(&mut host, "", &escape), GlobalKeyOutcome::Pass, "the prompt still sees the escape");
    assert_eq!(host.named("resetDrag").len() + host.named("clearPromptSelection").len() + host.named("clearRect").len(), 3);

    host.picker = true;
    host.events.clear();
    handle_global_key(&mut host, "", &escape);
    assert!(host.named("resetDrag").is_empty(), "a picker's escape is the picker's");
}

#[test]
fn paging_scrolls_by_sixty_percent_of_the_rows_unless_an_overlay_owns_the_keys() {
    let page_up = key(|k| k.page_up = true);
    let page_down = key(|k| k.page_down = true);
    let mut host = H::new();
    host.rows = Some(50);
    handle_global_key(&mut host, "", &page_up);
    handle_global_key(&mut host, "", &page_down);
    assert_eq!(host.named("scroll"), [json!(["scroll", 30]), json!(["scroll", -30])]);
    host.rows = Some(2);
    host.events.clear();
    handle_global_key(&mut host, "", &page_up);
    assert_eq!(host.named("scroll"), [json!(["scroll", 3])], "at least three rows");
    host.rows = None;
    host.events.clear();
    handle_global_key(&mut host, "", &page_up);
    assert_eq!(host.named("scroll"), [json!(["scroll", 14])], "24 rows when the size is unknown");
    host.scroll_focus = OverlayOwner { btw_panel: true, ..OverlayOwner::default() };
    host.events.clear();
    assert_eq!(handle_global_key(&mut host, "", &page_up), GlobalKeyOutcome::Consumed);
    assert!(host.named("scroll").is_empty());

    let ctrl_end = key(|k| {
        k.ctrl = true;
        k.end = true;
    });
    handle_global_key(&mut host, "", &ctrl_end);
    assert_eq!(host.named("resetScroll").len(), 1);
    handle_global_key(&mut host, "o", &key(|k| k.ctrl = true));
    assert_eq!(host.named("toggleExpand").len(), 1);
    assert_eq!(host.named("settleDrag").len(), 3, "every keystroke settles a stuck drag first");
}

fn typing_host(previous_draft: &str) -> H {
    let mut host = H::new();
    host.p.draft = previous_draft.to_owned();
    host.p.draft_override =
        Some(mixdog_tui::handlers::state::PublishedOverride { id: 0, draft: DraftOverride { value: "x".to_owned(), cursor: None, selection_anchor: None } });
    host
}

#[test]
fn a_keystroke_lifts_the_draft_into_the_app_state_only_for_a_slash_command() {
    let mut host = typing_host("");
    apply_prompt_draft_change(&mut host, "/mo");
    assert_eq!(host.p.draft, "/mo", "a slash token can open the palette, so the app state holds it");
    assert!(host.p.draft_override.is_none(), "a typed key supersedes the published override");

    let mut prose = typing_host("");
    apply_prompt_draft_change(&mut prose, "hello there");
    assert_eq!(prose.p.draft, "", "prose renders inside the prompt input and is not lifted");

    let mut leaving = typing_host("/model");
    apply_prompt_draft_change(&mut leaving, "/model gpt");
    assert_eq!(leaving.p.draft, "/model gpt", "a draft that began as a slash flow stays in sync");

    let mut cleared = typing_host("/model");
    apply_prompt_draft_change(&mut cleared, "");
    assert_eq!(cleared.p.draft, "", "clearing the prompt clears the stale slash value");
}

#[test]
fn an_edit_that_does_not_come_from_history_ends_the_history_walk() {
    let walking = |last: &str| {
        let mut host = typing_host("");
        host.p.history_nav = HistoryNav { active: true, index: 0, seed: "seed".into(), last_value: last.into() };
        host
    };
    let mut same = walking("third");
    apply_prompt_draft_change(&mut same, "third");
    assert!(same.p.history_nav.active, "the value the walk itself put in the prompt keeps the walk");
    let mut seed = walking("third");
    apply_prompt_draft_change(&mut seed, "seed");
    assert!(seed.p.history_nav.active, "stepping back to the seed keeps the walk");
    let mut typed = walking("third");
    apply_prompt_draft_change(&mut typed, "third!");
    assert!(!typed.p.history_nav.active, "typing over a history entry ends the walk");
    let mut emptied = walking("third");
    apply_prompt_draft_change(&mut emptied, "");
    assert!(!emptied.p.history_nav.active, "an empty prompt ends the walk");
}

#[test]
fn the_change_a_history_step_makes_does_not_show_a_hint_and_clears_a_live_one() {
    let mut host = typing_host("");
    host.p.history_draft_change = true;
    host.p.hint.show("live", HintTone::Info, None, 0);
    apply_prompt_draft_change(&mut host, "an older prompt");
    assert!(!host.p.history_draft_change, "the flag covers one change only");
    assert!(!host.p.hint.is_live(), "the hint of the step is cleared");

    let mut quiet = typing_host("");
    apply_prompt_draft_change(&mut quiet, "x");
    assert!(!quiet.p.hint.is_live(), "a keystroke with nothing to hint leaves no hint");
}

#[test]
fn a_dismissed_palette_stays_dismissed_until_the_text_changes() {
    let mut host = typing_host("/mo");
    host.p.slash_dismissed_for = "/mo".to_owned();
    apply_prompt_draft_change(&mut host, "/mo");
    assert_eq!(host.p.slash_dismissed_for, "/mo", "the same text keeps the palette closed");
    apply_prompt_draft_change(&mut host, "/mod");
    assert_eq!(host.p.slash_dismissed_for, "", "the next edit lets it open again");
}
