//! The connect flow with fakes: the machine (scripted inspections, recorded pins), the links (scripted opens), the askpass
//! helper and the connection the answers are pushed to. No ssh runs and nothing is bound.

use std::collections::{HashSet, VecDeque};
use std::future::Future;
use std::io;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use async_trait::async_trait;
use mixdog_app_protocol::v2::connections::{
    SshAgentState, SshAgentStatus, SshAskpass, SshAskpassKind, SshConnectSettings, SshHopKey, SshHopRole,
};
use mixdog_ssh::askpass::{AskpassKind, AskpassPrompter, AskpassQuestion};
use mixdog_ssh::command::FailureClass;
use mixdog_ssh::connect_failure::ConnectError;
use mixdog_ssh::context::AskpassEnv;
use mixdog_ssh::host_key::{Pin, Replace};
use mixdog_ssh::pins::Claim;
use mixdog_ssh::install_wire::RemoteBootstrapError;
use tokio::sync::{mpsc, Notify};

use super::*;
use crate::attempts::{ConnectionsPush, ServerLinks, MAX_ATTEMPTS_PER_CALLER, MAX_SECRET_LENGTH};
use crate::host_list_ops::{forget_saved, LocalForget};
use crate::login::{AskpassControl, StartedAskpass};
use crate::paths::ConnectionsPaths;

const ONE: ConnectionId = ConnectionId(1);
const TWO: ConnectionId = ConnectionId(2);
const TARGET: &str = "dev@build.example";

async fn within<T>(work: impl Future<Output = T>) -> T {
    mixdog_rt::time::timeout(Duration::from_secs(5), work).await.expect("timed out")
}

fn trusted() -> HostKeyInspection {
    HostKeyInspection { hops: Vec::new(), check: SshHostKeyCheck::Trusted { authority: None, hops: None }, pin: None, replace: None, summary: None, reviewed: None }
}

async fn unknown(line: &str) -> HostKeyInspection {
    HostKeyInspection {
        hops: Vec::new(),
        check: SshHostKeyCheck::Unknown { fingerprint: format!("SHA256:{line}"), key_type: "ED25519".into(), hops: None },
        pin: Some(Pin::new(PathBuf::from("known_hosts"), vec![Claim::new("owner".into(), "build.example".into(), "ssh-ed25519".into(), line.to_owned())], Vec::new())),
        replace: None,
        summary: None,
        reviewed: None,
    }
}

async fn changed() -> HostKeyInspection {
    HostKeyInspection {
        hops: Vec::new(),
        check: SshHostKeyCheck::Changed {
            previous: "SHA256:old".into(),
            current: "SHA256:new".into(),
            key_type: "ED25519".into(),
            host: "Build.Example".into(),
            remove_command: "ssh-keygen -R build.example".into(),
            replaceable: true,
            hops: None,
        },
        pin: None,
        replace: Some(Replace {
            spec: "build.example".into(),
            file: PathBuf::from("known_hosts"),
            claim: Claim::new("owner".into(), "build.example".into(), "ssh-ed25519".into(), "new".into()),
            host: "Build.Example".into(),
            old_key: "old".into(),
            shown: Vec::new(),
        }),
        summary: None,
        reviewed: None,
    }
}

fn request(attempt_id: &str) -> SshConnectRequest {
    SshConnectRequest {
        attempt_id: attempt_id.to_owned(),
        trust_host_key: None,
        replace_host_key: None,
        accept_forwards: None,
        settings: None,
        force_restart: None,
    }
}

fn auth_refused() -> ConnectError {
    ConnectError::Ssh(SshError::new("Permission denied (publickey).", FailureClass::Terminal))
}

fn daemon_running() -> ConnectError {
    ConnectError::Bootstrap(RemoteBootstrapError::from_wire("daemon-not-proxy", "A daemon is running (pid 4242).", None))
}

// ----- fakes -----------------------------------------------------------------------------------------------------------

struct FakeMachine {
    inspections: Mutex<VecDeque<HostKeyInspection>>,
    inspected: AtomicUsize,
    /// While set, an inspection says it started and waits for `release_inspect`.
    hold_inspect: AtomicBool,
    inspect_started: Notify,
    release_inspect: Notify,
    pinned: Mutex<Vec<String>>,
    /// What the next pin is refused with.
    pin_refusal: Mutex<Option<SshError>>,
    replaced: Mutex<Vec<String>>,
    diagnostics: Arc<Diagnostics>,
}

impl FakeMachine {
    fn new() -> Self {
        Self {
            inspections: Mutex::new(VecDeque::new()),
            inspected: AtomicUsize::new(0),
            hold_inspect: AtomicBool::new(false),
            inspect_started: Notify::new(),
            release_inspect: Notify::new(),
            pinned: Mutex::new(Vec::new()),
            pin_refusal: Mutex::new(None),
            replaced: Mutex::new(Vec::new()),
            diagnostics: Arc::new(Diagnostics::new()),
        }
    }
}

#[async_trait]
impl SshMachine for FakeMachine {
    async fn inspect(&self, _target: &SshTarget) -> Result<HostKeyInspection, SshError> {
        self.inspected.fetch_add(1, Ordering::SeqCst);
        if self.hold_inspect.load(Ordering::SeqCst) {
            self.inspect_started.notify_one();
            self.release_inspect.notified().await;
        }
        Ok(self.inspections.lock().unwrap_or_else(PoisonError::into_inner).pop_front().unwrap_or_else(trusted))
    }

    async fn pin(&self, inspection: &HostKeyInspection) -> Result<(), SshError> {
        if let Some(refusal) = self.pin_refusal.lock().unwrap_or_else(PoisonError::into_inner).take() {
            return Err(refusal);
        }
        self.pinned.lock().unwrap_or_else(PoisonError::into_inner).push(inspection.pin.as_ref().and_then(|pin| pin.claims.first()).map(|claim| claim.key.clone()).unwrap_or_default());
        Ok(())
    }

    async fn replace(&self, inspection: &HostKeyInspection) -> Result<(), SshError> {
        self.replaced.lock().unwrap_or_else(PoisonError::into_inner).push(inspection.replace.as_ref().map(|replace| format!("{} {}", replace.spec, replace.claim.key)).unwrap_or_default());
        Ok(())
    }

