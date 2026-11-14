//! Twin test `write_core`: pdf-lib 1.17.1 as the Node office PDF code drives it (the recording
//! `native/core/fixtures/office-write-core/golden.json`, written by
//! `benchmarks/rust-core/recorders/record-office-write-core.mjs`) against the writing half of this crate.
//!
//! For every recorded case the Rust document is loaded the way the office code loads (or created), given the same
//! operations and saved in both forms; what the Rust reader reads back from the output must equal the structural
//! summary pdf-lib read from its own output (page count, boxes, rotation, Info, object count, encryption), and the
//! Rust reader must read pdf-lib's output to the same summary. Re-recording, and having pdf-lib open what Rust wrote,
//! is `twin_live_write_core` (ignored: it runs Node).

use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use mixdog_pdf::write::info::PRODUCER;
use mixdog_pdf::write::{
    DocumentProperties, LoadOptions, PdfDocument, Rect, SaveOptions, WriteError, decode_text_string,
    encode_text_string, flate_stream, pdf_date,
};
use mixdog_pdf::{Dict, FilterResult, Guard, Obj, PdfError, Ref, StreamFilters};
use serde_json::{Value, json};

// ---- helpers -----------------------------------------------------------------------------------------------------

struct Filters;

impl StreamFilters for Filters {
    fn decode(
        &self,
        name: &str,
        data: &[u8],
        _params: Option<&Dict>,
        _length: Option<usize>,
        _max_output: usize,
    ) -> FilterResult {
        match name {
            "FlateDecode" | "Fl" => {
                let mut out = Vec::new();
                flate2::read::ZlibDecoder::new(data)
                    .read_to_end(&mut out)
                    .map_err(|e| PdfError::Format(e.to_string()))?;
                Ok(Some(out))
            }
            _ => Ok(None),
        }
    }
}

fn options(ignore_encryption: bool) -> LoadOptions {
    LoadOptions {
        ignore_encryption,
        filters: Arc::new(Filters),
        guard: Guard::unbounded(),
    }
}

fn load(bytes: &[u8], ignore_encryption: bool) -> Result<PdfDocument, WriteError> {
    PdfDocument::load(bytes.to_vec(), &options(ignore_encryption))
}

fn unbase64(text: &str) -> Vec<u8> {
    let mut out = Vec::new();
    let mut bits = 0u32;
    let mut have = 0;
    for c in text.bytes().take_while(|c| *c != b'=') {
        let value = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            other => panic!("not base64: {other}"),
        };
        bits = (bits << 6) | u32::from(value);
        have += 6;
        if have >= 8 {
            have -= 8;
            out.push((bits >> have) as u8);
            bits &= (1 << have) - 1;
        }
    }
    out
}

/// A number as JSON the way Node prints it: an integer when it has no fraction.
fn number(value: f64) -> Value {
    if value.fract() == 0.0 && value.abs() < 1e15 {
        json!(value as i64)
    } else {
        json!(value)
    }
}

fn rect(r: Rect) -> Value {
    Value::Array([r.x, r.y, r.width, r.height].into_iter().map(number).collect())
}

fn text(value: Option<String>) -> Value {
    value.map_or(Value::Null, Value::String)
}

/// The summary of the recorder's `summarize`.
fn summarize(document: &PdfDocument) -> Value {
    let pages: Vec<Value> = document
        .pages()
        .into_iter()
        .map(|page| {
            json!({
                "mediaBox": rect(document.media_box(page).unwrap()),
                "cropBox": rect(document.crop_box(page).unwrap()),
                "bleedBox": rect(document.bleed_box(page).unwrap()),
                "trimBox": rect(document.trim_box(page).unwrap()),
                "artBox": rect(document.art_box(page).unwrap()),
                "rotation": number(document.rotation(page).unwrap()),
            })
        })
        .collect();
    json!({
        "pageCount": pages.len(),
        "pages": pages,
        "info": {
            "title": text(document.title()),
            "author": text(document.author()),
            "subject": text(document.subject()),
            "keywords": text(document.keywords()),
        },
        "objectCount": document.store().len(),
        "encrypted": document.is_encrypted(),
    })
}

