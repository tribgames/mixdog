//! The production [`ComputerCommands`]: the secret fill's Computer Use commands (`find`, `type`),
//! run on the session's computer helper with the command names and shapes the desktop host
//! takes (`computer-bridge` `executeSerialized`; `ProcessComputerBackend` is the helper), each
//! under the human-only lock as each command of the desktop's queue was (`command-attempt.ts`).

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::PoisonError;

use async_trait::async_trait;
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
use mixdog_core_api::ids::ThreadId;
use mixdog_tools::desktop::computer_backend::semantic_payload;
use mixdog_tools::desktop::host::HostCommands;
use mixdog_tools::state::secrets::ComputerSecretHost;
use serde_json::Value;
use serde_json::json;
use tokio_util::sync::CancellationToken;

use super::ComputerCommands;
use super::HumanOnlyLock;
use super::Redact;
use super::saved_login::FillContext;
use super::saved_login::SavedLoginRegistry;
use super::saved_login::SavedLoginTurn;
use super::saved_login::fill_saved_login;
use crate::session::turn_snapshots::TurnSnapshots;
use super::saved_login::pixels_allowed;
use super::saved_login_host::HelperWindowPids;
use super::saved_login_host::HostSavedLogins;

/// The computer helper of a thread's session; `None` when no desktop control is attached to it.
pub trait ComputerSecretHosts: Send + Sync {
    fn secret_host(&self, thread: &ThreadId) -> Option<Arc<dyn ComputerSecretHost>>;
}

/// [`ComputerCommands`] over the session's computer helper.
pub struct HostComputerCommands {
    hosts: Arc<dyn ComputerSecretHosts>,
    lock: Arc<HumanOnlyLock>,
}

impl HostComputerCommands {
    pub fn new(hosts: Arc<dyn ComputerSecretHosts>, lock: Arc<HumanOnlyLock>) -> Self {
        Self { hosts, lock }
    }
}

#[async_trait]
impl ComputerCommands for HostComputerCommands {
    /// The only commands sent here are the fill's own: a `find` read of the bound window and the
    /// `type` of the secret. The helper withholds captures once a secret may hold focus
    /// (`arm_focus`), so it is armed just before the secret is typed, as Node arms its registry
    /// (`armFocus`) after taking the value. A command a pending human-only approval refuses fails
    /// with the lock's text, which the fill answers `blocked`.
    async fn execute(&self, thread: &ThreadId, command: Value) -> Result<Value, String> {
        let host = self
            .hosts
            .secret_host(thread)
            .ok_or_else(|| "computer_backend_unavailable: no desktop control is attached to this session".to_owned())?;
        let Value::Object(command) = command else {
            return Err("computer command must be an object".to_owned());
        };
        if command.get("action").and_then(Value::as_str) == Some("type") {
            host.arm_focus();
        }
        let _operation = self.lock.begin_computer_operation()?;
        host.execute(command).await.map(Value::Object)
    }
}

/// The agent turn a session's saved-login fill belongs to (Node's bridge named it in `turn_id`): the
/// number of the session's turn that is running now, `None` when none is. The fill's redaction and
/// pixel guard live until that turn settles.
pub trait SavedLoginTurns: Send + Sync {
    fn turn(&self, thread: &ThreadId) -> Option<u64>;
}

/// The agent turns of the sessions, counted as they settle, which is what a saved-login fill is scoped to: the running turn of
/// a session is the one after the last that settled (Node's `turn_id`). A settled turn lifts its fills' password redaction and
/// pixel guard (`settleSavedLoginTurn`), and a session that ends lifts all of its own (`forget`); [`SettlingSavedLogins`] makes
/// those calls where the actor reports them.
pub struct SavedLoginTurnClock {
    registry: Arc<SavedLoginRegistry>,
    /// Per session, how many turns have settled.
    settled: Mutex<HashMap<String, u64>>,
}

impl SavedLoginTurnClock {
    pub fn new(registry: Arc<SavedLoginRegistry>) -> Arc<Self> {
        Arc::new(Self { registry, settled: Mutex::new(HashMap::new()) })
    }

    fn turn_settled(&self, thread: &ThreadId) {
        let turn = {
            let mut settled = self.settled.lock().unwrap_or_else(PoisonError::into_inner);
            let count = settled.entry(thread.as_str().to_owned()).or_insert(0);
            *count += 1;
            SavedLoginTurn { session: thread.as_str().to_owned(), turn: *count }
        };
        let registry = self.registry.clone();
        drop(tokio::spawn(async move { registry.settle(&turn).await }));
    }

