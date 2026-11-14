//! Tests of the spawn rewrites, the short exec, the private folder rules and the agent probe (cases of the desktop's
//! ssh-auth `prepareSshSpawn`, ssh-agent and resolvePlainDir tests). No process is started: the spawner is scripted.

use std::collections::BTreeMap;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::Notify;

use crate::agent::{agent_status, parse_service_state, service_is_disabled, AgentState, ServiceState};
use crate::command::{parse_ssh_target, FailureClass};
use crate::context::{
    AskpassEnv, AttemptContext, ChildExit, ConfigFiles, HostSettings, Platform, PreparedSpawn, SshChild, SshConfigFiles, SshEnv,
    SshSpawner, ToolOutput, ToolRunner,
};
use crate::diagnostics::{DiagnosticKind, Diagnostics};
use crate::private_dir::{is_plain_path, resolve_plain_dir_with};
use crate::spawn::{prepare_spawn, ssh_exec, ExecOptions, MAX_CAPTURE_BYTES};

const EXEC: [&str; 8] = ["-o", "BatchMode=yes", "-o", "ControlMaster=no", "-o", "ControlPath=none", "--", "root@h"];
const TUNNEL: [&str; 9] = ["-o", "BatchMode=yes", "-N", "-o", "ControlMaster=no", "-o", "ControlPath=none", "--", "root@h"];

