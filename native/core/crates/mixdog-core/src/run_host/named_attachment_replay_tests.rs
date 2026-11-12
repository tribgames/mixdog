//! `fixtures/named-attachment-file-cases` (`record-named-attachment-file-cases.mjs`, b6f10295a): the cases of
//! `named-attachment-file.test.mjs` whose subject is the PC file a submission names, replayed in recorded order over one store (as the
//! Node test shares one data directory): every recorded blob is planted through the store's own `store_inline`, then the core's
//! `attached_files_note` and `reference_part` run over the real `StoreFiles` and `StoreFacts`.

use std::collections::HashSet;
use std::path::Path;
use std::sync::Arc;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use mixdog_agent::compact::estimate::MediaMeter;
use mixdog_agent::compact::estimate::PartMeter;
use mixdog_core_api::domain::provider::BinarySource;
use mixdog_core_api::domain::provider::ContentPart;
use mixdog_store::blobs::BlobStore;
use mixdog_testkit::exact::Exact;
use serde_json::Value;

use super::attachment_reference::AttachedFile;
use super::attachment_reference::AttachmentFiles;
use super::attachment_reference::OriginalFile;
use super::attachment_reference::ReferencedMedia;
use super::attachment_store::StoreFacts;
use super::attachment_store::StoreFiles;

/// Pricing is not what these cases are about: the references never reach it.
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

fn bytes(base64: &Value) -> Vec<u8> {
    STANDARD.decode(base64.as_str().expect("base64 text")).expect("base64")
}

/// The recorder wrote the data directory as `<data>`.
fn scrub(value: &Value, root: &Path) -> Value {
    match value {
        Value::String(text) => Value::String(text.replace(&*root.to_string_lossy(), "<data>")),
        Value::Array(items) => Value::Array(items.iter().map(|item| scrub(item, root)).collect()),
        Value::Object(fields) => Value::Object(fields.iter().map(|(key, item)| (key.clone(), scrub(item, root))).collect()),
        other => other.clone(),
    }
}

impl World {
    /// Every blob the store held at the end of the recorded case, written through the store.
    async fn plant(&self, blobs: &Value) {
        for (reference, base64) in blobs.as_object().expect("blobs") {
            let stored = self.files.store_inline(base64.as_str().expect("base64"), "", "").await.expect("stored");
            assert_eq!(&stored.reference, reference, "the store names a blob by the digest of its bytes");
        }
    }

    fn scrubbed(&self, value: &Value) -> Value {
        scrub(value, self.dir.path())
    }

    /// `attachmentsForIntake`'s list as the core's records, and the pasted texts among them (not files).
    fn records(list: &Value) -> (Vec<AttachedFile>, HashSet<String>) {
        let text = |entry: &Value, key: &str| entry[key].as_str().map(str::to_owned);
        let records = list
            .as_array()
            .expect("attachments")
            .iter()
            .map(|entry| AttachedFile {
                attachment_ref: text(entry, "attachmentRef").expect("ref"),
                name: text(entry, "name").unwrap_or_default(),
                mime_type: text(entry, "mimeType").unwrap_or_default(),
                size_bytes: entry["size"].as_u64().unwrap_or(0),
                original: entry.get("original").map(|original| OriginalFile { attachment_ref: text(original, "attachmentRef").expect("ref"), mime_type: text(original, "mimeType") }),
            })
            .collect();
        let pasted = list.as_array().unwrap().iter().filter(|entry| entry["kind"] == "text").map(|entry| entry["attachmentRef"].as_str().unwrap().to_owned()).collect();
        (records, pasted)
    }

    /// `attachedFilesNote(prompt, options, attachments)` as `{ text, attachmentReference }`; `None` when nothing is a file.
    async fn note(&self, attachments: &Value) -> Option<Value> {
        let (records, pasted) = Self::records(attachments);
        let Some(ContentPart::Text(text, Some(meta))) = self.media.attached_files_note(&records, &pasted).await else { return None };
        Some(serde_json::json!({ "type": "text", "text": text, "attachmentReference": meta }))
    }

    /// The recorder's `fileOf`: the note's file entry, the bytes at its path and the name of the copy.
    fn file_entry(&self, file: &Value) -> Value {
        let path = file["path"].as_str().expect("path");
        let mut entry = file.clone();
        entry["base64"] = Value::String(STANDARD.encode(std::fs::read(path).expect("the copy is there")));
        entry["basename"] = Value::String(Path::new(path).file_name().unwrap().to_string_lossy().into_owned());
        entry
    }

    fn blob_bytes(&self, reference: &str) -> String {
        STANDARD.encode(std::fs::read(self.files.blob_path(reference).expect("a blob path")).expect("the blob"))
    }
}

fn note_of(world: &World, note: Option<Value>) -> Value {
    world.scrubbed(&note.expect("a note"))
}

