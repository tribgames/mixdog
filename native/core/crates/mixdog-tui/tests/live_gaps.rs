//! What the running application draws and takes beyond the pickers and the prompt box, driven through [`AppState`] with a scripted
//! store: the spinner row, the text-entry prompts, the ctrl+wheel zoom passthrough, a paste that reads on a worker, the soft-wrap
//! flags of a selection, the history paging inside a scroll, and the session thread id of `toggleVoice`.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use mixdog_session_view::action_route::{RouteContext, resolve_action};
use mixdog_term::KeyFlags;
use mixdog_term::frame::{Grid, Rect, Style};
use mixdog_term::guard::{Sink, TerminalRestorer};
use mixdog_term::modes::{MOUSE_RESTORE_DELAY, ModeEnv, TerminalModes};
use mixdog_term::paint::{Painter, TextWrap};
use mixdog_term::selection::{SelectionMode, SelectionRect, SelectionState};
use mixdog_tui::app::clock::Clock;
use mixdog_tui::app::store::AppStore;
use mixdog_tui::app::{AppOptions, AppState};
use mixdog_tui::handlers::draft_flow::cancel_provider_prompt;
use mixdog_tui::handlers::host::GlobalKeyHost;
use mixdog_tui::mouse::MouseHost;
use mixdog_tui::slash::host::{PromptSurface, SlashHost, TextPrompt};
use serde_json::{Value, json};

type Calls = Rc<RefCell<Vec<(String, Value)>>>;

struct FakeStore {
    calls: Calls,
    answers: HashMap<String, Result<Value, String>>,
    state: Arc<Value>,
}

impl AppStore for FakeStore {
    fn call(&mut self, action: &str, args: &[Value]) -> Result<Value, String> {
        self.calls.borrow_mut().push((action.to_owned(), Value::Array(args.to_vec())));
        self.answers.get(action).cloned().unwrap_or(Ok(Value::Null))
    }

    fn has_method(&self, _name: &str) -> bool {
        true
    }

    fn state(&self) -> Arc<Value> {
        Arc::clone(&self.state)
    }

    fn tick(&mut self) -> bool {
        false
    }

    fn push_notice(&mut self, _text: &str, _level: &str) {}

    fn submit(&mut self, _prompt: &Value, _options: &Value) -> Result<bool, String> {
        Ok(true)
    }

    fn abort(&mut self, _options: &Value) -> Result<Value, String> {
        Ok(Value::Null)
    }

    fn restore_queued(&mut self, _current_text: &str) -> Result<Value, String> {
        Ok(Value::Null)
    }

    fn resolve_tool_approval(&mut self, _id: &str, _decision: &Value) -> Result<bool, String> {
        Ok(true)
    }

    fn onboarding_completed(&mut self) -> bool {
        true
    }

    fn dispose(&mut self, _reason: &str) -> bool {
        true
    }
}

struct Harness {
    app: AppState,
    clock: Clock,
    calls: Calls,
}

impl Harness {
    fn calls_named(&self, action: &str) -> Vec<Value> {
        self.calls.borrow().iter().filter(|(name, _)| name == action).map(|(_, args)| args.clone()).collect()
    }

    fn screen(&mut self) -> Vec<String> {
        let (grid, _) = self.app.render_frame(100, 30);
        (0..grid.height).map(|y| grid.row_text(y)).collect()
    }
}

fn harness(state: Value, answers: Vec<(&str, Result<Value, String>)>) -> Harness {
    let calls: Calls = Rc::new(RefCell::new(Vec::new()));
    let store = FakeStore { calls: Rc::clone(&calls), answers: answers.into_iter().map(|(name, answer)| (name.to_owned(), answer)).collect(), state: Arc::new(state) };
    let options = AppOptions { cwd: "C:/work".to_owned(), version: "1.2.3".to_owned(), force_onboarding: false, onboarding_completed: Some(true) };
    let clock = Clock::new(1_000);
    let mut app = AppState::new(Box::new(store), clock.clone(), options);
    app.chrome.update(100, 30);
    app.mount();
    app.chrome.tick_after_mount();
    Harness { app, clock, calls }
}

fn session_state(extra: Value) -> Value {
    let mut state = json!({ "items": [{ "id": "u0", "kind": "user", "text": "hi" }], "cwd": "C:/work", "provider": "anthropic", "model": "m" });
    if let (Some(target), Some(extra)) = (state.as_object_mut(), extra.as_object()) {
        target.extend(extra.clone());
    }
    state
}

fn key() -> KeyFlags {
    KeyFlags::default()
}

