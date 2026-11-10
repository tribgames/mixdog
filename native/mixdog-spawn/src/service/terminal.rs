//! `terminal/*`: the terminal tab layer ([`TerminalTabs`]) behind its wire methods. A tab's output
//! is the scoped feed `process:<tabId>`; the sections `terminalActivity` and `terminalTabs` follow
//! the tabs' own change callbacks, in order, through one worker.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use bytes::Bytes;
use mixdog_app_protocol::TerminalInputParams;
use mixdog_app_protocol::TerminalResizeParams;
use mixdog_app_protocol::v2::feed::FeedPosition as WireFeedPosition;
use mixdog_app_protocol::v2::params::TerminalAttachParams;
use mixdog_app_protocol::v2::params::TerminalDisposeParams;
use mixdog_app_protocol::v2::params::TerminalEnsureParams;
use mixdog_app_protocol::v2::params::TerminalFocusParams;
use mixdog_app_protocol::v2::params::TerminalPauseParams;
use mixdog_app_protocol::v2::params::TerminalResumeParams;
use mixdog_core_api::call::CoreRequest;
use mixdog_core_api::call::Reply;
use mixdog_core_api::call::Subscribe;
use mixdog_core_api::error::CoreError;
use mixdog_core_api::feed::FeedPosition;
use mixdog_core_api::feed::ResumeFrom;
use mixdog_core_api::feed::Window;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::service::Admit;
use mixdog_core_api::service::DomainService;
use mixdog_core_api::state::SectionChange;
use mixdog_core_api::state::StatePublisher;
use mixdog_protocol::SectionName;
use mixdog_rt::TaskClass;
use serde_json::Value;
use serde_json::json;
use tokio::sync::mpsc;

use super::client_of;
use super::connection_key;
use super::decode;
use super::domain_error;
use super::feeds::ProcessFeeds;
use super::invalid_params;
use super::process_failure;
use crate::manager::LocalProcessManager;
use crate::terminal::ActivityState;
use crate::terminal::Attached;
use crate::terminal::EnsureRequest;
use crate::terminal::Published;
use crate::terminal::SizeOwner;
use crate::terminal::SizeOwnerChange;
use crate::terminal::TerminalConfig;
use crate::terminal::TerminalError;
use crate::terminal::TerminalEvents;
use crate::terminal::TerminalTabs;

#[derive(Default)]
pub struct TerminalServiceConfig {
    /// Mixdog's own directory for shell startup files (see [`TerminalConfig`]).
    pub shell_integration_dir: Option<PathBuf>,
}

/// A change of tab state, queued by the tabs (under their lock) for the section worker.
enum Change {
    Activity(String, Option<ActivityState>),
    /// A tab's size owner changed (cleared when its last claim ended).
    Owner(SizeOwnerChange),
    /// A disposed tab's claims were dropped: what is held for the id goes without an owner event.
    Forgotten(String),
    Tabs,
    /// Answered once every change queued before it is published: a reply that must not overtake the events its call caused.
    Barrier(tokio::sync::oneshot::Sender<()>),
}

struct Events {
    changes: mpsc::UnboundedSender<Change>,
}

impl TerminalEvents for Events {
    fn activity(&self, id: &str, state: Option<ActivityState>) {
        let _ = self.changes.send(Change::Activity(id.to_owned(), state));
    }

    fn size_owner(&self, change: &SizeOwnerChange) {
        let _ = self.changes.send(Change::Owner(change.clone()));
    }

    fn size_claims_forgotten(&self, id: &str) {
        let _ = self.changes.send(Change::Forgotten(id.to_owned()));
    }

    fn published(&self) -> Option<Published> {
        let (published, done) = tokio::sync::oneshot::channel();
        self.changes.send(Change::Barrier(published)).ok().map(|()| done)
    }
}

pub struct TerminalService {
    tabs: Arc<TerminalTabs>,
    feeds: Arc<ProcessFeeds>,
    changes: mpsc::UnboundedSender<Change>,
}

fn section_bytes(value: &Value) -> SectionChange {
    SectionChange::Set(Bytes::from(serde_json::to_vec(value).expect("a section value serializes")))
}

fn owner_json(owner: &SizeOwner) -> Value {
    json!({ "cols": owner.cols, "rows": owner.rows, "owner": owner.owner })
}

/// What one client is told about a tab's size owner: `own` is true when this client holds it.
fn client_owner(owner: Option<&SizeOwner>, client: &str) -> Value {
    match owner {
        Some(owner) => json!({ "cols": owner.cols, "rows": owner.rows, "own": !client.is_empty() && owner.owner == client }),
        None => Value::Null,
    }
}

/// The answer to an ensure or attach: Node's `{id, replay, sizeOwner}` and the asking connection's key. A replay window that starts
/// inside a non-BMP character carries the lone low surrogate Node's string starts with as `replayLeadUnit`, which the adapter puts back
/// in front of `replay` (JSON text from the core cannot hold a lone surrogate); the field is absent otherwise.
pub fn attached_reply(attached: &Attached, client: &str) -> Value {
    let mut reply = json!({
        "id": attached.id,
        "replay": attached.replay,
        "sizeOwner": client_owner(attached.size_owner.as_ref(), client),
        "client": client,
    });
    if let Some(lead) = attached.replay_lead {
        reply["replayLeadUnit"] = json!(lead);
    }
    reply
}

