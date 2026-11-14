//! [`RoomFiles`] over the session directory: the files a member's turn produced, taken in as the
//! room log's `agent-room-delivery.mjs` does (`speechWithArtifacts`, `storedFileFields`).
//!
//! A speech row carrying `artifactsFrom { sessionId, since }` names the member's own session in
//! this room and when its turn started. The files that turn wrote inside the session's folders
//! are stored and ride on the row as references. A user row's `upload` (the files of the user's
//! message) is taken in as a chat prompt's are (`storedRow`). Any other row comes back as it is.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;
use base64::Engine;
use mixdog_core_api::domain::ext::DocumentText;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_session::session::prompt_submission::{LongText, PromptStore, blob_size, materialize_prompt_submission, reference_of, saved, truthy};
use mixdog_rt::InLane;
use mixdog_store::fsio::{IoLane, WriteLane};
use mixdog_store::schema::bounded::Digest;

use super::media::{MAX_PDF_BYTES, pdf_intake_facts};
use mixdog_core_base::rooms::ids::room_member_of_session;
use mixdog_core_rooms::rooms::live::{LogLine, RoomFiles};
use mixdog_core_session::session::SessionDirectory;
use mixdog_js::to_number_of;
use mixdog_rt::{CancellationToken, DurabilityIo, LaneToken};
use mixdog_services::bots::delivery::rows::artifact_records;
use mixdog_services::task_reports::artifacts::turn_slice;
use mixdog_services::task_reports::collect::{Options, collect_turn_artifacts, session_roots, store_attachment};
use mixdog_store::blobs::BlobStore;
use serde_json::{Map, Value, json};

pub struct SessionFiles {
    directory: Arc<SessionDirectory>,
    lane: DurabilityIo,
    data_dir: PathBuf,
    /// `sensitive_scopes(&[home, mixdog home, data dir])`: files under them are never taken.
    scopes: Vec<Vec<String>>,
    /// The PDF check of a user's upload (`inspectPdfBuffer`).
    docs: Arc<dyn DocumentText>,
    log: LogLine,
}

impl SessionFiles {
    pub fn new(directory: Arc<SessionDirectory>, lane: DurabilityIo, data_dir: PathBuf, scopes: Vec<Vec<String>>, docs: Arc<dyn DocumentText>, log: LogLine) -> Self {
        Self { directory, lane, data_dir, scopes, docs, log }
    }

    /// `loadSession` + `turnSlice` + `collectTurnArtifacts(.., { cwd, roots: sessionRoots(session) })`.
    async fn collect(&self, session_id: &str, since: f64) -> Result<Vec<Value>, String> {
        let (folders, messages) = session_turns(&self.directory, session_id).await?;
        let found = collect_from(self.lane, &self.data_dir, &self.scopes, &folders, &messages, "", since).await?;
        Ok(found.get("files").and_then(Value::as_array).cloned().unwrap_or_default())
    }
}

/// A stored session's folders and model messages (`loadSession(id)`).
async fn session_turns(directory: &SessionDirectory, session_id: &str) -> Result<(Folders, Value), String> {
    let thread = ThreadId::from(session_id);
    let header = directory.stored_header(&thread).await.ok_or_else(|| format!("session {session_id} is not available"))?;
    let held = directory.model_context(&thread).read().await.map_err(|error| error.to_string())?;
    let messages = Value::Array(held.into_iter().map(|(_, message)| message).collect());
    let text = |value: Option<&Value>| value.and_then(Value::as_str).unwrap_or_default().to_owned();
    let cwd = text(header.get("cwd"));
    let workspace = header.get("workspace");
    let candidates = vec![
        cwd.clone(),
        text(workspace.and_then(|w| w.get("projectPath"))),
        text(workspace.and_then(|w| w.get("worktreePath"))),
        text(header.get("desktopSession").and_then(|d| d.get("projectPath"))),
    ];
    Ok((Folders { cwd, candidates }, messages))
}

/// `turnArtifacts(sessionId, runId)` (`agent-task-sessions.mjs`): the files the turn that took
/// submission `run_id` produced, as `collectTurnArtifacts` answers them (`{ files, omitted? }`).
pub async fn turn_files(directory: &SessionDirectory, lane: DurabilityIo, data_dir: &Path, scopes: &[Vec<String>], session_id: &str, run_id: &str) -> Result<Value, String> {
    let (folders, messages) = session_turns(directory, session_id).await?;
    collect_from(lane, data_dir, scopes, &folders, &messages, run_id, 0.0).await
}

