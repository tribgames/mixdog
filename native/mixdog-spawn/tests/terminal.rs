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
    Forgotten(String),
}

#[derive(Default)]
struct Events {
    log: Mutex<Vec<Ev>>,
    changed: Condvar,
    /// Woken by each event, for the waits that run on a runtime thread (`announced`).
    logged: tokio::sync::Notify,
    /// A test's hold on the next announcement that a disposed tab's claims were forgotten: the announcement says it is in hand and
    /// returns once the gate opens, as a slow consumer would.
    hold_forgotten: Mutex<Option<(std::sync::mpsc::Sender<()>, std::sync::mpsc::Receiver<()>)>>,
    /// The same for the next size-owner announcement (made under the id's claim gate).
    hold_owner: Mutex<Option<(std::sync::mpsc::Sender<()>, std::sync::mpsc::Receiver<()>)>>,
    /// The ids whose claim gate a caller found taken and waited for (`TerminalConfig::gate_waiting`), in order.
    gate_waits: Mutex<Vec<String>>,
    gate_waited: Condvar,
}

/// How long a wait for an event of the product may take before it is a failure that names what was awaited.
const EVENT_DEADLINE: Duration = Duration::from_secs(60);

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

    fn wait_for(&self, what: &str, predicate: impl Fn(&[Ev]) -> bool) {
        let started = std::time::Instant::now();
        let mut log = self.log.lock().unwrap();
        while !predicate(&log) {
            let left = EVENT_DEADLINE.checked_sub(started.elapsed()).unwrap_or_else(|| panic!("no event within {EVENT_DEADLINE:?} for: {what}"));
            let (next, timeout) = self.changed.wait_timeout(log, left).unwrap();
            log = next;
            assert!(!timeout.timed_out() || predicate(&log), "no event within {EVENT_DEADLINE:?} for: {what}");
        }
    }

    /// Returns once `ready` holds for the events logged, woken by each event (no polling). The deadline fails a wait that never ends.
    async fn announced(&self, what: &str, ready: impl Fn(&[Ev]) -> bool) {
        let waited = tokio::time::timeout(EVENT_DEADLINE, async {
            loop {
                let logged = self.logged.notified();
                tokio::pin!(logged);
                // Registered before the check, so an event between check and await still wakes it.
                logged.as_mut().enable();
                if ready(&self.log.lock().unwrap()) {
                    return;
                }
                logged.await;
            }
        })
        .await;
        assert!(waited.is_ok(), "no event within {EVENT_DEADLINE:?} for: {what}");
    }

    /// Holds the next forgotten-claims announcement. Returns the receiver that says it is in hand and the sender that opens the gate.
    fn hold_next_forgotten(&self) -> (std::sync::mpsc::Receiver<()>, std::sync::mpsc::Sender<()>) {
        let (held_tx, held_rx) = std::sync::mpsc::channel();
        let (open_tx, open_rx) = std::sync::mpsc::channel();
        *self.hold_forgotten.lock().unwrap() = Some((held_tx, open_rx));
        (held_rx, open_tx)
    }

    /// Holds the next size-owner announcement, as [`Self::hold_next_forgotten`] does.
    fn hold_next_owner(&self) -> (std::sync::mpsc::Receiver<()>, std::sync::mpsc::Sender<()>) {
        let (held_tx, held_rx) = std::sync::mpsc::channel();
        let (open_tx, open_rx) = std::sync::mpsc::channel();
        *self.hold_owner.lock().unwrap() = Some((held_tx, open_rx));
        (held_rx, open_tx)
    }

    fn gate_waited(&self, id: &str) {
        self.gate_waits.lock().unwrap().push(id.to_owned());
        self.gate_waited.notify_all();
    }

    /// Returns once a caller waits for the claim gate of `id` (the product's own signal, given just before it blocks).
    fn wait_gate(&self, id: &str, what: &str) {
        let waits = self.gate_waits.lock().unwrap();
        let (waits, timeout) = self.gate_waited.wait_timeout_while(waits, EVENT_DEADLINE, |waits| !waits.iter().any(|w| w == id)).unwrap();
        drop(waits);
        assert!(!timeout.timed_out(), "{what}: nothing waited for the claim gate of {id} within {EVENT_DEADLINE:?}");
    }
}

impl TerminalEvents for Events {
    fn activity(&self, id: &str, state: Option<ActivityState>) {
        self.log.lock().unwrap().push(Ev::Activity(id.to_owned(), state));
        self.changed.notify_all();
        self.logged.notify_waiters();
    }

