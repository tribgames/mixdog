//! What Node's `extractDocument` answers for the documents its own test asserts (`fixtures/tools-untested/web-extract.json`,
//! `record-tools-untested.mjs`), replayed whole and in the recorded order.

use super::extract::extract_document;
use serde_json::Value;
use url::Url;

/// Node's `formatResponse('web_search', …)` over the payloads its test builds (and their neighbours), read back
/// the way the core reads a stored Node payload.
#[test]
fn search_results_are_printed_as_node_prints_them() {
    let doc: Value = serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/tools-untested/web-search-format.json")).unwrap();
    let mut failures = Vec::new();
    for case in doc["cases"].as_array().unwrap() {
        assert_eq!(case["bareFormSameText"], true, "the recording's two input forms must agree: {}", case["response"]);
        let stored = serde_json::json!({ "response": case["response"] });
        let payload = super::search::SearchPayload::from_node(&stored).expect("a stored payload");
        let got = super::search::format_results(&payload);
        if got != case["text"].as_str().unwrap() {
            failures.push(format!("{}:\n  Node {:?}\n  here {got:?}", case["response"], case["text"]));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn documents_are_extracted_as_node_extracts_them() {
    let doc: Value = serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/tools-untested/web-extract.json")).unwrap();
    let mut failures = Vec::new();
    for case in doc["cases"].as_array().unwrap() {
        let url = Url::parse(case["url"].as_str().unwrap()).unwrap();
        let got = extract_document(&url, case["body"].as_str().unwrap(), case["contentType"].as_str().unwrap());
        let label = format!("{} {}", case["contentType"], case["body"].as_str().unwrap().chars().take(40).collect::<String>());
        match (case.get("errorCode").and_then(Value::as_str), got) {
            (Some(code), Err(error)) if error.code() == code => {}
            (Some(code), other) => failures.push(format!("{label}: Node fails with {code}, here {:?}", other.map(|page| page.content).map_err(|e| e.code()))),
            (None, Err(error)) => failures.push(format!("{label}: Node extracts, here {}", error.code())),
            (None, Ok(page)) => {
                // Node's whole payload; its `url` is the input.
                let here = serde_json::json!({
                    "url": case["url"], "title": page.title, "content": page.content, "excerpt": page.excerpt,
                    "extractor": page.extractor, "format": page.format, "contentType": page.content_type,
                });
                if here != case["page"] {
                    failures.push(format!("{label}:\n  Node {}\n  here {here}", case["page"]));
                }
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
