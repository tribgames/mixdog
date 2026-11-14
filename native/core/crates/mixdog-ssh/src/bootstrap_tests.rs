//! Tests of the bootstrap, the server cleanup and the failure views (cases of the desktop's remote-bootstrap,
//! remote-cleanup, connect-failure and remote-connect tests). No process is started: the remote is a scripted spawner
//! that answers each ssh run with the next reply and records the program arguments and the bytes sent on stdin.

use std::collections::BTreeMap;
use std::io;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::Duration;

use async_trait::async_trait;
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use mixdog_app_protocol::v2::connections::SshFailureKind;
use serde_json::{json, Value};
use tokio::io::{AsyncRead, AsyncWrite};

use crate::bootstrap::{
    bootstrap, parse_remote_discovery, parse_remote_report, BootstrapOptions, BootstrapPhase, ServerBinary, ServerIdentity, ServerPayloads,
};
use crate::cleanup::{cleanup_server, CleanupOptions, CleanupProgress};
use crate::command::{parse_ssh_target, FailureClass, SshError, SshTarget};
use crate::connect_failure::{failure_of, login_key_commands, ConnectError};
use crate::context::{
    AttemptContext, ChildExit, ConfigFiles, ModelLogin, Platform, PreparedSpawn, SshChild, SshConfigFiles, SshEnv, SshSpawner, ToolOutput,
    ToolRunner,
};
use crate::diagnostics::{DiagnosticKind, Diagnostics};
use crate::install_wire::{RemoteBootstrapError, ServerPlatform};

// ---- the fake remote ----

struct Reply {
    stdout: String,
    stderr: String,
    code: i32,
}

/// ssh stand-in: each exec prints the next scripted stdout and exits; the last reply answers every later run.
struct ScriptedSsh {
    replies: Vec<Reply>,
    calls: Mutex<Vec<Vec<String>>>,
    inputs: Arc<Mutex<Vec<Vec<u8>>>>,
}

struct Stdin {
    inputs: Arc<Mutex<Vec<Vec<u8>>>>,
    index: usize,
}

impl AsyncWrite for Stdin {
    fn poll_write(self: Pin<&mut Self>, _cx: &mut Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
        self.inputs.lock().unwrap()[self.index].extend_from_slice(buf);
        Poll::Ready(Ok(buf.len()))
    }

    fn poll_flush(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }

    fn poll_shutdown(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }
}

struct Child {
    stdout: Option<Vec<u8>>,
    stderr: Option<Vec<u8>>,
    stdin: Option<Stdin>,
    code: i32,
}

#[async_trait]
impl SshChild for Child {
    fn take_stdin(&mut self) -> Option<Box<dyn AsyncWrite + Send + Unpin>> {
        self.stdin.take().map(|stdin| Box::new(stdin) as Box<dyn AsyncWrite + Send + Unpin>)
    }

    fn take_stdout(&mut self) -> Option<Box<dyn AsyncRead + Send + Unpin>> {
        self.stdout.take().map(|bytes| Box::new(io::Cursor::new(bytes)) as Box<dyn AsyncRead + Send + Unpin>)
    }

    fn take_stderr(&mut self) -> Option<Box<dyn AsyncRead + Send + Unpin>> {
        self.stderr.take().map(|bytes| Box::new(io::Cursor::new(bytes)) as Box<dyn AsyncRead + Send + Unpin>)
    }

    async fn wait(&mut self) -> io::Result<ChildExit> {
        Ok(ChildExit { code: Some(self.code), signal: None })
    }

    fn kill(&mut self) {}
}

impl SshSpawner for ScriptedSsh {
    fn spawn(&self, prepared: &PreparedSpawn) -> io::Result<Box<dyn SshChild>> {
        let mut calls = self.calls.lock().unwrap();
        let index = calls.len();
        calls.push(prepared.args.clone());
        self.inputs.lock().unwrap().push(Vec::new());
        let reply = &self.replies[index.min(self.replies.len() - 1)];
        Ok(Box::new(Child {
            stdout: Some(reply.stdout.clone().into_bytes()),
            stderr: Some(reply.stderr.clone().into_bytes()),
            stdin: Some(Stdin { inputs: self.inputs.clone(), index }),
            code: reply.code,
        }))
    }
}

struct NoFiles;

impl ConfigFiles for NoFiles {
    fn read_text(&self, _path: &Path) -> Option<String> {
        None
    }

    fn list_names(&self, _directory: &Path) -> Vec<String> {
        Vec::new()
    }

    fn is_file(&self, _path: &Path) -> bool {
        false
    }
}

struct NoConfigs;

impl SshConfigFiles for NoConfigs {
    fn for_args(&self, _args: &[String]) -> Option<PathBuf> {
        None
    }

    fn generic(&self) -> Option<PathBuf> {
        None
    }
}

struct NoTools;

#[async_trait]
impl ToolRunner for NoTools {
    async fn run(&self, command: &Path, _args: &[String], _timeout: Duration) -> io::Result<ToolOutput> {
        Err(io::Error::other(format!("unexpected {}", command.display())))
    }
}