    fn size_owner(&self, change: &SizeOwnerChange) {
        let hold = self.hold_owner.lock().unwrap().take();
        if let Some((held, open)) = hold {
            held.send(()).expect("the test waits for the held announcement");
            open.recv_timeout(EVENT_DEADLINE).expect("the test never opened the gate on the held owner announcement");
        }
        self.log.lock().unwrap().push(Ev::Owner(change.clone()));
        self.changed.notify_all();
        self.logged.notify_waiters();
    }

    fn size_claims_forgotten(&self, id: &str) {
        let hold = self.hold_forgotten.lock().unwrap().take();
        if let Some((held, open)) = hold {
            held.send(()).expect("the test waits for the held announcement");
            open.recv_timeout(Duration::from_secs(10)).expect("the test never opened the gate on the held announcement");
        }
        self.log.lock().unwrap().push(Ev::Forgotten(id.to_owned()));
        self.changed.notify_all();
        self.logged.notify_waiters();
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
    let waits = Arc::clone(&events);
    config.gate_waiting = Some(Arc::new(move |id: &str| waits.gate_waited(id)));
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

    /// Returns once the tab's replay holds `needle`. The replay has no event of its own to wait on, so it is read again every 25 ms; the
    /// deadline turns a text that never comes into a failure that names it.
    fn wait_text(&self, id: &str, needle: &str) {
        let started = std::time::Instant::now();
        while !self.tabs.snapshot(id, None).is_some_and(|s| s.text.contains(needle)) {
            assert!(started.elapsed() < EVENT_DEADLINE, "{id}: {needle:?} never appeared in the replay within {EVENT_DEADLINE:?}");
            std::thread::sleep(Duration::from_millis(25));
        }
    }
}

/// Node's size-owner claim model (`terminal-manager.ts` `resize`): a phone's claim sets the size and the
/// newest claim owns, a claim of zero size releases it, a resize without a claim is ignored while any
/// claim stands, and a connection closing releases nothing (the lease does).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn size_owner_follows_claims_not_focus() {
    let rig = rig("size-owner").await;
    let attached = rig.tabs.ensure(Some("term_sizeowner"), rig.request()).await.unwrap();
    let id = attached.id.as_str();
    assert_eq!(id, "term_sizeowner");
    assert_eq!(attached.size_owner, None);
    assert_eq!(rig.pty(id), Some(PtySize { cols: 100, rows: 30 }));
    // The only reading of the clock is the cursor epoch of the spawn.
    assert_eq!(rig.clock_reads.load(Ordering::SeqCst), 1);

    // No claim stands: a view without a claim fits the PTY.
    rig.tabs.resize(id, 110, 31, "");
    assert_eq!(rig.pty(id), Some(PtySize { cols: 110, rows: 31 }));
    assert_eq!(rig.tabs.size_owner(id), None);

    // Focus is activity only; it claims nothing.
    rig.tabs.focus(id, "A", true);
    assert_eq!(rig.tabs.size_owner(id), None);

    rig.tabs.resize(id, 50, 20, "A");
    assert_eq!(rig.tabs.size_owner(id), Some(SizeOwner { cols: 50, rows: 20, owner: "A".into() }));
    assert_eq!(rig.pty(id), Some(PtySize { cols: 50, rows: 20 }));
    rig.tabs.resize(id, 90, 40, "");
    assert_eq!(rig.pty(id), Some(PtySize { cols: 50, rows: 20 }), "a resize without a claim is ignored while one stands");

    // The newest claim owns; a renewal by the older claimant keeps its place.
    rig.tabs.resize(id, 60, 25, "B");
    assert_eq!(rig.pty(id), Some(PtySize { cols: 60, rows: 25 }));
    rig.tabs.resize(id, 70, 26, "A");
    assert_eq!(rig.tabs.size_owner(id), Some(SizeOwner { cols: 60, rows: 25, owner: "B".into() }));
    assert_eq!(rig.pty(id), Some(PtySize { cols: 60, rows: 25 }));

    // The owner releases: the next claimant still holding one owns, at the size it last claimed.
    rig.tabs.resize(id, 0, 0, "B");
    assert_eq!(rig.tabs.size_owner(id), Some(SizeOwner { cols: 70, rows: 26, owner: "A".into() }));
    assert_eq!(rig.pty(id), Some(PtySize { cols: 70, rows: 26 }));

