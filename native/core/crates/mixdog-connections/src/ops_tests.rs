//! The cleanup, diagnostics and saved-list operations with fakes: the links, the askpass helper, the cleanup over ssh and the
//! machine the diagnostics read. No ssh runs and nothing is bound.

use std::collections::{HashSet, VecDeque};
use std::future::Future;
use std::io;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use async_trait::async_trait;
use mixdog_app_protocol::v2::connections::{
    SshAgentState, SshAgentStatus, SshAskpass, SshCleanupPhase, SshCleanupRequest, SshCleanupResult, SshFailureKind, SshProgress,
    SshServerLog,
};
use mixdog_core_api::ids::ConnectionId;
use mixdog_ssh::askpass::{AskpassKind, AskpassPrompter, AskpassQuestion};
use mixdog_ssh::cleanup::{CleanupProgress, CleanupReport};
use mixdog_ssh::command::{parse_ssh_target, FailureClass, SshError, SshTarget};
use mixdog_ssh::connect_failure::ConnectError;
use mixdog_ssh::context::{AskpassEnv, AttemptContext, Platform};
use mixdog_ssh::diagnostics::{diagnostics_key_for, DiagnosticKind, Diagnostics};
use mixdog_ssh::host_key::ResolvedHost;
use mixdog_ssh::session::Progress;
use serde_json::json;
use tokio::sync::{mpsc, Notify};

use crate::attempts::{Attempts, ConnectionsPush, ServerLinks};
use crate::cleanup_ops::{Cleanup, CleanupDeps, CleanupProgressSink, ServerCleaner};
use crate::diagnostics_ops::{Asker, DiagnosticsMachine, DiagnosticsOps};
use crate::host_list_ops::{HostLinks, HostList};
use crate::host_store::{SshHostRecord, SshHostStore};
use crate::link::LinkSpec;
use crate::link_machine::ModelLogin;
use crate::login::{AskpassControl, LoginHelpers, StartedAskpass};
use crate::paths::ConnectionsPaths;

const ONE: ConnectionId = ConnectionId(1);
const TARGET: &str = "dev@build.example";

async fn within<T>(work: impl Future<Output = T>) -> T {
    mixdog_rt::time::timeout(Duration::from_secs(5), work).await.expect("timed out")
}

fn locked<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

// ----- fakes -----------------------------------------------------------------------------------------------------------

#[derive(Default)]
struct FakeLinks {
    open: Mutex<HashSet<String>>,
    closed: Mutex<Vec<String>>,
    applied: Mutex<Vec<(String, ModelLogin)>>,
    applied_signal: Notify,
}

#[async_trait]
impl ServerLinks for FakeLinks {
    fn is_open(&self, id: &str) -> bool {
        locked(&self.open).contains(id)
    }

    async fn open(&self, _spec: LinkSpec, _context: AttemptContext, _progress: Option<Progress>) -> Result<(), ConnectError> {
        Ok(())
    }

    async fn close(&self, id: &str) {
        locked(&self.closed).push(id.to_owned());
        locked(&self.open).remove(id);
    }
}

#[async_trait]
impl HostLinks for FakeLinks {
    async fn apply_model_login(&self, id: &str, login: ModelLogin) -> Result<(), ConnectError> {
        locked(&self.applied).push((id.to_owned(), login));
        self.applied_signal.notify_one();
        Ok(())
    }
}

struct FakePush {
    askpass: mpsc::UnboundedSender<(ConnectionId, SshAskpass)>,
}

impl ConnectionsPush for FakePush {
    fn askpass(&self, to: ConnectionId, question: SshAskpass) {
        drop(self.askpass.send((to, question)));
    }

    fn progress(&self, _to: ConnectionId, _progress: SshProgress) {}
}

struct FakeSession {
    dismissed: bool,
}

impl AskpassEnv for FakeSession {
    fn env(&self) -> Vec<(String, String)> {
        Vec::new()
    }

    fn closed(&self) -> bool {
        false
    }

    fn control_dir(&self) -> Option<PathBuf> {
        None
    }
}

