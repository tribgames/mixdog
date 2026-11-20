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
use mixdog_agent::compact::fresh::{AttachmentSeam, Preflight};
use mixdog_agent::compact::text_utils::StoredText;
use mixdog_ai::service::model_proxy_inline::{AttachmentReader, ReadError};
use mixdog_protocol::message_class::user_text::attachment_text;
use mixdog_agent::message::AgentMessage;
use mixdog_core_api::domain::provider::{BinarySource, Content, ContentPart, DocumentSource, ImageSource};

use super::media::{inline_file_kind, AttachmentFacts, FileKind};

// Up to this many pages per read call: the cap the read tool enforces.
pub use mixdog_tools::fs::READ_PDF_MAX_PAGES_PER_CALL;

/// A payload written to the store.
#[derive(Clone, PartialEq, Debug)]
pub struct StoredFile {
    pub reference: String,
    pub size_bytes: u64,
}

/// The store's form of an image part: a reference with its picture type, no bytes and no text.
fn stored_image(reference: String, mime_type: &str) -> ContentPart {
    ContentPart::File { source: BinarySource::AttachmentRef(reference), mime_type: mime_type.to_owned(), filename: None, text: None }
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
    /// The store's refusal text for a stored image it judged unusable (its verdict is permanent); `None` for any other
    /// reference. A refused image is referenced by the store, never carried inline and never turned into text.
    async fn refusal_of(&self, reference: &str) -> Option<String> {
        let _ = reference;
        None
    }
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

/// `ATTACHMENT_INLINE_SHARE`: inline attachments may take at most this share of the model window,
/// summed over the transcript.
const ATTACHMENT_INLINE_SHARE: f64 = 0.25;
/// `PDF_TEXT_MAX_BYTES / 4`: what a PDF costs at most when it lowers to text.
const PDF_TEXT_MAX_TOKENS: u64 = 256 * 1024 / 4;

fn is_image_part(part: &ContentPart) -> bool {
    match part {
        ContentPart::Image(_) => true,
        ContentPart::File { mime_type, .. } => is_image_mime(mime_type),
        _ => false,
    }
}

/// The compaction seam over the attachment store.
pub struct ReferencedMedia {
    files: Arc<dyn AttachmentFiles>,
    facts: Arc<dyn AttachmentFacts>,
    meter: Arc<dyn MediaMeter>,
    /// The store's bytes, for the summarizer's stored text attachments.
    reader: Option<Arc<dyn AttachmentReader>>,
}

impl ReferencedMedia {
    pub fn new(files: Arc<dyn AttachmentFiles>, facts: Arc<dyn AttachmentFacts>, meter: Arc<dyn MediaMeter>) -> Self {
        Self { files, facts, meter, reader: None }
    }

    pub fn with_reader(self, reader: Arc<dyn AttachmentReader>) -> Self {
        Self { reader: Some(reader), ..self }
    }

    /// `mediaPartToReference`: the reference text part standing for one media part, or `None` when
    /// the part cannot travel by reference (a URL image, a non-PDF file, a store failure).
    pub async fn reference_part(&self, part: &ContentPart) -> Option<ContentPart> {
        self.reference_part_with(part, None).await
    }

    /// `messageAttachmentTokens`: what a user message's own referencable media cost inline.
    fn inline_tokens(&self, message: &AgentMessage, native_pdf: bool) -> u64 {
        let Content::Parts(parts) = &message.message.content else { return 0 };
        parts
            .iter()
            .filter(|p| is_referencable(p))
            .map(|p| {
                let tokens = self.meter.part(p).tokens;
                if native_pdf || is_image_part(p) { tokens } else { tokens.min(PDF_TEXT_MAX_TOKENS) }
            })
            .sum()
    }

    /// `carriesTextlessScan`: a stored PDF with no text layer lowers to empty text for a provider
    /// that reads PDFs as text, so inline it says nothing.
    async fn carries_textless_scan(&self, message: &AgentMessage, native_pdf: bool) -> bool {
        let Content::Parts(parts) = &message.message.content else { return false };
        if native_pdf {
            return false;
        }
        for part in parts.iter().filter(|p| is_referencable(p) && !is_image_part(p)) {
            if let ContentPart::File { source: BinarySource::AttachmentRef(r), .. } = part
                && let Some(facts) = self.facts.facts(r).await
                && facts.page_count.unwrap_or(0) > 0
                && facts.text_pages == Some(0)
            {
                return true;
            }
        }
        false
    }

    /// [`Self::reference_part`] with the message's own attachment record of the part (its name as
    /// picked and its original), which Node matches by `attachmentRef`.
    pub async fn reference_part_with(&self, part: &ContentPart, record: Option<&AttachedFile>) -> Option<ContentPart> {
        if !is_referencable(part) {
            return None;
        }
        // The stored form: (reference, size, mime, filename, is_image).
        let (reference, size, mime, filename, image) = match part {
            ContentPart::Image(ImageSource::Base64 { data, mime_type, .. }) => {
                let stored = self.files.store_inline(data, mime_type, "").await?;
                if self.files.refusal_of(&stored.reference).await.is_some() {
                    return Some(stored_image(stored.reference, mime_type));
                }
                (stored.reference, stored.size_bytes, mime_type.clone(), String::new(), true)
            }
            ContentPart::File { source: BinarySource::AttachmentRef(r), mime_type, .. } if is_image_mime(mime_type) && self.files.refusal_of(r).await.is_some() => {
                // Already the store's own form of a refused picture: the part stays exactly as it is, for a send to name.
                return None;
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
    async fn stored_text(&self, part: &ContentPart) -> Result<Option<StoredText>, String> {
        let ContentPart::File { source: BinarySource::AttachmentRef(reference), filename, text: Some(text), .. } = part else {
            return Ok(None);
        };
        let Some(reader) = &self.reader else { return Ok(None) };
        match reader.read(reference).await {
            Ok(bytes) => Ok(Some(StoredText::Text(attachment_text(&String::from_utf8_lossy(&bytes), text.kind.as_deref(), filename.as_deref())))),
            Err(ReadError::Permanent) => Ok(Some(StoredText::Gone)),
            Err(ReadError::Other(message)) => Err(message),
        }
    }

    /// `referenceMessageMedia`: a user message with every referencable media part of its own
    /// content replaced by its reference text (other roles and tool results stay as they are).
    async fn reference_media(&self, message: &AgentMessage) -> AgentMessage {
        // The message's own attachment records name each file as picked.
        let records = attached_records(message);
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

    async fn preflight(&self, messages: &[AgentMessage], context_window: u64, native_pdf: bool) -> Option<Preflight> {
        let budget = (context_window as f64 * ATTACHMENT_INLINE_SHARE).floor() as u64;
        if budget == 0 {
            return None;
        }
        let mut next = messages.to_vec();
        // (index, inline tokens) of each message carrying attachments, oldest first.
        let mut carriers: Vec<(usize, u64)> =
            next.iter().enumerate().map(|(i, m)| (i, self.inline_tokens(m, native_pdf))).filter(|c| c.1 > 0).collect();
        let before: u64 = carriers.iter().map(|c| c.1).sum();
        let mut inline = before;
        let mut referenced = 0;
        for pass in [true, false] {
            for carrier in &mut carriers {
                let take = if pass {
                    carrier.1 > budget || self.carries_textless_scan(&next[carrier.0], native_pdf).await
                } else {
                    if inline <= budget {
                        break;
                    }
                    carrier.1 > 0
                };
                if !take {
                    continue;
                }
                let rewritten = self.reference_media(&next[carrier.0]).await;
                if rewritten == next[carrier.0] {
                    continue;
                }
                inline = inline.saturating_sub(carrier.1.saturating_sub(self.inline_tokens(&rewritten, native_pdf)));
                next[carrier.0] = rewritten;
                carrier.1 = 0;
                referenced += 1;
            }
        }
        (referenced > 0).then_some(Preflight { messages: next, referenced_messages: referenced, inline_tokens_before: before, budget_tokens: budget })
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
mod refusal_tests {
    use std::sync::Arc;

    use async_trait::async_trait;
    use mixdog_agent::compact::estimate::{MediaMeter, PartMeter};
    use mixdog_agent::message::ToolKind;

    use super::*;
    use crate::run_host::media::StoredFacts;

    const REFUSED: &str = "aa";
    const FINE: &str = "bb";

    /// A store whose verdicts are fixed: the image "aa" is refused, every other one is usable.
    struct Files;
    #[async_trait]
    impl AttachmentFiles for Files {
        async fn store_inline(&self, base64: &str, _: &str, _: &str) -> Option<StoredFile> {
            Some(StoredFile { reference: if base64 == "refused" { REFUSED } else { FINE }.to_owned(), size_bytes: 3 })
        }
        async fn refusal_of(&self, reference: &str) -> Option<String> {
            (reference == REFUSED).then(|| "damaged".to_owned())
        }
        async fn named_file(&self, reference: &str, _: &str, _: &str, _: Option<&OriginalFile>) -> Result<String, ()> {
            Ok(format!("/files/{reference}"))
        }
        fn blob_path(&self, reference: &str) -> Result<String, InvalidReference> {
            Ok(format!("/blobs/{reference}"))
        }
    }

    struct Facts;
    #[async_trait]
    impl AttachmentFacts for Facts {
        async fn facts(&self, _: &str) -> Option<StoredFacts> {
            None
        }
    }

    struct Meter;
    impl MediaMeter for Meter {
        fn part(&self, _: &ContentPart) -> PartMeter {
            PartMeter { text: String::new(), tokens: 1 }
        }
    }

    fn seam() -> ReferencedMedia {
        ReferencedMedia::new(Arc::new(Files), Arc::new(Facts), Arc::new(Meter))
    }

    fn inline(data: &str) -> ContentPart {
        ContentPart::Image(ImageSource::Base64 { data: data.into(), mime_type: "image/png".into(), width: None, height: None })
    }

    #[tokio::test]
    async fn a_refused_image_becomes_the_stores_reference_never_text_and_never_stays_inline() {
        let got = seam().reference_part(&inline("refused")).await.expect("replaced");
        assert_eq!(got, ContentPart::File { source: BinarySource::AttachmentRef(REFUSED.into()), mime_type: "image/png".into(), filename: None, text: None });
        assert!(matches!(seam().reference_part(&inline("fine")).await, Some(ContentPart::Text(..))), "a usable image is referenced by its path as before");
        // The store's own form of a refused picture is left exactly as it is (a send names it).
        assert_eq!(seam().reference_part(&got).await, None);
    }

    #[tokio::test]
    async fn every_role_is_referenced_and_a_tool_result_keeps_its_call() {
        for message in [AgentMessage::user("x"), AgentMessage::tool_text("c1", "x", ToolKind::Normal)] {
            let mut message = message;
            message.message.content = Content::Parts(vec![ContentPart::Text("see".into(), None), inline("fine"), inline("refused")]);
            let out = seam().reference_media(&message).await;
            let Content::Parts(parts) = &out.message.content else { panic!("parts") };
            assert_eq!(parts.len(), 3, "no part is dropped or merged");
            assert!(matches!(&parts[1], ContentPart::Text(..)));
            assert!(matches!(&parts[2], ContentPart::File { source: BinarySource::AttachmentRef(r), .. } if r == REFUSED));
            assert_eq!(out.tool_call_id(), message.tool_call_id());
        }
    }
}

#[cfg(test)]
mod tests {

}


