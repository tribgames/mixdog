//! Attachments sent by reference instead of inline (Node `attachments/attachment-reference.mjs`).
//!
//! A PDF or image the user attached already lives in the content-addressed store. When inlining
//! it would crowd the context window, the message carries a short text part instead: the file's
//! name, size, page count and text-layer status, and the path the model reads it from, so the
//! model pulls in only the pages the request needs. Compaction uses this for the attachments of
//! the latest message when they do not fit, and for every earlier message.

use std::sync::Arc;

use async_trait::async_trait;
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

/// `record.original`: the file as picked, behind a stored converted copy.
#[derive(Clone, PartialEq, Debug)]
pub struct OriginalFile {
    pub attachment_ref: String,
    pub mime_type: Option<String>,
}

/// A reference that names no blob: Node's `attachmentPath` throws a TypeError for it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InvalidReference;

/// The attachment store's files: where the bytes live and under what name.
#[async_trait]
pub trait AttachmentFiles: Send + Sync {
    /// `storeInlineImagePart` / `storeInlineDocumentPart`: writes an inline payload so it gets a
    /// path too; `None` when the store cannot take it.
    async fn store_inline(&self, base64: &str, mime_type: &str, filename: &str) -> Option<StoredFile>;
    /// `namedAttachmentFile`: the copy under the file's own name and extension, for a file
    /// chooser or an office tool.
    ///
    /// `original` is the file as it was picked, when the stored copy is a converted form of it
    /// (`record.original`).
    async fn named_file(&self, reference: &str, filename: &str, mime_type: &str, original: Option<&OriginalFile>) -> Result<String, ()>;
    /// `attachmentFilePath`: the bare blob path, the fallback when the named copy cannot be made.
    /// A reference that names no blob is an error, as it is a throw in Node.
    fn blob_path(&self, reference: &str) -> Result<String, InvalidReference>;
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
        ContentPart::Image(_) | ContentPart::Text(_, _) => false,
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
    pub async fn reference_part(&self, part: &ContentPart) -> Option<ContentPart> {
        self.reference_part_with(part, None).await
    }

    /// [`Self::reference_part`] with the message's own attachment record of the part (its name as
    /// picked and its original), which Node matches by `attachmentRef`.
    pub async fn reference_part_with(&self, part: &ContentPart, record: Option<&AttachedFile>) -> Option<ContentPart> {
        if !is_referencable(part) {
            return None;
        }
        // The stored form: (reference, size, mime, filename, is_image).
        let (reference, size, mime, filename, image) = match part {
            ContentPart::Image(ImageSource::Base64 { data, mime_type }) => {
                let stored = self.files.store_inline(data, mime_type, "").await?;
                (stored.reference, stored.size_bytes, mime_type.clone(), String::new(), true)
            }
            ContentPart::File { source: BinarySource::AttachmentRef(r), mime_type, filename, .. } => {
                let size = self.facts.facts(r).await.map_or(0, |f| f.size_bytes);
                let image = is_image_mime(mime_type);
                (r.clone(), size, mime_type.clone(), filename.clone().unwrap_or_default(), image)
            }
            ContentPart::File { source: BinarySource::Base64(data), mime_type, filename, .. } => {
                let name = filename.clone().unwrap_or_default();
                let stored = self.files.store_inline(data, &mime_or_pdf(mime_type), &name).await?;
                (stored.reference, stored.size_bytes, mime_or_pdf(mime_type), name, false)
            }
            ContentPart::Document { source: DocumentSource::Base64 { media_type, data }, title } => {
                let name = title.clone().unwrap_or_default();
                let stored = self.files.store_inline(data, &mime_or_pdf(media_type), &name).await?;
                (stored.reference, stored.size_bytes, mime_or_pdf(media_type), name, false)
            }
            _ => return None,
        };
        // A file reaches here as a PDF only: the stored mime decides, never the bytes.
        if !image && inline_file_kind(&mime, "", "") != FileKind::Pdf {
            return None;
        }
        let facts = self.facts.facts(&reference).await.unwrap_or_default();
        let mime_type = if mime.is_empty() { if image { "image/png".to_owned() } else { "application/pdf".to_owned() } } else { mime };
        let filename = if filename.is_empty() { record.map(|r| r.name.clone()).unwrap_or_default() } else { filename };
        let info = Info {
            filename,
            mime_type: mime_type.clone(),
            size_bytes: if size > 0 { size } else { facts.size_bytes },
            page_count: if image { 0 } else { facts.page_count.unwrap_or(0) },
            text_pages: if image { None } else { facts.text_pages },
        };
        // The named copy is the file the model hands to a file chooser or an office tool; the bare
        // blob path is only the fallback when the copy cannot be made.
        // A reference that names no blob cannot travel by reference at all.
        let path = match self.files.named_file(&reference, &info.filename, &mime_type, record.and_then(|r| r.original.as_ref())).await {
            Ok(path) => path,
            Err(()) => self.files.blob_path(&reference).ok()?,
        };
        let mut meta = serde_json::Map::new();
        meta.insert("attachmentRef".into(), serde_json::Value::String(reference.clone()));
        meta.insert("kind".into(), serde_json::Value::String(if image { "image" } else { "pdf" }.to_owned()));
        meta.insert("filename".into(), serde_json::Value::String(info.filename.clone()));
        meta.insert("mimeType".into(), serde_json::Value::String(info.mime_type.clone()));
        meta.insert("sizeBytes".into(), serde_json::Value::from(info.size_bytes));
        if info.page_count > 0 {
            meta.insert("pageCount".into(), serde_json::Value::from(info.page_count));
        }
        if let Some(pages) = info.text_pages {
            meta.insert("textPages".into(), serde_json::Value::from(pages));
        }
        Some(ContentPart::Text(if image { image_reference_text(&info, &path) } else { pdf_reference_text(&info, &path) }, Some(meta)))
    }
}

