//! memory-embedding-tokenizer: `UnigramTokenizer::load` and `encode` (memory/embed/tokenizer.rs) over the
//! tokenizer.json layouts stored beside the golden.

use mixdog_testkit::Exact;

use super::{assert_case_count, case, fixture, golden, int, same, string};
use crate::memory::embed::tokenizer::UnigramTokenizer;
use crate::memory::error::MemoryError;

const SET: &str = "memory-embedding-tokenizer";
/// Node's `Number.MAX_SAFE_INTEGER` window of case 0 (the recording names it).
const MAX_SAFE_INTEGER: usize = 9_007_199_254_740_991;
/// The window the engine loads with when the model names none (embed/engine.rs `unwrap_or(512)`), Node's
/// `loadUnigramTokenizer` default.
const DEFAULT_WINDOW: usize = 512;

fn load(file: &str, max_length: usize) -> UnigramTokenizer {
    UnigramTokenizer::load(&fixture(SET, file), max_length).unwrap_or_else(|e| panic!("{file} loads: {e}"))
}

fn ids(ids: Vec<i64>) -> Exact {
    Exact::Array(ids.into_iter().map(int).collect())
}

#[test]
fn the_recording_has_three_cases() {
    assert_case_count(&golden(SET), 3);
}

#[test]
fn compact_unigram_encoder_reproduces_the_reference_library_ids_exactly() {
    let name = "compact Unigram encoder reproduces the reference library ids exactly";
    let golden = golden(SET);
    let case = case(&golden, 0, name);
    assert_eq!(case.get("maxLength").as_str(), "Number.MAX_SAFE_INTEGER");
    let tokenizer = load(case.get("tokenizerFile").as_str(), MAX_SAFE_INTEGER);
    for (i, pair) in case.get("encoded").as_array().iter().enumerate() {
        let [text, expected] = pair.as_array() else { panic!("sample {i} is not [text, ids]") };
        same(&format!("{name}: sample {i} {:?}", text.as_str()), expected, &ids(tokenizer.encode(text.as_str())));
    }
}

#[test]
fn ids_are_cut_to_the_model_window_like_transformers_truncation() {
    let name = "ids are cut to the model window like transformers truncation";
    let golden = golden(SET);
    let case = case(&golden, 1, name);
    let file = case.get("tokenizerFile").as_str();
    for probe in case.get("windowProbes").as_array() {
        let window = probe.get("maxLength").as_f64() as usize;
        let text = probe.get("text").as_str();
        same(&format!("{name}: window {window} {text:?}"), probe.get("result"), &ids(load(file, window).encode(text)));
    }
    // The recorder encodes 'ab cd' at the default window (record-memory-embedding-tokenizer.mjs `defaultWindow`).
    same(&format!("{name}: default window"), case.get("defaultWindow").get("result"), &ids(load(file, DEFAULT_WINDOW).encode("ab cd")));
}

#[test]
fn a_non_unigram_layout_is_reported_as_unsupported() {
    let name = "a non-Unigram layout is reported as unsupported";
    let golden = golden(SET);
    let case = case(&golden, 2, name);
    for probe in case.get("unsupported").as_array() {
        let file = probe.get("tokenizerFile").as_str();
        let error = match UnigramTokenizer::load(&fixture(SET, file), DEFAULT_WINDOW) {
            Ok(_) => panic!("{file} loads"),
            Err(error) => error,
        };
        // Node's UnsupportedTokenizerError is the embedding failure kind; its JS class name has no Rust form.
        let MemoryError::Embedding(message) = error else { panic!("{file}: not an embedding error: {error:?}") };
        let thrown = probe.get("thrown");
        assert_eq!(thrown.get("isUnsupportedTokenizerError"), &Exact::Bool(true));
        same(&format!("{name}: {file} thrown message"), thrown.get("message"), &string(message.clone()));
        let Exact::Error { message: recorded, code: None, cause: None, props, .. } = probe.get("error") else {
            panic!("{file}: recorded error carries a code or cause")
        };
        assert!(props.is_empty(), "{file}: recorded error props {props:?}");
        same(&format!("{name}: {file} error message"), &string(recorded.clone()), &string(message));
    }
}