/// A session's cwd and the folders its files may come from (`sessionRoots`' candidates).
struct Folders {
    cwd: String,
    candidates: Vec<String>,
}

/// `turnSlice(messages, { runId, since })` + `collectTurnArtifacts(.., { cwd, roots: sessionRoots(..) })`
/// on the durability lane: the files the turn wrote, stored (a file that fits a prompt) or
/// path-only (`{ files, omitted? }`).
async fn collect_from(lane: DurabilityIo, data_dir: &Path, scopes: &[Vec<String>], folders: &Folders, messages: &Value, run_id: &str, since: f64) -> Result<Value, String> {
    let slice = Value::Array(turn_slice(messages, run_id, since));
    let (data_dir, scopes) = (data_dir.to_path_buf(), scopes.to_vec());
    let (cwd, candidates) = (folders.cwd.clone(), folders.candidates.clone());
    let found = lane
        .submit(&CancellationToken::new(), move |lane| {
            let options = Options { cwd, roots: session_roots(&candidates), scopes };
            let blobs = BlobStore::new(&data_dir);
            collect_turn_artifacts(lane, &slice, &options, &|bytes| store_attachment(&blobs, lane, bytes)).to_json()
        })
        .map_err(|error| format!("{error:?}"))?
        .await
        .map_err(|error| format!("{error:?}"))?;
    Ok(found)
}

/// `storedFileFields(files)`: `{ parts, attachments }` for the stored files among `files`; none
/// when none is stored.
pub fn stored_file_fields(files: &[Value]) -> Map<String, Value> {
    let stored: Vec<Value> = files.iter().filter(|file| file.get("id").is_some_and(|id| !id.is_null() && id != "")).cloned().collect();
    let mut out = Map::new();
    if stored.is_empty() {
        return out;
    }
    let parts: Vec<Value> = stored
        .iter()
        .map(|file| {
            let kind = file.get("kind").and_then(Value::as_str);
            let mut part = Map::new();
            part.insert("type".into(), json!(match kind { Some("image") => "image", Some("text") => "text", _ => "file" }));
            part.insert("attachmentRef".into(), file["id"].clone());
            if kind == Some("text") {
                part.insert("textKind".into(), json!("file"));
            }
            for (key, from) in [("mimeType", "mimeType"), ("filename", "name"), ("sizeBytes", "size")] {
                if let Some(value) = file.get(from) {
                    part.insert(key.into(), value.clone());
                }
            }
            Value::Object(part)
        })
        .collect();
    out.insert("parts".into(), Value::Array(parts));
    out.insert("attachments".into(), Value::Array(artifact_records(&stored)));
    out
}

const MAX_MESSAGE_ATTACHMENTS: usize = 64;
const MAX_BLOB_BYTES: usize = 64 * 1024 * 1024;

/// `String(a || b || fallback).slice(0, limit)`.
fn first_text(values: &[Option<&Value>], fallback: &str, limit: usize) -> String {
    let text = values.iter().find(|value| truthy(**value)).map_or_else(|| fallback.to_owned(), |value| mixdog_js::value_to_string(value.unwrap()));
    mixdog_js::slice_utf16(&text, limit)
}

/// The attachment store as the prompt intake writes and measures it (`saveBuffer`, `attachmentBlobSize`). A save is
/// staged: the intake's checks all run over the staged files, and only an intake that passes every one stores them
/// ([`SessionFiles::stored_row`]), so a refused message leaves nothing in the store.
struct Store<'a, L> {
    blobs: &'a BlobStore,
    lane: &'a InLane<L>,
    staged: std::cell::RefCell<Vec<(String, Vec<u8>)>>,
}

impl<'a, L: WriteLane + IoLane> Store<'a, L> {
    fn new(blobs: &'a BlobStore, lane: &'a InLane<L>) -> Self {
        Self { blobs, lane, staged: std::cell::RefCell::new(Vec::new()) }
    }
}

