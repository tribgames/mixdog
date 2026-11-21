//! Ignored: starts Word; run with `-- --ignored` on Windows with it and `MIXDOG_TEST_LIVE_OFFICE=1`, else a requested test ends at once.
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
    let dir = std::env::temp_dir().join(format!("mixdog-office-word-edit-live-{}-{name}", std::process::id()));
    let _ = mixdog_fsio::remove_dir_all(&Unlaned, &dir);
    mixdog_fsio::create_dir_all(&Unlaned, &dir).expect("a scratch directory");
    dir
}

fn request(value: &Json) -> Value {
    payload::parse_payload(&value.to_string()).expect("a request")
}

fn attempt(env: &Env<'_>, state: &mut SessionState, body: &Json) -> Result<Json, String> {
    let actions = Actions { env: *env, proof: &Unlaned, drivers: Drivers::registered() };
    let mut out = Emitter::stdio();
    invoke_session_action(&actions, &mut out, state, &request(body)).map(|answer| serde_json::from_str(&emit_json(&answer)).expect("the answer is JSON"))
}

fn act(env: &Env<'_>, state: &mut SessionState, body: &Json) -> Json {
    attempt(env, state, body).unwrap_or_else(|message| panic!("{body}: {message}"))
}

/// The results of a batch answer, wherever the session action nests them.
fn results_of(answer: &Json) -> &Vec<Json> {
    answer["results"].as_array().or_else(|| answer["value"]["results"].as_array()).unwrap_or_else(|| panic!("no results in {answer}"))
}

#[test]
#[ignore = "starts Microsoft Word; MIXDOG_TEST_LIVE_OFFICE=1"]
fn a_background_document_is_edited_through_the_registered_editor() {
    if !live_office() {
        eprintln!("MIXDOG_TEST_LIVE_OFFICE is not 1: nothing was run");
        return;
    }
    let _apartment = Sta::enter().expect("an apartment");
    let platform = WindowsPlatform::new().expect("the Windows layer");
    let env = Env { platform: &platform, applications: &LiveApplications };
    let dir = scratch("edit");
    let before = platform.office_process_ids("docx");
    let path = dir.join("edit.docx");
    let id = "live-word-edit";
    let open = json!({"action": "open_session", "session": id, "format": "docx", "path": path, "mode": "background", "create": true});
    let mut out = Emitter::stdio();
    let mut state = open_session_state(&Unlaned, &env, &mut out, &request(&open)).expect("the session opens");

    let appended = act(
        &env,
        &mut state,
        &json!({"action": "batch", "session": id, "operations": [
            {"op": "append_text", "text": "Quarterly report", "style": "Heading1"},
            {"op": "append_text", "text": "Revenue grew 12% this quarter."},
            {"op": "append_text", "text": "First item", "properties": {"listKind": "bullet"}},
        ]}),
    );
    let results = results_of(&appended);
    assert_eq!(results.len(), 3, "{appended}");
    assert_eq!(results[1]["path"], "/body/p[2]", "{appended}");

    let edited = act(
        &env,
        &mut state,
        &json!({"action": "batch", "session": id, "operations": [
            {"op": "replace_text", "find": "12%", "replace": "13%"},
            {"op": "add_table", "values": [["Region", "Revenue"], ["North", "120"]], "properties": {"columnAlignments": ["left", "right"]}},
            {"op": "set_page", "properties": {"orientation": "landscape", "columns": 1}},
            {"op": "track_changes", "enabled": true},
            {"op": "add_comment", "find": "Revenue", "text": "Check", "author": "Reviewer", "initials": "RV"},
            {"op": "track_changes", "enabled": false},
        ]}),
    );
    let results = results_of(&edited);
    assert_eq!(results[0]["count"], 1, "{edited}");
    assert_eq!(results[1]["table"], 1, "{edited}");

    let refused = attempt(
        &env,
        &mut state,
        &json!({"action": "batch", "session": id, "operations": [{"op": "set_table_cell", "table": 9, "row": 1, "col": 1, "text": "x"}]}),
    );
    let message = refused.expect_err("a table that is not there is refused");
    assert!(message.contains("DOCX table 9 not found: the document holds 1 table(s)"), "{message}");

    let read = act(&env, &mut state, &json!({"action": "snapshot", "session": id}));
    assert_eq!(read["value"]["tableCount"], 1, "{read}");

    let closed = close_session(&mut state, &env, &request(&json!({"action": "close_session", "session": id, "save": true}))).expect("the close answers");
    assert!(closed.closed, "{}", emit_json(&closed.result));
    assert_eq!(platform.office_process_ids("docx"), before, "no Word process was left that was not there before");
    let _ = mixdog_fsio::remove_dir_all(&Unlaned, &dir);
}
