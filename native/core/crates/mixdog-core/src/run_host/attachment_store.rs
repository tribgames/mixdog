//! The attachment ports over the process's one [`BlobStore`] (Node `runtime/attachments/store.mjs`):
//! the stored text the compaction and the transcript commit read ([`StoreBlobs`]).
//!
//! Every disk access is a job on the interactive (reads) or durability (writes) lane, through the
//! lane-proofed functions of `mixdog_statefile` and `mixdog_store::blobs`; the ports are
//! asynchronous, so a caller awaits the lane's answer and no thread waits for it.
//!
//! All ports are built over ONE `BlobStore` (its GC pins live in memory, so a second instance
//! would not see the first one's pins).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use mixdog_agent::compact::blob_reads::{BlobReads, StoreUnavailable, StoreWork};
use mixdog_core_api::domain::ext::{DocumentText, PdfCounts, PdfIntake};
// The waiting form: these reads and writes carry a user's or an agent's message; a full lane is waited out, never
// answered as a store that is unavailable.
use mixdog_core_base::support::on_lane_wait as on_lane;
use mixdog_protocol::ThreadId;
use mixdog_rt::{DurabilityIo, InLane, InteractiveIo, LaneTokens};
use mixdog_statefile::IoLane;
use mixdog_store::blobs::{digest_of_reference, BlobStore, LaneBlobs};
use tokio_util::sync::CancellationToken;

use super::attachment_reference::{AttachmentFiles, InvalidReference, OriginalFile, StoredFile};
use super::media::{base64_byte_length, AttachmentFacts, StoredFacts, MAX_PDF_BYTES};

/// The stored attachments as the compaction and the transcript commit read them
/// (`readAttachmentTextWithin`, [`LaneBlobs`]): their work runs as one interactive-lane job.
pub struct StoreBlobs {
    blobs: BlobStore,
    interactive: InteractiveIo,
}

impl StoreBlobs {
    pub fn new(blobs: BlobStore, tokens: &LaneTokens) -> Self {
        Self { blobs, interactive: tokens.interactive_io }
    }
}

#[async_trait]
impl BlobReads for StoreBlobs {
    async fn read_with(&self, work: StoreWork) -> Result<(), StoreUnavailable> {
        let blobs = self.blobs.clone();
        on_lane(self.interactive, &CancellationToken::new(), move |lane| work(&LaneBlobs { blobs: &blobs, lane }))
            .await
            .map_err(|_| StoreUnavailable)
    }
}

/// What the attachment store records of a stored file: the size of its blob on disk
/// (`attachmentBlobSize`, a `stat`) and, for a PDF, the page and text-layer counts Node's intake
/// (`preparePromptSubmissionForProvider`) records on the part: the extension host's inspector over
/// the same bytes, counted once per blob (a reference names its bytes). Image sizes stay `None`. A
/// blob that is not there, or a reference off the pattern, has no facts. An inline PDF is counted
/// the same way, once per payload.
pub struct StoreFacts {
    blobs: BlobStore,
    interactive: InteractiveIo,
    docs: Option<Arc<dyn DocumentText>>,
    counted: Mutex<HashMap<String, Option<PdfCounts>>>,
}

/// The extension host queues work by thread; the store's counting is no session's.
const COUNTING_THREAD: &str = "attachment-facts";
const COUNTED_CAP: usize = 1024;

impl StoreFacts {
    pub fn new(blobs: BlobStore, tokens: &LaneTokens) -> Self {
        Self { blobs, interactive: tokens.interactive_io, docs: None, counted: Mutex::new(HashMap::new()) }
    }

    /// Counts each stored PDF's pages and text layer with `docs`.
    pub fn with_documents(self, docs: Arc<dyn DocumentText>) -> Self {
        Self { docs: Some(docs), ..self }
    }