impl<L: WriteLane + IoLane> PromptStore for Store<'_, L> {
    /// `saveBuffer(buffer)`'s checks and reference `{ attachmentRef, sizeBytes }`; the bytes are stored once every check passed.
    fn save(&self, bytes: &[u8]) -> Result<Map<String, Value>, String> {
        if bytes.is_empty() {
            return Err("prompt attachment is empty".into());
        }
        if bytes.len() > MAX_BLOB_BYTES {
            return Err("prompt attachment exceeds the 64 MiB input limit".into());
        }
        let reference = mixdog_store::blobs::digest_of(bytes).as_str().trim_start_matches("sha256:").to_owned();
        let mut staged = self.staged.borrow_mut();
        if !staged.iter().any(|(staged, _)| *staged == reference) {
            staged.push((reference.clone(), bytes.to_vec()));
        }
        Ok(saved(&reference, bytes.len()))
    }

    fn stored_len(&self, reference: &str) -> Result<Option<u64>, String> {
        if let Some((_, bytes)) = self.staged.borrow().iter().find(|(staged, _)| staged == reference) {
            return Ok(Some(bytes.len() as u64));
        }
        let digest = Digest::try_from(format!("sha256:{reference}")).map_err(|error| error.to_string())?;
        self.blobs.len(self.lane, &digest).map_err(|error| error.to_string())
    }
}

/// A user message's files as the prompt intake takes them in (`materializePromptSubmission`,
/// `attachmentsForIntake`, `promptContentImageMeta`): the materialized prompt, its attachment records and image chips.
struct Intake {
    prompt: Vec<Value>,
    attachments: Vec<Value>,
    images: Vec<Value>,
}

/// `attachmentsForIntake(prompt, options)`: one record per stored image, file and pasted or attached text.
fn intake_attachments<L: WriteLane + IoLane>(store: &Store<'_, L>, prompt: &[Value], images: &[&Value], texts: &[&Value]) -> Result<Vec<Value>, String> {
    let mut found: Vec<(String, Map<String, Value>)> = Vec::new();
    let mut add = |reference: &str, info: Map<String, Value>| {
        if !found.iter().any(|(r, _)| r == reference) && found.len() < MAX_MESSAGE_ATTACHMENTS {
            found.push((reference.to_owned(), info));
        }
    };
    let named = |raw: &Value, fallback: &str| first_text(&[raw.get("filename"), raw.get("name")], fallback, 200);
    // `pickedOriginal`: the file the user picked, when the store still holds it.
    let original = |raw: Option<&Value>| -> Result<Map<String, Value>, String> {
        let mut out = Map::new();
        let reference = raw.and_then(|raw| raw.get("originalRef")).map(mixdog_js::value_to_string).unwrap_or_default();
        if reference.len() == 64 && reference.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) && store.stored_len(&reference)?.is_some() {
            let mime = first_text(&[raw.and_then(|raw| raw.get("originalMediaType"))], "", 100);
            out.insert("original".into(), json!({ "attachmentRef": reference, "mimeType": mime }));
        }
        Ok(out)
    };
    let record = |kind: &str, name: String, mime: String, size: Value| {
        let mut info = Map::new();
        info.insert("kind".into(), json!(kind));
        info.insert("name".into(), json!(name));
        info.insert("mimeType".into(), json!(mime));
        info.insert("size".into(), size);
        info
    };
    for part in prompt {
        let Some(reference) = reference_of(part) else { continue };
        let mime = first_text(&[part.get("mimeType"), part.get("mediaType")], "", 100);
        let size = blob_size(store, reference, part.get("sizeBytes"))?;
        match (part.get("type").and_then(Value::as_str), part.get("textKind").and_then(Value::as_str)) {
            (Some("image"), _) => {
                let meta = images.iter().find(|raw| raw.get("attachmentRef").and_then(Value::as_str) == Some(reference)).copied();
                let mime = if mime.is_empty() { first_text(&[meta.and_then(|m| m.get("mediaType"))], "image/png", usize::MAX) } else { mime };
                let mut info = original(meta)?;
                info.extend(record("image", named(meta.unwrap_or(part), "image"), mime, size));
                add(reference, info);
            }
            (Some("file"), _) => {
                let mime = if mime.is_empty() { "application/octet-stream".to_owned() } else { mime };
                add(reference, record("file", named(part, "attachment"), mime, size));
            }
            (Some("text"), Some(kind @ ("paste" | "file"))) => {
                let mime = if mime.is_empty() { "text/plain".to_owned() } else { mime };
                add(reference, record("text", named(part, if kind == "paste" { "pasted-text.txt" } else { "attachment.txt" }), mime, size));
            }
            _ => {}
        }
    }
    // Images the prompt carries only by side table, then the pasted and attached texts.
    for raw in images {
        let Some(reference) = reference_of(raw) else { continue };
        let mut info = original(Some(raw))?;
        let size = blob_size(store, reference, raw.get("sizeBytes"))?;
        info.extend(record("image", named(raw, "image"), first_text(&[raw.get("mediaType")], "image/png", 100), size));
        add(reference, info);
    }
    for raw in texts {
        let Some(reference) = reference_of(raw) else { continue };
        let fallback = if raw.get("source").and_then(Value::as_str) == Some("file") { "attachment.txt" } else { "pasted-text.txt" };
        let size = blob_size(store, reference, raw.get("sizeBytes"))?;
        add(reference, record("text", named(raw, fallback), first_text(&[raw.get("mimeType")], "text/plain", 100), size));
    }
    Ok(found
        .into_iter()
        .map(|(reference, info)| {
            let mut out = Map::new();
            out.insert("id".into(), json!(reference));
            out.insert("attachmentRef".into(), json!(reference));
            out.extend(info);
            Value::Object(out)
        })
        .collect())
}

