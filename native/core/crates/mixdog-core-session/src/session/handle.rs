//! `SessionHandle`: what the rest of the core holds of a loaded thread. C0 control goes to
//! the control cell (RT-C, never waits), attach goes to the feed (RT-C, under the feed lock),
//! reads of the acked view need no actor, and mutations go through the actor's inbox.

use std::sync::Arc;
use std::sync::Weak;

use async_trait::async_trait;
use mixdog_app_protocol::v2::feed::ResumeWindow;
use mixdog_app_protocol::v2::thread::ThreadClearParams;
use mixdog_app_protocol::v2::thread::ThreadForkParams;
use mixdog_app_protocol::v2::thread::ThreadResumeParams;
use mixdog_core_api::CoreError;
use mixdog_core_api::Feed;
use mixdog_core_api::FeedSource;
use mixdog_core_api::Reply;
use mixdog_core_api::RunControl;
use mixdog_core_api::ThreadHandle;
use mixdog_core_api::call::Caller;
use mixdog_core_api::call::CoreRequest;
use mixdog_core_api::call::Subscribe;
use mixdog_core_api::feed::AttachDecision;
use mixdog_core_api::feed::AttachRequest;
use mixdog_core_api::feed::FeedPosition;
use mixdog_core_api::feed::ResumeFrom;
use mixdog_core_api::feed::Window;
use mixdog_core_api::ids::FeedId;
use mixdog_core_api::ids::OpId;
use mixdog_core_api::ids::QueuedId;
use mixdog_core_api::ids::SubscriptionId;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_api::ids::TurnId;
use mixdog_core_api::call::CallContext;
use mixdog_core_api::ids::Method;
use mixdog_core_api::thread::Decision;
use mixdog_core_api::thread::Stop;
use mixdog_core_api::thread::stop_reply;
use mixdog_core_base::support::on_lane;
use mixdog_rt::LaneToken;
use mixdog_rt::Scope;
use mixdog_tools::policy::SessionSurface;
use serde_json::Value;
use serde_json::json;
use tokio::sync::mpsc;
use tokio::sync::oneshot;
use tokio::sync::watch;

use super::SessionDeps;
use super::actor::Inbox;
use super::control::ControlCell;
use super::control::Ctl;
use super::directory::CreateSpec;
use super::directory::DirInner;
use super::run::ProducerMsg;
use super::state::Queued;
use super::stop;
use mixdog_core_ports::ports::threads::Section;
use super::view::SnapshotParams;
use mixdog_core_base::approvals::Lineage;
use mixdog_core_ports::ports::gate::LiveHeader;

pub struct SessionHandle {
    pub(crate) id: ThreadId,
    /// The desktop's control session: the kind its `session` record carries (`SessionRecord::control`), set by a control
    /// start's create and read back by every open. A fork's heir is created without it.
    pub(crate) control: bool,
    pub(crate) cell: Arc<ControlCell>,
    pub(crate) feed: Arc<dyn Feed>,
    pub(crate) inbox: mpsc::Sender<Inbox>,
    pub(crate) producers: mpsc::Sender<ProducerMsg>,
    pub(crate) lineage: Lineage,
    pub(crate) deps: Arc<SessionDeps>,
    pub(crate) directory: Weak<DirInner>,
    /// One room post (`thread/roomRows/append`) or `thread/reactions/set` at a time, in
    /// order (`agent-room-delivery.mjs` `serialized`): each reads the conversation, then
    /// writes it.
    pub(crate) reactions: mixdog_rt::Gate,
    /// Sends reach the actor in the order they arrive, though one first claims its staged
    /// originals (session-turns.mjs keeps the claim synchronous so a later send cannot
    /// overtake an earlier one).
    pub(crate) submits: mixdog_rt::Gate,
    /// The order threads were loaded in (the order of Node's `_liveSessions` Map, which lists
    /// sessions in the order they entered it).
    pub(crate) loaded_seq: u64,
}

/// A caller's cancel ended a wait on one of the handle's gates or on the actor.
fn caller_cancelled(_: mixdog_rt::GateCancelled) -> CoreError {
    CoreError::Cancelled { by: "caller".into() }
}

fn window_of(window: &ResumeWindow) -> Window {
    match window {
        ResumeWindow::LastItems { last_items } => Window::LastItems(*last_items),
        ResumeWindow::LastTurns { last_turns } => Window::LastTurns(*last_turns),
        ResumeWindow::None { .. } => Window::HeaderOnly,
    }
}

impl SessionHandle {
    /// Woken after every step of this thread's actor: what a test waits on instead of the clock.
    #[cfg(any(test, feature = "test-support"))]
    pub fn stepped(&self) -> &tokio::sync::Notify {
        &self.cell.stepped
    }

    /// The actor's `turn_busy()` after its last step: a next turn is queued while it holds.
    #[cfg(any(test, feature = "test-support"))]
    pub fn turn_busy(&self) -> bool {
        self.cell.busy.load(std::sync::atomic::Ordering::SeqCst)
    }

    fn closing(&self) -> CoreError {
        CoreError::ThreadClosing {
            thread_id: self.id.clone(),
        }
    }

    /// Where this thread's server requests are shown (P §8.3).
    pub fn lineage(&self) -> &Lineage {
        &self.lineage
    }

    /// Publishes a section of the thread projection from its owning domain (P §5.1). Waits
    /// for producer-lane capacity, which the actor grants while its outbox has room.
    pub async fn set_section(&self, section: Section) -> Result<(), CoreError> {
        self.producers
            .send(ProducerMsg::Section(section))
            .await
            .map_err(|_| self.closing())
    }

