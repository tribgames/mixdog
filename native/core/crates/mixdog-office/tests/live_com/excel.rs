//! The `[excel]` profile: persistent Excel sessions, and what Excel reads and writes as the portable reader and writer do.

use serde_json::{Value, json};

use super::{Live, all_matches, capture, items, matches, number, png_pixel, stringify, wait_for_process_exit};

#[test]
#[ignore = "starts Microsoft Excel; MIXDOG_TEST_LIVE_OFFICE=1"]
fn persistent_excel_sessions_own_one_document_and_preserve_utf8_text() {
    let Some(live) = Live::start() else { return };
    let background_path = live.path("background-한글.xlsx");
    let visible_path = live.path("visible-한글.xlsx");

    let background = live.call(json!({ "action": "create", "path": background_path, "format": "xlsx", "mode": "background" }));
    assert_eq!(background["mode"], "background");
    assert_eq!(background["ownership"], "owned");
    assert_ne!(background["visible"], true, "a background session opens no window");
    let session = background["session"].clone();

    let batch = live.call(json!({
        "action": "batch",
        "session": session,
        "operations": [
            { "op": "set_cell", "sheet": "Sheet1", "cell": "A1", "value": "하이하이하이" },
            { "op": "set_cell", "sheet": "Sheet1", "cell": "B1", "value": 21 },
            { "op": "set_range", "sheet": "Sheet1", "range": "C1:D1", "values": [[true, 22.5]] },
            { "op": "append_row", "sheet": "Sheet1", "values": ["추가 행", 23] },
            { "op": "add_validation", "sheet": "Sheet1", "range": "E1:E3", "formula1": "Yes,No", "inputMessage": "Choose a value" },
            { "op": "freeze_panes", "sheet": "Sheet1", "row": 2 },
            { "op": "set_sheet_view", "sheet": "Sheet1", "showGridlines": false, "zoom": 95 }
        ]
    }));
    let isolation = &batch["backgroundIsolation"];
    assert_eq!(isolation["observedVisibleWindows"], json!([]), "{}", stringify(&batch));
    assert_eq!(isolation["hiddenWindows"], 0, "{}", stringify(&batch));
    assert_eq!(isolation["focusRestorations"], 0, "{}", stringify(&batch));
    // The contract is that background Office never takes the foreground, not that the desktop's foreground window is frozen.
    assert_eq!(isolation["ownedForeground"], false, "{}", stringify(&batch));

    let get = |target: &str| live.call(json!({ "action": "get", "session": session, "target": target }));
    assert_eq!(get("/sheet[Sheet1]/cell[A1]")["element"]["value"], "하이하이하이");
    assert_eq!(get("/sheet[Sheet1]/cell[B1]")["element"]["value"], 21);
    assert_eq!(get("/sheet[Sheet1]/cell[D1]")["element"]["value"], 22.5);
    assert_eq!(get("/sheet[Sheet1]/cell[B2]")["element"]["value"], 23);
    let validated = live.call(json!({ "action": "snapshot", "session": session }));
    let sheet = &validated["document"]["sheets"][0];
    assert_eq!(sheet["validationCount"], 1);
    assert_eq!(sheet["validations"][0]["ranges"], json!(["E1:E3"]));
    // Named as the portable reader names it, not by Excel's enumeration number.
    assert_eq!(sheet["validations"][0]["type"], "list");
    assert_eq!(sheet["validations"][0]["formula1"], "\"Yes,No\"");

    live.call(json!({
        "action": "batch",
        "session": session,
        "operations": [
            { "op": "set_formula", "sheet": "Sheet1", "cell": "G2", "formula": "=B2*2" },
            { "op": "insert_rows", "sheet": "Sheet1", "row": 2, "count": 1 },
            { "op": "merge_cells", "sheet": "Sheet1", "range": "H1:I1" },
            { "op": "unmerge_cells", "sheet": "Sheet1", "range": "H1:I1" },
            { "op": "define_name", "name": "MixdogInput", "refersTo": "Sheet1!$B$1" },
            { "op": "set_hyperlink", "sheet": "Sheet1", "cell": "J1", "address": "https://mix.dog", "text": "Mixdog" }
        ]
    }));
    let shifted = get("/sheet[Sheet1]/cell[G3]");
    assert!(matches("B3", "", shifted["element"]["formula"].as_str().unwrap_or_default()));
    live.call(json!({
        "action": "batch",
        "session": session,
        "operations": [
            { "op": "delete_rows", "sheet": "Sheet1", "row": 2, "count": 1 },
            { "op": "set_formula", "sheet": "Sheet1", "cell": "A1501", "formula": "=1/0" },
            { "op": "set_cell", "sheet": "Sheet1", "cell": "B1501", "value": 99 },
            { "op": "add_sheet", "name": "Checks" },
            { "op": "set_cell", "sheet": "Checks", "cell": "A1", "value": "Tie-out" },
            { "op": "set_formula", "sheet": "Checks", "cell": "B1", "formula": "=1=2" }
        ]
    }));
    let formula_issues = live.call(json!({ "action": "issues", "session": session }));
    assert!(items(&formula_issues["issues"]).iter().any(|issue| issue["code"] == "formula_error" && issue["path"] == "/sheet[Sheet1]/cell[A1501]"));
    let audit = live.call(json!({ "action": "issues", "session": session, "auditProfile": "financial-model" }));
    assert_eq!(audit["auditCoverage"]["mode"], "full");
    assert_eq!(audit["auditCoverage"]["complete"], true);
    assert_eq!(audit["auditCoverage"]["scannedCells"], audit["auditCoverage"]["totalCells"]);
    assert!(items(&audit["issues"]).iter().any(|issue| issue["code"] == "hardcode_missing_source" && issue["path"] == "/sheet[Sheet1]/cell[B1501]"));
    assert!(items(&audit["issues"]).iter().any(|issue| issue["code"] == "failed_check" && issue["path"] == "/sheet[Checks]/cell[B1]"));

    let compact = live.call(json!({ "action": "snapshot", "session": session, "sheet": "Sheet1", "limit": 10_000, "maxChars": 100_000 }));
    let compact_sheet = &compact["document"]["sheets"][0];
    assert_eq!(compact_sheet["representation"], "row-blocks");
    assert_eq!(items(&compact_sheet["cells"]).len(), 0, "row blocks carry the cells");
    // Excel read the whole workbook whatever the limit, so a read over maxChars came back as a truncated text preview; the retry
    // now asks for pages, and the result is a document with a cursor.
    let narrow = live.call(json!({ "action": "snapshot", "session": session, "maxChars": 4000 }));
    assert!(narrow["preview"].is_null(), "{}", &stringify(&narrow)[..400.min(stringify(&narrow).len())]);
    assert!(narrow["document"]["sheets"].is_array());
    assert!(stringify(&narrow).encode_utf16().count() <= 4000 + 2000, "the page fits the size the caller asked for");
    assert!(!items(&compact_sheet["rowBlocks"]).is_empty());
    assert_eq!(compact["document"]["pagination"]["scanned"], 10_000);
    assert_eq!(compact_sheet["rowBlocks"][0]["values"][0][0], "하이하이하이");
    live.call(json!({ "action": "batch", "session": session, "operations": [{ "op": "clear_cell", "sheet": "Sheet1", "cell": "A1501" }] }));
    let validation = live.call(json!({ "action": "validate", "session": session }));
    assert_eq!(validation["ok"], true, "{}", stringify(&validation));
    assert_eq!(validation["native"]["opened"], true);

    let failed = live.raw(json!({
        "action": "batch",
        "session": session,
        "operations": [
            { "op": "set_cell", "sheet": "Sheet1", "cell": "A1", "value": "복원되어야 함" },
            { "op": "unsupported_operation" }
        ]
    }));
    assert_eq!(failed["isError"], true);
    assert_eq!(get("/sheet[Sheet1]/cell[A1]")["element"]["value"], "하이하이하이");

    live.call(json!({ "action": "begin", "session": session }));
    live.call(json!({ "action": "batch", "session": session, "operations": [{ "op": "set_cell", "sheet": "Sheet1", "cell": "A1", "value": "트랜잭션 임시값" }] }));
    let diff = live.call(json!({ "action": "diff", "session": session }));
    assert!(number(&diff["transaction"]["diff"]["summary"]["modified"]) > 0.0);
    live.call(json!({ "action": "rollback", "session": session }));
    assert_eq!(get("/sheet[Sheet1]/cell[A1]")["element"]["value"], "하이하이하이");
    live.call(json!({ "action": "close", "session": session }));

    let strict_attach = live.raw(json!({ "action": "attach", "path": background_path }));
    assert_eq!(strict_attach["isError"], true);
    assert!(matches("not registered as open", "i", &super::text_of(&strict_attach)));

    let visible = live.call(json!({ "action": "create", "path": visible_path, "format": "xlsx", "mode": "visible" }));
    assert_eq!(visible["mode"], "visible");
    assert_eq!(visible["ownership"], "owned");
    assert_eq!(visible["visible"], true);
    assert!(number(&visible["appPid"]) > 0.0);
    assert!(number(&visible["windowHwnd"]) > 0.0);

    let reused = live.call(json!({ "action": "open", "path": visible_path, "mode": "visible" }));
    assert_eq!(reused["session"], visible["session"]);
    assert_eq!(reused["reused"], true);

    live.call(json!({
        "action": "batch",
        "session": visible["session"],
        "operations": [{ "op": "set_cell", "sheet": "Sheet1", "cell": "A1", "value": "한글-日本語-中文" }],
        "save": true
    }));
    let visible_cell = live.call(json!({ "action": "get", "session": visible["session"], "target": "/sheet[Sheet1]/cell[A1]" }));
    assert_eq!(visible_cell["element"]["value"], "한글-日本語-中文");
    let visible_snapshot = live.call(json!({ "action": "snapshot", "session": visible["session"] }));
    assert_eq!(visible_snapshot["document"]["selection"]["available"], true);
    assert_eq!(visible_snapshot["document"]["selection"]["sheet"], "Sheet1");
    assert!(matches(r"^/sheet\[Sheet1\]/range\[", "", visible_snapshot["document"]["selection"]["target"].as_str().unwrap_or_default()));
    live.call(json!({
        "action": "batch",
        "session": visible["session"],
        "operations": [{
            "op": "add_provenance",
            "sheet": "Sheet1",
            "cell": "A1",
            "source": { "document": "source-model.xlsx", "target": "/sheet[Inputs]/cell[C3]", "label": "Revenue" }
        }]
    }));
    let sourced = live.call(json!({ "action": "snapshot", "session": visible["session"] }));
    assert!(matches(r"Source: source-model\.xlsx#/sheet\[Inputs\]/cell\[C3\]", "", sourced["document"]["sheets"][0]["notes"][0]["text"].as_str().unwrap_or_default()));

    live.call(json!({ "action": "close", "session": visible["session"], "save": true }));
    assert!(wait_for_process_exit(visible["appPid"].as_u64().expect("appPid")));
}