    fn runtime_stopped(&self, thread: &ThreadId) {
        // A turn the runtime stopped in is over: `forget` settles it, so the next runtime's first turn is a new number.
        *self.settled.lock().unwrap_or_else(PoisonError::into_inner).entry(thread.as_str().to_owned()).or_insert(0) += 1;
        let (registry, session) = (self.registry.clone(), thread.as_str().to_owned());
        drop(tokio::spawn(async move { registry.forget(&session).await }));
    }
}

impl SavedLoginTurns for SavedLoginTurnClock {
    fn turn(&self, thread: &ThreadId) -> Option<u64> {
        let settled = self.settled.lock().unwrap_or_else(PoisonError::into_inner);
        Some(settled.get(thread.as_str()).copied().unwrap_or(0) + 1)
    }
}

/// The session deps' `TurnSnapshots` (the call the actor makes where Node's `settleTurn` runs) with the saved logins' turn
/// settlement beside it: pass it as `SessionDeps.snapshots` around the one the daemon builds.
pub struct SettlingSavedLogins {
    inner: Arc<dyn TurnSnapshots>,
    clock: Arc<SavedLoginTurnClock>,
}

impl SettlingSavedLogins {
    pub fn new(inner: Arc<dyn TurnSnapshots>, clock: Arc<SavedLoginTurnClock>) -> Self {
        Self { inner, clock }
    }
}

impl TurnSnapshots for SettlingSavedLogins {
    fn turn_settled(&self, thread: &ThreadId) {
        self.clock.turn_settled(thread);
        self.inner.turn_settled(thread);
    }

    fn runtime_stopped(&self, thread: &ThreadId) {
        self.clock.runtime_stopped(thread);
        self.inner.runtime_stopped(thread);
    }

    fn dispose(&self) {
        self.inner.dispose();
    }
}

/// The runtime that names itself in a fill's command (`runtime_id`).
const RUNTIME_ID: &str = "core";

/// One session's [`ComputerBackend`] that serves `fill_saved_login` itself, as the desktop host's
/// `fillSavedLogin` did: the login comes from the desktop's vault (`host/browser/command`
/// `saved_login_admit|value|release`) and is written by the session's computer helper
/// (`saved_login_check`, `saved_login_type`); the value never passes through the tool call or its
/// reply. It also holds the capture of a browser a saved password was filled into back until the
/// filling turn settles (`assertSavedLoginPixelsAllowed`). Every other call goes to `inner`.
pub struct SavedLoginComputerBackend {
    inner: Arc<dyn ComputerBackend>,
    thread: ThreadId,
    host: Arc<dyn HostCommands>,
    commands: Arc<dyn ComputerCommands>,
    registry: Arc<SavedLoginRegistry>,
    redactor: Arc<dyn Redact>,
    turns: Arc<dyn SavedLoginTurns>,
}

impl SavedLoginComputerBackend {
    pub fn new(
        inner: Arc<dyn ComputerBackend>,
        thread: ThreadId,
        host: Arc<dyn HostCommands>,
        commands: Arc<dyn ComputerCommands>,
        registry: Arc<SavedLoginRegistry>,
        redactor: Arc<dyn Redact>,
        turns: Arc<dyn SavedLoginTurns>,
    ) -> Self {
        Self { inner, thread, host, commands, registry, redactor, turns }
    }

    fn hide(&self, text: &str) -> String {
        self.redactor.redact(&self.thread, text)
    }

    /// A refusal as the tool's failure: its code is the text before the first colon when that is a
    /// code (`saved_login_unavailable: ...`), else the generic one.
    fn failed(&self, message: &str) -> ComputerError {
        let message = self.hide(message);
        let code = message
            .split_once(':')
            .map(|(code, _)| code)
            .filter(|code| !code.is_empty() && code.bytes().all(|b| b.is_ascii_lowercase() || b == b'_'))
            .unwrap_or("computer_failed");
        ComputerError::Failed { code: code.to_owned(), message }
    }

