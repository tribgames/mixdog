//! What `computer/bridge/run` is composed from: the computer pool, the one secret fill with its redactor, the one saved-login registry,
//! and the turn a saved-login fill is scoped to while the bridge runs one (the runtime's own turn number).

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core::run_host::native_tools::ComputerSessionPool;
use mixdog_core_api::domain::computer::ComputerBackend;
use mixdog_core_api::domain::computer::ComputerSessions;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_session::session::secret_input::ComputerSecretHosts;
use mixdog_core_session::session::secret_input::Redact;
use mixdog_core_session::session::secret_input::SavedLoginRegistry;
use mixdog_core_session::session::secret_input::SavedLoginTurn;
use mixdog_core_session::session::secret_input::SavedLoginTurns;
use mixdog_core_session::session::secret_input::SecretFill;
use mixdog_tools::desktop::computer_bridge_run::BridgeHost;
use mixdog_tools::desktop::computer_bridge_run::BridgeSavedLogins;
use mixdog_tools::desktop::computer_bridge_run::BridgeSecrets;
use mixdog_tools::desktop::computer_bridge_run::FillTurns;
use serde_json::Map;
use serde_json::Value;

/// The pool the bridge's commands run on.
pub struct PoolBridgeHost(pub Arc<ComputerSessionPool>);

#[async_trait]
impl BridgeHost for PoolBridgeHost {
    fn backend(&self, session: &str) -> Arc<dyn ComputerBackend> {
        self.0.backend(session)
    }
    async fn helper(&self, session: &str, command: Map<String, Value>) -> Result<Map<String, Value>, String> {
        let host = self.0.secret_host(&ThreadId::from(session)).ok_or("computer_capacity_exhausted: no helper is available for this session")?;
        host.execute(command).await
    }
    fn has_helper(&self, session: &str) -> bool {
        self.0.helper_pid(session).is_some()
    }
    async fn abort(&self, session: &str) -> bool {
        self.0.abort(session).await
    }
    async fn end_execution(&self, session: &str) -> bool {
        self.0.end_execution(session).await
    }
    async fn release(&self, session: &str) -> bool {
        self.0.release(session).await
    }
}

/// The one secret fill and the redactor that hides its values and the saved-login passwords.
pub struct FillBridgeSecrets {
    pub fill: Arc<SecretFill>,
    pub redactor: Arc<dyn Redact>,
}

#[async_trait]
impl BridgeSecrets for FillBridgeSecrets {
    fn bind(&self, session: &str, request_id: &str, window_id: &str, reference: &str) -> String {
        self.fill.computer_bind(&ThreadId::from(session), request_id, window_id, reference)
    }
    async fn input(&self, session: &str, request_id: &str, window_id: &str, reference: &str) -> String {
        self.fill.computer_input(&ThreadId::from(session), request_id, window_id, reference).await
    }
    fn redact(&self, session: &str, text: &str) -> String {
        self.redactor.redact(&ThreadId::from(session), text)
    }
    fn focus_armed(&self, session: &str) -> bool {
        self.fill.focus_armed(&ThreadId::from(session))
    }
    fn clear_focus(&self, session: &str) {
        self.fill.clear_focus(&ThreadId::from(session));
    }
}

/// The one registry of saved-login fills, the core's own: a session no core runtime runs for admits no fill, and a settlement of
/// one keeps nothing for it.
pub struct RegistryBridgeSavedLogins(pub Arc<SavedLoginRegistry>);

#[async_trait]
impl BridgeSavedLogins for RegistryBridgeSavedLogins {
    fn admit(&self, session: &str, turn: u64) -> Result<Box<dyn Send>, String> {
        self.0.admit(&SavedLoginTurn { session: session.to_owned(), turn }).map(|guard| Box::new(guard) as Box<dyn Send>)
    }
    async fn settle(&self, session: &str, turn: u64) {
        self.0.settle(&SavedLoginTurn { session: session.to_owned(), turn }).await;
    }
    fn pixels_guarded(&self) -> bool {
        !self.0.pixel_guards().is_empty()
    }
}

/// The turn source of a session's saved-login fills: the runtime's own turn while the bridge runs a fill of the session, else the core's count.
pub struct BridgeFillTurns {
    pub fills: Arc<FillTurns>,
    pub clock: Arc<dyn SavedLoginTurns>,
}

