//! `SessionHandle`: what the rest of the core holds of a loaded thread. C0 control goes to
//! the control cell (RT-C, never waits), attach goes to the feed (RT-C, under the feed lock),
//! reads of the acked view need no actor, and mutations go through the actor's inbox.

use std::sync::Arc;
use std::sync::Weak;

use async_trait::async_trait;
use mixdog_app_protocol::v2::feed::ResumeWindow;
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
use mixdog_core_api::thread::Decision;
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
use mixdog_core_ports::ports::threads::Section;
use super::view::SnapshotParams;
use mixdog_core_base::approvals::Lineage;
use mixdog_core_ports::ports::gate::LiveHeader;

pub struct SessionHandle {
    pub(crate) id: ThreadId,
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

    /// `RequestThread.window`: `compaction.compactCount` of the acked header, 0 until the first
    /// compaction (`compactCount`, `store-summary-fields.mjs:70`: a safe non-negative integer).
    pub fn thread_window(&self) -> u64 {
        let header = self.cell.header.load();
        let count = header.get("compaction").and_then(|c| c.get("compactCount")).and_then(Value::as_u64);
        count.filter(|n| *n <= (1u64 << 53) - 1).unwrap_or(0)
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

    /// `turn/start` (`session-turns.mjs` `submitAdmitted`): the originals a composer staged for
    /// the message's images are claimed first, so staging limits can no longer take them; one
    /// that is gone (or cannot be claimed in time) is dropped from the message, leaving the
    /// resized copy. The claim and the enqueue are not interleaved with another send's.
    async fn turn_start(&self, mut req: CoreRequest) -> Result<Reply, CoreError> {
        // An admitted start (`admitted`, turn-gate.mjs): the idle-only delete refuses while one is
        // in its intake, and the thread refuses starts while that delete runs.
        let directory = self.directory.upgrade().ok_or_else(|| self.closing())?;
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
        let answer = Scope::new().cancel(&cancel).run(self.enqueue(req)).await.done().ok_or(mixdog_rt::GateCancelled).map_err(caller_cancelled)??;
        drop(in_order);
        answer.await.map_err(|_| self.closing())?
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
    async fn room_rows_append(&self, req: CoreRequest) -> Result<Reply, CoreError> {
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
        let fresh = super::room_log::fresh_rows(context.read().await?.iter().map(|(_, message)| message), messages);
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
        let append = CoreRequest {
            method: mixdog_core_api::ids::Method("thread/roomRows/commit"),
            params: json!({ "rows": rows }),
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
        let (base, mut header) = rx.await.map_err(|_| self.closing())??;
        let directory = self.directory.upgrade().ok_or_else(|| self.closing())?;
        // The desktop's `inheritSession` creates the heir where the source's Project is (or in the task workspace) with a
        // fresh classification, never in the source's worktree; an inherit into an existing thread keeps that thread's place.
        if params.into_thread_id.is_none() {
            heir_place(&directory.deps, &mut header).await?;
        }
        header.insert(
            "inheritedFromSessionId".into(),
            Value::String(self.id.as_str().to_owned()),
        );
        let created = directory
            .create(CreateSpec {
                id: params.into_thread_id,
                header,
                base: Some(base),
                op: req.op.clone(),
                method: req.method,
                params: req.params.clone(),
                seed: None,
            })
            .await?;
        let summary = created.cell.view.load_full().summary.clone();
        Ok(Reply::Value(json!({ "thread": summary })))
    }
}

/// `inheritSession` (`session-host-lifecycle.ts:968-978`): `resolveSessionWorkspace(sessionProjectPath(source))`. The source's
/// Project is the deepest registered one holding its stored Project, folder or workspace (`sessionProjectKey`); the heir takes
/// that Project as `cwd` and `{project, projectPath}`, or the task workspace and `{task, null}`, and no `workspace` record.
/// Only a source the desktop classified is moved: a thread of another client keeps its header.
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
    fn interrupt(&self, turn: &TurnId) -> Result<Value, CoreError> {
        self.cell.interrupt(turn)
    }

    /// R10: the input names the queued entry to steer (`{queuedId}`).
    fn steer(&self, expected_turn: &TurnId, input: Value, _op: OpId) -> Result<Value, CoreError> {
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

#[async_trait]
impl ThreadHandle for SessionHandle {
    fn id(&self) -> &ThreadId {
        &self.id
    }

    async fn request(&self, req: CoreRequest) -> Result<Reply, CoreError> {
        match req.method.as_str() {
            "thread/resume" => self.resume(&req),
            "thread/read" => self.read(&req).await,
            "thread/fork" => self.fork(req).await,
            "turn/start" => self.turn_start(req).await,
            "thread/delete" => self.delete(&req).await,
            "thread/revertTurnReview" => self.revert_turn_review(&req, false).await,
            "thread/revertTurnReviewFile" => self.revert_turn_review(&req, true).await,
            "thread/reactions/set" if !matches!(req.ctx.caller, Caller::Connection(_)) => self.reactions_set(req).await,
            "thread/roomRows/append" if !matches!(req.ctx.caller, Caller::Connection(_)) => self.room_rows_append(req).await,
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