    // A closing connection releases nothing.
    rig.tabs.connection_closed("A");
    assert_eq!(rig.tabs.size_owner(id), Some(SizeOwner { cols: 70, rows: 26, owner: "A".into() }));

    // Sizes clamp to 2..500 x 2..200.
    rig.tabs.resize(id, 1, 900, "A");
    assert_eq!(rig.tabs.size_owner(id), Some(SizeOwner { cols: 2, rows: 200, owner: "A".into() }));
    rig.tabs.resize(id, 0, 0, "A");
    assert_eq!(rig.tabs.size_owner(id), None);

    // A reattaching view learns the owner's size.
    rig.tabs.resize(id, 90, 40, "A");
    let again = rig.tabs.attach(id).await.unwrap();
    assert_eq!(again.size_owner, Some(SizeOwner { cols: 90, rows: 40, owner: "A".into() }));

    let owners: Vec<(String, u16, u16)> = rig.events.owners(id).into_iter().map(|c| (c.owner, c.cols, c.rows)).collect();
    assert_eq!(
        owners,
        vec![
            ("A".to_owned(), 50, 20),
            ("B".to_owned(), 60, 25),
            ("A".to_owned(), 70, 26),
            ("A".to_owned(), 2, 200),
            (String::new(), 0, 0),
            ("A".to_owned(), 90, 40),
        ]
    );

    // Disposing kills the shell, and draining its feed to the exit event is the barrier: the
    // process has ended, so nothing that belongs to the tab can still be pending. The claims go
    // with the tab without an owner event (Node's `forgetSizeClaims` emits none), and the clock was never read again.
    rig.tabs.dispose(id);
    let (_, exit) = collect(&rig.manager, &mixdog_protocol::ProcessHandle::from(id)).await;
    assert!(exit.killed.is_some(), "the shell ended because the tab was disposed");
    assert_eq!(rig.tabs.size_owner(id), None);
    let after: Vec<(String, u16, u16)> = rig.events.owners(id).into_iter().map(|c| (c.owner, c.cols, c.rows)).collect();
    assert_eq!(after, owners, "a disposal announces no owner change");
    assert_eq!(rig.events.all().last(), Some(&Ev::Forgotten(id.to_owned())), "and tells its consumer the claims are forgotten");
    assert_eq!(rig.clock_reads.load(Ordering::SeqCst), 1);
}

/// Node forgets a disposed tab's claims synchronously (terminal-manager.ts:549) and announces nothing. Here the announcement that the
/// claims are forgotten is made under the claims lock, so a claim that arrives meanwhile is queued behind it and its owner event follows
/// the forgetting; made after the lock, the claim's event came first and the forgetting wiped the owner it had just announced.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_claim_made_while_a_disposal_is_announced_is_not_undone_by_it() {
    let rig = rig("forget-gate").await;
    rig.tabs.ensure(Some("term_gate"), rig.request()).await.unwrap();
    rig.tabs.resize("term_gate", 50, 20, "A");
    let (held, open) = rig.events.hold_next_forgotten();
    let tabs = Arc::clone(&rig.tabs);
    let disposing = std::thread::spawn(move || tabs.dispose("term_gate"));
    held.recv_timeout(Duration::from_secs(10)).expect("the disposal never announced the forgetting of the claims");
    let tabs = Arc::clone(&rig.tabs);
    let (claimed, claim_done) = std::sync::mpsc::channel();
    let claiming = std::thread::spawn(move || {
        tabs.resize("term_gate", 60, 25, "B");
        claimed.send(()).unwrap();
    });
    // A claim that gets through while the announcement is in hand is not queued behind it. The bounded wait names what it checks.
    assert!(
        claim_done.recv_timeout(Duration::from_secs(2)).is_err(),
        "a claim was applied while the disposal's announcement was held: it is not ordered behind it"
    );
    open.send(()).unwrap();
    disposing.join().unwrap();
    claim_done.recv_timeout(Duration::from_secs(10)).expect("the claim was never applied after the announcement was let go");
    claiming.join().unwrap();
    let ours: Vec<Ev> = rig.events.all().into_iter().filter(|e| matches!(e, Ev::Forgotten(id) if id == "term_gate") || matches!(e, Ev::Owner(c) if c.id == "term_gate")).collect();
    let owner = |owner: &str, cols, rows| Ev::Owner(SizeOwnerChange { id: "term_gate".into(), cols, rows, owner: owner.into() });
    assert_eq!(ours, vec![owner("A", 50, 20), Ev::Forgotten("term_gate".into()), owner("B", 60, 25)], "the claim follows the forgetting");
    rig.tabs.dispose_all();
}

