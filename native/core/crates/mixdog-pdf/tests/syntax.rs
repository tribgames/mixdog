//! The lexer, the parser, the object model and the cross-reference table on hand-made files: tokens, strings, names,
//! streams with a wrong `/Length`, inline images, classic tables, xref streams, hybrid files, `/Prev` chains,
//! object streams, encryption seams, cancellation and budget, and the reconstruction of broken files.

use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

use mixdog_pdf::{
    Budget, ByteStream, CommandArgs, Decryptor, DecryptorFactory, Dict, FilterResult, Guard,
    KnownCommands, Lexer, Linearization, Obj, Parser, PdfError, Ref, StreamFilters, Xref,
    XrefOptions,
};

// ---- helpers -----------------------------------------------------------------------------------------------------

struct TestFilters;

impl StreamFilters for TestFilters {
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
            "Broken" => Err(PdfError::Format("broken".to_owned())),
            _ => Ok(None),
        }
    }
}

fn deflate(data: &[u8]) -> Vec<u8> {
    let mut encoder = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
    encoder.write_all(data).unwrap();
    encoder.finish().unwrap()
}

fn options() -> XrefOptions {
    XrefOptions {
        filters: Arc::new(TestFilters),
        decryptor: None,
        guard: Guard::unbounded(),
    }
}

fn lexer(bytes: &[u8]) -> Lexer {
    Lexer::new(ByteStream::from_vec(bytes.to_vec()), Guard::unbounded())
}

fn tokens(bytes: &[u8]) -> Vec<Obj> {
    let mut lexer = lexer(bytes);
    let mut out = Vec::new();
    loop {
        match lexer.get_obj().unwrap() {
            Obj::Eof => return out,
            other => out.push(other),
        }
    }
}

fn parse(bytes: &[u8]) -> Result<Obj, PdfError> {
    Parser::new(lexer(bytes), None, true, false)?.get_obj(None)
}

fn num(obj: &Obj) -> f64 {
    obj.as_num()
        .unwrap_or_else(|| panic!("not a number: {obj:?}"))
}

fn string(obj: &Obj) -> Vec<u8> {
    obj.as_str()
        .unwrap_or_else(|| panic!("not a string: {obj:?}"))
        .to_vec()
}

fn name(obj: &Obj) -> String {
    obj.as_name()
        .unwrap_or_else(|| panic!("not a name: {obj:?}"))
        .to_owned()
}

fn dict(obj: &Obj) -> Arc<Dict> {
    obj.as_dict()
        .unwrap_or_else(|| panic!("not a dictionary: {obj:?}"))
        .clone()
}

/// A file under construction; offsets are relative to the `%PDF-` header, as in the file's own tables.
struct Pdf {
    buf: Vec<u8>,
    lead: usize,
    offsets: BTreeMap<i64, usize>,
}

impl Pdf {
    fn new(lead: &str) -> Pdf {
        let mut buf = lead.as_bytes().to_vec();
        let lead = buf.len();
        buf.extend_from_slice(b"%PDF-1.4\n");
        Pdf {
            buf,
            lead,
            offsets: BTreeMap::new(),
        }
    }

    fn pos(&self) -> usize {
        self.buf.len() - self.lead
    }

    fn text(&mut self, text: &str) {
        self.buf.extend_from_slice(text.as_bytes());
    }

    fn obj(&mut self, num: i64, body: &str) {
        self.offsets.insert(num, self.pos());
        self.text(&format!("{num} 0 obj\n{body}\nendobj\n"));
    }

    fn stream_obj(&mut self, num: i64, dict: &str, data: &[u8]) {
        self.offsets.insert(num, self.pos());
        self.text(&format!(
            "{num} 0 obj\n<< {dict} /Length {} >>\nstream\n",
            data.len()
        ));
        self.buf.extend_from_slice(data);
        self.text("\nendstream\nendobj\n");
    }

    /// A classic table of single-entry subsections for `nums`; returns the offset of `xref`.
    fn table(&mut self, nums: &[i64], trailer: &str) -> usize {
        let at = self.pos();
        self.text("xref\n0 1\n0000000000 65535 f \n");
        for n in nums {
            let offset = self.offsets[n];
            self.text(&format!("{n} 1\n{offset:010} 00000 n \n"));
        }
        self.text(&format!("trailer\n<< {trailer} >>\n"));
        at
    }

