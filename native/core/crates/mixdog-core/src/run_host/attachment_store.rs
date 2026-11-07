//! The attachment ports over the process's one [`BlobStore`] (Node `runtime/attachments/store.mjs`):
//! the stored text the compaction and the transcript commit read ([`StoreBlobs`]).
//!
//! Every disk access is a job on the interactive (reads) or durability (writes) lane, through the
//! lane-proofed functions of `mixdog_statefile` and `mixdog_store::blobs`; the ports are
//! asynchronous, so a caller awaits the lane's answer and no thread waits for it.
//!
//! All ports are built over ONE `BlobStore` (its GC pins live in memory, so a second instance
//! would not see the first one's pins).

use std::path::{Path, PathBuf};

use async_trait::async_trait;
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use mixdog_agent::compact::blob_reads::{BlobReads, StoreUnavailable, StoreWork};
use mixdog_core_base::support::on_lane;
use mixdog_protocol::message_class::user_text::{Blobs, ReadError};
use mixdog_rt::{DurabilityIo, InLane, InteractiveIo, LaneTokens};
use mixdog_statefile::IoLane;
use mixdog_store::blobs::{digest_of, BlobStore};
use mixdog_store::schema::bounded::Digest;
use tokio_util::sync::CancellationToken;

use super::attachment_reference::{AttachmentFiles, InvalidReference, OriginalFile, StoredFile};
use super::media::{AttachmentFacts, StoredFacts};

/// The store digest of a reference (`/^[a-f0-9]{64}$/`, `attachmentPath`); `None` for anything else.
fn digest_of_reference(reference: &str) -> Option<Digest> {
    Digest::try_from(format!("sha256:{reference}")).ok()
}

/// `readAttachmentTextWithin` (store.mjs:418) on an open lane: the blob's UTF-8 text when the file
/// holds at most `max_bytes`, `None` when it holds more. A file that is not there is `Missing`;
/// an empty or non-regular file, one whose bytes do not hash to its name, and every other failure
/// are `Other`. The size is the file's own, and at most `max_bytes + 1` bytes are read.
fn read_within<L: IoLane>(lane: &InLane<L>, path: &Path, digest: &Digest, max_bytes: u64) -> Result<Option<String>, ReadError> {
    let failure = |error: std::io::Error| if error.kind() == std::io::ErrorKind::NotFound { ReadError::Missing } else { ReadError::Other };
    let meta = mixdog_statefile::metadata(lane, path).map_err(failure)?;
    if !meta.is_file() || meta.len() == 0 {
        return Err(ReadError::Other);
    }
    if meta.len() > max_bytes {
        return Ok(None);
    }
    let wanted = usize::try_from(max_bytes.saturating_add(1)).unwrap_or(usize::MAX);
    let bytes = mixdog_statefile::read_range(lane, path, 0, wanted).map_err(failure)?;
    if bytes.len() as u64 > max_bytes {
        return Ok(None);
    }
    if digest_of(&bytes) != *digest {
        return Err(ReadError::Other);
    }
    Ok(Some(String::from_utf8_lossy(&bytes).into_owned()))
}

/// The store inside one interactive lane job: the synchronous reader the work is handed.
struct LaneBlobs<'a> {
    blobs: &'a BlobStore,
    lane: &'a InLane<InteractiveIo>,
}

impl Blobs for LaneBlobs<'_> {
    fn text_within(&self, hex: &str, max_bytes: u64) -> Result<Option<String>, ReadError> {
        // `attachmentPath` throws on a reference off the pattern: not a missing blob.
        let digest = digest_of_reference(hex).ok_or(ReadError::Other)?;
        read_within(self.lane, &self.blobs.path(&digest), &digest, max_bytes)
    }
}

/// The stored attachments as the compaction and the transcript commit read them
/// (`readAttachmentTextWithin`): their work runs as one interactive-lane job.
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
/// (`attachmentBlobSize`, a `stat`). Page and text-layer counts and image sizes are on the part in
/// Node, not in the store, so they stay `None`. A blob that is not there, or a reference off the
/// pattern, has no facts.
pub struct StoreFacts {
    blobs: BlobStore,
    interactive: InteractiveIo,
}

impl StoreFacts {
    pub fn new(blobs: BlobStore, tokens: &LaneTokens) -> Self {
        Self { blobs, interactive: tokens.interactive_io }
    }
}

#[async_trait]
impl AttachmentFacts for StoreFacts {
    async fn facts(&self, reference: &str) -> Option<StoredFacts> {
        let path = self.blobs.path(&digest_of_reference(reference)?);
        let size = on_lane(self.interactive, &CancellationToken::new(), move |lane| mixdog_statefile::metadata(lane, &path).map(|meta| meta.len())).await.ok()?.ok()?;
        Some(StoredFacts { size_bytes: size, ..StoredFacts::default() })
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

/// `namedAttachmentFile` (store.mjs:212): a copy of the stored attachment under its original name,
/// `<data>/prompt-attachments/files/<ref>/<name>`; the folder is keyed by the original's bytes when
/// the picked file was kept and still readable. A copy that is already there is never overwritten.
fn named_copy(
    lane: &InLane<DurabilityIo>,
    blobs: &BlobStore,
    files_dir: &Path,
    reference: &str,
    filename: &str,
    mime_type: &str,
    original: Option<&OriginalFile>,
) -> Option<String> {
    let mut buffer = read_blob(lane, blobs, reference)?;
    let mut key_ref = reference.to_owned();
    let mut type_for_name = mime_type.to_owned();
    if let Some(original) = original
        && let Some(bytes) = read_blob(lane, blobs, &original.attachment_ref)
    {
        buffer = bytes;
        key_ref = original.attachment_ref.clone();
        if let Some(own) = original.mime_type.as_deref().filter(|m| !m.is_empty()) {
            type_for_name = own.to_owned();
        }
    }
    let dir = files_dir.join(&key_ref);
    let name = if filename.is_empty() {
        let existing = mixdog_statefile::list_dir(lane, &dir).ok().and_then(|names| names.into_iter().find(|n| !n.contains(".mixdog-tmp-")));
        existing.unwrap_or_else(|| attachment_file_name("", mime_type, if mime_type.starts_with("image/") { "image" } else { "attachment" }))
    } else {
        attachment_file_name(filename, &type_for_name, "attachment")
    };
    let target = dir.join(&name);
    if !matches!(mixdog_statefile::read_content(&target), Ok(Some(_))) {
        mixdog_statefile::create_private_dir_all(lane, &dir).ok()?;
        mixdog_statefile::write_file(lane, &target, &buffer, &mixdog_statefile::Opts::default()).ok()?;
    }
    Some(target.to_string_lossy().into_owned())
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
        let reference = pin.digest().as_str().strip_prefix("sha256:")?.to_owned();
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
    async fn a_named_copy_is_made_reused_keyed_by_the_original_and_never_overwritten() {
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
}
