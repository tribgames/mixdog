//! The recorded answers of Node's `office-extract.mjs` replayed byte for byte: every entry of the crate on the same bytes
//! (`fixtures/ooxml-text/golden.json`, recorded by `benchmarks/rust-core/recorders/record-ooxml-text.mjs`), and the
//! attached-file cases of the media-text set (`fixtures/tools/media-text/office.json`).

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use mixdog_fsio::Unlaned;
use mixdog_ooxml_text::ExtractOptions;
use mixdog_ooxml_text::Limits;
use mixdog_ooxml_text::extract_ooxml_text;
use mixdog_ooxml_text::extract_ooxml_text_from_buffer;
use mixdog_ooxml_text::media::office_text_for_file;
use mixdog_ooxml_text::try_extract_ooxml_text_from_buffer;
use serde_json::Value;
use sha2::Digest;
use sha2::Sha256;

/// What a recording holds for one answer: the text, `null`, or (for a text too large to keep) its size, hash and end.
fn matches_recording(what: &str, actual: Option<&str>, want: &Value) {
    match want {
        Value::Null => assert_eq!(actual, None, "{what}"),
        Value::String(text) => assert_eq!(actual, Some(text.as_str()), "{what}"),
        Value::Object(digest) => {
            let actual = actual.unwrap_or_else(|| panic!("{what}: no text, the recording has one"));
            assert_eq!(actual.len() as u64, digest["bytes"].as_u64().unwrap(), "{what}: byte count");
            let hash: String = Sha256::digest(actual.as_bytes()).iter().map(|byte| format!("{byte:02x}")).collect();
            assert_eq!(hash, digest["sha256"].as_str().unwrap(), "{what}: sha256");
            let tail: Vec<char> = actual.chars().rev().take(80).collect();
            let tail: String = tail.into_iter().rev().collect();
            assert_eq!(tail, digest["tail"].as_str().unwrap(), "{what}: last 80 characters");
        }
        other => panic!("{what}: unexpected recording {other}"),
    }
}

/// Each case is four answers (the buffer, the bounded buffer, the lowered text, the file); the answers are cut into this
/// many slices, an answer belonging to the slice its number (case index * 4 + which answer) is congruent to, so every
/// answer of every case runs in exactly one slice, and the answers of one large case run in different slices.
const SLICES: usize = 16;
const ANSWERS: usize = 4;

fn slice_answers(cases: usize, slice: usize) -> usize {
    (0..cases * ANSWERS).filter(|unit| unit % SLICES == slice).count()
}

fn golden() -> Vec<Value> {
    serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/ooxml-text/golden.json")).expect("golden")
}

#[test]
fn the_entry_slices_cover_every_recorded_answer_once() {
    let cases = golden().len();
    let sliced: usize = (0..SLICES).map(|slice| slice_answers(cases, slice)).sum();
    assert_eq!(sliced, cases * ANSWERS);
    println!("{cases} cases, {} answers in {SLICES} slices", cases * ANSWERS);
}

fn every_entry_of_slice_answers_as_node_did(slice: usize) {
    let cases = golden();
    assert!(cases.len() >= 120, "{} cases", cases.len());
    let scratch = tempfile::tempdir().expect("scratch folder");
    let mut ran = 0;
    for (index, case) in cases.iter().enumerate() {
        let mine = |answer: usize| (index * ANSWERS + answer) % SLICES == slice;
        if !(0..ANSWERS).any(mine) {
            continue;
        }
        let name = case["name"].as_str().unwrap();
        let filename = case["filename"].as_str().unwrap();
        let bytes = STANDARD.decode(case["dataBase64"].as_str().unwrap()).unwrap();
        let options = &case["options"];
        let limits = Limits {
            max_output_bytes: options["maxOutputBytes"].as_u64().unwrap() as usize,
            max_part_bytes: options["maxPartBytes"].as_u64().unwrap(),
            max_container_bytes: options["maxContainerBytes"].as_u64().unwrap(),
        };
        let extract = ExtractOptions { max_output_bytes: limits.max_output_bytes };

        if mine(0) {
            ran += 1;
            let buffer = extract_ooxml_text_from_buffer(&bytes, filename, &extract);
            matches_recording(&format!("{name}: buffer"), Some(&buffer), &case["buffer"]);
        }

        if mine(1) {
            ran += 1;
            let tried = try_extract_ooxml_text_from_buffer(&bytes, filename, &limits);
            matches_recording(&format!("{name}: try"), tried.as_deref(), &case["try"]);
        }

        if mine(2) {
            ran += 1;
            let lowered = office_text_for_file(case["dataBase64"].as_str().unwrap(), filename);
            matches_recording(&format!("{name}: lowered"), lowered.as_deref(), &case["lowered"]);
        }

        if mine(3) {
            ran += 1;
            if let Some(want) = case.get("file") {
                let path = scratch.path().join(filename);
                mixdog_testkit::write(&path, &bytes);
                let text = extract_ooxml_text(&Unlaned, &path, &extract);
                matches_recording(&format!("{name}: file"), Some(&text), want);
                mixdog_testkit::remove_file(&path);
            } else {
                assert_eq!(filename, "", "{name}: only a case without a file name has no file entry");
            }
        }
    }
    println!("slice {slice}: {ran} of {} answers", cases.len() * ANSWERS);
    assert_eq!(ran, slice_answers(cases.len(), slice));
}