/// Node runs a claim and a dispose of one id one after the other (terminal-manager.ts:455, :536; recorded in golden.json,
/// trace.claims.order: the owner pushed, then the tab's end and the dispose's answer). A dispose that comes while a claim of the same
/// id is announcing its owner waits for it: the owner, then the tab's end, then its claims forgotten. Without the gate around the whole
/// disposal the tab's end came between the claim's change and its announcement, and the forgetting wiped the owner just announced.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_dispose_during_a_claims_announcement_waits_for_it() {
    let rig = rig("dispose-gate").await;
    rig.tabs.ensure(Some("term_dgate"), rig.request()).await.unwrap();
    rig.events.wait_for("the tab's first prompt", |log| log.iter().any(|e| matches!(e, Ev::Activity(id, Some(_)) if id == "term_dgate")));
    let (held, open) = rig.events.hold_next_owner();
    let tabs = Arc::clone(&rig.tabs);
    let claiming = std::thread::spawn(move || tabs.resize("term_dgate", 50, 20, "A"));
    held.recv_timeout(EVENT_DEADLINE).expect("the claim never announced its owner");
    let tabs = Arc::clone(&rig.tabs);
    let disposing = std::thread::spawn(move || tabs.dispose("term_dgate"));
    rig.events.wait_gate("term_dgate", "the dispose made during the claim's announcement");
    open.send(()).unwrap();
    claiming.join().unwrap();
    disposing.join().unwrap();
    let ours: Vec<Ev> = rig
        .events
        .all()
        .into_iter()
        .filter(|e| match e {
            Ev::Activity(id, None) | Ev::Forgotten(id) => id == "term_dgate",
            Ev::Owner(c) => c.id == "term_dgate",
            Ev::Activity(..) => false,
        })
        .collect();
    let owner = Ev::Owner(SizeOwnerChange { id: "term_dgate".into(), cols: 50, rows: 20, owner: "A".into() });
    assert_eq!(ours, vec![owner, Ev::Activity("term_dgate".into(), None), Ev::Forgotten("term_dgate".into())], "the dispose ran wholly after the claim");
}

/// An attach made while a claim is announcing its owner waits for the announcement (the owner is read under the id's gate): it never
/// shows an owner whose PTY fit and announcement are still to come, which Node, one thread, never could.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_attach_during_a_claims_announcement_waits_for_it() {
    let rig = rig("attach-gate").await;
    rig.tabs.ensure(Some("term_agate"), rig.request()).await.unwrap();
    let (held, open) = rig.events.hold_next_owner();
    let tabs = Arc::clone(&rig.tabs);
    let claiming = std::thread::spawn(move || tabs.resize("term_agate", 50, 20, "A"));
    held.recv_timeout(EVENT_DEADLINE).expect("the claim never announced its owner");
    let tabs = Arc::clone(&rig.tabs);
    let attaching = tokio::spawn(async move { tabs.attach("term_agate").await });
    rig.events.wait_gate("term_agate", "the attach made during the claim's announcement");
    // The waiter is the attach: it has not answered while the announcement is held (a lapse 30 s on would wait for the gate too).
    assert!(!attaching.is_finished(), "the attach answered while the claim's announcement was still held");
    open.send(()).unwrap();
    claiming.join().unwrap();
    let attached = attaching.await.unwrap().expect("the tab runs");
    assert_eq!(attached.size_owner, Some(SizeOwner { cols: 50, rows: 20, owner: "A".into() }));
    rig.tabs.dispose("term_agate");
}

/// One connection holds claims on at most 256 ids at once; a claim on one more id is ignored (no owner, no announcement), while a
/// renewal of a held claim still works. Node bounded nothing (`sizeClaims`, terminal-manager.ts:455).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_connection_holds_claims_on_a_bounded_number_of_ids() {
    let rig = rig("claim-cap").await;
    for n in 0..256 {
        rig.tabs.resize(&format!("term_cap_{n}"), 50, 20, "A");
    }
    rig.tabs.resize("term_cap_over", 50, 20, "A");
    assert_eq!(rig.tabs.size_owner("term_cap_over"), None, "the claim beyond the bound is ignored");
    assert!(rig.events.owners("term_cap_over").is_empty());
    rig.tabs.resize("term_cap_over", 50, 20, "B");
    assert!(rig.tabs.size_owner("term_cap_over").is_some(), "another connection still claims");
    rig.tabs.resize("term_cap_0", 60, 21, "A");
    assert_eq!(rig.tabs.size_owner("term_cap_0"), Some(SizeOwner { cols: 60, rows: 21, owner: "A".into() }), "a renewal is not a new claim");
}

