//! [`RoomFiles`] over the session directory: the files a member's turn produced, taken in as the
//! room log's `agent-room-delivery.mjs` does (`speechWithArtifacts`, `storedFileFields`).
//!
//! A speech row carrying `artifactsFrom { sessionId, since }` names the member's own session in
//! this room and when its turn started. The files that turn wrote inside the session's folders
//! are stored and ride on the row as references. Any other row comes back as it is.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::ids::ThreadId;
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
    log: LogLine,
}

impl SessionFiles {
    pub fn new(directory: Arc<SessionDirectory>, lane: DurabilityIo, data_dir: PathBuf, scopes: Vec<Vec<String>>, log: LogLine) -> Self {
        Self { directory, lane, data_dir, scopes, log }
    }

    /// `loadSession` + `turnSlice` + `collectTurnArtifacts(.., { cwd, roots: sessionRoots(session) })`.
    async fn collect(&self, session_id: &str, since: f64) -> Result<Vec<Value>, String> {
        let thread = ThreadId::from(session_id);
        let header = self.directory.stored_header(&thread).await.ok_or_else(|| format!("session {session_id} is not available"))?;
        let held = self.directory.model_context(&thread).read().await.map_err(|error| error.to_string())?;
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
        let folders = Folders { cwd, candidates };
        collect_from(self.lane, &self.data_dir, &self.scopes, &folders, &messages, since).await
    }
}

/// A session's cwd and the folders its files may come from (`sessionRoots`' candidates).
struct Folders {
    cwd: String,
    candidates: Vec<String>,
}

/// `turnSlice(messages, { since })` + `collectTurnArtifacts(.., { cwd, roots: sessionRoots(..) })`
/// on the durability lane: the files the turn wrote, stored (a file that fits a prompt) or
/// path-only.
async fn collect_from(lane: DurabilityIo, data_dir: &Path, scopes: &[Vec<String>], folders: &Folders, messages: &Value, since: f64) -> Result<Vec<Value>, String> {
    let slice = Value::Array(turn_slice(messages, "", since));
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
    Ok(found.get("files").and_then(Value::as_array).cloned().unwrap_or_default())
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

#[async_trait]
impl RoomFiles for SessionFiles {
    async fn take_in(&self, room_id: &str, row: Value) -> Result<Value, String> {
        let kind = row.get("kind").and_then(Value::as_str);
        if kind == Some("user") && row.get("upload").is_some_and(Value::is_object) {
            // A user row's upload is the prompt intake's (`storedRow`); the exchange never posts one.
            return Err("a user row's upload is taken in by the message intake, not by the room log".into());
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
mod tests {
    use super::*;
    use mixdog_core_session::session::testing::Rig;

    const REF: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    const GOLDEN: &str = include_str!("room_files/golden.json");
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
        let golden: Value = serde_json::from_str(GOLDEN).unwrap();
        let (dir, root, other) = tree().await;
        let swap = |text: &str| text.replace("<root>", &root.to_string_lossy().replace('\\', "/")).replace("<other>", &other.to_string_lossy().replace('\\', "/"));
        let folders = Folders { cwd: root.to_string_lossy().into_owned(), candidates: vec![root.to_string_lossy().into_owned()] };
        let data = dir.path().join("data");
        for name in ["chart", "several", "nothing"] {
            let case = &golden[name];
            let messages: Value = serde_json::from_str(&swap(&case["messages"].to_string())).unwrap();
            let lane = mixdog_rt::testing::tokens().durability_io;
            let files = collect_from(lane, &data, &[], &folders, &messages, 1000.0).await.unwrap();
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
            json!({ "id": REF, "kind": "text", "name": "n.txt", "mimeType": "text/plain", "size": 1 }),
            json!({ "id": REF, "kind": "file", "name": "d.pdf", "mimeType": "application/pdf", "size": 2 }),
        ]);
        let parts = fields["parts"].as_array().unwrap();
        assert_eq!(parts[0], json!({ "type": "image", "attachmentRef": REF, "mimeType": "image/png", "filename": "a.png", "sizeBytes": 3 }));
        assert_eq!(parts[1], json!({ "type": "text", "attachmentRef": REF, "textKind": "file", "mimeType": "text/plain", "filename": "n.txt", "sizeBytes": 1 }));
        assert_eq!(parts[2]["type"], "file");
        assert_eq!(fields["attachments"].as_array().unwrap().len(), 3);
    }

    fn files() -> (Rig, SessionFiles) {
        let rig = Rig::new();
        let directory = Arc::new(SessionDirectory::new(rig.deps()));
        let lane = mixdog_rt::testing::tokens().durability_io;
        let files = SessionFiles::new(directory, lane, std::env::temp_dir(), Vec::new(), Arc::new(|_: &str| {}));
        (rig, files)
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
        let upload = json!({ "id": "u", "kind": "user", "text": "t", "upload": { "parts": [] } });
        assert!(files.take_in("room01", upload).await.is_err());
    }
}