    /// The user's "Retry storage" for a thread in `storage: indeterminate` (SM §8).
    pub fn retry_storage(&self) -> Result<(), CoreError> {
        self.cell.ctl_tx.try_send(Ctl::RetryStorage).map_err(|_| CoreError::QueueFull {
            queue: "control".into(),
        })
    }

    /// Today's `explicitSessionCwd()` inside this session's scope: its cwd, else
    /// `MIXDOG_SESSION_CWD`, else `<data>/user-cwd.txt`.
    pub async fn explicit_cwd(&self) -> Result<Option<String>, CoreError> {
        let header = self.cell.header.load_full();
        let scoped = header.get("cwd").and_then(Value::as_str);
        self.deps.user_cwd.explicit_cwd(scoped).await
    }

    /// Today's `readLastSessionCwd(keyPid)`.
    pub async fn last_cwd(&self, key_pid: Option<&str>) -> Result<Option<String>, CoreError> {
        self.deps.user_cwd.last_cwd(key_pid).await
    }

    /// The session's latest acked header, as a snapshot.
    pub fn header_snapshot(&self) -> Arc<mixdog_store::schema::record::Header> {
        self.cell.header.load_full()
    }

    /// The messages of the session's current turn transcript, as a snapshot.
    pub fn turn_messages_snapshot(&self) -> Arc<Vec<Value>> {
        self.cell.turn_messages.borrow().clone()
    }

    /// The session's latest acked header (`SessionGate`'s `LiveHeader`).
    pub fn live_header(&self) -> Arc<dyn LiveHeader> {
        self.cell.clone()
    }

    /// `!!controller && !controller.signal.aborted`: a turn is running and its signal is not aborted.
    pub fn controller_live(&self) -> bool {
        self.cell.run.load().as_ref().is_some_and(|run| !run.cancel.is_aborted())
    }

    /// The session's "Allow for this session" grants (`SessionGate`'s `session_grants`).
    pub fn grants(&self) -> Arc<mixdog_tools::policy::SessionGrants> {
        self.cell.grants.clone()
    }

    /// The session's tool-policy surface, republished by the actor whenever it changes.
    pub fn surface(&self) -> watch::Receiver<Arc<SessionSurface>> {
        self.cell.surface.clone()
    }

    /// A tool-policy input outside the thread changed: the actor re-derives the surface.
    pub fn refresh_surface(&self) -> Result<(), CoreError> {
        self.cell.ctl_tx.try_send(Ctl::RefreshSurface).map_err(|_| CoreError::QueueFull {
            queue: "control".into(),
        })
    }

    /// The session's cwd was applied (`applyResolvedCwd`), the same folder again or a new one
    /// (`changed`): the actor schedules the code-graph warm.
    pub fn cwd_applied(&self, changed: bool) -> Result<(), CoreError> {
        self.cell.ctl_tx.try_send(Ctl::CwdApplied { changed }).map_err(|_| CoreError::QueueFull {
            queue: "control".into(),
        })
    }

    /// Puts the request in the actor's inbox; the receiver answers once the actor has.
    async fn enqueue(&self, req: CoreRequest) -> Result<oneshot::Receiver<Result<Reply, CoreError>>, CoreError> {
        let (tx, rx) = oneshot::channel();
        let connection = matches!(req.ctx.caller, Caller::Connection(_));
        let msg = Inbox::Request { req, tx };
        if connection {
            self.inbox.try_send(msg).map_err(|error| match error {
                mpsc::error::TrySendError::Full(_) => CoreError::QueueFull {
                    queue: "inbox".into(),
                },
                mpsc::error::TrySendError::Closed(_) => self.closing(),
            })?;
        } else {
            self.inbox.send(msg).await.map_err(|_| self.closing())?;
        }
        Ok(rx)
    }

    /// A call on the thread scope's op store, answered by the actor.
    pub(crate) async fn op_call(&self, call: super::thread_ops::OpCall) -> Result<Reply, CoreError> {
        let (tx, rx) = oneshot::channel();
        self.inbox.send(Inbox::Op { call, tx }).await.map_err(|_| self.closing())?;
        rx.await.map_err(|_| self.closing())?
    }

    async fn to_actor(&self, req: CoreRequest) -> Result<Reply, CoreError> {
        self.enqueue(req).await?.await.map_err(|_| self.closing())?
    }

    /// `to_actor` for a caller that holds a gate: the request's cancel ends the wait on a full
    /// inbox or a silent actor, so the gate is never held past it.
    async fn to_actor_cancellable(&self, req: CoreRequest) -> Result<Reply, CoreError> {
        let cancel = req.ctx.cancel.clone();
        Scope::new().cancel(&cancel).run(self.to_actor(req)).await.done().ok_or(mixdog_rt::GateCancelled).map_err(caller_cancelled)?
    }

    /// `createCurrentSession` for this thread when it has no session yet.
    async fn create_session(&self) -> Result<(), CoreError> {
        let directory = self.directory.upgrade().ok_or_else(|| self.closing())?;
        super::SessionDirectory::over(directory).seat_session(&self.id).await
    }