/// Applies queued changes to the sections, one at a time and in order, and publishes what changed:
/// the section follows every change the way Node's per-change events did, so the phone's events
/// (activity, size owner) are the changes themselves, never a coalesced state.
async fn publish_sections(
    mut changes: mpsc::UnboundedReceiver<Change>,
    tabs: Arc<TerminalTabs>,
    publisher: Arc<dyn StatePublisher>,
) {
    // Tabs with a known activity, in creation order (Node's `activitySnapshot` walks its tab map).
    let mut activity: Vec<(u64, String, &'static str)> = Vec::new();
    // The owner of each id's size as the changes announced it; claims belong to the id, not the process, so an id with no tab has
    // one too (Node announces a claim whether or not a PTY exists). `None` is a release announced and not yet published: it is
    // published once, as the row of that id with a null owner, and dropped after.
    let mut owners: HashMap<String, Option<SizeOwner>> = HashMap::new();
    while let Some(change) = changes.recv().await {
        let (mut activity_changed, mut tabs_changed) = (false, false);
        match change {
            Change::Activity(id, Some(state)) => {
                let state = state.as_str();
                match activity.iter_mut().find(|(_, known, _)| *known == id) {
                    Some(entry) => {
                        activity_changed = entry.2 != state;
                        entry.2 = state;
                    }
                    None => {
                        let seq = tabs.creation_order(&id).unwrap_or(u64::MAX);
                        let at = activity.partition_point(|(other, ..)| *other <= seq);
                        activity.insert(at, (seq, id, state));
                        activity_changed = true;
                    }
                }
            }
            Change::Activity(id, None) => {
                let before = activity.len();
                activity.retain(|(_, known, _)| *known != id);
                activity_changed = activity.len() != before;
            }
            Change::Owner(change) => {
                let owner = (!change.owner.is_empty()).then(|| SizeOwner { cols: change.cols, rows: change.rows, owner: change.owner });
                owners.insert(change.id, owner);
                tabs_changed = true;
            }
            Change::Forgotten(id) => {
                owners.remove(&id);
                continue;
            }
            Change::Tabs => tabs_changed = true,
            Change::Barrier(published) => {
                let _ = published.send(());
                continue;
            }
        }
        if activity_changed {
            let object: serde_json::Map<String, Value> =
                activity.iter().map(|(_, id, state)| (id.clone(), json!(state))).collect();
            publisher.publish(SectionName::TerminalActivity, None, section_bytes(&Value::Object(object)));
        }
        if tabs_changed {
            let listed = tabs.list_tabs();
            let mut list: Vec<Value> = listed
                .iter()
                .map(|tab| {
                    json!({
                        "id": tab.id,
                        "shell": tab.shell,
                        "running": tab.running,
                        "cwd": tab.cwd,
                        "sizeOwner": owners.get(&tab.id).and_then(Option::as_ref).map(owner_json),
                    })
                })
                .collect();
            // An id with an owner and no tab: a row of its own (`tab: false`) so the phone hears its claim and release.
            let mut bare: Vec<&String> = owners.keys().filter(|id| !listed.iter().any(|tab| &tab.id == *id)).collect();
            bare.sort();
            list.extend(bare.into_iter().map(|id| {
                json!({ "id": id, "tab": false, "running": false, "sizeOwner": owners[id].as_ref().map(owner_json) })
            }));
            publisher.publish(SectionName::TerminalTabs, None, section_bytes(&Value::Array(list)));
            owners.retain(|_, owner| owner.is_some());
        }
    }
}
impl TerminalService {
    pub fn new(
        manager: LocalProcessManager,
        feeds: Arc<ProcessFeeds>,
        publisher: Arc<dyn StatePublisher>,
        config: TerminalServiceConfig,
    ) -> Arc<Self> {
        let (changes, queue) = mpsc::unbounded_channel();
        let mut tab_config = TerminalConfig::new(Arc::new(Events { changes: changes.clone() }));
        tab_config.shell_integration_dir = config.shell_integration_dir;
        let tabs = Arc::new(TerminalTabs::new(manager, tab_config));
        let worker_tabs = Arc::clone(&tabs);
        mixdog_rt::spawn("terminal-sections", TaskClass::Work, publish_sections(queue, worker_tabs, publisher));
        // A tab's shell ending changes the tab list.
        let on_exit = changes.clone();
        feeds.on_exit(move |_| {
            let _ = on_exit.send(Change::Tabs);
        });
        Arc::new(Self { tabs, feeds, changes })
    }

    /// The tab layer, for the in-process `terminal` tool.
    pub fn tabs(&self) -> &Arc<TerminalTabs> {
        &self.tabs
    }

    /// A connection closed: its focus on every tab ends (its size claims lapse with their lease).
    pub fn connection_closed(&self, connection: ConnectionId) {
        self.tabs.connection_closed(&connection_key(connection));
    }
}

fn terminal_failure(error: TerminalError) -> CoreError {
    match error {
        TerminalError::Disposed => domain_error("terminal", "DISPOSED"),
        TerminalError::InvalidCwd => invalid_params("options.cwd", "an absolute path"),
        TerminalError::Process(error) => process_failure(error),
    }
}

fn resume_of(value: Option<Value>) -> Result<Option<ResumeFrom>, CoreError> {
    let Some(value) = value.filter(|v| !v.is_null()) else {
        return Ok(None);
    };
    let position: WireFeedPosition =
        serde_json::from_value(value).map_err(|e| invalid_params("resumeFrom", e.to_string()))?;
    Ok(Some(ResumeFrom {
        position: FeedPosition {
            epoch: position.epoch,
            seq: position.seq,
        },
        window: Window::Fixed,
    }))
}

/// How long a reply waits for the events its call caused to be published (see `TerminalService::published`).
const PUBLISH_DEADLINE: std::time::Duration = std::time::Duration::from_secs(10);

impl TerminalService {
    /// Resolves once every change queued before it is published: a reply that must not overtake the events its call caused. A publish
    /// reaches the connection's app-feed lane at once; the connection's writer still sends control frames (answers) before lane frames
    /// (mixdog-app-server-transport writer.rs `next_work`), so this orders the answer behind the events only up to the writer.
    ///
    /// Bounded by [`PUBLISH_DEADLINE`]: a section worker that has not reached the barrier by then (a publisher stuck downstream) does
    /// not hold the call, and the call fails (`terminal`/`PUBLISH_TIMEOUT`, naming the wait): its events may follow the answer, which a
    /// plain answer would hide. The worker ending (shutdown) ends the wait.
    async fn published(&self) -> Result<(), CoreError> {
        let (published, done) = tokio::sync::oneshot::channel();
        if self.changes.send(Change::Barrier(published)).is_ok() && tokio::time::timeout(PUBLISH_DEADLINE, done).await.is_err() {
            return Err(CoreError::DomainError {
                domain: "terminal".into(),
                code: Some("PUBLISH_TIMEOUT".into()),
                message: Some(format!("the events this call caused were not published within {PUBLISH_DEADLINE:?}").into()),
                detail: None,
            });
        }
        Ok(())
    }
}

#[async_trait]
impl DomainService for TerminalService {
    async fn call(&self, req: CoreRequest) -> Result<Reply, CoreError> {
        let client = client_of(&req);
        match req.method.as_str() {
            "terminal/ensure" => {
                let params: TerminalEnsureParams = decode(&req.params)?;
                let options = &params.options;
                // No choice spawns the detected OS default (Node's `resolveShellProfile('')`): pwsh before Windows PowerShell.
                let profile = self.tabs.resolve_profile(options.get("profile").and_then(Value::as_str).unwrap_or("")).await;
                let request = EnsureRequest {
                    cwd: options.get("cwd").and_then(Value::as_str).map(str::to_owned),
                    profile,
                    cols: options.get("cols").and_then(Value::as_u64).map(|n| n as u32),
                    rows: options.get("rows").and_then(Value::as_u64).map(|n| n as u32),
                };
                let attached = self
                    .tabs
                    .ensure(params.tab_id.as_ref().map(|id| id.as_str()), request)
                    .await
                    .map_err(terminal_failure)?;
                // Node pushed `termData` of every running terminal to a phone reading the lane: the output feed exists from the
                // first ensure and pumping, so a `feed/subscribe` of `process:<id>` finds it and reads its output.
                // Node answered the ensure in-process before the new shell's first output (all five recorded runs, runs.json): the
                // feed is held until the answer is in the connection's outgoing queue, as for a disposal.
                let held = self.feeds.open_terminal(&attached.id, || self.tabs.relay_order(&attached.id));
                let _ = self.changes.send(Change::Tabs);
                req.ctx.after_answer.keep(held);
                Ok(Reply::Value(attached_reply(&attached, &client)))
            }
            "terminal/attach" => {
                let params: TerminalAttachParams = decode(&req.params)?;
                let resume_from = resume_of(params.resume_from)?;
                // A tab that is not running answers `null` (Node's `termAttach`), never an error.
                let Some(attached) = self.tabs.attach(params.tab_id.as_str()).await else {
                    return Ok(Reply::Value(Value::Null));
                };
                // A phone reads the tab's output framed as Node's relay lane sent it; the window keeps the raw feed (its own
                // 5 ms buffer is in the desktop's main process, ipc-terminal.ts).
                let feed = if req.ctx.origin == mixdog_protocol::Origin::Relay {
                    self.feeds.relay_feed(&attached.id)
                } else {
                    self.feeds.feed(&attached.id, true)
                };
                Ok(Reply::Subscribe(Subscribe {
                    result: attached_reply(&attached, &client),
                    feed,
                    window: Window::Fixed,
                    resume_from,
                }))
            }
            "terminal/profiles" => {
                let profiles: Vec<Value> = self
                    .tabs
                    .profiles()
                    .await
                    .into_iter()
                    .map(|p| {
                        let mut entry = json!({ "id": p.id, "label": p.label, "path": p.path });
                        if p.default {
                            entry["default"] = json!(true);
                        }
                        entry
                    })
                    .collect();
                Ok(Reply::Value(Value::Array(profiles)))
            }
            "terminal/focus" => {
                let params: TerminalFocusParams = decode(&req.params)?;
                self.tabs.focus(params.tab_id.as_str(), &client, params.focused);
                // A focus that clears a finished tab forwards the activity change before the request is answered, as a disposal does.
                self.published().await?;
                Ok(Reply::Value(json!({})))
            }
            "terminal/pause" => {
                let params: TerminalPauseParams = decode(&req.params)?;
                self.tabs.pause_output(params.tab_id.as_str());
                Ok(Reply::Value(json!({})))
            }
            "terminal/resume" => {
                let params: TerminalResumeParams = decode(&req.params)?;
                self.tabs.resume_output(params.tab_id.as_str());
                Ok(Reply::Value(json!({})))
            }
            "terminal/dispose" => {
                let params: TerminalDisposeParams = decode(&req.params)?;
                // The phone sees, as Node recorded it (golden.json, trace.claims.order): the tab's end, the dispose's answer, then
                // what the killed shell still wrote and its exit line. The feed is held from before the kill until the answer is made.
                let held = self.feeds.hold(params.tab_id.as_str());
                self.tabs.dispose(params.tab_id.as_str());
                self.feeds.close(params.tab_id.as_str());
                let _ = self.changes.send(Change::Tabs);
                // Node's disposal forwards the tab's end (state: null) before it answers the request (terminal-manager.ts:541,
                // remote-relay-push-lanes.ts:150, remote-methods.ts:1284).
                self.published().await?;
                // The hold ends once the answer is in the connection's outgoing queue (or the request or the connection is gone), so
                // nothing the pump publishes after it can be queued ahead of the answer.
                req.ctx.after_answer.keep(held);
                Ok(Reply::Value(json!({})))
            }
            other => Err(invalid_params("method", format!("a method of terminal, not {other}"))),
        }
    }

    fn methods(&self) -> &'static [&'static str] {
        &[
            "terminal/ensure",
            "terminal/attach",
            "terminal/profiles",
            "terminal/focus",
            "terminal/pause",
            "terminal/resume",
            "terminal/dispose",
            "terminal/input",
            "terminal/resize",
        ]
    }

    fn notify(&self, method: Method, params: Value, from: ConnectionId) -> Admit {
        // Keystrokes and sizes of a tab that is gone are ignored, as the tabs do themselves.
        match method.as_str() {
            "terminal/input" => {
                if let Ok(input) = serde_json::from_value::<TerminalInputParams>(params) {
                    // Input the tab's queue cannot take yet pauses this connection's reader until it is written, as `process/input` does.
                    if let Some(pending) = self.tabs.write(input.tab_id.as_str(), &input.data) {
                        return Admit::Pause(Box::pin(pending.finish()));
                    }
                }
            }
            "terminal/resize" => {
                if let Ok(size) = serde_json::from_value::<TerminalResizeParams>(params) {
                    // Only a claiming view is a size owner; any other view's resize has no client.
                    let client = if size.claim == Some(true) { connection_key(from) } else { String::new() };
                    // Node resized the PTY and announced the new owner in one call (terminal-manager.ts:485-488): whatever happened
                    // after that call reached the phone after the announcement (the console's re-render, a relay flush whose 16 ms ran
                    // out later, the shell's exit, a later output's activity), and what Node had read before it was in its relay buffer
                    // already. So what the shell writes from here, the relay flushes and the exit wait until the announcement is
                    // published; the output already in the feed does not (`hold_new_output`). Activity changes go through the same
                    // ordered queue as the announcement and are not held. The hold's deadline runs from here, so a resize that blocks
                    // in the console holds the feed for no longer than that. A stated limit: a resize still blocked when the deadline
                    // passes lets what was held go before the owner, a shell's exit (its end and exit line) included.
                    let release = self.feeds.hold_new_output(size.tab_id.as_str()).map(|held| {
                        let deadline = tokio::time::Instant::now() + PUBLISH_DEADLINE;
                        let (published, done) = tokio::sync::oneshot::channel();
                        mixdog_rt::spawn("terminal-owner-first", TaskClass::Work, async move {
                            let _ = tokio::time::timeout_at(deadline, done).await;
                            drop(held);
                        });
                        published
                    });
                    self.tabs.resize(size.tab_id.as_str(), u32::from(size.cols), u32::from(size.rows), &client);
                    if let Some(published) = release {
                        // A worker that is gone drops `published`, which ends the hold.
                        let _ = self.changes.send(Change::Barrier(published));
                    }
                }
            }
            _ => {}
        }
        Admit::Accepted
    }
}

