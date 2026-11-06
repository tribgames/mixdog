//! Attachments sent by reference instead of inline (Node `attachments/attachment-reference.mjs`).
//!
//! A PDF or image the user attached already lives in the content-addressed store. When inlining
//! it would crowd the context window, the message carries a short text part instead: the file's
//! name, size, page count and text-layer status, and the path the model reads it from, so the
//! model pulls in only the pages the request needs. Compaction uses this for the attachments of
//! the latest message when they do not fit, and for every earlier message.

use std::sync::Arc;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use mixdog_agent::compact::estimate::MediaMeter;
use mixdog_agent::compact::fresh::AttachmentSeam;
use mixdog_agent::message::AgentMessage;
use mixdog_core_api::domain::provider::{BinarySource, Content, ContentPart, DocumentSource, ImageSource, Role};

use super::media::{inline_file_kind, AttachmentFacts, FileKind};

/// Up to this many pages per read call; the read tool enforces the same cap.
pub const READ_PDF_MAX_PAGES_PER_CALL: u64 = 20;

/// A payload written to the store.
#[derive(Clone, PartialEq, Debug)]
pub struct StoredFile {
    pub reference: String,
    pub size_bytes: u64,
}

/// The attachment store's files: where the bytes live and under what name.
pub trait AttachmentFiles: Send + Sync {
    /// `storeInlineImagePart` / `storeInlineDocumentPart`: writes an inline payload so it gets a
    /// path too; `None` when the store cannot take it.
    fn store_inline(&self, base64: &str, mime_type: &str, filename: &str) -> Option<StoredFile>;
    /// `namedAttachmentFile`: the copy under the file's own name and extension, for a file
    /// chooser or an office tool.
    fn named_file(&self, reference: &str, filename: &str, mime_type: &str) -> Result<String, ()>;
    /// `attachmentFilePath`: the bare blob path, the fallback when the named copy cannot be made.
    fn blob_path(&self, reference: &str) -> String;
}

/// `sizeLabel`.
fn size_label(bytes: u64) -> String {
    const MB: f64 = 1024.0 * 1024.0;
    if bytes as f64 >= MB {
        format!("{:.1} MB", bytes as f64 / MB)
    } else if bytes >= 1024 {
        format!("{} KB", ((bytes as f64 / 1024.0).round() as u64).max(1))
    } else {
        format!("{bytes} bytes")
    }
}

/// `quotedName`.
fn quoted_name(name: &str, fallback: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("");
    let cleaned: String = base.chars().filter(|c| !matches!(c, '"' | '\r' | '\n')).collect();
    let base = mixdog_js::js_trim(&cleaned);
    format!("\"{}\"", if base.is_empty() { fallback } else { base })
}

/// `textLayerLabel`: how much of a PDF reads as text, in words the model can act on.
fn text_layer_label(pages: u64, text_pages: Option<u64>) -> String {
    match text_pages {
        Some(with_text) if pages > 0 => {
            if with_text == 0 {
                "no text layer (scanned pages)".to_owned()
            } else if with_text >= pages {
                "text layer on every page".to_owned()
            } else {
                format!("text layer on {with_text} of {pages} pages; the rest are scanned")
            }
        }
        _ => "text layer not checked".to_owned(),
    }
}

struct Info {
    filename: String,
    mime_type: String,
    size_bytes: u64,
    page_count: u64,
    text_pages: Option<u64>,
}

/// `pdfReferenceText`.
fn pdf_reference_text(info: &Info, path: &str) -> String {
    let plural = if info.page_count == 1 { "" } else { "s" };
    let pages = if info.page_count > 0 { format!("{} page{plural}, ", info.page_count) } else { String::new() };
    [
        format!(
            "[Attachment kept on disk, not inlined: {} (PDF, {pages}{}, {})",
            quoted_name(&info.filename, "document.pdf"),
            text_layer_label(info.page_count, info.text_pages),
            size_label(info.size_bytes)
        ),
        format!("Path: {path}"),
        format!(
            "Read only what the request needs: read this path with pages, e.g. pages=\"1-5\" (up to {READ_PDF_MAX_PAGES_PER_CALL} pages per call). Pages with a text layer come back as text; scanned pages come back as page images, or as OCR text when the model is text-only.]"
        ),
    ]
    .join("\n")
}

