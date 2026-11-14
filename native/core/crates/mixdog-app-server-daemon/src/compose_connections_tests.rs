//! The adapters of the connections composition: what they answer over fakes (no process is started and no window is opened).

use std::sync::atomic::{AtomicBool, Ordering};

use mixdog_core_api::mock::MockHostChannel;
use mixdog_core_domains::notify::engine::ToastStyle;
use mixdog_ssh::context::{ChildExit, SshChild};
use mixdog_ssh::install_wire::{ServerArch, ServerOs};
use tokio::io::AsyncWrite;

use super::*;

/// A file system with the listed files.
struct Files(Vec<PathBuf>);

impl ConfigFiles for Files {
    fn read_text(&self, _path: &Path) -> Option<String> {
        None
    }

    fn list_names(&self, _directory: &Path) -> Vec<String> {
        Vec::new()
    }

    fn is_file(&self, path: &Path) -> bool {
        self.0.iter().any(|file| file == path)
    }
}

struct FakeChild {
    stdout: Option<Vec<u8>>,
    stderr: Option<Vec<u8>>,
    code: Option<i32>,
    killed: Arc<AtomicBool>,
}

#[async_trait]
impl SshChild for FakeChild {
    fn take_stdin(&mut self) -> Option<Box<dyn AsyncWrite + Send + Unpin>> {
        Some(Box::new(tokio::io::sink()))
    }

    fn take_stdout(&mut self) -> Option<Box<dyn AsyncRead + Send + Unpin>> {
        self.stdout.take().map(|bytes| Box::new(std::io::Cursor::new(bytes)) as Box<dyn AsyncRead + Send + Unpin>)
    }

    fn take_stderr(&mut self) -> Option<Box<dyn AsyncRead + Send + Unpin>> {
        self.stderr.take().map(|bytes| Box::new(std::io::Cursor::new(bytes)) as Box<dyn AsyncRead + Send + Unpin>)
    }

    async fn wait(&mut self) -> io::Result<ChildExit> {
        Ok(ChildExit { code: self.code, signal: None })
    }

    fn kill(&mut self) {
        self.killed.store(true, Ordering::SeqCst);
    }
}

/// Starts nothing: answers with a scripted child and remembers what it was asked to run.
struct FakeSpawner {
    started: Mutex<Vec<PreparedSpawn>>,
    child: Mutex<Option<FakeChild>>,
}

impl SshSpawner for FakeSpawner {
    fn spawn(&self, prepared: &PreparedSpawn) -> io::Result<Box<dyn SshChild>> {
        self.started.lock().unwrap().push(prepared.clone());
        match self.child.lock().unwrap().take() {
            Some(child) => Ok(Box::new(child)),
            None => Err(io::Error::new(io::ErrorKind::NotFound, "nothing to start")),
        }
    }
}

fn no_env(_: &str) -> Option<String> {
    None
}

fn test_env(spawner: Arc<dyn SshSpawner>, server_cores_dir: Option<PathBuf>) -> SshEnv {
    SshEnv {
        platform: Platform::Linux,
        env: BTreeMap::new(),
        home: PathBuf::from("/home/user"),
        askpass_helper: None,
        server_cores_dir,
        files: Arc::new(Files(Vec::new())),
        config_files: Arc::new(NoConfigFiles),
        tools: Arc::new(SpawnedTools::new(spawner.clone())),
        spawner,
        diagnostics: Arc::new(Diagnostics::new()),
    }
}

#[tokio::test]
async fn a_tool_reports_what_it_printed_and_its_exit_code() {
    let spawner = Arc::new(FakeSpawner {
        started: Mutex::new(Vec::new()),
        child: Mutex::new(Some(FakeChild { stdout: Some(b"OpenSSH_9.5".to_vec()), stderr: Some(b"warning".to_vec()), code: Some(3), killed: Arc::default() })),
    });
    let tools = SpawnedTools::new(spawner.clone());
    let output = tools.run(Path::new("ssh"), &["-V".to_owned()], Duration::from_secs(5)).await.expect("the tool ran");
    assert_eq!(output, ToolOutput { exit_code: Some(3), stdout: "OpenSSH_9.5".to_owned(), stderr: "warning".to_owned() });
    let started = spawner.started.lock().unwrap();
    assert_eq!(started.len(), 1);
    assert_eq!((started[0].command.as_path(), started[0].args.as_slice(), started[0].env.is_none()), (Path::new("ssh"), &["-V".to_owned()][..], true));
}

