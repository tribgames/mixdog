//! DS-PROC-2, 3 and 8 and the terminal golden corpus: the Node twin's recorded behavior
//! (`fixtures/terminal-pipeline.json`, `fixtures/terminal-bridge.json`, the shared
//! `core/fixtures/desktop/terminal/corpus.json`) replayed against the Rust tab layer, and live
//! tabs over real shells.

mod common;

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Condvar;
use std::sync::Mutex;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;
use std::time::Duration;

use async_trait::async_trait;
use common::*;
use mixdog_core_api::domain::process::ProcessManager;
use mixdog_core_api::domain::process::PtySize;
use mixdog_spawn::LocalProcessManager;
use mixdog_spawn::terminal::*;
use serde_json::Value;
use serde_json::json;
use tokio_util::sync::CancellationToken;

// ----- the output pipeline, against the Node twin ----------------------------------------------

fn fnv(units: &[u16]) -> u32 {
    let mut hash: u32 = 0x811c_9dc5;
    for unit in units {
        hash ^= u32::from(*unit & 0xff);
        hash = hash.wrapping_mul(0x0100_0193);
        hash ^= u32::from(*unit >> 8);
        hash = hash.wrapping_mul(0x0100_0193);
    }
    hash
}

fn hex(text: &str) -> Vec<u8> {
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap())
        .collect()
}

fn state_json(state: Option<ActivityState>) -> Value {
    state.map_or(Value::Null, |s| json!(s.as_str()))
}

struct Pipeline {
    scanner: Option<MarkerScanner>,
    decoder: Utf8Decoder,
    buffer: ReplayBuffer,
    activity: ActivityTracker,
    transitions: Vec<Value>,
}

impl Pipeline {
    fn new(integrated: bool, infer_start: bool, start: u64, limit: usize) -> Self {
        Self {
            scanner: integrated.then(MarkerScanner::default),
            decoder: Utf8Decoder::default(),
            buffer: ReplayBuffer::new(limit, start),
            activity: ActivityTracker::new(infer_start),
            transitions: Vec::new(),
        }
    }

    fn note(&mut self, change: Option<Option<ActivityState>>) {
        if let Some(state) = change {
            self.transitions.push(state_json(state));
        }
    }

    fn data(&mut self, bytes: &[u8]) {
        let decoded = self.decoder.push(bytes);
        let (text, markers) = match self.scanner.as_mut() {
            Some(scanner) => scanner.scan(&decoded),
            None => (decoded, Vec::new()),
        };
        self.buffer.append(&text);
        for marker in markers {
            let change = self.activity.marker(marker);
            self.note(change);
        }
    }

    fn finish_stream(&mut self) {
        if let Some(scanner) = self.scanner.as_mut() {
            let held = scanner.flush();
            self.buffer.append(&held);
        }
    }
}

/// The deterministic 5 MB burst both sides generate.
fn burst() -> Vec<u8> {
    let mut out = String::new();
    let mut i = 0u32;
    while out.len() < 5 * 1024 * 1024 {
        out.push_str(&format!("burst line {i:08} é世 \r\n"));
        i += 1;
    }
    out.into_bytes()
}

#[test]
fn output_pipeline_matches_terminal_manager() {
    let recorded = fixture("tests/fixtures/terminal-pipeline.json");
    let start = recorded["startOffset"].as_u64().unwrap();
    let limit = recorded["limit"].as_u64().unwrap() as usize;
    let mut count = 0;
    for scenario in recorded["scenarios"].as_array().unwrap() {
        let name = scenario["name"].as_str().unwrap();
        let options = &scenario["options"];
        let mut pipe = Pipeline::new(
            options["integrated"] != json!(false),
            options["inferStart"] == json!(true),
            start,
            limit,
        );
        if scenario.get("burst").is_some() {
            let bytes = burst();
            assert_eq!(bytes.len() as u64, scenario["burst"]["bytes"].as_u64().unwrap());
            for chunk in bytes.chunks(scenario["burst"]["chunk"].as_u64().unwrap() as usize) {
                pipe.data(chunk);
            }
        }
        for op in scenario["ops"].as_array().unwrap() {
            if let Some(data) = op.get("data") {
                pipe.data(&hex(data.as_str().unwrap()));
            } else if let Some(focus) = op.get("focus") {
                let change = pipe.activity.set_focus(focus[0].as_str().unwrap(), focus[1].as_bool().unwrap());
                pipe.note(change);
            } else if let Some(input) = op.get("input") {
                if pipe.scanner.is_some() {
                    let change = pipe.activity.input(input.as_str().unwrap());
                    pipe.note(change);
                }
            } else if op.get("exit").is_some() {
                pipe.finish_stream();
                let change = pipe.activity.exit();
                pipe.note(change);
            } else if op.get("flush").is_some() {
                pipe.finish_stream();
            }
        }
        let expect = &scenario["expect"];
        let replay = pipe.buffer.read();
        let units: Vec<u16> = replay.encode_utf16().collect();
        assert_eq!(pipe.buffer.cursor(), expect["cursor"].as_u64().unwrap(), "{name}: cursor");
        assert_eq!(pipe.buffer.trimmed(), expect["trimmed"].as_bool().unwrap(), "{name}: trimmed");
        assert_eq!(units.len() as u64, expect["length"].as_u64().unwrap(), "{name}: length");
        assert_eq!(u64::from(fnv(&units)), expect["fnv"].as_u64().unwrap(), "{name}: replay text");
        assert_eq!(String::from_utf16_lossy(&units[..units.len().min(80)]), expect["head"].as_str().unwrap(), "{name}: head");
        assert_eq!(String::from_utf16_lossy(&units[units.len().saturating_sub(80)..]), expect["tail"].as_str().unwrap(), "{name}: tail");
        if let Some(full) = expect["replay"].as_str() {
            assert_eq!(replay, full, "{name}: replay");
        }
        assert_eq!(Value::Array(pipe.transitions), expect["transitions"], "{name}: activity transitions");
        count += 1;
    }
    assert_eq!(count, 24);
}