    /// `turn/start` (`session-turns.mjs` `submitAdmitted`): the originals a composer staged for
    /// the message's images are claimed first, so staging limits can no longer take them; one
    /// that is gone (or cannot be claimed in time) is dropped from the message, leaving the
    /// resized copy. The claim and the enqueue are not interleaved with another send's.
    async fn turn_start(&self, mut req: CoreRequest) -> Result<Reply, CoreError> {
        // An admitted start (`admitted`, turn-gate.mjs): the idle-only delete refuses while one is
        // in its intake, and the thread refuses starts while that delete runs.
        let directory = self.directory.upgrade().ok_or_else(|| self.closing())?;
        // A turn is a session's first use (`createCurrentSession('turn')`, `turn-prepare.mjs`).
        self.create_session().await?;
        let _admitted = directory.gate().enter(&self.id).ok_or_else(|| self.closing())?;
        let cancel = req.ctx.cancel.clone();
        let in_order = self.submits.enter(&cancel).await.map_err(caller_cancelled)?;
        let named = super::staged_originals::named_originals(&req.params);
        if !named.is_empty() {
            let originals = self.deps.staged_originals.clone();
            // A claim that cannot run claims nothing, as a throw inside `claimStagedOriginals` does.
            let claimed = on_lane(self.deps.lanes.durability, &req.ctx.cancel, move |lane| originals.claim(lane, &named)).await.unwrap_or_default();
            super::staged_originals::drop_lost_originals(&mut req.params, &claimed);
        }
        // A full inbox must not hold the gate past the caller's cancel.
        // A session whose thread has ended takes nothing (drain-enqueue.mjs:27, admission 	erminal): Node answers a refused submit alse.
        let closed = || mixdog_core_base::support::coded("session", super::actor::SUBMIT_REFUSED, "The session is closed.");
        let answer = Scope::new().cancel(&cancel).run(self.enqueue(req)).await.done().ok_or(mixdog_rt::GateCancelled).map_err(caller_cancelled)?.map_err(|error| if matches!(error, CoreError::ThreadClosing { .. }) { closed() } else { error })?;
        drop(in_order);
        answer.await.map_err(|_| closed())?
    }

    fn resume(&self, req: &CoreRequest) -> Result<Reply, CoreError> {
        let params: ThreadResumeParams =
            serde_json::from_value(req.params.clone()).map_err(|_| CoreError::InvalidParams {
                path: "params".into(),
                expected: "ThreadResumeParams".into(),
            })?;
        let window = window_of(&params.window);
        let resume_from = params.resume_from.map(|from| ResumeFrom {
            position: FeedPosition {
                epoch: from.epoch,
                seq: from.seq,
            },
            window: window_of(&from.window),
        });
        let view = self.cell.view.load_full();
        let feed: Arc<dyn FeedSource> = self.feed.clone();
        Ok(Reply::Subscribe(Subscribe {
            result: json!({ "thread": view.summary }),
            feed,
            window,
            resume_from,
        }))
    }

    /// `thread/read`: the acked view, encoded on cpu-interactive (it can be a 2 MiB window).
    async fn read(&self, req: &CoreRequest) -> Result<Reply, CoreError> {
        let view = self.cell.view.load_full();
        let job = self
            .deps
            .lanes
            .cpu
            .submit(&req.ctx.cancel, move |_lane| {
                serde_json::to_value(SnapshotParams {
                    thread: &view.summary,
                    state: &view.state,
                    items: view.items.iter().map(|item| item.as_ref()).collect(),
                    has_older: view.has_older,
                })
                .expect("protocol types serialize")
            })?;
        job.await.map(Reply::Value).map_err(|_| CoreError::ConnectionClosed)
    }

