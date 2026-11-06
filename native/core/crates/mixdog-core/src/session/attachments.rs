//! A conversation's attachments by id, for the blob domain's `attachment` transfer source:
//! Node's `namedAttachment` (`apps/desktop/src/main/session-attachments.ts`) over
//! `sessionAttachments` (`transcript-file-links.ts`). The transcript window (a loaded thread's
//! acked view) is read first; a compaction or the window's edge can leave an id only the
//! session's whole stored history names, which is read next.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::ids::ThreadId;
use mixdog_protocol::RoomRowKind;
use mixdog_protocol::ThreadItem;

use super::SessionDirectory;
use crate::domains::blob::NamedAttachment;
use crate::domains::blob::SessionAttachments;

pub struct SessionAttachmentLinks {
    directory: Arc<SessionDirectory>,
}

impl SessionAttachmentLinks {
    pub fn new(directory: Arc<SessionDirectory>) -> Self {
        Self { directory }
    }
}

/// `ATTACHMENT_ID`: `/^[a-f0-9]{64}$/`.
fn attachment_id(id: &str) -> bool {
    id.len() == 64 && id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// `sessionAttachments(snapshot).get(id)`: the first row that names `id`, in transcript order.
/// User rows carry their attachments, their images' `attachmentRef` and their restored
/// `imageRefs`; a task report and a member's room speech carry the files they returned.
/// Nothing else in a transcript names an attachment the host serves.
pub(crate) fn named_in<'a>(items: impl IntoIterator<Item = &'a ThreadItem>, id: &str) -> Option<NamedAttachment> {
    if !attachment_id(id) {
        return None;
    }
    let named = |name: &str, mime_type: &str| NamedAttachment { name: Some(name.to_owned()), mime_type: Some(mime_type.to_owned()) };
    for item in items {
        match item {
            // A user row, and a routine notice shown as one: only a task report carries files.
            ThreadItem::UserMessage { details, .. } => {
                if let Some(found) = details.attachments.iter().find(|a| a.id == id) {
                    return Some(named(&found.name, &found.mime_type));
                }
                if let Some(image) = details.images.iter().find(|i| i.attachment_ref.as_deref() == Some(id)) {
                    return Some(named(&image.name, &image.mime_type));
                }
                if details.image_refs.iter().any(|slot| slot.reference.as_deref() == Some(id)) {
                    return Some(named("image", "image/png"));
                }
            }
            ThreadItem::RoomRow { room, attachments, images, .. } if matches!(room.kind, RoomRowKind::User | RoomRowKind::Speech) => {
                if let Some(found) = attachments.iter().find(|a| a.id == id) {
                    return Some(named(&found.name, &found.mime_type));
                }
                if let Some(image) = images.iter().find(|i| i.attachment_ref.as_deref() == Some(id)) {
                    return Some(named(&image.name, &image.mime_type));
                }
            }
            _ => {}
        }
    }
    None
}

#[async_trait]
impl SessionAttachments for SessionAttachmentLinks {
    async fn named(&self, session_id: &str, id: &str) -> Option<NamedAttachment> {
        let thread = ThreadId::from(session_id);
        let window = self.directory.handle(&thread).map(|handle| handle.cell.view.load_full());
        if let Some(found) = window.as_ref().and_then(|view| named_in(view.items.iter().map(Arc::as_ref), id)) {
            return Some(found);
        }
        // An unknown or unreadable session names nothing (`readSessionHistory` → null).
        let history = self.directory.history_items(&thread).await.ok()?;
        named_in(&history, id)
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use mixdog_store::schema::record::Record;
    use serde_json::Value;
    use serde_json::json;

    use super::*;
    use crate::session::Transcript;
    use crate::session::seams::Shown;
    use crate::session::testing::MemStore;
    use crate::session::testing::Rig;
    use crate::session::transcript::RecordTranscript;

    /// The ids of `ids` some row of `items` names.
    fn census(items: &[ThreadItem], ids: &[&str]) -> HashSet<String> {
        ids.iter().filter(|id| named_in(items, id).is_some()).map(|id| (*id).to_owned()).collect()
    }

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

    async fn projected(records: Vec<Record>) -> Vec<ThreadItem> {
        use mixdog_rt::LaneToken as _;
        let tokens = mixdog_rt::testing::tokens();
        let job = tokens.cpu_interactive.submit(&mixdog_rt::CancellationToken::new(), move |lane| {
            records
                .iter()
                .filter_map(|r| if let Record::Item(item) = r { Some(item) } else { None })
                .flat_map(|record| RecordTranscript::new().items(lane, record))
                .filter_map(|shown| if let Shown::Item(item) = shown { Some(item) } else { None })
                .collect::<Vec<_>>()
        });
        job.expect("cpu lane").await.expect("projected")
    }

    /// `transcript-file-links.ts` `sessionAttachments` over the rows the transcript shows.
    #[tokio::test]
    async fn user_rows_and_member_speech_name_attachments() {
        let items = projected(conversation()).await;
        let ids = ['a', 'b', 'd', 'e', 'f'].map(hex);
        let named = census(&items, &ids.iter().map(String::as_str).collect::<Vec<_>>());
        let want: HashSet<String> = [&ids[0], &ids[1], &ids[2]].into_iter().cloned().collect();
        assert_eq!(named, want);
        let notes = named_in(&items, &ids[0]).unwrap();
        assert_eq!((notes.name.as_deref(), notes.mime_type.as_deref()), (Some("notes.md"), Some("text/markdown")));
        // A restored image line: `{ name: 'image', mimeType: 'image/png' }` whatever it was.
        let image = named_in(&items, &ids[1]).unwrap();
        assert_eq!((image.name.as_deref(), image.mime_type.as_deref()), (Some("image"), Some("image/png")));
        assert!(named_in(&items, "A".repeat(64).as_str()).is_none(), "an id off the pattern names nothing");
    }

    /// `namedAttachment`: an id outside the window is found in the whole stored history; an
    /// id the conversation never named, or an unknown session, is not linked.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_history_names_what_the_window_does_not() {
        let rig = Rig::new();
        let store = Arc::new(MemStore::default());
        let thread = ThreadId::from("sess_att");
        store.seed(&thread, conversation());
        let mut deps = rig.deps_parts(store);
        deps.transcript = Arc::new(RecordTranscript::new());
        let directory = Arc::new(SessionDirectory::new(Arc::new(deps)));
        let links = SessionAttachmentLinks::new(directory);
        let found = links.named("sess_att", &hex('d')).await.expect("named by the stored speech");
        assert_eq!((found.name.as_deref(), found.mime_type.as_deref()), (Some("chart.png"), Some("image/png")));
        assert!(links.named("sess_att", &hex('e')).await.is_none());
        assert!(links.named("sess_other", &hex('a')).await.is_none());
    }
}
