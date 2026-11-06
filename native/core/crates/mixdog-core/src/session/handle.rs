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
use mixdog_rt::LaneToken;
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
use super::state::Section;
use super::view::SnapshotParams;
use crate::approvals::Lineage;
use crate::ports::gate::LiveHeader;

pub struct SessionHandle {
    pub(crate) id: ThreadId,
    pub(crate) cell: Arc<ControlCell>,
    pub(crate) feed: Arc<dyn Feed>,
    pub(crate) inbox: mpsc::Sender<Inbox>,
    pub(crate) producers: mpsc::Sender<ProducerMsg>,
    pub(crate) lineage: Lineage,
    pub(crate) deps: Arc<SessionDeps>,
    pub(crate) directory: Weak<DirInner>,
}

fn window_of(window: &ResumeWindow) -> Window {
    match window {
        ResumeWindow::LastItems { last_items } => Window::LastItems(*last_items),
        ResumeWindow::LastTurns { last_turns } => Window::LastTurns(*last_turns),
        ResumeWindow::None { .. } => Window::HeaderOnly,
    }
}

impl SessionHandle {
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
    pub async fn explicit_cwd(&self) -> Option<String> {
        let header = self.cell.header.load_full();
        let scoped = header.get("cwd").and_then(Value::as_str);
        self.deps.user_cwd.explicit_cwd(scoped).await
    }

    /// Today's `readLastSessionCwd(keyPid)`.
    pub async fn last_cwd(&self, key_pid: Option<&str>) -> Option<String> {
        self.deps.user_cwd.last_cwd(key_pid).await
    }

    /// The session's latest acked header (`SessionGate`'s `LiveHeader`).
    pub fn live_header(&self) -> Arc<dyn LiveHeader> {
        self.cell.clone()
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

    async fn to_actor(&self, req: CoreRequest) -> Result<Reply, CoreError> {
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
        rx.await.map_err(|_| self.closing())?
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
        header.insert(
            "inheritedFromSessionId".into(),
            Value::String(self.id.as_str().to_owned()),
        );
        let directory = self.directory.upgrade().ok_or_else(|| self.closing())?;
        let created = directory
            .create(CreateSpec {
                id: params.into_thread_id,
                header,
                base: Some(base),
                op: req.op.clone(),
                method: req.method,
                params: req.params.clone(),
            })
            .await?;
        let summary = created.cell.view.load_full().summary.clone();
        Ok(Reply::Value(json!({ "thread": summary })))
    }
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

    fn decide(&self, decision: Decision) -> Result<(), CoreError> {
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
            // The acked header, for the core's own ports; never a connection's read.
            "thread/header/read" if !matches!(req.ctx.caller, Caller::Connection(_)) => {
                Ok(Reply::Value(json!({ "header": *self.cell.header.load_full() })))
            }
            _ => self.to_actor(req).await,
        }
    }
}