    /// A stored PDF's counts, `None` for any other blob or one the inspector rejects.
    async fn pdf_counts(&self, reference: &str, path: PathBuf) -> Option<PdfCounts> {
        let interactive = self.interactive;
        self.count_once(reference, async move {
            let bytes = on_lane(interactive, &CancellationToken::new(), move |lane| mixdog_statefile::read_range(lane, &path, 0, MAX_PDF_BYTES as usize)).await.ok()?.ok()?;
            Some(bytes.starts_with(b"%PDF-").then(|| STANDARD.encode(&bytes)))
        })
        .await
    }

    /// The counts of the PDF `key` names (a reference, or an inline payload's hash), counted once: `payload` is its
    /// base64, `Some(None)` for bytes that are no PDF. Bytes that cannot be read, or an inspector that does not answer,
    /// leave nothing remembered.
    async fn count_once(&self, key: &str, payload: impl std::future::Future<Output = Option<Option<String>>>) -> Option<PdfCounts> {
        let docs = self.docs.as_ref()?;
        if let Some(known) = self.counted.lock().unwrap_or_else(std::sync::PoisonError::into_inner).get(key) {
            return *known;
        }
        let counts = match payload.await? {
            Some(data) => match docs.pdf_counts(&ThreadId::from(COUNTING_THREAD), &data).await.ok()? {
                PdfIntake::Counts(counts) => Some(counts),
                PdfIntake::Rejected(_) => None,
            },
            None => None,
        };
        let mut counted = self.counted.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if counted.len() >= COUNTED_CAP {
            counted.clear();
        }
        counted.insert(key.to_owned(), counts);
        counts
    }
}

/// The facts of a file of `size_bytes` with a PDF's `counts`.
fn facts_of(size_bytes: u64, counts: Option<PdfCounts>) -> StoredFacts {
    StoredFacts {
        size_bytes,
        page_count: counts.map(|c| c.page_count).filter(|pages| *pages > 0),
        text_pages: counts.map(|c| c.text_pages),
        text_chars: counts.map(|c| c.text_chars),
        ..StoredFacts::default()
    }
}

#[async_trait]
impl AttachmentFacts for StoreFacts {
    async fn facts(&self, reference: &str) -> Option<StoredFacts> {
        let path = self.blobs.path(&digest_of_reference(reference)?);
        let stat = path.clone();
        let size = on_lane(self.interactive, &CancellationToken::new(), move |lane| mixdog_statefile::metadata(lane, &stat).map(|meta| meta.len())).await.ok()?.ok()?;
        Some(facts_of(size, self.pdf_counts(reference, path).await))
    }

    /// The same inspector over the inline payload, counted once per payload as a stored PDF is per blob.
    async fn inline_pdf_facts(&self, key: &str, data: &str) -> Option<StoredFacts> {
        let counts = self.count_once(key, async { Some(Some(data.to_owned())) }).await?;
        Some(facts_of(base64_byte_length(data), Some(counts)))
    }
}

const MAX_NAME_LENGTH: usize = 120;
const MAX_EXTENSION_LENGTH: usize = 16;

struct Rule {
    exts: &'static [&'static str],
    strict: bool,
}

/// `MIME_EXTENSIONS` (attachments/attachment-file-name.mjs) for the types the image codec does not own: the formats it
/// decodes (PNG, JPEG, GIF, WebP, TIFF, SVG, AVIF) take their media type and extensions from
/// `mixdog_imaging::Format`, so the two cannot disagree. BMP and HEIC/HEIF are named here: they are recognised as
/// attachments but are not decoded images.
const RULES: &[(&str, Rule)] = &[
    ("image/bmp", Rule { exts: &[".bmp"], strict: true }),
    ("image/heic", Rule { exts: &[".heic"], strict: true }),
    ("image/heif", Rule { exts: &[".heif"], strict: true }),
    ("application/pdf", Rule { exts: &[".pdf"], strict: true }),
    ("application/vnd.openxmlformats-officedocument.wordprocessingml.document", Rule { exts: &[".docx"], strict: true }),
    ("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", Rule { exts: &[".xlsx"], strict: true }),
    ("application/vnd.openxmlformats-officedocument.presentationml.presentation", Rule { exts: &[".pptx"], strict: true }),
    ("application/msword", Rule { exts: &[".doc"], strict: true }),
    ("application/vnd.ms-excel", Rule { exts: &[".xls"], strict: true }),
    ("application/vnd.ms-powerpoint", Rule { exts: &[".ppt"], strict: true }),
    ("text/plain", Rule { exts: &[".txt"], strict: false }),
    ("text/markdown", Rule { exts: &[".md"], strict: false }),
    ("text/csv", Rule { exts: &[".csv"], strict: false }),
    ("text/tab-separated-values", Rule { exts: &[".tsv"], strict: false }),
    ("text/html", Rule { exts: &[".html"], strict: false }),
    ("application/json", Rule { exts: &[".json"], strict: false }),
    ("application/zip", Rule { exts: &[".zip"], strict: false }),
    ("application/x-hwp", Rule { exts: &[".hwp"], strict: false }),
];

