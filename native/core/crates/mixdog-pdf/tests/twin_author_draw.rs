//! Twin test `author_draw`: `src/runtime/office/pdf/pdf-draw.mjs` (the recording
//! `native/core/fixtures/office-author-draw/golden.json`, written by
//! `benchmarks/rust-core/recorders/record-office-author-draw.mjs`) against `mixdog_pdf::author`.
//!
//! * wrap: the lines of `wrapText`, or its refusal, for each recorded text, width and measure (Helvetica, and two fixed
//!   measures that need no font file).
//! * colors, pageSizes, rounding: the channels, sizes and numbers, or the refusal text.
//! * images: for each recorded file the size the page places the image at, the image object (its dictionary, and the
//!   decoded bytes by hash and length) and its soft mask, or the refusal text. The pixels of an SVG are not compared
//!   (the recording of `office-svg` does that); its raster size, its soft mask and the declared size are.
//!
//! The font choice of `pdf-fonts.mjs` is replayed by `twin_embed`. Re-recording is `twin_live_author_draw` (ignored: it
//! runs Node).

use std::io::Read;
use std::path::PathBuf;

use mixdog_fsio::Unlaned;
use mixdog_office_base::twin;
use mixdog_pdf::author::draw::{embed_image, page_size, parse_color, round2};
use mixdog_pdf::author::wrap::wrap_text;
use mixdog_pdf::embed::{EmbedError, Font, StandardFontName};
use mixdog_pdf::write::store::ObjectStore;
use mixdog_pdf::{Obj, Ref};
use mixdog_raster::svg::SvgFonts;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

const SET: &str = "office-author-draw";
const RECORDER: &str = "benchmarks/rust-core/recorders/record-office-author-draw.mjs";

#[test]
fn wrapping_equals_the_recording() {
    let golden = twin::load_golden(SET);
    let helvetica = Font::standard(StandardFontName::Helvetica);
    for case in golden["wrap"].as_array().expect("wrap") {
        let name = case["name"].as_str().expect("name");
        let text = case["text"].as_str().expect("text");
        let size = case["size"].as_f64().expect("size");
        let width = case["width"].as_f64().expect("width");
        let measure: Box<dyn Fn(&str) -> Result<f64, EmbedError>> = match case["measure"].as_str().expect("measure") {
            "chars" => Box::new(move |value| Ok(value.chars().count() as f64 * size)),
            "wide" => Box::new(move |value| {
                Ok(value.chars().map(|character| if u32::from(character) > 0x2e7f { 2.0 } else { 1.0 }).sum::<f64>() * size)
            }),
            "helvetica" => {
                let font = helvetica.clone();
                Box::new(move |value| font.width_of_text_at_size(value, size))
            }
            other => panic!("{name}: measure {other}"),
        };
        let ours = wrap_text(text, width, measure);
        match (case.get("lines"), case.get("error")) {
            (Some(lines), _) => {
                let want: Vec<&str> = lines.as_array().expect("lines").iter().map(|line| line.as_str().expect("line")).collect();
                assert_eq!(ours.as_ref().map(|lines| lines.iter().map(String::as_str).collect::<Vec<_>>()), Ok(want), "{name}");
            }
            (None, Some(error)) => {
                assert_eq!(ours.unwrap_err().to_string(), error.as_str().expect("error"), "{name}");
            }
            _ => panic!("{name}: neither lines nor an error recorded"),
        }
    }
}

#[test]
fn colours_equal_the_recording() {
    let golden = twin::load_golden(SET);
    for case in golden["colors"].as_array().expect("colors") {
        let value = case["value"].as_str().unwrap_or("");
        match parse_color(value) {
            Ok(rgb) => {
                let want: Vec<f64> = case["rgb"].as_array().expect("rgb").iter().map(|channel| channel.as_f64().expect("channel")).collect();
                assert_eq!(rgb.to_vec(), want, "{value:?}");
            }
            Err(error) => assert_eq!(error, case["error"].as_str().expect("an error is recorded"), "{value:?}"),
        }
    }
}

#[test]
fn page_sizes_equal_the_recording() {
    let golden = twin::load_golden(SET);
    for case in golden["pageSizes"].as_array().expect("pageSizes") {
        let properties = &case["properties"];
        match page_size(properties) {
            Ok(size) => {
                let want: Vec<f64> = case["size"].as_array().expect("size").iter().map(|side| side.as_f64().expect("side")).collect();
                assert_eq!(size.to_vec(), want, "{properties}");
            }
            Err(error) => assert_eq!(error, case["error"].as_str().expect("an error is recorded"), "{properties}"),
        }
    }
}

#[test]
fn rounding_equals_the_recording() {
    let golden = twin::load_golden(SET);
    for case in golden["rounding"].as_array().expect("rounding") {
        let value = case["value"].as_f64().expect("value");
        assert_eq!(round2(value), case["rounded"].as_f64().expect("rounded"), "{value}");
    }
}