    fn startxref(&mut self, at: usize) {
        self.text(&format!("startxref\n{at}\n%%EOF\n"));
    }

    fn open(&self) -> Result<Xref, PdfError> {
        Xref::open(Arc::from(self.buf.clone()), options())
    }
}

const CATALOG: &str = "<< /Type /Catalog /Pages 2 0 R /S (abc) >>";
const PAGES: &str = "<< /Type /Pages /Kids [3 0 R] /Count 1 >>";
const PAGE: &str = "<< /Type /Page /Parent 2 0 R >>";

fn classic() -> Pdf {
    let mut pdf = Pdf::new("");
    pdf.obj(1, CATALOG);
    pdf.obj(2, PAGES);
    pdf.obj(3, PAGE);
    pdf
}

fn fetch(xref: &Xref, num: i64) -> Obj {
    xref.fetch(Ref::new(num, 0), false).unwrap()
}

/// `W [1 2 1]` entries.
fn xref_entries(entries: &[(u8, u16, u8)]) -> Vec<u8> {
    let mut out = Vec::new();
    for (kind, field, generation) in entries {
        out.push(*kind);
        out.extend_from_slice(&field.to_be_bytes());
        out.push(*generation);
    }
    out
}

// ---- lexer -------------------------------------------------------------------------------------------------------

#[test]
fn numbers_follow_pdfjs_tolerance() {
    let found = tokens(b"0 123 -45 +6 .5 4. 3.25 --7 1-2");
    let values: Vec<f64> = found.iter().map(num).collect();
    assert_eq!(
        values,
        vec![0.0, 123.0, -45.0, 6.0, 0.5, 4.0, 3.25, -7.0, 12.0]
    );
    assert_eq!(found[1].as_int(), Some(123));
    assert_eq!(found[2].as_int(), Some(-45));
    assert_eq!(
        found[5].as_int(),
        Some(4),
        "4. is an integer for Number.isInteger"
    );
    assert_eq!(found[6].as_int(), None);
}

#[test]
fn lone_sign_before_white_space_is_zero_and_a_letter_is_an_error() {
    assert_eq!(num(&tokens(b"- ")[0]), 0.0);
    let err = lexer(b"-a").get_obj().unwrap_err();
    assert_eq!(
        err,
        PdfError::Format("Invalid number: a (charCode 97)".to_owned())
    );
    assert_eq!(err.name(), "FormatError");
}

#[test]
fn literal_strings_resolve_escapes_and_balance_parentheses() {
    let found = tokens(b"(Hi \\(x\\) \\101\\060 (in) \\\nend) (\\53+) () (abc");
    assert_eq!(string(&found[0]), b"Hi (x) A0 (in) end".to_vec());
    assert_eq!(string(&found[1]), b"++".to_vec());
    assert_eq!(string(&found[2]), Vec::<u8>::new());
    assert_eq!(
        string(&found[3]),
        b"abc".to_vec(),
        "an unterminated string ends with the data"
    );
}

#[test]
fn hex_strings_ignore_white_space_and_pad_an_odd_digit() {
    let found = tokens(b"<48 65 6C6c6F7> <> <4g1>");
    assert_eq!(string(&found[0]), b"Hellop".to_vec());
    assert_eq!(string(&found[1]), Vec::<u8>::new());
    assert_eq!(string(&found[2]), vec![0x41]);
}

#[test]
fn names_resolve_hash_escapes() {
    let found = tokens(b"/Name /A#20B /A#zz /Lime#41 / /A#4 ");
    let names: Vec<String> = found.iter().map(name).collect();
    assert_eq!(names, vec!["Name", "A B", "A#zz", "LimeA", "", "A#4"]);
}

