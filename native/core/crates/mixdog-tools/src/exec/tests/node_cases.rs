//! Node tests of the shell tool replayed against the recording `fixtures/exec-cases/golden.json`
//! (`record-exec-cases.mjs`, Node b6f10295a): one test per recorded scenario.

use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering::SeqCst;

use super::*;

fn golden() -> &'static JsonValue {
    static GOLDEN: std::sync::LazyLock<JsonValue> = std::sync::LazyLock::new(|| {
        serde_json::from_str(include_str!("../../../../../fixtures/exec-cases/golden.json")).unwrap()
    });
    &GOLDEN
}

fn scenario(name: &str) -> &'static JsonValue {
    &golden()["scenarios"][name]
}

/// How long a step the test waits on may take before the test fails naming it (a failure bound, not a wait the test relies on).
const STEP_MS: u64 = 5_000;

async fn until<T>(what: &str, wait: impl std::future::Future<Output = T>) -> T {
    tokio::time::timeout(std::time::Duration::from_millis(STEP_MS), wait)
        .await
        .unwrap_or_else(|_| panic!("{what}: not within {STEP_MS} ms"))
}

/// One spawned process of [`Stepped`]: the test sends its events; `pulled` counts the reads of the job's collector, so a
/// count past an event's position means the job has taken that event in.
struct Run {
    events: Chan,
    seq: u64,
    pulled: tokio::sync::watch::Receiver<u64>,
}

struct PullSource {
    events: mpsc::UnboundedReceiver<ProcessEvent>,
    pulled: tokio::sync::watch::Sender<u64>,
}

#[async_trait]
impl EventSource<ProcessEvent> for PullSource {
    async fn next(&mut self) -> Option<ProcessEvent> {
        self.pulled.send_modify(|n| *n += 1);
        self.events.recv().await
    }
}

/// A process manager the test steps by hand: a spawn answers `answer` (events sent at once), a kill ends the process unless
/// `kill_ends` is off (a killed tree that keeps running).
struct Stepped {
    runs: Mutex<HashMap<ProcessHandle, Run>>,
    sources: Mutex<HashMap<ProcessHandle, PullSource>>,
    spawned: Mutex<Vec<(CommandSpec, EnvSpec, Option<std::time::Duration>)>>,
    answer: Box<dyn Fn(&CommandSpec) -> Vec<(Option<OutputStream>, Vec<u8>, i32)> + Send + Sync>,
    kill_ends: std::sync::atomic::AtomicBool,
}

impl Stepped {
    /// `answer`: the events a spawn emits at once, each `(Some(stream), bytes, _)` an output and `(None, _, code)` the exit.
    fn new(answer: impl Fn(&CommandSpec) -> Vec<(Option<OutputStream>, Vec<u8>, i32)> + Send + Sync + 'static) -> Arc<Self> {
        Arc::new(Self {
            runs: Mutex::default(),
            sources: Mutex::default(),
            spawned: Mutex::default(),
            answer: Box::new(answer),
            kill_ends: std::sync::atomic::AtomicBool::new(true),
        })
    }

    fn quiet() -> Arc<Self> {
        Self::new(|_| Vec::new())
    }

    fn emit(&self, handle: &str, event: impl FnOnce(u64) -> ProcessEvent) -> u64 {
        let mut runs = self.runs.lock().unwrap();
        let run = runs.get_mut(&ProcessHandle(handle.to_owned())).unwrap();
        run.events.send(event(run.seq)).unwrap();
        run.seq += 1;
        run.seq
    }

    /// Sends `bytes` on `stream` and waits until the job has taken it in.
    async fn output(&self, handle: &str, stream: OutputStream, bytes: &[u8]) {
        let bytes = bytes.to_vec();
        let at = self.emit(handle, |seq| ProcessEvent::Output { seq, stream, bytes });
        let mut pulled = self.runs.lock().unwrap()[&ProcessHandle(handle.to_owned())].pulled.clone();
        until(&format!("{handle} to take in output {at}"), pulled.wait_for(|n| *n > at)).await.unwrap();
    }

