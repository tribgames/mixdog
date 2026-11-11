//! Replay of Node's K1 recording `fixtures/git-launch-cases` (`record-git-launch-cases.mjs`, b6f10295a): the git the core starts,
//! the environment it starts it with, and its one retry when the resolved binary is gone, through the core's own entries
//! (`resolve_layout`, `launch_environment`, `launch_for`, `git_command`, `start_git`).
//!
//! Every recorded file tree is rebuilt in a fresh folder, written `<root-N>` (N: the recording's creation order) on both sides.
//! Where Node started processes, the core starts the recording's own stand-in (`git-standin.cs`, compiled with the .NET
//! Framework's csc as the recorder did) through its real process manager. Where Node's test scripted the start function, the
//! core's process manager is scripted the same way. A scenario whose recorded caller environment is not this process's runs in a
//! child of this test binary started with exactly that environment, as the git child would inherit it.
#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "the replay builds the recorded file trees, compiles the recording's stand-in and starts itself in the recorded environment")]

use std::os::windows::process::CommandExt;
use std::path::Path;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::OnceLock;
use std::time::Duration;

use async_trait::async_trait;
use mixdog_core_api::domain::common::EventSource;
use mixdog_core_api::domain::mock::VecSource;
use mixdog_core_api::domain::process::CommandSpec;
use mixdog_core_api::domain::process::EnvSpec;
use mixdog_core_api::domain::process::ExitStatus;
use mixdog_core_api::domain::process::ProcessError;
use mixdog_core_api::domain::process::ProcessEvent;
use mixdog_core_api::domain::process::ProcessExit;
use mixdog_core_api::domain::process::ProcessInfo;
use mixdog_core_api::domain::process::ProcessManager;
use mixdog_core_api::domain::process::PtySize;
use mixdog_core_api::domain::process::SpawnRequest;
use mixdog_core_api::domain::process::SpawnedProcess;
use mixdog_protocol::ProcessHandle;
use mixdog_testkit::Exact;
use serde_json::Value;
use serde_json::json;
use tokio_util::sync::CancellationToken;

use super::Env;
use super::Layout;
use super::git_command;
use super::launch_environment;
use super::launch_for;
use super::native_realpath;
use super::resolve_layout;
use crate::error::ScmFailure;
use crate::exec::Exec;
use crate::exec::ExecOutput;
use crate::exec::ExecSpec;
use crate::git::start_git;
use crate::testing::TestProcesses;

const GOLDEN: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/git-launch-cases/golden.json");
/// `git-standin.cs` of the recorder, from the checkout root four levels above this crate (csc reads no `..` in a path).
fn standin_source() -> std::path::PathBuf {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).ancestors().nth(4).expect("the checkout root");
    ["benchmarks", "rust-core", "recorders", "lib", "git-standin.cs"].iter().fold(root.to_path_buf(), |path, part| path.join(part))
}
/// What a child run of this binary reads from its cwd, and what it writes back there.
const SCENE: &str = "k1-git-launch-scene.json";
const RESULT: &str = "k1-git-launch-result.json";
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const CHILD_DEADLINE: Duration = Duration::from_secs(240);

/// The recorded case `index`, after checking it is the case `name`.
fn recorded(index: usize, name: &str) -> Exact {
    let golden = Exact::load(GOLDEN);
    let case = &golden.get("cases").as_array()[index];
    assert_eq!(case.get("case").as_str(), name, "case {index} of {GOLDEN}");
    case.get("observed").clone()
}

fn plain(value: &Exact) -> Value {
    value.to_plain().expect("a plain recorded value")
}

fn join(root: &str, parts: &[&str]) -> String {
    parts.iter().fold(Path::new(root).to_path_buf(), |path, part| path.join(part)).to_string_lossy().into_owned()
}

/// The temp roots of one case, in the recording's numbering.
#[derive(Default)]
struct Roots {
    dirs: Vec<tempfile::TempDir>,
    named: Vec<(String, String)>,
}

impl Roots {
    fn add(&mut self, number: usize) -> String {
        let dir = tempfile::Builder::new().prefix("mixdog-git-launch-").tempdir().expect("a temp root");
        let root = native_realpath(dir.path()).expect("the temp root's real path");
        self.named.push((root.clone(), format!("<root-{number}>")));
        self.dirs.push(dir);
        root
    }

    fn mask_text(&self, text: &str) -> String {
        self.named.iter().fold(text.to_owned(), |text, (root, marker)| text.replace(root, marker))
    }

