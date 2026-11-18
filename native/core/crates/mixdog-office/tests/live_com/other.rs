//! The `[compat]`, `[attach]`, `[contract]` and `[author]` profiles: both backends alike, the file kinds native Office creates, the
//! attach to a user's own Excel, the one snapshot contract, and the re-authoring of a deck over an open PowerPoint session.

use mixdog_office::snapshot::contract::{describe_office_snapshot_violations, office_snapshot_contract_violations};
use serde_json::{Value, json};

use super::{ExternalExcel, Live, all_matches, capture, items, matches, mentions, stringify, strip};

// fillColor: null takes a cell's fill away in all three formats, identically on both backends: Excel and Word had skipped null and
// kept the fill, the portable Word writer had no way to drop a shading at all.
#[test]
#[ignore = "starts Microsoft Excel, Word and PowerPoint; MIXDOG_TEST_LIVE_OFFICE=1"]
fn compat_fill_color_null_clears_an_excel_cell_a_word_table_cell_and_a_slide_table_cell_alike_on_both_backends() {
    let Some(live) = Live::start() else { return };
    let cases = [
        (
            "xlsx",
            json!([
                { "op": "set_range", "sheet": "Sheet1", "range": "A1:B1", "values": [["권역", 29000]] },
                { "op": "set_style", "sheet": "Sheet1", "range": "A1:B1", "properties": { "fillColor": "FFF2CC" } },
                { "op": "set_style", "sheet": "Sheet1", "cell": "B1", "properties": { "fillColor": null } }
            ]),
            json!(["FFF2CC", "none"]),
        ),
        (
            "docx",
            json!([
                { "op": "add_table", "values": [["권역", "9월"], ["수도권", "29,000"]] },
                { "op": "set_table_cell_style", "table": 1, "row": 2, "col": 1, "properties": { "fillColor": "EEF2F7" } },
                { "op": "set_table_cell_style", "table": 1, "row": 2, "col": 2, "properties": { "fillColor": "EEF2F7" } },
                { "op": "set_table_cell_style", "table": 1, "row": 2, "col": 2, "properties": { "fillColor": null } }
            ]),
            json!(["EEF2F7", "NONE"]),
        ),
        (
            "pptx",
            json!([
                { "op": "add_slide" },
                { "op": "add_table", "slide": 1, "values": [["권역", "9월"], ["수도권", "29,000"]], "left": 60, "top": 80, "width": 400, "height": 100 },
                { "op": "set_table_cell_style", "slide": 1, "shape": 1, "row": 2, "col": 1, "properties": { "fillColor": "F5ECD9" } },
                { "op": "set_table_cell_style", "slide": 1, "shape": 1, "row": 2, "col": 2, "properties": { "fillColor": "F5ECD9" } },
                { "op": "set_table_cell_style", "slide": 1, "shape": 1, "row": 2, "col": 2, "properties": { "fillColor": null } }
            ]),
            json!(["F5ECD9", "noFill"]),
        ),
    ];
    let read = |format: &str, name: &str| -> Value {
        let package = live.package(name);
        match format {
            "xlsx" => {
                let sheet = package.text("xl/worksheets/sheet1.xml");
                let styles = package.text("xl/styles.xml");
                let fills_block = capture(r"<fills[^>]*>([\s\S]*?)</fills>", "", &styles, 1).unwrap_or_default();
                let fills: Vec<String> = all_matches(r"<fill>[\s\S]*?</fill>", &fills_block).iter().map(|fill| capture(r#"rgb="(?:FF)?([0-9A-F]{6})""#, "i", fill, 1).unwrap_or_else(|| "none".to_owned())).collect();
                let xfs_block = capture(r"<cellXfs[^>]*>([\s\S]*?)</cellXfs>", "", &styles, 1).unwrap_or_default();
                let xfs: Vec<usize> = all_matches(r"<xf\b[^>]*>", &xfs_block).iter().map(|xf| capture(r#"fillId="(\d+)""#, "", xf, 1).and_then(|digits| digits.parse().ok()).unwrap_or(0)).collect();
                Value::Array(
                    ["A1", "B1"]
                        .iter()
                        .map(|reference| {
                            let style: usize = capture(&format!(r#"<c r="{reference}"[^>]*?\bs="(\d+)""#), "", &sheet, 1).and_then(|digits| digits.parse().ok()).unwrap_or(0);
                            json!(xfs.get(style).and_then(|fill| fills.get(*fill)).cloned().unwrap_or_else(|| "none".to_owned()))
                        })
                        .collect(),
                )
            }
            "docx" => {
                let document = package.text("word/document.xml");
                let rows = all_matches(r"<w:tr\b[\s\S]*?</w:tr>", &document);
                Value::Array(all_matches(r"<w:tc>[\s\S]*?</w:tc>", &rows[1]).iter().map(|cell| json!(capture(r#"<w:shd\b[^>]*w:fill="([^"]+)""#, "", cell, 1).unwrap_or_else(|| "none".to_owned()).to_uppercase())).collect())
            }
            _ => {
                let slide = package.text("ppt/slides/slide1.xml");
                let rows = all_matches(r"<a:tr\b[\s\S]*?</a:tr>", &slide);
                Value::Array(
                    all_matches(r"<a:tc\b[\s\S]*?</a:tc>", &rows[1])
                        .iter()
                        .map(|cell| {
                            let own = strip(r"<a:ln\w*\b[^>]*?(?:/>|>[\s\S]*?</a:ln\w*>)", &capture(r"<a:tcPr\b[^>]*/>|<a:tcPr\b[^>]*>[\s\S]*?</a:tcPr>", "", cell, 0).unwrap_or_default());
                            json!(if matches(r"<a:noFill/>", "", &own) { "noFill".to_owned() } else { capture(r#"<a:srgbClr val="([0-9A-F]{6})""#, "i", &own, 1).unwrap_or_else(|| "none".to_owned()) })
                        })
                        .collect(),
                )
            }
        }
    };
    for (format, operations, expected) in cases {
        for mode in ["background", "portable"] {
            let name = format!("clear-{mode}.{format}");
            let created = live.create(&name, format, mode, operations.clone());
            live.call(json!({ "action": "save", "session": created["session"] }));
            live.close(&created["session"]);
            assert_eq!(read(format, &name), expected, "{format} {mode}");
        }
    }
}

#[test]
#[ignore = "starts Microsoft Excel, Word and PowerPoint; MIXDOG_TEST_LIVE_OFFICE=1"]
fn compat_native_office_creates_and_reopens_template_and_macro_enabled_file_kinds() {
    let Some(live) = Live::start() else { return };
    let cases = [
        ("docm", json!([{ "op": "append_text", "text": "DOCM document" }]), "DOCM document"),
        ("dotm", json!([{ "op": "append_text", "text": "DOTM template" }]), "DOTM template"),
        ("dotx", json!([{ "op": "append_text", "text": "DOTX template" }]), "DOTX template"),
        ("xltx", json!([{ "op": "set_cell", "sheet": "Sheet1", "cell": "A1", "value": "XLTX template" }]), "XLTX template"),
        ("xltm", json!([{ "op": "set_cell", "sheet": "Sheet1", "cell": "A1", "value": "XLTM template" }]), "XLTM template"),
        ("xlsm", json!([{ "op": "set_cell", "sheet": "Sheet1", "cell": "A1", "value": "XLSM workbook" }]), "XLSM workbook"),
        ("pptm", json!([{ "op": "add_slide" }, { "op": "add_textbox", "slide": 1, "text": "PPTM presentation" }]), "PPTM presentation"),
        ("potx", json!([{ "op": "add_slide" }, { "op": "add_textbox", "slide": 1, "text": "POTX template" }]), "POTX template"),
        ("potm", json!([{ "op": "add_slide" }, { "op": "add_textbox", "slide": 1, "text": "POTM template" }]), "POTM template"),
    ];
    for (file_kind, operations, expected) in cases {
        let path = live.path(&format!("native.{file_kind}"));
        let created = live.call(json!({ "action": "create", "path": path, "format": file_kind, "mode": "background" }));
        assert_eq!(created["fileKind"], file_kind, "{file_kind}");
        live.call(json!({ "action": "batch", "session": created["session"], "operations": operations }));
        let validation = live.call(json!({ "action": "validate", "session": created["session"] }));
        assert_eq!(validation["ok"], true, "{file_kind}: {}", stringify(&validation));
        assert_eq!(validation["native"]["opened"], true, "{file_kind}");
        if file_kind.starts_with("xl") {
            // validate still carries the reopened workbook's reading, which a caller checks persisted settings against; only
            // finalize, which drops it from its answer, no longer asks for it.
            let sheets = if validation["native"]["snapshot"]["sheets"].is_null() { json!([]) } else { validation["native"]["snapshot"]["sheets"].clone() };
            assert!(stringify(&sheets).contains(expected), "{file_kind}: {}", stringify(&sheets));
        }
        live.close(&created["session"]);
        let reopened = live.call(json!({ "action": "open", "path": path, "output": live.path(&format!("reopened.{file_kind}")), "mode": "background" }));
        assert_eq!(reopened["fileKind"], file_kind, "{file_kind}");
        assert!(mentions(&reopened["document"], expected), "{file_kind}: {}", stringify(&reopened["document"]));
        live.close(&reopened["session"]);
    }
}

#[test]
#[ignore = "starts and shows Microsoft Excel; MIXDOG_TEST_LIVE_OFFICE=1"]
fn attach_attach_selects_the_exact_workbook_across_multiple_excel_instances() {
    let Some(live) = Live::start() else { return };
    let (first_path, second_path) = (live.path("first.xlsx"), live.path("second.xlsx"));
    for path in [&first_path, &second_path] {
        let created = live.call(json!({ "action": "create", "path": path, "format": "xlsx" }));
        assert_eq!(created["mode"], "background");
        assert_ne!(created["visible"], true);
        live.close(&created["session"]);
    }
    let mut first_external = ExternalExcel::start(&live, &first_path);
    let mut second_external = ExternalExcel::start(&live, &second_path);

    let automatic = live.call(json!({ "action": "open", "path": second_path, "output": live.path("auto-background.xlsx") }));
    assert_eq!(automatic["mode"], "background");
    assert_eq!(automatic["ownership"], "owned");
    assert_ne!(automatic["visible"], true);
    let isolation = &automatic["backgroundIsolation"];
    assert_eq!(isolation["strict"], true, "{}", stringify(&automatic));
    assert_eq!(isolation["isolatedProcess"], true, "{}", stringify(&automatic));
    assert_eq!(isolation["visibleOwnedWindows"], 0, "{}", stringify(&automatic));
    assert_eq!(isolation["ownedForeground"], false, "{}", stringify(&automatic));
    assert_ne!(automatic["windowHwnd"].as_u64(), Some(second_external.hwnd));
    live.close(&automatic["session"]);

    let attached_second = live.call(json!({ "action": "attach", "path": second_path }));
    assert_eq!(attached_second["ownership"], "attached");
    assert_eq!(attached_second["windowHwnd"].as_u64(), Some(second_external.hwnd));
    assert_eq!(attached_second["appPid"].as_u64(), Some(second_external.process_id));
    live.call(json!({
        "action": "batch",
        "session": attached_second["session"],
        "operations": [{ "op": "set_cell", "sheet": "Sheet1", "cell": "A1", "value": "두 번째 정확한 창" }],
        "save": true
    }));
    let second_cell = live.call(json!({ "action": "get", "session": attached_second["session"], "target": "/sheet[Sheet1]/cell[A1]" }));
    assert_eq!(second_cell["element"]["value"], "두 번째 정확한 창");
    live.close(&attached_second["session"]);
    assert!(second_external.running(), "closing an attached session must not close the user-owned Excel instance");

    let attached_first = live.call(json!({ "action": "attach", "path": first_path }));
    assert_eq!(attached_first["windowHwnd"].as_u64(), Some(first_external.hwnd));
    let first_snapshot = live.call(json!({ "action": "snapshot", "session": attached_first["session"] }));
    assert_eq!(items(&first_snapshot["document"]["sheets"][0]["cells"]).len(), 0);
    live.close(&attached_first["session"]);

    first_external.stop();
    second_external.stop();
}

#[test]
#[ignore = "starts Microsoft Excel, Word and PowerPoint; MIXDOG_TEST_LIVE_OFFICE=1"]
fn contract_both_backends_satisfy_one_snapshot_contract_and_agree_on_the_same_document() {
    let Some(live) = Live::start() else { return };
    let cases = [
        (
            "docx",
            "contract.docx",
            json!([
                { "op": "append_text", "text": "Document title", "style": "Title" },
                { "op": "append_text", "text": "Heading one", "style": "Heading1" },
                { "op": "append_text", "text": "Body paragraph." },
                { "op": "add_table", "values": [["A", "B"], ["1", "2"]] }
            ]),
        ),
        ("xlsx", "contract.xlsx", json!([{ "op": "set_range", "range": "A1:B3", "values": [["Region", "Revenue"], ["Korea", 120], ["Japan", 95]] }])),
        (
            "pptx",
            "contract.pptx",
            json!([
                { "op": "add_slide" },
                { "op": "set_slide_background", "slide": 1, "color": "16191D" },
                { "op": "add_textbox", "slide": 1, "text": "Title", "properties": { "left": 40, "top": 40, "width": 400, "height": 60, "fontSize": 40 } },
                { "op": "set_notes", "slide": 1, "text": "Speaker note." },
                { "op": "add_slide" },
                { "op": "set_slide_background", "slide": 2, "color": "F5F2EC" },
                { "op": "add_table", "slide": 2, "values": [["A", "B"], ["1", "2"]], "left": 40, "top": 40, "width": 300, "height": 90 }
            ]),
        ),
    ];
    let text = |value: &Value| -> String { value.as_str().unwrap_or_default().to_owned() };
    let shown = |value: &Value| -> String { if value.is_null() { "undefined".to_owned() } else { value.as_str().map_or_else(|| value.to_string(), str::to_owned) } };
    for (format, file, operations) in cases {
        let target = live.path(file);
        let authored = live.call(json!({ "action": "create", "path": target, "mode": "portable", "operations": operations }));
        live.close(&authored["session"]);

        let mut readings = serde_json::Map::new();
        for mode in ["portable", "background"] {
            let opened = live.call(json!({ "action": "open", "path": target, "mode": mode }));
            let snapshot = live.call(json!({ "action": "snapshot", "session": opened["session"] }));
            let violations = office_snapshot_contract_violations(&snapshot["document"], format, true);
            assert!(violations.is_empty(), "{} {format} breaks the backend contract:\n{}", text(&opened["backend"]), describe_office_snapshot_violations(&violations));
            readings.insert(mode.to_owned(), snapshot["document"].clone());
            live.close(&opened["session"]);
        }

        // One file, two readers. Representation may differ, but the facts a caller acts on must not: silent disagreement here is
        // what blinded design review.
        let (portable, com) = (&readings["portable"], &readings["background"]);
        match format {
            "docx" => {
                assert_eq!(com["tableCount"], portable["tableCount"], "table counts must agree");
                // Word numbers table-cell paragraphs alongside body paragraphs while the portable model reports cell text under
                // tables, so /body/p[N] addresses different content per backend. Body text itself must still agree.
                let body_text = |document: &Value| -> Vec<Value> {
                    items(&document["paragraphs"]).iter().filter(|entry| entry["inTable"] != true).map(|entry| entry["text"].clone()).filter(super::truthy).collect()
                };
                assert_eq!(body_text(com), body_text(portable), "body paragraph text must agree");
                // Word answers under the UI language; a localized style name handed to the portable writer produces an unknown
                // styleId and silently drops styling.
                let body_styles = |document: &Value| -> Vec<Value> {
                    items(&document["paragraphs"]).iter().filter(|entry| entry["inTable"] != true && !shown(&entry["text"]).trim().is_empty() && !entry["text"].is_null()).map(|entry| entry["style"].clone()).collect()
                };
                assert_eq!(body_styles(com), body_styles(portable), "paragraph styles must agree");
                let table_styles = |document: &Value| -> Vec<Value> { items(&document["tables"]).iter().map(|entry| entry["style"].clone()).collect() };
                assert_eq!(table_styles(com), table_styles(portable), "table styles must agree");
            }
            "xlsx" => {
                let cell_values = |document: &Value| -> Vec<String> {
                    items(&document["sheets"]).iter().flat_map(|sheet| items(&sheet["cells"]).iter().map(|cell| format!("{}={}", shown(&cell["path"]), shown(&cell["value"])))).collect()
                };
                assert_eq!(cell_values(com), cell_values(portable), "cell values must agree");
            }
            _ => {
                assert_eq!(com["slideCount"], portable["slideCount"], "slide counts must agree");
                let per_slide = |document: &Value, read: &dyn Fn(&Value) -> Value| -> Vec<Value> { items(&document["slides"]).iter().map(read).collect() };
                let indexes = |slide: &Value| slide["index"].clone();
                assert_eq!(per_slide(com, &indexes), per_slide(portable, &indexes), "slide order must agree");
                let notes = |slide: &Value| json!(if slide["notes"].is_null() { String::new() } else { shown(&slide["notes"]).trim().to_owned() });
                assert_eq!(per_slide(com, &notes), per_slide(portable, &notes), "speaker notes must agree");
                let backgrounds = |slide: &Value| json!(text(&slide["background"]["color"]).to_uppercase());
                assert_eq!(per_slide(com, &backgrounds), per_slide(portable, &backgrounds), "slide backgrounds must agree");
                let shape_counts = |slide: &Value| json!(items(&slide["shapes"]).len());
                assert_eq!(per_slide(com, &shape_counts), per_slide(portable, &shape_counts), "shape counts must agree");
            }
        }
    }
}


// The authoring loop re-authors the same target over and over, and starting PowerPoint again costs seconds every pass. Re-authoring
// keeps the hidden process and swaps only the document: the session survives, what it reads is the new deck, and a failed source
// leaves the live deck untouched. The decks are authored from HTML slides (the pptxgenjs script runtime is not part of the build),
// through an installed Chrome or Edge.
#[test]
#[ignore = "starts Microsoft PowerPoint and a headless browser; MIXDOG_TEST_LIVE_OFFICE=1"]
fn author_re_authoring_a_deck_reuses_the_open_powerpoint_session_and_reads_the_new_deck() {
    let Some(live) = Live::start() else { return };
    // A pptxgenjs script, as the Node test authors the deck: it runs on the script interpreter of the install.
    let node = std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()).map(|dir| dir.join("node.exe")).find(|path| path.is_file()).expect("node on PATH runs the authoring script");
    mixdog_office::author::script_runtime::install(mixdog_office::author::script_runtime::ScriptRuntime {
        program: node,
        package_root: std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../.."),
        electron: false,
    });
    let path = live.path("reused.pptx");
    let deck = |titles: &[&str]| -> String {
        format!(
            "
const pptxgen = require('pptxgenjs');
const pres = new pptxgen();
pres.layout = 'LAYOUT_WIDE';
for (const title of {}) {{
  pres.addSlide().addText(title, {{ x: 0.8, y: 0.8, w: 11, h: 1.2, fontSize: 32, bold: true }});
}}
await pres.writeFile({{ fileName: OUTPUT }});
",
            serde_json::to_string(titles).expect("titles")
        )
    };
    let first = live.call(json!({ "action": "author", "path": path, "script": deck(&["First deck"]), "render": false }));
    assert_eq!(first["ok"], true, "{}", stringify(&first["error"]));
    assert_eq!(first["backend"], "microsoft-office-com");
    assert_ne!(first["reusedSession"], true);
    let opened = live.call(json!({ "action": "snapshot", "session": first["session"] }));
    assert_eq!(items(&opened["document"]["slides"]).len(), 1);

    let again = live.call(json!({ "action": "author", "path": path, "script": deck(&["Second deck", "Added slide"]), "overwrite": true, "render": false }));
    assert_eq!(again["ok"], true, "{}", stringify(&again["error"]));
    assert_eq!(again["reusedSession"], true);
    assert_eq!(again["session"], first["session"], "the session survives the rewrite");
    assert_eq!(items(&again["receipt"]["slides"]).len(), 2);
    let reread = live.call(json!({ "action": "snapshot", "session": again["session"] }));
    assert_eq!(items(&reread["document"]["slides"]).len(), 2, "the reused session reads the new deck, not the cached old one");
    assert!(mentions(&reread["document"]["slides"][0], "Second deck"));
    assert_eq!(reread["appPid"], opened["appPid"], "the same PowerPoint process carries both decks");

    let failed = live.call(json!({ "action": "author", "path": path, "script": "undefinedCall();", "overwrite": true, "render": false }));
    assert_eq!(failed["ok"], false);
    assert_eq!(failed["reason"], "script_failed");
    let survived = live.call(json!({ "action": "snapshot", "session": again["session"] }));
    assert_eq!(items(&survived["document"]["slides"]).len(), 2, "a failed script leaves the open deck alone");
    let staged: Vec<String> = std::fs::read_dir(live.dir()).expect("the scratch folder").filter_map(Result::ok).map(|entry| entry.file_name().to_string_lossy().into_owned()).filter(|name| name.contains(".authoring.")).collect();
    assert!(staged.is_empty(), "no staging file is left beside the target: {staged:?}");
    live.close(&again["session"]);
}