    async fn fill(&self, input: &Value, cancel: &CancellationToken) -> Result<Vec<ToolPart>, ComputerError> {
        let Some(turn) = self.turns.turn(&self.thread) else {
            return Err(self.failed("saved_login_unavailable: the request names no runtime and agent turn to scope its protection to; no input was sent"));
        };
        let given = |key: &str| input.get(key).cloned().unwrap_or(Value::Null);
        let window_id = self.target_window(input).await?;
        let command = json!({
            "action": "fill_saved_login",
            "session_id": self.thread.as_str(),
            "window_id": window_id,
            "saved_account": given("savedAccount"),
            "field": given("field"),
            "turn_id": turn,
            "runtime_id": RUNTIME_ID,
        });
        let logins = HostSavedLogins::admit(self.host.clone(), self.thread.clone(), turn)
            .await
            .map_err(|message| self.failed(&format!("saved_login_unavailable: {message}; no input was sent")))?;
        let outcome = self.fill_admitted(&command, &logins, turn, cancel).await;
        // The turn's admission at the desktop is not needed once the fill is over.
        logins.release().await;
        let reply = outcome.map_err(|message| self.failed(&message))?;
        let mut result = reply.get("result").and_then(Value::as_object).cloned().unwrap_or_default();
        // The reply names the tool's action, as `canonicalComputerResultText` rewrote it, and the window the fill was made in.
        let action = ComputerAction::SavedLogin.wire_name();
        result.insert("action".to_owned(), json!(action));
        if !matches!(result.get("window_id"), Some(Value::String(id)) if !id.is_empty()) {
            result.insert("window_id".to_owned(), command["window_id"].clone());
        }
        // The host's own reply of a semantic action: what it did, whether it was verified, how it was delivered, and the verdict.
        let shaped = semantic_payload(action, &result);
        Ok(vec![ToolPart::Text(self.hide(&Value::Object(shaped).to_string()))])
    }

    /// The window a fill is made in: an `app` is resolved to its one visible window, and a refusal says why there is none or
    /// which windows match (`resolveAppWindowId`, which the host ran before the fill for any app-named command); a command that
    /// names its window goes as it is.
    async fn target_window(&self, input: &Value) -> Result<Value, ComputerError> {
        let named = |key: &str| input.get(key).and_then(Value::as_str).map(mixdog_js::js_trim).filter(|text| !text.is_empty());
        if let Some(app) = named("app") {
            let found = self
                .commands
                .execute(&self.thread, json!({ "action": "window_bounds", "session_id": self.thread.as_str(), "app": app }))
                .await
                .map_err(|message| self.failed(&message))?;
            return Ok(found.get("window_id").cloned().unwrap_or(Value::Null));
        }
        Ok(input.get("window_id").cloned().unwrap_or(Value::Null))
    }

    async fn fill_admitted(&self, command: &Value, logins: &HostSavedLogins, turn: u64, cancel: &CancellationToken) -> Result<Value, String> {
        let admitted = self
            .registry
            .admit(&SavedLoginTurn { session: self.thread.as_str().to_owned(), turn })
            .map_err(|message| format!("saved_login_unavailable: {message}; no input was sent"))?;
        let window = command.get("window_id").and_then(Value::as_str).unwrap_or_default();
        let worker = logins.worker(self.commands.clone(), window);
        let runnable = || if cancel.is_cancelled() { Err("cancelled".to_owned()) } else { Ok(()) };
        let hide = |text: &str| self.hide(text);
        let context = FillContext { registry: &self.registry, windows: cfg!(windows), assert_runnable: &runnable, redact: &hide };
        let outcome = fill_saved_login(command, logins, &worker, &context).await;
        drop(admitted);
        outcome
    }

    /// While a saved password's turn runs, the pixels of its browser leave nothing: a capture, and
    /// the capture an `act` takes after its steps, unless they read the accessibility tree only.
    async fn pixels(&self, request: &ComputerRequest) -> Result<(), ComputerError> {
        let mode = match request.action {
            ComputerAction::Capture => request.input.get("mode").and_then(Value::as_str).filter(|mode| !mode.is_empty()).unwrap_or("state"),
            ComputerAction::Act => match request.input.get("observe").and_then(Value::as_str).filter(|mode| !mode.is_empty()) {
                Some(mode) => mode,
                None => return Ok(()),
            },
            _ => return Ok(()),
        };
        let window = request.input.get("window_id").and_then(Value::as_str).unwrap_or_default();
        let pids = HelperWindowPids::new(self.commands.clone(), self.thread.clone());
        pixels_allowed(&self.registry, mode, window, &pids).await.map_err(|message| self.failed(&message))
    }
}