fn from_base64(text: &str) -> Vec<u8> {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = Vec::new();
    let (mut bits, mut held) = (0u32, 0u32);
    for byte in text.bytes().filter(|byte| *byte != b'=') {
        bits = (bits << 6) | ALPHABET.iter().position(|letter| *letter == byte).expect("base64") as u32;
        held += 6;
        if held >= 8 {
            held -= 8;
            out.push((bits >> held) as u8);
            bits &= (1 << held) - 1;
        }
    }
    out
}

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn inflate(raw: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    flate2::read::ZlibDecoder::new(raw).read_to_end(&mut out).expect("a Flate stream");
    out
}

/// The dictionary the way the recorder reduces it: numbers as numbers, names as their text, an array as pdf-lib prints it;
/// without `Length` and `SMask`.
fn reduced(store: &ObjectStore, reference: Ref) -> (Value, Vec<u8>, Option<Ref>) {
    let Some(Obj::Stream(stream)) = store.get(reference) else { panic!("{reference} is not a stream") };
    let mut dict = Map::new();
    let mut mask = None;
    for (key, value) in stream.dict.iter() {
        match (key, value) {
            ("Length", _) => {}
            ("SMask", Obj::Ref(target)) => mask = Some(*target),
            (_, Obj::Num(number)) => {
                dict.insert(key.to_owned(), if number.fract() == 0.0 { json!(*number as i64) } else { json!(number) });
            }
            (_, Obj::Name(name)) => {
                dict.insert(key.to_owned(), json!(&**name));
            }
            (_, Obj::Array(items)) => {
                let parts: Vec<String> = items.iter().map(|item| item.as_num().expect("a number").to_string()).collect();
                dict.insert(key.to_owned(), json!(format!("[ {} ]", parts.join(" "))));
            }
            other => panic!("{key}: {other:?}"),
        }
    }
    let filter = dict.get("Filter").and_then(Value::as_str).unwrap_or("");
    let bytes = if filter == "FlateDecode" { inflate(stream.raw()) } else { stream.raw().to_vec() };
    (Value::Object(dict), bytes, mask)
}

fn scratch() -> PathBuf {
    let directory = std::env::temp_dir().join(format!("mixdog-author-draw-{}", std::process::id()));
    mixdog_testkit::create_dir_all(&directory);
    directory
}

#[test]
fn embedded_images_equal_the_recording() {
    let golden = twin::load_golden(SET);
    let directory = scratch();
    let fonts = SvgFonts::none();
    for case in golden["images"].as_array().expect("images") {
        let name = case["name"].as_str().expect("name");
        let svg = name.starts_with("svg-");
        let path = directory.join(case["file"].as_str().expect("file"));
        mixdog_testkit::write(&path, from_base64(case["data"].as_str().expect("data")));
        let shown = path.to_string_lossy().into_owned();
        let mut store = ObjectStore::new();
        let ours = embed_image(&Unlaned, &mut store, &fonts, &shown);
        if let Some(recorded) = case.get("error") {
            let error = ours.expect_err(name).to_string();
            if case["exact"].as_bool() == Some(true) {
                assert_eq!(error.replace(&shown, "<file>"), recorded.as_str().expect("error"), "{name}");
            }
            continue;
        }
        let image = ours.unwrap_or_else(|error| panic!("{name}: {error}"));
        assert_eq!((u64::from(image.width), u64::from(image.height)), (case["width"].as_u64().expect("width"), case["height"].as_u64().expect("height")), "{name}: the size the page places it at");
        let (dict, bytes, mask) = reduced(&store, image.reference);
        assert_eq!(dict, case["image"]["dict"], "{name}: the image dictionary");
        assert_eq!(bytes.len() as u64, case["image"]["length"].as_u64().expect("length"), "{name}: the decoded length");
        if !svg {
            assert_eq!(sha256(&bytes), case["image"]["sha256"].as_str().expect("sha256"), "{name}: the decoded bytes");
        }
        match (&case["smask"], mask) {
            (Value::Null, None) => {}
            (recorded, Some(reference)) if !recorded.is_null() => {
                let (dict, bytes, nested) = reduced(&store, reference);
                assert!(nested.is_none(), "{name}: a mask has no mask");
                assert_eq!(dict, recorded["dict"], "{name}: the soft mask dictionary");
                assert_eq!(bytes.len() as u64, recorded["length"].as_u64().expect("length"), "{name}: the soft mask length");
                if !svg {
                    assert_eq!(sha256(&bytes), recorded["sha256"].as_str().expect("sha256"), "{name}: the soft mask bytes");
                }
            }
            (recorded, ours) => panic!("{name}: soft mask recorded {recorded}, here {ours:?}"),
        }
    }
    mixdog_testkit::remove_dir_all(&directory);
}

/// Records again with Node and compares: `cargo test -p mixdog-pdf --test twin_author_draw -- --ignored`.
#[test]
#[ignore = "runs node: re-records the fixture"]
fn twin_live_author_draw() {
    let path = twin::repo_root().join("native/core/fixtures").join(SET).join("golden.json");
    let before = mixdog_testkit::read(&path);
    twin::run_recorder(RECORDER, &twin::node_source_root());
    let after = mixdog_testkit::read(&path);
    assert!(before == after, "the recording differs from a new one");
    wrapping_equals_the_recording();
    colours_equal_the_recording();
    page_sizes_equal_the_recording();
    rounding_equals_the_recording();
    embedded_images_equal_the_recording();
}
