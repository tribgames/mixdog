//! Small direct pdf.js recordings for lazy encryption failures and non-number Rotate.
use mixdog_pdf::document::{Document, OpenOptions, wrap_reason};
use mixdog_pdf::{Obj, PdfError};
use serde_json::Value;

fn hex(s: &str) -> Vec<u8> {
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
}
fn json(value: &Obj) -> Value {
    match value {
        Obj::Null => Value::Null,
        Obj::Num(n) if n.fract() == 0.0 && n.abs() < 9_007_199_254_740_992.0 => {
            serde_json::json!(*n as i64)
        }
        Obj::Num(n) => serde_json::json!(n),
        Obj::Bool(b) => serde_json::json!(b),
        Obj::Str(s) => Value::String(s.iter().map(|&b| char::from(b)).collect()),
        Obj::Array(a) => Value::Array(a.iter().map(json).collect()),
        other => panic!("unexpected observable rotation {other:?}"),
    }
}
fn error(actual: PdfError, row: &Value) {
    let actual = wrap_reason(&actual);
    assert_eq!(serde_json::json!(actual.code), row["error"]["code"], "{}", row["name"]);
    assert_eq!(actual.name, row["error"]["name"].as_str().unwrap(), "{}", row["name"]);
    assert_eq!(actual.message, row["error"]["message"].as_str().unwrap(), "{}", row["name"]);
}
#[test]
fn original_node_document_followup() {
    let fixture: Value = serde_json::from_str(include_str!("document_followup.json")).unwrap();
    let cases = fixture["cases"].as_array().unwrap();
    assert_eq!(cases.len(), 39);
    for row in cases {
        let options = OpenOptions { password: row["password"].as_str().map(str::to_owned), ..OpenOptions::default() };
        let doc = match Document::open(hex(row["hex"].as_str().unwrap()), &options) {
            Ok(doc) => {
                assert_eq!(row["open"], true, "{} unexpectedly opened", row["name"]);
                doc
            }
            Err(e) => {
                assert!(row["open"].is_null(), "{} failed at open: {e}", row["name"]);
                error(e, row);
                continue;
            }
        };
        assert_eq!(doc.num_pages(), row["numPages"].as_i64().unwrap());
        let page = match doc.page(0) {
            Err(e) => {
                assert!(row["page"].is_null(), "{}", row["name"]);
                error(e, row);
                continue;
            }
            Ok(page) => {
                assert_eq!(row["page"], true, "{}", row["name"]);
                page
            }
        };
        assert_eq!(json(&page.rotate), row["rotate"], "{}", row["name"]);
        let view = page.viewport(1.0);
        assert_eq!(json(&view.rotation), row["viewport"]["rotation"], "{}", row["name"]);
        assert_eq!(view.width, row["viewport"]["width"].as_f64().unwrap());
        assert_eq!(view.height, row["viewport"]["height"].as_f64().unwrap());
        for (a, b) in view.transform.iter().zip(row["viewport"]["transform"].as_array().unwrap()) {
            assert_eq!(*a, b.as_f64().unwrap());
        }
        if row["content"] == true {
            match page.content(&doc) {
                Err(e) => error(e, row),
                Ok(bytes) => {
                    assert!(row["error"].is_null(), "{} unexpectedly read content", row["name"]);
                    if row["name"] == "consecutive encrypted strings and stream" {
                        let content = doc.xref().get(&page.dict, "Contents").unwrap();
                        let stream = content.as_stream().unwrap();
                        let first = stream.dict.get_raw("S1").unwrap().as_str().unwrap();
                        let second = stream.dict.get_raw("S2").unwrap().as_str().unwrap();
                        assert_eq!(first, second, "each string starts with a fresh AES state");
                        assert_eq!(mixdog_pdf_codec::flate::inflate(first, 4096).unwrap(), bytes, "the same-object stream also starts with a fresh AES state");
                    }
                    if row["text"] == "" {
                        assert!(bytes.is_empty(), "{}", row["name"]);
                    } else if row["text"].as_str().is_some_and(|s| s.starts_with("Encrypted content line one")) {
                        assert!(bytes.windows(b"Encrypted content line one".len()).any(|w| w == b"Encrypted content line one"));
                    } else {
                        assert!(bytes.windows(5).any(|w| w == b"Plain"));
                    }
                }
            }
        }
    }
}

#[test]
fn invalid_explicit_viewport_rotation_is_an_error() {
    assert!(mixdog_pdf::page::Viewport::new([0., 0., 100., 200.], 1., 1., Obj::Num(45.), 0., 0.).is_err());
}