/// `materializePromptSubmission(prompt, { pastedImages, pastedTexts })` (the session's one implementation,
/// [`materialize_prompt_submission`]), then its attachment records and image chips.
fn take_upload<L: WriteLane + IoLane>(store: &Store<'_, L>, text: &str, upload: &Value) -> Result<Intake, String> {
    // The words ride along so the composer's text tokens find their pastes.
    let mut prompt = vec![json!({ "type": "text", "text": text })];
    prompt.extend(upload.get("parts").and_then(Value::as_array).cloned().unwrap_or_default());
    // `{ ...(upload.pastedImages ? { pastedImages } : {}), ...(upload.pastedTexts ? { pastedTexts } : {}) }`.
    let mut options = Map::new();
    for key in ["pastedImages", "pastedTexts"] {
        if let Some(table) = upload.get(key).filter(|table| truthy(Some(table))) {
            options.insert(key.into(), table.clone());
        }
    }
    let taken = materialize_prompt_submission(store, &Value::Array(prompt), &Value::Object(options), LongText::Stored)?;
    // A prompt of parts stays parts.
    let materialized = match taken.prompt {
        Value::Array(parts) => parts,
        _ => Vec::new(),
    };
    let images = taken.options.get("pastedImages").and_then(Value::as_object);
    let texts = taken.options.get("pastedTexts").and_then(Value::as_object);
    let image_entries: Vec<&Value> = images.into_iter().flat_map(|map| map.values()).filter(|raw| raw.is_object()).collect();
    let text_entries: Vec<&Value> = texts.into_iter().flat_map(|map| map.values()).filter(|raw| raw.is_object()).collect();
    let attachments = intake_attachments(store, &materialized, &image_entries, &text_entries)?;
    let chips = mixdog_core_session::session::transcript::image_meta(&json!({
        "message": materialized,
        "options": { "pastedImages": images.map_or(Value::Null, |images| Value::Object(images.clone())) },
    }));
    Ok(Intake { prompt: materialized, attachments, images: chips })
}

