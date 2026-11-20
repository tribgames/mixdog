//! The session lifecycle against real Microsoft Office. Every test is `#[ignore]`: it starts Office, shows an Excel window
//! and drives the foreground, so it runs only on request (`cargo test -p mixdog-office-com --test session_live -- --ignored`)
//! on a Windows machine with Office and `MIXDOG_TEST_LIVE_OFFICE=1`. Without that variable a test that was asked for ends
//! at once and says it did nothing.
//!
//! The scenarios of `tests/scenarios/session.json` through the lifecycle in this process, on a single-threaded apartment
//! of its own: open and create per format in the background, closed with a save; no WINWORD, EXCEL or POWERPNT process is
//! left that was not there before; and a user's visible Excel holding a workbook is still running, workbook open, after an
//! attach session on that workbook closes.
#![cfg(windows)]

use std::path::PathBuf;

use mixdog_fsio::Unlaned;
use mixdog_office_com::com::Value as Com;
use mixdog_office_com::com::live::Sta;
use mixdog_office_com::com::live::create_object;
use mixdog_office_com::host::Emitter;
use mixdog_office_com::office::Env;
use mixdog_office_com::office::LiveApplications;
use mixdog_office_com::platform::Platform;
use mixdog_office_com::platform::WindowsPlatform;
use mixdog_office_com::ps::json::emit_json;
use mixdog_office_com::ps::payload;
use mixdog_office_com::state::close_session;
use mixdog_office_com::state::open_session_response;
use mixdog_office_com::state::open_session_state;
use serde_json::Value as Json;
use serde_json::json;

fn live_office() -> bool {
    std::env::var("MIXDOG_TEST_LIVE_OFFICE").as_deref() == Ok("1")
}

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("mixdog-office-session-live-{}-{name}", std::process::id()));
    let _ = mixdog_fsio::remove_dir_all(&Unlaned, &dir);
    mixdog_fsio::create_dir_all(&Unlaned, &dir).expect("a scratch directory");
    dir
}

/// One session of the request: opened, answered, closed (saved when `save`); the answers of the open and of the close.
fn run_session(env: &Env<'_>, request: &Json, save: bool) -> (String, String, bool) {
    let mut out = Emitter::stdio();
    let mut state = open_session_state(&Unlaned, env, &mut out, &payload::parse_payload(&request.to_string()).expect("a request")).expect("the session opens");
    let opened = emit_json(&open_session_response(&mut state, env).expect("the open answers"));
    let close = json!({"action": "close_session", "session": request["session"], "save": save});
    let closed = close_session(&mut state, env, &payload::parse_payload(&close.to_string()).expect("a request")).expect("the close answers");
    (opened, emit_json(&closed.result), closed.closed)
}

#[test]
#[ignore = "starts Microsoft Office; MIXDOG_TEST_LIVE_OFFICE=1"]
fn background_sessions_create_save_and_close_without_leaving_an_office_process() {
    if !live_office() {
        eprintln!("MIXDOG_TEST_LIVE_OFFICE is not 1: nothing was run");
        return;
    }
    let _apartment = Sta::enter().expect("an apartment");
    let platform = WindowsPlatform::new().expect("the Windows layer");
    let env = Env { platform: &platform, applications: &LiveApplications };
    let dir = scratch("background");
    for format in ["docx", "xlsx", "pptx"] {
        let before: Vec<Vec<i32>> = ["docx", "xlsx", "pptx"].iter().map(|kind| platform.office_process_ids(kind)).collect();
        let path = dir.join(format!("live.{format}"));
        let request =
            json!({"action": "open_session", "session": format!("live-{format}"), "format": format, "path": path, "mode": "background", "create": true});
        let (opened, closed, ok) = run_session(&env, &request, true);
        assert!(opened.contains("\"opened\":true") && opened.contains("\"mode\":\"background\""), "{format}: {opened}");
        assert!(ok && closed.contains("\"closed\":true"), "{format}: {closed}");
        assert!(mixdog_fsio::is_file(&Unlaned, &path), "{format}: the document was saved");
        let after: Vec<Vec<i32>> = ["docx", "xlsx", "pptx"].iter().map(|kind| platform.office_process_ids(kind)).collect();
        assert_eq!(after, before, "{format}: no Office process was left that was not there before");
    }
    let _ = mixdog_fsio::remove_dir_all(&Unlaned, &dir);
}

#[test]
#[ignore = "starts and shows Microsoft Excel; MIXDOG_TEST_LIVE_OFFICE=1"]
fn an_attach_session_closing_leaves_the_users_excel_running_with_the_workbook_open() {
    if !live_office() {
        eprintln!("MIXDOG_TEST_LIVE_OFFICE is not 1: nothing was run");
        return;
    }
    let _apartment = Sta::enter().expect("an apartment");
    let platform = WindowsPlatform::new().expect("the Windows layer");
    let env = Env { platform: &platform, applications: &LiveApplications };
    let dir = scratch("attach");
    let path = dir.join("users.xlsx");

    // The user's Excel: visible, with a saved workbook open.
    let users = create_object("Excel.Application").expect("Excel");
    users.put("Visible", Com::Bool(true)).expect("shown");
    let book = users.get("Workbooks").and_then(|books| books.call_member("Add", &[])).expect("a workbook").into_obj().expect("an object");
    book.call("SaveAs", &[Com::from(path.to_string_lossy().into_owned()), Com::I4(51)]).expect("saved");
    let users_pid = platform.process_id_for_window(users.get("Hwnd").expect("a window").as_i64().unwrap_or(0));
    assert!(users_pid > 0);

    let request = json!({"action": "open_session", "session": "live-attach", "format": "xlsx", "path": path, "mode": "attach"});
    let (opened, closed, ok) = run_session(&env, &request, false);
    assert!(opened.contains("\"ownership\":\"attached\""), "{opened}");
    assert!(ok && closed.contains("\"detached\":true"), "{closed}");

    assert!(platform.process_exists(users_pid), "the user's Excel is still running");
    let open_books = users.get("Workbooks").and_then(|books| books.member("Count")).expect("a count");
    assert_eq!(open_books.as_i64(), Some(1), "the workbook is still open");

    let _ = book.call("Close", &[Com::Bool(false)]);
    let _ = users.call("Quit", &[]);
    drop(book);
    drop(users);
    let _ = mixdog_fsio::remove_dir_all(&Unlaned, &dir);
}