#[async_trait]
impl ComputerBackend for SavedLoginComputerBackend {
    async fn run(&self, request: ComputerRequest, cancel: CancellationToken) -> Result<Vec<ToolPart>, ComputerError> {
        if request.action == ComputerAction::SavedLogin {
            return self.fill(&request.input, &cancel).await;
        }
        self.pixels(&request).await?;
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

#[cfg(test)]
mod tests {
    use std::sync::Mutex;
    use std::sync::PoisonError;
    use std::sync::atomic::AtomicUsize;
    use std::sync::atomic::Ordering;
    use std::time::Duration;

    use mixdog_core_api::CallContext;
    use mixdog_core_api::CoreError;
    use mixdog_core_api::ClaimedHostChannel;
    use mixdog_core_api::HostClaim;
    use mixdog_core_api::HostChannel;
    use mixdog_core_api::HostCapability;
    use mixdog_core_api::HostError;
    use mixdog_core_api::ids::Method;
    use serde_json::Map;
    use serde_json::json;

    use super::super::FillGates;
    use super::super::SecretFill;
    use super::super::SecretSlots;
    use super::super::human_only::free_lock;
    use super::*;

    const ID: &str = "secret_0123456789ab";

    /// The helper, answering a recorded script and keeping what it was sent.
    struct Helper {
        script: Vec<Value>,
        sent: Mutex<Vec<Value>>,
        armed: AtomicUsize,
    }

    #[async_trait]
    impl ComputerSecretHost for Helper {
        async fn execute(&self, command: Map<String, Value>) -> Result<Map<String, Value>, String> {
            let mut sent = self.sent.lock().unwrap_or_else(PoisonError::into_inner);
            sent.push(Value::Object(command));
            match self.script.get(sent.len() - 1) {
                None => Ok(Map::new()),
                Some(step) => match step.get("throw").and_then(Value::as_str) {
                    Some("string") => Err("a thrown string stale_target".to_owned()),
                    Some(message) => Err(message.to_owned()),
                    None => Ok(step.get("reply").and_then(Value::as_object).cloned().unwrap_or_default()),
                },
            }
        }

        fn arm_focus(&self) {
            self.armed.fetch_add(1, Ordering::SeqCst);
        }
    }

    struct Hosts(Option<Arc<Helper>>);

    impl ComputerSecretHosts for Hosts {
        fn secret_host(&self, _: &ThreadId) -> Option<Arc<dyn ComputerSecretHost>> {
            self.0.clone().map(|helper| helper as Arc<dyn ComputerSecretHost>)
        }
    }

    struct Open(bool);

    impl FillGates for Open {
        fn browser_free(&self, _: &ThreadId) -> bool {
            true
        }
        fn computer_free(&self) -> bool {
            self.0
        }
    }

    /// A computer fill never asks the desktop.
    struct NoDesktop;

    #[async_trait]
    impl HostChannel for NoDesktop {
        async fn request(&self, _: HostCapability, _: Method, _: Value) -> Result<Value, HostError> {
            unreachable!("a computer fill sends nothing to the desktop")
        }
        fn notify(&self, _: HostCapability, _: Method, _: Value) -> Result<(), CoreError> {
            unreachable!("a computer fill sends nothing to the desktop")
        }
    }

    #[async_trait]
    impl ClaimedHostChannel for NoDesktop {
        async fn request_claimed(&self, _: HostCapability, _: Method, _: Value) -> Result<(HostClaim, Value), HostError> {
            unreachable!("a computer fill sends nothing to the desktop")
        }
        async fn request_to(&self, _: &HostClaim, _: HostCapability, _: Method, _: Value) -> Result<Value, HostError> {
            unreachable!("a computer fill sends nothing to the desktop")
        }
    }

    fn golden() -> Value {
        serde_json::from_str(include_str!("../../../../../fixtures/secret-input/computer.json")).unwrap()
    }

    /// The commands the helper receives are the ones the real Node `typeComputerSecret` sent
    /// (`fixtures/secret-input/computer.json`), and the helper is armed exactly when Node armed focus.
    #[tokio::test]
    async fn the_helper_gets_the_commands_the_recorded_node_fill_sent() {
        let mut replayed = 0;
        for case in golden()["type"].as_array().unwrap() {
            let name = case["name"].as_str().unwrap();
            let Some(session) = case["command"]["session_id"].as_str().filter(|s| !s.is_empty()) else { continue };
            let helper = Arc::new(Helper { script: case["script"].as_array().unwrap().clone(), sent: Mutex::new(Vec::new()), armed: AtomicUsize::new(0) });
            let slots = Arc::new(SecretSlots::new(Duration::from_secs(3600)));
            let commands = Arc::new(HostComputerCommands::new(Arc::new(Hosts(Some(helper.clone()))), free_lock()));
            let fill = SecretFill::new(slots.clone(), Arc::new(Open(case["gateHeld"] != json!(true))), commands, Arc::new(NoDesktop));
            let thread = ThreadId::from(session);
            if let Some(provided) = case["provide"].as_str() {
                assert!(slots.provide(ID, provided), "{name}");
            }
            if let Some(bind) = case["bind"].as_object() {
                let got = |key: &str| bind[key].as_str().unwrap().to_owned();
                assert!(slots.bind_computer(ID, &got("session"), &got("windowId"), &got("ref")), "{name}");
            }
            let command = &case["command"];
            let named = |key: &str| command.get(key).and_then(Value::as_str).unwrap_or_default().to_owned();
            let outcome = fill.computer_input(&thread, command["request_id"].as_str().unwrap(), &named("window_id"), &named("ref")).await;
            assert_eq!(json!(outcome), case["outcome"], "{name}");
            assert_eq!(json!(helper.sent.lock().unwrap().clone()), case["commands"], "{name}");
            assert_eq!(json!(helper.armed.load(Ordering::SeqCst) > 0), case["after"]["focusArmed"], "{name}");
            replayed += 1;
        }
        assert!(replayed > 10, "{replayed}");
    }

    #[tokio::test]
    async fn no_helper_or_a_non_object_command_is_an_error_text_the_fill_blocks_on() {
        let thread = ThreadId::from("S1");
        let none = HostComputerCommands::new(Arc::new(Hosts(None)), free_lock());
        assert!(none.execute(&thread, json!({ "action": "find" })).await.unwrap_err().starts_with("computer_backend_unavailable"));
        let helper = Arc::new(Helper { script: Vec::new(), sent: Mutex::new(Vec::new()), armed: AtomicUsize::new(0) });
        let some = HostComputerCommands::new(Arc::new(Hosts(Some(helper.clone()))), free_lock());
        assert!(some.execute(&thread, json!("type")).await.is_err());
        assert!(helper.sent.lock().unwrap().is_empty() && helper.armed.load(Ordering::SeqCst) == 0);
        some.execute(&thread, json!({ "action": "find" })).await.unwrap();
        assert_eq!(helper.armed.load(Ordering::SeqCst), 0, "a read does not arm focus");
    }

    /// Each command runs under the human-only lock (`command-attempt.ts` `beginComputerOperation`): one a
    /// pending approval refuses never reaches the helper and fails with the lock's text, so a fill whose
    /// gate was free when it was checked answers `blocked` with nothing typed.
    #[tokio::test]
    async fn a_command_a_pending_human_only_approval_refuses_never_reaches_the_helper() {
        let thread = ThreadId::from("S1");
        let helper = Arc::new(Helper { script: Vec::new(), sent: Mutex::new(Vec::new()), armed: AtomicUsize::new(0) });
        let lock = free_lock();
        let desktop = CallContext::internal("desktop");
        let hold = lock.hold("Allow all actions", &desktop);
        let commands = Arc::new(HostComputerCommands::new(Arc::new(Hosts(Some(helper.clone()))), lock.clone()));
        let refusal = "Computer Use is blocked while a human-only approval is pending: Allow all actions";
        assert_eq!(commands.execute(&thread, json!({ "action": "find" })).await.unwrap_err(), refusal);
        let slots = Arc::new(SecretSlots::new(Duration::from_secs(3600)));
        let fill = SecretFill::new(slots.clone(), Arc::new(Open(true)), commands.clone(), Arc::new(NoDesktop));
        assert!(slots.provide(ID, "hunter2") && slots.bind_computer(ID, "S1", "w1", "e1"));
        assert_eq!(fill.computer_input(&thread, ID, "w1", "e1").await, "blocked");
        assert!(helper.sent.lock().unwrap().is_empty());
        assert!(lock.end(&hold, &desktop.caller));
        commands.execute(&thread, json!({ "action": "find" })).await.unwrap();
        assert_eq!(helper.sent.lock().unwrap().len(), 1);
    }
}