    fn platform(&self) -> Platform {
        Platform::Linux
    }

    fn diagnostics(&self) -> Arc<Diagnostics> {
        self.diagnostics.clone()
    }

    fn var(&self, name: &str) -> Option<String> {
        (name == REMOTE_CWD_VAR).then(|| " ~/work ".to_owned())
    }
}

#[derive(Default)]
struct FakeLinks {
    open: Mutex<HashSet<String>>,
    needs_replacement: AtomicBool,
    outcomes: Mutex<VecDeque<Result<(), ConnectError>>>,
    /// `(id, had an askpass session, forced restart)` of every open.
    opened: Mutex<Vec<(String, bool, bool)>>,
    closed: Mutex<Vec<String>>,
    hold: AtomicBool,
    started: Notify,
    release: Notify,
    /// While set, a close says it started and waits for `release_close`.
    hold_close: AtomicBool,
    close_started: Notify,
    release_close: Notify,
}

#[async_trait]
impl ServerLinks for FakeLinks {
    fn is_open(&self, id: &str) -> bool {
        !self.needs_replacement.load(Ordering::SeqCst) && self.open.lock().unwrap_or_else(PoisonError::into_inner).contains(id)
    }

    async fn open(&self, spec: LinkSpec, context: AttemptContext, _progress: Option<Progress>, cancel: Option<&tokio_util::sync::CancellationToken>) -> Result<LinkOpen, ConnectError> {
        let reused = self.is_open(&spec.id);
        self.opened.lock().unwrap_or_else(PoisonError::into_inner).push((spec.id.clone(), context.askpass.is_some(), context.force_restart));
        if self.hold.load(Ordering::SeqCst) {
            self.started.notify_one();
            if let Some(cancel) = cancel.filter(|_| !reused) {
                tokio::select! {
                    () = cancel.cancelled() => {
                        self.close(&spec.id).await;
                        return Err(daemon_running());
                    }
                    () = self.release.notified() => {}
                }
            } else {
                self.release.notified().await;
            }
        }
        let outcome = self.outcomes.lock().unwrap_or_else(PoisonError::into_inner).pop_front().unwrap_or(Ok(()));
        if outcome.is_ok() {
            self.needs_replacement.store(false, Ordering::SeqCst);
            self.open.lock().unwrap_or_else(PoisonError::into_inner).insert(spec.id);
        }
        outcome.map(|()| if reused { LinkOpen::Reused } else { LinkOpen::Owned(1) })
    }

    async fn close(&self, id: &str) {
        if self.hold_close.load(Ordering::SeqCst) {
            self.close_started.notify_one();
            self.release_close.notified().await;
        }
        self.closed.lock().unwrap_or_else(PoisonError::into_inner).push(id.to_owned());
        self.open.lock().unwrap_or_else(PoisonError::into_inner).remove(id);
    }
}

struct FakePush {
    askpass: mpsc::UnboundedSender<(ConnectionId, SshAskpass)>,
    progress: Mutex<Vec<(ConnectionId, SshProgress)>>,
}

impl ConnectionsPush for FakePush {
    fn askpass(&self, to: ConnectionId, question: SshAskpass) {
        drop(self.askpass.send((to, question)));
    }

    fn progress(&self, to: ConnectionId, progress: SshProgress) {
        self.progress.lock().unwrap_or_else(PoisonError::into_inner).push((to, progress));
    }
}

struct FakeSession {
    dismissed: bool,
    closed: AtomicBool,
}

impl AskpassEnv for FakeSession {
    fn env(&self) -> Vec<(String, String)> {
        Vec::new()
    }

    fn closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
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

    async fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
    }
}

#[derive(Default)]
struct FakeLogin {
    dismissed: AtomicBool,
    started: AtomicUsize,
    sessions: Mutex<Vec<Arc<FakeSession>>>,
}

#[async_trait]
impl LoginHelpers for FakeLogin {
    async fn start_askpass(&self, _prompter: Arc<dyn AskpassPrompter>) -> io::Result<StartedAskpass> {
        self.started.fetch_add(1, Ordering::SeqCst);
        let session = Arc::new(FakeSession { dismissed: self.dismissed.load(Ordering::SeqCst), closed: AtomicBool::new(false) });
        self.sessions.lock().unwrap_or_else(PoisonError::into_inner).push(session.clone());
        Ok(StartedAskpass { env: session.clone(), control: session })
    }

    async fn agent_status(&self) -> SshAgentStatus {
        SshAgentStatus { state: SshAgentState::Empty, command: Some("ssh-add".into()) }
    }
}

#[derive(Default)]
struct FakeWindows {
    opened: Mutex<Vec<String>>,
    rolled_back: Mutex<Vec<String>>,
    refuse: AtomicBool,
    hold: AtomicBool,
    started: Notify,
    release: Notify,
}

#[async_trait]
impl ServerWindows for FakeWindows {
    async fn open(&self, id: &str, _name: &str) -> Result<bool, String> {
        if self.hold.load(Ordering::SeqCst) {
            self.started.notify_one();
            self.release.notified().await;
        }
        if self.refuse.load(Ordering::SeqCst) {
            return Err("No window".to_owned());
        }
        self.opened.lock().unwrap_or_else(PoisonError::into_inner).push(id.to_owned());
        Ok(true)
    }

    async fn rollback(&self, id: &str) {
        self.rolled_back.lock().unwrap().push(id.to_owned());
    }
}

struct Rig {
    connect: Arc<Connect>,
    machine: Arc<FakeMachine>,
    links: Arc<FakeLinks>,
    push: Arc<FakePush>,
    login: Arc<FakeLogin>,
    windows: Arc<FakeWindows>,
    hosts: Arc<SshHostStore>,
    askpass: mpsc::UnboundedReceiver<(ConnectionId, SshAskpass)>,
    _dir: tempfile::TempDir,
}