#[cfg(all(test, feature = "core-test"))]
mod tests {
    use std::sync::Mutex;
    use std::time::Duration;

    use base64::Engine;
    use base64::engine::general_purpose::STANDARD;
    use mixdog_core_api::domain::common::AbsPath;
    use mixdog_core_api::domain::process::CommandSpec;
    use mixdog_core_api::domain::process::EnvSpec;
    use mixdog_core_api::domain::process::OutputMode;
    use mixdog_core_api::domain::process::ProcessManager;
    use mixdog_core_api::domain::process::ProcessOwner;
    use mixdog_core_api::domain::process::SpawnRequest;
    use mixdog_core_api::feed::ScopedFeed;
    use mixdog_core_api::feed::ScopedFeeds;
    use mixdog_core_api::mock::FeedTap;
    use mixdog_core_api::mock::MockLimits;
    use mixdog_core_api::mock::MockScopedFeeds;
    use mixdog_core_api::mock::MockStatePublisher;
    use mixdog_protocol::FeedId;
    use mixdog_protocol::ProcessHandle;

    use super::*;
    use crate::manager::ProcessConfig;
    #[cfg(windows)]
    use crate::terminal::SpawnProfile;

    const DEADLINE: Duration = Duration::from_secs(60);

    /// `fut`'s value, or a failure naming `what` once [`DEADLINE`] has passed on the wall clock. The deadline waits on the blocking
    /// pool, which also keeps a paused clock from moving by itself meanwhile: only the test's `advance` moves it.
    async fn within<T>(what: &str, fut: impl std::future::Future<Output = T>) -> T {
        let (_alive, timer) = std::sync::mpsc::channel::<()>();
        let deadline = tokio::task::spawn_blocking(move || {
            let _ = timer.recv_timeout(DEADLINE);
        });
        tokio::select! {
            value = fut => value,
            _ = deadline => panic!("never happened within {DEADLINE:?}: {what}"),
        }
    }

