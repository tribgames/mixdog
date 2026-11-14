//! The human-only approval lock (Node `apps/desktop/src/main/human-only-approval.ts`), kept by the
//! core: the core sends the agent's Computer Use input to its own helper (D-DESKTOP), so none of it
//! meets the desktop's lock (`command-attempt.ts` `beginComputerOperation`) any more. While a
//! human-only approval is pending, Computer Use refuses every new operation with Node's text, before
//! anything is sent. What holds it:
//! - an open screen (`computer`) takeover of a session this core hosts ([`TakeoverHolds::screen`]),
//!   named as `takeover-gate.ts` names it;
//! - a hold the desktop declares around one of its human-only dialogs (`withHumanOnlyApproval`: a
//!   browser approval card, the Allow-all-actions confirm, its own takeover hold) with
//!   `host/humanOnly/begin`, answered once the operations already running ended, until
//!   `host/humanOnly/end` from that same connection or until that connection closes, so a desktop
//!   that went away cannot leave Computer Use held and no other connection can free it.
//!
//! What runs under it: every `computer` tool call but `wait_for_user` ([`GatedComputerBackend`]) and
//! every command of a secret fill (`HostComputerCommands`), as every command the desktop's queue ran.

use std::sync::Arc;
use std::sync::Mutex;
use std::sync::MutexGuard;
use std::sync::PoisonError;

use async_trait::async_trait;
use mixdog_app_protocol::v2::host::HostHumanOnlyBeginParams;
use mixdog_app_protocol::v2::host::HostHumanOnlyBeginResult;
use mixdog_app_protocol::v2::host::HostHumanOnlyEndParams;
use mixdog_core_api::CallContext;
use mixdog_core_api::Caller;
use mixdog_core_api::CoreError;
use mixdog_core_api::CoreRequest;
use mixdog_core_api::DomainService;
use mixdog_core_api::Reply;
use mixdog_core_api::domain::computer::ComputerAction;
use mixdog_core_api::domain::computer::ComputerBackend;
use mixdog_core_api::domain::computer::ComputerError;
use mixdog_core_api::domain::computer::ComputerRequest;
use mixdog_core_api::domain::computer::ComputerStatus;
use mixdog_core_api::domain::computer::DesktopIdentity;
use mixdog_core_api::domain::computer::DisplayId;
use mixdog_core_api::domain::computer::DisplayInfo;
use mixdog_core_api::domain::computer::InputOutcome;
use mixdog_core_api::domain::computer::ScreenInput;
use mixdog_core_api::domain::media::MediaFrameSource;
use mixdog_core_api::domain::tool::ToolPart;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::service::Admit;
use mixdog_core_base::support::decode;
use mixdog_core_base::support::wrong_method;
use serde_json::Value;
use serde_json::json;
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

use super::TakeoverHolds;

/// `beginComputerOperation`'s refusal, followed by `: <label>` when a pending approval has one.
const BLOCKED: &str = "Computer Use is blocked while a human-only approval is pending";

/// The code of a refused `computer` call; the model reads only its message, as Node words a thrown one (`Error: …`).
const BLOCKED_CODE: &str = "human_only_approval_pending";

const HUMAN_ONLY_BEGIN: &str = "host/humanOnly/begin";
const HUMAN_ONLY_END: &str = "host/humanOnly/end";

/// A hold the desktop declared.
struct Hold {
    id: String,
    /// What it holds the screen for; empty names nothing.
    label: String,
    /// Who declared it: only that caller ends it (the ids are a counter any connection could name).
    owner: Caller,
    /// Cancelled when the connection that declared it closes, which ends it.
    until: CancellationToken,
}

#[derive(Default)]
struct State {
    /// `activeComputerOperations`.
    operations: usize,
    /// The desktop's holds, oldest first (`pendingLabels`).
    holds: Vec<Hold>,
    /// The id of the latest hold.
    last: u64,
}

impl State {
    /// A hold whose connection closed is gone.
    fn prune(&mut self) {
        self.holds.retain(|hold| !hold.until.is_cancelled());
    }
}

/// The one human-only lock of the process.
pub struct HumanOnlyLock {
    takeovers: Arc<dyn TakeoverHolds>,
    state: Mutex<State>,
    /// Woken when the last running operation ends.
    idle: Notify,
}

