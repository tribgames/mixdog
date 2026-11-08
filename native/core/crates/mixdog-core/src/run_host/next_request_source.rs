//! The real [`NextMainRequest`]: the request a thread's next turn would send (Node `nextMainRequest`),
//! rebuilt by the turn's own assembly ([`HostRunParts::next_request`]) over the thread's live header,
//! tool surface and stored rows.
//!
//! The assembly belongs to the directory that owns the sessions, and the directory's dependencies (this
//! source is among them, through `SideQuestionService`) are built before it: the source is created empty
//! and [`build_directory`](super::boot::build_directory) binds it once, as it binds the seams.

use std::sync::{Arc, OnceLock, Weak};

use async_trait::async_trait;
use mixdog_core_api::domain::provider::{ModelRequest, Role};
use mixdog_core_api::ids::ThreadId;
use mixdog_core_session::session::SessionDirectory;
use mixdog_store::schema::record::Header;
use serde_json::Value;

use super::assemble::HostRunParts;
use super::side_question_store::{NextMainRequest, SideMaterial};

#[derive(Default)]
pub struct NextRequestSource {
    bound: OnceLock<(Weak<SessionDirectory>, Arc<HostRunParts>)>,
}

impl NextRequestSource {
    pub fn new() -> Arc<Self> {
        Arc::default()
    }

    /// The directory and the assembly it was bound to, for the other sources that read the same
    /// thread views ([`super::inheritance_fit`]).
    pub(crate) fn bound(&self) -> Option<&(Weak<SessionDirectory>, Arc<HostRunParts>)> {
        self.bound.get()
    }

    /// Bound exactly once, by the composition of the turn path.
    pub(crate) fn bind(&self, directory: Weak<SessionDirectory>, parts: Arc<HostRunParts>) {
        let _ = self.bound.set((directory, parts));
    }
}

impl NextRequestSource {
    /// The thread's header and the request its next turn would send.
    async fn rebuilt(&self, thread: &ThreadId) -> Option<(Arc<Header>, SideMaterial)> {
        let (directory, parts) = self.bound.get()?;
        let directory = directory.upgrade()?;
        let handle = directory.handle(thread)?;
        let header = handle.live_header().header();
        let surface = handle.surface().borrow().clone();
        let prior = directory.model_context(thread).read().await.ok()?;
        let (provider, request) = parts.next_request(thread, &header, &surface, prior, handle.thread_window()).await?;
        Some((header, SideMaterial { request, provider }))
    }

    /// `lastSentMainRequest`: what the cache warmer replays after a restart lost the in-memory
    /// request. The rebuilt next request (no tail reminder: the warm adds it, see
    /// `with_tail_reminder`) cut back to the last request that was sent, with its send time.
    pub async fn last_sent(&self, thread: &ThreadId) -> Option<LastSent> {
        let (header, material) = self.rebuilt(thread).await?;
        let (request, sent_at) = last_sent_of(material.request, &header)?;
        let text = |key: &str| header.get(key).and_then(Value::as_str).unwrap_or_default().to_owned();
        let owner = text("ownerSessionId");
        let parent = text("parentSessionId");
        Some(LastSent {
            material: SideMaterial { request, ..material },
            sent_at,
            provider_name: text("provider"),
            // `session.ownerSessionId || session.parentSessionId`.
            owner_session_id: [owner, parent].into_iter().find(|id| !id.is_empty()),
        })
    }

    /// The tail reminder text for `thread` and `model` from the thread's live header, read now:
    /// its response language and role are the session's as they are at this moment
    /// (`withTailReminder` reads the session object at each send).
    pub fn tail_text(&self, thread: &ThreadId, model: &str) -> Result<Option<String>, String> {
        let (directory, parts) = self.bound.get().ok_or("the session directory is not bound")?;
        let directory = directory.upgrade().ok_or("the session directory is gone")?;
        let handle = directory.handle(thread).ok_or_else(|| format!("thread {} is not loaded", thread.as_str()))?;
        let header = handle.live_header().header();
        Ok(parts.tail_reminder(&header).text(model))
    }
}