impl SessionFiles {
    /// `storedRow(row)`: a user row's `upload` taken in as a chat prompt's files are; the row keeps the stored
    /// references (`parts`), their attachment records and the bubble's image chips, never the bytes.
    async fn stored_row(&self, room_id: &str, row: Value) -> Result<Value, String> {
        let Value::Object(mut rest) = row else { return Ok(row) };
        let upload = rest.shift_remove("upload").unwrap_or(Value::Null);
        // `String(row.text ?? '')`.
        let text = rest.get("text").filter(|text| !text.is_null()).map(mixdog_js::value_to_string).unwrap_or_default();
        // Node stores each file as it meets it (`saveBuffer` inside `materializePromptSubmission`, then the text limit,
        // then the PDF check, `store.mjs:619-623`, `agent-room-delivery.mjs:32`); here every check runs over the staged
        // files first and only a message that passes them all is stored, so a refusal leaves nothing behind.
        let data_dir = self.data_dir.clone();
        let (mut intake, staged) = self
            .lane
            .submit(&CancellationToken::new(), move |lane| {
                let blobs = BlobStore::new(&data_dir);
                let store = Store::new(&blobs, lane);
                let intake = take_upload(&store, &text, &upload)?;
                Ok::<_, String>((intake, store.staged.into_inner()))
            })
            .map_err(|error| format!("{error:?}"))?
            .await
            .map_err(|error| format!("{error:?}"))??;
        // `preparePromptSubmissionForProvider(.., { nativePdf: false })`: each PDF checked, its page counts kept on the part.
        let thread = ThreadId::from(format!("sess_room_{room_id}"));
        for part in intake.prompt.iter_mut() {
            let mime = first_text(&[part.get("mimeType"), part.get("mediaType")], "", usize::MAX).to_lowercase();
            let Some(reference) = reference_of(part).map(str::to_owned).filter(|_| part.get("type").and_then(Value::as_str) == Some("file") && mime == "application/pdf") else {
                continue;
            };
            let (bytes, size) = match staged.iter().find(|(staged, _)| *staged == reference) {
                Some((_, bytes)) => {
                    let size = bytes.len() as u64;
                    (if size > MAX_PDF_BYTES { Vec::new() } else { bytes.clone() }, size)
                }
                None => {
                    let data_dir = self.data_dir.clone();
                    let claimed = part.get("sizeBytes").cloned();
                    self.lane
                        .submit(&CancellationToken::new(), move |lane| {
                            let blobs = BlobStore::new(&data_dir);
                            let store = Store::new(&blobs, lane);
                            let size = blob_size(&store, &reference, claimed.as_ref())?.as_f64().unwrap_or(0.0) as u64;
                            let digest = Digest::try_from(format!("sha256:{reference}")).map_err(|error| error.to_string())?;
                            let bytes = if size > MAX_PDF_BYTES { Vec::new() } else { blobs.read(lane, &digest).map_err(|error| error.to_string())? };
                            Ok::<_, String>((bytes, size))
                        })
                        .map_err(|error| format!("{error:?}"))?
                        .await
                        .map_err(|error| format!("{error:?}"))??
                }
            };
            let facts = pdf_intake_facts(self.docs.as_ref(), &thread, &base64::engine::general_purpose::STANDARD.encode(&bytes), size, false).await?;
            part["pageCount"] = json!(facts.page_count.unwrap_or(0));
            part["textPages"] = json!(facts.text_pages.unwrap_or(0));
            part["textChars"] = json!(facts.text_chars.unwrap_or(0));
        }
        // Every check passed: the files are stored, each reused blob's time refreshed (`saveBuffer`).
        let data_dir = self.data_dir.clone();
        self.lane
            .submit(&CancellationToken::new(), move |lane| {
                let blobs = BlobStore::new(&data_dir);
                staged.iter().try_for_each(|(_, bytes)| blobs.put_fresh(lane, bytes).map(drop).map_err(|error| error.to_string()))
            })
            .map_err(|error| format!("{error:?}"))?
            .await
            .map_err(|error| format!("{error:?}"))??;
        let parts: Vec<Value> = intake
            .prompt
            .into_iter()
            .filter(|part| reference_of(part).is_some() && (part.get("type").and_then(Value::as_str) != Some("text") || truthy(part.get("textKind"))))
            .collect();
        rest.insert("parts".into(), Value::Array(parts));
        rest.insert("attachments".into(), Value::Array(intake.attachments));
        rest.insert("images".into(), Value::Array(intake.images));
        Ok(Value::Object(rest))
    }
}

