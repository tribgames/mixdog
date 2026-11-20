//! What a connector's tool result becomes for the model: embedded files, the success flag, normalization of content parts, the
//! output cap, and which calls count as outbound.

use base64::Engine;
use mixdog_core_api::domain::tool::ToolPart;
use mixdog_mcp::result::OutputPolicy;
use mixdog_mcp::result::Part;
use mixdog_mcp::result::Spiller;
use mixdog_mcp::result::cap_parts;
use mixdog_mcp::result::map_call_result;
use mixdog_mcp::result::normalize_parts;
use serde_json::Value;
use serde_json::json;

fn spiller() -> (tempfile::TempDir, Spiller) {
    let dir = tempfile::tempdir().unwrap();
    let spiller = Spiller::new(dir.path().to_path_buf(), mixdog_rt::testing::tokens().durability_io);
    (dir, spiller)
}

/// An embedded resource blob of a readable kind is the inline file Node's `mcpFilePart` handed the loop (`{ type: 'file', data,
/// mimeType, filename }`), as `ToolPart::File` (which the production renderer makes the part an attachment is), not JSON text of it.
/// A binary one is saved to disk and named. The kind is `mixdog_ai::providers::file_text::inline_file_kind`.
#[tokio::test]
async fn an_embedded_resource_file_is_a_file_part_and_a_binary_is_saved() {
    let (_dir, spiller) = spiller();
    let blob = |bytes: &[u8], mime: &str, uri: &str| json!({ "content": [{ "type": "resource", "resource": { "uri": uri, "mimeType": mime, "blob": base64::engine::general_purpose::STANDARD.encode(bytes) } }] });
    let docx = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    for (bytes, mime, uri, filename) in [
        (&b"a,b"[..], "text/csv", "file:///d/a.csv", "a.csv"),
        (b"PKdocx", docx, "file:///d/a.docx", "a.docx"),
        (b"%PDF-1.7 body", "application/octet-stream", "file:///d/scan.bin", "scan.bin"),
    ] {
        let output = map_call_result(&blob(bytes, mime, uri), OutputPolicy::default(), &spiller).await.unwrap();
        assert_eq!(output.parts, vec![ToolPart::File { mime: mime.to_owned(), data: bytes.to_vec(), filename: Some(filename.to_owned()) }], "{filename}");
    }
    let output = map_call_result(&blob(b"PK\x03\x04zip", "application/zip", "file:///d/a.zip"), OutputPolicy::default(), &spiller).await.unwrap();
    let [ToolPart::Text(text)] = &output.parts[..] else { panic!("{:?}", output.parts) };
    assert!(text.starts_with("[MCP resource a.zip (application/zip, 7 bytes) saved to "), "{text}");
}

/// A result the server did not mark `isError` is declared a success (`explicitSuccess`), whatever its text starts with; one
/// it marked is the call's error, not an output.
#[tokio::test]
async fn a_result_without_is_error_is_an_explicit_success() {
    let (_dir, spiller) = spiller();
    let ok = json!({ "content": [{ "type": "text", "text": "Error: only wording" }] });
    let output = map_call_result(&ok, OutputPolicy::default(), &spiller).await.unwrap();
    assert!(output.explicit_success);
    let marked = json!({ "isError": false, "content": [{ "type": "text", "text": "Error: only wording" }] });
    assert!(map_call_result(&marked, OutputPolicy::default(), &spiller).await.unwrap().explicit_success);
    let failed = json!({ "isError": true, "content": [{ "type": "text", "text": "bad" }] });
    assert!(map_call_result(&failed, OutputPolicy::default(), &spiller).await.is_err());
}

fn text_of(result: Value) -> Vec<Part> {
    vec![Part::Text(result.as_str().unwrap().to_owned())]
}

#[tokio::test]
async fn text_blocks_without_media_become_one_text_joined_by_newlines() {
    let (_dir, spiller) = spiller();
    let two = json!({ "content": [{ "type": "text", "text": "a" }, { "type": "text", "text": "b" }] });
    assert_eq!(normalize_parts(&two, &spiller).await, text_of(json!("a\nb")));
    assert_eq!(normalize_parts(&json!({ "content": "plain" }), &spiller).await, text_of(json!("plain")));
    assert_eq!(normalize_parts(&json!({}), &spiller).await, text_of(json!("")), "no content is an empty text");
    assert_eq!(normalize_parts(&json!({ "content": [] }), &spiller).await, text_of(json!("")));
}

#[tokio::test]
async fn an_image_block_keeps_its_place_among_the_text_blocks() {
    let (_dir, spiller) = spiller();
    let data = base64::engine::general_purpose::STANDARD.encode(b"png-bytes");
    let result = json!({ "content": [{ "type": "text", "text": "before" }, { "type": "image", "mimeType": "image/png", "data": data }, { "type": "text", "text": "after" }] });
    assert_eq!(
        normalize_parts(&result, &spiller).await,
        vec![Part::Text("before".into()), Part::Image { mime: "image/png".into(), bytes: b"png-bytes".to_vec() }, Part::Text("after".into())]
    );
}

