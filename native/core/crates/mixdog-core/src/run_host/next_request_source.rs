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
        // Read as one load with the rows: the request carries the generation of the history it was built from.
        let generation = directory.deps().cache_tail.generation(thread.as_str(), header.get("cacheTailBook"));
        let prior = directory.model_context(thread).read().await.ok()?;
        let (provider, request) = parts.next_request(thread, &header, &surface, (prior, generation)).await?;
        Some((header, SideMaterial { request: Arc::new(request), provider }))
    }

    /// `lastSentMainRequest`: what the cache warmer replays after a restart lost the in-memory
    /// request. The rebuilt next request (no tail reminder: the warm adds it, see
    /// `with_tail_reminder`) cut back to the last request that was sent, with its send time.
    pub async fn last_sent(&self, thread: &ThreadId) -> Option<LastSent> {
        let (header, material) = self.rebuilt(thread).await?;
        // The kept request is the sent one without its tail reminder.
        let (request, sent_at) = last_sent_of(mixdog_agent::without_tail_reminder(&material.request), &header)?;
        let text = |key: &str| header.get(key).and_then(Value::as_str).unwrap_or_default().to_owned();
        let owner = text("ownerSessionId");
        let parent = text("parentSessionId");
        Some(LastSent {
            material: SideMaterial { request: Arc::new(request), ..material },
            sent_at,
            provider_name: text("provider"),
            // `session.ownerSessionId || session.parentSessionId`.
            owner_session_id: [owner, parent].into_iter().find(|id| !id.is_empty()),
        })
    }

    /// The provider request the thread's next send would carry, as `tools/toolsStatus` with `snapshot` reads it
    /// ([`super::request_snapshot::snapshot`]). Node has no such call; the request it builds without sending is
    /// `nextMainRequest` (`session/side-question.mjs:64-99`), which composes nothing: `null` for a thread with no user
    /// conversation, an agent's or one whose provider is not available, otherwise the stored header and transcript as
    /// they are (no turn-start reconcile, no tail reminder), with the boundary's tool snapshot. So is this: it reads the
    /// live header, surface and rows and writes nothing. `user_message`, which Node has no counterpart of, is appended
    /// to the rebuilt transcript.
    pub async fn request_snapshot(&self, thread: &ThreadId, user_message: Option<&str>) -> Result<Value, String> {
        let (directory, parts) = self.bound.get().ok_or("the session directory is not bound")?;
        let directory = directory.upgrade().ok_or("the session directory is gone")?;
        let handle = directory.handle(thread).ok_or_else(|| format!("thread {} is not loaded", thread.as_str()))?;
        let header = handle.live_header().header();
        let surface = handle.surface().borrow().clone();
        let generation = directory.deps().cache_tail.generation(thread.as_str(), header.get("cacheTailBook"));
        let prior = directory.model_context(thread).read().await.map_err(|_| "the thread's rows could not be read".to_owned())?;
        match parts.snapshot_request(thread, &header, &surface, (prior, generation), user_message).await {
            Some((provider, request)) => super::request_snapshot::snapshot(&header, &*provider, &request),
            None => Ok(Value::Null),
        }
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
    if sent_at.partial_cmp(&0.0) != Some(std::cmp::Ordering::Greater) {
        return None;
    }
    request.messages.truncate(end);
    Some((request, sent_at as u64))
}

#[async_trait]
impl mixdog_core_ports::ports::tools_status::RequestSnapshots for NextRequestSource {
    async fn snapshot(&self, thread: &ThreadId, user_message: Option<&str>) -> Result<Value, mixdog_core_api::CoreError> {
        self.request_snapshot(thread, user_message).await.map_err(|reason| mixdog_core_base::support::failed("tools", reason))
    }
}

#[async_trait]
impl NextMainRequest for NextRequestSource {
    async fn next(&self, thread: &ThreadId) -> Option<SideMaterial> {
        self.rebuilt(thread).await.map(|(_, material)| material)
    }

    async fn compact(&self, thread: &ThreadId) -> Result<(), String> {
        use mixdog_core_api::ThreadHandle as _;
        let (directory, _) = self.bound.get().ok_or("the session directory is not bound")?;
        let directory = directory.upgrade().ok_or("the session directory is gone")?;
        let handle = directory.handle(thread).ok_or_else(|| format!("thread {} is not loaded", thread.as_str()))?;
        let op = format!("side-compact-{}", uuid::Uuid::new_v4());
        let request = mixdog_core_api::CoreRequest {
            method: mixdog_core_api::ids::Method("thread/compact/start"),
            // Decided by the session at the moment it would start: refused once anything else runs there.
            params: serde_json::json!({ "threadId": thread.as_str(), "opId": op, "options": { "idleOnly": true } }),
            op: Some(mixdog_core_api::ids::OpId::from(op.as_str())),
            ctx: mixdog_core_api::call::CallContext::internal("side-question"),
        };
        match handle.request(request).await {
            // No compactor for the session (no context window): nothing was compacted.
            Ok(mixdog_core_api::Reply::Value(serde_json::Value::Null)) => Err("the transcript could not be compacted".to_owned()),
            // Refused at its start: a turn or another compaction runs on the session now.
            Ok(mixdog_core_api::Reply::Value(answer)) if answer.get("changed") == Some(&serde_json::Value::Bool(false)) && answer.get("reason").is_some() => {
                Err(answer.get("reason").and_then(serde_json::Value::as_str).unwrap_or("the session is busy").to_owned())
            }
            Ok(_) => Ok(()),
            Err(error) => Err(error.to_string()),
        }
    }
}

#[cfg(test)]
mod tests {}
