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
use mixdog_app_protocol::v2::thread::ThreadRewindParams;
use mixdog_core_api::CoreError;
use mixdog_core_api::Feed;
use mixdog_core_api::FeedSource;
use mixdog_core_api::Reply;
use mixdog_core_api::RunControl;
use mixdog_core_api::ThreadHandle;
use mixdog_core_api::call::CallContext;
use mixdog_core_api::call::Caller;
use mixdog_core_api::call::CoreRequest;
use mixdog_core_api::call::Subscribe;
use mixdog_core_api::feed::AttachDecision;
use mixdog_core_api::feed::AttachRequest;
use mixdog_core_api::feed::AttachStart;
use mixdog_core_api::feed::FeedPosition;
use mixdog_core_api::feed::ResumeFrom;
use mixdog_core_api::feed::Window;
use mixdog_core_api::ids::FeedId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::ids::OpId;
use mixdog_core_api::ids::QueuedId;
use mixdog_core_api::ids::SubscriptionId;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_api::ids::TurnId;
use mixdog_core_api::thread::Decision;
use mixdog_core_api::thread::Stop;
use mixdog_core_api::thread::stop_reply;
use mixdog_core_base::support::on_lane;
use mixdog_core_base::support::on_lane_wait;
use mixdog_rt::Scope;
use mixdog_tools::policy::SessionSurface;
use serde_json::Value;
use serde_json::json;
use tokio::sync::mpsc;
use tokio::sync::oneshot;
use tokio::sync::watch;

use super::SessionDeps;
use super::actor::ForkSource;
use super::actor::HistoryRevision;
use super::actor::Inbox;
use super::actor::RewindPreview;
use super::control::ControlCell;
use super::control::Ctl;
use super::directory::CreateSpec;
use super::directory::DirInner;
use super::prompt_submission::LaneAttachments;
use super::prompt_submission::LongText;
use super::prompt_submission::NoStore;
use super::prompt_submission::Submission;
use super::prompt_submission::materialize_prompt_submission;
use super::prompt_submission::touches_store;
use super::run::ProducerMsg;
use super::state::Queued;
use super::stop;
use super::view::SnapshotParams;
use mixdog_core_base::approvals::Lineage;
use mixdog_core_ports::ports::gate::LiveHeader;
use mixdog_core_ports::ports::threads::Section;

pub struct SessionHandle {
    pub(crate) id: ThreadId,
    /// The desktop's control session: the kind its `session` record carries (`SessionRecord::control`), set by a control
    /// start's create and read back by every open. A fork's heir is created without it.
    pub(crate) control: bool,
    pub(crate) cell: Arc<ControlCell>,
    #[allow(dead_code, reason = "Retain the handle-owned feed and its existing crate-internal replay access rather than change ownership or field layout")]
    pub(crate) feed: Arc<dyn Feed>,
    /// The thread feed as a subscriber attaches to it: what the subscribing replies (`thread/start`, `thread/resume`) hand out.
    pub(crate) subscriptions: Arc<CountedFeed>,
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
    /// Whether the images a restored history holds all have a verdict yet (open for a new session).
    pub image_gate: Arc<super::image_gate::ImageGate>,
    /// The order threads were loaded in (the order of Node's `_liveSessions` Map, which lists
    /// sessions in the order they entered it).
    pub(crate) loaded_seq: u64,
}

/// A caller's cancel ended a wait on one of the handle's gates or on the actor.
fn caller_cancelled(_: mixdog_rt::GateCancelled) -> CoreError {
    CoreError::Cancelled { by: "caller".into() }
}

