//! Guard over the whole engine: the host connection is lost on the Nth host call of each mutating command of the recorded script
//! (form fill, sequence, click, navigation, upload, ...), and every one of those commands answers as a command that may have
//! executed (`CommandFailure::connection_lost`), whichever layer between the host call and the answer would have swallowed or
//! worded the error. A refusal at the very first call, before anything was handed over, is not that.
//!
//! The recorded host (`browser-engine-transcript.jsonl`) is replayed up to the command under test with every call answered, then the
//! command runs with the loss injected at one of its host calls; the calls of each command are counted by a first, whole pass.

use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;

use async_trait::async_trait;
use bytes::Bytes;
use mixdog_browser_engine::ApprovalPort;
use mixdog_browser_engine::BlobPort;
use mixdog_browser_engine::FilePort;
use mixdog_browser_engine::HostCallError;
use mixdog_browser_engine::TakeoverPort;
use mixdog_browser_engine::actions::registry::is_action;
use mixdog_browser_engine::approval::classify::ActionPolicy;
use mixdog_browser_engine::fake::FakeHost;
use mixdog_browser_engine::lane::mirror::Mirror;
use mixdog_browser_engine::lane::sink::EngineSinkImpl;
use mixdog_browser_engine::limits::OBSERVATION_ACTIONS;
use mixdog_browser_engine::port::HostWire;
use mixdog_browser_engine::queue::user_hold::UserHold;
use mixdog_browser_engine::runner::guard::SecretGuard;
use mixdog_browser_engine::runner::runner::BrowserEngine;
use mixdog_browser_engine::runner::runner::CommandFailure;
use mixdog_browser_engine::runner::runner::EnginePorts;
use mixdog_browser_engine::types::ApprovalAnswer;
use mixdog_browser_engine::types::BrowserApprovalPrompt;
use mixdog_browser_engine::types::FileFacts;
use mixdog_browser_engine::types::Remember;
use mixdog_browser_engine::types::TakeoverGuard;
use mixdog_browser_policy::url_policy::UrlPolicy;
use mixdog_core_api::domain::tool::ToolError;
use mixdog_protocol::ThreadId;
use mixdog_rt::CancellationToken;
use regex::Regex;
use serde_json::Map;
use serde_json::Value;

struct NoSecrets;

impl SecretGuard for NoSecrets {
    fn redact(&self, _session_id: &str, text: &str) -> String {
        text.to_owned()
    }

    fn remember(&self, _session_id: &str, _secret: &str) {}
}

struct Allows;

#[async_trait]
impl ApprovalPort for Allows {
    async fn ask(&self, _prompt: BrowserApprovalPrompt) -> Result<ApprovalAnswer, ToolError> {
        Ok(ApprovalAnswer::Allow { remember: Remember::Once })
    }
}

struct NoTakeover;

impl TakeoverPort for NoTakeover {
    fn begin(&self, _session_id: &str) -> Result<TakeoverGuard, String> {
        Ok(TakeoverGuard::new(CancellationToken::new(), None))
    }
}

struct NoBlobs;

#[async_trait]
impl BlobPort for NoBlobs {
    async fn read(&self, digest: &str) -> Result<Bytes, String> {
        Err(format!("the transcript holds no blob {digest}"))
    }
}

struct RecordedFiles;

#[async_trait]
impl FilePort for RecordedFiles {
    async fn stat(&self, path: &Path) -> FileFacts {
        FileFacts { exists: true, is_file: true, size: 22, canonical: Some(path.to_path_buf()), modified: None }
    }

    async fn write_frame(&self, run_dir: &Path, _bytes: Bytes, _mime_type: &str) -> std::io::Result<PathBuf> {
        Ok(run_dir.to_path_buf())
    }
}

/// The recorded host, counting every call it is asked and failing the one at `fail_at` (not forwarded) with `error`.
struct Chaos {
    inner: Arc<FakeHost>,
    calls: AtomicUsize,
    fail_at: Option<usize>,
    error: HostCallError,
}

#[async_trait]
impl HostWire for Chaos {
    async fn call(&self, method: &'static str, params: Value, cancel: &CancellationToken) -> Result<Value, HostCallError> {
        let index = self.calls.fetch_add(1, Ordering::SeqCst);
        if Some(index) == self.fail_at {
            return Err(self.error.clone());
        }
        self.inner.call(method, params, cancel).await
    }

    fn notify(&self, method: &'static str, params: Value) -> Result<(), HostCallError> {
        self.inner.notify(method, params)
    }
}

/// One command of the corpus as it ran: its action, the host calls it made (by index over the whole replay) and what it answered.
struct Ran {
    action: String,
    calls: std::ops::Range<usize>,
    outcome: Result<(), CommandFailure>,
}

struct Script {
    transcript: String,
    origin: String,
    commands: Vec<Value>,
}