macro_rules! entry_slices {
    ($($name:ident = $slice:expr),* $(,)?) => {
        $(
            #[test]
            fn $name() {
                every_entry_of_slice_answers_as_node_did($slice);
            }
        )*
    };
}

entry_slices!(
    every_entry_answers_as_node_did_slice_00 = 0,
    every_entry_answers_as_node_did_slice_01 = 1,
    every_entry_answers_as_node_did_slice_02 = 2,
    every_entry_answers_as_node_did_slice_03 = 3,
    every_entry_answers_as_node_did_slice_04 = 4,
    every_entry_answers_as_node_did_slice_05 = 5,
    every_entry_answers_as_node_did_slice_06 = 6,
    every_entry_answers_as_node_did_slice_07 = 7,
    every_entry_answers_as_node_did_slice_08 = 8,
    every_entry_answers_as_node_did_slice_09 = 9,
    every_entry_answers_as_node_did_slice_10 = 10,
    every_entry_answers_as_node_did_slice_11 = 11,
    every_entry_answers_as_node_did_slice_12 = 12,
    every_entry_answers_as_node_did_slice_13 = 13,
    every_entry_answers_as_node_did_slice_14 = 14,
    every_entry_answers_as_node_did_slice_15 = 15,
);

/// The attached-file cases are cut into this many slices (a case belongs to the slice its index is congruent to).
const ATTACHED_SLICES: usize = 5;

/// `fixtures/tools/media-text/office.json`: the text Node's lowering gave an attached Office file, or `null`.
fn media_cases() -> Vec<Value> {
    serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/tools/media-text/office.json")).expect("media-text office set")
}

#[test]
fn the_attached_file_slices_cover_every_case_once() {
    let total = media_cases().len();
    let sliced: usize = (0..ATTACHED_SLICES).map(|slice| (0..total).filter(|index| index % ATTACHED_SLICES == slice).count()).sum();
    assert_eq!(sliced, total);
    println!("{total} attached-file cases in {ATTACHED_SLICES} slices");
}

fn attached_files_of_slice_lower(slice: usize) {
    let cases = media_cases();
    assert!(cases.len() >= 9);
    let mut ran = 0;
    for (_, case) in cases.iter().enumerate().filter(|(index, _)| index % ATTACHED_SLICES == slice) {
        ran += 1;
        let name = case["name"].as_str().unwrap();
        let actual = office_text_for_file(case["dataBase64"].as_str().unwrap(), case["filename"].as_str().unwrap());
        let want = match case.get("text") {
            Some(text) => text.clone(),
            None => serde_json::json!({
                "bytes": case["textBytes"],
                "sha256": case["textSha256"],
                "tail": case["textTail"],
            }),
        };
        matches_recording(name, actual.as_deref(), &want);
    }
    println!("attached slice {slice}: {ran} of {} cases", cases.len());
    assert_eq!(ran, (0..cases.len()).filter(|index| index % ATTACHED_SLICES == slice).count());
}

macro_rules! attached_slices {
    ($($name:ident = $slice:expr),* $(,)?) => {
        $(
            #[test]
            fn $name() {
                attached_files_of_slice_lower($slice);
            }
        )*
    };
}

attached_slices!(
    attached_files_lower_to_the_text_of_the_media_text_set_slice_0 = 0,
    attached_files_lower_to_the_text_of_the_media_text_set_slice_1 = 1,
    attached_files_lower_to_the_text_of_the_media_text_set_slice_2 = 2,
    attached_files_lower_to_the_text_of_the_media_text_set_slice_3 = 3,
    attached_files_lower_to_the_text_of_the_media_text_set_slice_4 = 4,
);