    fn unmask(&self, text: &str) -> String {
        self.named.iter().fold(text.to_owned(), |text, (root, marker)| text.replace(marker, root))
    }

    fn mask(&self, value: &Exact) -> Exact {
        match value {
            Exact::String(text) => Exact::String(self.mask_text(text)),
            Exact::Array(items) => Exact::Array(items.iter().map(|item| self.mask(item)).collect()),
            Exact::Object(entries) => Exact::Object(entries.iter().map(|(key, item)| (key.clone(), self.mask(item))).collect()),
            Exact::Error { name, message, code, cause, props } => Exact::Error {
                name: name.clone(),
                message: self.mask_text(message),
                code: code.clone(),
                cause: cause.clone(),
                props: props.iter().map(|(key, item)| (key.clone(), self.mask(item))).collect(),
            },
            other => other.clone(),
        }
    }

    /// `actual` (plain JSON, a failure written as the recorder's `$exact` error) against the recorded value, whole.
    fn compare(&self, actual: &Value, expected: &Exact, case: &str) {
        let actual = self.mask(&Exact::decode(actual).expect("the replay's own value decodes"));
        if let Some(difference) = actual.difference(expected) {
            panic!("{case}: the core's outcome differs from Node's at {difference}");
        }
    }

    fn env(&self, recorded: &Exact) -> Env {
        recorded.entries().iter().map(|(key, value)| (key.clone(), self.unmask(value.as_str()))).collect()
    }
}

/// The recorder's `tree`: a folder per `name/`, an empty file per other name.
fn tree(root: &str, files: &Exact) {
    for file in files.as_array() {
        let file = file.as_str();
        let path = Path::new(root).join(file.trim_end_matches('/'));
        if file.ends_with('/') {
            mixdog_testkit::create_dir_all(&path);
        } else {
            mixdog_testkit::create_dir_all(path.parent().expect("a parent"));
            mixdog_testkit::write(&path, "");
        }
    }
}

fn env_json(env: &Env) -> Value {
    Value::Object(env.iter().map(|(key, value)| (key.clone(), Value::String(value.clone()))).collect())
}

fn layout_json(layout: &Option<Layout>) -> Value {
    match layout {
        None => Value::Null,
        Some(layout) => json!({"command": layout.command, "root": layout.root, "msystem": layout.msystem, "msysConfig": layout.msys_config}),
    }
}

fn layout_of(recorded: &Exact, roots: &Roots) -> Layout {
    Layout {
        command: roots.unmask(recorded.get("command").as_str()),
        root: roots.unmask(recorded.get("root").as_str()),
        msystem: recorded.get("msystem").as_str().to_owned(),
        msys_config: recorded.get("msysConfig").as_array().iter().map(|item| item.as_str().to_owned()).collect(),
    }
}

/// `gitCommand(env)` and `gitChildEnv(env)` as the core computes them for a child whose inherited environment is `env`: the
/// program, the environment the child receives, and whether that is `env` itself (no launcher variables).
fn child_launch(env: &Env) -> (String, Env, bool) {
    let mut spec = ExecSpec::new("git", ".");
    let launch = launch_for(&crate::git::child_base(&spec, env.clone()));
    let unchanged = launch.env.is_empty();
    crate::git::apply_launch(&mut spec, launch);
    (spec.program.clone(), crate::git::child_base(&spec, env.clone()), unchanged)
}

/// A failed start as Node's runner rejects it: `spawn <code>`, the libuv code of the OS error (ENOENT for a missing program).
fn node_error(failure: &ScmFailure) -> Value {
    let code = match failure {
        ScmFailure::Unavailable { .. } => "ENOENT",
        ScmFailure::Spawn { code, .. } => code,
        other => panic!("not a failed start: {other:?}"),
    };
    json!({"$exact": "error", "name": "Error", "message": format!("spawn {code}"), "code": code, "props": {}})
}

/// The recording's `<ms>`: a duration the run measured, written as the marker once it is one (a finite number ≥ 0).
fn measured(ms: f64) -> Value {
    assert!(ms.is_finite() && ms >= 0.0, "a measured duration: {ms}");
    json!("<ms>")
}

/// `runChildTimed`'s `timing` of a start, its measurements normalised as the recording's.
fn timing_json(timing: &crate::exec::SpawnTiming) -> Value {
    json!({"queueMs": measured(timing.queue_ms), "spawnMs": measured(timing.spawn_ms)})
}

