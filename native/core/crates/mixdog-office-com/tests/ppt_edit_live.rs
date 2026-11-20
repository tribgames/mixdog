//! The PowerPoint editor against real Microsoft PowerPoint and Excel. The test is `#[ignore]`d: it starts both, so it runs only on
//! request (`cargo test -p mixdog-office-com --test ppt_edit_live -- --ignored`) on a Windows machine with Microsoft PowerPoint and
//! Excel and `MIXDOG_TEST_LIVE_OFFICE=1`. Without that variable a test that was asked for ends at once and says it did nothing.
//!
//! Every scenario of `tests/scenarios/ppt-edit.json` runs through the Rust session lifecycle and actions in this process, in a
//! directory of its own. Each answer must hold what its step expects (`expect.contains`), no window of the owned PowerPoint or of
//! a chart's Excel may be visible at any moment of a background batch (a thread polls for it), and no POWERPNT or EXCEL process
//! may be left that was not there before, whether a step failed or not (a failed chart creation included).
#![cfg(windows)]

use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::time::Duration;
use std::time::Instant;

use mixdog_fsio::Unlaned;
use mixdog_office_com::actions::Actions;
use mixdog_office_com::actions::session_actions::invoke_session_action;
use mixdog_office_com::com::live::Sta;
use mixdog_office_com::drivers::Drivers;
use mixdog_office_com::host::Emitter;
use mixdog_office_com::office::Env;
use mixdog_office_com::office::LiveApplications;
use mixdog_office_com::platform::Platform;
use mixdog_office_com::platform::WindowsPlatform;
use mixdog_office_com::ps::json::emit_json;
use mixdog_office_com::ps::payload;
use mixdog_office_com::state::SessionState;
use mixdog_office_com::state::close_session;
use mixdog_office_com::state::open_session_response;
use mixdog_office_com::state::open_session_state;
use serde_json::Value as Json;

fn live_office() -> bool {
    std::env::var("MIXDOG_TEST_LIVE_OFFICE").as_deref() == Ok("1")
}

fn crate_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("mixdog-office-ppt-edit-live-{}-{name}", std::process::id()));
    let _ = mixdog_fsio::remove_dir_all(&Unlaned, &dir);
    mixdog_fsio::create_dir_all(&Unlaned, &dir).expect("a scratch directory");
    dir
}