#[async_trait]
impl AskpassControl for FakeSession {
    fn cancelled(&self) -> bool {
        self.dismissed
    }

    async fn close(&self) {}
}

#[derive(Default)]
struct FakeLogin {
    dismissed: AtomicBool,
    started: AtomicUsize,
    prompters: Mutex<Vec<Arc<dyn AskpassPrompter>>>,
}

#[async_trait]
impl LoginHelpers for FakeLogin {
    async fn start_askpass(&self, prompter: Arc<dyn AskpassPrompter>) -> io::Result<StartedAskpass> {
        self.started.fetch_add(1, Ordering::SeqCst);
        locked(&self.prompters).push(prompter);
        let session = Arc::new(FakeSession { dismissed: self.dismissed.load(Ordering::SeqCst) });
        Ok(StartedAskpass { env: session.clone(), control: session })
    }

    async fn agent_status(&self) -> SshAgentStatus {
        SshAgentStatus { state: SshAgentState::Empty, command: Some("ssh-add".into()) }
    }
}

/// What one run of the cleanup saw.
struct Run {
    askpass: bool,
    remove_user_data: bool,
    diagnostics_key: Option<String>,
    links_open: usize,
}

struct FakeCleaner {
    outcomes: Mutex<VecDeque<Result<CleanupReport, ConnectError>>>,
    runs: Mutex<Vec<Run>>,
    links: Arc<FakeLinks>,
}

#[async_trait]
impl ServerCleaner for FakeCleaner {
    async fn remove(
        &self,
        context: &AttemptContext,
        _target: &SshTarget,
        remove_user_data: bool,
        progress: &(dyn Fn(CleanupProgress) + Sync),
    ) -> Result<CleanupReport, ConnectError> {
        locked(&self.runs).push(Run {
            askpass: context.askpass.is_some(),
            remove_user_data,
            diagnostics_key: context.diagnostics_key.clone(),
            links_open: locked(&self.links.open).len(),
        });
        progress(CleanupProgress::Connect);
        let outcome = locked(&self.outcomes).pop_front().unwrap_or_else(|| Ok(CleanupReport::default()));
        if outcome.is_ok() {
            progress(CleanupProgress::Stop { detail: "no core running".into() });
            progress(CleanupProgress::Remove { detail: "removed nothing".into() });
            progress(CleanupProgress::Done);
        }
        outcome
    }

    fn platform(&self) -> Platform {
        Platform::Linux
    }
}

fn auth_refused() -> ConnectError {
    ConnectError::Ssh(SshError::new("Permission denied (publickey).", FailureClass::Terminal))
}

fn unreachable_server() -> ConnectError {
    ConnectError::Ssh(SshError::new("Connection timed out", FailureClass::Transient))
}

fn key(target: &str) -> String {
    diagnostics_key_for(&parse_ssh_target(target).expect("a target"))
}

async fn saved(hosts: &SshHostStore, target: &str, name: &str) -> SshHostRecord {
    let record = hosts.ensure_for_target(target, name).expect("a target");
    hosts.save(record).await.expect("saved")
}

async fn store() -> (Arc<SshHostStore>, tempfile::TempDir) {
    let dir = tempfile::tempdir().expect("a folder");
    let hosts = Arc::new(SshHostStore::load(&ConnectionsPaths::new(dir.path()), mixdog_rt::testing::tokens().durability_io).await);
    (hosts, dir)
}

// ----- cleanup ----------------------------------------------------------------------------------------------------------

struct CleanupRig {
    cleanup: Cleanup,
    hosts: Arc<SshHostStore>,
    links: Arc<FakeLinks>,
    cleaner: Arc<FakeCleaner>,
    login: Arc<FakeLogin>,
    questions: mpsc::UnboundedReceiver<(ConnectionId, SshAskpass)>,
    progress: Arc<Mutex<Vec<(String, SshCleanupPhase, Option<String>)>>>,
    sink: CleanupProgressSink,
    _dir: tempfile::TempDir,
}

