//! The `attachments` of a `session` (send, create) or `agent` (spawn, send) call, resolved as Node's
//! `callerAttachmentParts` does (`workspace-tools.mjs`, `handoff-attachments.mjs`): each reference is an attachment the
//! caller's own conversation shows (by id or by file name) or a file inside the caller's folders, and comes back as the
//! stored reference part a forwarded prompt carries. A file is read once on the durability lane and stored in the
//! attachment store under its content address; nothing but the reference travels on.
//! Replayed against Node's answers by `mixdog-services` (`fixtures/session-activity/golden.json`, `handoff.resolve`).

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::OnceLock;

use async_trait::async_trait;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_session::session::SessionDirectory;
use mixdog_rt::CancellationToken;
use mixdog_rt::DurabilityIo;
use mixdog_rt::LaneToken;
use mixdog_services::task_reports::collect::Options;
use mixdog_services::task_reports::collect::resolve_handoff_attachments;
use mixdog_services::task_reports::collect::session_roots;
use mixdog_services::task_reports::collect::store_attachment;
use mixdog_store::blobs::BlobStore;
use mixdog_store::schema::bounded::Digest;
use mixdog_store::schema::record::Header;
use serde_json::Value;

/// `rt.session.messages` of the calling session: its model messages, the prompt of the turn the call runs in included
/// (Node commits the user turn to the session before the provider call, `precommitUserTurn`).
#[async_trait]
pub trait CallerMessages: Send + Sync {
    async fn messages(&self, thread: &ThreadId) -> Result<Vec<Value>, String>;
}

#[async_trait]
impl CallerMessages for SessionDirectory {
    async fn messages(&self, thread: &ThreadId) -> Result<Vec<Value>, String> {
        let held = self.model_context(thread).read().await.map_err(|error| error.to_string())?;
        Ok(held.into_iter().map(|(_, message)| message).collect())
    }
}

/// What resolving a call's `attachments` needs of the process.
pub struct HandoffAttachments {
    pub messages: Arc<dyn CallerMessages>,
    pub lane: DurabilityIo,
    pub data_dir: PathBuf,
    /// `sensitive_scopes(&[home, mixdog home, data dir])`: files under them are never attached.
    pub scopes: Vec<Vec<String>>,
}

impl HandoffAttachments {
    /// `resolveHandoffAttachments(refs, { messages, roots: sessionRoots(session, callerCwd), cwd: callerCwd, surface }).parts`
    /// for the session of `header`; `Err` is the text Node throws.
    pub async fn resolve(&self, thread: &ThreadId, header: &Header, refs: &Value, cwd: &str, surface: &str) -> Result<Vec<Value>, String> {
        if refs.is_null() {
            return Ok(Vec::new());
        }
        let messages = Value::Array(self.messages.messages(thread).await?);
        let text = |value: Option<&Value>| value.and_then(Value::as_str).unwrap_or_default().to_owned();
        let workspace = header.get("workspace");
        // `sessionRoots`' candidates, in its order.
        let candidates = vec![
            cwd.to_owned(),
            text(header.get("cwd")),
            text(workspace.and_then(|w| w.get("projectPath"))),
            text(workspace.and_then(|w| w.get("worktreePath"))),
            text(header.get("desktopSession").and_then(|d| d.get("projectPath"))),
        ];
        let (data_dir, scopes, cwd, refs, surface) = (self.data_dir.clone(), self.scopes.clone(), cwd.to_owned(), refs.clone(), surface.to_owned());
        let found = self
            .lane
            .submit(&CancellationToken::new(), move |lane| {
                let options = Options { cwd, roots: session_roots(&candidates), scopes };
                let blobs = BlobStore::new(&data_dir);
                // `readAttachmentBuffer(id).length`: the stored bytes, verified against their address.
                let stored_len = |id: &str| blobs.read(lane, &Digest::try_from(format!("sha256:{id}")).ok()?).ok().map(|bytes| bytes.len() as u64);
                resolve_handoff_attachments(lane, &refs, &messages, &options, &surface, &stored_len, &|bytes| store_attachment(&blobs, lane, bytes))
            })
            .map_err(|error| format!("{error:?}"))?
            .await
            .map_err(|error| format!("{error:?}"))??;
        Ok(found.parts)
    }
}

