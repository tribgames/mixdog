//! The live backend against Microsoft Office. Both tests are `#[ignore]`d: they start Word and Excel, so they run only
//! on a Windows PC with Office, by hand, with `MIXDOG_TEST_LIVE_OFFICE=1`:
//! `cargo test -p mixdog-office-com --test dispatch_live -- --ignored`.
#![cfg(windows)]

use mixdog_office_com::com::Error;
use mixdog_office_com::com::SafeArray;
use mixdog_office_com::com::Value;
use mixdog_office_com::com::live::Sta;
use mixdog_office_com::com::live::create_object;
use serde_json::Value as Json;

const CORPUS: &str = include_str!("fixtures/errors/corpus.json");

fn live_enabled() -> bool {
    std::env::var("MIXDOG_TEST_LIVE_OFFICE").is_ok_and(|value| value == "1")
}

fn corpus_entry(id: &str) -> Json {
    let corpus: Json = serde_json::from_str(CORPUS).expect("corpus.json parses");
    corpus["entries"]
        .as_array()
        .and_then(|entries| entries.iter().find(|entry| entry["id"] == id))
        .cloned()
        .unwrap_or_else(|| panic!("the corpus has no entry {id}"))
}

fn assert_matches_corpus(id: &str, error: &Error) {
    let entry = corpus_entry(id);
    assert_eq!(entry["reproduced"], true, "{id} was not reproduced when the corpus was recorded");
    let com = error.as_com().unwrap_or_else(|| panic!("{id}: a COM failure, got {error}"));
    assert_eq!(i64::from(com.hresult), entry["hresult"].as_i64().expect("hresult"), "{id}");
    assert_eq!(i64::from(com.inner_hresult), entry["innerHResult"].as_i64().expect("innerHResult"), "{id}");
    assert_eq!(com.message, entry["message"].as_str().expect("message"), "{id}");
}

#[test]
#[ignore = "starts Excel and Word; MIXDOG_TEST_LIVE_OFFICE=1"]
fn dispatch_live_errors() {
    if !live_enabled() {
        return;
    }
    let _sta = Sta::enter().expect("apartment");
    let missing = std::env::temp_dir().join("mixdog-errors-corpus-no-such-file.xlsx");
    let missing = Value::from(missing.to_string_lossy().into_owned());

    let excel = create_object("Excel.Application").expect("Excel");
    excel.put("Visible", Value::Bool(false)).expect("hidden");
    excel.put("DisplayAlerts", Value::I4(0)).expect("no alerts");
    let workbooks = excel.get("Workbooks").expect("Workbooks").into_obj().expect("object");
    let opened = workbooks.call("Open", &[missing.clone()]);
    assert_matches_corpus("excel-open-missing-file", &opened.expect_err("a missing file"));
    let workbook = workbooks.call("Add", &[]).expect("Add").into_obj().expect("object");
    let sheet = workbook.get("Worksheets").expect("Worksheets").into_obj().expect("object").item(1).expect("Item").into_obj().expect("object");
    let range = sheet.call("Range", &[Value::from("A1")]).expect("Range").into_obj().expect("object");
    assert_matches_corpus("excel-range-item-zero", &range.call("Item", &[Value::I4(0)]).expect_err("Item(0)"));
    assert_matches_corpus("excel-worksheet-name-set", &sheet.put("Name", Value::from("a:b")).expect_err("a bad name"));
    assert_eq!(excel.get("NoSuchProperty").expect("a missing property answers null"), Value::Null);
    workbook.call("Close", &[Value::Bool(false)]).expect("Close");
    excel.call("Quit", &[]).expect("Quit");

    let word = create_object("Word.Application").expect("Word");
    word.put("Visible", Value::Bool(false)).expect("hidden");
    let documents = word.get("Documents").expect("Documents").into_obj().expect("object");
    let document = documents.call("Add", &[]).expect("Add").into_obj().expect("object");
    assert_matches_corpus("word-parameterized-get", &document.get_with("Compatibility", &[Value::I4(9999)]).expect_err("Compatibility(9999)"));
    assert_matches_corpus("word-parameterized-set", &document.put_with("Compatibility", &[Value::I4(9999)], Value::Bool(true)).expect_err("set"));
    document.call("Close", &[Value::I4(0)]).expect("Close");
    word.call("Quit", &[Value::I4(0)]).expect("Quit");
}

#[test]
#[ignore = "starts Excel and Word; MIXDOG_TEST_LIVE_OFFICE=1"]
fn dispatch_live_roundtrip() {
    if !live_enabled() {
        return;
    }
    let _sta = Sta::enter().expect("apartment");

    let excel = create_object("Excel.Application").expect("Excel");
    excel.put("Visible", Value::Bool(false)).expect("hidden");
    excel.put("DisplayAlerts", Value::I4(0)).expect("no alerts");
    let workbook = excel.get("Workbooks").expect("Workbooks").into_obj().expect("object").call("Add", &[]).expect("Add").into_obj().expect("object");
    let sheet = workbook.get("Worksheets").expect("Worksheets").into_obj().expect("object").item(1).expect("Item").into_obj().expect("object");

    // A 0-based 2 x 2 block goes in; Value2 comes back as a 1-based object[,].
    let block = SafeArray::zero_based(vec![vec![Value::R8(1.0), Value::from("two")], vec![Value::R8(3.0), Value::R8(4.5)]]).expect("block");
    let target = sheet.call("Range", &[Value::from("A1:B2")]).expect("Range").into_obj().expect("object");
    target.put("Value2", Value::Array(block)).expect("write the block");
    let Value::Array(read) = target.get("Value2").expect("read the block") else {
        panic!("Value2 of a range is an array");
    };
    assert_eq!((read.lower_bound(0), read.lower_bound(1)), (Some(1), Some(1)));
    assert_eq!(read.get(&[1, 2]), Some(&Value::from("two")));
    assert_eq!(read.get(&[2, 1]), Some(&Value::R8(3.0)));

    // A date, an error value and a VT_R4 read.
    let date = sheet.call("Range", &[Value::from("C1")]).expect("Range").into_obj().expect("object");
    date.put("Value2", Value::Date(45_000.5)).expect("write a date");
    date.put("NumberFormat", Value::from("yyyy-mm-dd hh:mm")).expect("format");
    assert!(matches!(date.get("Value2").expect("read"), Value::Date(_) | Value::R8(_)));
    let na = sheet.call("Range", &[Value::from("C2")]).expect("Range").into_obj().expect("object");
    na.put("Formula", Value::from("=NA()")).expect("write #N/A");
    assert_eq!(na.get("Value2").expect("read"), Value::Error(0x800A_07FA_u32 as i32));
    workbook.call("Close", &[Value::Bool(false)]).expect("Close");
    excel.call("Quit", &[]).expect("Quit");

    let word = create_object("Word.Application").expect("Word");
    word.put("Visible", Value::Bool(false)).expect("hidden");
    let document = word.get("Documents").expect("Documents").into_obj().expect("object").call("Add", &[]).expect("Add").into_obj().expect("object");
    let font = document.get("Content").expect("Content").into_obj().expect("object").get("Font").expect("Font").into_obj().expect("object");
    font.put("Size", Value::R4(12.5)).expect("size");
    assert_eq!(font.get("Size").expect("size"), Value::R4(12.5));
    document.call("Close", &[Value::I4(0)]).expect("Close");
    word.call("Quit", &[Value::I4(0)]).expect("Quit");
}