    fn exit(&self, handle: &str, status: ExitStatus, killed: Option<KillReason>) {
        self.emit(handle, |seq| ProcessEvent::Exited { seq, exit: ProcessExit { status, killed } });
    }

    fn script(&self, n: usize) -> String {
        match &self.spawned.lock().unwrap()[n].0 {
            CommandSpec::Shell { script, .. } => script.clone(),
            CommandSpec::Argv { program, args } => std::iter::once(program).chain(args).cloned().collect::<Vec<_>>().join(" "),
        }
    }
}

#[async_trait]
impl ProcessManager for Stepped {
    async fn spawn(&self, request: SpawnRequest) -> Result<SpawnedProcess, ProcessError> {
        let (tx, rx) = mpsc::unbounded_channel();
        let (pulled_tx, pulled) = tokio::sync::watch::channel(0);
        let events = (self.answer)(&request.command);
        self.spawned.lock().unwrap().push((request.command.clone(), request.env.clone(), request.time_limit));
        let mut run = Run { events: tx, seq: 0, pulled };
        for (stream, bytes, code) in events {
            let seq = run.seq;
            run.events
                .send(match stream {
                    Some(stream) => ProcessEvent::Output { seq, stream, bytes },
                    None => ProcessEvent::Exited { seq, exit: ProcessExit { status: ExitStatus::Code(code), killed: None } },
                })
                .unwrap();
            run.seq += 1;
        }
        self.runs.lock().unwrap().insert(request.handle.clone(), run);
        self.sources.lock().unwrap().insert(request.handle.clone(), PullSource { events: rx, pulled: pulled_tx });
        Ok(SpawnedProcess { handle: request.handle, pid: 1 })
    }

    fn subscribe(&self, handle: &ProcessHandle, _: Option<u64>) -> Result<Box<dyn EventSource<ProcessEvent>>, ProcessError> {
        let source = self.sources.lock().unwrap().remove(handle).ok_or(ProcessError::UnknownHandle)?;
        Ok(Box::new(source))
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
        if self.kill_ends.load(SeqCst) {
            self.exit(&handle.0, ExitStatus::Signal(9), Some(KillReason::Requested));
        }
        Ok(())
    }
    fn list(&self) -> Vec<ProcessInfo> {
        Vec::new()
    }
}

/// A rig whose tool runs on `processes`, with the runtime `adjust` makes and a clock the test sets.
fn stepped_rig(processes: Arc<Stepped>, adjust: impl FnOnce(&mut ExecConfig)) -> (Rig, ShellTool, Arc<AtomicU64>) {
    let mut rig = rig();
    let clock = Arc::new(AtomicU64::new(golden_ms()));
    let mut config = rig.runtime.config.clone_for_test();
    config.now_ms = {
        let clock = clock.clone();
        Arc::new(move || clock.load(SeqCst))
    };
    adjust(&mut config);
    rig.runtime = ExecRuntime::new(config);
    rig.manager = processes;
    let shell = ShellTool::new(rig.runtime.clone());
    (rig, shell, clock)
}

fn windows_powershell(config: &mut ExecConfig) {
    config.windows = true;
    config.powershell = true;
    config.shell = Arc::new(FixedShell("powershell.exe".into()));
}