/// `runGitOffThread`'s settlement: the run, or the failed start as Node's runner rejects it, its `timing` on the error.
fn settled(outcome: &Result<ExecOutput, ScmFailure>, resolved: impl FnOnce(&ExecOutput) -> Value) -> Value {
    match outcome {
        Ok(output) => json!({"resolved": resolved(output)}),
        Err(failure) => {
            let mut error = node_error(failure);
            let ScmFailure::Spawn { timing, .. } = failure else { panic!("a refused start carries its timing: {failure:?}") };
            error["props"] = json!({"timing": timing_json(timing)});
            json!({"rejected": error})
        }
    }
}

/// `spawnSync`'s result for an outcome; the child's pid is a measurement of the run (normalised `<pid>` in the recording).
fn sync_result(outcome: &Result<ExecOutput, ScmFailure>) -> Value {
    let output = outcome.as_ref().expect("the child ran");
    let (stdout, stderr) = (output.stdout_text(), output.stderr_text());
    json!({"status": output.code, "signal": null, "output": [null, stdout, stderr], "pid": "<pid>", "stdout": stdout, "stderr": stderr})
}

/// The environment a child of a spawn request receives (the process manager's rule: this process's own, less `remove`, with each
/// `set` replacing any spelling of its name).
fn child_env(spec: &EnvSpec) -> Env {
    let same = |a: &str, b: &str| a.eq_ignore_ascii_case(b);
    let mut env: Env = if spec.inherit { super::process_env() } else { Vec::new() };
    env.retain(|(key, _)| !spec.remove.iter().any(|name| same(key, name)));
    for (key, value) in &spec.set {
        env.retain(|(k, _)| !same(k, key));
        env.push((key.clone(), value.clone()));
    }
    env
}

/// A failure Node's retry test threw from its start function: the error the process manager reports for it, and the error
/// itself as the recorder writes it (its message and code are the test script's own).
struct Thrown {
    error: ProcessError,
    node: Value,
}

/// The recorder's `enoent()`: `spawn ENOENT`, code ENOENT.
fn enoent(program: &str) -> Option<Thrown> {
    Some(Thrown {
        error: ProcessError::ProgramNotFound { program: program.to_owned() },
        node: json!({"$exact": "error", "name": "Error", "message": "spawn ENOENT", "code": "ENOENT", "props": {}}),
    })
}

/// The start function of Node's retry tests: it records each start (program and environment) and fails it as `fail` says, or
/// lets it exit 0.
struct ScriptedStarts {
    fail: Box<dyn Fn(&str) -> Option<Thrown> + Send + Sync>,
    seen: Mutex<Vec<(String, Env)>>,
    thrown: Mutex<Vec<Value>>,
}

impl ScriptedStarts {
    fn new(fail: impl Fn(&str) -> Option<Thrown> + Send + Sync + 'static) -> Arc<Self> {
        Arc::new(Self { fail: Box::new(fail), seen: Mutex::default(), thrown: Mutex::default() })
    }

    fn seen(&self) -> Vec<(String, Env)> {
        self.seen.lock().unwrap().clone()
    }

    /// `startGit`'s settlement: Node's `startGit` rethrows its start's error unchanged, so a rejection of the core's `start_git`
    /// is the last error the script threw, once the core's failure is that error's (its libuv code).
    fn outcome(&self, outcome: &Result<ExecOutput, ScmFailure>) -> Value {
        let Err(failure) = outcome else { return json!({"resolved": true}) };
        let thrown = self.thrown.lock().unwrap().last().cloned().expect("a rejection follows a thrown start");
        assert_eq!(node_error(failure)["code"], thrown["code"], "the core's failure is the start's own");
        json!({"rejected": thrown})
    }
}

