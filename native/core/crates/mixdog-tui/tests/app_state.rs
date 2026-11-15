//! The application state driven with a scripted store and a hand-set clock: panel ownership, the first mount (the project picker
//! present in the first frame, the onboarding verdict), the theme epoch, the setup `open` request and every path of the exit flow.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::Arc;

use mixdog_term::KeyFlags;
use mixdog_tui::app::clock::Clock;
use mixdog_tui::app::picker::AppPicker;
use mixdog_tui::app::store::AppStore;
use mixdog_tui::app::{AppCtx, AppOptions, AppState};
use mixdog_tui::handlers::exit::ExitStep;
use mixdog_tui::pickers::extensions::ExtensionsHost;
use mixdog_tui::slash::host::{Opener, SlashHost};
use mixdog_tui::surface::SurfaceKind;
use serde_json::{Value, json};

type Calls = Rc<RefCell<Vec<(String, Value)>>>;

/// A store that answers from a table and records what it was asked.
struct FakeStore {
    calls: Calls,
    answers: HashMap<String, Result<Value, String>>,
    state: Arc<Value>,
    onboarding_completed: bool,
    notices: Rc<RefCell<Vec<(String, String)>>>,
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

    fn push_notice(&mut self, text: &str, level: &str) {
        self.notices.borrow_mut().push((text.to_owned(), level.to_owned()));
    }

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
        self.onboarding_completed
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
}

fn harness(items: usize, completed: bool, force: bool, answers: Vec<(&str, Result<Value, String>)>) -> Harness {
    let calls: Calls = Rc::new(RefCell::new(Vec::new()));
    let clock = Clock::new(1_000);
    let state = json!({ "items": (0..items).map(|n| json!({ "id": format!("u{n}"), "kind": "user", "text": "hi" })).collect::<Vec<_>>(), "cwd": "C:/work" });
    let store = FakeStore {
        calls: Rc::clone(&calls),
        answers: answers.into_iter().map(|(name, answer)| (name.to_owned(), answer)).collect(),
        state: Arc::new(state),
        onboarding_completed: completed,
        notices: Rc::new(RefCell::new(Vec::new())),
    };
    let options = AppOptions { cwd: "C:/work".to_owned(), version: "1.2.3".to_owned(), force_onboarding: force, onboarding_completed: Some(completed) };
    let app = AppState::new(Box::new(store), clock.clone(), options);
    Harness { app, clock, calls }
}

fn project_panel(app: &AppState) -> Option<(bool, bool)> {
    match app.surface.picker() {
        Some(AppPicker::Ext(panel)) if panel.kind == "project" => Some((panel.loading, panel.initial_pending)),
        _ => None,
    }
}

#[test]
fn an_empty_session_starts_with_the_project_picker_already_in_the_first_frame() {
    let mut h = harness(0, true, false, vec![("listProjects", Ok(json!([{ "path": "C:/work/a", "alias": "a" }])))]);
    h.app.mount();
    // Before anything ran: the loading frame of the project list is the picker, and no store call was made for it yet.
    assert_eq!(project_panel(&h.app), Some((true, true)));
    assert!(h.calls_named("listProjects").is_empty());
    assert!(h.app.background_pending());
    // The read that fills it runs after that frame.
    while h.app.run_background() {}
    assert_eq!(h.calls_named("listProjects").len(), 1);
    assert_eq!(project_panel(&h.app), Some((false, false)));
}

#[test]
fn a_session_with_items_or_the_wizard_owning_the_screen_has_no_project_picker() {
    let mut with_items = harness(2, true, false, vec![]);
    with_items.app.mount();
    assert!(with_items.app.surface.picker().is_none());

    let mut forced = harness(0, true, true, vec![]);
    forced.app.mount();
    assert!(forced.app.surface.picker().is_none());
    assert!(forced.app.onboarding_active());

    let mut unfinished = harness(0, false, false, vec![]);
    unfinished.app.mount();
    assert!(unfinished.app.surface.picker().is_none());
    assert!(unfinished.app.onboarding_active());
}

