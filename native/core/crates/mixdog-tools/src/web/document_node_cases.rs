//! Node's document extraction cases (`fixtures/document-content-cases`, `record-document-content-cases.mjs`): each
//! recorded call through `extract_document`, the whole page (the url is the caller's, as Node echoes it) or the error's
//! code and message against Node's.
#![allow(clippy::disallowed_methods, reason = "test fixture loading")]

use serde_json::Value;
use serde_json::json;
use url::Url;

use super::extract::extract_document;

#[test]
fn every_recorded_document_extraction_is_nodes() {
    let path = format!("{}/../../fixtures/document-content-cases/golden.json", env!("CARGO_MANIFEST_DIR"));
    let golden: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let cases = golden["cases"].as_array().unwrap();
    let mut failures = Vec::new();
    for case in cases {
        for call in case["recorded"].as_array().unwrap() {
            let (url, body, kind) = (call["url"].as_str().unwrap(), call["body"].as_str().unwrap(), call["type"].as_str().unwrap());
            let mut got = json!({ "url": url, "body": body, "type": kind });
            match extract_document(&Url::parse(url).unwrap(), body, kind) {
                Ok(page) => {
                    got["page"] = json!({
                        "url": url,
                        "title": page.title,
                        "content": page.content,
                        "excerpt": page.excerpt,
                        "extractor": page.extractor,
                        "format": page.format,
                        "contentType": page.content_type,
                    });
                }
                Err(error) => got["error"] = json!({ "code": error.code(), "message": error.message }),
            }
            if &got != call {
                failures.push(format!("{}:\n  want {call}\n  got  {got}", case["case"]));
            }
        }
    }
    assert!(failures.is_empty(), "{} call(s) differ:\n{}", failures.len(), failures.join("\n"));
    assert_eq!(cases.len(), 5, "every case of the test file is recorded");
}