#[tokio::test]
async fn a_tool_that_cannot_be_started_is_the_error_of_the_run() {
    let spawner = Arc::new(FakeSpawner { started: Mutex::new(Vec::new()), child: Mutex::new(None) });
    let error = SpawnedTools::new(spawner).run(Path::new("ssh-keygen"), &[], Duration::from_secs(5)).await.expect_err("nothing was started");
    assert_eq!(error.kind(), io::ErrorKind::NotFound);
}

#[tokio::test]
async fn nothing_staged_is_a_local_payload_failure_and_an_identity_that_matches_no_server() {
    let spawner: Arc<dyn SshSpawner> = Arc::new(FakeSpawner { started: Mutex::new(Vec::new()), child: Mutex::new(None) });
    let payloads = LocalPayloads::new(test_env(spawner, None));
    assert_eq!(payloads.identity(), &ServerIdentity { version: String::new(), build: String::new() });
    let error = payloads.binary(ServerPlatform { os: ServerOs::Linux, arch: ServerArch::X64 }).err().expect("no runtime is staged");
    assert_eq!(error.code, "local-payload");
}

#[test]
fn the_askpass_helper_is_the_named_file_else_the_one_beside_the_core() {
    let dir = PathBuf::from("/app/core");
    let beside = dir.join(if cfg!(windows) { "mixdog-askpass.exe" } else { "mixdog-askpass" });
    let named = PathBuf::from("/elsewhere/askpass");
    let env = |name: &str| (name == ASKPASS_ENV).then(|| named.to_string_lossy().into_owned());
    assert_eq!(askpass_helper(&env, Some(&dir), &Files(vec![named.clone(), beside.clone()])), Some(named.clone()));
    assert_eq!(askpass_helper(&env, Some(&dir), &Files(vec![beside.clone()])), Some(beside.clone()));
    assert_eq!(askpass_helper(&no_env, Some(&dir), &Files(vec![named, beside.clone()])), Some(beside));
    assert_eq!(askpass_helper(&no_env, Some(&dir), &Files(Vec::new())), None);
    assert_eq!(askpass_helper(&no_env, None, &Files(Vec::new())), None);
}

#[test]
fn the_server_runtimes_are_the_named_folder_else_the_staged_one_beside_the_core() {
    let dir = PathBuf::from("/app/core");
    let staged = PathBuf::from("/app/server-cores");
    let manifest = staged.join(SERVER_MANIFEST_FILE);
    let named = |name: &str| (name == SERVER_CORES_ENV).then(|| "/custom/cores".to_owned());
    assert_eq!(server_cores_dir(&named, Some(&dir), &Files(Vec::new())), Some(PathBuf::from("/custom/cores")));
    assert_eq!(server_cores_dir(&no_env, Some(&dir), &Files(vec![manifest])), Some(staged));
    // A folder without the release manifest is nothing staged.
    assert_eq!(server_cores_dir(&no_env, Some(&dir), &Files(Vec::new())), None);
    assert_eq!(server_cores_dir(&no_env, None, &Files(Vec::new())), None);
}

#[test]
fn the_presence_watch_reports_changes_only() {
    let mut watch = PresenceWatch::default();
    assert_eq!(watch.sample(false), None, "an absent host at the start is no change");
    assert_eq!(watch.sample(true), Some(true));
    assert_eq!(watch.sample(true), None);
    assert_eq!(watch.sample(false), Some(false));
    assert_eq!(watch.sample(false), None);
    assert_eq!(watch.sample(true), Some(true));
}

fn focus(windows: Vec<WindowFocusEntry>) -> HostWindowFocus {
    HostWindowFocus::new(Arc::new(move || Some(WindowFocusValue { windows: windows.clone() })))
}

fn entry(connection_id: &str, visible: bool, focused: bool, session_id: Option<&str>) -> WindowFocusEntry {
    WindowFocusEntry { connection_id: connection_id.to_owned(), visible, focused, session_id: session_id.map(str::to_owned) }
}