#[tokio::test]
async fn a_reported_error_without_media_is_the_error_text_prefixed_once() {
    let (_dir, spiller) = spiller();
    let failed = |text: &str| json!({ "isError": true, "content": [{ "type": "text", "text": text }] });
    assert_eq!(map_call_result(&failed("bad"), OutputPolicy::default(), &spiller).await.unwrap_err().text, "Error: bad");
    assert_eq!(map_call_result(&failed("Error: bad"), OutputPolicy::default(), &spiller).await.unwrap_err().text, "Error: bad");
    let structured = json!({ "isError": true, "content": [{ "type": "text", "text": "bad" }], "structuredContent": { "code": 7 } });
    assert_eq!(map_call_result(&structured, OutputPolicy::default(), &spiller).await.unwrap_err().data, Some(json!({ "code": 7 })));
}

#[tokio::test]
async fn a_reported_error_with_an_image_stays_a_result_whose_first_text_carries_the_prefix() {
    let (_dir, spiller) = spiller();
    let data = base64::engine::general_purpose::STANDARD.encode(b"x");
    let with_text = json!({ "isError": true, "content": [{ "type": "text", "text": "bad" }, { "type": "image", "mimeType": "image/png", "data": data }] });
    let output = map_call_result(&with_text, OutputPolicy::default(), &spiller).await.unwrap();
    assert!(matches!(&output.parts[0], ToolPart::Text(text) if text == "Error: bad"), "{:?}", output.parts);
    assert_eq!(output.parts.len(), 2);
    assert!(!output.explicit_success);
    let image_first = json!({ "isError": true, "content": [{ "type": "image", "mimeType": "image/png", "data": data }] });
    let output = map_call_result(&image_first, OutputPolicy::default(), &spiller).await.unwrap();
    assert!(matches!(&output.parts[0], ToolPart::Text(text) if text == "Error:"), "{:?}", output.parts);
}

fn rows_of(count: usize, width: usize) -> String {
    vec!["x".repeat(width); count].join("\n")
}

#[tokio::test]
async fn a_text_over_two_thousand_lines_keeps_its_first_1200_and_last_400_lines_and_says_where_the_rest_went() {
    let (_dir, spiller) = spiller();
    let text = rows_of(2500, 9);
    let (capped, note) = cap_parts(vec![Part::Text(text.clone())], OutputPolicy::default(), &spiller).await;
    let [Part::Text(shown)] = &capped[..] else { panic!("{capped:?}") };
    let marker = "[output capped at 2000 lines; lines 1201-2100 of 2500 omitted (24 KB file); offset:1201 for more]";
    let head = rows_of(1200, 9);
    let tail = rows_of(400, 9);
    assert!(shown.starts_with(&format!("{head}\n{marker}\n{tail}\n\n... [full output spilled to ")), "{}", &shown[shown.len().min(10_800)..]);
    assert!(shown.ends_with("] ..."));
    let note = note.expect("a cut says so");
    assert_eq!(note.total, text.len() as u64);
    assert_eq!(note.next_offset, Some(1201));
    // The omitted text is in the file the note names.
    let full = std::fs::read_to_string(note.full_path.expect("the full text is kept").as_path()).unwrap();
    assert_eq!(full, text);
}

#[tokio::test]
async fn a_text_over_the_byte_limit_is_cut_by_bytes_when_it_has_lines_to_spare() {
    let (_dir, spiller) = spiller();
    let (capped, note) = cap_parts(vec![Part::Text(rows_of(1700, 39))], OutputPolicy::default(), &spiller).await;
    let [Part::Text(shown)] = &capped[..] else { panic!("{capped:?}") };
    assert!(shown.contains("[output capped at 50 KB; lines 1201-1300 of 1700 omitted (66 KB file); offset:1201 for more]"), "{shown}");
    assert!(note.is_some());
}

#[tokio::test]
async fn a_text_within_both_limits_and_an_image_pass_through_untouched() {
    let (_dir, spiller) = spiller();
    let parts = vec![Part::Text(rows_of(10, 5)), Part::Image { mime: "image/png".into(), bytes: b"hi".to_vec() }];
    let (capped, note) = cap_parts(parts.clone(), OutputPolicy::default(), &spiller).await;
    assert_eq!(capped, parts);
    assert!(note.is_none());
}

#[tokio::test]
async fn the_cap_counts_only_text_and_leaves_an_image_where_it_was() {
    let (_dir, spiller) = spiller();
    let image = Part::Image { mime: "image/png".into(), bytes: b"hi".to_vec() };
    let (capped, _) = cap_parts(vec![image.clone(), Part::Text(rows_of(2500, 9))], OutputPolicy::default(), &spiller).await;
    assert_eq!(capped.len(), 2);
    assert_eq!(capped[0], image);
}