fn world(replies: Vec<Reply>) -> (SshEnv, Arc<ScriptedSsh>) {
    let ssh = Arc::new(ScriptedSsh { replies, calls: Mutex::new(Vec::new()), inputs: Arc::new(Mutex::new(Vec::new())) });
    let env = SshEnv {
        platform: Platform::Linux,
        env: BTreeMap::new(),
        home: PathBuf::from("/home/tester"),
        askpass_helper: None,
        server_cores_dir: None,
        files: Arc::new(NoFiles),
        config_files: Arc::new(NoConfigs),
        tools: Arc::new(NoTools),
        spawner: ssh.clone(),
        diagnostics: Arc::new(Diagnostics::new()),
    };
    (env, ssh)
}

impl ScriptedSsh {
    fn call_count(&self) -> usize {
        self.calls.lock().unwrap().len()
    }

    /// The `server-ensure` arguments of the n-th recorded ssh run.
    fn program_args(&self, n: usize) -> Value {
        let calls = self.calls.lock().unwrap();
        let command = calls[n].last().unwrap();
        let encoded = command.split("printf %s ").nth(1).unwrap().split(' ').next().unwrap();
        let script = String::from_utf8(STANDARD.decode(encoded).unwrap()).unwrap();
        let args = script.split("\nARGS='").nth(1).unwrap().split('\'').next().unwrap();
        serde_json::from_slice(&STANDARD.decode(args).unwrap()).unwrap()
    }

    fn input(&self, n: usize) -> Vec<u8> {
        self.inputs.lock().unwrap()[n].clone()
    }
}

/// A staged release of one fake bundle per platform.
struct FakePayloads {
    identity: ServerIdentity,
    bundles: BTreeMap<String, Vec<u8>>,
}

fn payloads(platforms: &[&str]) -> FakePayloads {
    FakePayloads {
        identity: ServerIdentity { version: "1.4.6".to_owned(), build: "0123456789abcdef".to_owned() },
        bundles: platforms.iter().map(|key| ((*key).to_owned(), format!("bundle {key}\n").into_bytes())).collect(),
    }
}

impl FakePayloads {
    fn digests(&self, key: &str) -> (String, String) {
        (crate::install_wire::sha256_hex(format!("mixdogd {key}").as_bytes()), crate::install_wire::sha256_hex(&self.bundles[key]))
    }
}

impl ServerPayloads for FakePayloads {
    fn identity(&self) -> &ServerIdentity {
        &self.identity
    }

    fn binary(&self, platform: ServerPlatform) -> Result<ServerBinary, RemoteBootstrapError> {
        let key = platform.key();
        let archive = self.bundles.get(&key).ok_or_else(|| {
            RemoteBootstrapError::from_wire("local-payload", format!("This desktop ships no Mixdog server runtime for {key}."), None)
        })?;
        let (sha256, bundle_sha256) = self.digests(&key);
        Ok(ServerBinary { sha256, bundle_sha256, archive: archive.clone() })
    }
}

fn discovery_json(change: impl FnOnce(&mut serde_json::Map<String, Value>)) -> String {
    let mut core = json!({
        "version": "1.4.6", "build": "b", "instanceId": "i-1", "processStartTime": "t", "state": "serving",
        "rpc": { "port": 41001 }, "control": { "port": 41002 },
    });
    if let Some(map) = core.as_object_mut() {
        change(map);
    }
    json!({ "pid": 4242, "endpoints": { "session": { "port": 41002, "token": "session-secret-1" } }, "core": core }).to_string()
}

fn serving() -> String {
    discovery_json(|_| {})
}

fn with_platform(body: &str) -> String {
    format!("MIXDOG_PLATFORM Linux x86_64|glibc\n{body}\n")
}

/// A MIXDOG_RESULT reply for a Linux x64 glibc server: a serving, current core unless `overrides` say otherwise.
fn result(overrides: Value) -> Reply {
    let mut value = json!({
        "home": "/home/alice", "uid": 1000, "runtimeRoot": "/tmp/mixdog-1000",
        "versionDir": "/home/alice/.mixdog-remote/versions/1.4.6-0123456789abcdef", "installed": true,
        "daemonJson": serving(), "healthy": true, "coreCurrent": true, "started": false,
    });
    for (key, field) in overrides.as_object().into_iter().flatten() {
        value[key] = field.clone();
    }
    Reply { stdout: with_platform(&format!("MIXDOG_RESULT {value}")), stderr: String::new(), code: 0 }
}

fn error_reply(code: &str, message: &str, drain: Option<Value>) -> Reply {
    let drain_line = drain.map(|drain| format!("MIXDOG_DRAIN {drain}\n")).unwrap_or_default();
    Reply { stdout: with_platform(&format!("{drain_line}MIXDOG_ERROR {code} {message}")), stderr: String::new(), code: 3 }
}

/// What a server with an older core, or none, reports to the probe.
fn older() -> Value {
    json!({ "coreCurrent": false, "daemonJson": discovery_json(|core| {
        core.insert("version".into(), json!("1.4.5"));
        core.insert("build".into(), json!("old"));
    }) })
}

fn empty() -> Value {
    json!({ "installed": false, "healthy": false, "coreCurrent": false, "daemonJson": null })
}

fn target(name: &str) -> SshTarget {
    parse_ssh_target(name).unwrap()
}