    /// `thread/reactions/set {agentId, emoji, messagesBack?, othersKeep?}`: a bot's reaction
    /// (`emoji` null removes it) on the user message `messagesBack` user messages before the
    /// newest in the conversation (`reactInSession`), stored on that message and shown at once.
    /// Answers `{changed, messageId, reactions}`; no such message, or an emoji another bot already
    /// left in a room, is a domain error carrying Node's text. Internal callers only.
    async fn reactions_set(&self, req: CoreRequest) -> Result<Reply, CoreError> {
        let params = &req.params;
        let invalid = |path: &str, expected: &str| CoreError::InvalidParams { path: path.into(), expected: expected.into() };
        let agent_id = params.get("agentId").and_then(Value::as_str).ok_or_else(|| invalid("agentId", "a bot id"))?;
        let emoji = match params.get("emoji") {
            None | Some(Value::Null) => "",
            Some(Value::String(emoji)) => emoji,
            Some(_) => return Err(invalid("emoji", "an emoji or null")),
        };
        let messages_back = match params.get("messagesBack") {
            None | Some(Value::Null) => 0,
            Some(back) => back.as_u64().ok_or_else(|| invalid("messagesBack", "a count"))?,
        };
        let others_keep = params.get("othersKeep").and_then(Value::as_bool).unwrap_or(false);
        let _one_at_a_time = self.reactions.enter(&req.ctx.cancel).await.map_err(caller_cancelled)?;
        let context = super::run::ModelContext {
            store: self.deps.store.clone(),
            lanes: self.deps.lanes,
            thread: self.id.clone(),
            input: mixdog_core_api::ids::ItemId::from(String::new()),
        };
        let (ids, messages): (Vec<_>, Vec<_>) = context.read().await?.into_iter().unzip();
        let change = super::message_reactions::Change {
            agent_id,
            emoji,
            messages_back,
            others_keep,
            at: self.deps.clock.now_ms(),
        };
        let done = super::message_reactions::react_to_message(&messages, &change).map_err(|message| CoreError::DomainError {
            domain: "session".into(),
            code: None,
            message: Some(message.into()),
            detail: None,
        })?;
        let mut reply = json!({ "changed": done.changed, "messageId": done.message_id, "reactions": done.reactions });
        let Some(message) = done.message else {
            return Ok(Reply::Value(reply));
        };
        let iid = ids[done.index].as_str().to_owned();
        let (store, thread) = (self.deps.store.clone(), self.id.clone());
        let found = self.deps.lanes.io.submit(&req.ctx.cancel, {
            let iid = iid.clone();
            move |lane| store.history_row(lane, &thread, &iid)
        })?;
        let dropped = || CoreError::Internal { incident_id: "session-reaction-job-dropped".into() };
        let (_, mut row) = found.await.map_err(|_| dropped())??.ok_or_else(|| CoreError::ItemNotFound {
            thread_id: self.id.clone(),
            item_id: ids[done.index].clone(),
        })?;
        row.body = mixdog_store::schema::blob::Slot::Inline(message.clone());
        let transcript = self.deps.transcript.clone();
        let shown = self.deps.lanes.cpu.submit(&req.ctx.cancel, {
            let row = row.clone();
            move |lane| transcript.items(lane, &row)
        })?;
        // Only the lines that carry reactions are re-shown; a row's other items are unchanged.
        let items: Vec<mixdog_protocol::ThreadItem> = shown
            .await
            .map_err(|_| dropped())?
            .into_iter()
            .filter_map(|shown| match shown {
                super::seams::Shown::Item(
                    item @ (mixdog_protocol::ThreadItem::UserMessage { .. } | mixdog_protocol::ThreadItem::RoomRow { .. }),
                ) => Some(item),
                _ => None,
            })
            .collect();
        let apply = json!({
            "iid": iid,
            "refs": row.refs,
            "body": message,
            "turn": row.turn.as_ref().map(|turn| turn.as_str()),
            "items": items,
        });
        self.to_actor_cancellable(CoreRequest { method: mixdog_core_api::ids::Method("thread/reactions/apply"), params: apply, op: None, ctx: req.ctx }).await?;
        reply["changed"] = Value::Bool(true);
        Ok(Reply::Value(reply))
    }

    /// `thread/roomRows/append {messages}`: a room post (`agent-room-delivery.mjs` `commit`). A
    /// message whose `meta.transcript.messageId` the conversation already holds, or an earlier
    /// message of the post carries, is skipped; the rest are stored as rows of no turn, each
    /// shown live as it lands. Answers `{added}`. Internal callers only.
    async fn room_rows_append(&self, req: CoreRequest, dedupe: bool) -> Result<Reply, CoreError> {
        let messages = req.params.get("messages").and_then(Value::as_array).cloned().ok_or_else(|| CoreError::InvalidParams {
            path: "messages".into(),
            expected: "the room row messages".into(),
        })?;
        let _one_at_a_time = self.reactions.enter(&req.ctx.cancel).await.map_err(caller_cancelled)?;
        let context = super::run::ModelContext {
            store: self.deps.store.clone(),
            lanes: self.deps.lanes,
            thread: self.id.clone(),
            input: mixdog_core_api::ids::ItemId::from(String::new()),
        };
        // An inheritance carries the source's messages whole (`target.messages.push(...)`): none is judged held.
        let fresh = if dedupe { super::room_log::fresh_rows(context.read().await?.iter().map(|(_, message)| message), messages) } else { messages };
        if fresh.is_empty() {
            return Ok(Reply::Value(json!({ "added": 0 })));
        }
        // Each row's facts read the prompt-attachment store: an io-lane job.
        let store = self.deps.attachments.clone();
        let read = self.deps.lanes.io.submit(&req.ctx.cancel, move |lane| {
            fresh
                .into_iter()
                .map(|mut body| {
                    let facts = store.facts(lane, &mut body);
                    json!({ "body": body, "visible": facts.visible, "prompt": facts.prompt })
                })
                .collect::<Vec<Value>>()
        })?;
        let rows = read.await.map_err(|_| CoreError::Internal { incident_id: "session-room-facts-dropped".into() })?;
        let set = req.params.get("set").cloned().unwrap_or(Value::Null);
        let unset = req.params.get("unset").cloned().unwrap_or(Value::Null);
        let append = CoreRequest {
            method: mixdog_core_api::ids::Method("thread/roomRows/commit"),
            params: json!({ "rows": rows, "set": set, "unset": unset }),
            op: None,
            ctx: req.ctx,
        };
        self.to_actor_cancellable(append).await
    }

    /// `thread/revertTurnReview {checkpointId?}` / `thread/revertTurnReviewFile {file, checkpointId?}`:
    /// the session runtime's `revertTurnReview(getCwd(), getSessionId(), ...)`. A refusal is a domain
    /// error carrying Node's message.
    async fn revert_turn_review(&self, req: &CoreRequest, file: bool) -> Result<Reply, CoreError> {
        use mixdog_app_protocol::v2::params::ThreadRevertTurnReviewFileParams;
        use mixdog_app_protocol::v2::params::ThreadRevertTurnReviewParams;
        let invalid = |expected: &str| CoreError::InvalidParams { path: "params".into(), expected: expected.into() };
        let (file, checkpoint) = if file {
            let p: ThreadRevertTurnReviewFileParams = serde_json::from_value(req.params.clone()).map_err(|_| invalid("ThreadRevertTurnReviewFileParams"))?;
            (Some(p.file), p.checkpoint_id)
        } else {
            let p: ThreadRevertTurnReviewParams = serde_json::from_value(req.params.clone()).map_err(|_| invalid("ThreadRevertTurnReviewParams"))?;
            (None, p.checkpoint_id)
        };
        // An unrun cwd read is an error, not "no cwd": the review would revert in the wrong place.
        let cwd = self.explicit_cwd().await?.unwrap_or_default();
        let checkpoint = checkpoint.unwrap_or_default();
        let review = &self.deps.turn_review;
        let done = match file {
            Some(file) => review.revert_turn_review_file(&cwd, self.id.as_str(), &file, &checkpoint).await,
            None => review.revert_turn_review(&cwd, self.id.as_str(), &checkpoint).await,
        };
        done.map(|reply| Reply::Value(Value::Object(reply))).map_err(|error| CoreError::DomainError {
            domain: "turnReview".into(),
            code: None,
            message: Some(error.message.into()),
            detail: None,
        })
    }

