//! The Rust footer against what the Node one does (tests/goldens/footer.json, recorded by tests/recorders/record-footer.mjs):
//! `renderStatusline` over the file sets and step sequences of the recording (a render, the background refreshes it queued,
//! the clock moving on), and the status line hook over a fake clock (the line after each step, the next timer, the refresh
//! period).
//!
//! The model catalog and the OAuth usage cache are what the process supplies; each step hands back what Node's modules
//! answered. A reset time is the local time of the machine, so the clock times after `↻ ` are masked on both sides.

use std::collections::HashMap;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;

use mixdog_core_session::session::statusline_agents::RuntimeEntry;
use mixdog_tui::footer::FooterInputs;
use mixdog_tui::footer::RenderArgs;
use mixdog_tui::footer::RendererDeps;
use mixdog_tui::footer::StatusHost;
use mixdog_tui::footer::StatusIo;
use mixdog_tui::footer::StatusPaths;
use mixdog_tui::footer::StatuslineRenderer;
use mixdog_tui::footer::StatuslineText;
use mixdog_tui::footer::io::FileStat;
use mixdog_tui_style::color::Styler;
use mixdog_view_model::display::statusline_format::StatusStyle;
use mixdog_view_model::display::statusline_segments::BackgroundRun;
use serde_json::Map;
use serde_json::Value;

const GOLDEN: &str = include_str!("goldens/footer.json");
/// What the recording's `$PID` stands for: the pid the shell-job records name, which the test machine says is alive.
const ALIVE_PID: u64 = 777_000;
const STYLE: StatusStyle = StatusStyle::new(Styler::new(true, true));

fn golden() -> Value {
    serde_json::from_str(GOLDEN).expect("the golden parses")
}

fn data_dir() -> PathBuf {
    PathBuf::from("/footer/data")
}

fn config_dir() -> PathBuf {
    PathBuf::from("/footer/config")
}

/// The data directory of a case as a map of files.
struct MemoryIo {
    files: Mutex<HashMap<String, String>>,
    mtime_ms: f64,
}

impl MemoryIo {
    fn key(&self, path: &Path) -> Option<String> {
        path.strip_prefix(data_dir()).ok().map(|rest| rest.to_string_lossy().replace('\\', "/"))
    }
}

impl StatusIo for MemoryIo {
    fn read_text(&self, path: &Path) -> Option<String> {
        self.files.lock().unwrap().get(&self.key(path)?).cloned()
    }

    fn stat(&self, path: &Path) -> Option<FileStat> {
        let text = self.files.lock().unwrap().get(&self.key(path)?).cloned()?;
        Some(FileStat { len: text.len() as u64, created_ms: 1, mtime_ms: self.mtime_ms })
    }

    fn read_range(&self, path: &Path, offset: u64, len: usize) -> Option<Vec<u8>> {
        let text = self.read_text(path)?;
        let bytes = text.as_bytes();
        let start = usize::try_from(offset).ok()?.min(bytes.len());
        Some(bytes[start..(start + len).min(bytes.len())].to_vec())
    }

    fn list_dir(&self, path: &Path) -> Option<Vec<String>> {
        let dir = format!("{}/", self.key(path)?);
        let names: Vec<String> = self.files.lock().unwrap().keys().filter_map(|key| key.strip_prefix(&dir).map(str::to_owned)).collect();
        (!names.is_empty()).then_some(names)
    }

    fn pid_alive(&self, pid: u64) -> bool {
        pid == ALIVE_PID
    }
}

/// What a step's process supplies: the OAuth usage and the catalog rows Node's modules answered.
#[derive(Default)]
struct Supplied {
    usage: Option<Value>,
    meta: Map<String, Value>,
}

#[derive(Default)]
struct TestHost {
    supplied: Mutex<Supplied>,
}

impl StatusHost for TestHost {
    fn catalog_meta(&self, model: &str, provider: &str) -> Option<Map<String, Value>> {
        self.supplied.lock().unwrap().meta.get(&format!("{model}\0{provider}")).and_then(Value::as_object).cloned()
    }

