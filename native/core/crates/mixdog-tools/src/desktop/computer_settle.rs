//! What an action did to the windows: the post-action settle, transitions, dialogs, a launch's successor and new windows
//! (`host/window-settle.ts`, `shared/window-transition.ts`, `host/window-arrivals.ts`). Windows only: the other platforms' sessions
//! keep the helper's replies as they are.

use std::collections::HashMap;
use std::collections::HashSet;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::time::Duration;

use async_trait::async_trait;
use mixdog_core_api::domain::computer::ComputerError;
use mixdog_core_api::domain::tool::ToolPart;
use mixdog_js::js_trim;
use mixdog_rt::time::Instant;
use mixdog_rt::time::sleep;
use mixdog_rt::time::timeout;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;
use tokio_util::sync::CancellationToken;

use super::computer_backend::HOST_READ_ACTIONS;
use super::computer_backend::ProcessComputerBackend;
use super::computer_gnome::ARRIVALS_SESSION_ID;

/// `DEFAULT_CAPTURE_AFTER_DELAY_MS` and `MAX_CAPTURE_AFTER_DELAY_MS` (`shared/common.ts`).
const DEFAULT_SETTLE_MS: u64 = 150;
const MAX_SETTLE_MS: u64 = 2_000;
/// How long a launch settle waits for a successor window, polling every 100 ms (`window-settle.ts`).
const LAUNCH_SUCCESSOR_TIMEOUT: Duration = Duration::from_millis(4_000);
const LAUNCH_MINIMUM_SETTLE: Duration = Duration::from_millis(500);
const LAUNCH_POLL: Duration = Duration::from_millis(100);
/// A modal dialog is created after the action returns: how long a scan keeps looking for it.
const DIALOG_WATCH_EXPECTED: Duration = Duration::from_millis(1_200);
const DIALOG_WATCH_FOCUS_GAP: Duration = Duration::from_millis(600);
const DIALOG_POLL: Duration = Duration::from_millis(100);
/// How long a command waits for an arrivals read (`window-arrivals.ts` `ARRIVALS_READ_BUDGET_MS`).
const ARRIVALS_READ_BUDGET: Duration = Duration::from_millis(300);

// --- window records (`ComputerWindowRecord`, `normalizeComputerWindowRecords`) ---

/// One window of a `list_windows` / `window_snapshot` list.
#[derive(Clone, Debug, Default, PartialEq)]
pub(super) struct Window {
    pub id: String,
    pub title: String,
    pub class_name: String,
    pub app: String,
    pub pid: i64,
    pub parent_pid: i64,
    /// The process that owns the content a frame window hosts; a packaged app's window belongs to the system frame host.
    pub content_pid: i64,
    pub owner_id: String,
    pub focused: bool,
    pub minimized: bool,
    pub maximized: bool,
    pub x: i64,
    pub y: i64,
    pub width: i64,
    pub height: i64,
}

/// The row's first present key (the helper's snake case, then the record's camel case).
fn field<'a>(row: &'a Value, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().find_map(|key| row.get(*key).filter(|value| !value.is_null()))
}

fn string_of(row: &Value, keys: &[&str]) -> String {
    field(row, keys).and_then(Value::as_str).unwrap_or_default().to_owned()
}

/// `finiteNumber`: a number, or a numeric string; anything else is 0.
fn number_of(row: &Value, keys: &[&str]) -> i64 {
    let number = match field(row, keys) {
        Some(Value::Number(number)) => number.as_f64(),
        Some(Value::String(text)) => js_trim(text).parse::<f64>().ok(),
        _ => None,
    };
    number.filter(|number| number.is_finite()).map_or(0, |number| number as i64)
}

impl Window {
    fn from_row(row: &Value) -> Option<Self> {
        let id = string_of(row, &["id"]);
        if id.is_empty() {
            return None;
        }
        let flag = |key: &str| row.get(key) == Some(&Value::Bool(true));
        Some(Self {
            id,
            title: string_of(row, &["title"]),
            class_name: string_of(row, &["class_name", "className"]),
            app: string_of(row, &["app"]),
            pid: number_of(row, &["pid"]),
            parent_pid: number_of(row, &["parent_pid", "parentPid"]),
            content_pid: number_of(row, &["content_pid", "contentPid"]),
            owner_id: string_of(row, &["owner_id", "ownerId"]),
            focused: flag("focused"),
            minimized: flag("minimized"),
            maximized: flag("maximized"),
            x: number_of(row, &["x"]),
            y: number_of(row, &["y"]),
            width: number_of(row, &["width"]),
            height: number_of(row, &["height"]),
        })
    }

    /// The record as the model reads it (the TS record's field names).
    fn to_json(&self) -> Value {
        json!({
            "id": self.id, "title": self.title, "className": self.class_name, "app": self.app, "pid": self.pid,
            "parentPid": self.parent_pid, "contentPid": self.content_pid, "ownerId": self.owner_id, "focused": self.focused,
            "minimized": self.minimized, "maximized": self.maximized, "x": self.x, "y": self.y, "width": self.width, "height": self.height,
        })
    }

    /// `changed`: whether the window moved, was retitled, re-owned or changed state between two lists.
    fn differs_from(&self, before: &Window) -> bool {
        before.title != self.title
            || before.owner_id != self.owner_id
            || before.focused != self.focused
            || before.minimized != self.minimized
            || before.maximized != self.maximized
            || before.x != self.x
            || before.y != self.y
            || before.width != self.width
            || before.height != self.height
    }
}

/// The windows of a helper answer; a row without an id is dropped.
fn windows_of(result: &Map<String, Value>) -> Vec<Window> {
    match result.get("windows") {
        Some(Value::Array(rows)) => rows.iter().filter_map(Window::from_row).collect(),
        Some(row @ Value::Object(_)) => Window::from_row(row).into_iter().collect(),
        _ => Vec::new(),
    }
}

/// Where window lists come from; a fake in the tests.
#[async_trait]
pub(super) trait WindowReader: Sync {
    /// One list of the desktop's windows: `with_app` names each window's app (`list_windows`, else the cheaper `window_snapshot`),
    /// `arrivals` reads through the arrivals worker's own session. `None` when the read failed; only a cancel is an error.
    async fn windows(&self, with_app: bool, arrivals: bool, cancel: &CancellationToken) -> Result<Option<Vec<Window>>, ComputerError>;
}

#[async_trait]
impl WindowReader for ProcessComputerBackend {
    async fn windows(&self, with_app: bool, arrivals: bool, cancel: &CancellationToken) -> Result<Option<Vec<Window>>, ComputerError> {
        let action = if with_app { "list_windows" } else { "window_snapshot" };
        match self.host_read(action, Vec::new(), arrivals.then_some(ARRIVALS_SESSION_ID), cancel).await {
            Ok(result) => Ok(Some(windows_of(&result))),
            Err(ComputerError::Cancelled) => Err(ComputerError::Cancelled),
            Err(_) => Ok(None),
        }
    }
}

// --- the transition (`computeComputerWindowTransition`) ---

/// Why a window became the next target.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Reason {
    OwnedWindowOpened,
    OwnerWindowRestored,
    ChildProcessWindowOpened,
    SingleSameProcessWindowOpened,
    LaunchedProcessWindow,
    LaunchedAppOpened,
    LaunchedAppFocused,
    LaunchedWindowFocused,
    LaunchedAppExisting,
    LaunchedSingleWindow,
}

