//! The server windows open at the last quit come back at the next launch (a setting of this PC's window): each remembered server
//! that is still saved is connected in the background, in batch mode (a server that now needs a password fails here and is
//! reconnected from Settings -> Connection), and its window is opened through the host once the link is up. The progress of the
//! reopenings still running or failed is a watch the connections feed publishes as its `restore` key; a reopening that is ready
//! leaves the list.
//!
//! The remembered ids live in [`WindowRestoreStore`]; a server removed from the saved list since is skipped and forgotten.

use std::collections::HashSet;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_app_protocol::v2::connections::{ServerRestorePhase, ServerRestoreProgress};
use mixdog_rt::TaskClass;
use mixdog_ssh::command::parse_ssh_target;
use mixdog_ssh::connect_failure::ConnectError;
use mixdog_ssh::context::{AttemptContext, HostSettings, ModelLogin};
use mixdog_ssh::session::{Progress, SessionPhase};
use tokio::sync::watch;

use crate::host_store::{ModelLogin as StoredModelLogin, SshHostRecord, SshHostSettings, SshHostStore};
use crate::link::{LinkPool, LinkSpec};
use crate::paths::StoreError;
use crate::window_restore_store::WindowRestoreStore;

/// What a reopening needs of the link pool.
#[async_trait]
pub trait RestoreLinks: Send + Sync {
    /// Connects the server (bootstrap, tunnel, attach) under `context`, reporting its phases.
    async fn open(&self, spec: LinkSpec, context: AttemptContext, progress: Option<Progress>) -> Result<(), ConnectError>;
}

#[async_trait]
impl RestoreLinks for LinkPool {
    async fn open(&self, spec: LinkSpec, context: AttemptContext, progress: Option<Progress>) -> Result<(), ConnectError> {
        LinkPool::open(self, spec, context, progress).await.map(|_| ())
    }
}

/// The host's windows (`host/window/open`): what a reopening needs once its link is up.
#[async_trait]
pub trait RestoreWindows: Send + Sync {
    /// Opens (or focuses) the window of the server; the error is the text the failed reopening shows.
    async fn open(&self, connection_id: &str, name: &str) -> Result<(), String>;
}

/// The attempt context of a saved server's automatic connect: its saved settings, no askpass (so ssh runs in batch mode).
pub fn attempt_context(record: &SshHostRecord) -> AttemptContext {
    AttemptContext {
        settings: record.settings.as_ref().map(host_settings),
        diagnostics_key: Some(record.id.clone()),
        ..AttemptContext::default()
    }
}

fn host_settings(saved: &SshHostSettings) -> HostSettings {
    HostSettings {
        model_login: saved.model_login.map(|login| match login {
            StoredModelLogin::Server => ModelLogin::Server,
        }),
        remote_cwd: saved.remote_cwd.clone(),
        identity_file: saved.identity_file.clone(),
        auto_reconnect: saved.auto_reconnect,
        allowed_providers: saved.allowed_providers.clone(),
        grace_minutes: saved.grace_minutes,
    }
}

struct Inner {
    store: Arc<WindowRestoreStore>,
    hosts: Arc<SshHostStore>,
    progress: watch::Sender<Vec<ServerRestoreProgress>>,
}

impl Inner {
    /// A ready reopening leaves the list; anything else replaces its row, or is added after the others.
    fn report(&self, record: &SshHostRecord, phase: ServerRestorePhase, message: Option<String>) {
        let row = ServerRestoreProgress { id: record.id.clone(), name: record.name.clone(), phase, message };
        self.progress.send_modify(|list| {
            if phase == ServerRestorePhase::Ready {
                list.retain(|known| known.id != row.id);
            } else if let Some(known) = list.iter_mut().find(|known| known.id == row.id) {
                *known = row;
            } else {
                list.push(row);
            }
        });
    }

    async fn reopen(self: &Arc<Self>, record: &SshHostRecord, links: &dyn RestoreLinks, windows: &dyn RestoreWindows) -> Result<(), String> {
        let target = parse_ssh_target(&record.target).map_err(|error| error.to_string())?;
        let spec = LinkSpec { id: record.id.clone(), name: record.name.clone(), target };
        let (inner, shown) = (self.clone(), record.clone());
        let progress: Progress = Arc::new(move |phase| {
            // The link's own `Ready` is not the reopening's: that is when the window is open too.
            let phase = match phase {
                SessionPhase::Connect => ServerRestorePhase::Connect,
                SessionPhase::Check { .. } => ServerRestorePhase::Check,
                SessionPhase::Install => ServerRestorePhase::Install,
                SessionPhase::Start => ServerRestorePhase::Start,
                SessionPhase::Ready => return,
            };
            inner.report(&shown, phase, None);
        });
        links.open(spec, attempt_context(record), Some(progress)).await.map_err(|error| error.to_string())?;
        windows.open(&record.id, &record.name).await
    }
}

/// The reopening of the remembered server windows.
pub struct Restore {
    inner: Arc<Inner>,
}

impl Restore {
    pub fn new(store: Arc<WindowRestoreStore>, hosts: Arc<SshHostStore>) -> Self {
        let (progress, _) = watch::channel(Vec::new());
        Self { inner: Arc::new(Inner { store, hosts, progress }) }
    }

    /// The reopenings still running or failed, again after every change (for a window that subscribes after they were reported).
    pub fn progress(&self) -> watch::Receiver<Vec<ServerRestoreProgress>> {
        self.inner.progress.subscribe()
    }

    /// Reopens the remembered windows when the setting is on: every saved server is connected at once, and its window is opened
    /// when its link is up. Resolves when every attempt settled; a failed one stays in [`Self::progress`] with its message.
    /// Only a store that cannot be read fails the run.
    pub async fn run(&self, links: Arc<dyn RestoreLinks>, windows: Arc<dyn RestoreWindows>) -> Result<(), StoreError> {
        let inner = &self.inner;
        if !inner.store.enabled().await? {
            return Ok(());
        }
        let open = inner.store.list().await?;
        if open.is_empty() {
            return Ok(());
        }
        let saved = inner.hosts.list();
        let known: HashSet<String> = saved.iter().map(|record| record.id.clone()).collect();
        // A server no longer saved is not reopened, and not remembered either.
        if open.iter().any(|id| !known.contains(id)) {
            inner.store.retain(|id| known.contains(id)).await?;
        }
        let mut attempts = Vec::new();
        for record in open.iter().filter_map(|id| saved.iter().find(|record| &record.id == id)).cloned() {
            let (inner, links, windows) = (inner.clone(), links.clone(), windows.clone());
            attempts.push(mixdog_rt::spawn("server-window-restore", TaskClass::Control, async move {
                inner.report(&record, ServerRestorePhase::Connect, None);
                match inner.reopen(&record, links.as_ref(), windows.as_ref()).await {
                    Ok(()) => inner.report(&record, ServerRestorePhase::Ready, None),
                    Err(message) => inner.report(&record, ServerRestorePhase::Failed, Some(message)),
                }
            }));
        }
        for attempt in attempts {
            // A reopening that panicked reports nothing more: its row stays at the phase it had reached.
            let _ = attempt.await;
        }
        Ok(())
    }
}