/// `imageReferenceText`.
fn image_reference_text(info: &Info, path: &str) -> String {
    let mime = if info.mime_type.is_empty() { "image" } else { info.mime_type.as_str() };
    [
        format!("[Image kept on disk, not inlined: {} ({mime}, {})", quoted_name(&info.filename, "image"), size_label(info.size_bytes)),
        format!("Path: {path}"),
        "View it with read on this path when the request needs it.]".to_owned(),
    ]
    .join("\n")
}

fn is_image_mime(mime: &str) -> bool {
    mixdog_js::js_trim(mime).to_lowercase().starts_with("image/")
}

fn mime_or_pdf(mime: &str) -> String {
    let m = mixdog_js::js_trim(mime).to_lowercase();
    if m.is_empty() { "application/pdf".to_owned() } else { m }
}

/// `isReferencableMediaPart`.
pub fn is_referencable(part: &ContentPart) -> bool {
    match part {
        ContentPart::Image(ImageSource::Base64 { .. }) => true,
        ContentPart::Image(_) | ContentPart::Text(_) => false,
        ContentPart::Document { source, .. } => matches!(source, DocumentSource::Base64 { .. }),
        ContentPart::File { source, mime_type, filename, text: None } => match source {
            BinarySource::AttachmentRef(_) => is_image_mime(mime_type) || inline_file_kind(&mime_or_pdf(mime_type), "", filename.as_deref().unwrap_or("")) == FileKind::Pdf,
            BinarySource::Base64(data) => inline_file_kind(&mime_or_pdf(mime_type), data, filename.as_deref().unwrap_or("")) == FileKind::Pdf,
        },
        ContentPart::File { .. } => false,
    }
}

/// The compaction seam over the attachment store.
pub struct ReferencedMedia {
    files: Arc<dyn AttachmentFiles>,
    facts: Arc<dyn AttachmentFacts>,
    meter: Arc<dyn MediaMeter>,
}

impl ReferencedMedia {
    pub fn new(files: Arc<dyn AttachmentFiles>, facts: Arc<dyn AttachmentFacts>, meter: Arc<dyn MediaMeter>) -> Self {
        Self { files, facts, meter }
    }

    /// `mediaPartToReference`: the reference text part standing for one media part, or `None` when
    /// the part cannot travel by reference (a URL image, a non-PDF file, a store failure).
    pub fn reference_part(&self, part: &ContentPart) -> Option<ContentPart> {
        if !is_referencable(part) {
            return None;
        }
        // The stored form: (reference, size, mime, filename, is_image).
        let (reference, size, mime, filename, image) = match part {
            ContentPart::Image(ImageSource::Base64 { data, mime_type }) => {
                let stored = self.files.store_inline(data, mime_type, "")?;
                (stored.reference, stored.size_bytes, mime_type.clone(), String::new(), true)
            }
            ContentPart::File { source: BinarySource::AttachmentRef(r), mime_type, filename, .. } => {
                let size = self.facts.facts(r).map_or(0, |f| f.size_bytes);
                let image = is_image_mime(mime_type);
                (r.clone(), size, mime_type.clone(), filename.clone().unwrap_or_default(), image)
            }
            ContentPart::File { source: BinarySource::Base64(data), mime_type, filename, .. } => {
                let name = filename.clone().unwrap_or_default();
                let stored = self.files.store_inline(data, &mime_or_pdf(mime_type), &name)?;
                (stored.reference, stored.size_bytes, mime_or_pdf(mime_type), name, false)
            }
            ContentPart::Document { source: DocumentSource::Base64 { media_type, data }, title } => {
                let name = title.clone().unwrap_or_default();
                let stored = self.files.store_inline(data, &mime_or_pdf(media_type), &name)?;
                (stored.reference, stored.size_bytes, mime_or_pdf(media_type), name, false)
            }
            _ => return None,
        };
        // A file reaches here as a PDF only: the stored mime decides, never the bytes.
        if !image && inline_file_kind(&mime, "", "") != FileKind::Pdf {
            return None;
        }
        let facts = self.facts.facts(&reference).unwrap_or_default();
        let mime_type = if mime.is_empty() { if image { "image/png".to_owned() } else { "application/pdf".to_owned() } } else { mime };
        let info = Info {
            filename,
            mime_type: mime_type.clone(),
            size_bytes: if size > 0 { size } else { facts.size_bytes },
            page_count: if image { 0 } else { facts.page_count.unwrap_or(0) },
            text_pages: if image { None } else { facts.text_pages },
        };
        // The named copy is the file the model hands to a file chooser or an office tool; the bare
        // blob path is only the fallback when the copy cannot be made.
        let path = self.files.named_file(&reference, &info.filename, &mime_type).unwrap_or_else(|()| self.files.blob_path(&reference));
        Some(ContentPart::Text(if image { image_reference_text(&info, &path) } else { pdf_reference_text(&info, &path) }))
    }
}