#[test]
fn the_wizard_launches_once_and_only_when_onboarding_is_not_completed() {
    let mut done = harness(0, true, false, vec![]);
    done.app.mount();
    assert!(!done.app.onboarding_active());

    let mut h = harness(0, false, false, vec![("getProviderSetup", Ok(json!({ "providers": [] })))]);
    h.app.mount();
    h.app.mount();
    assert!(h.app.onboarding_active());
    while h.app.run_background() {}
    // The first step reads the provider setup once; a second mount did not launch another wizard.
    assert_eq!(h.calls_named("getProviderSetup").len(), 1);
    assert!(h.app.surface.picker().is_some());
}

#[test]
fn the_disabled_skills_are_read_once_after_the_first_frame_and_a_failure_leaves_every_skill_enabled() {
    let mut h = harness(1, true, false, vec![("getDisabledSkills", Ok(json!({ "disabled": ["review", "notes"] })))]);
    h.app.mount();
    assert!(ExtensionsHost::disabled_skills(&h.app).is_empty());
    while h.app.run_background() {}
    let skills = ExtensionsHost::disabled_skills(&h.app);
    assert!(skills.contains("review") && skills.contains("notes"));
    assert_eq!(h.calls_named("getDisabledSkills").len(), 1);

    let mut failing = harness(1, true, false, vec![("getDisabledSkills", Err("offline".to_owned()))]);
    failing.app.mount();
    while failing.app.run_background() {}
    assert!(ExtensionsHost::disabled_skills(&failing.app).is_empty());
}

#[test]
fn the_catalog_warm_up_waits_its_delay_then_lists_both_catalogs_once() {
    let mut h = harness(1, true, false, vec![("listProviderModels", Ok(json!([{ "provider": "openai", "id": "gpt" }]))), ("listWebSearchModels", Ok(json!([{ "provider": "openai", "id": "gpt" }])))]);
    h.app.mount();
    while h.app.run_background() {}
    assert!(h.calls_named("listProviderModels").is_empty());
    assert_eq!(h.app.next_deadline(), Some(1_000 + 1500));
    h.clock.advance(1500);
    assert!(h.app.background_pending());
    while h.app.run_background() {}
    assert_eq!(h.calls_named("listProviderModels").len(), 1);
    assert_eq!(h.calls_named("listWebSearchModels").len(), 1);
    assert!(!h.app.background_pending());
}

#[test]
fn a_newer_panel_supersedes_the_claim_of_an_older_one_and_a_closed_claim_stays_closed() {
    let mut h = harness(1, true, false, vec![]);
    let first = h.app.paint_loading_frame("model", "Model").expect("the surface is free");
    assert!(h.app.owns_surface(first));
    assert!(matches!(h.app.surface.picker(), Some(AppPicker::Slash(_))));
    // A different panel takes the surface: the first claim no longer holds and cannot paint or close anything.
    let second = h.app.paint_loading_frame("theme", "Theme").expect("the first panel's claim re-armed");
    assert!(!h.app.owns_surface(first));
    assert!(h.app.owns_surface(second));
    h.app.close_surface(first);
    assert!(h.app.surface.picker().is_some());
    h.app.close_surface(second);
    assert!(h.app.surface.picker().is_none());
    assert!(!h.app.owns_surface(second));
    // A late result under the closed claim paints nothing.
    assert!(h.app.paint_loading_frame("model", "Model").is_some());
    let stale = second;
    h.app.close_surface(stale);
    assert!(matches!(h.app.surface.picker(), Some(AppPicker::Slash(_))));
}