fn golden_path() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/office-write-core/golden.json")
}

fn golden() -> Value {
    let path = golden_path();
    serde_json::from_str(&mixdog_testkit::read_string(&path)).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

fn strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .expect("array")
        .iter()
        .map(|item| item.as_str().expect("string").to_owned())
        .collect()
}

fn apply(document: &mut PdfDocument, op: &Value) {
    match op["op"].as_str().expect("op") {
        "properties" => {
            let properties = &op["properties"];
            document.apply_document_properties(&DocumentProperties {
                title: properties["title"].as_str().map(str::to_owned),
                author: properties["author"].as_str().map(str::to_owned),
                subject: properties["subject"].as_str().map(str::to_owned),
                keywords: properties.get("keywords").map(strings),
            });
        }
        "creator" => document.set_creator(op["value"].as_str().expect("value")),
        "addPage" => {
            document
                .add_page(op["width"].as_f64().expect("width"), op["height"].as_f64().expect("height"))
                .expect("add a page");
        }
        other => panic!("unknown operation {other}"),
    }
}

const FORMS: [(&str, bool); 2] = [("classic", false), ("objectStreams", true)];

/// The document of a recorded case with its operations applied; `None` when the case is a refused load.
fn run_case(case: &Value) -> Option<PdfDocument> {
    let name = case["name"].as_str().expect("name");
    let ignore = case["ignoreEncryption"].as_bool().unwrap_or(false);
    let mut document = if case["create"].as_bool() == Some(true) {
        PdfDocument::create_at(0)
    } else {
        let input = unbase64(case["input"].as_str().expect("input"));
        match load(&input, ignore) {
            Err(error) => {
                assert_eq!(case["loadError"], json!("encrypted"), "{name}: {error}");
                assert_eq!(error, WriteError::Encrypted, "{name}");
                return None;
            }
            Ok(document) => {
                assert!(case.get("loadError").is_none(), "{name}: loaded a file pdf-lib refuses");
                assert_eq!(summarize(&document), case["inputSummary"], "{name}: the input as read");
                assert!(!document.store().is_dirty(), "{name}: a load is not an edit");
                document
            }
        }
    };
    for op in case["ops"].as_array().expect("ops") {
        apply(&mut document, op);
    }
    Some(document)
}

fn every_case_equals_the_recording() {
    let golden = golden();
    let cases = golden["cases"].as_array().expect("cases");
    assert!(cases.len() >= 10);
    for case in cases {
        let name = case["name"].as_str().expect("name");
        let Some(document) = run_case(case) else {
            continue;
        };
        for (form, use_object_streams) in FORMS {
            let recorded = &case["saves"][form];
            let written = document.save(SaveOptions { use_object_streams });
            let reread = load(&written, true).unwrap_or_else(|e| panic!("{name}/{form}: Rust output: {e}"));
            assert_eq!(summarize(&reread), recorded["summary"], "{name}/{form}: Rust output read back");
            if !document.is_encrypted() {
                let packs = written.windows(7).any(|w| w == b"/ObjStm");
                assert_eq!(packs, recorded["packsObjects"].as_bool().unwrap(), "{name}/{form}: object streams");
            }
            let theirs = unbase64(recorded["pdf"].as_str().expect("pdf"));
            let read_theirs = load(&theirs, true).unwrap_or_else(|e| panic!("{name}/{form}: pdf-lib output: {e}"));
            assert_eq!(summarize(&read_theirs), recorded["summary"], "{name}/{form}: pdf-lib output read by Rust");
        }
    }
}

// ---- the twin ----------------------------------------------------------------------------------------------------

#[test]
fn write_core_equals_the_recording() {
    every_case_equals_the_recording();
}