/// `bash-tool-cwd-env.test.mjs`: the launcher directory and files of the runtime Node recorded, and the model shell's PATH over
/// the daemon's `PATH=A;B` with that directory first; the session cwd rides along.
#[test]
fn the_skill_launcher_directory_leads_the_shell_path_as_in_node() {
    let case = scenario("launcher-path");
    let runtime = &case["runtime"];
    let rt = SkillRuntime {
        platform: runtime["platform"].as_str().unwrap().into(),
        interpreter: runtime["interpreter"].as_str().unwrap().into(),
        entry: runtime["entry"].as_str().unwrap().into(),
        electron: runtime["electron"].as_bool().unwrap(),
    };
    let dir = skill_launcher_dir(&rt, case["dataDir"].as_str().unwrap());
    assert_eq!(dir, case["dir"].as_str().unwrap());
    let files: Vec<JsonValue> = super::super::invocation::skill_launcher_files(&rt)
        .into_iter()
        .map(|(name, content)| serde_json::json!({ "name": name, "exists": true, "content": content }))
        .collect();
    assert_eq!(JsonValue::Array(files), case["files"]);
    let daemon = vec![("PATH".to_owned(), case["daemonEnv"]["PATH"].as_str().unwrap().to_owned())];
    let env = super::super::env::shell_env(
        &daemon,
        &super::super::env::ShellEnv {
            cwd: "C:\\x",
            windows: rt.platform == "win32",
            scratch_dir: None,
            skill_launcher_dir: Some(std::path::Path::new(&dir)),
        },
    );
    let get = |name: &str| env.set.iter().find(|(k, _)| k == name).map(|(_, v)| JsonValue::from(v.as_str()));
    assert_eq!(get("PATH"), Some(case["PATH"].clone()));
    assert_eq!(get("MIXDOG_SESSION_CWD"), Some(case["sessionCwd"].clone()));
    // The daemon's own variables are an input, never changed (Node: `daemonPathKept`).
    assert_eq!(case["daemonPathKept"], true);
    assert_eq!(daemon[0].1, case["daemonEnv"]["PATH"].as_str().unwrap());
}

/// `bash-tool-cwd-env.test.mjs`, through the tool: a run writes the launchers Node writes for the same runtime into the data
/// dir's launcher directory and puts that directory first on the child's PATH.
#[tokio::test]
async fn a_shell_run_writes_nodes_launchers_and_leads_its_path_with_them() {
    let case = scenario("launcher-path");
    let runtime = &case["runtime"];
    let rt = SkillRuntime {
        platform: runtime["platform"].as_str().unwrap().into(),
        interpreter: runtime["interpreter"].as_str().unwrap().into(),
        entry: runtime["entry"].as_str().unwrap().into(),
        electron: runtime["electron"].as_bool().unwrap(),
    };
    let processes = Stepped::new(|_| vec![(None, Vec::new(), 0)]);
    let (rig, shell, _) = stepped_rig(processes.clone(), |config| {
        windows_powershell(config);
        config.skill_runtime = Some(rt.clone());
    });
    shell.call(&ctx(&rig, "l1"), serde_json::json!({"command": "echo hi"})).await.unwrap();
    let data = rig.dir.path().join("data");
    let dir = skill_launcher_dir(&rt, &data.to_string_lossy());
    for file in case["files"].as_array().unwrap() {
        let written = std::fs::read_to_string(std::path::Path::new(&dir).join(file["name"].as_str().unwrap())).unwrap();
        assert_eq!(written, file["content"].as_str().unwrap());
    }
    let (_, env, _) = processes.spawned.lock().unwrap()[0].clone();
    let path = env.set.iter().find(|(k, _)| k.eq_ignore_ascii_case("PATH")).map(|(_, v)| v.clone()).unwrap();
    assert_eq!(path.split(';').next(), Some(dir.as_str()));
}

/// `script-transport.slow.test.mjs`: a pipeline nested in a group (or behind a script block) gets no filter tee; a plain
/// trailing filter pipeline does.
#[test]
fn filter_tee_plans_are_made_for_the_pipelines_node_plans() {
    for case in scenario("filter-plan-groups")["cases"].as_array().unwrap() {
        let command = case["command"].as_str().unwrap();
        let plan = super::super::invocation::build_powershell_filter_tee_plan(command, "0123abcd", "C:\\t", '\\');
        assert_eq!(JsonValue::from(plan.is_some()), case["planned"], "{command}");
    }
}