#[test]
fn delimiters_comments_and_keywords() {
    let found = tokens(b"% skip me\n[ ] << >> { } > true false null BT /F1 12 Tf");
    let cmds: Vec<&str> = found
        .iter()
        .filter_map(|o| match o {
            Obj::Cmd(c) => Some(&**c),
            _ => None,
        })
        .collect();
    assert_eq!(cmds, vec!["[", "]", "<<", ">>", "{", "}", ">", "BT", "Tf"]);
    assert!(matches!(found[7], Obj::Bool(true)));
    assert!(matches!(found[8], Obj::Bool(false)));
    assert!(found[9].is_null());
}

#[test]
fn bi_marks_the_inline_image_position_and_long_commands_fail() {
    let mut lexer = lexer(b"BI /W 1");
    assert!(lexer.get_obj().unwrap().is_cmd("BI"));
    assert_eq!(lexer.begin_inline_image_pos, Some(3));
    let long = vec![b'a'; 129];
    assert_eq!(lexer_error(&long), "Command token too long: 128");
}

fn lexer_error(bytes: &[u8]) -> String {
    lexer(bytes).get_obj().unwrap_err().message().to_owned()
}

#[test]
fn an_unmatched_close_parenthesis_is_illegal() {
    assert_eq!(lexer_error(b")"), "Illegal character: 41");
}

// ---- parser ------------------------------------------------------------------------------------------------------

#[test]
fn arrays_dictionaries_and_references() {
    let obj = parse(b"<< /A [1 2 0 R (s) /N] /B << /C null >> /D 3.5 >>").unwrap();
    let d = dict(&obj);
    let a = d.get_raw("A").unwrap().as_array().unwrap().clone();
    assert_eq!(a.len(), 4);
    assert_eq!(num(&a[0]), 1.0);
    assert_eq!(a[1].as_ref_value(), Some(Ref::new(2, 0)));
    assert_eq!(string(&a[2]), b"s".to_vec());
    assert_eq!(name(&a[3]), "N");
    assert!(
        dict(d.get_raw("B").unwrap())
            .get_raw("C")
            .unwrap()
            .is_null()
    );
    assert_eq!(num(d.get_raw("D").unwrap()), 3.5);
    assert_eq!(d.keys().collect::<Vec<_>>(), vec!["A", "B", "D"]);
}

#[test]
fn a_repeated_key_keeps_its_place_and_a_non_name_key_is_skipped() {
    let d = dict(&parse(b"<< /A 1 /B 2 /A 3 >>").unwrap());
    assert_eq!(d.keys().collect::<Vec<_>>(), vec!["A", "B"]);
    assert_eq!(num(d.get_raw("A").unwrap()), 3.0);
    let d = dict(&parse(b"<< 5 /A 1 >>").unwrap());
    assert_eq!(d.keys().collect::<Vec<_>>(), vec!["A"]);
}

#[test]
fn end_of_file_inside_a_container_is_an_error_unless_recovering() {
    assert_eq!(
        parse(b"[1 2").unwrap_err(),
        PdfError::ParserEof("End of file inside array.".to_owned())
    );
    assert_eq!(
        parse(b"<< /A 1").unwrap_err(),
        PdfError::ParserEof("End of file inside dictionary.".to_owned())
    );
    let mut recovering = Parser::new(lexer(b"[1 2"), None, true, true).unwrap();
    assert_eq!(
        recovering.get_obj(None).unwrap().as_array().unwrap().len(),
        2
    );
    let mut recovering = Parser::new(lexer(b"<< /A 1"), None, true, true).unwrap();
    assert_eq!(dict(&recovering.get_obj(None).unwrap()).len(), 1);
}

#[test]
fn nesting_deeper_than_the_budget_is_refused() {
    let guard = Guard::new(
        None,
        Budget {
            max_depth: 5,
            ..Budget::default()
        },
    );
    let mut parser = Parser::new(
        Lexer::new(ByteStream::from_vec(b"[[[[[[[[1]]]]]]]]".to_vec()), guard),
        None,
        false,
        false,
    )
    .unwrap();
    assert!(matches!(
        parser.get_obj(None),
        Err(PdfError::ResourceLimit(_))
    ));
}

#[test]
fn a_stream_with_the_right_length_is_cut_there() {
    let obj = parse(b"<< /Length 5 >>\nstream\nhello\nendstream").unwrap();
    assert_eq!(obj.as_stream().unwrap().raw(), b"hello");
}