impl Reason {
    fn as_str(self) -> &'static str {
        match self {
            Self::OwnedWindowOpened => "owned_window_opened",
            Self::OwnerWindowRestored => "owner_window_restored",
            Self::ChildProcessWindowOpened => "child_process_window_opened",
            Self::SingleSameProcessWindowOpened => "single_same_process_window_opened",
            Self::LaunchedProcessWindow => "launched_process_window",
            Self::LaunchedAppOpened => "launched_app_opened",
            Self::LaunchedAppFocused => "launched_app_focused",
            Self::LaunchedWindowFocused => "launched_window_focused",
            Self::LaunchedAppExisting => "launched_app_existing",
            Self::LaunchedSingleWindow => "launched_single_window",
        }
    }
}

/// What an action did to the windows of its target, from the lists before and after it.
#[derive(Clone, Debug, Default, PartialEq)]
pub(super) struct Transition {
    pub opened: Vec<Window>,
    pub closed: Vec<Window>,
    pub changed: Vec<Window>,
    pub focused_before: String,
    pub focused_after: String,
    pub next_target: Option<(Window, Reason)>,
}

impl Transition {
    /// The `window_transition` the reply carries.
    pub fn to_json(&self) -> Value {
        let rows = |windows: &[Window]| Value::Array(windows.iter().map(Window::to_json).collect());
        let mut object = Map::new();
        object.insert("observed".into(), json!(true));
        object.insert("opened_windows".into(), rows(&self.opened));
        object.insert("closed_windows".into(), rows(&self.closed));
        object.insert("changed_windows".into(), rows(&self.changed));
        object.insert("focused_before".into(), json!(self.focused_before));
        object.insert("focused_after".into(), json!(self.focused_after));
        if let Some((window, reason)) = &self.next_target {
            object.insert("next_target".into(), window.to_json());
            object.insert("next_target_reason".into(), json!(reason.as_str()));
        }
        Value::Object(object)
    }
}

type ById<'a> = HashMap<&'a str, &'a Window>;

fn by_id(windows: &[Window]) -> ById<'_> {
    windows.iter().map(|window| (window.id.as_str(), window)).collect()
}

/// `normalizedAppName`: the executable's name, lower case, without `.exe`.
fn normalized_app(value: &str) -> String {
    let name = value.replace('\\', "/").rsplit('/').next().unwrap_or_default().to_lowercase();
    name.strip_suffix(".exe").map_or_else(|| name.clone(), str::to_owned)
}

fn owner_chain_contains(candidate: &str, expected_owner: &str, windows: &ById) -> bool {
    let mut visited = HashSet::new();
    let mut current = windows.get(candidate).copied();
    while let Some(window) = current {
        if window.owner_id.is_empty() || visited.contains(window.owner_id.as_str()) {
            break;
        }
        if window.owner_id == expected_owner {
            return true;
        }
        visited.insert(window.owner_id.as_str());
        current = windows.get(window.owner_id.as_str()).copied();
    }
    false
}

/// The one candidate, else the one focused candidate.
fn unique_preferred<'a>(candidates: &[&'a Window]) -> Option<&'a Window> {
    if let [only] = candidates {
        return Some(*only);
    }
    let focused: Vec<&'a Window> = candidates.iter().copied().filter(|window| window.focused).collect();
    if let [only] = focused.as_slice() { Some(*only) } else { None }
}

fn preferred_successor<'a>(candidates: &[&'a Window], target_still_present: bool) -> Option<&'a Window> {
    let focused: Vec<&'a Window> = candidates.iter().copied().filter(|window| window.focused).collect();
    if let [only] = focused.as_slice() {
        return Some(*only);
    }
    if target_still_present { None } else { unique_preferred(candidates) }
}

/// The command launched a process or app rather than acting on a window: its successor is the window that opened for that
/// process/app, else the app window that took focus, else an existing app window.
fn launched_successor<'a>(
    opened: &[&'a Window],
    all_opened: &[&'a Window],
    after: &'a [Window],
    focused_before: &str,
    target_pid: i64,
    context_app: &str,
) -> Option<(&'a Window, Reason)> {
    let app_is_context = |window: &Window| !context_app.is_empty() && normalized_app(&window.app) == context_app;
    let of_process: Vec<&'a Window> = opened
        .iter()
        .copied()
        .filter(|window| target_pid > 0 && (window.pid == target_pid || window.parent_pid == target_pid || window.content_pid == target_pid))
        .collect();
    if let Some(window) = unique_preferred(&of_process) {
        return Some((window, Reason::LaunchedProcessWindow));
    }
    let of_app: Vec<&'a Window> = opened.iter().copied().filter(|window| app_is_context(window)).collect();
    if let Some(window) = unique_preferred(&of_app) {
        return Some((window, Reason::LaunchedAppOpened));
    }
    if let Some(window) = after.iter().find(|window| window.focused && window.id != focused_before && app_is_context(window)) {
        return Some((window, Reason::LaunchedAppFocused));
    }
    // A shell broker can host the launched app in another process under another name, so neither pid nor app name matches. A window
    // that both appeared during this launch and took focus is still that launch's window; it is offered to observe next, while the
    // launch itself stays unconfirmed.
    if let Some(window) = all_opened.iter().copied().find(|window| window.focused && window.id != focused_before) {
        return Some((window, Reason::LaunchedWindowFocused));
    }
    let existing: Vec<&'a Window> = after.iter().filter(|window| app_is_context(window)).collect();
    unique_preferred(&existing).map(|window| (window, Reason::LaunchedAppExisting))
}

/// The target closed and nothing opened: the nearest surviving owner in its chain takes over.
fn restored_owner<'a>(before: &ById, after: &ById<'a>, target_window_id: &str) -> Option<&'a Window> {
    let owner_of = |id: &str| before.get(id).map(|window| window.owner_id.clone()).filter(|owner| !owner.is_empty());
    let mut visited = HashSet::from([target_window_id.to_owned()]);
    let mut owner_id = owner_of(target_window_id);
    while let Some(id) = owner_id {
        if !visited.insert(id.clone()) {
            break;
        }
        if let Some(owner) = after.get(id.as_str()) {
            return Some(*owner);
        }
        owner_id = owner_of(&id);
    }
    None
}

/// Successor among the windows the target's action opened: one it owns, then its child process's window, then a single
/// same-process window.
fn opened_successor<'a>(opened: &[&'a Window], before: &ById, after: &ById, target_window_id: &str) -> Option<(&'a Window, Reason)> {
    let owned: Vec<&'a Window> = opened.iter().copied().filter(|window| owner_chain_contains(&window.id, target_window_id, after)).collect();
    if let Some(window) = preferred_successor(&owned, after.contains_key(target_window_id)) {
        return Some((window, Reason::OwnedWindowOpened));
    }
    let target_pid = before.get(target_window_id).map(|window| window.pid).filter(|pid| *pid != 0)?;
    let children: Vec<&'a Window> = opened.iter().copied().filter(|window| window.parent_pid == target_pid).collect();
    if let Some(window) = unique_preferred(&children) {
        return Some((window, Reason::ChildProcessWindowOpened));
    }
    let same_process: Vec<&'a Window> =
        opened.iter().copied().filter(|window| window.pid == target_pid && !owner_chain_contains(&window.id, target_window_id, after)).collect();
    unique_preferred(&same_process).map(|window| (window, Reason::SingleSameProcessWindowOpened))
}

