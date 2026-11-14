//! What the windows know of the connections, as the `connections` scoped feed (`connections/subscribe`). It replaces what the
//! desktop's main process forwarded to a window: `forwardConnectionLink` (the link state and the Ports panel of the window's
//! server) and `hostListsChanged` (the saved servers, for ssh). The keys, in the feed's section updates:
//!
//! - `hosts`: the saved servers (`SshHost[]`, `open` while the server has a link);
//! - `restore`: `{enabled, progress}`, the "reopen server windows" setting and the reopenings still running or failed;
//! - `link/<connectionId>`: the [`ConnectionLinkView`] of a server's link;
//! - `ports/<connectionId>`: the [`ServerPortsView`] of its Ports panel.
//!
//! A subscriber of one connection gets that connection's two keys only (the feed of [`ConnectionsFeed::source`] for it), which is
//! what keeps a server window from seeing another server. A key's value is published when it changes; a key that goes away (its
//! link ended) is published as removed. The snapshot of a feed is `{sections: [..]}` of every key it carries.
//!
//! The link of a server comes and goes in the pool without a message the feed could hear (its attach is announced before the pool
//! lists the link, its close not at all): whoever opens or closes a link calls [`ConnectionsFeed::reconcile`] afterwards. A link
//! that attaches again (the pool replaced it) is followed from that attach.

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use mixdog_app_protocol::v2::connections::{
    ConnectionLinkState, ConnectionLinkView, ServerPortsView, ServerRestoreProgress, SshHost, SshHostSettings, SshModelLogin,
};
use mixdog_core_api::FeedSource;
use mixdog_core_api::ScopedFeeds;
use mixdog_core_api::feed_publisher::FeedPublisher;
use mixdog_protocol::FeedId;
use mixdog_rt::TaskClass;
use serde_json::{Value, json};
use tokio::sync::{broadcast, watch};
use tokio::task::AbortHandle;
use tokio_util::sync::{CancellationToken, DropGuard};

use crate::host_store::{ModelLogin as StoredModelLogin, SshHostRecord, SshHostStore};
use crate::link::{LinkPool, ServerLink};
use crate::link_machine::{LinkState, LinkViewState, ModelLogin};
use crate::restore::Restore;
use crate::window_restore_store::WindowRestoreStore;

const FEED_ID: &str = "connections";
const SECTION: &str = "connections";
const UPDATED: &str = "connections/updated";
const HOSTS_KEY: &str = "hosts";
const RESTORE_KEY: &str = "restore";

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// What the feed reads of one server link: the two watches whose values are published.
pub trait FeedLink: Send + Sync {
    fn link_view(&self) -> watch::Receiver<LinkViewState>;
    fn ports_view(&self) -> watch::Receiver<ServerPortsView>;
}

impl FeedLink for ServerLink {
    fn link_view(&self) -> watch::Receiver<LinkViewState> {
        self.view()
    }

    fn ports_view(&self) -> watch::Receiver<ServerPortsView> {
        self.ports().view()
    }
}

/// The links the feed follows.
pub trait FeedLinks: Send + Sync {
    fn get(&self, id: &str) -> Option<Arc<dyn FeedLink>>;
    fn ids(&self) -> Vec<String>;
    /// The ids of links that attached (the first time, or again).
    fn on_attach(&self) -> broadcast::Receiver<String>;
}

impl FeedLinks for LinkPool {
    fn get(&self, id: &str) -> Option<Arc<dyn FeedLink>> {
        LinkPool::get(self, id).map(|link| link as Arc<dyn FeedLink>)
    }

    fn ids(&self) -> Vec<String> {
        self.list().iter().map(|link| link.id().to_owned()).collect()
    }

    fn on_attach(&self) -> broadcast::Receiver<String> {
        LinkPool::on_attach(self)
    }
}

