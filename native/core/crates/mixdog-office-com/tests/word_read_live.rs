//! The Word reader against real Microsoft Word. Every test is `#[ignore]`: it starts Word, so it runs only on request
//! (`cargo test -p mixdog-office-com --test it -- --ignored word_read_live::`) on a Windows machine with Word and
//! `MIXDOG_TEST_LIVE_OFFICE=1`. Without that variable a test that was asked for ends at once and says it did nothing.
//!
//! A background document is created, read through the registered `docx` reader (snapshot, snapshot of one paragraph, issues,
//! selection) and closed with no Office process left that was not there before. The call order and the answers of the reader
//! are pinned without Office, against scripted Word objects, in `tests/word_read.rs`; `tests/switch_word_live.rs` runs the
//! listed scenarios against Word and checks what each one states.
#![cfg(windows)]

use std::path::PathBuf;

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
    let dir = std::env::temp_dir().join(format!("mixdog-office-word-read-live-{}-{name}", std::process::id()));
    let _ = mixdog_fsio::remove_dir_all(&Unlaned, &dir);
    mixdog_fsio::create_dir_all(&Unlaned, &dir).expect("a scratch directory");
    dir
}

fn request(value: &Json) -> Value {
    payload::parse_payload(&value.to_string()).expect("a request")
}

fn act(env: &Env<'_>, state: &mut SessionState, body: &Json) -> Json {
    let actions = Actions { env: *env, proof: &Unlaned, drivers: Drivers::registered() };
    let mut out = Emitter::stdio();
    match invoke_session_action(&actions, &mut out, state, &request(body)) {
        Ok(answer) => serde_json::from_str(&emit_json(&answer)).expect("the answer is JSON"),
        Err(message) => panic!("{body}: {message}"),
    }
}

#[test]
#[ignore = "starts Microsoft Word; MIXDOG_TEST_LIVE_OFFICE=1"]
fn a_background_document_is_read_through_the_registered_reader() {
    if !live_office() {
        eprintln!("MIXDOG_TEST_LIVE_OFFICE is not 1: nothing was run");
        return;
    }
    let _apartment = Sta::enter().expect("an apartment");
    let platform = WindowsPlatform::new().expect("the Windows layer");
    let env = Env { platform: &platform, applications: &LiveApplications };
    let dir = scratch("read");
    let before = platform.office_process_ids("docx");
    let path = dir.join("read.docx");
    let id = "live-word-read";
    let open = json!({"action": "open_session", "session": id, "format": "docx", "path": path, "mode": "background", "create": true});
    let mut out = Emitter::stdio();
    let mut state = open_session_state(&Unlaned, &env, &mut out, &request(&open)).expect("the session opens");
    let whole = act(&env, &mut state, &json!({"action": "snapshot", "session": id}));
    assert_eq!(whole["value"]["format"], "docx", "{whole}");
    assert!(whole["value"]["paragraphCount"].as_i64().unwrap_or(0) >= 1, "{whole}");
    assert!(whole["value"]["paragraphs"].is_array(), "{whole}");
    let paged = act(&env, &mut state, &json!({"action": "snapshot", "session": id, "paged": true, "offset": 0, "limit": 1}));
    assert_eq!(paged["value"]["pagination"]["unit"], "paragraph", "{paged}");
    let issues = act(&env, &mut state, &json!({"action": "issues", "session": id}));
    assert_eq!(issues["value"]["format"], "docx", "{issues}");
    assert!(issues["value"]["issues"].is_array(), "{issues}");
    let closed = close_session(&mut state, &env, &request(&json!({"action": "close_session", "session": id, "save": true}))).expect("the close answers");
    assert!(closed.closed, "{}", emit_json(&closed.result));
    assert_eq!(platform.office_process_ids("docx"), before, "no Word process was left that was not there before");
    let _ = mixdog_fsio::remove_dir_all(&Unlaned, &dir);
}