#[test]
fn replay_window_keeps_cursors_stable_across_trimming() {
    let mut buffer = ReplayBuffer::new(10, 100);
    buffer.append("abcdefghij");
    buffer.append("klm");
    assert_eq!(buffer.read(), "defghijklm");
    assert_eq!(buffer.cursor(), 113);
    assert!(buffer.trimmed());
    let kept = buffer.read_since(110);
    assert_eq!((kept.text.as_str(), kept.cursor, kept.reset), ("klm", 113, false));
    assert!(buffer.read_since(100).reset, "a cursor below the window resets");
    assert!(buffer.read_since(114).reset, "a cursor from the future resets");
    assert_eq!(buffer.read_since(113).text, "");
    // An astral character counts as two positions, as in the Node twin.
    let mut wide = ReplayBuffer::new(100, 0);
    wide.append("a😀b");
    assert_eq!(wide.cursor(), 4);
    assert_eq!(cursor_epoch(1_700_000_000_000), 1_700_000_000_000_000);
}

#[test]
fn shell_integration_plans_match_the_node_twin() {
    let recorded = fixture("tests/fixtures/terminal-pipeline.json");
    let root = scratch_dir("plans");
    for case in recorded["plans"].as_array().unwrap() {
        let spawn = &case["spawn"];
        let profile = SpawnProfile {
            path: spawn["path"].as_str().unwrap().to_owned(),
            args: spawn["args"].as_array().map_or_else(Vec::new, |a| a.iter().map(|v| v.as_str().unwrap().to_owned()).collect()),
            env: spawn["env"].as_object().map_or_else(Vec::new, |o| o.iter().map(|(k, v)| (k.clone(), v.as_str().unwrap().to_owned())).collect()),
        };
        let windows = case["platform"] == "win32";
        let plan = plan_shell_integration(&profile, (!case["noRoot"].as_bool().unwrap()).then_some(root.as_path()), &|_| None, windows);
        let expect = &case["plan"];
        assert_eq!(plan.path, expect["path"].as_str().unwrap());
        let args: Vec<&str> = plan.args.iter().map(String::as_str).collect();
        let want_args: Vec<&str> = expect["args"].as_array().unwrap().iter().map(|v| v.as_str().unwrap()).collect();
        assert_eq!(args, want_args, "{spawn}");
        let env: HashMap<&str, &str> = plan.env.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
        let want_env: HashMap<&str, &str> = expect["env"].as_object().unwrap().iter().map(|(k, v)| (k.as_str(), v.as_str().unwrap())).collect();
        assert_eq!(env, want_env, "{spawn}");
        let integration = plan.integration.map(|i| format!("{i:?}").to_lowercase());
        assert_eq!(integration.as_deref(), expect["integration"].as_str(), "{spawn}");
    }

    // The startup files of bash and zsh are written byte for byte as the Node twin writes them.
    let shell = &recorded["shellFiles"];
    let files_root = scratch_dir("plans-files");
    let bash = plan_shell_integration(
        &SpawnProfile { path: "/bin/bash".into(), args: vec!["-i".into()], env: vec![] },
        Some(files_root.as_path()),
        &|_| None,
        false,
    );
    assert_eq!(bash.integration, Some(Integration::Bash));
    let shape: Vec<&str> = bash.args.iter().enumerate().map(|(i, a)| if i == 1 { "<script>" } else { a.as_str() }).collect();
    let want: Vec<&str> = shell["bashArgsShape"].as_array().unwrap().iter().map(|v| v.as_str().unwrap()).collect();
    assert_eq!(shape, want);
    assert!(bash.args[1].ends_with("/bash/mixdog.bash"), "{:?}", bash.args);
    let zsh = plan_shell_integration(
        &SpawnProfile { path: "/bin/zsh".into(), args: vec![], env: vec![] },
        Some(files_root.as_path()),
        &|name| (name == "HOME").then(|| "/home/u".to_owned()),
        false,
    );
    let mut keys: Vec<&str> = zsh.env.iter().map(|(k, _)| k.as_str()).collect();
    keys.sort();
    let want_keys: Vec<&str> = shell["zshEnvKeys"].as_array().unwrap().iter().map(|v| v.as_str().unwrap()).collect();
    assert_eq!(keys, want_keys);
    let zsh_env: HashMap<&str, &str> = zsh.env.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
    assert_eq!(zsh_env["MIXDOG_USER_ZDOTDIR"], shell["zshUserZdotdir"].as_str().unwrap());
    assert_eq!(zsh_env["MIXDOG_ZDOTDIR_UNSET"], shell["zshUnsetFlag"].as_str().unwrap());
    let login = plan_shell_integration(
        &SpawnProfile { path: "/bin/bash".into(), args: vec!["--login".into()], env: vec![("PROMPT_COMMAND".into(), "inherited".into())] },
        Some(files_root.as_path()),
        &|_| None,
        false,
    );
    let prompt = &login.env.iter().find(|(k, _)| k == "PROMPT_COMMAND").unwrap().1;
    assert_eq!(prompt.ends_with("; inherited"), shell["loginPromptCommandSuffix"].as_bool().unwrap());
    assert!(prompt.starts_with(shell["loginPromptCommandPrefix"].as_str().unwrap()));
    let version_dir = std::fs::read_dir(&files_root).unwrap().next().unwrap().unwrap().path();
    let written = shell["files"].as_object().unwrap();
    for (relative, content) in written {
        let actual = std::fs::read_to_string(version_dir.join(relative)).unwrap_or_else(|e| panic!("{relative}: {e}"));
        assert_eq!(actual, content.as_str().unwrap().replace("\r\n", "\n"), "{relative}");
    }
}

// ----- the terminal tool's formatting and commands, against the Node twin ----------------------

#[test]
fn terminal_tool_arguments_validate_like_the_node_twin() {
    let recorded = fixture("tests/fixtures/terminal-bridge.json");
    for case in recorded["validate"].as_array().unwrap() {
        let args = &case["args"];
        let node = &case["result"];
        let got = validate_args(args);
        if node["ok"] == json!(false) {
            assert_eq!(got.unwrap_err(), node["error"].as_str().unwrap(), "{args}");
            continue;
        }
        let v = got.unwrap_or_else(|e| panic!("{args}: {e}"));
        assert_eq!(format!("{:?}", v.action).to_lowercase(), node["action"].as_str().unwrap(), "{args}");
        assert_eq!(v.tab.map(u64::from), node["tab"].as_u64(), "{args}");
        assert_eq!(v.since, node["since"].as_u64(), "{args}");
        assert_eq!(v.grep.as_deref(), node["grep"].as_str(), "{args}");
        assert_eq!(v.offset_lines.map(|n| n as u64), node["offset_lines"].as_u64(), "{args}");
        assert_eq!(v.command.as_deref(), node["command"].as_str(), "{args}");
        if node.get("lines").is_some() {
            assert_eq!(v.lines as u64, node["lines"].as_u64().unwrap(), "{args}");
        }
    }
}