/// `computeComputerWindowTransition`: `target_window_id` is the window the action acted on, or empty for a launch, which names
/// the process (`target_pid`) or the app (`target_app`) it started instead.
pub(super) fn compute_transition(before: &[Window], after: &[Window], target_window_id: &str, target_pid: i64, target_app: &str, launch: bool) -> Transition {
    let (before_by_id, after_by_id) = (by_id(before), by_id(after));
    let context_pid = if target_pid > 0 {
        target_pid
    } else {
        [&before_by_id, &after_by_id].iter().filter_map(|windows| windows.get(target_window_id)).map(|window| window.pid).find(|pid| *pid != 0).unwrap_or(0)
    };
    let context_app = normalized_app(target_app);
    let belongs_to_target = |window: &Window, windows: &ById| {
        window.id == target_window_id
            || (context_pid > 0 && (window.pid == context_pid || window.parent_pid == context_pid || window.content_pid == context_pid))
            || (target_window_id.is_empty() && !context_app.is_empty() && normalized_app(&window.app) == context_app)
            || (!target_window_id.is_empty() && owner_chain_contains(&window.id, target_window_id, windows))
    };
    let all_opened: Vec<&Window> = after.iter().filter(|window| !before_by_id.contains_key(window.id.as_str())).collect();
    let opened: Vec<&Window> = all_opened.iter().copied().filter(|window| belongs_to_target(window, &after_by_id)).collect();
    let closed: Vec<&Window> = before.iter().filter(|window| !after_by_id.contains_key(window.id.as_str()) && belongs_to_target(window, &before_by_id)).collect();
    let changed: Vec<&Window> = after
        .iter()
        .filter(|window| before_by_id.get(window.id.as_str()).is_some_and(|previous| belongs_to_target(window, &after_by_id) && window.differs_from(previous)))
        .collect();
    let focused_id = |windows: &[Window]| windows.iter().find(|window| window.focused).map(|window| window.id.clone()).unwrap_or_default();
    let focused_before = focused_id(before);

    let mut successor: Option<(&Window, Reason)> = None;
    if target_window_id.is_empty() && (target_pid > 0 || !context_app.is_empty()) {
        successor = launched_successor(&opened, &all_opened, after, &focused_before, target_pid, &context_app);
    }
    if target_window_id.is_empty() && launch && successor.is_none() {
        // A URI or shell verb names no process and no app, and a folder or document path names only itself while an already
        // running shell or app opens the window; a single unowned window that appeared during the launch is offered to observe next.
        let appeared: Vec<&Window> = all_opened.iter().copied().filter(|window| window.owner_id.is_empty()).collect();
        if let [window] = appeared.as_slice() {
            successor = Some((*window, Reason::LaunchedSingleWindow));
        }
    } else if !target_window_id.is_empty() && opened.is_empty() {
        let owner = if after_by_id.contains_key(target_window_id) { None } else { restored_owner(&before_by_id, &after_by_id, target_window_id) };
        successor = owner.map(|window| (window, Reason::OwnerWindowRestored));
    } else if !target_window_id.is_empty() {
        successor = opened_successor(&opened, &before_by_id, &after_by_id, target_window_id);
    }
    Transition {
        opened: opened.into_iter().cloned().collect(),
        closed: closed.into_iter().cloned().collect(),
        changed: changed.into_iter().cloned().collect(),
        focused_after: focused_id(after),
        focused_before,
        next_target: successor.map(|(window, reason)| (window.clone(), reason)),
    }
}

// --- the settle (`settleWindowTransition`) ---

/// Whether the first scan may have run before the dialog existed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DialogWatch {
    None,
    /// The command promised a window (a menu entry labelled with an ellipsis).
    Expected,
    /// Focus belongs to no listed window: the gap a modal leaves while it is being created.
    FocusGap,
}

fn menu_path_opens_dialog(path: Option<&Value>) -> bool {
    let leaf = path.and_then(Value::as_array).and_then(|path| path.last()).and_then(Value::as_str).map(js_trim).unwrap_or_default();
    leaf.ends_with("...") || leaf.ends_with('\u{2026}')
}

fn dialog_watch(action: &str, menu_path: Option<&Value>, transition: Option<&Transition>) -> DialogWatch {
    let Some(transition) = transition else { return DialogWatch::None };
    if !transition.opened.is_empty() {
        return DialogWatch::None;
    }
    if action == "invoke_menu" && menu_path_opens_dialog(menu_path) {
        return DialogWatch::Expected;
    }
    if transition.closed.is_empty() && transition.focused_after.is_empty() { DialogWatch::FocusGap } else { DialogWatch::None }
}

/// A promised dialog is worth the whole budget; a focus gap is settled as soon as some window owns focus again.
fn dialog_watch_settled(watch: DialogWatch, transition: &Transition) -> bool {
    !transition.opened.is_empty() || (watch == DialogWatch::FocusGap && !transition.focused_after.is_empty())
}

/// What a settle needs of the action it follows.
#[derive(Clone, Debug, Default)]
pub(super) struct Settling {
    pub action: String,
    /// The window the action acted on; empty for a launch.
    pub target_window_id: String,
    pub pid: i64,
    pub app_hint: String,
    pub delay: Duration,
    pub menu_path: Option<Value>,
}

/// What a settle found.
pub(super) struct Settled {
    pub transition: Option<Transition>,
    /// How long the settle took; the capture after the action is due this much later than the action.
    pub delay: Duration,
}

fn assert_running(cancel: &CancellationToken) -> Result<(), ComputerError> {
    if cancel.is_cancelled() { Err(ComputerError::Cancelled) } else { Ok(()) }
}

/// One read of the window list and the transition it shows against the list taken before the action.
async fn scan<R: WindowReader>(reader: &R, settling: &Settling, before: Option<&[Window]>, with_app: bool, cancel: &CancellationToken) -> Result<Option<Transition>, ComputerError> {
    let after = reader.windows(with_app, false, cancel).await?;
    Ok(match (before, after) {
        (Some(before), Some(after)) => Some(compute_transition(before, &after, &settling.target_window_id, settling.pid, &settling.app_hint, settling.action == "launch")),
        _ => None,
    })
}

/// A launch polls until its successor window exists or the budget ends.
async fn await_launch_successor<R: WindowReader>(reader: &R, settling: &Settling, before: Option<&[Window]>, started: Instant, cancel: &CancellationToken) -> Result<Settled, ComputerError> {
    let deadline = started + settling.delay.max(LAUNCH_SUCCESSOR_TIMEOUT);
    let minimum = settling.delay.max(LAUNCH_MINIMUM_SETTLE);
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if !remaining.is_zero() {
            sleep(LAUNCH_POLL.min(remaining)).await;
        }
        assert_running(cancel)?;
        let transition = scan(reader, settling, before, started.elapsed() >= minimum, cancel).await?;
        let ready = transition.as_ref().is_some_and(|transition| transition.next_target.is_some()) && started.elapsed() >= minimum;
        if ready || Instant::now() >= deadline {
            return Ok(Settled { transition, delay: started.elapsed() });
        }
    }
}