impl AttachmentSeam for ReferencedMedia {
    /// `referenceMessageMedia`: a user message with every referencable media part of its own
    /// content replaced by its reference text (other roles and tool results stay as they are).
    fn reference_media(&self, message: &AgentMessage) -> AgentMessage {
        if message.role() != Role::User {
            return message.clone();
        }
        let Content::Parts(parts) = &message.message.content else { return message.clone() };
        let mut changed = false;
        let next: Vec<ContentPart> = parts
            .iter()
            .map(|part| match self.reference_part(part) {
                Some(reference) => {
                    changed = true;
                    reference
                }
                None => part.clone(),
            })
            .collect();
        if !changed {
            return message.clone();
        }
        let mut out = message.clone();
        out.message.content = Content::Parts(next);
        out
    }

    /// `messageHasReferencableMedia`.
    fn has_referencable_media(&self, message: &AgentMessage) -> bool {
        matches!(&message.message.content, Content::Parts(parts) if parts.iter().any(is_referencable))
    }

    /// `messageAttachmentBreakdown(message).tokens`: the image and document allowances.
    fn attachment_tokens(&self, message: &AgentMessage) -> u64 {
        match &message.message.content {
            Content::Parts(parts) => parts.iter().filter(|p| !matches!(p, ContentPart::Text(_))).map(|p| self.meter.part(p).tokens).sum(),
            Content::Text(_) => 0,
        }
    }
}

#[cfg(test)]
mod tests {
    use mixdog_agent::compact::estimate::PartMeter;
    use serde_json::Value;

    use super::*;
    use crate::run_host::media::StoredFacts;

    /// A store that names a payload by its filename and finds the path Node's run gave it.
    struct Files(Value);
    impl AttachmentFiles for Files {
        fn store_inline(&self, base64: &str, _: &str, filename: &str) -> Option<StoredFile> {
            Some(StoredFile { reference: filename.to_owned(), size_bytes: STANDARD.decode(base64).unwrap().len() as u64 })
        }
        fn named_file(&self, reference: &str, _: &str, _: &str) -> Result<String, ()> {
            let key = if reference.is_empty() { "pdf_unchecked" } else { reference };
            let case = self.0.as_object().unwrap().iter().find(|(_, v)| v["text"].as_str().is_some_and(|t| t.contains(&format!("\"{}\"", key))) || false);
            let text = case.map_or("", |(_, v)| v["text"].as_str().unwrap());
            text.lines().find_map(|l| l.strip_prefix("Path: ")).map(str::to_owned).ok_or(())
        }
        fn blob_path(&self, reference: &str) -> String {
            format!("blob:{reference}")
        }
    }

    struct Facts;
    impl AttachmentFacts for Facts {
        fn facts(&self, reference: &str) -> Option<StoredFacts> {
            let (pages, text) = match reference {
                "C:\\docs\\Q1 \"report\".pdf" => (3, 2),
                "one.pdf" => (1, 1),
                "scan.pdf" => (12, 0),
                _ => return None,
            };
            Some(StoredFacts { page_count: Some(pages), text_pages: Some(text), ..Default::default() })
        }
    }

