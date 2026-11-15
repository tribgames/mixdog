//! Twin test `jbig2`: the recording of pdf.js 6.4.299's `jbig2.wasm` (PDFium's JBIG2 and fax decoders) decoding the
//! streams `benchmarks/rust-core/recorders/record-office-jbig2.mjs` writes (`native/core/fixtures/office-jbig2/cases.txt`)
//! against `mixdog_pdf::codec`. For EVERY recorded case the output must equal the recording byte for byte, and a case
//! the decoder fails must fail here with the same message: generic regions with every template, typical prediction and
//! adaptive pixels, MMR, refinement regions, page composition, segment headers, globals, truncated and damaged streams,
//! image sizes; CCITT G3 and G4 with every option and run length, random and damaged data, the size rules.
//!
//! Segment types the symbol-dictionary port decodes (symbol dictionaries, text, pattern, halftone regions, tables) are
//! not in the recording. Re-recording is `twin_live_jbig2` (ignored: it runs Node).

use mixdog_office_base::twin;
use mixdog_pdf::codec::CodecError;
use mixdog_pdf::codec::arith::{ArithDecoder, ArithIaidDecoder, ArithIntDecoder};
use mixdog_pdf::codec::ccitt::{self, CcittParams};
use mixdog_pdf::codec::jbig2;

const RECORDER: &str = "benchmarks/rust-core/recorders/record-office-jbig2.mjs";

enum Kind {
    Jbig2,
    Ccitt(CcittParams),
}

struct Case {
    name: String,
    kind: Kind,
    width: i32,
    height: i32,
    data: Vec<u8>,
    globals: Option<Vec<u8>>,
    /// The recorded outcome: the bytes, or the message of the failure.
    expected: Result<Vec<u8>, String>,
}

fn set_dir() -> std::path::PathBuf {
    twin::repo_root().join("native/core/fixtures/office-jbig2")
}

fn unhex(text: &str) -> Vec<u8> {
    assert!(text.len() % 2 == 0, "odd hex length");
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).expect("hex"))
        .collect()
}

fn number(value: &str) -> i32 {
    value.parse().unwrap_or_else(|_| panic!("number {value:?}"))
}

fn load_cases() -> Vec<Case> {
    let text = mixdog_testkit::read_string(set_dir().join("cases.txt"));
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
        let kind = match get("kind") {
            "jbig2" => Kind::Jbig2,
            "ccitt" => Kind::Ccitt(CcittParams {
                k: number(get("k")),
                end_of_line: get("eol") == "1",
                encoded_byte_align: get("align") == "1",
                black_is_1: get("black") == "1",
                columns: number(get("columns")),
                rows: number(get("rows")),
            }),
            other => panic!("kind {other}"),
        };
        let expected = if let Some(hex) = fields.get("ok") {
            Ok(unhex(hex))
        } else {
            Err(get("error").to_owned())
        };
        cases.push(Case {
            name: get("case").to_owned(),
            kind,
            width: number(get("width")),
            height: number(get("height")),
            data: unhex(get("data")),
            globals: fields.get("globals").map(|g| unhex(g)),
            expected,
        });
    }
    cases
}

fn decode(case: &Case) -> Result<Vec<u8>, CodecError> {
    match &case.kind {
        Kind::Jbig2 => jbig2::decode(&case.data, case.width, case.height, case.globals.as_deref()),
        Kind::Ccitt(params) => ccitt::decode(&case.data, case.width, case.height, params),
    }
}

/// How `got` differs from the recording, or `None` when it equals it.
fn difference(case: &Case, got: &Result<Vec<u8>, CodecError>) -> Option<String> {
    match (&case.expected, got) {
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
    assert!(cases.len() > 600, "only {} cases recorded", cases.len());
    let failed = cases.iter().filter(|c| c.expected.is_err()).count();
    assert!(
        failed > 0 && failed < cases.len(),
        "the recording must hold decoded and failed cases"
    );
    let differences: Vec<String> = cases
        .iter()
        .filter_map(|case| difference(case, &decode(case)))
        .collect();
    assert!(
        differences.is_empty(),
        "{} of {} cases differ from the recording:\n{}",
        differences.len(),
        cases.len(),
        differences.iter().take(20).cloned().collect::<Vec<_>>().join("\n")
    );
}

#[test]
fn twin_jbig2() {
    every_output_equals_the_recording();
}

/// The integers and symbol ids the recorder's IAx and IAID encoders wrote.
#[test]
fn arithmetic_vectors_decode() {
    let text = mixdog_testkit::read_string(set_dir().join("arith-vectors.txt"));
    let mut seen = 0;
    for line in text.lines() {
        let parts: Vec<&str> = line.split(' ').collect();
        match parts[0] {
            "integers" => {
                let coded = unhex(parts[1]);
                let want: Vec<Option<i32>> = parts[2]
                    .split(',')
                    .map(|v| if v == "oob" { None } else { Some(number(v)) })
                    .collect();
                let mut decoder = ArithDecoder::new(&coded, 0);
                let mut ints = ArithIntDecoder::new();
                let got: Vec<Option<i32>> = want.iter().map(|_| ints.decode(&mut decoder)).collect();
                assert_eq!(got, want);
            }
            "ids" => {
                let coded = unhex(parts[2]);
                let want: Vec<u32> = parts[3].split(',').map(|v| number(v) as u32).collect();
                let mut decoder = ArithDecoder::new(&coded, 0);
                let mut ids = ArithIaidDecoder::new(number(parts[1]) as u32);
                let got: Vec<u32> = want.iter().map(|_| ids.decode(&mut decoder)).collect();
                assert_eq!(got, want);
            }
            other => panic!("vector kind {other}"),
        }
        seen += 1;
    }
    assert_eq!(seen, 2);
}

/// The product's own Node configuration cannot decode these images at all: pdf.js is never given a `wasmUrl`, so a
/// JBIG2 or CCITT image fails there ("JBig2 failed to initialize"). The recording is of the decoder pdf.js uses when it
/// is given its wasm files, which is what the Rust decoder now provides to the reader.
#[test]
fn the_recording_says_what_the_product_configuration_does() {
    let manifest = mixdog_testkit::read_string(set_dir().join("MANIFEST.json"));
    assert!(manifest.contains("\"wasmUrlGiven\": false"));
    assert!(manifest.contains("\"imageDecoded\": false"));
    assert!(manifest.contains("JBig2 failed to initialize"));
}

/// Records again with Node and compares: `cargo test -p mixdog-pdf --test twin_jbig2_generic -- --ignored`.
#[test]
#[ignore = "re-records through Node (pdfjs-dist's jbig2.wasm)"]
fn twin_live_jbig2() {
    let printed = twin::run_recorder(RECORDER, &twin::node_source_root());
    assert!(
        printed.contains("recorded office-jbig2"),
        "the recorder did not finish: {printed}"
    );
    every_output_equals_the_recording();
}