/// Keeps scanning until the dialog the action opened is listed, or the watch settles, or the budget ends.
async fn await_dialog<R: WindowReader>(
    reader: &R,
    settling: &Settling,
    before: Option<&[Window]>,
    watch: DialogWatch,
    first: Option<Transition>,
    cancel: &CancellationToken,
) -> Result<Option<Transition>, ComputerError> {
    let budget = if watch == DialogWatch::Expected { DIALOG_WATCH_EXPECTED } else { DIALOG_WATCH_FOCUS_GAP };
    let deadline = Instant::now() + budget;
    let mut transition = first;
    while Instant::now() < deadline {
        sleep(DIALOG_POLL.min(deadline.saturating_duration_since(Instant::now()))).await;
        assert_running(cancel)?;
        let Some(next) = scan(reader, settling, before, false, cancel).await? else { break };
        let settled = dialog_watch_settled(watch, &next);
        transition = Some(next);
        if settled {
            break;
        }
    }
    Ok(transition)
}

/// Lets the desktop settle after a mutation and reports what moved. A launch polls until its successor window exists or the
/// budget ends; every other action pays one settle and then reads the window list once, and keeps looking for a dialog it
/// promised or whose focus gap it sees. The settle budget is never shortened by watching for the transition to start.
pub(super) async fn settle<R: WindowReader>(reader: &R, settling: &Settling, before: Option<&[Window]>, cancel: &CancellationToken) -> Result<Settled, ComputerError> {
    let started = Instant::now();
    if settling.action == "launch" {
        return await_launch_successor(reader, settling, before, started, cancel).await;
    }
    if !settling.delay.is_zero() {
        sleep(settling.delay).await;
    }
    assert_running(cancel)?;
    let transition = scan(reader, settling, before, false, cancel).await?;
    let watch = dialog_watch(&settling.action, settling.menu_path.as_ref(), transition.as_ref());
    if watch == DialogWatch::None {
        return Ok(Settled { transition, delay: settling.delay });
    }
    let transition = await_dialog(reader, settling, before, watch, transition, cancel).await?;
    Ok(Settled { transition, delay: started.elapsed() })
}

// --- the windows that arrived between commands (`createWindowArrivals`) ---

/// Windows present at the session's last look or already named to it, or `Unknown`: a read failed before any baseline existed, so
/// a later list cannot tell which of its windows are new.
enum Baseline {
    Known(HashSet<String>),
    Unknown,
}

/// A session's windows that appeared since its previous command. An action reads the window list once, at its settle mark, so a
/// window that opens later (a page's sign-in popup, a slow dialog) is named by no reply: each command compares the desktop with
/// what the session already knows and names the newcomers as arrivals since the last action, never as its effects. The reads run
/// through the arrivals worker's own session, one at a time, each waited on for a short budget only: nothing here may cost the
/// command it rides on.
#[derive(Default)]
pub(super) struct Arrivals {
    baseline: Mutex<Option<Baseline>>,
    /// The one read in flight; a busy read is skipped, never queued behind.
    reading: AtomicBool,
}

/// Held while the arrivals read runs.
struct Reading<'a>(&'a AtomicBool);

impl Drop for Reading<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

fn locked<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn ids(windows: &[Window]) -> HashSet<String> {
    windows.iter().map(|window| window.id.clone()).collect()
}

impl Arrivals {
    /// The session was released (`windowArrivals.forget`): its next command takes a fresh baseline instead of naming what opened
    /// meanwhile.
    pub fn forget(&self) {
        *locked(&self.baseline) = None;
    }

    /// The list read within the budget: `None` when it is still running, another read is, or it failed.
    async fn bounded_read<R: WindowReader>(&self, reader: &R, with_app: bool, cancel: &CancellationToken) -> Result<Option<Vec<Window>>, ComputerError> {
        if self.reading.swap(true, Ordering::SeqCst) {
            return Ok(None);
        }
        let _reading = Reading(&self.reading);
        match timeout(ARRIVALS_READ_BUDGET, reader.windows(with_app, true, cancel)).await {
            Ok(read) => read,
            Err(_) => Ok(None),
        }
    }

    /// The windows the session has not been told about; a session's first command only takes the baseline. `acts` is whether the
    /// command may change the desktop, which a session without a baseline cannot tell apart from what it reads.
    pub async fn read<R: WindowReader>(&self, reader: &R, acts: bool, cancel: &CancellationToken) -> Result<Vec<Window>, ComputerError> {
        let windows = self.bounded_read(reader, false, cancel).await?;
        let mut baseline = locked(&self.baseline);
        let Some(windows) = windows else {
            // Late, busy or failed: an action without a baseline is unknown until its own before list seeds one.
            if acts && baseline.is_none() {
                *baseline = Some(Baseline::Unknown);
            }
            return Ok(Vec::new());
        };
        match baseline.take() {
            None => {
                *baseline = Some(Baseline::Known(ids(&windows)));
                Ok(Vec::new())
            }
            Some(Baseline::Unknown) => {
                // Which windows arrived since the failed read cannot be told apart, so every one counts until a reply has named it.
                *baseline = Some(Baseline::Known(HashSet::new()));
                Ok(windows)
            }
            Some(Baseline::Known(mut known)) => {
                // A closed window leaves the baseline, so a handle reused later reads as new.
                let present = ids(&windows);
                known.retain(|id| present.contains(id));
                let arrived = windows.into_iter().filter(|window| !known.contains(&window.id)).collect();
                *baseline = Some(Baseline::Known(known));
                Ok(arrived)
            }
        }
    }

    /// What an action's own window reads showed: the list before it seeds a session without a baseline, and the windows its reply
    /// names are known.
    pub fn note_settled(&self, before: Option<&[Window]>, named: &[String]) {
        let mut baseline = locked(&self.baseline);
        if !matches!(baseline.as_ref(), Some(Baseline::Known(_))) {
            let Some(before) = before else { return };
            *baseline = Some(Baseline::Known(ids(before)));
        }
        if let Some(Baseline::Known(known)) = baseline.as_mut() {
            known.extend(named.iter().cloned());
        }
    }

    /// Names the arrivals on a JSON reply. A reply that cannot carry them (plain text, user-owned clipboard text) leaves them for the
    /// next command.
    pub async fn report<R: WindowReader>(&self, reader: &R, arrived: Vec<Window>, parts: &mut [ToolPart], clipboard_read: bool, cancel: &CancellationToken) -> Result<(), ComputerError> {
        if arrived.is_empty() || clipboard_read {
            return Ok(());
        }
        let Some((text, mut payload)) = parts.iter_mut().find_map(|part| match part {
            ToolPart::Text(text) => match serde_json::from_str::<Value>(text) {
                Ok(Value::Object(payload)) => Some((text, payload)),
                _ => None,
            },
            _ => None,
        }) else {
            return Ok(());
        };
        let named: Vec<String> = arrived.iter().map(|window| window.id.clone()).collect();
        self.note_settled(None, &named);
        // The snapshot read carries no app names; only a reply with arrivals pays for them, and a slow or failed read leaves them empty.
        let apps: HashMap<String, String> = self.bounded_read(reader, true, cancel).await?.into_iter().flatten().map(|window| (window.id, window.app)).collect();
        let rows: Vec<Value> = arrived
            .iter()
            .map(|window| json!({"id": window.id, "title": window.title, "app": apps.get(&window.id).filter(|app| !app.is_empty()).unwrap_or(&window.app)}))
            .collect();
        payload.insert("windows_opened_since_last_action".into(), Value::Array(rows));
        *text = Value::Object(payload).to_string();
        Ok(())
    }
}

// --- the backend's hooks ---

/// Only the helper on Windows reports windows this way.
fn tracks() -> bool {
    cfg!(windows)
}