/// The view of a saved server: the record, and whether its window is open (it has a link).
pub fn ssh_host_view(record: &SshHostRecord, open: bool) -> SshHost {
    SshHost {
        id: record.id.clone(),
        name: record.name.clone(),
        target: record.target.clone(),
        last_connected_at: record.last_connected_at.as_ref().and_then(|at| at.as_i64().or_else(|| at.as_f64().map(|ms| ms as i64))),
        open,
        settings: record.settings.as_ref().map(|saved| SshHostSettings {
            model_login: saved.model_login.map(|login| match login {
                StoredModelLogin::Server => SshModelLogin::Server,
            }),
            remote_cwd: saved.remote_cwd.clone(),
            identity_file: saved.identity_file.clone(),
            auto_reconnect: saved.auto_reconnect,
            allowed_providers: saved.allowed_providers.clone(),
            grace_minutes: saved.grace_minutes,
        }),
    }
}

/// What a server window shows of its link.
pub fn connection_link_view(view: &LinkViewState) -> ConnectionLinkView {
    let state = match &view.state {
        LinkState::Connected => ConnectionLinkState::Connected,
        LinkState::Reconnecting { attempt, next_retry_at_ms, .. } => {
            ConnectionLinkState::Reconnecting { attempt: *attempt, next_retry_at: next_retry_at_ms.map(|at| at as i64) }
        }
        LinkState::Lost { terminal, code, message, settings_required } => ConnectionLinkState::Lost {
            terminal: *terminal,
            code: code.clone(),
            message: message.clone(),
            settings_required: settings_required.then_some(true),
        },
        LinkState::Paused => ConnectionLinkState::Paused,
    };
    ConnectionLinkView {
        connection_id: view.connection_id.clone(),
        state,
        rtt_ms: view.rtt_ms.map(|ms| u32::try_from(ms).unwrap_or(u32::MAX)),
        terminals_available: view.terminals_available,
        model_login: match view.model_login {
            ModelLogin::Pc => SshModelLogin::Pc,
            ModelLogin::Server => SshModelLogin::Server,
        },
    }
}

fn link_key(id: &str) -> String {
    format!("link/{id}")
}

fn ports_key(id: &str) -> String {
    format!("ports/{id}")
}

/// One key as it is now: its revision (counted per key) and value.
struct Entry {
    revision: u64,
    value: Value,
}

/// The snapshot state of a feed: the section update of each of its keys.
fn snapshot<'a>(entries: impl Iterator<Item = (&'a String, &'a Entry)>) -> Value {
    let sections: Vec<Value> = entries
        .map(|(key, entry)| json!({ "section": SECTION, "key": key, "revision": entry.revision, "value": entry.value }))
        .collect();
    json!({ "sections": sections })
}

struct State {
    entries: BTreeMap<String, Entry>,
    /// The next revision of each key ever published: it keeps counting through a removal.
    revisions: HashMap<String, u64>,
    all: FeedPublisher,
    /// The feeds of the subscribers limited to one connection, made when the first asks.
    scoped: HashMap<String, FeedPublisher>,
}

/// The connection a key belongs to: `link/<id>` and `ports/<id>` belong to `<id>`; `hosts` and `restore` to none.
fn owner(key: &str) -> Option<&str> {
    key.strip_prefix("link/").or_else(|| key.strip_prefix("ports/"))
}

impl State {
    fn scoped_entries(&self, id: &str) -> impl Iterator<Item = (&String, &Entry)> {
        let keys = [link_key(id), ports_key(id)];
        self.entries.iter().filter(move |(key, _)| keys.contains(key))
    }

    /// Sets the key's value (`None` removes it) and tells the feeds that carry it; a value that did not change says nothing.
    fn publish(&mut self, key: &str, value: Option<Value>) {
        if self.entries.get(key).map(|entry| &entry.value) == value.as_ref() {
            return;
        }
        let revision = self.revisions.entry(key.to_owned()).or_insert(0);
        *revision += 1;
        let revision = *revision;
        let params = match &value {
            Some(value) => json!({ "section": SECTION, "key": key, "revision": revision, "value": value }),
            None => json!({ "section": SECTION, "key": key, "revision": revision, "removed": true }),
        };
        match value {
            Some(value) => {
                self.entries.insert(key.to_owned(), Entry { revision, value });
            }
            None => {
                self.entries.remove(key);
            }
        }
        self.all.publish(UPDATED, params.clone(), snapshot(self.entries.iter()));
        if let Some(id) = owner(key) {
            if let Some(feed) = self.scoped.get(id) {
                feed.publish(UPDATED, params, snapshot(self.scoped_entries(id)));
            }
        }
    }
}