#[tokio::test(flavor = "current_thread")]
async fn every_named_attachment_case_gives_the_files_node_recorded() {
    let golden: Value = serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/named-attachment-file-cases/golden.json")).expect("golden.json");
    let golden = Exact::decode(&golden).expect("exact");
    let w = world();
    let mut seen = Vec::new();
    for case in golden.get("cases").as_array() {
        let name = case.get("case").as_str().to_owned();
        let want = case.get("observed").to_plain().expect("plain");
        seen.push(name.clone());
        match name.as_str() {
            "an attached image is copied under its original name; the blob stays content-addressed" => {
                w.plant(&want["blobs"]).await;
                let note = w.note(&want["attachments"]).await;
                assert_eq!(note_of(&w, note.clone()), want["note"]);
                let files = note.unwrap()["attachmentReference"]["files"].clone();
                let photo = files.as_array().unwrap().iter().find(|file| file["mimeType"] == "image/jpeg").expect("the photo").clone();
                assert_eq!(w.scrubbed(&w.file_entry(&photo)), want["photo"], "the copy under its own name, with its bytes");
                assert_eq!(Value::String(w.blob_bytes(photo["attachmentRef"].as_str().unwrap())), want["blobBase64"], "the blob stays the stored bytes");
                assert_eq!(want["noteNamesPath"], true);
                let reused = w.files.named_file(photo["attachmentRef"].as_str().unwrap(), photo["name"].as_str().unwrap(), photo["mimeType"].as_str().unwrap(), None).await.expect("a copy");
                assert_eq!(Value::String(reused.clone()) == photo["path"], want["reusedIsThePath"].as_bool().unwrap());
                assert_eq!(w.scrubbed(&Value::String(reused)), want["reusedPath"]);
            }
            "a document without a name still gets a typed file, and a paste is not listed as a file" => {
                w.plant(&want["blobs"]).await;
                let note = w.note(&want["attachments"]).await;
                assert_eq!(note_of(&w, note.clone()), want["note"]);
                let mut names: Vec<String> = note.unwrap()["attachmentReference"]["files"].as_array().unwrap().iter().map(|file| file["path"].as_str().unwrap().rsplit(['/', '\\']).next().unwrap().to_owned()).collect();
                names.sort();
                assert_eq!(serde_json::json!(names), want["names"]);
                assert_eq!(w.note(&serde_json::json!([])).await, None);
                assert!(want["plain"].is_null());
            }
            "the note is model-facing only: the restored bubble does not show it" => {
                // What the restored bubble shows is replayed in mixdog-core-session (message_attachments_tests).
            }
            "a by-reference image names the same copy the note gave, not the bare blob" => {
                w.plant(&want["blobs"]).await;
                let note = w.note(&want["attachments"]).await;
                assert_eq!(note_of(&w, note.clone()), want["note"]);
                let photo = note.unwrap()["attachmentReference"]["files"].as_array().unwrap().iter().find(|file| file["mimeType"] == "image/jpeg").unwrap().clone();
                let part = &want["imagePart"];
                let image = ContentPart::File {
                    source: BinarySource::AttachmentRef(part["attachmentRef"].as_str().unwrap().to_owned()),
                    mime_type: part["mimeType"].as_str().unwrap().to_owned(),
                    filename: None,
                    text: None,
                };
                let Some(ContentPart::Text(text, Some(meta))) = w.media.reference_part(&image).await else { panic!("a reference part") };
                assert_eq!(w.scrubbed(&Value::String(text.clone())), want["reference"]["text"]);
                assert_eq!(w.scrubbed(&Value::Object(meta.clone())), want["reference"]["attachmentReference"]);
                assert!(text.contains(photo["path"].as_str().unwrap()), "the reference names the copy the note gave");
                assert_eq!(meta["attachmentRef"], photo["attachmentRef"]);
            }
            "the PC file is the original picked bytes in their own format; the model keeps the resized blob" => {
                w.plant(&want["blobs"]).await;
                let note = w.note(&want["attachments"]).await;
                assert_eq!(note_of(&w, note.clone()), want["note"]);
                let file = note.unwrap()["attachmentReference"]["files"][0].clone();
                assert_eq!(w.scrubbed(&w.file_entry(&file)), want["file"]);
                assert_eq!(bytes(&w.file_entry(&file)["base64"]), bytes(&want["originalBase64"]), "the PC file is the original bytes");
                assert_eq!(Value::String(w.blob_bytes(file["attachmentRef"].as_str().unwrap())), want["blobBase64"], "the blob stays the resized image");
                // A later note with no original given never touches the original's file.
                let other = w.files.named_file(file["attachmentRef"].as_str().unwrap(), "IMG_0042.heic", "image/webp", None).await.expect("a copy");
                assert_eq!(w.scrubbed(&Value::String(other.clone())), want["other"]);
                assert_eq!(Value::String(other) == file["path"], want["otherIsFile"].as_bool().unwrap());
                assert_eq!(Value::String(STANDARD.encode(std::fs::read(file["path"].as_str().unwrap()).unwrap())), want["fileAfter"]);
            }
            "two originals that resize to the same bytes and share a name keep separate files" => {
                w.plant(&want["blobs"]).await;
                let mut paths = Vec::new();
                for send in want["sends"].as_array().unwrap() {
                    let note = w.note(&send["attachments"]).await;
                    assert_eq!(note_of(&w, note.clone()), send["note"]);
                    let file = note.unwrap()["attachmentReference"]["files"][0].clone();
                    assert_eq!(w.scrubbed(&w.file_entry(&file)), send["file"]);
                    assert_eq!(bytes(&w.file_entry(&file)["base64"]), bytes(&send["originalBase64"]));
                    paths.push(file["path"].as_str().unwrap().to_owned());
                }
                assert_eq!(want["differentPaths"], paths[0] != paths[1]);
                assert_eq!(want["sameName"], Path::new(&paths[0]).file_name() == Path::new(&paths[1]).file_name());
            }
            "a message record keeps the picked file referenced" => {
                // The record's normaliser is replayed in mixdog-core-session (message_attachments_tests).
            }
            "a missing original falls back to the resized copy under the same name" => {
                w.plant(&want["blobs"]).await;
                let note = w.note(&want["attachments"]).await;
                assert_eq!(note_of(&w, note.clone()), want["note"]);
                let file = note.unwrap()["attachmentReference"]["files"][0].clone();
                assert_eq!(w.scrubbed(&w.file_entry(&file)), want["file"]);
            }
            other => panic!("no replay for the recorded case {other:?}"),
        }
    }
    assert_eq!(seen.len(), 8, "every recorded case is replayed");
}