    /// Holds the next tab-list publication (where a size owner is published) until the test opens the gate, and notes how many frames
    /// the phone's relay feed had when it went.
    #[derive(Default)]
    struct Gated {
        inner: MockStatePublisher,
        gate: Mutex<Option<(std::sync::mpsc::Sender<()>, std::sync::mpsc::Receiver<()>)>>,
        relay: Mutex<Option<Arc<dyn ScopedFeed>>>,
        relay_at_owner: Mutex<Option<u64>>,
    }

    impl StatePublisher for Gated {
        fn publish(&self, section: SectionName, key: Option<String>, change: SectionChange) {
            let gate = (section == SectionName::TerminalTabs).then(|| self.gate.lock().unwrap().take()).flatten();
            let Some((held, open)) = gate else {
                return self.inner.publish(section, key, change);
            };
            held.send(()).unwrap();
            open.recv_timeout(DEADLINE).expect("the test opens the gate");
            let relay = self.relay.lock().unwrap().clone().expect("the relay feed is known");
            *self.relay_at_owner.lock().unwrap() = Some(relay.position().seq);
            self.inner.publish(section, key, change);
            // Told the test the owner is out.
            let _ = held.send(());
        }
    }

    /// The text of the output frames among `frames`, with each frame's feed sequence number.
    fn outputs(frames: &[Value]) -> Vec<(u64, String)> {
        frames
            .iter()
            .filter(|frame| frame["method"] == "process/outputDelta")
            .map(|frame| {
                let bytes = STANDARD.decode(frame["params"]["bytesB64"].as_str().expect("output carries bytes")).unwrap();
                (frame["feed"]["seq"].as_u64().expect("a feed frame has its seq"), String::from_utf8_lossy(&bytes).into_owned())
            })
            .collect()
    }

    fn sent(frames: &[Value], text: &str) -> Option<u64> {
        outputs(frames).into_iter().find(|(_, output)| output.contains(text)).map(|(seq, _)| seq)
    }

    /// A process that writes `before` and then `after`, each once the test sends it a line.
    fn two_writes(handle: &ProcessHandle) -> SpawnRequest {
        let command = if cfg!(windows) {
            let script = "$null = [Console]::In.ReadLine(); [Console]::Out.Write('before'); $null = [Console]::In.ReadLine(); \
                          [Console]::Out.Write('after'); $null = [Console]::In.ReadLine()";
            CommandSpec::Argv { program: "powershell".to_owned(), args: vec!["-NoProfile".to_owned(), "-Command".to_owned(), script.to_owned()] }
        } else {
            CommandSpec::Argv { program: "sh".to_owned(), args: vec!["-c".to_owned(), "read a; printf before; read b; printf after; read c".to_owned()] }
        };
        SpawnRequest {
            handle: handle.clone(),
            command,
            cwd: AbsPath::new(std::env::temp_dir()).unwrap(),
            env: EnvSpec { inherit: true, ..EnvSpec::default() },
            pty: None,
            stdin_piped: true,
            output: OutputMode::Merged,
            owner: ProcessOwner::Internal,
            time_limit: None,
        }
    }

