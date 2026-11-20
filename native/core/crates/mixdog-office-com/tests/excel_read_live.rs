//! The workbook reader against real Microsoft Excel. Every test is `#[ignore]`: it starts Excel, so it runs only on request
//! (`cargo test -p mixdog-office-com --test excel_read_live -- --ignored`) on a Windows machine with Excel and
//! `MIXDOG_TEST_LIVE_OFFICE=1`. Without that variable a test that was asked for ends at once and says it did nothing.
//!
//! A new workbook in a background session is read whole, by pages, for its selection and for its issues (both audit
//! profiles) through the registered reader, and what comes back has the shape the portable reader answers with.
#![cfg(windows)]

use std::path::PathBuf;

use mixdog_fsio::Unlaned;
use mixdog_office_com::com::live::Sta;
use mixdog_office_com::drivers::Drivers;
use mixdog_office_com::format::issues_document;
use mixdog_office_com::format::snapshot_document;
use mixdog_office_com::format::snapshot_selection;
use mixdog_office_com::host::Emitter;
use mixdog_office_com::office::Env;
use mixdog_office_com::office::LiveApplications;
use mixdog_office_com::platform::WindowsPlatform;
use mixdog_office_com::ps::Value;
use mixdog_office_com::ps::json::to_json;
use mixdog_office_com::ps::payload;
use mixdog_office_com::state::close_session;
use mixdog_office_com::state::open_session_state;
use serde_json::json;

fn live_office() -> bool {
    std::env::var("MIXDOG_TEST_LIVE_OFFICE").as_deref() == Ok("1")
}

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("mixdog-excel-read-live-{}-{name}", std::process::id()));
    let _ = mixdog_fsio::remove_dir_all(&Unlaned, &dir);
    mixdog_fsio::create_dir_all(&Unlaned, &dir).expect("a scratch directory");
    dir
}

fn request(value: &serde_json::Value) -> Value {
    payload::parse_payload(&value.to_string()).expect("a request")
}

#[test]
#[ignore = "starts Microsoft Excel; MIXDOG_TEST_LIVE_OFFICE=1"]
fn a_new_workbook_reads_whole_by_pages_for_its_selection_and_for_its_issues() {
    if !live_office() {
        eprintln!("MIXDOG_TEST_LIVE_OFFICE is not 1: nothing was run");
        return;
    }
    let _apartment = Sta::enter().expect("an apartment");
    let platform = WindowsPlatform::new().expect("the Windows layer");
    let env = Env { platform: &platform, applications: &LiveApplications };
    let dir = scratch("read");
    let path = dir.join("read.xlsx");
    let body = json!({"action": "open_session", "session": "live-read", "format": "xlsx", "path": path, "mode": "background", "create": true});
    let mut out = Emitter::stdio();
    let mut state = open_session_state(&Unlaned, &env, &mut out, &request(&body)).expect("the session opens");
    let document = state.document.clone().expect("the open workbook");
    let drivers = Drivers::registered();

    let whole = snapshot_document(&drivers, &env, &document, "xlsx", &request(&json!({}))).expect("the whole read");
    let text = to_json(&whole, 30);
    assert!(text.contains("\"format\":\"xlsx\"") && text.contains("\"sheets\":["), "{text}");
    assert!(text.contains("\"protection\":{\"protected\":false}"), "{text}");

    let paged =
        snapshot_document(&drivers, &env, &document, "xlsx", &request(&json!({"paged": true, "limit": 100, "range": "A1:C3"}))).expect("the paged read");
    let text = to_json(&paged, 30);
    assert!(text.contains("\"representation\":\"cells\"") && text.contains("\"total\":9"), "{text}");

    let selection = snapshot_selection(&drivers, &env, &document, "xlsx");
    assert!(to_json(&selection, 6).contains("\"kind\":\"range\""), "{}", to_json(&selection, 6));

    for profile in [json!({}), json!({"auditProfile": "financial-model"})] {
        let issues = issues_document(&drivers, &env, &document, "xlsx", Some(&request(&profile))).expect("the issues");
        let text = to_json(&issues, 30);
        assert!(text.contains("\"format\":\"xlsx\"") && text.contains("\"auditCoverage\":{"), "{text}");
    }

    let closed =
        close_session(&mut state, &env, &request(&json!({"action": "close_session", "session": "live-read", "save": false}))).expect("the close answers");
    assert!(closed.closed);
    let _ = mixdog_fsio::remove_dir_all(&Unlaned, &dir);
}
