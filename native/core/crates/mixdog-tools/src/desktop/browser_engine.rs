//! The `browser` and `browser_devtools` tools' host commands, run by the core's browser engine when the connected desktop serves
//! the engine's host lane (`host/browser/*`), and forwarded as `host/browser/command` otherwise.
//!
//! The choice is made per command from what the connected side says it serves ([`HostChannel::serves`] for
//! [`HostCapability::BrowserEngine`]); there is no switch. A command that is not an action of the Browser Use contract (the
//! runtime-only bridge actions of the secret input and the saved logins, and every action the pane itself answers) always goes the
//! way it went before, and so does every `visualize` command.

use std::sync::Arc;

use async_trait::async_trait;
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use mixdog_browser_engine::actions::registry::is_action;
use mixdog_browser_engine::reply::reply::ToolReply;
use mixdog_browser_engine::runner::runner::BrowserEngine;
use mixdog_core_api::HostCapability;
use mixdog_core_api::HostChannel;
use mixdog_core_api::domain::tool::ToolError;
use mixdog_protocol::JsonValue;
use mixdog_protocol::ThreadId;
use mixdog_rt::CancellationToken;
use serde_json::Map;
use serde_json::Value;

use super::host::ChannelHostCommands;
use super::host::HOST_COMMAND_FAILED;
use super::host::HostCommandError;
use super::host::HostCommands;

/// [`HostCommands`] whose Browser Use actions run in the engine.
pub struct EngineHostCommands {
    forward: Arc<ChannelHostCommands>,
    engine: Arc<BrowserEngine>,
    channel: Arc<dyn HostChannel>,
}

impl EngineHostCommands {
    /// `forward` carries what the engine does not run, `channel` says whether the connected desktop serves the engine.
    pub fn new(forward: Arc<ChannelHostCommands>, engine: Arc<BrowserEngine>, channel: Arc<dyn HostChannel>) -> Arc<Self> {
        Arc::new(Self { forward, engine, channel })
    }

    fn runs_in_engine(&self, action: &str) -> bool {
        is_action(action) && self.channel.serves(HostCapability::BrowserEngine)
    }
}

/// The turn a command belongs to, as the decimal text the engine reads: the `turn_id` the input carries, else none (`0`: the
/// command owns no page).
fn turn_text(input: &Map<String, Value>) -> String {
    match input.get("turn_id") {
        Some(Value::Number(number)) => number.to_string(),
        Some(Value::String(text)) => text.trim().to_owned(),
        _ => "0".to_owned(),
    }
}

/// The reply as the host's `host/browser/command` result value the `browser` tool renders (`browser_output`): text, image, outcome.
fn reply_value(reply: ToolReply) -> Value {
    let mut value = Map::new();
    value.insert("text".to_owned(), Value::String(reply.text));
    if let Some(image) = reply.image {
        value.insert("image".to_owned(), serde_json::json!({ "mimeType": image.mime_type, "data": STANDARD.encode(&image.bytes) }));
    }
    if let Some(outcome) = reply.outcome {
        value.insert("outcome".to_owned(), Value::String(outcome.as_str().to_owned()));
    }
    if let Some(timing) = reply.timing.and_then(|timing| serde_json::to_value(timing).ok()) {
        value.insert("timing".to_owned(), timing);
    }
    Value::Object(value)
}

/// A failed command as the host's refusal of it: the tool words it with `Error: ` as it did the host's own message. A command
/// the caller's token ended is cancelled, whichever way the engine worded it.
fn command_failure(error: ToolError, cancel: &CancellationToken) -> HostCommandError {
    if cancel.is_cancelled() {
        return HostCommandError::Cancelled;
    }
    HostCommandError::Rpc { code: HOST_COMMAND_FAILED, message: error.message_for_model, timing: None }
}

#[async_trait]
impl HostCommands for EngineHostCommands {
    async fn browser(&self, thread: &ThreadId, action: &str, input: JsonValue, cancel: &CancellationToken) -> Result<JsonValue, HostCommandError> {
        if !self.runs_in_engine(action) {
            return self.forward.browser(thread, action, input, cancel).await;
        }
        let empty = Map::new();
        let fields = input.as_object().unwrap_or(&empty);
        match self.engine.run(thread, &turn_text(fields), action, fields, cancel).await {
            Ok(reply) => Ok(reply_value(reply)),
            Err(error) => Err(command_failure(error, cancel)),
        }
    }