/// The resolver, bound once the session directory exists (after the tool pool is built). Unbound, a call's `attachments`
/// are refused as unavailable.
#[derive(Default)]
pub struct LateAttachments(OnceLock<Arc<HandoffAttachments>>);

impl LateAttachments {
    pub fn bind(&self, attachments: Arc<HandoffAttachments>) -> Result<(), &'static str> {
        self.0.set(attachments).map_err(|_| "handoff attachments")
    }

    pub fn get(&self) -> Option<&Arc<HandoffAttachments>> {
        self.0.get()
    }
}

impl crate::run_host::late::Bound for LateAttachments {
    fn cell(&self) -> &'static str {
        "handoff attachments"
    }

    fn is_bound(&self) -> bool {
        self.0.get().is_some()
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    /// A conversation held in memory.
    struct Held(Vec<Value>);

    #[async_trait]
    impl CallerMessages for Held {
        async fn messages(&self, _: &ThreadId) -> Result<Vec<Value>, String> {
            Ok(self.0.clone())
        }
    }

    /// A project folder with two files and a folder beside it, written on the lane; the paths are the real ones.
    async fn tree() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let base = mixdog_workspace::pathguard::canonical(dir.path()).unwrap();
        let (root, other) = (base.join("proj"), base.join("other"));
        let (a, b) = (root.clone(), other.clone());
        let lane = mixdog_rt::testing::tokens().durability_io;
        let job = lane
            .submit(&CancellationToken::new(), move |lane| {
                mixdog_statefile::create_private_dir_all(lane, &a).unwrap();
                mixdog_statefile::create_private_dir_all(lane, &b).unwrap();
                mixdog_statefile::append_file(lane, &a.join("notes.md"), b"# notes\nhello\n").unwrap();
                mixdog_statefile::append_file(lane, &a.join("shot.png"), &[0x89, b'P', b'N', b'G']).unwrap();
                mixdog_statefile::append_file(lane, &b.join("outside.md"), b"outside\n").unwrap();
            })
            .unwrap();
        job.await.unwrap();
        (dir, root, other)
    }

    fn resolver(data_dir: PathBuf, messages: Vec<Value>) -> HandoffAttachments {
        HandoffAttachments { messages: Arc::new(Held(messages)), lane: mixdog_rt::testing::tokens().durability_io, data_dir, scopes: Vec::new() }
    }

    fn header(fields: Value) -> Header {
        serde_json::from_value(fields).unwrap()
    }

    /// A file of the caller's folder is stored and comes back as the reference part Node's `referencePart` builds; the
    /// stored bytes are the file's, under their content address in the attachment store.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_file_in_the_callers_folder_becomes_a_stored_reference_part() {
        let (dir, root, _) = tree().await;
        let data = dir.path().join("data");
        let attachments = resolver(data.clone(), Vec::new());
        let cwd = root.to_string_lossy().into_owned();
        let parts = attachments.resolve(&ThreadId::from("sess_a"), &Header::default(), &json!(["notes.md", "shot.png"]), &cwd, "session").await.unwrap();
        let notes = mixdog_store::blobs::digest_of(b"# notes\nhello\n").as_str().trim_start_matches("sha256:").to_owned();
        let shot = mixdog_store::blobs::digest_of(&[0x89, b'P', b'N', b'G']).as_str().trim_start_matches("sha256:").to_owned();
        assert_eq!(
            parts,
            vec![
                json!({ "type": "text", "textKind": "file", "attachmentRef": notes, "sizeBytes": 14, "mimeType": "text/markdown", "filename": "notes.md" }),
                json!({ "type": "image", "attachmentRef": shot, "sizeBytes": 4, "mimeType": "image/png", "filename": "shot.png" }),
            ]
        );
        let stored = data.join("prompt-attachments").join("sha256").join(&notes[..2]).join(&notes);
        assert_eq!(mixdog_statefile::read_content(&stored).unwrap().unwrap(), b"# notes\nhello\n");
        // What the forwarded prompt carries (`handoffContent`): the text, then the parts as they are.
        let content = mixdog_agent::agent_tool::flow::handoff::handoff_content("look", &parts);
        assert_eq!(content[0], json!({ "type": "text", "text": "look" }));
        assert_eq!(content.as_array().unwrap()[1..], parts[..]);
    }

    /// The folders are the caller's working directory and its session's own (`sessionRoots`): a file beside them is
    /// refused in Node's words, and is attached once the session's record names that folder.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn only_the_sessions_folders_are_read() {
        let (dir, root, other) = tree().await;
        let attachments = resolver(dir.path().join("data"), Vec::new());
        let cwd = root.to_string_lossy().into_owned();
        let outside = other.join("outside.md").to_string_lossy().into_owned();
        let thread = ThreadId::from("sess_a");
        assert_eq!(
            attachments.resolve(&thread, &Header::default(), &json!([outside]), &cwd, "agent").await,
            Err(format!("agent: attachment \"{outside}\" is outside this session's folders"))
        );
        for record in [
            json!({ "cwd": other.to_string_lossy() }),
            json!({ "workspace": { "projectPath": other.to_string_lossy() } }),
            json!({ "workspace": { "worktreePath": other.to_string_lossy() } }),
            json!({ "desktopSession": { "projectPath": other.to_string_lossy() } }),
        ] {
            let parts = attachments.resolve(&thread, &header(record.clone()), &json!([outside]), &cwd, "agent").await.unwrap();
            assert_eq!(parts[0]["filename"], "outside.md", "{record}");
        }
    }

    /// An attachment the conversation shows is forwarded by its id or its name without reading any file; an id the
    /// conversation does not show, and `attachments` of the wrong shape, are refused in Node's words.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_attachment_the_conversation_shows_is_forwarded_by_id_or_name() {
        let (dir, root, _) = tree().await;
        let data = dir.path().join("data");
        let cwd = root.to_string_lossy().into_owned();
        let thread = ThreadId::from("sess_a");
        // The user's upload is in the store, as the prompt intake left it.
        let lane = mixdog_rt::testing::tokens().durability_io;
        let at = data.clone();
        let id = lane.submit(&CancellationToken::new(), move |lane| store_attachment(&BlobStore::new(&at), lane, b"uploaded bytes")).unwrap().await.unwrap().unwrap();
        let upload = json!({
            "role": "user",
            "content": [{ "type": "text", "text": "see" }],
            "meta": { "transcript": { "attachments": [{ "id": id, "attachmentRef": id, "kind": "image", "name": "photo.png", "mimeType": "image/png", "size": 14 }] } },
        });
        let attachments = resolver(data.clone(), vec![upload]);
        let part = json!({ "type": "image", "attachmentRef": id, "sizeBytes": 14, "mimeType": "image/png", "filename": "photo.png" });
        assert_eq!(attachments.resolve(&thread, &Header::default(), &json!([id]), &cwd, "session").await.unwrap(), vec![part.clone()]);
        assert_eq!(attachments.resolve(&thread, &Header::default(), &json!(["photo.png"]), &cwd, "session").await.unwrap(), vec![part]);
        assert_eq!(attachments.resolve(&thread, &Header::default(), &Value::Null, &cwd, "session").await.unwrap(), Vec::<Value>::new());
        let unknown = "f".repeat(64);
        assert_eq!(
            attachments.resolve(&thread, &Header::default(), &json!([unknown]), &cwd, "session").await,
            Err(format!("session: attachment {unknown} is not in this conversation"))
        );
        assert_eq!(
            attachments.resolve(&thread, &Header::default(), &json!("photo.png"), &cwd, "agent").await,
            Err("agent: attachments must be a list of attachment ids or file paths".to_owned())
        );
        // Another conversation does not show it.
        let elsewhere = resolver(data, Vec::new());
        assert_eq!(
            elsewhere.resolve(&thread, &Header::default(), &json!([id]), &cwd, "session").await,
            Err(format!("session: attachment {id} is not in this conversation"))
        );
    }
}
