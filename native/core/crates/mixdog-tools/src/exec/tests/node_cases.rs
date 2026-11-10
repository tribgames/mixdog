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
    rig.task = TaskTool::new(rig.runtime.clone());
    let shell = ShellTool::new(rig.runtime.clone());
    (rig, shell, clock)
}

fn windows_powershell(config: &mut ExecConfig) {
    config.windows = true;
    config.powershell = true;
    config.shell = Arc::new(FixedShell("powershell.exe".into()));
}

/// The skill runtime Node's recorder ran under (`spawn-env`), the one its launchers and skill function name.
fn recorded_skill_runtime() -> SkillRuntime {
    let runtime = &scenario("spawn-env")["runtime"];
    SkillRuntime {
        platform: runtime["platform"].as_str().unwrap().into(),
        interpreter: runtime["interpreter"].as_str().unwrap().into(),
        entry: runtime["entry"].as_str().unwrap().into(),
        electron: runtime["electron"].as_bool().unwrap(),
    }
}

/// `bash-tool-cwd-env.test.mjs`, both tests through the tool: with the daemon env replaced by each recorded one, a run in the
/// test's cwd hands the shell Node's whole env (the daemon env minus what is removed, plus what is set), leaves the daemon env
/// as it was, and writes Node's launchers. `<WORK>` in the recording is this rig's directory.
#[cfg(windows)]
#[tokio::test]
async fn the_shell_env_is_nodes_whole_env_for_each_daemon_env() {
    let case = scenario("spawn-env");
    let processes = Stepped::new(|_| vec![(None, Vec::new(), 0)]);
    let (rig, shell, _) = stepped_rig(processes.clone(), |config| {
        windows_powershell(config);
        config.skill_runtime = Some(recorded_skill_runtime());
    });
    let work = rig.dir.path().to_string_lossy().into_owned();
    let at_work = |v: &JsonValue| -> JsonValue { serde_json::from_str(&v.to_string().replace("<WORK>", &work.replace('\\', "\\\\"))).unwrap() };
    for (n, run) in case["cases"].as_array().unwrap().iter().enumerate() {
        let base = at_work(&run["base"]);
        let base = base.as_object().unwrap();
        // SAFETY: the test runner (nextest) runs each test in a process of its own; nothing else reads the environment
        // while it is replaced.
        for (key, _) in std::env::vars_os() {
            unsafe { std::env::remove_var(key) };
        }
        for (key, value) in base {
            unsafe { std::env::set_var(key, value.as_str().unwrap()) };
        }
        let cwd = run["cwd"].as_array().unwrap().iter().fold(rig.dir.path().to_path_buf(), |p, s| p.join(s.as_str().unwrap()));
        std::fs::create_dir_all(&cwd).unwrap();
        let mut call = ctx(&rig, &format!("e{n}"));
        call.cwd = AbsPath::new(&cwd).unwrap();
        shell.call(&call, serde_json::json!({"command": "echo hi"})).await.unwrap();
        let (_, spec, _) = processes.spawned.lock().unwrap()[n].clone();
        assert!(spec.inherit);
        let mut env = base.clone();
        env.retain(|key, _| !spec.remove.contains(key));
        for (key, value) in &spec.set {
            env.insert(key.clone(), value.as_str().into());
        }
        assert_eq!(JsonValue::Object(env), at_work(&run["env"]), "case {n}");
        let after: serde_json::Map<String, JsonValue> = std::env::vars().map(|(k, v)| (k, v.into())).collect();
        assert_eq!(JsonValue::from(&after == base), run["daemonEnvKept"], "case {n}");
    }
    let dir = std::path::PathBuf::from(at_work(&case["dir"]).as_str().unwrap());
    let mut names: Vec<String> = std::fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
    names.sort();
    let files: Vec<JsonValue> = names
        .into_iter()
        .map(|name| serde_json::json!({ "name": name, "content": std::fs::read_to_string(dir.join(&name)).unwrap() }))
        .collect();
    assert_eq!(JsonValue::Array(files), case["files"]);
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

/// The producer-exit tee's random token as `<T>` and its file's directory (the host temp dir) as `<TMP>`.
fn tee_neutral(script: &str) -> String {
    let token = regex::Regex::new(r"__mixdogProducerExit([0-9A-Za-z]+)").unwrap();
    let Some(found) = token.captures(script) else { return script.to_owned() };
    let script = script.replace(&found[1], "<T>");
    regex::Regex::new(r"'[^']*mixdog-tee-<T>\.log'").unwrap().replace_all(&script, r"'<TMP>\mixdog-tee-<T>.log'").into_owned()
}

/// `display-command.test.mjs`: a piped PowerShell command started in the background runs as Node's whole wrapped script (the
/// producer-exit tee behind the UTF-8 preamble and skill function), and its task is labelled with the caller's text.
#[tokio::test]
async fn a_wrapped_powershell_pipeline_keeps_the_callers_text_as_its_label() {
    let case = scenario("display-command");
    let processes = Stepped::quiet();
    let (rig, shell, _) = stepped_rig(processes.clone(), |config| {
        windows_powershell(config);
        config.skill_runtime = Some(recorded_skill_runtime());
    });
    let command = case["command"].as_str().unwrap();
    shell.call(&ctx(&rig, "d1"), serde_json::json!({"command": command, "background": true})).await.unwrap();
    assert_eq!(tee_neutral(&processes.script(0)), tee_neutral(case["ran"].as_str().unwrap()));
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

/// `shell-output-silence.test.mjs`, its first two tests, each on a background job of its own: at each recorded step the
/// silence note is the `task list` entry of the job (absent for Node's null; a list consumes no output), and the progress
/// digest is the body of a `task wait` on it (the text between the task header and the wait-ceiling note).
#[tokio::test(start_paused = true)]
async fn the_silence_warning_follows_output_on_either_stream_as_in_node() {
    let case = scenario("output-silence");
    const MIN: u64 = 60_000;
    let processes = Stepped::quiet();
    let (rig, shell, clock) = stepped_rig(processes.clone(), |_| {});
    let base = golden_ms();
    // Node's threshold in the recording is its default (the agent stall budget), the one Rust reads with no override.
    assert_eq!(case["warnMs"].as_u64(), Some(10 * MIN));
    for (n, job) in case["jobs"].as_array().unwrap().iter().enumerate() {
        clock.store(base, SeqCst);
        let call = format!("s{n}");
        let id = format!("task-{call}");
        shell.call(&ctx(&rig, &call), serde_json::json!({"command": "slow test", "background": true})).await.unwrap();
        for (k, step) in job["steps"].as_array().unwrap().iter().enumerate() {
            if let Some(stream) = step["output"].as_str() {
                clock.store(base + step["minute"].as_u64().unwrap() * MIN, SeqCst);
                let stream = if stream == "stderr" { OutputStream::Stderr } else { OutputStream::Stdout };
                processes.output(&id, stream, b"x\n").await;
                continue;
            }
            let at = step["note"].as_u64().or(step["digest"].as_u64()).unwrap();
            clock.store(base + at * MIN, SeqCst);
            let c = ctx(&rig, &format!("{call}-{k}"));
            let got = if step["note"].is_u64() {
                let listed = body(rig.task.call(&c, serde_json::json!({"action": "list"})).await);
                let entry = format!("- {id} ");
                listed
                    .split_once("[output silence]\n")
                    .and_then(|(_, quiet)| quiet.lines().find_map(|l| l.strip_prefix(&entry)))
                    .map_or(JsonValue::Null, JsonValue::from)
            } else {
                let waited = body(
                    rig.task.call(&c, serde_json::json!({"action": "wait", "task_id": id, "timeout_ms": 1000})).await,
                );
                let (_, rest) = waited.split_once("\n\n").unwrap_or_else(|| panic!("{waited}"));
                JsonValue::from(rest.rsplit_once("\n\nWait ceiling reached").map_or(rest, |(b, _)| b))
            };
            assert_eq!(got, step["text"], "{} step {k}", job["name"]);
        }
        processes.exit(&id, ExitStatus::Code(0), None);
    }
}