fn all_platforms() -> FakePayloads {
    payloads(&["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"])
}

type Phases = Mutex<Vec<BootstrapPhase>>;

async fn run_bootstrap(
    env: &SshEnv,
    context: &AttemptContext,
    host: &str,
    model_login: Option<ModelLogin>,
    release: &FakePayloads,
    phases: &Phases,
) -> Result<crate::bootstrap::RemoteReport, ConnectError> {
    let progress = |phase: BootstrapPhase| phases.lock().unwrap().push(phase);
    bootstrap(env, context, &target(host), BootstrapOptions { model_login, payloads: release, progress: &progress }).await
}

fn bootstrap_error(result: Result<crate::bootstrap::RemoteReport, ConnectError>) -> RemoteBootstrapError {
    match result {
        Err(ConnectError::Bootstrap(error)) => error,
        other => panic!("expected a bootstrap error, got {other:?}"),
    }
}

// ---- parsing ----

#[test]
fn remote_discovery_reads_the_control_port_the_serving_rpc_port_token_and_identity() {
    let found = parse_remote_discovery(&serving()).unwrap();
    assert_eq!((found.rpc_port, found.control_port), (Some(41001), 41002));
    assert_eq!((found.token.as_str(), found.pid, found.instance_id.as_str()), ("session-secret-1", 4242, "i-1"));
    assert_eq!((found.process_start_time.as_str(), found.state.as_str(), found.version.as_str(), found.build.as_str()), ("t", "serving", "1.4.6", "b"));
    // A draining core keeps its control listener and has no RPC listener.
    let draining = parse_remote_discovery(&discovery_json(|core| {
        core.insert("state".into(), json!("draining"));
        core.remove("rpc");
    }))
    .unwrap();
    assert_eq!((draining.rpc_port, draining.control_port), (None, 41002));
}