/// `safeBaseName`: the last path component, control characters and `<>:"|?*` (a run of them) made
/// one `-`, the white space and dots at both ends cut.
fn safe_base_name(name: &str) -> String {
    let last = name.rsplit(['/', '\\']).next().unwrap_or("");
    let mut replaced = String::new();
    let mut in_run = false;
    for c in last.chars() {
        let bad = c <= '\u{1f}' || matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*');
        if bad && !in_run {
            replaced.push('-');
        } else if !bad {
            replaced.push(c);
        }
        in_run = bad;
    }
    replaced.trim_matches(|c| mixdog_js::is_js_space(c) || c == '.').to_owned()
}

/// `RESERVED_DEVICE_NAME`: `/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i`.
fn reserved_device_name(base: &str) -> bool {
    let lower = base.to_ascii_lowercase();
    let stem = if ["con", "prn", "aux", "nul"].iter().any(|n| lower.starts_with(n)) {
        3
    } else if (lower.starts_with("com") || lower.starts_with("lpt")) && lower.as_bytes().get(3).is_some_and(|d| (b'1'..=b'9').contains(d)) {
        4
    } else {
        return false;
    };
    let rest = &lower[stem..];
    rest.is_empty() || (rest.starts_with('.') && !rest.contains(['\n', '\r', '\u{2028}', '\u{2029}']))
}

/// Node's `path.extname` of a name without separators.
fn extname(base: &str) -> &str {
    let bytes = base.as_bytes();
    let mut start_dot = None;
    let mut pre_dot_state = 0i8;
    for (at, byte) in bytes.iter().enumerate().rev() {
        if *byte == b'.' {
            if start_dot.is_none() {
                start_dot = Some(at);
            } else if pre_dot_state != 1 {
                pre_dot_state = 1;
            }
        } else if start_dot.is_some() {
            pre_dot_state = -1;
        }
    }
    match start_dot {
        Some(dot) if !bytes.is_empty() && pre_dot_state != 0 && !(pre_dot_state == 1 && dot == bytes.len() - 1 && dot == 1) => &base[dot..],
        _ => "",
    }
}

/// `attachmentFileName(name, mimeType, fallback)`: the name an attachment gets when it is copied
/// out of the store, made safe for a path, with the extension its type calls for.
pub fn attachment_file_name(name: &str, mime_type: &str, fallback: &str) -> String {
    let base = safe_base_name(name);
    let mut base = if base.is_empty() { fallback.to_owned() } else { base };
    if reserved_device_name(&base) {
        base.insert(0, '_');
    }
    let mime = mixdog_js::js_to_lowercase(mixdog_js::js_trim(mime_type.split(';').next().unwrap_or("")));
    let rule: Option<(&[&str], bool)> = mixdog_imaging::Format::from_media_type(&mime)
        .map(|format| (format.extensions(), true))
        .or_else(|| RULES.iter().find(|(m, _)| *m == mime).map(|(_, rule)| (rule.exts, rule.strict)));
    let mut keep = extname(&base);
    if mixdog_js::utf16_len(keep) > MAX_EXTENSION_LENGTH {
        keep = "";
    }
    let ext = mixdog_js::js_to_lowercase(keep);
    if let Some((exts, strict)) = rule
        && (ext.is_empty() || (strict && !exts.contains(&ext.as_str())))
    {
        let keep = exts[0];
        return mixdog_js::slice_utf16(&base, MAX_NAME_LENGTH - keep.len()) + keep;
    }
    if mixdog_js::utf16_len(&base) <= MAX_NAME_LENGTH {
        base
    } else {
        mixdog_js::slice_utf16(&base, MAX_NAME_LENGTH - mixdog_js::utf16_len(keep)) + keep
    }
}

