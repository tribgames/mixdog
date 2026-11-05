//! `terminal/*`: the terminal tab layer ([`TerminalTabs`]) behind its wire methods. A tab's output
//! is the scoped feed `process:<tabId>`; the sections `terminalActivity` and `terminalTabs` follow
//! the tabs' own change callbacks, in order, through one worker.

use std::collections::BTreeMap;
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
use crate::terminal::EnsureRequest;
use crate::terminal::SizeOwner;
use crate::terminal::SizeOwnerChange;
use crate::terminal::TerminalConfig;
use crate::terminal::TerminalError;
use crate::terminal::TerminalEvents;
use crate::terminal::TerminalTabs;

pub struct TerminalServiceConfig {
    /// Mixdog's own directory for shell startup files (see [`TerminalConfig`]).
    pub shell_integration_dir: Option<PathBuf>,
}

/// A change of tab state, queued by the tabs (under their lock) for the section worker.
enum Change {
    Activity(String, Option<ActivityState>),
    Tabs,
}

struct Events {
    changes: mpsc::UnboundedSender<Change>,
}

impl TerminalEvents for Events {
    fn activity(&self, id: &str, state: Option<ActivityState>) {
        let _ = self.changes.send(Change::Activity(id.to_owned(), state));
    }

    fn size_owner(&self, _change: &SizeOwnerChange) {
        let _ = self.changes.send(Change::Tabs);
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

/// Applies queued changes to the sections, in order, and publishes what changed.
async fn publish_sections(
    mut changes: mpsc::UnboundedReceiver<Change>,
    tabs: Arc<TerminalTabs>,
    publisher: Arc<dyn StatePublisher>,
) {
    let mut activity: BTreeMap<String, &'static str> = BTreeMap::new();
    while let Some(first) = changes.recv().await {
        let (mut activity_changed, mut tabs_changed) = (false, false);
        let mut apply = |change: Change| match change {
            Change::Activity(id, Some(state)) => {
                activity_changed |= activity.insert(id, state.as_str()) != Some(state.as_str());
            }
            Change::Activity(id, None) => activity_changed |= activity.remove(&id).is_some(),
            Change::Tabs => tabs_changed = true,
        };
        apply(first);
        while let Ok(more) = changes.try_recv() {
            apply(more);
        }
        if activity_changed {
            publisher.publish(SectionName::TerminalActivity, None, section_bytes(&json!(activity)));
        }
        if tabs_changed {
            let list: Vec<Value> = tabs
                .list_tabs()
                .iter()
                .map(|tab| {
                    json!({
                        "id": tab.id,
                        "shell": tab.shell,
                        "running": tab.running,
                        "cwd": tab.cwd,
                        "sizeOwner": tab.size_owner.as_ref().map(owner_json),
                    })
                })
                .collect();
            publisher.publish(SectionName::TerminalTabs, None, section_bytes(&Value::Array(list)));
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

    /// A connection closed: its focus and size ownership on every tab end.
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

#[async_trait]
impl DomainService for TerminalService {
    async fn call(&self, req: CoreRequest) -> Result<Reply, CoreError> {
        let client = client_of(&req);
        match req.method.as_str() {
            "terminal/ensure" => {
                let params: TerminalEnsureParams = decode(&req.params)?;
                let options = &params.options;
                let profile = match options.get("profile").and_then(Value::as_str) {
                    Some(id) => self.tabs.resolve_profile(id).await,
                    None => None,
                };
                let request = EnsureRequest {
                    cwd: options.get("cwd").and_then(Value::as_str).map(str::to_owned),
                    profile,
                    cols: options.get("cols").and_then(Value::as_u64).map(|n| n as u32),
                    rows: options.get("rows").and_then(Value::as_u64).map(|n| n as u32),
                };
                let attached = self
                    .tabs
                    .ensure(Some(params.tab_id.as_str()), request)
                    .await
                    .map_err(terminal_failure)?;
                let _ = self.changes.send(Change::Tabs);
                Ok(Reply::Value(json!({
                    "id": attached.id,
                    "replay": attached.replay,
                    "sizeOwner": client_owner(attached.size_owner.as_ref(), &client),
                })))
            }
            "terminal/attach" => {
                let params: TerminalAttachParams = decode(&req.params)?;
                let resume_from = resume_of(params.resume_from)?;
                let attached = self
                    .tabs
                    .attach(params.tab_id.as_str())
                    .await
                    .ok_or_else(|| domain_error("terminal", "NOT_RUNNING"))?;
                Ok(Reply::Subscribe(Subscribe {
                    result: json!({
                        "id": attached.id,
                        "hasReplay": !attached.replay.is_empty(),
                        "sizeOwner": client_owner(attached.size_owner.as_ref(), &client),
                    }),
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
                self.tabs.focus(params.tab_id.as_str(), &client, true);
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
                self.tabs.dispose(params.tab_id.as_str());
                self.feeds.close(params.tab_id.as_str());
                let _ = self.changes.send(Change::Tabs);
                Ok(Reply::Value(json!({})))
            }
            other => Err(invalid_params("method", format!("a method of terminal, not {other}"))),
        }
    }

    fn notify(&self, method: Method, params: Value, from: ConnectionId) -> Admit {
        // Keystrokes and sizes of a tab that is gone are ignored, as the tabs do themselves.
        match method.as_str() {
            "terminal/input" => {
                if let Ok(input) = serde_json::from_value::<TerminalInputParams>(params) {
                    self.tabs.write(input.tab_id.as_str(), &input.data);
                }
            }
            "terminal/resize" => {
                if let Ok(size) = serde_json::from_value::<TerminalResizeParams>(params) {
                    self.tabs.resize(
                        size.tab_id.as_str(),
                        u32::from(size.cols),
                        u32::from(size.rows),
                        &connection_key(from),
                    );
                }
            }
            _ => {}
        }
        Admit::Accepted
    }
}