/// A claim that is not renewed lapses after `SIZE_OWNER_LEASE` (30 s) and the PTY is fitted to the
/// next claimant; a renewal restarts the lease. Time is the paused tokio clock the core ticker follows.
#[tokio::test(start_paused = true)]
async fn a_size_claim_lapses_after_its_lease_unless_renewed() {
    let rig = rig("size-lease").await;
    let attached = rig.tabs.ensure(Some("term_sizelease"), rig.request()).await.unwrap();
    let id = attached.id.as_str();
    rig.tabs.resize(id, 50, 20, "A");
    rig.tabs.resize(id, 60, 25, "B");
    let held = |tabs: &TerminalTabs| tabs.size_owner(id).map(|o| (o.owner, o.cols, o.rows));
    tokio::time::advance(std::time::Duration::from_secs(20)).await;
    rig.tabs.resize(id, 61, 26, "B");
    tokio::time::advance(std::time::Duration::from_secs(20)).await;
    // A's lease ended at 30 s, B renewed at 20 s: B still owns and A is gone.
    assert_eq!(held(&rig.tabs), Some(("B".to_owned(), 61, 26)));
    tokio::time::advance(std::time::Duration::from_secs(11)).await;
    // The ticker's callback only hands the lapse to a task it spawns, so `advance` returning does not say the lapse has run: the
    // release event the task announces does. The wait is on that event; with the clock paused, a task that never announces leaves the
    // runtime idle, the clock then jumps to the wait's deadline, and the test fails naming the event instead of hanging.
    rig.events.announced(
        "the 30 s lease lapsed and announced the release",
        |log| log.iter().any(|e| matches!(e, Ev::Owner(c) if c.id == id && c.owner.is_empty() && c.cols == 0)),
    )
    .await;
    assert_eq!(held(&rig.tabs), None, "B's lease ended 30 s after its renewal");
    let owners: Vec<(String, u16, u16)> = rig.events.owners(id).into_iter().map(|c| (c.owner, c.cols, c.rows)).collect();
    assert_eq!(owners, vec![("A".into(), 50, 20), ("B".into(), 60, 25), ("B".into(), 61, 26), (String::new(), 0, 0)]);
    rig.tabs.dispose(id);
}
/// A rig on the manual lease clock (debug builds, `MIXDOG_TERMINAL_LEASE_CLOCK` set to a directory) and one tab.
/// The tests step the clock through the socket the core publishes in that directory, as the replay does.
#[cfg(feature = "lease-clock")]
async fn manual_lease_rig(name: &str) -> (Rig, String, LeaseClock) {
    let clock_dir = std::env::temp_dir().join(format!("mixdog-lease-clock-{}-{name}", std::process::id()));
    std::fs::create_dir_all(&clock_dir).unwrap();
    // SAFETY: set before this test's tabs exist; the test binary runs each test in its own process under nextest.
    unsafe { std::env::set_var("MIXDOG_TERMINAL_LEASE_CLOCK", &clock_dir) };
    // SAFETY: as above.
    unsafe { std::env::set_var("MIXDOG_TERMINAL_LEASE_CLOCK_SECRET", LEASE_CLOCK_SECRET) };
    let rig = rig(name).await;
    let attached = rig.tabs.ensure(Some("term_manual"), rig.request()).await.unwrap();
    let id = attached.id.clone();
    let clock = LeaseClock::admitted(lease_clock_port(name));
    (rig, id, clock)
}
/// The run's secret this test process gives its core; a connection that does not send it moves nothing.
#[cfg(feature = "lease-clock")]
const LEASE_CLOCK_SECRET: &str = "terminal-test-secret";
/// The port the core published in the rig's clock directory: the seam as the replay uses it.
#[cfg(feature = "lease-clock")]
fn lease_clock_port(name: &str) -> u16 {
    let dir = std::env::temp_dir().join(format!("mixdog-lease-clock-{}-{name}", std::process::id()));
    std::fs::read_to_string(dir.join("port")).unwrap().parse().unwrap()
}
#[cfg(feature = "lease-clock")]
fn lease_clock_stream(port: u16) -> std::net::TcpStream {
    let stream = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
    // A clock that never answers fails the test by its message instead of blocking it.
    stream.set_read_timeout(Some(std::time::Duration::from_secs(30))).unwrap();
    stream
}
/// The replay's end of the manual lease clock: a command line out, the core's answer line back (a blocking read).
#[cfg(feature = "lease-clock")]
struct LeaseClock {
    reader: std::io::BufReader<std::net::TcpStream>,
}
#[cfg(feature = "lease-clock")]
impl LeaseClock {
    /// A connection that has sent the run's secret.
    fn admitted(port: u16) -> Self {
        let mut clock = LeaseClock { reader: std::io::BufReader::new(lease_clock_stream(port)) };
        assert_eq!(clock.send(&format!("secret {LEASE_CLOCK_SECRET}")), "admitted");
        clock
    }
    fn send(&mut self, line: &str) -> String {
        use std::io::{BufRead, Write};
        writeln!(self.reader.get_mut(), "{line}").unwrap();
        let mut answer = String::new();
        self.reader.read_line(&mut answer).unwrap_or_else(|error| panic!("the lease clock did not answer `{line}` within 30 s: {error}"));
        answer.trim_end().to_owned()
    }
    fn advance(&mut self, ms: u64) -> String {
        self.send(&format!("advance {ms}"))
    }
}
/// A claim renewed at 10 s holds until 40 s and lapses at that edge, to the instant.
#[cfg(feature = "lease-clock")]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_manual_lease_clock_moves_the_edge_with_a_renewal() {
    let (rig, id, mut clock) = manual_lease_rig("manual-renewal").await;
    rig.tabs.resize(&id, 50, 20, "A");
    assert_eq!(clock.advance(10_000), "lapsed 0");
    rig.tabs.resize(&id, 50, 20, "A");
    assert_eq!(clock.advance(29_999), "lapsed 0", "a renewal at 10 s holds until 40 s");
    assert!(rig.tabs.size_owner(&id).is_some());
    assert_eq!(clock.advance(1), "lapsed 1", "the renewed lease lapses at 40 s, to the instant");
    assert_eq!(rig.tabs.size_owner(&id), None);
    rig.tabs.dispose(&id);
}
/// An unrenewed claim holds until its 30 s edge, not a millisecond before, and lapses there.
#[cfg(feature = "lease-clock")]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_manual_lease_clock_lapses_an_unrenewed_claim_at_exactly_30_seconds() {
    let (rig, id, mut clock) = manual_lease_rig("manual-edge").await;
    rig.tabs.resize(&id, 50, 20, "A");
    assert_eq!(clock.advance(29_999), "lapsed 0", "an unrenewed claim holds until its 30 s edge");
    assert_eq!(clock.advance(1), "lapsed 1", "and lapses at the 30 s edge");
    assert_eq!(rig.tabs.size_owner(&id), None);
    rig.tabs.dispose(&id);
}
/// A line that is not `advance <ms>` is refused and moves nothing; the clock answers the next command on the same connection.
#[cfg(feature = "lease-clock")]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_manual_lease_clock_refuses_what_is_not_an_advance() {
    let (rig, id, mut clock) = manual_lease_rig("manual-refuse").await;
    rig.tabs.resize(&id, 50, 20, "A");
    assert_eq!(clock.send("advance soon"), "refused");
    assert_eq!(clock.send("rewind 1"), "refused");
    assert_eq!(clock.advance(29_999), "lapsed 0", "the refused lines moved no time");
    assert_eq!(clock.advance(1), "lapsed 1");
    rig.tabs.dispose(&id);
}
/// A local process that does not know the run's secret moves nothing: its first line is refused and its connection closed.
#[cfg(feature = "lease-clock")]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_manual_lease_clock_refuses_a_client_without_the_secret() {
    use std::io::BufRead;
    let (rig, id, mut clock) = manual_lease_rig("manual-secret").await;
    rig.tabs.resize(&id, 50, 20, "A");
    let mut stranger = LeaseClock { reader: std::io::BufReader::new(lease_clock_stream(lease_clock_port("manual-secret"))) };
    assert_eq!(stranger.send("advance 30000"), "refused: the first line must be `secret <the run's secret>`");
    let mut rest = String::new();
    assert_eq!(stranger.reader.read_line(&mut rest).unwrap(), 0, "the stranger's connection is closed");
    assert_eq!(clock.advance(29_999), "lapsed 0", "the stranger moved no time");
    rig.tabs.dispose(&id);
}
/// A control connection that leaves a line unfinished must not stop another connection's dvance from being answered.
#[cfg(feature = "lease-clock")]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_stalled_clock_connection_does_not_block_another() {
    use std::io::Write;
    let (rig, id, _first) = manual_lease_rig("manual-stalled").await;
    let port = lease_clock_port("manual-stalled");
    let mut stalled = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
    stalled.write_all(b"advance 1").unwrap();
    let mut late = LeaseClock::admitted(port);
    rig.tabs.resize(&id, 50, 20, "A");
    assert_eq!(late.advance(30_000), "lapsed 1", "a connection after a stalled one is still served");
    rig.tabs.dispose(&id);
}
/// The control connection has deadlines: a line left unfinished is answered with what was awaited, and the connection is closed (its
/// thread and socket are released), not held for ever.
#[cfg(feature = "lease-clock")]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_connection_that_leaves_a_line_unfinished_is_refused_and_closed() {
    use std::io::{BufRead, Write};
    let (rig, id, _first) = manual_lease_rig("manual-unfinished").await;
    let port = lease_clock_port("manual-unfinished");
    let mut stalled = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
    // The test's own guard, longer than the core's line deadline: a core without one fails here by its message instead of hanging.
    stalled.set_read_timeout(Some(std::time::Duration::from_secs(60))).unwrap();
    stalled.write_all(b"advance 1").unwrap();
    let mut reader = std::io::BufReader::new(stalled);
    let mut told = String::new();
    reader.read_line(&mut told).unwrap_or_else(|e| panic!("the core never answered a line left unfinished: {e}"));
    assert_eq!(told, "refused: the `advance <ms>` command was not finished with a newline within 10 s\n");
    let mut rest = String::new();
    assert_eq!(reader.read_line(&mut rest).unwrap(), 0, "the connection is closed after the refusal");
    rig.tabs.dispose(&id);
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
    let _ = rig.tabs.write(&id, "Start-Sleep -Milliseconds 600; Write-Output MIXDOG_DONE_$((1+1))\r");
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
    let _ = rig.tabs.write(&id, "Write-Output MIXDOG_SECOND\r");
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

    let _ = rig.tabs.write("term_shared", "exit 3\r");
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
                let _ = rig.tabs.write(target, args.unwrap()[1].as_str().unwrap());
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
    let _ = rig.tabs.write("session-terminal:sess8", "exit\r");
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
/// test. A view's resize claims the size and a non-positive resize releases it, as the five size-claim cases record.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn terminal_operation_failure_paths_equal_nodes_recording() {
    use mixdog_spawn::scripted;
    const S: &str = "session-terminal:S";
    let recorded = fixture("../core/fixtures/terminal-ops/failure-paths.json");
    let rig = scripted_rig("failure-paths").await;
    let tabs = &*rig.tabs;
    let cases = recorded["cases"].as_array().unwrap();
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
    let payload = |attached: Option<Attached>| match attached {
        None => Value::Null,
        Some(attached) => {
            let mut value = json!({ "id": attached.id, "replay": attached.replay });
            if let Some(owner) = &attached.size_owner {
                value["sizeOwner"] = json!({ "cols": owner.cols, "rows": owner.rows, "owner": owner.owner });
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
                let _ = tabs.write(&coerced(args.first()), args[1].as_str().unwrap());
                Value::Null
            }
            "termResize" => {
                tabs.resize(&coerced(args.first()), args[1].as_u64().unwrap() as u32, args[2].as_u64().unwrap() as u32, args[3].as_str().unwrap());
                Value::Null
            }
            other => panic!("unmapped recorded operation {other} in case {name}"),
        };
        let want = if case.get("error").is_some_and(|error| !error.is_null()) { panic!("{name}: Node failed: {}", case["error"]) } else { placed(&case["result"]) };
        assert_eq!(got, want, "{name}");
    }
    assert_eq!(seen, cases.len(), "every recorded case was replayed");
    tabs.dispose_all();
}