#[test]
fn remote_discovery_rejects_incomplete_or_malformed_daemon_json() {
    assert_eq!(parse_remote_discovery("not json"), None);
    assert_eq!(parse_remote_discovery("null"), None);
    let document = |change: &dyn Fn(&mut Value)| {
        let mut value: Value = serde_json::from_str(&serving()).unwrap();
        change(&mut value);
        value.to_string()
    };
    assert_eq!(parse_remote_discovery(&document(&|value| value["pid"] = json!(0))), None);
    assert_eq!(parse_remote_discovery(&document(&|value| value["core"] = Value::Null)), None);
    assert_eq!(parse_remote_discovery(&document(&|value| value["core"]["control"]["port"] = json!(70000))), None);
    assert_eq!(parse_remote_discovery(&document(&|value| value["endpoints"] = json!({ "session": { "port": 1 } }))), None);
    // A 1.4.5 daemon's file has no core block: it is not a 1.4.6 discovery document.
    assert_eq!(parse_remote_discovery(r#"{"pid":9,"endpoints":{"session":{"port":4100,"token":"t"}}}"#), None);
}

#[test]
fn parse_result_and_error() {
    let stdout = |reply: &Reply| reply.stdout.clone();
    let report = parse_remote_report(&format!("motd noise\n{}", stdout(&result(json!({}))))).unwrap();
    assert_eq!((report.home.as_str(), report.uid, report.healthy, report.core_current), ("/home/alice", 1000, true, true));
    assert_eq!(report.discovery.as_ref().and_then(|found| found.rpc_port), Some(41001));
    assert!(!report.started && report.replaced.is_none() && report.installed);
    let replaced = parse_remote_report(&stdout(&result(json!({ "started": true, "replaced": { "pid": 7, "version": "1.4.5", "graceful": true } })))).unwrap();
    let replaced = replaced.replaced.unwrap();
    assert_eq!((replaced.pid, replaced.version.as_str(), replaced.graceful), (7, "1.4.5", true));
    let missing = parse_remote_report(&stdout(&result(json!({ "daemonJson": null })))).unwrap();
    assert_eq!((missing.discovery, missing.healthy, missing.core_current), (None, false, false));
    // The document itself stands in for its text; a core without an RPC listener never counts as serving.
    let object = serde_json::from_str::<Value>(&discovery_json(|core| {
        core.remove("rpc");
    }))
    .unwrap();
    let draining = parse_remote_report(&stdout(&result(json!({ "daemonJson": object })))).unwrap();
    assert_eq!((draining.healthy, draining.core_current), (false, false));
    assert_eq!(parse_remote_report("MIXDOG_RESULT {\"gcRemoved\":[\"a\",1]}\n").unwrap().gc_removed, ["a", "1"]);

    let outdated = bootstrap_error(parse_remote_report("MIXDOG_ERROR client-outdated This Mixdog is older than the server.\n").map_err(ConnectError::from));
    assert_eq!((outdated.code.as_str(), outdated.message.as_str()), ("client-outdated", "This Mixdog is older than the server."));
    assert!(outdated.is_terminal());
    let drain = json!({ "drainId": "d1", "confirmToken": "tok",
        "running": [{ "kind": "turn", "threadId": "t1", "turnId": null, "title": "fix the build" }] });
    let busy = parse_remote_report(&format!("MIXDOG_DRAIN {drain}\nMIXDOG_ERROR daemon-busy-other-version The older core is running 1 turn.\n")).unwrap_err();
    let listing = busy.detail.unwrap();
    assert_eq!((busy.code.as_str(), listing.confirm_token.as_str()), ("daemon-busy-other-version", "tok"));
    assert_eq!((listing.running[0].title.as_str(), listing.running[0].turn_id.clone()), ("fix the build", None));
    // The output of a shell that knows no sh holds no result.
    assert_eq!(parse_remote_report("bash: sh: not found").unwrap_err().code, "protocol");
    assert_eq!(parse_remote_report("MIXDOG_RESULT {torn").unwrap_err().code, "protocol");
}

#[test]
fn an_unsupported_platform_outranks_whatever_failed_after_the_probe() {
    let error = parse_remote_report("MIXDOG_PLATFORM Linux x86_64|musl\nMIXDOG_ERROR install-failed gzip missing\n").unwrap_err();
    assert!(error.code == "unsupported-platform" && error.message.contains("musl") && error.is_terminal());
}

// ---- bootstrap ----

#[tokio::test]
async fn an_equal_serving_core_is_attached_to_after_one_probe_uploading_nothing() {
    let (env, ssh) = world(vec![result(json!({}))]);
    let phases = Phases::default();
    let report = run_bootstrap(&env, &AttemptContext::default(), "equal-core", None, &all_platforms(), &phases).await.unwrap();
    let (found, rpc) = report.serving().unwrap();
    assert_eq!((rpc, found.control_port, found.token.as_str()), (41001, 41002, "session-secret-1"));
    assert_eq!(ssh.call_count(), 1);
    let probe = ssh.program_args(0);
    assert_eq!((&probe["mode"], &probe["installId"], &probe["version"]), (&json!("probe"), &json!("1.4.6-0123456789abcdef"), &json!("1.4.6")));
    assert!(probe.get("upload").is_none());
    assert_eq!(*phases.lock().unwrap(), [BootstrapPhase::Check { detail: "linux-x64".to_owned() }]);
}

#[tokio::test]
async fn upload_only_when_missing() {
    // A missing install uploads the bundle of the server platform with its digests.
    let release = all_platforms();
    let (env, ssh) = world(vec![result(empty()), result(json!({ "started": true }))]);
    let phases = Phases::default();
    let report = run_bootstrap(&env, &AttemptContext::default(), "missing-install", None, &release, &phases).await.unwrap();
    assert_eq!(ssh.call_count(), 2);
    let ensure = ssh.program_args(1);
    let (sha256, bundle_sha256) = release.digests("linux-x64");
    assert_eq!((&ensure["mode"], &ensure["upload"], &ensure["sha256"], &ensure["bundleSha256"]), (&json!("ensure"), &json!(true), &json!(sha256), &json!(bundle_sha256)));
    assert_eq!(ssh.input(1), b"bundle linux-x64\n");
    assert!(ssh.input(0).is_empty());
    assert!(report.started);
    assert_eq!(phases.lock().unwrap()[1], BootstrapPhase::Install);

    // An installed build with an older core runs ensure without the upload and reports the replaced core.
    let (env, ssh) = world(vec![result(older()), result(json!({ "started": true, "replaced": { "pid": 4000, "version": "1.4.5", "graceful": true } }))]);
    let phases = Phases::default();
    let report = run_bootstrap(&env, &AttemptContext::default(), "newer-client", None, &release, &phases).await.unwrap();
    assert!(ssh.program_args(1).get("upload").is_none());
    assert!(ssh.input(1).is_empty());
    assert_eq!(report.replaced.map(|replaced| (replaced.pid, replaced.graceful)), Some((4000, true)));
    assert_eq!(phases.lock().unwrap()[1], BootstrapPhase::Start);

    // A build removed between the probe and the ensure is uploaded by a second ensure.
    let (env, ssh) = world(vec![
        result(older()),
        error_reply("install-missing", "The Mixdog runtime is not installed on the server and must be uploaded.", None),
        result(json!({ "started": true })),
    ]);
    run_bootstrap(&env, &AttemptContext::default(), "removed-between", None, &release, &Phases::default()).await.unwrap();
    assert_eq!(ssh.call_count(), 3);
    assert_eq!(ssh.program_args(2)["upload"], json!(true));
    assert!(!ssh.input(2).is_empty());
}

#[tokio::test]
async fn the_attempt_writes_what_it_found_and_did_into_the_servers_log() {
    let release = all_platforms();
    let (env, _ssh) = world(vec![
        result(empty()),
        result(json!({ "started": true, "replaced": { "pid": 4000, "version": "", "graceful": false }, "gcRemoved": ["1.4.4-aaa", "1.4.3-bbb"] })),
    ]);
    let context = AttemptContext { diagnostics_key: Some("log-ring".to_owned()), ..AttemptContext::default() };
    run_bootstrap(&env, &context, "log-ring", None, &release, &Phases::default()).await.unwrap();
    let lines: Vec<String> = env.diagnostics.entries("log-ring").into_iter().filter(|entry| entry.kind == DiagnosticKind::Log).map(|entry| entry.text).collect();
    assert_eq!(
        lines,
        [
            "remote probe platform=linux-x64 install=1.4.6-0123456789abcdef installed=false core=none current=false",
            "uploading server runtime 1.4.6-0123456789abcdef platform=linux-x64 bytes=17",
            "replaced remote core pid=4000 mixdog=unknown graceful=false",
            "remote gc removed 1.4.4-aaa, 1.4.3-bbb",
        ]
    );
}

#[tokio::test]
async fn an_older_desktop_is_refused_by_the_server_and_nothing_is_retried() {
    let words = "This Mixdog (1.4.6) is older than the one on the server (1.5.0). Update Mixdog on this PC.";
    let (env, ssh) = world(vec![result(empty()), error_reply("client-outdated", words, None)]);
    let outcome = run_bootstrap(&env, &AttemptContext::default(), "older-client", None, &all_platforms(), &Phases::default()).await;
    let error = outcome.unwrap_err();
    assert!(error.is_terminal());
    let view = failure_of(&error, &target("older-client"), Platform::Linux);
    assert_eq!((view.kind, view.message.as_str()), (SshFailureKind::Failed { message: words.to_owned() }, words));
    assert_eq!(ssh.call_count(), 2);
}

#[tokio::test]
async fn a_confirmation_sends_exactly_the_token_of_the_listing_the_user_saw_once() {
    let drain = json!({ "drainId": "d1", "confirmToken": "tok-1",
        "running": [{ "kind": "turn", "threadId": "t1", "turnId": "u1", "title": "fix the build" }] });
    let busy = error_reply("daemon-busy-other-version", "The Mixdog core (1.4.5) is running 1 turn on the server.", Some(drain));
    let (env, ssh) = world(vec![
        result(older()),
        busy,
        result(older()),
        result(json!({ "started": true })),
        result(older()),
        result(json!({ "started": true })),
    ]);
    let release = all_platforms();
    let plain = AttemptContext::default();
    let confirming = AttemptContext { force_restart: true, ..Default::default() };
    let error = bootstrap_error(run_bootstrap(&env, &plain, "busy-server", None, &release, &Phases::default()).await);
    assert_eq!(error.detail.as_ref().map(|listing| listing.running[0].title.as_str()), Some("fix the build"));
    assert!(error.is_terminal());
    assert!(ssh.program_args(1).get("confirmToken").is_none());
    // The user confirms: the same server gets the token of the listing they saw.
    run_bootstrap(&env, &confirming, "busy-server", None, &release, &Phases::default()).await.unwrap();
    assert_eq!(ssh.program_args(3)["confirmToken"], json!("tok-1"));
    // The confirmation covered that open only.
    run_bootstrap(&env, &confirming, "busy-server", None, &release, &Phases::default()).await.unwrap();
    assert!(ssh.program_args(5).get("confirmToken").is_none());
}

#[tokio::test]
async fn a_confirmation_without_a_prior_listing_sends_no_token() {
    let (env, ssh) = world(vec![result(older()), result(json!({ "started": true }))]);
    let confirming = AttemptContext { force_restart: true, ..Default::default() };
    run_bootstrap(&env, &confirming, "never-listed", None, &all_platforms(), &Phases::default()).await.unwrap();
    assert!(ssh.program_args(1).get("confirmToken").is_none());
}

#[tokio::test]
async fn a_core_that_is_still_not_serving_this_version_after_ensure_is_unhealthy() {
    let (env, _ssh) = world(vec![result(older()), result(json!({ "coreCurrent": false }))]);
    let error = bootstrap_error(run_bootstrap(&env, &AttemptContext::default(), "unhealthy", None, &all_platforms(), &Phases::default()).await);
    assert_eq!(error.code, "daemon-unhealthy");
    assert!(!error.is_terminal());
}

#[tokio::test]
async fn server_logins_travel_as_the_model_login_argument_this_pcs_logins_as_nothing() {
    let (env, ssh) = world(vec![result(json!({}))]);
    run_bootstrap(&env, &AttemptContext::default(), "pc-logins", Some(ModelLogin::Pc), &all_platforms(), &Phases::default()).await.unwrap();
    assert!(ssh.program_args(0).get("modelLogin").is_none());
    let (env, ssh) = world(vec![result(json!({}))]);
    run_bootstrap(&env, &AttemptContext::default(), "server-logins", Some(ModelLogin::Server), &all_platforms(), &Phases::default()).await.unwrap();
    assert_eq!(ssh.program_args(0)["modelLogin"], json!("server"));
    // The probe also asks for the lock timings, so a server on either mode runs the same program.
    assert_eq!(ssh.program_args(0)["lockWaitMs"], json!(240_000));
}

#[tokio::test]
async fn a_windows_server_is_an_unsupported_platform() {
    let reply = Reply { stdout: String::new(), stderr: "'sh' is not recognized as an internal or external command,".to_owned(), code: 1 };
    let (env, _ssh) = world(vec![reply]);
    let error = bootstrap_error(run_bootstrap(&env, &AttemptContext::default(), "windows-box", None, &all_platforms(), &Phases::default()).await);
    assert!(error.code == "unsupported-platform" && error.message.contains("Windows"));
    // Any other silent failure of the login shell is a remote-shell failure with the end of stderr.
    let reply = Reply { stdout: String::new(), stderr: "line1\nline2\n".to_owned(), code: 2 };
    let (env, _ssh) = world(vec![reply]);
    let error = bootstrap_error(run_bootstrap(&env, &AttemptContext::default(), "odd-shell", None, &all_platforms(), &Phases::default()).await);
    assert_eq!((error.code.as_str(), error.message.as_str()), ("remote-shell", "Remote bootstrap exited with status 2.\nline1\nline2"));
}

#[tokio::test]
async fn a_server_platform_with_no_shipped_runtime_is_refused_before_anything_is_sent() {
    let reply = Reply { stdout: "MIXDOG_PLATFORM Linux aarch64|glibc\nMIXDOG_RESULT {\"home\":\"/h\",\"installed\":false}\n".to_owned(), stderr: String::new(), code: 0 };
    let (env, ssh) = world(vec![reply]);
    let lonely = payloads(&["linux-x64"]);
    let error = bootstrap_error(run_bootstrap(&env, &AttemptContext::default(), "lonely", None, &lonely, &Phases::default()).await);
    assert!(error.code == "local-payload" && error.is_terminal());
    assert_eq!(ssh.call_count(), 1);
}

#[tokio::test]
async fn ssh_failures_pass_through_as_ssh_errors() {
    let reply = Reply { stdout: String::new(), stderr: "root@h: Permission denied (publickey).\n".to_owned(), code: 255 };
    let (env, _ssh) = world(vec![reply]);
    let outcome = run_bootstrap(&env, &AttemptContext::default(), "denied", None, &all_platforms(), &Phases::default()).await;
    let Err(ConnectError::Ssh(error)) = outcome else { panic!("expected an ssh error") };
    assert!(error.is_terminal());
}

#[test]
fn terminal_classification_covers_refusals_and_mismatches_not_transient_trouble() {
    let terminal = |code: &str| ConnectError::Bootstrap(RemoteBootstrapError::from_wire(code, code, None)).is_terminal();
    for code in [
        "client-outdated", "daemon-model-login", "protocol-mismatch", "unsupported-platform", "daemon-busy-other-version", "install-locked",
        "port-unavailable", "local-payload",
    ] {
        assert!(terminal(code), "{code}");
    }
    for code in ["protocol", "remote-shell", "daemon-timeout", "daemon-exited", "daemon-unhealthy", "install-failed", "install-missing"] {
        assert!(!terminal(code), "{code}");
    }
    assert!(ConnectError::from(SshError::new("Host key verification failed.", FailureClass::Terminal)).is_terminal());
    assert!(!ConnectError::from(SshError::new("Connection refused", FailureClass::Transient)).is_terminal());
}

// ---- cleanup ----

fn probe_reply(installed: bool) -> Reply {
    result(json!({ "installed": installed }))
}

fn cleanup_reply(cleanup: Value) -> Reply {
    result(json!({ "cleanup": cleanup }))
}

async fn run_cleanup(
    env: &SshEnv,
    host: &str,
    remove_user_data: bool,
    events: &Mutex<Vec<CleanupProgress>>,
) -> Result<crate::cleanup::CleanupReport, ConnectError> {
    let release = all_platforms();
    let progress = |event: CleanupProgress| events.lock().unwrap().push(event);
    cleanup_server(env, &AttemptContext::default(), &target(host), CleanupOptions { remove_user_data, payloads: &release }, &progress).await
}

#[tokio::test]
async fn cleanup_stops_the_core_then_removes_everything_but_user_data() {
    let (env, ssh) = world(vec![
        probe_reply(true),
        cleanup_reply(json!({ "stopped": { "pid": 4242, "stopped": true }, "removed": [], "kept": [] })),
        cleanup_reply(json!({ "stopped": null, "removed": ["versions", "deps", "daemon.log", "state.json"], "kept": ["user-data"] })),
    ]);
    let events = Mutex::new(Vec::new());
    let report = run_cleanup(&env, "devbox", false, &events).await.unwrap();
    let shape = |n: usize| {
        let args = ssh.program_args(n);
        (args["mode"].clone(), args.get("phase").cloned(), args.get("removeUserData").cloned(), args.get("upload").cloned())
    };
    assert_eq!(shape(0), (json!("probe"), None, None, None));
    assert_eq!(shape(1), (json!("cleanup"), Some(json!("stop")), None, None));
    assert_eq!(shape(2), (json!("cleanup"), Some(json!("remove")), None, None));
    let events = events.lock().unwrap();
    assert_eq!(events[0], CleanupProgress::Connect);
    assert_eq!(events[1], CleanupProgress::Stop { detail: "stopped pid 4242".to_owned() });
    assert!(matches!(&events[2], CleanupProgress::Remove { detail } if detail.contains("kept user-data")));
    assert_eq!(events[3], CleanupProgress::Done);
    assert_eq!((report.removed.len(), report.kept.clone()), (4, vec!["user-data".to_owned()]));
    assert_eq!(report.stopped.map(|core| core.pid), Some(4242));
}

#[tokio::test]
async fn a_server_without_this_build_gets_the_runtime_once_for_the_stop_run() {
    let (env, ssh) = world(vec![
        probe_reply(false),
        cleanup_reply(json!({ "stopped": null, "removed": [], "kept": [] })),
        cleanup_reply(json!({ "stopped": null, "removed": ["versions"], "kept": [] })),
    ]);
    let events = Mutex::new(Vec::new());
    run_cleanup(&env, "devbox-bare", true, &events).await.unwrap();
    assert_eq!(ssh.program_args(1)["upload"], json!(true));
    assert!(ssh.program_args(2).get("upload").is_none());
    assert!(!ssh.input(1).is_empty() && ssh.input(2).is_empty());
    assert_eq!(ssh.program_args(1)["removeUserData"], json!(true));
    let events = events.lock().unwrap();
    assert_eq!(events[1], CleanupProgress::Stop { detail: "no core running".to_owned() });
    assert_eq!(events[2], CleanupProgress::Remove { detail: "removed versions".to_owned() });
}

#[tokio::test]
async fn the_servers_refusal_stops_the_cleanup() {
    for phase in ["stop", "remove"] {
        let refusal = || error_reply("daemon-unproven", "A process (pid 77) ... nothing was removed.", None);
        let replies = if phase == "stop" {
            vec![probe_reply(true), refusal()]
        } else {
            vec![probe_reply(true), cleanup_reply(json!({ "stopped": null, "removed": [], "kept": [] })), refusal()]
        };
        let (env, ssh) = world(replies);
        let events = Mutex::new(Vec::new());
        let Err(ConnectError::Bootstrap(error)) = run_cleanup(&env, "devbox-refusing", true, &events).await else {
            panic!("the cleanup should have been refused")
        };
        assert!(error.code == "daemon-unproven" && error.message.contains("pid 77"));
        assert_eq!(ssh.call_count(), if phase == "stop" { 2 } else { 3 });
        assert!(!events.lock().unwrap().iter().any(|event| matches!(event, CleanupProgress::Remove { .. } | CleanupProgress::Done)));
    }
}

// ---- failure views ----

const LINUX: Platform = Platform::Linux;

fn ssh_error(message: &str, kind: FailureClass, stderr: &str) -> ConnectError {
    SshError::new(message, kind).with_stderr(stderr, Some(255)).into()
}

fn view(error: &ConnectError) -> SshFailureKind {
    failure_of(error, &target("root@123.45.67.89"), LINUX).kind
}

fn coded(code: &str, message: &str) -> ConnectError {
    RemoteBootstrapError::from_wire(code, message, None).into()
}

#[test]
fn a_refused_login_becomes_the_login_key_guidance_with_the_powershell_variant_on_windows() {
    let refused = ssh_error("ssh failed:\nroot@x: Permission denied (publickey).", FailureClass::Terminal, "Permission denied (publickey).");
    let linux = failure_of(&refused, &target("root@123.45.67.89"), LINUX);
    assert_eq!(
        linux.kind,
        SshFailureKind::Auth { keygen: "ssh-keygen -t ed25519".to_owned(), register: "ssh-copy-id root@123.45.67.89".to_owned(), agent: None }
    );
    assert!(linux.settings_required);
    let windows = failure_of(&refused, &target("root@123.45.67.89"), Platform::Windows);
    let SshFailureKind::Auth { register, .. } = windows.kind else { panic!("expected the login guidance") };
    assert_eq!(
        register,
        r#"Get-Content "$env:USERPROFILE\.ssh\id_ed25519.pub" | ssh root@123.45.67.89 "mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys""#
    );
    assert_eq!(login_key_commands(&target("root@host:2202"), LINUX).1, "ssh-copy-id -p 2202 root@host");
}

#[test]
fn a_changed_host_key_blocks_a_plain_network_failure_is_shown_as_it_is() {
    let changed = ssh_error("x", FailureClass::Terminal, "@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @");
    let shown = failure_of(&changed, &target("root@123.45.67.89"), LINUX);
    assert_eq!(shown.kind, SshFailureKind::HostKeyChanged { previous: None, current: None });
    assert!(shown.settings_required);
    let timeout = ssh_error("ssh root@123.45.67.89 failed:\nConnection timed out", FailureClass::Transient, "Connection timed out");
    let shown = failure_of(&timeout, &target("root@123.45.67.89"), LINUX);
    assert_eq!(shown.kind, SshFailureKind::Failed { message: "ssh root@123.45.67.89 failed:\nConnection timed out".to_owned() });
    assert!(!shown.settings_required);
}

#[test]
fn strict_checking_a_key_never_seen_is_a_plain_failure_a_changed_one_still_blocks() {
    let unknown = ssh_error(
        "x",
        FailureClass::Terminal,
        "No ED25519 host key is known for 123.45.67.89 and you have requested strict checking.\nHost key verification failed.",
    );
    assert!(matches!(view(&unknown), SshFailureKind::Failed { .. }));
    let changed = ssh_error(
        "x",
        FailureClass::Terminal,
        "Host key for 123.45.67.89 has changed and you have requested strict checking.\nHost key verification failed.",
    );
    assert_eq!(view(&changed), SshFailureKind::HostKeyChanged { previous: None, current: None });
}

#[test]
fn a_daemon_outside_proxy_mode_yields_its_pid_other_codes_stay_generic() {
    let running = coded("daemon-not-proxy", "A Mixdog daemon (pid 1667) is already running on the server without desktop model proxy mode; stop it (kill 1667).");
    assert_eq!(view(&running), SshFailureKind::DaemonRunning { pid: 1667 });
    assert_eq!(view(&coded("daemon-not-proxy", "A Mixdog daemon is already running.")), SshFailureKind::Failed { message: "A Mixdog daemon is already running.".to_owned() });
    assert_eq!(view(&coded("upload", "Cannot write /x on the server.")), SshFailureKind::Failed { message: "Cannot write /x on the server.".to_owned() });
}

#[test]
fn the_server_installs_error_codes_each_get_their_own_view() {
    let message = |text: &str| text.to_owned();
    let of = |code: &str, text: &str| view(&coded(code, text));
    assert_eq!(of("unsupported-platform", "Windows servers are not supported."), SshFailureKind::UnsupportedPlatform { message: message("Windows servers are not supported.") });
    assert_eq!(of("install-failed", "digest"), SshFailureKind::InstallFailed { message: message("digest") });
    assert_eq!(of("local-payload", "no runtime"), SshFailureKind::InstallFailed { message: message("no runtime") });
    assert_eq!(of("install-locked", "locked"), SshFailureKind::InstallLocked);
    assert_eq!(of("daemon-busy-other-version", "busy on 1.0.0"), SshFailureKind::DaemonBusy { message: message("busy on 1.0.0") });
    assert_eq!(of("port-unavailable", "port 7000 is taken"), SshFailureKind::PortUnavailable { message: message("port 7000 is taken") });
    assert_eq!(of("daemon-stop", "m"), SshFailureKind::DaemonStop { message: message("m") });
    assert_eq!(of("daemon-replace", "m"), SshFailureKind::DaemonReplace { message: message("m") });
    assert_eq!(of("daemon-unproven", "m"), SshFailureKind::DaemonUnproven { message: message("m") });
    assert_eq!(of("daemon-unmanaged", "m"), SshFailureKind::DaemonUnmanaged { message: message("m") });
    assert_eq!(of("daemon-data-in-use", "m"), SshFailureKind::DaemonDataInUse { message: message("m") });
    assert_eq!(of("protocol-mismatch", "server speaks protocol 3"), SshFailureKind::ProtocolMismatch { message: message("server speaks protocol 3") });
    for code in ["internal", "protocol"] {
        assert_eq!(of(code, "boom"), SshFailureKind::Internal { message: message("boom") });
    }
    for code in ["remote-shell", "remote-home"] {
        assert_eq!(of(code, "status 1"), SshFailureKind::RemoteShell { message: message("status 1") });
    }
    // A message is bounded to its last 800 characters.
    let long = "x".repeat(900) + "end";
    let SshFailureKind::Failed { message } = of("client-outdated", &long) else { panic!("expected a plain failure") };
    assert_eq!((message.chars().count(), message.ends_with("end")), (800, true));
}

#[test]
fn a_missing_openssh_client_gets_the_windows_install_command_other_systems_only_the_message() {
    let missing = ssh_error("The OpenSSH client (ssh) was not found on PATH.", FailureClass::Terminal, "");
    let windows = failure_of(&missing, &target("root@h"), Platform::Windows);
    let SshFailureKind::SshMissing { command: Some(command) } = windows.kind else { panic!("expected the install command") };
    assert_eq!(command, "Add-WindowsCapability -Online -Name OpenSSH.Client~~~~0.0.1.0");
    assert!(!command.contains('\n'));
    assert_eq!(failure_of(&missing, &target("root@h"), LINUX).kind, SshFailureKind::SshMissing { command: None });
    assert_eq!(failure_of(&missing, &target("root@h"), Platform::MacOs).kind, SshFailureKind::SshMissing { command: None });
}

#[test]
fn every_failure_view_carries_the_error_code_the_bootstrap_code_or_the_views_own_name() {
    let code = |error: ConnectError| failure_of(&error, &target("root@h"), LINUX).code;
    for name in [
        "install-failed", "install-locked", "daemon-busy-other-version", "port-unavailable", "protocol-mismatch", "internal", "remote-shell",
        "remote-home", "client-outdated", "upload", "daemon-not-proxy",
    ] {
        assert_eq!(code(coded(name, "pid 5")), name);
    }
    assert_eq!(code(ssh_error("x", FailureClass::Terminal, "Permission denied (publickey).")), "auth");
    assert_eq!(code(ssh_error("x", FailureClass::Terminal, "REMOTE HOST IDENTIFICATION HAS CHANGED")), "host-key-changed");
    assert_eq!(code(ssh_error("timed out", FailureClass::Transient, "Connection timed out")), "ssh-transient");
    assert_eq!(code(ssh_error("odd", FailureClass::Terminal, "")), "ssh-terminal");
    let lite = failure_of(&ssh_error("x", FailureClass::Terminal, "Permission denied"), &target("root@h"), LINUX);
    assert_eq!(lite.kind_name(), "auth");
    assert_eq!(lite.into_failure().code.as_deref(), Some("auth"));
}