#[test]
fn terminal_tool_output_is_shaped_like_the_node_twin() {
    let recorded = fixture("tests/fixtures/terminal-bridge.json");
    let cases = recorded["client"].as_array().unwrap();
    assert!(cases.len() >= 20);
    for case in cases {
        let validated = validate_args(&case["args"]).unwrap();
        let text = render(&validated, &case["value"], 50 * 1024);
        assert_eq!(text, case["text"].as_str().unwrap(), "{}", case["args"]);
    }
}

struct ScriptedBackend {
    tabs: Vec<SessionTab>,
    snapshots: HashMap<String, Replay>,
    start: Option<SessionTab>,
    shown: bool,
    writes: Mutex<Vec<(String, String)>>,
}

fn tab_of(value: &Value) -> SessionTab {
    SessionTab {
        tab: value["tab"].as_u64().unwrap() as u32,
        id: value["id"].as_str().unwrap().to_owned(),
        shell: value["shell"].as_str().unwrap().to_owned(),
        running: value["running"].as_bool().unwrap(),
        cwd: value["cwd"].as_str().map(str::to_owned),
    }
}

#[async_trait]
impl BridgeBackend for ScriptedBackend {
    async fn session_tabs(&self, _: &str) -> Vec<SessionTab> {
        self.tabs.clone()
    }

    async fn write(&self, id: &str, data: &str) {
        self.writes.lock().unwrap().push((id.to_owned(), data.to_owned()));
    }

    async fn start_terminal(&self, _: &str) -> Result<SessionTab, String> {
        self.start.clone().ok_or_else(|| "the terminal did not start".to_owned())
    }

    async fn reveal_terminal(&self, _: &str, _: &SessionTab, _: &[SessionTab]) -> bool {
        self.shown
    }

    async fn snapshot(&self, id: &str, _since: Option<u64>) -> Option<Replay> {
        self.snapshots.get(id).cloned()
    }
}

#[tokio::test]
async fn terminal_commands_behave_like_the_node_twin() {
    let recorded = fixture("tests/fixtures/terminal-bridge.json");
    for case in recorded["commands"].as_array().unwrap() {
        let command = &case["command"];
        let backend = Arc::new(ScriptedBackend {
            tabs: case["tabs"].as_array().unwrap().iter().map(tab_of).collect(),
            snapshots: case["snapshots"]
                .as_object()
                .unwrap()
                .iter()
                .map(|(id, s)| {
                    (
                        id.clone(),
                        Replay {
                            text: s["text"].as_str().unwrap().to_owned(),
                            cursor: s["cursor"].as_u64().unwrap(),
                            reset: s["reset"].as_bool().unwrap(),
                        },
                    )
                })
                .collect(),
            start: case["start"].is_object().then(|| tab_of(&case["start"])),
            shown: case["shown"].as_bool().unwrap(),
            writes: Mutex::new(Vec::new()),
        });
        let mut args = serde_json::Map::new();
        for key in ["action", "tab", "since", "command"] {
            if let Some(v) = command.get(key) {
                args.insert(key.to_owned(), v.clone());
            }
        }
        let validated = validate_args(&Value::Object(args)).unwrap();
        let bridge = TerminalBridge::with_backend(backend.clone());
        let got = bridge.command(&validated, command["session_id"].as_str().unwrap(), None).await;
        match (&case["error"], got) {
            (Value::String(error), Err(got)) => assert_eq!(&got, error, "{command}"),
            (Value::String(error), Ok(v)) => panic!("{command}: expected error {error}, got {v}"),
            (_, Ok(v)) => assert_eq!(v, case["value"], "{command}"),
            (_, Err(e)) => panic!("{command}: unexpected error {e}"),
        }
        let writes: Vec<Value> = backend.writes.lock().unwrap().iter().map(|(id, d)| json!([id, d])).collect();
        assert_eq!(Value::Array(writes), case["writes"], "{command}");
    }
}

// ----- live tabs -------------------------------------------------------------------------------

#[derive(Clone, PartialEq, Debug)]
enum Ev {
    Activity(String, Option<ActivityState>),
    Owner(SizeOwnerChange),
}

#[derive(Default)]
struct Events {
    log: Mutex<Vec<Ev>>,
    changed: Condvar,
}

impl Events {
    fn all(&self) -> Vec<Ev> {
        self.log.lock().unwrap().clone()
    }

    fn activity(&self, id: &str) -> Vec<Option<ActivityState>> {
        self.all()
            .into_iter()
            .filter_map(|e| match e {
                Ev::Activity(i, s) if i == id => Some(s),
                _ => None,
            })
            .collect()
    }

    fn owners(&self, id: &str) -> Vec<SizeOwnerChange> {
        self.all()
            .into_iter()
            .filter_map(|e| match e {
                Ev::Owner(c) if c.id == id => Some(c),
                _ => None,
            })
            .collect()
    }

    fn wait_for(&self, _what: &str, predicate: impl Fn(&[Ev]) -> bool) {
        let mut log = self.log.lock().unwrap();
        while !predicate(&log) {
            log = self.changed.wait(log).unwrap();
        }
    }
}

impl TerminalEvents for Events {
    fn activity(&self, id: &str, state: Option<ActivityState>) {
        self.log.lock().unwrap().push(Ev::Activity(id.to_owned(), state));
        self.changed.notify_all();
    }

    fn size_owner(&self, change: &SizeOwnerChange) {
        self.log.lock().unwrap().push(Ev::Owner(change.clone()));
        self.changed.notify_all();
    }
}

struct Rig {
    tabs: Arc<TerminalTabs>,
    manager: LocalProcessManager,
    events: Arc<Events>,
    clock_reads: Arc<AtomicUsize>,
    profile: SpawnProfile,
    dir: std::path::PathBuf,
}