#[async_trait]
impl RoomFiles for SessionFiles {
    async fn take_in(&self, room_id: &str, row: Value) -> Result<Value, String> {
        let kind = row.get("kind").and_then(Value::as_str);
        // `row.upload && typeof row.upload === 'object'`.
        if kind == Some("user") && row.get("upload").is_some_and(|upload| upload.is_object() || upload.is_array()) {
            return self.stored_row(room_id, row).await;
        }
        let Some(from) = row.get("artifactsFrom").filter(|from| kind == Some("speech") && from.is_object()).cloned() else {
            return Ok(row);
        };
        let Value::Object(mut rest) = row else { return Ok(row) };
        rest.shift_remove("artifactsFrom");
        let session_id = from.get("sessionId").and_then(Value::as_str).unwrap_or_default().to_owned();
        let speaker = rest.get("speaker").and_then(Value::as_str).unwrap_or_default().to_owned();
        let belongs = room_member_of_session(&session_id).is_some_and(|member| member.room_id == room_id && member.agent_id == speaker);
        if !belongs {
            return Ok(Value::Object(rest));
        }
        // `Number(from.since) || 0`.
        let since = Some(to_number_of(from.get("since"))).filter(|since| !since.is_nan()).unwrap_or(0.0);
        match self.collect(&session_id, since).await {
            Ok(files) => rest.extend(stored_file_fields(&files)),
            Err(error) => (self.log)(&format!("the files of {session_id} could not be taken in: {error}")),
        }
        Ok(Value::Object(rest))
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use mixdog_core_session::session::prompt_submission::MAX_PROMPT_TEXT_BYTES;
    use mixdog_core_session::session::testing::Rig;

    const REF: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    // Node's attachment records are unique by ref, so the three files of the test have three.
    const REF_TEXT: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const REF_FILE: &str = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

    const GOLDEN: mixdog_testkit::Fixture = mixdog_testkit::fixture_const!("src/run_host/room_files/golden.json");
    const PNG: &str = "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da636460f85f0f0002870180eb47ba920000000049454e44ae426082";

    fn bytes(hex: &str) -> Vec<u8> {
        (0..hex.len()).step_by(2).map(|at| u8::from_str_radix(&hex[at..at + 2], 16).unwrap()).collect()
    }

    /// The real files of a project and a folder beside it, written on the lane.
    async fn tree() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let (root, other) = (dir.path().join("proj"), dir.path().join("other"));
        let (a, b) = (root.clone(), other.clone());
        let lane = mixdog_rt::testing::tokens().durability_io;
        let job = lane
            .submit(&CancellationToken::new(), move |lane| {
                mixdog_statefile::create_private_dir_all(lane, &a).unwrap();
                mixdog_statefile::create_private_dir_all(lane, &b).unwrap();
                mixdog_statefile::append_file(lane, &a.join("shot.png"), &bytes(PNG)).unwrap();
                mixdog_statefile::append_file(lane, &a.join("notes.md"), b"# notes\nhello\n").unwrap();
                mixdog_statefile::append_file(lane, &b.join("outside.md"), b"outside\n").unwrap();
            })
            .unwrap();
        job.await.unwrap();
        (dir, root, other)
    }

    /// Node's `speechWithArtifacts` on the same files: the parts and attachment records a member's
    /// turn returns, the order of its reply's links, only its own turn, only inside the session's
    /// folders and only what exists (golden recorded from `createAgentRoomDelivery`).
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_members_turn_files_become_the_rows_parts_and_attachments_as_node_stores_them() {
        let golden: Value = serde_json::from_str(&GOLDEN).unwrap();
        let (dir, root, other) = tree().await;
        let swap = |text: &str| text.replace("<root>", &root.to_string_lossy().replace('\\', "/")).replace("<other>", &other.to_string_lossy().replace('\\', "/"));
        let folders = Folders { cwd: root.to_string_lossy().into_owned(), candidates: vec![root.to_string_lossy().into_owned()] };
        let data = dir.path().join("data");
        for name in ["chart", "several", "nothing"] {
            let case = &golden[name];
            let messages: Value = serde_json::from_str(&swap(&case["messages"].to_string())).unwrap();
            let lane = mixdog_rt::testing::tokens().durability_io;
            let found = collect_from(lane, &data, &[], &folders, &messages, "", 1000.0).await.unwrap();
            let files = found.get("files").and_then(Value::as_array).cloned().unwrap_or_default();
            let got = stored_file_fields(&files);
            let want = &case["row"];
            assert_eq!(got.get("parts"), want.get("parts"), "{name}");
            assert_eq!(got.get("attachments"), want.get("attachments"), "{name}");
        }
    }