async fn cleanup_rig(outcomes: Vec<Result<CleanupReport, ConnectError>>) -> CleanupRig {
    let (hosts, dir) = store().await;
    let links = Arc::new(FakeLinks::default());
    let (askpass, questions) = mpsc::unbounded_channel();
    let cleaner = Arc::new(FakeCleaner { outcomes: Mutex::new(outcomes.into()), runs: Mutex::new(Vec::new()), links: links.clone() });
    let login = Arc::new(FakeLogin::default());
    let cleanup = Cleanup::new(CleanupDeps {
        hosts: hosts.clone(),
        attempts: Attempts::new(links.clone(), Arc::new(FakePush { askpass })),
        cleaner: cleaner.clone(),
        login: login.clone(),
    });
    let progress = Arc::new(Mutex::new(Vec::new()));
    let seen = progress.clone();
    let sink: CleanupProgressSink =
        Arc::new(move |step| locked(&seen).push((step.operation_id.clone(), step.phase, step.detail.clone())));
    CleanupRig { cleanup, hosts, links, cleaner, login, questions, progress, sink, _dir: dir }
}

fn cleanup_request(forget: bool, remove_user_data: bool) -> SshCleanupRequest {
    SshCleanupRequest { operation_id: "op-1".into(), remove_user_data, forget }
}

fn failed_kind(result: &SshCleanupResult) -> &SshFailureKind {
    match result {
        SshCleanupResult::Failed(failed) => &failed.failure.kind,
        SshCleanupResult::Done(_) => panic!("expected a failure"),
    }
}

#[tokio::test]
async fn cleanup_closes_the_window_first_then_removes_and_forgets_the_server() {
    let rig = cleanup_rig(vec![Ok(CleanupReport::default())]).await;
    let record = saved(&rig.hosts, TARGET, "Build").await;
    locked(&rig.links.open).insert(record.id.clone());
    let result = within(rig.cleanup.cleanup(ONE, &record.id, cleanup_request(true, true), rig.sink.clone())).await.expect("answered");
    let SshCleanupResult::Done(done) = result else { panic!("expected done") };
    assert!(done.hosts.is_empty());
    assert_eq!(done.detail, None);
    assert!(rig.hosts.get(&record.id).is_none());
    // The window was gone before ssh ran, and the saved settings' diagnostics ring is the one the run writes to.
    assert_eq!(*locked(&rig.links.closed), vec![record.id.clone()]);
    let runs = locked(&rig.cleaner.runs);
    assert_eq!((runs.len(), runs[0].links_open, runs[0].remove_user_data, runs[0].askpass), (1, 0, true, false));
    assert_eq!(runs[0].diagnostics_key, Some(key(TARGET)));
    // The dialog is told where the run is, under the id it chose.
    let phases: Vec<_> = locked(&rig.progress).iter().map(|(operation, phase, detail)| (operation.clone(), *phase, detail.clone())).collect();
    assert_eq!(
        phases,
        vec![
            ("op-1".to_owned(), SshCleanupPhase::Connect, None),
            ("op-1".to_owned(), SshCleanupPhase::Stop, Some("no core running".to_owned())),
            ("op-1".to_owned(), SshCleanupPhase::Remove, Some("removed nothing".to_owned())),
            ("op-1".to_owned(), SshCleanupPhase::Done, None),
        ]
    );
}

#[tokio::test]
async fn cleanup_keeps_the_saved_server_unless_asked_and_answers_with_the_list() {
    let rig = cleanup_rig(vec![Ok(CleanupReport::default())]).await;
    let record = saved(&rig.hosts, TARGET, "Build").await;
    let result = within(rig.cleanup.cleanup(ONE, &record.id, cleanup_request(false, false), rig.sink.clone())).await.expect("answered");
    let SshCleanupResult::Done(done) = result else { panic!("expected done") };
    assert_eq!(done.hosts.len(), 1);
    assert_eq!((done.hosts[0].id.as_str(), done.hosts[0].open), (record.id.as_str(), false));
    assert!(rig.hosts.get(&record.id).is_some());
    assert!(!locked(&rig.cleaner.runs)[0].remove_user_data);
}