#[async_trait]
impl ProcessManager for ScriptedStarts {
    async fn spawn(&self, request: SpawnRequest) -> Result<SpawnedProcess, ProcessError> {
        let CommandSpec::Argv { program, .. } = &request.command else { panic!("git starts as an argument vector") };
        self.seen.lock().unwrap().push((program.clone(), child_env(&request.env)));
        match (self.fail)(program) {
            Some(Thrown { error, node }) => {
                self.thrown.lock().unwrap().push(node);
                Err(error)
            }
            None => Ok(SpawnedProcess { handle: request.handle, pid: 1 }),
        }
    }
    fn subscribe(&self, _handle: &ProcessHandle, _from_seq: Option<u64>) -> Result<Box<dyn EventSource<ProcessEvent>>, ProcessError> {
        Ok(Box::new(VecSource::new([ProcessEvent::Exited { seq: 0, exit: ProcessExit { status: ExitStatus::Code(0), killed: None } }])))
    }
    async fn write_stdin(&self, _handle: &ProcessHandle, _bytes: Vec<u8>) -> Result<(), ProcessError> {
        Ok(())
    }
    fn close_stdin(&self, _handle: &ProcessHandle) -> Result<(), ProcessError> {
        Ok(())
    }
    fn resize_pty(&self, _handle: &ProcessHandle, _size: PtySize) -> Result<(), ProcessError> {
        Err(ProcessError::NotPty)
    }
    fn kill(&self, _handle: &ProcessHandle) -> Result<(), ProcessError> {
        Ok(())
    }
    fn list(&self) -> Vec<ProcessInfo> {
        Vec::new()
    }
}

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread().enable_all().build().expect("a runtime")
}

fn lane() -> mixdog_rt::MaintenanceIo {
    mixdog_rt::testing::tokens().maintenance_io
}

/// The scene this run is a child for, when it is one.
fn scene() -> Option<Value> {
    let path = std::env::current_dir().ok()?.join(SCENE);
    path.is_file().then(|| serde_json::from_str(&mixdog_testkit::read_string(&path)).expect("the scene"))
}

fn answer(result: &Value) {
    mixdog_testkit::write(std::env::current_dir().expect("the scene folder").join(RESULT), result.to_string());
}

/// Runs the test `test` of this binary in a child whose whole environment is `env`, in a scene folder holding `scene`; the child
/// writes its result there.
fn in_child(test: &str, env: &Env, scene: &Value) -> Value {
    let folder = tempfile::Builder::new().prefix("mixdog-git-launch-scene-").tempdir().expect("a scene folder");
    mixdog_testkit::write(folder.path().join(SCENE), scene.to_string());
    let mut command = std::process::Command::new(std::env::current_exe().expect("this test binary"));
    command
        .args([test, "--exact", "--nocapture", "--test-threads=1"])
        .current_dir(folder.path())
        .env_clear()
        .envs(env.iter().map(|(key, value)| (key, value)))
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .creation_flags(CREATE_NO_WINDOW);
    let child = command.spawn().expect("this test binary starts");
    let pid = child.id();
    let (sent, received) = std::sync::mpsc::channel();
    std::thread::spawn(move || sent.send(child.wait_with_output()));
    let Ok(output) = received.recv_timeout(CHILD_DEADLINE) else {
        let _ = std::process::Command::new("taskkill").args(["/PID", &pid.to_string(), "/T", "/F"]).creation_flags(CREATE_NO_WINDOW).output();
        panic!("{test} in its recorded environment: no exit within {CHILD_DEADLINE:?}");
    };
    let output = output.expect("the child test's output");
    assert!(
        output.status.success(),
        "{test} in its recorded environment failed:\n{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_str(&mixdog_testkit::read_string(folder.path().join(RESULT))).expect("the child's result")
}

/// The recording's stand-in for git (`git-standin.cs`), compiled once per run with the .NET Framework's csc.
fn standin() -> &'static Path {
    static BUILT: OnceLock<tempfile::TempDir> = OnceLock::new();
    BUILT
        .get_or_init(|| {
            let dir = tempfile::Builder::new().prefix("mixdog-git-standin-").tempdir().expect("a build folder");
            let system_root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".to_owned());
            let csc = Path::new(&system_root).join("Microsoft.NET").join("Framework64").join("v4.0.30319").join("csc.exe");
            let out = dir.path().join("standin.exe");
            let built = std::process::Command::new(&csc)
                .args(["/nologo", "/target:exe", &format!("/out:{}", out.display()), &standin_source().to_string_lossy()])
                .creation_flags(CREATE_NO_WINDOW)
                .output()
                .expect("csc starts");
            assert!(built.status.success(), "the git stand-in did not compile: {}", String::from_utf8_lossy(&built.stdout));
            dir
        })
        .path()
}

/// `\`, newline and tab escaped as `installStandin` writes an answer.
fn escape(text: &str) -> String {
    text.replace('\\', "\\\\").replace('\n', "\\n").replace('\t', "\\t")
}