    fn cached_models(&self, _provider: &str) -> Vec<Value> {
        Vec::new()
    }

    fn cached_oauth_usage(&self, _route: &Value, _allow_stale: bool) -> Option<Value> {
        self.supplied.lock().unwrap().usage.clone()
    }

    fn agent_runtimes(&self) -> Vec<RuntimeEntry> {
        Vec::new()
    }

    fn hidden_agent_names(&self) -> Vec<String> {
        Vec::new()
    }

    fn env(&self, _name: &str) -> Option<String> {
        None
    }
}

/// Node's `setImmediate`: refreshes run when the test lets them, after the render that queued them returned.
#[derive(Default)]
struct Deferred {
    jobs: Mutex<Vec<Box<dyn FnOnce() + Send>>>,
}

impl BackgroundRun for Deferred {
    fn run(&self, job: Box<dyn FnOnce() + Send>) {
        self.jobs.lock().unwrap().push(job);
    }
}

impl Deferred {
    fn flush(&self) {
        loop {
            let jobs = std::mem::take(&mut *self.jobs.lock().unwrap());
            if jobs.is_empty() {
                break;
            }
            for job in jobs {
                job();
            }
        }
    }
}

struct Rig {
    renderer: StatuslineRenderer,
    host: Arc<TestHost>,
    io: Arc<MemoryIo>,
    background: Arc<Deferred>,
    clock: Arc<Mutex<f64>>,
}

impl Rig {
    fn new(origin: f64, files: &Map<String, Value>) -> Self {
        let files: HashMap<String, String> =
            files.iter().map(|(name, text)| (name.clone(), text.as_str().unwrap_or("").replace("$PID", &ALIVE_PID.to_string()))).collect();
        let io = Arc::new(MemoryIo { files: Mutex::new(files), mtime_ms: origin });
        let host = Arc::new(TestHost::default());
        let background = Arc::new(Deferred::default());
        let clock = Arc::new(Mutex::new(origin));
        let renderer = StatuslineRenderer::new(RendererDeps {
            host: host.clone(),
            io: io.clone(),
            paths: StatusPaths { data_dir: data_dir(), config_dir: config_dir() },
            background: background.clone(),
            clock: {
                let clock = clock.clone();
                Arc::new(move || *clock.lock().unwrap())
            },
            style: STYLE,
            process_started_at_ms: origin,
        });
        Self { renderer, host, io, background, clock }
    }

    fn set_clock(&self, now: f64) {
        *self.clock.lock().unwrap() = now;
    }

    fn now(&self) -> f64 {
        *self.clock.lock().unwrap()
    }
}

fn text(value: &Value, key: &str) -> String {
    value.get(key).and_then(Value::as_str).unwrap_or("").to_owned()
}

fn number(value: &Value, key: &str) -> f64 {
    value.get(key).and_then(Value::as_f64).unwrap_or(0.0)
}

fn list(value: &Value, key: &str) -> Vec<Value> {
    value.get(key).and_then(Value::as_array).cloned().unwrap_or_default()
}

fn render_args(args: &Value, columns: f64) -> RenderArgs {
    RenderArgs {
        session_id: args.get("sessionId").and_then(Value::as_str).map(str::to_owned),
        client_host_pid: args.get("clientHostPid").and_then(Value::as_f64),
        provider: text(args, "provider"),
        model: text(args, "model"),
        effort: text(args, "effort"),
        fast: args.get("fast").and_then(Value::as_bool).unwrap_or(false),
        ultra: args.get("ultra").and_then(Value::as_bool).unwrap_or(false),
        cwd: text(args, "cwd"),
        stats: args.get("stats").filter(|stats| !stats.is_null()).cloned(),
        context_window: number(args, "contextWindow"),
        display_context_window: number(args, "displayContextWindow"),
        raw_context_window: number(args, "rawContextWindow"),
        compact_boundary_tokens: number(args, "compactBoundaryTokens"),
        auto_compact_token_limit: number(args, "autoCompactTokenLimit"),
        agent_workers: list(args, "agentWorkers"),
        agent_jobs: list(args, "agentJobs"),
        active_tools: args.get("activeTools").filter(|tools| !tools.is_null()).cloned(),
        terminal_columns: Some(columns),
    }
}