/// `${work}` of every string of the request, the work directory.
fn substitute(value: &Json, work: &str) -> Json {
    match value {
        Json::String(text) => Json::String(text.replace("${work}", work)),
        Json::Array(items) => Json::Array(items.iter().map(|item| substitute(item, work)).collect()),
        Json::Object(fields) => Json::Object(fields.iter().map(|(key, item)| (key.clone(), substitute(item, work))).collect()),
        other => other.clone(),
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// One run of a scenario.

struct Run {
    work: PathBuf,
}

fn steps_of(scenario: &Json) -> Vec<&Json> {
    scenario["steps"].as_array().expect("the steps").iter().collect()
}

fn copy_input(step: &Json, work: &Path) {
    let from = crate_dir().join("tests").join("inputs").join(step["copy"].as_str().expect("a file"));
    let name = step.get("as").and_then(Json::as_str).unwrap_or_else(|| step["copy"].as_str().expect("a file"));
    let bytes = mixdog_fsio::read(&Unlaned, &from).unwrap_or_else(|error| panic!("{}: {error}", from.display()));
    mixdog_fsio::write(&Unlaned, &work.join(name), &bytes).expect("the input is copied");
}

fn run_in_process(env: &Env<'_>, scenario: &Json, work: PathBuf, watching: &AtomicBool) -> Run {
    let work_text = work.to_string_lossy().into_owned();
    let mut states: BTreeMap<String, SessionState> = BTreeMap::new();
    for step in steps_of(scenario) {
        if step.get("copy").is_some() {
            copy_input(step, &work);
            continue;
        }
        let Some(send) = step.get("send") else { continue };
        let request = substitute(&send["request"], &work_text);
        let parsed = payload::parse_payload(&request.to_string()).expect("a request");
        let action = request["action"].as_str().unwrap_or_default().to_owned();
        let id = request["session"].as_str().unwrap_or_default().to_owned();
        let background_batch = action == "batch" && states.get(&id).is_some_and(|state| state.mode.as_str() == "background");
        watching.store(background_batch, Ordering::SeqCst);
        let answer = match action.as_str() {
            "open_session" => {
                let mut out = Emitter::stdio();
                match open_session_state(&Unlaned, env, &mut out, &parsed) {
                    Ok(mut state) => {
                        let opened = open_session_response(&mut state, env).map(|value| emit_json(&value));
                        states.insert(id.clone(), state);
                        opened.map_or_else(|message| serde_json::json!({"ok": false, "error": message}), |text| serde_json::from_str(&text).expect("the answer is JSON"))
                    }
                    Err(message) => serde_json::json!({"ok": false, "error": message}),
                }
            }
            "close_session" => {
                let state = states.get_mut(&id).unwrap_or_else(|| panic!("no session {id}"));
                let closed = close_session(state, env, &parsed).expect("the close answers");
                let answer: Json = serde_json::from_str(&emit_json(&closed.result)).expect("the answer is JSON");
                if closed.closed {
                    states.remove(&id);
                }
                answer
            }
            _ => {
                let state = states.get_mut(&id).unwrap_or_else(|| panic!("no session {id}"));
                let actions = Actions { env: *env, proof: &Unlaned, drivers: Drivers::registered() };
                let mut out = Emitter::stdio();
                match invoke_session_action(&actions, &mut out, state, &parsed) {
                    Ok(value) => serde_json::from_str(&emit_json(&value)).expect("the answer is JSON"),
                    Err(message) => serde_json::json!({"ok": false, "error": message}),
                }
            }
        };
        watching.store(false, Ordering::SeqCst);
        if let Some(expected) = step.get("expect").and_then(|expect| expect.get("contains")).and_then(Json::as_str) {
            assert!(answer.to_string().contains(expected), "{}: the answer lacks {expected}: {answer}", scenario["id"]);
        }
    }
    Run { work }
}

// ---------------------------------------------------------------------------------------------------------------------
// The windows of the owned applications, polled.

fn office_processes(platform: &WindowsPlatform) -> BTreeSet<i32> {
    ["pptx", "xlsx"].iter().flat_map(|format| platform.office_process_ids(format)).collect()
}

#[test]
#[ignore = "starts Microsoft PowerPoint and Excel; MIXDOG_TEST_LIVE_OFFICE=1"]
fn the_editor_meets_what_every_scenario_expects_and_leaves_no_process() {
    if !live_office() {
        eprintln!("MIXDOG_TEST_LIVE_OFFICE is not 1: nothing was run");
        return;
    }
    let text = mixdog_fsio::read_to_string(&Unlaned, &crate_dir().join("tests").join("scenarios").join("ppt-edit.json")).expect("the scenarios");
    let file: Json = serde_json::from_str(&text).expect("the scenarios are JSON");
    let _apartment = Sta::enter().expect("an apartment");
    let platform = WindowsPlatform::new().expect("the Windows layer");
    let env = Env { platform: &platform, applications: &LiveApplications };
    let before = office_processes(&platform);

    // The poll: while a background batch runs, no window of a process that was not there before may be visible.
    let watching = Arc::new(AtomicBool::new(false));
    let stop = Arc::new(AtomicBool::new(false));
    let violations: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let poller = {
        let (watching, stop, violations, before) = (Arc::clone(&watching), Arc::clone(&stop), Arc::clone(&violations), before.clone());
        std::thread::spawn(move || {
            let platform = WindowsPlatform::new().expect("the Windows layer of the poll");
            while !stop.load(Ordering::SeqCst) {
                if watching.load(Ordering::SeqCst) {
                    for process in office_processes(&platform).difference(&before) {
                        if platform.visible_window_count_for_process(*process) > 0 {
                            violations.lock().expect("the list").extend(platform.visible_window_descriptions_for_process(*process));
                        }
                    }
                }
                std::thread::sleep(Duration::from_millis(20));
            }
        })
    };

    for scenario in file["scenarios"].as_array().expect("scenarios") {
        let id = scenario["id"].as_str().expect("an id");
        let rust = run_in_process(&env, scenario, scratch(id), &watching);
        let _ = mixdog_fsio::remove_dir_all(&Unlaned, &rust.work);
    }
    stop.store(true, Ordering::SeqCst);
    poller.join().expect("the poll ends");
    assert!(violations.lock().expect("the list").is_empty(), "a window of the owned applications was visible during a background batch: {:?}", violations.lock().expect("the list"));

    // No process is left that was not there before (the applications quit on their own: the wait is bounded).
    let deadline = Instant::now() + Duration::from_secs(20);
    while office_processes(&platform) != before && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(250));
    }
    assert_eq!(office_processes(&platform), before, "POWERPNT or EXCEL was left running");
}
