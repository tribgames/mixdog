//! A conversation's attachments by id: the desktop residual service's view of a session ([`DesktopAttachmentHost`], Node's
//! `session-attachments.ts` `AttachmentHost`) and, over the same reader, the blob domain's `attachment` transfer source
//! (`SessionAttachments::named`). One rule names them (`desktop_residual::session_attachments`, `transcript-file-links.ts`) over
//! the rows the transcript shows: the loaded thread's acked view is read first as the transcript window; a compaction or the
//! window's edge can leave an id only the session's whole stored history names, which is read next.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::ids::ThreadId;

use super::SessionDirectory;
use mixdog_core_domains::domains::desktop_residual::named_attachment;
use mixdog_core_ports::ports::domain_sessions::NamedAttachment;
use mixdog_core_ports::ports::domain_sessions::SessionAttachments;

/// A session's conversation and the attachment store.
pub struct DesktopAttachmentHost {
    directory: Arc<SessionDirectory>,
    store: mixdog_store::blobs::BlobStore,
    interactive: mixdog_rt::InteractiveIo,
}

impl DesktopAttachmentHost {
    pub fn new(directory: Arc<SessionDirectory>, store: mixdog_store::blobs::BlobStore, tokens: &mixdog_rt::LaneTokens) -> Self {
        Self { directory, store, interactive: tokens.interactive_io }
    }
}

#[async_trait]
impl mixdog_core_domains::domains::desktop_residual::AttachmentHost for DesktopAttachmentHost {
    async fn session_transcript(&self, session_id: &str) -> Option<serde_json::Value> {
        let handle = self.directory.handle(&ThreadId::from(session_id))?;
        let view = handle.cell.view.load_full();
        let rows: Vec<serde_json::Value> = view.items.iter().map(|item| super::reads::display_row(item)).collect();
        Some(serde_json::json!({ "items": rows }))
    }

    async fn session_history(&self, session_id: &str) -> Option<serde_json::Value> {
        let items = self.directory.history_items(&ThreadId::from(session_id)).await.ok()?;
        let rows: Vec<serde_json::Value> = items.iter().map(super::reads::display_row).collect();
        Some(serde_json::json!({ "items": rows }))
    }

    async fn attachment_bytes(&self, id: &str) -> Option<Vec<u8>> {
        use mixdog_store::blobs::BlobError;
        let digest = mixdog_store::schema::bounded::Digest::try_from(format!("sha256:{id}")).ok()?;
        let store = self.store.clone();
        let read = mixdog_core_base::support::on_lane(self.interactive, &tokio_util::sync::CancellationToken::new(), move |lane| match store.read(lane, &digest) {
            Ok(bytes) => Some(bytes),
            // A stored file that fails its hash is still handed over as stored: the caller's own integrity check names it `changed`.
            Err(BlobError::Corrupt { .. }) => std::fs::read(store.path(&digest)).ok(),
            Err(_) => None,
        })
        .await;
        read.ok().flatten()
    }
}

#[async_trait]
impl SessionAttachments for DesktopAttachmentHost {
    async fn named(&self, session_id: &str, id: &str) -> Option<NamedAttachment> {
        let found = named_attachment(self, session_id, id).await?;
        Some(NamedAttachment { name: Some(found.name), mime_type: Some(found.mime_type) })
    }
}

#[cfg(test)]
mod tests {
    use mixdog_core_domains::domains::desktop_residual::AttachmentHost;
    use mixdog_core_domains::domains::desktop_residual::session_attachments;
    use mixdog_store::schema::record::Record;
    use serde_json::Value;
    use serde_json::json;

    use super::*;
    use crate::session::testing::MemStore;
    use crate::session::testing::Rig;
    use crate::session::transcript::RecordTranscript;

    fn hex(c: char) -> String {
        c.to_string().repeat(64)
    }

    /// A user row carries its display text as its `prompt` fact.
    fn item(iid: &str, role: &str, body: Value) -> Record {
        let mut record = json!({
            "k": "item", "iid": iid, "form": "message", "model": true, "visible": true, "role": role,
            "refs": [], "body": { "inline": body },
        });
        if role == "user" {
            record["prompt"] = json!({ "inline": "look" });
        }
        serde_json::from_value(record).expect("item record")
    }

    fn attachment(id: &str, name: &str, mime: &str) -> Value {
        json!({ "id": id, "attachmentRef": id, "kind": "file", "name": name, "mimeType": mime, "size": 3 })
    }

