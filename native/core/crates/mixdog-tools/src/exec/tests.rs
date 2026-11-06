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
    /// The `echo X; Start-Sleep 30` command prints nothing at spawn; the test prints later.
    quiet: std::sync::atomic::AtomicBool,
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
        let exit = |status, killed| ProcessExit { status, killed };
        self.seen.lock().unwrap().push((request.command.clone(), request.env.clone()));
        if script == "run-limited" {
            self.limited.lock().unwrap().insert(request.handle.clone());
        } else if let Some(tee) = script
            .split("-FilePath '")
            .nth(1)
            .filter(|_| script.contains("Tee-Object"))
            .and_then(|rest| rest.split('\'').next())
        {
            // A filter pipeline whose producer failed: the tee holds what the filters swallowed.
            std::fs::write(tee, "boom\n").unwrap();
            send(&tx, &mut seq, |seq| ProcessEvent::Exited { seq, exit: exit(ExitStatus::Code(1), None) });
        } else if script == "echo begin; Start-Sleep 30" {
            let bytes = b"begin\n".to_vec();
            send(&tx, &mut seq, |seq| ProcessEvent::Output { seq, stream: OutputStream::Stdout, bytes });
            send(&tx, &mut seq, |seq| ProcessEvent::Exited {
                seq,
                exit: exit(ExitStatus::Signal(9), Some(KillReason::TimeLimit)),
            });
        } else if self.quiet.load(std::sync::atomic::Ordering::SeqCst) && script.ends_with("; Start-Sleep 30") {
        } else if let Some(word) = script.strip_suffix("; Start-Sleep 30").and_then(|s| s.strip_prefix("echo ")) {
            let bytes = format!("{word}\n").into_bytes();
            send(&tx, &mut seq, |seq| ProcessEvent::Output { seq, stream: OutputStream::Stdout, bytes });
        } else if script == "echo done-out" {
            // Silent until the test prints and ends it, as Node's process had printed nothing when
            // the task was promoted.
        } else if let Some(rest) = script.strip_prefix("echo ") {
            send(&tx, &mut seq, |seq| ProcessEvent::Output {
                seq,
                stream: OutputStream::Stdout,
                bytes: format!("{rest}\n").into_bytes(),
            });
            send(&tx, &mut seq, |seq| ProcessEvent::Exited { seq, exit: exit(ExitStatus::Code(0), None) });
        } else if script.starts_with("grep ") {
            send(&tx, &mut seq, |seq| ProcessEvent::Exited { seq, exit: exit(ExitStatus::Code(1), None) });
        } else if script == "korean" {
            send(&tx, &mut seq, |seq| ProcessEvent::Output {
                seq,
                stream: OutputStream::Stdout,
                bytes: vec![0xC7, 0xD1, 0xB1, 0xDB, 0x20, 0xC3, 0xE2, 0xB7, 0xC2, 0x0A],
            });
            send(&tx, &mut seq, |seq| ProcessEvent::Exited { seq, exit: exit(ExitStatus::Code(0), None) });
        } else if script == "repeat" {
            send(&tx, &mut seq, |seq| ProcessEvent::Output {
                seq,
                stream: OutputStream::Stdout,
                bytes: "tick\n".repeat(200).into_bytes(),
            });
            send(&tx, &mut seq, |seq| ProcessEvent::Exited { seq, exit: exit(ExitStatus::Code(0), None) });
        } else if script == "fail" {
            send(&tx, &mut seq, |seq| ProcessEvent::Output {
                seq,
                stream: OutputStream::Stderr,
                bytes: b"boom\n".to_vec(),
            });
            send(&tx, &mut seq, |seq| ProcessEvent::Exited { seq, exit: exit(ExitStatus::Code(3), None) });
        } else if script == "timeout" {
            send(&tx, &mut seq, |seq| ProcessEvent::Exited {
                seq,
                exit: exit(ExitStatus::Signal(9), Some(KillReason::TimeLimit)),
            });
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

    async fn write_stdin(&self, _: &ProcessHandle, _: Vec<u8>) -> Result<(), ProcessError> {
        Err(ProcessError::StdinClosed)
    }
    fn close_stdin(&self, _: &ProcessHandle) -> Result<(), ProcessError> {
        Err(ProcessError::StdinClosed)
    }
    fn resize_pty(&self, _: &ProcessHandle, _: PtySize) -> Result<(), ProcessError> {
        Err(ProcessError::NotPty)
    }
    fn kill(&self, handle: &ProcessHandle) -> Result<(), ProcessError> {
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

struct Rig {
    shell: ShellTool,
    task: TaskTool,
    runtime: Arc<ExecRuntime>,
    dir: tempfile::TempDir,
    processes: Arc<FakeProcesses>,
    /// What the tool sees: the fake, or the real manager of a test that runs real processes.
    manager: Arc<dyn ProcessManager>,
    review: Arc<super::settle::RecordingReview>,
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
    let review = Arc::new(super::settle::RecordingReview::default());
    let dir = tempfile::tempdir().unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let runtime = ExecRuntime::new(ExecConfig {
        tasks: Arc::new(mixdog_spawn::tasks::TaskRegistry::new(Arc::new(NoPublisher), golden_ms)),
        lanes: IoLanes {
            interactive: tokens.interactive_io,
            durability: tokens.durability_io,
            maintenance: tokens.maintenance_io,
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
        shell_path: "/bin/sh".into(),
        shell_name: "sh".into(),
        script_syntax: Arc::new(AwaitIsTopLevel),
        windows: false,
        powershell: false,
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
    }
}

fn ctx(rig: &Rig, call: &str) -> ToolContext {
    let tokens = mixdog_rt::testing::tokens();
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

fn body(outcome: ToolOutcome) -> String {
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
        assert_eq!(body(rig.task.call(&c, golden["input"].clone()).await), golden["text"].as_str().unwrap(), "{name}");
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
    kill_works: bool,
}

#[async_trait]
impl SurvivorWatch for FakeSurvivors {
    fn survivors(&self, _: &ProcessHandle) -> Option<Survivors> {
        Some(Survivors { reachable: true })
    }
    async fn wait_gone(&self, _: &ProcessHandle) {
        self.gone.notified().await;
    }
    async fn kill(&self, _: &ProcessHandle) -> bool {
        if self.kill_works {
            self.gone.notify_one();
        }
        self.kill_works
    }
}

/// A command that finished but left processes running hands them over as a tracked task.
#[tokio::test]
async fn surviving_descendants_become_a_tracked_task_that_cancels_and_completes() {
    let rig = rig();
    let watch = Arc::new(FakeSurvivors { gone: tokio::sync::Notify::new(), kill_works: true });
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
    assert!(read.contains("status: cancelled") && read.ends_with("(no new output)"), "{read}");
}

#[tokio::test]
async fn survivors_that_resist_the_kill_keep_the_task_pending() {
    let rig = rig();
    let watch = Arc::new(FakeSurvivors { gone: tokio::sync::Notify::new(), kill_works: false });
    let mut config = rig.runtime.config.clone_for_test();
    config.survivors = Some(watch);
    let runtime = ExecRuntime::new(config);
    let (shell, task) = (ShellTool::new(runtime.clone()), TaskTool::new(runtime));
    shell.call(&ctx(&rig, "s1"), serde_json::json!({"command": "echo hi"})).await.unwrap();
    let out = body(task.call(&ctx(&rig, "s2"), serde_json::json!({"action": "cancel", "task_id": "task-s1"})).await);
    assert_eq!(out, "status: cancel-pending\ntask_id: task-s1\nthe kill was sent and the command itself exited, but processes it started are still alive. They keep being terminated and stay tracked (the folder stays held) until they are gone; re-run task cancel or task read to check again.");
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
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
}

/// Node `notifyToolCompletion`: the launching call's `notifyFn` takes the completion first, with
/// the meta that files it; the owner's default delivery is not used when it accepts.
#[tokio::test]
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
#[tokio::test]
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
    config.shell_name = "powershell.exe".into();
    config.skill_runtime = Some(skill_runtime());
    let shell = ShellTool::new(ExecRuntime::new(config));
    (rig, shell)
}

#[tokio::test]
async fn a_powershell_command_gets_the_utf8_preamble_and_the_skill_function() {
    let (rig, shell) = windows_powershell_rig();
    shell.call(&ctx(&rig, "p1"), serde_json::json!({"command": "echo hi", "background": true})).await.unwrap();
    let (spec, _) = rig.processes.seen.lock().unwrap()[0].clone();
    let CommandSpec::Shell { script, shell: None } = spec else { panic!("{spec:?}") };
    assert_eq!(
        script,
        format!(
            "{}\n{}\necho hi",
            super::invocation::POWERSHELL_UTF8_PREFIX,
            super::invocation::render_powershell_skill_function(&skill_runtime())
        )
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
    let (spec, _) = rig.processes.seen.lock().unwrap()[0].clone();
    let CommandSpec::Shell { script, .. } = spec else { panic!() };
    let tee = script.split("-FilePath '").nth(1).and_then(|r| r.split('\'').next()).unwrap().to_owned();
    assert!(!std::path::Path::new(&tee).exists(), "the tee file is deleted");
}

/// A POSIX bash command travels through the environment, not argv.
#[tokio::test]
async fn a_bash_command_is_delivered_through_the_environment() {
    let rig = rig();
    let mut config = rig.runtime.config.clone_for_test();
    config.shell_path = "/bin/bash".into();
    let shell = ShellTool::new(ExecRuntime::new(config));
    shell.call(&ctx(&rig, "b1"), serde_json::json!({"command": "echo hi", "background": true})).await.unwrap();
    let (spec, env) = rig.processes.seen.lock().unwrap()[0].clone();
    let CommandSpec::Shell { script, shell: Some(path) } = spec else { panic!("{spec:?}") };
    assert_eq!(path, "/bin/bash");
    assert_eq!(script, "eval \"${MIXDOG_SHELL_SCRIPT?mixdog: shell script was not delivered to the child}\"");
    assert!(env.set.contains(&("MIXDOG_SHELL_SCRIPT".to_owned(), "echo hi".to_owned())));
}

// ---- real processes through `mixdog_spawn::LocalProcessManager` ----

fn real_rig() -> Rig {
    let mut rig = rig();
    let tokens = mixdog_rt::testing::tokens();
    rig.manager = Arc::new(mixdog_spawn::LocalProcessManager::new(
        tokens.spawn_io,
        mixdog_spawn::ProcessConfig::default(),
    ));
    rig
}

const LONG_SLEEP: &str = if cfg!(windows) { "Start-Sleep 30" } else { "sleep 30" };

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
