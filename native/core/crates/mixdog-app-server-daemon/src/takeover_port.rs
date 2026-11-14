//! The core's takeover owner (Node `takeover-gate.ts`): while a session waits on a `takeover` card (handoff_user) its Browser Use
//! is refused and what is running is stopped, until the card is answered or expires and the session's open requests no longer
//! hold it. [`CoreTakeover`] is the engine's [`TakeoverPort`] over the takeover state the sessions publish
//! ([`TakeoverHolds`]); [`TakeoverReadyService`] is `takeover/ready`, by which a client asks whether the person may act on a
//! takeover it shows (the desktop's `takeoverReady`: the card and the sign-in window wait on it).
//!
//! - `begin(session)` is `beginOperation`: refused with Node's text while the session's own takeover is pending (another
//!   session's never refuses), else one running command, counted until its guard drops. The guard's `cancelled()` fires when a
//!   takeover of the session starts meanwhile (`drainOperations` aborting the in-flight commands). The takeover state is read
//!   by polling while a command runs: the sessions publish it into their control cell without a notification.
//! - `ready(session, takeover)` is `ready`: true once the takeover is held and the session's commands drained (no agent
//!   capture lands after it); false when it ends first, or when it is not held within [`UNSEEN_READY`].
//! - The screen takeover's hold on Computer Use is the human-only lock's own read of the same state, and the hold the core takes
//!   for the cards it raises is `CardHolds`, both in `mixdog_core_session::session::secret_input`.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::MutexGuard;
use std::sync::PoisonError;
use std::time::Duration;

use async_trait::async_trait;
use mixdog_app_protocol::v2::takeover::TakeoverReadyParams;
use mixdog_app_protocol::v2::takeover::TakeoverReadyResult;
use mixdog_browser_engine::port::TakeoverPort;
use mixdog_browser_engine::types::TakeoverGuard;
use mixdog_core_api::CoreError;
use mixdog_core_api::CoreRequest;
use mixdog_core_api::DomainService;
use mixdog_core_api::Reply;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_api::service::Admit;
use mixdog_core_base::support::decode;
use mixdog_core_base::support::wrong_method;
use mixdog_core_session::session::secret_input::TakeoverHolds;
use serde_json::Value;
use serde_json::json;
use tokio_util::sync::CancellationToken;

pub const TAKEOVER_READY: &str = "takeover/ready";

/// `UNSEEN_READY_MS`: how long a card may ask about a takeover the core has not seen held yet.
pub const UNSEEN_READY: Duration = Duration::from_secs(30);
/// How often the takeover state is read while a command runs or a readiness is awaited: the sessions publish it without a
/// notification.
const POLL: Duration = Duration::from_millis(50);

#[derive(Default)]
struct State {
    next: u64,
    /// The running Browser Use commands: the session of each and the token its takeover fires.
    operations: HashMap<u64, (String, CancellationToken)>,
    /// Whether a task reads the takeover state for the running commands.
    watching: bool,
}

struct Shared {
    holds: Arc<dyn TakeoverHolds>,
    state: Mutex<State>,
}

impl Shared {
    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn held(&self, session: &str) -> bool {
        self.holds.hold(&ThreadId::from(session)).held
    }

    fn running(&self, session: &str) -> usize {
        self.state().operations.values().filter(|(owner, _)| owner == session).count()
    }
}

/// The takeover owner of the core.
pub struct CoreTakeover {
    shared: Arc<Shared>,
}

impl CoreTakeover {
    pub fn new(holds: Arc<dyn TakeoverHolds>) -> Self {
        Self { shared: Arc::new(Shared { holds, state: Mutex::default() }) }
    }

    /// Resolves true once the person may act on takeover `takeover_id` of `session_id`, false when it ends first or is never
    /// seen. The takeover state names no takeover id: the session's current takeover answers for `takeover_id`.
    pub async fn ready(&self, session_id: &str, _takeover_id: &str) -> bool {
        let deadline = tokio::time::Instant::now() + UNSEEN_READY;
        let mut seen = false;
        loop {
            let held = self.shared.held(session_id);
            seen |= held;
            if held && self.shared.running(session_id) == 0 {
                return true;
            }
            if (!held && seen) || (!seen && tokio::time::Instant::now() >= deadline) {
                return false;
            }
            tokio::time::sleep(POLL).await;
        }
    }