/// Records again with Node, compares, then has pdf-lib open what Rust wrote:
/// `cargo test -p mixdog-pdf --test twin_write_core -- --ignored`.
#[test]
#[ignore = "re-records through Node (pdf-lib) and has it open the Rust output"]
fn twin_live_write_core() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../..");
    let tree = std::env::var_os("MIXDOG_NODE_TREE").map_or_else(|| root.clone(), PathBuf::from);
    let recorder = root.join("benchmarks/rust-core/recorders/record-office-write-core.mjs");
    let tree_arg = std::ffi::OsString::from("--tree");
    mixdog_testkit::output("node", &[recorder.as_os_str(), tree_arg.as_os_str(), tree.as_os_str()]);
    every_case_equals_the_recording();

    let directory = std::env::temp_dir().join(format!("mixdog-write-core-{}", std::process::id()));
    mixdog_testkit::create_dir_all(&directory);
    let mut expected = serde_json::Map::new();
    for case in golden()["cases"].as_array().expect("cases") {
        let Some(document) = run_case(case) else {
            continue;
        };
        for (form, use_object_streams) in FORMS {
            let file = format!("{}-{form}.pdf", case["name"].as_str().expect("name"));
            let written = document.save(SaveOptions { use_object_streams });
            mixdog_testkit::write(directory.join(&file), &written);
            expected.insert(file, summarize(&load(&written, true).expect("reread")));
        }
    }
    let verify_arg = std::ffi::OsString::from("--verify");
    let printed = mixdog_testkit::output(
        "node",
        &[
            recorder.as_os_str(),
            tree_arg.as_os_str(),
            tree.as_os_str(),
            verify_arg.as_os_str(),
            directory.as_os_str(),
        ],
    );
    mixdog_testkit::remove_dir_all(&directory);
    let theirs: Value = serde_json::from_str(printed.trim()).expect("pdf-lib's summaries");
    assert_eq!(theirs, Value::Object(expected), "pdf-lib reading the Rust output");
}

// ---- structure of what is written ----------------------------------------------------------------------------------

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

fn count(haystack: &[u8], needle: &[u8]) -> usize {
    haystack.windows(needle.len()).filter(|w| *w == needle).count()
}

#[test]
fn classic_form_points_every_entry_at_its_object() {
    let mut document = PdfDocument::create_at(0);
    document.add_page(612.0, 792.0).unwrap();
    document.set_title("Offsets");
    let bytes = document.save(SaveOptions { use_object_streams: false });
    assert!(bytes.starts_with(b"%PDF-1.7\n"));
    assert!(bytes.ends_with(b"%%EOF\n"));
    let tail = String::from_utf8_lossy(&bytes[bytes.len() - 40..]).into_owned();
    let start: usize = tail
        .split("startxref\n")
        .nth(1)
        .and_then(|rest| rest.lines().next())
        .and_then(|line| line.parse().ok())
        .expect("startxref");
    assert!(bytes[start..].starts_with(b"xref\n0 5\n0000000000 65535 f \n"));
    let table = String::from_utf8_lossy(&bytes[start..]).into_owned();
    let entries: Vec<&str> = table.lines().skip(2).take(5).collect();
    for (num, entry) in entries.iter().enumerate().skip(1) {
        assert_eq!(entry.len(), 19, "entry lines are 20 bytes with the newline");
        let offset: usize = entry[..10].parse().unwrap();
        assert!(bytes[offset..].starts_with(format!("{num} 0 obj\n").as_bytes()), "object {num}");
    }
    assert!(table.contains("/Size 5"));
}

#[test]
fn a_gap_in_the_numbers_is_a_new_subsection() {
    let mut document = PdfDocument::create_at(0);
    let far = Ref::new(9, 0);
    document.store_mut().assign(far, Obj::Num(7.0));
    let bytes = document.save(SaveOptions { use_object_streams: false });
    let text = String::from_utf8_lossy(&bytes).into_owned();
    assert!(text.contains("xref\n0 4\n"), "{text}");
    assert!(text.contains("\n9 1\n"));
    let reread = load(&bytes, false).unwrap();
    assert!(matches!(reread.store().get(far), Some(Obj::Num(n)) if *n == 7.0));
    assert!(text.contains("/Size 10"));
}

#[test]
fn objects_are_packed_fifty_to_a_stream() {
    let mut document = PdfDocument::create_at(0);
    for _ in 0..120 {
        document.add_page(10.0, 20.0).unwrap();
    }
    let bytes = document.save(SaveOptions::default());
    assert_eq!(count(&bytes, b"/Type /ObjStm"), 3, "123 objects");
    assert!(find(&bytes, b"/Type /XRef").is_some());
    assert!(find(&bytes, b"\nxref\n").is_none());
    let reread = load(&bytes, false).unwrap();
    assert_eq!(reread.page_count(), 120);
    assert_eq!(reread.store().len(), document.store().len());
    assert!(!reread.store().is_dirty());
}

