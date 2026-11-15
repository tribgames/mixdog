//! Twin test `embed`: pdf-lib 1.17.1 with @pdf-lib/fontkit 1.1.1 as the Node office PDF code drives it (the recording
//! `native/core/fixtures/office-embed/golden.json`, written by `benchmarks/rust-core/recorders/record-office-embed.mjs`)
//! against `mixdog_pdf::embed`.
//!
//! * faces: for every recorded face and text list the Rust embedder must give the same coverage answers, the same
//!   widths and the same encoded glyph strings as pdf-lib; the objects it writes (Type0 font, CIDFont with its `W`,
//!   descriptor, ToUnicode text) equal the recorded ones, and the subset font program holds the same glyphs: every
//!   glyf slice or charstring and subroutine is the recorded one, with the recorded advances.
//! * standard: the 14 standard fonts' codes, widths with kerning, heights, dictionaries and refusal messages.
//! * documentFont: `pdf-fonts.mjs` (`embedDocumentFont`, `embedBoldFont`, `unicodeFontPath`) with explicit faces, the
//!   `MIXDOG_OCR_FONT` override and no system face, the font path replaced by `<font>` in every message.
//!
//! The one-page PDFs Rust writes being read back by pdf.js, and re-recording, is `twin_live_embed` (ignored: it runs
//! Node).

use std::io::Read;
use std::path::{Component, Path, PathBuf};

use mixdog_fsio::Unlaned;
use mixdog_pdf::embed::{
    DocumentFont, EmbeddedFace, Font, FontEnv, FontRequest, StandardFontName, SuffixRng,
    embed_bold_font, embed_document_font, unicode_font_path,
};
use mixdog_pdf::write::PdfDocument;
use mixdog_pdf::{Dict, Obj, Ref};
use serde_json::{Map, Value, json};

// ---- helpers -----------------------------------------------------------------------------------------------------

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures")
}

/// `path` with `.` and `..` folded away (no file system access).
fn clean(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

fn golden() -> Value {
    let path = fixtures().join("office-embed/golden.json");
    serde_json::from_str(&mixdog_testkit::read_string(&path))
        .unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

fn face_path(golden: &Value, id: &str) -> PathBuf {
    clean(&fixtures().join(golden["faces"][id].as_str().expect("face path")))
}

fn font_of(golden: &Value, id: &str) -> Font {
    let bytes = mixdog_testkit::read(face_path(golden, id));
    Font::embedded(EmbeddedFace::from_bytes(bytes).unwrap_or_else(|e| panic!("{id}: {e}")))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02X}")).collect()
}

/// A number as JSON the way Node prints it: an integer when it has no fraction.
fn number(value: f64) -> Value {
    if value.fract() == 0.0 && value.abs() < 1e15 {
        json!(value as i64)
    } else {
        json!(value)
    }
}

fn close(a: f64, b: f64) -> bool {
    (a - b).abs() <= 1e-9 * a.abs().max(b.abs()).max(1.0)
}

fn assert_width(got: f64, want: &Value, what: &str) {
    let want = want.as_f64().unwrap_or_else(|| panic!("{what}: no number"));
    assert!(close(got, want), "{what}: {got} != {want}");
}

// ---- the objects of an embedded font ---------------------------------------------------------------------------------

fn inflate(raw: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    flate2::read::ZlibDecoder::new(raw)
        .read_to_end(&mut out)
        .expect("a Flate stream");
    out
}

fn stream_bytes(document: &PdfDocument, r: Ref) -> Vec<u8> {
    match document.store().get(r) {
        Some(Obj::Stream(stream)) => inflate(stream.raw()),
        other => panic!("{r} is not a stream: {other:?}"),
    }
}

/// The recorder's `dump`: references followed, a stream as its dictionary without `Length`.
fn dump(document: &PdfDocument, obj: &Obj) -> Value {
    match obj {
        Obj::Ref(r) => dump(
            document,
            document.store().get(*r).expect("a reference to an object"),
        ),
        Obj::Name(name) => json!({ "name": &**name }),
        Obj::Num(value) => number(*value),
        Obj::Str(bytes) => json!({ "string": String::from_utf8_lossy(bytes) }),
        Obj::Array(items) => Value::Array(items.iter().map(|item| dump(document, item)).collect()),
        Obj::Dict(dict) => dump_dict(document, dict),
        Obj::Stream(stream) => {
            let mut dict = dump_dict(document, &stream.dict);
            dict.as_object_mut().expect("object").shift_remove("Length");
            json!({ "dict": dict })
        }
        other => panic!("not an object of a font: {other:?}"),
    }
}

fn dump_dict(document: &PdfDocument, dict: &Dict) -> Value {
    let mut out = Map::new();
    for (key, value) in dict.iter() {
        out.insert(key.to_owned(), dump(document, value));
    }
    Value::Object(out)
}

/// The recording of a stream is `{dict, length, sha256}`: the replay compares the dictionary (`Length` is the size of
/// the compressed bytes) and checks the decoded program and CMap on their own.
fn golden_dump(value: &Value) -> Value {
    match value {
        Value::Object(map) if map.contains_key("sha256") && map.contains_key("dict") => {
            let mut dict = map["dict"].clone();
            dict.as_object_mut().expect("object").shift_remove("Length");
            json!({ "dict": dict })
        }
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(key, item)| (key.clone(), golden_dump(item)))
                .collect(),
        ),
        Value::Array(items) => Value::Array(items.iter().map(golden_dump).collect()),
        other => other.clone(),
    }
}