#[tokio::test]
async fn a_refused_login_is_retried_once_through_askpass_and_its_questions_go_to_the_caller() {
    let mut rig = cleanup_rig(vec![Err(auth_refused()), Ok(CleanupReport::default())]).await;
    let record = saved(&rig.hosts, TARGET, "Build").await;
    let result = within(rig.cleanup.cleanup(ONE, &record.id, cleanup_request(false, false), rig.sink.clone())).await.expect("answered");
    assert!(matches!(result, SshCleanupResult::Done(_)));
    assert_eq!(rig.login.started.load(Ordering::SeqCst), 1);
    let askpass: Vec<bool> = locked(&rig.cleaner.runs).iter().map(|run| run.askpass).collect();
    assert_eq!(askpass, vec![false, true]);
    // The questions of ssh reach the connection that started the cleanup, named by its operation id.
    let prompter = locked(&rig.login.prompters)[0].clone();
    let asked = tokio::spawn(async move { prompter.ask(AskpassQuestion { kind: AskpassKind::Password, prompt: "Password:".into(), retry: false }).await });
    let (to, question) = within(rig.questions.recv()).await.expect("a question");
    assert_eq!((to, question.attempt_id.as_str(), question.host.as_deref()), (ONE, "op-1", Some("build.example")));
    asked.abort();
}

#[tokio::test]
async fn a_login_that_stays_refused_carries_the_state_of_the_ssh_agent() {
    let rig = cleanup_rig(vec![Err(auth_refused()), Err(auth_refused())]).await;
    let record = saved(&rig.hosts, TARGET, "Build").await;
    let result = within(rig.cleanup.cleanup(ONE, &record.id, cleanup_request(true, false), rig.sink.clone())).await.expect("answered");
    assert!(matches!(failed_kind(&result), SshFailureKind::Auth { agent: Some(agent), .. } if agent.state == SshAgentState::Empty));
    // A failed cleanup forgets nothing.
    assert!(rig.hosts.get(&record.id).is_some());
}

#[tokio::test]
async fn a_dismissed_question_ends_the_cleanup_as_cancelled() {
    let rig = cleanup_rig(vec![Err(auth_refused()), Err(auth_refused())]).await;
    rig.login.dismissed.store(true, Ordering::SeqCst);
    let record = saved(&rig.hosts, TARGET, "Build").await;
    let result = within(rig.cleanup.cleanup(ONE, &record.id, cleanup_request(true, false), rig.sink.clone())).await.expect("answered");
    assert_eq!(*failed_kind(&result), SshFailureKind::Cancelled);
    assert!(rig.hosts.get(&record.id).is_some());
}

#[tokio::test]
async fn another_failure_is_a_result_the_dialog_shows_and_is_not_retried() {
    let rig = cleanup_rig(vec![Err(unreachable_server())]).await;
    let record = saved(&rig.hosts, TARGET, "Build").await;
    let result = within(rig.cleanup.cleanup(ONE, &record.id, cleanup_request(true, false), rig.sink.clone())).await.expect("answered");
    assert!(matches!(failed_kind(&result), SshFailureKind::Failed { .. }));
    assert_eq!(rig.login.started.load(Ordering::SeqCst), 0);
    assert_eq!(locked(&rig.cleaner.runs).len(), 1);
}

#[tokio::test]
async fn a_cleanup_without_an_operation_or_a_saved_server_is_refused() {
    let rig = cleanup_rig(Vec::new()).await;
    let record = saved(&rig.hosts, TARGET, "Build").await;
    let mut request = cleanup_request(false, false);
    request.operation_id = String::new();
    let refused = rig.cleanup.cleanup(ONE, &record.id, request, rig.sink.clone()).await.unwrap_err();
    assert_eq!(refused.to_string(), "operationId must be a non-empty string.");
    let refused = rig.cleanup.cleanup(ONE, "", cleanup_request(false, false), rig.sink.clone()).await.unwrap_err();
    assert_eq!(refused.to_string(), "id must be a non-empty string.");
    let refused = rig.cleanup.cleanup(ONE, "gone", cleanup_request(false, false), rig.sink.clone()).await.unwrap_err();
    assert_eq!(refused.to_string(), "This SSH server is no longer saved.");
    assert!(locked(&rig.cleaner.runs).is_empty());
}