#[test]
fn the_theme_stays_in_this_process_and_every_switch_bumps_the_epoch_and_is_mirrored_to_the_core() {
    let mut h = harness(1, true, false, vec![]);
    let before = h.app.theme_epoch();
    let listed = h.app.store_call("listThemes", json!([])).expect("listed locally");
    assert!(listed.as_array().is_some_and(|themes| !themes.is_empty()));
    assert!(h.calls_named("listThemes").is_empty());
    let id = listed[0]["id"].as_str().expect("an id").to_owned();
    let applied = h.app.store_call("setTheme", json!([id, { "persist": false }])).expect("applied");
    assert_eq!(applied["id"], json!(id));
    assert!(h.app.theme_epoch() > before);
    assert_eq!(h.app.store_call("getTheme", json!([])).expect("read"), json!(id));
    // The core is told, with the persistence the caller asked for.
    assert_eq!(h.calls_named("setTheme"), vec![json!([id, { "persist": false }])]);
    h.app.store_call("setTheme", json!([id])).expect("applied");
    assert_eq!(h.calls_named("setTheme")[1], json!([id, { "persist": true }]));
}

#[test]
fn a_setup_open_request_runs_its_command_once_per_sequence_number() {
    let mut h = harness(1, true, false, vec![]);
    h.app.on_ui_open_request("theme", 1);
    let epoch = h.app.surface.epoch().current();
    assert!(h.app.surface.picker().is_some());
    // The same request again is history.
    h.app.on_ui_open_request("theme", 1);
    assert_eq!(h.app.surface.epoch().current(), epoch);
    // A section without a slash command: connection pairing says where it lives.
    h.app.on_ui_open_request("connection", 2);
}

#[test]
fn the_exit_flushes_the_final_frame_then_disposes_then_exits_and_a_second_request_changes_nothing() {
    let mut h = harness(1, true, false, vec![]);
    assert!(!h.app.exiting());
    assert_eq!(h.app.exit_step(), ExitStep::Wait);
    h.app.request_exit();
    assert!(h.app.exiting());
    h.clock.advance(10);
    h.app.request_exit();
    assert_eq!(h.app.exit_step(), ExitStep::Wait);
    h.clock.advance(60);
    assert_eq!(h.app.exit_step(), ExitStep::Dispose);
    assert_eq!(h.app.exit_step(), ExitStep::Wait);
    h.app.dispose_settled();
    assert_eq!(h.app.exit_step(), ExitStep::Exit);
    assert_eq!(h.app.exit_step(), ExitStep::Wait);
}

#[test]
fn a_dispose_that_never_settles_is_raced_and_a_hung_exit_is_ended_by_the_hard_timer() {
    let mut raced = harness(1, true, false, vec![]);
    raced.app.request_exit();
    raced.clock.advance(60);
    assert_eq!(raced.app.exit_step(), ExitStep::Dispose);
    raced.clock.advance(350);
    assert_eq!(raced.app.exit_step(), ExitStep::Exit);

    let mut hung = harness(1, true, false, vec![]);
    hung.app.request_exit();
    hung.clock.advance(2_000);
    assert_eq!(hung.app.exit_step(), ExitStep::HardExit);
    assert_eq!(hung.app.exit_step(), ExitStep::Wait);
}

#[test]
fn a_continuation_names_its_target_and_the_app_claims_a_picker_surface_on_request() {
    let mut h = harness(1, true, false, vec![]);
    let claim = h.app.claim_surface(SurfaceKind::Picker);
    assert!(h.app.owns_surface(claim));
    let opened = SlashHost::open(&mut h.app, Opener::Theme, json!({}));
    assert!(opened.is_ok());
    // Nothing was on screen, so painting the first picker is not a handover: the claim taken before it still holds.
    assert!(h.app.owns_surface(claim));
    assert!(h.app.surface.picker().is_some());
}

#[test]
fn typing_a_quit_command_and_pressing_enter_starts_the_exit_and_freezes_the_prompt() {
    let mut h = harness(1, true, false, vec![]);
    h.app.chrome.tick_after_mount();
    assert!(h.app.prompt_key("/quit", &KeyFlags::default()));
    assert!(!h.app.exiting());
    let enter = KeyFlags { return_key: true, ..KeyFlags::default() };
    assert!(h.app.prompt_key("\r", &enter));
    assert!(h.app.exiting());
}