// A form's instruction line under its title set column A four times the width of the dates under it, as the portable writer no
// longer does: a line alone in its row prints across the empty cells beside it and sizes no column of a fit over several.
#[test]
#[ignore = "starts Microsoft Excel; MIXDOG_TEST_LIVE_OFFICE=1"]
fn excel_a_multi_column_fit_is_not_widened_by_a_line_of_text_alone_in_its_row() {
    let Some(live) = Live::start() else { return };
    let created = live.create(
        "form.xlsx",
        "xlsx",
        "background",
        json!([
            { "op": "set_range", "sheet": "Sheet1", "range": "A1:A2", "values": [["경비 신청서"], ["파란 칸에 입력하세요. 둘째 줄은 작성 예시입니다."]] },
            { "op": "set_range", "sheet": "Sheet1", "range": "A4:C5", "values": [["사용일", "구분", "금액"], ["2026-10-02", "교통", 18400]] },
            { "op": "autofit_range", "sheet": "Sheet1", "range": "A:C" }
        ]),
    );
    // The line is wrapped only for the fit: it still reads on one line afterwards.
    let line = live.call(json!({ "action": "get", "session": created["session"], "target": "/sheet[Sheet1]/cell[A2]" }));
    assert_ne!(line["element"]["style"]["wrapText"], true, "{}", stringify(&line["element"]["style"]));
    live.close(&created["session"]);
    let sheet = live.package("form.xlsx").text("xl/worksheets/sheet1.xml");
    let width: f64 = capture(r#"<col min="1" max="1" width="([\d.]+)""#, "", &sheet, 1).and_then(|text| text.parse().ok()).unwrap_or(f64::NAN);
    assert!(width > 0.0 && width < 18.0, "column A fits its dates, not the instruction line: {width}");
}

// A pivot over Hangul fields took the fixed caption "Sum of 매출"; Korean Excel heads it "합계 : 매출" and its totals "총합계", as the
// portable writer now writes them.
#[test]
#[ignore = "starts Microsoft Excel; MIXDOG_TEST_LIVE_OFFICE=1"]
fn excel_a_pivot_over_korean_fields_takes_korean_captions() {
    let Some(live) = Live::start() else { return };
    let created = live.create(
        "pivot.xlsx",
        "xlsx",
        "background",
        json!([
            { "op": "set_range", "sheet": "Sheet1", "range": "A1:C4", "values": [["권역", "분기", "매출"], ["서울", "1분기", 820], ["부산", "1분기", 410], ["서울", "2분기", 910]] },
            { "op": "add_pivot_table", "sheet": "Sheet1", "source": "A1:C4", "destination": "E1", "rows": ["권역"], "columns": ["분기"], "values": ["매출"] }
        ]),
    );
    let read = live.call(json!({ "action": "snapshot", "session": created["session"], "sheet": "Sheet1", "range": "E1:I8" }));
    let values: Vec<Value> = items(&read["document"]["sheets"][0]["cells"]).iter().map(|cell| cell["value"].clone()).collect();
    let has = |text: &str| values.iter().any(|value| value == text);
    let shown = stringify(&Value::Array(values.clone()));
    assert!(has("합계 : 매출"), "{shown}");
    assert!(has("총합계"), "{shown}");
    // The row header names its field, as the portable writer heads it, not "행 레이블".
    assert!(!has("행 레이블") && !has("Row Labels"), "{shown}");
    // And the column header names its field over the quarters, not "열 레이블".
    assert!(has("분기"), "{shown}");
    assert!(!has("열 레이블") && !has("Column Labels"), "{shown}");
    live.close(&created["session"]);
}

#[test]
#[ignore = "starts Microsoft Excel; MIXDOG_TEST_LIVE_OFFICE=1"]
fn excel_a_text_excel_would_type_as_a_date_a_number_or_a_truth_value_stays_text() {
    let Some(live) = Live::start() else { return };
    let texts = ["1", "1,234", "12,345.6", "15%", "12.5%", "-500000", ".5", "007", "1-1", "1/2", "2026/10/05", "2026-10-05", "1e3", "(100)", "10:30", "TRUE", "#N/A", "214-86-12345"];
    let operations = json!([
        { "op": "set_style", "range": "B1", "properties": { "numberFormat": "0.0" } },
        { "op": "set_range", "range": format!("A1:A{}", texts.len()), "values": texts.iter().map(|text| json!([text])).collect::<Vec<_>>() },
        { "op": "set_cell", "cell": "B1", "value": "3-4" },
        { "op": "set_cell", "cell": "B2", "value": "2,500" },
        { "op": "append_row", "values": ["1-3", "7", "9%"] }
    ]);
    let read = |mode: &str| -> Vec<Value> {
        let created = live.create(&format!("typed-{mode}.xlsx"), "xlsx", mode, operations.clone());
        let snapshot = live.call(json!({
            "action": "snapshot",
            "session": created["session"],
            "sheet": "Sheet1",
            "range": format!("A1:C{}", texts.len() + 1),
            "includeStyles": true
        }));
        live.close(&created["session"]);
        items(&snapshot["document"]["sheets"][0]["cells"])
            .iter()
            .map(|cell| json!([cell["ref"], cell["value"], cell["style"]["numberFormat"].as_str().unwrap_or("")]))
            .collect()
    };
    let excel = read("background");
    let cell = |reference: &str| excel.iter().find(|entry| entry[0] == reference).unwrap_or_else(|| panic!("no cell {reference}")).clone();
    // "1-1" as an item number, a fraction, a slashed date, an exponent, a time, a truth value, and an error stay text, under the
    // format their cell had ('0.0' on B1).
    for reference in ["A8", "A9", "A10", "A11", "A13", "A14", "A15", "A16", "A17", "A18", "A19"] {
        assert!(cell(reference)[1].is_string(), "{}", stringify(&cell(reference)));
    }
    assert_eq!(cell("B1"), json!(["B1", "3-4", "0.0"]));
    assert_eq!(cell("A2"), json!(["A2", 1234, "#,##0"]));
    assert_eq!(cell("A5"), json!(["A5", 0.125, "0.00%"]));
    assert_eq!(cell("A12"), json!(["A12", 46300, "yyyy-mm-dd"]));
    assert_eq!(excel, read("portable"));
}

#[test]
#[ignore = "starts Microsoft Excel; MIXDOG_TEST_LIVE_OFFICE=1"]
fn excel_freeze_panes_freezes_above_and_left_of_the_cell_it_names_under_a_tall_title_band() {
    let Some(live) = Live::start() else { return };
    let created = live.create(
        "frozen.xlsx",
        "xlsx",
        "background",
        json!([
            { "op": "set_range", "sheet": "Sheet1", "range": "A7:C9", "values": [["지역", "매출", "비중"], ["서울", 1, 2], ["부산", 3, 4]] },
            { "op": "set_row_height", "sheet": "Sheet1", "row": 1, "height": 86 },
            // The portable writer's reading: row 8 and column B scroll, so rows 1-7 and column A stay.
            { "op": "freeze_panes", "sheet": "Sheet1", "row": 8, "column": 2 }
        ]),
    );
    let snapshot = live.call(json!({ "action": "snapshot", "session": created["session"] }));
    assert_eq!(snapshot["document"]["sheets"][0]["freezePanes"]["splitRow"], 7);
    assert_eq!(snapshot["document"]["sheets"][0]["freezePanes"]["splitColumn"], 1);
    live.close(&created["session"]);
}

#[test]
#[ignore = "starts Microsoft Excel; MIXDOG_TEST_LIVE_OFFICE=1"]
fn excel_a_protected_form_reads_back_allows_and_reports_its_entry_cells_as_the_portable_file_does() {
    let Some(live) = Live::start() else { return };
    let operations = json!([
        { "op": "set_range", "sheet": "Sheet1", "range": "A5:B5", "values": [["일자", "항목"]] },
        { "op": "add_validation", "sheet": "Sheet1", "range": "B6:B15", "formula1": "\"교통비,숙박비\"" },
        { "op": "set_style", "sheet": "Sheet1", "range": "B11:B15", "properties": { "locked": false } },
        { "op": "protect_sheet", "sheet": "Sheet1", "allowFiltering": true }
    ]);
    let read = |mode: &str| -> Value {
        let created = live.create(&format!("form-{mode}.xlsx"), "xlsx", mode, operations.clone());
        let issues = live.call(json!({ "action": "issues", "session": created["session"] }));
        let snapshot = live.call(json!({ "action": "snapshot", "session": created["session"] }));
        let sheet = &snapshot["document"]["sheets"][0];
        live.close(&created["session"]);
        // Excel does not say whether a password guards a sheet; the portable reader does.
        let mut protection = sheet["protection"].clone();
        if let Some(map) = protection.as_object_mut() {
            map.remove("password");
        }
        let validations: Vec<Value> = items(&sheet["validations"]).iter().map(|entry| json!([entry["ranges"], entry["type"], entry["formula1"]])).collect();
        let locked = items(&issues["issues"]).iter().find(|issue| issue["code"] == "protected_input_locked").cloned().unwrap_or(Value::Null);
        json!({ "locked": locked, "protection": protection, "validations": validations })
    };
    let portable = read("portable");
    let excel = read("background");
    // Excel refuses SpecialCells on a protected sheet: its dropdowns had read back as none, and its locked entry cells passed the
    // audit.
    assert_eq!(excel["validations"], json!([[["B6:B15"], "list", "\"교통비,숙박비\""]]));
    assert_eq!(excel["validations"], portable["validations"]);
    assert!(excel["locked"].is_object(), "Excel reports the locked entry cells");
    assert_eq!(excel["locked"]["path"], "/sheet[Sheet1]/cell[B6]");
    assert_eq!(excel["locked"]["message"], portable["locked"]["message"]);
    assert_eq!(excel["protection"], json!({ "protected": true, "allowFormattingCells": false, "allowSorting": false, "allowFiltering": true }));
    assert_eq!(excel["protection"], portable["protection"]);
}

#[test]
#[ignore = "starts Microsoft Excel; MIXDOG_TEST_LIVE_OFFICE=1"]
fn excel_a_cut_label_a_figure_run_into_its_label_and_faint_ink_are_reported_on_excel_as_portably() {
    let Some(live) = Live::start() else { return };
    let operations = json!([
        {
            "op": "set_range",
            "sheet": "Sheet1",
            "range": "A1:D3",
            "values": [["일자", "허브", "비고", "확인"], [46204, "수도권", "야간 증원 인력 두 명을 추가로 투입할 예정", "예"], [46205, "부산", "없음", "예"]]
        },
        { "op": "set_style", "sheet": "Sheet1", "range": "A2:A3", "properties": { "numberFormat": "yyyy-mm-dd" } },
        { "op": "set_column_width", "sheet": "Sheet1", "column": "A", "width": 12 },
        { "op": "set_column_width", "sheet": "Sheet1", "column": "C", "width": 8 },
        { "op": "set_cell", "sheet": "Sheet1", "cell": "A5", "value": "참고: 잠정 집계" },
        { "op": "set_style", "sheet": "Sheet1", "range": "A5", "properties": { "color": "D1D5DB" } }
    ]);
    let codes = ["figure_label_adjacent", "label_truncated", "low_contrast"];
    let read = |mode: &str| -> Vec<String> {
        let created = live.create(&format!("log-{mode}.xlsx"), "xlsx", mode, operations.clone());
        let reviewed = live.call(json!({ "action": "issues", "session": created["session"] }));
        live.close(&created["session"]);
        let mut found: Vec<String> = items(&reviewed["issues"])
            .iter()
            .filter(|entry| codes.iter().any(|code| entry["code"] == *code))
            .map(|entry| format!("{} {}", entry["code"].as_str().unwrap_or_default(), entry["path"].as_str().unwrap_or_default()))
            .collect();
        found.sort();
        found
    };
    let excel = read("background");
    // Excel's host had reported none of the three.
    assert_eq!(excel, vec!["figure_label_adjacent /sheet[Sheet1]/cell[B2]", "label_truncated /sheet[Sheet1]/cell[C2]", "low_contrast /sheet[Sheet1]/cell[A5]"]);
    assert_eq!(excel, read("portable"));
}

#[test]
#[ignore = "starts Microsoft Excel; MIXDOG_TEST_LIVE_OFFICE=1"]
fn excel_a_fit_by_width_alone_leaves_the_printed_length_free_as_the_portable_file_does() {
    let Some(live) = Live::start() else { return };
    let read = |mode: &str| -> Value {
        let created = live.create(
            &format!("log-{mode}.xlsx"),
            "xlsx",
            mode,
            json!([
                { "op": "set_range", "sheet": "Sheet1", "range": "A1:B2", "values": [["일자", "처리량"], ["2026-07-01", 1400]] },
                { "op": "set_page_setup", "sheet": "Sheet1", "fitToPagesWide": 1 },
                // A one-page report after a data sheet fitted by width: Excel had refused its height of 1 once the same statement
                // had set the data sheet's free height ("Specified cast is not valid").
                { "op": "add_sheet", "name": "Report" },
                { "op": "set_cell", "sheet": "Report", "cell": "A1", "value": "요약" },
                { "op": "set_page_setup", "sheet": "Report", "fitToPagesWide": 1, "fitToPagesTall": 1 }
            ]),
        );
        // The portable reader answers a sheet at a time; Excel answers the workbook either way.
        let mut fits = serde_json::Map::new();
        for name in ["Sheet1", "Report"] {
            let snapshot = live.call(json!({ "action": "snapshot", "session": created["session"], "sheet": name }));
            let sheet = items(&snapshot["document"]["sheets"]).iter().find(|sheet| sheet["name"] == name).cloned().unwrap_or(Value::Null);
            let setup = &sheet["pageSetup"];
            // Excel says False for a free count and the portable reader 0; either way no page limit.
            let count = |value: &Value| if number(value).is_nan() { 0.0 } else { number(value) };
            fits.insert(name.to_owned(), json!([count(&setup["fitToPagesWide"]), count(&setup["fitToPagesTall"])]));
        }
        live.close(&created["session"]);
        Value::Object(fits)
    };
    // Excel had kept the height at its default of one page and shrunk a 92-row log onto it.
    let expected = json!({ "Sheet1": [1.0, 0.0], "Report": [1.0, 1.0] });
    assert_eq!(read("background"), expected);
    assert_eq!(read("portable"), expected);
}

#[test]
#[ignore = "starts Microsoft Excel; MIXDOG_TEST_LIVE_OFFICE=1"]
fn excel_a_validation_takes_its_choices_and_its_rule_in_the_forms_the_contract_names_them() {
    let Some(live) = Live::start() else { return };
    // Side by side and one above another: Excel finds the validated cells as one area (B6:E15), and had read the five rules back
    // as the first of them.
    let operations = json!([
        { "op": "set_range", "sheet": "Sheet1", "range": "A1:A3", "values": [["서울"], ["부산"], ["대구"]] },
        { "op": "add_validation", "sheet": "Sheet1", "range": "B6:B15", "formula1": "\"교통비,숙박비\"" },
        { "op": "add_validation", "sheet": "Sheet1", "range": "C6:C15", "type": "whole", "formula1": "1", "formula2": "5000000" },
        { "op": "add_validation", "sheet": "Sheet1", "range": "D6:D10", "formula1": "서울,부산" },
        { "op": "add_validation", "sheet": "Sheet1", "range": "D11:D15", "formula1": "$A$1:$A$3" },
        { "op": "add_validation", "sheet": "Sheet1", "range": "E6:E15", "formula1": "LEN(E6)<=10" }
    ]);
    let read = |mode: &str| -> Vec<Value> {
        let created = live.create(&format!("rules-{mode}.xlsx"), "xlsx", mode, operations.clone());
        let snapshot = live.call(json!({ "action": "snapshot", "session": created["session"] }));
        live.close(&created["session"]);
        let text = |value: &Value| value.as_str().unwrap_or_default().to_owned();
        let mut rows: Vec<(String, Value)> = items(&snapshot["document"]["sheets"][0]["validations"])
            .iter()
            .map(|entry| {
                let ranges = items(&entry["ranges"]).iter().map(&text).collect::<Vec<_>>().join(" ");
                let row = json!([ranges, entry["type"], entry["operator"].as_str().unwrap_or(""), entry["formula1"], entry["formula2"].as_str().unwrap_or("")]);
                (ranges, row)
            })
            .collect();
        rows.sort_by(|left, right| left.0.cmp(&right.0));
        rows.into_iter().map(|(_, row)| row).collect()
    };
    let excel = read("background");
    // A quoted list had kept its quotes as part of its first and last choice (""교통비,숙박비""), and a bare range had become a
    // dropdown of its own address.
    assert_eq!(
        Value::Array(excel.clone()),
        json!([
            ["B6:B15", "list", "", "\"교통비,숙박비\"", ""],
            ["C6:C15", "whole", "between", "1", "5000000"],
            ["D11:D15", "list", "", "$A$1:$A$3", ""],
            ["D6:D10", "list", "", "\"서울,부산\"", ""],
            ["E6:E15", "custom", "", "LEN(E6)<=10", ""]
        ])
    );
    assert_eq!(excel, read("portable"));
}

// A workbook opened in the background came up in a 114 x 58 pt window, too short to split: freezing row 2 and column B failed on
// every opened file ("FreezePanes" could not be set) while the portable writer froze them.
#[test]
#[ignore = "starts Microsoft Excel; MIXDOG_TEST_LIVE_OFFICE=1"]
fn excel_freeze_panes_freezes_a_row_and_a_column_on_an_opened_workbook_as_the_portable_writer_does() {
    let Some(live) = Live::start() else { return };
    let source = live.path("ledger.xlsx");
    let created = live.call(json!({
        "action": "create",
        "path": source,
        "format": "xlsx",
        "mode": "portable",
        "operations": [{ "op": "set_range", "sheet": "Sheet1", "range": "A1:C3", "values": [["권역", "7월", "9월"], ["수도권", 26100, 29000], ["부산", 21400, 26400]] }]
    }));
    live.close(&created["session"]);
    let frozen = |mode: &str| -> Vec<String> {
        let output = live.path(&format!("frozen-{mode}.xlsx"));
        let opened = live.call(json!({ "action": "open", "path": source, "mode": mode, "output": output }));
        live.call(json!({ "action": "batch", "session": opened["session"], "operations": [{ "op": "freeze_panes", "sheet": "Sheet1", "row": 2, "column": 2 }] }));
        live.call(json!({ "action": "save", "session": opened["session"] }));
        live.close(&opened["session"]);
        let sheet = live.package(&output).text("xl/worksheets/sheet1.xml");
        let pane = capture(r"<pane\b[^>]*/>", "", &sheet, 0).unwrap_or_default();
        // Excel records a split it froze as frozenSplit; either state holds the panes frozen.
        ["xSplit", "ySplit", "topLeftCell", "state"]
            .iter()
            .map(|name| capture(&format!(r#"\b{name}="([^"]+)""#), "", &pane, 1).unwrap_or_default())
            .map(|text| if text == "frozenSplit" { "frozen".to_owned() } else { text })
            .collect()
    };
    let excel = frozen("background");
    assert_eq!(excel, vec!["1", "1", "B2", "frozen"]);
    assert_eq!(frozen("portable"), excel);
}

// append_row wrote into bare cells on both backends: under #,##0 figures and 0.0% rates the new row read 1200 and 0.006. The row
// now takes the last row's formatting on each, as an inserted row takes the row above's.
#[test]
#[ignore = "starts Microsoft Excel; MIXDOG_TEST_LIVE_OFFICE=1"]
fn excel_an_appended_row_is_formatted_as_the_last_row_is_as_the_portable_writer_formats_it() {
    let Some(live) = Live::start() else { return };
    let appended = |mode: &str| -> Vec<String> {
        let created = live.create(
            &format!("append-{mode}.xlsx"),
            "xlsx",
            mode,
            json!([
                { "op": "set_range", "sheet": "Sheet1", "range": "A1:C3", "values": [["권역", "처리량", "지연률"], ["수도권", 29000, 0.009], ["부산", 26400, 0.019]] },
                { "op": "set_style", "sheet": "Sheet1", "range": "B2:B3", "properties": { "numberFormat": "#,##0" } },
                { "op": "set_style", "sheet": "Sheet1", "range": "C2:C3", "properties": { "numberFormat": "0.0%" } },
                { "op": "append_row", "sheet": "Sheet1", "values": ["세종", 1500, 0.006] }
            ]),
        );
        let snapshot = live.call(json!({ "action": "snapshot", "session": created["session"], "sheet": "Sheet1", "range": "B4:C4", "includeStyles": true }));
        live.close(&created["session"]);
        items(&snapshot["document"]["sheets"][0]["cells"])
            .iter()
            .map(|cell| {
                let shown = |value: &Value| value.as_str().map_or_else(|| value.to_string(), str::to_owned);
                format!("{}:{}:{}", shown(&cell["ref"]), shown(&cell["value"]), cell["style"]["numberFormat"].as_str().unwrap_or(""))
            })
            .collect()
    };
    let excel = appended("background");
    assert_eq!(excel, vec!["B4:1500:#,##0", "C4:0.006:0.0%"]);
    assert_eq!(appended("portable"), excel);
}

#[test]
#[ignore = "starts Microsoft Excel; MIXDOG_TEST_LIVE_OFFICE=1"]
fn excel_a_chart_ended_at_to_column_reaches_that_column_in_the_workbook_font() {
    let Some(live) = Live::start() else { return };
    let created = live.create(
        "spanned.xlsx",
        "xlsx",
        "background",
        json!([
            { "op": "set_range", "sheet": "Sheet1", "range": "A1:B3", "values": [["지역", "매출"], ["서울", 120], ["부산", 95]] },
            { "op": "set_column_width", "sheet": "Sheet1", "column": "A", "width": 20, "count": 4 },
            { "op": "add_chart", "sheet": "Sheet1", "range": "A1:B3", "chartType": "column", "cell": "A5", "toColumn": "D", "height": 200 }
        ]),
    );
    // Read as the portable reader reads it: the kind by name and the series' three references apart, not Excel's enumeration
    // number and one =SERIES(...) formula.
    let charted = live.call(json!({ "action": "snapshot", "session": created["session"] }));
    let chart = &charted["document"]["sheets"][0]["charts"][0];
    assert_eq!(chart["chartType"], "column");
    assert_eq!(
        json!([chart["series"][0]["formula"], chart["series"][0]["categoryFormula"], chart["series"][0]["valueFormula"]]),
        json!(["Sheet1!$B$1", "Sheet1!$A$2:$A$3", "Sheet1!$B$2:$B$3"])
    );
    live.close(&created["session"]);
    let drawing = live.package("spanned.xlsx").text("xl/drawings/drawing1.xml");
    // The frame's right edge is column D's: the anchor ends at E with no offset, whatever a column measures here.
    assert!(matches(r"<xdr:to><xdr:col>4</xdr:col><xdr:colOff>0</xdr:colOff>", "", &drawing));
}

#[test]
#[ignore = "starts Microsoft Excel; MIXDOG_TEST_LIVE_OFFICE=1"]
fn excel_a_border_set_on_a_block_rules_the_lines_between_its_cells_as_the_portable_writer_does() {
    let Some(live) = Live::start() else { return };
    let created = live.create(
        "grid.xlsx",
        "xlsx",
        "background",
        json!([
            { "op": "set_range", "sheet": "Sheet1", "range": "A1:C3", "values": [["a", "b", "c"], [1, 2, 3], [4, 5, 6]] },
            // The edge indexes alone drew one box around the block; the file writer borders every cell.
            { "op": "set_style", "sheet": "Sheet1", "range": "A1:C3", "properties": { "borders": { "style": "thin" } } }
        ]),
    );
    live.close(&created["session"]);
    let package = live.package("grid.xlsx");
    let styles = package.text("xl/styles.xml");
    let sheet = package.text("xl/worksheets/sheet1.xml");
    let cell_xfs = capture(r"<cellXfs\b[\s\S]*?</cellXfs>", "", &styles, 0).unwrap_or_default();
    let xfs = all_matches(r"<xf\b[^>]*>", &cell_xfs);
    let border_block = capture(r"<borders\b[\s\S]*?</borders>", "", &styles, 0).unwrap_or_default();
    let borders = all_matches(r"<border\b[\s\S]*?</border>", &border_block);
    let style: usize = capture(r#"<c r="B2"[^>]*?\ss="(\d+)""#, "", &sheet, 1).and_then(|digits| digits.parse().ok()).unwrap_or(0);
    let border_id: usize = capture(r#"borderId="(\d+)""#, "", xfs.get(style).map_or("", String::as_str), 1).and_then(|digits| digits.parse().ok()).unwrap_or(0);
    let border = borders.get(border_id).cloned().unwrap_or_default();
    assert!(matches(r#"<left style="thin""#, "", &border), "{border}");
    assert!(matches(r#"<top style="thin""#, "", &border), "{border}");
}

#[test]
#[ignore = "starts Microsoft Excel; MIXDOG_TEST_LIVE_OFFICE=1"]
fn excel_charts_and_pictures_are_reviewed_against_the_print_area_and_each_other_on_excel_too() {
    let Some(live) = Live::start() else { return };
    let picture = live.path("logo.png");
    std::fs::write(&picture, png_pixel()).expect("the picture");
    let created = live.create(
        "drawings.xlsx",
        "xlsx",
        "background",
        json!([
            { "op": "set_range", "sheet": "Sheet1", "range": "A1:B4", "values": [["지역", "매출"], ["서울", 120], ["부산", 80], ["대구", 60]] },
            { "op": "add_chart", "sheet": "Sheet1", "range": "A1:B4", "chartType": "column", "cell": "D2", "width": 300, "height": 200 },
            { "op": "add_chart", "sheet": "Sheet1", "range": "A1:B4", "chartType": "pie", "cell": "F6", "width": 240, "height": 180 },
            { "op": "add_image", "sheet": "Sheet1", "path": picture, "cell": "D20", "width": 40, "altText": "회사 로고" },
            // Excel reports the area as $A$1:$C$10; read that way it was no print area at all.
            { "op": "set_page_setup", "sheet": "Sheet1", "printArea": "A1:C10" }
        ]),
    );
    let issues = live.call(json!({ "action": "issues", "session": created["session"] }));
    let found: Vec<String> = items(&issues["issues"]).iter().map(|entry| format!("{} {}", entry["code"].as_str().unwrap_or_default(), entry["path"].as_str().unwrap_or_default())).collect();
    for expected in ["drawing_outside_print_area /sheet[Sheet1]/chart[1]", "drawing_outside_print_area /sheet[Sheet1]/image[1]", "drawing_overlap /sheet[Sheet1]/chart[2]"] {
        assert!(found.iter().any(|entry| entry == expected), "{expected} in {found:?}");
    }
    live.close(&created["session"]);
}

// The Excel snapshot reads a sheet's values and formulas in one array each and settles "nothing withheld" with one question (its
// visible cells are the whole range); only otherwise are rows and columns walked. EntireRow.Hidden reads False on a range whose
// rows are mixed, and taken for that answer it reported a hidden row and column as shown.
#[test]
#[ignore = "starts Microsoft Excel; MIXDOG_TEST_LIVE_OFFICE=1"]
fn excel_the_snapshot_names_hidden_rows_and_columns_and_reads_formulas_from_the_sheet() {
    let Some(live) = Live::start() else { return };
    let created = live.create(
        "withheld.xlsx",
        "xlsx",
        "background",
        json!([
            { "op": "set_range", "sheet": "Sheet1", "range": "A1:C3", "values": [["지역", "매출", "비고"], ["서울", 120, "본사"], ["부산", 80, "허브"]] },
            { "op": "set_cell", "sheet": "Sheet1", "cell": "A4", "value": "합계" },
            { "op": "set_formula", "sheet": "Sheet1", "cell": "B4", "formula": "=SUM(B2:B3)" }
        ]),
    );
    let read = || -> Value {
        let snapshot = live.call(json!({ "action": "snapshot", "session": created["session"], "sheet": "Sheet1" }));
        items(&snapshot["document"]["sheets"]).iter().find(|entry| entry["name"] == "Sheet1").cloned().unwrap_or(Value::Null)
    };
    let shown = read();
    // Nothing withheld reads absent, as the portable reader answers it.
    let or_empty = |value: &Value| if value.is_null() { json!([]) } else { value.clone() };
    assert_eq!(json!([or_empty(&shown["hiddenRows"]), or_empty(&shown["hiddenColumns"])]), json!([[], []]));
    let fourth: Vec<Value> = items(&shown["cells"])
        .iter()
        .map(|cell| json!([cell["ref"], cell["value"], if cell["formula"].is_null() { Value::Null } else { cell["formula"].clone() }]))
        .filter(|entry| entry[0].as_str().is_some_and(|reference| reference.ends_with('4')))
        .collect();
    assert_eq!(Value::Array(fourth), json!([["A4", "합계", null], ["B4", 200, "=SUM(B2:B3)"]]));
    live.call(json!({
        "action": "batch",
        "session": created["session"],
        "operations": [
            { "op": "set_column_visibility", "sheet": "Sheet1", "column": "C", "visible": false },
            { "op": "set_row_visibility", "sheet": "Sheet1", "row": 3, "visible": false }
        ]
    }));
    let withheld = read();
    assert_eq!(json!([withheld["hiddenRows"], withheld["hiddenColumns"]]), json!([[3], ["C"]]));
    live.close(&created["session"]);
}

#[test]
#[ignore = "starts Microsoft Excel; MIXDOG_TEST_LIVE_OFFICE=1"]
fn excel_copy_sheet_copies_and_insert_columns_takes_a_column_letter() {
    let Some(live) = Live::start() else { return };
    let created = live.create("sheets.xlsx", "xlsx", "background", json!([{ "op": "set_range", "sheet": "Sheet1", "range": "A1:B2", "values": [["a", "b"], [1, 2]] }]));
    let edited = live.call(json!({
        "action": "batch",
        "session": created["session"],
        "operations": [{ "op": "copy_sheet", "sheet": "Sheet1", "name": "사본" }, { "op": "insert_columns", "sheet": "Sheet1", "column": "B", "count": 1 }]
    }));
    let result_of = |op: &str| items(&edited["results"]).iter().find(|result| result["op"] == op).cloned().unwrap_or(Value::Null);
    assert_eq!(result_of("copy_sheet")["sheet"], "사본");
    assert_eq!(result_of("insert_columns")["column"], 2);
    let missing = live.refused(json!({ "action": "batch", "session": created["session"], "operations": [{ "op": "delete_sheet", "sheet": "없는 시트" }] }));
    assert!(matches(r"Worksheet not found: 없는 시트", "", &missing), "{missing}");
    live.close(&created["session"]);
}