async fn rig() -> Rig {
    let dir = tempfile::tempdir().unwrap();
    let hosts = Arc::new(SshHostStore::load(&ConnectionsPaths::new(dir.path()), mixdog_rt::testing::tokens().durability_io).await);
    let machine = Arc::new(FakeMachine::new());
    let links = Arc::new(FakeLinks::default());
    let (askpass, askpass_rx) = mpsc::unbounded_channel();
    let push = Arc::new(FakePush { askpass, progress: Mutex::new(Vec::new()) });
    let login = Arc::new(FakeLogin::default());
    let windows = Arc::new(FakeWindows::default());
    let links_view = links.clone();
    let connect = Arc::new(Connect::new(ConnectDeps {
        attempts: Attempts::new(links.clone(), push.clone()),
        machine: machine.clone(),
        login: login.clone(),
        hosts: hosts.clone(),
        windows: windows.clone(),
        view: Arc::new(move |record: &SshHostRecord| SshHost {
            id: record.id.clone(),
            name: record.name.clone(),
            target: record.target.clone(),
            last_connected_at: record.last_connected_at.as_ref().and_then(serde_json::Number::as_i64),
            open: links_view.is_open(&record.id),
            settings: None,
        }),
        clock: Arc::new(|| 1_700_000_000_000),
    }));
    Rig { connect, machine, links, push, login, windows, hosts, askpass: askpass_rx, _dir: dir }
}

fn queue(rig: &Rig, inspection: HostKeyInspection) {
    rig.machine.inspections.lock().unwrap_or_else(PoisonError::into_inner).push_back(inspection);
}

fn connected(result: &SshConnectResult) -> &SshHost {
    match result {
        SshConnectResult::Connected(ok) => &ok.host,
        SshConnectResult::Failed(failed) => panic!("expected a connection, got {:?}", failed.failure),
    }
}

fn failure(result: &SshConnectResult) -> &SshFailureKind {
    match result {
        SshConnectResult::Failed(failed) => &failed.failure.kind,
        SshConnectResult::Connected(_) => panic!("expected a failure"),
    }
}

// ----- the attempt guarantees --------------------------------------------------------------------------------------------

#[tokio::test]
async fn attempt_bound_to_caller() {
    let rig = rig().await;
    let inspection = rig.connect.inspect(ONE, TARGET).await.unwrap();
    assert!(matches!(inspection.check, SshHostKeyCheck::Trusted { .. }));
    let result = rig.connect.connect(ONE, &inspection.attempt_id, request(&inspection.attempt_id)).await.unwrap();
    assert_eq!(connected(&result).target, TARGET);
    assert_eq!(rig.windows.opened.lock().unwrap().len(), 1);
    // The server is saved with the time it connected; the attempt is spent.
    let saved = rig.hosts.find_by_target(TARGET).expect("saved");
    assert_eq!(saved.last_connected_at.and_then(|at| at.as_i64()), Some(1_700_000_000_000));
    assert!(rig.connect.connect(ONE, &inspection.attempt_id, request(&inspection.attempt_id)).await.is_err());
}

#[tokio::test]
async fn foreign_caller_refused() {
    let mut rig = rig().await;
    let inspection = rig.connect.inspect(ONE, TARGET).await.unwrap();
    let id = inspection.attempt_id;
    // Another connection can neither connect with the attempt nor cancel it, and gets the answer a missing attempt gets.
    let foreign = rig.connect.connect(TWO, &id, request(&id)).await.unwrap_err();
    let missing = rig.connect.connect(TWO, "no-such-attempt", request("no-such-attempt")).await.unwrap_err();
    assert_eq!(foreign, missing);
    rig.connect.cancel(TWO, &id).await;
    assert_eq!(rig.connect.attempts().attempt_count(ONE), 1);
    assert!(rig.links.opened.lock().unwrap().is_empty());
    // A question of the attempt is answered only by the connection it was put to.
    let attempt = rig.connect.attempts().owned(ONE, &id).unwrap();
    let prompter = rig.connect.attempts().prompter(attempt, "build.example".into());
    let asked = tokio::spawn(async move { prompter.ask(AskpassQuestion { kind: AskpassKind::Password, prompt: "Password:".into(), retry: false }).await });
    let (to, question) = within(rig.askpass.recv()).await.unwrap();
    assert_eq!(to, ONE);
    rig.connect.askpass_reply(TWO, &id, &question.request_id, Some("stolen".into()));
    rig.connect.askpass_reply(ONE, "another-attempt", &question.request_id, Some("stolen".into()));
    assert_eq!(rig.connect.attempts().question_count(), 1);
    rig.connect.askpass_reply(ONE, &id, &question.request_id, Some("secret".into()));
    assert_eq!(within(asked).await.unwrap(), Some("secret".to_owned()));
}