    /// `thread/delete`: `deleteSession` (`true` once the session is gone, `false` when nothing
    /// was deleted), or with `ifIdle` the desktop's `deleteSessionIfIdle` (`{deleted, reason?}`).
    async fn delete(&self, req: &CoreRequest) -> Result<Reply, CoreError> {
        let directory = self.directory.upgrade().ok_or_else(|| self.closing())?;
        super::delete::serve(&directory, &req.params).await
    }

    /// `thread/fork`: a new thread whose history continues this one's acked lineage.
    async fn fork(&self, req: CoreRequest) -> Result<Reply, CoreError> {
        let params: ThreadForkParams =
            serde_json::from_value(req.params.clone()).map_err(|_| CoreError::InvalidParams {
                path: "params".into(),
                expected: "ThreadForkParams".into(),
            })?;
        let (tx, rx) = oneshot::channel();
        self.inbox
            .send(Inbox::ForkPlan { tx })
            .await
            .map_err(|_| self.closing())?;
        let (_base, mut header) = rx.await.map_err(|_| self.closing())??;
        let directory = self.directory.upgrade().ok_or_else(|| self.closing())?;
        if let Some(heir) = &params.into_thread_id {
            let heirs = super::SessionDirectory::over(directory.clone());
            if heirs.try_stored_header(heir).await?.is_some() {
                return heirs.carry_into(&self.id, heir, params.compact == Some(true)).await;
            }
        }
        // The desktop's `inheritSession` creates the heir where the source's Project is (or in the task workspace) with a
        // fresh classification, never in the source's worktree; an inherit into an existing thread keeps that thread's place.
        if params.into_thread_id.is_none() {
            heir_place(&directory.deps, &mut header).await?;
        }
        // The heir owns a Codex wire identity of its own: Node's cold heir drops the source's and mints one (`cold-heir.mjs:70`,
        // `:143` `ensureCodexWireSessionId`), so the two sessions never share a `session_id` on the wire.
        header.shift_remove("codexWireSessionId");
        if header.get("provider").and_then(Value::as_str) == Some("openai-oauth") {
            header.insert("codexWireSessionId".into(), Value::String(uuid::Uuid::now_v7().to_string()));
        }
        header.insert(
            "inheritedFromSessionId".into(),
            Value::String(self.id.as_str().to_owned()),
        );
        // The heir is a session of its own: Node stamps its creation, not the source's times.
        fresh_heir_state(&mut header);
        let now = json!(directory.deps.clock.now_ms());
        for key in ["createdAt", "updatedAt", "lastUsedAt"] {
            header.insert(key.into(), now.clone());
        }
        let created = directory
            .create(CreateSpec {
                id: params.into_thread_id,
                header,
                base: None,
                op: req.op.clone(),
                method: req.method,
                params: req.params.clone(),
                seed: None,
                settings: None,
                starting: None,
            })
            .await?;
        // The heir's prompt is composed for the heir (`createSession`: its scratch directory, tools and workflow), never the
        // source's text; `carryConversation` carries the conversation only ("System blocks belong to the session that BUILT them").
        directory.deps.empty_surface.refresh_empty(&created.id).await.map_err(|message| mixdog_core_base::support::failed("session", message))?;
        // `inheritFrom` (`lifecycle/inheritance.mjs`): the heir is a created, empty session and the source's conversation is
        // carried into it with its inheritance boundary, as an `intoThreadId` heir's is.
        let heirs = super::SessionDirectory::over(directory.clone());
        heirs.carry_into(&self.id, &created.id, params.compact == Some(true)).await
    }

    /// `thread/clear`. With `rebuildPrompt` (an agent chat's reset, `session-ops.mjs clear`) it is refused while a turn runs, and
    /// the emptied thread's prompt and tool surface are composed again from the current rules as a new thread's are; the answer
    /// is `{ promptRebuilt }`, whether that was applied.
    async fn clear(&self, req: CoreRequest) -> Result<Reply, CoreError> {
        let params: ThreadClearParams =
            serde_json::from_value(req.params.clone()).map_err(|_| CoreError::InvalidParams {
                path: "params".into(),
                expected: "ThreadClearParams".into(),
            })?;
        let rebuild = params.rebuild_prompt == Some(true);
        if rebuild && self.cell.run.load().is_some() {
            return Err(mixdog_core_base::support::failed("session", "The session is running a turn; wait for it to finish."));
        }
        // `runtime.clear` answers false without a session, which the host turns into this refusal for a rebuilding reset
        // (`session-reset.mjs`: `result === false && (archiveAs || reset.rebuildPrompt)`).
        if rebuild {
            let directory = self.directory.upgrade().ok_or_else(|| self.closing())?;
            if !super::SessionDirectory::over(directory).holds_session(&self.id).await? {
                return Err(mixdog_core_base::support::failed("session", "The conversation could not be cleared."));
            }
        }
        let reply = self.to_actor(req).await?;
        if !rebuild {
            return Ok(reply);
        }
        let directory = self.directory.upgrade().ok_or_else(|| self.closing())?;
        let rebuilt = directory
            .deps
            .empty_surface
            .refresh_empty(&self.id)
            .await
            .map_err(|message| mixdog_core_base::support::failed("session", message))?;
        Ok(Reply::Value(json!({ "promptRebuilt": rebuilt })))
    }
}

