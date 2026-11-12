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

/// Set in the process [`in_own_process`] starts.
const OWN_PROCESS: &str = "MIXDOG_EXEC_TEST_OWN_PROCESS";

/// A test that replaces or edits the whole process environment (the shell tool reads it as Node's `process.env`, so the
/// tests of its end are written against it) runs in a process of its own: its edits would otherwise reach the tests that run
/// beside it on the other threads of this binary (a temp dir under the Windows folder, no `PATH`, no `SystemRoot`). The
/// caller's process is left untouched; this re-runs the test in the binary and fails with what the run printed. Whether the
/// test is to run its body here. The run's own waits carry their deadlines (`until`, the tests' paused clocks).
fn in_own_process(test: &str) -> bool {
    if std::env::var_os(OWN_PROCESS).is_some() {
        return true;
    }
    let mut run = std::process::Command::new(std::env::current_exe().unwrap());
    run.args([test, "--exact", "--nocapture", "--test-threads=1"]).env(OWN_PROCESS, "1");
    #[cfg(windows)]
    std::os::windows::process::CommandExt::creation_flags(&mut run, 0x0800_0000);
    let out = run.output().unwrap();
    // A filter that matches nothing (a renamed test) exits successfully without running the body.
    assert!(
        String::from_utf8_lossy(&out.stdout).lines().any(|line| line == "running 1 test"),
        "{test} in a process of its own: the child did not run exactly that one test\n{}",
        String::from_utf8_lossy(&out.stdout)
    );
    assert!(
        out.status.success(),
        "{test} in a process of its own: {}\n{}\n{}",
        out.status,
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    false
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
    /// When each spawn happened (the test clock).
    spawned_at: Mutex<Vec<tokio::time::Instant>>,
    answer: Box<dyn Fn(&CommandSpec) -> Vec<(Option<OutputStream>, Vec<u8>, i32)> + Send + Sync>,
    kill_ends: std::sync::atomic::AtomicBool,
    /// Whether a spawn's run limit ends it (the process manager's own limit) when it expires.
    limits: std::sync::atomic::AtomicBool,
    /// The PowerShell processes still waiting for their script (`index` into `spawned`, run limit): the script arrives on
    /// stdin, framed, to the bootstrap the spawn names, so what ran is only known once it is written.
    awaiting: Mutex<HashMap<ProcessHandle, (usize, Option<std::time::Duration>)>>,
    /// Every process that took its script on stdin: its input may be closed.
    fed: Mutex<std::collections::HashSet<ProcessHandle>>,
}

impl Stepped {
    /// `answer`: the events a spawn emits at once, each `(Some(stream), bytes, _)` an output and `(None, _, code)` the exit.
    fn new(answer: impl Fn(&CommandSpec) -> Vec<(Option<OutputStream>, Vec<u8>, i32)> + Send + Sync + 'static) -> Arc<Self> {
        Arc::new(Self {
            runs: Mutex::default(),
            sources: Mutex::default(),
            spawned: Mutex::default(),
            spawned_at: Mutex::default(),
            answer: Box::new(answer),
            kill_ends: std::sync::atomic::AtomicBool::new(true),
            limits: std::sync::atomic::AtomicBool::new(false),
            awaiting: Mutex::default(),
            fed: Mutex::default(),
        })
    }

    /// The process `handle` starts running `command`: what `answer` makes of it is sent, and a run limit ends it when it expires.
    fn begin(&self, handle: &ProcessHandle, command: &CommandSpec, limit: Option<std::time::Duration>) {
        let events = (self.answer)(command);
        let mut runs = self.runs.lock().unwrap();
        let run = runs.get_mut(handle).unwrap();
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
        if let (true, Some(limit)) = (self.limits.load(SeqCst), limit) {
            let (events, seq) = (run.events.clone(), run.seq);
            tokio::spawn(async move {
                tokio::time::sleep(limit).await;
                let exit = ProcessExit { status: ExitStatus::Signal(9), killed: Some(KillReason::TimeLimit) };
                let _ = events.send(ProcessEvent::Exited { seq, exit });
            });
        }
    }

    fn quiet() -> Arc<Self> {
        Self::new(|_| Vec::new())
    }

    fn emit(&self, handle: &str, event: impl FnOnce(u64) -> ProcessEvent) -> u64 {
        let mut runs = self.runs.lock().unwrap();
        let run = runs.get_mut(&ProcessHandle(handle.to_owned())).unwrap();
        // A run whose job already took its exit has no reader left.
        let _ = run.events.send(event(run.seq));
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
        let index = {
            let mut spawned = self.spawned.lock().unwrap();
            spawned.push((request.command.clone(), request.env.clone(), request.time_limit));
            spawned.len() - 1
        };
        self.spawned_at.lock().unwrap().push(tokio::time::Instant::now());
        self.runs.lock().unwrap().insert(request.handle.clone(), Run { events: tx, seq: 0, pulled });
        self.sources.lock().unwrap().insert(request.handle.clone(), PullSource { events: rx, pulled: pulled_tx });
        match &request.command {
            CommandSpec::Shell { script, .. } if script == crate::exec::POWERSHELL_BOOTSTRAP => {
                self.awaiting.lock().unwrap().insert(request.handle.clone(), (index, request.time_limit));
            }
            command => self.begin(&request.handle, command, request.time_limit),
        }
        Ok(SpawnedProcess { handle: request.handle, pid: 1 })
    }

    fn subscribe(&self, handle: &ProcessHandle, _: Option<u64>) -> Result<Box<dyn EventSource<ProcessEvent>>, ProcessError> {
        let source = self.sources.lock().unwrap().remove(handle).ok_or(ProcessError::UnknownHandle)?;
        Ok(Box::new(source))
    }

    /// The script of a PowerShell process arrives framed (its length, a line break, the script); what ran is the script, which
    /// replaces the bootstrap in the spawn's record, and the process starts as the answer says.
    async fn write_stdin(&self, handle: &ProcessHandle, bytes: Vec<u8>) -> Result<(), ProcessError> {
        let Some((index, limit)) = self.awaiting.lock().unwrap().remove(handle) else { return Err(ProcessError::StdinClosed) };
        let framed = String::from_utf8(bytes).unwrap();
        let script = framed.split_once('\n').expect("a framed script").1.to_owned();
        let command = {
            let mut spawned = self.spawned.lock().unwrap();
            let CommandSpec::Shell { shell, .. } = spawned[index].0.clone() else { unreachable!("a bootstrap spawn is a shell command") };
            spawned[index].0 = CommandSpec::Shell { script, shell };
            spawned[index].0.clone()
        };
        self.fed.lock().unwrap().insert(handle.clone());
        self.begin(handle, &command, limit);
        Ok(())
    }
    fn close_stdin(&self, handle: &ProcessHandle) -> Result<(), ProcessError> {
        if self.fed.lock().unwrap().contains(handle) { Ok(()) } else { Err(ProcessError::StdinClosed) }
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
    if !in_own_process("exec::tests::node_cases::the_shell_env_is_nodes_whole_env_for_each_daemon_env") {
        return;
    }
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

/// `script-transport.slow.test.mjs`' two filter-plan tests through the tool on Windows PowerShell: each command runs as Node's
/// whole script (a pipeline nested in a group without the producer-exit tee, a trailing filter pipeline with it) and answers
/// Node's text for a clean exit.
#[tokio::test]
async fn filter_pipelines_run_as_nodes_whole_script() {
    let case = scenario("filter-plan");
    let processes = Stepped::new(|_| vec![(None, Vec::new(), 0)]);
    let (rig, shell, _) = stepped_rig(processes.clone(), |config| {
        windows_powershell(config);
        config.skill_runtime = Some(recorded_skill_runtime());
    });
    for (n, run) in case["cases"].as_array().unwrap().iter().enumerate() {
        let command = run["command"].as_str().unwrap();
        let text = body(shell.call(&ctx(&rig, &format!("f{n}")), serde_json::json!({"command": command})).await);
        let ran = inline_neutral(&tee_neutral(&processes.script(n)));
        assert_eq!(ran, inline_neutral(&tee_neutral(run["ran"].as_str().unwrap())), "{command}");
        assert_eq!(text, run["result"].as_str().unwrap(), "{command}");
    }
}

/// A hoisted file's path (`<dir>/mixdog-inline-<id>`, either slash form, in whatever dir the run used).
fn hoisted_file() -> regex::Regex {
    regex::Regex::new(r#"[A-Za-z]:[\\/][^"'\s]*?mixdog-inline-[0-9a-f-]+"#).unwrap()
}

/// `text` with each hoisted file's path, up to its extension, as `<FILE>`.
fn inline_neutral(text: &str) -> String {
    hoisted_file().replace_all(text, "<FILE>").into_owned()
}

/// A command line as its words (double quotes group and are dropped).
fn words(text: &str) -> Vec<String> {
    regex::Regex::new(r#""([^"]*)"|(\S+)"#).unwrap().captures_iter(text).map(|c| c.get(1).or(c.get(2)).unwrap().as_str().to_owned()).collect()
}

/// `script-transport.slow.test.mjs`' two file-transport tests through the tool: each long inline command (and the short one
/// that stays inline; the oversized PowerShell bodies are a named difference) runs as Node's whole text on Node's platform and
/// shell, from a hoisted file holding Node's text, and answers Node's text. On Node's `linux` the bash transport carries the
/// command in the environment, so that is the text compared.
#[tokio::test]
async fn long_commands_run_from_nodes_hoisted_files() {
    for name in ["script-file-transport", "script-file-transport-linux"] {
        let case = scenario(name);
        let linux = case["platform"] == "linux";
        for (n, run) in case["cases"].as_array().unwrap().iter().enumerate() {
            let files = Arc::new(Mutex::new(Vec::new()));
            let processes = {
                let files = files.clone();
                Stepped::new(move |spec| {
                    let text = match spec {
                        CommandSpec::Shell { script, .. } => script.clone(),
                        CommandSpec::Argv { program, args } => format!("{program} {}", args.join(" ")),
                    };
                    let file = hoisted_file().find(&text).map(|path| {
                        let ext = regex::Regex::new(r"^\.\w+").unwrap().find(&text[path.end()..]).unwrap();
                        std::fs::read_to_string(path.as_str().to_owned() + ext.as_str()).unwrap()
                    });
                    files.lock().unwrap().push(file);
                    vec![(None, Vec::new(), 0)]
                })
            };
            let powershell = run["spec"] == "powershell";
            let (rig, shell, _) = stepped_rig(processes.clone(), |config| {
                if powershell {
                    windows_powershell(config);
                    config.skill_runtime = Some(recorded_skill_runtime());
                } else if linux {
                    config.shell = Arc::new(FixedShell("/bin/bash".into()));
                } else {
                    config.windows = true;
                }
            });
            let command = run["command"].as_str().unwrap();
            let call_ctx = ctx(&rig, &format!("h{n}"));
            let call = shell.call(&call_ctx, serde_json::json!({"command": command}));
            let text = body(until(&format!("{name} {n}: the call"), call).await);
            let (spec, env, _) = processes.spawned.lock().unwrap()[0].clone();
            let want = run["ran"].as_str().unwrap();
            match spec {
                // Rust starts a lone `node <file>` itself (no shell between): the program's name and its arguments are
                // Node's command words.
                CommandSpec::Argv { program, args } => {
                    let stem = std::path::Path::new(&program).file_stem().unwrap().to_string_lossy().into_owned();
                    let got: Vec<String> = std::iter::once(stem).chain(args).map(|w| inline_neutral(&w)).collect();
                    assert_eq!(got, words(want), "{name} {n}");
                }
                CommandSpec::Shell { script, .. } => {
                    let ran = if linux { env.set.iter().find(|(k, _)| k == "MIXDOG_SHELL_SCRIPT").unwrap().1.clone() } else { script };
                    assert_eq!(inline_neutral(&ran), want, "{name} {n}");
                }
            }
            // Node records `null` for a run that hoisted nothing.
            assert_eq!(files.lock().unwrap()[0].as_deref(), run["file"].as_str(), "{name} {n}");
            assert_eq!(text, run["result"].as_str().unwrap(), "{name} {n}");
        }
    }
}

/// `deadline-plan.test.mjs`, every recorded plan through the tool (a quiet process the manager ends at its run limit). Each of
/// Node's fields is checked against what the tool does with the call: the run limit the spawn carries is `backgroundDeadlineMs`
/// (with background tasks on) or `timeout` (off), and `timeout + promotedTimeoutMs` when a deadline is split; the call ends
/// at `autoBackgroundMs` moved to the background when that comes before the foreground `timeout`, else at `timeout`,
/// promoted as `promoteAtTimeout` says; with neither it never ends on its own.
#[tokio::test(start_paused = true)]
async fn every_deadline_plan_is_what_the_tool_does_with_the_call() {
    if !in_own_process("exec::tests::node_cases::every_deadline_plan_is_what_the_tool_does_with_the_call") {
        return;
    }
    const VARS: [&str; 3] = ["MIXDOG_SHELL_AUTO_BACKGROUND_MS", "BASH_MAX_TIMEOUT_MS", "MIXDOG_SHELL_BACKGROUND_MAX_MS"];
    const NEVER: std::time::Duration = std::time::Duration::from_secs(30 * 24 * 3600);
    for (n, case) in scenario("deadline-plan")["cases"].as_array().unwrap().iter().enumerate() {
        for name in VARS {
            // SAFETY: the test runner (nextest) runs each test in a process of its own; nothing else reads the environment.
            match case["env"][name].as_str() {
                Some(value) => unsafe { std::env::set_var(name, value) },
                None => unsafe { std::env::remove_var(name) },
            }
        }
        let background = case["backgroundOnTimeout"].as_bool().unwrap();
        // SAFETY: as above.
        unsafe { std::env::set_var("MIXDOG_SHELL_DISABLE_BACKGROUND_TASKS", if background { "0" } else { "1" }) };
        let processes = Stepped::quiet();
        processes.limits.store(true, SeqCst);
        let (rig, shell, _) = stepped_rig(processes.clone(), |_| {});
        let mut input = case["args"].clone();
        input["command"] = "make".into();
        let ended = tokio::time::timeout(NEVER, shell.call(&ctx(&rig, &format!("d{n}")), input)).await.ok().map(body);
        let at = (tokio::time::Instant::now() - processes.spawned_at.lock().unwrap()[0]).as_millis() as u64;
        let limit = processes.spawned.lock().unwrap()[0].2.map_or(0, |d| d.as_millis() as u64);
        let got = serde_json::json!({
            "limit": limit,
            "endsAt": if ended.is_some() { at } else { 0 },
            "promoted": ended.as_deref().is_some_and(|t| t.starts_with("background task\n")),
        });
        let plan = &case["plan"];
        let num = |k: &str| plan[k].as_u64().unwrap();
        let (hold, foreground, promote) = (num("autoBackgroundMs"), num("timeout"), plan["promoteAtTimeout"] == true);
        let (ends_at, promoted) = if hold > 0 && (foreground == 0 || hold < foreground) {
            (hold, true)
        } else if foreground > 0 {
            (foreground, promote)
        } else {
            (0, false)
        };
        let deadline = if background { num("backgroundDeadlineMs") } else { foreground };
        let want = serde_json::json!({"limit": deadline, "endsAt": ends_at, "promoted": promoted});
        assert_eq!(got, want, "{case}");
        if num("promotedTimeoutMs") > 0 {
            assert_eq!(limit, foreground + num("promotedTimeoutMs"), "{case}");
        }
        let _ = rig.manager.kill(&ProcessHandle(format!("task-d{n}")));
    }
}

/// `failure-taxonomy.test.mjs` 'shell failure rendering preserves actual signals and runtime kill causes': each process end the
/// Rust process manager can report (a signal death, a cancelled run, an expired run limit) answers Node's whole text.
#[tokio::test(start_paused = true)]
async fn each_process_end_answers_nodes_failure_text() {
    for case in scenario("failure-status")["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let processes = Stepped::quiet();
        processes.kill_ends.store(false, SeqCst);
        let (rig, shell, _) = stepped_rig(processes.clone(), windows_powershell);
        let c = ctx(&rig, name);
        let id = format!("task-{name}");
        let end = |status, killed| {
            let processes = processes.clone();
            let id = id.clone();
            async move {
                until("spawn", async { while processes.spawned.lock().unwrap().is_empty() { tokio::task::yield_now().await } }).await;
                processes.exit(&id, status, killed);
            }
        };
        let (call, cancel) = (shell.call(&c, serde_json::json!({"command": "x", "timeout_ms": 500})), c.cancel.clone());
        let text = match name {
            "signal" => tokio::join!(call, end(ExitStatus::Signal(9), None)).0,
            "cancellation" => {
                let ended = end(ExitStatus::Signal(15), Some(KillReason::Requested));
                tokio::join!(call, async move {
                    cancel.cancel();
                    ended.await;
                })
                .0
            }
            "timeout" => tokio::join!(call, end(ExitStatus::Signal(15), Some(KillReason::TimeLimit))).0,
            _ => continue,
        };
        assert_eq!(body(text), case["result"].as_str().unwrap(), "{name}");
    }
}

/// Polls `check` until it holds, waiting real time between tries (file cleanup runs on the blocking pool).
async fn eventually(what: &str, check: impl Fn() -> bool) {
    for _ in 0..500 {
        if check() {
            return;
        }
        tokio::task::spawn_blocking(|| std::thread::sleep(std::time::Duration::from_millis(10))).await.unwrap();
    }
    panic!("{what}: not within 5 s");
}

/// The tee path a PowerShell filter script writes (`Tee-Object -FilePath '<path>'`).
fn tee_file(spec: &CommandSpec) -> Option<String> {
    let CommandSpec::Shell { script, .. } = spec else { return None };
    script.split("-FilePath '").nth(1).and_then(|rest| rest.split('\'').next()).map(str::to_owned)
}

/// `queued-tee-lifecycle.test.mjs`: a command moved to the background (Node's queued run) keeps its tee capture while it runs
/// and gives it up once it settled.
#[tokio::test(start_paused = true)]
async fn a_backgrounded_runs_tee_lives_until_it_settles() {
    let case = scenario("queued-tee");
    let paths = Arc::new(Mutex::new(Vec::new()));
    let processes = {
        let paths = paths.clone();
        Stepped::new(move |spec| {
            let path = tee_file(spec).unwrap();
            std::fs::write(&path, "queued producer output").unwrap();
            paths.lock().unwrap().push(path);
            Vec::new()
        })
    };
    let (rig, shell, _) = stepped_rig(processes.clone(), windows_powershell);
    let text = body(shell.call(&ctx(&rig, "q1"), serde_json::json!({"command": case["command"], "background": true})).await);
    assert!(text.starts_with("background task\n"), "{text}");
    tokio::time::sleep(std::time::Duration::from_secs(10)).await;
    let path = std::path::PathBuf::from(paths.lock().unwrap()[0].clone());
    let kept = path.exists();
    processes.exit("task-q1", ExitStatus::Code(1), None);
    eventually("the tee to go", || !path.exists()).await;
    let got = serde_json::json!({"command": case["command"], "keptWhileRunning": kept, "keptAfterSettle": path.exists()});
    assert_eq!(got, serde_json::json!({"command": case["command"], "keptWhileRunning": case["keptWhileRunning"], "keptAfterSettle": case["keptAfterSettle"]}));
}

/// `guardians-background.slow.test.mjs` 'a promoted non-zero command reports one consistent status on every surface': each
/// end of a promoted `npm test` the Rust process manager can report notifies Node's whole completion, with Node's task status.
#[tokio::test(start_paused = true)]
async fn a_promoted_commands_end_notifies_nodes_completion() {
    for case in scenario("status-surfaces")["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let end = match name {
            "nonzero" => Some((ExitStatus::Code(3), None)),
            "signal" => Some((ExitStatus::Signal(11), None)),
            "timed-out" => Some((ExitStatus::Signal(9), Some(KillReason::TimeLimit))),
            "running" => None,
            _ => continue,
        };
        let processes = Stepped::quiet();
        let (rig, shell, clock) = stepped_rig(processes.clone(), |_| {});
        let seen = Arc::new(Mutex::new(Vec::new()));
        let mut c = ctx(&rig, "s1");
        c.options.notify = {
            let seen = seen.clone();
            Some(ToolNotify(Arc::new(move |text: &str, meta: &JsonValue| {
                seen.lock().unwrap().push((text.to_owned(), meta.clone()));
                true
            })))
        };
        shell.call(&c, serde_json::json!({"command": "npm test", "background": true})).await.unwrap();
        processes.output("task-s1", OutputStream::Stdout, b"running tests").await;
        processes.output("task-s1", OutputStream::Stderr, b"3 failing").await;
        let Some((status, killed)) = end else {
            let listed = body(rig.task.call(&ctx(&rig, "l1"), serde_json::json!({"action": "list"})).await);
            assert!(listed.lines().any(|l| l.starts_with("- task-s1 shell/shell ") && l.split(' ').nth(3) == case["taskStatus"].as_str()), "{listed}");
            processes.exit("task-s1", ExitStatus::Code(0), None);
            continue;
        };
        clock.store(golden_ms() + 1500, SeqCst);
        processes.exit("task-s1", status, killed);
        let spill = rig.runtime.config.spill_dir.to_string_lossy().into_owned();
        until("the completion", async { while seen.lock().unwrap().is_empty() { tokio::task::yield_now().await } }).await;
        let (text, meta) = seen.lock().unwrap()[0].clone();
        let completion = &case["completion"];
        // The capture path in either slash form (Rust writes `/`, Node's `path.join` `\`): both name the same file.
        let want = completion["body"].as_str().unwrap().replace("<L>\\", "<L>/");
        assert_eq!(text.replace(&spill.replace('\\', "/"), "<L>").replace(&spill, "<L>"), want, "{name}");
        assert_eq!(meta["status"], completion["taskStatus"], "{name}");
    }
}

/// `{started: …}` and `{logs: …}` of a task block as placeholders (the live run's clock and its capture path).
fn task_block_neutral(text: &str) -> String {
    let started = regex::Regex::new(r"(?m)^started: .*$").unwrap();
    let logs = regex::Regex::new(r"(?m)^logs: .*$").unwrap();
    logs.replace_all(&started.replace_all(text, "started: <T>"), "logs: <LOGS>").into_owned()
}

fn live_pwsh() -> (Rig, ShellTool, TaskTool) {
    let mut rig = real_rig();
    let mut config = rig.runtime.config.clone_for_test();
    config.windows = true;
    config.powershell = true;
    config.shell = Arc::new(FixedShell("pwsh.exe".into()));
    // A live run's elapsed time is the wall clock's.
    config.now_ms = Arc::new(|| std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64);
    rig.runtime = ExecRuntime::new(config);
    let (shell, task) = (ShellTool::new(rig.runtime.clone()), TaskTool::new(rig.runtime.clone()));
    (rig, shell, task)
}

/// `guardians-background.slow.test.mjs`, the pwsh entry of the two descendant tests and 'a finished command that left
/// descendants is tracked and cancelled through the task tool', live with the process layer's survivor watch: the detaching
/// command answers Node's warning and task block (the live ping output after it is not compared: its count of replies is
/// timing), `task cancel` on it and the command whose descendants all exit answer Node's whole text.
#[cfg(windows)]
#[tokio::test]
async fn live_descendants_are_tracked_and_cancelled_as_in_node() {
    let case = scenario("descendants-live");
    let mut rig = rig();
    let tokens = mixdog_rt::testing::tokens();
    let manager = mixdog_spawn::LocalProcessManager::new(tokens.spawn_io, mixdog_spawn::ProcessConfig::default());
    rig.manager = Arc::new(manager.clone());
    let mut config = rig.runtime.config.clone_for_test();
    config.windows = true;
    config.powershell = true;
    config.shell = Arc::new(FixedShell("pwsh.exe".into()));
    config.survivors = Some(Arc::new(mixdog_spawn::survivors::ProcessSurvivors::new(manager)));
    rig.runtime = ExecRuntime::new(config);
    let (shell, task) = (ShellTool::new(rig.runtime.clone()), TaskTool::new(rig.runtime.clone()));
    let left = body(shell.call(&ctx(&rig, "v1"), serde_json::json!({"command": case["detaching"]})).await);
    let id = regex::Regex::new(r"(?m)^task_id: (\S+)$").unwrap().captures(&left).map(|c| c[1].to_owned()).unwrap_or_else(|| panic!("{left}"));
    let head = |text: &str| task_block_neutral(text).split_once("started: <T>").map(|(h, _)| h.to_owned()).unwrap();
    assert_eq!(head(&left.replace(&id, "<ID>")), head(case["left"].as_str().unwrap()));
    let cancelled = body(task.call(&ctx(&rig, "v2"), serde_json::json!({"action": "cancel", "task_id": id})).await);
    assert_eq!(cancelled.replace(&id, "<ID>"), case["cancelled"].as_str().unwrap());
}

/// `guardians-background.slow.test.mjs` 'a real auto-backgrounded command leaves through the background result path': the
/// test's command live on pwsh with the recorded hold answers Node's background text (task id, start time, log path and the
/// elapsed seconds as placeholders).
#[cfg(windows)]
#[tokio::test]
async fn a_live_command_past_its_hold_answers_nodes_background_text() {
    if !in_own_process("exec::tests::node_cases::a_live_command_past_its_hold_answers_nodes_background_text") {
        return;
    }
    let case = scenario("auto-background-live");
    // SAFETY: the test runner (nextest) runs each test in a process of its own.
    unsafe { std::env::set_var("MIXDOG_SHELL_AUTO_BACKGROUND_MS", case["holdMs"].to_string()) };
    let (rig, shell, task) = live_pwsh();
    let text = body(shell.call(&ctx(&rig, "g1"), serde_json::json!({"command": case["command"]})).await);
    task.call(&ctx(&rig, "g2"), serde_json::json!({"action": "cancel", "task_id": "task-g1"})).await.unwrap();
    let neutral = |text: &str| {
        let secs = regex::Regex::new(r"after the \d+s hold").unwrap();
        secs.replace(&task_block_neutral(text), "after the <N>s hold").into_owned()
    };
    assert_eq!(neutral(&text.replace("task-g1", "<ID>")), neutral(case["result"].as_str().unwrap()));
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
