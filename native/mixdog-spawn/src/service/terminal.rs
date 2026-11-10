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

impl TerminalService {
    /// Resolves once every change queued before it is published: a reply that must not overtake the events its call caused. A publish
    /// reaches the connection's queue at once, so the reply that follows is received after those events.
    async fn published(&self) {
        let (published, done) = tokio::sync::oneshot::channel();
        if self.changes.send(Change::Barrier(published)).is_ok() {
            let _ = done.await;
        }
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
                self.feeds.open_terminal(&attached.id);
                let _ = self.changes.send(Change::Tabs);
                Ok(Reply::Value(attached_reply(&attached, &client)))
            }
            "terminal/attach" => {
                let params: TerminalAttachParams = decode(&req.params)?;
                let resume_from = resume_of(params.resume_from)?;
                // A tab that is not running answers `null` (Node's `termAttach`), never an error.
                let Some(attached) = self.tabs.attach(params.tab_id.as_str()).await else {
                    return Ok(Reply::Value(Value::Null));
                };
                Ok(Reply::Subscribe(Subscribe {
                    result: attached_reply(&attached, &client),
                    feed: self.feeds.feed(&attached.id, true),
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
                self.published().await;
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
                self.published().await;
                drop(held);
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
                    self.tabs.resize(size.tab_id.as_str(), u32::from(size.cols), u32::from(size.rows), &client);
                }
            }
            _ => {}
        }
        Admit::Accepted
    }
}