struct Inner {
    feeds: Arc<dyn ScopedFeeds>,
    links: Arc<dyn FeedLinks>,
    hosts: Arc<SshHostStore>,
    restore_store: Arc<WindowRestoreStore>,
    progress: watch::Receiver<Vec<ServerRestoreProgress>>,
    state: Mutex<State>,
    /// The task that follows each link.
    follows: Mutex<HashMap<String, AbortHandle>>,
    stop: CancellationToken,
}

impl Inner {
    fn publish(&self, key: &str, value: Option<Value>) {
        locked(&self.state).publish(key, value);
    }

    fn publish_hosts(&self) {
        let hosts: Vec<SshHost> =
            self.hosts.list().iter().map(|record| ssh_host_view(record, self.links.get(&record.id).is_some())).collect();
        self.publish(HOSTS_KEY, serde_json::to_value(hosts).ok());
    }

    async fn publish_restore(&self) {
        let progress = self.progress.borrow().clone();
        match self.restore_store.enabled().await {
            Ok(enabled) => self.publish(RESTORE_KEY, Some(json!({ "enabled": enabled, "progress": progress }))),
            Err(error) => tracing::warn!("[connections] the reopen setting could not be read: {error}"),
        }
    }

    /// Follows the link `id` has now (replacing the follow of an earlier one); nothing when it has none.
    fn follow(self: &Arc<Self>, id: &str) {
        let Some(link) = self.links.get(id) else { return };
        let (mut view, mut ports) = (link.link_view(), link.ports_view());
        drop(link);
        let (inner, key_id) = (self.clone(), id.to_owned());
        let task = mixdog_rt::spawn("connections-feed-link", TaskClass::Control, async move {
            loop {
                let link_value = serde_json::to_value(connection_link_view(&view.borrow_and_update())).ok();
                let ports_value = serde_json::to_value(&*ports.borrow_and_update()).ok();
                {
                    let mut state = locked(&inner.state);
                    state.publish(&link_key(&key_id), link_value);
                    state.publish(&ports_key(&key_id), ports_value);
                }
                inner.publish_hosts();
                tokio::select! {
                    () = inner.stop.cancelled() => return,
                    changed = view.changed() => if changed.is_err() { break },
                    changed = ports.changed() => if changed.is_err() { break },
                }
            }
            // The link itself is gone (not replaced): the next reconcile removes what it published.
        });
        let replaced = locked(&self.follows).insert(id.to_owned(), task.abort_handle());
        if let Some(old) = replaced {
            old.abort();
        }
    }

    /// Follows every link the pool lists and stops following the ones it no longer lists.
    fn reconcile(self: &Arc<Self>) {
        let ids = self.links.ids();
        let gone: Vec<String> = locked(&self.follows).keys().filter(|id| !ids.contains(id)).cloned().collect();
        for id in gone {
            if let Some(task) = locked(&self.follows).remove(&id) {
                task.abort();
            }
            let mut state = locked(&self.state);
            state.publish(&link_key(&id), None);
            state.publish(&ports_key(&id), None);
        }
        for id in ids {
            if !locked(&self.follows).contains_key(&id) {
                self.follow(&id);
            }
        }
        self.publish_hosts();
    }
}

/// The `connections` feed and the tasks that keep it current.
pub struct ConnectionsFeed {
    inner: Arc<Inner>,
    /// Ends the tasks when the feed is dropped.
    _stop: DropGuard,
}