async fn rig(name: &str) -> Rig {
    let manager = manager();
    let events = Arc::new(Events::default());
    let clock_reads = Arc::new(AtomicUsize::new(0));
    let mut config = TerminalConfig::new(events.clone());
    let reads = Arc::clone(&clock_reads);
    config.now_ms = Arc::new(move || {
        reads.fetch_add(1, Ordering::SeqCst);
        1_700_000_000_000
    });
    config.shell_integration_dir = Some(scratch_dir(&format!("{name}-integration")));
    let tabs = Arc::new(TerminalTabs::new(manager.clone(), config));
    let profile = tabs.resolve_profile("").await.expect("this machine has a shell");
    Rig {
        tabs,
        manager,
        events,
        clock_reads,
        profile,
        dir: scratch_dir(name),
    }
}

impl Rig {
    fn request(&self) -> EnsureRequest {
        EnsureRequest {
            cwd: Some(self.dir.display().to_string()),
            profile: Some(self.profile.clone()),
            cols: Some(100),
            rows: Some(30),
        }
    }

    fn pty(&self, id: &str) -> Option<PtySize> {
        self.manager.info(&mixdog_protocol::ProcessHandle::from(id)).unwrap().pty
    }

    /// Returns once the feed shows `needle` and, after it, the complete prompt ConPTY draws for
    /// the idle shell. Eight recorded runs ended the prompt in one of three ways, each followed
    /// directly by the next input's echo and nothing else:
    /// - a repaint, `ESC[?25l \n PS <cwd>>` + padding + `ESC[<row>;<col>H ESC[?25h`: closed by the
    ///   cursor show after a cursor position;
    /// - plain text `\r\n PS <cwd>> ` ending in a space;
    /// - plain text `\r\n PS <cwd>>` + `ESC[1C` (the space as a cursor move).
    /// The shell writes its prompt as the last thing before it blocks reading input and the
    /// screen does not change again, so ConPTY has nothing further to paint until the next input
    /// arrives. The feed carries the replay window's text and the window is appended first, so
    /// what this saw is already visible to `snapshot`.
    async fn wait_prompt_frame_after(&self, id: &str, needle: &str) {
        use mixdog_core_api::domain::process::ProcessEvent;
        const HIDE: &str = "\u{1b}[?25l";
        const SHOW: &str = "\u{1b}[?25h";
        let mut events = self.manager.subscribe(&mixdog_protocol::ProcessHandle::from(id), Some(0)).expect("subscribe");
        let mut text = String::new();
        loop {
            match events.next().await.expect("the shell outlives the wait") {
                ProcessEvent::Output { bytes, .. } => text.push_str(&String::from_utf8_lossy(&bytes)),
                ProcessEvent::Exited { .. } => panic!("the shell exited before it drew its prompt"),
            }
            let Some(after) = text.rfind(needle).map(|at| &text[at..]) else { continue };
            // A cursor-hide with no show after it is a frame still being drawn.
            if after.rfind(HIDE) > after.rfind(SHOW) {
                continue;
            }
            let Some(prompt) = after.rfind("\nPS ").map(|at| &after[at + 1..]) else { continue };
            let repainted = prompt.strip_suffix(SHOW).is_some_and(|body| {
                body.rfind("\u{1b}[").is_some_and(|at| {
                    body[at + 2..].strip_suffix('H').is_some_and(|rc| {
                        rc.split_once(';').is_some_and(|(r, c)| {
                            !r.is_empty() && !c.is_empty() && r.bytes().chain(c.bytes()).all(|b| b.is_ascii_digit())
                        })
                    })
                })
            });
            if repainted || prompt.ends_with("> ") || prompt.ends_with(">\u{1b}[1C") {
                return;
            }
        }
    }