/// The recorder's `controlledInstall` at `root`, from its recorded description.
fn controlled_install(root: &str, description: &Exact, roots: &Roots) {
    tree(root, description.get("files"));
    let exe = standin().join("standin.exe");
    let real = join(root, &["Git", "mingw64", "bin", "git.exe"]);
    std::fs::copy(&exe, &real).expect("the stand-in as the real binary");
    let answers: Vec<String> = description
        .get("answers")
        .as_array()
        .iter()
        .map(|answer| {
            let [matched, code, out, err] = answer.as_array() else { panic!("an answer has four parts") };
            let out = if out.as_str() == "$ENV" { "$ENV".to_owned() } else { escape(out.as_str()) };
            format!("{}\t{}\t{out}\t{}", matched.as_str(), code.as_f64(), escape(err.as_str()))
        })
        .collect();
    mixdog_testkit::write(format!("{real}.answers"), answers.join("\n"));
    let wrapper: Vec<String> = description.get("wrapper").as_array().iter().map(|line| roots.unmask(line.as_str())).collect();
    for launcher in ["cmd", "bin"] {
        let path = join(root, &["Git", launcher, "git.exe"]);
        std::fs::copy(&exe, &path).expect("the stand-in as the launcher");
        mixdog_testkit::write(format!("{path}.wrapper"), wrapper.join("\n"));
    }
}

/// What the stand-in at `exe` recorded: one `{argv, cwd, env}` per start, in order.
fn standin_starts(exe: &str) -> Value {
    let log = format!("{exe}.log");
    if !Path::new(&log).is_file() {
        return json!([]);
    }
    Value::Array(mixdog_testkit::read_string(&log).split('\n').filter(|line| !line.is_empty()).map(|line| serde_json::from_str(line).expect("a start")).collect())
}

fn files(observed: &Exact, key: &str) -> Value {
    plain(observed.get(key))
}

#[test]
fn case0_git_for_windows_launchers_resolve_to_the_real_binary_of_their_install() {
    let expected = recorded(0, "Git for Windows launchers resolve to the real binary of their install");
    let mut roots = Roots::default();
    let root = roots.add(1);
    tree(&root, expected.get("files"));
    let launchers: Vec<Value> = ["cmd", "bin"]
        .iter()
        .map(|launcher| {
            let path = join(&root, &["Git", launcher]);
            json!({"pathValue": path, "launch": layout_json(&resolve_layout("win32", &path))})
        })
        .collect();
    let arm_files = expected.get("arm").get("files");
    let arm = roots.add(2);
    tree(&arm, arm_files);
    let path = join(&arm, &["Git", "cmd"]);
    let actual = json!({
        "files": files(&expected, "files"),
        "launchers": launchers,
        "arm": {"files": plain(arm_files), "pathValue": path, "launch": layout_json(&resolve_layout("win32", &path))},
    });
    roots.compare(&actual, &expected, "case 0");
}

#[test]
fn case1_every_other_git_keeps_plain_git() {
    let expected = recorded(1, "every other git keeps plain `git`");
    let mut roots = Roots::default();
    let root = roots.add(3);
    tree(&root, expected.get("files"));
    let cases: Vec<Value> = expected
        .get("cases")
        .as_array()
        .iter()
        .map(|case| {
            let platform = case.get("platform").as_str();
            let path = roots.unmask(case.get("pathValue").as_str());
            json!({"label": case.get("label").as_str(), "platform": platform, "pathValue": path, "launch": layout_json(&resolve_layout(platform, &path))})
        })
        .collect();
    roots.compare(&json!({"files": files(&expected, "files"), "cases": cases}), &expected, "case 1");
}

#[test]
fn case2_the_child_environment_is_the_one_the_launcher_builds() {
    let expected = recorded(2, "the child environment is the one the launcher builds");
    let mut roots = Roots::default();
    let root = roots.add(4);
    mixdog_testkit::create_dir_all(Path::new(&root).join(expected.get("homeDirectoryExists").as_str().trim_end_matches('/')));
    let launch = layout_of(expected.get("launch"), &roots);
    let with = expected.get("withHomeDir");
    let caller = roots.env(with.get("callerBefore"));
    let caller_before = caller.clone();
    let with_input = roots.env(with.get("input"));
    let env = launch_environment(&launch, &with_input);
    let missing_input = roots.env(expected.get("homeMissing").get("input"));
    let missing = launch_environment(&launch, &missing_input);
    let kept = expected.get("kept");
    let kept_launch = layout_of(kept.get("launch"), &roots);
    let kept_input = roots.env(kept.get("input"));
    let kept_env = launch_environment(&kept_launch, &kept_input);
    let actual = json!({
        "homeDirectoryExists": expected.get("homeDirectoryExists").as_str(),
        "launch": layout_json(&Some(launch)),
        "withHomeDir": {
            "input": env_json(&with_input),
            "env": env_json(&env),
            "pathIsUndefined": !env.iter().any(|(key, _)| key == "PATH"),
            "callerAfter": env_json(&caller),
            "callerBefore": env_json(&caller_before),
        },
        "homeMissing": {"input": env_json(&missing_input), "env": env_json(&missing)},
        "kept": {"launch": layout_json(&Some(kept_launch)), "input": env_json(&kept_input), "env": env_json(&kept_env)},
    });
    roots.compare(&actual, &expected, "case 2");
}

