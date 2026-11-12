//! Where a filled secret is hidden from the agent: the replies of the two tools whose output can
//! carry what the page or the screen shows. Node redacts exactly there, in the window process, with
//! the session's remembered secrets (`secretInputs.redact`):
//! - Browser Use: the reply's `text` and a failure's message (`browser/agent-bridge.ts`
//!   `guardBrowserSecrets`);
//! - Computer Use: the reply's `text` and a failure's message (`computer/host/bridge-server-request.ts`
//!   `sealReply` and the error path).
//!
//! The value is held by the core now (the fill sends it to the desktop for that one fill and the
//! desktop remembers nothing), so the core hides it, on the same two paths, before the reply is a
//! tool result and so before it is stored in the transcript. Nothing else is touched: images, the
//! other reply fields and the visualize tool pass as they came.

use std::sync::Arc;

use async_trait::async_trait;
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
use mixdog_protocol::JsonValue;
use mixdog_tools::desktop::host::HostCommandError;
use mixdog_tools::desktop::host::HostCommands;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use super::SecretFill;
use super::SessionSecrets;

/// `secretInputs.redact(sessionId, text)`: `text` with every value filled for the session hidden.
pub trait Redact: Send + Sync {
    fn redact(&self, thread: &ThreadId, text: &str) -> String;
}

impl Redact for SecretFill {
    fn redact(&self, thread: &ThreadId, text: &str) -> String {
        SecretFill::redact(self, thread, text)
    }
}

impl Redact for SessionSecrets {
    fn redact(&self, thread: &ThreadId, text: &str) -> String {
        SessionSecrets::redact(self, thread.as_str(), text)
    }
}

/// The browser commands of [`HostCommands`] with the session's filled secrets hidden from the
/// reply `text` and from a failure's message.
pub struct RedactingHostCommands {
    inner: Arc<dyn HostCommands>,
    redactor: Arc<dyn Redact>,
}

impl RedactingHostCommands {
    pub fn new(inner: Arc<dyn HostCommands>, redactor: Arc<dyn Redact>) -> Self {
        Self { inner, redactor }
    }
}

#[async_trait]
impl HostCommands for RedactingHostCommands {
    async fn browser(&self, thread: &ThreadId, action: &str, input: JsonValue, cancel: &mixdog_rt::CancellationToken) -> Result<JsonValue, HostCommandError> {
        match self.inner.browser(thread, action, input, cancel).await {
            Ok(mut reply) => {
                if let Some(Value::String(text)) = reply.get_mut("text") {
                    *text = self.redactor.redact(thread, text);
                }
                Ok(reply)
            }
            Err(HostCommandError::Rpc { code, message, timing }) => {
                Err(HostCommandError::Rpc { code, message: self.redactor.redact(thread, &message), timing })
            }
            Err(other) => Err(other),
        }
    }

    async fn visualize(&self, thread: &ThreadId, cwd: &str, action: &str, input: JsonValue, cancel: &mixdog_rt::CancellationToken) -> Result<JsonValue, HostCommandError> {
        self.inner.visualize(thread, cwd, action, input, cancel).await
    }
}

/// One session's [`ComputerBackend`] with the session's filled secrets hidden from the text parts
/// of a reply and from a failure's message. Images and JSON parts pass as they came.
pub struct RedactingComputerBackend {
    inner: Arc<dyn ComputerBackend>,
    thread: ThreadId,
    redactor: Arc<dyn Redact>,
}

impl RedactingComputerBackend {
    pub fn new(inner: Arc<dyn ComputerBackend>, thread: ThreadId, redactor: Arc<dyn Redact>) -> Self {
        Self { inner, thread, redactor }
    }

    fn hide(&self, text: &str) -> String {
        self.redactor.redact(&self.thread, text)
    }
}