impl SavedLoginTurns for BridgeFillTurns {
    fn turn(&self, thread: &ThreadId) -> Option<u64> {
        self.fills.current(thread.as_str()).or_else(|| self.clock.turn(thread))
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use mixdog_core_api::CoreRequest;
    use mixdog_core_api::DomainService;
    use mixdog_core_api::Reply;
    use mixdog_core_api::call::CallContext;
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
    use mixdog_core_session::session::secret_input::ComputerCommands;
    use mixdog_core_session::session::secret_input::SavedLoginComputerBackend;
    use mixdog_core_session::session::secret_input::SavedLoginTurnClock;
    use mixdog_protocol::Origin;
    use mixdog_tools::desktop::computer_bridge_run::BRIDGE_RUN;
    use mixdog_tools::desktop::computer_bridge_run::ComputerBridgeRun;
    use mixdog_tools::desktop::computer_pixels::ComputerBlobs;
    use mixdog_tools::desktop::host::HostCommandError;
    use mixdog_tools::desktop::host::HostCommands;
    use serde_json::json;
    use tokio::sync::Semaphore;
    use tokio::task::JoinHandle;
    use tokio_util::sync::CancellationToken;

    use super::*;

    const SESSION: &str = "S1";
    const OWNER: &str = "0a1b2c3d-0000-4000-8000-0123456789ab";
    const PASSWORD: &str = "Pa55-word";

    /// The session's backend under the saved-login one, which a fill never reaches.
    struct Inert;

    #[async_trait]
    impl ComputerBackend for Inert {
        async fn run(&self, _: ComputerRequest, _: CancellationToken) -> Result<Vec<ToolPart>, ComputerError> {
            unreachable!("a saved-login fill never reaches the session's backend")
        }
        fn inject(&self, _: ScreenInput) -> Result<InputOutcome, ComputerError> {
            unreachable!()
        }
        fn release_input(&self) -> Result<u32, ComputerError> {
            unreachable!()
        }
        fn input_desktop(&self) -> Option<DesktopIdentity> {
            None
        }
        fn displays(&self) -> Result<Vec<DisplayInfo>, ComputerError> {
            unreachable!()
        }
        fn screen_source(&self, _: DisplayId) -> Result<Box<dyn MediaFrameSource>, ComputerError> {
            unreachable!()
        }
        fn status(&self) -> ComputerStatus {
            ComputerStatus::default()
        }
    }

    /// The desktop's vault: it admits every fill and answers the saved password, keeping the actions it was asked.
    #[derive(Default)]
    struct Vault(Mutex<Vec<String>>);

    #[async_trait]
    impl HostCommands for Vault {
        async fn browser(&self, _: &ThreadId, action: &str, _: Value, _: &mixdog_rt::CancellationToken) -> Result<Value, HostCommandError> {
            self.0.lock().unwrap().push(action.to_owned());
            Ok(match action {
                "saved_login_admit" => json!({ "enabled": true }),
                "saved_login_release" => json!({ "released": true }),
                _ => json!({ "enabled": true, "value": PASSWORD, "label": "j•••e@example.com", "origin": "https://login.example.com" }),
            })
        }
        async fn visualize(&self, _: &ThreadId, _: &str, _: &str, _: Value, _: &mixdog_rt::CancellationToken) -> Result<Value, HostCommandError> {
            unreachable!()
        }
    }

    /// The session's computer helper as a fill's steps meet it, keeping every command.
    #[derive(Default)]
    struct Steps(Mutex<Vec<Value>>);

    #[async_trait]
    impl ComputerCommands for Steps {
        async fn execute(&self, _: &ThreadId, command: Value) -> Result<Value, String> {
            self.0.lock().unwrap().push(command.clone());
            Ok(match command["action"].as_str() {
                Some("saved_login_check") => json!({ "saved_login_target": { "window_id": "hwnd:0x1", "pid": "4242", "origin": "https://login.example.com" } }),
                _ => json!({ "action": "fill_saved_login", "effect": "confirmed" }),
            })
        }
    }

    struct Plain;

    impl Redact for Plain {
        fn redact(&self, _: &ThreadId, text: &str) -> String {
            text.to_owned()
        }
    }

    /// The pool: a session's backend is the saved-login one over the registry and the bridge's fill turns, the owner's process
    /// runs, and any other helper command holds the session's queue until `gate` lets it through.
    struct Pool {
        registry: Arc<SavedLoginRegistry>,
        turns: Arc<dyn SavedLoginTurns>,
        vault: Arc<Vault>,
        steps: Arc<Steps>,
        holding: Semaphore,
        gate: Semaphore,
    }

    #[async_trait]
    impl BridgeHost for Pool {
        fn backend(&self, session: &str) -> Arc<dyn ComputerBackend> {
            Arc::new(SavedLoginComputerBackend::new(
                Arc::new(Inert),
                ThreadId::from(session),
                self.vault.clone(),
                self.steps.clone(),
                self.registry.clone(),
                Arc::new(Plain),
                self.turns.clone(),
            ))
        }
        async fn helper(&self, _: &str, command: Map<String, Value>) -> Result<Map<String, Value>, String> {
            let answer = if command.get("action").and_then(Value::as_str) == Some("process_fate") {
                json!({ "state": "running", "created": "133000000000000000" })
            } else {
                self.holding.add_permits(1);
                drop(self.gate.acquire().await.unwrap());
                json!({})
            };
            Ok(answer.as_object().cloned().unwrap_or_default())
        }
        fn has_helper(&self, _: &str) -> bool {
            false
        }
        async fn abort(&self, _: &str) -> bool {
            true
        }
        async fn end_execution(&self, _: &str) -> bool {
            true
        }
        async fn release(&self, _: &str) -> bool {
            true
        }
    }

    struct NoSecrets;

    #[async_trait]
    impl BridgeSecrets for NoSecrets {
        fn bind(&self, _: &str, _: &str, _: &str, _: &str) -> String {
            unreachable!()
        }
        async fn input(&self, _: &str, _: &str, _: &str, _: &str) -> String {
            unreachable!()
        }
        fn redact(&self, _: &str, text: &str) -> String {
            text.to_owned()
        }
        fn focus_armed(&self, _: &str) -> bool {
            false
        }
        fn clear_focus(&self, _: &str) {}
    }

    struct NoBlobs;

    #[async_trait]
    impl ComputerBlobs for NoBlobs {
        async fn read(&self, _: &str) -> Result<Vec<u8>, ComputerError> {
            unreachable!()
        }
    }

    struct Rig {
        service: Arc<ComputerBridgeRun>,
        pool: Arc<Pool>,
        registry: Arc<SavedLoginRegistry>,
        clock: Arc<SavedLoginTurnClock>,
    }

    /// The bridge composed as the daemon composes it, over a session whose runtime started.
    fn rig() -> Rig {
        let registry = SavedLoginRegistry::new();
        let clock = SavedLoginTurnClock::new(registry.clone());
        let fills = Arc::new(FillTurns::default());
        let pool = Arc::new(Pool {
            registry: registry.clone(),
            turns: Arc::new(BridgeFillTurns { fills: fills.clone(), clock: clock.clone() }),
            vault: Arc::default(),
            steps: Arc::default(),
            holding: Semaphore::new(0),
            gate: Semaphore::new(0),
        });
        let saved = Arc::new(RegistryBridgeSavedLogins(registry.clone()));
        let service = Arc::new(ComputerBridgeRun::new(pool.clone(), Arc::new(NoSecrets), saved, Arc::new(NoBlobs), fills));
        clock.runtime_started(&ThreadId::from(SESSION), 1);
        Rig { service, pool, registry, clock }
    }

    async fn run(service: Arc<ComputerBridgeRun>, command: Value) -> Value {
        let mut ctx = CallContext::connection(ConnectionId(1), Origin::Local, CancellationToken::new());
        ctx.host_claimant = true;
        let request =
            CoreRequest { method: Method(BRIDGE_RUN), params: json!({ "command": command, "sessionKey": SESSION, "signalId": "sig" }), op: None, ctx };
        match service.call(request).await {
            Ok(Reply::Value(answer)) => answer,
            _ => panic!("the bridge answers"),
        }
    }

    fn fill(turn: u64) -> Value {
        json!({ "action": "fill_saved_login", "session_id": SESSION, "window_id": "hwnd:0x1", "saved_account": "j•••e@example.com", "field": "password", "turn_id": turn, "runtime_id": OWNER })
    }

    async fn attach(rig: &Rig) {
        let attached = run(rig.service.clone(), json!({ "action": "owner_attach", "runtime_id": OWNER, "pid": 4321 })).await;
        assert_eq!(attached["value"]["text"], "attached", "{attached}");
    }

    async fn until(what: &str, done: impl Fn() -> bool) {
        for _ in 0..10_000 {
            if done() {
                return;
            }
            tokio::task::yield_now().await;
        }
        panic!("{what}");
    }

    /// A fill the bridge admitted for the running turn, queued behind a held helper command: the held command and the fill.
    async fn queued_fill(rig: &Rig) -> (JoinHandle<Value>, JoinHandle<Value>, u64) {
        attach(rig).await;
        let turn = rig.registry.current_turn(SESSION).unwrap();
        let held = tokio::spawn(run(rig.service.clone(), json!({ "action": "find", "session_id": SESSION, "text": "Sign in" })));
        drop(rig.pool.holding.acquire().await.unwrap());
        let filling = tokio::spawn(run(rig.service.clone(), fill(turn)));
        let admitted = SavedLoginTurn { session: SESSION.to_owned(), turn };
        until("the bridge to admit the fill", || rig.registry.admitted(&admitted)).await;
        (held, filling, turn)
    }

    /// The queued fill's answer once the held command went through, with what it left: nothing looked up or written.
    async fn refused_when_run(rig: &Rig, held: JoinHandle<Value>, filling: JoinHandle<Value>) -> String {
        rig.pool.gate.add_permits(1);
        held.await.unwrap();
        let answer = filling.await.unwrap();
        assert_eq!(answer["ok"], false, "{answer}");
        assert_eq!(*rig.pool.vault.0.lock().unwrap(), ["saved_login_admit", "saved_login_release"], "no value was looked up");
        assert!(rig.pool.steps.0.lock().unwrap().is_empty(), "nothing was checked or written");
        assert!(rig.registry.pixel_guards().is_empty() && rig.registry.redact(PASSWORD) == PASSWORD);
        answer["error"].as_str().unwrap().to_owned()
    }

    /// After a delete, a settlement through the bridge keeps no count for the session and a fill through it is refused before it
    /// runs.
    #[tokio::test]
    async fn a_deleted_session_is_neither_counted_again_nor_filled_through_the_bridge() {
        let rig = rig();
        attach(&rig).await;
        rig.clock.session_deleted(&ThreadId::from(SESSION));
        RegistryBridgeSavedLogins(rig.registry.clone()).settle(SESSION, 5).await;
        let refused = run(rig.service.clone(), fill(1)).await;
        assert_eq!(refused["error"], "saved_login_unavailable: no runtime of its session is running; no input was sent", "{refused}");
        assert!(rig.pool.vault.0.lock().unwrap().is_empty() && rig.pool.steps.0.lock().unwrap().is_empty());
        assert_eq!(rig.registry.current_turn(SESSION), None);
        rig.registry.runtime_started(SESSION, 2);
        assert_eq!(rig.registry.current_turn(SESSION), Some(1), "the settlement after the delete kept no count");
    }

    /// A fill queued at the bridge while its turn settles is refused by the backend's own admission when its turn comes.
    #[tokio::test]
    async fn a_bridge_fill_queued_across_its_turns_settlement_is_refused_at_the_backend() {
        let rig = rig();
        let (held, filling, turn) = queued_fill(&rig).await;
        let accepted = run(rig.service.clone(), json!({ "action": "turn_settle", "session_id": SESSION, "turn_id": turn, "runtime_id": OWNER })).await;
        assert_eq!(accepted["value"]["text"], "turn settlement accepted", "{accepted}");
        until("the turn to settle", || rig.registry.current_turn(SESSION) == Some(turn + 1)).await;
        assert_eq!(refused_when_run(&rig, held, filling).await, "saved_login_unavailable: its agent turn has already ended; no input was sent");
    }

    /// A fill queued at the bridge while its session is deleted is refused by the backend's own admission, and nothing of the
    /// session is left.
    #[tokio::test]
    async fn a_bridge_fill_queued_across_a_delete_is_refused_at_the_backend() {
        let rig = rig();
        let (held, filling, _) = queued_fill(&rig).await;
        rig.clock.session_deleted(&ThreadId::from(SESSION));
        assert_eq!(refused_when_run(&rig, held, filling).await, "saved_login_unavailable: no runtime of its session is running; no input was sent");
        assert_eq!(rig.registry.current_turn(SESSION), None);
    }
}
