//! The files a submission names on this PC: each attached file is copied out of the content-addressed store under the name
//! it was picked with, and the model is told where, in a note that rides the message. A pasted text is not a file.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use mixdog_agent::compact::estimate::MediaMeter;
use mixdog_agent::compact::estimate::PartMeter;
use mixdog_core_api::domain::provider::ContentPart;
use mixdog_store::blobs::BlobStore;
use serde_json::Value;
use serde_json::json;

use super::attachment_reference::AttachedFile;
use super::attachment_reference::AttachmentFiles;
use super::attachment_reference::OriginalFile;
use super::attachment_reference::ReferencedMedia;
use super::attachment_store::StoreFacts;
use super::attachment_store::StoreFiles;

/// Pricing is not what these tests are about: a file note never reaches it.
struct NoMeter;

impl MediaMeter for NoMeter {
    fn part(&self, _: &ContentPart) -> PartMeter {
        PartMeter { text: String::new(), tokens: 0 }
    }
}

struct World {
    dir: tempfile::TempDir,
    files: Arc<StoreFiles>,
    media: ReferencedMedia,
}

fn world() -> World {
    let dir = tempfile::tempdir().expect("data dir");
    let blobs = BlobStore::new(dir.path());
    let tokens = mixdog_rt::testing::tokens();
    let files = Arc::new(StoreFiles::new(blobs.clone(), dir.path(), &tokens));
    let media = ReferencedMedia::new(files.clone(), Arc::new(StoreFacts::new(blobs, &tokens)), Arc::new(NoMeter));
    World { dir, files, media }
}

/// A reference no blob was ever stored under.
const ABSENT: &str = "abababababababababababababababababababababababababababababababab";

impl World {
    /// Stores `bytes` and returns the reference the store names them by.
    async fn plant(&self, bytes: &[u8]) -> String {
        self.files.store_inline(&STANDARD.encode(bytes), "", "").await.expect("stored").reference
    }

    /// Where the copy of the blob `reference` under `name` lives.
    fn copy_path(&self, reference: &str, name: &str) -> PathBuf {
        self.dir.path().join("prompt-attachments").join("files").join(reference).join(name)
    }

    async fn note(&self, records: &[AttachedFile], pasted: &[&str]) -> Option<(String, Value)> {
        let pasted: HashSet<String> = pasted.iter().map(|reference| (*reference).to_owned()).collect();
        match self.media.attached_files_note(records, &pasted).await {
            Some(ContentPart::Text(text, Some(meta))) => Some((text, Value::Object(meta))),
            Some(other) => panic!("the note is a text part with its file list, not {other:?}"),
            None => None,
        }
    }
}

fn file(reference: &str, name: &str, mime: &str, size: u64) -> AttachedFile {
    AttachedFile { attachment_ref: reference.into(), name: name.into(), mime_type: mime.into(), size_bytes: size, original: None }
}

#[tokio::test(flavor = "current_thread")]
async fn an_attached_file_is_copied_under_its_picked_name_and_the_note_names_the_copy() {
    let w = world();
    let reference = w.plant(b"jpeg bytes").await;
    let (text, meta) = w.note(&[file(&reference, "photo", "image/jpeg", 10)], &[]).await.expect("a note");
    let copy = w.copy_path(&reference, "photo.jpg");
    let path = copy.to_string_lossy().into_owned();
    assert_eq!(text, format!("[Attached files on this PC:\n- {path}\n]"), "a name without an extension takes its type's");
    assert_eq!(meta, json!({ "kind": "files", "files": [{ "attachmentRef": reference, "name": "photo", "mimeType": "image/jpeg", "sizeBytes": 10, "path": path }] }));
    assert_eq!(std::fs::read(&copy).expect("the copy is there"), b"jpeg bytes");
    let blob = w.files.blob_path(&reference).expect("a blob path");
    assert_eq!(std::fs::read(blob).expect("the blob stays"), b"jpeg bytes", "the store itself stays content-addressed");
}