/// `canonicalBase64Buffer`: the bytes of a base64 string that re-encodes to the same string.
fn canonical_base64(data: &str) -> Option<Vec<u8>> {
    let bytes = STANDARD.decode(data).ok()?;
    (!bytes.is_empty() && STANDARD.encode(&bytes) == data).then_some(bytes)
}

/// The bytes of a stored blob; an empty one is invalid (`readAttachmentBuffer`).
fn read_blob<L: IoLane>(lane: &InLane<L>, blobs: &BlobStore, reference: &str) -> Option<Vec<u8>> {
    let bytes = blobs.read(lane, &digest_of_reference(reference)?).ok()?;
    (!bytes.is_empty()).then_some(bytes)
}

/// One named copy to publish (`namedCopyPlan`): its folder, its file, and the bytes to write, none when a copy of
/// the blob's size is already there.
struct CopyPlan {
    dir: PathBuf,
    target: PathBuf,
    buffer: Option<Vec<u8>>,
}

/// `namedCopyPlan`: the blob is proven by its size on disk (a file of 1 to `MAX_BLOB_BYTES` bytes), and a copy
/// that is already there by a stat (a file of the blob's size). Neither is read then; only a missing or torn copy
/// has the blob read.
fn copy_plan(lane: &InLane<DurabilityIo>, blobs: &BlobStore, files_dir: &Path, key_ref: &str, type_for_name: &str, filename: &str, mime_type: &str) -> Option<CopyPlan> {
    let size = blobs.len(lane, &digest_of_reference(key_ref)?).ok()??;
    if size == 0 || size > mixdog_protocol::MAX_BLOB_BYTES {
        return None;
    }
    let dir = files_dir.join(key_ref);
    let name = if filename.is_empty() {
        let existing = mixdog_statefile::list_dir(lane, &dir).ok().and_then(|names| names.into_iter().find(|n| !n.contains(".mixdog-tmp-")));
        existing.unwrap_or_else(|| attachment_file_name("", mime_type, if mime_type.starts_with("image/") { "image" } else { "attachment" }))
    } else {
        attachment_file_name(filename, type_for_name, "attachment")
    };
    let target = dir.join(&name);
    let present = mixdog_statefile::metadata(lane, &target).is_ok_and(|copy| copy.is_file() && copy.len() == size);
    let buffer = if present { None } else { Some(read_blob(lane, blobs, key_ref)?) };
    Some(CopyPlan { dir, target, buffer })
}

/// `publishNamedCopy`: writes the copy the plan asks for; a write that fails is the failure.
fn publish_copy(lane: &InLane<DurabilityIo>, plan: CopyPlan) -> Option<String> {
    if let Some(buffer) = &plan.buffer {
        mixdog_statefile::create_private_dir_all(lane, &plan.dir).ok()?;
        mixdog_statefile::write_file(lane, &plan.target, buffer, &mixdog_statefile::Opts::default()).ok()?;
    }
    Some(plan.target.to_string_lossy().into_owned())
}

