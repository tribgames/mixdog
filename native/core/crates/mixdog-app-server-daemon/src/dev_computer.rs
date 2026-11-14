//! Test hook (cargo feature `test-hooks`, refused in a release build by build.rs; registered only when the daemon starts with
//! `MIXDOGD_TEST_HOOKS=1`): `dev/computer/run`, the entry the live Computer Use harness drives. It runs ONE command through the
//! same `ComputerSessionPool` and `GatedComputerBackend` the `computer` tool uses (`ComputerSessions::backend`), outside a model
//! turn, and answers what the old resident bridge's `POST /command` answered (`scenario-runtime.ts`): the reply text, the image as
//! a blob reference, and the helper's process id for the harness's own process checks.
//!
//! A command whose `action` is not one of the tool's is the helper's own (the bridge's `/command` took them all): `click`, `type`,
//! `key`, `list_windows`, `sequence`, `set_value`, `close_window`, `focus_window` and the rest of its vocabulary run through the
//! session's helper exactly as a handed-off secret's commands do (the observation-only mode and the launch policy admit them first).
//! The lifecycle ones (`session_release`, `session_abort`, `execution_end`) end the session's state as the host's own calls do, and
//! `read_authorization`, `update_authorization` and `authorization_windows` are the narrowing the harness sets on the launch policy.
//!
//! The call is refused to a connection that is not on this machine (Ssh, Relay); a window-scoped connection never reaches it
//! (the method is `[window] deny`, so the boundary's table refuses it). A command's own failure is the answer (`ok: false`
//! with the helper's code and words), as the bridge answered `{ok:false,error}`; only a malformed call is an error.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use mixdog_core_api::CoreError;
use mixdog_core_api::DomainService;
use mixdog_core_api::Reply;
use mixdog_core_api::call::CoreRequest;
use mixdog_core_api::domain::computer::ComputerAction;
use mixdog_core_api::domain::computer::ComputerError;
use mixdog_core_api::domain::computer::ComputerRequest;
use mixdog_core_api::domain::computer::ComputerSessions;
use tokio_util::sync::CancellationToken;
use mixdog_core_api::domain::tool::ImageData;
use mixdog_core_api::domain::tool::ToolPart;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::Method;
use mixdog_core::run_host::native_tools::ComputerSessionPool;
use mixdog_core_session::session::secret_input::ComputerSecretHosts as _;
use mixdog_core_api::service::Admit;
use mixdog_core_base::support::decode;
use mixdog_core_base::support::invalid;
use mixdog_core_base::support::on_lane;
use mixdog_protocol::Origin;
use mixdog_protocol::ThreadId;
use mixdog_tools::desktop::computer_launch_policy::AuthorizationStatus;
use mixdog_tools::desktop::computer_launch_policy::WindowIdentity;
use mixdog_tools::desktop::computer_policy::authorization;
use mixdog_tools::desktop::computer_policy::now_ms;
use mixdog_rt::DurabilityIo;
use mixdog_rt::InteractiveIo;
use mixdog_rt::LaneTokens;
use mixdog_store::blobs::BlobStore;
use serde::Deserialize;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

/// The method this service answers.
pub(crate) const DEV_COMPUTER_RUN: &str = "dev/computer/run";

/// The one environment variable that turns the test hooks on at start.
pub(crate) const TEST_HOOKS_ENV: &str = "MIXDOGD_TEST_HOOKS";

/// The bridge's own per-command wait (`AbortSignal.timeout(45_000)`).
const DEFAULT_TIMEOUT_MS: u32 = 45_000;
/// The longest wait a call may ask for.
const MAX_TIMEOUT_MS: u32 = 120_000;