async fn scripted_rig(name: &str) -> Rig {
    let manager = manager();
    let events = Arc::new(Events::default());
    let clock_reads = Arc::new(AtomicUsize::new(0));
    let mut config = TerminalConfig::new(events.clone());
    config.piped = true;
    config.shell_integration_dir = Some(scratch_dir(&format!("{name}-integration")));
    let waits = Arc::clone(&events);
    config.gate_waiting = Some(Arc::new(move |id: &str| waits.gate_waited(id)));
    let tabs = Arc::new(TerminalTabs::new(manager.clone(), config));
    Rig { tabs, manager, events, clock_reads, profile: mixdog_spawn::scripted::profile(), dir: scratch_dir(name) }
}

/// The window a late reader gets is Node's `TerminalReplayBuffer` at its boundary (golden.json, trace.replayWindow, recorded from Node): 200,000
/// UTF-16 units, so two-byte characters count as one and a non-BMP character on the cut loses its first unit. A string cannot hold the lone
/// surrogate Node keeps there; it reads as U+FFFD, one unit in place of one.
#[test]
fn the_replay_window_is_nodes_at_its_boundary() {
    let golden: Value = serde_json::from_str(include_str!("../../../apps/mobile/fixtures/phone-terminal/golden.json")).unwrap();
    let cases = golden["trace"]["replayWindow"].as_array().unwrap();
    assert_eq!(cases.len(), 6);
    for case in cases {
        let mut buffer = ReplayBuffer::new(REPLAY_BUFFER_LIMIT, 0);
        for chunk in case["chunks"].as_array().unwrap() {
            let text: String = chunk.as_array().unwrap().iter().map(|part| part[0].as_str().unwrap().repeat(part[1].as_u64().unwrap() as usize)).collect();
            buffer.append(&text);
        }
        let units: Vec<u64> = buffer.read().encode_utf16().map(u64::from).collect();
        // Node's lone surrogates are what a string cannot hold: the replacement character stands for each.
        let node = |at: &Value| -> Vec<u64> { at.as_array().unwrap().iter().map(|u| u.as_u64().unwrap()).map(|u| if (0xd800..0xe000).contains(&u) && !pair(at, u) { 0xfffd } else { u }).collect() };
        let name = case["name"].as_str().unwrap();
        assert_eq!(units.len() as u64, case["length"].as_u64().unwrap(), "{name}: length in units");
        assert_eq!(buffer.cursor(), case["cursor"].as_u64().unwrap(), "{name}: cursor");
        assert_eq!(buffer.trimmed(), case["trimmed"].as_bool().unwrap(), "{name}: trimmed");
        assert_eq!(&units[..4], node(&case["head"]).as_slice(), "{name}: first units");
        assert_eq!(&units[units.len() - 4..], node(&case["tail"]).as_slice(), "{name}: last units");
    }
}