impl ConnectionsFeed {
    /// Starts the feed over the saved servers, the reopen setting and its progress, and the links of `links`; the links that exist
    /// now are followed at once.
    pub fn start(
        feeds: Arc<dyn ScopedFeeds>,
        links: Arc<dyn FeedLinks>,
        hosts: Arc<SshHostStore>,
        restore_store: Arc<WindowRestoreStore>,
        restore: &Restore,
    ) -> Self {
        let stop = CancellationToken::new();
        let all = FeedPublisher::create(feeds.as_ref(), FeedId(FEED_ID.to_owned()), json!({ "sections": [] }));
        let state = State { entries: BTreeMap::new(), revisions: HashMap::new(), all, scoped: HashMap::new() };
        let inner = Arc::new(Inner {
            feeds,
            links,
            hosts,
            restore_store,
            progress: restore.progress(),
            state: Mutex::new(state),
            follows: Mutex::new(HashMap::new()),
            stop: stop.clone(),
        });
        inner.publish_hosts();
        inner.reconcile();
        spawn_hosts(inner.clone());
        spawn_attach(inner.clone());
        spawn_restore(inner.clone());
        Self { inner, _stop: stop.drop_guard() }
    }

    /// The feed a `connections/subscribe` is attached to: `None` carries every key, a connection id only that connection's.
    pub fn source(&self, connection_id: Option<&str>) -> Arc<dyn FeedSource> {
        let mut state = locked(&self.inner.state);
        let Some(id) = connection_id else { return state.all.source() };
        if !state.scoped.contains_key(id) {
            let initial = snapshot(state.scoped_entries(id));
            let feed = FeedPublisher::create(self.inner.feeds.as_ref(), FeedId(FEED_ID.to_owned()), initial);
            state.scoped.insert(id.to_owned(), feed);
        }
        state.scoped[id].source()
    }

    /// A link was opened or closed in the pool: follows the new ones, drops the ended ones (their keys are published as removed)
    /// and republishes the saved servers' `open`.
    pub fn reconcile(&self) {
        self.inner.reconcile();
    }

    /// The "reopen server windows" setting changed: its key is read again.
    pub async fn refresh_restore(&self) {
        self.inner.publish_restore().await;
    }
}

fn spawn_hosts(inner: Arc<Inner>) {
    let mut hosts = inner.hosts.subscribe();
    drop(mixdog_rt::spawn("connections-feed-hosts", TaskClass::Control, async move {
        loop {
            tokio::select! {
                () = inner.stop.cancelled() => return,
                changed = hosts.changed() => if changed.is_err() { return },
            }
            inner.publish_hosts();
        }
    }));
}

fn spawn_attach(inner: Arc<Inner>) {
    let mut attached = inner.links.on_attach();
    drop(mixdog_rt::spawn("connections-feed-attach", TaskClass::Control, async move {
        loop {
            let id = tokio::select! {
                () = inner.stop.cancelled() => return,
                id = attached.recv() => id,
            };
            match id {
                // The pool lists a link a moment after its first attach: that one is seen by `reconcile`.
                Ok(id) => inner.follow(&id),
                Err(broadcast::error::RecvError::Lagged(_)) => inner.reconcile(),
                Err(broadcast::error::RecvError::Closed) => return,
            }
        }
    }));
}

/// Publishes the reopen key at the start and after each change of the reopenings (each also reconciles the links: a reopening
/// that opened its link has put it in the pool by then).
fn spawn_restore(inner: Arc<Inner>) {
    let mut progress = inner.progress.clone();
    drop(mixdog_rt::spawn("connections-feed-restore", TaskClass::Control, async move {
        loop {
            progress.mark_unchanged();
            inner.publish_restore().await;
            inner.reconcile();
            tokio::select! {
                () = inner.stop.cancelled() => return,
                changed = progress.changed() => if changed.is_err() { return },
            }
        }
    }));
}

#[cfg(test)]
#[path = "restore_view_policy_tests.rs"]
mod restore_view_policy_tests;