    struct Meter;
    impl MediaMeter for Meter {
        fn part(&self, part: &ContentPart) -> PartMeter {
            PartMeter { text: String::new(), tokens: if matches!(part, ContentPart::Text(_)) { 0 } else { 100 } }
        }
    }

    fn seam(golden: &Value) -> ReferencedMedia {
        ReferencedMedia::new(Arc::new(Files(golden.clone())), Arc::new(Facts), Arc::new(Meter))
    }

    fn b64(text: &str) -> String {
        STANDARD.encode(text)
    }

    /// Node's `mediaPartToReference` text on eight parts; the path line is the one the store gave.
    #[test]
    fn reference_texts_follow_node() {
        let golden: Value = serde_json::from_str(include_str!("golden/attachment_reference.json")).unwrap();
        let pdf = b64(&format!("%PDF-1.4 {}", "x".repeat(2000)));
        let file = |name: Option<&str>| ContentPart::File {
            source: BinarySource::Base64(pdf.clone()),
            mime_type: "application/pdf".into(),
            filename: name.map(str::to_owned),
            text: None,
        };
        let png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
        let cases: Vec<(&str, ContentPart)> = vec![
            ("pdf_pages", file(Some("C:\\docs\\Q1 \"report\".pdf"))),
            ("pdf_one_page_all_text", file(Some("one.pdf"))),
            ("pdf_scanned", file(Some("scan.pdf"))),
            ("pdf_unchecked", file(None)),
            ("pdf_document", ContentPart::Document { source: DocumentSource::Base64 { media_type: "application/pdf".into(), data: pdf.clone() }, title: Some("Doc.pdf".into()) }),
            ("text_file", ContentPart::File { source: BinarySource::Base64(b64("hello")), mime_type: "text/plain".into(), filename: Some("a.txt".into()), text: None }),
            ("url_image", ContentPart::Image(ImageSource::Url("http://x/y.png".into()))),
        ];
        let s = seam(&golden);
        for (id, part) in &cases {
            let want = &golden[*id];
            assert_eq!(is_referencable(part), want["referencable"].as_bool().unwrap(), "{id} referencable");
            let got = s.reference_part(part);
            match want["text"].as_str().filter(|t| !t.is_empty()) {
                Some(text) => assert_eq!(got, Some(ContentPart::Text(text.to_owned())), "{id}"),
                None => assert_eq!(got, None, "{id}"),
            }
        }
        // The image part: Node named it by file name, which an inline Rust image part does not carry.
        let image = s.reference_part(&ContentPart::Image(ImageSource::Base64 { data: png.into(), mime_type: "image/png".into() })).unwrap();
        let ContentPart::Text(text) = image else { panic!("text") };
        assert!(text.starts_with("[Image kept on disk, not inlined: \"image\" (image/png, 70 bytes)\n"), "{text}");
    }

    #[test]
    fn only_a_user_messages_media_is_referenced_and_tokens_count_media_only() {
        let golden: Value = serde_json::from_str(include_str!("golden/attachment_reference.json")).unwrap();
        let s = seam(&golden);
        let pdf = ContentPart::File { source: BinarySource::Base64(b64("%PDF-1.4 abc")), mime_type: "application/pdf".into(), filename: Some("one.pdf".into()), text: None };
        let mut user = AgentMessage::user("see");
        user.message.content = Content::Parts(vec![ContentPart::Text("see".into()), pdf.clone()]);
        assert!(s.has_referencable_media(&user));
        assert_eq!(s.attachment_tokens(&user), 100);
        let referenced = s.reference_media(&user);
        let Content::Parts(parts) = &referenced.message.content else { panic!("parts") };
        assert_eq!(parts[0], ContentPart::Text("see".into()));
        assert!(matches!(&parts[1], ContentPart::Text(t) if t.starts_with("[Attachment kept on disk, not inlined: \"one.pdf\" (PDF, 1 page, text layer on every page, 12 bytes)")));
        assert!(!s.has_referencable_media(&referenced));
        // A tool result is left as it is.
        let mut tool = AgentMessage::tool_text("c1", "x", mixdog_agent::message::ToolKind::Normal);
        tool.message.content = Content::Parts(vec![pdf]);
        assert_eq!(s.reference_media(&tool), tool);
    }
}