#[test]
fn case3_each_environments_own_path_decides_the_git_it_starts() {
    let expected = recorded(3, "each environment's own PATH decides the git it starts");
    let mut roots = Roots::default();
    let root = roots.add(5);
    tree(&root, expected.get("files"));
    let install: Env = vec![("PATH".into(), join(&root, &["Git", "cmd"]))];
    let shim: Env = vec![("Path".into(), join(&root, &["scoop", "shims"]))];
    let (install_command, install_env, _) = child_launch(&install);
    let (shim_command, shim_env, shim_unchanged) = child_launch(&shim);
    let actual = json!({
        "files": files(&expected, "files"),
        "install": {"input": env_json(&install), "command": install_command, "childEnv": env_json(&install_env)},
        "shim": {"input": env_json(&shim), "command": shim_command, "childEnv": env_json(&shim_env), "childEnvIsTheSameObject": shim_unchanged},
    });
    roots.compare(&actual, &expected, "case 3");
}

const CASE4: &str = "git_launch::k1_replay::case4_a_resolved_binary_that_is_gone_is_resolved_again_and_that_spawn_retried_once";

#[test]
fn case4_a_resolved_binary_that_is_gone_is_resolved_again_and_that_spawn_retried_once() {
    if let Some(scene) = scene() {
        let root = scene["root"].as_str().expect("the scene's root");
        let first = git_command();
        mixdog_testkit::remove_dir_all(Path::new(root).join("Git"));
        let gone = first.clone();
        let starts = ScriptedStarts::new(move |program| if program == gone { enoent(program) } else { None });
        let outcome = runtime().block_on(start_git(&Exec::new(starts.clone()), lane(), ExecSpec::new("git", root), &CancellationToken::new()));
        let seen = starts.seen();
        let commands: Vec<Value> = seen.iter().map(|(command, env)| json!({"command": command, "childEnv": env_json(env)})).collect();
        let settled = starts.outcome(&outcome);
        let result = match scene["mode"].as_str() {
            Some("startGit") => json!({
                "resolvedBefore": first,
                "result": if outcome.is_ok() { json!("ran") } else { settled["rejected"].clone() },
                "spawnedCommands": commands,
                "secondChildEnvIsCallerEnv": seen.get(1).is_some_and(|(_, env)| *env == super::process_env()),
                "resolutionAfterRetry": git_command(),
            }),
            _ => json!({
                "outcome": if outcome.is_ok() { json!({"status": 0}) } else { settled["rejected"].clone() },
                "spawnedCommands": seen.iter().map(|(command, _)| command.clone()).collect::<Vec<_>>(),
            }),
        };
        answer(&result);
        return;
    }
    let expected = recorded(4, "a resolved binary that is gone is resolved again, and that spawn retried once");
    let mut roots = Roots::default();
    let root = roots.add(6);
    tree(&root, expected.get("files"));
    let stale = roots.add(7);
    tree(&stale, expected.get("files"));
    let env: Env = vec![("PATH".into(), join(&root, &["Git", "cmd"]))];
    let stale_env: Env = vec![("PATH".into(), join(&stale, &["Git", "cmd"]))];
    let started = in_child(CASE4, &env, &json!({"mode": "startGit", "root": root}));
    let synced = in_child(CASE4, &stale_env, &json!({"mode": "startGitSync", "root": stale}));
    let actual = json!({
        "files": files(&expected, "files"),
        "env": env_json(&env),
        "resolvedBefore": started["resolvedBefore"],
        "uninstalledAfterResolve": true,
        "startGit": {
            "result": started["result"],
            "spawnedCommands": started["spawnedCommands"],
            "secondChildEnvIsCallerEnv": started["secondChildEnvIsCallerEnv"],
            "resolutionAfterRetry": started["resolutionAfterRetry"],
        },
        "startGitSync": {"staleEnv": env_json(&stale_env), "outcome": synced["outcome"], "spawnedCommands": synced["spawnedCommands"]},
    });
    roots.compare(&actual, &expected, "case 4");
}