    /// The commands of `session` running now.
    pub fn running(&self, session: &str) -> usize {
        self.shared.running(session)
    }
}

/// Node's `browserRefusal`.
fn refusal(step: Option<String>) -> String {
    let step = step.unwrap_or_else(|| "a step only the user can do".to_owned());
    format!(
        "Browser Use is paused for this session: the user has taken over ({step}) and was shown a card for it. \
         Wait for the handoff_user result (\"done\", \"denied\" or \"expired\"); do not retry or work around it meanwhile."
    )
}

/// Stops the commands of every session whose takeover started, for as long as any command runs.
fn watch_operations(shared: Arc<Shared>) {
    drop(tokio::spawn(async move {
        loop {
            tokio::time::sleep(POLL).await;
            let mut state = shared.state();
            if state.operations.is_empty() {
                state.watching = false;
                return;
            }
            let taken: Vec<CancellationToken> = state.operations.values().filter(|(session, _)| shared.held(session)).map(|(_, token)| token.clone()).collect();
            drop(state);
            for token in taken {
                token.cancel();
            }
        }
    }));
}

impl TakeoverPort for CoreTakeover {
    /// Needs a tokio runtime: the command is watched for its session's takeover.
    fn begin(&self, session_id: &str) -> Result<TakeoverGuard, String> {
        let hold = self.shared.holds.hold(&ThreadId::from(session_id));
        if hold.held {
            return Err(refusal(hold.screen));
        }
        let token = CancellationToken::new();
        let (id, spawn) = {
            let mut state = self.shared.state();
            state.next += 1;
            let id = state.next;
            state.operations.insert(id, (session_id.to_owned(), token.clone()));
            (id, !std::mem::replace(&mut state.watching, true))
        };
        if spawn {
            watch_operations(self.shared.clone());
        }
        let shared = self.shared.clone();
        Ok(TakeoverGuard::new(token, Some(Box::new(move || drop(shared.state().operations.remove(&id))))))
    }
}

/// `takeover/ready` (client -> core): answered once the takeover is ready or never will be.
pub struct TakeoverReadyService {
    takeover: Arc<CoreTakeover>,
}

impl TakeoverReadyService {
    pub fn new(takeover: Arc<CoreTakeover>) -> Self {
        Self { takeover }
    }
}

#[async_trait]
impl DomainService for TakeoverReadyService {
    fn methods(&self) -> &'static [&'static str] {
        &[TAKEOVER_READY]
    }

    async fn call(&self, request: CoreRequest) -> Result<Reply, CoreError> {
        if request.method.as_str() != TAKEOVER_READY {
            return Err(wrong_method("takeover", request.method.as_str()));
        }
        let TakeoverReadyParams { session_id, takeover_id } = decode(&request)?;
        let ready = self.takeover.ready(&session_id, &takeover_id).await;
        Ok(Reply::Value(json!(TakeoverReadyResult { ready })))
    }

    fn notify(&self, _: Method, _: Value, _: ConnectionId) -> Admit {
        Admit::Accepted
    }
}

#[cfg(test)]
mod tests {
    use mixdog_core_base::support::testing::request;
    use mixdog_core_base::support::testing::value;
    use mixdog_core_session::session::secret_input::TakeoverHold;

    use super::*;

    #[derive(Default)]
    struct Holds(Mutex<HashMap<String, TakeoverHold>>);

    impl Holds {
        fn take(&self, session: &str, screen: Option<&str>) {
            self.0.lock().unwrap().insert(session.to_owned(), TakeoverHold { held: true, screen: screen.map(str::to_owned) });
        }
        fn end(&self, session: &str) {
            self.0.lock().unwrap().remove(session);
        }
    }

    impl TakeoverHolds for Holds {
        fn hold(&self, thread: &ThreadId) -> TakeoverHold {
            self.0.lock().unwrap().get(thread.as_str()).cloned().unwrap_or_default()
        }
        fn screen(&self) -> Option<String> {
            self.0.lock().unwrap().values().find_map(|hold| hold.screen.clone())
        }
    }

