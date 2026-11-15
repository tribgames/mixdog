//! Twin test `jbig2-symbols`: the recording of pdf.js 6.4.299's `jbig2.wasm` (PDFium's JBIG2 decoder) decoding the
//! streams `tests/record_jbig2_symbols.mjs` writes (`native/core/fixtures/office-jbig2-symbols/cases.txt`) against
//! `mixdog_pdf::codec::jbig2`. For EVERY recorded case the output must equal the recording byte for byte, and a case the
//! decoder fails must fail here with the same message: symbol dictionaries (arithmetic with every template, Huffman with
//! every table choice and custom tables, refinement and aggregation, retained contexts, globals), text regions (both
//! coding modes, every reference corner, transposed, strips, offsets, refinement, every operator), pattern dictionaries
//! and halftone regions (every template and operator, grid vectors, skip), and damaged or random payloads behind valid
//! headers. Re-recording is `twin_live_jbig2_symbols` (ignored: it runs Node).

use mixdog_office_base::twin;
use mixdog_pdf::codec::jbig2;

const RECORDER: &str = "native/core/crates/mixdog-pdf/tests/record_jbig2_symbols.mjs";

struct Case {
    name: String,
    width: i32,
    height: i32,
    data: Vec<u8>,
    globals: Option<Vec<u8>>,
    /// The recorded outcome: the bytes, or the message of the failure.
    expected: Result<Vec<u8>, String>,
}

fn unhex(text: &str) -> Vec<u8> {
    assert!(text.len() % 2 == 0, "odd hex length");
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).expect("hex"))
        .collect()
}

fn load_cases() -> Vec<Case> {
    let path = twin::repo_root().join("native/core/fixtures/office-jbig2-symbols/cases.txt");
    let text = mixdog_testkit::read_string(path);
    let mut cases = Vec::new();
    for block in text.split("\n\n").filter(|b| !b.trim().is_empty()) {
        let mut fields = std::collections::BTreeMap::new();
        for line in block.lines() {
            let (key, value) = line.split_once(' ').unwrap_or((line, ""));
            fields.insert(key.to_owned(), value.to_owned());
        }
        let get = |key: &str| {
            fields
                .get(key)
                .unwrap_or_else(|| panic!("case without {key}: {block:.80}"))
                .as_str()
        };
        let number = |key: &str| get(key).parse::<i32>().unwrap_or_else(|_| panic!("number {key}"));
        let expected = match fields.get("ok") {
            Some(hex) => Ok(unhex(hex)),
            None => Err(get("error").to_owned()),
        };
        cases.push(Case {
            name: get("case").to_owned(),
            width: number("width"),
            height: number("height"),
            data: unhex(get("data")),
            globals: fields.get("globals").map(|g| unhex(g)),
            expected,
        });
    }
    cases
}

/// How the decoder's result differs from the recording, or `None` when it is the same.
fn difference(case: &Case) -> Option<String> {
    let got = jbig2::decode(&case.data, case.width, case.height, case.globals.as_deref());
    match (&case.expected, &got) {
        (Ok(want), Ok(have)) if want == have => None,
        (Ok(want), Ok(have)) => {
            let at = want.iter().zip(have).position(|(a, b)| a != b);
            Some(format!(
                "{}: output differs (recorded {} bytes, got {}, first difference at {at:?})",
                case.name,
                want.len(),
                have.len()
            ))
        }
        (Err(want), Err(have)) if want == have.message() => None,
        (Err(want), Err(have)) => Some(format!(
            "{}: failed with {:?}, recorded {want:?}",
            case.name,
            have.message()
        )),
        (Ok(want), Err(have)) => Some(format!(
            "{}: failed with {:?}, recorded {} bytes",
            case.name,
            have.message(),
            want.len()
        )),
        (Err(want), Ok(have)) => Some(format!(
            "{}: decoded {} bytes, recorded the failure {want:?}",
            case.name,
            have.len()
        )),
    }
}

fn every_output_equals_the_recording() {
    let cases = load_cases();
    assert!(cases.len() > 300, "only {} cases recorded", cases.len());
    let failed = cases.iter().filter(|c| c.expected.is_err()).count();
    assert!(
        failed > 0 && failed < cases.len(),
        "the recording must hold decoded and failed cases"
    );
    for prefix in [
        "sdd-arith-",
        "sdd-huffman",
        "sdd-refagg-arith-",
        "sdd-refagg-huffman-",
        "sdd-retained-",
        "text-arith-",
        "text-huffman-",
        "halftone-",
        "fuzz-pattern-dict-",
        "fuzz-halftone-",
        "damaged-",
    ] {
        assert!(
            cases.iter().any(|c| c.name.starts_with(prefix) && c.expected.is_ok()),
            "no decoded case {prefix}*"
        );
    }
    let differences: Vec<String> = cases.iter().filter_map(difference).collect();
    assert!(
        differences.is_empty(),
        "{} of {} cases differ from the recording:\n{}",
        differences.len(),
        cases.len(),
        differences.iter().take(20).cloned().collect::<Vec<_>>().join("\n")
    );
}

#[test]
fn twin_jbig2_symbols() {
    every_output_equals_the_recording();
}

/// Records again with Node and compares: `cargo test -p mixdog-pdf --test twin_jbig2_symbols -- --ignored`.
#[test]
#[ignore = "re-records through Node (pdfjs-dist's jbig2.wasm)"]
fn twin_live_jbig2_symbols() {
    let printed = twin::run_recorder(RECORDER, &twin::node_source_root());
    assert!(
        printed.contains("recorded office-jbig2-symbols"),
        "the recorder did not finish: {printed}"
    );
    every_output_equals_the_recording();
}