#[tokio::test(flavor = "current_thread")]
async fn a_file_that_already_carries_its_types_extension_keeps_its_name() {
    let w = world();
    let reference = w.plant(b"pdf bytes").await;
    let (_, meta) = w.note(&[file(&reference, "Q1 report.pdf", "application/pdf", 9)], &[]).await.expect("a note");
    assert_eq!(meta["files"][0]["path"], json!(w.copy_path(&reference, "Q1 report.pdf").to_string_lossy()));
}

#[tokio::test(flavor = "current_thread")]
async fn a_pasted_text_is_not_listed_as_a_file_and_nothing_attached_is_no_note() {
    let w = world();
    let pasted = w.plant(b"pasted words").await;
    let document = w.plant(b"doc bytes").await;
    let (text, meta) = w.note(&[file(&pasted, "paste.txt", "text/plain", 12), file(&document, "doc.txt", "text/plain", 9)], &[pasted.as_str()]).await.expect("a note");
    assert_eq!(meta["files"].as_array().expect("files").len(), 1);
    assert!(text.contains("doc.txt") && !text.contains("paste.txt"), "{text}");
    assert_eq!(w.note(&[], &[]).await, None);
    assert_eq!(w.note(&[file(&pasted, "paste.txt", "text/plain", 12)], &[pasted.as_str()]).await, None, "a message of only pasted text names no files");
}

#[tokio::test(flavor = "current_thread")]
async fn a_file_whose_copy_cannot_be_made_is_left_out_of_the_note() {
    let w = world();
    let reference = w.plant(b"kept").await;
    let (_, meta) = w.note(&[file(ABSENT, "gone.txt", "text/plain", 4), file("not a reference", "bad.txt", "text/plain", 4), file(&reference, "kept.txt", "text/plain", 4)], &[]).await.expect("a note");
    let names: Vec<&str> = meta["files"].as_array().expect("files").iter().map(|entry| entry["name"].as_str().expect("name")).collect();
    assert_eq!(names, ["kept.txt"]);
}

#[tokio::test(flavor = "current_thread")]
async fn two_files_with_the_same_name_keep_separate_copies() {
    let w = world();
    let (first, second) = (w.plant(b"first bytes").await, w.plant(b"second bytes").await);
    let (_, meta) = w.note(&[file(&first, "same.txt", "text/plain", 11), file(&second, "same.txt", "text/plain", 12)], &[]).await.expect("a note");
    let paths: Vec<PathBuf> = meta["files"].as_array().expect("files").iter().map(|entry| PathBuf::from(entry["path"].as_str().expect("path"))).collect();
    assert_ne!(paths[0], paths[1]);
    assert_eq!(paths[0].file_name(), paths[1].file_name(), "each is named as it was picked");
    assert_eq!(std::fs::read(&paths[0]).unwrap(), b"first bytes");
    assert_eq!(std::fs::read(&paths[1]).unwrap(), b"second bytes");
}

#[tokio::test(flavor = "current_thread")]
async fn the_file_as_picked_is_copied_rather_than_its_converted_form_and_a_missing_original_falls_back_to_the_stored_copy() {
    let w = world();
    let converted = w.plant(b"resized bytes").await;
    let original = w.plant(b"original bytes").await;
    let with_original = |original: &str| AttachedFile {
        original: Some(OriginalFile { attachment_ref: original.into(), mime_type: Some("image/png".into()) }),
        ..file(&converted, "pic.png", "image/png", 13)
    };

    let (_, meta) = w.note(&[with_original(&original)], &[]).await.expect("a note");
    let path = PathBuf::from(meta["files"][0]["path"].as_str().expect("path"));
    assert_eq!(path, w.copy_path(&original, "pic.png"), "the folder is keyed by the original's bytes");
    assert_eq!(std::fs::read(&path).unwrap(), b"original bytes");

    let (_, meta) = w.note(&[with_original(ABSENT)], &[]).await.expect("a note");
    let path = PathBuf::from(meta["files"][0]["path"].as_str().expect("path"));
    assert_eq!(path, w.copy_path(&converted, "pic.png"), "the stored copy stands in, under the same name");
    assert_eq!(std::fs::read(&path).unwrap(), b"resized bytes");
}
