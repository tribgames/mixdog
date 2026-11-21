//! The `browser` and `browser_devtools` host commands: run by the core's browser engine when the connected desktop serves the
//! engine's host lane (`host/browser/*`), forwarded as `host/browser/command` otherwise. A command that is not an action of the
//! Browser Use contract, and every `visualize` command, is always forwarded.

use std::sync::Arc;

use async_trait::async_trait;
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use mixdog_browser_engine::actions::registry::is_action;
use mixdog_browser_engine::reply::reply::ToolReply;
use mixdog_browser_engine::runner::runner::BrowserEngine;
use mixdog_browser_engine::runner::runner::CommandFailure;
use mixdog_core_api::CoreError;
use mixdog_core_api::HostCapability;
use mixdog_core_api::HostChannel;
use mixdog_core_api::HostError;
use mixdog_protocol::JsonValue;
use mixdog_protocol::ThreadId;
use mixdog_rt::CancellationToken;
use serde_json::Map;
use serde_json::Value;

use super::host::BrowserCommandClock;
use super::host::BrowserTimingLog;
use super::host::BrowserToolReply;
use super::host::ChannelHostCommands;
use super::host::HOST_COMMAND_FAILED;
use super::host::HostCommandError;
use super::host::HostCommands;

/// The Browser Use switch (`desktop.browserControl`) as it stands now. Node's `setBridgeEnabled(false)` stopped the bridge, so a
/// command in flight failed and a new one found no bridge; here the engine is the core's own, so the switch is read per command.
#[async_trait]
pub trait BrowserSwitch: Send + Sync {
    /// Whether Browser Use is on right now.
    fn enabled(&self) -> bool;
    /// Completes once Browser Use is off (at once when it already is).
    async fn off(&self);
}

/// [`HostCommands`] whose Browser Use actions run in the engine.
#[derive(Clone)]
pub struct EngineHostCommands {
    forward: Arc<ChannelHostCommands>,
    engine: Arc<BrowserEngine>,
    channel: Arc<dyn HostChannel>,
    timing: Option<BrowserTimingLog>,
    switch: Option<Arc<dyn BrowserSwitch>>,
}

impl EngineHostCommands {
    /// `forward` carries what the engine does not run, `channel` says whether the connected desktop serves the engine.
    pub fn new(forward: Arc<ChannelHostCommands>, engine: Arc<BrowserEngine>, channel: Arc<dyn HostChannel>) -> Arc<Self> {
        Arc::new(Self { forward, engine, channel, timing: None, switch: None })
    }

    /// Also hands the `browser_timing` row of each command the engine runs to `timing`, as [`ChannelHostCommands::with_timing`] does
    /// for the commands it sends: a command that failed carries the timing of the part that ran.
    pub fn with_timing(forward: Arc<ChannelHostCommands>, engine: Arc<BrowserEngine>, channel: Arc<dyn HostChannel>, timing: BrowserTimingLog) -> Arc<Self> {
        Arc::new(Self { forward, engine, channel, timing: Some(timing), switch: None })
    }

    /// Every browser command, the engine's and the forwarded ones, answers to `switch`: with Browser Use off a new command finds
    /// no host (the unavailable answer), and one in flight when it goes off fails as a command does whose bridge went down.
    pub fn switched(self: Arc<Self>, switch: Arc<dyn BrowserSwitch>) -> Arc<Self> {
        Arc::new(Self { switch: Some(switch), ..(*self).clone() })
    }

    fn runs_in_engine(&self, action: &str) -> bool {
        is_action(action) && self.channel.serves(HostCapability::BrowserEngine)
    }
}

/// Keep the engine's screenshot in bytes for the local tool, leaving other media on its existing path.
fn tool_reply(reply: ToolReply) -> BrowserToolReply {
    let mut value = Map::new();
    value.insert("text".to_owned(), Value::String(reply.text));
    // A completed download the command attached (`downloads` with `attach`): the old path's `result.file`.
    if let Some(file) = reply.file {
        value.insert("file".to_owned(), serde_json::json!({ "mimeType": file.mime_type, "name": file.name, "data": STANDARD.encode(&file.bytes) }));
    }
    if let Some(outcome) = reply.outcome {
        value.insert("outcome".to_owned(), Value::String(outcome.as_str().to_owned()));
    }
    if let Some(timing) = reply.timing.and_then(|timing| serde_json::to_value(timing).ok()) {
        value.insert("timing".to_owned(), timing);
    }
    BrowserToolReply { value: Value::Object(value), screenshot: reply.image }
}

/// The JSON API (including `browser/bridge/run`) retains its existing image shape.
fn reply_value(mut reply: BrowserToolReply) -> Value {
    if let Some(image) = reply.screenshot {
        reply.value["image"] = serde_json::json!({ "mimeType": image.mime_type, "data": STANDARD.encode(&image.bytes) });
    }
    reply.value
}

