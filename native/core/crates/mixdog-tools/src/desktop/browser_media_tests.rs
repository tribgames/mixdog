//! `browser_output` over a `downloads {attach:true}` reply and a screenshot: the parts each kind of file becomes and the sentence the
//! reply says about it. The type of each file is the engine's own (`download_mime_type`), as it travels in a real reply.

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use mixdog_browser_engine::reply::downloads_text::download_mime_type;
use mixdog_core_api::domain::tool::ImageData;
use mixdog_core_api::domain::tool::ToolPart;
use serde_json::Value;
use serde_json::json;

use super::host::browser_output;

fn reply_text(name: &str) -> String {
    format!("Downloads this session (newest first):\n- d1 {name} completed C:/tmp/{name}\n\nAttached download d1 as {name}.")
}

/// The parts of the tool output the engine's reply for an attach of `name` with `bytes` becomes.
fn attach(name: &str, bytes: &[u8]) -> Vec<ToolPart> {
    let file = json!({"mimeType": download_mime_type(name, ""), "name": name, "data": STANDARD.encode(bytes)});
    browser_output(&json!({"text": reply_text(name), "file": file})).expect("an attach").parts
}

fn file_part(name: &str, mime: &str, bytes: &[u8]) -> ToolPart {
    ToolPart::File { mime: mime.to_owned(), data: bytes.to_vec(), filename: Some(name.to_owned()) }
}

#[test]
fn office_files_and_structured_text_reach_the_model_as_file_parts_and_the_reply_stands() {
    let docx = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    let xlsx = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    for (name, mime, bytes) in [("a.docx", docx, &b"PK\x03\x04docx"[..]), ("a.xlsx", xlsx, b"PK\x03\x04xlsx"), ("a.yaml", "application/yaml", b"k: v\n")] {
        assert_eq!(attach(name, bytes), vec![ToolPart::Text(reply_text(name)), file_part(name, mime, bytes)], "{name}");
    }
}

#[test]
fn gif_and_webp_are_image_parts() {
    for (name, mime) in [("a.gif", "image/gif"), ("a.webp", "image/webp")] {
        let parts = attach(name, b"pixels");
        assert_eq!(parts[0], ToolPart::Text(reply_text(name)));
        assert_eq!(parts[1], ToolPart::Image { mime: mime.to_owned(), data: ImageData::Bytes(b"pixels".to_vec()), width: None, height: None }, "{name}");
    }
}

#[test]
fn a_pdf_is_a_document_whatever_it_is_labelled() {
    // `.bin` has no type of its own, so it is labelled application/octet-stream; the bytes decide.
    assert_eq!(download_mime_type("report.bin", ""), "application/octet-stream");
    let parts = attach("report.bin", b"%PDF-1.7 body");
    assert_eq!(parts, vec![ToolPart::Text(reply_text("report.bin")), ToolPart::Document { mime: "application/pdf".into(), data: b"%PDF-1.7 body".to_vec() }]);
}

#[test]
fn a_binary_stays_on_disk_and_the_reply_no_longer_says_it_was_attached() {
    for (name, mime, bytes) in [("a.zip", "application/zip", &b"PK\x03\x04zip"[..]), ("blob.bin", "application/octet-stream", &[0u8, 1, 2, 3][..])] {
        let parts = attach(name, bytes);
        let ToolPart::Text(text) = &parts[0] else { panic!("{parts:?}") };
        assert!(!text.contains("Attached download"), "{text}");
        assert!(text.ends_with(&format!("\n\nDownload d1 ({name}) was not attached inline.")), "{text}");
        assert!(text.starts_with("Downloads this session (newest first):\n- d1 "), "the list stays: {text}");
        assert_eq!(
            parts[1..],
            [ToolPart::Text(format!(
                "Download {name} ({mime}, {} bytes) is binary and stays on disk; open it from the path listed above with read.",
                bytes.len()
            ))]
        );
    }
}

#[test]
fn a_file_the_bridge_would_have_refused_is_refused() {
    for file in [
        json!({"mimeType": "text/csv; charset=utf-8", "name": "a.csv", "data": "YSxi"}),
        json!({"mimeType": "text/csv", "name": "a/b.csv", "data": "YSxi"}),
        json!({"mimeType": "text/csv", "name": "a.csv", "data": "***"}),
    ] {
        let error = browser_output(&json!({"text": "x", "file": file})).expect_err("refused");
        assert_eq!(error.message_for_model, "Error: browser bridge returned an invalid file");
    }
}

fn image_reply(bytes: usize) -> Value {
    json!({"text": "shot", "image": {"mimeType": "image/png", "data": STANDARD.encode(vec![0u8; bytes])}})
}

#[test]
fn an_image_of_thirty_mebibytes_is_accepted_and_one_over_the_limit_is_not() {
    let parts = browser_output(&image_reply(30 * 1024 * 1024)).expect("accepted").parts;
    assert!(matches!(&parts[1], ToolPart::Image { data: ImageData::Bytes(bytes), .. } if bytes.len() == 30 * 1024 * 1024));
    let error = browser_output(&image_reply(48 * 1024 * 1024 + 1)).expect_err("refused");
    assert_eq!(error.message_for_model, "Error: browser bridge returned an invalid image");
}