/// How long [SessionHandle::model_messages] waits for the context's row count before it reads the whole conversation.
const TAIL_COUNT_WAIT: std::time::Duration = std::time::Duration::from_millis(250);

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
    /// The published view's items, oldest first, then the in-progress ones.
    #[cfg(any(test, feature = "test-support"))]
    pub fn view_items(&self) -> Arc<[Arc<mixdog_protocol::ThreadItem>]> {
        self.cell.view.load_full().items.clone()
    }
    /// The actor's `turn_busy()` after its last step: a next turn is queued while it holds.
    #[cfg(any(test, feature = "test-support"))]
    pub fn turn_busy(&self) -> bool {
        self.cell.busy.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// Node's `getSessionProgressSnapshot(id)?.stage`: the stage of the thread's runtime entry, `None` before the first
    /// marker and once a settled turn's entry is evicted.
    #[cfg(any(test, feature = "test-support"))]
    pub fn runtime_stage(&self) -> Option<String> {
        self.cell.progress.borrow().stage()
    }

    /// The open-time recovery of the runs the last process died in is done and its records are released.
    #[cfg(any(test, feature = "test-support"))]
    pub fn recovered(&self) -> bool {
        self.cell.recovered.load(std::sync::atomic::Ordering::SeqCst)
    }

    fn closing(&self) -> CoreError {
        CoreError::ThreadClosing { thread_id: self.id.clone() }
    }

    /// Where this thread's server requests are shown (P §8.3).
    pub fn lineage(&self) -> &Lineage {
        &self.lineage
    }

    /// Publishes a section of the thread projection from its owning domain (P §5.1). Waits
    /// for producer-lane capacity, which the actor grants while its outbox has room.
    pub async fn set_section(&self, section: Section) -> Result<(), CoreError> {
        self.producers.send(ProducerMsg::Section(section)).await.map_err(|_| self.closing())
    }

    /// The user's "Retry storage" for a thread in `storage: indeterminate` (SM §8).
    pub fn retry_storage(&self) -> Result<(), CoreError> {
        self.cell.ctl_tx.try_send(Ctl::RetryStorage).map_err(|_| CoreError::QueueFull { queue: "control".into() })
    }

    /// Today's `explicitSessionCwd()` inside this session's scope: its cwd, else
    /// `MIXDOG_SESSION_CWD`, else `<data>/user-cwd.txt`.
    pub async fn explicit_cwd(&self) -> Result<Option<String>, CoreError> {
        let header = self.cell.header.load_full();
        let scoped = header.get("cwd").and_then(Value::as_str);
        self.deps.user_cwd.explicit_cwd(scoped).await
    }

    /// Today's `captureOriginalUserCwd()` inside this session's scope: the explicit cwd, then
    /// `MIXDOG_PROJECT_DIR`, then the process cwd. Relative paths and the prompt's env cwd resolve here.
    pub async fn captured_cwd(&self) -> Result<Option<String>, CoreError> {
        let header = self.cell.header.load_full();
        let scoped = header.get("cwd").and_then(Value::as_str);
        self.deps.user_cwd.captured_cwd(scoped).await
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
        self.cell.ctl_tx.try_send(Ctl::RefreshSurface).map_err(|_| CoreError::QueueFull { queue: "control".into() })
    }

    /// The session's cwd was applied (`applyResolvedCwd`), the same folder again or a new one
    /// (`changed`): the actor schedules the code-graph warm.
    pub fn cwd_applied(&self, changed: bool) -> Result<(), CoreError> {
        self.cell.ctl_tx.try_send(Ctl::CwdApplied { changed }).map_err(|_| CoreError::QueueFull { queue: "control".into() })
    }

    /// Puts the request in the actor's inbox; the receiver answers once the actor has.
    async fn enqueue(&self, req: CoreRequest) -> Result<oneshot::Receiver<Result<Reply, CoreError>>, CoreError> {
        let (tx, rx) = oneshot::channel();
        let connection = matches!(req.ctx.caller, Caller::Connection(_));
        let msg = Inbox::Request { req, tx };
        if connection {
            self.inbox.try_send(msg).map_err(|error| match error {
                mpsc::error::TrySendError::Full(_) => CoreError::QueueFull { queue: "inbox".into() },
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
        let method = req.method;
        self.enqueue(req).await?.await.map_err(|_| {
            tracing::warn!(thread = %self.id, %method, "the session actor dropped the request's reply without answering it");
            self.closing()
        })?
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

    async fn take_in_prompt(&self, req: &mut CoreRequest, cancel: &mixdog_rt::CancellationToken) -> Result<(), CoreError> {
        let Some(input) = req.params.get("input").filter(|input| input.is_object()) else { return Ok(()) };
        let (prompt, options) = (input.get("prompt").cloned(), input.get("options").cloned().unwrap_or(Value::Null));
        let Some(prompt) = prompt else { return Ok(()) };
        let long_text = LongText::Inline;
        let taken = if touches_store(&prompt, &options, long_text) {
            let store = self.deps.attachments.clone();
            on_lane_wait(self.deps.lanes.io, cancel, move |lane| {
                materialize_prompt_submission(&LaneAttachments { store: &store, lane }, &prompt, &options, long_text)
            })
            .await?
        } else {
            materialize_prompt_submission(&NoStore, &prompt, &options, long_text)
        };
        let Submission { prompt, options } = taken.map_err(|message| mixdog_core_base::support::failed("session", message))?;
        req.params["input"]["prompt"] = prompt;
        // Only the pasted tables change; options the submission did not give stay ungiven.
        for key in ["pastedImages", "pastedTexts"] {
            if let Some(table) = options.get(key) {
                req.params["input"]["options"][key] = table.clone();
            }
        }
        Ok(())
    }

    async fn deferring(&self, ctx: &CallContext) -> Result<(), CoreError> {
        if matches!(ctx.caller, Caller::Connection(_)) {
            return Ok(());
        }
        let _waiting = super::directory::InFlight::enter(&self.cell.deferring);
        let mut hold = self.deps.start_hold.clone();
        let open = async move { hold.wait_for(|read| *read != super::StartHold::Held).await.map(|read| *read) };
        match Scope::new().cancel(&ctx.cancel).run(open).await.done().ok_or(mixdog_rt::GateCancelled).map_err(caller_cancelled)? {
            Ok(super::StartHold::Closed(drain_reason)) => Err(CoreError::ServerShuttingDown { drain_reason }),
            // Open, or a core whose hold is gone: nothing holds the start.
            _ => Ok(()),
        }
    }

    async fn turn_start(&self, mut req: CoreRequest) -> Result<Reply, CoreError> {
        self.deferring(&req.ctx).await?;
        // A thread just opened is still reading its history for images; the send is judged on that answer.
        Scope::new().cancel(&req.ctx.cancel).run(self.image_gate.scanned()).await.done().ok_or(mixdog_rt::GateCancelled).map_err(caller_cancelled)?;
        if let Some(sentence) = self.image_gate.refusal() {
            return Err(mixdog_core_base::support::failed("session", sentence));
        }
        // An admitted start (`admitted`, turn-gate.mjs): the idle-only delete refuses while one is
        // in its intake, and the thread refuses starts while that delete runs.
        let directory = self.directory.upgrade().ok_or_else(|| self.closing())?;
        // A turn is a session's first use (`createCurrentSession('turn')`, `turn-prepare.mjs`).
        self.create_session().await?;
        let _admitted = directory.gate().enter(&self.id).ok_or_else(|| self.closing())?;
        let cancel = req.ctx.cancel.clone();
        let in_order = self.submits.enter(&cancel).await.map_err(caller_cancelled)?;
        self.take_in_prompt(&mut req, &cancel).await?;
        // The attachments' intake comes first: the refusal is the submit's answer.
        let provider = self.header_snapshot().get("provider").and_then(Value::as_str).unwrap_or_default().to_owned();
        self.deps.prompt_intake.admit(&self.id, &provider, &req.params).await.map_err(|message| mixdog_core_base::support::failed("session", message))?;
        let mut named = super::staged_originals::named_originals(&req.params);
        named.sort();
        named.dedup();
        let mut missing = Vec::new();
        if !named.is_empty() {
            let originals = self.deps.staged_originals.clone();
            // Only an original whose bytes are not in the store leaves the message; a look that cannot run keeps them all
            // (nothing deletes a staged original, so the message keeps what it was sent with).
            missing = on_lane_wait(self.deps.lanes.io, &req.ctx.cancel, move |lane| named.into_iter().filter(|r| !originals.stored(lane, r)).collect())
                .await
                .unwrap_or_default();
        }
        // The fact is the core's own, made at this acceptance (a replay of an accepted send joins that first record, so it is
        // told once); what a caller put on the params under that name is replaced.
        super::staged_originals::record_missing(&mut req.params, &missing);
        // A full inbox must not hold the gate past the caller's cancel.
        // A session whose thread has ended takes nothing (drain-enqueue.mjs:27, admission 	erminal): Node answers a refused submit alse.
        let closed = || mixdog_core_base::support::coded("session", super::actor::SUBMIT_REFUSED, "The session is closed.");
        let answer = Scope::new()
            .cancel(&cancel)
            .run(self.enqueue(req))
            .await
            .done()
            .ok_or(mixdog_rt::GateCancelled)
            .map_err(caller_cancelled)?
            .map_err(|error| if matches!(error, CoreError::ThreadClosing { .. }) { closed() } else { error })?;
        drop(in_order);
        let reply = answer.await.map_err(|_| {
            tracing::warn!(thread = %self.id, method = "turn/start", "the session actor dropped the request's reply without answering it");
            closed()
        })??;
        Ok(reply)
    }

    fn resume(&self, req: &CoreRequest) -> Result<Reply, CoreError> {
        let params: ThreadResumeParams = serde_json::from_value(req.params.clone())
            .map_err(|_| CoreError::InvalidParams { path: "params".into(), expected: "ThreadResumeParams".into() })?;
        let window = window_of(&params.window);
        let resume_from =
            params.resume_from.map(|from| ResumeFrom { position: FeedPosition { epoch: from.epoch, seq: from.seq }, window: window_of(&from.window) });
        let view = self.cell.view.load_full();
        let feed: Arc<dyn FeedSource> = self.subscriptions.clone();
        // The resume's release drains what an earlier process left queued (`resume.mjs:72`) and restarts the idle clock, a full
        // control lane or not.
        self.cell.deliver(super::control::Ctl::Resumed);
        Ok(Reply::Subscribe(Subscribe { result: json!({ "thread": view.summary }), feed, window, resume_from }))
    }

    /// The model conversation (`session.messages`), for the core's own ports: what is stored, then what is held in memory
    /// unsaved (asked first, so a record stored in between is read from the store; an amend replaces its row).
    ///
    /// `wanted`: only the newest stored rows are read, widened toward the oldest (16, then 8 times as many each step) until one
    /// of the messages, amended as above, satisfies it, or the whole conversation is read. Whether any message satisfies
    /// `wanted` is then the answer the whole conversation gives: a match is a message the whole read holds too, and no match
    /// is only answered once every row is read.
    #[allow(
        clippy::disallowed_methods,
        reason = "on a replay's virtual clock mixdog_rt::time stops the replay at the count wait and starts the full-history read there; tokio's timer does not"
    )]
    pub async fn model_messages(&self, wanted: Option<&(dyn Fn(&serde_json::Value) -> bool + Sync)>) -> Result<Vec<serde_json::Value>, CoreError> {
        let (tx, rx) = oneshot::channel();
        self.inbox.send(Inbox::UnsavedRows { tx }).await.map_err(|_| self.closing())?;
        let unsaved = rx.await.map_err(|_| self.closing())?;
        let context = super::run::ModelContext {
            store: self.deps.store.clone(),
            sensitive: self.deps.sensitive.clone(),
            lanes: self.deps.lanes,
            thread: self.id.clone(),
            input: mixdog_core_api::ids::ItemId::from(String::new()),
        };
        // The count waits for a held store (a save that failed), which the whole read does not: a count that does not come at
        // once reads the whole conversation, the answer the tail would have given.
        let len = match wanted {
            Some(_) => match tokio::time::timeout(TAIL_COUNT_WAIT, context.len()).await {
                Ok(len) => len?,
                Err(_) => 0,
            },
            None => 0,
        };
        let mut take = 16usize;
        loop {
            let skip = len.saturating_sub(take);
            let mut rows: Vec<(String, serde_json::Value)> =
                context.read_from(skip).await?.into_iter().map(|(iid, message)| (iid.as_str().to_owned(), message)).collect();
            for (iid, body, amend) in &unsaved {
                match rows.iter_mut().find(|(row, _)| row == iid) {
                    Some(row) => row.1 = body.clone(),
                    None if !amend => rows.push((iid.clone(), body.clone())),
                    None => {}
                }
            }
            let messages: Vec<serde_json::Value> = rows.into_iter().map(|(_, message)| message).collect();
            match wanted {
                Some(wanted) if skip > 0 && !messages.iter().any(wanted) => take = take.saturating_mul(8),
                _ => return Ok(messages),
            }
        }
    }

    /// `thread/read`: the acked view, encoded on cpu-interactive (it can be a 2 MiB window).
    async fn read(&self, req: &CoreRequest) -> Result<Reply, CoreError> {
        let view = self.cell.view.load_full();
        // The read's `window` (the desktop asks `lastItems: 32`) selects as a resume's snapshot does; none sends the whole view.
        let window = req.params.get("window").cloned().and_then(|w| serde_json::from_value::<ResumeWindow>(w).ok()).map(|w| window_of(&w));
        // A read waits for room on a full lane, bounded by the caller's cancel (never `QueueFull`).
        on_lane_wait(self.deps.lanes.cpu, &req.ctx.cancel, move |_lane| {
            let (items, has_older) = match &window {
                Some(window) => {
                    let items = view.select(window);
                    let has_older = super::view::snapshot_has_older(view.has_older, window, items.len(), view.items.len());
                    (items, has_older)
                }
                None => (view.items.iter().map(|item| item.as_ref()).collect(), view.has_older),
            };
            let mut read =
                serde_json::to_value(SnapshotParams { thread: &view.summary, state: &view.state, items, has_older }).expect("protocol types serialize");
            // A retrying spinner shows the wait left at this read, from the deadline the view holds.
            if let Some(spinner) = read.pointer_mut("/state/runtime/spinner") {
                super::spinner::project_retry(spinner, super::spinner::core_now_ms());
            }
            read
        })
        .await
        .map(Reply::Value)
    }

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
            sensitive: self.deps.sensitive.clone(),
            lanes: self.deps.lanes,
            thread: self.id.clone(),
            input: mixdog_core_api::ids::ItemId::from(String::new()),
        };
        let (ids, messages): (Vec<_>, Vec<_>) = context.read().await?.into_iter().unzip();
        let change = super::message_reactions::Change { agent_id, emoji, messages_back, others_keep, at: self.deps.clock.now_ms() };
        let done = super::message_reactions::react_to_message(&messages, &change).map_err(|message| mixdog_core_base::support::failed("session", message))?;
        let mut reply = json!({ "changed": done.changed, "messageId": done.message_id, "reactions": done.reactions });
        let Some(message) = done.message else {
            return Ok(Reply::Value(reply));
        };
        self.amend_shown(&ids[done.index], message, req.ctx).await?;
        reply["changed"] = Value::Bool(true);
        Ok(Reply::Value(reply))
    }

    /// `thread/appliedSkills/set {iid, names}` (`recordAppliedSkills`): the skills a prompt's turn loaded, stamped on
    /// its row (`meta.transcript.appliedSkills`) and shown on its line at once. Internal callers only.
    async fn applied_skills_set(&self, req: CoreRequest) -> Result<Reply, CoreError> {
        let invalid = |path: &str, expected: &str| CoreError::InvalidParams { path: path.into(), expected: expected.into() };
        let iid = req.params.get("iid").and_then(Value::as_str).filter(|iid| !iid.is_empty()).ok_or_else(|| invalid("iid", "the prompt's row"))?;
        let names: Vec<String> =
            serde_json::from_value(req.params.get("names").cloned().unwrap_or(Value::Null)).map_err(|_| invalid("names", "skill names"))?;
        if names.is_empty() {
            return Ok(Reply::Value(json!({ "changed": false })));
        }
        let iid = mixdog_core_api::ids::ItemId::from(iid.to_owned());
        // The message as the conversation holds it (`session.messages`), its stored body read in.
        let context = super::run::ModelContext {
            store: self.deps.store.clone(),
            sensitive: self.deps.sensitive.clone(),
            lanes: self.deps.lanes,
            thread: self.id.clone(),
            input: mixdog_core_api::ids::ItemId::from(String::new()),
        };
        let Some((_, mut message)) = context.read().await?.into_iter().find(|(id, _)| *id == iid) else {
            return Err(CoreError::ItemNotFound { thread_id: self.id.clone(), item_id: iid });
        };
        let Some(body) = message.as_object_mut() else { return Ok(Reply::Value(json!({ "changed": false }))) };
        let meta = body.entry("meta").or_insert_with(|| json!({}));
        if !meta.is_object() {
            *meta = json!({});
        }
        let transcript = meta.as_object_mut().expect("meta is an object").entry("transcript").or_insert_with(|| json!({}));
        if !transcript.is_object() {
            *transcript = json!({});
        }
        transcript.as_object_mut().expect("transcript is an object").insert("appliedSkills".into(), json!(names));
        self.amend_shown(&iid, message, req.ctx).await?;
        Ok(Reply::Value(json!({ "changed": true })))
    }

    /// The row `iid`'s body becomes `message`, and its user lines are shown again with it.
    async fn amend_shown(&self, item: &mixdog_core_api::ids::ItemId, message: Value, ctx: mixdog_core_api::call::CallContext) -> Result<(), CoreError> {
        let iid = item.as_str().to_owned();
        self.deps.store.unheld().await;
        let (store, thread) = (self.deps.store.clone(), self.id.clone());
        // The reaction is a bot's data: a full lane is waited out, never refused.
        let found = on_lane_wait(self.deps.lanes.io, &ctx.cancel, {
            let iid = iid.clone();
            move |lane| store.history_row(lane, &thread, &iid)
        });
        let (_, mut row) = found.await??.ok_or_else(|| CoreError::ItemNotFound { thread_id: self.id.clone(), item_id: item.clone() })?;
        row.body = mixdog_store::schema::blob::Slot::Inline(message.clone());
        let transcript = self.deps.transcript.clone();
        let shown = on_lane_wait(self.deps.lanes.cpu, &ctx.cancel, {
            let row = row.clone();
            move |lane| transcript.items(lane, &row)
        });
        // Only the user lines (the ones that carry reactions and skill chips) are re-shown; a row's other items are unchanged.
        let items: Vec<mixdog_protocol::ThreadItem> = shown
            .await?
            .into_iter()
            .filter_map(|shown| match shown {
                super::seams::Shown::Item(item @ (mixdog_protocol::ThreadItem::UserMessage { .. } | mixdog_protocol::ThreadItem::RoomRow { .. })) => Some(item),
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
        self.to_actor_cancellable(CoreRequest { method: mixdog_core_api::ids::Method("thread/reactions/apply"), params: apply, op: None, ctx }).await?;
        Ok(())
    }

    async fn room_rows_append(&self, req: CoreRequest, dedupe: bool) -> Result<Reply, CoreError> {
        let messages = req
            .params
            .get("messages")
            .and_then(Value::as_array)
            .cloned()
            .ok_or_else(|| CoreError::InvalidParams { path: "messages".into(), expected: "the room row messages".into() })?;
        let _one_at_a_time = self.reactions.enter(&req.ctx.cancel).await.map_err(caller_cancelled)?;
        let context = super::run::ModelContext {
            store: self.deps.store.clone(),
            sensitive: self.deps.sensitive.clone(),
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
        let rows = on_lane_wait(self.deps.lanes.io, &req.ctx.cancel, move |lane| {
            fresh
                .into_iter()
                .map(|mut body| {
                    let facts = store.facts(lane, &mut body);
                    json!({ "body": body, "visible": facts.visible, "prompt": facts.prompt })
                })
                .collect::<Vec<Value>>()
        })
        .await?;
        let set = req.params.get("set").cloned().unwrap_or(Value::Null);
        let unset = req.params.get("unset").cloned().unwrap_or(Value::Null);
        // The room's view with these rows rides the commit, so the actor takes both in one plan.
        let mut params = json!({ "rows": rows, "set": set, "unset": unset });
        if let Some(view) = req.params.get("roomView") {
            params["roomView"] = view.clone();
        }
        let append = CoreRequest { method: mixdog_core_api::ids::Method("thread/roomRows/commit"), params, op: None, ctx: req.ctx };
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
        done.map(|reply| Reply::Value(Value::Object(reply))).map_err(|error| mixdog_core_base::support::failed("turnReview", error.message))
    }

    /// `thread/delete`: `deleteSession` (`true` once the session is gone, `false` when nothing
    /// was deleted), or with `ifIdle` the desktop's `deleteSessionIfIdle` (`{deleted, reason?}`).
    async fn delete(&self, req: &CoreRequest) -> Result<Reply, CoreError> {
        let directory = self.directory.upgrade().ok_or_else(|| self.closing())?;
        super::delete::serve(&directory, &req.params, &req.ctx.cancel).await
    }

    async fn fork_source(&self, idle: bool) -> Result<ForkSource, CoreError> {
        let (tx, rx) = oneshot::channel();
        self.inbox.send(Inbox::ForkPlan { idle, tx }).await.map_err(|_| self.closing())?;
        rx.await.map_err(|_| self.closing())?
    }

    pub(super) async fn require_fork_source(&self, source: &ForkSource, idle: bool) -> Result<(), CoreError> {
        let actual = self.fork_source(idle).await?;
        if actual.revision != source.revision || actual.active_input != source.active_input {
            return Err(super::actor::history_conflict());
        }
        Ok(())
    }

    pub(super) async fn completed_history(&self, source: &ForkSource) -> Result<Vec<Value>, CoreError> {
        let mut rows = self.history_context().read().await?;
        self.require_fork_source(source, false).await?;
        if let Some(input) = &source.active_input {
            let at = rows.iter().position(|(item, _)| item == input).ok_or_else(super::actor::history_conflict)?;
            rows.truncate(at);
        }
        Ok(rows.into_iter().map(|(_, body)| body).collect())
    }

    async fn commit_history(&self, req: CoreRequest, revision: HistoryRevision) -> Result<Reply, CoreError> {
        let (tx, rx) = oneshot::channel();
        self.inbox.send(Inbox::CheckedHistory { req, revision, tx }).await.map_err(|_| self.closing())?;
        rx.await.map_err(|_| self.closing())?
    }

    fn history_context(&self) -> super::run::ModelContext {
        super::run::ModelContext {
            store: self.deps.store.clone(),
            sensitive: self.deps.sensitive.clone(),
            lanes: self.deps.lanes,
            thread: self.id.clone(),
            input: mixdog_core_api::ids::ItemId::from(String::new()),
        }
    }

    /// `thread/fork`: a new thread whose conversation continues the source's completed history.
    async fn fork(&self, req: CoreRequest) -> Result<Reply, CoreError> {
        let params: ThreadForkParams =
            serde_json::from_value(req.params.clone()).map_err(|_| CoreError::InvalidParams { path: "params".into(), expected: "ThreadForkParams".into() })?;
        let directory = self.directory.upgrade().ok_or_else(|| self.closing())?;
        let heirs = super::SessionDirectory::over(directory.clone());
        // The fork copies durable history: what the session holds unwritten (a turn's rows in flight, or what a failed save
        // held after the disk recovered) is written first. A write that fails leaves it unwritten, and the plan refuses.
        let (tx, rx) = oneshot::channel();
        self.inbox.send(Inbox::WritesLanded { tx }).await.map_err(|_| self.closing())?;
        rx.await.map_err(|_| self.closing())?.map_err(|_| super::actor::history_conflict())?;
        let source = self.fork_source(false).await?;
        let compact = params.compact == Some(true);
        if let Some(heir) = &params.into_thread_id {
            if heirs.try_stored_header(heir).await?.is_some() {
                return heirs.carry_into(self, heir, &source, super::inheritance::CarryMode::Existing { compact }).await;
            }
            if heir == &self.id {
                return Err(mixdog_core_base::support::failed("inheritance", "inheritFrom: a session cannot inherit from itself"));
            }
        }
        let visible_heir = params.into_thread_id.is_none();
        let heir = params.into_thread_id.unwrap_or_else(|| directory.mint_session_id());
        let mut header = source.header.clone();
        // The desktop's `inheritSession` creates the heir where the source's Project is (or in the task workspace) with a
        // fresh classification, never in the source's worktree; an inherit into an existing thread keeps that thread's place.
        if visible_heir {
            heir_place(&directory.deps, &mut header).await?;
            root_heir_identity(&mut header);
        }
        if let Some(route) = &params.route {
            let pick = super::new_route::draft_pick(route);
            let effective = self.deps.new_route.adopt(&heir, Some(&pick)).await.map_err(|message| mixdog_core_base::support::failed("route", message))?;
            heir_route(&mut header, pick, &effective)?;
        }
        let header = self.fresh_copy_header(header);
        let created = match directory
            .create(CreateSpec {
                id: Some(heir.clone()),
                header,
                base: None,
                // Creation alone is not a completed fork.
                op: None,
                op_audience: None,
                method: Method("thread/fork/create"),
                params: Value::Null,
                seed: None,
                settings: None,
                starting: None,
            })
            .await
        {
            Ok(created) => created,
            Err(error) => {
                if visible_heir {
                    // Even a failed create can leave files after an uncertain storage result.
                    heirs.discard(&heir).await;
                }
                return Err(error);
            }
        };
        let result = async {
            if params.route.is_some() {
                directory.deps.new_route.seat(&created.id).await.map_err(|message| mixdog_core_base::support::failed("route", message))?;
            } else {
                directory.deps.new_route.boot(&created.id, &created.cell.header.load_full());
            }
            directory.deps.empty_surface.refresh_empty(&created.id).await.map_err(|message| mixdog_core_base::support::failed("session", message))?;
            heirs.carry_into(self, &created.id, &source, super::inheritance::CarryMode::New { compact }).await
        }
        .await;
        if result.is_err() {
            heirs.discard(&created.id).await;
        }
        result
    }

    fn fresh_copy_header(&self, mut header: mixdog_store::schema::record::Header) -> mixdog_store::schema::record::Header {
        fresh_heir_state(&mut header);
        header.insert("inheritedFromSessionId".into(), json!(self.id));
        let now = json!(self.deps.clock.now_ms());
        for key in ["createdAt", "updatedAt", "lastUsedAt"] {
            header.insert(key.into(), now.clone());
        }
        header
    }

    /// The outgoing conversation is recovery data, not a prompt sized for a model.
    async fn keep_cleared_copy(&self, source: &ForkSource) -> Result<Option<ThreadId>, CoreError> {
        let rows = self.completed_history(source).await?;
        if !super::route_session::has_user_conversation(&rows) {
            return Ok(None);
        }
        let directory = self.directory.upgrade().ok_or_else(|| self.closing())?;
        let heirs = super::SessionDirectory::over(directory.clone());
        let copy = directory.mint_session_id();
        let mut header = self.fresh_copy_header(source.header.clone());
        // A preserved copy has its source's provenance and title, but not its lifecycle.
        for key in ["title", "titleSource", "titleLocked", "name"] {
            if let Some(value) = source.header.get(key) {
                header.insert(key.into(), value.clone());
            }
        }
        header.shift_remove("workspace"); // The source still owns its worktree.
        let saved = async {
            directory
                .create(CreateSpec {
                    id: Some(copy.clone()),
                    header,
                    base: None,
                    op: None,
                    op_audience: None,
                    method: Method("thread/clear/copy"),
                    params: Value::Null,
                    seed: None,
                    settings: None,
                    starting: None,
                })
                .await?;
            heirs.carry_into(self, &copy, source, super::inheritance::CarryMode::Recovery { rows }).await
        }
        .await;
        if let Err(error) = saved {
            heirs.discard(&copy).await;
            return Err(error);
        }
        Ok(Some(copy))
    }

    /// `thread/clear`. With `rebuildPrompt` (an agent chat's reset, `session-ops.mjs clear`) it is refused while a turn runs, and
    /// the emptied thread's prompt and tool surface are composed again from the current rules as a new thread's are; the answer
    /// is `{ promptRebuilt }`, whether that was applied.
    async fn clear(&self, req: CoreRequest) -> Result<Reply, CoreError> {
        let params: ThreadClearParams =
            serde_json::from_value(req.params.clone()).map_err(|_| CoreError::InvalidParams { path: "params".into(), expected: "ThreadClearParams".into() })?;
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
        let reply = if matches!(req.ctx.caller, Caller::Connection(_)) {
            let _waited = if self.cell.gated.load(std::sync::atomic::Ordering::SeqCst) { Some(self.fork_source(true).await?) } else { None };
            let _serial = self.submits.enter(&req.ctx.cancel).await.map_err(caller_cancelled)?;
            let source = self.fork_source(true).await?;
            let copy = self.keep_cleared_copy(&source).await?;
            let result = self.commit_history(req, source.revision).await;
            if matches!(
                result,
                Err(CoreError::PreconditionFailed { .. }
                    | CoreError::BarrierFailed { .. }
                    | CoreError::WindowFull { .. }
                    | CoreError::OpIdConflict { .. }
                    | CoreError::OpFenced { .. })
            ) && let (Some(copy), Some(directory)) = (copy, self.directory.upgrade())
            {
                super::SessionDirectory::over(directory).discard(&copy).await;
            }
            result?
        } else {
            self.to_actor(req).await?
        };
        if !rebuild {
            return Ok(reply);
        }
        let directory = self.directory.upgrade().ok_or_else(|| self.closing())?;
        let rebuilt = directory.deps.empty_surface.refresh_empty(&self.id).await.map_err(|message| mixdog_core_base::support::failed("session", message))?;
        Ok(Reply::Value(json!({ "promptRebuilt": rebuilt })))
    }
}

fn run_stop_reply(
    turn: &TurnId,
    decision: &stop::Decision,
    restore_id: Option<String>,
    restored: Option<&Value>,
    unreadable: Option<String>,
    facts: &stop::Facts,
) -> Value {
    let mut reply = stop_reply(Some(turn), true);
    reply["restoreText"] = json!(decision.restore_text);
    reply["restoredSubmissionIds"] = json!(decision.restored_ids);
    if let Some(id) = restore_id.filter(|_| !decision.restore_text.is_empty()) {
        reply["restoreId"] = json!(id);
    }
    if let Some(restored) = restored {
        for key in ["pastedImages", "pastedTexts", "content", "notice"] {
            if let Some(value) = restored.get(key) {
                reply[key] = value.clone();
            }
        }
    }
    if let Some(message) = unreadable {
        reply["notice"] = json!(format!("Could not restore the attachments ({message}); the prompt was kept."));
    }
    for (key, pointer, discard) in
        [("discardPastedImages", "/options/pastedImages", decision.discard_images), ("discardPastedTexts", "/options/pastedTexts", decision.discard_texts)]
    {
        if discard {
            reply[key] = facts.entry.pointer(pointer).cloned().unwrap_or(Value::Null);
        }
    }
    reply
}

fn fresh_heir_state(header: &mut mixdog_store::schema::record::Header) {
    const COMPACTION_CONFIG: [&str; 9] =
        ["auto", "model", "summaryModel", "timeoutMs", "memoryTimeoutMs", "bufferTokens", "mainBufferTokens", "reservedTokens", "boundaryTokens"];
    const NOT_CARRIED: [&str; 48] = [
        "offloadInheriting",
        "offloadInheritingBoot",
        "bp3Cursor",
        "closeProvenance",
        "lastCacheWriteTokens",
        "lastCachedReadTokens",
        "lastContextTokens",
        "lastContextTokensStaleAfterCompact",
        "lastContextTokensUpdatedAt",
        "lastInputTokens",
        "lastIterationIndex",
        "lastOutputTokens",
        "lastProviderSendAt",
        "lastTurnCompletedAt",
        "lastPromptTokens",
        "lastProviderCachedPrefixTokens",
        "lastProviderCacheObservation",
        "providerPrefixBaseline",
        "lastUncachedInputTokens",
        "reasoningUsage",
        "titleUpdatedAt",
        "todo",
        "todoCheck",
        "totalCacheWriteTokens",
        "totalCachedReadTokens",
        "totalUncachedInputTokens",
        "transcriptEpoch",
        "turnBotChain",
        "turnCoverage",
        "pendingGoalReminder",
        "goalReminderRevision",
        "goalStalledNotice",
        "contextUsageSnapshot",
        "turnHop",
        "usageMetricsTurnId",
        "usageReadout",
        "archivedAt",
        "favoriteAt",
        "name",
        "title",
        "titleLocked",
        "titleSource",
        "importOrigin",
        "codexWireSessionId",
        "detachedReason",
        "sessionVisibility",
        "task_id",
        "taskId",
    ];
    for key in NOT_CARRIED {
        header.shift_remove(key);
    }
    header.retain(|key, _| !key.starts_with("contextPressureBaseline"));
    for key in ["providerState", "pendingRoute", "wireRoute", "activeTurnCheckpoint", "lastHeartbeatAt", "clientHostPid"] {
        header.shift_remove(key);
    }
    header.insert("closed".into(), json!(false));
    header.insert("status".into(), json!("idle"));
    header.insert("generation".into(), json!(0));
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

fn root_heir_identity(header: &mut mixdog_store::schema::record::Header) {
    for key in ["parentSessionId", "ownerSessionId", "visibility", "agentTag", "taskType", "permissionMode", "scopeKey"] {
        header.shift_remove(key);
    }
    header.extend([
        ("owner".into(), json!("cli")),
        ("agent".into(), json!("lead")),
        ("lane".into(), json!("cli")),
        ("sourceType".into(), json!("lead")),
        ("sourceName".into(), json!("main")),
    ]);
}

fn heir_route(
    header: &mut mixdog_store::schema::record::Header,
    mut route: serde_json::Map<String, Value>,
    effective: &serde_json::Map<String, Value>,
) -> Result<(), CoreError> {
    route.extend(effective.clone());
    const FIELDS: &[&str] = &[
        "provider",
        "model",
        "effort",
        "fast",
        "autoEffort",
        "modelParameters",
        "contextPercent",
        "contextTokens",
        "selectedContextWindow",
        "routeFallbacks",
        "routeFallbackSource",
    ];
    for key in FIELDS.iter().copied().chain([
        "presetName",
        "routeFallbackIndex",
        "routeFallbackPrimary",
        "routeFallbackFailures",
        "contextWindow",
        "rawContextWindow",
        "displayContextWindow",
        "effectiveContextWindowPercent",
        "compactBoundaryTokens",
        "autoCompactTokenLimit",
    ]) {
        header.shift_remove(key);
    }
    header.extend(super::new_route::create_keys(&route).map_err(|message| mixdog_core_base::support::failed("route", message))?);
    for key in FIELDS {
        if let Some(value) = route.shift_remove(*key) {
            header.insert((*key).into(), value);
        }
    }
    Ok(())
}

async fn heir_place(deps: &SessionDeps, header: &mut mixdog_store::schema::record::Header) -> Result<(), CoreError> {
    use super::thread_settings::project_identity;
    use super::thread_settings::session_project_key;
    let source = Value::Object(header.clone());
    // The source's staged working-folder change is its own: the heir's prompt is built for the folder it starts in
    // (`cold-heir.mjs`: `delete heir.workspaceReroot`).
    header.shift_remove("workspaceReroot");
    if !source.get("desktopSession").is_some_and(Value::is_object) {
        // A worktree belongs to the session that created it: the heir starts in the Project folder (`cold-heir.mjs`).
        if let Some(folder) = super::worktree::replacement_session_cwd(source.get("workspace")) {
            header.insert("workspace".into(), super::worktree::Workspace::project(&folder, &folder).to_value());
            header.insert("cwd".into(), json!(folder));
        }
        return Ok(());
    }
    let registered = deps.new_place.projects().await.map_err(|message| mixdog_core_base::support::failed("session", message))?;
    let keys: Vec<String> = registered.iter().map(|path| project_identity(Some(path))).collect();
    let stored =
        (source.pointer("/desktopSession/classification") == Some(&json!("project"))).then(|| source.pointer("/desktopSession/projectPath").cloned()).flatten();
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
    fn position(&self) -> FeedPosition {
        self.subscriptions.position()
    }

    fn feed_id(&self) -> FeedId {
        self.subscriptions.feed_id()
    }

    fn attach(&self, req: AttachRequest) -> Result<AttachDecision, CoreError> {
        self.subscriptions.attach(req)
    }

    fn carries(&self, sub: &SubscriptionId, window: &Window, resume: &ResumeFrom) -> Option<AttachDecision> {
        self.subscriptions.carries(sub, window, resume)
    }

    fn detach(&self, sub: SubscriptionId) {
        self.subscriptions.detach(sub);
    }

    fn ordered(&self) -> bool {
        self.subscriptions.ordered()
    }
}

pub(crate) struct CountedFeed {
    cell: Arc<ControlCell>,
    feed: Arc<dyn Feed>,
    counted: std::sync::Mutex<std::collections::HashSet<SubscriptionId>>,
}

impl CountedFeed {
    pub(crate) fn new(cell: Arc<ControlCell>, feed: Arc<dyn Feed>) -> Self {
        Self { cell, feed, counted: std::sync::Mutex::default() }
    }

    fn counted(&self) -> std::sync::MutexGuard<'_, std::collections::HashSet<SubscriptionId>> {
        self.counted.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// The attach of a new subscription whose admission ([`ControlCell::subscribing`]) was already taken.
    fn attach_admitted(&self, req: AttachRequest) -> Result<AttachDecision, CoreError> {
        let sub = req.sub.clone();
        let decision = self.feed.attach(req);
        let counted = decision.is_ok() && self.counted().insert(sub);
        self.cell.subscribed(counted);
        decision
    }
}

pub(crate) struct AdmittedFeed {
    feed: Arc<CountedFeed>,
    admitted: std::sync::atomic::AtomicBool,
}

impl AdmittedFeed {
    /// `feed`'s thread has admitted one attach for this reply.
    pub(crate) fn new(feed: Arc<CountedFeed>) -> Self {
        Self { feed, admitted: std::sync::atomic::AtomicBool::new(true) }
    }
}

impl FeedSource for AdmittedFeed {
    fn position(&self) -> FeedPosition {
        self.feed.position()
    }

    fn feed_id(&self) -> FeedId {
        self.feed.feed_id()
    }

    fn attach(&self, req: AttachRequest) -> Result<AttachDecision, CoreError> {
        if !matches!(req.start, AttachStart::Recover { .. }) && self.admitted.swap(false, std::sync::atomic::Ordering::SeqCst) {
            return self.feed.attach_admitted(req);
        }
        self.feed.attach(req)
    }

    /// A reply answered by the subscription its connection holds is never attached: its admission goes back when it is dropped.
    fn carries(&self, sub: &SubscriptionId, window: &Window, resume: &ResumeFrom) -> Option<AttachDecision> {
        self.feed.carries(sub, window, resume)
    }

    fn detach(&self, sub: SubscriptionId) {
        self.feed.detach(sub);
    }

    fn ordered(&self) -> bool {
        self.feed.ordered()
    }
}

impl Drop for AdmittedFeed {
    fn drop(&mut self) {
        if self.admitted.swap(false, std::sync::atomic::Ordering::SeqCst) {
            self.feed.cell.unsubscribed();
        }
    }
}

impl FeedSource for CountedFeed {
    fn position(&self) -> FeedPosition {
        self.feed.position()
    }

    fn feed_id(&self) -> FeedId {
        self.feed.feed_id()
    }

    fn attach(&self, req: AttachRequest) -> Result<AttachDecision, CoreError> {
        // A lag recovery re-enters a subscription already counted.
        if matches!(req.start, AttachStart::Recover { .. }) {
            return self.feed.attach(req);
        }
        if !self.cell.subscribing() {
            return Err(CoreError::ThreadClosing { thread_id: self.cell.thread.clone() });
        }
        self.attach_admitted(req)
    }

    fn carries(&self, sub: &SubscriptionId, window: &Window, resume: &ResumeFrom) -> Option<AttachDecision> {
        self.feed.carries(sub, window, resume)
    }

    fn detach(&self, sub: SubscriptionId) {
        self.feed.detach(sub.clone());
        if self.counted().remove(&sub) {
            self.cell.unsubscribed();
        }
    }

    fn ordered(&self) -> bool {
        self.feed.ordered()
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
            .ok_or_else(|| CoreError::InvalidParams { path: "queuedId".into(), expected: "a queued entry id".into() })?;
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
    /// `rewindToItem` (`rewind.mjs`): the prompt's restore payload is built from its stored content before any history
    /// changes, so a refusal (`restoreFiles: false` over a file part) or an attachment read error leaves the
    /// conversation untouched; the actor then rewinds, and the payload rides its reply.
    async fn rewind(&self, req: CoreRequest) -> Result<Reply, CoreError> {
        let params: ThreadRewindParams = serde_json::from_value(req.params.clone())
            .map_err(|_| CoreError::InvalidParams { path: "params".into(), expected: "ThreadRewindParams".into() })?;
        let (tx, rx) = oneshot::channel();
        self.inbox.send(Inbox::RewindPreview { item: params.item_id, tx }).await.map_err(|_| self.closing())?;
        let preview = rx.await.map_err(|_| self.closing())??;
        // Nothing is committed yet: a cancelled request leaves the restore's reads where they wait.
        let restore = mixdog_rt::Scope::new()
            .cancel(&req.ctx.cancel)
            .run(self.rewind_restore(&preview, params.restore_files != Some(false)))
            .await
            .done()
            .ok_or_else(super::seams::turn_read_cancelled)??;
        let (reply, restore) = match (self.commit_history(req, preview.revision).await?, restore) {
            (Reply::Value(value), Some(restore)) => (value, restore),
            (reply, _) => return Ok(reply),
        };
        let mut value = reply;
        for key in ["pastedImages", "pastedTexts", "content", "notice"] {
            if let Some(found) = restore.get(key) {
                value[key] = found.clone();
            }
        }
        Ok(Reply::Value(value))
    }

    /// Resolve the exact row the actor previewed, including a prompt archived by a compaction.
    async fn rewind_restore(&self, preview: &RewindPreview, restore_files: bool) -> Result<Option<Value>, CoreError> {
        let rows = self.history_context().read().await?;
        let body = match rows.into_iter().find(|(iid, _)| iid == &preview.item) {
            Some((_, body)) => body,
            None => {
                let directory = self.directory.upgrade().ok_or_else(|| self.closing())?;
                let found = super::SessionDirectory::over(directory).history_row(&self.id, preview.item.as_str()).await?;
                match found.map(|(_, row)| row.body) {
                    Some(mixdog_store::schema::blob::Slot::Inline(body)) => body,
                    _ => return Err(super::actor::history_conflict()),
                }
            }
        };
        let Some(content) = body.get("content").filter(|content| content.is_array()).cloned() else {
            return Ok(None);
        };
        let (store, text) = (self.deps.attachments.clone(), preview.text.clone());
        on_lane_wait(self.deps.lanes.io, &mixdog_rt::CancellationToken::new(), move |lane| {
            super::restore_hydrate::rewind_restore(&store, lane, &content, &text, restore_files)
        })
        .await?
    }

    async fn stop_gated(&self, restore_prompt: Option<bool>, ctx: &CallContext) -> Option<Result<Value, CoreError>> {
        if !self.cell.gated.load(std::sync::atomic::Ordering::SeqCst) || restore_prompt == Some(false) {
            return None;
        }
        let queued = self.cell.queue.load().iter().rev().find(|queued| super::control::is_editable_entry(&queued.entry)).cloned()?;
        let raw = super::actor::restored_reply(&[super::actor::Taken::of(&queued)], None);
        let store = self.deps.attachments.clone();
        // Refused on a full lane: the Stop goes on by the ungated path, never behind a read.
        let hydrated = on_lane(self.deps.lanes.io, &mixdog_rt::CancellationToken::new(), move |lane| super::restore_hydrate::hydrate(&store, lane, raw)).await;
        let Ok(Ok(restored)) = hydrated else {
            return None;
        };
        let canceller = self.canceller_of(ctx);
        let (tx, rx) = oneshot::channel();
        self.cell.deliver(Ctl::StopQueued { qid: queued.qid.clone(), canceller, reply: tx });
        let (restore_id, wait) = match rx.await {
            Ok(Some(stopped)) => stopped,
            Ok(None) => return None,
            Err(_) => return Some(Err(self.closing())),
        };
        if let Err(error) = self.stop_saved(vec![wait]).await {
            return Some(Err(error));
        }
        let mut reply = stop_reply(None, false);
        reply["restoreText"] = restored["text"].clone();
        if let Some(id) = restore_id {
            reply["restoreId"] = json!(id);
        }
        reply["pastedImages"] = restored["pastedImages"].clone();
        reply["pastedTexts"] = restored["pastedTexts"].clone();
        // The submissions the window named (`submittedIds`), not the queue's own entry ids.
        reply["restoredSubmissionIds"] =
            json!(queued.entry.pointer("/options/clientSubmissionId").and_then(Value::as_str).filter(|id| !id.is_empty()).into_iter().collect::<Vec<_>>());
        for key in ["content", "notice"] {
            if let Some(value) = restored.get(key) {
                reply[key] = value.clone();
            }
        }
        Some(Ok(reply))
    }

    async fn stop_busy(&self, submission: Option<String>, ctx: CallContext) -> Result<Value, CoreError> {
        let (tx, rx) = oneshot::channel();
        self.cell.deliver(Ctl::StopBusy(tx));
        let busy = rx.await.map_err(|_| self.closing())?;
        self.busy_reply(busy, submission, ctx).await
    }

    /// [`super::SessionDirectory::stop_work`] on this session.
    pub(crate) async fn stop_work(&self, submissions: Vec<String>) -> Result<(), CoreError> {
        let (tx, rx) = oneshot::channel();
        self.cell.deliver(Ctl::StopWork { submissions, reply: tx });
        let waits = rx.await.map_err(|_| self.closing())?;
        self.stop_saved(waits).await
    }

    /// A Stop's answer: success only once every record it appended is durable; a save that failed answers its storage error
    /// (the cancellation fired here and stands).
    async fn stop_saved(&self, waits: Vec<super::stop::StopWait>) -> Result<(), CoreError> {
        for wait in waits {
            wait.await.map_err(|_| self.closing())??;
        }
        Ok(())
    }

    async fn busy_reply(&self, busy: super::control::BusyStop, submission: Option<String>, ctx: CallContext) -> Result<Value, CoreError> {
        match busy {
            super::control::BusyStop::Stopped(waits) => {
                self.stop_saved(waits).await?;
                Ok(stop_reply(None, true))
            }
            super::control::BusyStop::Idle => self.stop_idle(submission, ctx).await,
            super::control::BusyStop::Unstoppable(stage) => {
                let mut reply = stop_reply(None, false);
                reply["reason"] = json!("could-not-stop");
                reply["notice"] = json!(format!("Could not stop: the session is busy ({stage}) and that work cannot be cancelled."));
                Ok(reply)
            }
        }
    }

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
        let stopped = self.stop_turn(request).await;
        // An Agent stopping its own turn is the live parent signal for the agent jobs it started; a Lead's stop leaves delegated
        // work alone (`abortSession`, `session-turns.mjs`: `cancelBackgroundTasks({ surface: 'agent', callerSessionId })`).
        let mut header = (**self.cell.header.load()).clone();
        if !header.contains_key("id") {
            header.insert("id".into(), json!(self.id));
        }
        if mixdog_core_base::quota_resume::is_agent_only_session(&Value::Object(header)) {
            self.deps.agent_signals.agent_turn_aborted(self.id.as_str());
        }
        stopped
    }

    async fn request(&self, req: CoreRequest) -> Result<Reply, CoreError> {
        self.request_inner(req).await
    }
}

impl SessionHandle {
    /// [`ThreadHandle::stop`] without the agent's own jobs following it.
    async fn stop_turn(&self, request: Stop) -> Result<Value, CoreError> {
        let Stop { turn: named, restore_prompt, submission_id, ctx } = request;
        // A room log runs no turn: its Stop is the room's (`session-host.ts` `abortSession` → `agentRooms.stop`).
        if let Some(room) = mixdog_core_base::rooms::ids::room_id_of_session(self.id.as_str())
            && let Some(stopped) = self.deps.room_members.stop_room(&room)
        {
            // Success only once every member stop the room owes is durable.
            stopped.saved.await?;
            return Ok(stop_reply(None, stopped.stopped));
        }
        let named_turn = named.is_some();
        let run = match (named, self.cell.run.load_full()) {
            (Some(turn), Some(run)) if run.turn == turn => run,
            (Some(turn), _) => return Err(CoreError::TurnNotActive { thread_id: self.id.clone(), turn_id: Some(turn) }),
            (None, Some(run)) => run,
            (None, None) => {
                if let Some(reply) = self.stop_gated(restore_prompt, &ctx).await {
                    return reply;
                }
                return self.stop_busy(submission_id, ctx).await;
            }
        };
        let canceller = self.canceller_of(&ctx);
        let facts = run.prompt.snapshot();
        let steering = self.cell.queue.load().iter().any(|queued| super::control::is_editable_entry(&queued.entry));
        let (restored, unreadable) = if stop::wants_restore(&facts, restore_prompt, &canceller, steering) && facts.has_attachments() {
            self.read_handback(&facts).await
        } else {
            (None, None)
        };
        #[cfg(any(test, feature = "test-support"))]
        run.prompt.paused().await;
        let (tx, rx) = oneshot::channel();
        self.cell.deliver(Ctl::StopRun { turn: run.turn.clone(), named: named_turn, restore_prompt, canceller, unreadable: unreadable.is_some(), reply: tx });
        let (decision, wait, restore_id) = match rx.await.map_err(|_| self.closing())? {
            super::control::RunStop::Decided(decision, wait, restore_id) => (decision, wait, restore_id),
            super::control::RunStop::NotActive => return Err(CoreError::TurnNotActive { thread_id: self.id.clone(), turn_id: Some(run.turn.clone()) }),
            super::control::RunStop::Busy(busy) => return self.busy_reply(busy, submission_id, ctx).await,
        };
        self.stop_saved(vec![wait]).await?;
        Ok(run_stop_reply(&run.turn, &decision, restore_id, restored.as_ref(), unreadable, &facts))
    }

    fn canceller_of(&self, ctx: &CallContext) -> String {
        match &ctx.caller {
            Caller::Connection(connection) => self.deps.devices.describe(*connection).device,
            Caller::Internal(_) => String::new(),
        }
    }

    async fn read_handback(&self, facts: &stop::Facts) -> (Option<Value>, Option<String>) {
        let queued = Queued { qid: String::new(), entry: facts.entry.clone(), display: Value::Null };
        let raw = super::actor::restored_reply(&[super::actor::Taken::of(&queued)], None);
        let store = self.deps.attachments.clone();
        // Refused on a full lane: the turn is stopped at once and the reply says its attachments were not read back.
        let read = on_lane(self.deps.lanes.io, &mixdog_rt::CancellationToken::new(), move |lane| {
            let mut raw = raw;
            if let Some(texts) = raw.get_mut("pastedTexts") {
                super::restore_hydrate::materialize_texts(&store, lane, texts)?;
            }
            super::restore_hydrate::hydrate(&store, lane, raw)
        })
        .await;
        match read {
            Ok(Ok(hydrated)) => (Some(hydrated), None),
            Ok(Err(error)) | Err(error) => (None, Some(error.to_string())),
        }
    }

    async fn request_inner(&self, req: CoreRequest) -> Result<Reply, CoreError> {
        match req.method.as_str() {
            "thread/resume" => self.resume(&req),
            "thread/read" => self.read(&req).await,
            "thread/clear" => self.clear(req).await,
            "thread/rewind" => self.rewind(req).await,
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
            "thread/appliedSkills/set" if !matches!(req.ctx.caller, Caller::Connection(_)) => self.applied_skills_set(req).await,
            "thread/roomRows/append" if !matches!(req.ctx.caller, Caller::Connection(_)) => self.room_rows_append(req, true).await,
            "thread/inheritedRows/append" if !matches!(req.ctx.caller, Caller::Connection(_)) => self.room_rows_append(req, false).await,
            // The acked header, for the core's own ports; never a connection's read.
            "thread/header/read" if !matches!(req.ctx.caller, Caller::Connection(_)) => Ok(Reply::Value(json!({ "header": *self.cell.header.load_full() }))),
            // The model conversation (`session.messages`), for the core's own ports: what is stored, then what is held in
            // memory unsaved (asked first, so a record stored in between is read from the store; an amend replaces its row).
            "thread/messages/read" if !matches!(req.ctx.caller, Caller::Connection(_)) => {
                let messages = self.model_messages(None).await?;
                Ok(Reply::Value(json!({ "messages": messages })))
            }
            // `restoreQueued` gives the entries' attachments back with their bytes: the actor answers the
            // references, read here on the interactive lane (the actor never touches the store).
            "thread/queue/delete" if req.params.get("restore") == Some(&serde_json::Value::Bool(true)) => {
                let Reply::Value(raw) = self.to_actor(req).await? else {
                    return Err(CoreError::InvalidParams { path: "reply".into(), expected: "a value".into() });
                };
                let store = self.deps.attachments.clone();
                // The actor has taken the entries out: their attachments are read back whether or not the caller still waits.
                let hydrated =
                    on_lane_wait(self.deps.lanes.io, &mixdog_rt::CancellationToken::new(), move |lane| super::restore_hydrate::hydrate(&store, lane, raw))
                        .await??;
                Ok(Reply::Value(hydrated))
            }
            _ => self.to_actor(req).await,
        }
    }
}

#[cfg(test)]
mod recovery_history_tests {
    use super::*;
    use crate::session::SessionDirectory;
    use crate::session::testing::{Rig, lock};
    use crate::session::tests::{request, start_thread, turn};
    use mixdog_store::schema::blob::Slot;
    use mixdog_store::schema::record::Record;
    use std::sync::atomic::Ordering::SeqCst;

    async fn append(handle: &SessionHandle, messages: Value) {
        handle
            .request(CoreRequest {
                method: Method("thread/inheritedRows/append"),
                params: json!({ "messages": messages }),
                op: None,
                ctx: CallContext::internal("test"),
            })
            .await
            .expect("append");
    }

    fn fail_copy(rig: &Rig) {
        *lock(&rig.store.fail_when) = Some((
            Box::new(
                |record| matches!(record, Record::Meta(meta) if matches!(&meta.change, Slot::Inline(change) if change.set.contains_key("inheritedFromSessionId"))),
            ),
            false,
        ));
    }

    #[tokio::test(start_paused = true)]
    async fn ordinary_clear_recovers_the_original_without_fitting_or_summarizing_it() {
        let rig = Rig::new();
        *lock(&rig.inherit.basis) = Some((100, 200, true));
        rig.compaction.heir_fails.store(true, SeqCst);
        let directory = SessionDirectory::new(rig.deps());
        let source = start_thread(&directory).await;
        let original = json!([{ "role": "user", "content": "question" }, { "role": "assistant", "content": "answer" }]);
        append(&source, original.clone()).await;
        source.request(request("thread/clear", json!({ "threadId": source.id, "opId": "clear" }), "clear")).await.expect("clear");
        assert!(directory.model_context(&source.id).read().await.unwrap().is_empty());
        let copies: Vec<_> = rig.store.log_ids().into_iter().filter(|id| id != &source.id).collect();
        assert_eq!(copies.len(), 1);
        let copied: Vec<_> = directory.model_context(&copies[0]).read().await.unwrap().into_iter().map(|(_, body)| body).collect();
        assert_eq!(json!(copied), original);
        assert!(lock(&rig.inherit.asked).is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn a_clear_whose_recovery_copy_rolls_back_leaves_the_source_intact() {
        let rig = Rig::new();
        rig.store.listed.store(true, SeqCst);
        let directory = SessionDirectory::new(rig.deps());
        let source = start_thread(&directory).await;
        append(&source, json!([{ "role": "user", "content": "keep me" }])).await;
        fail_copy(&rig);
        let clear = source.request(request("thread/clear", json!({ "threadId": source.id, "opId": "clear" }), "clear")).await;
        assert!(matches!(clear, Err(CoreError::BarrierFailed { .. })), "{clear:?}");
        assert_eq!(directory.model_context(&source.id).read().await.unwrap()[0].1["content"], "keep me");
    }

    #[tokio::test(start_paused = true)]
    async fn a_new_fork_does_not_acknowledge_a_copy_that_rolled_back() {
        let rig = Rig::new();
        rig.store.listed.store(true, SeqCst);
        let directory = SessionDirectory::new(rig.deps());
        let source = start_thread(&directory).await;
        append(&source, json!([{ "role": "user", "content": "keep me" }])).await;
        fail_copy(&rig);
        let fork = source.request(request("thread/fork", json!({ "threadId": source.id, "opId": "fork" }), "fork")).await;
        assert!(matches!(fork, Err(CoreError::BarrierFailed { .. })), "{fork:?}");
        assert_eq!(directory.loaded_ids(), [source.id.clone()]);
    }

    #[tokio::test(start_paused = true)]
    async fn a_fork_does_not_carry_the_live_turns_precommitted_prompt() {
        use crate::session::seams::RunOutcome;
        let rig = Rig::new();
        let arrived = Arc::new(tokio::sync::Notify::new());
        let finish = Arc::new(tokio::sync::Notify::new());
        rig.set_script(Arc::new({
            let (arrived, finish) = (arrived.clone(), finish.clone());
            move |run| {
                let (arrived, finish) = (arrived.clone(), finish.clone());
                Box::pin(async move {
                    run.port.input_durable().await.expect("precommitted prompt");
                    arrived.notify_one();
                    finish.notified().await;
                    RunOutcome::Completed(Default::default())
                })
            }
        }));
        let directory = SessionDirectory::new(rig.deps());
        let source = start_thread(&directory).await;
        append(&source, json!([{ "role": "user", "content": "completed" }])).await;
        turn(&source, "in flight", "turn").await;
        arrived.notified().await;
        let fork = source.request(request("thread/fork", json!({ "threadId": source.id, "opId": "fork" }), "fork")).await;
        finish.notify_one();
        let Reply::Value(fork) = fork.expect("fork") else { panic!("fork reply") };
        let heir = ThreadId::from(fork["thread"]["id"].as_str().expect("heir id"));
        let rows = directory.model_context(&heir).read().await.expect("heir context");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].1["content"], "completed");
    }

    #[tokio::test(start_paused = true)]
    async fn a_compacting_fork_of_a_running_source_is_made_from_its_committed_turns() {
        use crate::session::seams::RunOutcome;
        let rig = Rig::new();
        let arrived = Arc::new(tokio::sync::Notify::new());
        let finish = Arc::new(tokio::sync::Notify::new());
        rig.set_script(Arc::new({
            let (arrived, finish) = (arrived.clone(), finish.clone());
            move |run| {
                let (arrived, finish) = (arrived.clone(), finish.clone());
                Box::pin(async move {
                    run.port.input_durable().await.expect("precommitted prompt");
                    arrived.notify_one();
                    finish.notified().await;
                    RunOutcome::Completed(Default::default())
                })
            }
        }));
        *lock(&rig.inherit.budget) = Some(10_000);
        *lock(&rig.compaction.heir_rows) = Some(vec![json!({ "role": "user", "content": "summary" }), json!({ "role": "assistant", "content": "ok" })]);
        let directory = SessionDirectory::new(rig.deps());
        let source = start_thread(&directory).await;
        append(&source, json!([{ "role": "user", "content": "completed" }])).await;
        turn(&source, "in flight", "turn").await;
        arrived.notified().await;
        let fork = source.request(request("thread/fork", json!({ "threadId": source.id, "opId": "fork", "compact": true }), "fork")).await;
        finish.notify_one();
        let Reply::Value(fork) = fork.expect("a running source forks compacted") else { panic!("fork reply") };
        assert_eq!(fork["compacted"], true);
        let seen = lock(&rig.compaction.heir_seen).clone();
        let conversation = crate::session::inheritance::inheritable(seen.concat());
        let contents: Vec<&str> = conversation.iter().filter_map(|row| row["content"].as_str()).collect();
        assert_eq!(contents, ["completed"], "the compactor is given the committed turns, not the in-flight prompt");
    }

    /// A compacting fork whose heir drops what is bound to the source's prefix (a thinking replay, an open tool round) gives the
    /// compactor the rows the fit measured, after that rebinding (`fitConversationForHeir(carrySource, ...)`), never the source's own.
    #[tokio::test(start_paused = true)]
    async fn a_compacting_fork_summarizes_the_rows_rebound_to_the_heirs_prefix() {
        let rig = Rig::new();
        *lock(&rig.inherit.budget) = Some(10_000);
        *lock(&rig.compaction.heir_rows) = Some(vec![json!({ "role": "user", "content": "summary" }), json!({ "role": "assistant", "content": "ok" })]);
        let rebound = vec![json!({ "role": "user", "content": "q" }), json!({ "role": "assistant", "content": "a, its replay dropped" })];
        *lock(&rig.inherit.rebound) = Some(rebound.clone());
        let directory = SessionDirectory::new(rig.deps());
        let source = start_thread(&directory).await;
        append(&source, json!([{ "role": "user", "content": "q" }, { "role": "assistant", "content": "a, with the source's replay" }])).await;
        let fork = source.request(request("thread/fork", json!({ "threadId": source.id, "opId": "fork", "compact": true }), "fork")).await;
        let Reply::Value(fork) = fork.expect("a compacting fork") else { panic!("fork reply") };
        assert_eq!(fork["compacted"], true);
        let seen = lock(&rig.compaction.heir_seen).clone();
        assert_eq!(seen.len(), 1);
        assert_eq!(crate::session::inheritance::inheritable(seen[0].clone()), rebound);
    }

    #[tokio::test(start_paused = true)]
    async fn a_fork_measures_its_rows_after_the_replay_bound_to_the_old_prefix_is_removed() {
        let rig = Rig::new();
        *lock(&rig.inherit.basis) = Some((1_000, 10, true));
        let directory = SessionDirectory::new(rig.deps());
        let source = start_thread(&directory).await;
        append(&source, json!([{ "role": "user", "content": "q" }, { "role": "assistant", "content": "a" }])).await;
        source.request(request("thread/fork", json!({ "threadId": source.id, "opId": "fork" }), "fork")).await.expect("fork");
        assert_eq!(*lock(&rig.inherit.bound_after), [0], "bound before the first measurement");
    }

    #[tokio::test(start_paused = true)]
    async fn a_fork_does_not_replay_the_sources_effort_configuration() {
        let rig = Rig::new();
        let directory = SessionDirectory::new(rig.deps());
        let source = start_thread(&directory).await;
        let snapshot = json!({ "version": 1, "provider": "openai", "model": "gpt-6", "mode": "responses", "initialEffort": "low", "effort": "high" });
        append(
            &source,
            json!([{ "role": "user", "content": "q", "meta": { "effortConfiguration": snapshot, "source": "x" } }, { "role": "assistant", "content": "a" }]),
        )
        .await;
        let Reply::Value(fork) = source.request(request("thread/fork", json!({ "threadId": source.id, "opId": "fork" }), "fork")).await.expect("fork") else {
            panic!("fork reply")
        };
        let heir = ThreadId::from(fork["thread"]["id"].as_str().expect("heir id"));
        let rows = directory.model_context(&heir).read().await.expect("heir context");
        assert_eq!(rows[0].1["content"], "q");
        assert!(rows[0].1["meta"].get("effortConfiguration").is_none(), "{}", rows[0].1);
        assert_eq!(rows[0].1["meta"]["source"], "x");
    }

    #[tokio::test(start_paused = true)]
    async fn a_routed_fork_fits_the_destination_and_owns_its_history_as_a_root_lead() {
        let rig = Rig::new();
        let directory = SessionDirectory::new(rig.deps());
        let source_id = ThreadId::from("sess_worker_source");
        directory
            .create_with_id(
                source_id.clone(),
                json!({
                    "cwd": "/ws", "provider": "source-provider", "model": "source-model", "contextTokens": 64000,
                    "owner": "agent", "agent": "builder", "visibility": "agent-only", "ownerSessionId": "sess_parent",
                })
                .as_object()
                .unwrap()
                .clone(),
                json!({}),
            )
            .await
            .expect("source");
        let source = directory.open_handle(&source_id, &CallContext::internal("test")).await.expect("open source");
        append(&source, json!([{ "role": "user", "content": "carry me" }])).await;
        let fork = source
            .request(request(
                "thread/fork",
                json!({
                    "threadId": source.id, "opId": "fork",
                    "route": { "provider": "openai", "model": "destination", "effort": "high", "fast": true,
                        "autoEffort": false, "modelParameters": { "context": "wide" }, "contextTokens": 12000 },
                }),
                "fork",
            ))
            .await
            .expect("fork");
        let Reply::Value(fork) = fork else { panic!("fork must return a value") };
        let heir = ThreadId::from(fork["thread"]["id"].as_str().expect("heir id"));
        let header = rig.store.stored_header(&heir).expect("durable heir");
        assert_eq!(mixdog_store::summary::session_visibility(&header), "ordinary");
        assert!(mixdog_store::summary::is_root_lead_session(&header));
        assert_eq!(header["owner"], "cli");
        assert_eq!(header["effort"], "high");
        assert_eq!(header["fast"], true);
        assert_eq!(header["autoEffort"], false);
        assert_eq!(header["modelParameters"], json!({ "context": "wide" }));
        assert_eq!(header["contextTokens"], 12000);
        assert_eq!(*lock(&rig.inherit.asked), [("openai".into(), "destination".into(), None, Some(heir), 1)]);
    }

    #[tokio::test(start_paused = true)]
    async fn rewind_refuses_failed_preparation_and_publishes_the_retained_users_display_id() {
        let rig = Rig::new();
        let mut deps = rig.deps_parts(rig.store.clone());
        deps.transcript = Arc::new(crate::session::testing::RecordTranscript::new());
        let deps = Arc::new(deps);
        let directory = SessionDirectory::new(deps.clone());
        let source = start_thread(&directory).await;
        append(
            &source,
            json!([
                // A row shows the submission id its record keeps as `clientSubmissionId` (transcript_rows.rs `metadata`); a bare
                // `submissionIds` is the turn's, and a restored row of only that shows its item id, as Node's restore numbered it.
                { "role": "user", "content": "first", "meta": { "transcript": { "clientSubmissionId": "shown-first" } } },
                { "role": "user", "content": "second", "meta": { "transcript": { "clientSubmissionId": "shown-second" } } },
            ]),
        )
        .await;
        let first = source.view_items()[0].id().clone();
        assert_ne!(first.as_str(), "shown-first");
        assert_ne!(source.view_items()[1].id().as_str(), "shown-second");
        let rewind = |op| request("thread/rewind", json!({ "threadId": source.id, "opId": op, "itemId": "shown-second" }), op);
        rig.store.fail_context.store(true, SeqCst);
        assert!(source.request(rewind("failed-read")).await.is_err());
        assert_eq!(source.view_items().len(), 2);
        let Reply::Value(reply) = source.request(rewind("rewind")).await.expect("rewind") else { panic!("rewind reply") };
        assert_eq!(reply["text"], "second");
        let reset = rig.feeds.frames(source.id.as_str()).into_iter().find(|(_, method, _)| method == "thread/historyReset").expect("reset");
        assert_eq!(reset.2["fromItemId"], "shown-first");
        let restored = SessionDirectory::new(deps).open_handle(&source.id, &CallContext::internal("restored")).await.expect("reopen");
        assert_eq!(restored.view_items().iter().map(|item| item.id()).collect::<Vec<_>>(), [&first]);
    }

    #[tokio::test(start_paused = true)]
    async fn rewind_refuses_a_commit_after_the_previewed_history_changes() {
        let rig = Rig::new();
        let directory = SessionDirectory::new(rig.deps());
        let source = start_thread(&directory).await;
        append(&source, json!([{ "role": "user", "content": "first" }])).await;
        let item = source.view_items()[0].id().clone();
        let (tx, rx) = oneshot::channel();
        source.inbox.send(Inbox::RewindPreview { item: item.clone(), tx }).await.expect("preview request");
        let preview = rx.await.unwrap().expect("preview");
        assert!(source.rewind_restore(&preview, true).await.expect("restore").is_none());
        append(&source, json!([{ "role": "user", "content": "second" }])).await;
        let req = request("thread/rewind", json!({ "threadId": source.id, "opId": "stale", "itemId": item }), "stale");
        assert!(matches!(source.commit_history(req, preview.revision).await, Err(CoreError::PreconditionFailed { .. })));
        assert_eq!(source.view_items().len(), 2);
    }
}