/// Whether the surrogate `unit` of the four `units` is half of a pair there.
fn pair(units: &Value, unit: u64) -> bool {
    let all: Vec<u64> = units.as_array().unwrap().iter().map(|u| u.as_u64().unwrap()).collect();
    let at = all.iter().position(|u| *u == unit).unwrap();
    if (0xd800..0xdc00).contains(&unit) { all.get(at + 1).is_some_and(|n| (0xdc00..0xe000).contains(n)) } else { at > 0 && (0xd800..0xdc00).contains(&all[at - 1]) }
}

/// Node is one thread, so a claim's change, its PTY fit and its announcement are one step. Here they are one step per id (a gate), and the claims
/// map's own lock is held only to change the map: an announcement held for one tab does not hold back the claims of another.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_held_announcement_does_not_hold_back_another_tabs_claims() {
    let rig = rig("gate-other").await;
    rig.tabs.ensure(Some("term_held"), rig.request()).await.unwrap();
    rig.tabs.ensure(Some("term_free"), rig.request()).await.unwrap();
    rig.tabs.resize("term_held", 50, 20, "A");
    let (held, open) = rig.events.hold_next_forgotten();
    let tabs = Arc::clone(&rig.tabs);
    let disposing = std::thread::spawn(move || tabs.dispose("term_held"));
    held.recv_timeout(Duration::from_secs(10)).expect("the disposal never announced the forgetting of the claims");
    let tabs = Arc::clone(&rig.tabs);
    let (claimed, claim_done) = std::sync::mpsc::channel();
    let claiming = std::thread::spawn(move || {
        tabs.resize("term_free", 60, 25, "B");
        claimed.send(()).unwrap();
    });
    claim_done.recv_timeout(Duration::from_secs(10)).expect("a claim on another tab waited for the announcement held for this one");
    open.send(()).unwrap();
    disposing.join().unwrap();
    claiming.join().unwrap();
    rig.tabs.dispose_all();
}