#[async_trait]
impl AttachmentSeam for ReferencedMedia {
    /// `referenceMessageMedia`: a user message with every referencable media part of its own
    /// content replaced by its reference text (other roles and tool results stay as they are).
    async fn reference_media(&self, message: &AgentMessage) -> AgentMessage {
        // The message's own attachment records name each file as picked.
        let records = attached_records(message);
        if message.role() != Role::User {
            return message.clone();
        }
        let Content::Parts(parts) = &message.message.content else { return message.clone() };
        let mut changed = false;
        let mut next: Vec<ContentPart> = Vec::with_capacity(parts.len());
        for part in parts {
            let record = records.iter().find(|r| matches!(part, ContentPart::File { source: BinarySource::AttachmentRef(a), .. } if *a == r.attachment_ref));
            match self.reference_part_with(part, record).await {
                Some(reference) => {
                    changed = true;
                    next.push(reference);
                }
                None => next.push(part.clone()),
            }
        }
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
            Content::Parts(parts) => parts.iter().filter(|p| !matches!(p, ContentPart::Text(_, _))).map(|p| self.meter.part(p).tokens).sum(),
            Content::Text(_) => 0,
        }
    }
}

/// One attachment of a submission, as `attachmentsForIntake` lists it.
#[derive(Clone, PartialEq, Debug)]
pub struct AttachedFile {
    pub attachment_ref: String,
    pub name: String,
    pub mime_type: String,
    pub size_bytes: u64,
    pub original: Option<OriginalFile>,
}

/// `message.meta.transcript.attachments`.
fn attached_records(message: &AgentMessage) -> Vec<AttachedFile> {
    let list = message.stored.as_ref().and_then(|row| row.get("meta")).and_then(|m| m.pointer("/transcript/attachments")).and_then(|a| a.as_array());
    list.into_iter()
        .flatten()
        .filter_map(|record| {
            let text = |key: &str| record.get(key).and_then(|v| v.as_str()).map(str::to_owned);
            Some(AttachedFile {
                attachment_ref: text("attachmentRef")?,
                name: text("name").unwrap_or_default(),
                mime_type: text("mimeType").unwrap_or_default(),
                size_bytes: record.get("size").and_then(|v| v.as_u64()).unwrap_or(0),
                original: record.get("original").and_then(|o| Some(OriginalFile { attachment_ref: o.get("attachmentRef")?.as_str()?.to_owned(), mime_type: o.get("mimeType").and_then(|m| m.as_str()).map(str::to_owned) })),
            })
        })
        .collect()
}

