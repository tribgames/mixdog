//! The codecs behind the reader against what pdf.js answered to the same files (`fixtures/pdf-codec`, recorded by
//! `benchmarks/rust-core/recorders/record-pdf-codec.mjs`): every stream filter alone and chained, the predictors of
//! Flate and LZW, and every revision of the standard security handler with the empty, the user and the owner password.
//!
//! For each attempt to open a file: the same outcome as pdf.js (opened, or the `PasswordException` with its code and
//! message), and the lines pdf.js read from the page are among the string literals of the decoded content streams.

use std::io::Write;
use std::path::{Path, PathBuf};

use mixdog_pdf::codec_glue::CodecFilters;
use mixdog_pdf::document::{Document, OpenOptions, wrap_reason};
use mixdog_pdf::{PdfError, StreamFilters};
use serde_json::Value;

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/pdf-codec")
}

fn json(path: PathBuf) -> Value {
    serde_json::from_str(&mixdog_testkit::read_string(path)).expect("a recording parses")
}

/// The string literals of a content stream, escapes resolved (`(a \(b\) c)` is `a (b) c`).
fn literal_strings(content: &[u8]) -> Vec<Vec<u8>> {
    let mut found = Vec::new();
    let mut at = 0;
    while at < content.len() {
        if content[at] != b'(' {
            at += 1;
            continue;
        }
        at += 1;
        let mut depth = 1;
        let mut text = Vec::new();
        while at < content.len() {
            let byte = content[at];
            at += 1;
            match byte {
                b'\\' => {
                    let Some(&next) = content.get(at) else { break };
                    at += 1;
                    match next {
                        b'n' => text.push(b'\n'),
                        b'r' => text.push(b'\r'),
                        b't' => text.push(b'\t'),
                        b'b' => text.push(8),
                        b'f' => text.push(12),
                        b'\r' | b'\n' => {}
                        b'0'..=b'7' => {
                            let mut value = u32::from(next - b'0');
                            for _ in 0..2 {
                                match content.get(at) {
                                    Some(digit @ b'0'..=b'7') => {
                                        value = value * 8 + u32::from(digit - b'0');
                                        at += 1;
                                    }
                                    _ => break,
                                }
                            }
                            text.push(value as u8);
                        }
                        other => text.push(other),
                    }
                }
                b'(' => {
                    depth += 1;
                    text.push(byte);
                }
                b')' => {
                    depth -= 1;
                    if depth == 0 {
                        break;
                    }
                    text.push(byte);
                }
                _ => text.push(byte),
            }
        }
        found.push(text);
    }
    found
}

/// What differs between one recorded attempt to open `bytes` and this port, as short lines.
fn attempt_differences(name: &str, bytes: &[u8], attempt: &Value) -> Vec<String> {
    let label = attempt["label"].as_str().unwrap_or("?");
    let options = OpenOptions {
        password: attempt["password"].as_str().map(str::to_owned),
        ..OpenOptions::default()
    };
    let opened = Document::open(bytes.to_vec(), &options);
    if attempt["opened"] != Value::Bool(true) {
        return match opened {
            Ok(_) => vec![format!("{name} ({label}): opened, pdf.js did not")],
            Err(e) => {
                let ours = wrap_reason(&e);
                let theirs = &attempt["error"];
                if Some(ours.name) == theirs["name"].as_str()
                    && Some(ours.message.as_str()) == theirs["message"].as_str()
                    && ours.code.map(u64::from) == theirs["code"].as_u64()
                {
                    Vec::new()
                } else {
                    vec![format!("{name} ({label}): {ours:?}, pdf.js {theirs}")]
                }
            }
        };
    }
    let document = match opened {
        Ok(document) => document,
        Err(e) => return vec![format!("{name} ({label}): did not open: {e}")],
    };
    let mut found = Vec::new();
    if Some(document.num_pages()) != attempt["numPages"].as_i64() {
        found.push(format!(
            "{name} ({label}): {} pages, pdf.js {}",
            document.num_pages(),
            attempt["numPages"]
        ));
    }
    let mut literals = Vec::new();
    for index in 0..usize::try_from(document.num_pages()).unwrap_or(0) {
        match document
            .page(index)
            .and_then(|page| page.content(&document))
        {
            Ok(content) => literals.extend(literal_strings(&content)),
            Err(e) => found.push(format!("{name} ({label}) page {}: {e}", index + 1)),
        }
    }
    for line in attempt["strings"].as_array().expect("the strings") {
        let line = line.as_str().expect("a string");
        if !literals.iter().any(|literal| literal == line.as_bytes()) {
            found.push(format!(
                "{name} ({label}): the decoded content lacks {line:?}"
            ));
        }
    }
    found
}