#[async_trait]
impl ComputerBackend for RedactingComputerBackend {
    async fn run(&self, request: ComputerRequest, cancel: CancellationToken) -> Result<Vec<ToolPart>, ComputerError> {
        match self.inner.run(request, cancel).await {
            Ok(parts) => Ok(parts
                .into_iter()
                .map(|part| match part {
                    ToolPart::Text(text) => ToolPart::Text(self.hide(&text)),
                    other => other,
                })
                .collect()),
            Err(ComputerError::Failed { code, message }) => Err(ComputerError::Failed { code, message: self.hide(&message) }),
            Err(ComputerError::Unavailable { reason }) => Err(ComputerError::Unavailable { reason: self.hide(&reason) }),
            Err(ComputerError::InvalidInput { reason }) => Err(ComputerError::InvalidInput { reason: self.hide(&reason) }),
            Err(other) => Err(other),
        }
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
    use std::time::Duration;

    use mixdog_core_api::domain::computer::ComputerAction;
    use mixdog_core_base::support::testing::request;
    use mixdog_core_base::support::testing::value;
    use serde_json::json;

    use super::super::ComputerCommands;
    use super::super::FillGates;
    use super::super::SecretInputService;
    use super::super::SecretSlots;
    use super::*;

    const ID: &str = "secret_0123456789ab";
    const VALUE: &str = "Tr0ub4dor&3";

    /// What the page and the screen show after the fill: the value, in text, in an error and next to
    /// other fields.
    struct Page {
        reply: Value,
        failure: Option<String>,
    }

    #[async_trait]
    impl HostCommands for Page {
        async fn browser(&self, _: &ThreadId, _: &str, _: JsonValue, _: &mixdog_rt::CancellationToken) -> Result<JsonValue, HostCommandError> {
            match &self.failure {
                Some(message) => Err(HostCommandError::Rpc { code: -32000, message: message.clone(), timing: Some(json!({ "ms": 3 })) }),
                None => Ok(self.reply.clone()),
            }
        }
        async fn visualize(&self, _: &ThreadId, _: &str, _: &str, _: JsonValue, _: &mixdog_rt::CancellationToken) -> Result<JsonValue, HostCommandError> {
            Ok(self.reply.clone())
        }
    }

    struct Screen {
        parts: Vec<ToolPart>,
        failure: Option<ComputerError>,
    }

    #[async_trait]
    impl ComputerBackend for Screen {
        async fn run(&self, _: ComputerRequest, _: CancellationToken) -> Result<Vec<ToolPart>, ComputerError> {
            match &self.failure {
                Some(error) => Err(error.clone()),
                None => Ok(self.parts.clone()),
            }
        }
        fn inject(&self, _: ScreenInput) -> Result<InputOutcome, ComputerError> {
            Err(ComputerError::Denied)
        }
        fn release_input(&self) -> Result<u32, ComputerError> {
            Ok(7)
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
            ComputerStatus { active: true, observe_only: false, controller: None }
        }
    }

    fn click() -> ComputerRequest {
        ComputerRequest { action: ComputerAction::ALL[0], input: json!({}) }
    }

    fn remembering(session: &str, value: &str) -> Arc<SessionSecrets> {
        let secrets = Arc::new(SessionSecrets::new());
        secrets.remember(session, value);
        secrets
    }

    #[tokio::test]
    async fn a_browser_reply_and_failure_hide_the_sessions_secret_and_nothing_else() {
        let secrets = remembering("S1", VALUE);
        let reply = json!({ "text": format!("field shows {VALUE}!"), "url": format!("https://x.test/?q={VALUE}"), "n": 3 });
        let shown = RedactingHostCommands::new(Arc::new(Page { reply: reply.clone(), failure: None }), secrets.clone());
        let got = shown.browser(&ThreadId::from("S1"), "read", json!({}), &mixdog_rt::CancellationToken::new()).await.unwrap();
        assert_eq!(got["text"], "field shows [redacted]!");
        assert_eq!((&got["url"], &got["n"]), (&reply["url"], &reply["n"]), "only the reply text is redacted, as Node does");
        let other = shown.browser(&ThreadId::from("S2"), "read", json!({}), &mixdog_rt::CancellationToken::new()).await.unwrap();
        assert_eq!(other, reply, "another session's reply is untouched");
        let failing = RedactingHostCommands::new(Arc::new(Page { reply: json!({}), failure: Some(format!("typed {VALUE} failed")) }), secrets);
        let error = failing.browser(&ThreadId::from("S1"), "read", json!({}), &mixdog_rt::CancellationToken::new()).await.unwrap_err();
        assert_eq!(error, HostCommandError::Rpc { code: -32000, message: "typed [redacted] failed".into(), timing: Some(json!({ "ms": 3 })) });
        assert_eq!(failing.visualize(&ThreadId::from("S1"), "/p", "x", json!({}), &mixdog_rt::CancellationToken::new()).await.unwrap(), json!({}));
    }

    #[tokio::test]
    async fn a_computer_reply_and_failure_hide_the_sessions_secret_and_keep_other_parts() {
        let secrets = remembering("S1", VALUE);
        let image = ToolPart::Image { mime: "image/png".into(), data: mixdog_core_api::domain::tool::ImageData::Bytes(vec![1, 2]), width: None, height: None };
        let parts = vec![ToolPart::Text(format!("typed {VALUE}")), image.clone(), ToolPart::Json(json!({ "k": VALUE }))];
        let backend = RedactingComputerBackend::new(Arc::new(Screen { parts: parts.clone(), failure: None }), ThreadId::from("S1"), secrets.clone());
        let got = backend.run(click(), CancellationToken::new()).await.unwrap();
        assert_eq!(got, vec![ToolPart::Text("typed [redacted]".into()), image, parts[2].clone()]);
        for (failure, want) in [
            (ComputerError::Failed { code: "c".into(), message: format!("no {VALUE}") }, ComputerError::Failed { code: "c".into(), message: "no [redacted]".into() }),
            (ComputerError::Unavailable { reason: format!("no {VALUE}") }, ComputerError::Unavailable { reason: "no [redacted]".into() }),
            (ComputerError::InvalidInput { reason: format!("no {VALUE}") }, ComputerError::InvalidInput { reason: "no [redacted]".into() }),
            (ComputerError::Denied, ComputerError::Denied),
        ] {
            let failing = RedactingComputerBackend::new(Arc::new(Screen { parts: Vec::new(), failure: Some(failure) }), ThreadId::from("S1"), secrets.clone());
            assert_eq!(failing.run(click(), CancellationToken::new()).await.unwrap_err(), want);
        }
        assert_eq!((backend.release_input(), backend.status().active), (Ok(7), true));
    }

    struct Open;

    impl FillGates for Open {
        fn browser_free(&self, _: &ThreadId) -> bool {
            true
        }
        fn computer_free(&self) -> bool {
            true
        }
    }

    /// The helper types whatever it is told and the screen then shows it.
    struct Typing;

    #[async_trait]
    impl ComputerCommands for Typing {
        async fn execute(&self, _: &ThreadId, _: Value) -> Result<Value, String> {
            Ok(Value::Null)
        }
    }

    /// A computer fill never asks the desktop.
    struct NoDesktop;

    #[async_trait]
    impl mixdog_core_api::HostChannel for NoDesktop {
        async fn request(&self, _: mixdog_core_api::HostCapability, _: mixdog_core_api::ids::Method, _: Value) -> Result<Value, mixdog_core_api::HostError> {
            unreachable!("a computer fill sends nothing to the desktop")
        }
        fn notify(&self, _: mixdog_core_api::HostCapability, _: mixdog_core_api::ids::Method, _: Value) -> Result<(), mixdog_core_api::CoreError> {
            unreachable!("a computer fill sends nothing to the desktop")
        }
    }

    #[async_trait]
    impl mixdog_core_api::ClaimedHostChannel for NoDesktop {
        async fn request_claimed(&self, _: mixdog_core_api::HostCapability, _: mixdog_core_api::ids::Method, _: Value) -> Result<(mixdog_core_api::HostClaim, Value), mixdog_core_api::HostError> {
            unreachable!("a computer fill sends nothing to the desktop")
        }
        async fn request_to(&self, _: &mixdog_core_api::HostClaim, _: mixdog_core_api::HostCapability, _: mixdog_core_api::ids::Method, _: Value) -> Result<Value, mixdog_core_api::HostError> {
            unreachable!("a computer fill sends nothing to the desktop")
        }
    }

    /// The whole path: the card's value arrives through `approval/provideSecret`, the computer fill
    /// types it, and every reply the agent can see afterwards - browser and computer, text and
    /// failure - carries `[redacted]`. Those replies are what becomes the tool results, so none of
    /// them, and so nothing stored in the transcript, holds the value.
    #[tokio::test]
    async fn a_provided_secret_is_in_no_reply_the_agent_sees() {
        let slots = Arc::new(SecretSlots::new(Duration::from_secs(120)));
        let fill = Arc::new(SecretFill::new(slots.clone(), Arc::new(Open), Arc::new(Typing), Arc::new(NoDesktop)));
        let thread = ThreadId::from("S1");
        let provide = SecretInputService::new(slots.clone());
        assert!(slots.bind_computer(ID, "S1", "w1", "e1"));
        let params = json!({ "opId": "x", "requestId": ID, "secret": VALUE });
        assert_eq!(value(&provide, request("approval/provideSecret", params, Some(1))).await.unwrap(), json!({}));
        assert_eq!(fill.computer_input(&thread, ID, "w1", "e1").await, "entered");

        let page = RedactingHostCommands::new(
            Arc::new(Page { reply: json!({ "text": format!("the page now reads {VALUE}") }), failure: None }),
            fill.clone(),
        );
        let broken = RedactingHostCommands::new(Arc::new(Page { reply: json!({}), failure: Some(format!("{VALUE} rejected")) }), fill.clone());
        let screen = RedactingComputerBackend::new(
            Arc::new(Screen { parts: vec![ToolPart::Text(format!("screen shows {VALUE}"))], failure: Some(ComputerError::Failed { code: "c".into(), message: format!("{VALUE} gone") }) }),
            thread.clone(),
            fill.clone(),
        );
        let ok_screen = RedactingComputerBackend::new(
            Arc::new(Screen { parts: vec![ToolPart::Text(format!("screen shows {VALUE}"))], failure: None }),
            thread.clone(),
            fill.clone(),
        );
        let stored = Mutex::new(Vec::<String>::new());
        let keep = |text: String| stored.lock().unwrap().push(text);
        keep(page.browser(&thread, "read", json!({}), &mixdog_rt::CancellationToken::new()).await.unwrap().to_string());
        keep(format!("{:?}", broken.browser(&thread, "read", json!({}), &mixdog_rt::CancellationToken::new()).await.unwrap_err()));
        keep(format!("{:?}", ok_screen.run(click(), CancellationToken::new()).await.unwrap()));
        keep(format!("{:?}", screen.run(click(), CancellationToken::new()).await.unwrap_err()));
        let stored = stored.into_inner().unwrap();
        assert!(stored.iter().all(|text| !text.contains(VALUE) && text.contains("[redacted]")), "{stored:?}");
        assert!(!slots.has(ID), "and the slot itself is spent");
    }
}
