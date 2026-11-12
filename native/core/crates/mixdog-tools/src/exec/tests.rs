#![allow(clippy::disallowed_methods, reason = "tests read and write their fixture files on the test thread")]

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use mixdog_core_api::domain::common::AbsPath;
use mixdog_core_api::domain::common::EventSource;
use mixdog_core_api::domain::mock::MockApprovalGate;
use mixdog_core_api::domain::mock::MockFileService;
use mixdog_core_api::domain::mock::MockProgress;
use mixdog_core_api::domain::process::*;
use mixdog_core_api::domain::tool::*;
use mixdog_protocol::JsonValue;
use mixdog_protocol::ProcessHandle;
use mixdog_protocol::ThreadId;
use mixdog_protocol::ToolCallId;
use mixdog_protocol::TurnId;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use super::*;

type Chan = mpsc::UnboundedSender<ProcessEvent>;

/// Scripted by command text: `echo X`, `fail`, `timeout`; anything else keeps running.
#[derive(Default)]
struct FakeProcesses {
    senders: Mutex<HashMap<ProcessHandle, (Chan, u64)>>,
    receivers: Mutex<HashMap<ProcessHandle, mpsc::UnboundedReceiver<ProcessEvent>>>,
    /// Handles whose kill is reported as the run limit expiring.
    limited: Mutex<std::collections::HashSet<ProcessHandle>>,
    /// Every spawn request, in order.
    seen: Mutex<Vec<(CommandSpec, EnvSpec)>>,
    /// Every script fed on stdin, in order.
    fed: Mutex<Vec<String>>,
    /// The `echo X; Start-Sleep 30` command prints nothing at spawn; the test prints later.
    quiet: std::sync::atomic::AtomicBool,
    /// A kill that cannot be sent (the process manager refuses it).
    refuse_kill: std::sync::atomic::AtomicBool,
    /// A write to a process's input that fails (its pipe broke).
    refuse_write: std::sync::atomic::AtomicBool,
    /// Every handle whose input was closed, and every handle killed, in order.
    closed: Mutex<Vec<ProcessHandle>>,
    killed: Mutex<Vec<ProcessHandle>>,
}

struct ChanSource(mpsc::UnboundedReceiver<ProcessEvent>);

#[async_trait]
impl EventSource<ProcessEvent> for ChanSource {
    async fn next(&mut self) -> Option<ProcessEvent> {
        self.0.recv().await
    }
}

fn send(chan: &Chan, seq: &mut u64, make: impl FnOnce(u64) -> ProcessEvent) {
    chan.send(make(*seq)).unwrap();
    *seq += 1;
}

#[async_trait]
impl ProcessManager for FakeProcesses {
    async fn spawn(&self, request: SpawnRequest) -> Result<SpawnedProcess, ProcessError> {
        let CommandSpec::Shell { script, .. } = &request.command else {
            unreachable!()
        };
        let (tx, rx) = mpsc::unbounded_channel();
        let mut seq = 0;
        self.seen.lock().unwrap().push((request.command.clone(), request.env.clone()));
        // A script fed on stdin acts when it arrives.
        if !request.stdin_piped {
            self.act(script, &request.handle, &tx, &mut seq);
        }
        self.senders.lock().unwrap().insert(request.handle.clone(), (tx, seq));
        self.receivers.lock().unwrap().insert(request.handle.clone(), rx);
        Ok(SpawnedProcess { handle: request.handle, pid: 1 })
    }

    fn subscribe(
        &self,
        handle: &ProcessHandle,
        _from_seq: Option<u64>,
    ) -> Result<Box<dyn EventSource<ProcessEvent>>, ProcessError> {
        let rx = self.receivers.lock().unwrap().remove(handle).ok_or(ProcessError::UnknownHandle)?;
        Ok(Box::new(ChanSource(rx)))
    }

    async fn write_stdin(&self, handle: &ProcessHandle, bytes: Vec<u8>) -> Result<(), ProcessError> {
        if self.refuse_write.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(ProcessError::Io { os_code: Some(232) });
        }
        let script = String::from_utf8(bytes).unwrap();
        self.fed.lock().unwrap().push(script.clone());
        let mut senders = self.senders.lock().unwrap();
        let (tx, seq) = senders.get_mut(handle).ok_or(ProcessError::UnknownHandle)?;
        let tx = tx.clone();
        self.act(&script, handle, &tx, seq);
        Ok(())
    }
    fn close_stdin(&self, handle: &ProcessHandle) -> Result<(), ProcessError> {
        self.closed.lock().unwrap().push(handle.clone());
        Ok(())
    }
    fn resize_pty(&self, _: &ProcessHandle, _: PtySize) -> Result<(), ProcessError> {
        Err(ProcessError::NotPty)
    }
    fn kill(&self, handle: &ProcessHandle) -> Result<(), ProcessError> {
        if self.refuse_kill.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(ProcessError::UnknownHandle);
        }
        self.killed.lock().unwrap().push(handle.clone());
        let mut senders = self.senders.lock().unwrap();
        let (tx, seq) = senders.get_mut(handle).ok_or(ProcessError::UnknownHandle)?;
        let reason = if self.limited.lock().unwrap().contains(handle) { KillReason::TimeLimit } else { KillReason::Requested };
        send(tx, seq, |seq| ProcessEvent::Exited {
            seq,
            exit: ProcessExit { status: ExitStatus::Signal(9), killed: Some(reason) },
        });
        Ok(())
    }
    fn list(&self) -> Vec<ProcessInfo> {
        Vec::new()
    }
}

impl FakeProcesses {
    /// What the process of `script` prints and how it ends.
    fn act(&self, script: &str, handle: &ProcessHandle, tx: &Chan, seq: &mut u64) {
        let exit = |status, killed| ProcessExit { status, killed };
        if script == "run-limited" {
            self.limited.lock().unwrap().insert(handle.clone());
        } else if let Some(tee) = script
            .split("-FilePath '")
            .nth(1)
            .filter(|_| script.contains("Tee-Object"))
            .and_then(|rest| rest.split('\'').next())
        {
            // A filter pipeline whose producer failed: the tee holds what the filters swallowed.
            std::fs::write(tee, "boom\n").unwrap();
            send(tx, seq,|seq| ProcessEvent::Exited { seq, exit: exit(ExitStatus::Code(1), None) });
        } else if script == "echo begin; Start-Sleep 30" {
            let bytes = b"begin\n".to_vec();
            send(tx, seq,|seq| ProcessEvent::Output { seq, stream: OutputStream::Stdout, bytes });
            send(tx, seq,|seq| ProcessEvent::Exited {
                seq,
                exit: exit(ExitStatus::Signal(9), Some(KillReason::TimeLimit)),
            });
        } else if self.quiet.load(std::sync::atomic::Ordering::SeqCst) && script.ends_with("; Start-Sleep 30") {
        } else if let Some(word) = script.strip_suffix("; Start-Sleep 30").and_then(|s| s.strip_prefix("echo ")) {
            let bytes = format!("{word}\n").into_bytes();
            send(tx, seq,|seq| ProcessEvent::Output { seq, stream: OutputStream::Stdout, bytes });
        } else if script == "echo done-out" {
            // Silent until the test prints and ends it, as Node's process had printed nothing when
            // the task was promoted.
        } else if let Some(rest) = script.strip_prefix("echo ") {
            send(tx, seq,|seq| ProcessEvent::Output {
                seq,
                stream: OutputStream::Stdout,
                bytes: format!("{rest}\n").into_bytes(),
            });
            send(tx, seq,|seq| ProcessEvent::Exited { seq, exit: exit(ExitStatus::Code(0), None) });
        } else if script.starts_with("grep ") {
            send(tx, seq,|seq| ProcessEvent::Exited { seq, exit: exit(ExitStatus::Code(1), None) });
        } else if script == "korean" {
            send(tx, seq,|seq| ProcessEvent::Output {
                seq,
                stream: OutputStream::Stdout,
                bytes: vec![0xC7, 0xD1, 0xB1, 0xDB, 0x20, 0xC3, 0xE2, 0xB7, 0xC2, 0x0A],
            });
            send(tx, seq,|seq| ProcessEvent::Exited { seq, exit: exit(ExitStatus::Code(0), None) });
        } else if script == "repeat" {
            send(tx, seq,|seq| ProcessEvent::Output {
                seq,
                stream: OutputStream::Stdout,
                bytes: "tick\n".repeat(200).into_bytes(),
            });
            send(tx, seq,|seq| ProcessEvent::Exited { seq, exit: exit(ExitStatus::Code(0), None) });
        } else if script == "fail" {
            send(tx, seq,|seq| ProcessEvent::Output {
                seq,
                stream: OutputStream::Stderr,
                bytes: b"boom\n".to_vec(),
            });
            send(tx, seq,|seq| ProcessEvent::Exited { seq, exit: exit(ExitStatus::Code(3), None) });
        } else if script == "timeout" {
            send(tx, seq,|seq| ProcessEvent::Exited {
                seq,
                exit: exit(ExitStatus::Signal(9), Some(KillReason::TimeLimit)),
            });
        }
    }
}

/// Stands in for the worker: every `await` body reads as top-level, so it stays inline.
struct AwaitIsTopLevel;
#[async_trait]
impl ScriptSyntax for AwaitIsTopLevel {
    async fn compiles_as_commonjs(&self, _: &ThreadId, _: &str) -> Result<bool, mixdog_core_api::domain::ext::ExtError> {
        Ok(false)
    }
}

struct NoPublisher;
impl mixdog_spawn::tasks::TaskPublisher for NoPublisher {
    fn thread_updated(&self, _: &str, _: &mixdog_spawn::tasks::ShellJobsState) {}
    fn host_updated(&self, _: &mixdog_spawn::tasks::HostShellJobs) {}
    fn schedule_expiry(&self, _: u64) {}
}

/// 2026-01-02T03:04:05.678Z, the instant the recorded Node tasks started.
fn golden_ms() -> u64 {
    use chrono::TimeZone;
    chrono::Utc.with_ymd_and_hms(2026, 1, 2, 3, 4, 5).unwrap().timestamp_millis() as u64 + 678
}

pub(super) struct Rig {
    shell: ShellTool,
    task: TaskTool,
    pub(super) runtime: Arc<ExecRuntime>,
    dir: tempfile::TempDir,
    processes: Arc<FakeProcesses>,
    /// What the tool sees: the fake, or the real manager of a test that runs real processes.
    manager: Arc<dyn ProcessManager>,
    review: Arc<super::settle::RecordingReview>,
    /// The lanes the runtime and every call context use: the test backend's, or real executors'.
    tokens: mixdog_rt::LaneTokens,
}

fn rig() -> Rig {
    rig_with(Arc::new(OsPromptElevation))
}

struct RefuseElevation;
impl ElevationGate for RefuseElevation {
    fn approved(&self, _: &ToolContext, _: &str) -> bool {
        false
    }
}

fn rig_with(elevation: Arc<dyn ElevationGate>) -> Rig {
    rig_full(elevation, None)
}

fn rig_full(elevation: Arc<dyn ElevationGate>, notifier: Option<Arc<dyn TaskNotifier>>) -> Rig {
    rig_on(mixdog_rt::testing::tokens(), elevation, notifier)
}

fn rig_on(tokens: mixdog_rt::LaneTokens, elevation: Arc<dyn ElevationGate>, notifier: Option<Arc<dyn TaskNotifier>>) -> Rig {
    let review = Arc::new(super::settle::RecordingReview::default());
    let dir = tempfile::tempdir().unwrap();
    let runtime = ExecRuntime::new(ExecConfig {
        tasks: Arc::new(mixdog_spawn::tasks::TaskRegistry::new(Arc::new(NoPublisher), golden_ms)),
        lanes: IoLanes {
            interactive: tokens.interactive_io,
            durability: tokens.durability_io,
            maintenance: tokens.maintenance_io,
            spawn: tokens.spawn_io,
            pty: tokens.pty_io,
        },
        spill_dir: dir.path().join("l"),
        data_dir: Some(dir.path().join("data")),
        skill_launcher_dir: None,
        notifier,
        survivors: None,
        wake: WakeHub::new(),
        policy: Arc::new(crate::policy::exec::NodeCommandPolicy),
        elevation,
        oem: None,
        skill_runtime: None,
        shell: Arc::new(FixedShell("/bin/sh".into())),
        script_syntax: Arc::new(AwaitIsTopLevel),
        windows: false,
        powershell: false,
        warm_standby: false,
        now_ms: Arc::new(golden_ms),
    });
    let processes = Arc::new(FakeProcesses::default());
    Rig {
        shell: ShellTool::new(runtime.clone()),
        task: TaskTool::new(runtime.clone()),
        runtime,
        dir,
        manager: processes.clone(),
        processes,
        review,
        tokens,
    }
}

pub(super) fn ctx(rig: &Rig, call: &str) -> ToolContext {
    let tokens = rig.tokens;
    ToolContext {
        call_id: ToolCallId::from(call),
        thread_id: ThreadId::from("t"),
        turn_id: TurnId::from("r"),
        tool: "shell".into(),
        cwd: AbsPath::new(rig.dir.path()).unwrap(),
        surface: SurfaceKind::Lead,
        cancel: CancellationToken::new(),
        deadline: None,
        progress: Arc::new(MockProgress::default()),
        io: ToolIo {
            interactive: tokens.interactive_io,
            durability: tokens.durability_io,
            maintenance: tokens.maintenance_io,
        },
        approvals: Arc::new(MockApprovalGate::default()),
        files: Arc::new(MockFileService::default()),
        processes: rig.manager.clone(),
        options: Default::default(),
        review: Some(rig.review.clone()),
    }
}

pub(super) fn body(outcome: ToolOutcome) -> String {
    match outcome {
        Ok(out) => match &out.parts[0] {
            ToolPart::Text(t) => t.clone(),
            _ => panic!("not text"),
        },
        Err(e) => e.message_for_model,
    }
}