/// The reset times after `↻ ` are the machine's local time; they and their padding are replaced by `<T>`.
fn masked(line: &str) -> String {
    let mut out = String::new();
    let mut rest = line;
    while let Some(at) = rest.find("\u{21bb} ") {
        let (head, tail) = rest.split_at(at + "\u{21bb} ".len());
        out.push_str(head);
        out.push_str("<T>");
        let skip = tail.find(|c: char| !(c.is_ascii_digit() || c == ':' || c == '-' || c == ' ')).unwrap_or(tail.len());
        rest = &tail[skip..];
    }
    out.push_str(rest);
    out
}

#[test]
fn render_statusline_matches_what_node_renders_step_by_step() {
    let golden = golden();
    for case in golden["renders"].as_array().expect("renders") {
        let name = text(case, "name");
        let rig = Rig::new(number(case, "origin"), case["files"].as_object().expect("files"));
        for (index, step) in case["steps"].as_array().expect("steps").iter().enumerate() {
            rig.set_clock(number(step, "now"));
            for removed in list(step, "removed") {
                rig.io.files.lock().unwrap().remove(removed.as_str().unwrap_or(""));
            }
            let supplied = &step["supplied"];
            *rig.host.supplied.lock().unwrap() =
                Supplied { usage: supplied.get("usage").filter(|usage| !usage.is_null()).cloned(), meta: supplied["meta"].as_object().cloned().unwrap_or_default() };
            let out = rig.renderer.render(&render_args(&step["args"], number(step, "cols")));
            rig.background.flush();
            assert_eq!(masked(&out), masked(&text(step, "out")), "{name}: step {index}");
        }
    }
}

fn inputs_of(spec: &Value) -> FooterInputs {
    let args = &spec["args"];
    FooterInputs {
        args: render_args(args, 120.0),
        resize_epoch: number(spec, "resizeEpoch") as u64,
        agent_revision: number(spec, "agentRevision") as u64,
        theme_epoch: number(spec, "themeEpoch") as u64,
    }
}

#[test]
fn the_status_line_hook_matches_node_step_by_step() {
    let golden = golden();
    for case in golden["hooks"].as_array().expect("hooks") {
        let name = text(case, "name");
        let rig = Rig::new(number(case, "origin"), &Map::new());
        let mut text_state: Option<StatuslineText> = None;
        let mut inputs = FooterInputs::default();
        let steps = case["steps"].as_array().expect("steps");
        for (index, (op, expected)) in case["ops"].as_array().expect("ops").iter().zip(steps).enumerate() {
            match op["op"].as_str().unwrap_or("") {
                "mount" => {
                    inputs = inputs_of(&op["inputs"]);
                    let mut state = StatuslineText::new(rig.renderer.clone(), &inputs, op.get("initialLine").and_then(Value::as_str));
                    state.update(&inputs);
                    text_state = Some(state);
                }
                "update" => {
                    inputs = inputs_of(&op["inputs"]);
                    text_state.as_mut().expect("mounted").update(&inputs);
                }
                "tick" => text_state.as_mut().expect("mounted").refresh_tick(&inputs),
                "advance" => rig.set_clock(rig.now() + number(op, "ms")),
                "wake" => {
                    let state = text_state.as_mut().expect("mounted");
                    if let Some(at) = state.next_wake() {
                        rig.set_clock(rig.now().max(at));
                    }
                    state.poll();
                    rig.background.flush();
                }
                other => panic!("unknown op {other}"),
            }
            let state = text_state.as_ref().expect("mounted");
            let origin = number(case, "origin");
            let label = format!("{name}: step {index} ({})", op["op"].as_str().unwrap_or(""));
            assert_eq!(state.line(), text(expected, "line"), "{label}: line");
            assert_eq!(state.next_wake().map(|at| at - origin), expected.get("nextWake").and_then(Value::as_f64), "{label}: next wake");
            assert_eq!(state.refresh_ms(), number(expected, "refreshMs"), "{label}: refresh period");
        }
    }
}