impl HumanOnlyLock {
    /// The lock over the screen takeovers of the sessions `takeovers` reads.
    pub fn new(takeovers: Arc<dyn TakeoverHolds>) -> Self {
        Self { takeovers, state: Mutex::default(), idle: Notify::new() }
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The refusal `beginComputerOperation` throws now, `None` while Computer Use is free.
    pub(crate) fn refusal(&self) -> Option<String> {
        let screen = self.takeovers.screen();
        refusal(screen, &mut self.state())
    }

    /// `beginComputerOperation`: one operation, counted until the returned guard drops; refused with
    /// Node's text while a human-only approval is pending.
    pub(crate) fn begin_computer_operation(self: &Arc<Self>) -> Result<ComputerOperation, String> {
        let screen = self.takeovers.screen();
        let mut state = self.state();
        if let Some(refusal) = refusal(screen, &mut state) {
            return Err(refusal);
        }
        state.operations += 1;
        Ok(ComputerOperation(Arc::clone(self)))
    }

    /// A hold the desktop declares (`withHumanOnlyApproval`) in call `by`: new operations are refused
    /// from now until [`Self::end`] names the returned id for the same caller or `by`'s connection closes.
    pub(crate) fn hold(&self, label: &str, by: &CallContext) -> String {
        let mut state = self.state();
        state.last += 1;
        let id = state.last.to_string();
        state.holds.push(Hold { id: id.clone(), label: label.to_owned(), owner: by.caller.clone(), until: by.cancel.clone() });
        id
    }

    /// Ends hold `id` that `by` declared; false when it holds nothing for `by` (ended, its connection
    /// closed, or another caller's).
    pub(crate) fn end(&self, id: &str, by: &Caller) -> bool {
        let mut state = self.state();
        state.prune();
        let before = state.holds.len();
        state.holds.retain(|hold| hold.id != id || hold.owner != *by);
        state.holds.len() < before
    }

    /// Resolves once no operation runs (`withHumanOnlyApproval` waiting for `activeComputerOperations`):
    /// while a hold refuses new ones, once those already running ended.
    pub(crate) async fn drained(&self) {
        loop {
            let notified = self.idle.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.state().operations == 0 {
                return;
            }
            notified.await;
        }
    }
}

/// The refusal while a human-only approval is pending, naming the first one that has a label: an
/// open screen takeover (it is up before the desktop declares anything), then the desktop's holds in
/// the order they came (`pendingLabels.find(Boolean)`).
fn refusal(screen: Option<String>, state: &mut State) -> Option<String> {
    state.prune();
    if screen.is_none() && state.holds.is_empty() {
        return None;
    }
    let takeover = screen.map(|step| format!("the user has the screen for a takeover ({step}) and was shown a card for it; try again once it ends"));
    let label = takeover.or_else(|| state.holds.iter().map(|hold| &hold.label).find(|label| !label.is_empty()).cloned());
    Some(match label {
        Some(label) => format!("{BLOCKED}: {label}"),
        None => BLOCKED.to_owned(),
    })
}

/// A running operation: it ends when dropped (the release `beginComputerOperation` returns).
pub(crate) struct ComputerOperation(Arc<HumanOnlyLock>);

impl Drop for ComputerOperation {
    fn drop(&mut self) {
        let mut state = self.0.state();
        state.operations = state.operations.saturating_sub(1);
        if state.operations == 0 {
            self.0.idle.notify_waiters();
        }
    }
}

/// One session's [`ComputerBackend`] under the human-only lock: a call is refused before anything is
/// sent while a human-only approval is pending, and runs as an operation until it returns.
/// `wait_for_user` sends nothing and waits on the person, so it never counts (Node serves it outside
/// the command queue, `bridge-command-dispatch.ts`); a paired phone's remote control is the person's
/// own input and passes.
pub struct GatedComputerBackend {
    inner: Arc<dyn ComputerBackend>,
    lock: Arc<HumanOnlyLock>,
}

impl GatedComputerBackend {
    pub fn new(inner: Arc<dyn ComputerBackend>, lock: Arc<HumanOnlyLock>) -> Self {
        Self { inner, lock }
    }
}

#[async_trait]
impl ComputerBackend for GatedComputerBackend {
    async fn run(&self, request: ComputerRequest, cancel: CancellationToken) -> Result<Vec<ToolPart>, ComputerError> {
        if request.action == ComputerAction::WaitForUser {
            return self.inner.run(request, cancel).await;
        }
        let _operation = self.lock.begin_computer_operation().map_err(|message| ComputerError::Failed { code: BLOCKED_CODE.into(), message })?;
        self.inner.run(request, cancel).await
    }