fn fixture(dir: &str, name: &str) -> JsonValue {
    let path = format!("{}/../../fixtures/tools/{dir}/{name}.json", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

#[tokio::test]
async fn echo_matches_the_golden_fixture() {
    let rig = rig();
    let golden = fixture("shell", "shell-echo");
    let text = body(rig.shell.call(&ctx(&rig, "c1"), golden["input"].clone()).await);
    assert_eq!(text, golden["text"].as_str().unwrap());
}

/// The first job of a runtime removes the logs of ended jobs older than a week (`sweepExpiredShellOutput`), beside
/// the command and never on its path: the command completes while the sweep is held. Only logs whose ownership
/// record shows their job ended are taken: a running job's week-silent logs (another process's) and a user's file named
/// like a log stay. Later jobs sweep nothing, and a job's own record shows it ended once it has.
#[tokio::test]
async fn the_first_job_sweeps_the_ended_jobs_logs_older_than_a_week_once_beside_the_command() {
    let rig = rig();
    let logs = rig.dir.path().join("l");
    std::fs::create_dir_all(&logs).unwrap();
    let day = std::time::Duration::from_secs(24 * 60 * 60);
    let now = std::time::SystemTime::now();
    let aged_with = |name: &str, body: &str, age: std::time::Duration| {
        let path = logs.join(name);
        std::fs::write(&path, body).unwrap();
        std::fs::File::options().write(true).open(&path).unwrap().set_modified(now - age).unwrap();
        path
    };
    let aged = |name: &str, age| aged_with(name, "", age);
    let job = |id: &str, state: &str, age| {
        [
            aged(&format!("{id}.stdout.log"), age),
            aged(&format!("{id}.stderr.log"), age),
            aged_with(&format!("{id}.owner.json"), &format!(r#"{{"pid":1,"state":"{state}"}}"#), age),
        ]
    };
    let expired = job("task-old", "finished", day * 8);
    let recent = job("task-recent", "finished", day * 6);
    let live = job("task-live-elsewhere", "running", day * 8);
    let users = aged("task-my-personal-notes.stdout.log", day * 8);
    let foreign = aged("notes.txt", day * 8);
    let gate = super::spill::sweep_gate::hold(&logs);
    let golden = fixture("shell", "shell-echo");
    mixdog_rt::time::timeout(std::time::Duration::from_secs(60), rig.shell.call(&ctx(&rig, "c1"), golden["input"].clone()))
        .await
        .expect("the command completes while the log sweep is held")
        .unwrap();
    assert!(expired.iter().all(|p| p.exists()), "the held sweep has removed nothing yet");
    gate.notify_one();
    rig.runtime.drain_snapshots(&CancellationToken::new()).await;
    assert!(expired.iter().all(|p| !p.exists()), "the ended job's week-old logs and record went");
    assert!(recent.iter().all(|p| p.exists()), "the newer ones stayed");
    assert!(live.iter().all(|p| p.exists()), "a running job's silent logs stay");
    assert!(users.exists() && foreign.exists(), "files with no ownership record stay");
    let later = job("task-later", "finished", day * 8);
    rig.shell.call(&ctx(&rig, "c2"), golden["input"].clone()).await.unwrap();
    rig.runtime.drain_snapshots(&CancellationToken::new()).await;
    assert!(later.iter().all(|p| p.exists()), "the sweep runs once per runtime");
}

/// A job's logs are created after their ownership record, which shows the job running until it is marked ended.
#[tokio::test]
async fn a_jobs_log_record_shows_it_running_until_it_ends() {
    let rig = rig();
    let (out, err) = (rig.dir.path().join("task-r.stdout.log"), rig.dir.path().join("task-r.stderr.log"));
    let writer = super::spill::LogWriter::new(rig.runtime.config.lanes.pty, &out, &err);
    writer.open().await;
    writer.close(super::spill::LOG_STALL).await;
    let record = || std::fs::read_to_string(rig.dir.path().join("task-r.owner.json")).unwrap();
    assert!(out.exists() && err.exists() && record().contains(r#""state":"running""#), "{}", record());
    writer.mark_finished(super::spill::LOG_STALL).await;
    assert!(record().contains(r#""state":"finished""#), "{}", record());
}

/// A job's first drain is held before it creates the logs (a stalled disk) while the job ends: the close gives the
/// writer up and the end is marked with no record to mark yet. The held creation, when it runs, records the job as
/// ended: a record left saying running after the job's end would keep its logs from every sweep. Real io-pty threads.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_log_creation_held_past_the_jobs_end_records_the_job_as_ended() {
    let minute = std::time::Duration::from_secs(60);
    let (_executors, tokens) = mixdog_rt::exec::boot(mixdog_rt::exec::RtConfig::for_cores(4)).expect("the executors");
    let dir = tempfile::tempdir().unwrap();
    let logs = [dir.path().join("d.stdout.log"), dir.path().join("d.stderr.log")];
    let owner = dir.path().join("d.owner.json");
    let gate = super::spill::write_gate::arm(dir.path());
    let writer = super::spill::LogWriter::new(tokens.pty_io, &logs[0], &logs[1]);
    mixdog_rt::time::timeout(minute, writer.open()).await.expect("the drain starts");
    let reached = gate.clone();
    tokio::task::spawn_blocking(move || reached.wait_reached(1)).await.unwrap();
    mixdog_rt::time::timeout(minute, writer.close(std::time::Duration::ZERO)).await.expect("closing returns while the creation is held");
    mixdog_rt::time::timeout(minute, writer.mark_finished(minute)).await.expect("the mark ends while the creation is held");
    assert!(!owner.exists(), "the held creation has written no record, and the mark creates none");
    gate.open();
    mixdog_rt::time::timeout(minute, writer.idle()).await.expect("the held creation ends");
    let record = std::fs::read_to_string(&owner).unwrap();
    assert!(record.contains(r#""state":"finished""#), "{record}");
}

/// The end of a job is marked on its logs' own lane and within a deadline: with the only io-pty thread held, the mark
/// waits in io-pty's queue, the marking returns at its deadline with the record unchanged, and the mark is written
/// once a thread is free.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn marking_a_jobs_end_waits_on_the_logs_lane_and_returns_at_its_deadline() {
    use mixdog_rt::LaneToken;
    let minute = std::time::Duration::from_secs(60);
    let mut config = mixdog_rt::exec::RtConfig::for_cores(4);
    config.pty_max_live = 1;
    let (executors, tokens) = mixdog_rt::exec::boot(config).expect("the executors");
    let dir = tempfile::tempdir().unwrap();
    let logs = [dir.path().join("m.stdout.log"), dir.path().join("m.stderr.log")];
    let record = || std::fs::read_to_string(dir.path().join("m.owner.json")).unwrap();
    let writer = super::spill::LogWriter::new(tokens.pty_io, &logs[0], &logs[1]);
    mixdog_rt::time::timeout(minute, writer.open()).await.expect("the drain starts");
    let closed = mixdog_rt::time::timeout(minute, writer.close(minute)).await.expect("the logs are created");
    assert_eq!(closed, super::spill::LogsClosed::Complete);
    let (started, held_started) = std::sync::mpsc::channel();
    let (release, held) = std::sync::mpsc::channel::<()>();
    let holder = tokens
        .pty_io
        .submit(&CancellationToken::new(), move |_| {
            started.send(()).unwrap();
            let _ = held.recv_timeout(std::time::Duration::from_secs(60));
        })
        .expect("io-pty takes the holder");
    held_started.recv_timeout(minute).expect("the only io-pty thread is held");
    let pty_queue = || executors.diagnostics().lanes.into_iter().find(|l| l.kind == mixdog_rt::LaneKind::PtyIo).unwrap().queue_depth;
    mixdog_rt::time::timeout(minute, writer.mark_finished(std::time::Duration::ZERO)).await.expect("marking returns at its deadline");
    assert_eq!(pty_queue(), 1, "the mark waits in io-pty's queue");
    assert!(record().contains(r#""state":"running""#), "{}", record());
    drop(release);
    mixdog_rt::time::timeout(minute, holder).await.expect("the holder ends").unwrap();
    // A second mark queues behind the first: when it has run, so has the first.
    mixdog_rt::time::timeout(minute, writer.mark_finished(minute)).await.expect("the marks run once a thread is free");
    assert!(record().contains(r#""state":"finished""#), "{}", record());
}

/// A running job whose log another process's sweep removed keeps spilling: its next append recreates the log.
#[tokio::test]
async fn an_append_recreates_a_log_another_sweep_removed() {
    let rig = rig();
    let log = rig.dir.path().join("task-live.stdout.log");
    let writer = super::spill::LogWriter::new(rig.runtime.config.lanes.pty, &log, &rig.dir.path().join("task-live.stderr.log"));
    writer.push(0, b"first\n".to_vec()).await;
    assert_eq!(writer.close(super::spill::LOG_STALL).await, super::spill::LogsClosed::Complete);
    std::fs::remove_file(&log).unwrap();
    writer.push(0, b"later\n".to_vec()).await;
    assert_eq!(writer.close(super::spill::LOG_STALL).await, super::spill::LogsClosed::Complete, "the stream still spills");
    assert_eq!(std::fs::read_to_string(&log).unwrap(), "later\n");
}

/// A hoisted script stays while its command runs; one whose tree never settled is removed when
/// the runtime shuts down (Node's exit hook, `foreground-artifact-lifecycle.test.mjs:66`).
#[tokio::test]
async fn a_hoisted_script_of_a_tree_that_never_settled_is_removed_at_shutdown() {
    let rig = rig();
    let started = body(
        rig.shell
            .call(&ctx(&rig, "c1"), serde_json::json!({"command": "node -e \"console.log(1)\"", "background": true}))
            .await,
    );
    assert!(started.starts_with("background task\n"), "{started}");
    let (spec, _) = rig.processes.seen.lock().unwrap().last().cloned().unwrap();
    let CommandSpec::Shell { script, .. } = spec else { unreachable!() };
    let path = script.rsplit('"').nth(1).map(std::path::PathBuf::from).expect("the command runs a hoisted file");
    assert!(path.exists(), "the running command still uses {}", path.display());
    rig.runtime.drain_snapshots(&CancellationToken::new()).await;
    assert!(!path.exists(), "the shutdown removed {}", path.display());
}

/// The `task` goldens were recorded from today's Node product (`executeTaskTool`); every text is
/// asserted byte-equal.
#[tokio::test]
async fn task_matches_the_golden_twins_recorded_from_node() {
    let rig = rig();
    let c = ctx(&rig, "c0");
    for name in [
        "task-list-empty",
        "task-no-action",
        "task-no-task-id",
        "task-session-id",
        "task-bad-action",
        "task-read-missing",
        "task-wait-missing",
        "task-cancel-missing",
    ] {
        let golden = fixture("task", name);
        assert_eq!(body(rig.task.execute(&c, golden["input"].clone()).await), golden["text"].as_str().unwrap(), "{name}");
    }
    // The task Node registered: a running shell `sleep 100`, id task-gold.
    let started = body(
        rig.shell
            .call(&ctx(&rig, "gold"), serde_json::json!({"command": "sleep 100", "background": true}))
            .await,
    );
    assert!(started.starts_with("background task\ntask_id: task-gold\nlabel: sleep 100\nstatus: running\nstarted: 2026-01-02T03:04:05.678Z\n"), "{started}");
    let golden = fixture("task", "task-list-running");
    assert_eq!(body(rig.task.call(&c, golden["input"].clone()).await), golden["text"].as_str().unwrap());
    // `task read` of a running task Node holds no result for renders the bare header.
    let golden = fixture("task", "task-read-running");
    let job = rig.runtime.get(&ThreadId::from("t"), "task-gold").unwrap();
    let shown = job.render(false, Some("")).replace(&super::jobs::shown_path(&rig.dir.path().join("l")), "/l");
    assert_eq!(shown, golden["text"].as_str().unwrap());
}

/// What Node's `executeBuiltinTool` answers a `task` call whose arguments are wrong (the guard, then the handler):
/// every case of `fixtures/tool-arg-answers/answers.json` (`record-tool-arg-answers.mjs`), text for text.
#[tokio::test]
async fn task_arguments_are_answered_as_nodes_guard_answers_them() {
    let rig = rig();
    let c = ctx(&rig, "c0");
    let answers: JsonValue = serde_json::from_str(&std::fs::read_to_string(format!("{}/../../fixtures/tool-arg-answers/answers.json", env!("CARGO_MANIFEST_DIR"))).unwrap()).unwrap();
    let mut failures = Vec::new();
    let mut compared = 0;
    for case in answers["cases"].as_array().unwrap().iter().filter(|c| c["tool"] == "task") {
        let got = body(rig.task.call(&c, case["input"].clone()).await);
        if got != case["text"].as_str().unwrap() {
            failures.push(format!("{}: want {:?}, got {got:?}", case["name"], case["text"]));
        }
        compared += 1;
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
    assert!(compared >= 37, "{compared}");
}

/// Replaces what differs per run: the task id, timestamps and log paths.
fn normalize(text: &str) -> String {
    let id = regex::Regex::new(r"task-[A-Za-z0-9_]+").unwrap().replace_all(text, "JOB").into_owned();
    let ts = regex::Regex::new(r"\d{4}-\d\d-\d\dT[\d:.]+Z").unwrap().replace_all(&id, "TS").into_owned();
    regex::Regex::new(r"logs: .*").unwrap().replace_all(&ts, "logs: LOGS").into_owned()
}

/// Texts recorded from today's Node product for a timeout, a cancelled foreground command, a
/// hold that ran out, an explicit background start and the cancel of a running and an ended task.
#[tokio::test]
async fn shell_and_task_goldens_recorded_from_node() {
    let mut rig = rig();
    // A clock that moves, as the hold text counts real seconds.
    let begun = std::time::Instant::now();
    let mut config = rig.runtime.config.clone_for_test();
    config.now_ms = Arc::new(move || golden_ms() + begun.elapsed().as_millis() as u64);
    rig.runtime = ExecRuntime::new(config);
    rig.shell = ShellTool::new(rig.runtime.clone());
    rig.task = TaskTool::new(rig.runtime.clone());
    let golden = fixture("shell", "shell-timeout");
    let err = rig.shell.call(&ctx(&rig, "g1"), golden["input"].clone()).await.unwrap_err();
    assert_eq!(normalize(&err.message_for_model), golden["text"].as_str().unwrap());

    // Aborted once the command is running: the kill arrives, the text names the cancellation.
    let golden = fixture("shell", "shell-cancelled-foreground");
    let c = ctx(&rig, "g2");
    let cancel = c.cancel.clone();
    let call = rig.shell.call(&c, golden["input"].clone());
    let abort = async {
        while rig.processes.senders.lock().unwrap().is_empty() {
            tokio::task::yield_now().await;
        }
        cancel.cancel();
    };
    let (outcome, ()) = tokio::join!(call, abort);
    assert_eq!(normalize(&body(outcome)), golden["text"].as_str().unwrap());

    let golden = fixture("shell", "shell-hold-expiry");
    let held = body(rig.shell.call(&ctx(&rig, "g3"), golden["input"].clone()).await);
    assert_eq!(normalize(&held), golden["text"].as_str().unwrap());

    let golden = fixture("shell", "shell-background-start");
    let started = body(rig.shell.call(&ctx(&rig, "g4"), golden["input"].clone()).await);
    // The fake prints at once; Node's process had printed nothing yet.
    let expected = golden["text"].as_str().unwrap().replace(
        "[progress] no new output since you last saw it — still running, not an error\n\n(no new output)",
        "[progress] +0.0 KB, +1 lines since you last saw it · last line: \"tick\" — still running, not an error\n\n[stdout]\ntick\n",
    );
    assert_eq!(normalize(&started), expected);

    let c = ctx(&rig, "g5");
    for name in ["task-cancel-running", "task-cancel-again"] {
        let golden = fixture("shell", name);
        let mut input = golden["input"].clone();
        input["task_id"] = "task-g4".into();
        assert_eq!(normalize(&body(rig.task.call(&c, input).await)), golden["text"].as_str().unwrap(), "{name}");
    }
}

/// `task read`/`wait` of a finished task, `wait` that reaches its ceiling and `list` of both, as
/// recorded from Node (`fixtures/tools/task/task-*-completed|expiry|after`).
#[tokio::test]
async fn task_read_wait_and_list_match_the_goldens_recorded_from_node() {
    let rig = rig();
    rig.shell.call(&ctx(&rig, "a"), serde_json::json!({"command": "echo done-out", "background": true})).await.unwrap();
    {
        let mut senders = rig.processes.senders.lock().unwrap();
        let (tx, seq) = senders.values_mut().next().unwrap();
        send(tx, seq, |seq| ProcessEvent::Output { seq, stream: OutputStream::Stdout, bytes: b"done-out\n".to_vec() });
        send(tx, seq, |seq| ProcessEvent::Exited { seq, exit: ProcessExit { status: ExitStatus::Code(0), killed: None } });
    }
    let owner = ThreadId::from("t");
    rig.runtime.get(&owner, "task-a").unwrap().settled().await;
    let c = ctx(&rig, "x");
    for name in ["task-read-completed", "task-wait-completed"] {
        let golden = fixture("task", name);
        let mut input = golden["input"].clone();
        input["task_id"] = "task-a".into();
        assert_eq!(normalize(&body(rig.task.call(&c, input).await)), golden["text"].as_str().unwrap(), "{name}");
    }
    rig.processes.quiet.store(true, std::sync::atomic::Ordering::SeqCst);
    rig.shell.call(&ctx(&rig, "b"), serde_json::json!({"command": "echo tick; Start-Sleep 30", "background": true})).await.unwrap();
    {
        let mut senders = rig.processes.senders.lock().unwrap();
        let (tx, seq) = senders.values_mut().find(|(tx, _)| !tx.is_closed()).unwrap();
        send(tx, seq, |seq| ProcessEvent::Output { seq, stream: OutputStream::Stdout, bytes: b"tick\n".to_vec() });
    }
    let golden = fixture("task", "task-wait-running-expiry");
    let mut input = golden["input"].clone();
    input["task_id"] = "task-b".into();
    assert_eq!(normalize(&body(rig.task.call(&c, input).await)), golden["text"].as_str().unwrap());
    let golden = fixture("task", "task-list-after");
    assert_eq!(normalize(&body(rig.task.call(&c, golden["input"].clone()).await)), golden["text"].as_str().unwrap());
}

/// Every finished shell call — failed or refused included — tells the turn review the folder it
/// ran in (Node `noteCommandToolSettled(effectiveToolCwd(...))` → `noteTurnWorktreeChange([cwd])`),
/// and the end of a background task does too (`completeBackgroundTask`).
#[tokio::test]
async fn a_settled_shell_command_notes_its_folder_for_the_turn_review() {
    let rig = rig();
    let session = rig.dir.path().to_string_lossy().into_owned();
    let notes = || rig.review.notes.lock().unwrap().clone();
    rig.shell.call(&ctx(&rig, "n1"), serde_json::json!({"command": "echo hi"})).await.unwrap();
    // A folder that does not exist fails the call, and the folder is still noted, resolved.
    rig.shell.call(&ctx(&rig, "n2"), serde_json::json!({"command": "echo hi", "cwd": "sub/../gone"})).await.unwrap_err();
    // So does a refused command and an invalid call.
    rig.shell.call(&ctx(&rig, "n3"), serde_json::json!({"command": "shutdown now"})).await.unwrap_err();
    rig.shell.call(&ctx(&rig, "n4"), serde_json::json!({"nope": 1})).await.unwrap_err();
    let gone = rig.dir.path().join("gone").to_string_lossy().into_owned();
    assert_eq!(
        notes(),
        vec![Some(vec![session.clone()]), Some(vec![gone]), Some(vec![session.clone()]), Some(vec![session.clone()])]
    );

    rig.shell.call(&ctx(&rig, "a"), serde_json::json!({"command": "echo done-out", "background": true})).await.unwrap();
    assert_eq!(notes().len(), 5);
    {
        let mut senders = rig.processes.senders.lock().unwrap();
        let (tx, seq) = senders.values_mut().find(|(tx, _)| !tx.is_closed()).unwrap();
        send(tx, seq, |seq| ProcessEvent::Exited { seq, exit: ProcessExit { status: ExitStatus::Code(0), killed: None } });
    }
    rig.runtime.get(&ThreadId::from("t"), "task-a").unwrap().settled().await;
    assert_eq!(notes().len(), 6);
    assert_eq!(notes()[5], Some(vec![session]));
}

/// A call dropped mid-run (cancelled) still notes its folder, as Node's `finally` does.
#[tokio::test]
async fn a_cancelled_shell_call_still_notes_its_folder() {
    let rig = rig();
    let context = ctx(&rig, "x1");
    let call = rig.shell.call(&context, fixture("shell", "shell-cancelled-foreground")["input"].clone());
    let running = async {
        while rig.processes.senders.lock().unwrap().is_empty() {
            tokio::task::yield_now().await;
        }
    };
    // The command is running when the future is dropped.
    tokio::select! {
        _ = call => panic!("the call finished"),
        () = running => {}
    }
    assert_eq!(rig.review.notes.lock().unwrap().len(), 1);
    assert_eq!(*rig.review.notes.lock().unwrap(), vec![Some(vec![rig.dir.path().to_string_lossy().into_owned()])]);
}

/// A promoted command that hits its run limit says how much of the limit was left at promotion
/// (Node: `error: timed out after 985 ms`, counted from the process start).
#[tokio::test]
async fn a_promoted_command_that_hits_its_limit_reports_the_remainder() {
    let mut rig = rig();
    let begun = std::time::Instant::now();
    let mut config = rig.runtime.config.clone_for_test();
    config.now_ms = Arc::new(move || golden_ms() + begun.elapsed().as_millis() as u64);
    rig.runtime = ExecRuntime::new(config);
    rig.shell = ShellTool::new(rig.runtime.clone());
    rig.task = TaskTool::new(rig.runtime.clone());
    rig.shell
        .call(&ctx(&rig, "l1"), serde_json::json!({"command": "run-limited", "timeout_ms": 4000, "wait_ms": 1000}))
        .await
        .unwrap();
    let c = ctx(&rig, "l2");
    rig.task.call(&c, serde_json::json!({"action": "cancel", "task_id": "task-l1"})).await.unwrap();
    let read = body(rig.task.call(&c, serde_json::json!({"action": "read", "task_id": "task-l1"})).await);
    assert!(read.contains("status: failed\nexit_code: 124\ntimed_out: true\n"), "{read}");
    let left = regex::Regex::new(r"error: timed out after (\d+) ms").unwrap().captures(&read).unwrap()[1].parse::<u64>().unwrap();
    assert!((2900..=3000).contains(&left), "{left}: {read}");
}

/// A running task quiet past the threshold says so on read, in the digest and in the list; any
/// output resets the clock. Derived from the last output on read — no timer.
#[tokio::test]
async fn a_quiet_running_task_carries_the_silence_warning() {
    let rig = rig();
    let now = Arc::new(std::sync::atomic::AtomicU64::new(golden_ms()));
    let mut config = rig.runtime.config.clone_for_test();
    let clock = now.clone();
    config.now_ms = Arc::new(move || clock.load(std::sync::atomic::Ordering::SeqCst));
    let runtime = ExecRuntime::new(config);
    let (shell, task) = (ShellTool::new(runtime.clone()), TaskTool::new(runtime));
    shell.call(&ctx(&rig, "q1"), serde_json::json!({"command": "sleep 100", "background": true})).await.unwrap();
    let c = ctx(&rig, "q2");
    let fresh = body(task.call(&c, serde_json::json!({"action": "read", "task_id": "task-q1"})).await);
    assert!(!fresh.contains("output_silence"), "{fresh}");
    now.store(golden_ms() + 601_000, std::sync::atomic::Ordering::SeqCst);
    let read = body(task.call(&c, serde_json::json!({"action": "read", "task_id": "task-q1"})).await);
    assert!(read.contains("\noutput_silence: no output for 10m — may be hung; inspect or cancel\nlogs: "), "{read}");
    let listed = body(task.call(&c, serde_json::json!({"action": "list"})).await);
    assert!(listed.ends_with("[output silence]\n- task-q1 no output for 10m — may be hung; inspect or cancel"), "{listed}");
}

#[tokio::test]
async fn non_zero_exit_keeps_output_and_code() {
    let rig = rig();
    let text = body(rig.shell.call(&ctx(&rig, "c1"), serde_json::json!({"command": "fail"})).await);
    assert_eq!(text, "[exit code: 3]\n\nboom\n");
}

#[tokio::test]
async fn time_limit_is_a_deadline_error_with_node_status_text() {
    let rig = rig();
    let err = rig
        .shell
        .call(&ctx(&rig, "c1"), serde_json::json!({"command": "timeout", "timeout_ms": 5}))
        .await
        .unwrap_err();
    assert!(matches!(err.code, ToolErrorCode::DeadlineExceeded { partial: true }));
    assert_eq!(
        err.message_for_model,
        "Error: [shell-run-failed] [timeout: 5ms signal: SIGKILL cause: timeout] — command killed; partial effects may remain\n\n(no output)"
    );
}

#[tokio::test]
async fn wmic_is_rewritten_for_powershell_with_a_hard_30s_cap_and_refused_without_get() {
    let rig = rig();
    let mut config = rig.runtime.config.clone_for_test();
    config.powershell = true;
    let runtime = ExecRuntime::new(config);
    let (shell, task) = (ShellTool::new(runtime.clone()), TaskTool::new(runtime));
    let err = shell
        .call(&ctx(&rig, "w1"), serde_json::json!({"command": "wmic process"}))
        .await
        .unwrap_err();
    assert_eq!(
        err.message_for_model,
        "Error: [shell-tool-failed] wmic process commands are disabled because WMIC can stall for minutes; use PowerShell Get-CimInstance/Get-Process instead."
    );
    shell
        .call(&ctx(&rig, "w2"), serde_json::json!({"command": "wmic process get name", "background": true}))
        .await
        .unwrap();
    let listed = body(task.call(&ctx(&rig, "w3"), serde_json::json!({"action": "list"})).await);
    assert!(listed.contains("shell/shell running label=powershell.exe -NoProfile -EncodedCommand "), "{listed}");
}

struct FakeSurvivors {
    gone: tokio::sync::Notify,
    kill_works: std::sync::atomic::AtomicBool,
    kills: std::sync::atomic::AtomicUsize,
    /// A kill that has signalled holds here (when set) until the test lets it report its outcome.
    after_kill: Option<Arc<tokio::sync::Notify>>,
}

impl FakeSurvivors {
    fn new(kill_works: bool) -> Arc<Self> {
        Arc::new(Self { gone: tokio::sync::Notify::new(), kill_works: kill_works.into(), kills: 0.into(), after_kill: None })
    }

    fn holding(kill_works: bool, after_kill: Arc<tokio::sync::Notify>) -> Arc<Self> {
        Arc::new(Self { gone: tokio::sync::Notify::new(), kill_works: kill_works.into(), kills: 0.into(), after_kill: Some(after_kill) })
    }
}

#[async_trait]
impl SurvivorWatch for FakeSurvivors {
    fn survivors(&self, _: &ProcessHandle) -> Option<Survivors> {
        Some(Survivors { reachable: true })
    }
    async fn wait_gone(&self, _: &ProcessHandle, _: &CancellationToken) -> bool {
        self.gone.notified().await;
        true
    }
    async fn kill(&self, _: &ProcessHandle) -> bool {
        use std::sync::atomic::Ordering::SeqCst;
        self.kills.fetch_add(1, SeqCst);
        let works = self.kill_works.load(SeqCst);
        if works {
            self.gone.notify_one();
        }
        if let Some(hold) = &self.after_kill {
            hold.notified().await;
        }
        works
    }
}
/// A command that finished but left processes running hands them over as a tracked task.
#[tokio::test]
async fn surviving_descendants_become_a_tracked_task_that_cancels_and_completes() {
    let rig = rig();
    let watch = FakeSurvivors::new(true);
    let mut config = rig.runtime.config.clone_for_test();
    config.survivors = Some(watch.clone());
    let runtime = ExecRuntime::new(config);
    let (shell, task) = (ShellTool::new(runtime.clone()), TaskTool::new(runtime));
    let text = body(shell.call(&ctx(&rig, "s1"), serde_json::json!({"command": "echo hi"})).await);
    assert_eq!(
        text,
        "[exit code: 0]\n⚠️ the command finished but left descendants running: they are tracked as the task below, and `task cancel` terminates them.\nbackground task\ntask_id: task-s1\nlabel: echo hi\nstatus: running\nstarted: 2026-01-02T03:04:05.678Z\n\nhi\n"
    );
    let c = ctx(&rig, "s2");
    let listed = body(task.call(&c, serde_json::json!({"action": "list"})).await);
    assert_eq!(listed, "background tasks: 1\n- task-s1 shell/shell running label=echo hi");
    let cancelled = body(task.call(&c, serde_json::json!({"action": "cancel", "task_id": "task-s1"})).await);
    assert_eq!(cancelled, "status: completed\ntask_id: task-s1\ncancelled: shell/shell");
    let read = body(task.call(&c, serde_json::json!({"action": "read", "task_id": "task-s1"})).await);
    assert!(read.contains("status: cancelled") && read.ends_with("error: cancelled by task control"), "{read}");
}

#[tokio::test]
async fn survivors_that_resist_the_kill_keep_the_task_pending() {
    let rig = rig();
    let watch = FakeSurvivors::new(false);
    let mut config = rig.runtime.config.clone_for_test();
    config.survivors = Some(watch);
    let runtime = ExecRuntime::new(config);
    let (shell, task) = (ShellTool::new(runtime.clone()), TaskTool::new(runtime));
    shell.call(&ctx(&rig, "s1"), serde_json::json!({"command": "echo hi"})).await.unwrap();
    let out = body(task.call(&ctx(&rig, "s2"), serde_json::json!({"action": "cancel", "task_id": "task-s1"})).await);
    assert_eq!(out, "status: cancel-pending\ntask_id: task-s1\nthe kill was sent and the command itself exited, but processes it started are still alive. They keep being terminated and stay tracked (the folder stays held) until they are gone; re-run task cancel or task read to check again.");
}

/// What Node's agent reads of a survivors task (`fixtures/shell-survivors/golden.json`, recorded from Node b6f10295a by
/// `record-shell-survivors.mjs`): the recording's task id and timestamps are placeholders.
fn survivors_golden() -> JsonValue {
    serde_json::from_str(include_str!("../../../../fixtures/shell-survivors/golden.json")).unwrap()
}

fn node_view(text: &str, id: &str) -> String {
    text.replace(id, "<TASK>")
        .lines()
        .map(|line| match line.split_once(": ") {
            Some((key @ ("started" | "finished"), _)) => format!("{key}: <TIME>"),
            _ => line.to_owned(),
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// A runtime over `watch` and the survivors task `task-s1` an `echo hi` left behind.
async fn survivors_rig(rig: &Rig, watch: Arc<FakeSurvivors>) -> (ShellTool, TaskTool, Arc<ExecRuntime>, Arc<Job>) {
    let mut config = rig.runtime.config.clone_for_test();
    config.survivors = Some(watch);
    let runtime = ExecRuntime::new(config);
    let (shell, task) = (ShellTool::new(runtime.clone()), TaskTool::new(runtime.clone()));
    shell.call(&ctx(rig, "s1"), serde_json::json!({"command": "echo hi"})).await.unwrap();
    let tracked = runtime.get(&ThreadId::from("t"), "task-s1").unwrap();
    (shell, task, runtime, tracked)
}

async fn view(task: &TaskTool, rig: &Rig, call: &str, args: JsonValue) -> String {
    node_view(&body(task.call(&ctx(rig, call), args).await), "task-s1")
}

/// A survivors task that ends on its own reads as Node's does at every step: running without a body, completed with the
/// result's `(no new output)` (`(no output)` for an explicit tail), and nothing left to cancel afterwards.
#[tokio::test]
async fn a_survivors_task_that_ends_on_its_own_reads_as_nodes_does() {
    let rig = rig();
    let want = survivors_golden();
    let watch = FakeSurvivors::new(true);
    let (_, task, _, tracked) = survivors_rig(&rig, watch.clone()).await;
    let read = |call: &'static str| view(&task, &rig, call, serde_json::json!({"action": "read", "task_id": "task-s1"}));
    assert_eq!(read("r1").await, want["natural"]["readRunning"].as_str().unwrap());
    watch.gone.notify_one();
    tracked.settled().await;
    assert_eq!(view(&task, &rig, "w", serde_json::json!({"action": "wait", "task_id": "task-s1", "timeout_ms": 1000})).await, want["natural"]["wait"].as_str().unwrap());
    assert_eq!(read("r2").await, want["natural"]["read"].as_str().unwrap());
    assert_eq!(view(&task, &rig, "t", serde_json::json!({"action": "read", "task_id": "task-s1", "output": "tail"})).await, want["natural"]["tail"].as_str().unwrap());
    assert_eq!(view(&task, &rig, "c", serde_json::json!({"action": "cancel", "task_id": "task-s1"})).await, want["natural"]["cancelAfterEnd"].as_str().unwrap());
}

/// A cancel ends the task as cancelled with no body, a second cancel finds no task, and the observer's own exit event
/// arriving while the kill is still reporting cannot make it completed (the cancel is latched before anything is signalled).
#[tokio::test]
async fn a_cancelled_survivors_task_stays_cancelled_whichever_exit_event_comes_first() {
    let rig = rig();
    let want = survivors_golden();
    let hold = Arc::new(tokio::sync::Notify::new());
    let watch = FakeSurvivors::holding(true, hold.clone());
    let (_, task, _, tracked) = survivors_rig(&rig, watch).await;
    let cancel = view(&task, &rig, "c1", serde_json::json!({"action": "cancel", "task_id": "task-s1"}));
    // The kill has signalled; the observer sees the survivors go and finishes before the kill reports.
    let observer_first = async {
        tracked.settled().await;
        hold.notify_one();
    };
    let (cancelled, ()) = tokio::join!(cancel, observer_first);
    assert_eq!(cancelled, want["cancelled"]["cancel"].as_str().unwrap());
    let got = |call: &'static str, extra: JsonValue| {
        let mut args = serde_json::json!({"action": "read", "task_id": "task-s1"});
        args.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        view(&task, &rig, call, args)
    };
    assert_eq!(got("r1", serde_json::json!({})).await, want["cancelled"]["read"].as_str().unwrap());
    assert_eq!(got("r2", serde_json::json!({"output": "tail"})).await, want["cancelled"]["tail"].as_str().unwrap());
    assert_eq!(view(&task, &rig, "c2", serde_json::json!({"action": "cancel", "task_id": "task-s1"})).await, want["cancelled"]["cancelAgain"].as_str().unwrap());
}

/// A cancel whose kill could not confirm the survivors gone holds the row and keeps terminating on every observation pass,
/// until a re-observation finds none: then the hold ends.
#[tokio::test]
async fn an_unconfirmed_cancel_keeps_terminating_on_every_pass_until_the_survivors_are_gone() {
    let rig = rig();
    let watch = FakeSurvivors::new(false);
    let (_, task, runtime, tracked) = survivors_rig(&rig, watch.clone()).await;
    let pending = body(task.call(&ctx(&rig, "c1"), serde_json::json!({"action": "cancel", "task_id": "task-s1"})).await);
    assert!(pending.starts_with("status: cancel-pending\n"), "{pending}");
    let held = |runtime: &ExecRuntime| runtime.config.tasks.get("task-s1").unwrap();
    assert!(held(&runtime).termination_unconfirmed, "the row is held while the processes are not confirmed gone");
    assert_eq!(held(&runtime).status, mixdog_spawn::tasks::TaskStatus::Cancelled, "the registry state is terminal at the cancel");
    assert_eq!(watch.kills.load(std::sync::atomic::Ordering::SeqCst), 1);
    // The next pass of the observation (Node's TERMINATION_RECHECK_MS) terminates them again; this time it works.
    watch.kill_works.store(true, std::sync::atomic::Ordering::SeqCst);
    tokio::time::pause();
    tokio::time::advance(std::time::Duration::from_millis(5_000)).await;
    tracked.settled().await;
    assert_eq!(watch.kills.load(std::sync::atomic::Ordering::SeqCst), 2);
    assert!(!held(&runtime).termination_unconfirmed, "confirmed gone ends the hold");
}

/// The tracked task started with the command, not when its survivors were observed (`trackSurvivingDescendants` passes
/// the command's `startedAtMs`): a clock that moves a second per reading shows the first reading, not a later one.
#[tokio::test]
async fn a_survivors_task_starts_when_its_command_started() {
    let rig = rig();
    let mut config = rig.runtime.config.clone_for_test();
    config.survivors = Some(FakeSurvivors::new(true));
    let clock = Arc::new(std::sync::atomic::AtomicU64::new(golden_ms()));
    config.now_ms = Arc::new({
        let clock = clock.clone();
        move || clock.fetch_add(1000, std::sync::atomic::Ordering::SeqCst)
    });
    let runtime = ExecRuntime::new(config);
    let started = body(ShellTool::new(runtime).call(&ctx(&rig, "s1"), serde_json::json!({"command": "echo hi"})).await);
    assert!(started.contains("\nstarted: 2026-01-02T03:04:05.678Z\n"), "{started}");
    assert!(clock.load(std::sync::atomic::Ordering::SeqCst) > golden_ms() + 1000, "the clock moved on before the survivors were observed");
}
/// `shell` and `task`, built through their runtime constructors, are the definitions Node sends
/// (`fixtures/tool-definitions/definitions.json`, through `mixdog_js::fixture_tools`): the shell text of the
/// runtime's shell kind, with and without background tasks, and the task tool for the Lead and for a delegated agent.
#[test]
fn the_shell_and_task_tools_are_nodes_definitions() {
    let node = |key: &str| mixdog_js::fixture_tools::definition(key).expect("a recorded Node definition");
    let same = |got: &ToolSpec, node: &serde_json::Value, what: &str| {
        assert_eq!(&got.definition(), node, "{what}");
        assert_eq!(got.annotations.to_json().to_string(), node["annotations"].to_string(), "{what} annotations");
    };
    let rig = rig();
    for powershell in [false, true] {
        for background in [true, false] {
            let mut config = rig.runtime.config.clone_for_test();
            config.windows = powershell;
            let shell = ShellTool::with_background(ExecRuntime::new(config), background);
            let kind = if powershell { "powershell" } else { "posix" };
            let recorded = node(&format!("shell@{kind}{}", if background { "" } else { "-foreground" }));
            same(shell.spec(), &recorded, &format!("shell {kind} background {background}"));
        }
    }
    same(rig.task.spec(), &node("task"), "task");
    same(rig.task.agent_spec().expect("task has an agent text"), &node("task@agent"), "agent task");
}

/// Node binds the shell text from the kind of the shell it resolves; in every recorded combination of
/// platform, "system shell" setting and `MIXDOG_SHELL` that kind is the platform's, so the text a
/// session is sent is the platform's whatever the setting says (and a changed setting changes no text).
#[test]
fn the_shell_text_follows_the_platform_for_every_recorded_setting() {
    let golden: serde_json::Value = serde_json::from_str(include_str!("testdata/shell_choice.json")).expect("the recording is JSON");
    let text_of = |kind: &str| mixdog_js::fixture_tools::definition(&format!("shell@{kind}")).expect("a shell");
    for case in golden["cases"].as_array().expect("cases") {
        let kind = case["shellType"].as_str().expect("kind");
        let windows = case["platform"] == "win32";
        let spec = super::shell::shell_spec(super::shell::ShellKind::of(windows), true);
        assert_eq!(spec.definition(), text_of(kind), "{case}");
    }
}

/// Legacy programs write in the OEM code page; on a CP949 host the bytes are decoded, not garbled.
#[tokio::test]
async fn cp949_output_is_decoded_with_the_oem_page() {
    let rig = rig();
    let mut config = rig.runtime.config.clone_for_test();
    config.oem = Some("euc-kr");
    let shell = ShellTool::new(ExecRuntime::new(config));
    let text = body(shell.call(&ctx(&rig, "k1"), serde_json::json!({"command": "korean"})).await);
    assert_eq!(text, "[exit code: 0]\n\n한글 출력\n");
    // The default host decodes UTF-8 (the invalid bytes become U+FFFD).
    let text = body(rig.shell.call(&ctx(&rig, "k2"), serde_json::json!({"command": "korean"})).await);
    assert!(text.contains('\u{FFFD}'), "{text}");
}

#[tokio::test]
async fn a_search_that_found_nothing_is_marked_no_match() {
    let rig = rig();
    let text = body(rig.shell.call(&ctx(&rig, "c1"), serde_json::json!({"command": "grep x f"})).await);
    // `grep x f` is a shell file read: the guard adds its pointer to the read / grep / list tools.
    assert_eq!(
        text,
        "[exit code: 1]\n[outcome: no-match]\nNote: use the read / grep / list tools for files instead of the shell.\n\n(no output)"
    );
}

#[tokio::test]
async fn repeated_output_is_compacted_and_the_full_capture_is_archived() {
    let rig = rig();
    let text = body(rig.shell.call(&ctx(&rig, "c1"), serde_json::json!({"command": "repeat"})).await);
    assert!(text.starts_with("[exit code: 0]\n\ntick\n... [previous line repeated 199 more times]\n\n\n[lossless compact: consecutive-duplicates; full captured output preserved]\n[full stdout: "), "{text}");
    assert!(text.ends_with(" (1000 bytes) — use read to recover]"), "{text}");
    let archived = std::fs::read_dir(rig.dir.path().join("data/tool-results/t")).unwrap().next().unwrap().unwrap();
    assert_eq!(std::fs::read_to_string(archived.path()).unwrap(), "tick\n".repeat(200));
}

#[tokio::test]
async fn a_destructive_command_gets_its_warning_after_the_status_line() {
    let rig = rig();
    let text = body(
        rig.shell
            .call(&ctx(&rig, "c1"), serde_json::json!({"command": "echo hi; git reset --hard"}))
            .await,
    );
    assert_eq!(text, "[exit code: 0]\n⚠️ may discard uncommitted changes\n\nhi; git reset --hard\n");
}

#[tokio::test]
async fn the_exec_policy_refuses_before_anything_is_spawned() {
    let rig = rig();
    let err = rig
        .shell
        .call(&ctx(&rig, "c1"), serde_json::json!({"command": "shutdown now"}))
        .await
        .unwrap_err();
    assert_eq!(
        err.message_for_model,
        "Error: [shell-tool-failed] command blocked by exec policy — destructive or system-destabilising pattern (hard block) [rule hard-block]"
    );
    assert!(rig.processes.senders.lock().unwrap().is_empty());
}

#[tokio::test]
async fn held_command_moves_to_background_and_task_cancels_it() {
    let rig = rig();
    let text = body(
        rig.shell
            .call(&ctx(&rig, "c1"), serde_json::json!({"command": "sleep 100", "background": true}))
            .await,
    );
    assert!(text.contains("\nstarted in the background; still running. Its result is delivered automatically when it finishes; use task wait only if you need it now.\n\n[progress] no new output since you last saw it — still running, not an error\n\n(no new output)"), "{text}");
    let c = ctx(&rig, "c2");
    let cancelled = body(rig.task.call(&c, serde_json::json!({"action": "cancel", "task_id": "task-c1"})).await);
    assert_eq!(cancelled, "status: completed\ntask_id: task-c1\ncancelled: shell/shell");
    let read = body(rig.task.call(&c, serde_json::json!({"action": "read", "task_id": "task-c1"})).await);
    assert!(read.contains("status: cancelled\nexit_code: 137\n"), "{read}");
    assert!(read.ends_with("\n\n(no new output)"), "{read}");
}

struct FixedCycle(u64);
impl OwnerCycles for FixedCycle {
    fn current(&self, _: &ThreadId) -> u64 {
        self.0
    }
}

/// `hasActiveBackgroundTasks({ surface: 'shell', awaitedOnly, match })` of `background-wait.mjs`:
/// a command moved to the background is work its owner waits on, in the user cycle it started in;
/// another owner's, and an ended one, are not.
#[tokio::test]
async fn a_background_command_is_work_its_owner_waits_on_in_the_cycle_it_started() {
    let rig = rig();
    rig.runtime.set_cycles(Arc::new(FixedCycle(3)));
    let owner = ThreadId::from("t");
    assert!(!rig.runtime.has_active(&owner, false, None), "nothing is running yet");
    rig.shell.call(&ctx(&rig, "c1"), serde_json::json!({"command": "sleep 100", "background": true})).await.unwrap();
    assert!(rig.runtime.has_active(&owner, true, Some(3)));
    assert!(rig.runtime.has_active(&owner, false, None));
    assert!(!rig.runtime.has_active(&owner, true, Some(4)), "it started in an earlier cycle than 4");
    assert!(!rig.runtime.has_active(&ThreadId::from("other"), false, None));
    rig.task.call(&ctx(&rig, "c2"), serde_json::json!({"action": "cancel", "task_id": "task-c1"})).await.unwrap();
    assert!(!rig.runtime.has_active(&owner, false, None), "an ended task is not work");
}

/// The owner's default delivery: what reached `TaskNotifier::finished`.
#[derive(Default)]
struct OwnerNotices(std::sync::Mutex<Vec<(String, String)>>);

#[async_trait]
impl TaskNotifier for OwnerNotices {
    async fn finished(&self, owner: &ThreadId, surface: &str, task_id: &str, status: &str, _: String) {
        self.0.lock().unwrap().push((owner.as_str().to_owned(), format!("{surface}/{task_id}/{status}")));
    }
}

/// Starts a background command with `notify` in its call options and cancels it through `task`,
/// the end the detached job reports.
async fn background_end(notify: Option<ToolNotify>, owner: &Arc<OwnerNotices>) {
    let rig = rig_full(Arc::new(OsPromptElevation), Some(owner.clone()));
    let mut start = ctx(&rig, "c1");
    start.options.notify = notify;
    rig.shell.call(&start, serde_json::json!({"command": "sleep 100", "background": true})).await.unwrap();
    rig.task.call(&ctx(&rig, "c2"), serde_json::json!({"action": "cancel", "task_id": "task-c1"})).await.unwrap();
    for _ in 0..200 {
        if rig.runtime.get(&ThreadId::from("t"), "task-c1").is_some_and(|j| j.status() != JobStatus::Running) {
            break;
        }
        tokio::task::yield_now().await;
    }
    mixdog_rt::time::sleep(std::time::Duration::from_millis(50)).await;
}

/// Node `notifyToolCompletion`: the launching call's `notifyFn` takes the completion first, with
/// the meta that files it; the owner's default delivery is not used when it accepts.
#[tokio::test(start_paused = true)]
async fn a_background_end_goes_to_the_calls_notify_hook_first() {
    let owner = Arc::new(OwnerNotices::default());
    let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
    let hook = {
        let seen = seen.clone();
        ToolNotify(Arc::new(move |text: &str, meta: &JsonValue| {
            seen.lock().unwrap().push((text.to_owned(), meta.clone()));
            true
        }))
    };
    background_end(Some(hook), &owner).await;
    let seen = seen.lock().unwrap();
    assert_eq!(seen.len(), 1);
    assert!(seen[0].0.contains("task-c1"), "{}", seen[0].0);
    assert_eq!(seen[0].1["execution_surface"], "shell");
    assert_eq!(seen[0].1["execution_id"], "task-c1");
    assert_eq!(seen[0].1["status"], "cancelled");
    assert_eq!(seen[0].1["type"], "shell_task_result");
    assert!(owner.0.lock().unwrap().is_empty());
    // The whole meta is the one Node handed its hook for a cancelled job.
    let golden = completion_meta_golden();
    let cancelled = golden["cases"].as_array().unwrap().iter().find(|c| c["name"] == "cancelled").unwrap();
    assert_eq!(seen[0].1, cancelled["received"]["meta"]);
}

fn completion_meta_golden() -> JsonValue {
    serde_json::from_str(include_str!("testdata/shell_completion_meta.json")).unwrap()
}

/// `shellCompletionInstruction` for every end Node recorded (completed, a non-zero exit that stays
/// completed, cancelled, timed out, a signal death, no exit status).
#[test]
fn the_completion_instruction_is_nodes_for_each_kind_of_end() {
    let golden = completion_meta_golden();
    for case in golden["cases"].as_array().unwrap() {
        let meta = &case["received"]["meta"];
        let code = case["detail"]["exitCode"].as_i64().map(|c| c as i32);
        // A signal death leaves no exit code in the job's facts, whatever the detail says.
        let code = if case["detail"]["signal"].is_null() { code } else { None };
        assert_eq!(super::jobs::completion_instruction(meta["status"].as_str().unwrap(), code), meta["instruction"], "{}", case["name"]);
    }
}

/// A hook that declines (`false`) falls through to the owner, as Node's `enqueueFallback` does; a
/// call without a hook goes straight to the owner.
#[tokio::test(start_paused = true)]
async fn a_declined_or_missing_hook_falls_back_to_the_owner() {
    let owner = Arc::new(OwnerNotices::default());
    let declined = ToolNotify(Arc::new(|_: &str, _: &JsonValue| false));
    background_end(Some(declined), &owner).await;
    background_end(None, &owner).await;
    assert_eq!(*owner.0.lock().unwrap(), vec![("t".to_owned(), "shell/task-c1/cancelled".to_owned()); 2]);
}

#[tokio::test]
async fn a_wait_ends_the_moment_the_session_reports_user_input() {
    let rig = rig();
    rig.shell
        .call(&ctx(&rig, "c1"), serde_json::json!({"command": "sleep 100", "background": true}))
        .await
        .unwrap();
    let c = ctx(&rig, "c2");
    let hub = rig.runtime.config.wake.clone();
    let waiter = rig.task.call(&c, serde_json::json!({"action": "wait", "task_id": "task-c1", "timeout_ms": 3_600_000}));
    let wake = async {
        while hub.active_waits(&ThreadId::from("t")) == 0 {
            tokio::task::yield_now().await;
        }
        hub.interrupt(&ThreadId::from("t"), WakeReason::UserMessage, None);
    };
    let (waited, ()) = tokio::join!(waiter, wake);
    assert!(body(waited).ends_with(
        "\n\nWait ended by new user input; task still running in the background. Handle the new message first."
    ));
}

fn elevation_commands() -> Vec<(String, String)> {
    let vectors: Vec<JsonValue> = serde_json::from_str(include_str!(
        "../policy/testdata/exec_node_vectors.json"
    ))
    .unwrap();
    vectors
        .iter()
        .filter(|v| v["decision"] == "ask")
        .map(|v| (v["command"].as_str().unwrap().to_owned(), v["message"].as_str().unwrap().to_owned()))
        .collect()
}

/// Every elevation spelling Node classifies as `ask` is refused with Node's exact text when the
/// runtime does not approve the call, and runs when it does (Node's default: the OS prompt).
#[tokio::test]
async fn an_unapproved_elevation_is_refused_with_nodes_text_and_never_spawned() {
    let commands = elevation_commands();
    assert_eq!(commands.len(), 31);
    let rig = rig_with(Arc::new(RefuseElevation));
    // A leading `cd x && …` is moved into `cwd` by the guard and then needs `x` to exist; it is
    // covered by the policy vectors.
    let commands: Vec<_> = commands.into_iter().filter(|(c, _)| !c.starts_with("cd ")).collect();
    for (i, (command, message)) in commands.iter().enumerate() {
        let err = rig
            .shell
            .call(&ctx(&rig, &format!("e{i}")), serde_json::json!({"command": command, "background": true}))
            .await
            .unwrap_err();
        assert_eq!(err.message_for_model, message.replacen("Error: ", "Error: [shell-tool-failed] ", 1), "{command:?}");
    }
    assert!(rig.processes.senders.lock().unwrap().is_empty());

    let rig = rig_with(Arc::new(OsPromptElevation));
    for (i, (command, _)) in commands.iter().enumerate() {
        let out = body(
            rig.shell
                .call(&ctx(&rig, &format!("e{i}")), serde_json::json!({"command": command, "background": true}))
                .await,
        );
        assert!(!out.contains("requires user approval"), "{command:?}: {out}");
        assert!(out.contains("still running") || out.starts_with("[exit code: 0]"), "{command:?}: {out}");
    }
}

#[tokio::test]
async fn cwd_must_be_an_existing_directory() {
    let rig = rig();
    let err = rig
        .shell
        .call(&ctx(&rig, "c1"), serde_json::json!({"command": "echo x", "cwd": "missing-dir"}))
        .await
        .unwrap_err();
    assert!(matches!(err.code, ToolErrorCode::NotFound { .. }));
    assert!(err.message_for_model.starts_with("Error: [shell-tool-failed] shell cwd \""));
    assert!(err.message_for_model.ends_with("missing-dir\" does not exist"));
}


// ---- invocation plan ----

fn skill_runtime() -> SkillRuntime {
    SkillRuntime {
        platform: "win32".into(),
        interpreter: "C:\\Mixdog\\Mixdog.exe".into(),
        entry: "C:\\Mixdog\\entry.mjs".into(),
        electron: true,
    }
}

/// A rig on a Windows PowerShell host: the run goes with the UTF-8 console preamble and the
/// `mixdog-skill-node` function, and the skill launchers are written for the installation.
fn windows_powershell_rig() -> (Rig, ShellTool) {
    let rig = rig();
    let mut config = rig.runtime.config.clone_for_test();
    config.windows = true;
    config.powershell = true;
    config.shell = Arc::new(FixedShell("powershell.exe".into()));
    config.skill_runtime = Some(skill_runtime());
    let shell = ShellTool::new(ExecRuntime::new(config));
    (rig, shell)
}

/// A script whose write to PowerShell's input fails is never run in part: its input is left open (the bootstrap reads
/// to the end before it compiles, so it runs nothing), the tree is ended, and the call fails.
#[tokio::test]
async fn a_script_that_could_not_be_written_whole_is_ended_unrun_and_the_call_fails() {
    let (rig, shell) = windows_powershell_rig();
    rig.processes.refuse_write.store(true, std::sync::atomic::Ordering::SeqCst);
    let error = shell.call(&ctx(&rig, "w1"), serde_json::json!({"command": "echo hi"})).await.unwrap_err();
    assert_eq!(
        error.message_for_model,
        "Error: [shell-tool-failed] [stdin write failed]\n\nthe command could not be passed whole to the shell, so it was not run"
    );
    let handle = ProcessHandle::from("task-w1");
    assert!(rig.processes.closed.lock().unwrap().is_empty(), "the input of a part-written script is never closed");
    assert_eq!(*rig.processes.killed.lock().unwrap(), [handle]);
}

/// The bootstrap runs a script only when all of it arrived: an input that ends after half of the script (a pipe that broke
/// part way) runs nothing of it, not even the statement the half carries whole, and exits 1; the whole script runs.
#[cfg(windows)]
#[test]
fn the_bootstrap_runs_nothing_of_a_script_that_arrived_in_part() {
    use std::io::Write;
    use std::process::Stdio;
    let dir = tempfile::tempdir().unwrap();
    let marker = dir.path().join("first-half-ran");
    let script = format!("New-Item -ItemType File -Path '{}' | Out-Null\n# {}\nWrite-Output whole", marker.display(), "x".repeat(400));
    let framed = super::invocation::frame_powershell_script(&script);
    let run = |input: &str| {
        let mut child = std::process::Command::new("powershell.exe")
            .args(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", super::invocation::POWERSHELL_BOOTSTRAP])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(input.as_bytes()).unwrap();
        child.wait_with_output().unwrap()
    };
    let half = &framed[..framed.len() / 2];
    assert!(half.contains("Out-Null\n# x"), "the half carries the first statement whole");
    let cut = run(half);
    assert!(!marker.exists(), "the first half of a script that arrived in part ran");
    assert_eq!(cut.status.code(), Some(1));
    assert_eq!(String::from_utf8_lossy(&cut.stderr).trim(), "the command arrived incomplete and was not run");
    assert_eq!(String::from_utf8_lossy(&cut.stdout), "");
    let whole = run(&framed);
    assert!(marker.exists(), "the whole script ran");
    assert_eq!((whole.status.code(), String::from_utf8_lossy(&whole.stdout).trim()), (Some(0), "whole"));
}

#[tokio::test]
async fn a_powershell_command_gets_the_utf8_preamble_and_the_skill_function() {
    let (rig, shell) = windows_powershell_rig();
    shell.call(&ctx(&rig, "p1"), serde_json::json!({"command": "echo hi", "background": true})).await.unwrap();
    let (spec, _) = rig.processes.seen.lock().unwrap()[0].clone();
    let CommandSpec::Shell { script, shell: Some(program) } = spec else { panic!("{spec:?}") };
    assert_eq!(program, "powershell.exe");
    assert_eq!(script, super::invocation::POWERSHELL_BOOTSTRAP);
    assert_eq!(
        rig.processes.fed.lock().unwrap()[0],
        super::invocation::frame_powershell_script(&format!(
            "{}\n{}\necho hi",
            super::invocation::POWERSHELL_UTF8_PREFIX,
            super::invocation::render_powershell_skill_function(&skill_runtime())
        ))
    );
    // The launcher files exist for this installation and their directory leads PATH.
    let launchers = rig.dir.path().join("data/skill-launchers");
    let installed = std::fs::read_dir(&launchers).unwrap().next().unwrap().unwrap().path();
    assert!(installed.join("mixdog-skill-node.cmd").is_file());
    let (_, env) = rig.processes.seen.lock().unwrap()[0].clone();
    let path = env.set.iter().find(|(k, _)| k == "PATH" || k.eq_ignore_ascii_case("path")).unwrap();
    let name = installed.file_name().unwrap().to_string_lossy().into_owned();
    assert!(path.1.starts_with(&format!("{}skill-launchers\\{name};", &path.1[..path.1.find("skill-launchers").unwrap()])), "{}", path.1);
}

/// A shell source like the daemon's: the default is probed when first needed, kept, and dropped by
/// a setting change (`setConfiguredShell`). Each probe finds the next installation in `installs`.
#[derive(Default)]
struct ChangingShell {
    state: std::sync::Mutex<(String, Option<String>)>,
    probes: std::sync::atomic::AtomicUsize,
}

impl ChangingShell {
    fn set(&self, value: &str) {
        let mut state = self.state.lock().unwrap();
        if state.0 != value {
            *state = (value.to_owned(), None);
        }
    }
}

impl ShellSource for ChangingShell {
    fn configured(&self) -> String {
        self.state.lock().unwrap().0.clone()
    }
    fn kept_default(&self) -> Option<String> {
        self.state.lock().unwrap().1.clone()
    }
    fn resolve_default(&self) -> String {
        let n = self.probes.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        format!("C:\\Host\\pwsh{n}.exe")
    }
    fn keep_default(&self, configured: &str, program: String) {
        let mut state = self.state.lock().unwrap();
        if state.0 == configured {
            state.1 = Some(program);
        }
    }
}

/// The default program is probed once and kept; a setting change drops it, so the next spawn
/// probes again (Node's `setConfiguredShell` clearing `_resolvedShell`); an unchanged value keeps it.
#[tokio::test]
async fn a_setting_change_makes_the_next_spawn_resolve_the_default_again() {
    let rig = rig();
    let source = Arc::new(ChangingShell::default());
    let mut config = rig.runtime.config.clone_for_test();
    config.windows = true;
    config.powershell = true;
    config.shell = source.clone();
    let shell = ShellTool::new(ExecRuntime::new(config));
    // (setting before the spawn, program the spawn runs)
    for (n, (value, expected)) in [
        ("", "C:\\Host\\pwsh0.exe"),
        ("", "C:\\Host\\pwsh0.exe"),
        ("bash", "C:\\Host\\pwsh1.exe"),
        ("bash", "C:\\Host\\pwsh1.exe"),
        ("", "C:\\Host\\pwsh2.exe"),
    ]
    .into_iter()
    .enumerate()
    {
        source.set(value);
        shell
            .call(&ctx(&rig, &format!("r{n}")), serde_json::json!({"command": "echo hi", "background": true}))
            .await
            .unwrap();
        let (spec, _) = rig.processes.seen.lock().unwrap()[n].clone();
        let CommandSpec::Shell { shell: Some(program), .. } = spec else { panic!("{spec:?}") };
        assert_eq!(program, expected, "spawn {n}");
    }
}

/// The "system shell" setting is read on every spawn: a change reaches the next command, and a
/// POSIX shell named on Windows leaves the default PowerShell (Node's `resolveShell`; the recorded
/// choices themselves are checked in `shell_choice`).
#[tokio::test]
async fn a_changed_system_shell_setting_reaches_the_next_spawn() {
    let rig = rig();
    let setting = Arc::new(ChangingShell::default());
    let mut config = rig.runtime.config.clone_for_test();
    config.windows = true;
    config.powershell = true;
    config.shell = setting.clone();
    let shell = ShellTool::new(ExecRuntime::new(config));
    // `MIXDOG_SHELL` only matters while the setting is empty, which no step here is.
    for (n, (value, expected)) in [
        ("pwsh", "pwsh"),
        ("D:\\Tools\\PowerShell\\pwsh.exe", "D:\\Tools\\PowerShell\\pwsh.exe"),
        ("bash", "C:\\Host\\pwsh2.exe"),
        ("powershell.exe", "powershell.exe"),
    ]
    .into_iter()
    .enumerate()
    {
        setting.set(value);
        shell
            .call(&ctx(&rig, &format!("s{n}")), serde_json::json!({"command": "echo hi", "background": true}))
            .await
            .unwrap();
        let (spec, _) = rig.processes.seen.lock().unwrap()[n].clone();
        let CommandSpec::Shell { shell: Some(program), .. } = spec else { panic!("{spec:?}") };
        assert_eq!(program, expected, "setting {value:?}");
    }
}

/// The producer failed and the trailing filter matched nothing: the visible output is empty, so
/// the unfiltered tail from the tee is attached in the same call.
#[tokio::test]
async fn a_swallowing_filter_pipeline_gets_the_rescue_tail_and_its_tee_is_consumed() {
    let (rig, shell) = windows_powershell_rig();
    let text = body(
        shell
            .call(&ctx(&rig, "t1"), serde_json::json!({"command": "npm test 2>&1 | Select-Object -First 3"}))
            .await,
    );
    assert_eq!(
        text,
        "[exit code: 1]\n\n(no output)\n\n[filter-swallowed output rescue] the command failed but its trailing filter(s) matched nothing, so the visible output was empty. Unfiltered pipeline output (tail):\nboom\n"
    );
    let script = rig.processes.fed.lock().unwrap()[0].clone();
    let tee = script.split("-FilePath '").nth(1).and_then(|r| r.split('\'').next()).unwrap().to_owned();
    assert!(!std::path::Path::new(&tee).exists(), "the tee file is deleted");
}

/// A POSIX bash command travels through the environment, not argv.
#[tokio::test]
async fn a_bash_command_is_delivered_through_the_environment() {
    let rig = rig();
    let mut config = rig.runtime.config.clone_for_test();
    config.shell = Arc::new(FixedShell("/bin/bash".into()));
    let shell = ShellTool::new(ExecRuntime::new(config));
    shell.call(&ctx(&rig, "b1"), serde_json::json!({"command": "echo hi", "background": true})).await.unwrap();
    let (spec, env) = rig.processes.seen.lock().unwrap()[0].clone();
    let CommandSpec::Shell { script, shell: Some(path) } = spec else { panic!("{spec:?}") };
    assert_eq!(path, "/bin/bash");
    assert_eq!(script, "eval \"${MIXDOG_SHELL_SCRIPT?mixdog: shell script was not delivered to the child}\"");
    assert!(env.set.contains(&("MIXDOG_SHELL_SCRIPT".to_owned(), "echo hi".to_owned())));
}

// ---- real processes through `mixdog_spawn::LocalProcessManager` ----

pub(super) fn real_rig() -> Rig {
    let mut rig = rig();
    rig.manager = Arc::new(mixdog_spawn::LocalProcessManager::new(
        rig.tokens.spawn_io,
        mixdog_spawn::ProcessConfig::default(),
    ));
    rig
}

const LONG_SLEEP: &str = if cfg!(windows) { "Start-Sleep 30" } else { "sleep 30" };

/// Both io-maintenance threads are held by jobs that do not return (two long searches or tree
/// walks): 30 shell calls still start, run and record their output to their logs. The lanes are
/// the real pooled ones (the test backend runs every lane job inline on the submitting thread)
/// and are installed process-wide, so this test needs a process of its own (nextest).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn thirty_shell_calls_start_and_record_while_io_maintenance_is_held() {
    use mixdog_rt::LaneToken;
    let (_executors, tokens) = mixdog_rt::exec::boot(mixdog_rt::exec::RtConfig::for_cores(4)).expect("the executors");
    let (started_tx, started_rx) = std::sync::mpsc::channel();
    let mut releases = Vec::new();
    for _ in 0..2 {
        let (release, held) = std::sync::mpsc::channel::<()>();
        let started = started_tx.clone();
        tokens
            .maintenance_io
            .submit(&CancellationToken::new(), move |_| {
                started.send(()).unwrap();
                let _ = held.recv_timeout(std::time::Duration::from_secs(120));
            })
            .expect("io-maintenance takes the holder");
        releases.push(release);
    }
    for _ in 0..2 {
        started_rx.recv_timeout(std::time::Duration::from_secs(60)).expect("both io-maintenance threads are held");
    }
    let rig = rig_on(tokens, Arc::new(OsPromptElevation), None);
    let calls = (0..30).map(|i| {
        let rig = &rig;
        async move { body(rig.shell.call(&ctx(rig, &format!("m{i}")), serde_json::json!({"command": format!("echo out{i}")})).await) }
    });
    let texts = mixdog_rt::time::timeout(std::time::Duration::from_secs(60), futures::future::join_all(calls))
        .await
        .expect("30 shell calls finish while io-maintenance is held");
    for (i, text) in texts.iter().enumerate() {
        assert_eq!(text, &format!("[exit code: 0]\n\nout{i}\n"));
        let log = rig.dir.path().join("l").join(format!("task-m{i}.stdout.log"));
        assert_eq!(std::fs::read_to_string(log).unwrap(), format!("out{i}\n"), "the log of call {i}");
    }
    drop(releases);
}

/// A job's log writes are held (a stalled disk): the writer takes chunks until it holds its cap of
/// unwritten bytes, the collector then waits, and once the writes resume nothing is lost or
/// reordered and the logs are complete when the writer closes. The drain runs on a real io-pty
/// thread (process-wide executors, so a process of its own: nextest).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_held_log_writer_keeps_within_its_cap_and_loses_or_reorders_nothing() {
    use futures::FutureExt;
    use super::spill::LOG_PENDING_CAP;
    const CHUNK: usize = 16 * 1024;
    let (_executors, tokens) = mixdog_rt::exec::boot(mixdog_rt::exec::RtConfig::for_cores(4)).expect("the executors");
    let dir = tempfile::tempdir().unwrap();
    let logs = [dir.path().join("j.stdout.log"), dir.path().join("j.stderr.log")];
    for log in &logs {
        std::fs::write(log, b"").unwrap();
    }
    let gate = super::spill::write_gate::arm(dir.path());
    let writer = super::spill::LogWriter::new(tokens.pty_io, &logs[0], &logs[1]);
    // Two stdout chunks, then one stderr chunk, each tagged with its number.
    let chunk = |n: usize| {
        let tag = format!("[{n:05}]");
        let bytes: Vec<u8> = tag.bytes().cycle().take(CHUNK).collect();
        (usize::from(n % 3 == 2), bytes)
    };
    let mut expected = [Vec::new(), Vec::new()];

    let (stream, bytes) = chunk(0);
    expected[stream].extend_from_slice(&bytes);
    mixdog_rt::time::timeout(std::time::Duration::from_secs(60), writer.push(stream, bytes)).await.expect("the drain starts");
    gate.wait_reached(1);
    let mut accepted = 1;
    let blocked = loop {
        let (stream, bytes) = chunk(accepted);
        if writer.push(stream, bytes.clone()).now_or_never().is_none() {
            break accepted;
        }
        expected[stream].extend_from_slice(&bytes);
        assert!(writer.unwritten() <= LOG_PENDING_CAP);
        accepted += 1;
    };
    assert_eq!(blocked, LOG_PENDING_CAP / CHUNK, "chunks taken while the writes are held");
    assert_eq!(writer.unwritten(), LOG_PENDING_CAP);

    let total = 3 * blocked;
    let producer = async {
        for n in blocked..total {
            let (stream, bytes) = chunk(n);
            expected[stream].extend_from_slice(&bytes);
            writer.push(stream, bytes).await;
            assert!(writer.unwritten() <= LOG_PENDING_CAP);
        }
        assert_eq!(writer.close(super::spill::LOG_STALL).await, super::spill::LogsClosed::Complete);
    };
    gate.open();
    mixdog_rt::time::timeout(std::time::Duration::from_secs(60), producer).await.expect("the writer takes and writes every chunk");
    assert_eq!(writer.unwritten(), 0);
    for (stream, log) in logs.iter().enumerate() {
        assert!(std::fs::read(log).unwrap() == expected[stream], "log {stream} holds every chunk in order");
    }
}

/// The launchers are written by the first call and their stamps kept; a launcher removed or
/// rewritten since is written again by the next call.
#[tokio::test]
async fn a_launcher_changed_on_disk_is_written_again_by_the_next_call() {
    let rig = rig();
    let rt = SkillRuntime {
        platform: "linux".into(),
        interpreter: "/opt/mixdog/mixdogd".into(),
        entry: "/opt/mixdog/skill.js".into(),
        electron: false,
    };
    let mut config = rig.runtime.config.clone_for_test();
    config.skill_runtime = Some(rt.clone());
    let shell = ShellTool::new(ExecRuntime::new(config));
    let data = rig.dir.path().join("data");
    let file = std::path::PathBuf::from(super::invocation::skill_launcher_dir(&rt, &data.to_string_lossy())).join("mixdog-skill-node");
    shell.call(&ctx(&rig, "k1"), serde_json::json!({"command": "echo one"})).await.unwrap();
    let written = std::fs::read_to_string(&file).unwrap();
    assert!(written.contains("/opt/mixdog/skill.js"), "{written}");

    std::fs::write(&file, "tampered").unwrap();
    shell.call(&ctx(&rig, "k2"), serde_json::json!({"command": "echo two"})).await.unwrap();
    assert_eq!(std::fs::read_to_string(&file).unwrap(), written, "a rewritten launcher is restored");

    std::fs::remove_file(&file).unwrap();
    shell.call(&ctx(&rig, "k3"), serde_json::json!({"command": "echo three"})).await.unwrap();
    assert_eq!(std::fs::read_to_string(&file).unwrap(), written, "a removed launcher is written again");
}

/// A launcher replaced by one of the same length, its modification time put back, is still found
/// out and written again: the next call runs the installation's launcher, not the replacement.
#[tokio::test]
async fn a_launcher_replaced_with_the_same_length_and_time_is_written_again() {
    let rig = rig();
    let rt = SkillRuntime {
        platform: "linux".into(),
        interpreter: "/opt/mixdog/mixdogd".into(),
        entry: "/opt/mixdog/skill.js".into(),
        electron: false,
    };
    let mut config = rig.runtime.config.clone_for_test();
    config.skill_runtime = Some(rt.clone());
    let shell = ShellTool::new(ExecRuntime::new(config));
    let data = rig.dir.path().join("data");
    let file = std::path::PathBuf::from(super::invocation::skill_launcher_dir(&rt, &data.to_string_lossy())).join("mixdog-skill-node");
    shell.call(&ctx(&rig, "s1"), serde_json::json!({"command": "echo one"})).await.unwrap();
    let written = std::fs::read_to_string(&file).unwrap();
    let modified = std::fs::metadata(&file).unwrap().modified().unwrap();
    std::fs::write(&file, "#".repeat(written.len())).unwrap();
    std::fs::File::options().write(true).open(&file).unwrap().set_modified(modified).unwrap();
    assert_eq!(std::fs::metadata(&file).unwrap().modified().unwrap(), modified);

    shell.call(&ctx(&rig, "s2"), serde_json::json!({"command": "echo two"})).await.unwrap();
    assert_eq!(std::fs::read_to_string(&file).unwrap(), written, "the replacement is overwritten");
}

/// The log drain panics: the writer still ends, so closing it (the job's end) returns and later
/// output does not hang either. The drain runs on a real io-pty thread (process-wide executors:
/// nextest).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_log_drain_that_panics_leaves_the_writer_ended_not_hung() {
    let (_executors, tokens) = mixdog_rt::exec::boot(mixdog_rt::exec::RtConfig::for_cores(4)).expect("the executors");
    let dir = tempfile::tempdir().unwrap();
    let logs = [dir.path().join("p.stdout.log"), dir.path().join("p.stderr.log")];
    let _gate = super::spill::write_gate::arm_panicking(dir.path());
    let writer = super::spill::LogWriter::new(tokens.pty_io, &logs[0], &logs[1]);
    let run = async {
        writer.push(0, b"first\n".to_vec()).await;
        writer.close(super::spill::LOG_STALL).await;
        writer.push(1, b"late\n".to_vec()).await;
        writer.close(super::spill::LOG_STALL).await
    };
    let closed = mixdog_rt::time::timeout(std::time::Duration::from_secs(60), run).await.expect("the writer ends after its drain panicked");
    assert_eq!(writer.unwritten(), 0);
    // Nothing reached either log: both say so from their first byte.
    assert_eq!(closed, super::spill::LogsClosed::Incomplete);
    assert_eq!(writer.gaps(), [Some(0), Some(0)]);
}

/// The lane refuses the log drain (the test backend refuses this thread's jobs): the writer ends
/// and closing it returns.
#[tokio::test]
async fn a_refused_log_drain_leaves_the_writer_ended_not_hung() {
    let tokens = mixdog_rt::testing::tokens();
    let dir = tempfile::tempdir().unwrap();
    let logs = [dir.path().join("r.stdout.log"), dir.path().join("r.stderr.log")];
    let writer = super::spill::LogWriter::new(tokens.pty_io, &logs[0], &logs[1]);
    let _refused = mixdog_rt::testing::refuse_jobs_on_this_thread();
    let run = async {
        writer.push(0, b"refused\n".to_vec()).await;
        writer.close(super::spill::LOG_STALL).await;
    };
    mixdog_rt::time::timeout(std::time::Duration::from_secs(60), run).await.expect("the writer ends after its drain was refused");
    assert_eq!(writer.unwritten(), 0);
    assert_eq!(writer.close(super::spill::LOG_STALL).await, super::spill::LogsClosed::Incomplete);
    assert_eq!(writer.gaps(), [Some(0), None], "the refused output is recorded as missing from byte 0");
}

/// The io-pty lane stays saturated (a one-job cap, held for good): admission has a deadline, so
/// the collector's `open` and `push` return, and the job's close reports the output incomplete.
#[tokio::test(start_paused = true)]
async fn a_log_drain_the_saturated_lane_never_admits_ends_with_the_output_incomplete() {
    let mut config = mixdog_rt::exec::RtConfig::for_cores(4);
    config.pty_max_live = 1;
    let (_executors, tokens) = mixdog_rt::exec::boot(config).expect("the executors");
    let (started, held_started) = std::sync::mpsc::channel();
    let (release, held) = std::sync::mpsc::channel::<()>();
    {
        use mixdog_rt::LaneToken;
        tokens
            .pty_io
            .submit(&CancellationToken::new(), move |_| {
                started.send(()).unwrap();
                let _ = held.recv_timeout(std::time::Duration::from_secs(60));
            })
            .expect("io-pty takes the holder");
    }
    held_started.recv_timeout(std::time::Duration::from_secs(60)).expect("the only io-pty thread is held");
    let dir = tempfile::tempdir().unwrap();
    let logs = [dir.path().join("w.stdout.log"), dir.path().join("w.stderr.log")];
    let writer = super::spill::LogWriter::new(tokens.pty_io, &logs[0], &logs[1]);
    let mut run = Box::pin(async {
        writer.open().await;
        writer.push(0, b"never admitted\n".to_vec()).await;
        writer.close(super::spill::LOG_STALL).await
    });
    assert!(futures::FutureExt::now_or_never(&mut run).is_none(), "the writer waits for an io-pty thread");
    // The clock moves only here, past the admission's deadline (a timer is a millisecond coarse).
    tokio::time::advance(super::spill::LOG_STALL + std::time::Duration::from_millis(1)).await;
    let closed = futures::FutureExt::now_or_never(&mut run).expect("the writer gives the drain up at its deadline instead of waiting for ever");
    drop(release);
    assert_eq!(closed, super::spill::LogsClosed::Incomplete);
    assert_eq!(writer.gaps(), [Some(0), None]);
    assert_eq!(writer.unwritten(), 0);
}

/// Every io-pty thread is taken (a one-job cap, held): the writer waits for a thread instead of
/// dropping the output, and the log holds it once the thread frees.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_saturated_io_pty_lane_delays_the_log_and_drops_nothing() {
    use mixdog_rt::LaneToken;
    let mut config = mixdog_rt::exec::RtConfig::for_cores(4);
    config.pty_max_live = 1;
    let (_executors, tokens) = mixdog_rt::exec::boot(config).expect("the executors");
    let (started, held_started) = std::sync::mpsc::channel();
    let (release, held) = std::sync::mpsc::channel::<()>();
    tokens
        .pty_io
        .submit(&CancellationToken::new(), move |_| {
            started.send(()).unwrap();
            let _ = held.recv_timeout(std::time::Duration::from_secs(60));
        })
        .expect("io-pty takes the holder");
    held_started.recv_timeout(std::time::Duration::from_secs(60)).expect("the only io-pty thread is held");
    let dir = tempfile::tempdir().unwrap();
    let logs = [dir.path().join("s.stdout.log"), dir.path().join("s.stderr.log")];
    for log in &logs {
        std::fs::write(log, b"").unwrap();
    }
    let writer = super::spill::LogWriter::new(tokens.pty_io, &logs[0], &logs[1]);
    let mut run = Box::pin(async {
        writer.push(0, b"kept\n".to_vec()).await;
        assert_eq!(writer.close(super::spill::LOG_STALL).await, super::spill::LogsClosed::Complete);
    });
    assert!(futures::FutureExt::now_or_never(&mut run).is_none(), "the writer waits for an io-pty thread");
    drop(release);
    mixdog_rt::time::timeout(std::time::Duration::from_secs(60), run).await.expect("the log is written once the thread frees");
    assert_eq!(std::fs::read_to_string(&logs[0]).unwrap(), "kept\n");
}

/// Delegates to the real process manager and reports the first spawned process's exit. With
/// `hold_caller`, the spawning caller is held after the spawn until the child has filled its
/// replay ring (its reader is parked behind a subscriber) or has exited: the schedule where the
/// job's task runs only after the child wrote more than the ring holds.
struct ExitSignal {
    inner: mixdog_spawn::LocalProcessManager,
    exited: Mutex<Option<std::sync::mpsc::Sender<()>>>,
    hold_caller: bool,
}

impl ExitSignal {
    fn options(&self) -> (mixdog_spawn::SpawnOptions, tokio::sync::oneshot::Receiver<()>) {
        let (ended, ended_rx) = tokio::sync::oneshot::channel();
        let exited = self.exited.lock().unwrap().take();
        let mut options = mixdog_spawn::SpawnOptions::default();
        options.on_exit = Some(Box::new(move |_: &ProcessExit| {
            if let Some(exited) = exited {
                let _ = exited.send(());
            }
            let _ = ended.send(());
            Vec::new()
        }));
        (options, ended_rx)
    }

    async fn hold(&self, handle: &ProcessHandle, ended: tokio::sync::oneshot::Receiver<()>) {
        if !self.hold_caller {
            return;
        }
        let filled = self.inner.output_blocked(handle);
        mixdog_rt::time::timeout(std::time::Duration::from_secs(60), futures::future::select(Box::pin(filled), ended))
            .await
            .expect("the child fills its replay ring or exits while the caller is held");
    }
}

#[async_trait]
impl ProcessManager for ExitSignal {
    async fn spawn(&self, request: SpawnRequest) -> Result<SpawnedProcess, ProcessError> {
        let (options, ended) = self.options();
        let spawned = self.inner.spawn_with(request, options).await?;
        self.hold(&spawned.handle, ended).await;
        Ok(spawned)
    }
    async fn spawn_subscribed(
        &self,
        request: SpawnRequest,
    ) -> Result<(SpawnedProcess, Box<dyn EventSource<ProcessEvent>>), ProcessError> {
        let (options, ended) = self.options();
        let spawned = self.inner.spawn_subscribed_with(request, options).await?;
        self.hold(&spawned.0.handle, ended).await;
        Ok(spawned)
    }
    fn subscribe(&self, handle: &ProcessHandle, from_seq: Option<u64>) -> Result<Box<dyn EventSource<ProcessEvent>>, ProcessError> {
        self.inner.subscribe(handle, from_seq)
    }
    async fn write_stdin(&self, handle: &ProcessHandle, bytes: Vec<u8>) -> Result<(), ProcessError> {
        self.inner.write_stdin(handle, bytes).await
    }
    fn close_stdin(&self, handle: &ProcessHandle) -> Result<(), ProcessError> {
        self.inner.close_stdin(handle)
    }
    fn resize_pty(&self, handle: &ProcessHandle, size: PtySize) -> Result<(), ProcessError> {
        self.inner.resize_pty(handle, size)
    }
    fn kill(&self, handle: &ProcessHandle) -> Result<(), ProcessError> {
        self.inner.kill(handle)
    }
    fn list(&self) -> Vec<ProcessInfo> {
        self.inner.list()
    }
}

/// The job's log creation is held while the child writes twelve times what its replay ring holds
/// (three merged output events) and exits: the output is already being taken (into the writer's
/// queue, whose cap it stays under), so none of it is lost and the log holds all of it in order
/// once the creation goes on. Real executors and processes (nextest).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn output_written_while_the_log_creation_is_held_is_not_lost() {
    const BYTES: usize = 192 * 1024;
    let (_executors, tokens) = mixdog_rt::exec::boot(mixdog_rt::exec::RtConfig::for_cores(4)).expect("the executors");
    let mut rig = rig_on(tokens, Arc::new(OsPromptElevation), None);
    let (exited, exit_seen) = std::sync::mpsc::channel();
    let config = mixdog_spawn::ProcessConfig { ring_bytes: 16 * 1024, ..mixdog_spawn::ProcessConfig::default() };
    rig.manager = Arc::new(ExitSignal {
        inner: mixdog_spawn::LocalProcessManager::new(tokens.spawn_io, config),
        exited: Mutex::new(Some(exited)),
        hold_caller: false,
    });
    let gate = super::spill::write_gate::arm(&rig.dir.path().join("l"));
    let (command, expected) = if cfg!(windows) {
        (format!("[Console]::Out.Write('x' * {BYTES})"), "x".repeat(BYTES))
    } else {
        (format!("printf '%0{BYTES}d' 0"), "0".repeat(BYTES))
    };
    // The creation is held until the child has exited; the waiting is on a thread of its own.
    let opener = std::thread::spawn(move || {
        gate.wait_reached(1);
        exit_seen.recv_timeout(std::time::Duration::from_secs(60)).expect("the child wrote everything and exited");
        gate.open();
    });
    let outcome = mixdog_rt::time::timeout(
        std::time::Duration::from_secs(120),
        rig.shell.call(&ctx(&rig, "ring"), serde_json::json!({ "command": command })),
    )
    .await
    .expect("the call ends");
    opener.join().unwrap();
    let text = body(outcome);
    assert!(text.starts_with("[exit code: 0]"), "{}", &text[..text.len().min(300)]);
    let log = std::fs::read_to_string(rig.dir.path().join("l").join("task-ring.stdout.log")).unwrap();
    assert!(log == expected, "the log holds all {BYTES} bytes in order ({} read)", log.len());
}

/// The job's task is held after the spawn until the child has written more than its replay ring
/// holds (or exited): no schedule loses the start of the output, because the job's subscription
/// exists before the child's first byte. Real executors and processes (nextest).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn output_written_before_the_job_is_scheduled_is_not_lost() {
    const BYTES: usize = 192 * 1024;
    let (_executors, tokens) = mixdog_rt::exec::boot(mixdog_rt::exec::RtConfig::for_cores(4)).expect("the executors");
    let mut rig = rig_on(tokens, Arc::new(OsPromptElevation), None);
    let config = mixdog_spawn::ProcessConfig { ring_bytes: 16 * 1024, ..mixdog_spawn::ProcessConfig::default() };
    rig.manager = Arc::new(ExitSignal {
        inner: mixdog_spawn::LocalProcessManager::new(tokens.spawn_io, config),
        exited: Mutex::new(None),
        hold_caller: true,
    });
    let (command, expected) = if cfg!(windows) {
        (format!("[Console]::Out.Write('x' * {BYTES})"), "x".repeat(BYTES))
    } else {
        (format!("printf '%0{BYTES}d' 0"), "0".repeat(BYTES))
    };
    let outcome = mixdog_rt::time::timeout(
        std::time::Duration::from_secs(120),
        rig.shell.call(&ctx(&rig, "late"), serde_json::json!({ "command": command })),
    )
    .await
    .expect("the call ends");
    let text = body(outcome);
    assert!(text.starts_with("[exit code: 0]"), "{}", &text[..text.len().min(300)]);
    let log = std::fs::read_to_string(rig.dir.path().join("l").join("task-late.stdout.log")).unwrap();
    assert!(log == expected, "the log holds all {BYTES} bytes in order ({} read)", log.len());
}

/// A log drain is held inside a write (a stalled disk) when the job ends: closing the writer
/// returns at its deadline instead of waiting for the write, names the outcome, and records that
/// the stdout log lacks the output from its first byte. Real io-pty thread (nextest).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn closing_a_stalled_log_writer_returns_at_its_deadline_and_names_the_missing_bytes() {
    let (_executors, tokens) = mixdog_rt::exec::boot(mixdog_rt::exec::RtConfig::for_cores(4)).expect("the executors");
    let dir = tempfile::tempdir().unwrap();
    let logs = [dir.path().join("c.stdout.log"), dir.path().join("c.stderr.log")];
    let gate = super::spill::write_gate::arm(dir.path());
    let writer = super::spill::LogWriter::new(tokens.pty_io, &logs[0], &logs[1]);
    mixdog_rt::time::timeout(std::time::Duration::from_secs(60), writer.push(0, b"held\n".to_vec()))
        .await
        .expect("the drain starts");
    let reached = gate.clone();
    tokio::task::spawn_blocking(move || reached.wait_reached(1)).await.unwrap();
    let closed = mixdog_rt::time::timeout(std::time::Duration::from_secs(60), writer.close(std::time::Duration::ZERO))
        .await
        .expect("closing returns while the write is held");
    assert_eq!(closed, super::spill::LogsClosed::Incomplete);
    assert_eq!(writer.gaps(), [Some(0), None]);
    gate.open();
}

/// Every io-pty thread is taken, so the job's drain waits in the lane's queue; the job is then
/// given up (its close passes the deadline): the waiting drain leaves the queue unrun, the close
/// returns, and nothing is written to the log afterwards.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_log_drain_waiting_for_a_thread_leaves_the_queue_when_the_writer_is_given_up() {
    use mixdog_rt::LaneToken;
    let mut config = mixdog_rt::exec::RtConfig::for_cores(4);
    config.pty_max_live = 1;
    let (executors, tokens) = mixdog_rt::exec::boot(config).expect("the executors");
    let (started, held_started) = std::sync::mpsc::channel();
    let (release, held) = std::sync::mpsc::channel::<()>();
    let holder = tokens
        .pty_io
        .submit(&CancellationToken::new(), move |_| {
            started.send(()).unwrap();
            let _ = held.recv_timeout(std::time::Duration::from_secs(60));
        })
        .expect("io-pty takes the holder");
    held_started.recv_timeout(std::time::Duration::from_secs(60)).expect("the only io-pty thread is held");
    let dir = tempfile::tempdir().unwrap();
    let logs = [dir.path().join("w.stdout.log"), dir.path().join("w.stderr.log")];
    for log in &logs {
        std::fs::write(log, b"").unwrap();
    }
    let writer = super::spill::LogWriter::new(tokens.pty_io, &logs[0], &logs[1]);
    let pty_queue = || executors.diagnostics().lanes.into_iter().find(|l| l.kind == mixdog_rt::LaneKind::PtyIo).unwrap().queue_depth;
    let mut push = Box::pin(writer.push(0, b"never\n".to_vec()));
    assert!(futures::FutureExt::now_or_never(&mut push).is_none(), "the drain waits for an io-pty thread");
    assert_eq!(pty_queue(), 1);
    let closed = mixdog_rt::time::timeout(std::time::Duration::from_secs(60), writer.close(std::time::Duration::ZERO))
        .await
        .expect("closing returns while the drain waits");
    assert_eq!(closed, super::spill::LogsClosed::Incomplete);
    mixdog_rt::time::timeout(std::time::Duration::from_secs(60), push).await.expect("the waiting drain is withdrawn");
    assert_eq!(pty_queue(), 0, "the drain left the lane's queue");
    assert_eq!(writer.gaps(), [Some(0), None]);
    drop(release);
    mixdog_rt::time::timeout(std::time::Duration::from_secs(60), holder).await.expect("the holder ends").unwrap();
    assert_eq!(std::fs::read_to_string(&logs[0]).unwrap(), "", "nothing is written after the writer was given up");
}

#[tokio::test]
async fn a_real_echo_matches_the_golden_fixture() {
    let rig = real_rig();
    let golden = fixture("shell", "shell-echo");
    let text = body(rig.shell.call(&ctx(&rig, "r1"), golden["input"].clone()).await);
    assert_eq!(text, golden["text"].as_str().unwrap());
}

#[tokio::test]
async fn a_real_non_zero_exit_keeps_its_code() {
    let rig = real_rig();
    let text = body(rig.shell.call(&ctx(&rig, "r2"), serde_json::json!({"command": "exit 3"})).await);
    assert_eq!(text, "[exit code: 3]\n\n(no output)");
}

#[tokio::test]
async fn a_real_command_over_its_time_limit_is_killed_with_nodes_text() {
    let rig = real_rig();
    let err = rig
        .shell
        .call(&ctx(&rig, "r3"), serde_json::json!({"command": format!("echo begin; {LONG_SLEEP}"), "timeout_ms": 5000}))
        .await
        .unwrap_err();
    assert!(matches!(err.code, ToolErrorCode::DeadlineExceeded { partial: true }));
    // How much output a slow shell start got in before the kill varies; the status text does not.
    assert!(
        err.message_for_model.starts_with(
            "Error: [shell-run-failed] [timeout: 5000ms signal: SIGKILL cause: timeout] — command killed; partial effects may remain\n\n"
        ),
        "{}",
        err.message_for_model
    );
}

#[tokio::test]
async fn a_real_background_command_is_cancelled_through_the_task_tool() {
    let rig = real_rig();
    let started = body(
        rig.shell
            .call(&ctx(&rig, "r4"), serde_json::json!({"command": LONG_SLEEP, "background": true}))
            .await,
    );
    assert!(started.contains("\nstarted in the background; still running. "), "{started}");
    let c = ctx(&rig, "r5");
    let cancelled = body(rig.task.call(&c, serde_json::json!({"action": "cancel", "task_id": "task-r4"})).await);
    assert_eq!(cancelled, "status: completed\ntask_id: task-r4\ncancelled: shell/shell");
    let read = body(rig.task.call(&c, serde_json::json!({"action": "read", "task_id": "task-r4"})).await);
    assert!(read.contains("status: cancelled\nexit_code: 137\n"), "{read}");
}

/// Starts a background `command` of `thread` under the task id `task-<call>`.
async fn background_of(rig: &Rig, call: &str, thread: &str, command: &str) {
    let mut c = ctx(rig, call);
    c.thread_id = ThreadId::from(thread);
    rig.shell.call(&c, serde_json::json!({"command": command, "background": true})).await.unwrap();
}

/// `task-tool-stop-all-shells.test.mjs` and `task-tool-stop-shell-job.test.mjs`: a session lists
/// and stops its own background shells only; the answers are the structured ones the surfaces read.
#[tokio::test]
async fn a_session_stops_only_its_own_background_shells_with_the_structured_answers() {
    let rig = rig();
    let control = ShellControl::new(rig.runtime.clone(), rig.manager.clone());
    let (owner, other) = (ThreadId::from("sess_stopall_owner"), ThreadId::from("sess_stopall_other"));
    assert!(control.list_stoppable(&owner).is_empty());
    assert_eq!(control.stop_jobs(&owner).await, serde_json::json!({ "stopped": 0, "stopping": 0 }));

    background_of(&rig, "a", owner.as_str(), "npm run dev").await;
    background_of(&rig, "b", owner.as_str(), "tail -f log").await;
    background_of(&rig, "f", other.as_str(), "sleep 999").await;
    let listed = control.list_stoppable(&owner);
    assert_eq!(listed.iter().map(|job| job.task_id.as_str()).collect::<Vec<_>>(), ["task-a", "task-b"]);
    assert_eq!(listed[0], StoppableJob { task_id: "task-a".into(), command: "npm run dev".into() });
    assert_eq!(control.list_stoppable(&other).len(), 1);

    assert_eq!(control.stop_job(&owner, "  ").await, serde_json::json!({ "stopped": false, "error": "task_id is required" }));
    // Another session's job reads as unknown and keeps running.
    assert_eq!(
        control.stop_job(&other, "task-a").await,
        serde_json::json!({ "stopped": false, "error": "task not found: task-a" })
    );
    assert!(rig.runtime.get(&owner, "task-a").unwrap().is_running());
    assert_eq!(control.stop_job(&owner, " task-a ").await, serde_json::json!({ "stopped": true }));
    // An ended task is not a failed stop: it says how it ended.
    assert_eq!(
        control.stop_job(&owner, "task-a").await,
        serde_json::json!({ "stopped": false, "finished": true, "error": "task already cancelled: task-a" })
    );

    assert_eq!(control.stop_jobs(&owner).await, serde_json::json!({ "stopped": 1, "stopping": 0 }));
    assert!(rig.runtime.get(&other, "task-f").unwrap().is_running(), "another session keeps its job");
    assert!(control.list_stoppable(&owner).is_empty());
}

/// A shell that has completed leaves the stoppable list, and stopping it answers how it ended and
/// cancels nothing: the same lists and answer Node recorded for a task completed through
/// `completeBackgroundTask` (`record-shell-job-actions.mjs`, `completed`).
#[tokio::test]
async fn a_completed_shell_leaves_the_stoppable_list_and_its_stop_says_how_it_ended() {
    let golden: JsonValue =
        serde_json::from_str(include_str!("../../../../fixtures/shell-job-actions/shell-job-actions.json")).unwrap();
    let want = &golden["completed"];
    let rig = rig();
    let control = ShellControl::new(rig.runtime.clone(), rig.manager.clone());
    let owner = ThreadId::from("sess_b");
    background_of(&rig, "b", owner.as_str(), "sleep 100").await;
    rig.shell.call(&{
        let mut c = ctx(&rig, "d");
        c.thread_id = owner.clone();
        c
    }, serde_json::json!({"command": "echo done-out", "background": true})).await.unwrap();
    let ids = |control: &ShellControl| control.list_stoppable(&owner).into_iter().map(|job| job.task_id).collect::<Vec<_>>();
    // Node's ids are `job_b1` and `job_done`; the order (start, then id) is the same.
    assert_eq!(ids(&control), ["task-b", "task-d"]);
    assert_eq!(want["stoppableBefore"], serde_json::json!(["job_b1", "job_done"]));
    let handle = rig.runtime.get(&owner, "task-d").unwrap().handle.clone();
    {
        let mut senders = rig.processes.senders.lock().unwrap();
        let (tx, seq) = senders.get_mut(&handle).unwrap();
        send(tx, seq, |seq| ProcessEvent::Exited { seq, exit: ProcessExit { status: ExitStatus::Code(0), killed: None } });
    }
    rig.runtime.get(&owner, "task-d").unwrap().settled().await;
    assert_eq!(ids(&control), ["task-b"]);
    assert_eq!(want["stoppableAfter"], serde_json::json!(["job_b1"]));
    let answer = control.stop_job(&owner, "task-d").await;
    let mut expected = want["answer"].clone();
    expected["error"] = JsonValue::String(want["answer"]["error"].as_str().unwrap().replace("job_done", "task-d"));
    assert_eq!(answer, expected);
}

/// `cancelOwnedShellTrees` + `noteShellOwnerSessionClosed` (`session-close.mjs:184`): a closing
/// session's shells are killed, another session's are not, and what remains is flagged as
/// closed-owner work.
#[tokio::test]
async fn a_closing_session_kills_its_shells_and_flags_the_owner_closed() {
    let rig = rig();
    let control = ShellControl::new(rig.runtime.clone(), rig.manager.clone());
    let (owner, other) = (ThreadId::from("sess_closing"), ThreadId::from("sess_bystander"));
    background_of(&rig, "x", owner.as_str(), "sleep 100").await;
    background_of(&rig, "y", other.as_str(), "sleep 100").await;
    control.cancel_owned(&owner);
    let gone = rig.runtime.get(&owner, "task-x").unwrap();
    gone.settled().await;
    assert_eq!(gone.status(), JobStatus::Cancelled);
    assert!(rig.runtime.get(&other, "task-y").unwrap().is_running());
    assert!(control.tasks().get("task-x").unwrap().owner_closed);
    assert!(!control.tasks().get("task-y").unwrap().owner_closed);
}

/// A stop that cannot confirm the processes gone answers `unconfirmed` and records it: the row is
/// held (`terminationUnconfirmed`), `/release` finds it, and a closed owner's hold is found by the
/// sessions that see its folder. The hold ends with the job (confirmed gone) or with the release.
#[tokio::test]
async fn an_unconfirmed_stop_holds_the_row_until_the_job_ends_or_is_released() {
    let rig = rig();
    let watch = FakeSurvivors::new(false);
    let mut config = rig.runtime.config.clone_for_test();
    config.survivors = Some(watch.clone());
    let runtime = ExecRuntime::new(config);
    let shell = ShellTool::new(runtime.clone());
    let control = ShellControl::new(runtime.clone(), rig.manager.clone());
    let owner = ThreadId::from("t");
    shell.call(&ctx(&rig, "s1"), serde_json::json!({"command": "echo hi"})).await.unwrap();
    assert!(control.hold("task-s1").is_none(), "nothing is held before a stop");

    let unconfirmed = serde_json::json!({ "stopped": false, "unconfirmed": true, "error": "cancellation not confirmed: task-s1" });
    assert_eq!(control.stop_job(&owner, "task-s1").await, unconfirmed);
    assert!(control.hold("task-s1").is_some(), "the unconfirmed stop is recorded");
    assert_eq!(control.list_stoppable(&owner).len(), 1, "a held job stays listed");
    control.tasks().owner_closed(owner.as_str());
    let orphaned = |control: &ShellControl| -> Vec<String> {
        control.tasks().host_state().orphaned.into_iter().map(|row| row.task_id).collect()
    };
    assert_eq!(orphaned(&control), ["task-s1"], "a closed owner's hold is found");

    // The survivors exit by themselves: confirmed gone, so the hold ends with the job.
    let ended = runtime.get(&owner, "task-s1").unwrap();
    watch.gone.notify_one();
    ended.settled().await;
    assert!(control.hold("task-s1").is_none());
    assert!(!control.tasks().get("task-s1").unwrap().termination_unconfirmed);
    assert!(orphaned(&control).is_empty());

    // An explicit release drops the row of a held one.
    shell.call(&ctx(&rig, "s2"), serde_json::json!({"command": "echo hi"})).await.unwrap();
    assert_eq!(control.stop_job(&owner, "task-s2").await["unconfirmed"], true);
    assert!(control.hold("task-s2").is_some());
    control.release("task-s2");
    assert!(control.hold("task-s2").is_none() && control.tasks().get("task-s2").is_none());
}

/// A kill the process manager refuses is the same unconfirmed stop; a later stop that lands ends
/// the job and with it the hold. A closing session whose kill cannot be sent leaves the same hold.
#[tokio::test]
async fn a_kill_that_cannot_be_sent_holds_the_row_and_a_later_kill_clears_it() {
    let rig = rig();
    let control = ShellControl::new(rig.runtime.clone(), rig.manager.clone());
    let owner = ThreadId::from("sess_unkillable");
    background_of(&rig, "x", owner.as_str(), "sleep 100").await;
    background_of(&rig, "y", owner.as_str(), "sleep 100").await;
    rig.processes.refuse_kill.store(true, std::sync::atomic::Ordering::SeqCst);

    let refused = serde_json::json!({ "stopped": false, "unconfirmed": true, "error": "cancellation not confirmed: task-x" });
    assert_eq!(control.stop_job(&owner, "task-x").await, refused);
    assert!(control.hold("task-x").is_some());
    assert!(rig.runtime.get(&owner, "task-x").unwrap().is_running(), "the job was not ended");

    control.cancel_owned(&owner);
    assert!(control.hold("task-y").is_some(), "the close holds what it could not kill");
    let orphaned: Vec<String> = control.tasks().host_state().orphaned.into_iter().map(|row| row.task_id).collect();
    assert_eq!(orphaned, ["task-x", "task-y"]);

    rig.processes.refuse_kill.store(false, std::sync::atomic::Ordering::SeqCst);
    assert_eq!(control.stop_job(&owner, "task-x").await, serde_json::json!({ "stopped": true }));
    let row = control.tasks().get("task-x").unwrap();
    assert!(!row.termination_unconfirmed && row.status == mixdog_spawn::tasks::TaskStatus::Cancelled, "{row:?}");
    assert!(control.hold("task-x").is_none());
    assert!(control.hold("task-y").is_some(), "the other job is still held");
}

/// `turn-reap.mjs` over background shells (`record-agent-watchdog.mjs`, `reaps`): the watchdog's
/// stop of a turn ends the shells the turn started (at or after its ask, its own session's only)
/// without waiting, and the handoff splits them into confirmed gone and still stopping, exactly
/// as real Node did. A kill that cannot be sent is Node's unconfirmed kill.
#[tokio::test]
async fn a_stalled_turns_reap_stops_and_splits_the_shells_as_node_did() {
    use std::sync::atomic::Ordering::SeqCst;
    let golden: JsonValue =
        serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/agent-watchdog/golden.json")).unwrap();
    let names = |value: &JsonValue| -> std::collections::BTreeSet<String> {
        value.as_array().unwrap().iter().map(|id| id.as_str().unwrap().to_owned()).collect()
    };
    for case in golden["reaps"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let rig = rig();
        let clock = Arc::new(std::sync::atomic::AtomicU64::new(0));
        let mut config = rig.runtime.config.clone_for_test();
        config.now_ms = {
            let clock = clock.clone();
            Arc::new(move || clock.load(SeqCst))
        };
        let runtime = ExecRuntime::new(config);
        let shell = ShellTool::new(runtime.clone());
        let control = ShellControl::new(runtime.clone(), rig.manager.clone());
        let owner = ThreadId::from(case["session"].as_str().unwrap());
        let now = 1_000_000_i64;
        for job in case["jobs"].as_array().unwrap() {
            clock.store((now + job["startedOffset"].as_i64().unwrap()) as u64, SeqCst);
            let mut call = ctx(&rig, job["id"].as_str().unwrap());
            call.thread_id = ThreadId::from(job["session"].as_str().unwrap_or(owner.as_str()));
            shell.call(&call, serde_json::json!({"command": "sleep 100", "background": true})).await.unwrap();
        }
        rig.processes.refuse_kill.store(case["kill"] == "unconfirmed", SeqCst);
        control.reap_since(&owner, (now + case["askOffset"].as_i64().unwrap()) as u64);
        let reaped = names(&case["cancelled"]);
        if case["kill"] != "unconfirmed" {
            for id in &reaped {
                let job = runtime.get(&owner, &format!("task-{id}")).unwrap();
                job.settled().await;
            }
        }
        for job in case["jobs"].as_array().unwrap() {
            let id = job["id"].as_str().unwrap();
            let session = ThreadId::from(job["session"].as_str().unwrap_or(owner.as_str()));
            let running = runtime.get(&session, &format!("task-{id}")).unwrap().is_running();
            let held = control.tasks().get(&format!("task-{id}")).unwrap().termination_unconfirmed;
            assert_eq!(!(running && !held), reaped.contains(id), "{name}: {id} stopped or held");
        }
        let (stopped, stopping) = control.take_reaped(&owner);
        let strip = |ids: Vec<String>| ids.into_iter().map(|id| id.trim_start_matches("task-").to_owned()).collect::<std::collections::BTreeSet<_>>();
        assert_eq!(strip(stopped), names(&case["stopped"]), "{name}: stopped");
        assert_eq!(strip(stopping), names(&case["stopping"]), "{name}: stopping");
        assert!(control.take_reaped(&owner).0.is_empty(), "{name}: the list is handed out once");
    }
}
// ---- the shell's refusal of a command the built-in tools cover, and `machine`: recorded from Node ----

/// A workspace file's bytes from its recipe: hex, or text (repeated, with a trailing piece, in UTF-16 with a BOM).
fn recipe_bytes(f: &JsonValue) -> Vec<u8> {
    if let Some(h) = f.get("hex").and_then(JsonValue::as_str) {
        return (0..h.len()).step_by(2).map(|i| u8::from_str_radix(&h[i..i + 2], 16).unwrap()).collect();
    }
    let mut text = f["text"].as_str().unwrap().to_owned();
    if let Some(times) = f.get("repeat").and_then(JsonValue::as_u64) {
        text = text.repeat(times as usize);
    }
    if let Some(tail) = f.get("tail").and_then(JsonValue::as_str) {
        text.push_str(tail);
    }
    if f.get("enc").and_then(JsonValue::as_str) == Some("utf16le") {
        let mut out = vec![0xff, 0xfe];
        for unit in text.encode_utf16() {
            out.extend_from_slice(&unit.to_le_bytes());
        }
        return out;
    }
    text.into_bytes()
}

/// The recorded workspace under `dir`, and its path as Node spells it (no verbatim prefix).
fn recorded_files(dir: &std::path::Path, files: &serde_json::Map<String, JsonValue>) -> std::path::PathBuf {
    let root = dir.join("ws");
    for (rel, f) in files {
        let path = root.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        if f.get("remove").is_none() {
            std::fs::write(path, recipe_bytes(f)).unwrap();
        }
    }
    std::path::PathBuf::from(std::fs::canonicalize(&root).unwrap().to_string_lossy().trim_start_matches(r"\\?\"))
}

/// A call's context over the recorded workspace, offering the tools the case names (null: no session information).
fn cover_ctx(rig: &Rig, root: &std::path::Path, offers: &JsonValue) -> ToolContext {
    let mut c = ctx(rig, "cover");
    c.files = Arc::new(mixdog_workspace::localfs::LocalFileService::new());
    c.cwd = AbsPath::new(root).unwrap();
    c.options.offered_tools = offers.as_array().map(|tools| Arc::new(tools.iter().map(|t| t.as_str().unwrap().to_owned()).collect()));
    c
}

/// The guard on Node's recorded table (`record-shell-cover.mjs`): every command under both shell families, the tools the
/// session offers, and the refusal text or the call that runs with its notes. Path rules differ per platform, so the table
/// is replayed on the platform it was recorded on.
#[cfg(windows)]
#[tokio::test]
async fn the_shell_guard_covers_what_node_covers() {
    let doc: JsonValue = serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/shell-cover/cases.json")).unwrap();
    assert_eq!(doc["platform"], "win32");
    let dir = tempfile::tempdir().unwrap();
    let root = recorded_files(dir.path(), doc["files"].as_object().unwrap());
    let forward = root.to_string_lossy().replace('\\', "/");
    let back = root.to_string_lossy().into_owned();
    let fix = |s: &str| s.replace(&forward, "<WS>").replace(&back, "<WS>");
    let rig = rig();
    let mut failures = Vec::new();
    let cases = doc["cases"].as_array().unwrap();
    for case in cases {
        let c = cover_ctx(&rig, &root, &case["offers"]);
        let command = case["args"]["command"].as_str().unwrap().replace("<WS>", &forward);
        let cwd = case["args"]["cwd"].as_str().map(|c| c.replace("<WS>", &forward));
        let powershell = case["shellType"] == "powershell";
        let got = super::guard::guard_call(&c, &command, cwd.as_deref(), false, powershell).await;
        let want = &case["result"];
        let same = match &got {
            super::guard::Guarded::Refused(text) => want["failure"].as_str() == Some(fix(text).as_str()),
            super::guard::Guarded::Run { command, cwd, notes } => {
                want["failure"].is_null()
                    && want["args"]["command"].as_str() == Some(fix(command).as_str())
                    && want["args"]["cwd"].as_str() == cwd.as_deref().map(fix).as_deref()
                    && want["notes"].as_array().unwrap().iter().map(|n| n.as_str().unwrap()).eq(notes.iter().map(|n| fix(n)).collect::<Vec<_>>().iter().map(String::as_str))
            }
        };
        if !same {
            failures.push(format!("{} {} offers {}\n  want {want}\n  got  {got:?}", case["shellType"], case["args"], case["offers"]));
        }
    }
    assert!(failures.is_empty(), "{} of {} differ:\n{}", failures.len(), cases.len(), failures.iter().take(20).cloned().collect::<Vec<_>>().join("\n"));
}

/// The refusal reaches the caller through the shell tool itself, as an error with Node's text: nothing runs.
#[cfg(windows)]
#[tokio::test]
async fn the_shell_tool_refuses_a_covered_command_with_nodes_text() {
    let doc: JsonValue = serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/shell-cover/cases.json")).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let root = recorded_files(dir.path(), doc["files"].as_object().unwrap());
    let forward = root.to_string_lossy().replace('\\', "/");
    let rig = rig();
    let mut refused = 0;
    for case in doc["cases"].as_array().unwrap() {
        let failure = case["result"]["failure"].as_str().unwrap_or("");
        // The rig's shell is a POSIX one.
        if case["shellType"] != "posix" || case["args"].get("cwd").is_some() || !failure.contains("the built-in tools cover this command") {
            continue;
        }
        let c = cover_ctx(&rig, &root, &case["offers"]);
        let command = case["args"]["command"].as_str().unwrap().replace("<WS>", &forward);
        let outcome = rig.shell.call(&c, serde_json::json!({ "command": command })).await;
        let Err(e) = outcome else { panic!("{command} was run") };
        assert_eq!(e.message_for_model.replace(&forward, "<WS>"), failure, "{command}");
        refused += 1;
    }
    assert!(refused > 30, "{refused} refusals replayed");
}

/// What the `machine` tool prints, as the recorder writes it: each reading a placeholder, the wording, the order of the
/// sections and the number of `top by …` rows exact (`record-machine-tool.mjs` states the rules).
fn machine_shape(text: &str) -> String {
    let process_row = regex::Regex::new(r"^ {2}\S.* \(pid \d+\) {2}cpu [\d.]+% {2}mem \d+ MB$").unwrap();
    let more_row = regex::Regex::new(r"^ {2}… \d+ more$").unwrap();
    let mut out: Vec<String> = Vec::new();
    let mut section = String::new();
    for line in text.split('\n') {
        let heads = ["cpu", "memory", "processes", "drives", "top by cpu", "top by memory"];
        if heads.iter().any(|h| line.starts_with(h)) {
            section = line.split([':', '(']).next().unwrap().trim().to_owned();
        }
        let mut next = line.to_owned();
        if line.starts_with("cpu: ") {
            next = regex::Regex::new(r"^cpu: \d+% busy of \d+ cores").unwrap().replace(line, "cpu: <n>% busy of <n> cores").into_owned();
        } else if line.starts_with("memory: ") {
            next = regex::Regex::new(r"^memory: [\d.]+ GB available of [\d.]+ GB \(\d+% used\)$").unwrap().replace(line, "memory: <gb> GB available of <gb> GB (<n>% used)").into_owned();
        } else if section == "drives" && line.starts_with("  ") && !line.trim().is_empty() {
            if out.last().is_some_and(|l| l == "  <drive> <gb> GB of <gb> GB") {
                continue;
            }
            next = "  <drive> <gb> GB of <gb> GB".to_owned();
        } else if line.starts_with("processes matching \"") {
            next = regex::Regex::new(r"\((\d+)\):$").unwrap().replace(line, |c: &regex::Captures| if &c[1] == "0" { "(0):".to_owned() } else { "(<n>):".to_owned() }).into_owned();
        } else if section.starts_with("processes matching") {
            if line == "  none" {
                next = line.to_owned();
            } else if process_row.is_match(line) || more_row.is_match(line) {
                if out.last().is_some_and(|l| l == "  <process rows>") {
                    continue;
                }
                next = "  <process rows>".to_owned();
            }
        } else if process_row.is_match(line) {
            next = "  <process> (pid <n>)  cpu <n>%  mem <n> MB".to_owned();
        }
        out.push(next);
    }
    out.join("\n")
}

/// Node's `machine` on its recorded arguments: the same sections, wording and refusals, whatever the machine's own readings.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn machine_has_nodes_shape() {
    let doc: JsonValue = serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/machine-tool/cases.json")).unwrap();
    let rig = real_rig();
    let tool = MachineTool::new();
    let mut failures = Vec::new();
    for (n, case) in doc["cases"].as_array().unwrap().iter().enumerate() {
        let (refused, text) = match tool.call(&ctx(&rig, &format!("machine{n}")), case["input"].clone()).await {
            Ok(out) => match &out.parts[0] {
                ToolPart::Text(t) => (false, t.clone()),
                other => panic!("{other:?}"),
            },
            Err(e) => (true, e.message_for_model),
        };
        let want = &case["result"];
        let shaped = machine_shape(&text);
        let mut expected = want["text"].as_str().unwrap().to_owned();
        // A machine too loaded to list its processes in time is told so (the tool's own deadline; Node's recorder refuses to
        // record that answer): the process sections give way to that one line and nothing else changes.
        if shaped.contains("processes: unavailable (no answer within the deadline)") {
            let lines: Vec<&str> = expected.split('\n').collect();
            let from = lines.iter().position(|l| *l == "top by cpu:").unwrap();
            let to = lines.iter().position(|l| l.starts_with("drives")).unwrap();
            let tail = lines.iter().position(|l| l.starts_with("processes matching")).unwrap_or(lines.len());
            expected = [&lines[..from], &["processes: unavailable (no answer within the deadline)"][..], &lines[to..tail]].concat().join("\n");
        }
        if shaped != expected || refused != want["isError"].as_bool().unwrap() {
            failures.push(format!("{}\n  want {}\n  got  {shaped}", case["name"], want["text"]));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}