/// `inheritSession` (`session-host-lifecycle.ts:968-978`): `resolveSessionWorkspace(sessionProjectPath(source))`. The source's
/// Project is the deepest registered one holding its stored Project, folder or workspace (`sessionProjectKey`); the heir takes
/// that Project as `cwd` and `{project, projectPath}`, or the task workspace and `{task, null}`, and no `workspace` record.
/// Only a source the desktop classified is moved: a thread of another client keeps its header.
/// A heir is a session of its own, created fresh and given the source's conversation (`createSession` then `inheritFrom`): it
/// holds none of what the source measured or ran. Its usage totals start at zero, its context readings, step list, close
/// provenance, transcript identity and the source's own name and title are not carried (the carry gives the heir the source's title), and its compaction is the configuration alone, without the source's checks.
fn fresh_heir_state(header: &mut mixdog_store::schema::record::Header) {
    const COMPACTION_CONFIG: [&str; 9] = ["auto", "model", "summaryModel", "timeoutMs", "memoryTimeoutMs", "bufferTokens", "mainBufferTokens", "reservedTokens", "boundaryTokens"];
    // A copy still being made into the source is the source's; the heir's own reference set is given by the carry.
    const NOT_CARRIED: [&str; 44] = [
        "offloadInheriting", "offloadInheritingBoot",
        "bp3Cursor", "closeProvenance", "lastCacheWriteTokens", "lastCachedReadTokens", "lastContextTokens", "lastContextTokensStaleAfterCompact",
        "lastContextTokensUpdatedAt", "lastInputTokens", "lastIterationIndex", "lastOutputTokens", "lastProviderSendAt", "lastTurnCompletedAt",
        "lastUncachedInputTokens", "reasoningUsage", "titleUpdatedAt", "todo", "todoCheck", "totalCacheWriteTokens", "totalCachedReadTokens",
        "totalUncachedInputTokens", "transcriptEpoch", "turnBotChain", "turnCoverage", "pendingGoalReminder",
        "goalReminderRevision", "goalStalledNotice", "contextUsageSnapshot", "turnHop", "usageMetricsTurnId", "usageReadout",
        "archivedAt", "favoriteAt", "name", "title", "titleLocked", "titleSource", "importOrigin", "codexWireSessionId", "detachedReason", "sessionVisibility", "task_id", "taskId",
    ];
    for key in NOT_CARRIED {
        header.shift_remove(key);
    }
    header.retain(|key, _| !key.starts_with("contextPressureBaseline"));
    // `ensureCodexWireSessionId`: the heir's own wire id on an `openai-oauth` route, none on any other.
    let wire = if header.get("provider").and_then(Value::as_str) == Some("openai-oauth") { json!(uuid::Uuid::now_v7().to_string()) } else { Value::Null };
    header.insert("codexWireSessionId".into(), wire);
    for key in ["totalInputTokens", "totalOutputTokens", "totalToolCalls", "tokensCumulative"] {
        header.insert(key.into(), json!(0));
    }
    if let Some(Value::Object(compaction)) = header.get_mut("compaction") {
        compaction.retain(|key, _| COMPACTION_CONFIG.contains(&key.as_str()));
        // The overrides a turn resolved (the source's buffer reads 0) are the source's: the heir starts from its configuration, unset.
        for key in ["bufferTokens", "mainBufferTokens", "reservedTokens"] {
            if compaction.contains_key(key) {
                compaction.insert(key.into(), Value::Null);
            }
        }
    }
}

async fn heir_place(deps: &SessionDeps, header: &mut mixdog_store::schema::record::Header) -> Result<(), CoreError> {
    use super::thread_settings::project_identity;
    use super::thread_settings::session_project_key;
    let source = Value::Object(header.clone());
    if !source.get("desktopSession").is_some_and(Value::is_object) {
        return Ok(());
    }
    let registered = deps.new_place.projects().await.map_err(|message| mixdog_core_base::support::failed("session", message))?;
    let keys: Vec<String> = registered.iter().map(|path| project_identity(Some(path))).collect();
    let stored = (source.pointer("/desktopSession/classification") == Some(&json!("project"))).then(|| source.pointer("/desktopSession/projectPath").cloned()).flatten();
    let key = session_project_key(&json!({ "projectPath": stored, "cwd": source.get("cwd"), "workspace": source.get("workspace") }), &keys);
    let project = registered.iter().find(|path| !key.is_empty() && project_identity(Some(path)) == key);
    match project {
        Some(path) => {
            header.insert("cwd".into(), json!(path));
            header.insert("desktopSession".into(), json!({ "classification": "project", "projectPath": path }));
        }
        None => {
            let folder = deps.task_workspace.path().await.map_err(|message| mixdog_core_base::support::failed("session", message))?;
            header.insert("cwd".into(), json!(folder));
            header.insert("desktopSession".into(), json!({ "classification": "task", "projectPath": null }));
        }
    }
    header.shift_remove("workspace");
    Ok(())
}