// ----- diagnostics ------------------------------------------------------------------------------------------------------

struct FakeMachine {
    diagnostics: Arc<Diagnostics>,
    ssh_version: String,
    resolved: Option<ResolvedHost>,
    log: Mutex<Result<String, String>>,
    contexts: Mutex<Vec<Option<String>>>,
}

#[async_trait]
impl DiagnosticsMachine for FakeMachine {
    async fn ssh_version(&self) -> String {
        self.ssh_version.clone()
    }

    async fn resolved_host(&self, _target: &SshTarget) -> Option<ResolvedHost> {
        self.resolved.clone()
    }

    async fn daemon_log(&self, _target: &SshTarget, context: AttemptContext) -> Result<String, SshError> {
        locked(&self.contexts).push(context.diagnostics_key);
        locked(&self.log).clone().map_err(|message| SshError::new(message, FailureClass::Transient))
    }

    fn os(&self) -> String {
        "win32 10.0.26100 (x64)".to_owned()
    }

    fn diagnostics(&self) -> Arc<Diagnostics> {
        self.diagnostics.clone()
    }
}

fn resolved(proxy_jump: Option<&str>, proxy_command: bool) -> ResolvedHost {
    ResolvedHost {
        hostname: "build.internal".into(),
        port: 2200,
        user: Some("deploy".into()),
        known_hosts_files: Vec::new(),
        global_known_hosts_files: Vec::new(),
        host_key_algorithms: Vec::new(),
        proxy_jump: proxy_jump.map(str::to_owned),
        proxy_command,
        proxied: proxy_jump.is_some() || proxy_command,
        forwards: Vec::new(),
    }
}

struct DiagnosticsRig {
    ops: DiagnosticsOps,
    machine: Arc<FakeMachine>,
    hosts: Arc<SshHostStore>,
    _dir: tempfile::TempDir,
}

async fn diagnostics_rig(resolved: Option<ResolvedHost>, log: Result<String, String>) -> DiagnosticsRig {
    let (hosts, dir) = store().await;
    let machine = Arc::new(FakeMachine {
        diagnostics: Arc::new(Diagnostics::new()),
        ssh_version: "OpenSSH_9.5p1".into(),
        resolved,
        log: Mutex::new(log),
        contexts: Mutex::new(Vec::new()),
    });
    DiagnosticsRig { ops: DiagnosticsOps::new(hosts.clone(), machine.clone()), machine, hosts, _dir: dir }
}

#[tokio::test]
async fn the_log_is_the_servers_ring_and_its_copy_text_hides_the_server() {
    let rig = diagnostics_rig(None, Ok(String::new())).await;
    let record = saved(&rig.hosts, "dev@build.example", "Build").await;
    rig.machine.diagnostics.record(Some(key("dev@build.example").as_str()), DiagnosticKind::Ssh, "ssh dev@build.example uptime", 1_000);
    rig.machine.diagnostics.record(Some(key("other@else.example").as_str()), DiagnosticKind::Ssh, "ssh other@else.example", 1_000);
    // This PC's window asks by saved id or by address.
    for reference in [record.id.as_str(), "dev@build.example"] {
        let view = rig.ops.log(&Asker::ThisPc, reference).expect("a log");
        assert_eq!(view.lines.len(), 1);
        assert!(view.lines[0].contains("ssh dev@build.example uptime"));
        assert!(!view.copy_text.contains("build.example"), "{}", view.copy_text);
        assert!(view.copy_text.contains("<server>"));
    }
    assert_eq!(rig.ops.log(&Asker::ThisPc, "").unwrap_err().to_string(), "ref must be a non-empty string.");
}