#[tokio::test]
async fn frozen_inspection_pins_shown_key() {
    let rig = rig().await;
    queue(&rig, unknown("key-shown-to-the-user").await);
    let inspection = rig.connect.inspect(ONE, TARGET).await.unwrap();
    assert!(matches!(&inspection.check, SshHostKeyCheck::Unknown { fingerprint, .. } if fingerprint == "SHA256:key-shown-to-the-user"));
    // The server presents another key by now: it is not looked at again, the key that was shown is the key that is saved.
    queue(&rig, unknown("key-the-server-swapped-in").await);
    let mut confirm = request(&inspection.attempt_id);
    confirm.trust_host_key = Some(true);
    let result = rig.connect.connect(ONE, &inspection.attempt_id, confirm).await.unwrap();
    connected(&result);
    assert_eq!(*rig.machine.pinned.lock().unwrap(), vec!["key-shown-to-the-user".to_owned()]);
    assert_eq!(rig.machine.inspected.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn a_closed_caller_gets_no_attempt_and_no_question() {
    let rig = rig().await;
    let inspection = rig.connect.inspect(ONE, TARGET).await.unwrap();
    let attempt = rig.connect.attempts().owned(ONE, &inspection.attempt_id).unwrap();
    rig.connect.caller_closed(ONE).await;
    // An inspection that was still being read when its connection closed must not leave an attempt nobody can cancel.
    let refused = rig.connect.inspect(ONE, TARGET).await.unwrap_err();
    assert_eq!(refused.to_string(), "This connection is closed.");
    assert_eq!(rig.connect.attempts().attempt_count(ONE), 0);
    // Nor is a question put to it.
    let prompter = rig.connect.attempts().prompter(attempt, "build.example".into());
    assert_eq!(prompter.ask(AskpassQuestion { kind: AskpassKind::Otp, prompt: "Code:".into(), retry: false }).await, None);
    assert_eq!(rig.connect.attempts().question_count(), 0);
    // Another connection is not affected.
    assert!(rig.connect.inspect(TWO, TARGET).await.is_ok());
}

#[tokio::test]
async fn caller_close_cancels() {
    let mut rig = rig().await;
    // A pending question answers nothing, and withdraws nothing from a connection that is gone.
    let idle = rig.connect.inspect(TWO, TARGET).await.unwrap();
    let idle_attempt = rig.connect.attempts().owned(TWO, &idle.attempt_id).unwrap();
    let prompter = rig.connect.attempts().prompter(idle_attempt, "build.example".into());
    let asked = tokio::spawn(async move { prompter.ask(AskpassQuestion { kind: AskpassKind::Otp, prompt: "Code:".into(), retry: false }).await });
    within(rig.askpass.recv()).await.unwrap();
    rig.connect.caller_closed(TWO).await;
    assert_eq!(within(asked).await.unwrap(), None);
    assert_eq!(rig.connect.attempts().attempt_count(TWO), 0);
    assert!(rig.askpass.try_recv().is_err());
    // An attempt that is connecting stops where it is and gives its link back.
    let inspection = rig.connect.inspect(ONE, TARGET).await.unwrap();
    rig.links.hold.store(true, Ordering::SeqCst);
    let connect = rig.connect.clone();
    let id = inspection.attempt_id.clone();
    let running = tokio::spawn(async move { connect.connect(ONE, &id, request(&id)).await });
    within(rig.links.started.notified()).await;
    rig.connect.caller_closed(ONE).await;
    let result = within(running).await.unwrap().unwrap();
    assert_eq!(rig.links.closed.lock().unwrap().len(), 1);
    assert!(matches!(failure(&result), SshFailureKind::Cancelled));
    assert!(rig.hosts.find_by_target(TARGET).is_none());
    assert!(rig.windows.opened.lock().unwrap().is_empty());
    assert_eq!(rig.connect.attempts().attempt_count(ONE), 0);
}

#[tokio::test]
async fn window_refusal_only_detaches_a_new_link_and_does_not_stamp_the_saved_host() {
    for (existing, replacement) in [(false, false), (true, false), (true, true)] {
        let rig = rig().await;
        let record = rig.hosts.reserve_for_target(TARGET).unwrap().record.clone();
        let saved = rig.hosts.save(record).await.unwrap();
        if existing {
            rig.links.open.lock().unwrap().insert(saved.id.clone());
        }
        rig.links.needs_replacement.store(replacement, Ordering::SeqCst);
        rig.windows.refuse.store(true, Ordering::SeqCst);

        let id = rig.connect.inspect(ONE, TARGET).await.unwrap().attempt_id;
        let outcome = rig.connect.connect(ONE, &id, request(&id)).await.unwrap();
        let SshConnectResult::Failed(outcome) = outcome else { panic!("window was refused") };
        assert_eq!(outcome.failure.code.as_deref(), Some("window-open"));
        assert_eq!(rig.links.is_open(&saved.id), existing && !replacement);
        assert_eq!(rig.hosts.get(&saved.id).unwrap().last_connected_at, saved.last_connected_at);
    }
}

#[tokio::test]
async fn cancel_while_the_window_opens_does_not_save_a_disconnected_host() {
    let rig = rig().await;
    rig.windows.hold.store(true, Ordering::SeqCst);
    let id = rig.connect.inspect(ONE, TARGET).await.unwrap().attempt_id;
    let running = {
        let (connect, id) = (rig.connect.clone(), id.clone());
        tokio::spawn(async move { connect.connect(ONE, &id, request(&id)).await })
    };
    within(rig.windows.started.notified()).await;
    rig.connect.cancel(ONE, &id).await;
    rig.windows.release.notify_one();

    let outcome = within(running).await.unwrap().unwrap();
    assert_eq!(failure(&outcome), &SshFailureKind::Cancelled);
    assert!(rig.hosts.find_by_target(TARGET).is_none());
    assert!(rig.links.open.lock().unwrap().is_empty());
    assert_eq!(rig.links.closed.lock().unwrap().len(), 1);
    assert_eq!(*rig.windows.rolled_back.lock().unwrap(), *rig.links.closed.lock().unwrap());
}

#[tokio::test]
async fn max_8_attempts() {
    let rig = rig().await;
    let mut first = None;
    for _ in 0..MAX_ATTEMPTS_PER_CALLER {
        let inspection = rig.connect.inspect(ONE, TARGET).await.unwrap();
        first.get_or_insert(inspection.attempt_id);
    }
    // The ninth makes room by dropping the oldest idle attempt of the same connection; another connection has its own eight.
    rig.connect.inspect(ONE, TARGET).await.unwrap();
    assert_eq!(rig.connect.attempts().attempt_count(ONE), MAX_ATTEMPTS_PER_CALLER);
    assert!(rig.connect.attempts().owned(ONE, &first.unwrap()).is_err());
    rig.connect.inspect(TWO, TARGET).await.unwrap();
    assert_eq!(rig.connect.attempts().attempt_count(TWO), 1);
    // With eight connecting there is no idle one to drop.
    let busy = self::rig().await;
    busy.links.hold.store(true, Ordering::SeqCst);
    let mut runs = Vec::new();
    for _ in 0..MAX_ATTEMPTS_PER_CALLER {
        let inspection = busy.connect.inspect(ONE, TARGET).await.unwrap();
        let connect = busy.connect.clone();
        let id = inspection.attempt_id.clone();
        runs.push(tokio::spawn(async move { connect.connect(ONE, &id, request(&id)).await }));
    }
    // Only one of them holds the target at a time: the others are queued, all of them are marked connecting.
    for _ in 0..3 {
        tokio::task::yield_now().await;
    }
    let refused = busy.connect.inspect(ONE, TARGET).await.unwrap_err();
    assert_eq!(refused.to_string(), "Too many SSH connections are being made at once.");
    for run in runs {
        run.abort();
    }
}

// ----- what the pre-check allows --------------------------------------------------------------------------------------

#[tokio::test]
async fn unknown_key_needs_the_users_confirmation() {
    let rig = rig().await;
    queue(&rig, unknown("fresh").await);
    let inspection = rig.connect.inspect(ONE, TARGET).await.unwrap();
    let id = inspection.attempt_id;
    let refused = rig.connect.connect(ONE, &id, request(&id)).await.unwrap_err();
    assert_eq!(refused.to_string(), "Confirm the server\u{2019}s fingerprint before connecting.");
    // The attempt is still there to confirm; nothing was saved or opened.
    assert!(rig.machine.pinned.lock().unwrap().is_empty());
    assert!(rig.links.opened.lock().unwrap().is_empty());
    let mut confirm = request(&id);
    confirm.trust_host_key = Some(true);
    connected(&rig.connect.connect(ONE, &id, confirm).await.unwrap());
}

#[tokio::test]
async fn changed_key_is_replaced_only_by_the_typed_name() {
    let rig = rig().await;
    queue(&rig, changed().await);
    queue(&rig, changed().await);
    queue(&rig, SshHostKeyCheck::Revoked { fingerprint: "SHA256:r".into(), host: "build.example".into() }.into_inspection());
    let first = rig.connect.inspect(ONE, TARGET).await.unwrap().attempt_id;
    let mut wrong = request(&first);
    wrong.replace_host_key = Some("other.example".into());
    let result = rig.connect.connect(ONE, &first, wrong).await.unwrap();
    assert!(matches!(failure(&result), SshFailureKind::HostKeyChanged { previous: Some(old), current: Some(new) } if old == "SHA256:old" && new == "SHA256:new"));
    // A refusal ends the attempt.
    assert!(rig.connect.attempts().owned(ONE, &first).is_err());
    let second = rig.connect.inspect(ONE, TARGET).await.unwrap().attempt_id;
    let mut typed = request(&second);
    typed.replace_host_key = Some("  build.EXAMPLE ".into());
    connected(&rig.connect.connect(ONE, &second, typed).await.unwrap());
    assert_eq!(*rig.machine.replaced.lock().unwrap(), vec!["build.example new".to_owned()]);
    let third = rig.connect.inspect(ONE, TARGET).await.unwrap().attempt_id;
    let mut trust = request(&third);
    trust.trust_host_key = Some(true);
    let result = rig.connect.connect(ONE, &third, trust).await.unwrap();
    assert!(matches!(failure(&result), SshFailureKind::HostKeyRevoked));
}

#[tokio::test]
async fn unreachable_key_check_is_refused_with_its_reason() {
    let rig = rig().await;
    queue(&rig, SshHostKeyCheck::Unreachable { message: "Connection timed out".into(), notice: None, ssh_missing: None }.into_inspection());
    queue(&rig, SshHostKeyCheck::Unreachable { message: "ssh not found".into(), notice: None, ssh_missing: Some(SshMissing { command: Some("install ssh".into()) }) }.into_inspection());
    let first = rig.connect.inspect(ONE, TARGET).await.unwrap().attempt_id;
    let result = rig.connect.connect(ONE, &first, request(&first)).await.unwrap();
    assert!(matches!(failure(&result), SshFailureKind::Failed { message } if message == "Connection timed out"));
    let second = rig.connect.inspect(ONE, TARGET).await.unwrap().attempt_id;
    let result = rig.connect.connect(ONE, &second, request(&second)).await.unwrap();
    assert!(matches!(failure(&result), SshFailureKind::SshMissing { command: Some(command) } if command == "install ssh"));
    assert!(rig.links.opened.lock().unwrap().is_empty());
}

#[tokio::test]
async fn forwards_need_the_users_acceptance() {
    let rig = rig().await;
    let mut inspection = trusted();
    inspection.summary = Some(SshConfigSummary {
        host_name: "build.example".into(),
        user: None,
        port: 22,
        proxy_jump: None,
        proxy_command: false,
        forwards: Some(vec!["LocalForward 8080 localhost:80".into()]),
    });
    queue(&rig, inspection);
    let shown = rig.connect.inspect(ONE, TARGET).await.unwrap();
    assert_eq!(shown.summary.as_ref().and_then(|summary| summary.forwards.as_ref()).map(Vec::len), Some(1));
    let id = shown.attempt_id;
    let refused = rig.connect.connect(ONE, &id, request(&id)).await.unwrap_err();
    assert_eq!(refused.to_string(), "Confirm the port forwards before connecting.");
    let mut accepted = request(&id);
    accepted.accept_forwards = Some(true);
    connected(&rig.connect.connect(ONE, &id, accepted).await.unwrap());
}

#[tokio::test]
async fn a_pending_jump_hop_is_confirmed_before_the_connection() {
    let rig = rig().await;
    let mut inspection = unknown("jump").await;
    inspection.check = SshHostKeyCheck::Unknown {
        fingerprint: "SHA256:jump".into(),
        key_type: "ED25519".into(),
        hops: Some(vec![SshHopKey { name: "target".into(), role: SshHopRole::Target, status: SshHopStatus::Pending, fingerprint: None, key_type: None }]),
    };
    queue(&rig, inspection);
    let id = rig.connect.inspect(ONE, TARGET).await.unwrap().attempt_id;
    let mut confirm = request(&id);
    confirm.trust_host_key = Some(true);
    let result = rig.connect.connect(ONE, &id, confirm).await.unwrap();
    assert!(matches!(failure(&result), SshFailureKind::HostKeyNext));
    assert_eq!(rig.machine.pinned.lock().unwrap().len(), 1);
    assert!(rig.links.opened.lock().unwrap().is_empty());
}

#[tokio::test]
async fn entered_settings_are_validated_and_saved_with_the_server() {
    let rig = rig().await;
    let id = rig.connect.inspect(ONE, TARGET).await.unwrap().attempt_id;
    let mut bad = request(&id);
    bad.settings = Some(SshConnectSettings { identity_file: Some("-oProxyCommand=x".into()), remote_cwd: None });
    assert!(rig.connect.connect(ONE, &id, bad).await.is_err());
    let mut good = request(&id);
    good.settings = Some(SshConnectSettings { identity_file: Some("~/.ssh/build".into()), remote_cwd: Some("~/src".into()) });
    connected(&rig.connect.connect(ONE, &id, good).await.unwrap());
    let settings = rig.hosts.find_by_target(TARGET).and_then(|record| record.settings).expect("settings saved");
    assert_eq!(settings.identity_file.as_deref(), Some("~/.ssh/build"));
    assert_eq!(settings.remote_cwd.as_deref(), Some("~/src"));
    // A live connection is reused without logging in, so new settings would be saved untested.
    let again = rig.connect.inspect(ONE, TARGET).await.unwrap().attempt_id;
    let mut other = request(&again);
    other.settings = Some(SshConnectSettings { identity_file: None, remote_cwd: Some("~/other".into()) });
    let result = rig.connect.connect(ONE, &again, other).await.unwrap();
    assert!(matches!(failure(&result), SshFailureKind::AlreadyConnected));
}

// ----- login and restart -----------------------------------------------------------------------------------------------

#[tokio::test]
async fn refused_login_is_retried_once_through_askpass() {
    let rig = rig().await;
    rig.links.outcomes.lock().unwrap().extend([Err(auth_refused()), Ok(())]);
    let id = rig.connect.inspect(ONE, TARGET).await.unwrap().attempt_id;
    connected(&rig.connect.connect(ONE, &id, request(&id)).await.unwrap());
    // BatchMode first, then the same open with the askpass session; the session is ended.
    let opened = rig.links.opened.lock().unwrap().clone();
    assert_eq!(opened.iter().map(|open| open.1).collect::<Vec<_>>(), vec![false, true]);
    assert!(rig.login.sessions.lock().unwrap()[0].closed.load(Ordering::SeqCst));
}

#[tokio::test]
async fn a_login_still_refused_carries_the_agent_hint() {
    let rig = rig().await;
    rig.links.outcomes.lock().unwrap().extend([Err(auth_refused()), Err(auth_refused())]);
    let id = rig.connect.inspect(ONE, TARGET).await.unwrap().attempt_id;
    let result = rig.connect.connect(ONE, &id, request(&id)).await.unwrap();
    match failure(&result) {
        SshFailureKind::Auth { agent: Some(agent), .. } => assert_eq!(agent.state, SshAgentState::Empty),
        other => panic!("expected the login failure with the agent, got {other:?}"),
    }
    assert_eq!(rig.login.started.load(Ordering::SeqCst), 1);
    assert!(rig.hosts.find_by_target(TARGET).is_none());
}

#[tokio::test]
async fn a_dismissed_question_is_a_cancelled_connect() {
    let rig = rig().await;
    rig.login.dismissed.store(true, Ordering::SeqCst);
    rig.links.outcomes.lock().unwrap().extend([Err(auth_refused()), Err(auth_refused())]);
    let id = rig.connect.inspect(ONE, TARGET).await.unwrap().attempt_id;
    let result = rig.connect.connect(ONE, &id, request(&id)).await.unwrap();
    assert!(matches!(failure(&result), SshFailureKind::Cancelled));
}

#[tokio::test]
async fn a_running_daemon_makes_the_attempt_restartable() {
    let rig = rig().await;
    rig.links.outcomes.lock().unwrap().extend([Err(daemon_running())]);
    let id = rig.connect.inspect(ONE, TARGET).await.unwrap().attempt_id;
    let result = rig.connect.connect(ONE, &id, request(&id)).await.unwrap();
    assert!(matches!(failure(&result), SshFailureKind::DaemonRunning { pid: 4242 }));
    // The attempt outlives the failure, but only a confirmed restart may use it again.
    assert!(rig.connect.connect(ONE, &id, request(&id)).await.is_err());
    let mut restart = request(&id);
    restart.force_restart = Some(true);
    connected(&rig.connect.connect(ONE, &id, restart).await.unwrap());
    assert_eq!(rig.links.opened.lock().unwrap().iter().map(|open| open.2).collect::<Vec<_>>(), vec![false, true]);
}

#[tokio::test]
async fn progress_reaches_only_the_caller_that_started_the_attempt() {
    let rig = rig().await;
    let id = rig.connect.inspect(ONE, TARGET).await.unwrap().attempt_id;
    let attempt = rig.connect.attempts().owned(ONE, &id).unwrap();
    let progress = rig.connect.progress_reporter(&attempt);
    progress(SessionPhase::Check { detail: "linux x64".into() });
    attempt.run().state = AttemptState::Connecting;
    rig.connect.cancel(ONE, &id).await;
    progress(SessionPhase::Ready);
    let seen = rig.push.progress.lock().unwrap().clone();
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0].0, ONE);
    assert_eq!(seen[0].1.phase, SshPhase::Check);
    assert_eq!(seen[0].1.detail.as_deref(), Some("linux x64"));
    let key = diagnostics_key_for(attempt.target());
    assert!(rig.machine.diagnostics().lines(&key, 10).iter().any(|line| line.contains("check: linux x64")));
}