    fn inject(&self, input: ScreenInput) -> Result<InputOutcome, ComputerError> {
        self.inner.inject(input)
    }

    fn release_input(&self) -> Result<u32, ComputerError> {
        self.inner.release_input()
    }

    fn input_desktop(&self) -> Option<DesktopIdentity> {
        self.inner.input_desktop()
    }

    fn displays(&self) -> Result<Vec<DisplayInfo>, ComputerError> {
        self.inner.displays()
    }

    fn screen_source(&self, display: DisplayId) -> Result<Box<dyn MediaFrameSource>, ComputerError> {
        self.inner.screen_source(display)
    }

    fn status(&self) -> ComputerStatus {
        self.inner.status()
    }
}

/// `host/humanOnly/begin` and `host/humanOnly/end`: the desktop's holds on the lock.
pub struct HumanOnlyService {
    lock: Arc<HumanOnlyLock>,
}

impl HumanOnlyService {
    pub fn new(lock: Arc<HumanOnlyLock>) -> Self {
        Self { lock }
    }
}

#[async_trait]
impl DomainService for HumanOnlyService {
    fn methods(&self) -> &'static [&'static str] {
        &[HUMAN_ONLY_BEGIN, HUMAN_ONLY_END]
    }

    async fn call(&self, req: CoreRequest) -> Result<Reply, CoreError> {
        match req.method.as_str() {
            HUMAN_ONLY_BEGIN => {
                let HostHumanOnlyBeginParams { label } = decode(&req)?;
                // The hold lasts no longer than the connection that declared it.
                let hold_id = self.lock.hold(&label, &req.ctx);
                tokio::select! {
                    () = self.lock.drained() => {}
                    () = req.ctx.cancel.cancelled() => {}
                }
                Ok(Reply::Value(serde_json::to_value(HostHumanOnlyBeginResult { hold_id }).expect("a typed result serializes")))
            }
            HUMAN_ONLY_END => {
                let HostHumanOnlyEndParams { hold_id } = decode(&req)?;
                // Another connection's hold, or one already over, is left as it is.
                self.lock.end(&hold_id, &req.ctx.caller);
                Ok(Reply::Value(json!({})))
            }
            other => Err(wrong_method("host", other)),
        }
    }

    fn notify(&self, _: Method, _: Value, _: ConnectionId) -> Admit {
        Admit::Accepted
    }
}

/// No session holds a takeover.
#[cfg(test)]
struct NoTakeovers;

#[cfg(test)]
impl TakeoverHolds for NoTakeovers {
    fn hold(&self, _: &mixdog_core_api::ids::ThreadId) -> super::TakeoverHold {
        super::TakeoverHold::default()
    }

    fn screen(&self) -> Option<String> {
        None
    }
}

/// A lock no takeover holds, for a test that holds it itself.
#[cfg(test)]
pub(super) fn free_lock() -> Arc<HumanOnlyLock> {
    Arc::new(HumanOnlyLock::new(Arc::new(NoTakeovers)))
}

#[cfg(test)]
mod tests {
    use mixdog_core_api::ids::ThreadId;
    use mixdog_core_base::support::testing::request;
    use mixdog_core_base::support::testing::value;
    use mixdog_protocol::Origin;
    use tokio::sync::oneshot;

    use super::super::TakeoverHold;
    use super::*;
    use crate::session::testing::awaiting;

    /// The helper: it keeps each action it is sent, and the first one runs until `release` fires.
    #[derive(Default)]
    struct Helper {
        sent: Mutex<Vec<ComputerAction>>,
        started: Mutex<Option<oneshot::Sender<()>>>,
        release: Mutex<Option<oneshot::Receiver<()>>>,
    }