impl FeedSource for SessionHandle {
    fn feed_id(&self) -> FeedId {
        self.feed.feed_id()
    }

    fn attach(&self, req: AttachRequest) -> Result<AttachDecision, CoreError> {
        if !self.cell.subscribing() {
            return Err(self.closing());
        }
        let decision = self.feed.attach(req);
        self.cell.subscribed(decision.is_ok());
        decision
    }

    fn detach(&self, sub: SubscriptionId) {
        self.feed.detach(sub);
        self.cell.unsubscribed();
    }
}

impl RunControl for SessionHandle {
    fn interrupt(&self, turn: &TurnId, restore_prompt: Option<bool>) -> Result<Value, CoreError> {
        self.cell.interrupt(turn, restore_prompt)
    }

    /// R10: the input names the queued entry to steer (`{queuedId}`).
    fn steer(&self, expected_turn: Option<&TurnId>, input: Value, _op: OpId) -> Result<Value, CoreError> {
        let queued = input
            .get("queuedId")
            .and_then(Value::as_str)
            .ok_or_else(|| CoreError::InvalidParams {
                path: "queuedId".into(),
                expected: "a queued entry id".into(),
            })?;
        self.cell.steer(expected_turn, QueuedId::from(queued))
    }

    fn active_turn(&self) -> Option<TurnId> {
        self.cell.run.load_full().map(|run| run.turn.clone())
    }

    fn decide(&self, decision: Decision) -> Result<(), CoreError> {
        // An answer resumes the turn: an admitted start (`approveSession`, session-turns.mjs).
        let directory = self.directory.upgrade().ok_or_else(|| self.closing())?;
        let _admitted = directory.gate().enter(&self.id).ok_or_else(|| self.closing())?;
        self.cell.decide(decision)
    }
}

impl SessionHandle {
    /// [`RunControl::decide`] whose caller is told whether its decision resolved the request (`ControlCell::decide_arbitrated`): the
    /// answer of a phone notification's button and of a room, which Node gave only after the session's serialized resolution.
    pub(crate) async fn decide_arbitrated(&self, decision: Decision) -> Result<bool, CoreError> {
        let directory = self.directory.upgrade().ok_or_else(|| self.closing())?;
        let _admitted = directory.gate().enter(&self.id).ok_or_else(|| self.closing())?;
        self.cell.decide_arbitrated(decision).await
    }
}

impl SessionHandle {
    /// `abort` while nothing runs (`reclaimIdleSubmission`, `abort.mjs:84`): the queued submission the client names is handed
    /// back to its composer (`restoreQueued('', submissionId)`); naming none, or one that is not queued, stops nothing.
    async fn stop_idle(&self, submission: Option<String>, ctx: CallContext) -> Result<Value, CoreError> {
        let nothing = || Ok(stop_reply(None, false));
        let Some(submission) = submission.filter(|id| !id.is_empty()) else {
            return nothing();
        };
        let queued = self
            .cell
            .queue
            .load()
            .iter()
            .find(|queued| queued.entry.pointer("/options/clientSubmissionId").and_then(Value::as_str) == Some(submission.as_str()))
            .map(|queued| queued.qid.clone());
        let Some(qid) = queued else {
            return nothing();
        };
        let Reply::Value(restored) = self
            .request(CoreRequest {
                method: Method("thread/queue/delete"),
                params: json!({ "threadId": self.id, "opId": format!("stop:{}", super::new_id()), "queuedId": qid, "restore": true }),
                op: None,
                ctx,
            })
            .await?
        else {
            return nothing();
        };
        if restored["count"].as_u64().unwrap_or(0) == 0 {
            return nothing();
        }
        let mut reply = stop_reply(None, false);
        reply["restoreText"] = restored["text"].clone();
        reply["pastedImages"] = restored["pastedImages"].clone();
        reply["pastedTexts"] = restored["pastedTexts"].clone();
        reply["restoredSubmissionIds"] = json!([submission]);
        for key in ["content", "notice"] {
            if let Some(value) = restored.get(key) {
                reply[key] = value.clone();
            }
        }
        Ok(reply)
    }
}

#[async_trait]
impl ThreadHandle for SessionHandle {
    fn id(&self) -> &ThreadId {
        &self.id
    }