// ----- questions ---------------------------------------------------------------------------------------------------------

#[tokio::test]
async fn a_withdrawn_question_is_closed_in_the_dialog() {
    let mut rig = rig().await;
    let id = rig.connect.inspect(ONE, TARGET).await.unwrap().attempt_id;
    let attempt = rig.connect.attempts().owned(ONE, &id).unwrap();
    let prompter = rig.connect.attempts().prompter(attempt, "build.example".into());
    let asked = tokio::spawn(async move { prompter.ask(AskpassQuestion { kind: AskpassKind::Passphrase, prompt: "Enter passphrase".into(), retry: true }).await });
    let (_, question) = within(rig.askpass.recv()).await.unwrap();
    assert_eq!(question.kind, SshAskpassKind::Passphrase);
    assert_eq!(question.host.as_deref(), Some("build.example"));
    assert!(question.retry);
    assert_eq!(question.timeout_ms, 120_000);
    // The session gave the question up (it timed out): the dialog is told to close it.
    asked.abort();
    let (to, closing) = within(rig.askpass.recv()).await.unwrap();
    assert_eq!((to, closing.kind, closing.request_id), (ONE, SshAskpassKind::Close, question.request_id));
}

#[tokio::test]
async fn an_answer_too_long_for_a_password_cancels_the_question() {
    let mut rig = rig().await;
    let id = rig.connect.inspect(ONE, TARGET).await.unwrap().attempt_id;
    let attempt = rig.connect.attempts().owned(ONE, &id).unwrap();
    let prompter = rig.connect.attempts().prompter(attempt, "build.example".into());
    let asked = tokio::spawn(async move { prompter.ask(AskpassQuestion { kind: AskpassKind::Password, prompt: "Password:".into(), retry: false }).await });
    let (_, question) = within(rig.askpass.recv()).await.unwrap();
    rig.connect.askpass_reply(ONE, &id, &question.request_id, Some("x".repeat(MAX_SECRET_LENGTH + 1)));
    assert_eq!(within(asked).await.unwrap(), None);
}