impl ReferencedMedia {
    /// `attachedFilesNote`: the text part naming where a submission's attached files live on this
    /// PC, each under its original name. `pasted` are the pasted texts, which are not files; a file
    /// whose named copy cannot be made is left out. `None` when nothing is left to name. The part's
    /// object is `{kind: "files", files: [...]}`, as Node stores it.
    pub async fn attached_files_note(&self, records: &[AttachedFile], pasted: &std::collections::HashSet<String>) -> Option<ContentPart> {
        use serde_json::{json, Value};
        let mut files: Vec<Value> = Vec::new();
        let mut lines: Vec<String> = Vec::new();
        for record in records {
            if pasted.contains(&record.attachment_ref) {
                continue;
            }
            let Ok(path) = self.files.named_file(&record.attachment_ref, &record.name, &record.mime_type, record.original.as_ref()).await else { continue };
            files.push(json!({ "attachmentRef": record.attachment_ref, "name": record.name, "mimeType": record.mime_type, "sizeBytes": record.size_bytes, "path": path }));
            lines.push(format!("- {path}"));
        }
        if files.is_empty() {
            return None;
        }
        let text = ["[Attached files on this PC:".to_owned()].into_iter().chain(lines).chain(["]".to_owned()]).collect::<Vec<_>>().join("\n");
        let mut meta = serde_json::Map::new();
        meta.insert("kind".into(), json!("files"));
        meta.insert("files".into(), Value::Array(files));
        Some(ContentPart::Text(text, Some(meta)))
    }
}
#[cfg(test)]
mod tests {
    use base64::Engine;
    use base64::engine::general_purpose::STANDARD;
    use mixdog_agent::compact::estimate::PartMeter;
    use serde_json::Value;

    use super::*;
    use crate::run_host::media::StoredFacts;

    /// A store that names a payload by its filename and finds the path Node's run gave it.
    struct Files(Value);
    #[async_trait]
    impl AttachmentFiles for Files {
        async fn store_inline(&self, base64: &str, _: &str, filename: &str) -> Option<StoredFile> {
            Some(StoredFile { reference: filename.to_owned(), size_bytes: STANDARD.decode(base64).unwrap().len() as u64 })
        }
        async fn named_file(&self, reference: &str, _: &str, _: &str, _: Option<&OriginalFile>) -> Result<String, ()> {
            let case = match reference {
                "bad" => return Err(()),
                "C:\\docs\\Q1 \"report\".pdf" => "pdf_pages",
                "one.pdf" => "pdf_one_page_all_text",
                "scan.pdf" => "pdf_scanned",
                "Doc.pdf" => "pdf_document",
                _ => "pdf_unchecked",
            };
            let text = self.0[case]["text"].as_str().unwrap_or("");
            text.lines().find_map(|l| l.strip_prefix("Path: ")).map(str::to_owned).ok_or(())
        }
        fn blob_path(&self, reference: &str) -> Result<String, InvalidReference> {
            if reference == "bad" { Err(InvalidReference) } else { Ok(format!("blob:{reference}")) }
        }
    }

    struct Facts;
    #[async_trait]
    impl AttachmentFacts for Facts {
        async fn facts(&self, reference: &str) -> Option<StoredFacts> {
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
            PartMeter { text: String::new(), tokens: if matches!(part, ContentPart::Text(_, _)) { 0 } else { 100 } }
        }
    }

    fn seam(golden: &Value) -> ReferencedMedia {
        ReferencedMedia::new(Arc::new(Files(golden.clone())), Arc::new(Facts), Arc::new(Meter))
    }

    fn b64(text: &str) -> String {
        STANDARD.encode(text)
    }

