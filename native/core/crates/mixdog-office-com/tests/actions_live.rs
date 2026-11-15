//! The actions against real Microsoft Office. Every test is `#[ignore]`: it starts Office, so it runs only on request
//! (`cargo test -p mixdog-office-com --test actions_live -- --ignored`) on a Windows machine with Office and
//! `MIXDOG_TEST_LIVE_OFFICE=1`. Without that variable a test that was asked for ends at once and says it did nothing.
//!
//! The scenarios of `tests/scenarios/actions.json` that need no reader or editor of an application (those are written
//! by the application tasks, and their scenarios are run through the transport once they are registered): a background
//! session of each format created, saved, rendered (a deck twice: the second export needs a reopen), copied and closed, with
//! every rendered PDF on disk and no Office process left that was not there before; the reload of a deck from a file written
//! elsewhere; and a workbook with `horizontalDpi="0"` repaired when the session reopens it (the reader-dependent
//! `post_save_validate` is run once the readers are registered).
#![cfg(windows)]

use std::path::PathBuf;

use mixdog_fsio::Unlaned;
use mixdog_office_com::actions::Actions;
use mixdog_office_com::actions::reopen::reopen_background_excel_session;
use mixdog_office_com::actions::session_actions::invoke_session_action;
use mixdog_office_com::com::live::Sta;
use mixdog_office_com::drivers::Drivers;
use mixdog_office_com::host::Emitter;
use mixdog_office_com::office::Env;
use mixdog_office_com::office::LiveApplications;
use mixdog_office_com::platform::Platform;
use mixdog_office_com::platform::WindowsPlatform;
use mixdog_office_com::ps::Value;
use mixdog_office_com::ps::json::emit_json;
use mixdog_office_com::ps::payload;
use mixdog_office_com::state::SessionState;
use mixdog_office_com::state::close_session;
use mixdog_office_com::state::open_session_state;
use serde_json::Value as Json;
use serde_json::json;

fn live_office() -> bool {
    std::env::var("MIXDOG_TEST_LIVE_OFFICE").as_deref() == Ok("1")
}

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("mixdog-office-actions-live-{}-{name}", std::process::id()));
    let _ = mixdog_fsio::remove_dir_all(&Unlaned, &dir);
    mixdog_fsio::create_dir_all(&Unlaned, &dir).expect("a scratch directory");
    dir
}

fn request(value: &Json) -> Value {
    payload::parse_payload(&value.to_string()).expect("a request")
}

fn processes(platform: &WindowsPlatform) -> Vec<Vec<i32>> {
    ["docx", "xlsx", "pptx"].iter().map(|format| platform.office_process_ids(format)).collect()
}

/// One action of the open session, answered as the session host answers it (the line it writes).
fn act(env: &Env<'_>, state: &mut SessionState, body: &Json) -> String {
    let actions = Actions { env: *env, proof: &Unlaned, drivers: Drivers::registered() };
    let mut out = Emitter::stdio();
    match invoke_session_action(&actions, &mut out, state, &request(body)) {
        Ok(answer) => emit_json(&answer),
        Err(message) => panic!("{body}: {message}"),
    }
}

fn open(env: &Env<'_>, format: &str, path: &PathBuf, create: bool) -> SessionState {
    let body = json!({"action": "open_session", "session": format!("live-{format}"), "format": format, "path": path, "mode": "background", "create": create});
    let mut out = Emitter::stdio();
    open_session_state(&Unlaned, env, &mut out, &request(&body)).expect("the session opens")
}

fn close(env: &Env<'_>, state: &mut SessionState, id: &str) {
    let closed = close_session(state, env, &request(&json!({"action": "close_session", "session": id, "save": true}))).expect("the close answers");
    assert!(closed.closed, "{}", emit_json(&closed.result));
}

fn pdf_size(path: &PathBuf) -> u64 {
    mixdog_fsio::metadata(&Unlaned, path).expect("the PDF is on disk").len()
}