    #[test]
    fn only_stored_files_become_parts_and_attachments() {
        assert!(stored_file_fields(&[json!({ "path": "/a", "kind": "file" }), json!({ "id": "" })]).is_empty());
        let fields = stored_file_fields(&[
            json!({ "id": REF, "kind": "image", "name": "a.png", "mimeType": "image/png", "size": 3, "path": "/a.png" }),
            json!({ "path": "/skipped" }),
            json!({ "id": REF_TEXT, "kind": "text", "name": "n.txt", "mimeType": "text/plain", "size": 1 }),
            json!({ "id": REF_FILE, "kind": "file", "name": "d.pdf", "mimeType": "application/pdf", "size": 2 }),
        ]);
        let parts = fields["parts"].as_array().unwrap();
        assert_eq!(parts[0], json!({ "type": "image", "attachmentRef": REF, "mimeType": "image/png", "filename": "a.png", "sizeBytes": 3 }));
        assert_eq!(parts[1], json!({ "type": "text", "attachmentRef": REF_TEXT, "textKind": "file", "mimeType": "text/plain", "filename": "n.txt", "sizeBytes": 1 }));
        assert_eq!(parts[2]["type"], "file");
        assert_eq!(fields["attachments"].as_array().unwrap().len(), 3);
    }

    /// No PDF is taken in by these tests.
    pub(crate) struct NoDocuments;
    #[async_trait]
    impl DocumentText for NoDocuments {
        async fn office_text(&self, _: &ThreadId, _: &str, _: &str) -> Result<Option<String>, mixdog_core_api::domain::ext::ExtError> {
            unreachable!("no office text is read")
        }
        async fn pdf_text(&self, _: &ThreadId, _: &str) -> Result<String, mixdog_core_api::domain::ext::ExtError> {
            unreachable!("no PDF text is read")
        }
        async fn pdf_counts(&self, _: &ThreadId, _: &str) -> Result<mixdog_core_api::domain::ext::PdfIntake, mixdog_core_api::domain::ext::ExtError> {
            unreachable!("no PDF is taken in")
        }
    }

    fn files() -> (Rig, SessionFiles) {
        let rig = Rig::new();
        let directory = Arc::new(SessionDirectory::new(rig.deps()));
        let lane = mixdog_rt::testing::tokens().durability_io;
        let files = SessionFiles::new(directory, lane, std::env::temp_dir(), Vec::new(), Arc::new(NoDocuments), Arc::new(|_: &str| {}));
        (rig, files)
    }

    /// The PDF parser refuses every PDF with pdf.js's own message (`inspectPdfBuffer` through `unpdf`).
    struct BadPdf;
    #[async_trait]
    impl DocumentText for BadPdf {
        async fn office_text(&self, _: &ThreadId, _: &str, _: &str) -> Result<Option<String>, mixdog_core_api::domain::ext::ExtError> {
            unreachable!("no office text is read")
        }
        async fn pdf_text(&self, _: &ThreadId, _: &str) -> Result<String, mixdog_core_api::domain::ext::ExtError> {
            unreachable!("no PDF text is read")
        }
        async fn pdf_counts(&self, _: &ThreadId, _: &str) -> Result<mixdog_core_api::domain::ext::PdfIntake, mixdog_core_api::domain::ext::ExtError> {
            Ok(mixdog_core_api::domain::ext::PdfIntake::Rejected("Invalid PDF structure.".into()))
        }
    }

    fn b64(bytes: &[u8]) -> String {
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }

    /// A user row whose upload carries an image the store has not seen, then `more`.
    fn upload_row(text: String, more: Vec<Value>, pasted_texts: Option<Value>) -> Value {
        let mut parts = vec![json!({ "type": "image", "data": b64(&bytes(PNG)), "mimeType": "image/png" })];
        parts.extend(more);
        let mut upload = json!({ "parts": parts });
        if let Some(texts) = pasted_texts {
            upload["pastedTexts"] = texts;
        }
        json!({ "id": "u1", "kind": "user", "text": text, "upload": upload })
    }