    fn wait_text(&self, id: &str, needle: &str) {
        loop {
            if self.tabs.snapshot(id, None).is_some_and(|s| s.text.contains(needle)) {
                return;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
    }
}

/// DS-PROC-3: size ownership follows focus and connection close, with no timer anywhere.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn size_owner_follows_focus_and_connection_close_without_timers() {
    let rig = rig("size-owner").await;
    let attached = rig.tabs.ensure(Some("term_sizeowner"), rig.request()).await.unwrap();
    let id = attached.id.as_str();
    assert_eq!(id, "term_sizeowner");
    assert_eq!(attached.size_owner, None);
    assert_eq!(rig.pty(id), Some(PtySize { cols: 100, rows: 30 }));
    // The only reading of the clock is the cursor epoch of the spawn.
    assert_eq!(rig.clock_reads.load(Ordering::SeqCst), 1);

    // Nobody owns the size: any view's resize applies.
    rig.tabs.resize(id, 110, 31, "A");
    assert_eq!(rig.pty(id), Some(PtySize { cols: 110, rows: 31 }));
    assert_eq!(rig.tabs.size_owner(id), None);

    rig.tabs.focus(id, "A", true);
    assert_eq!(rig.tabs.size_owner(id), Some(SizeOwner { cols: 110, rows: 31, owner: "A".into() }));
    rig.tabs.resize(id, 50, 20, "B");
    assert_eq!(rig.pty(id), Some(PtySize { cols: 110, rows: 31 }), "a non-owner's resize is ignored");

    // Another focus takes over, at the size B last reported.
    rig.tabs.focus(id, "B", true);
    assert_eq!(rig.tabs.size_owner(id), Some(SizeOwner { cols: 50, rows: 20, owner: "B".into() }));
    assert_eq!(rig.pty(id), Some(PtySize { cols: 50, rows: 20 }));
    rig.tabs.resize(id, 70, 25, "B");
    assert_eq!(rig.pty(id), Some(PtySize { cols: 70, rows: 25 }));
    rig.tabs.resize(id, 1, 1, "A");
    assert_eq!(rig.pty(id), Some(PtySize { cols: 70, rows: 25 }));

    // The owner's connection closes: ownership is released at once.
    rig.tabs.connection_closed("B");
    assert_eq!(rig.tabs.size_owner(id), None);
    rig.tabs.resize(id, 90, 40, "A");
    assert_eq!(rig.pty(id), Some(PtySize { cols: 90, rows: 40 }));

    // A reattaching view learns the owner's size.
    rig.tabs.focus(id, "A", true);
    let again = rig.tabs.attach(id).await.unwrap();
    assert_eq!(again.size_owner, Some(SizeOwner { cols: 90, rows: 40, owner: "A".into() }));

    let owners: Vec<(String, u16, u16)> = rig.events.owners(id).into_iter().map(|c| (c.owner, c.cols, c.rows)).collect();
    assert_eq!(
        owners,
        vec![
            ("A".to_owned(), 110, 31),
            ("B".to_owned(), 50, 20),
            ("B".to_owned(), 70, 25),
            (String::new(), 0, 0),
            ("A".to_owned(), 90, 40),
        ]
    );

    // No lease lapses, no timer fires: ownership changes only through the calls above. Each call
    // announced its change before returning, so the owner log is already complete; the shell's own
    // asynchronous activity lands in the same log as `Ev::Activity` and is not size ownership.
    // Disposing kills the shell, and draining its feed to the exit event is the barrier: the
    // process has ended, so nothing that belongs to the tab can still be pending. Only the
    // disposal's own release may follow, and the clock was never read again.
    rig.tabs.dispose(id);
    let (_, exit) = collect(&rig.manager, &mixdog_protocol::ProcessHandle::from(id)).await;
    assert!(exit.killed.is_some(), "the shell ended because the tab was disposed");
    let mut released = owners;
    released.push((String::new(), 0, 0));
    let after: Vec<(String, u16, u16)> = rig.events.owners(id).into_iter().map(|c| (c.owner, c.cols, c.rows)).collect();
    assert_eq!(after, released);
    assert_eq!(rig.clock_reads.load(Ordering::SeqCst), 1);
    // The thread count is process-wide and sibling tests of this binary start threads in
    // parallel, so it cannot witness "no thread appears"; the clock and event checks above do.
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn activity_follows_the_shell_markers_and_focus() {
    let rig = rig("activity").await;
    let attached = rig.tabs.ensure(Some("term_activity"), rig.request()).await.unwrap();
    let id = attached.id.clone();
    if !rig.profile.path.to_lowercase().contains("pwsh") && !rig.profile.path.to_lowercase().contains("powershell") {
        eprintln!("skipping: the default shell has no integration here");
        return;
    }
    // The prompt appears: idle. No marker text ever reaches the replay.
    rig.events.wait_for("the first prompt", |log| log.iter().any(|e| matches!(e, Ev::Activity(_, Some(ActivityState::Idle)))));
    assert_eq!(rig.tabs.activity_snapshot(), vec![(id.clone(), ActivityState::Idle)]);
    rig.tabs.write(&id, "Start-Sleep -Milliseconds 600; Write-Output MIXDOG_DONE_$((1+1))\r");
    rig.events.wait_for("running then finished", |log| {
        let states: Vec<_> = log.iter().filter_map(|e| if let Ev::Activity(_, s) = e { Some(*s) } else { None }).collect();
        states.ends_with(&[Some(ActivityState::Running), Some(ActivityState::Finished)])
    });
    rig.wait_text(&id, "MIXDOG_DONE_2");
    let snapshot = rig.tabs.snapshot(&id, None).unwrap();
    assert!(!snapshot.text.contains("]697;"), "marker text leaked into the replay: {:?}", snapshot.text);
    // Focusing the finished tab clears it.
    rig.tabs.focus(&id, "view-1", true);
    assert_eq!(rig.events.activity(&id).last(), Some(&Some(ActivityState::Idle)));
    // With a view focused, a finished command goes straight back to idle.
    rig.tabs.write(&id, "Write-Output MIXDOG_SECOND\r");
    rig.wait_text(&id, "MIXDOG_SECOND");
    rig.events.wait_for("second command cycle", |log| log.iter().filter(|e| matches!(e, Ev::Activity(_, Some(ActivityState::Running)))).count() >= 2);
    rig.tabs.connection_closed("view-1");
    rig.tabs.dispose(&id);
    assert_eq!(rig.events.activity(&id).last(), Some(&None), "disposing ends the activity");
    assert!(rig.tabs.activity_snapshot().is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn tabs_reuse_ids_share_one_spawn_and_report_exit() {
    let rig = rig("lifecycle").await;
    // Concurrent ensures for one id share one spawn.
    let (a, b) = tokio::join!(
        rig.tabs.ensure(Some("term_shared"), rig.request()),
        rig.tabs.ensure(Some("term_shared"), rig.request())
    );
    assert_eq!(a.unwrap().id, "term_shared");
    assert_eq!(b.unwrap().id, "term_shared");
    let running = |rig: &Rig| ProcessManager::list(&rig.manager).iter().filter(|p| p.exit.is_none()).count();
    assert_eq!(running(&rig), 1);
    // An id that is not requestable gets a generated one.
    let generated = rig.tabs.ensure(Some("not a valid id"), rig.request()).await.unwrap();
    assert!(generated.id.starts_with("term_"), "{}", generated.id);
    assert_ne!(generated.id, "not a valid id");

    rig.tabs.write("term_shared", "exit 3\r");
    rig.wait_text("term_shared", "[process exited with code 3]");
    assert_eq!(rig.tabs.attach("term_shared").await, None, "an exited tab is not running");
    let before = rig.tabs.snapshot("term_shared", None).unwrap();
    // Ensuring an exited tab starts a new process whose cursors begin above the old ones.
    let restarted = rig.tabs.ensure(Some("term_shared"), rig.request()).await.unwrap();
    assert_eq!(restarted.replay, "");
    let after = rig.tabs.snapshot("term_shared", None).unwrap();
    assert!(after.cursor > before.cursor);
    assert!(rig.tabs.snapshot("term_shared", Some(before.cursor)).unwrap().reset, "a stale cursor resets");

    // Dispose kills the tree and frees the id at once.
    rig.tabs.dispose("term_shared");
    assert_eq!(rig.tabs.snapshot("term_shared", None), None);
    let again = rig.tabs.ensure(Some("term_shared"), rig.request()).await.unwrap();
    assert_eq!(again.replay, "");
    rig.tabs.dispose_all();
    assert!(rig.tabs.session_tabs("x").is_empty());
    assert!(matches!(rig.tabs.ensure(Some("term_after"), rig.request()).await, Err(TerminalError::Disposed)));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn tabs_under_a_removed_worktree_are_disposed() {
    let rig = rig("worktree").await;
    let inner = rig.dir.join("wt");
    std::fs::create_dir_all(&inner).unwrap();
    let mut request = rig.request();
    request.cwd = Some(inner.display().to_string());
    rig.tabs.ensure(Some("term_inside"), request).await.unwrap();
    rig.tabs.ensure(Some("term_outside"), rig.request()).await.unwrap();
    let removed = rig.tabs.dispose_under(&inner.display().to_string());
    assert_eq!(removed, vec!["term_inside".to_owned()]);
    assert!(rig.tabs.snapshot("term_outside", None).is_some());
    assert!(is_path_under_root("C:\\Work\\Tree", "c:/work/tree/sub") == cfg!(windows));
    rig.tabs.dispose_all();
}

// ----- the corpus ------------------------------------------------------------------------------

/// The terminal corpus of the Node twin, replayed operation by operation on a real tab.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn terminal_corpus_replays_on_a_real_tab() {
    let corpus = fixture("../core/fixtures/desktop/terminal/corpus.json");
    assert_eq!(corpus["domain"], "terminal");
    let rig = rig("corpus").await;
    let mut id = String::new();
    let mut seen = 0;
    for entry in corpus["entries"].as_array().unwrap() {
        let op = entry["op"].as_str().unwrap();
        let args = entry["args"].as_array();
        let expect = &entry["result"];
        match op {
            "termProfiles" => {
                let profiles = rig.tabs.profiles().await;
                let got: Vec<Value> = profiles
                    .iter()
                    .map(|p| {
                        let mut v = json!({ "id": p.id, "label": p.label, "path": p.path });
                        if p.default {
                            v["default"] = json!(true);
                        }
                        v
                    })
                    .collect();
                assert_eq!(got.iter().filter(|p| p["default"] == json!(true)).count(), 1, "one default profile");
                // The recorded corpus is the shape of the list, not one machine's shells.
                assert_eq!(expect["defaultCount"], json!(1));
                assert_eq!(expect["nonEmpty"], json!(!got.is_empty()));
                let allowed: Vec<&str> = expect["entryKeys"].as_array().unwrap().iter().map(|k| k.as_str().unwrap()).collect();
                for p in &got {
                    assert!(std::path::Path::new(p["path"].as_str().unwrap()).is_absolute());
                    for key in p.as_object().unwrap().keys() {
                        assert!(allowed.contains(&key.as_str()), "unexpected key {key}");
                    }
                }
                assert_eq!(expect["pathsAbsolute"], json!(true));
            }
            "termEnsure" => {
                let attached = rig.tabs.ensure(None, rig.request()).await.unwrap();
                id = attached.id.clone();
                assert!(id.starts_with("term_"));
                let got = json!({ "id": "<id>", "replayType": "string", "sizeOwner": attached.size_owner.as_ref().map(|o| o.owner.clone()) });
                assert_eq!(&got, expect);
            }
            "termActivity" => {
                let states = rig.tabs.activity_snapshot();
                assert_eq!(json!(states.len()), json!(expect.as_array().unwrap().len()));
            }
            "termWrite" => {
                let target = if args.unwrap()[0] == "<id>" { id.as_str() } else { args.unwrap()[0].as_str().unwrap() };
                // The recorded line has a literal backslash-r: typed, echoed, never submitted.
                rig.tabs.write(target, args.unwrap()[1].as_str().unwrap());
                assert_eq!(expect, &Value::Null);
            }
            "termSnapshot" => {
                rig.wait_text(&id, "MIXDOG_FIXTURE_MARKER");
                let snapshot = rig.tabs.snapshot(&id, None).unwrap();
                // `containsMarker` is when the recorder looked, not behaviour: the Node recorder
                // snapshots right after the write, and the two recordings of this corpus
                // disagree (true, then false). The test waits for the echo, so it is true here.
                assert!(snapshot.text.contains("MIXDOG_FIXTURE_MARKER"));
                let got = json!({
                    "cursorType": "number",
                    "keys": ["cursor", "reset", "text"],
                });
                let mut recorded = expect.clone();
                recorded.as_object_mut().unwrap().remove("containsMarker");
                assert_eq!(got, recorded);
            }
            "termResize" => {
                let a = args.unwrap();
                rig.tabs.resize(&id, a[1].as_u64().unwrap() as u32, a[2].as_u64().unwrap() as u32, a[3].as_str().unwrap());
                assert_eq!(rig.pty(&id), Some(PtySize { cols: 100, rows: 30 }));
            }
            "termFocus" => {
                let a = args.unwrap();
                rig.tabs.focus(&id, a[1].as_str().unwrap(), a[2].as_bool().unwrap());
                assert_eq!(rig.tabs.size_owner(&id).map(|o| o.owner), Some("client-a".to_owned()));
            }
            "termPause" => rig.tabs.pause_output(&id),
            "termResume" => rig.tabs.resume_output(&id),
            "termAttach" => {
                let attached = rig.tabs.attach(&id).await.unwrap();
                let got = json!({ "hasReplay": !attached.replay.is_empty(), "id": "<id>" });
                assert_eq!(&got, expect);
            }
            "termSessionTabs" => {
                assert_eq!(json!(rig.tabs.session_tabs(args.unwrap()[0].as_str().unwrap()).len()), json!(expect.as_array().unwrap().len()));
            }
            "termDispose" => rig.tabs.dispose(&id),
            "termAttach(after dispose)" => {
                assert_eq!(rig.tabs.attach(&id).await, None);
                assert_eq!(expect, &Value::Null);
            }
            "<emitted event kinds>" => {
                // The data events became the process feed (`process:<tabId>`), which the other
                // tests read; the count of the old listener events has no counterpart.
                assert_eq!(entry["emitted"], json!(true));
                continue;
            }
            other => panic!("unknown corpus op {other}"),
        }
        seen += 1;
    }
    assert_eq!(seen, 14);
}

// ----- DS-PROC-8: the terminal tool over the tabs, in process ----------------------------------

struct Host {
    cwd: String,
    reveals: AtomicUsize,
}

#[async_trait]
impl TerminalBridgeHost for Host {
    async fn session_cwd(&self, _: &str) -> Option<String> {
        Some(self.cwd.clone())
    }

    async fn reveal(&self, _: &str, _: &SessionTab, _: &[SessionTab]) -> bool {
        self.reveals.fetch_add(1, Ordering::SeqCst);
        true
    }
}

fn print_lines(count: u32) -> String {
    if cfg!(windows) {
        format!("1..{count} | ForEach-Object {{ \"bridge line $_\" }}")
    } else {
        format!("seq 1 {count} | sed 's/^/bridge line /'")
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn terminal_tool_lists_runs_and_reads_in_process() {
    let rig = rig("bridge").await;
    let host = Arc::new(Host { cwd: rig.dir.display().to_string(), reveals: AtomicUsize::new(0) });
    // The default profile of this machine is what `ensure` resolves when none is given.
    let bridge = TerminalBridge::new(rig.tabs.clone(), host.clone());
    let options = BridgeOptions::default();
    let call = |args: Value| {
        let bridge = &bridge;
        let options = &options;
        async move { bridge.execute(&args, "sess8", options).await }
    };

    let listed = call(json!({ "action": "list" })).await;
    assert_eq!(listed, ToolText { text: "No terminal tabs open for this session.".into(), is_error: false });
    assert_eq!(call(json!({ "action": "read" })).await.text, "Error: no terminal tabs are open for this session");
    assert_eq!(call(json!({ "action": "run", "tab": 2, "command": "x" })).await.text, "Error: no terminal tab 2; no terminal tabs are open");

    // `run` with no tab open starts the session's first terminal and types into it.
    let run = call(json!({ "action": "run", "command": print_lines(500) })).await;
    assert!(!run.is_error, "{}", run.text);
    assert!(run.text.starts_with("Terminal run: session-terminal:sess8 · 1 "), "{}", run.text);
    assert!(run.text.contains("The terminal is shown in the desktop window."), "{}", run.text);
    assert_eq!(host.reveals.load(Ordering::SeqCst), 1);
    let cursor: u64 = run.text.split("cursor=").nth(1).unwrap().lines().next().unwrap().parse().unwrap();
    rig.wait_text("session-terminal:sess8", "bridge line 500");
    // The shell stays live; this is the barrier after which it is quiet until the next input.
    rig.wait_prompt_frame_after("session-terminal:sess8", "bridge line 500").await;

    let listed = call(json!({ "action": "list" })).await.text;
    assert!(listed.starts_with("1 ") && listed.contains(" running "), "{listed}");

    // A plain read: the newest 40 lines, bounded and labeled.
    let read = call(json!({ "action": "read" })).await;
    assert!(read.text.starts_with("UNTRUSTED TERMINAL OUTPUT"), "{}", read.text);
    assert!(read.text.contains("\nTerminal: session-terminal:sess8 · "), "{}", read.text);
    let body_rows = read.text.lines().filter(|l| l.starts_with("bridge line ")).count();
    assert!(body_rows <= 40 && body_rows > 20, "{body_rows} rows\n{}", read.text);
    assert!(read.text.contains("bridge line 500"));

    // The 400-line cap: asking for more still gets exactly 400, the newest.
    let capped = call(json!({ "action": "read", "lines": 100000 })).await;
    let rows = capped.text.lines().filter(|l| l.starts_with("bridge line ")).count();
    assert!(rows >= 380 && rows <= 400, "{rows} rows");
    assert!(capped.text.contains("bridge line 500") && !capped.text.contains("bridge line 50\n"), "{}", &capped.text[..300]);
    assert!(capped.text.lines().count() <= 404);

    // grep: case-insensitive, with two lines of context and line numbers.
    let grep = call(json!({ "action": "read", "grep": "BRIDGE LINE 250", "lines": 1 })).await;
    assert!(grep.text.contains("Terminal (partial)"), "{}", grep.text);
    assert!(grep.text.contains("1 of 1 matches for \"BRIDGE LINE 250\""), "{}", grep.text);
    assert!(grep.text.contains(": bridge line 250"), "{}", grep.text);
    assert!(grep.text.contains(": bridge line 248") && grep.text.contains(": bridge line 252"), "{}", grep.text);

    // since: only what came after the run's cursor, nothing when asked again at the new cursor.
    let since = call(json!({ "action": "read", "since": cursor, "lines": 400 })).await;
    assert!(since.text.contains("Terminal (partial)") && since.text.contains("new lines"), "{}", since.text);
    // Everything after the cursor (the 500 lines and the prompt), capped to the newest 400.
    assert!(since.text.contains("bridge line 500") && !since.text.contains("bridge line 1\n"), "{}", &since.text[..400]);
    let new_cursor: u64 = since.text.split("cursor=").nth(1).unwrap().lines().next().unwrap().parse().unwrap();
    assert!(new_cursor > cursor);
    let nothing = call(json!({ "action": "read", "since": new_cursor })).await;
    assert!(nothing.text.contains("no new output"), "{}", nothing.text);

    // Refusals: bad arguments, a stale cursor, the exec policy, a cancelled caller.
    assert_eq!(call(json!({ "action": "read", "lines": 0 })).await.text, "Error: lines must be an integer >= 1");
    let stale = call(json!({ "action": "read", "since": 1 })).await;
    assert!(stale.text.contains("[gap: older output was not retained]") || stale.text.contains("lines "), "{}", stale.text);
    let refusing = BridgeOptions {
        policy: Some(Arc::new(|command, elevated| {
            assert!(!elevated);
            command.contains("rm -rf").then(|| "Error: destructive command".to_owned())
        })),
        ..BridgeOptions::default()
    };
    let blocked = bridge.execute(&json!({ "action": "run", "command": "rm -rf /" }), "sess8", &refusing).await;
    assert_eq!(blocked, ToolText { text: "Error: destructive command".into(), is_error: true });
    let cancel = CancellationToken::new();
    cancel.cancel();
    let cancelled = BridgeOptions { cancel: Some(cancel), ..BridgeOptions::default() };
    let before = rig.tabs.snapshot("session-terminal:sess8", None).unwrap().cursor;
    let result = bridge.execute(&json!({ "action": "run", "command": "echo never" }), "sess8", &cancelled).await;
    assert_eq!(result.text, "Error: terminal run cancelled");
    assert_eq!(rig.tabs.snapshot("session-terminal:sess8", None).unwrap().cursor, before, "nothing was typed");
    assert_eq!(host.reveals.load(Ordering::SeqCst), 1, "a refused run reveals nothing");

    // Another session never sees this session's tabs.
    assert_eq!(call(json!({ "action": "list" })).await.text.starts_with("1 "), true);
    let other = bridge.execute(&json!({ "action": "list" }), "other-session", &options).await;
    assert_eq!(other.text, "No terminal tabs open for this session.");
    // Only now does the shell leave, on its own.
    rig.tabs.write("session-terminal:sess8", "exit\r");
    let (_, exit) = collect(&rig.manager, &mixdog_protocol::ProcessHandle::from("session-terminal:sess8")).await;
    assert!(exit.killed.is_none(), "the shell left on its own");
    rig.tabs.dispose_all();
}

// ----- the terminal operations' failure paths, against the Node recording -----------------------

/// What the dispatcher makes of an argument: `String(arg || '')` for the ids it reads.
fn coerced(arg: Option<&Value>) -> String {
    match arg {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(text)) => text.clone(),
        Some(other) => other.to_string(),
    }
}

/// `term_<pid>_<n>`: the id the manager makes when the one asked for is not acceptable.
fn is_generated(id: &str) -> bool {
    id.strip_prefix(&format!("term_{}_", std::process::id())).is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
}

/// `failure-paths.json` is Node's `createDesktopOperations` over its real terminal manager and a scripted PTY
/// (`record-terminal-ops.mjs`). The replay runs every recorded case on real tabs whose child is `scripted::profile()` over pipes: it
/// prints the recorded script's lines, nothing else, so the text is Node's own. Each answer is compared whole with the recording:
/// text, cursors (relative to the tab's base), flags, the tab list with every field. A recorded case that no arm consumes fails the
/// test. The phone's size claim is the one thing not replayed: in Node a view's resize claims the size and a non-positive resize
/// releases it (with a 30 s lease); that model is ported elsewhere, and its five cases are listed here until it lands.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn terminal_operation_failure_paths_equal_nodes_recording() {
    use mixdog_spawn::scripted;
    const S: &str = "session-terminal:S";
    const NOT_REPLAYED: [&str; 5] = [
        "a phone claims the size",
        "attach while the phone owns the size",
        "ensure while the phone owns the size",
        "the phone releases it",
        "attach after the release",
    ];
    let recorded = fixture("../core/fixtures/terminal-ops/failure-paths.json");
    let rig = scripted_rig("failure-paths").await;
    let tabs = &*rig.tabs;
    let cases = recorded["cases"].as_array().unwrap();
    for name in NOT_REPLAYED {
        assert!(cases.iter().any(|case| case["name"] == name), "{name} is recorded");
    }
    let script = &recorded["script"];
    let lines = |key: &str| -> Vec<String> { script[key].as_array().unwrap().iter().map(|line| line.as_str().unwrap().to_owned()).collect() };
    let say = |key: &str| {
        let lines = lines(key);
        let rig = &rig;
        async move { scripted::say(&rig.tabs, &rig.manager, S, &lines.iter().map(String::as_str).collect::<Vec<_>>()).await }
    };
    // The recording's `{cwd}` is the directory the tabs were opened in.
    let cwd = serde_json::to_string(&rig.dir.display().to_string()).unwrap();
    let cwd = &cwd[1..cwd.len() - 1];
    let placed = |value: &Value| -> Value { serde_json::from_str(&value.to_string().replace(recorded["cwd"].as_str().unwrap(), cwd)).unwrap() };
    let unmapped = |size_owner: &Option<SizeOwner>| size_owner.as_ref().map(|_| json!("<a size owner, which the replay does not model>"));
    let payload = |attached: Option<Attached>| match attached {
        None => Value::Null,
        Some(attached) => {
            let mut value = json!({ "id": attached.id, "replay": attached.replay });
            if let Some(owner) = unmapped(&attached.size_owner) {
                value["sizeOwner"] = owner;
            }
            value
        }
    };
    let generic = |mut value: Value| {
        if value["id"].as_str().is_some_and(is_generated) {
            value["id"] = json!("<generated>");
        }
        value
    };
    let mut base: Option<u64> = None;
    let mut seen = 0;
    for case in cases {
        let name = case["name"].as_str().unwrap();
        if NOT_REPLAYED.contains(&name) {
            continue;
        }
        seen += 1;
        let args = case["args"].as_array().unwrap();
        // What the tab did before this case, in the recording's order.
        match name {
            "ensure the same id again replays what it printed" => say("first").await,
            "snapshot since undefined" => say("second").await,
            "attach an exited tab" => scripted::exit(tabs, &rig.manager, S, script["exitCode"].as_u64().unwrap() as u8).await,
            _ => {}
        }
        let got: Value = match case["op"].as_str().unwrap() {
            "termSessionTabs" => json!(tabs
                .session_tabs(&coerced(args.first()))
                .iter()
                .map(|t| json!({ "tab": t.tab, "id": t.id, "shell": t.shell, "running": t.running, "cwd": t.cwd }))
                .collect::<Vec<_>>()),
            "termAttach" => payload(tabs.attach(&coerced(args.first())).await),
            "termEnsure" => {
                let attached = tabs.ensure(args[0].as_str(), rig.request()).await.unwrap();
                generic(payload(Some(attached)))
            }
            "termSnapshot" => {
                let since = match args.get(1) {
                    None | Some(Value::Null) => None,
                    Some(Value::Number(literal)) => Some(literal.as_u64().unwrap()),
                    Some(object) => Some((base.unwrap() as i64 + object["rel"].as_i64().unwrap()) as u64),
                };
                if base.is_none() {
                    let whole = tabs.snapshot(S, None).unwrap();
                    base = Some(whole.cursor - whole.text.encode_utf16().count() as u64);
                }
                match tabs.snapshot(&coerced(args.first()), since) {
                    None => Value::Null,
                    Some(got) => json!({ "text": got.text, "cursor": got.cursor as i64 - base.unwrap() as i64, "reset": got.reset }),
                }
            }
            "termDispose" => {
                tabs.dispose(&coerced(args.first()));
                Value::Null
            }
            "termWrite" => {
                tabs.write(&coerced(args.first()), args[1].as_str().unwrap());
                Value::Null
            }
            other => panic!("unmapped recorded operation {other} in case {name}"),
        };
        let want = if case.get("error").is_some_and(|error| !error.is_null()) { panic!("{name}: Node failed: {}", case["error"]) } else { placed(&case["result"]) };
        assert_eq!(got, want, "{name}");
    }
    assert_eq!(seen, cases.len() - NOT_REPLAYED.len(), "every recorded case outside the size claim was replayed");
    tabs.dispose_all();
}

async fn scripted_rig(name: &str) -> Rig {
    let manager = manager();
    let events = Arc::new(Events::default());
    let clock_reads = Arc::new(AtomicUsize::new(0));
    let mut config = TerminalConfig::new(events.clone());
    config.piped = true;
    config.shell_integration_dir = Some(scratch_dir(&format!("{name}-integration")));
    let tabs = Arc::new(TerminalTabs::new(manager.clone(), config));
    Rig { tabs, manager, events, clock_reads, profile: mixdog_spawn::scripted::profile(), dir: scratch_dir(name) }
}