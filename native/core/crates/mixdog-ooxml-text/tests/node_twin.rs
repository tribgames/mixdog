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

#[test]
fn every_entry_answers_as_node_did() {
    let cases: Vec<Value> = serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/ooxml-text/golden.json")).expect("golden");
    assert!(cases.len() >= 120, "{} cases", cases.len());
    let scratch = tempfile::tempdir().expect("scratch folder");
    for case in &cases {
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

        let buffer = extract_ooxml_text_from_buffer(&bytes, filename, &extract);
        matches_recording(&format!("{name}: buffer"), Some(&buffer), &case["buffer"]);

        let tried = try_extract_ooxml_text_from_buffer(&bytes, filename, &limits);
        matches_recording(&format!("{name}: try"), tried.as_deref(), &case["try"]);

        let lowered = office_text_for_file(case["dataBase64"].as_str().unwrap(), filename);
        matches_recording(&format!("{name}: lowered"), lowered.as_deref(), &case["lowered"]);

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

/// `fixtures/tools/media-text/office.json`: the text Node's lowering gave an attached Office file, or `null`.
#[test]
fn attached_files_lower_to_the_text_of_the_media_text_set() {
    let cases: Vec<Value> = serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/tools/media-text/office.json")).expect("media-text office set");
    assert!(cases.len() >= 9);
    for case in &cases {
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
}
