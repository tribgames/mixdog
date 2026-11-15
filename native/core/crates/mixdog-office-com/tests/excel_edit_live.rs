//! The workbook editor against real Microsoft Excel. Every test is `#[ignore]`: it starts Excel, so it runs only on request
//! (`cargo test -p mixdog-office-com --test excel_edit_live -- --ignored`) on a Windows machine with Excel and
//! `MIXDOG_TEST_LIVE_OFFICE=1`. Without that variable a test that was asked for ends at once and says it did nothing.
//!
//! A new workbook in a background session is edited through the registered editor with the argument sets of the live Excel
//! tests of the PowerShell host (cells, a typed-text case, a block, styles, a merge, widths, panes, a chart, page setup, a header),
//! and the workbook is read back through the registered reader. The twin comparison with the PowerShell host (responses equal after
//! normalisation, the saved file equal after OOXML normalisation, wall time not above the host's) is the recorded scenario set of
//! `recorder/scenarios/excel-edit.json`.
#![cfg(windows)]

use std::path::PathBuf;

use mixdog_fsio::Unlaned;
use mixdog_office_com::com::live::Sta;
use mixdog_office_com::drivers::Drivers;
use mixdog_office_com::excel::edit::Editor;
use mixdog_office_com::format::EditContext;
use mixdog_office_com::format::FormatEditor;
use mixdog_office_com::format::snapshot_document;
use mixdog_office_com::host::Emitter;
use mixdog_office_com::office::Env;
use mixdog_office_com::office::LiveApplications;
use mixdog_office_com::platform::WindowsPlatform;
use mixdog_office_com::ps::Value;
use mixdog_office_com::ps::json::to_json;
use mixdog_office_com::ps::payload;
use mixdog_office_com::state::ChartExcel;
use mixdog_office_com::state::close_session;
use mixdog_office_com::state::open_session_state;
use serde_json::json;

fn live_office() -> bool {
    std::env::var("MIXDOG_TEST_LIVE_OFFICE").as_deref() == Ok("1")
}

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("mixdog-excel-edit-live-{}-{name}", std::process::id()));
    let _ = mixdog_fsio::remove_dir_all(&Unlaned, &dir);
    mixdog_fsio::create_dir_all(&Unlaned, &dir).expect("a scratch directory");
    dir
}

fn request(value: &serde_json::Value) -> Value {
    payload::parse_payload(&value.to_string()).expect("a request")
}

#[test]
#[ignore = "starts Microsoft Excel; MIXDOG_TEST_LIVE_OFFICE=1"]
fn a_new_workbook_is_edited_operation_by_operation_and_read_back() {
    if !live_office() {
        eprintln!("MIXDOG_TEST_LIVE_OFFICE is not 1: nothing was run");
        return;
    }
    let _apartment = Sta::enter().expect("an apartment");
    let platform = WindowsPlatform::new().expect("the Windows layer");
    let env = Env { platform: &platform, applications: &LiveApplications };
    let dir = scratch("edit");
    let path = dir.join("edit.xlsx");
    let body = json!({"action": "open_session", "session": "live-edit", "format": "xlsx", "path": path, "mode": "background", "create": true});
    let mut out = Emitter::stdio();
    let mut state = open_session_state(&Unlaned, &env, &mut out, &request(&body)).expect("the session opens");
    let document = state.document.clone().expect("the open workbook");
    let mut chart_excel = ChartExcel::default();

    let operations = [
        json!({"op": "set_range", "range": "A1:C4", "values": [["Item", "Q1", "Q2"], ["a", 1, 2], ["1-2", 4, 5], ["007", 7, 8]]}),
        json!({"op": "set_formula", "cell": "D2", "formula": "SUM(B2:C2)"}),
        json!({"op": "set_style", "range": "A1:D1", "properties": {"bold": true, "fillColor": "DDEEFF", "horizontalAlignment": "centre"}}),
        json!({"op": "set_style", "range": "B2:D4", "properties": {"numberFormat": "#,##0;[Red]-#,##0"}}),
        json!({"op": "merge_cells", "range": "F1:G2"}),
        json!({"op": "set_column_width", "column": "A", "width": 18}),
        json!({"op": "set_row_height", "row": 1, "height": 24}),
        json!({"op": "autofit_range", "range": "A1:D4"}),
        json!({"op": "freeze_panes", "row": 2, "column": 2}),
        json!({"op": "add_chart", "chartType": "column", "range": "A1:C4", "cell": "F4", "title": "Sales", "showValues": true}),
        json!({"op": "set_page_setup", "orientation": "landscape", "fitToPagesWide": 1, "leftMargin": 0.5}),
        json!({"op": "set_header_footer", "kind": "footer", "alignment": "center", "text": "Page {page} of {pages}"}),
        json!({"op": "add_sheet", "name": "Notes"}),
        json!({"op": "rename_sheet", "sheet": "Notes", "name": "Notes 2"}),
    ];
    for op in &operations {
        let mut context = EditContext { env, chart_excel: &mut chart_excel };
        let record = Editor
            .apply_operation(&mut context, &document, &request(op), false, false)
            .unwrap_or_else(|error| panic!("{op}: {}", error.message()))
            .expect("a record");
        let text = to_json(&record, 6);
        assert!(text.contains("\"changed\":true"), "{op}: {text}");
    }

    let drivers = Drivers::registered();
    let read = snapshot_document(&drivers, &env, &document, "xlsx", &request(&json!({"sheet": "Sheet1"}))).expect("the read");
    let text = to_json(&read, 30);
    // The two texts Excel would have typed as a date and as a number stay text.
    assert!(text.contains("\"1-2\"") && text.contains("\"007\""), "{text}");
    assert!(text.contains("\"Item\""), "{text}");

    let closed = close_session(&mut state, &env, &request(&json!({"action": "close_session", "session": "live-edit", "save": false})))
        .expect("the close answers");
    assert!(closed.closed);
    let _ = mixdog_fsio::remove_dir_all(&Unlaned, &dir);
}
