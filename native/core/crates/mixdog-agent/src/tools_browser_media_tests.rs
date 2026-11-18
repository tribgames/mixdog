//! A `browser` result with a downloaded file or a screenshot, through the production renderer (`render_output`, which every tool
//! result passes before the model reads it): each kind of file arrives as the part an attached file of that kind is.

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use mixdog_browser_engine::reply::downloads_text::download_mime_type;
use mixdog_core_api::domain::provider::BinarySource;
use mixdog_core_api::domain::provider::Content;
use mixdog_core_api::domain::provider::ContentPart;
use mixdog_core_api::domain::provider::ImageSource;
use mixdog_tools::desktop::host::browser_output;
use serde_json::json;

use super::render_output;

fn reply_text(name: &str) -> String {
    format!("Downloads this session (newest first):\n- d1 {name}\n\nAttached download d1 as {name}.")
}

/// What the model is handed for the engine's reply to `downloads {attach:true}` of `name` holding `bytes`.
fn rendered(name: &str, bytes: &[u8]) -> Content {
    let file = json!({"mimeType": download_mime_type(name, ""), "name": name, "data": STANDARD.encode(bytes)});
    render_output(browser_output(&json!({"text": reply_text(name), "file": file})).expect("an attach").parts)
}

fn inline_file(name: &str, mime: &str, bytes: &[u8]) -> ContentPart {
    ContentPart::File { source: BinarySource::Base64(STANDARD.encode(bytes)), mime_type: mime.to_owned(), filename: Some(name.to_owned()), text: None }
}

#[test]
fn a_csv_and_a_docx_download_are_the_inline_file_parts_an_attachment_is() {
    let docx = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    for (name, mime, bytes) in [("a.csv", "text/csv", &b"a,b"[..]), ("a.docx", docx, b"PKdocx"), ("a.yaml", "application/yaml", b"k: v")] {
        let Content::Parts(parts) = rendered(name, bytes) else { panic!("{name}: parts") };
        // Not a JSON text of base64: the same part a file attached to a message is, which the media lowering turns into the file's
        // text (a text type) or its extraction (an Office file).
        assert_eq!(parts, vec![ContentPart::Text(reply_text(name), None), inline_file(name, mime, bytes)], "{name}");
    }
}

#[test]
fn a_pdf_and_an_image_download_arrive_as_before() {
    let Content::Parts(pdf) = rendered("report.bin", b"%PDF-1.7 body") else { panic!("parts") };
    assert_eq!(
        pdf[1],
        ContentPart::File { source: BinarySource::Base64(STANDARD.encode(b"%PDF-1.7 body")), mime_type: "application/pdf".into(), filename: None, text: None }
    );
    let Content::Parts(gif) = rendered("a.gif", b"pixels") else { panic!("parts") };
    assert_eq!(gif[1], ContentPart::Image(ImageSource::Base64 { data: STANDARD.encode(b"pixels"), mime_type: "image/gif".into(), width: None, height: None }));
}

#[test]
fn a_binary_download_is_text_naming_the_file_on_disk() {
    let Content::Text(text) = rendered("a.zip", b"PK\x03\x04zip") else { panic!("a binary adds no media part") };
    assert!(text.contains("\n\nDownload d1 (a.zip) was not attached inline.\n"), "{text}");
    assert!(text.ends_with("Download a.zip (application/zip, 7 bytes) is binary and stays on disk; open it from the path listed above with read."), "{text}");
    assert!(!text.contains("Attached download"), "{text}");
}