/// What `lastSentMainRequest` answers and the warm reads of it besides the request: the provider's
/// registered name and the ledger owner of the session.
pub struct LastSent {
    pub material: SideMaterial,
    pub sent_at: u64,
    pub provider_name: String,
    pub owner_session_id: Option<String>,
}

/// The part of `lastSentMainRequest` that follows the rebuild: the request without the reply the last
/// request produced (the trailing assistant messages), stamped with `Number(lastProviderSendAt)`.
/// `None` when the transcript does not end in such a reply (nothing was sent from it, or nothing
/// precedes it) or the thread has no positive send time.
pub fn last_sent_of(mut request: ModelRequest, header: &Header) -> Option<(ModelRequest, u64)> {
    let mut end = request.messages.len();
    while end > 0 && request.messages[end - 1].role == Role::Assistant {
        end -= 1;
    }
    if end == 0 || end == request.messages.len() {
        return None;
    }
    let sent_at = mixdog_js::to_number_of(header.get("lastProviderSendAt"));
    if !(sent_at > 0.0) {
        return None;
    }
    request.messages.truncate(end);
    Some((request, sent_at as u64))
}

#[async_trait]
impl NextMainRequest for NextRequestSource {
    async fn next(&self, thread: &ThreadId) -> Option<SideMaterial> {
        self.rebuilt(thread).await.map(|(_, material)| material)
    }
}

#[cfg(test)]
mod tests {
    use mixdog_core_api::domain::provider::{Content, Message, RequestOptions};
    use serde_json::Value;

    use super::*;

    /// `lastSentMainRequest` (`fixtures/last-sent/golden.json`, from the real Node function over
    /// stored session records): the cases the transcript's tail and the send time decide. The others
    /// (a closed or agent-owned session, no conversation, an unregistered provider) are decided
    /// by the rebuild itself, `HostRunParts::next_request`.
    #[test]
    fn the_last_sent_request_is_the_one_node_replays() {
        let golden: Value = serde_json::from_str(include_str!("../../../../fixtures/last-sent/golden.json")).expect("fixture");
        let mut answered = 0;
        for case in golden["cases"].as_array().expect("cases") {
            if case["decidedBy"] != "trim" {
                continue;
            }
            let name = case["name"].as_str().expect("name");
            let messages: Vec<Message> = case["messages"]
                .as_array()
                .expect("messages")
                .iter()
                .map(|m| {
                    let role = match m["role"].as_str().expect("role") {
                        "system" => Role::System,
                        "assistant" => Role::Assistant,
                        "tool" => Role::Tool,
                        _ => Role::User,
                    };
                    Message::new(role, Content::Text(m["content"].as_str().expect("content").to_owned()))
                })
                .collect();
            let request = ModelRequest { model: "claude-test".into(), messages, tools: Vec::new(), options: RequestOptions::default() };
            let mut header = Header::new();
            if !case["sendTime"].is_null() {
                header.insert("lastProviderSendAt".into(), case["sendTime"].clone());
            }
            let got = last_sent_of(request, &header);
            match (&case["answer"], got) {
                (Value::Null, None) => {}
                (answer, Some((kept, sent_at))) if !answer.is_null() => {
                    let want = answer["messages"].as_array().expect("answer messages");
                    assert_eq!(kept.messages.len(), want.len(), "{name}: kept messages");
                    for (got, want) in kept.messages.iter().zip(want) {
                        assert_eq!(got.content, Content::Text(want["content"].as_str().expect("content").to_owned()), "{name}: content");
                    }
                    assert_eq!(Some(sent_at as f64), answer["sentAt"].as_f64(), "{name}: sent at");
                    answered += 1;
                }
                (answer, got) => panic!("{name}: Node answers {answer}, Rust {:?}", got.map(|g| g.1)),
            }
        }
        assert!(answered >= 4, "the golden covers requests that are replayed");
    }
}