/// `display-command.test.mjs`: a piped PowerShell command started in the background runs wrapped (the producer-exit tee) and
/// its task is labelled with the caller's text.
#[tokio::test]
async fn a_wrapped_powershell_pipeline_keeps_the_callers_text_as_its_label() {
    let case = scenario("display-command");
    let processes = Stepped::quiet();
    let (rig, shell, _) = stepped_rig(processes.clone(), windows_powershell);
    let command = case["command"].as_str().unwrap();
    shell.call(&ctx(&rig, "d1"), serde_json::json!({"command": command, "background": true})).await.unwrap();
    assert_eq!(JsonValue::from(processes.script(0).contains("__mixdogProducerExit")), case["wrapped"]);
    let shown = rig.runtime.get(&ThreadId::from("t"), "task-d1").unwrap().render(false, None);
    let label = format!("label: {}", case["displayCommand"].as_str().unwrap());
    assert!(shown.lines().any(|line| line == label), "{shown}");
    processes.exit("task-d1", ExitStatus::Code(0), None);
}

/// `failure-taxonomy.test.mjs` 'WMIC rewrite note follows the leading shell failure marker': a wmic query rewritten to
/// PowerShell that exits 1 with no output answers Node's text, under the rewrite's hard 30 s limit.
#[tokio::test]
async fn a_failed_wmic_rewrite_answers_nodes_text_with_the_note_after_the_status() {
    let case = scenario("wmic-note");
    let processes = Stepped::new(|_| vec![(None, Vec::new(), 1)]);
    let (rig, shell, _) = stepped_rig(processes.clone(), windows_powershell);
    let text = body(shell.call(&ctx(&rig, "w1"), serde_json::json!({"command": case["command"]})).await);
    assert_eq!(text, case["result"].as_str().unwrap());
    assert!(processes.script(0).ends_with(case["ran"].as_str().unwrap()), "{}", processes.script(0));
    let limit = processes.spawned.lock().unwrap()[0].2;
    assert_eq!(limit, Some(std::time::Duration::from_millis(case["timeoutMs"].as_u64().unwrap())));
}

/// `script-transport.slow.test.mjs`: an oversized PowerShell body with non-ASCII text, non-ASCII output and a plain exit run
/// live through the tool on pwsh answer Node's text.
#[cfg(windows)]
#[tokio::test]
async fn live_powershell_runs_answer_nodes_text() {
    let mut rig = real_rig();
    let mut config = rig.runtime.config.clone_for_test();
    config.windows = true;
    config.powershell = true;
    config.shell = Arc::new(FixedShell("pwsh.exe".into()));
    rig.runtime = ExecRuntime::new(config);
    let shell = ShellTool::new(rig.runtime.clone());
    for (n, case) in scenario("powershell-live")["cases"].as_array().unwrap().iter().enumerate() {
        let command = case["command"].as_str().unwrap();
        let input = serde_json::json!({"command": command, "timeout_ms": 10_000});
        let text = body(shell.call(&ctx(&rig, &format!("p{n}")), input).await);
        assert_eq!(text, case["result"].as_str().unwrap(), "{command}");
    }
}

/// `script-transport.slow.test.mjs` 'command text reaches the shell byte-identical': each body run live on bash through the
/// tool's bash transport (the command in the environment, evaluated by the shell) exits 0 with the output Node's run of the
/// same body printed. Recorded on Git Bash; the tool's bash transport is the non-Windows one, so `windows` is off.
#[cfg(windows)]
#[tokio::test]
async fn bash_bodies_reach_the_shell_byte_identical_as_in_node() {
    let case = scenario("bash-byte-identity");
    let mut rig = real_rig();
    let mut config = rig.runtime.config.clone_for_test();
    config.shell = Arc::new(FixedShell(case["shell"].as_str().unwrap().into()));
    rig.runtime = ExecRuntime::new(config);
    let shell = ShellTool::new(rig.runtime.clone());
    for (n, run) in case["cases"].as_array().unwrap().iter().enumerate() {
        let command = run["command"].as_str().unwrap();
        let text = body(shell.call(&ctx(&rig, &format!("b{n}")), serde_json::json!({"command": command})).await);
        // Node's case runs below the tool (execShellCommand); the tool's `cat` note is not part of what the shell printed.
        let text = text.replacen(&format!("\n{}", super::super::guard::SHELL_FILE_READ_NOTE), "", 1);
        let expected = format!("[exit code: {}]\n\n{}", run["exitCode"], run["stdout"].as_str().unwrap());
        assert_eq!(text, expected, "{command}");
    }
}