/// The windows an action starts from, and what its settle needs of the action.
pub(super) struct Before {
    windows: Option<Vec<Window>>,
    /// `None` for a read: it settles nothing.
    settling: Option<Settling>,
}

/// The settle delay of `command`: `capture_delay_ms` when a capture follows, else the default (`screenshotInteger`).
fn settle_delay(command: &Map<String, Value>) -> Result<Duration, ComputerError> {
    let requested = if command.get("capture_after") == Some(&Value::Bool(true)) { command.get("capture_delay_ms").filter(|value| !value.is_null()) } else { None };
    let Some(requested) = requested else { return Ok(Duration::from_millis(DEFAULT_SETTLE_MS)) };
    match requested.as_u64() {
        Some(ms) if ms <= MAX_SETTLE_MS => Ok(Duration::from_millis(ms)),
        _ => Err(ComputerError::InvalidInput { reason: format!("capture_delay_ms must be an integer from 0 to {MAX_SETTLE_MS}") }),
    }
}

/// Reads the windows before `action` runs: a mutation is judged against this list.
pub(super) async fn before(backend: &ProcessComputerBackend, action: &str, command: &Map<String, Value>, cancel: &CancellationToken) -> Result<Before, ComputerError> {
    if !tracks() || HOST_READ_ACTIONS.contains(&action) {
        return Ok(Before { windows: None, settling: None });
    }
    let settling = Settling {
        action: action.to_owned(),
        target_window_id: command.get("window_id").and_then(Value::as_str).unwrap_or_default().to_owned(),
        app_hint: command.get("app").and_then(Value::as_str).unwrap_or_default().to_owned(),
        delay: settle_delay(command)?,
        menu_path: command.get("path").cloned(),
        pid: 0,
    };
    Ok(Before { windows: backend.windows(false, false, cancel).await?, settling: Some(settling) })
}

/// Waits for `action`'s windows to settle and adds what changed since `before` to its result as `window_transition`, and how long
/// the settle took as `settle_delay_ms`.
pub(super) async fn after(backend: &ProcessComputerBackend, action: &str, before: Before, result: &mut Map<String, Value>, cancel: &CancellationToken) -> Result<(), ComputerError> {
    let Some(mut settling) = before.settling else { return Ok(()) };
    if settling.target_window_id.is_empty() {
        settling.target_window_id = result.get("window_id").and_then(Value::as_str).unwrap_or_default().to_owned();
    }
    settling.pid = result.get("pid").and_then(Value::as_i64).unwrap_or(0);
    if action != "launch" {
        settling.app_hint.clear();
    } else if let Some(hint) = result.get("app_hint").and_then(Value::as_str).filter(|hint| !hint.is_empty()) {
        settling.app_hint = hint.to_owned();
    }
    let settled = settle(backend, &settling, before.windows.as_deref(), cancel).await?;
    // The reply names these, so the session's next command does not again.
    let opened: Vec<String> = settled.transition.iter().flat_map(|transition| transition.opened.iter().map(|window| window.id.clone())).collect();
    backend.arrivals.note_settled(before.windows.as_deref(), &opened);
    if let Some(transition) = &settled.transition {
        result.insert("window_transition".into(), transition.to_json());
    }
    result.insert("settle_delay_ms".into(), json!(u64::try_from(settled.delay.as_millis()).unwrap_or(u64::MAX)));
    Ok(())
}

/// A background `sequence_step` reply as the step's result (`readSequenceStep`): the step's own result, with what the window lists
/// around it show as `window_transition` and the helper's settle as `settle_delay_ms`. A reply without the lists (a helper that
/// reads no windows) is the step's result as it is.
pub(super) fn sequence_step_result(backend: &ProcessComputerBackend, window_id: &str, reply: &Map<String, Value>) -> Map<String, Value> {
    let Some(Value::Object(step)) = reply.get("step_result") else { return reply.clone() };
    let mut result = step.clone();
    let list = |key: &str| reply.get(key).and_then(Value::as_array).map(|rows| rows.iter().filter_map(Window::from_row).collect::<Vec<_>>());
    let (Some(before), Some(after)) = (list("windows_before"), list("windows_after")) else { return result };
    let transition = compute_transition(&before, &after, window_id, result.get("pid").and_then(Value::as_i64).unwrap_or(0), "", false);
    // The reply names these, so the session's next command does not again.
    let opened: Vec<String> = transition.opened.iter().map(|window| window.id.clone()).collect();
    backend.arrivals.note_settled(Some(before.as_slice()), &opened);
    result.insert("window_transition".into(), transition.to_json());
    if let Some(delay) = reply.get("settle_delay_ms").filter(|delay| delay.is_number()) {
        result.insert("settle_delay_ms".into(), delay.clone());
    }
    result
}

/// The windows that arrived since the session's previous command, read before the command runs.
pub(super) async fn arrived_before(backend: &ProcessComputerBackend, action: &str, cancel: &CancellationToken) -> Result<Vec<Window>, ComputerError> {
    // An arrivals read never starts the helper: a spawn cut off by the read's budget could leave a resident helper the backend
    // never stored (the TS arrivals worker only started with worker slots to spare). Without one the baseline stays unset, so the
    // first read once the helper runs only takes it.
    if !tracks() || !backend.has_live_host() {
        return Ok(Vec::new());
    }
    backend.arrivals.read(backend, !HOST_READ_ACTIONS.contains(&action), cancel).await
}