#[tokio::test]
async fn an_operation_question_is_answered_by_its_caller_and_dies_with_it() {
    let mut rig = rig().await;
    let prompter = rig.connect.attempts().operation_prompter(ONE, "cleanup-1".into(), "build.example".into());
    let asked = tokio::spawn(async move { prompter.ask(AskpassQuestion { kind: AskpassKind::Password, prompt: "Password:".into(), retry: false }).await });
    let (to, question) = within(rig.askpass.recv()).await.unwrap();
    assert_eq!((to, question.attempt_id.as_str()), (ONE, "cleanup-1"));
    rig.connect.askpass_reply(TWO, "cleanup-1", &question.request_id, Some("stolen".into()));
    rig.connect.askpass_reply(ONE, "cleanup-1", &question.request_id, Some("secret".into()));
    assert_eq!(within(asked).await.unwrap(), Some("secret".to_owned()));
    let prompter = rig.connect.attempts().operation_prompter(ONE, "cleanup-2".into(), "build.example".into());
    let asked = tokio::spawn(async move { prompter.ask(AskpassQuestion { kind: AskpassKind::Otp, prompt: "Code:".into(), retry: false }).await });
    within(rig.askpass.recv()).await.unwrap();
    rig.connect.caller_closed(ONE).await;
    assert_eq!(within(asked).await.unwrap(), None);
}