    /// A claim holds back what the shell writes after it (the console's re-render) until the size owner is published, on a clock only
    /// the test moves: the phone gets the announcement first, as Node's did (it resized and announced in one call,
    /// terminal-manager.ts:485-488). Output already in the feed when the claim came (Node had it in its relay buffer then) is not held.
    #[test]
    fn a_claim_holds_back_what_the_shell_writes_after_it_until_its_owner_is_published() {
        let paused = tokio::runtime::Builder::new_current_thread().enable_all().start_paused(true).build().unwrap();
        let sections = tokio::runtime::Builder::new_multi_thread().worker_threads(1).enable_all().build().unwrap();
        paused.block_on(async {
            let manager = LocalProcessManager::new(mixdog_rt::testing::tokens().spawn_io, ProcessConfig::default());
            let scoped = Arc::new(MockScopedFeeds::new(MockLimits::default()));
            let feeds = ProcessFeeds::new(manager.clone(), Arc::clone(&scoped) as Arc<dyn ScopedFeeds>);
            let publisher = Arc::new(Gated::default());
            // The section worker runs on a runtime of its own: a held publication blocks it, not the pump.
            let service = {
                let _sections = sections.enter();
                TerminalService::new(manager.clone(), Arc::clone(&feeds), Arc::clone(&publisher) as Arc<dyn StatePublisher>, TerminalServiceConfig::default())
            };
            let handle = ProcessHandle::from(format!("term_claim_{}", std::process::id()));
            manager.spawn(two_writes(&handle)).await.unwrap();
            let opened = feeds.open_terminal(handle.as_str(), || None);
            let relay = scoped.find(&FeedId::from(format!("process:relay:{handle}"))).expect("the relay feed exists");
            *publisher.relay.lock().unwrap() = Some(Arc::clone(&relay));
            let tap = FeedTap::attach(&relay);
            let mut written = manager.subscribe(&handle, None).unwrap();
            manager.write_input(&handle, b"1\n".to_vec()).unwrap();
            within("the first output entered the feed", written.next()).await;

            let (held, open) = (std::sync::mpsc::channel(), std::sync::mpsc::channel());
            *publisher.gate.lock().unwrap() = Some((held.0, open.1));
            let _ = service.notify(Method("terminal/resize"), json!({ "tabId": handle.as_str(), "cols": 101, "rows": 31, "claim": true }), ConnectionId(1));
            let held = Arc::new(Mutex::new(held.1));
            let next_from_publisher = |what: &'static str| {
                let held = Arc::clone(&held);
                async move { tokio::task::spawn_blocking(move || held.lock().unwrap().recv_timeout(DEADLINE)).await.unwrap().expect(what) }
            };
            next_from_publisher("the owner's publication reached the publisher").await;
            drop(opened);
            within("the output already in the feed went out while the owner was unpublished", tap.notifications_until(|frames| sent(frames, "before").is_some())).await;

            // The hold stands until just before its deadline; the relay's 16 ms are long over, so unheld output would go at once.
            tokio::time::advance(PUBLISH_DEADLINE - Duration::from_millis(1)).await;
            let mut stops = feeds.stops_of(handle.as_str());
            let stopped = *stops.borrow_and_update();
            manager.write_input(&handle, b"2\n".to_vec()).unwrap();
            within("the re-render entered the feed", written.next()).await;
            within("the pump stopped for the hold or sent the re-render", async {
                tokio::select! {
                    _ = stops.wait_for(|stops| *stops > stopped) => {}
                    _ = tap.notifications_until(|frames| sent(frames, "after").is_some()) => {}
                }
            })
            .await;
            open.0.send(()).unwrap();
            next_from_publisher("the owner was published").await;
            let frames = within("the re-render reached the phone", tap.notifications_until(|frames| sent(frames, "after").is_some())).await;
            let at_owner = publisher.relay_at_owner.lock().unwrap().expect("the owner was published");
            assert_eq!(sent(&frames, "before"), Some(at_owner), "the output from before the claim was the last frame before the owner");
            assert!(sent(&frames, "after").unwrap() > at_owner, "the re-render reached the phone before the owner announcement: {frames:?}");
            let _ = manager.kill(&handle);
        });
    }

    /// What ends a claim's hold in [`a_parked_chunk_goes_once_whatever_ends_the_claims_hold`].
    #[derive(Clone, Copy, Debug, PartialEq)]
    enum Release {
        /// The owner is published.
        Published,
        /// The deadline passes with the publication still blocked.
        Deadline,
        /// The shell ends while the hold stands; the owner is published after.
        TabEnd,
    }

    /// C3 (b) and C2: the hold goes in while the producer is paused with a chunk at its gate; the chunk enters the feed on resume and
    /// waits for the hold. Whatever ends the hold (publication, deadline, or publication after the tab's end, which by itself ends no
    /// hold: the exit is what waits), the chunk reaches the phone exactly once and the hold is gone exactly once (its one `FeedHold`,
    /// dropped by the claim's task).
    fn a_parked_chunk_goes_once_whatever_ends_the_claims_hold(release: Release) {
        let paused = tokio::runtime::Builder::new_current_thread().enable_all().start_paused(true).build().unwrap();
        let sections = tokio::runtime::Builder::new_multi_thread().worker_threads(1).enable_all().build().unwrap();
        paused.block_on(async {
            let manager = LocalProcessManager::new(mixdog_rt::testing::tokens().spawn_io, ProcessConfig::default());
            let scoped = Arc::new(MockScopedFeeds::new(MockLimits::default()));
            let feeds = ProcessFeeds::new(manager.clone(), Arc::clone(&scoped) as Arc<dyn ScopedFeeds>);
            let publisher = Arc::new(Gated::default());
            let service = {
                let _sections = sections.enter();
                TerminalService::new(manager.clone(), Arc::clone(&feeds), Arc::clone(&publisher) as Arc<dyn StatePublisher>, TerminalServiceConfig::default())
            };
            let handle = ProcessHandle::from(format!("term_parked_{release:?}_{}", std::process::id()));
            manager.spawn(two_writes(&handle)).await.unwrap();
            let opened = feeds.open_terminal(handle.as_str(), || None);
            let relay = scoped.find(&FeedId::from(format!("process:relay:{handle}"))).expect("the relay feed exists");
            *publisher.relay.lock().unwrap() = Some(Arc::clone(&relay));
            let tap = FeedTap::attach(&relay);
            let mut written = manager.subscribe(&handle, None).unwrap();
            manager.write_input(&handle, b"1\n".to_vec()).unwrap();
            within("the first output entered the feed", written.next()).await;
            drop(opened);
            within("the first output reached the phone", tap.notifications_until(|frames| sent(frames, "before").is_some())).await;
            // The relay's window after that frame closes: what comes next goes on its own.
            tokio::time::advance(Duration::from_secs(1)).await;

            manager.set_output_paused(&handle, true).unwrap();
            manager.write_input(&handle, b"2\n".to_vec()).unwrap();
            within("the producer parked the chunk at the gate", manager.output_blocked(&handle)).await.unwrap();
            let (held, open) = (std::sync::mpsc::channel(), std::sync::mpsc::channel());
            *publisher.gate.lock().unwrap() = Some((held.0, open.1));
            let mut holds = feeds.holds_of(handle.as_str());
            let _ = service.notify(Method("terminal/resize"), json!({ "tabId": handle.as_str(), "cols": 101, "rows": 31, "claim": true }), ConnectionId(1));
            assert_eq!(holds.borrow_and_update().len(), 1, "the claim took its hold");
            let held = Arc::new(Mutex::new(held.1));
            let next_from_publisher = |what: &'static str| {
                let held = Arc::clone(&held);
                async move { tokio::task::spawn_blocking(move || held.lock().unwrap().recv_timeout(DEADLINE)).await.unwrap().expect(what) }
            };
            next_from_publisher("the owner's publication reached the publisher").await;

            let mut stops = feeds.stops_of(handle.as_str());
            let stopped = *stops.borrow_and_update();
            manager.set_output_paused(&handle, false).unwrap();
            within("the parked chunk entered the feed", written.next()).await;
            within("the pump stopped for the hold", stops.wait_for(|stops| *stops > stopped)).await.unwrap();
            assert_eq!(sent(&tap.notifications_until(|_| true).await, "after"), None, "the parked chunk went while held");

            match release {
                Release::Published => {
                    open.0.send(()).unwrap();
                    next_from_publisher("the owner was published").await;
                }
                Release::Deadline => tokio::time::advance(PUBLISH_DEADLINE).await,
                Release::TabEnd => {
                    let _ = manager.kill(&handle);
                    within("the shell's exit entered the feed", manager.feed_of(&handle).unwrap().ended()).await;
                    let frames = tap.notifications_until(|_| true).await;
                    assert_eq!(sent(&frames, "after"), None, "the parked chunk went at the tab's end, before the owner");
                    assert!(frames.iter().all(|frame| frame["method"] != "process/exited"), "the exit went before the owner");
                    open.0.send(()).unwrap();
                    next_from_publisher("the owner was published").await;
                }
            }
            within("the hold ended", holds.wait_for(Vec::is_empty)).await.unwrap();
            within("the parked chunk reached the phone", tap.notifications_until(|frames| sent(frames, "after").is_some())).await;
            tokio::time::advance(Duration::from_secs(1)).await;
            let _ = manager.kill(&handle);
            let frames = within("the exit reached the phone", tap.notifications_until(|frames| frames.iter().any(|frame| frame["method"] == "process/exited"))).await;
            let text: String = outputs(&frames).into_iter().map(|(_, output)| output).collect();
            assert_eq!(text.matches("after").count(), 1, "the parked chunk reached the phone once: {text:?}");
            assert!(holds.borrow().is_empty(), "the hold came back");
            if release == Release::Deadline {
                open.0.send(()).unwrap();
                next_from_publisher("the owner was published").await;
            }
        });
    }

    #[test]
    fn a_parked_chunk_goes_once_when_the_owner_is_published() {
        a_parked_chunk_goes_once_whatever_ends_the_claims_hold(Release::Published);
    }

    #[test]
    fn a_parked_chunk_goes_once_when_the_hold_reaches_its_deadline() {
        a_parked_chunk_goes_once_whatever_ends_the_claims_hold(Release::Deadline);
    }

    #[test]
    fn a_parked_chunk_goes_once_when_the_tab_ends_during_the_hold() {
        a_parked_chunk_goes_once_whatever_ends_the_claims_hold(Release::TabEnd);
    }

    /// Records every section publication with the relay feed's position when it went.
    /// The first publication a gate matches waits (on the section worker) until the test opens the gate.
    #[cfg(windows)]
    #[derive(Default)]
    struct Ordered {
        relay: Mutex<Option<Arc<dyn ScopedFeed>>>,
        log: Mutex<Vec<(bool, Value, u64)>>,
        changed: tokio::sync::Notify,
        #[allow(clippy::type_complexity)]
        gate: Mutex<Option<(Box<dyn Fn(bool, &Value) -> bool + Send>, std::sync::mpsc::Sender<()>, std::sync::mpsc::Receiver<()>)>>,
    }

    #[cfg(windows)]
    impl StatePublisher for Ordered {
        fn publish(&self, section: SectionName, _: Option<String>, change: SectionChange) {
            let SectionChange::Set(bytes) = &change else { return };
            let tabs = section == SectionName::TerminalTabs;
            let value: Value = serde_json::from_slice(bytes).unwrap();
            let gated = {
                let mut gate = self.gate.lock().unwrap();
                if gate.as_ref().is_some_and(|(matches, ..)| matches(tabs, &value)) { gate.take() } else { None }
            };
            if let Some((_, held, open)) = gated {
                held.send(()).unwrap();
                open.recv_timeout(DEADLINE).expect("the test opens the gate within 60 s");
            }
            let at = self.relay.lock().unwrap().as_ref().map_or(0, |relay| relay.position().seq);
            self.log.lock().unwrap().push((tabs, value, at));
            self.changed.notify_waiters();
        }
    }

    #[cfg(windows)]
    impl Ordered {
        /// The relay position at the first publication `found` matches, once there is one.
        async fn at(&self, found: impl Fn(bool, &Value) -> bool) -> u64 {
            loop {
                let changed = self.changed.notified();
                let mut changed = std::pin::pin!(changed);
                changed.as_mut().enable();
                if let Some((_, _, at)) = self.log.lock().unwrap().iter().find(|(tabs, value, _)| found(*tabs, value)) {
                    return *at;
                }
                changed.await;
            }
        }

        fn index(&self, found: impl Fn(bool, &Value) -> bool) -> Option<usize> {
            self.log.lock().unwrap().iter().position(|(tabs, value, _)| found(*tabs, value))
        }
    }

    /// A tab running the integrated Windows PowerShell (its prompt marks the tab idle, so the tab's end is an activity change), its
    /// relay feed pumped and read, the section worker on a runtime of its own (a gated publication blocks it, not the pump), the test
    /// on a paused clock: the tab's exit comes [`crate::manager::NODE_PTY_FLUSH`] after the shell's end only when the test advances it.
    #[cfg(windows)]
    struct ShellRig {
        manager: LocalProcessManager,
        feeds: Arc<ProcessFeeds>,
        publisher: Arc<Ordered>,
        service: Arc<TerminalService>,
        id: String,
        handle: ProcessHandle,
        relay: Arc<dyn ScopedFeed>,
        raw: FeedTap,
        tap: FeedTap,
    }

    #[cfg(windows)]
    impl ShellRig {
        async fn start(name: &str, sections: &tokio::runtime::Runtime) -> Self {
            let manager = LocalProcessManager::new(mixdog_rt::testing::tokens().spawn_io, ProcessConfig::default());
            let scoped = Arc::new(MockScopedFeeds::new(MockLimits::default()));
            let feeds = ProcessFeeds::new(manager.clone(), Arc::clone(&scoped) as Arc<dyn ScopedFeeds>);
            let publisher = Arc::new(Ordered::default());
            let service = {
                let _sections = sections.enter();
                TerminalService::new(manager.clone(), Arc::clone(&feeds), Arc::clone(&publisher) as Arc<dyn StatePublisher>, TerminalServiceConfig::default())
            };
            let id = format!("term_{name}_{}", std::process::id());
            let handle = ProcessHandle::from(id.as_str());
            let profile = SpawnProfile { path: "powershell.exe".to_owned(), ..SpawnProfile::default() };
            within("the tab started", service.tabs.ensure(Some(&id), EnsureRequest { profile: Some(profile), cols: Some(80), rows: Some(24), ..EnsureRequest::default() }))
                .await
                .unwrap();
            drop(feeds.open_terminal(&id, || service.tabs.relay_order(&id)));
            let relay = scoped.find(&FeedId::from(format!("process:relay:{id}"))).expect("the relay feed exists");
            *publisher.relay.lock().unwrap() = Some(Arc::clone(&relay));
            let raw = FeedTap::attach(&scoped.find(&FeedId::from(format!("process:{id}"))).expect("the raw feed exists"));
            let tap = FeedTap::attach(&relay);
            let rig = Self { manager, feeds, publisher, service, id, handle, relay, raw, tap };
            within("the prompt's activity was published", rig.publisher.at(|tabs, value| !tabs && value.get(&rig.id).is_some())).await;
            // The relay's window closes: the next output goes as a leading-edge frame.
            tokio::time::advance(Duration::from_secs(1)).await;
            rig
        }

        /// The shell has ended and its exit wait has seen every byte it wrote (the clock has not moved since its end).
        async fn ended_quietly(&self) {
            let mut wait = self.manager.exit_wait(&self.handle).unwrap();
            let manager = &self.manager;
            within("the shell ended and its output was seen", wait.wait_for(|wait| wait.waiting && wait.quiet_from == manager.output_pushed(&self.handle).unwrap()))
                .await
                .unwrap();
        }

        /// The pump has taken every byte the shell wrote.
        async fn all_taken(&self) {
            let pushed = self.manager.output_pushed(&self.handle).unwrap() as usize;
            let total = |frames: &[Value]| outputs(frames).iter().map(|(_, text)| text.len()).sum::<usize>();
            within("the pump took the shell's output", self.raw.notifications_until(|frames| total(frames) >= pushed)).await;
        }

        fn ended(&self) -> impl Fn(bool, &Value) -> bool + '_ {
            |tabs, value| !tabs && value.get(&self.id).is_none()
        }

        fn owned(&self) -> impl Fn(bool, &Value) -> bool + '_ {
            |tabs, value| tabs && value.as_array().is_some_and(|rows| rows.iter().any(|row| row["id"] == json!(self.id) && !row["sizeOwner"].is_null()))
        }
    }

    /// Blocks on `rx` for at most [`DEADLINE`], off the paused runtime.
    async fn received(rx: &Arc<Mutex<std::sync::mpsc::Receiver<()>>>, what: &'static str) {
        let rx = Arc::clone(rx);
        tokio::task::spawn_blocking(move || rx.lock().unwrap().recv_timeout(DEADLINE)).await.unwrap().expect(what);
    }

    /// G1: the shell's end and its exit line reach a client in Node's order (terminal-manager.ts:378-384: the text, `activity.exit()`,
    /// the exit line). The tab's end is held at the publisher; the pump waits for it and does not send the exit line meanwhile.
    #[cfg(windows)]
    #[test]
    fn the_exit_line_waits_until_the_tabs_end_has_reached_the_clients() {
        let paused = tokio::runtime::Builder::new_current_thread().enable_all().start_paused(true).build().unwrap();
        let sections = tokio::runtime::Builder::new_multi_thread().worker_threads(1).enable_all().build().unwrap();
        paused.block_on(async {
            let rig = ShellRig::start("exit_order", &sections).await;
            assert!(rig.service.tabs.write(&rig.id, "exit\r").is_none(), "the line was queued");
            rig.ended_quietly().await;
            let (held, open) = (std::sync::mpsc::channel(), std::sync::mpsc::channel());
            let id = rig.id.clone();
            *rig.publisher.gate.lock().unwrap() = Some((Box::new(move |tabs, value: &Value| !tabs && value.get(&id).is_none()), held.0, open.1));
            let held = Arc::new(Mutex::new(held.1));
            let mut orderings = rig.feeds.orderings_of(&rig.id);
            let ordered = *orderings.borrow_and_update();
            tokio::time::advance(crate::manager::NODE_PTY_FLUSH).await;
            received(&held, "the tab's end reached the publisher").await;
            // The raw feed carries the pump's output at once (the relay feed may buffer it for its 16 ms).
            let exit_line = |frames: &[Value]| sent(frames, "[process exited").is_some();
            within("the pump waited for the tab's end or sent the exit line", async {
                tokio::select! {
                    _ = orderings.wait_for(|waits| *waits > ordered) => {}
                    _ = rig.raw.notifications_until(exit_line) => {}
                }
            })
            .await;
            assert!(!exit_line(&rig.raw.notifications_until(|_| true).await), "the exit line went while the tab's end was held at the publisher");
            assert!(!exit_line(&rig.tap.notifications_until(|_| true).await), "the exit line went while the tab's end was held at the publisher");
            open.0.send(()).unwrap();
            let at_end = within("the tab's end was published", rig.publisher.at(rig.ended())).await;
            tokio::time::advance(Duration::from_secs(1)).await;
            let frames = within("the exit line went", rig.tap.notifications_until(exit_line)).await;
            assert!(sent(&frames, "[process exited").unwrap() > at_end, "the exit line went before the tab's end");
        });
    }

    /// G2 and C1, through the service: a claim takes its hold and its resize stops at the claim gate, before the announcement; the
    /// shell's end comes meanwhile (`paused`: its echo of `exit` waiting unread at the paused gate; otherwise with all its output
    /// taken); the resize is let go. A client gets the owner, then (`paused`) the parked output as a leading-edge frame, then the tab's
    /// end, then the exit line, and no activity change before the owner: Node ran no exit handler inside its resize-and-announce call
    /// (terminal-manager.ts:485-488).
    #[cfg(windows)]
    fn the_owner_goes_before_the_exit_of_a_shell_that_ends_during_a_claim(paused: bool) {
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().start_paused(true).build().unwrap();
        let sections = tokio::runtime::Builder::new_multi_thread().worker_threads(1).enable_all().build().unwrap();
        runtime.block_on(async {
            let rig = ShellRig::start(if paused { "claimed_parked" } else { "claimed_taken" }, &sections).await;
            if paused {
                rig.manager.set_output_paused(&rig.handle, true).unwrap();
            }
            // Paused: the line without its Enter, so the shell is still there when the claim comes; its echo waits at the gate.
            assert!(rig.service.tabs.write(&rig.id, if paused { "exit" } else { "exit\r" }).is_none(), "the line was queued");
            if paused {
                within("the producer parked the shell's echo at the gate", rig.manager.output_blocked(&rig.handle)).await.unwrap();
            } else {
                rig.ended_quietly().await;
                rig.all_taken().await;
            }
            let claimed = rig.publisher.log.lock().unwrap().len();
            let gate = rig.service.tabs.hold_claim_gate(&rig.id);
            let mut holds = rig.feeds.holds_of(&rig.id);
            let (claimed_tx, claimed_rx) = std::sync::mpsc::channel();
            {
                let (service, runtime, id) = (Arc::clone(&rig.service), tokio::runtime::Handle::current(), rig.id.clone());
                std::thread::spawn(move || {
                    let _runtime = runtime.enter();
                    let _ = service.notify(Method("terminal/resize"), json!({ "tabId": id, "cols": 101, "rows": 31, "claim": true }), ConnectionId(1));
                    let _ = claimed_tx.send(());
                });
            }
            within("the claim took its hold", holds.wait_for(|holds| holds.len() == 1)).await.unwrap();
            if paused {
                assert!(rig.service.tabs.write(&rig.id, "\r").is_none(), "the Enter was queued");
            }
            // Paused: the shell's end lets the parked echo in, after the end, which starts the exit wait again.
            rig.ended_quietly().await;
            tokio::time::advance(crate::manager::NODE_PTY_FLUSH).await;
            within("the shell's exit entered the feed", rig.manager.feed_of(&rig.handle).unwrap().ended()).await;
            let before = rig.relay.position().seq;
            drop(gate);
            received(&Arc::new(Mutex::new(claimed_rx)), "the claim's resize returned once its gate was let go").await;

            let at_owner = within("the owner was published", rig.publisher.at(rig.owned())).await;
            let at_end = within("the tab's end was published", rig.publisher.at(rig.ended())).await;
            assert_eq!(at_owner, before, "output went while the claim held the feed, or after the owner was published");
            let owner = rig.publisher.index(rig.owned()).unwrap();
            let log = rig.publisher.log.lock().unwrap().clone();
            let changes: Vec<usize> = (claimed..log.len()).filter(|at| !log[*at].0).collect();
            assert!(changes.iter().all(|at| *at > owner), "an activity change went before the owner: {log:?}");
            let frames = if paused {
                within("the parked output went as a leading-edge frame", rig.tap.notifications_until(|frames| outputs(frames).iter().any(|(seq, _)| *seq > before))).await
            } else {
                Vec::new()
            };
            tokio::time::advance(Duration::from_secs(1)).await;
            let frames = [frames, within("the exit line went", rig.tap.notifications_until(|frames| sent(frames, "[process exited").is_some())).await].concat();
            let exit_line = sent(&frames, "[process exited").unwrap();
            if paused {
                let parked = outputs(&frames).into_iter().find(|(seq, _)| *seq > before).unwrap();
                assert!(parked.0 != exit_line && parked.0 <= at_end, "the parked output is not between the owner ({at_owner}) and the tab's end ({at_end}): {parked:?}");
            }
            assert!(exit_line > at_end, "the exit line went before the tab's end");
        });
    }

    #[cfg(windows)]
    #[test]
    fn the_owner_goes_before_the_exit_and_the_parked_output_of_a_shell_that_ends_during_a_claim() {
        the_owner_goes_before_the_exit_of_a_shell_that_ends_during_a_claim(true);
    }

    #[cfg(windows)]
    #[test]
    fn the_owner_goes_before_the_exit_of_a_shell_that_ends_with_its_output_taken_during_a_claim() {
        the_owner_goes_before_the_exit_of_a_shell_that_ends_during_a_claim(false);
    }

    /// A claim's hold has its deadline from when it is taken: a resize that blocks (here at the id's claim gate) holds the feed no longer.
    #[tokio::test(start_paused = true)]
    async fn a_claims_hold_ends_at_its_deadline_while_the_resize_is_blocked() {
        let manager = LocalProcessManager::new(mixdog_rt::testing::tokens().spawn_io, ProcessConfig::default());
        let feeds = ProcessFeeds::new(manager.clone(), Arc::new(MockScopedFeeds::new(MockLimits::default())));
        let service = TerminalService::new(manager, Arc::clone(&feeds), Arc::new(MockStatePublisher::default()), TerminalServiceConfig::default());
        let _ = feeds.feed("term_blocked", true);
        let gate = service.tabs.hold_claim_gate("term_blocked");
        let mut holds = feeds.holds_of("term_blocked");
        let (claimed_tx, claimed_rx) = std::sync::mpsc::channel();
        {
            let (service, runtime) = (Arc::clone(&service), tokio::runtime::Handle::current());
            std::thread::spawn(move || {
                let _runtime = runtime.enter();
                let _ = service.notify(Method("terminal/resize"), json!({ "tabId": "term_blocked", "cols": 101, "rows": 31, "claim": true }), ConnectionId(1));
                let _ = claimed_tx.send(());
            });
        }
        within("the claim took its hold", holds.wait_for(|holds| holds.len() == 1)).await.unwrap();
        tokio::time::advance(PUBLISH_DEADLINE - Duration::from_millis(1)).await;
        assert_eq!(holds.borrow().len(), 1, "the hold ended before its deadline");
        tokio::time::advance(Duration::from_millis(1)).await;
        within("the hold of a claim whose resize is blocked ended at its deadline", holds.wait_for(Vec::is_empty)).await.unwrap();
        drop(gate);
        received(&Arc::new(Mutex::new(claimed_rx)), "the claim's resize returned once its gate was let go").await;
    }

    /// A dispose is not answered before the tab's end it caused is published (Node: terminal-manager.ts:541, `activity.exit()` before
    /// the answer): with that publication held at the publisher, the call waits through the barrier's whole deadline, and when the
    /// deadline passes it fails (`PUBLISH_TIMEOUT`) instead of answering ahead of the tab's end.
    #[cfg(windows)]
    #[test]
    fn a_dispose_whose_tabs_end_is_held_is_not_answered_first() {
        let paused = tokio::runtime::Builder::new_current_thread().enable_all().start_paused(true).build().unwrap();
        let sections = tokio::runtime::Builder::new_multi_thread().worker_threads(1).enable_all().build().unwrap();
        paused.block_on(async {
            let rig = ShellRig::start("dispose_held", &sections).await;
            let (held, open) = (std::sync::mpsc::channel(), std::sync::mpsc::channel());
            let id = rig.id.clone();
            *rig.publisher.gate.lock().unwrap() = Some((Box::new(move |tabs, value: &Value| !tabs && value.get(&id).is_none()), held.0, open.1));
            let request = CoreRequest {
                method: Method("terminal/dispose"),
                params: json!({ "tabId": rig.id, "opId": "op-dispose" }),
                op: None,
                ctx: mixdog_core_api::call::CallContext::internal("test"),
            };
            let mut reply = std::pin::pin!(rig.service.call(request));
            assert!(still_pending(reply.as_mut()).await, "the dispose was answered while the tab's end was held at the publisher");
            received(&Arc::new(Mutex::new(held.1)), "the tab's end reached the publisher").await;
            tokio::time::advance(PUBLISH_DEADLINE - Duration::from_millis(1)).await;
            assert!(still_pending(reply.as_mut()).await, "the dispose was answered before the barrier's deadline with the tab's end still held");
            tokio::time::advance(Duration::from_millis(1)).await;
            let answer = within("the dispose ended at the barrier's deadline", reply).await;
            match answer {
                Err(CoreError::DomainError { code: Some(code), .. }) if &*code == "PUBLISH_TIMEOUT" => {}
                other => panic!("a dispose whose tab's end was never published was answered as {other:?}, not a PUBLISH_TIMEOUT error"),
            }
            open.0.send(()).unwrap();
            within("the tab's end was published once the gate opened", rig.publisher.at(rig.ended())).await;
        });
    }

    /// Polls `future` once: whether it is still pending.
    #[cfg(windows)]
    async fn still_pending<F: std::future::Future + ?Sized>(mut future: std::pin::Pin<&mut F>) -> bool {
        std::future::poll_fn(|cx| std::task::Poll::Ready(future.as_mut().poll(cx).is_pending())).await
    }
}