#[test]
fn a_window_is_in_front_only_when_it_is_visible_and_focused() {
    let source = focus(vec![entry("a", true, true, Some("s1")), entry("b", true, false, Some("s2")), entry("c", false, true, None)]);
    assert!(source.is_foreground("a"));
    assert!(!source.is_foreground("b"));
    assert!(!source.is_foreground("c"));
    assert!(!source.is_foreground("unknown"));
}

#[test]
fn a_session_is_on_screen_when_the_focused_window_of_the_server_shows_it() {
    let source = focus(vec![entry("a", true, true, Some("s1")), entry("b", true, false, Some("s2"))]);
    assert!(source.session_on_screen("a", "s1"));
    assert!(!source.session_on_screen("a", "s2"));
    assert!(!source.session_on_screen("b", "s2"), "an unfocused window shows nothing to the person");
}

#[test]
fn a_host_that_reported_no_window_state_has_no_window_in_front() {
    let source = HostWindowFocus::new(Arc::new(|| None));
    assert!(!source.is_foreground("a"));
    assert!(!source.session_on_screen("a", "s"));
}

fn toasts(host: Arc<MockHostChannel>, percent: i64) -> HostToasts {
    HostToasts::new(host, Arc::new(move || ToastStyle::for_volume(percent)))
}

fn shown(title: &str) -> HostNotificationShowParams {
    HostNotificationShowParams {
        title: title.to_owned(),
        body: "done".to_owned(),
        thread_id: None,
        sound: None,
        volume: None,
        connection_id: Some("srv".to_owned()),
        label: Some("Server".to_owned()),
    }
}

#[test]
fn a_servers_toast_goes_to_the_host_with_this_pcs_sound_and_volume() {
    let host = Arc::new(MockHostChannel::default());
    host.claim(HostCapability::Notifications);
    toasts(host.clone(), 40).show(shown("Server · answer")).expect("the host takes it");
    let sent = host.sent();
    assert_eq!(sent.len(), 1);
    let (capability, method, params) = &sent[0];
    assert_eq!((*capability, method.as_str()), (HostCapability::Notifications, "host/notification/show"));
    assert_eq!(params["title"], "Server · answer");
    assert_eq!(params["connectionId"], "srv");
    assert_eq!(params["sound"], ToastStyle::SOUND);
    assert_eq!(params["volume"], 40.0);
}

#[test]
fn a_muted_volume_is_the_silent_sound() {
    let host = Arc::new(MockHostChannel::default());
    host.claim(HostCapability::Notifications);
    toasts(host.clone(), 0).show(shown("t")).expect("the host takes it");
    assert_eq!(host.sent()[0].2["sound"], ToastStyle::MUTED);
}

#[test]
fn a_toast_without_a_host_is_the_error_of_the_show() {
    let host = Arc::new(MockHostChannel::default());
    assert!(toasts(host, 50).show(shown("t")).is_err());
}

#[test]
fn the_fixed_texts_keep_the_servers_name_where_the_notifier_puts_it() {
    let texts = EnglishTexts;
    assert!(texts.lost_title().contains("{{name}}"));
    assert!(texts.restored_title().contains("{{name}}"));
    assert_eq!(texts.attachment_label(AttachmentKind::Image), "Image");
    assert_eq!(texts.attachment_label(AttachmentKind::Video), "Video");
    assert_eq!(texts.attachment_label(AttachmentKind::File), "File");
    assert_eq!(texts.turn_failed(), "The turn stopped with an error.");
}

/// Remembers the power events it was told of.
struct PowerSpy(Mutex<Vec<PowerEvent>>);

impl PowerSink for PowerSpy {
    fn power(&self, event: PowerEvent) {
        self.0.lock().unwrap().push(event);
    }
}

#[test]
fn a_power_event_reaches_every_sink_in_order() {
    let (first, second) = (Arc::new(PowerSpy(Mutex::default())), Arc::new(PowerSpy(Mutex::default())));
    let sinks = PowerSinks(vec![first.clone(), second.clone()]);
    sinks.power(PowerEvent::Suspend);
    sinks.power(PowerEvent::Resume);
    for spy in [first, second] {
        assert_eq!(*spy.0.lock().unwrap(), vec![PowerEvent::Suspend, PowerEvent::Resume]);
    }
}

#[test]
fn a_power_event_before_the_service_exists_is_nobodys() {
    LateConnectionsPower::default().power(PowerEvent::Suspend);
}