    fn owner() -> (Arc<Holds>, Arc<CoreTakeover>) {
        let holds = Arc::new(Holds::default());
        (holds.clone(), Arc::new(CoreTakeover::new(holds)))
    }

    #[tokio::test(start_paused = true)]
    async fn a_takeover_refuses_its_own_session_only() {
        let (holds, owner) = owner();
        holds.take("s1", Some("sign-in on example.com"));
        let refused = owner.begin("s1").unwrap_err();
        assert!(refused.starts_with("Browser Use is paused for this session: the user has taken over (sign-in on example.com)"), "{refused}");
        assert!(refused.contains("Wait for the handoff_user result"));
        assert!(owner.begin("s2").is_ok(), "another session's takeover never blocks");
        holds.take("s3", None);
        assert!(owner.begin("s3").unwrap_err().contains("(a step only the user can do)"));
        holds.end("s1");
        assert!(owner.begin("s1").is_ok());
    }

    #[tokio::test(start_paused = true)]
    async fn a_takeover_starting_stops_the_running_command_of_its_session_only() {
        let (holds, owner) = owner();
        let (mine, other) = (owner.begin("s1").unwrap(), owner.begin("s2").unwrap());
        assert_eq!(owner.running("s1"), 1);
        holds.take("s1", None);
        tokio::time::timeout(Duration::from_secs(1), mine.cancelled().cancelled()).await.expect("the takeover stops the running command");
        assert!(!other.cancelled().is_cancelled());
        drop(mine);
        assert_eq!(owner.running("s1"), 0, "the guard releases the command");
        assert_eq!(owner.running("s2"), 1);
        drop(other);
        assert_eq!(owner.running("s2"), 0);
    }

    #[tokio::test(start_paused = true)]
    async fn ready_waits_for_the_commands_of_the_session_to_drain() {
        let (holds, owner) = owner();
        let running = owner.begin("s1").unwrap();
        holds.take("s1", None);
        let waiting = tokio::spawn({
            let owner = owner.clone();
            async move { owner.ready("s1", "t1").await }
        });
        tokio::time::sleep(Duration::from_secs(1)).await;
        assert!(!waiting.is_finished(), "a command of the session is still draining");
        drop(running);
        assert!(waiting.await.unwrap());
    }

    #[tokio::test(start_paused = true)]
    async fn ready_is_false_when_the_takeover_ends_or_is_never_seen() {
        let (holds, owner) = owner();
        holds.take("s1", None);
        assert!(owner.ready("s1", "t1").await, "held and nothing of the session runs: ready at once");
        let other = owner.begin("s2").unwrap();
        holds.take("s2", None);
        let ends = tokio::spawn({
            let owner = owner.clone();
            async move { owner.ready("s2", "t2").await }
        });
        tokio::time::sleep(Duration::from_millis(200)).await;
        holds.end("s2");
        assert!(!ends.await.unwrap(), "the takeover ended before its command drained");
        drop(other);
        // Never held: the answer comes at the end of the unseen wait.
        let started = tokio::time::Instant::now();
        assert!(!owner.ready("s3", "t3").await);
        assert!(started.elapsed() >= UNSEEN_READY);
    }

    #[tokio::test(start_paused = true)]
    async fn takeover_ready_answers_whether_the_person_may_act() {
        let (holds, owner) = owner();
        holds.take("s1", None);
        let service = TakeoverReadyService::new(owner.clone());
        let answer = value(&service, request(TAKEOVER_READY, json!({ "sessionId": "s1", "takeoverId": "t1" }), None)).await.unwrap();
        assert_eq!(answer, json!({ "ready": true }));
        holds.end("s1");
        let answer = value(&service, request(TAKEOVER_READY, json!({ "sessionId": "s1", "takeoverId": "t1" }), None)).await.unwrap();
        assert_eq!(answer, json!({ "ready": false }), "never seen held within the unseen wait");
        assert!(value(&service, request(TAKEOVER_READY, json!({ "sessionId": "s1" }), None)).await.is_err());
    }
}
