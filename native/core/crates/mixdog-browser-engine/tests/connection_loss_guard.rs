//! Guard over the whole engine: the host connection is lost at each host call of a mutating command (navigate, reload, back, a
//! navigate into a background tab the command opens, a cookie write), and every one of those commands answers as a command that may have executed
//! (`CommandFailure::connection_lost`), whichever layer between the host call and the answer would have swallowed or worded the
//! error. A refusal at the very first call, before anything was handed over, is not that.
//!
//! Each command runs against a scripted host written here; a first, whole pass counts its host calls and checks the script is the
//! one the command follows.

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
use mixdog_browser_engine::fake::Expect;
use mixdog_browser_engine::fake::FakeHost;
use mixdog_browser_engine::fake::page_facts;
use mixdog_browser_engine::lane::mirror::Mirror;
use mixdog_browser_engine::lane::sink::EngineSinkImpl;
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
use serde_json::Value;
use serde_json::json;

const THREAD: &str = "s1";

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
        Err(format!("the script holds no blob {digest}"))
    }
}

struct NoFiles;

#[async_trait]
impl FilePort for NoFiles {
    async fn stat(&self, _path: &Path) -> FileFacts {
        FileFacts::default()
    }

    async fn write_frame(&self, run_dir: &Path, _bytes: Bytes, _mime_type: &str) -> std::io::Result<PathBuf> {
        Ok(run_dir.to_path_buf())
    }
}

/// The scripted host, counting every call it is asked and failing the one at `fail_at` (not forwarded) with `error`.
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

fn page_row(page: &str) -> Value {
    json!({"pageId": page, "tabId": "v1", "sessionId": THREAD, "background": false, "facts": page_facts(page, 1)})
}

/// The page the command works on, already open.
fn resolved(page: &str) -> Expect {
    Expect::ok("host/browser/pages/resolve", json!({"page": page_row(page), "leaseId": "lease-1"}))
}

/// The blank background page the command just opened: its facts name the document and no address yet.
fn resolved_blank(page: &str) -> Expect {
    let mut row = page_row(page);
    row["background"] = json!(true);
    row["created"] = json!(true);
    row["disposable"] = json!(true);
    row["facts"]["url"] = json!("");
    row["facts"]["background"] = json!(true);
    row["facts"]["visible"] = json!(false);
    Expect::ok("host/browser/pages/resolve", json!({"page": row, "leaseId": "lease-1"}))
}

/// The move answered on a new document with a dialog open: the command answers with the dialog, without the settle.
fn moved(page: &str) -> Expect {
    let mut facts = page_facts(page, 2);
    facts["documentId"] = json!(format!("{page}:2"));
    facts["url"] = json!("https://b.test/app");
    facts["pendingDialog"] = json!({"type": "alert", "message": "Arrived", "openedAt": 1, "bridge": false});
    Expect::ok("host/browser/page/navigate", json!({"facts": facts}))
}

/// A cookie written on the page: a mutation that moves nothing.
fn cookie_set() -> Expect {
    Expect::ok("host/browser/cookies", json!({"facts": page_facts("p1", 2)}))
}

/// One mutating command, the host calls it makes, in order, and what its answer says when they all succeed.
struct Command {
    action: &'static str,
    input: Value,
    script: fn() -> Vec<Expect>,
    says: &'static str,
}

fn commands() -> Vec<Command> {
    vec![
        Command { action: "navigate", input: json!({"url": "https://b.test/app"}), script: || vec![resolved("p1"), moved("p1")], says: "Arrived" },
        Command { action: "navigate", input: json!({"reload": true}), script: || vec![resolved("p1"), moved("p1")], says: "Arrived" },
        Command { action: "back", input: json!({}), script: || vec![resolved("p1"), moved("p1")], says: "Arrived" },
        Command {
            action: "navigate",
            input: json!({"url": "https://b.test/app", "background": true, "tab": "live"}),
            script: || vec![resolved_blank("p1"), moved("p1")],
            says: "Arrived",
        },
        Command {
            action: "cookies",
            input: json!({"operation": "set", "name": "a", "value": "1"}),
            script: || vec![resolved("p1"), cookie_set()],
            says: "Set cookie \"a\"",
        },
    ]
}

/// Runs `command` once against its script, the host losing its connection (or refusing) at call `fail_at`: the outcome, the number
/// of host calls the command made, and the scripted host.
async fn run(command: &Command, fail_at: Option<usize>, error: HostCallError) -> (Result<String, CommandFailure>, usize, Arc<FakeHost>) {
    let inner = Arc::new(FakeHost::scripted((command.script)()));
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
            files: Arc::new(NoFiles),
            secrets: Arc::new(NoSecrets),
            approval_policy: ActionPolicy::from_env(None, None, None, is_action),
            urls: UrlPolicy::default(),
            frame_dir: PathBuf::from("frames"),
        },
    );
    inner.attach_sink(engine.sink(Arc::new(EngineSinkImpl::new(mirror, hold))));
    let input = command.input.as_object().cloned().unwrap_or_default();
    let outcome = engine.run(&ThreadId::from(THREAD), command.action, &input, &CancellationToken::new()).await.map(|reply| reply.text);
    (outcome, chaos.calls.load(Ordering::SeqCst), inner)
}

// Any settle or poll wait runs on the paused clock: the scripted host answers at once.
#[tokio::test(start_paused = true)]
async fn a_connection_lost_after_a_mutating_command_was_handed_over_is_never_answered_as_a_plain_failure() {
    let mut losses = 0;
    let mut refusals = 0;
    let mut problems = Vec::new();
    for command in commands() {
        let name = format!("{} {}", command.action, command.input);
        let (whole, calls, host) = run(&command, None, HostCallError::ConnectionLost).await;
        let text = whole.unwrap_or_else(|failure| panic!("{name}: the whole pass failed: {}", failure.error.message_for_model));
        assert!(text.contains(command.says), "{name}: {text}");
        host.finish().unwrap_or_else(|mismatch| panic!("{name}: the command does not follow its script: {mismatch}"));
        assert!(calls >= 2, "{name}: {calls} host call(s)");
        // The loss at each host call of the command: a request was handed to the host, so the command may have run.
        for call in 0..calls {
            losses += 1;
            match run(&command, Some(call), HostCallError::ConnectionLost).await.0 {
                Err(failure) if failure.connection_lost => {}
                Err(failure) => problems.push(format!("{name}, loss at call {call}: answered {:?} without the loss", failure.error.message_for_model)),
                Ok(_) => problems.push(format!("{name}, loss at call {call}: answered as a success")),
            }
        }
        // A refusal at the first call, with nothing handed over, is the plain unavailable kind.
        refusals += 1;
        match run(&command, Some(0), HostCallError::Unavailable { detail: "noClaimant".into() }).await.0 {
            Err(failure) if !failure.connection_lost => {}
            Err(_) => problems.push(format!("{name}, no claimant at call 0: answered as a possible execution")),
            Ok(_) => problems.push(format!("{name}, no claimant at call 0: answered as a success")),
        }
    }
    assert!(losses >= 10 && refusals == 5, "every command was exercised: {losses} losses, {refusals} refusals");
    assert!(problems.is_empty(), "{} case(s):\n{}", problems.len(), problems.join("\n"));
}
