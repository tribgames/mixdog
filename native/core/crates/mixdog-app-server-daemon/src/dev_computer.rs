//! Test hook (cargo feature `test-hooks`, refused in a release build by build.rs; registered only when the daemon starts with
//! `MIXDOGD_TEST_HOOKS=1`): `dev/computer/run`, the entry the live Computer Use harness drives. It runs ONE command through the
//! same `ComputerSessionPool` and `GatedComputerBackend` the `computer` tool uses (`ComputerSessions::backend`), outside a model
//! turn, and answers what the old resident bridge's `POST /command` answered (`scenario-runtime.ts`): the reply text, the image as
//! a blob reference, and the helper's process id for the harness's own process checks.
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
use mixdog_core_api::domain::tool::ImageData;
use mixdog_core_api::domain::tool::ToolPart;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::service::Admit;
use mixdog_core_base::support::decode;
use mixdog_core_base::support::invalid;
use mixdog_core_base::support::on_lane;
use mixdog_protocol::Origin;
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

/// The helper process id of a session's helper, where the pool knows it.
pub(crate) type HelperPid = Arc<dyn Fn(&str) -> Option<u32> + Send + Sync>;

pub(crate) struct DevComputerRun {
    sessions: Arc<dyn ComputerSessions>,
    blobs: BlobStore,
    interactive: InteractiveIo,
    durability: DurabilityIo,
    helper_pid: HelperPid,
}

impl DevComputerRun {
    /// The service when the hooks are on, else `None` (the method is then unregistered, answered as unknown).
    pub(crate) fn if_enabled(
        env: &dyn Fn(&str) -> Option<String>,
        sessions: Arc<dyn ComputerSessions>,
        blobs: BlobStore,
        tokens: &LaneTokens,
        helper_pid: HelperPid,
    ) -> Option<Arc<Self>> {
        test_hooks_enabled(env).then(|| Arc::new(Self { sessions, blobs, interactive: tokens.interactive_io, durability: tokens.durability_io, helper_pid }))
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
        let request = command_request(&params.command).map_err(|expected| invalid("params/command", &expected))?;
        // The command runs under the call's own cancel: the connection closing, or the wait ending, stops it.
        let cancel = req.ctx.cancel.child_token();
        let backend = self.sessions.backend(&params.session_thread_id);
        let outcome = match tokio::time::timeout(Duration::from_millis(u64::from(timeout_ms)), backend.run(request, cancel.clone())).await {
            Ok(outcome) => outcome,
            Err(_) => {
                cancel.cancel();
                Err(ComputerError::Failed { code: "timeout".into(), message: format!("the command did not finish within {timeout_ms} ms") })
            }
        };
        let mut answer = match outcome {
            Ok(parts) => self.answer(req, parts).await?,
            Err(error) => failure(error),
        };
        if let Some(pid) = (self.helper_pid)(&params.session_thread_id) {
            answer["helperPid"] = json!(pid);
        }
        Ok(answer)
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

/// The request of a command: the tool's own shape (`{action, input: {..}}`) or the bridge's flat one (`{action, ..fields}`, which
/// is what the harness sent to `/command`; a `session_id` in it is the session the call already names).
fn command_request(command: &Map<String, Value>) -> Result<ComputerRequest, String> {
    let name = command.get("action").and_then(Value::as_str).ok_or("a command names its `action`")?.trim();
    let action = ComputerAction::from_wire(name).ok_or_else(|| format!("unknown computer action \"{name}\""))?;
    let input = match command.get("input") {
        Some(Value::Object(input)) => Value::Object(input.clone()),
        Some(Value::Null) | None => Value::Object(command.iter().filter(|(key, _)| !matches!(key.as_str(), "action" | "session_id")).map(|(key, value)| (key.clone(), value.clone())).collect()),
        Some(_) => return Err(format!("computer action \"{name}\" input must be an object")),
    };
    Ok(ComputerRequest { action, input })
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

    fn env(on: bool) -> impl Fn(&str) -> Option<String> {
        move |name| (on && name == TEST_HOOKS_ENV).then(|| "1".to_owned())
    }

    fn service(on: bool, fail: bool, hang: bool, dir: &std::path::Path) -> (Option<Arc<DevComputerRun>>, Log) {
        let log = Log::default();
        let sessions = Arc::new(Sessions { fail, hang, log: log.clone() });
        let tokens = mixdog_rt::testing::tokens();
        let service = DevComputerRun::if_enabled(&env(on), sessions, BlobStore::new(dir), &tokens, Arc::new(|session| (session == "s1").then_some(4242)));
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

    #[tokio::test]
    async fn a_remote_origin_and_a_malformed_call_are_refused() {
        let dir = tempfile::tempdir().unwrap();
        let service = service(true, false, false, dir.path()).0.unwrap();
        let good = json!({ "sessionThreadId": "s1", "command": { "action": "list" } });
        for origin in [Origin::Ssh, Origin::Relay] {
            assert!(matches!(service.call(call(origin, good.clone())).await, Err(CoreError::PermissionDenied { .. })));
        }
        for bad in [
            json!({ "sessionThreadId": "s1", "command": { "action": "zap" } }),
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