#[test]
#[ignore = "starts Microsoft Office; MIXDOG_TEST_LIVE_OFFICE=1"]
fn a_background_session_of_each_format_saves_renders_and_leaves_no_office_process() {
    if !live_office() {
        eprintln!("MIXDOG_TEST_LIVE_OFFICE is not 1: nothing was run");
        return;
    }
    let _apartment = Sta::enter().expect("an apartment");
    let platform = WindowsPlatform::new().expect("the Windows layer");
    let env = Env { platform: &platform, applications: &LiveApplications };
    let dir = scratch("sessions");
    for format in ["docx", "xlsx", "pptx"] {
        let before = processes(&platform);
        let path = dir.join(format!("live.{format}"));
        let mut state = open(&env, format, &path, true);
        let id = format!("live-{format}");
        assert!(act(&env, &mut state, &json!({"action": "save", "session": id})).contains("\"saved\":true"), "{format}: save");
        let first = dir.join(format!("{format}-1.pdf"));
        act(&env, &mut state, &json!({"action": "render", "session": id, "output": first}));
        assert!(pdf_size(&first) > 0, "{format}: the first render");
        if format == "pptx" {
            let second = dir.join("pptx-2.pdf");
            act(&env, &mut state, &json!({"action": "render", "session": id, "output": second}));
            assert!(pdf_size(&second) > 0, "the second render of a deck in one session needs a reopen and gets one");
        }
        if format != "docx" {
            let copy = dir.join(format!("copy.{format}"));
            act(&env, &mut state, &json!({"action": "save_copy", "session": id, "output": copy}));
            assert!(mixdog_fsio::is_file(&Unlaned, &copy), "{format}: the copy");
        }
        close(&env, &mut state, &id);
        assert!(mixdog_fsio::is_file(&Unlaned, &path), "{format}: the document was saved");
        assert_eq!(processes(&platform), before, "{format}: no Office process was left that was not there before");
    }
    let _ = mixdog_fsio::remove_dir_all(&Unlaned, &dir);
}

#[test]
#[ignore = "starts Microsoft PowerPoint; MIXDOG_TEST_LIVE_OFFICE=1"]
fn a_deck_written_elsewhere_is_reloaded_into_the_running_application() {
    if !live_office() {
        eprintln!("MIXDOG_TEST_LIVE_OFFICE is not 1: nothing was run");
        return;
    }
    let _apartment = Sta::enter().expect("an apartment");
    let platform = WindowsPlatform::new().expect("the Windows layer");
    let env = Env { platform: &platform, applications: &LiveApplications };
    let dir = scratch("reload");
    let source_path = dir.join("source.pptx");
    let mut source = open(&env, "pptx", &source_path, true);
    close(&env, &mut source, "live-pptx");
    let target = dir.join("target.pptx");
    let mut state = open(&env, "pptx", &target, true);
    let answer = act(&env, &mut state, &json!({"action": "reload_document", "session": "live-pptx", "source": source_path}));
    assert!(answer.contains("\"reloaded\":true"), "{answer}");
    assert!(!mixdog_fsio::is_file(&Unlaned, &source_path), "the source was moved onto the session path");
    close(&env, &mut state, "live-pptx");
    let _ = mixdog_fsio::remove_dir_all(&Unlaned, &dir);
}

#[test]
#[ignore = "starts Microsoft Excel; MIXDOG_TEST_LIVE_OFFICE=1"]
fn a_workbook_with_a_zero_dpi_is_repaired_when_the_session_reopens_it() {
    if !live_office() {
        eprintln!("MIXDOG_TEST_LIVE_OFFICE is not 1: nothing was run");
        return;
    }
    let _apartment = Sta::enter().expect("an apartment");
    let platform = WindowsPlatform::new().expect("the Windows layer");
    let env = Env { platform: &platform, applications: &LiveApplications };
    let dir = scratch("dpi");
    let path = dir.join("zero.xlsx");
    let input = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests").join("fixtures").join("actions").join("inputs").join("zero-dpi.xlsx");
    mixdog_fsio::copy(&Unlaned, &input, &path).expect("the workbook");
    let mut state = open(&env, "xlsx", &path, false);
    let actions = Actions { env, proof: &Unlaned, drivers: Drivers::registered() };
    reopen_background_excel_session(&actions, &mut state, "").expect("the workbook reopens");
    assert_eq!(state.excel_dpi_repairs, 1, "the one worksheet with a zero DPI was repaired");
    close(&env, &mut state, "live-xlsx");
    let _ = mixdog_fsio::remove_dir_all(&Unlaned, &dir);
}