    /// Node's `abortSession` over the run's prompt (`abort.mjs`): see [`super::stop`].
    async fn stop(&self, request: Stop) -> Result<Value, CoreError> {
        let Stop { turn: named, restore_prompt, submission_id, ctx } = request;
        let named_turn = named.is_some();
        let run = match (named, self.cell.run.load_full()) {
            (Some(turn), Some(run)) if run.turn == turn => run,
            (Some(turn), _) => return Err(CoreError::TurnNotActive { thread_id: self.id.clone(), turn_id: Some(turn) }),
            (None, Some(run)) => run,
            (None, None) => return self.stop_idle(submission_id, ctx).await,
        };
        let canceller = match &ctx.caller {
            Caller::Connection(connection) => self.deps.devices.describe(*connection).device,
            Caller::Internal(_) => String::new(),
        };
        let facts = run.prompt.snapshot();
        let steering = self.cell.queue.load().iter().any(|queued| super::control::is_editable_entry(&queued.entry));
        // A handed-back prompt's attachments are read before the turn is stopped, so a read that fails keeps the prompt
        // (`hydrateTolerantly`). A prompt with none reads nothing and the stop is not delayed.
        let mut restored = None;
        let mut unreadable = None;
        if stop::wants_restore(&facts, restore_prompt, &canceller, steering) && facts.has_attachments() {
            let queued = Queued { qid: String::new(), entry: facts.entry.clone(), display: Value::Null };
            let raw = super::actor::restored_reply(&[super::actor::Taken::of(&queued)], None);
            let store = self.deps.attachments.clone();
            let read = on_lane(self.deps.lanes.io, &mixdog_rt::CancellationToken::new(), move |lane| super::restore_hydrate::hydrate(&store, lane, raw)).await;
            match read {
                Ok(Ok(hydrated)) => restored = Some(hydrated),
                Ok(Err(error)) | Err(error) => unreadable = Some(error.to_string()),
            }
        }
        let decision = stop::decide(&facts, restore_prompt, &canceller, steering, unreadable.is_some());
        // The hand-back is recorded first: the actor reads it when the turn ends, which this abort may bring at once.
        run.prompt.record(decision.reclaim.clone());
        let name = match decision.reason {
            stop::Reason::Interrupt => "interrupt",
            stop::Reason::KeepPrompt => "user-cancel-keep-prompt",
            stop::Reason::UserCancel => mixdog_agent::cancel::CLI_ABORT,
        };
        if let Err(error) = self.cell.abort(&run.turn, &mixdog_agent::cancel::Abort::runtime_abort(self.id.as_str(), name)) {
            run.prompt.record(None);
            return if named_turn { Err(error) } else { Ok(stop_reply(None, false)) };
        }
        let mut reply = stop_reply(Some(&run.turn), true);
        reply["restoreText"] = json!(decision.restore_text);
        reply["restoredSubmissionIds"] = json!(decision.restored_ids);
        if let Some(restored) = &restored {
            for key in ["pastedImages", "pastedTexts", "content", "notice"] {
                if let Some(value) = restored.get(key) {
                    reply[key] = value.clone();
                }
            }
        }
        if let Some(message) = unreadable {
            reply["notice"] = json!(format!("Could not restore the attachments ({message}); the prompt was kept."));
        }
        for (key, pointer, discard) in [("discardPastedImages", "/options/pastedImages", decision.discard_images), ("discardPastedTexts", "/options/pastedTexts", decision.discard_texts)] {
            if discard {
                reply[key] = facts.entry.pointer(pointer).cloned().unwrap_or(Value::Null);
            }
        }
        Ok(reply)
    }

    async fn request(&self, req: CoreRequest) -> Result<Reply, CoreError> {
        match req.method.as_str() {
            "thread/resume" => self.resume(&req),
            "thread/read" => self.read(&req).await,
            "thread/clear" => self.clear(req).await,
            "thread/fork" => self.fork(req).await,
            "turn/start" => self.turn_start(req).await,
            // `goalControl` makes the session when there is none (`createCurrentSession('goal')`).
            "thread/goal/set" | "thread/goal/clear" | "thread/goal/control" => {
                self.create_session().await?;
                self.to_actor(req).await
            }
            "thread/delete" => self.delete(&req).await,
            "thread/revertTurnReview" => self.revert_turn_review(&req, false).await,
            "thread/revertTurnReviewFile" => self.revert_turn_review(&req, true).await,
            "thread/reactions/set" if !matches!(req.ctx.caller, Caller::Connection(_)) => self.reactions_set(req).await,
            "thread/roomRows/append" if !matches!(req.ctx.caller, Caller::Connection(_)) => self.room_rows_append(req, true).await,
            "thread/inheritedRows/append" if !matches!(req.ctx.caller, Caller::Connection(_)) => self.room_rows_append(req, false).await,
            // The acked header, for the core's own ports; never a connection's read.
            "thread/header/read" if !matches!(req.ctx.caller, Caller::Connection(_)) => {
                Ok(Reply::Value(json!({ "header": *self.cell.header.load_full() })))
            }
            // The model conversation as acked (`session.messages`), for the core's own ports.
            "thread/messages/read" if !matches!(req.ctx.caller, Caller::Connection(_)) => {
                let context = super::run::ModelContext {
                    store: self.deps.store.clone(),
                    lanes: self.deps.lanes,
                    thread: self.id.clone(),
                    input: mixdog_core_api::ids::ItemId::from(String::new()),
                };
                let messages: Vec<serde_json::Value> = context.read().await?.into_iter().map(|(_, message)| message).collect();
                Ok(Reply::Value(json!({ "messages": messages })))
            }
            // `restoreQueued` gives the entries' attachments back with their bytes: the actor answers the
            // references, read here on the interactive lane (the actor never touches the store).
            "thread/queue/delete" if req.params.get("restore") == Some(&serde_json::Value::Bool(true)) => {
                let Reply::Value(raw) = self.to_actor(req).await? else {
                    return Err(CoreError::InvalidParams { path: "reply".into(), expected: "a value".into() });
                };
                let store = self.deps.attachments.clone();
                let hydrated = mixdog_core_base::support::on_lane(self.deps.lanes.io, &mixdog_rt::CancellationToken::new(), move |lane| {
                    super::restore_hydrate::hydrate(&store, lane, raw)
                })
                .await??;
                Ok(Reply::Value(hydrated))
            }
            _ => self.to_actor(req).await,
        }
    }
}
