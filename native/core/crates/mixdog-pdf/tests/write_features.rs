//! Writing PDFs: the cross-reference table and object streams a save produces, the syntax that survives a save and a read,
//! document metadata and page boxes, and how the reader copes with damaged input.

use std::io::Read;
use std::sync::Arc;

use mixdog_pdf::write::info::PRODUCER;
use mixdog_pdf::write::{
    DocumentProperties, LoadOptions, PdfDocument, SaveOptions, WriteError, decode_text_string, encode_text_string, flate_stream, pdf_date,
};
use mixdog_pdf::{Dict, FilterResult, Guard, Obj, PdfError, Ref, StreamFilters};

struct Filters;

impl StreamFilters for Filters {
    fn decode(&self, name: &str, data: &[u8], _params: Option<&Dict>, _length: Option<usize>, _max_output: usize) -> FilterResult {
        match name {
            "FlateDecode" | "Fl" => {
                let mut out = Vec::new();
                flate2::read::ZlibDecoder::new(data).read_to_end(&mut out).map_err(|e| PdfError::Format(e.to_string()))?;
                Ok(Some(out))
            }
            _ => Ok(None),
        }
    }
}

fn options(ignore_encryption: bool) -> LoadOptions {
    LoadOptions { ignore_encryption, filters: Arc::new(Filters), guard: Guard::unbounded() }
}

fn load(bytes: &[u8], ignore_encryption: bool) -> Result<PdfDocument, WriteError> {
    PdfDocument::load(bytes.to_vec(), &options(ignore_encryption))
}

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
    let start: usize = tail.split("startxref\n").nth(1).and_then(|rest| rest.lines().next()).and_then(|line| line.parse().ok()).expect("startxref");
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
    assert!(matches!(document.decode_stream(Ref::new(1, 0), &Filters, &Guard::unbounded()), Err(WriteError::Invalid(_))));
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
fn keywords_are_one_string_joined_with_spaces() {
    let mut document = PdfDocument::create_at(0);
    document.apply_document_properties(&DocumentProperties { keywords: Some(vec!["a".to_owned(), "b c".to_owned()]), ..DocumentProperties::default() });
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
fn a_page_without_a_media_box_or_with_a_bad_one_is_an_error() {
    let mut document = PdfDocument::create_at(0);
    let page = document.add_page(10.0, 10.0).unwrap();
    document.store_mut().modify_dict(page, |dict| dict.delete("MediaBox")).unwrap();
    assert!(matches!(document.media_box(page), Err(WriteError::Invalid(_))));
    document.store_mut().modify_dict(page, |dict| dict.set("MediaBox", Obj::Array(Arc::new(vec![Obj::Num(1.0)])))).unwrap();
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

#[test]
fn an_entry_that_leads_to_another_object_rebuilds_the_table_and_reads_every_object() {
    let mut document = PdfDocument::create_at(0);
    let page = document.add_page(612.0, 792.0).unwrap();
    let mut bytes = document.save(SaveOptions { use_object_streams: false });
    // Row 4 (the page) of the table points at object 1.
    let table = find(&bytes, b"xref\n0 5\n").expect("table") + b"xref\n0 5\n".len();
    let first: Vec<u8> = bytes[table + 20..table + 30].to_vec();
    bytes[table + 4 * 20..table + 4 * 20 + 10].copy_from_slice(&first);
    let reread = load(&bytes, false).unwrap();
    assert_eq!(reread.store().len(), document.store().len());
    assert_eq!(reread.pages(), vec![page]);
    assert_eq!(reread.media_box(page).unwrap().width, 612.0);
}