#[test]
fn every_recorded_file_decodes_and_decrypts_as_in_pdf_js() {
    let manifest = json(fixtures().join("MANIFEST.json"));
    let cases = manifest["cases"].as_array().expect("the cases");
    assert!(
        cases.len() >= 74,
        "the recording lost cases: {}",
        cases.len()
    );
    let mut found = Vec::new();
    let mut attempts = 0;
    for case in cases {
        let golden = json(
            fixtures()
                .join("goldens")
                .join(format!("{}.json", case.as_str().expect("a case name"))),
        );
        let bytes = mixdog_testkit::read(fixtures().join(golden["file"].as_str().expect("a file")));
        for attempt in golden["attempts"].as_array().expect("the attempts") {
            attempts += 1;
            found.extend(attempt_differences(
                golden["name"].as_str().expect("a name"),
                &bytes,
                attempt,
            ));
        }
    }
    assert!(attempts >= cases.len(), "every case has an attempt");
    found.truncate(20);
    assert!(
        found.is_empty(),
        "differences from pdf.js:\n{}",
        found.join("\n")
    );
}

#[test]
fn a_literal_string_reads_its_escapes() {
    let strings = literal_strings(b"BT (one \\(two\\) \\\\ \\101 (nested)) Tj (next) Tj ET");
    assert_eq!(
        strings,
        vec![b"one (two) \\ A (nested)".to_vec(), b"next".to_vec()]
    );
}

#[test]
fn brotli_decode_is_a_known_filter_that_stops_past_the_limit() {
    let data: Vec<u8> = (0..4000u32).map(|n| (n % 251) as u8).collect();
    let mut packed = Vec::new();
    brotli::BrotliCompress(
        &mut &data[..],
        &mut packed,
        &brotli::enc::BrotliEncoderParams::default(),
    )
    .expect("compresses");
    let decoded = CodecFilters
        .decode("BrotliDecode", &packed, None, None, 1 << 20)
        .expect("decodes")
        .expect("a known filter");
    assert_eq!(decoded, data);
    assert!(matches!(
        CodecFilters.decode("BrotliDecode", &packed, None, None, 100),
        Err(PdfError::ResourceLimit(_))
    ));
}

#[test]
fn image_codecs_leave_the_bytes_and_an_unknown_name_is_not_decoded() {
    for name in [
        "DCTDecode",
        "DCT",
        "JPXDecode",
        "CCITTFaxDecode",
        "JBIG2Decode",
    ] {
        let out = CodecFilters
            .decode(name, b"pixels", None, None, 100)
            .expect("no failure");
        assert_eq!(out.as_deref(), Some(&b"pixels"[..]), "{name}");
    }
    assert_eq!(
        CodecFilters
            .decode("NoSuchDecode", b"x", None, None, 100)
            .expect("no failure"),
        None
    );
}

#[test]
fn a_wrong_password_is_the_incorrect_password_exception() {
    let path = fixtures().join("files/encrypted-rc4-128-user-password.pdf");
    let bytes = mixdog_testkit::read(path);
    let wrong = OpenOptions {
        password: Some("not the password".to_owned()),
        ..OpenOptions::default()
    };
    let error = Document::open(bytes.clone(), &wrong)
        .err()
        .expect("a wrong password");
    let exception = wrap_reason(&error);
    assert_eq!(
        (exception.name, exception.code, exception.message.as_str()),
        ("PasswordException", Some(2), "Incorrect Password")
    );
    let missing = Document::open(bytes, &OpenOptions::default())
        .err()
        .expect("no password");
    assert_eq!(wrap_reason(&missing).code, Some(1));
}

#[test]
fn flate_applies_the_predictor_of_its_parameters() {
    // A Flate stream with a PNG "up" predictor over 4-byte rows, written here.
    let rows: [[u8; 4]; 2] = [[1, 2, 3, 4], [5, 6, 7, 8]];
    let mut raw = Vec::new();
    let mut previous = [0u8; 4];
    for row in rows {
        raw.push(2);
        raw.extend(row.iter().zip(previous).map(|(b, p)| b.wrapping_sub(p)));
        previous = row;
    }
    let mut encoder = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
    encoder.write_all(&raw).expect("writes");
    let packed = encoder.finish().expect("finishes");
    let mut params = mixdog_pdf::Dict::new();
    params.set("Predictor", mixdog_pdf::Obj::Num(12.0));
    params.set("Columns", mixdog_pdf::Obj::Num(4.0));
    let decoded = CodecFilters
        .decode("FlateDecode", &packed, Some(&params), None, 1 << 20)
        .expect("decodes")
        .expect("a known filter");
    assert_eq!(decoded, vec![1, 2, 3, 4, 5, 6, 7, 8]);
}