    /// Node's `mediaPartToReference` text on eight parts; the path line is the one the store gave.
    #[tokio::test]
    async fn reference_texts_follow_node() {
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
            let got = s.reference_part(part).await;
            match want["text"].as_str().filter(|t| !t.is_empty()) {
                Some(text) => {
                    let Some(ContentPart::Text(got_text, Some(info))) = got else { panic!("{id}: a text part with its reference object") };
                    assert_eq!(got_text, text, "{id}");
                    // The reference is the store double's (Node's is the blob hash); the rest is Node's object.
                    let mut info = info;
                    assert!(info.insert("attachmentRef".into(), want["info"]["attachmentRef"].clone()).is_some_and(|r| r.is_string()), "{id}");
                    assert_eq!(Value::Object(info), want["info"], "{id} info");
                }
                None => assert_eq!(got, None, "{id}"),
            }
        }
        // The image part: Node named it by file name, which an inline Rust image part does not carry.
        let image = s.reference_part(&ContentPart::Image(ImageSource::Base64 { data: png.into(), mime_type: "image/png".into() })).await.unwrap();
        let ContentPart::Text(text, _) = image else { panic!("text") };
        assert!(text.starts_with("[Image kept on disk, not inlined: \"image\" (image/png, 70 bytes)\n"), "{text}");
    }

    #[tokio::test]
    async fn only_a_user_messages_media_is_referenced_and_tokens_count_media_only() {
        let golden: Value = serde_json::from_str(include_str!("golden/attachment_reference.json")).unwrap();
        let s = seam(&golden);
        let pdf = ContentPart::File { source: BinarySource::Base64(b64("%PDF-1.4 abc")), mime_type: "application/pdf".into(), filename: Some("one.pdf".into()), text: None };
        let mut user = AgentMessage::user("see");
        user.message.content = Content::Parts(vec![ContentPart::Text("see".into(), None), pdf.clone()]);
        assert!(s.has_referencable_media(&user));
        assert_eq!(s.attachment_tokens(&user), 100);
        let referenced = s.reference_media(&user).await;
        let Content::Parts(parts) = &referenced.message.content else { panic!("parts") };
        assert_eq!(parts[0], ContentPart::Text("see".into(), None));
        assert!(matches!(&parts[1], ContentPart::Text(t, _) if t.starts_with("[Attachment kept on disk, not inlined: \"one.pdf\" (PDF, 1 page, text layer on every page, 12 bytes)")));
        assert!(!s.has_referencable_media(&referenced));
        // A tool result is left as it is.
        let mut tool = AgentMessage::tool_text("c1", "x", mixdog_agent::message::ToolKind::Normal);
        tool.message.content = Content::Parts(vec![pdf]);
        assert_eq!(s.reference_media(&tool).await, tool);
    }

    /// Neither the named copy nor the bare blob path can be made for a reference that names no blob
    /// (Node throws): the part stays inline.
    #[tokio::test]
    async fn a_reference_that_names_no_blob_is_not_referenced() {
        let golden: Value = serde_json::from_str(include_str!("golden/attachment_reference.json")).unwrap();
        let s = seam(&golden);
        let part = ContentPart::File { source: BinarySource::AttachmentRef("bad".into()), mime_type: "application/pdf".into(), filename: Some("a.pdf".into()), text: None };
        assert_eq!(s.reference_part(&part).await, None);
    }

    #[tokio::test]
    async fn the_attached_files_note_names_each_path_and_keeps_the_files_object() {
        let golden: Value = serde_json::from_str(include_str!("golden/attachment_reference.json")).unwrap();
        let s = seam(&golden);
        let record = |r: &str| AttachedFile { attachment_ref: r.into(), name: format!("{r}.pdf"), mime_type: "application/pdf".into(), size_bytes: 7, original: None };
        let pasted = std::collections::HashSet::from(["p".to_owned()]);
        assert_eq!(s.attached_files_note(&[record("p")], &pasted).await, None);
        let Some(ContentPart::Text(text, Some(meta))) = s.attached_files_note(&[record("one.pdf"), record("p")], &pasted).await else { panic!("note") };
        assert!(text.starts_with("[Attached files on this PC:\n- ") && text.ends_with("\n]"), "{text}");
        assert_eq!(meta["kind"], "files");
        assert_eq!(meta["files"].as_array().unwrap().len(), 1);
        assert_eq!(meta["files"][0]["attachmentRef"], "one.pdf");
        assert_eq!(meta["files"][0]["sizeBytes"], 7);
    }}