/// `namedAttachmentFile` (store.mjs): a copy of the stored attachment under its original name,
/// `<data>/prompt-attachments/files/<ref>/<name>`; the folder is keyed by the original's bytes when the picked
/// file was kept. Only an original that cannot be read falls back to the stored blob: once its copy is planned,
/// failing to publish it is the failure, so resized bytes never stand in for a readable original.
fn named_copy(
    lane: &InLane<DurabilityIo>,
    blobs: &BlobStore,
    files_dir: &Path,
    reference: &str,
    filename: &str,
    mime_type: &str,
    original: Option<&OriginalFile>,
) -> Option<String> {
    if let Some(original) = original {
        let own_type = original.mime_type.as_deref().filter(|m| !m.is_empty()).unwrap_or(mime_type);
        if let Some(plan) = copy_plan(lane, blobs, files_dir, &original.attachment_ref, own_type, filename, mime_type) {
            return publish_copy(lane, plan);
        }
    }
    publish_copy(lane, copy_plan(lane, blobs, files_dir, reference, mime_type, filename, mime_type)?)
}

/// The attachment store's files (`storeInlineImagePart` / `storeInlineDocumentPart`,
/// `namedAttachmentFile`, `attachmentFilePath`) over the one [`BlobStore`].
pub struct StoreFiles {
    blobs: BlobStore,
    files_dir: PathBuf,
    data_dir: PathBuf,
    durability: DurabilityIo,
}

#[async_trait]
impl mixdog_agent::offload::ImageIntake for StoreFiles {
    /// A tool-result image enters the store as every other ingress does; the reference answers for a refused picture too.
    async fn store(&self, base64: &str, name: &str) -> Option<String> {
        Some(self.import_image(base64, name).await?.original)
    }

    async fn store_blob(&self, reference: &str, name: &str) -> Option<(String, String)> {
        let vault = mixdog_image_vault::ImageVault::new(self.blobs.clone(), &self.data_dir);
        let (reference, name) = (reference.to_owned(), name.to_owned());
        let manifest = on_lane(self.durability, &CancellationToken::new(), move |lane| vault.import_blob_ref(lane, &reference, &name, &mixdog_image_egress::admission::Cancel::default()))
            .await
            .ok()?
            .ok()?;
        let mime = match &manifest.outcome {
            mixdog_image_egress::Outcome::Accepted { kind, .. } => kind.mime(),
            mixdog_image_egress::Outcome::Refused { .. } => "image/*",
        };
        Some((manifest.original, mime.to_owned()))
    }
}

impl StoreFiles {
    /// The one import of a base64 image: bounded decode and validation under the process admission, the verdict recorded.
    /// `None` for what the store cannot take now (queue full, cancelled, storage failure, not base64).
    async fn import_image(&self, base64: &str, name: &str) -> Option<mixdog_image_egress::Manifest> {
        let vault = mixdog_image_vault::ImageVault::new(self.blobs.clone(), &self.data_dir);
        let (base64, name) = (base64.to_owned(), name.to_owned());
        on_lane(self.durability, &CancellationToken::new(), move |lane| vault.import_base64(lane, &base64, &name, &mixdog_image_egress::admission::Cancel::default()))
            .await
            .ok()?
            .ok()
    }

    pub fn new(blobs: BlobStore, data_dir: &Path, tokens: &LaneTokens) -> Self {
        Self { blobs, files_dir: data_dir.join("prompt-attachments").join("files"), data_dir: data_dir.to_path_buf(), durability: tokens.durability_io }
    }
}