// ----- opening a server's window ---------------------------------------------------------------------------------------

#[tokio::test]
async fn open_focuses_only_a_connected_saved_server() {
    let rig = rig().await;
    assert_eq!(rig.connect.open("missing").await.unwrap_err().to_string(), "This SSH server is no longer saved.");
    let id = rig.connect.inspect(ONE, TARGET).await.unwrap().attempt_id;
    let host = connected(&rig.connect.connect(ONE, &id, request(&id)).await.unwrap()).clone();
    rig.links.open.lock().unwrap().remove(&host.id);
    assert_eq!(
        rig.connect.open(&host.id).await.unwrap_err().to_string(),
        "This SSH server is not connected. Connect it from the SSH server dialog."
    );
    rig.links.open.lock().unwrap().insert(host.id.clone());
    connected(&rig.connect.open(&host.id).await.unwrap());
    assert_eq!(rig.windows.opened.lock().unwrap().len(), 2);
}

// ----- a forget and a connection of one server ---------------------------------------------------------------------------

const RETIRED: &str = "This connection attempt is no longer active. Check the address again.";

#[tokio::test]
async fn a_server_forgotten_after_its_check_is_not_connected_or_saved_by_that_check() {
    let rig = rig().await;
    let id = rig.connect.inspect(ONE, TARGET).await.unwrap().attempt_id;
    let host = connected(&rig.connect.connect(ONE, &id, request(&id)).await.unwrap()).clone();

    // Checked again, an externally trusted route with nothing left to confirm; then the server is forgotten.
    let stale = rig.connect.inspect(ONE, TARGET).await.unwrap().attempt_id;
    let LocalForget::Done = forget_saved(&rig.hosts, rig.connect.attempts(), &host.id).await else { panic!("forgotten") };
    assert_eq!(*rig.links.closed.lock().unwrap(), vec![host.id.clone()], "the forget detached the server");
    let opens = rig.links.opened.lock().unwrap().len();

    let refused = rig.connect.connect(ONE, &stale, request(&stale)).await.unwrap_err();
    assert_eq!(refused.to_string(), RETIRED);
    assert!(rig.hosts.list().is_empty(), "the check of before the forget saves nothing");
    assert_eq!(rig.links.opened.lock().unwrap().len(), opens, "and opens nothing");
}

#[tokio::test]
async fn a_check_answered_while_the_forget_closes_the_link_is_retired_with_the_entry() {
    let rig = rig().await;
    let id = rig.connect.inspect(ONE, TARGET).await.unwrap().attempt_id;
    let host = connected(&rig.connect.connect(ONE, &id, request(&id)).await.unwrap()).clone();

    // The forget is held while it closes the server's link; a check of the server is answered meanwhile.
    rig.links.hold_close.store(true, Ordering::SeqCst);
    let (hosts, connect, forgotten_id) = (rig.hosts.clone(), rig.connect.clone(), host.id.clone());
    let forgetting = tokio::spawn(async move { forget_saved(&hosts, connect.attempts(), &forgotten_id).await });
    within(rig.links.close_started.notified()).await;
    let between = rig.connect.inspect(ONE, TARGET).await.unwrap().attempt_id;
    assert!(rig.hosts.get(&host.id).is_some(), "the entry is still there while the link closes");

    rig.links.release_close.notify_one();
    let LocalForget::Done = within(forgetting).await.unwrap() else { panic!("forgotten") };
    assert_eq!(rig.connect.connect(ONE, &between, request(&between)).await.unwrap_err().to_string(), RETIRED);
    assert!(rig.hosts.list().is_empty(), "the check that came between the close and the removal saves nothing");
}