/// Whether the test hooks are on: `MIXDOGD_TEST_HOOKS` is `1`.
pub(crate) fn test_hooks_enabled(env: &dyn Fn(&str) -> Option<String>) -> bool {
    env(TEST_HOOKS_ENV).as_deref() == Some("1")
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Params {
    session_thread_id: String,
    command: Map<String, Value>,
    #[serde(default)]
    timeout_ms: Option<u32>,
}

/// What the harness reaches of a session beyond the tool: the helper itself, its lifecycle and the desktop's windows.
#[async_trait]
pub(crate) trait DevComputerHost: Send + Sync {
    /// The process id of the session's resident helper, while one runs.
    fn helper_pid(&self, session: &str) -> Option<u32>;
    /// One helper command, run to its reply; `Err` is the helper's error text.
    async fn helper(&self, session: &str, command: Map<String, Value>) -> Result<Map<String, Value>, String>;
    /// `endComputerExecution`: the turn's execution ends and the helper stays warm.
    async fn end_execution(&self, session: &str) -> bool;
    /// `releaseComputerSession`.
    async fn release(&self, session: &str) -> bool;
    /// `abortComputerSession`.
    async fn abort(&self, session: &str) -> bool;
    /// Every window of the desktop as `{id, pid, title}`, read by the host.
    async fn authorization_windows(&self, session: &str) -> Result<Vec<Value>, ComputerError>;
    /// The work of every session is stopped (the first step of a replaced authorization).
    async fn stop_all(&self);
}

#[async_trait]
impl DevComputerHost for ComputerSessionPool {
    fn helper_pid(&self, session: &str) -> Option<u32> {
        ComputerSessionPool::helper_pid(self, session)
    }

    async fn helper(&self, session: &str, command: Map<String, Value>) -> Result<Map<String, Value>, String> {
        let host = self.secret_host(&ThreadId::from(session)).ok_or("computer_capacity_exhausted: no helper is available for this session")?;
        host.execute(command).await
    }

    async fn end_execution(&self, session: &str) -> bool {
        ComputerSessionPool::end_execution(self, session).await
    }

    async fn release(&self, session: &str) -> bool {
        ComputerSessionPool::release(self, session).await
    }

    async fn abort(&self, session: &str) -> bool {
        ComputerSessionPool::abort(self, session).await
    }

    async fn authorization_windows(&self, session: &str) -> Result<Vec<Value>, ComputerError> {
        ComputerSessionPool::authorization_windows(self, session).await
    }

    async fn stop_all(&self) {
        self.release_all().await;
    }
}

pub(crate) struct DevComputerRun {
    sessions: Arc<dyn ComputerSessions>,
    host: Arc<dyn DevComputerHost>,
    blobs: BlobStore,
    interactive: InteractiveIo,
    durability: DurabilityIo,
}

/// What a command answered.
enum Answered {
    /// The tool's reply parts.
    Parts(Vec<ToolPart>),
    /// A helper command's or a control's result, as the reply text.
    Fields(Value),
}

impl DevComputerRun {
    /// The service when the hooks are on, else `None` (the method is then unregistered, answered as unknown).
    pub(crate) fn if_enabled(
        env: &dyn Fn(&str) -> Option<String>,
        sessions: Arc<dyn ComputerSessions>,
        host: Arc<dyn DevComputerHost>,
        blobs: BlobStore,
        tokens: &LaneTokens,
    ) -> Option<Arc<Self>> {
        test_hooks_enabled(env).then(|| Arc::new(Self { sessions, host, blobs, interactive: tokens.interactive_io, durability: tokens.durability_io }))
    }

    async fn run(&self, req: &CoreRequest) -> Result<Value, CoreError> {
        if req.ctx.origin != Origin::Local {
            return Err(CoreError::PermissionDenied { method: DEV_COMPUTER_RUN.into(), origin: req.ctx.origin });
        }
        let params: Params = decode(req)?;
        let timeout_ms = params.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS);
        if timeout_ms == 0 || timeout_ms > MAX_TIMEOUT_MS {
            return Err(invalid("params/timeoutMs", "1..=120000"));
        }
        if params.session_thread_id.trim().is_empty() {
            return Err(invalid("params/sessionThreadId", "a session id"));
        }
        let command = Command::of(&params.command).map_err(|expected| invalid("params/command", &expected))?;
        // The command runs under the call's own cancel: the connection closing, or the wait ending, stops it.
        let cancel = req.ctx.cancel.child_token();
        let helper_command = command.is_helper();
        let outcome = match mixdog_rt::time::timeout(Duration::from_millis(u64::from(timeout_ms)), self.dispatch(&params.session_thread_id, command, cancel.clone())).await {
            Ok(outcome) => outcome,
            Err(_) => {
                cancel.cancel();
                Err(ComputerError::Failed { code: "timeout".into(), message: format!("the command did not finish within {timeout_ms} ms") })
            }
        };
        // The bridge aborted the session of a helper command whose caller went away (`abortComputerSession`); a tool action ends itself.
        let ended_early = matches!(&outcome, Err(ComputerError::Cancelled)) || matches!(&outcome, Err(ComputerError::Failed { code, .. }) if code == "timeout");
        if helper_command && ended_early {
            self.host.abort(&params.session_thread_id).await;
        }
        let mut answer = match outcome {
            Ok(Answered::Parts(parts)) => self.answer(req, parts).await?,
            Ok(Answered::Fields(fields)) => json!({ "ok": true, "text": fields.to_string() }),
            Err(error) => failure(error),
        };
        if let Some(pid) = self.host.helper_pid(&params.session_thread_id) {
            answer["helperPid"] = json!(pid);
        }
        Ok(answer)
    }

    /// One command: the tool's own action through the session's backend, else the helper's command or a control of the harness.
    async fn dispatch(&self, session: &str, command: Command, cancel: CancellationToken) -> Result<Answered, ComputerError> {
        match command {
            Command::Tool(request) => self.sessions.backend(session).run(request, cancel).await.map(Answered::Parts),
            Command::Raw(command) => self.raw(session, command, &cancel).await.map(Answered::Fields),
        }
    }

    async fn raw(&self, session: &str, command: Map<String, Value>, cancel: &CancellationToken) -> Result<Value, ComputerError> {
        let action = command.get("action").and_then(Value::as_str).unwrap_or_default().to_owned();
        let host = &self.host;
        match action.as_str() {
            "session_release" => Ok(json!({ "ok": true, "released": host.release(session).await })),
            "session_abort" => Ok(json!({ "ok": true, "confirmed": host.abort(session).await })),
            "execution_end" => Ok(json!({ "ok": true, "ended": host.end_execution(session).await })),
            "read_authorization" => Ok(status_json(&authorization().read())),
            "authorization_windows" => Ok(json!({ "windows": host.authorization_windows(session).await? })),
            "update_authorization" => {
                let value = command.get("authorization").ok_or_else(|| ComputerError::InvalidInput { reason: "update_authorization names its `authorization`".into() })?;
                let status = authorization()
                    .update(value, now_ms, || host.stop_all(), || async {
                        let rows = host.authorization_windows(session).await?;
                        Ok(rows
                            .iter()
                            .filter_map(|row| Some(WindowIdentity { id: row.get("id")?.as_str()?.to_owned(), pid: row.get("pid")?.as_u64()? }))
                            .collect())
                    })
                    .await?;
                Ok(status_json(&status))
            }
            _ => match cancel.run_until_cancelled(host.helper(session, command)).await {
                None => Err(ComputerError::Cancelled),
                Some(reply) => reply.map(Value::Object).map_err(|message| {
                    let code = message
                        .split_once(':')
                        .map(|(code, _)| code)
                        .filter(|code| !code.is_empty() && code.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_'));
                    ComputerError::Failed { code: code.unwrap_or("computer_failed").to_owned(), message }
                }),
            },
        }
    }

    /// The text of the reply and its first image as a blob reference.
    async fn answer(&self, req: &CoreRequest, parts: Vec<ToolPart>) -> Result<Value, CoreError> {
        let mut texts = Vec::new();
        let mut image = None;
        for part in parts {
            match part {
                ToolPart::Text(text) => texts.push(text),
                ToolPart::Json(value) => texts.push(value.to_string()),
                ToolPart::Image { mime, data, .. } if image.is_none() => image = Some((mime, data)),
                ToolPart::Image { .. } | ToolPart::Document { .. } => {}
            }
        }
        let mut answer = json!({ "ok": true, "text": texts.join("\n") });
        if let Some((mime, data)) = image {
            let store = self.blobs.clone();
            let stored = match data {
                ImageData::Bytes(bytes) => {
                    on_lane(self.durability, &req.ctx.cancel, move |lane| {
                        let length = bytes.len() as u64;
                        store.put(lane, &bytes).map(|pin| (pin.digest().as_str().to_owned(), length))
                    })
                    .await?
                }
                ImageData::Blob(digest) => {
                    on_lane(self.interactive, &req.ctx.cancel, move |lane| {
                        let name = digest.as_str().to_owned();
                        store.len(lane, &digest).map(|length| (name, length.unwrap_or(0)))
                    })
                    .await?
                }
            };
            let (digest, byte_length) = stored.map_err(|error| CoreError::CapabilityUnavailable { capability: DEV_COMPUTER_RUN.into(), detail: error.to_string().into() })?;
            answer["imageBlob"] = json!({ "digest": digest, "byteLength": byte_length, "mimeType": mime });
        }
        Ok(answer)
    }
}

/// The helper's refusal as the answer: its code and its words.
fn failure(error: ComputerError) -> Value {
    let (code, message) = match error {
        ComputerError::Unavailable { reason } => ("unavailable".to_owned(), reason),
        ComputerError::InvalidInput { reason } => ("invalid_input".to_owned(), reason),
        ComputerError::Denied => ("denied".to_owned(), "PC access is not approved".to_owned()),
        ComputerError::Cancelled => ("cancelled".to_owned(), "cancelled".to_owned()),
        ComputerError::Failed { code, message } => (code, message),
    };
    json!({ "ok": false, "error": { "code": code, "message": message } })
}

/// The authorization status as the harness reads it.
fn status_json(status: &AuthorizationStatus) -> Value {
    json!({ "policy": status.policy, "externallyRestricted": status.externally_restricted, "updating": status.updating })
}

/// A command: the tool's own action, or one the helper (or the harness) answers itself.
enum Command {
    Tool(ComputerRequest),
    Raw(Map<String, Value>),
}

/// The controls the harness answers itself, not by the helper.
const CONTROLS: [&str; 6] = ["session_release", "session_abort", "execution_end", "read_authorization", "update_authorization", "authorization_windows"];

impl Command {
    /// Whether the helper is asked: a command that is not the tool's and not one of the harness's own controls.
    fn is_helper(&self) -> bool {
        matches!(self, Command::Raw(command) if !CONTROLS.contains(&command.get("action").and_then(Value::as_str).unwrap_or_default()))
    }

    /// The tool's own shape (`{action, input: {..}}`) or the bridge's flat one (`{action, ..fields}`, which is what the harness sent to
    /// `/command`; a `session_id` in it is the session the call already names). An action that is not the tool's is the helper's, sent
    /// as it is.
    fn of(command: &Map<String, Value>) -> Result<Command, String> {
        let name = command.get("action").and_then(Value::as_str).ok_or("a command names its `action`")?.trim();
        let Some(action) = ComputerAction::from_wire(name) else {
            let mut raw = command.clone();
            raw.remove("session_id");
            raw.insert("action".into(), json!(name));
            return Ok(Command::Raw(raw));
        };
        let input = match command.get("input") {
            Some(Value::Object(input)) => Value::Object(input.clone()),
            Some(Value::Null) | None => Value::Object(command.iter().filter(|(key, _)| !matches!(key.as_str(), "action" | "session_id")).map(|(key, value)| (key.clone(), value.clone())).collect()),
            Some(_) => return Err(format!("computer action \"{name}\" input must be an object")),
        };
        Ok(Command::Tool(ComputerRequest { action, input }))
    }
}

#[async_trait]
impl DomainService for DevComputerRun {
    fn methods(&self) -> &'static [&'static str] {
        &[DEV_COMPUTER_RUN]
    }

    async fn call(&self, req: CoreRequest) -> Result<Reply, CoreError> {
        Ok(Reply::Value(self.run(&req).await?))
    }

    fn notify(&self, _method: Method, _params: Value, _from: ConnectionId) -> Admit {
        Admit::Accepted
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use mixdog_core_api::call::CallContext;
    use mixdog_core_api::domain::computer::ComputerBackend;
    use mixdog_core_api::domain::computer::ComputerStatus;
    use mixdog_core_api::domain::computer::DesktopIdentity;
    use mixdog_core_api::domain::computer::DisplayId;
    use mixdog_core_api::domain::computer::DisplayInfo;
    use mixdog_core_api::domain::computer::InputOutcome;
    use mixdog_core_api::domain::computer::ScreenInput;
    use mixdog_core_api::domain::media::MediaFrameSource;
    use tokio_util::sync::CancellationToken;

    use super::*;

    type Log = Arc<Mutex<Vec<(String, ComputerRequest)>>>;

    /// A backend that records what it ran and answers a text and a two-byte image.
    struct Fake {
        session: String,
        fail: bool,
        hang: bool,
        log: Log,
    }

    #[async_trait]
    impl ComputerBackend for Fake {
        async fn run(&self, request: ComputerRequest, _: CancellationToken) -> Result<Vec<ToolPart>, ComputerError> {
            self.log.lock().unwrap().push((self.session.clone(), request));
            if self.hang {
                std::future::pending::<()>().await;
            }
            if self.fail {
                return Err(ComputerError::Failed { code: "stale_frame".into(), message: "stale_frame: unknown frame_id".into() });
            }
            Ok(vec![ToolPart::Text("{\"ok\":true}".into()), ToolPart::Image { mime: "image/png".into(), data: ImageData::Bytes(vec![1, 2]), width: None, height: None }])
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
            Err(ComputerError::Denied)
        }
        fn status(&self) -> ComputerStatus {
            ComputerStatus::default()
        }
    }

    struct Sessions {
        fail: bool,
        hang: bool,
        log: Log,
    }

    impl ComputerSessions for Sessions {
        fn backend(&self, session: &str) -> Arc<dyn ComputerBackend> {
            Arc::new(Fake { session: session.to_owned(), fail: self.fail, hang: self.hang, log: self.log.clone() })
        }
    }

    /// A host that records the helper commands it runs and answers the lifecycle controls.
    #[derive(Default)]
    struct Host {
        helper: Mutex<Vec<(String, Map<String, Value>)>>,
        ended: Mutex<Vec<String>>,
    }

    #[async_trait]
    impl DevComputerHost for Host {
        fn helper_pid(&self, session: &str) -> Option<u32> {
            (session == "s1").then_some(4242)
        }
        async fn helper(&self, session: &str, command: Map<String, Value>) -> Result<Map<String, Value>, String> {
            let refused = command.get("action") == Some(&json!("close_window")).then_some("computer_policy_denied: not authorized".to_owned());
            self.helper.lock().unwrap().push((session.to_owned(), command));
            match refused {
                Some(message) => Err(message),
                None => Ok(json!({ "text": "done", "pid": 7 }).as_object().cloned().unwrap()),
            }
        }
        async fn end_execution(&self, session: &str) -> bool {
            self.ended.lock().unwrap().push(format!("end:{session}"));
            true
        }
        async fn release(&self, session: &str) -> bool {
            self.ended.lock().unwrap().push(format!("release:{session}"));
            true
        }
        async fn abort(&self, session: &str) -> bool {
            self.ended.lock().unwrap().push(format!("abort:{session}"));
            false
        }
        async fn authorization_windows(&self, _: &str) -> Result<Vec<Value>, ComputerError> {
            Ok(vec![json!({ "id": "hwnd:0x1", "pid": 5, "title": "t" })])
        }
        async fn stop_all(&self) {}
    }

    fn env(on: bool) -> impl Fn(&str) -> Option<String> {
        move |name| (on && name == TEST_HOOKS_ENV).then(|| "1".to_owned())
    }

    fn service(on: bool, fail: bool, hang: bool, dir: &std::path::Path) -> (Option<Arc<DevComputerRun>>, Log) {
        let log = Log::default();
        let sessions = Arc::new(Sessions { fail, hang, log: log.clone() });
        let tokens = mixdog_rt::testing::tokens();
        let service = DevComputerRun::if_enabled(&env(on), sessions, Arc::new(Host::default()), BlobStore::new(dir), &tokens);
        (service, log)
    }

    fn call(origin: Origin, params: Value) -> CoreRequest {
        CoreRequest { method: Method(DEV_COMPUTER_RUN), params, op: None, ctx: CallContext::connection(ConnectionId(1), origin, CancellationToken::new()) }
    }

    fn value(reply: Result<Reply, CoreError>) -> Value {
        match reply {
            Ok(Reply::Value(value)) => value,
            Ok(_) => panic!("a subscribing reply"),
            Err(error) => panic!("an error: {error:?}"),
        }
    }

    #[test]
    fn refused_without_the_env() {
        let dir = tempfile::tempdir().unwrap();
        assert!(service(false, false, false, dir.path()).0.is_none(), "no service, so the method is not registered");
        assert!(!test_hooks_enabled(&|_| Some("0".to_owned())));
        assert!(!test_hooks_enabled(&|_| None));
        assert!(test_hooks_enabled(&env(true)));
    }

    #[tokio::test]
    async fn runs_a_fake_backend_command_with_the_env() {
        let dir = tempfile::tempdir().unwrap();
        let (service, log) = service(true, false, false, dir.path());
        let service = service.expect("registered with the env");
        let answer = value(service.call(call(Origin::Local, json!({ "sessionThreadId": "s1", "command": { "action": "capture", "app": "Notepad", "session_id": "x" } }))).await);
        assert_eq!(answer["ok"], json!(true));
        assert_eq!(answer["text"], json!("{\"ok\":true}"));
        assert_eq!(answer["helperPid"], json!(4242));
        assert_eq!(answer["imageBlob"]["byteLength"], json!(2));
        assert_eq!(answer["imageBlob"]["mimeType"], json!("image/png"));
        assert!(answer["imageBlob"]["digest"].as_str().unwrap().starts_with("sha256:"));
        let ran = log.lock().unwrap();
        assert_eq!(ran[0].0, "s1");
        assert_eq!(ran[0].1, ComputerRequest { action: ComputerAction::Capture, input: json!({ "app": "Notepad" }) });
    }

    #[tokio::test]
    async fn the_tool_shape_and_a_command_failure_are_answered() {
        let dir = tempfile::tempdir().unwrap();
        let (service, log) = service(true, true, false, dir.path());
        let service = service.unwrap();
        let answer = value(service.call(call(Origin::Local, json!({ "sessionThreadId": "s2", "command": { "action": "act", "input": { "x": 1 } } }))).await);
        assert_eq!(answer, json!({ "ok": false, "error": { "code": "stale_frame", "message": "stale_frame: unknown frame_id" } }));
        assert_eq!(log.lock().unwrap()[0].1.input, json!({ "x": 1 }));
    }

    /// An action that is not the tool's is the helper's own command: it reaches the session's helper as it is (without the
    /// `session_id` the call already names), its failure keeps the code its text opens with, and the lifecycle controls end the
    /// session's state.
    #[tokio::test]
    async fn a_helper_command_and_the_lifecycle_controls_are_answered() {
        let dir = tempfile::tempdir().unwrap();
        let log = Log::default();
        let host = Arc::new(Host::default());
        let sessions = Arc::new(Sessions { fail: false, hang: false, log: log.clone() });
        let service = DevComputerRun::if_enabled(&env(true), sessions, host.clone(), BlobStore::new(dir.path()), &mixdog_rt::testing::tokens()).unwrap();
        let run = |command: Value| call(Origin::Local, json!({ "sessionThreadId": "s1", "command": command }));

        let answer = value(service.call(run(json!({ "action": "click", "x": 3, "y": 4, "session_id": "ignored" }))).await);
        assert_eq!((answer["ok"].clone(), answer["helperPid"].clone()), (json!(true), json!(4242)));
        assert_eq!(serde_json::from_str::<Value>(answer["text"].as_str().unwrap()).unwrap(), json!({ "text": "done", "pid": 7 }));
        assert_eq!(host.helper.lock().unwrap()[0], ("s1".to_owned(), json!({ "action": "click", "x": 3, "y": 4 }).as_object().cloned().unwrap()));
        assert!(log.lock().unwrap().is_empty(), "the tool's backend was not used");

        let refused = value(service.call(run(json!({ "action": "close_window", "window_id": "hwnd:0x9" }))).await);
        assert_eq!(refused, json!({ "ok": false, "error": { "code": "computer_policy_denied", "message": "computer_policy_denied: not authorized" }, "helperPid": 4242 }));

        for (action, field, expected) in [("execution_end", "ended", true), ("session_release", "released", true), ("session_abort", "confirmed", false)] {
            let answer = value(service.call(run(json!({ "action": action }))).await);
            assert_eq!(serde_json::from_str::<Value>(answer["text"].as_str().unwrap()).unwrap()[field], json!(expected), "{action}");
        }
        assert_eq!(*host.ended.lock().unwrap(), vec!["end:s1", "release:s1", "abort:s1"]);

        let listed = value(service.call(run(json!({ "action": "authorization_windows" }))).await);
        assert_eq!(serde_json::from_str::<Value>(listed["text"].as_str().unwrap()).unwrap(), json!({ "windows": [{ "id": "hwnd:0x1", "pid": 5, "title": "t" }] }));
    }

    /// A helper command that outlives its wait ends its session, as the bridge aborted the session of a caller that went away.
    #[tokio::test(start_paused = true)]
    async fn a_helper_command_past_its_wait_aborts_the_session() {
        struct Stuck(Host);

        #[async_trait]
        impl DevComputerHost for Stuck {
            fn helper_pid(&self, session: &str) -> Option<u32> {
                self.0.helper_pid(session)
            }
            async fn helper(&self, _: &str, _: Map<String, Value>) -> Result<Map<String, Value>, String> {
                std::future::pending().await
            }
            async fn end_execution(&self, session: &str) -> bool {
                self.0.end_execution(session).await
            }
            async fn release(&self, session: &str) -> bool {
                self.0.release(session).await
            }
            async fn abort(&self, session: &str) -> bool {
                self.0.abort(session).await
            }
            async fn authorization_windows(&self, session: &str) -> Result<Vec<Value>, ComputerError> {
                self.0.authorization_windows(session).await
            }
            async fn stop_all(&self) {}
        }

        let dir = tempfile::tempdir().unwrap();
        let host = Arc::new(Stuck(Host::default()));
        let sessions = Arc::new(Sessions { fail: false, hang: false, log: Log::default() });
        let service = DevComputerRun::if_enabled(&env(true), sessions, host.clone(), BlobStore::new(dir.path()), &mixdog_rt::testing::tokens()).unwrap();
        let answer = value(service.call(call(Origin::Local, json!({ "sessionThreadId": "s1", "command": { "action": "sequence" }, "timeoutMs": 50 }))).await);
        assert_eq!(answer["error"]["code"], json!("timeout"));
        assert_eq!(*host.0.ended.lock().unwrap(), vec!["abort:s1"]);
    }

    #[tokio::test]
    async fn a_remote_origin_and_a_malformed_call_are_refused() {
        let dir = tempfile::tempdir().unwrap();
        let service = service(true, false, false, dir.path()).0.unwrap();
        let good = json!({ "sessionThreadId": "s1", "command": { "action": "list" } });
        for origin in [Origin::Ssh, Origin::Relay] {
            assert!(matches!(service.call(call(origin, good.clone())).await, Err(CoreError::PermissionDenied { .. })));
        }
        for bad in [
            json!({ "sessionThreadId": "s1", "command": {} }),
            json!({ "sessionThreadId": "s1", "command": { "action": "list" }, "timeoutMs": 120_001 }),
            json!({ "sessionThreadId": "", "command": { "action": "list" } }),
            json!({ "sessionThreadId": "s1", "command": { "action": "list" }, "extra": 1 }),
        ] {
            assert!(matches!(service.call(call(Origin::Local, bad)).await, Err(CoreError::InvalidParams { .. })));
        }
    }

    #[tokio::test(start_paused = true)]
    async fn a_command_past_its_wait_answers_a_timeout() {
        let dir = tempfile::tempdir().unwrap();
        let service = service(true, false, true, dir.path()).0.unwrap();
        let answer = value(service.call(call(Origin::Local, json!({ "sessionThreadId": "s1", "command": { "action": "wait_for_user" }, "timeoutMs": 50 }))).await);
        assert_eq!(answer["ok"], json!(false));
        assert_eq!(answer["error"]["code"], json!("timeout"));
    }
}