    #[async_trait]
    impl ComputerBackend for Helper {
        async fn run(&self, request: ComputerRequest, _: CancellationToken) -> Result<Vec<ToolPart>, ComputerError> {
            self.sent.lock().unwrap().push(request.action);
            let release = self.release.lock().unwrap().take();
            let started = self.started.lock().unwrap().take();
            if let Some(started) = started {
                started.send(()).unwrap();
            }
            if let Some(release) = release {
                release.await.unwrap();
            }
            Ok(Vec::new())
        }
        fn inject(&self, _: ScreenInput) -> Result<InputOutcome, ComputerError> {
            Ok(InputOutcome::Applied)
        }
        fn release_input(&self) -> Result<u32, ComputerError> {
            Ok(0)
        }
        fn input_desktop(&self) -> Option<DesktopIdentity> {
            None
        }
        fn displays(&self) -> Result<Vec<DisplayInfo>, ComputerError> {
            Ok(Vec::new())
        }
        fn screen_source(&self, _: DisplayId) -> Result<Box<dyn MediaFrameSource>, ComputerError> {
            Err(ComputerError::Cancelled)
        }
        fn status(&self) -> ComputerStatus {
            ComputerStatus::default()
        }
    }

    /// A session's screen takeover waiting on `step`.
    struct Takeover(&'static str);

    impl TakeoverHolds for Takeover {
        fn hold(&self, _: &ThreadId) -> TakeoverHold {
            TakeoverHold { held: true, screen: Some(self.0.to_owned()) }
        }
        fn screen(&self) -> Option<String> {
            Some(self.0.to_owned())
        }
    }

    fn act(action: ComputerAction) -> ComputerRequest {
        ComputerRequest { action, input: json!({ "window_id": "w-confirm", "actions": [{ "type": "click", "x": 40, "y": 20 }] }) }
    }

    fn blocked(label: &str) -> ComputerError {
        let message = if label.is_empty() { BLOCKED.to_owned() } else { format!("{BLOCKED}: {label}") };
        ComputerError::Failed { code: BLOCKED_CODE.into(), message }
    }

    /// While a hold is open, every call but `wait_for_user` is refused with Node's text before the helper
    /// is sent anything, naming the first hold that has a label; its end lets input through again.
    #[tokio::test]
    async fn an_open_hold_refuses_input_before_anything_is_sent() {
        let (lock, helper) = (free_lock(), Arc::new(Helper::default()));
        let gated = GatedComputerBackend::new(helper.clone(), lock.clone());
        gated.run(act(ComputerAction::Act), CancellationToken::new()).await.unwrap();
        let by = CallContext::internal("test");
        let unnamed = lock.hold("", &by);
        assert_eq!(gated.run(act(ComputerAction::Act), CancellationToken::new()).await.unwrap_err(), blocked(""));
        let card = lock.hold("the browser approval card", &by);
        for action in [ComputerAction::Act, ComputerAction::Clipboard, ComputerAction::Capture, ComputerAction::Window] {
            assert_eq!(gated.run(act(action), CancellationToken::new()).await.unwrap_err(), blocked("the browser approval card"));
        }
        gated.run(act(ComputerAction::WaitForUser), CancellationToken::new()).await.unwrap();
        assert_eq!(*helper.sent.lock().unwrap(), [ComputerAction::Act, ComputerAction::WaitForUser]);
        assert!(lock.end(&unnamed, &by.caller) && lock.end(&card, &by.caller));
        assert!(!lock.end(&card, &by.caller), "a hold ends once");
        gated.run(act(ComputerAction::Act), CancellationToken::new()).await.unwrap();
        assert_eq!(helper.sent.lock().unwrap().len(), 3);
    }

    /// An open screen takeover of any session holds the screen, named as `takeover-gate.ts` names it.
    #[tokio::test]
    async fn a_screen_takeover_holds_the_screen() {
        let lock = Arc::new(HumanOnlyLock::new(Arc::new(Takeover("step \"Confirm the dialog\""))));
        let helper = Arc::new(Helper::default());
        let gated = GatedComputerBackend::new(helper.clone(), lock.clone());
        let named = "the user has the screen for a takeover (step \"Confirm the dialog\") and was shown a card for it; try again once it ends";
        assert_eq!(gated.run(act(ComputerAction::Act), CancellationToken::new()).await.unwrap_err(), blocked(named));
        assert_eq!(lock.refusal(), Some(format!("{BLOCKED}: {named}")));
        assert!(helper.sent.lock().unwrap().is_empty());
    }

    /// `host/humanOnly/begin` holds Computer Use at once but answers only once the operation already
    /// running ended (`withHumanOnlyApproval` waits for `activeComputerOperations`); `end` frees it.
    #[tokio::test]
    async fn begin_answers_once_the_running_operation_ended() {
        let lock = free_lock();
        let (started, running) = oneshot::channel();
        let (release, held) = oneshot::channel();
        let helper = Arc::new(Helper { started: Mutex::new(Some(started)), release: Mutex::new(Some(held)), ..Helper::default() });
        let gated = Arc::new(GatedComputerBackend::new(helper.clone(), lock.clone()));
        let run = tokio::spawn({
            let gated = gated.clone();
            async move { gated.run(act(ComputerAction::Act), CancellationToken::new()).await }
        });
        awaiting(|| "the first call to reach the helper".to_owned(), running).await.unwrap();
        let service = HumanOnlyService::new(lock.clone());
        let mut begin = std::pin::pin!(value(&service, request(HUMAN_ONLY_BEGIN, json!({ "label": "Allow all actions" }), None)));
        assert!(futures::poll!(begin.as_mut()).is_pending(), "begin waits for the running call");
        assert_eq!(gated.run(act(ComputerAction::Act), CancellationToken::new()).await.unwrap_err(), blocked("Allow all actions"));
        assert!(futures::poll!(begin.as_mut()).is_pending());
        release.send(()).unwrap();
        awaiting(|| "the running call to end".to_owned(), run).await.unwrap().unwrap();
        let answer = awaiting(|| "begin to answer".to_owned(), begin).await.unwrap();
        let hold_id = answer["holdId"].as_str().unwrap().to_owned();
        assert_eq!(gated.run(act(ComputerAction::Act), CancellationToken::new()).await.unwrap_err(), blocked("Allow all actions"));
        assert_eq!(value(&service, request(HUMAN_ONLY_END, json!({ "holdId": hold_id }), None)).await.unwrap(), json!({}));
        gated.run(act(ComputerAction::Act), CancellationToken::new()).await.unwrap();
        assert_eq!(helper.sent.lock().unwrap().len(), 2, "only the calls made while free reached the helper");
    }

    /// A hold ends with the connection that declared it, so a desktop that went away leaves Computer Use free.
    #[tokio::test]
    async fn a_hold_ends_with_its_connection() {
        let lock = free_lock();
        let service = HumanOnlyService::new(lock.clone());
        let connection = CancellationToken::new();
        let begin = CoreRequest {
            method: Method(HUMAN_ONLY_BEGIN),
            params: json!({ "label": "" }),
            op: None,
            ctx: CallContext::connection(ConnectionId(1), Origin::Local, connection.clone()),
        };
        let answer = value(&service, begin).await.unwrap();
        assert_eq!(lock.refusal(), Some(BLOCKED.to_owned()));
        connection.cancel();
        assert_eq!(lock.refusal(), None);
        assert!(!lock.end(answer["holdId"].as_str().unwrap(), &Caller::Connection(ConnectionId(1))), "its connection ended it");
    }

    /// Only the connection that declared a hold ends it: the ids are a counter, so another connection
    /// naming one leaves Computer Use held.
    #[tokio::test]
    async fn only_the_connection_that_declared_a_hold_ends_it() {
        let lock = free_lock();
        let service = HumanOnlyService::new(lock.clone());
        let on = |connection: u64, method: &'static str, params: Value| CoreRequest {
            method: Method(method),
            params,
            op: None,
            ctx: CallContext::connection(ConnectionId(connection), Origin::Local, CancellationToken::new()),
        };
        let answer = value(&service, on(1, HUMAN_ONLY_BEGIN, json!({ "label": "Allow all actions" }))).await.unwrap();
        let end = json!({ "holdId": answer["holdId"] });
        assert_eq!(value(&service, on(2, HUMAN_ONLY_END, end.clone())).await.unwrap(), json!({}));
        assert_eq!(lock.refusal(), Some(format!("{BLOCKED}: Allow all actions")), "another connection's end leaves it held");
        assert_eq!(value(&service, on(1, HUMAN_ONLY_END, end)).await.unwrap(), json!({}));
        assert_eq!(lock.refusal(), None);
    }
}