const CASE5: &str = "git_launch::k1_replay::case5_only_a_missing_binary_retries_and_only_once";

/// ERROR_ELEVATION_REQUIRED: the Windows error libuv names EACCES when CreateProcess refuses a program.
const ELEVATION_REQUIRED: i32 = 740;

#[test]
fn case5_only_a_missing_binary_retries_and_only_once() {
    if let Some(scene) = scene() {
        let root = scene["root"].as_str().expect("the scene's root");
        let rt = runtime();
        let run = |fail: fn(&str) -> Option<Thrown>| {
            let starts = ScriptedStarts::new(fail);
            let outcome = rt.block_on(start_git(&Exec::new(starts.clone()), lane(), ExecSpec::new("git", root), &CancellationToken::new()));
            json!({"calls": starts.seen().len(), "outcome": starts.outcome(&outcome)})
        };
        let binary = git_command();
        let in_place = run(enoent);
        let stays = git_command();
        // The test's `Object.assign(new Error('denied'), { code: 'EACCES' })`: the OS error libuv names EACCES.
        let denied = run(|_| {
            Some(Thrown {
                error: ProcessError::Io { os_code: Some(ELEVATION_REQUIRED) },
                node: json!({"$exact": "error", "name": "Error", "message": "denied", "code": "EACCES", "props": {}}),
            })
        });
        mixdog_testkit::remove_dir_all(Path::new(root).join("Git"));
        let gone = run(enoent);
        answer(&json!({"binary": binary, "enoentWithBinaryInPlace": in_place, "resolutionAfter": stays, "otherSpawnFailure": denied, "goneAndRetryFails": gone}));
        return;
    }
    let expected = recorded(5, "only a missing binary retries, and only once");
    let mut roots = Roots::default();
    let root = roots.add(8);
    tree(&root, expected.get("files"));
    let env: Env = vec![("PATH".into(), join(&root, &["Git", "cmd"]))];
    let ran = in_child(CASE5, &env, &json!({"root": root}));
    let actual = json!({
        "files": files(&expected, "files"),
        "env": env_json(&env),
        "binary": ran["binary"],
        "enoentWithBinaryInPlace": ran["enoentWithBinaryInPlace"],
        "resolutionAfter": ran["resolutionAfter"],
        "otherSpawnFailure": ran["otherSpawnFailure"],
        "goneAndRetryFails": ran["goneAndRetryFails"],
    });
    roots.compare(&actual, &expected, "case 5");
}

/// The recorder's machine variables, given whole to every started child.
fn recorded_env(recorded: &Exact, roots: &Roots) -> Env {
    roots.env(recorded)
}

const CASE6: &str = "git_launch::k1_replay::case6_the_git_runner_falls_back_to_the_git_path_names_once_the_resolved_one_is_removed";

#[test]
fn case6_the_git_runner_falls_back_to_the_git_path_names_once_the_resolved_one_is_removed() {
    if let Some(scene) = scene() {
        let stale = scene["stale"].as_str().expect("the stale root");
        let rt = runtime();
        let exec = Exec::new(TestProcesses::shared());
        let version = || {
            let mut spec = ExecSpec::new("git", stale);
            spec.args = vec!["--version".to_owned()];
            spec.time_limit = Some(Duration::from_millis(30_000));
            spec.max_output = 1_000_000;
            rt.block_on(start_git(&exec, lane(), spec, &CancellationToken::new()))
        };
        let resolved = |output: &ExecOutput| json!({"code": output.code, "stdout": output.stdout_text(), "stderr": output.stderr_text(), "timing": timing_json(&output.timing)});
        let first = settled(&version(), resolved);
        mixdog_testkit::remove_dir_all(Path::new(stale).join("Git"));
        let after = settled(&version(), resolved);
        answer(&json!({"first": first, "afterRemoval": after}));
        return;
    }
    let expected = recorded(6, "the git runner falls back to the git PATH names once the resolved one is removed");
    let mut roots = Roots::default();
    let stale = roots.add(9);
    tree(&stale, expected.get("staleFiles"));
    let fallback = roots.add(10);
    controlled_install(&fallback, expected.get("fallback"), &roots);
    let env = recorded_env(expected.get("env"), &roots);
    let ran = in_child(CASE6, &env, &json!({"stale": stale}));
    let actual = json!({
        "staleFiles": files(&expected, "staleFiles"),
        "fallback": plain(&roots.mask(expected.get("fallback"))),
        "env": env_json(&env),
        "options": {"cwd": stale, "env": env_json(&env), "timeoutMs": 30_000, "maxBytes": 1_000_000},
        "staleCommand": join(&stale, &["Git", "mingw64", "bin", "git.exe"]),
        "first": ran["first"],
        "afterRemoval": ran["afterRemoval"],
        "standinStarts": {
            "launcher": standin_starts(&join(&fallback, &["Git", "cmd", "git.exe"])),
            "real": standin_starts(&join(&fallback, &["Git", "mingw64", "bin", "git.exe"])),
        },
    });
    roots.compare(&actual, &expected, "case 6");
}