#[async_trait]
impl AttachmentFiles for StoreFiles {
    /// `canonicalBase64Buffer` + `saveBuffer`: the bytes published at their address (no ticket: the reference is answered
    /// bare, and no claim of these attachments exists yet, so the store's collector stays refused while such references
    /// can be in flight; mixdog-store FORMAT.md §4.4). `None` for a payload that is not canonical base64, is empty or too
    /// large, or whose write fails (Node throws, the caller reads null).
    async fn store_inline(&self, base64: &str, mime_type: &str, filename: &str) -> Option<StoredFile> {
        if mime_type.starts_with("image/") {
            // An image is judged by its bytes once, here, whatever the verdict: the reference names the stored original and its
            // manifest (a refusal is a verdict a send reads and names), so a refused picture is never left inline nor turned into text.
            let manifest = self.import_image(base64, filename).await?;
            return Some(StoredFile { reference: manifest.original, size_bytes: manifest.encoded_len });
        }
        let bytes = canonical_base64(base64)?;
        let size_bytes = bytes.len() as u64;
        let blobs = self.blobs.clone();
        if mime_type.starts_with("image/") {
            // An image is judged by its bytes once, here: the vault keeps the original with its verdict and the rendition a
            // destination may need; a refused one is not stored as a reference (it stays inline, where egress refuses it by name).
            let (vault, name) = (mixdog_image_vault::ImageVault::new(blobs, &self.data_dir), filename.to_owned());
            let manifest = on_lane(self.durability, &CancellationToken::new(), move |lane| vault.import(lane, &bytes, &name, &mixdog_image_egress::admission::Cancel::default())).await.ok()?.ok()?;
            return matches!(manifest.outcome, mixdog_image_egress::Outcome::Accepted { .. }).then(|| StoredFile { reference: manifest.original, size_bytes });
        }
        let digest = on_lane(self.durability, &CancellationToken::new(), move |lane| blobs.put_with(lane, &bytes, mixdog_store::fsio::Access::Inherit)).await.ok()?.ok()?;
        let reference = mixdog_store::blobs::hex(&digest).to_owned();
        Some(StoredFile { reference, size_bytes })
    }

    async fn refusal_of(&self, reference: &str) -> Option<String> {
        let (vault, reference) = (mixdog_image_vault::ImageVault::new(self.blobs.clone(), &self.data_dir), reference.to_owned());
        match on_lane(self.durability, &CancellationToken::new(), move |lane| vault.lookup(lane, &reference)).await.ok()? {
            mixdog_image_vault::vault::Lookup::Found(manifest) => match manifest.outcome {
                mixdog_image_egress::Outcome::Refused { text } => Some(text),
                mixdog_image_egress::Outcome::Accepted { .. } => None,
            },
            _ => None,
        }
    }

    async fn named_file(&self, reference: &str, filename: &str, mime_type: &str, original: Option<&OriginalFile>) -> Result<String, ()> {
        let (blobs, files_dir) = (self.blobs.clone(), self.files_dir.clone());
        let (reference, filename, mime_type, original) = (reference.to_owned(), filename.to_owned(), mime_type.to_owned(), original.cloned());
        on_lane(self.durability, &CancellationToken::new(), move |lane| named_copy(lane, &blobs, &files_dir, &reference, &filename, &mime_type, original.as_ref()))
            .await
            .ok()
            .flatten()
            .ok_or(())
    }

    /// `attachmentFilePath`: the blob's path; a reference off the pattern is `attachmentPath`'s
    /// TypeError.
    fn blob_path(&self, reference: &str) -> Result<String, InvalidReference> {
        let digest = digest_of_reference(reference).ok_or(InvalidReference)?;
        Ok(self.blobs.path(&digest).to_string_lossy().into_owned())
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_stored_image_is_named_with_the_extension_of_its_media_type() {
        use super::attachment_file_name as named;
        for (mime, want) in [
            ("image/png", "pic.png"),
            ("image/jpeg", "pic.jpg"),
            ("image/gif", "pic.gif"),
            ("image/webp", "pic.webp"),
            ("image/tiff", "pic.tif"),
            ("image/svg+xml", "pic.svg"),
            ("image/avif", "pic.avif"),
            ("image/heic", "pic.heic"),
            ("image/heif", "pic.heif"),
            ("image/avif; charset=binary", "pic.avif"),
        ] {
            assert_eq!(named("pic", mime, "attachment"), want, "{mime}");
        }
        // A name that already carries one of the type's extensions keeps it; a foreign one gets the type's after it.
        assert_eq!(named("photo.jpeg", "image/jpeg", "x"), "photo.jpeg");
        assert_eq!(named("photo.png", "image/avif", "x"), "photo.png.avif");
        // Every format the codec decodes agrees with its own table.
        for format in mixdog_imaging::Format::ALL {
            assert_eq!(mixdog_imaging::Format::from_media_type(format.media_type()), Some(format));
            assert_eq!(named("n", format.media_type(), "x"), format!("n{}", format.extensions()[0]));
        }
    }

}