fn follow<'a>(document: &'a PdfDocument, obj: &'a Obj) -> &'a Obj {
    match obj {
        Obj::Ref(r) => document.store().get(*r).expect("a reference to an object"),
        other => other,
    }
}

fn dict_of<'a>(document: &'a PdfDocument, obj: &'a Obj) -> &'a Dict {
    match follow(document, obj) {
        Obj::Dict(dict) => dict,
        other => panic!("not a dictionary: {other:?}"),
    }
}

// ---- the subset programs --------------------------------------------------------------------------------------------------

fn u16_at(bytes: &[u8], at: usize) -> usize {
    (usize::from(bytes[at]) << 8) | usize::from(bytes[at + 1])
}

fn i16_at(bytes: &[u8], at: usize) -> i64 {
    i64::from(u16_at(bytes, at) as u16 as i16)
}

fn u32_at(bytes: &[u8], at: usize) -> usize {
    (u16_at(bytes, at) << 16) | u16_at(bytes, at + 2)
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

fn blobs(value: &Value) -> Vec<Vec<u8>> {
    value
        .as_array()
        .expect("array")
        .iter()
        .map(|item| unbase64(item.as_str().expect("base64")))
        .collect()
}

struct SfntSummary {
    tags: Vec<String>,
    glyphs: Vec<Vec<u8>>,
    advances: Vec<usize>,
    bearings: Vec<i64>,
    long_loca: bool,
    metrics: usize,
    tables: Vec<(String, Vec<u8>)>,
}

fn sfnt_summary(bytes: &[u8]) -> SfntSummary {
    let count = u16_at(bytes, 4);
    let mut tables = Vec::new();
    for index in 0..count {
        let at = 12 + index * 16;
        let tag = String::from_utf8_lossy(&bytes[at..at + 4]).into_owned();
        let (offset, length) = (u32_at(bytes, at + 8), u32_at(bytes, at + 12));
        tables.push((tag, bytes[offset..offset + length].to_vec()));
    }
    let table = |tag: &str| {
        tables
            .iter()
            .find(|(name, _)| name == tag)
            .map(|(_, data)| data.as_slice())
            .expect("table")
    };
    let head = table("head");
    let long_loca = i16_at(head, 50) == 1;
    let glyph_count = u16_at(table("maxp"), 4);
    let loca = table("loca");
    let offsets: Vec<usize> = (0..=glyph_count)
        .map(|index| {
            if long_loca {
                u32_at(loca, index * 4)
            } else {
                u16_at(loca, index * 2) * 2
            }
        })
        .collect();
    let glyf = table("glyf");
    let hmtx = table("hmtx");
    let metrics = u16_at(table("hhea"), 34);
    let mut advances = Vec::new();
    let mut bearings = Vec::new();
    for index in 0..glyph_count {
        let at = index.min(metrics - 1) * 4;
        advances.push(u16_at(hmtx, at));
        bearings.push(if index < metrics {
            i16_at(hmtx, at + 2)
        } else {
            i16_at(hmtx, metrics * 4 + (index - metrics) * 2)
        });
    }
    SfntSummary {
        tags: tables.iter().map(|(tag, _)| tag.clone()).collect(),
        glyphs: (0..glyph_count)
            .map(|index| glyf[offsets[index]..offsets[index + 1]].to_vec())
            .collect(),
        advances,
        bearings,
        long_loca,
        metrics,
        tables: tables
            .iter()
            .filter(|(tag, _)| matches!(tag.as_str(), "cvt " | "prep" | "fpgm"))
            .cloned()
            .collect(),
    }
}

struct CffSummary {
    char_strings: Vec<Vec<u8>>,
    globals: Vec<Vec<u8>>,
    font_dicts: Vec<Vec<Vec<u8>>>,
    cid: bool,
    cid_count: Option<i64>,
}

fn cff_index(bytes: &[u8], at: usize) -> (Vec<Vec<u8>>, usize) {
    let count = u16_at(bytes, at);
    if count == 0 {
        return (Vec::new(), at + 2);
    }
    let size = usize::from(bytes[at + 2]);
    let offset = |index: usize| {
        (0..size).fold(0usize, |value, i| {
            value * 256 + usize::from(bytes[at + 3 + index * size + i])
        })
    };
    let base = at + 3 + (count + 1) * size - 1;
    let items = (0..count)
        .map(|index| bytes[base + offset(index)..base + offset(index + 1)].to_vec())
        .collect();
    (items, base + offset(count))
}

fn cff_dict(data: &[u8]) -> Vec<(u16, Vec<i64>)> {
    let mut entries = Vec::new();
    let mut operands = Vec::new();
    let mut at = 0;
    while at < data.len() {
        let b0 = data[at];
        match b0 {
            0..=21 => {
                let op = if b0 == 12 {
                    1200 + u16::from(data[at + 1])
                } else {
                    u16::from(b0)
                };
                at += if b0 == 12 { 2 } else { 1 };
                entries.push((op, std::mem::take(&mut operands)));
            }
            28 => {
                operands.push(i16_at(data, at + 1));
                at += 3;
            }
            29 => {
                operands.push(i64::from(u32_at(data, at + 1) as u32 as i32));
                at += 5;
            }
            30 => {
                at += 1;
                loop {
                    let byte = data[at];
                    at += 1;
                    if byte >> 4 == 15 || byte & 15 == 15 {
                        break;
                    }
                }
                operands.push(0);
            }
            32..=246 => {
                operands.push(i64::from(b0) - 139);
                at += 1;
            }
            247..=250 => {
                operands.push((i64::from(b0) - 247) * 256 + i64::from(data[at + 1]) + 108);
                at += 2;
            }
            _ => {
                operands.push(-(i64::from(b0) - 251) * 256 - i64::from(data[at + 1]) - 108);
                at += 2;
            }
        }
    }
    entries
}

fn cff_summary(bytes: &[u8]) -> CffSummary {
    let (_, after_names) = cff_index(bytes, usize::from(bytes[2]));
    let (tops, after_tops) = cff_index(bytes, after_names);
    let (_, after_strings) = cff_index(bytes, after_tops);
    let (globals, _) = cff_index(bytes, after_strings);
    let top = cff_dict(&tops[0]);
    let find = |dict: &[(u16, Vec<i64>)], op: u16| {
        dict.iter()
            .find(|(name, _)| *name == op)
            .map(|(_, operands)| operands.clone())
    };
    let (char_strings, _) = cff_index(bytes, find(&top, 17).expect("CharStrings")[0] as usize);
    let private_of = |dict: &[(u16, Vec<i64>)]| -> Vec<Vec<u8>> {
        let Some(operands) = find(dict, 18) else {
            return Vec::new();
        };
        let (size, offset) = (operands[0] as usize, operands[1] as usize);
        let private = cff_dict(&bytes[offset..offset + size]);
        find(&private, 19).map_or_else(Vec::new, |subrs| {
            cff_index(bytes, offset + subrs[0] as usize).0
        })
    };
    let font_dicts = match find(&top, 1236) {
        Some(array) => cff_index(bytes, array[0] as usize)
            .0
            .iter()
            .map(|item| private_of(&cff_dict(item)))
            .collect(),
        None => vec![private_of(&top)],
    };
    CffSummary {
        char_strings,
        globals,
        font_dicts,
        cid: find(&top, 1230).is_some(),
        cid_count: find(&top, 1234).map(|operands| operands[0]),
    }
}

// ---- faces -----------------------------------------------------------------------------------------------------------------

fn embed_face(font: &Font, document: &mut PdfDocument) -> Ref {
    let mut rng = SuffixRng::default();
    let reference = document.store_mut().next_ref();
    font.embed_into(document.store_mut(), Some(reference), &mut rng)
        .expect("embed")
}

fn replay_face(golden: &Value, case: &Value) {
    let name = case["name"].as_str().expect("name");
    let font = font_of(golden, case["face"].as_str().expect("face"));
    assert_eq!(
        font.name(),
        case["fontName"].as_str().expect("fontName"),
        "{name}: the PostScript name"
    );
    for step in case["steps"].as_array().expect("steps") {
        let text = step["text"].as_str().expect("text");
        let what = format!("{name}/{text:?}");
        assert_eq!(
            font.covers(text),
            step["covers"].as_bool().expect("covers"),
            "{what}: covers"
        );
        for (size, recorded) in step["widths"].as_object().expect("widths") {
            assert_width(
                font.width_of_text_at_size(text, size.parse().expect("size"))
                    .expect("width"),
                recorded,
                &format!("{what}: width at {size}"),
            );
        }
        assert_eq!(
            hex(&font.encode_text(text).expect("encode")),
            step["encoded"].as_str().expect("encoded"),
            "{what}: encoded"
        );
    }
    let heights = &case["heights"];
    assert_width(
        font.height_at_size(12.0, true),
        &heights["plain"],
        &format!("{name}: height"),
    );
    assert_width(
        font.height_at_size(12.0, false),
        &heights["noDescender"],
        &format!("{name}: height without descender"),
    );
    assert_width(
        font.size_at_height(100.0),
        &heights["sizeAtHeight"],
        &format!("{name}: size at height"),
    );

    let mut document = PdfDocument::create_at(0);
    let reference = embed_face(&font, &mut document);
    let font_dict = Obj::Ref(reference);
    assert_eq!(
        dump(&document, &font_dict),
        golden_dump(&case["fontDict"]),
        "{name}: the objects written"
    );
    let dict = dict_of(&document, &font_dict);
    let cmap = stream_bytes(
        &document,
        dict.get_raw("ToUnicode")
            .and_then(Obj::as_ref_value)
            .expect("ToUnicode"),
    );
    assert_eq!(
        String::from_utf8(cmap).expect("text"),
        case["toUnicode"].as_str().expect("toUnicode"),
        "{name}: ToUnicode"
    );

    let descendants = dict
        .get_raw("DescendantFonts")
        .and_then(Obj::as_array)
        .expect("DescendantFonts");
    let descriptor = dict_of(
        &document,
        dict_of(&document, &descendants[0])
            .get_raw("FontDescriptor")
            .expect("FontDescriptor"),
    );
    let key = if descriptor.has("FontFile2") {
        "FontFile2"
    } else {
        "FontFile3"
    };
    let program = stream_bytes(
        &document,
        descriptor
            .get_raw(key)
            .and_then(Obj::as_ref_value)
            .expect("program"),
    );
    program_equals(name, &case["program"], &program);
}

fn program_equals(name: &str, recorded: &Value, program: &[u8]) {
    let kind = recorded["kind"].as_str().expect("kind");
    if kind == "glyf" {
        let got = sfnt_summary(program);
        let want_tags: Vec<&str> = recorded["tableTags"]
            .as_array()
            .expect("tags")
            .iter()
            .map(|tag| tag.as_str().expect("tag"))
            .collect();
        assert_eq!(
            got.tags.iter().map(String::as_str).collect::<Vec<_>>(),
            want_tags,
            "{name}: the tables of the subset"
        );
        assert_eq!(
            got.glyphs.len(),
            recorded["glyphCount"].as_u64().expect("count") as usize,
            "{name}: glyph count"
        );
        assert_eq!(
            got.long_loca,
            recorded["longLoca"].as_bool().expect("loca"),
            "{name}: loca format"
        );
        assert_eq!(
            got.metrics,
            recorded["numberOfMetrics"].as_u64().expect("metrics") as usize,
            "{name}: number of metrics"
        );
        for (index, glyph) in recorded["glyphs"]
            .as_array()
            .expect("glyphs")
            .iter()
            .enumerate()
        {
            assert_eq!(
                got.glyphs[index],
                unbase64(glyph["data"].as_str().expect("data")),
                "{name}: glyph {index}"
            );
        }
        let advances: Vec<u64> = recorded["advances"]
            .as_array()
            .expect("advances")
            .iter()
            .map(|v| v.as_u64().expect("advance"))
            .collect();
        assert_eq!(
            got.advances.iter().map(|v| *v as u64).collect::<Vec<_>>(),
            advances,
            "{name}: advances"
        );
        let bearings: Vec<i64> = recorded["bearings"]
            .as_array()
            .expect("bearings")
            .iter()
            .map(|v| v.as_i64().expect("bearing"))
            .collect();
        assert_eq!(got.bearings, bearings, "{name}: bearings");
        let hinting = recorded["tableData"].as_object().expect("tables");
        assert_eq!(
            got.tables.len(),
            hinting.len(),
            "{name}: the hinting tables"
        );
        for (tag, data) in &got.tables {
            assert_eq!(
                *data,
                unbase64(hinting[tag].as_str().expect("table")),
                "{name}: the {tag} table"
            );
        }
    } else {
        let got = cff_summary(program);
        assert!(got.cid, "{name}: a CID-keyed font");
        assert_eq!(
            got.char_strings,
            blobs(&recorded["charStrings"]),
            "{name}: charstrings"
        );
        assert_eq!(
            got.cid_count,
            recorded["cidCount"].as_i64(),
            "{name}: CIDCount"
        );
        assert_eq!(
            got.globals,
            blobs(&recorded["globalSubrs"]),
            "{name}: global subrs"
        );
        let dicts = recorded["fontDicts"].as_array().expect("fds");
        assert_eq!(got.font_dicts.len(), dicts.len(), "{name}: font dicts");
        for (index, recorded_dict) in dicts.iter().enumerate() {
            assert_eq!(
                got.font_dicts[index],
                blobs(&recorded_dict["subrs"]),
                "{name}: local subrs of dict {index}"
            );
        }
    }
}

#[test]
fn faces_equal_the_recording() {
    let golden = golden();
    let cases = golden["faceCases"].as_array().expect("faceCases");
    assert!(cases.len() >= 8);
    for case in cases {
        replay_face(&golden, case);
    }
}

// ---- the standard fonts ---------------------------------------------------------------------------------------------------

#[test]
fn standard_fonts_equal_the_recording() {
    let golden = golden();
    let fonts = golden["standard"].as_array().expect("standard");
    assert_eq!(fonts.len(), 14);
    for case in fonts {
        let name = case["name"].as_str().expect("name");
        let font = Font::standard(
            StandardFontName::from_name(name)
                .unwrap_or_else(|| panic!("{name} is a standard font")),
        );
        for entry in case["texts"].as_array().expect("texts") {
            let text = entry["text"].as_str().expect("text");
            let what = format!("{name}/{text:?}");
            assert_eq!(
                font.covers(text),
                entry["covers"].as_bool().expect("covers"),
                "{what}: covers"
            );
            match (font.encode_text(text), &entry["encoded"]) {
                (Ok(bytes), recorded) => assert_eq!(
                    json!({ "value": hex(&bytes) }),
                    *recorded,
                    "{what}: encoded"
                ),
                (Err(error), recorded) => assert_eq!(
                    json!({ "error": error.to_string() }),
                    *recorded,
                    "{what}: refusal"
                ),
            }
            match &entry["widths"] {
                Value::Object(recorded) if recorded.contains_key("value") => {
                    for (size, width) in recorded["value"].as_object().expect("widths") {
                        assert_width(
                            font.width_of_text_at_size(text, size.parse().expect("size"))
                                .expect("width"),
                            width,
                            &format!("{what}: width at {size}"),
                        );
                    }
                }
                recorded => {
                    let error = font
                        .width_of_text_at_size(text, 12.0)
                        .expect_err("a refusal");
                    assert_eq!(
                        json!({ "error": error.to_string() }),
                        *recorded,
                        "{what}: width refusal"
                    );
                }
            }
        }
        let heights = &case["heights"];
        assert_width(
            font.height_at_size(12.0, true),
            &heights["plain"],
            &format!("{name}: height"),
        );
        assert_width(
            font.height_at_size(12.0, false),
            &heights["noDescender"],
            &format!("{name}: height without descender"),
        );
        assert_width(
            font.size_at_height(100.0),
            &heights["sizeAtHeight"],
            &format!("{name}: size at height"),
        );
        let mut document = PdfDocument::create_at(0);
        let reference = font
            .embed_into(document.store_mut(), None, &mut SuffixRng::default())
            .expect("embed");
        assert_eq!(
            dump(&document, &Obj::Ref(reference)),
            golden_dump(&case["fontDict"]),
            "{name}: the font dictionary"
        );
    }
}

// ---- pdf-fonts.mjs --------------------------------------------------------------------------------------------------------------------------

/// The paths of the documentFont cases: the fixture faces and a scratch directory with the damaged files.
struct Scratch {
    root: PathBuf,
    hebrew: PathBuf,
    lisu: PathBuf,
    liberation: PathBuf,
    miriam: PathBuf,
}

impl Scratch {
    fn new(golden: &Value) -> Self {
        let root =
            clean(&std::env::temp_dir().join(format!("mixdog-embed-{}", std::process::id())));
        mixdog_testkit::create_dir_all(&root);
        let scratch = Scratch {
            root,
            hebrew: face_path(golden, "hebrew"),
            lisu: face_path(golden, "lisu"),
            liberation: face_path(golden, "liberation"),
            miriam: face_path(golden, "miriam"),
        };
        let hebrew = mixdog_testkit::read(&scratch.hebrew);
        let lisu = mixdog_testkit::read(&scratch.lisu);
        mixdog_testkit::write(
            scratch.root.join("garbage.ttf"),
            b"this is not a font file at all",
        );
        mixdog_testkit::write(scratch.root.join("truncated.ttf"), &hebrew[..300]);
        let mut collection = b"ttcf".to_vec();
        collection.extend_from_slice(&[0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 16]);
        collection.extend_from_slice(&hebrew);
        mixdog_testkit::write(scratch.root.join("collection.ttc"), collection);
        for (directory, files) in [
            (
                "pair",
                vec![("Face-Regular.ttf", &hebrew), ("Face-Bold.ttf", &hebrew)],
            ),
            (
                "lonely",
                vec![("Face-Regular.ttf", &hebrew), ("Face-Bold.ttf", &lisu)],
            ),
            (
                "suffix",
                vec![("Face.ttf", &hebrew), ("Faceb.ttf", &hebrew)],
            ),
        ] {
            mixdog_testkit::create_dir_all(scratch.root.join(directory));
            for (file, bytes) in files {
                mixdog_testkit::write(scratch.root.join(directory).join(file), bytes);
            }
        }
        scratch
    }

    /// `$hebrew`, `$scratch/x` and the like as the paths they stand for.
    fn path(&self, symbolic: &str) -> String {
        let path = match symbolic {
            "$hebrew" => self.hebrew.clone(),
            "$lisu" => self.lisu.clone(),
            "$liberation" => self.liberation.clone(),
            "$miriam" => self.miriam.clone(),
            "" => return String::new(),
            other => match other.strip_prefix("$scratch/") {
                Some(rest) => self.root.join(rest),
                None => PathBuf::from(other),
            },
        };
        path.to_string_lossy().into_owned()
    }

    /// The recorder's `tokenise`: every known path is `<font>`, and separators are slashes.
    fn tokenise(&self, text: &str) -> String {
        let mut text = text.to_owned();
        for path in [
            &self.root,
            &self.hebrew,
            &self.lisu,
            &self.liberation,
            &self.miriam,
        ] {
            let path = path.to_string_lossy().into_owned();
            text = text.split(path.as_str()).collect::<Vec<_>>().join("<font>");
            let slashed = path.replace('\\', "/");
            text = text
                .split(slashed.as_str())
                .collect::<Vec<_>>()
                .join("<font>");
        }
        text.replace('\\', "/")
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        mixdog_testkit::remove_dir_all(&self.root);
    }
}

fn env_of(scratch: &Scratch, ocr: &str) -> FontEnv {
    FontEnv {
        ocr_font: (!ocr.is_empty()).then(|| scratch.path(ocr)),
        system_fonts: Vec::new(),
    }
}

fn standard_of(request: &Value) -> StandardFontName {
    request["standard"]
        .as_str()
        .map_or(StandardFontName::Helvetica, |name| {
            StandardFontName::from_name(name).expect("a standard font")
        })
}

#[test]
fn document_fonts_equal_the_recording() {
    let golden = golden();
    let scratch = Scratch::new(&golden);
    let cases = golden["documentFont"]["cases"].as_array().expect("cases");
    assert!(cases.len() >= 20);
    for case in cases {
        let name = case["name"].as_str().expect("name");
        let request = &case["request"];
        let text = request["text"].as_str().expect("text");
        let font_path = scratch.path(request["fontPath"].as_str().expect("fontPath"));
        let env = env_of(&scratch, case["ocrFont"].as_str().unwrap_or(""));
        let result = embed_document_font(
            &Unlaned,
            &env,
            &FontRequest {
                font_path: &font_path,
                text,
                standard: standard_of(request),
            },
        );
        match (&result, &case["result"]) {
            (
                Ok(DocumentFont {
                    font,
                    font_path,
                    embedded,
                }),
                recorded,
            ) => {
                let recorded = &recorded["value"];
                assert!(
                    !recorded.is_null(),
                    "{name}: Rust chose a font where pdf-lib refused"
                );
                assert_eq!(
                    scratch.tokenise(font_path),
                    recorded["fontPath"].as_str().expect("fontPath"),
                    "{name}: the face's file"
                );
                assert_eq!(
                    *embedded,
                    recorded["embedded"].as_bool().expect("embedded"),
                    "{name}: embedded"
                );
                assert_eq!(
                    font.name(),
                    recorded["name"].as_str().expect("name"),
                    "{name}: the face"
                );
                assert_eq!(
                    font.covers(text),
                    recorded["covers"].as_bool().expect("covers"),
                    "{name}: covers"
                );
                assert_width(
                    font.width_of_text_at_size(text, 12.0).expect("width"),
                    &recorded["width"],
                    &format!("{name}: width"),
                );
                assert_eq!(
                    hex(&font.encode_text(text).expect("encode")),
                    recorded["encoded"].as_str().expect("encoded"),
                    "{name}: encoded"
                );
            }
            (Err(error), recorded) => {
                assert_eq!(
                    scratch.tokenise(&error.to_string()),
                    recorded["error"]
                        .as_str()
                        .unwrap_or_else(|| panic!("{name}: pdf-lib chose a font")),
                    "{name}: the refusal"
                );
            }
        }
    }

    for case in golden["documentFont"]["bold"].as_array().expect("bold") {
        let name = case["name"].as_str().expect("name");
        let font_path = scratch.path(case["fontPath"].as_str().expect("fontPath"));
        let text = case["text"].as_str().expect("text");
        let regular = if font_path.is_empty() {
            Font::standard(StandardFontName::Helvetica)
        } else {
            Font::embedded(
                EmbeddedFace::from_bytes(mixdog_testkit::read(&font_path))
                    .expect("the regular face"),
            )
        };
        let bold = embed_bold_font(&Unlaned, &regular, &font_path, text);
        let recorded = &case["result"]["value"];
        assert_eq!(
            bold.same_font(&regular),
            recorded["sameAsRegular"].as_bool().expect("sameAsRegular"),
            "{name}: the regular face stands in"
        );
        assert_eq!(
            bold.name(),
            recorded["name"].as_str().expect("name"),
            "{name}: the bold face"
        );
        assert_width(
            bold.width_of_text_at_size(text, 12.0).expect("width"),
            &recorded["width"],
            &format!("{name}: width"),
        );
    }

    for case in golden["documentFont"]["unicodePath"]
        .as_array()
        .expect("unicodePath")
    {
        let name = case["name"].as_str().expect("name");
        let env = env_of(&scratch, case["ocrFont"].as_str().expect("ocrFont"));
        let path = unicode_font_path(
            &Unlaned,
            &env,
            &scratch.path(case["explicit"].as_str().expect("explicit")),
        );
        assert_eq!(
            scratch.tokenise(&path),
            case["path"].as_str().expect("path"),
            "{name}: the first readable font"
        );
    }
}

// ---- the twin, live ------------------------------------------------------------------------------------------------------------------------

/// A one-page PDF drawing `text` with `font`.
fn one_page(font: &Font, text: &str) -> Vec<u8> {
    let mut document = PdfDocument::create_at(0);
    let page = document.add_page(612.0, 792.0).expect("a page");
    // the font is written after the text is encoded, so its subset holds the glyphs
    let encoded = font.encode_text(text).expect("encode");
    let font_ref = font
        .embed_into(document.store_mut(), None, &mut SuffixRng::default())
        .expect("embed");
    let content = format!("BT /F1 12 Tf 72 700 Td <{}> Tj ET", hex(&encoded));
    let contents = document
        .store_mut()
        .register(mixdog_pdf::write::flate_stream(
            Dict::new(),
            content.as_bytes(),
        ));
    let mut fonts = Dict::new();
    fonts.set("F1", Obj::Ref(font_ref));
    let mut resources = Dict::new();
    resources.set("Font", Obj::Dict(std::sync::Arc::new(fonts)));
    document.store_mut().modify_dict(page, |dict| {
        dict.set("Resources", Obj::Dict(std::sync::Arc::new(resources)));
        dict.set("Contents", Obj::Ref(contents));
    });
    document.save(mixdog_pdf::write::SaveOptions {
        use_object_streams: false,
    })
}

/// Records again with Node, compares, then has pdf.js read what Rust wrote:
/// `cargo test -p mixdog-pdf --test twin_embed -- --ignored`.
#[test]
#[ignore = "re-records through Node (pdf-lib, fontkit) and has pdf.js read the Rust output"]
fn twin_live_embed() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../..");
    let tree = std::env::var_os("MIXDOG_NODE_TREE").map_or_else(|| root.clone(), PathBuf::from);
    let recorder = root.join("benchmarks/rust-core/recorders/record-office-embed.mjs");
    let tree_arg = std::ffi::OsString::from("--tree");
    mixdog_testkit::output(
        "node",
        &[recorder.as_os_str(), tree_arg.as_os_str(), tree.as_os_str()],
    );
    faces_equal_the_recording();
    standard_fonts_equal_the_recording();
    document_fonts_equal_the_recording();

    let golden = golden();
    let directory = std::env::temp_dir().join(format!("mixdog-embed-live-{}", std::process::id()));
    mixdog_testkit::create_dir_all(&directory);
    let mut expected = Map::new();
    for (id, text) in [
        ("hebrew", "שלום עולם"),
        ("miriam", "Hello שלום"),
        ("lisu", "ABC abc 123"),
    ] {
        let font = font_of(&golden, id);
        let file = format!("{id}.pdf");
        mixdog_testkit::write(directory.join(&file), one_page(&font, text));
        expected.insert(file, json!({ "text": text, "width": font.width_of_text_at_size(text, 12.0).expect("width") }));
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
    let read: Value = serde_json::from_str(printed.trim()).expect("pdf.js output is JSON");
    for (file, want) in &expected {
        let items = read[file]
            .as_array()
            .unwrap_or_else(|| panic!("{file}: pdf.js read nothing"));
        let text: String = items
            .iter()
            .map(|item| item["text"].as_str().unwrap_or(""))
            .collect();
        let squeezed = |value: &str| {
            value
                .chars()
                .filter(|character| !character.is_whitespace())
                .collect::<String>()
        };
        assert_eq!(
            squeezed(&text),
            squeezed(want["text"].as_str().expect("text")),
            "{file}: the text pdf.js extracts"
        );
        let width: f64 = items
            .iter()
            .map(|item| item["width"].as_f64().unwrap_or(0.0))
            .sum();
        assert!(
            (width - want["width"].as_f64().expect("width")).abs() < 0.05,
            "{file}: pdf.js width {width}"
        );
    }
    mixdog_testkit::remove_dir_all(&directory);
}