#[tokio::test]
async fn a_check_that_started_before_the_forget_cannot_register_after_it() {
    let rig = rig().await;
    let id = rig.connect.inspect(ONE, TARGET).await.unwrap().attempt_id;
    let host = connected(&rig.connect.connect(ONE, &id, request(&id)).await.unwrap()).clone();

    // A check of the server is held while ssh reads its key; the server is forgotten meanwhile.
    rig.machine.hold_inspect.store(true, Ordering::SeqCst);
    let connect = rig.connect.clone();
    let inspecting = tokio::spawn(async move { connect.inspect(ONE, TARGET).await });
    within(rig.machine.inspect_started.notified()).await;
    let LocalForget::Done = forget_saved(&rig.hosts, rig.connect.attempts(), &host.id).await else { panic!("forgotten") };

    rig.machine.release_inspect.notify_one();
    assert_eq!(within(inspecting).await.unwrap().unwrap_err().to_string(), RETIRED, "its registration after the retirement is refused");
    assert_eq!(rig.connect.attempts().attempt_count(ONE), 0);
    assert!(rig.hosts.list().is_empty());
}

#[tokio::test]
async fn a_waiter_that_goes_away_leaves_no_turn_behind() {
    let rig = rig().await;
    let first = rig.hosts.turn("dev@build.example").await;
    {
        let waiter = rig.hosts.turn("dev@build.example");
        tokio::pin!(waiter);
        tokio::select! {
            biased;
            _ = &mut waiter => panic!("the turn is held"),
            () = std::future::ready(()) => {}
        }
        // The holder leaves while the waiter is still queued; then the waiter goes away without its turn.
        drop(first);
    }
    assert_eq!(rig.hosts.turns_in_use(), 0);
    drop(within(rig.hosts.turn("dev@build.example")).await);
    assert_eq!(rig.hosts.turns_in_use(), 0);
}

#[tokio::test]
async fn a_key_refused_where_it_is_saved_reaches_the_dialog_by_code() {
    let rig = rig().await;
    queue(&rig, unknown("key-shown").await);
    let id = rig.connect.inspect(ONE, TARGET).await.unwrap().attempt_id;
    let changed = mixdog_ssh::said::HOST_KEYS_CHANGED_WHILE_CONFIRMING.plain();
    *rig.machine.pin_refusal.lock().unwrap() = Some(SshError::said(changed.clone(), FailureClass::Transient));
    let mut confirmed = request(&id);
    confirmed.trust_host_key = Some(true);
    let SshConnectResult::Failed(failed) = rig.connect.connect(ONE, &id, confirmed).await.unwrap() else { panic!("refused") };
    assert_eq!(failed.failure.notice, Some(changed.message));
    assert_eq!(failed.failure.kind, SshFailureKind::Failed { message: changed.english });
    assert!(rig.links.opened.lock().unwrap().is_empty() && rig.hosts.list().is_empty(), "nothing is opened or saved");
}

#[tokio::test]
async fn a_forget_waits_for_the_connection_in_flight_and_removes_what_it_saved() {
    let rig = rig().await;
    let id = rig.connect.inspect(ONE, TARGET).await.unwrap().attempt_id;
    let host = connected(&rig.connect.connect(ONE, &id, request(&id)).await.unwrap()).clone();

    // A second connection of the server is held inside its turn, at the link.
    let again = rig.connect.inspect(ONE, TARGET).await.unwrap().attempt_id;
    rig.links.hold.store(true, Ordering::SeqCst);
    let connect = rig.connect.clone();
    let connecting = tokio::spawn(async move { connect.connect(ONE, &again, request(&again)).await });
    within(rig.links.started.notified()).await;

    let (hosts, connect, forgotten_id) = (rig.hosts.clone(), rig.connect.clone(), host.id.clone());
    let forgetting = tokio::spawn(async move { forget_saved(&hosts, connect.attempts(), &forgotten_id).await });
    for _ in 0..50 {
        tokio::task::yield_now().await;
    }
    assert!(!forgetting.is_finished(), "the forget waits for the server's turn");
    assert!(rig.hosts.get(&host.id).is_some() && rig.links.closed.lock().unwrap().is_empty(), "and has removed nothing meanwhile");

    rig.links.release.notify_one();
    connected(&within(connecting).await.unwrap().unwrap());
    let LocalForget::Done = within(forgetting).await.unwrap() else { panic!("forgotten") };
    assert!(rig.hosts.list().is_empty(), "what the connection saved is what the forget removed: the server does not come back");
    assert!(!rig.links.is_open(&host.id) && *rig.links.closed.lock().unwrap() == vec![host.id.clone()]);

    // The window of a server that is gone is not put forward again, and the server is not saved back.
    assert_eq!(rig.connect.open(&host.id).await.unwrap_err().to_string(), "This SSH server is no longer saved.");
    assert!(rig.hosts.list().is_empty());
}

#[tokio::test]
async fn open_ephemeral_is_never_saved() {
    let rig = rig().await;
    let result = rig.connect.open_ephemeral("ci@runner.example:2222", "runner").await.unwrap();
    let host = connected(&result);
    assert_eq!((host.id.as_str(), host.name.as_str()), (EPHEMERAL_ID, "runner"));
    assert!(rig.hosts.list().is_empty());
    assert_eq!(*rig.windows.opened.lock().unwrap(), vec![EPHEMERAL_ID.to_owned()]);
    assert!(rig.connect.open_ephemeral("-oProxyCommand=x", "x").await.is_err());
}

#[tokio::test]
async fn a_failed_open_is_a_result_the_dialog_shows() {
    let rig = rig().await;
    rig.links.outcomes.lock().unwrap().extend([Err(ConnectError::Ssh(SshError::new("Connection refused", FailureClass::Transient)))]);
    let result = rig.connect.open_ephemeral(TARGET, "dev").await.unwrap();
    assert!(matches!(failure(&result), SshFailureKind::Failed { .. }));
    assert!(rig.windows.opened.lock().unwrap().is_empty());
}

trait IntoInspection {
    fn into_inspection(self) -> HostKeyInspection;
}

impl IntoInspection for SshHostKeyCheck {
    fn into_inspection(self) -> HostKeyInspection {
        HostKeyInspection { hops: Vec::new(), check: self, pin: None, replace: None, summary: None, reviewed: None }
    }
}