#[test]
fn streams_the_encrypt_dictionary_and_other_generations_stay_unpacked() {
    let mut document = PdfDocument::create_at(0);
    let mut encrypt = Dict::new();
    encrypt.set("Filter", Obj::name("Standard"));
    let encrypt_ref = document.store_mut().register(Obj::Dict(Arc::new(encrypt)));
    document.store_mut().trailer.encrypt = Some(encrypt_ref);
    let mut old = Dict::new();
    old.set("Kept", Obj::Bool(true));
    document.store_mut().assign(Ref::new(40, 3), Obj::Dict(Arc::new(old)));
    let bytes = document.save(SaveOptions::default());
    assert!(find(&bytes, format!("{} 0 obj\n<<\n/Filter /Standard", encrypt_ref.num).as_bytes()).is_some());
    assert!(find(&bytes, b"40 3 obj\n<<\n/Kept true").is_some());
    let reread = load(&bytes, true).unwrap();
    assert!(reread.is_encrypted());
    assert!(reread.store().get(Ref::new(40, 3)).is_some());
    assert_eq!(load(&bytes, false).unwrap_err(), WriteError::Encrypted);
}

#[test]
fn an_encrypted_file_is_never_packed() {
    let golden = golden();
    let case = golden["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == "encrypted-structure")
        .expect("case");
    let document = run_case(case).expect("loads with ignoreEncryption");
    let bytes = document.save(SaveOptions::default());
    assert_eq!(count(&bytes, b"/ObjStm"), 0);
    assert!(find(&bytes, b"/Encrypt").is_some());
    let reread = load(&bytes, true).unwrap();
    assert_eq!(summarize(&reread), summarize(&document));
}

#[test]
fn syntax_survives_a_save_and_a_read() {
    let mut document = PdfDocument::create_at(0);
    let mut dict = Dict::new();
    dict.set("A B#", Obj::name("a/b c(d)"));
    dict.set("Binary", Obj::string(&[0, 255, 10, 13, b'(']));
    dict.set("Plain", Obj::string(b"x (y) \\ z"));
    dict.set("Half", Obj::Num(0.5));
    dict.set("Negative", Obj::Num(-3.0));
    dict.set("Large", Obj::Num(123_456_789_012.0));
    dict.set("Small", Obj::Num(0.001));
    dict.set("Nested", Obj::Array(Arc::new(vec![Obj::Null, Obj::Bool(false), Obj::Ref(Ref::new(1, 0))])));
    let r = document.store_mut().register(Obj::Dict(Arc::new(dict)));
    for use_object_streams in [false, true] {
        let reread = load(&document.save(SaveOptions { use_object_streams }), false).unwrap();
        let Some(Obj::Dict(back)) = reread.store().get(r) else {
            panic!("dictionary");
        };
        assert_eq!(back.get_raw("A B#").and_then(Obj::as_name), Some("a/b c(d)"));
        assert_eq!(back.get_raw("Binary").and_then(Obj::as_str), Some(&[0u8, 255, 10, 13, b'('][..]));
        assert_eq!(back.get_raw("Plain").and_then(Obj::as_str), Some(&b"x (y) \\ z"[..]));
        assert_eq!(back.get_raw("Half").and_then(Obj::as_num), Some(0.5));
        assert_eq!(back.get_raw("Negative").and_then(Obj::as_num), Some(-3.0));
        assert_eq!(back.get_raw("Large").and_then(Obj::as_num), Some(123_456_789_012.0));
        assert_eq!(back.get_raw("Small").and_then(Obj::as_num), Some(0.001));
        let Some(Obj::Array(items)) = back.get_raw("Nested") else {
            panic!("array");
        };
        assert!(items[0].is_null() && matches!(items[1], Obj::Bool(false)));
        assert_eq!(items[2].as_ref_value(), Some(Ref::new(1, 0)));
    }
}

#[test]
fn flate_streams_round_trip_and_get_their_length() {
    let content = b"BT /F1 12 Tf 72 720 Td (Hello) Tj ET ".repeat(40);
    let mut document = PdfDocument::create_at(0);
    let mut dict = Dict::new();
    dict.set("Purpose", Obj::name("Content"));
    let r = document.store_mut().register(flate_stream(dict, &content));
    for use_object_streams in [false, true] {
        let reread = load(&document.save(SaveOptions { use_object_streams }), false).unwrap();
        let Some(Obj::Stream(stream)) = reread.store().get(r) else {
            panic!("stream");
        };
        assert!(stream.raw().len() < content.len());
        assert!(stream.dict.get_raw("Filter").is_some_and(|f| f.is_name("FlateDecode")));
        assert_eq!(stream.dict.get_raw("Length").and_then(Obj::as_num), Some(stream.raw().len() as f64));
        let decoded = reread.decode_stream(r, &Filters, &Guard::unbounded()).unwrap();
        assert_eq!(decoded, content);
    }
    assert!(matches!(
        document.decode_stream(Ref::new(1, 0), &Filters, &Guard::unbounded()),
        Err(WriteError::Invalid(_))
    ));
}

// ---- the store, the pages and the Info dictionary -------------------------------------------------------------------

#[test]
fn a_loaded_document_is_dirty_only_after_an_edit() {
    let golden = golden();
    let case = &golden["cases"][0];
    let mut document = run_case(case).expect("loads");
    assert!(!document.store().is_dirty());
    document.set_title("Edited");
    assert!(document.store().is_dirty());
    let info = document.store().trailer.info.expect("info");
    assert_eq!(document.store().dirty_numbers().collect::<Vec<_>>(), vec![info.num]);
}

#[test]
fn deleting_does_not_lower_the_next_number() {
    let mut document = PdfDocument::create_at(0);
    let last = document.store().largest_object_number();
    let r = document.store_mut().register(Obj::Null);
    assert_eq!(r.num, last + 1);
    assert!(document.store_mut().delete(r));
    assert!(!document.store_mut().delete(r));
    assert_eq!(document.store_mut().next_ref().num, last + 2);
}

#[test]
fn a_new_document_has_no_page_and_the_metadata_of_a_new_document() {
    let document = PdfDocument::create_at(1_700_000_000);
    assert_eq!(document.page_count(), 0);
    assert_eq!(document.store().len(), 3);
    assert_eq!(document.producer().as_deref(), Some(PRODUCER));
    assert_eq!(document.creator().as_deref(), Some(PRODUCER));
    let info = document.store().dict(document.store().trailer.info.unwrap()).unwrap().clone();
    assert_eq!(info.get_raw("ModDate").and_then(Obj::as_str), Some(&b"D:20231114221320Z"[..]));
    assert_eq!(info.get_raw("CreationDate").and_then(Obj::as_str), Some(&b"D:20231114221320Z"[..]));
}

#[test]
fn a_loaded_document_keeps_its_producer_and_dates() {
    let golden = golden();
    let case = golden["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == "producer-kept")
        .expect("case");
    let mut document = run_case(case).expect("loads");
    assert_eq!(document.producer().as_deref(), Some("Tool 1.0"));
    assert_eq!(document.creator(), None);
    for use_object_streams in [false, true] {
        let reread = load(&document.save(SaveOptions { use_object_streams }), false).unwrap();
        assert_eq!(reread.producer().as_deref(), Some("Tool 1.0"));
        assert_eq!(reread.author().as_deref(), Some("New author"));
        assert_eq!(reread.title().as_deref(), Some("Plain (title)"));
        let info = reread.store().dict(reread.store().trailer.info.unwrap()).unwrap();
        assert_eq!(info.get_raw("CreationDate").and_then(Obj::as_str), Some(&b"D:20200101000000Z"[..]));
        assert!(!info.has("ModDate"));
    }
    document.apply_document_properties(&DocumentProperties::default());
    assert_eq!(document.subject(), None);
}

#[test]
fn keywords_are_one_string_joined_with_spaces() {
    let mut document = PdfDocument::create_at(0);
    document.apply_document_properties(&DocumentProperties {
        keywords: Some(vec!["a".to_owned(), "b c".to_owned()]),
        ..DocumentProperties::default()
    });
    assert_eq!(document.keywords().as_deref(), Some("a b c"));
    assert_eq!(document.title(), None);
}

#[test]
fn text_strings_use_utf16_with_a_byte_order_mark_and_pdfdoc_without() {
    assert_eq!(encode_text_string("A"), vec![0xfe, 0xff, 0, 0x41]);
    let sample = "Quarterly \u{BCF4}\u{ACE0}\u{C11C} \u{1F600}";
    assert_eq!(decode_text_string(&encode_text_string(sample)), sample);
    assert_eq!(decode_text_string(&[0x80, 0x41, 0xa0, 0x7f, 0xe9]), "\u{2022}A\u{20AC}\u{FFFD}\u{E9}");
}

#[test]
fn dates_are_utc_in_the_pdf_form() {
    assert_eq!(pdf_date(0), "D:19700101000000Z");
    assert_eq!(pdf_date(951_782_400), "D:20000229000000Z");
    assert_eq!(pdf_date(1_700_000_000), "D:20231114221320Z");
    assert_eq!(pdf_date(-1), "D:19691231235959Z");
}

#[test]
fn page_attributes_are_inherited_and_the_other_boxes_follow_the_crop_box() {
    let golden = golden();
    let case = golden["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == "inherited-unchanged")
        .expect("case");
    let document = run_case(case).expect("loads");
    let pages = document.pages();
    assert_eq!(pages.len(), 3);
    // The leaves are visited through their tree: the two under the nested node first.
    assert_eq!(document.rotation(pages[0]).unwrap(), 180.0);
    assert_eq!(document.rotation(pages[1]).unwrap(), 270.0);
    assert_eq!(document.media_box(pages[1]).unwrap().width, 50.0);
    assert_eq!(document.crop_box(pages[2]).unwrap(), Rect { x: 0.0, y: 0.0, width: 100.0, height: 200.0 });
    assert_eq!(document.art_box(pages[0]).unwrap(), document.crop_box(pages[0]).unwrap());
    assert_eq!(document.bleed_box(pages[1]).unwrap(), Rect { x: 1.0, y: 2.0, width: 48.0, height: 56.0 });
}

#[test]
fn a_page_without_a_media_box_or_with_a_bad_one_is_an_error() {
    let mut document = PdfDocument::create_at(0);
    let page = document.add_page(10.0, 10.0).unwrap();
    document.store_mut().modify_dict(page, |dict| dict.delete("MediaBox")).unwrap();
    assert!(matches!(document.media_box(page), Err(WriteError::Invalid(_))));
    document
        .store_mut()
        .modify_dict(page, |dict| dict.set("MediaBox", Obj::Array(Arc::new(vec![Obj::Num(1.0)]))))
        .unwrap();
    let message = document.media_box(page).unwrap_err().to_string();
    assert!(message.contains("length 1"), "{message}");
    assert_eq!(document.rotation(page).unwrap(), 0.0);
}

#[test]
fn a_page_tree_that_contains_itself_ends() {
    let mut document = PdfDocument::create_at(0);
    document.add_page(10.0, 10.0).unwrap();
    let root = document.store().dict(document.catalog_ref().unwrap()).unwrap().get_raw("Pages").unwrap().as_ref_value().unwrap();
    document
        .store_mut()
        .modify_dict(root, |tree| {
            let mut kids = tree.get_raw("Kids").and_then(Obj::as_array).map(|k| (**k).clone()).unwrap();
            kids.push(Obj::Ref(root));
            tree.set("Kids", Obj::Array(Arc::new(kids)));
        })
        .unwrap();
    assert_eq!(document.page_count(), 1);
}

#[test]
fn a_file_that_is_not_a_pdf_is_the_readers_error() {
    let error = load(b"not a pdf at all", false).unwrap_err();
    assert!(matches!(error, WriteError::Pdf(_)), "{error}");
    assert!(matches!(load(b"", false), Err(WriteError::Pdf(PdfError::InvalidPdf(_)))));
}