/// `integration.live.test.mjs`, all three tests: the findstr miss, the failed producer under a filter and `git diff --quiet`
/// in a dirty repo, run live through the tool on pwsh, answer Node's whole text.
#[cfg(windows)]
#[tokio::test]
async fn live_integration_runs_answer_nodes_text() {
    let mut rig = real_rig();
    let mut config = rig.runtime.config.clone_for_test();
    config.windows = true;
    config.powershell = true;
    config.shell = Arc::new(FixedShell("pwsh.exe".into()));
    rig.runtime = ExecRuntime::new(config);
    let shell = ShellTool::new(rig.runtime.clone());
    // The repo the recorder built: one commit of `one\n`, then the file changed to `two\n`.
    let repo = rig.dir.path().join("repo");
    std::fs::create_dir(&repo).unwrap();
    let git = |args: &[&str]| {
        let status = std::process::Command::new("git").arg("-C").arg(&repo).args(args).output().unwrap().status;
        assert!(status.success(), "git {args:?}");
    };
    git(&["init", "-q"]);
    git(&["config", "user.email", "t@t"]);
    git(&["config", "user.name", "t"]);
    git(&["config", "core.autocrlf", "false"]);
    std::fs::write(repo.join("f.txt"), "one\n").unwrap();
    git(&["add", "-A"]);
    git(&["commit", "-q", "-m", "init"]);
    std::fs::write(repo.join("f.txt"), "two\n").unwrap();
    for (n, case) in scenario("integration-live")["cases"].as_array().unwrap().iter().enumerate() {
        let mut call = ctx(&rig, &format!("i{n}"));
        if case["inRepo"] == true {
            call.cwd = AbsPath::new(&repo).unwrap();
        }
        let text = body(shell.call(&call, case["input"].clone()).await);
        assert_eq!(text, case["result"].as_str().unwrap(), "{}", case["input"]);
    }
}

/// `shell-output-silence.test.mjs`: a running background task's silence warning at each recorded read, output on stderr
/// alone resetting the clock.
#[tokio::test]
async fn the_silence_warning_follows_output_on_either_stream_as_in_node() {
    let case = scenario("output-silence");
    const MIN: u64 = 60_000;
    let processes = Stepped::quiet();
    let (rig, shell, clock) = stepped_rig(processes.clone(), |_| {});
    let base = golden_ms();
    // Node's threshold in the recording is its default (the agent stall budget), the one Rust reads with no override.
    assert_eq!(case["warnMs"].as_u64(), Some(10 * MIN));
    shell.call(&ctx(&rig, "s1"), serde_json::json!({"command": "slow test", "background": true})).await.unwrap();
    let job = rig.runtime.get(&ThreadId::from("t"), "task-s1").unwrap();
    for step in case["steps"].as_array().unwrap() {
        if let Some(stream) = step["output"].as_str() {
            clock.store(base + step["minute"].as_u64().unwrap() * MIN, SeqCst);
            let stream = if stream == "stderr" { OutputStream::Stderr } else { OutputStream::Stdout };
            processes.output("task-s1", stream, b"x\n").await;
        } else {
            let at = base + step["read"].as_u64().unwrap() * MIN;
            assert_eq!(job.silence_note(at).map(JsonValue::from).unwrap_or(JsonValue::Null), step["note"], "{step}");
        }
    }
    processes.exit("task-s1", ExitStatus::Code(0), None);
}