impl Script {
    fn load() -> Self {
        let golden: Value = serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/desktop-host/browser-golden.json")).expect("browser-golden.json is JSON");
        let steps = golden["steps"].as_array().expect("the corpus has steps");
        let upload_path = steps.iter().find(|step| step["request"]["action"] == "upload").and_then(|step| step["request"]["paths"][0].as_str()).expect("the corpus has an upload");
        let transcript = mixdog_testkit::fixture!("../../fixtures/desktop-host/browser-engine-transcript.jsonl")
            .replace("<UPLOAD>", serde_json::to_string(upload_path).expect("a path is JSON").trim_matches('"'));
        let origin = Regex::new(r"http://127\.0\.0\.1:\d+").expect("a valid pattern").find(&transcript).map_or_else(|| "<ORIGIN>".to_owned(), |found| found.as_str().to_owned());
        let commands = steps.iter().map(|step| step["request"].clone()).collect();
        Self { transcript, origin, commands }
    }

    /// Replays the commands up to and including `last`, the host losing its connection (or refusing) at call `fail_at`.
    async fn replay(&self, last: usize, fail_at: Option<usize>, error: HostCallError) -> Vec<Ran> {
        let inner = Arc::new(FakeHost::from_transcript_str(&self.transcript).expect("the transcript is readable"));
        let chaos = Arc::new(Chaos { inner: inner.clone(), calls: AtomicUsize::new(0), fail_at, error });
        let mirror = Arc::new(Mirror::new());
        let hold = Arc::new(UserHold::new());
        let engine = BrowserEngine::new(
            chaos.clone(),
            EnginePorts {
                mirror: mirror.clone(),
                hold: hold.clone(),
                approvals: Arc::new(Allows),
                takeover: Arc::new(NoTakeover),
                blobs: Arc::new(NoBlobs),
                files: Arc::new(RecordedFiles),
                secrets: Arc::new(NoSecrets),
                approval_policy: ActionPolicy::from_env(None, None, None, is_action),
                urls: UrlPolicy::default(),
                frame_dir: PathBuf::from("frames"),
            },
        );
        inner.attach_sink(engine.sink(Arc::new(EngineSinkImpl::new(mirror, hold))));
        let thread = ThreadId::from("loss-guard");
        let mut ran = Vec::new();
        for request in self.commands.iter().take(last.saturating_add(1)) {
            let request = request.as_object().expect("a step has its request");
            let command: Map<String, Value> = serde_json::from_str(&Value::Object(request.clone()).to_string().replace("<ORIGIN>", &self.origin)).expect("a request is JSON");
            let started = chaos.calls.load(Ordering::SeqCst);
            // A request the bridge refuses never reaches the engine.
            let (action, outcome) = match mixdog_tools::desktop::browser_bridge_run::validated_command(command) {
                Err(_) => (String::new(), Ok(())),
                Ok((action, input)) => {
                    let outcome = engine.run(&thread, &action, &input, &CancellationToken::new()).await.map(|_| ());
                    (action, outcome)
                }
            };
            ran.push(Ran { action, calls: started..chaos.calls.load(Ordering::SeqCst), outcome });
        }
        ran
    }
}

fn mutating(action: &str) -> bool {
    !action.is_empty() && !OBSERVATION_ACTIONS.contains(&action)
}

// The settle and poll waits run on the paused clock: the recorded host answers at once.
#[tokio::test(start_paused = true)]
async fn a_connection_lost_after_a_mutating_command_was_handed_over_is_never_answered_as_a_plain_failure() {
    let script = Script::load();
    let whole = script.replay(usize::MAX, None, HostCallError::ConnectionLost).await;
    let mut losses = 0;
    let mut refusals = 0;
    let mut problems = Vec::new();
    for (index, step) in whole.iter().enumerate() {
        if !mutating(&step.action) || step.calls.is_empty() {
            continue;
        }
        // The loss at each host call of the command: a request was handed to the host, so the command may have run.
        for call in step.calls.clone() {
            let ran = script.replay(index, Some(call), HostCallError::ConnectionLost).await;
            losses += 1;
            match &ran[index].outcome {
                Err(failure) if failure.connection_lost => {}
                Err(failure) => problems.push(format!("{} (step {index}), loss at call {call}: answered {:?} without the loss", step.action, failure.error.message_for_model)),
                Ok(()) => problems.push(format!("{} (step {index}), loss at call {call}: answered as a success", step.action)),
            }
        }
        // A refusal at the first call, with nothing handed over, is the plain unavailable kind.
        let first = step.calls.start;
        let ran = script.replay(index, Some(first), HostCallError::Unavailable { detail: "noClaimant".into() }).await;
        refusals += 1;
        if let Err(failure) = &ran[index].outcome
            && failure.connection_lost
        {
            problems.push(format!("{} (step {index}), no claimant at call {first}: answered as a possible execution", step.action));
        }
    }
    assert!(losses >= 20 && refusals >= 10, "the script exercises mutating commands: {losses} losses, {refusals} refusals");
    assert!(problems.is_empty(), "{} case(s):\n{}", problems.len(), problems.join("\n"));
}