/// Names `arrived` on the reply of `action`.
pub(super) async fn report_arrived(backend: &ProcessComputerBackend, action: &str, arrived: Vec<Window>, parts: &mut [ToolPart], cancel: &CancellationToken) -> Result<(), ComputerError> {
    backend.arrivals.report(backend, arrived, parts, action == "clipboard_read", cancel).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn window(id: &str, pid: i64) -> Window {
        Window { id: id.into(), pid, ..Window::default() }
    }

    fn with(mut window: Window, change: impl FnOnce(&mut Window)) -> Window {
        change(&mut window);
        window
    }

    fn compute(before: &[Window], after: &[Window], target: &str) -> Transition {
        compute_transition(before, after, target, 0, "", false)
    }

    /// The successor a transition names and why.
    fn target(transition: &Transition) -> Option<(String, Reason)> {
        transition.next_target.as_ref().map(|(window, reason)| (window.id.clone(), *reason))
    }

    fn named(id: &str, reason: Reason) -> Option<(String, Reason)> {
        Some((id.to_owned(), reason))
    }

    // `shared/window-transition-close.test.mjs`

    #[test]
    fn closing_a_background_popup_returns_to_its_owner_without_taking_another_apps_focus() {
        let main = window("hwnd:0x1", 11);
        let menu = with(window("hwnd:0x2", 11), |w| w.owner_id = main.id.clone());
        let unrelated = with(window("hwnd:0x3", 22), |w| w.focused = true);
        let transition = compute(&[main.clone(), menu.clone(), unrelated.clone()], &[main.clone(), unrelated.clone()], &menu.id);
        assert_eq!(target(&transition), named("hwnd:0x1", Reason::OwnerWindowRestored));
        assert_eq!((transition.focused_before.as_str(), transition.focused_after.as_str()), ("hwnd:0x3", "hwnd:0x3"));
        assert_eq!(transition.closed, vec![menu]);
    }

    #[test]
    fn closing_nested_popups_finds_the_nearest_surviving_owner() {
        let main = window("hwnd:0x1", 11);
        let menu = with(window("hwnd:0x2", 11), |w| w.owner_id = main.id.clone());
        let submenu = with(window("hwnd:0x4", 11), |w| w.owner_id = menu.id.clone());
        let before = [main.clone(), menu.clone(), submenu.clone()];
        let menu_left = compute(&before, &[main.clone(), menu.clone()], &submenu.id);
        assert_eq!(target(&menu_left), named("hwnd:0x2", Reason::OwnerWindowRestored));
        let main_left = compute(&before, std::slice::from_ref(&main), &submenu.id);
        assert_eq!(target(&main_left), named("hwnd:0x1", Reason::OwnerWindowRestored));
    }

    #[test]
    fn a_closed_window_without_a_surviving_owner_never_guesses_a_same_process_or_focused_target() {
        let main = window("hwnd:0x1", 11);
        let menu = window("hwnd:0x2", 11);
        let unrelated = with(window("hwnd:0x3", 22), |w| w.focused = true);
        for owner in ["", "hwnd:0x9", "hwnd:0x2"] {
            let closing = with(menu.clone(), |w| w.owner_id = owner.into());
            let transition = compute(&[main.clone(), closing.clone(), unrelated.clone()], &[main.clone(), unrelated.clone()], &closing.id);
            assert_eq!(transition.next_target, None, "owner {owner:?}");
        }
        assert_eq!(compute(&[main.clone(), menu.clone()], &[main, menu.clone()], &menu.id).next_target, None);
    }

    #[test]
    fn a_launcher_discovers_an_opened_direct_child_process_but_never_an_unrelated_app() {
        let main = window("hwnd:0x1", 11);
        let unrelated = with(window("hwnd:0x3", 22), |w| w.focused = true);
        let editor = with(window("hwnd:0x5", 33), |w| {
            w.parent_pid = 11;
            w.focused = true;
        });
        let transition = compute(&[main.clone(), unrelated.clone()], &[main.clone(), unrelated, editor.clone()], &main.id);
        assert_eq!(target(&transition), named("hwnd:0x5", Reason::ChildProcessWindowOpened));
        let stranger = with(editor, |w| w.parent_pid = 99);
        assert_eq!(compute(std::slice::from_ref(&main), &[main.clone(), stranger], &main.id).next_target, None);
    }

    #[test]
    fn a_launch_resolves_a_direct_child_process_without_guessing_unrelated_broker_windows() {
        let unrelated = with(window("hwnd:0x3", 22), |w| w.focused = true);
        let child = with(window("hwnd:0x5", 33), |w| {
            w.parent_pid = 44;
            w.app = "child-app".into();
        });
        let launch = |after: &[Window]| compute_transition(std::slice::from_ref(&unrelated), after, "", 44, "launcher", false);
        assert_eq!(target(&launch(&[unrelated.clone(), child.clone()])), named("hwnd:0x5", Reason::LaunchedProcessWindow));
        assert_eq!(launch(&[unrelated.clone(), with(child.clone(), |w| w.parent_pid = 55)]).next_target, None);
        assert_eq!(launch(&[unrelated.clone(), child.clone(), with(child, |w| w.id = "hwnd:0x6".into())]).next_target, None);
    }

    // `shared/window-transition-launch.test.mjs`

    #[test]
    fn a_frame_hosted_window_is_matched_by_the_process_that_owns_its_content() {
        let existing = with(window("hwnd:0x1", 11), |w| {
            w.focused = true;
            w.app = "explorer".into();
        });
        let frame = |content_pid| {
            with(window("hwnd:0x2", 900), |w| {
                w.content_pid = content_pid;
                w.focused = true;
                w.app = "ApplicationFrameHost".into();
            })
        };
        let blurred = with(existing.clone(), |w| w.focused = false);
        let hosted = compute_transition(std::slice::from_ref(&existing), &[blurred.clone(), frame(4242)], "", 4242, "calculator", false);
        assert_eq!(target(&hosted), named("hwnd:0x2", Reason::LaunchedProcessWindow));
        let unrelated = compute_transition(std::slice::from_ref(&existing), &[blurred, frame(55)], "", 4242, "calculator", false);
        assert_eq!(target(&unrelated), named("hwnd:0x2", Reason::LaunchedWindowFocused));
    }

    #[test]
    fn a_uri_launch_offers_the_one_window_that_appeared() {
        let existing = with(window("hwnd:0x1", 11), |w| w.focused = true);
        let settings = with(window("hwnd:0xD009C", 900), |w| w.app = "ApplicationFrameHost".into());
        let tooltip = with(window("hwnd:0x7", 11), |w| w.owner_id = "hwnd:0x1".into());
        let launch = |after: &[Window], launch| compute_transition(std::slice::from_ref(&existing), after, "", 0, "", launch);
        assert_eq!(target(&launch(&[existing.clone(), settings.clone(), tooltip], true)), named("hwnd:0xD009C", Reason::LaunchedSingleWindow));
        let second = with(settings.clone(), |w| w.id = "hwnd:0xE".into());
        assert_eq!(launch(&[existing.clone(), settings.clone(), second], true).next_target, None);
        assert_eq!(launch(&[existing.clone(), settings], false).next_target, None, "another action never adopts a window that happened to appear");
    }

    #[test]
    fn a_folder_path_launch_offers_the_explorer_window_that_appeared() {
        let existing = with(window("hwnd:0x1", 11), |w| w.focused = true);
        let folder = with(window("hwnd:0x29B0E6C", 7128), |w| w.app = "explorer".into());
        let transition = compute_transition(std::slice::from_ref(&existing), &[existing.clone(), folder], "", 0, "C:\\Users\\me\\AppData\\Local\\Temp\\probe", true);
        assert_eq!(target(&transition), named("hwnd:0x29B0E6C", Reason::LaunchedSingleWindow));
    }

    #[test]
    fn the_helpers_rows_are_read_with_the_hosted_process_as_content_pid() {
        let rows = json!({"windows": [{"id": "hwnd:0x3", "pid": 900, "parent_pid": 4, "content_pid": 4242}, {"id": "hwnd:0x4", "pid": 900}, {"pid": 1}]});
        let windows = windows_of(rows.as_object().unwrap());
        assert_eq!(windows.iter().map(|w| (w.id.as_str(), w.parent_pid, w.content_pid)).collect::<Vec<_>>(), [("hwnd:0x3", 4, 4242), ("hwnd:0x4", 0, 0)]);
        assert_eq!(windows[0].to_json()["contentPid"], 4242);
    }

    // `host/window-settle.test.mjs` (the pure part)

    #[test]
    fn a_menu_command_that_promises_a_dialog_keeps_watching_for_it() {
        let steady = Transition { focused_before: "a".into(), focused_after: "a".into(), ..Transition::default() };
        let promised = json!(["File", "Save as..."]);
        assert_eq!(dialog_watch("invoke_menu", Some(&promised), Some(&steady)), DialogWatch::Expected);
        assert_eq!(dialog_watch("invoke_menu", Some(&json!(["File", "Save \u{2026}"])), Some(&steady)), DialogWatch::Expected);
        assert_eq!(dialog_watch("invoke_menu", Some(&json!(["File", "Save"])), Some(&steady)), DialogWatch::None);
        let listed = Transition { opened: vec![window("d", 1)], ..steady.clone() };
        assert_eq!(dialog_watch("invoke_menu", Some(&promised), Some(&listed)), DialogWatch::None);
    }

    #[test]
    fn focus_belonging_to_no_listed_window_is_the_gap_a_modal_leaves_while_it_is_created() {
        let gap = Transition { focused_before: "a".into(), ..Transition::default() };
        let focused = Transition { focused_after: "a".into(), ..gap.clone() };
        assert_eq!(dialog_watch("click", None, Some(&gap)), DialogWatch::FocusGap);
        assert_eq!(dialog_watch("click", None, Some(&focused)), DialogWatch::None);
        assert_eq!(dialog_watch("click", None, Some(&Transition { closed: vec![window("d", 1)], ..gap.clone() })), DialogWatch::None);
        assert!(!dialog_watch_settled(DialogWatch::FocusGap, &gap));
        assert!(dialog_watch_settled(DialogWatch::FocusGap, &focused));
        assert!(!dialog_watch_settled(DialogWatch::Expected, &focused));
        assert!(dialog_watch_settled(DialogWatch::Expected, &Transition { opened: vec![window("d", 1)], ..gap }));
    }

    #[test]
    fn the_settle_delay_is_the_captures_or_the_default() {
        let command = |value: Value| value.as_object().unwrap().clone();
        assert_eq!(settle_delay(&command(json!({"capture_delay_ms": 900}))).unwrap(), Duration::from_millis(150), "no capture follows");
        assert_eq!(settle_delay(&command(json!({"capture_after": true, "capture_delay_ms": 900}))).unwrap(), Duration::from_millis(900));
        assert_eq!(settle_delay(&command(json!({"capture_after": true}))).unwrap(), Duration::from_millis(150));
        assert!(settle_delay(&command(json!({"capture_after": true, "capture_delay_ms": 2001}))).is_err());
        assert!(settle_delay(&command(json!({"capture_after": true, "capture_delay_ms": 1.5}))).is_err());
    }

    type Script = Box<dyn Fn(Duration, usize) -> Option<Vec<Window>> + Send + Sync>;

    /// A reader whose answers depend on the (virtual) time and the number of the call; each call is logged with when it was made.
    struct Clocked {
        started: Instant,
        script: Script,
        calls: Mutex<Vec<(Duration, bool, bool)>>,
        slow: Duration,
    }

    impl Clocked {
        fn new(script: impl Fn(Duration, usize) -> Option<Vec<Window>> + Send + Sync + 'static) -> Self {
            Self { started: Instant::now(), script: Box::new(script), calls: Mutex::default(), slow: Duration::ZERO }
        }

        fn calls(&self) -> Vec<(Duration, bool, bool)> {
            locked(&self.calls).clone()
        }
    }

    #[async_trait]
    impl WindowReader for Clocked {
        async fn windows(&self, with_app: bool, arrivals: bool, _cancel: &CancellationToken) -> Result<Option<Vec<Window>>, ComputerError> {
            let (at, number) = {
                let mut calls = locked(&self.calls);
                let at = self.started.elapsed();
                calls.push((at, with_app, arrivals));
                (at, calls.len())
            };
            if !self.slow.is_zero() {
                sleep(self.slow).await;
            }
            Ok((self.script)(at, number))
        }
    }

    fn settling(action: &str, target: &str) -> Settling {
        Settling { action: action.into(), target_window_id: target.into(), delay: Duration::from_millis(DEFAULT_SETTLE_MS), ..Settling::default() }
    }

    fn ms(value: u64) -> Duration {
        Duration::from_millis(value)
    }

    #[tokio::test(start_paused = true)]
    async fn a_dialog_created_after_the_settle_scan_is_still_reported_as_the_successor() {
        let main = with(window("hwnd:0x1", 10), |w| w.focused = true);
        let dialog = with(window("hwnd:0x2", 10), |w| {
            w.owner_id = main.id.clone();
            w.focused = true;
        });
        let (shown, hidden, dialog_shown) = (main.clone(), with(main.clone(), |w| w.focused = false), dialog.clone());
        let reader = Clocked::new(move |at, _| Some(if at < ms(400) { vec![shown.clone()] } else { vec![hidden.clone(), dialog_shown.clone()] }));
        let mut asking = settling("invoke_menu", &main.id);
        asking.menu_path = Some(json!(["File", "Save as..."]));
        asking.pid = 10;

        let settled = settle(&reader, &asking, Some(std::slice::from_ref(&main)), &CancellationToken::new()).await.unwrap();

        let transition = settled.transition.expect("a transition");
        assert_eq!(transition.opened, vec![dialog]);
        assert_eq!(target(&transition), named("hwnd:0x2", Reason::OwnedWindowOpened));
        assert!(reader.calls().len() > 1, "the watch has to scan again after the dialog appears");
        assert_eq!(settled.delay, ms(450), "150 ms settle, then polled every 100 ms until the scan at 450 ms sees it");
    }

    #[tokio::test(start_paused = true)]
    async fn a_promised_dialog_that_never_appears_ends_on_its_own_budget() {
        let main = with(window("hwnd:0x1", 10), |w| w.focused = true);
        let only = main.clone();
        let reader = Clocked::new(move |_, _| Some(vec![only.clone()]));
        let mut asking = settling("invoke_menu", &main.id);
        asking.menu_path = Some(json!(["File", "Settings..."]));

        let settled = settle(&reader, &asking, Some(std::slice::from_ref(&main)), &CancellationToken::new()).await.unwrap();

        assert_eq!(settled.delay, ms(150 + 1_200), "the settle delay plus the expected-dialog budget");
        assert_eq!(settled.transition.expect("a transition").opened, Vec::<Window>::new());
        assert!(reader.calls().len() > 2);
    }

    #[tokio::test(start_paused = true)]
    async fn an_action_with_no_dialog_to_wait_for_pays_one_settle_and_one_scan() {
        let main = with(window("hwnd:0x1", 10), |w| w.focused = true);
        let only = main.clone();
        let reader = Clocked::new(move |_, _| Some(vec![only.clone()]));

        let settled = settle(&reader, &settling("click", &main.id), Some(std::slice::from_ref(&main)), &CancellationToken::new()).await.unwrap();

        assert_eq!(settled.delay, ms(150));
        assert_eq!(reader.calls(), vec![(ms(150), false, false)]);
    }

    #[tokio::test(start_paused = true)]
    async fn the_launch_successor_is_found_on_the_third_poll_and_the_settle_still_lasts_its_minimum() {
        let existing = with(window("hwnd:0x1", 11), |w| w.focused = true);
        let editor = with(window("hwnd:0x5", 33), |w| {
            w.focused = true;
            w.app = "notepad".into();
        });
        let (old, new) = (existing.clone(), editor.clone());
        let reader = Clocked::new(move |_, number| Some(if number < 3 { vec![old.clone()] } else { vec![old.clone(), new.clone()] }));
        let mut launching = settling("launch", "");
        launching.pid = 33;
        launching.app_hint = "notepad".into();

        let settled = settle(&reader, &launching, Some(std::slice::from_ref(&existing)), &CancellationToken::new()).await.unwrap();

        let transition = settled.transition.expect("a transition");
        assert_eq!(target(&transition), named("hwnd:0x5", Reason::LaunchedProcessWindow));
        assert_eq!(settled.delay, ms(500), "found at 300 ms, held to the 500 ms minimum");
        let polls: Vec<(u128, bool)> = reader.calls().iter().map(|(at, with_app, _)| (at.as_millis(), *with_app)).collect();
        assert_eq!(polls, [(100, false), (200, false), (300, false), (400, false), (500, true)], "app names are read once the minimum has passed");
    }

    #[tokio::test(start_paused = true)]
    async fn a_launch_that_opens_nothing_gives_up_after_four_seconds() {
        let existing = window("hwnd:0x1", 11);
        let only = existing.clone();
        let reader = Clocked::new(move |_, _| Some(vec![only.clone()]));
        let mut launching = settling("launch", "");
        launching.pid = 33;

        let settled = settle(&reader, &launching, Some(std::slice::from_ref(&existing)), &CancellationToken::new()).await.unwrap();

        assert_eq!(settled.transition.expect("a transition").next_target, None);
        assert_eq!(settled.delay, ms(4_000));
    }

    #[tokio::test(start_paused = true)]
    async fn a_cancel_ends_the_settle() {
        let main = window("hwnd:0x1", 10);
        let only = main.clone();
        let reader = Clocked::new(move |_, _| Some(vec![only.clone()]));
        let cancel = CancellationToken::new();
        cancel.cancel();
        let ended = settle(&reader, &settling("click", &main.id), Some(std::slice::from_ref(&main)), &cancel).await;
        assert!(matches!(ended, Err(ComputerError::Cancelled)));
    }

    fn reply(text: &str) -> Vec<ToolPart> {
        vec![ToolPart::Text(text.into())]
    }

    fn text_of(parts: &[ToolPart]) -> &str {
        match &parts[0] {
            ToolPart::Text(text) => text,
            _ => panic!("text part"),
        }
    }

    /// A reader that lists `first` at its first call and `later` at every other.
    fn listing(first: Vec<Window>, later: Vec<Window>) -> Clocked {
        Clocked::new(move |_, number| Some(if number == 1 { first.clone() } else { later.clone() }))
    }

    /// `window-arrivals.test.mjs`: a popup that opens after the settle check is named by the next command, once.
    #[tokio::test(start_paused = true)]
    async fn arrivals_are_named_once_then_cleared() {
        let (first, popup) = (window("hwnd:0x1", 1), with(window("hwnd:0x9", 2), |w| w.title = "Sign in".into()));
        let reader = listing(vec![first.clone()], vec![first, popup.clone()]);
        let arrivals = Arrivals::default();
        let cancel = CancellationToken::new();

        assert!(arrivals.read(&reader, true, &cancel).await.unwrap().is_empty(), "a session's first command only takes the baseline");
        let arrived = arrivals.read(&reader, true, &cancel).await.unwrap();
        assert_eq!(arrived, vec![popup]);
        let mut parts = reply(r#"{"ok":true}"#);
        arrivals.report(&reader, arrived, &mut parts, false, &cancel).await.unwrap();
        let payload: Value = serde_json::from_str(text_of(&parts)).unwrap();
        assert_eq!(payload["windows_opened_since_last_action"], json!([{"id": "hwnd:0x9", "title": "Sign in", "app": ""}]));
        assert_eq!(payload["ok"], true);

        assert!(arrivals.read(&reader, true, &cancel).await.unwrap().is_empty(), "named windows are not named again");
        assert!(reader.calls().iter().all(|(_, _, arrivals)| *arrivals), "through the arrivals worker's own session");
    }

    #[tokio::test(start_paused = true)]
    async fn a_reply_that_cannot_carry_arrivals_leaves_them_for_the_next_command() {
        let (first, popup) = (window("hwnd:0x1", 1), window("hwnd:0x9", 2));
        let reader = listing(vec![first.clone()], vec![first, popup.clone()]);
        let arrivals = Arrivals::default();
        let cancel = CancellationToken::new();
        arrivals.read(&reader, false, &cancel).await.unwrap();

        let arrived = arrivals.read(&reader, false, &cancel).await.unwrap();
        for (text, clipboard) in [("plain text", false), (r#"{"text":"secret"}"#, true)] {
            let mut parts = reply(text);
            arrivals.report(&reader, arrived.clone(), &mut parts, clipboard, &cancel).await.unwrap();
            assert_eq!(text_of(&parts), text);
        }
        assert_eq!(arrivals.read(&reader, false, &cancel).await.unwrap(), vec![popup]);
    }

    #[tokio::test(start_paused = true)]
    async fn a_window_an_act_step_transition_already_named_is_not_named_again() {
        let (first, dialog) = (window("hwnd:0x1", 1), window("hwnd:0x9", 2));
        let reader = listing(vec![first.clone()], vec![first.clone(), dialog.clone()]);
        let arrivals = Arrivals::default();
        let cancel = CancellationToken::new();
        arrivals.read(&reader, true, &cancel).await.unwrap();

        arrivals.note_settled(Some(std::slice::from_ref(&first)), &[dialog.id.clone()]);

        assert!(arrivals.read(&reader, true, &cancel).await.unwrap().is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn an_arrivals_read_that_never_answers_costs_the_command_only_its_short_budget() {
        let mut reader = Clocked::new(|_, _| Some(vec![window("hwnd:0x1", 1)]));
        reader.slow = Duration::from_secs(3_600);
        let arrivals = Arrivals::default();
        let began = Instant::now();

        assert!(arrivals.read(&reader, true, &CancellationToken::new()).await.unwrap().is_empty());

        assert_eq!(began.elapsed(), ARRIVALS_READ_BUDGET);
        assert!(!arrivals.reading.load(Ordering::SeqCst), "the next command may read again");
    }

    #[tokio::test(start_paused = true)]
    async fn a_failed_first_read_leaves_the_baseline_unknown_so_a_popup_that_opens_next_is_still_named() {
        let popup = window("hwnd:0x9", 2);
        let shown = popup.clone();
        let reader = Clocked::new(move |_, number| (number > 1).then(|| vec![shown.clone()]));
        let arrivals = Arrivals::default();
        let cancel = CancellationToken::new();

        assert!(arrivals.read(&reader, true, &cancel).await.unwrap().is_empty());
        assert_eq!(arrivals.read(&reader, true, &cancel).await.unwrap(), vec![popup], "every window counts until a reply has named it");
    }

    #[tokio::test(start_paused = true)]
    async fn a_failed_first_read_before_an_act_takes_the_acts_own_before_list_as_the_baseline() {
        let (first, second) = (window("hwnd:0x1", 1), window("hwnd:0x2", 2));
        let shown = vec![first.clone(), second.clone()];
        let reader = Clocked::new(move |_, number| (number > 1).then(|| shown.clone()));
        let arrivals = Arrivals::default();
        let cancel = CancellationToken::new();
        arrivals.read(&reader, true, &cancel).await.unwrap();

        arrivals.note_settled(Some(&[first, second]), &[]);

        assert!(arrivals.read(&reader, true, &cancel).await.unwrap().is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn a_closed_window_leaves_the_baseline_so_a_reused_handle_reads_as_new() {
        let (first, reused) = (window("hwnd:0x1", 1), window("hwnd:0x7", 2));
        let lists = [vec![first.clone(), reused.clone()], vec![first.clone()], vec![first, reused.clone()]];
        let reader = Clocked::new(move |_, number| lists.get(number - 1).cloned());
        let arrivals = Arrivals::default();
        let cancel = CancellationToken::new();
        arrivals.read(&reader, true, &cancel).await.unwrap();
        assert!(arrivals.read(&reader, true, &cancel).await.unwrap().is_empty());
        assert_eq!(arrivals.read(&reader, true, &cancel).await.unwrap(), vec![reused]);
    }
}