#[test]
fn a_stream_with_a_wrong_length_is_cut_at_endstream() {
    for length in ["3", "99", "-4", "(x)"] {
        let source = format!("<< /Length {length} >>\nstream\nhello\nendstream\nendobj\n");
        let obj = parse(source.as_bytes()).unwrap();
        assert_eq!(
            obj.as_stream().unwrap().raw(),
            b"hello\n",
            "length {length}"
        );
    }
}

#[test]
fn a_truncated_endstream_spelling_is_found() {
    let obj = parse(b"<< /Length 1 >>\nstream\nhello world\nendstrea m endobj\n").unwrap();
    assert_eq!(obj.as_stream().unwrap().raw(), b"hello world\n");
}

#[test]
fn a_stream_without_endstream_is_a_format_error() {
    let err = parse(b"<< /Length 3 >>\nstream\nabc").unwrap_err();
    assert_eq!(
        err,
        PdfError::Format("Missing endstream command.".to_owned())
    );
}

#[test]
fn the_filter_chain_is_resolved_and_a_bad_name_is_refused() {
    let obj = parse(b"<< /Length 3 /Filter [/ASCIIHexDecode /FlateDecode] /DecodeParms [null << /Predictor 12 >>] >>\nstream\nabc\nendstream").unwrap();
    let stream = obj.as_stream().unwrap();
    let chain = stream.chain();
    assert_eq!(chain.len(), 2);
    assert_eq!(chain[0].name, "ASCIIHexDecode");
    assert!(chain[0].params.is_none());
    assert_eq!(
        num(chain[1]
            .params
            .as_ref()
            .unwrap()
            .get_raw("Predictor")
            .unwrap()),
        12.0
    );
    let err = parse(b"<< /Length 3 /Filter [5] >>\nstream\nabc\nendstream").unwrap_err();
    assert_eq!(err, PdfError::Format("Bad filter name \"5\"".to_owned()));
}