/// What the `browser_timing` row reads of an answer, in the shape the host channel gives one: a result's `timing`, a refusal's
/// `data.timing`, and a cancelled command with no body.
fn row_answer(answer: &Result<BrowserToolReply, HostCommandError>) -> Result<&JsonValue, HostError> {
    match answer {
        Ok(reply) => Ok(&reply.value),
        Err(HostCommandError::Rpc { code, message, timing }) => {
            Err(HostError::Rpc { code: *code, message: message.clone(), data: timing.as_ref().map(|timing| serde_json::json!({ "timing": timing })) })
        }
        Err(HostCommandError::Cancelled | HostCommandError::NoHost) => {
            Err(HostError::Core(CoreError::CapabilityUnavailable { capability: "desktopHost".into(), detail: "cancelled".into() }))
        }
    }
}

#[async_trait]
impl HostCommands for EngineHostCommands {
    async fn browser(&self, thread: &ThreadId, action: &str, input: JsonValue, cancel: &CancellationToken) -> Result<JsonValue, HostCommandError> {
        self.browser_for_tool(thread, action, input, cancel).await.map(reply_value)
    }

    async fn browser_for_tool(
        &self,
        thread: &ThreadId,
        action: &str,
        input: JsonValue,
        cancel: &CancellationToken,
    ) -> Result<BrowserToolReply, HostCommandError> {
        let Some(switch) = &self.switch else {
            return self.browser_command(thread, action, input, cancel).await;
        };
        if !switch.enabled() {
            return Err(HostCommandError::NoHost);
        }
        tokio::select! {
            answer = self.browser_command(thread, action, input, cancel) => answer,
            () = switch.off() => Err(super::host::browser_connection_lost(action)),
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
    use mixdog_browser_engine::HostCallError;
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
    use mixdog_core_api::domain::tool::ToolError;
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
        let value = commands(&channel, &host, None).browser(&thread, "list_tabs", json!({}), &CancellationToken::new()).await.expect("lists");
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

    struct Switch(tokio::sync::watch::Sender<bool>);

    #[async_trait]
    impl BrowserSwitch for Switch {
        fn enabled(&self) -> bool {
            *self.0.borrow()
        }

        async fn off(&self) {
            let _ = self.0.subscribe().wait_for(|on| !*on).await;
        }
    }

    /// A desktop that takes a command and never answers it.
    struct Silent;

    #[async_trait]
    impl HostChannel for Silent {
        async fn request(&self, _: HostCapability, _: Method, _: Value) -> Result<Value, HostError> {
            std::future::pending().await
        }

        fn serves(&self, capability: HostCapability) -> bool {
            capability != HostCapability::BrowserEngine
        }

        fn notify(&self, _: HostCapability, _: Method, _: Value) -> Result<(), CoreError> {
            Ok(())
        }
    }

    #[tokio::test]
    async fn browser_use_switched_off_fails_the_next_command_and_switched_on_admits_it_again() {
        let channel = Channel::new(true);
        let host = Arc::new(FakeHost::scripted(vec![listed("p1")]));
        let (tx, _) = tokio::sync::watch::channel(true);
        let commands = commands(&channel, &host, None).switched(Arc::new(Switch(tx.clone())));
        let thread = ThreadId::from("s1");
        let live = CancellationToken::new();
        tx.send_replace(false);
        for action in ["list_tabs", "begin_turn"] {
            assert_eq!(
                commands.browser(&thread, action, json!({}), &live).await,
                Err(HostCommandError::NoHost),
                "{action}: the engine's and the forwarded path both"
            );
        }
        assert!(channel.sent().is_empty() && host.calls().is_empty(), "nothing was sent anywhere while it was off");
        tx.send_replace(true);
        assert!(commands.browser(&thread, "list_tabs", json!({}), &live).await.is_ok());
    }

    #[tokio::test]
    async fn a_command_in_flight_when_browser_use_goes_off_fails_as_one_whose_bridge_went_down() {
        let channel: Arc<dyn HostChannel> = Arc::new(Silent);
        let host = Arc::new(FakeHost::scripted(Vec::new()));
        let (tx, _) = tokio::sync::watch::channel(true);
        let commands = EngineHostCommands::new(ChannelHostCommands::new(channel.clone()), engine(&host, None), channel).switched(Arc::new(Switch(tx.clone())));
        let thread = ThreadId::from("s1");
        let live = CancellationToken::new();
        let off = async {
            tokio::task::yield_now().await;
            tx.send_replace(false);
        };
        let (state_changing, _) = tokio::join!(commands.browser(&thread, "begin_turn", json!({}), &live), off);
        assert!(
            matches!(&state_changing, Err(HostCommandError::Rpc { message, .. }) if message.contains("may have executed and was not replayed")),
            "{state_changing:?}"
        );
        // An observation can be asked again: it reads as the missing desktop.
        assert_eq!(commands.browser(&thread, "list_tabs", json!({}), &live).await, Err(HostCommandError::NoHost));
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
    async fn a_command_that_failed_hands_its_row_the_timing_of_the_part_that_ran_and_the_refusal_carries_it() {
        let channel = Channel::new(true);
        let row = json!({"pageId": "p1", "tabId": "v1", "sessionId": "s1", "background": false, "facts": page_facts("p1", 1)});
        let host = Arc::new(FakeHost::scripted(vec![
            Expect::ok("host/browser/pages/resolve", json!({"page": row, "leaseId": "lease-1"})),
            Expect::err("host/browser/snapshot", HostCallError::Failed { message: "page is unavailable".into() }),
        ]));
        let rows: Arc<Mutex<Vec<Map<String, Value>>>> = Arc::default();
        let log: BrowserTimingLog = {
            let rows = rows.clone();
            Arc::new(move |args| rows.lock().unwrap().push(args))
        };
        let commands = EngineHostCommands::with_timing(ChannelHostCommands::new(channel.clone()), engine(&host, None), channel.clone(), log);
        let error = commands.browser(&ThreadId::from("s1"), "snapshot", json!({}), &CancellationToken::new()).await.expect_err("the snapshot fails");
        let HostCommandError::Rpc { message, timing: Some(timing), .. } = error else { panic!("a refusal with its timing: {error:?}") };
        assert_eq!(message, "page is unavailable");
        assert!(timing["commandMs"].is_number(), "{timing}");
        let rows = rows.lock().unwrap();
        assert_eq!(rows.len(), 1, "one row for the command");
        assert_eq!((rows[0]["body"]["ok"].as_bool(), &rows[0]["body"]["timing"], rows[0]["status"].as_i64()), (Some(false), &timing, Some(200)));
        assert_eq!(rows[0]["context"]["action"], "snapshot");
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

    /// The loss of the host connection is the engine's typed cause; a page exception whose text equals the transport message is an
    /// ordinary failure the agent reads as it is.
    #[test]
    fn only_the_typed_connection_loss_is_answered_as_a_lost_command() {
        use mixdog_core_api::domain::tool::ToolError;
        use mixdog_core_api::domain::tool::ToolErrorCode;
        let live = CancellationToken::new();
        let failure = |text: &str, connection_lost: bool| CommandFailure {
            error: ToolError::new(ToolErrorCode::Failed { reason: text.to_owned() }, text),
            timing: None,
            connection_lost,
        };
        let thrown = "the browser host is unavailable: claimantClosed";
        assert_eq!(
            command_failure(failure(thrown, false), &live, "click"),
            HostCommandError::Rpc { code: HOST_COMMAND_FAILED, message: thrown.to_owned(), timing: None }
        );
        let lost = command_failure(failure("lost", true), &live, "click");
        assert!(matches!(&lost, HostCommandError::Rpc { message, .. } if message.contains("may have executed and was not replayed")), "{lost:?}");
        assert_eq!(command_failure(failure("lost", true), &live, "snapshot"), HostCommandError::NoHost);
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
        let local = tool_reply(reply.clone());
        let output = crate::desktop::host::render_browser_output(&local.value, local.screenshot).expect_err("blocked carries a partial result");
        let value = reply_value(tool_reply(reply));
        assert_eq!(value["text"], "Clicked");
        assert_eq!(value["image"], json!({"mimeType": "image/png", "data": "cG5n"}));
        assert_eq!(value["outcome"], "blocked");
        let error = crate::desktop::host::browser_output(&value).expect_err("blocked is a failure");
        assert_eq!(error.message_for_model, "Clicked");
        assert_eq!(output.partial, error.partial);
        assert_eq!(reply_value(tool_reply(ToolReply::text(""))), json!({"text": ""}));
    }
}

/// A failed command as the host's refusal of it: the tool words it with `Error: ` as it did the host's own message, and the
/// refusal carries the timing of the part that ran. A command the caller's token ended is cancelled, whichever way the engine
/// worded it.
fn command_failure(failure: CommandFailure, cancel: &CancellationToken, action: &str) -> HostCommandError {
    if cancel.is_cancelled() {
        return HostCommandError::Cancelled;
    }
    // The desktop's claim ended while the command was out (the engine's typed cause): the same lost-connection answer the
    // forwarded commands give.
    if failure.connection_lost {
        return crate::desktop::host::browser_connection_lost(action);
    }
    let timing = failure.timing.and_then(|timing| serde_json::to_value(timing).ok());
    HostCommandError::Rpc { code: HOST_COMMAND_FAILED, message: failure.error.message_for_model, timing }
}
impl EngineHostCommands {
    async fn browser_command(
        &self,
        thread: &ThreadId,
        action: &str,
        input: JsonValue,
        cancel: &CancellationToken,
    ) -> Result<BrowserToolReply, HostCommandError> {
        if !self.runs_in_engine(action) {
            return self.forward.browser_for_tool(thread, action, input, cancel).await;
        }
        let empty = Map::new();
        let fields = input.as_object().unwrap_or(&empty);
        let turn_id = self.timing.as_ref().and_then(|_| fields.get("turn_id").cloned());
        let clock = BrowserCommandClock::start(self.timing.as_ref());
        let answer = match self.engine.run(thread, action, fields, cancel).await {
            Ok(reply) => Ok(tool_reply(reply)),
            Err(failure) => Err(command_failure(failure, cancel, action)),
        };
        if let Some(clock) = clock {
            let row = row_answer(&answer);
            clock.stop(thread, action, turn_id, row.as_ref().map(|value| *value));
        }
        answer
    }
}