    /// Each refusal of a user's upload is Node's text (`store.mjs:137,140,623`, the PDF parser's) and leaves the attachment
    /// store as it was: nothing of the message is stored, the image staged before the refused file included.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_refused_upload_stores_nothing_and_says_why_as_node_does() {
        let over_text = "x".repeat(MAX_PROMPT_TEXT_BYTES as usize + 1);
        let refusals = [
            ("text over 1 MiB", upload_row(over_text, vec![], None), "prompt text exceeds the 1 MiB input limit"),
            (
                "a file over 64 MiB",
                upload_row("t".into(), vec![json!({ "type": "file", "data": b64(&vec![7u8; MAX_BLOB_BYTES + 1]), "filename": "big.bin" })], None),
                "prompt attachment exceeds the 64 MiB input limit",
            ),
            (
                "an empty file",
                upload_row("[File #1]".into(), vec![], Some(json!({ "1": { "text": "", "source": "file", "filename": "empty.txt" } }))),
                "prompt attachment is empty",
            ),
            (
                "a PDF the parser refuses",
                upload_row("t".into(), vec![json!({ "type": "file", "data": b64(b"%PDF-1.7 not a document"), "filename": "bad.pdf" })], None),
                "Invalid PDF structure.",
            ),
        ];
        for (what, row, message) in refusals {
            let dir = tempfile::tempdir().unwrap();
            let rig = Rig::new();
            let lane = mixdog_rt::testing::tokens().durability_io;
            let files = SessionFiles::new(Arc::new(SessionDirectory::new(rig.deps())), lane, dir.path().to_path_buf(), Vec::new(), Arc::new(BadPdf), Arc::new(|_: &str| {}));
            assert_eq!(files.take_in("room01", row).await, Err(message.to_owned()), "{what}");
            assert_eq!(mixdog_testkit::tree(dir.path()), Vec::<(String, Vec<u8>)>::new(), "{what}: the store holds nothing of the refused message");
        }
    }

    /// A 65th file is no refusal: Node lists the first 64 attachments of a message (`store.mjs:638,664`) and keeps every
    /// file it stored on the row's parts.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_message_lists_its_first_64_attachments_and_keeps_every_file() {
        let dir = tempfile::tempdir().unwrap();
        let rig = Rig::new();
        let lane = mixdog_rt::testing::tokens().durability_io;
        let files = SessionFiles::new(Arc::new(SessionDirectory::new(rig.deps())), lane, dir.path().to_path_buf(), Vec::new(), Arc::new(NoDocuments), Arc::new(|_: &str| {}));
        let more: Vec<Value> = (0..64u32).map(|n| json!({ "type": "file", "data": b64(&n.to_be_bytes()), "filename": format!("f{n}.bin") })).collect();
        let row = files.take_in("room01", upload_row("t".into(), more, None)).await.unwrap();
        assert_eq!(row["parts"].as_array().unwrap().len(), 65);
        assert_eq!(row["attachments"].as_array().unwrap().len(), MAX_MESSAGE_ATTACHMENTS);
        assert_eq!(mixdog_testkit::tree(dir.path()).len(), 65, "every file of the accepted message is stored");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn rows_without_a_member_turn_to_read_come_back_unchanged_or_without_the_pointer() {
        let (_rig, files) = files();
        let plain = json!({ "id": "p", "kind": "pass", "speaker": "gh", "artifactsFrom": { "sessionId": "x" } });
        assert_eq!(files.take_in("room01", plain.clone()).await.unwrap(), plain, "only a speech takes files in");
        let speech = |session: &str, speaker: &str| json!({ "id": "s", "kind": "speech", "speaker": speaker, "text": "t", "artifactsFrom": { "sessionId": session, "since": 5 } });
        // Another room's, another member's, and a session that is no member session: no files, no pointer.
        for row in [speech("sess_rmem_room02_gh", "gh"), speech("sess_rmem_room01_ops", "gh"), speech("sess_other", "gh")] {
            assert_eq!(files.take_in("room01", row).await.unwrap(), json!({ "id": "s", "kind": "speech", "speaker": "gh", "text": "t" }));
        }
        // A member session that is not stored cannot be read: logged, the row goes without files.
        assert_eq!(
            files.take_in("room01", speech("sess_rmem_room01_gh", "gh")).await.unwrap(),
            json!({ "id": "s", "kind": "speech", "speaker": "gh", "text": "t" })
        );
    }
}