    async fn visualize(&self, thread: &ThreadId, cwd: &str, action: &str, input: JsonValue, cancel: &CancellationToken) -> Result<JsonValue, HostCommandError> {
        self.forward.visualize(thread, cwd, action, input, cancel).await
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;
    use std::path::PathBuf;
    use std::sync::Mutex;

    use bytes::Bytes;
    use mixdog_browser_engine::ApprovalPort;
    use mixdog_browser_engine::BlobPort;
    use mixdog_browser_engine::FilePort;
    use mixdog_browser_engine::TakeoverPort;
    use mixdog_browser_engine::approval::classify::ActionPolicy;
    use mixdog_browser_engine::fake::Expect;
    use mixdog_browser_engine::fake::FakeHost;
    use mixdog_browser_engine::fake::page_facts;
    use mixdog_browser_engine::lane::mirror::Mirror;
    use mixdog_browser_engine::queue::user_hold::UserHold;
    use mixdog_browser_engine::runner::guard::SecretGuard;
    use mixdog_browser_engine::runner::runner::EnginePorts;
    use mixdog_browser_engine::types::ApprovalAnswer;
    use mixdog_browser_engine::types::BrowserApprovalPrompt;
    use mixdog_browser_engine::types::FileFacts;
    use mixdog_browser_engine::types::TakeoverGuard;
    use mixdog_browser_policy::url_policy::UrlPolicy;
    use mixdog_core_api::CoreError;
    use mixdog_core_api::HostError;
    use mixdog_core_api::ids::Method;
    use serde_json::json;

    use super::*;

    /// A host channel that records the requests it was sent and says whether it serves the engine.
    struct Channel {
        serves_engine: bool,
        sent: Mutex<Vec<(HostCapability, &'static str)>>,
    }

    impl Channel {
        fn new(serves_engine: bool) -> Arc<Self> {
            Arc::new(Self { serves_engine, sent: Mutex::default() })
        }

        fn sent(&self) -> Vec<(HostCapability, &'static str)> {
            self.sent.lock().unwrap().clone()
        }
    }

    #[async_trait]
    impl HostChannel for Channel {
        async fn request(&self, capability: HostCapability, method: Method, _: Value) -> Result<Value, HostError> {
            self.sent.lock().unwrap().push((capability, method.as_str()));
            Ok(json!({ "text": "from the pane" }))
        }

        fn serves(&self, capability: HostCapability) -> bool {
            capability != HostCapability::BrowserEngine || self.serves_engine
        }

        fn notify(&self, _: HostCapability, _: Method, _: Value) -> Result<(), CoreError> {
            Ok(())
        }
    }

    struct Masks;

    impl SecretGuard for Masks {
        fn redact(&self, _: &str, text: &str) -> String {
            text.to_owned()
        }

        fn remember(&self, _: &str, _: &str) {}
    }

    struct Denies;

    #[async_trait]
    impl ApprovalPort for Denies {
        async fn ask(&self, _: BrowserApprovalPrompt) -> Result<ApprovalAnswer, ToolError> {
            Ok(ApprovalAnswer::Deny { reason: String::new() })
        }
    }

    struct Takeovers(Option<&'static str>);

    impl TakeoverPort for Takeovers {
        fn begin(&self, _: &str) -> Result<TakeoverGuard, String> {
            match self.0 {
                Some(refusal) => Err(refusal.to_owned()),
                None => Ok(TakeoverGuard::new(CancellationToken::new(), None)),
            }
        }
    }

    struct NoBlobs;

    #[async_trait]
    impl BlobPort for NoBlobs {
        async fn read(&self, _: &str) -> Result<Bytes, String> {
            Err("no blobs".to_owned())
        }
    }

    struct NoFiles;

    #[async_trait]
    impl FilePort for NoFiles {
        async fn stat(&self, _: &Path) -> FileFacts {
            FileFacts::default()
        }

        async fn write_frame(&self, run_dir: &Path, _: Bytes, _: &str) -> std::io::Result<PathBuf> {
            Ok(run_dir.to_path_buf())
        }
    }

    fn engine(host: &Arc<FakeHost>, takeover: Option<&'static str>) -> Arc<BrowserEngine> {
        Arc::new(BrowserEngine::new(
            host.clone(),
            EnginePorts {
                mirror: Arc::new(Mirror::new()),
                hold: Arc::new(UserHold::new()),
                approvals: Arc::new(Denies),
                takeover: Arc::new(Takeovers(takeover)),
                blobs: Arc::new(NoBlobs),
                files: Arc::new(NoFiles),
                secrets: Arc::new(Masks),
                approval_policy: ActionPolicy::from_env(None, None, None, is_action),
                urls: UrlPolicy::default(),
                frame_dir: PathBuf::from("frames"),
            },
        ))
    }

    fn commands(channel: &Arc<Channel>, host: &Arc<FakeHost>, takeover: Option<&'static str>) -> Arc<EngineHostCommands> {
        EngineHostCommands::new(ChannelHostCommands::new(channel.clone()), engine(host, takeover), channel.clone())
    }

    fn listed(page: &str) -> Expect {
        let row = json!({"pageId": page, "tabId": "v1", "sessionId": "s1", "background": false, "facts": page_facts(page, 1)});
        Expect::ok("host/browser/pages/list", json!({"pages": [row], "activePageId": page}))
    }

    #[tokio::test]
    async fn an_action_of_the_contract_runs_in_the_engine_when_the_desktop_serves_it() {
        let channel = Channel::new(true);
        let host = Arc::new(FakeHost::scripted(vec![listed("p1")]));
        let thread = ThreadId::from("s1");
        let value = commands(&channel, &host, None).browser(&thread, "list_tabs", json!({"turn_id": 3}), &CancellationToken::new()).await.expect("lists");
        assert!(value["text"].as_str().is_some_and(|text| text.contains("p1")), "{value}");
        assert!(channel.sent().is_empty(), "nothing went out as host/browser/command");
        host.finish().expect("the engine asked the host's lane once");
    }

    #[tokio::test]
    async fn without_a_serving_desktop_the_command_goes_out_as_host_browser_command() {
        let channel = Channel::new(false);
        let host = Arc::new(FakeHost::scripted(Vec::new()));
        let thread = ThreadId::from("s1");
        let value = commands(&channel, &host, None).browser(&thread, "list_tabs", json!({}), &CancellationToken::new()).await.expect("forwarded");
        assert_eq!(value["text"], "from the pane");
        assert_eq!(channel.sent(), [(HostCapability::Browser, "host/browser/command")]);
        assert!(host.calls().is_empty());
    }

    #[tokio::test]
    async fn the_runtime_only_actions_always_go_the_way_they_went() {
        let channel = Channel::new(true);
        let host = Arc::new(FakeHost::scripted(Vec::new()));
        let thread = ThreadId::from("s1");
        let commands = commands(&channel, &host, None);
        for action in ["secret_precheck", "secret_fill", "saved_login_admit", "secret_bind", "login_accounts", "page_url", "begin_turn"] {
            assert!(!is_action(action), "{action}");
            commands.browser(&thread, action, json!({}), &CancellationToken::new()).await.expect(action);
        }
        assert_eq!(channel.sent().len(), 7);
        assert!(host.calls().is_empty());
        commands.visualize(&thread, "/w", "open", json!({}), &CancellationToken::new()).await.expect("visualize");
        assert_eq!(channel.sent().last(), Some(&(HostCapability::Visualize, "host/visualize/command")));
    }

    #[tokio::test]
    async fn an_engine_failure_reads_as_the_hosts_refusal_did() {
        let channel = Channel::new(true);
        let host = Arc::new(FakeHost::scripted(Vec::new()));
        let thread = ThreadId::from("s1");
        let error = commands(&channel, &host, Some("a person has this session"))
            .browser(&thread, "snapshot", json!({}), &CancellationToken::new())
            .await
            .expect_err("taken over");
        assert_eq!(error, HostCommandError::Rpc { code: HOST_COMMAND_FAILED, message: "a person has this session".to_owned(), timing: None });
        let text = crate::desktop::host::command_error(crate::desktop::host::BROWSER_UNAVAILABLE, error).message_for_model;
        assert_eq!(text, "Error: a person has this session");
    }

    #[tokio::test]
    async fn a_command_the_callers_token_ended_is_cancelled() {
        let channel = Channel::new(true);
        let host = Arc::new(FakeHost::scripted(Vec::new()));
        let cancel = CancellationToken::new();
        cancel.cancel();
        let answer = commands(&channel, &host, Some("a person has this session")).browser(&ThreadId::from("s1"), "snapshot", json!({}), &cancel).await;
        assert_eq!(answer, Err(HostCommandError::Cancelled));
    }

    #[test]
    fn the_turn_is_the_number_the_input_carries() {
        let turn = |input: Value| turn_text(input.as_object().unwrap());
        assert_eq!(turn(json!({"turn_id": 7})), "7");
        assert_eq!(turn(json!({"turn_id": " 12 "})), "12");
        assert_eq!(turn(json!({"turn_id": null})), "0");
        assert_eq!(turn(json!({})), "0");
    }

    #[test]
    fn a_reply_is_the_value_the_browser_tool_renders() {
        use mixdog_browser_engine::reply::reply::ReplyImage;
        use mixdog_browser_engine::reply::reply::ReplyOutcome;
        let reply = ToolReply {
            text: "Clicked".to_owned(),
            image: Some(ReplyImage { mime_type: "image/png".to_owned(), bytes: Bytes::from_static(b"png") }),
            outcome: Some(ReplyOutcome::Blocked),
            ..ToolReply::default()
        };
        let value = reply_value(reply);
        assert_eq!(value["text"], "Clicked");
        assert_eq!(value["image"], json!({"mimeType": "image/png", "data": "cG5n"}));
        assert_eq!(value["outcome"], "blocked");
        let error = crate::desktop::host::browser_output(&value).expect_err("blocked is a failure");
        assert_eq!(error.message_for_model, "Clicked");
        assert!(error.partial.is_some());
        assert_eq!(reply_value(ToolReply::text("")), json!({"text": ""}));
    }
}