fn strings(items: &[&str]) -> Vec<String> {
    items.iter().map(|item| (*item).to_owned()).collect()
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

/// The configs of a run: a target's own file when the argument list names that host, else the generic one.
struct Configs {
    generic: Option<&'static str>,
    own: Option<&'static str>,
}

impl SshConfigFiles for Configs {
    fn for_args(&self, _args: &[String]) -> Option<PathBuf> {
        self.own.map(PathBuf::from)
    }

    fn generic(&self) -> Option<PathBuf> {
        self.generic.map(PathBuf::from)
    }
}

/// Answers the tools by name like the OS does.
struct Tools(Box<dyn Fn(&str, &[String]) -> io::Result<ToolOutput> + Send + Sync>);

#[async_trait]
impl ToolRunner for Tools {
    async fn run(&self, command: &Path, args: &[String], _timeout: Duration) -> io::Result<ToolOutput> {
        (self.0)(&command.to_string_lossy(), args)
    }
}

fn output(code: i32, stdout: &str) -> io::Result<ToolOutput> {
    Ok(ToolOutput { exit_code: Some(code), stdout: stdout.to_owned(), stderr: String::new() })
}

/// What a scripted child does.
#[derive(Clone)]
enum Script {
    /// Prints, then ends with the exit.
    Finish { stdout: Vec<Vec<u8>>, stderr: Vec<u8>, exit: ChildExit },
    /// Prints nothing and runs until killed.
    Hang,
    /// The start fails with this kind (reported by `wait`, as a failed start of the process manager is).
    StartFails(io::ErrorKind),
}

struct ScriptedChild {
    script: Script,
    killed: Arc<Notify>,
    was_killed: Arc<AtomicBool>,
    held: Option<tokio::io::DuplexStream>,
    peer: Option<tokio::io::DuplexStream>,
}

#[async_trait]
impl SshChild for ScriptedChild {
    fn take_stdin(&mut self) -> Option<Box<dyn AsyncWrite + Send + Unpin>> {
        Some(Box::new(tokio::io::sink()))
    }

    fn take_stdout(&mut self) -> Option<Box<dyn AsyncRead + Send + Unpin>> {
        match &self.script {
            Script::Finish { stdout, .. } => Some(Box::new(io::Cursor::new(stdout.concat()))),
            Script::Hang => self.peer.take().map(|stream| Box::new(stream) as Box<dyn AsyncRead + Send + Unpin>),
            Script::StartFails(_) => None,
        }
    }

    fn take_stderr(&mut self) -> Option<Box<dyn AsyncRead + Send + Unpin>> {
        match &self.script {
            Script::Finish { stderr, .. } => Some(Box::new(io::Cursor::new(stderr.clone()))),
            _ => None,
        }
    }

    async fn wait(&mut self) -> io::Result<ChildExit> {
        match &self.script {
            Script::Finish { exit, .. } => Ok(exit.clone()),
            Script::StartFails(kind) => Err(io::Error::new(*kind, "scripted start failure")),
            Script::Hang => {
                self.killed.notified().await;
                Ok(ChildExit { code: None, signal: Some("SIGKILL".to_owned()) })
            }
        }
    }

    fn kill(&mut self) {
        self.was_killed.store(true, Ordering::SeqCst);
        // The tree kill closes the pipes.
        self.held = None;
        self.killed.notify_one();
    }
}

/// Hands out one scripted child per spawn and remembers what it was asked to run.
struct Scripted {
    script: Script,
    spawn_error: bool,
    seen: Mutex<Vec<PreparedSpawn>>,
    was_killed: Arc<AtomicBool>,
}

impl Scripted {
    fn new(script: Script) -> Arc<Self> {
        Arc::new(Self { script, spawn_error: false, seen: Mutex::new(Vec::new()), was_killed: Arc::new(AtomicBool::new(false)) })
    }
}

impl SshSpawner for Scripted {
    fn spawn(&self, prepared: &PreparedSpawn) -> io::Result<Box<dyn SshChild>> {
        if self.spawn_error {
            return Err(io::Error::other("no runtime"));
        }
        self.seen.lock().unwrap().push(prepared.clone());
        let (held, peer) = tokio::io::duplex(1024);
        Ok(Box::new(ScriptedChild {
            script: self.script.clone(),
            killed: Arc::new(Notify::new()),
            was_killed: self.was_killed.clone(),
            held: Some(held),
            peer: Some(peer),
        }))
    }
}

fn env_with(platform: Platform, vars: &[(&str, &str)], configs: Configs, spawner: Arc<dyn SshSpawner>, tools: Tools) -> SshEnv {
    SshEnv {
        platform,
        env: vars.iter().map(|(key, value)| ((*key).to_owned(), (*value).to_owned())).collect::<BTreeMap<_, _>>(),
        home: PathBuf::from("/home/tester"),
        askpass_helper: None,
        server_cores_dir: None,
        files: Arc::new(NoFiles),
        config_files: Arc::new(configs),
        tools: Arc::new(tools),
        spawner,
        diagnostics: Arc::new(Diagnostics::new()),
    }
}

fn no_tools() -> Tools {
    Tools(Box::new(|command, _| Err(io::Error::other(format!("unexpected {command}")))))
}

fn plain_env(platform: Platform, vars: &[(&str, &str)], generic: Option<&'static str>) -> SshEnv {
    env_with(platform, vars, Configs { generic, own: None }, Scripted::new(Script::Hang), no_tools())
}

struct Live {
    vars: Vec<(String, String)>,
    control_dir: Option<PathBuf>,
    closed: bool,
}

impl AskpassEnv for Live {
    fn env(&self) -> Vec<(String, String)> {
        self.vars.clone()
    }

    fn closed(&self) -> bool {
        self.closed
    }

    fn control_dir(&self) -> Option<PathBuf> {
        self.control_dir.clone()
    }
}

fn live(control_dir: Option<&str>, closed: bool) -> AttemptContext {
    let vars = vec![("SSH_ASKPASS".to_owned(), "H:askpass.sh".to_owned()), ("MIXDOG_ASKPASS_TOKEN".to_owned(), "t".to_owned())];
    AttemptContext { askpass: Some(Arc::new(Live { vars, control_dir: control_dir.map(PathBuf::from), closed })), ..Default::default() }
}

// ---- prepare_spawn ----

#[test]
fn prepare_every_ssh_reads_mixdogs_own_config_unless_the_caller_passes_one() {
    let env = plain_env(Platform::Linux, &[], Some("/data/ssh/config"));
    let own = prepare_spawn(&env, "ssh", &strings(&EXEC), None);
    assert_eq!(own.args[..2], strings(&["-F", "/data/ssh/config"])[..]);
    assert_eq!(own.args[2..], strings(&EXEC)[..]);
    let mut mine = strings(&["-F", "mine"]);
    mine.extend(strings(&EXEC));
    assert_eq!(prepare_spawn(&env, "ssh", &mine, None).args, mine);
    assert_eq!(prepare_spawn(&env, "ssh-keyscan", &strings(&["-p", "22"]), None).args, strings(&["-p", "22"]));
}

#[test]
fn prepare_a_targets_own_config_wins_over_the_generic_one() {
    let env = env_with(Platform::Linux, &[], Configs { generic: Some("/data/ssh/config"), own: Some("/data/ssh/h.config") }, Scripted::new(Script::Hang), no_tools());
    assert_eq!(prepare_spawn(&env, "ssh", &strings(&EXEC), None).args[..2], strings(&["-F", "/data/ssh/h.config"])[..]);
}

#[test]
fn prepare_ssh_runs_batch_mode_with_no_helper_unless_an_interactive_retry_is_running() {
    let env = plain_env(Platform::Linux, &[("PATH", "x")], None);
    let plain = prepare_spawn(&env, "ssh", &strings(&EXEC), None);
    assert_eq!(plain.args, strings(&EXEC));
    assert_eq!(plain.env, None);
    let closed = prepare_spawn(&env, "ssh", &strings(&EXEC), Some(&live(None, true)));
    assert_eq!(closed.args, strings(&EXEC));
    assert_eq!(closed.env, None, "a session that ended no longer lends its helper to later reconnects");
    let other = prepare_spawn(&env, "ssh-keyscan", &strings(&["-p", "22"]), Some(&live(None, false)));
    assert_eq!((other.args, other.env), (strings(&["-p", "22"]), None));
}

#[test]
fn prepare_during_the_interactive_retry_ssh_gets_the_helper_batch_mode_off_and_a_display() {
    let env = plain_env(Platform::Windows, &[("PATH", "x")], None);
    let run = prepare_spawn(&env, "ssh", &strings(&EXEC), Some(&live(None, false)));
    let batch: Vec<&String> = run.args.iter().filter(|arg| arg.starts_with("BatchMode")).collect();
    assert_eq!(batch, ["BatchMode=no"]);
    let vars = run.env.expect("an environment");
    assert_eq!(vars["SSH_ASKPASS"], "H:askpass.sh");
    assert_eq!(vars["SSH_ASKPASS_REQUIRE"], "force");
    assert_eq!(vars["DISPLAY"], "localhost:0");
    assert_eq!(vars["PATH"], "x");
    assert!(run.args.contains(&"ControlPath=none".to_owned()), "Windows OpenSSH has no connection sharing");
    let shown = plain_env(Platform::Windows, &[("DISPLAY", ":1")], None);
    assert_eq!(prepare_spawn(&shown, "ssh", &strings(&EXEC), Some(&live(None, false))).env.unwrap()["DISPLAY"], ":1");
}

#[test]
fn prepare_macos_and_linux_share_one_login_across_the_short_commands_and_the_tunnel_only_joins_it() {
    let session = live(Some("/tmp/mxa-abc"), false);
    let linux = plain_env(Platform::Linux, &[], None);
    let exec = prepare_spawn(&linux, "ssh", &strings(&EXEC), Some(&session));
    assert!(exec.args.contains(&"ControlMaster=auto".to_owned()));
    assert!(exec.args.contains(&"ControlPath=/tmp/mxa-abc/%C".to_owned()));
    assert!(exec.args.contains(&"ControlPersist=30".to_owned()));
    let mac = plain_env(Platform::MacOs, &[], None);
    let tunnel = prepare_spawn(&mac, "ssh", &strings(&TUNNEL), Some(&session));
    assert!(tunnel.args.contains(&"ControlMaster=no".to_owned()), "a -N tunnel never becomes a background master");
    assert!(tunnel.args.contains(&"ControlPath=/tmp/mxa-abc/%C".to_owned()));
    assert!(!tunnel.args.iter().any(|arg| arg.starts_with("ControlPersist")));
    let windows = plain_env(Platform::Windows, &[], None);
    let on_windows = prepare_spawn(&windows, "ssh", &strings(&EXEC), Some(&live(Some("/tmp/mxa-abc"), false)));
    assert!(!on_windows.args.iter().any(|arg| arg.starts_with("ControlPersist") || arg == "ControlMaster=auto"));
}

#[test]
fn prepare_the_servers_key_file_is_passed_with_i_even_when_its_path_has_spaces_or_non_ascii_characters() {
    let env = plain_env(Platform::Windows, &[], None);
    let file = r"C:\Users\김 철수\.ssh\id work";
    let settings = HostSettings { identity_file: Some(file.to_owned()), ..Default::default() };
    let context = AttemptContext { settings: Some(settings), ..Default::default() };
    let run = prepare_spawn(&env, "ssh", &strings(&EXEC), Some(&context));
    assert_eq!(run.args[..4], strings(&["-i", file, "-o", "IdentitiesOnly=yes"])[..]);
    assert_eq!(run.args[4..], strings(&EXEC)[..]);
    let blank = AttemptContext { settings: Some(HostSettings::default()), ..Default::default() };
    assert!(!prepare_spawn(&env, "ssh", &strings(&EXEC), Some(&blank)).args.contains(&"-i".to_owned()));
}

#[test]
fn prepare_a_key_file_in_the_home_folder_is_expanded_and_the_key_goes_in_front_of_the_config() {
    let env = plain_env(Platform::Linux, &[], Some("/data/ssh/config"));
    let settings = HostSettings { identity_file: Some("~/.ssh/id_work".to_owned()), ..Default::default() };
    let context = AttemptContext { settings: Some(settings), ..Default::default() };
    let args = prepare_spawn(&env, "ssh", &strings(&EXEC), Some(&context)).args;
    assert_eq!(args[..6], strings(&["-i", "/home/tester/.ssh/id_work", "-o", "IdentitiesOnly=yes", "-F", "/data/ssh/config"])[..]);
}

// ---- ssh_exec ----

fn exec_options(timeout: Duration) -> ExecOptions {
    ExecOptions { target: parse_ssh_target("me@box").unwrap(), command: "echo hi".to_owned(), input: Some(b"in".to_vec()), timeout, context: None }
}

fn exec_env(spawner: Arc<Scripted>) -> SshEnv {
    env_with(Platform::Linux, &[], Configs { generic: None, own: None }, spawner, no_tools())
}

fn finish(stdout: &[&[u8]], stderr: &[u8], code: Option<i32>) -> Script {
    Script::Finish { stdout: stdout.iter().map(|chunk| chunk.to_vec()).collect(), stderr: stderr.to_vec(), exit: ChildExit { code, signal: None } }
}

#[tokio::test]
async fn exec_returns_the_remote_exit_code_and_both_streams_and_records_the_run() {
    let spawner = Scripted::new(finish(&[b"hello ", b"world"], b"warn\n", Some(3)));
    let env = exec_env(spawner.clone());
    let done = ssh_exec(&env, exec_options(Duration::from_secs(5))).await.expect("a remote exit code is not an ssh failure");
    assert_eq!((done.exit_code, done.stdout.as_str(), done.stderr.as_str()), (3, "hello world", "warn\n"));
    let seen = spawner.seen.lock().unwrap();
    assert_eq!(seen[0].command, PathBuf::from("ssh"));
    assert!(seen[0].args.ends_with(&strings(&["--", "me@box", "echo hi"])));
    let kinds: Vec<DiagnosticKind> = env.diagnostics.entries("*").iter().map(|entry| entry.kind).collect();
    assert!(kinds.contains(&DiagnosticKind::Ssh) && kinds.contains(&DiagnosticKind::Stderr));
}

#[tokio::test]
async fn exec_status_255_is_an_ssh_failure_classified_by_its_stderr() {
    let denied = Scripted::new(finish(&[], b"me@box: Permission denied (publickey).\n", Some(255)));
    let error = ssh_exec(&exec_env(denied), exec_options(Duration::from_secs(5))).await.unwrap_err();
    assert_eq!(error.kind, FailureClass::Terminal);
    assert_eq!(error.exit_code, Some(255));
    assert!(error.message.starts_with("ssh me@box failed:\n") && error.message.contains("Permission denied"));
    let silent = Scripted::new(finish(&[], b"", Some(255)));
    let error = ssh_exec(&exec_env(silent), exec_options(Duration::from_secs(5))).await.unwrap_err();
    assert_eq!((error.kind, error.message.as_str()), (FailureClass::Transient, "ssh me@box failed:\nssh exited with status 255"));
    let signalled = Scripted::new(Script::Finish { stdout: Vec::new(), stderr: Vec::new(), exit: ChildExit { code: None, signal: Some("SIGTERM".to_owned()) } });
    let error = ssh_exec(&exec_env(signalled), exec_options(Duration::from_secs(5))).await.unwrap_err();
    assert_eq!(error.message, "ssh me@box failed:\nssh exited on SIGTERM");
}

#[tokio::test]
async fn exec_capture_cap_stops_keeping_bytes_past_four_megabytes_and_still_ends() {
    let chunk = vec![b'x'; 1024 * 1024];
    let many: Vec<&[u8]> = (0..6).map(|_| chunk.as_slice()).collect();
    let env = exec_env(Scripted::new(finish(&many, b"", Some(0))));
    let done = ssh_exec(&env, exec_options(Duration::from_secs(20))).await.unwrap();
    assert!(done.stdout.len() >= MAX_CAPTURE_BYTES, "the first four megabytes are kept");
    assert!(done.stdout.len() < 6 * 1024 * 1024, "the rest is read and dropped");
}

#[tokio::test]
async fn exec_deadline_kills_the_child_and_reports_a_transient_timeout() {
    let spawner = Scripted::new(Script::Hang);
    let error = ssh_exec(&exec_env(spawner.clone()), exec_options(Duration::from_millis(60))).await.unwrap_err();
    assert!(spawner.was_killed.load(Ordering::SeqCst));
    assert_eq!(error.kind, FailureClass::Transient);
    assert_eq!(error.message, "ssh me@box timed out after 60 ms.");
}

#[tokio::test]
async fn exec_start_failures_are_terminal_and_a_missing_client_is_named() {
    let missing = Scripted::new(Script::StartFails(io::ErrorKind::NotFound));
    let error = ssh_exec(&exec_env(missing), exec_options(Duration::from_secs(5))).await.unwrap_err();
    assert_eq!((error.kind, error.message.as_str()), (FailureClass::Terminal, "The OpenSSH client (ssh) was not found on PATH."));
    let broken = Scripted::new(Script::StartFails(io::ErrorKind::PermissionDenied));
    let error = ssh_exec(&exec_env(broken), exec_options(Duration::from_secs(5))).await.unwrap_err();
    assert!(error.is_terminal() && error.message.starts_with("ssh failed to start: "));
    let refused = Arc::new(Scripted { script: Script::Hang, spawn_error: true, seen: Mutex::new(Vec::new()), was_killed: Arc::new(AtomicBool::new(false)) });
    let error = ssh_exec(&exec_env(refused), exec_options(Duration::from_secs(5))).await.unwrap_err();
    assert_eq!(error.message, "Could not start ssh: no runtime");
}

// ---- private_dir ----

fn windows_env(vars: &[(&str, &str)], tools: Tools) -> SshEnv {
    env_with(Platform::Windows, vars, Configs { generic: None, own: None }, Scripted::new(Script::Hang), tools)
}

#[tokio::test]
async fn private_dir_plain_path_rules() {
    assert!(is_plain_path("C:\\ProgramData") && !is_plain_path("C:\\Program Files") && !is_plain_path("C:\\Users\\김철수") && !is_plain_path(""));
    let shared = [("ProgramData", "C:\\ProgramData"), ("PUBLIC", "C:\\Users\\Public")];
    let none = || Tools(Box::new(|_, _| output(0, "C:\\Users\\김철수\\AppData\\Roaming\\Mixdog\r\n")));
    let plain = windows_env(&[shared[0], shared[1], ("USERNAME", "jae")], no_tools());
    let jae = Path::new("C:\\Users\\jae\\AppData\\Roaming\\Mixdog");
    assert_eq!(resolve_plain_dir_with(&plain, jae, "askpass", |_| {}).await, PathBuf::from("C:\\Users\\jae\\AppData\\Roaming\\Mixdog\\askpass"));
    let korean = Path::new("C:\\Users\\김철수\\AppData\\Local\\Temp\\mixdog-plain-test");
    let short = windows_env(
        &[shared[0], shared[1], ("USERNAME", "jae")],
        Tools(Box::new(|command, args| {
            assert_eq!(command, "powershell.exe");
            assert!(args.last().unwrap().contains("GetFolder('C:\\Users\\김철수"));
            output(0, "C:\\Users\\KIMCHE~1\\AppData\\Roaming\\Mixdog\r\n")
        })),
    );
    let created = Mutex::new(Vec::new());
    let got = resolve_plain_dir_with(&short, korean, "askpass", |folder| created.lock().unwrap().push(folder.to_owned())).await;
    assert_eq!(got, PathBuf::from("C:\\Users\\KIMCHE~1\\AppData\\Roaming\\Mixdog\\askpass"));
    assert_eq!(created.lock().unwrap().as_slice(), [korean.to_owned()], "the folder exists before its short name is asked");
    // No 8.3 names on the volume: a folder of its own under ProgramData, then Public.
    let no_short = windows_env(&[shared[0], shared[1], ("USERNAME", "Kim Cheol")], none());
    assert_eq!(resolve_plain_dir_with(&no_short, korean, "askpass", |_| {}).await, PathBuf::from("C:\\ProgramData\\mixdog-askpass-Kim_Cheol"));
    let public_only = windows_env(&[shared[1], ("USERNAME", "k")], none());
    assert_eq!(resolve_plain_dir_with(&public_only, korean, "askpass", |_| {}).await, PathBuf::from("C:\\Users\\Public\\mixdog-askpass-k"));
    // The system drive is the last root.
    let drive_only = windows_env(&[("SystemDrive", "C:"), ("USERNAME", "k")], none());
    assert_eq!(resolve_plain_dir_with(&drive_only, korean, "askpass", |_| {}).await, PathBuf::from("C:\\mixdog-askpass-k"));
    // A failing PowerShell is no short name.
    let broken = windows_env(&[shared[0], ("USERNAME", "k")], Tools(Box::new(|_, _| Err(io::Error::other("no powershell")))));
    assert_eq!(resolve_plain_dir_with(&broken, korean, "askpass", |_| {}).await, PathBuf::from("C:\\ProgramData\\mixdog-askpass-k"));
    // Other platforms use the path as it is.
    let linux = plain_env(Platform::Linux, &[], None);
    assert_eq!(resolve_plain_dir_with(&linux, Path::new("/home/김철수/.config/Mixdog"), "askpass", |_| {}).await, PathBuf::from("/home/김철수/.config/Mixdog/askpass"));
}

// ---- agent ----

const SC_RUNNING: &str = "SERVICE_NAME: ssh-agent\n        TYPE               : 10  WIN32_OWN_PROCESS\n        STATE              : 4  RUNNING\n";
const SC_STOPPED: &str = "SERVICE_NAME: ssh-agent\n        STATE              : 1  STOPPED\n";
const SC_MISSING: &str = "[SC] EnumQueryServicesStatus:OpenService FAILED 1060:\n\nThe specified service does not exist as an installed service.\n";

fn qc(start_type: &str) -> String {
    format!("SERVICE_NAME: ssh-agent\n        START_TYPE         : {start_type}\n")
}

/// Answers sc.exe and ssh-add like the OS; `add` is ssh-add -l's exit code.
fn os_tools(query: &'static str, config: String, add: i32) -> Tools {
    Tools(Box::new(move |command, args| match command {
        "sc.exe" => output(0, if args[0] == "query" { query } else { &config }),
        "ssh-add" => output(add, ""),
        other => Err(io::Error::other(format!("unexpected {other}"))),
    }))
}

fn agent_env(platform: Platform, vars: &[(&str, &str)], tools: Tools) -> SshEnv {
    env_with(platform, vars, Configs { generic: None, own: None }, Scripted::new(Script::Hang), tools)
}

#[test]
fn agent_service_output_is_read_for_state_and_start_type() {
    assert_eq!(parse_service_state(SC_RUNNING), ServiceState::Running);
    assert_eq!(parse_service_state(SC_STOPPED), ServiceState::Stopped);
    assert_eq!(parse_service_state(SC_MISSING), ServiceState::Missing);
    assert_eq!(parse_service_state("garbage"), ServiceState::Unknown);
    assert!(service_is_disabled(&qc("4   DISABLED")));
    assert!(!service_is_disabled(&qc("3   DEMAND_START")));
}

#[tokio::test]
async fn agent_windows_a_stopped_service_is_started_a_disabled_one_is_enabled_first_a_missing_one_has_nothing_to_start() {
    let stopped = agent_status(&agent_env(Platform::Windows, &[], os_tools(SC_STOPPED, qc("3   DEMAND_START"), 0))).await;
    assert_eq!((stopped.state, stopped.command.as_deref()), (AgentState::Stopped, Some("Start-Service ssh-agent; ssh-add")));
    let disabled = agent_status(&agent_env(Platform::Windows, &[], os_tools(SC_STOPPED, qc("4   DISABLED"), 0))).await;
    assert_eq!(
        (disabled.state, disabled.command.as_deref()),
        (AgentState::Disabled, Some("Set-Service ssh-agent -StartupType Manual; Start-Service ssh-agent; ssh-add"))
    );
    let missing = agent_status(&agent_env(Platform::Windows, &[], os_tools(SC_MISSING, qc("2   AUTO_START"), 0))).await;
    assert_eq!((missing.state, missing.command), (AgentState::Missing, None));
}

#[tokio::test]
async fn agent_windows_a_running_agent_is_empty_or_holds_keys() {
    let running = agent_status(&agent_env(Platform::Windows, &[], os_tools(SC_RUNNING, qc("2   AUTO_START"), 0))).await;
    assert_eq!((running.state, running.command), (AgentState::Running, None));
    let empty = agent_status(&agent_env(Platform::Windows, &[], os_tools(SC_RUNNING, qc("2   AUTO_START"), 1))).await;
    assert_eq!((empty.state, empty.command.as_deref()), (AgentState::Empty, Some("ssh-add")));
}

#[tokio::test]
async fn agent_macos_and_linux_no_socket_an_unreachable_one_an_empty_one_and_one_with_keys() {
    let none = agent_status(&agent_env(Platform::Linux, &[], os_tools("", String::new(), 0))).await;
    assert_eq!((none.state, none.command.as_deref()), (AgentState::Missing, Some(r#"eval "$(ssh-agent -s)" && ssh-add"#)));
    let socket = [("SSH_AUTH_SOCK", "/tmp/agent.1")];
    assert_eq!(agent_status(&agent_env(Platform::MacOs, &socket, os_tools("", String::new(), 2))).await.state, AgentState::Missing);
    let empty = agent_status(&agent_env(Platform::MacOs, &socket, os_tools("", String::new(), 1))).await;
    assert_eq!((empty.state, empty.command.as_deref()), (AgentState::Empty, Some("ssh-add")));
    let running = agent_status(&agent_env(Platform::Linux, &socket, os_tools("", String::new(), 0))).await;
    assert_eq!((running.state, running.command), (AgentState::Running, None));
}

#[tokio::test]
async fn agent_a_machine_without_the_tools_reports_an_unknown_state_instead_of_failing() {
    let state = agent_status(&agent_env(Platform::Linux, &[("SSH_AUTH_SOCK", "/x")], no_tools())).await;
    assert_eq!((state.state, state.command), (AgentState::Unknown, None));
}