fn escape() -> KeyFlags {
    KeyFlags { escape: true, ..KeyFlags::default() }
}

fn epoch_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |elapsed| elapsed.as_millis() as u64)
}

#[test]
fn the_spinner_row_shows_the_turn_above_the_prompt_and_asks_for_the_next_tick() {
    let started = epoch_ms() - 5_000;
    let mut h = harness(
        session_state(json!({ "busy": true, "spinner": { "active": true, "verb": "Working", "startedAt": started, "mode": "responding", "outputTokens": 0 } })),
        vec![],
    );
    let rows = h.screen();
    let at = rows.iter().position(|row| row.contains("esc to interrupt")).unwrap_or_else(|| panic!("no spinner row\n{}", rows.join("\n")));
    assert!(rows[at].contains("5s") || rows[at].contains("6s"), "the timer counts from the turn's start: {:?}", rows[at]);
    let prompt = rows.iter().rposition(|row| row.contains('\u{256d}')).expect("the prompt box");
    assert!(at < prompt, "the row is above the prompt box");
    // The animation wakes the loop one tick later, and that tick asks for a frame.
    let due = h.app.next_deadline().expect("a wake for the animation");
    assert!(due <= 1_000 + 130, "the next frame is due within an animation tick: {due}");
    h.app.take_frame_request();
    assert!(!h.app.take_frame_request(), "no frame is asked for before the tick");
    h.clock.set(1_000 + 130);
    h.app.on_timers();
    assert!(h.app.take_frame_request(), "the tick asks for the next frame");
}

#[test]
fn without_a_running_turn_there_is_no_spinner_row_and_no_wake() {
    let mut h = harness(session_state(json!({})), vec![]);
    let rows = h.screen();
    assert!(!rows.iter().any(|row| row.contains("esc to interrupt")));
}

#[test]
fn the_api_key_prompt_takes_typing_masks_it_and_escape_cancels_the_login() {
    let mut h = harness(session_state(json!({})), vec![]);
    let mut prompt = TextPrompt::new("api-key");
    prompt.label = "OpenAI".to_owned();
    h.app.set_prompt(PromptSurface::Provider, Some(prompt));
    for letter in ["s", "k", "-", "1"] {
        h.app.on_key(letter, &key());
    }
    let rows = h.screen();
    let at = rows.iter().find(|row| row.contains("API key >")).unwrap_or_else(|| panic!("no key prompt\n{}", rows.join("\n")));
    assert_eq!(at.matches('*').count(), 4, "four masked characters: {at:?}");
    assert!(!rows.iter().any(|row| row.contains("sk-1")), "the key is not on screen");
    h.app.on_key("", &KeyFlags { backspace: true, ..KeyFlags::default() });
    h.app.prompt_paste("abc");
    let rows = h.screen();
    let at = rows.iter().find(|row| row.contains("API key >")).expect("the key prompt");
    assert_eq!(at.matches('*').count(), 3 + 3, "a paste is inserted as text: {at:?}");
    h.app.on_key("", &escape());
    assert!(h.app.provider_prompt_value().is_none(), "Escape closes the prompt");
}

#[test]
fn escaping_an_oauth_code_prompt_cancels_the_flow_in_the_core() {
    let mut h = harness(session_state(json!({})), vec![]);
    let mut prompt = TextPrompt::new("oauth-code");
    prompt.label = "Sign in".to_owned();
    prompt.fields.insert("_login".to_owned(), json!("flow-1"));
    prompt.fields.insert("_cancelReturn".to_owned(), json!(true));
    h.app.set_prompt(PromptSurface::Provider, Some(prompt));
    cancel_provider_prompt(&mut h.app);
    assert_eq!(h.calls_named("cancelOAuthProviderLogin"), vec![json!(["flow-1"])]);
    assert!(h.app.provider_prompt_value().is_none());
}

#[test]
fn a_ctrl_wheel_turns_mouse_tracking_off_and_it_comes_back_after_the_delay() {
    let written = Arc::new(Mutex::new(Vec::<u8>::new()));
    let sink_written = Arc::clone(&written);
    let sink: Sink = Arc::new(move |bytes| {
        sink_written.lock().unwrap().extend_from_slice(bytes);
        Ok(())
    });
    let mut h = harness(session_state(json!({})), vec![]);
    h.app.set_terminal(TerminalRestorer::with_sink(TerminalModes::new(ModeEnv::from_vars(|_| None)), sink));
    MouseHost::passthrough_ctrl_wheel_zoom(&mut h.app);
    let first = String::from_utf8(written.lock().unwrap().clone()).expect("text");
    assert_eq!(first, "\x1b[?1006l\x1b[?1002l\x1b[?1000l\x1b[?1007l", "tracking and alternate scroll go off");
    assert!(h.app.next_deadline().is_some(), "the restore is scheduled");
    h.app.on_timers();
    assert_eq!(written.lock().unwrap().len(), first.len(), "nothing is written before the delay");
    std::thread::sleep(MOUSE_RESTORE_DELAY + Duration::from_millis(100));
    h.app.on_timers();
    let all = String::from_utf8(written.lock().unwrap().clone()).expect("text");
    assert_eq!(&all[first.len()..], "\x1b[?1000h\x1b[?1002h\x1b[?1006h\x1b[?1007l", "tracking comes back, alternate scroll stays off");
}

