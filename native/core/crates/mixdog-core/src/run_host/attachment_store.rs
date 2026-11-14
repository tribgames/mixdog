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

/// `MIME_EXTENSIONS` (attachments/attachment-file-name.mjs).
const RULES: &[(&str, Rule)] = &[
    ("image/png", Rule { exts: &[".png"], strict: true }),
    ("image/jpeg", Rule { exts: &[".jpg", ".jpeg", ".jpe", ".jfif"], strict: true }),
    ("image/gif", Rule { exts: &[".gif"], strict: true }),
    ("image/webp", Rule { exts: &[".webp"], strict: true }),
    ("image/bmp", Rule { exts: &[".bmp"], strict: true }),
    ("image/tiff", Rule { exts: &[".tif", ".tiff"], strict: true }),
    ("image/heic", Rule { exts: &[".heic"], strict: true }),
    ("image/heif", Rule { exts: &[".heif"], strict: true }),
    ("image/svg+xml", Rule { exts: &[".svg"], strict: true }),
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
    let rule = RULES.iter().find(|(m, _)| *m == mime).map(|(_, rule)| rule);
    let mut keep = extname(&base);
    if mixdog_js::utf16_len(keep) > MAX_EXTENSION_LENGTH {
        keep = "";
    }
    let ext = mixdog_js::js_to_lowercase(keep);
    if let Some(rule) = rule
        && (ext.is_empty() || (rule.strict && !rule.exts.contains(&ext.as_str())))
    {
        let keep = rule.exts[0];
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
    durability: DurabilityIo,
}

impl StoreFiles {
    pub fn new(blobs: BlobStore, data_dir: &Path, tokens: &LaneTokens) -> Self {
        Self { blobs, files_dir: data_dir.join("prompt-attachments").join("files"), durability: tokens.durability_io }
    }
}

#[async_trait]
impl AttachmentFiles for StoreFiles {
    /// `canonicalBase64Buffer` + `saveBuffer`. The write refreshes the mtime of a blob that was
    /// already there (`put_fresh`), as Node does, so the GC's age window protects the reference
    /// until the message that holds it is recorded. `None` for a payload that is not canonical
    /// base64, is empty or too large, or whose write fails (Node throws, the caller reads null).
    async fn store_inline(&self, base64: &str, _mime_type: &str, _filename: &str) -> Option<StoredFile> {
        let bytes = canonical_base64(base64)?;
        let size_bytes = bytes.len() as u64;
        let blobs = self.blobs.clone();
        let pin = on_lane(self.durability, &CancellationToken::new(), move |lane| blobs.put_fresh(lane, &bytes)).await.ok()?.ok()?;
        let reference = mixdog_store::blobs::hex(pin.digest()).to_owned();
        Some(StoredFile { reference, size_bytes })
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
    use base64::Engine;
    use base64::engine::general_purpose::STANDARD;
    use mixdog_agent::compact::blob_reads::with_blobs;
    use mixdog_protocol::message_class::user_text::ReadError;
    use mixdog_store::blobs::digest_of;
    use serde_json::Value;

    use super::*;
    use crate::run_host::fixture_fs;

    const GOLDEN: &str = include_str!("golden/attachment_store.json");

    fn golden() -> Value {
        serde_json::from_str(GOLDEN).unwrap()
    }

    fn bytes(value: &Value) -> Vec<u8> {
        STANDARD.decode(value.as_str().unwrap()).unwrap()
    }

    /// The store under a temp data dir with every recorded blob planted as the file Node had on disk
    /// (a tampered, empty or missing one included): the test backend runs the lane jobs inline.
    fn world() -> (tempfile::TempDir, BlobStore, LaneTokens, Value) {
        let dir = tempfile::tempdir().unwrap();
        let store = BlobStore::new(dir.path());
        let golden = golden();
        for blob in golden["blobs"].as_array().unwrap() {
            if let (Some(digest), false) = (digest_of_reference(blob["ref"].as_str().unwrap()), blob["file"].is_null()) {
                fixture_fs::write(store.path(&digest), bytes(&blob["file"]));
            }
        }
        (dir, store, mixdog_rt::testing::tokens(), golden)
    }

    fn shown(result: &Result<Option<String>, ReadError>) -> String {
        match result {
            Ok(Some(text)) => format!("text {text:?}"),
            Ok(None) => "none".to_owned(),
            Err(ReadError::Missing) => "missing".to_owned(),
            Err(ReadError::Other) => "other".to_owned(),
        }
    }

    async fn text_within(blobs: &StoreBlobs, reference: &str, max: u64) -> Result<Result<Option<String>, ReadError>, StoreUnavailable> {
        let reference = reference.to_owned();
        with_blobs(blobs, move |store| store.text_within(&reference, max)).await
    }

    /// Node's `readAttachmentTextWithin` on every recorded blob state and limit: ENOENT is a
    /// missing blob, an invalid, empty or tampered one and a reference off the pattern are `Other`.
    #[tokio::test(flavor = "current_thread")]
    async fn text_within_answers_as_nodes_read_attachment_text_within() {
        let (_dir, store, tokens, golden) = world();
        let blobs = StoreBlobs::new(store, &tokens);
        for case in golden["blobs"].as_array().unwrap() {
            for step in case["textWithin"].as_array().unwrap() {
                let want = &step["want"];
                let expected = if let Some(text) = want.get("text") {
                    format!("text {:?}", text.as_str().unwrap())
                } else if want.get("none").is_some() {
                    "none".to_owned()
                } else if want["error"] == "ENOENT" {
                    "missing".to_owned()
                } else {
                    "other".to_owned()
                };
                let got = text_within(&blobs, case["ref"].as_str().unwrap(), step["max"].as_u64().unwrap()).await.unwrap();
                assert_eq!(shown(&got), expected, "{} max {}", case["id"], step["max"]);
            }
        }
    }

    /// The AttachmentReader port is the domains' `StoreAttachments` (one value, also the process's
    /// own): Node's `readAttachmentBuffer` + `isPermanentAttachmentError` on every recorded state.
    #[tokio::test(flavor = "current_thread")]
    async fn the_reader_answers_as_nodes_read_attachment_buffer() {
        use mixdog_ai::service::model_proxy_inline::{AttachmentReader, ReadError as Reader};
        use mixdog_core_domains::domains::ai_admin::model_proxy::StoreAttachments;

        let (_dir, store, tokens, golden) = world();
        let reader = StoreAttachments { store, interactive: tokens.interactive_io };
        for case in golden["blobs"].as_array().unwrap() {
            let want = &case["read"];
            let expected = if want.get("bytes").is_some() {
                format!("bytes {:?}", bytes(&want["bytes"]))
            } else if want["permanent"] == true {
                "permanent".to_owned()
            } else {
                "other".to_owned()
            };
            let got = match reader.read(case["ref"].as_str().unwrap()).await {
                Ok(read) => format!("bytes {read:?}"),
                Err(Reader::Permanent) => "permanent".to_owned(),
                Err(Reader::Other(_)) => "other".to_owned(),
            };
            assert_eq!(got, expected, "{}", case["id"]);
        }
    }

    #[test]
    fn file_names_are_nodes_attachment_file_names() {
        for case in golden()["fileNames"].as_array().unwrap() {
            let got = attachment_file_name(case["name"].as_str().unwrap_or(""), case["mime"].as_str().unwrap_or(""), case["fallback"].as_str().unwrap_or("attachment"));
            assert_eq!(got, case["want"].as_str().unwrap(), "{} / {}", case["name"], case["mime"]);
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn an_inline_payload_is_stored_under_its_digest_or_refused_as_nodes_store_does() {
        let (dir, store, tokens, golden) = world();
        let files = StoreFiles::new(store.clone(), dir.path(), &tokens);
        for case in golden["inline"].as_array().unwrap() {
            let data = case["data"].as_str().unwrap();
            let got = files.store_inline(data, "application/pdf", "").await;
            match case["want"].as_object() {
                None => assert_eq!(got, None, "{data:?}"),
                Some(want) => {
                    let stored = got.unwrap_or_else(|| panic!("{data:?} stored"));
                    assert_eq!(stored.reference, want["ref"].as_str().unwrap(), "{data:?}");
                    assert_eq!(stored.size_bytes, want["size"].as_u64().unwrap(), "{data:?}");
                    let path = store.path(&digest_of_reference(&stored.reference).unwrap());
                    assert_eq!(mixdog_statefile::read_content(&path).unwrap(), Some(STANDARD.decode(data).unwrap()), "{data:?}");
                }
            }
        }
    }

    /// Node's `saveBuffer` touches a blob it reuses; the store does it on the lane, and the blob
    /// stays intact and unpinned.
    #[tokio::test(flavor = "current_thread")]
    async fn a_reused_blob_has_its_mtime_refreshed() {
        let (dir, store, tokens, _) = world();
        let files = StoreFiles::new(store.clone(), dir.path(), &tokens);
        let first = files.store_inline("aGVsbG8=", "text/plain", "").await.unwrap();
        let path = store.path(&digest_of_reference(&first.reference).unwrap());
        let before = std::time::SystemTime::now();
        let again = files.store_inline("aGVsbG8=", "text/plain", "").await.unwrap();
        assert_eq!(again, first);
        let modified = on_lane(tokens.interactive_io, &CancellationToken::new(), move |lane| mixdog_statefile::metadata(lane, &path).and_then(|meta| meta.modified()))
            .await
            .unwrap()
            .unwrap();
        assert!(modified >= before, "{modified:?} < {before:?}");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a_named_copy_is_made_reused_by_its_size_and_keyed_by_the_original() {
        let (dir, store, tokens, golden) = world();
        let files = StoreFiles::new(store.clone(), dir.path(), &tokens);
        let named = &golden["named"];
        for blob in named["blobs"].as_array().unwrap() {
            let digest = digest_of_reference(blob["ref"].as_str().unwrap()).unwrap();
            assert_eq!(digest_of(&bytes(&blob["bytes"])), digest);
            if blob["store"] == true {
                fixture_fs::write(store.path(&digest), bytes(&blob["bytes"]));
            }
        }
        let reference = |blob: &Value| blob.as_str().map_or_else(|| named["blobs"][blob.as_u64().unwrap() as usize]["ref"].as_str().unwrap().to_owned(), str::to_owned);
        for (index, step) in named["steps"].as_array().unwrap().iter().enumerate() {
            if let Some(overwrite) = step.get("overwrite") {
                fixture_fs::write(dir.path().join(overwrite["path"].as_str().unwrap()), bytes(&overwrite["content"]));
            }
            let original = step.get("original").map(|o| OriginalFile { attachment_ref: reference(&o["blob"]), mime_type: o["mime"].as_str().map(str::to_owned) });
            let got = files.named_file(&reference(&step["blob"]), step["filename"].as_str().unwrap(), step["mime"].as_str().unwrap(), original.as_ref()).await;
            let want = &step["want"];
            if want.get("error").is_some() {
                assert!(got.is_err(), "step {index}");
                continue;
            }
            let path = PathBuf::from(got.unwrap_or_else(|()| panic!("step {index} made a copy")));
            let relative: Vec<_> = path.strip_prefix(dir.path()).unwrap().iter().map(|part| part.to_string_lossy().into_owned()).collect();
            assert_eq!(relative.join("/"), want["path"].as_str().unwrap(), "step {index}");
            assert_eq!(mixdog_statefile::read_content(&path).unwrap(), Some(bytes(&want["content"])), "step {index}");
        }
    }

    /// `attachmentBlobSize(ref, 0)`: the file's size; a blob that is not there counts 0 (the claimed
    /// size) and has no facts, a reference off the pattern throws and has none either.
    #[tokio::test(flavor = "current_thread")]
    async fn the_facts_are_the_blobs_size_on_disk_as_node_stats_it() {
        let (_dir, store, tokens, golden) = world();
        let facts = StoreFacts::new(store, &tokens);
        for case in golden["blobs"].as_array().unwrap() {
            let got = facts.facts(case["ref"].as_str().unwrap()).await;
            let size = case["size"]["bytes"].as_u64().unwrap_or(0);
            let want = (!case["file"].is_null()).then_some(StoredFacts { size_bytes: size, ..StoredFacts::default() });
            assert_eq!(got, want, "{}", case["id"]);
        }
    }

    /// An inline PDF is counted by the stored PDFs' inspector, once per payload; with no inspector, or for a payload the
    /// inspector rejects, it has no counts.
    #[tokio::test(flavor = "current_thread")]
    async fn an_inline_pdf_is_counted_once_by_the_inspector() {
        struct Inspector(std::sync::atomic::AtomicUsize);
        #[async_trait]
        impl DocumentText for Inspector {
            async fn office_text(&self, _: &ThreadId, _: &str, _: &str) -> Result<Option<String>, mixdog_core_api::domain::ext::ExtError> {
                unreachable!("no Office file is read")
            }
            async fn pdf_text(&self, _: &ThreadId, _: &str) -> Result<String, mixdog_core_api::domain::ext::ExtError> {
                unreachable!("no PDF text is extracted")
            }
            async fn pdf_counts(&self, _: &ThreadId, data: &str) -> Result<PdfIntake, mixdog_core_api::domain::ext::ExtError> {
                self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                Ok(match data {
                    "bad" => PdfIntake::Rejected("Invalid PDF structure.".to_owned()),
                    _ => PdfIntake::Counts(PdfCounts { page_count: 3, text_pages: 2, text_chars: 4_001 }),
                })
            }
        }
        let (_dir, store, tokens, _) = world();
        assert_eq!(StoreFacts::new(store.clone(), &tokens).inline_pdf_facts("k", "JVBERi0=").await, None);
        let inspector = Arc::new(Inspector(std::sync::atomic::AtomicUsize::new(0)));
        let facts = StoreFacts::new(store, &tokens).with_documents(inspector.clone());
        let want = Some(StoredFacts { size_bytes: 5, page_count: Some(3), text_pages: Some(2), text_chars: Some(4_001), ..StoredFacts::default() });
        assert_eq!(facts.inline_pdf_facts("k", "JVBERi0=").await, want);
        assert_eq!(facts.inline_pdf_facts("k", "JVBERi0=").await, want);
        assert_eq!(facts.inline_pdf_facts("rejected", "bad").await, None);
        assert_eq!(inspector.0.load(std::sync::atomic::Ordering::SeqCst), 2, "each payload is counted once");
    }

    #[test]
    fn a_blob_path_is_the_stores_and_a_reference_that_names_no_blob_is_an_error() {
        let (dir, store, tokens, golden) = world();
        let files = StoreFiles::new(store.clone(), dir.path(), &tokens);
        let ascii = golden["blobs"][0]["ref"].as_str().unwrap();
        assert_eq!(files.blob_path(ascii).unwrap(), store.path(&digest_of_reference(ascii).unwrap()).to_string_lossy());
        assert_eq!(files.blob_path("zz"), Err(InvalidReference));
        assert_eq!(files.blob_path(&"A".repeat(64)), Err(InvalidReference));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a_refused_lane_job_is_an_error_not_a_wait() {
        let (_dir, store, tokens, golden) = world();
        let blobs = StoreBlobs::new(store, &tokens);
        let ascii = golden["blobs"][0]["ref"].as_str().unwrap();
        let _refuse = mixdog_rt::testing::refuse_jobs_on_this_thread();
        assert!(matches!(text_within(&blobs, ascii, 1 << 20).await, Err(StoreUnavailable)));
    }

    /// A user row's commit classifies it through this read: a full interactive lane is waited out, not answered with
    /// "the attachment store is unavailable" (which failed a spawned worker's first turn under load).
    #[tokio::test(flavor = "current_thread")]
    async fn a_read_on_a_full_lane_waits_for_room_and_then_answers() {
        let (_dir, store, tokens, golden) = world();
        let blobs = StoreBlobs::new(store, &tokens);
        let ascii = golden["blobs"][0]["ref"].as_str().unwrap();
        let full = mixdog_rt::testing::hold_full(mixdog_rt::LaneKind::InteractiveIo);
        let read = text_within(&blobs, ascii, 1 << 20);
        tokio::pin!(read);
        assert!(futures::poll!(&mut read).is_pending(), "the read waits while the lane is full");
        drop(full);
        assert!(read.await.is_ok(), "the read runs once the lane has room");
    }
}