#[test]
fn case7_without_a_bypass_the_command_and_environment_are_unchanged() {
    let expected = recorded(7, "without a bypass the command and environment are unchanged");
    let mut roots = Roots::default();
    let root = roots.add(11);
    mixdog_testkit::create_dir_all(Path::new(&root).join("empty"));
    let env: Env = vec![("PATH".into(), join(&root, &["empty"]))];
    let (command, child, _) = child_launch(&env);
    let plain_env: Env = vec![("PATH".into(), "x".into())];
    let (_, _, plain_unchanged) = child_launch(&plain_env);
    let actual = json!({"env": env_json(&env), "command": command, "gitChildEnvOfEnv": env_json(&child), "plain": env_json(&plain_env), "sameEnvObject": plain_unchanged});
    roots.compare(&actual, &expected, "case 7");
}

const CASE8: &str = "git_launch::k1_replay::case8_the_direct_binary_sees_the_environment_the_launcher_would_give_it";

#[test]
fn case8_the_direct_binary_sees_the_environment_the_launcher_would_give_it() {
    if let Some(scene) = scene() {
        let root = scene["root"].as_str().expect("the root");
        let args: Vec<String> = scene["args"].as_array().expect("the args").iter().map(|arg| arg.as_str().expect("an arg").to_owned()).collect();
        let rt = runtime();
        let exec = Exec::new(TestProcesses::shared());
        let spec = || {
            let mut spec = ExecSpec::new("git", root);
            spec.args = args.clone();
            spec.time_limit = Some(Duration::from_millis(30_000));
            spec
        };
        // Node's reference run: `git` as PATH names it, the launcher, with the caller's environment.
        let via = rt.block_on(exec.run(spec(), &CancellationToken::new()));
        let direct = rt.block_on(start_git(&exec, lane(), spec(), &CancellationToken::new()));
        let (command, _, _) = child_launch(&super::process_env());
        answer(&json!({"viaLauncher": sync_result(&via), "direct": sync_result(&direct), "command": command}));
        return;
    }
    let expected = recorded(8, "the direct binary sees the environment the launcher would give it");
    let mut roots = Roots::default();
    let root = roots.add(12);
    controlled_install(&root, expected.get("fallbackInstall"), &roots);
    let env = recorded_env(expected.get("env"), &roots);
    let args = plain(expected.get("args"));
    let ran = in_child(CASE8, &env, &json!({"root": root, "args": args}));
    let lines = |output: &Value| {
        let mut lines: Vec<String> = output["stdout"].as_str().expect("stdout").split('\n').filter(|line| !line.is_empty()).map(str::to_owned).collect();
        lines.sort();
        lines
    };
    let (direct, launcher) = (lines(&ran["direct"]), lines(&ran["viaLauncher"]));
    let only = |a: &[String], b: &[String]| a.iter().filter(|line| !b.contains(line)).cloned().collect::<Vec<_>>();
    let actual = json!({
        "fallbackInstall": plain(&roots.mask(expected.get("fallbackInstall"))),
        "env": env_json(&env),
        "args": args,
        "command": ran["command"],
        // `gitChildEnv(env)` of the recorded environment object, as the recorder computed it (in the child the environment is the
        // block Windows sorted).
        "launcherEnvironment": env_json(&child_launch(&env).1),
        "viaLauncher": ran["viaLauncher"],
        "direct": ran["direct"],
        "sameLines": direct == launcher,
        "onlyDirect": only(&direct, &launcher),
        "onlyLauncher": only(&launcher, &direct),
        "standinStarts": {
            "launcher": standin_starts(&join(&root, &["Git", "cmd", "git.exe"])),
            "real": standin_starts(&join(&root, &["Git", "mingw64", "bin", "git.exe"])),
        },
    });
    roots.compare(&actual, &expected, "case 8");
}