#[tokio::test]
async fn a_server_window_asks_only_about_its_own_server() {
    let rig = diagnostics_rig(None, Ok("up\n".into())).await;
    let own = saved(&rig.hosts, "dev@build.example", "Build").await;
    let other = saved(&rig.hosts, "ops@other.example", "Other").await;
    rig.machine.diagnostics.record(Some(key("ops@other.example").as_str()), DiagnosticKind::Log, "the other server", 1_000);
    // The reference the window sends is ignored: the window's own server answers.
    let view = rig.ops.log(&Asker::Server(own.id.clone()), &other.id).expect("a log");
    assert!(view.lines.is_empty());
    let refused = rig.ops.log(&Asker::Server("gone".into()), &own.id).unwrap_err();
    assert_eq!(refused.to_string(), "This window has no SSH server log.");
    assert!(rig.ops.server_log(&Asker::Server("gone".into()), &own.id).await.is_err());
    assert!(rig.ops.copy(&Asker::Server("gone".into()), &own.id, "1.0.0").await.is_err());
}

#[tokio::test]
async fn the_copied_text_names_the_app_ssh_and_what_ssh_resolves_without_the_server_names() {
    let rig = diagnostics_rig(Some(resolved(Some("jump@bastion.example:2222"), true)), Ok(String::new())).await;
    rig.machine.diagnostics.record(Some(key("dev@build.example").as_str()), DiagnosticKind::Stderr, "login to build.internal as deploy failed via bastion.example", 1_000);
    let text = rig.ops.copy(&Asker::ThisPc, "dev@build.example", "1.4.2").await.expect("a report");
    assert!(text.starts_with("Mixdog SSH diagnostics\nApp: 1.4.2\nOS: win32 10.0.26100 (x64)\nssh: OpenSSH_9.5p1\nConfig:\n"), "{text}");
    assert!(text.contains("  HostName <server>\n  User <server>\n  Port 2200\n  ProxyJump <server>\n  ProxyCommand (set)\n"), "{text}");
    assert!(text.contains("Log (last 100 lines):"));
    for name in ["build.example", "build.internal", "deploy", "bastion.example"] {
        assert!(!text.contains(name), "{name} in {text}");
    }
}

#[tokio::test]
async fn an_address_ssh_cannot_resolve_and_a_missing_ssh_are_said_so_in_the_copied_text() {
    let rig = diagnostics_rig(None, Ok(String::new())).await;
    let text = rig.ops.copy(&Asker::ThisPc, "dev@build.example", "1.4.2").await.expect("a report");
    assert!(text.contains("Config:\n  (ssh could not resolve this address)\n"), "{text}");
}

#[tokio::test]
async fn the_server_log_is_redacted_and_noted_in_the_ring() {
    let rig = diagnostics_rig(None, Ok("started on build.example\nMIXDOG_TOKEN=abc123\n\n".into())).await;
    let record = saved(&rig.hosts, "dev@build.example", "Build").await;
    let log = rig.ops.server_log(&Asker::ThisPc, &record.id).await.expect("answered");
    let SshServerLog::Text(log) = log else { panic!("expected the log") };
    assert_eq!(log.text, "started on build.example\nMIXDOG_TOKEN=<redacted>");
    assert_eq!(log.copy_text, "started on <server>\nMIXDOG_TOKEN=<redacted>");
    // The saved server's context writes to its own ring.
    assert_eq!(*locked(&rig.machine.contexts), vec![Some(key("dev@build.example"))]);
    let lines = rig.machine.diagnostics.lines(&key("dev@build.example"), 10);
    assert!(lines.iter().any(|line| line.contains("server log fetched (2 lines)")), "{lines:?}");
}

#[tokio::test]
async fn an_empty_server_log_and_an_unreachable_server_are_answers_not_errors() {
    let rig = diagnostics_rig(None, Ok("  \n".into())).await;
    let SshServerLog::Text(log) = rig.ops.server_log(&Asker::ThisPc, "dev@build.example").await.expect("answered") else {
        panic!("expected the log")
    };
    assert_eq!(log.text, "(daemon.log is empty or does not exist yet)");
    // An address that is not saved is read in a context that only names the ring.
    assert_eq!(*locked(&rig.machine.contexts), vec![Some(key("dev@build.example"))]);
    *locked(&rig.machine.log) = Err("Connection timed out".into());
    let failed = rig.ops.server_log(&Asker::ThisPc, "dev@build.example").await.expect("answered");
    assert_eq!(failed, SshServerLog::failed("Connection timed out".into()));
    let lines = rig.machine.diagnostics.lines(&key("dev@build.example"), 10);
    assert!(lines.iter().any(|line| line.contains("server log failed: Connection timed out")), "{lines:?}");
}