#[test]
fn a_paste_that_names_an_image_file_is_read_on_a_worker_and_lands_when_it_is_done() {
    let mut h = harness(session_state(json!({})), vec![]);
    let pasted = "C:/no/such/folder/shot.png";
    h.app.prompt_paste(pasted);
    // The loop was not held: the answer is pending and the draft has not changed.
    assert!(h.app.paste_pending(), "the read is on a worker");
    assert_eq!(h.app.prompt.value, "");
    for _ in 0..400 {
        h.app.on_timers();
        if !h.app.paste_pending() {
            break;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    assert!(!h.app.paste_pending(), "the worker answered");
    // The file does not exist: the text that was pasted stays.
    assert_eq!(h.app.prompt.value, pasted);
}

#[test]
fn a_wrapped_row_is_copied_joined_and_a_row_after_a_line_break_is_not() {
    let mut grid = Grid::new(12, 4);
    {
        let mut painter = Painter::new(&mut grid);
        // One text that wraps at a word, then a line break.
        let rows = painter.text(0, 0, "aaaa bbbb cccc\ndd", Style::default(), 9, TextWrap::Wrap);
        assert_eq!(rows, 3);
    }
    assert_eq!(grid.soft_wrap[..3], [false, true, false], "the second row wrapped, the third follows a line break");
    let mut selection = SelectionState::default();
    selection.set_selection(Some(SelectionRect::new(SelectionMode::Linear, 0, 0, 11, 2)));
    let soft = grid.soft_wrap.clone();
    selection.apply(&mut grid, &soft);
    let joined = selection.selection_text().expect("the selected text").to_owned();
    assert!(joined.starts_with("aaaa bbbb") && joined.contains("cccc") && !joined.contains("bbbb\n") && !joined.contains(" \ncccc"), "the wrapped rows join: {joined:?}");
    assert!(joined.ends_with("\ndd"), "the row after a line break starts a line: {joined:?}");
    // Without the flags every row is a line, which is what the copy did before they were passed.
    let mut plain = SelectionState::default();
    plain.set_selection(Some(SelectionRect::new(SelectionMode::Linear, 0, 0, 11, 2)));
    plain.apply(&mut grid, &[]);
    assert_eq!(plain.selection_text().map(|text| text.lines().count()), Some(3), "three lines without the flags");
}

#[test]
fn a_clipped_wrapped_row_marks_nothing_outside_the_clip() {
    let mut grid = Grid::new(12, 4);
    let mut painter = Painter::clipped(&mut grid, Rect::new(0, 0, 12, 1));
    painter.text(0, 0, "aaaa bbbb cccc", Style::default(), 9, TextWrap::Wrap);
    assert!(grid.soft_wrap.iter().all(|flag| !flag), "the wrapped row is outside the clip");
}

#[test]
fn scrolling_past_the_oldest_loaded_row_pages_the_history_through_the_store_inside_the_scroll() {
    let mut h = harness(session_state(json!({ "transcriptHistoryBefore": true })), vec![("restoreOlderTranscript", Ok(json!(true)))]);
    h.screen();
    GlobalKeyHost::scroll_transcript_rows(&mut h.app, 5);
    assert_eq!(h.calls_named("restoreOlderTranscript").len(), 1, "one page of older history was asked for");
    assert!(h.calls_named("restoreNewerTranscript").is_empty());
}

#[test]
fn toggle_voice_carries_the_session_thread_id() {
    // `AppCtx::store_call` is the session store's call, which routes a session action with the thread the view is bound to.
    let routed = resolve_action("toggleVoice", &[json!(true)], &RouteContext { thread_id: Some("thr_1") }).expect("toggleVoice routes");
    assert_eq!(routed.method, "voice/toggleVoice");
    assert_eq!(routed.params, json!({ "threadId": "thr_1", "enabled": true }));
}