#[test]
fn stream_decoding_runs_the_chain_and_tolerates_what_pdfjs_tolerates() {
    let guard = Guard::unbounded();
    let packed = deflate(b"plain text");
    let mut source = format!(
        "<< /Length {} /Filter /FlateDecode >>\nstream\n",
        packed.len()
    )
    .into_bytes();
    source.extend_from_slice(&packed);
    source.extend_from_slice(b"\nendstream");
    let obj = parse(&source).unwrap();
    assert_eq!(
        obj.as_stream()
            .unwrap()
            .decode(&TestFilters, &guard)
            .unwrap(),
        b"plain text"
    );

    let unknown = parse(b"<< /Length 3 /Filter /LZWDecode >>\nstream\nabc\nendstream").unwrap();
    assert_eq!(
        unknown
            .as_stream()
            .unwrap()
            .decode(&TestFilters, &guard)
            .unwrap(),
        b"abc",
        "an unsupported filter leaves the bytes"
    );
    let broken = parse(b"<< /Length 3 /Filter /Broken >>\nstream\nabc\nendstream").unwrap();
    assert!(
        broken
            .as_stream()
            .unwrap()
            .decode(&TestFilters, &guard)
            .unwrap()
            .is_empty(),
        "a failing filter leaves nothing"
    );
    let empty = parse(b"<< /Length 0 /Filter /FlateDecode >>\nstream\nendstream").unwrap();
    assert!(
        empty
            .as_stream()
            .unwrap()
            .decode(&TestFilters, &guard)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn an_inline_image_is_skipped_to_its_ei() {
    let known: KnownCommands = [(
        "Q".to_owned(),
        CommandArgs {
            num_args: 0,
            variable_args: false,
        },
    )]
    .into_iter()
    .collect();
    let source = b"BI /W 2 /H 2 /BPC 8 /CS /G ID abcd EI\nQ\n";
    let lexer = Lexer::with_known_commands(
        ByteStream::from_vec(source.to_vec()),
        Guard::unbounded(),
        Some(Arc::new(known)),
    );
    let mut parser = Parser::new(lexer, None, false, false).unwrap();
    let image = parser.get_obj(None).unwrap();
    let stream = image.as_stream().unwrap();
    assert_eq!(stream.raw(), b"abcd");
    assert_eq!(num(stream.dict.get_raw("W").unwrap()), 2.0);
    assert!(parser.get_obj(None).unwrap().is_cmd("EI"));
    assert!(parser.get_obj(None).unwrap().is_cmd("Q"));
}

#[test]
fn an_ascii_hex_inline_image_ends_at_its_marker() {
    let source = b"BI /F /AHx /W 1 /H 1 ID 00ff> EI Q";
    let mut parser = Parser::new(lexer(source), None, false, false).unwrap();
    let image = parser.get_obj(None).unwrap();
    assert_eq!(image.as_stream().unwrap().raw(), b"00ff>");
}

#[test]
fn linearization_reads_its_parameters() {
    fn file(length: usize) -> Vec<u8> {
        format!("%PDF-1.4\n1 0 obj\n<< /Linearized 1 /L {length:05} /H [1 2] /O 3 /E 4 /N 5 /T 6 >>\nendobj\n").into_bytes()
    }
    let total = file(0).len();
    let guard = Guard::unbounded();
    let found = Linearization::create(&ByteStream::from_vec(file(total)), &guard)
        .unwrap()
        .unwrap();
    assert_eq!(found.num_pages, 5);
    assert_eq!(found.hints, vec![1, 2]);
    assert_eq!(found.page_first, 0);
    assert!(Linearization::create(&ByteStream::from_vec(file(total + 1)), &guard).is_err());
    let plain = ByteStream::from_vec(b"%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n".to_vec());
    assert_eq!(Linearization::create(&plain, &guard).unwrap(), None);
}

// ---- cross-reference: classic tables -----------------------------------------------------------------------------

#[test]
fn a_classic_table_opens_and_fetches() {
    let mut pdf = classic();
    let at = pdf.table(&[1, 2, 3], "/Size 4 /Root 1 0 R");
    pdf.startxref(at);
    let xref = pdf.open().unwrap();
    assert_eq!(xref.version(), Some("1.4"));
    assert!(xref.root().unwrap().has("Pages"));
    assert!(xref.trailer().unwrap().has("Size"));
    // The object cache is keyed by number, so the generation is checked on the first fetch only.
    let err = xref.fetch(Ref::new(3, 1), false).unwrap_err();
    assert_eq!(
        err,
        PdfError::XRefEntry("Inconsistent generation in XRef: 3R1".to_owned())
    );
    let page = dict(&fetch(&xref, 3));
    assert!(page.get_raw("Type").unwrap().is_name("Page"));
    assert_eq!(page.obj_id.as_deref(), Some("3R"));
    assert!(
        fetch(&xref, 9).is_null(),
        "an object the table does not know is null"
    );
    assert!(fetch(&xref, 0).is_null(), "a free entry is null");
    let catalog = dict(&fetch(&xref, 1));
    let pages = xref.get(&catalog, "Pages").unwrap();
    assert_eq!(num(dict(&pages).get_raw("Count").unwrap()), 1.0);
    assert_eq!(xref.count_updates_after(0), Some(1));
}

#[test]
fn offsets_are_relative_to_the_header() {
    let mut pdf = Pdf::new("junk before the header\n");
    pdf.obj(1, CATALOG);
    pdf.obj(2, PAGES);
    pdf.obj(3, PAGE);
    let at = pdf.table(&[1, 2, 3], "/Size 4 /Root 1 0 R");
    pdf.startxref(at);
    let xref = pdf.open().unwrap();
    assert!(
        dict(&fetch(&xref, 3))
            .get_raw("Type")
            .unwrap()
            .is_name("Page")
    );
    assert_eq!(xref.count_updates_after(0), Some(1));
}

#[test]
fn an_incremental_update_follows_prev_and_the_newest_entry_wins() {
    let mut pdf = classic();
    let first = pdf.table(&[1, 2, 3], "/Size 4 /Root 1 0 R");
    pdf.startxref(first);
    pdf.obj(3, "<< /Type /Page /Updated true >>");
    let second = pdf.table(&[3], &format!("/Size 4 /Root 1 0 R /Prev {first}"));
    pdf.startxref(second);
    let xref = pdf.open().unwrap();
    let page = dict(&fetch(&xref, 3));
    assert!(matches!(page.get_raw("Updated"), Some(Obj::Bool(true))));
    assert!(xref.root().is_some());
    assert_eq!(xref.count_updates_after(0), Some(2));
    assert_eq!(xref.count_updates_after(second as i64), Some(1));
}

// ---- cross-reference: streams, object streams, hybrid files -------------------------------------------------------

#[test]
fn an_xref_stream_opens_and_fetches() {
    for compress in [false, true] {
        let mut pdf = classic();
        let at = pdf.pos();
        let entries = xref_entries(&[
            (0, 0, 255),
            (1, pdf.offsets[&1] as u16, 0),
            (1, pdf.offsets[&2] as u16, 0),
            (1, pdf.offsets[&3] as u16, 0),
            (1, at as u16, 0),
        ]);
        if compress {
            pdf.stream_obj(
                4,
                "/Type /XRef /Size 5 /W [1 2 1] /Root 1 0 R /Filter /FlateDecode",
                &deflate(&entries),
            );
        } else {
            pdf.stream_obj(4, "/Type /XRef /Size 5 /W [1 2 1] /Root 1 0 R", &entries);
        }
        pdf.startxref(at);
        let xref = pdf.open().unwrap();
        assert!(
            dict(&fetch(&xref, 3))
                .get_raw("Type")
                .unwrap()
                .is_name("Page"),
            "compressed: {compress}"
        );
        assert!(xref.root().is_some());
    }
}

/// The object stream holding the catalog, the page tree and the page, and the numbers to find them by.
fn object_stream(compress: bool, pdf: &mut Pdf, num: i64) {
    let bodies = [CATALOG, PAGES, PAGE];
    let mut header = String::new();
    let mut offset = 0;
    for (i, body) in bodies.iter().enumerate() {
        header.push_str(&format!("{} {offset} ", i + 1));
        offset += body.len() + 1;
    }
    let first = header.len();
    let mut data = header.into_bytes();
    data.extend_from_slice(bodies.join("\n").as_bytes());
    let dict = format!("/Type /ObjStm /N 3 /First {first}");
    if compress {
        pdf.stream_obj(
            num,
            &format!("{dict} /Filter /FlateDecode"),
            &deflate(&data),
        );
    } else {
        pdf.stream_obj(num, &dict, &data);
    }
}

#[test]
fn compressed_objects_come_out_of_their_object_stream() {
    for compress in [false, true] {
        let mut pdf = Pdf::new("");
        object_stream(compress, &mut pdf, 5);
        let at = pdf.pos();
        let entries = xref_entries(&[
            (0, 0, 255),
            (2, 5, 0),
            (2, 5, 1),
            (2, 5, 2),
            (0, 0, 0),
            (1, pdf.offsets[&5] as u16, 0),
            (1, at as u16, 0),
        ]);
        pdf.stream_obj(6, "/Type /XRef /Size 7 /W [1 2 1] /Root 1 0 R", &entries);
        pdf.startxref(at);
        let xref = pdf.open().unwrap();
        let page = dict(&fetch(&xref, 3));
        assert!(
            page.get_raw("Type").unwrap().is_name("Page"),
            "compressed: {compress}"
        );
        assert_eq!(page.obj_id.as_deref(), Some("3R"));
        assert!(xref.root().unwrap().has("Pages"));
        assert_eq!(
            string(dict(&fetch(&xref, 1)).get_raw("S").unwrap()),
            b"abc".to_vec()
        );
        assert!(
            fetch(&xref, 4).is_null(),
            "a free entry of the stream is null"
        );
    }
}

#[test]
fn a_hybrid_file_reads_the_table_and_its_xref_stream() {
    let mut pdf = Pdf::new("");
    object_stream(false, &mut pdf, 7);
    let hybrid = pdf.pos();
    let entries = xref_entries(&[(2, 7, 0), (2, 7, 1)]);
    pdf.stream_obj(4, "/Type /XRef /Size 8 /Index [1 2] /W [1 2 1]", &entries);
    let at = pdf.table(&[7, 4], &format!("/Size 8 /Root 1 0 R /XRefStm {hybrid}"));
    pdf.startxref(at);
    let xref = pdf.open().unwrap();
    assert!(xref.root().unwrap().has("Pages"));
    assert!(
        dict(&fetch(&xref, 2))
            .get_raw("Type")
            .unwrap()
            .is_name("Pages")
    );
    assert_eq!(
        xref.count_updates_after(0),
        Some(1),
        "the xref stream of a hybrid file is not an update"
    );
}

// ---- encryption seams, cancellation ------------------------------------------------------------------------------

struct Xor;

impl Decryptor for Xor {
    fn decrypt_string(&self, _num: i64, _generation: i64, data: &[u8]) -> Vec<u8> {
        data.iter().map(|b| b ^ 1).collect()
    }

    fn decrypt_stream(
        &self,
        _num: i64,
        _generation: i64,
        data: &[u8],
        _crypt_name: Option<&str>,
    ) -> Result<Vec<u8>, PdfError> {
        Ok(data.iter().map(|b| b ^ 1).collect())
    }
}

struct XorFactory {
    seen_id: Mutex<Vec<u8>>,
}

impl DecryptorFactory for XorFactory {
    fn create(
        &self,
        encrypt: &Dict,
        file_id: &[u8],
        _xref: &Xref,
    ) -> Result<Arc<dyn Decryptor>, PdfError> {
        assert!(encrypt.suppress_encryption);
        *self.seen_id.lock().unwrap() = file_id.to_vec();
        Ok(Arc::new(Xor))
    }
}

fn encrypted_file() -> Pdf {
    let mut pdf = classic();
    pdf.obj(5, "<< /Filter /Standard >>");
    pdf.stream_obj(6, "", &[b'a' ^ 1, b'b' ^ 1, b'c' ^ 1]);
    let at = pdf.table(
        &[1, 2, 3, 5, 6],
        "/Size 7 /Root 1 0 R /Encrypt 5 0 R /ID [(abcd) (efgh)]",
    );
    pdf.startxref(at);
    pdf
}

#[test]
fn an_encrypted_file_goes_through_the_decryptor() {
    let factory = Arc::new(XorFactory {
        seen_id: Mutex::new(Vec::new()),
    });
    let opts = XrefOptions {
        filters: Arc::new(TestFilters),
        decryptor: Some(factory.clone()),
        guard: Guard::unbounded(),
    };
    let xref = Xref::open(Arc::from(encrypted_file().buf), opts).unwrap();
    assert!(xref.is_encrypted());
    assert_eq!(*factory.seen_id.lock().unwrap(), b"abcd".to_vec());
    assert_eq!(
        string(dict(&fetch(&xref, 1)).get_raw("S").unwrap()),
        vec![b'a' ^ 1, b'b' ^ 1, b'c' ^ 1]
    );
    let stream = fetch(&xref, 6);
    assert_eq!(
        stream
            .as_stream()
            .unwrap()
            .decode(&TestFilters, xref.guard())
            .unwrap(),
        b"abc"
    );
}

#[test]
fn an_encrypted_file_without_a_decryptor_does_not_open() {
    assert!(matches!(encrypted_file().open(), Err(PdfError::Unknown(_))));
}

#[test]
fn a_cancelled_reader_stops() {
    let guard = Guard::new(Some(Arc::new(|| true)), Budget::default());
    let opts = XrefOptions {
        filters: Arc::new(TestFilters),
        decryptor: None,
        guard,
    };
    let mut pdf = classic();
    let at = pdf.table(&[1, 2, 3], "/Size 4 /Root 1 0 R");
    pdf.startxref(at);
    assert_eq!(
        Xref::open(Arc::from(pdf.buf), opts).err(),
        Some(PdfError::Cancelled)
    );
}

// ---- reconstruction of broken files ------------------------------------------------------------------------------

#[test]
fn a_startxref_that_leads_nowhere_makes_the_file_be_rebuilt() {
    let mut pdf = classic();
    pdf.table(&[1, 2, 3], "/Size 4 /Root 1 0 R");
    pdf.startxref(999_999);
    let xref = pdf.open().unwrap();
    assert!(
        dict(&fetch(&xref, 3))
            .get_raw("Type")
            .unwrap()
            .is_name("Page")
    );
    assert!(xref.root().unwrap().has("Pages"));
    assert_eq!(
        xref.count_updates_after(0),
        None,
        "a rebuilt table has no sections"
    );
}

#[test]
fn a_table_with_wrong_offsets_is_rebuilt_when_an_entry_leads_to_the_wrong_object() {
    let mut pdf = classic();
    let at = pdf.table(&[1, 2, 3], "/Size 4 /Root 1 0 R");
    pdf.startxref(at);
    // The entry of object 3 now names the offset of object 2.
    let wrong = format!("{:010}", pdf.offsets[&2]);
    let right = format!("{:010} 00000 n", pdf.offsets[&3]);
    let text = String::from_utf8(pdf.buf.clone())
        .unwrap()
        .replace(&right, &format!("{wrong} 00000 n"));
    let xref = Xref::open(Arc::from(text.into_bytes()), options()).unwrap();
    let err = xref.fetch(Ref::new(3, 0), false).unwrap_err();
    assert!(mixdog_pdf::repair::triggers_rebuild(&err, false));
    assert!(!mixdog_pdf::repair::triggers_rebuild(&err, true));
    xref.rebuild().unwrap();
    assert!(
        dict(&fetch(&xref, 3))
            .get_raw("Type")
            .unwrap()
            .is_name("Page")
    );
}

#[test]
fn a_file_without_any_table_is_rebuilt_from_its_objects_and_trailer() {
    let mut pdf = classic();
    pdf.text("trailer\n<< /Size 4 /Root 1 0 R >>\n");
    let xref = pdf.open().unwrap();
    assert!(xref.trailer().unwrap().has("Size"));
    assert!(xref.root().unwrap().has("Pages"));
}

#[test]
fn without_a_trailer_an_object_with_a_root_stands_in() {
    let mut pdf = classic();
    pdf.obj(4, "<< /Root 1 0 R >>");
    let xref = pdf.open().unwrap();
    assert!(xref.trailer().unwrap().has("Root"));
    assert!(xref.root().unwrap().has("Pages"));
}

#[test]
fn the_last_definition_of_an_object_wins() {
    let mut pdf = Pdf::new("");
    pdf.obj(1, "<< /V 1 >>");
    pdf.obj(1, "<< /Type /Catalog /Pages 2 0 R /V 2 >>");
    pdf.obj(2, PAGES);
    pdf.text("trailer\n<< /Size 3 /Root 1 0 R >>\n");
    let xref = pdf.open().unwrap();
    assert_eq!(num(dict(&fetch(&xref, 1)).get_raw("V").unwrap()), 2.0);
}

#[test]
fn a_file_with_no_catalog_is_invalid() {
    let mut pdf = Pdf::new("");
    pdf.obj(1, "<< /V 1 >>");
    assert_eq!(
        pdf.open().err(),
        Some(PdfError::InvalidPdf("Invalid PDF structure.".to_owned()))
    );
    assert_eq!(
        Xref::open(Arc::from(Vec::<u8>::new()), options()).err(),
        Some(PdfError::InvalidPdf(
            "The PDF file is empty, i.e. its size is zero bytes.".to_owned()
        ))
    );
}

#[test]
fn errors_carry_pdfjs_names_and_messages() {
    assert_eq!(PdfError::need_password().name(), "PasswordException");
    assert_eq!(PdfError::need_password().message(), "No password given");
    assert_eq!(
        PdfError::incorrect_password().message(),
        "Incorrect Password"
    );
    assert_eq!(PdfError::XRefParse.name(), "XRefParseException");
    assert_eq!(
        PdfError::XRefEntry("x".to_owned()).to_string(),
        "XRefEntryException: x"
    );
    assert!(PdfError::Cancelled.is_fatal());
    assert!(!PdfError::XRefParse.is_fatal());
}