// ----- the saved list ---------------------------------------------------------------------------------------------------

async fn list_rig() -> (HostList, Arc<SshHostStore>, Arc<FakeLinks>, tempfile::TempDir) {
    let (hosts, dir) = store().await;
    let links = Arc::new(FakeLinks::default());
    (HostList::new(hosts.clone(), links.clone()), hosts, links, dir)
}

#[tokio::test]
async fn rename_trims_and_shortens_the_name_and_ignores_an_empty_one() {
    let (list, hosts, links, _dir) = list_rig().await;
    let record = saved(&hosts, TARGET, "Build").await;
    locked(&links.open).insert(record.id.clone());
    list.rename(&record.id, &format!("  {}  ", "n".repeat(100))).await.expect("renamed");
    let shown = list.list();
    assert_eq!(shown.len(), 1);
    assert_eq!(shown[0].name, "n".repeat(80));
    assert!(shown[0].open);
    list.rename(&record.id, "   ").await.expect("answered");
    assert_eq!(list.list()[0].name, "n".repeat(80));
    assert!(list.rename("", "x").await.is_err());
}

#[tokio::test]
async fn a_changed_model_login_is_applied_to_the_live_link_and_other_settings_are_not() {
    let (list, hosts, links, _dir) = list_rig().await;
    let record = saved(&hosts, TARGET, "Build").await;
    let shown = list.update_settings(&record.id, &json!({ "remoteCwd": "~/work" })).await.expect("saved");
    assert_eq!(shown.settings.as_ref().and_then(|settings| settings.remote_cwd.as_deref()), Some("~/work"));
    let shown = list.update_settings(&record.id, &json!({ "remoteCwd": "~/work", "modelLogin": "server" })).await.expect("saved");
    assert!(shown.settings.as_ref().is_some_and(|settings| settings.model_login.is_some()));
    within(links.applied_signal.notified()).await;
    assert_eq!(*locked(&links.applied), vec![(record.id.clone(), ModelLogin::Server)]);
    // The same login again changes nothing on the server; back to this PC's logins restarts it the other way.
    list.update_settings(&record.id, &json!({ "modelLogin": "server" })).await.expect("saved");
    list.update_settings(&record.id, &json!({ "modelLogin": "pc" })).await.expect("saved");
    within(links.applied_signal.notified()).await;
    assert_eq!(*locked(&links.applied), vec![(record.id.clone(), ModelLogin::Server), (record.id.clone(), ModelLogin::Pc)]);
}

#[tokio::test]
async fn a_setting_that_cannot_be_used_is_refused_and_applies_nothing() {
    let (list, hosts, links, _dir) = list_rig().await;
    let record = saved(&hosts, TARGET, "Build").await;
    assert!(list.update_settings(&record.id, &json!({ "modelLogin": "other" })).await.is_err());
    assert!(list.update_settings(&record.id, &json!({ "remoteCwd": "relative/path" })).await.is_err());
    assert!(hosts.get(&record.id).is_some_and(|saved| saved.settings.is_none()));
    assert!(locked(&links.applied).is_empty());
    assert_eq!(list.update_settings("gone", &json!({})).await.unwrap_err().to_string(), "This SSH server is no longer saved.");
}

#[tokio::test]
async fn forget_removes_only_the_saved_entry() {
    let (list, hosts, _links, _dir) = list_rig().await;
    let build = saved(&hosts, TARGET, "Build").await;
    let other = saved(&hosts, "ops@other.example", "Other").await;
    list.forget(&build.id).await.expect("forgotten");
    assert_eq!(list.list().iter().map(|host| host.id.as_str()).collect::<Vec<_>>(), vec![other.id.as_str()]);
    assert!(list.forget("").await.is_err());
}