    /// One stored message of each row kind `sessionAttachments` reads or skips. (A task
    /// report's files wait on its restored notice carrying them, `routineResultNotice`.)
    fn conversation() -> Vec<Record> {
        let (a, b, d, e, f) = (hex('a'), hex('b'), hex('d'), hex('e'), hex('f'));
        vec![
            // A prompt's files, and an image whose stored original is its `attachmentRef`.
            item("u1", "user", json!({
                "role": "user",
                "content": [{ "type": "text", "text": "look" }, { "type": "image", "attachmentRef": b, "mimeType": "image/jpeg" }],
                "meta": { "transcript": { "attachments": [attachment(&a, "notes.md", "text/markdown")] } },
            })),
            // A member's speech returns its files; a pass row names nothing.
            item("s1", "assistant", json!({
                "role": "assistant", "content": "here",
                "meta": { "source": "agent-room", "room": { "kind": "speech", "speaker": "scout" },
                          "transcript": { "messageId": "m1", "attachments": [attachment(&d, "chart.png", "image/png")] } },
            })),
            item("p1", "assistant", json!({
                "role": "assistant", "content": "",
                "meta": { "source": "agent-room", "room": { "kind": "pass", "speaker": "scout" },
                          "transcript": { "messageId": "m2", "attachments": [attachment(&e, "x.txt", "text/plain")] } },
            })),
            // An assistant's own text never names an attachment.
            item("a1", "assistant", json!({ "role": "assistant", "content": format!("see {f}") })),
        ]
    }

    fn host(directory: Arc<SessionDirectory>, data_dir: &std::path::Path) -> DesktopAttachmentHost {
        DesktopAttachmentHost::new(directory, mixdog_store::blobs::BlobStore::new(data_dir), &mixdog_rt::testing::tokens())
    }

    /// The host over a stored conversation of one session; the rig that owns its lanes is returned beside it, to be kept alive.
    async fn stored_conversation(data_dir: &std::path::Path) -> (Rig, DesktopAttachmentHost) {
        let rig = Rig::new();
        let store = Arc::new(MemStore::default());
        store.seed(&ThreadId::from("sess_att"), conversation());
        let mut deps = rig.deps_parts(store);
        deps.transcript = Arc::new(RecordTranscript::new());
        let host = host(Arc::new(SessionDirectory::new(Arc::new(deps))), data_dir);
        (rig, host)
    }

    /// `transcript-file-links.ts` `sessionAttachments` over the rows the transcript shows: a user row's files and its images, a
    /// member's speech's files; a pass row and an assistant's text name nothing.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn user_rows_and_member_speech_name_attachments() {
        let dir = tempfile::tempdir().expect("data dir");
        let (_rig, host) = stored_conversation(dir.path()).await;
        let snapshot = host.session_history("sess_att").await.expect("the stored history");
        let ids = ['a', 'b', 'd', 'e', 'f'].map(hex);
        let named: Vec<String> = session_attachments(&snapshot).into_iter().map(|attachment| attachment.id).collect();
        assert_eq!(named, vec![ids[0].clone(), ids[1].clone(), ids[2].clone()]);
        let notes = host.named("sess_att", &ids[0]).await.unwrap();
        assert_eq!((notes.name.as_deref(), notes.mime_type.as_deref()), (Some("notes.md"), Some("text/markdown")));
        // A restored image line: `{ name: 'image', mimeType: 'image/png' }` whatever it was.
        let image = host.named("sess_att", &ids[1]).await.unwrap();
        assert_eq!((image.name.as_deref(), image.mime_type.as_deref()), (Some("image"), Some("image/png")));
        assert!(host.named("sess_att", "A".repeat(64).as_str()).await.is_none(), "an id off the pattern names nothing");
    }

    /// `namedAttachment`: an id outside the window is found in the whole stored history; an id the conversation never named, or an
    /// unknown session, is not linked.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_history_names_what_the_window_does_not() {
        let dir = tempfile::tempdir().expect("data dir");
        let (_rig, host) = stored_conversation(dir.path()).await;
        assert!(host.session_transcript("sess_att").await.is_none(), "the session is not loaded: no window");
        let found = host.named("sess_att", &hex('d')).await.expect("named by the stored speech");
        assert_eq!((found.name.as_deref(), found.mime_type.as_deref()), (Some("chart.png"), Some("image/png")));
        assert!(host.named("sess_att", &hex('e')).await.is_none());
        assert!(host.named("sess_other", &hex('a')).await.is_none());
        assert!(host.session_history("sess_other").await.is_none());
    }

    /// The store's file by content hash is handed over as stored, a file that fails its hash included (the caller's own
    /// integrity check names it `changed`); a hash the store does not hold is `None`.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn attachment_bytes_come_from_the_store_by_content_hash() {
        let dir = tempfile::tempdir().expect("data dir");
        let (_rig, host) = stored_conversation(dir.path()).await;
        let id = hex('c');
        assert!(host.attachment_bytes(&id).await.is_none(), "nothing stored under this hash");
        let digest = mixdog_store::schema::bounded::Digest::try_from(format!("sha256:{id}")).expect("digest");
        let path = host.store.path(&digest);
        std::fs::create_dir_all(path.parent().expect("the store's folder")).expect("folder");
        std::fs::write(&path, b"not what the hash says").expect("stored file");
        assert_eq!(host.attachment_bytes(&id).await.as_deref(), Some(&b"not what the hash says"[..]));
        assert!(host.attachment_bytes("not a hash").await.is_none());
    }
}
