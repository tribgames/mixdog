//! The usage readings of one cache file (`gateway-oauth-usage-cache.json`): the one owner in the process of what is
//! served, of what a measurement may publish, and of what the file is still owed.
//!
//! Serve: the owner reads the file once, before its first operation, and from then on every lookup selects from its
//! state; a miss reads nothing. Mutate: a put, a negative, a provider invalidation and a stamped retirement change
//! that state, and that change is their point of effect. Persist: each change adds to the edits the file is owed, in
//! the order the state changed; a write applies all outstanding edits to the current file under its lock and
//! acknowledges them only when that write succeeded.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::MutexGuard;
use std::sync::PoisonError;
use std::sync::Weak;

use futures::FutureExt;
use futures::future::BoxFuture;
use futures::future::Shared;
use serde_json::Value;

use super::CREDENTIAL_STAMP;
use super::DISK_CACHE_TTL_MS;
use super::LIVE_CACHE_TTL_MS;
use super::NEGATIVE_CACHE_TTL_MS;
use super::Obj;
use super::STALE_DISK_CACHE_TTL_MS;
use super::fresh;
use super::newest_provider_snapshot;
use super::now_ms;
use super::read_json_file;
use super::update_json_atomic;
use crate::oauth::CredentialIo;

pub(super) type Measuring = Shared<BoxFuture<'static, Option<Value>>>;

/// A cached reading. `live` is one this process measured; one read from the file at start is served for display only,
/// never taken for a current measurement.
struct Entry {
    reading: Value,
    live: bool,
}

/// What a measurement holds from its start: the cache epoch of its provider and of its slot then. A retirement moves
/// the epoch on, and what the measurement brings back is then neither published nor served.
#[derive(Clone)]
pub(super) struct Ticket {
    id: u64,
    provider: String,
    slot: String,
    epoch: (u64, u64),
}

struct Flight {
    ticket: Ticket,
    measuring: Measuring,
}

/// An edit the cache file is owed.
#[derive(Clone)]
enum FileEdit {
    Put { key: String, reading: Value },
    /// Every reading of a provider: its slots and their models.
    EraseProvider(String),
    /// The readings of one slot (its bare key and its models) that one sign-in measured.
    EraseStamped { slot: String, stamp: String },
}

#[derive(Default)]
struct State {
    entries: HashMap<String, Entry>,
    /// Memory only: when a slot or route last measured nothing.
    negatives: HashMap<String, i64>,
    provider_epochs: HashMap<String, u64>,
    slot_epochs: HashMap<String, u64>,
    flights: HashMap<String, Flight>,
    tickets: u64,
    /// The edits the file has not acknowledged, oldest first, each with the position the state change gave it.
    owed: Vec<(u64, FileEdit)>,
    position: u64,
    acknowledged: u64,
    /// Whether the file's routes were taken in.
    seeded: bool,
    /// The erases made before that: the file's image is older than each of them, and is taken in without what they
    /// removed.
    early: Vec<FileEdit>,
}

fn of_provider(key: &str, provider: &str) -> bool {
    key.strip_prefix(provider).is_some_and(|rest| rest.is_empty() || rest.starts_with('\u{1}') || rest.starts_with('\u{2}'))
}

fn of_slot(key: &str, slot: &str) -> bool {
    key.strip_prefix(slot).is_some_and(|rest| rest.is_empty() || rest.starts_with('\u{1}'))
}

fn stamped(reading: &Value, stamp: &str) -> bool {
    reading.get(CREDENTIAL_STAMP).and_then(Value::as_str) == Some(stamp)
}

/// The provider of a slot key (`provider`, or `provider\u{2}account`).
fn provider_of(slot: &str) -> &str {
    slot.split('\u{2}').next().unwrap_or(slot)
}

impl FileEdit {
    fn apply(&self, routes: &mut Obj) {
        match self {
            Self::Put { key, reading } => {
                routes.insert(key.clone(), reading.clone());
            }
            Self::EraseProvider(provider) => routes.retain(|key, _| !of_provider(key, provider)),
            Self::EraseStamped { slot, stamp } => routes.retain(|key, reading| !(of_slot(key, slot) && stamped(reading, stamp))),
        }
    }

    /// Whether this later edit makes the owed `earlier` one pointless: the file ends the same without it.
    fn supersedes(&self, earlier: &Self) -> bool {
        match (self, earlier) {
            (Self::Put { key, .. }, Self::Put { key: old, .. }) => key == old,
            (Self::EraseProvider(provider), Self::Put { key, .. }) => of_provider(key, provider),
            (Self::EraseProvider(provider), Self::EraseProvider(old)) => provider == old,
            (Self::EraseProvider(provider), Self::EraseStamped { slot, .. }) => provider_of(slot) == provider,
            (Self::EraseStamped { slot, stamp }, Self::Put { key, reading }) => of_slot(key, slot) && stamped(reading, stamp),
            (Self::EraseStamped { slot, stamp }, Self::EraseStamped { slot: old, stamp: old_stamp }) => slot == old && stamp == old_stamp,
            _ => false,
        }
    }
}

impl State {
    fn epoch(&self, provider: &str, slot: &str) -> (u64, u64) {
        (self.provider_epochs.get(provider).copied().unwrap_or(0), self.slot_epochs.get(slot).copied().unwrap_or(0))
    }

    fn current(&self, ticket: &Ticket) -> bool {
        self.epoch(&ticket.provider, &ticket.slot) == ticket.epoch
    }

    fn owe(&mut self, edit: FileEdit) {
        if !self.seeded && !matches!(edit, FileEdit::Put { .. }) {
            self.early.push(edit.clone());
        }
        self.owed.retain(|(_, earlier)| !edit.supersedes(earlier));
        self.position += 1;
        self.owed.push((self.position, edit));
    }

    fn live(&self, key: &str) -> Option<&Value> {
        self.entries.get(key).filter(|entry| entry.live).map(|entry| &entry.reading)
    }

    /// The live reading a measurement of this route would be: the route's own, else its slot's.
    fn measured(&self, key: &str, slot: &str, now: i64) -> Option<Value> {
        fresh(self.live(key), LIVE_CACHE_TTL_MS, now).or_else(|| fresh(self.live(slot), LIVE_CACHE_TTL_MS, now))
    }
}

/// Test seams: a point inside the file's read at start and inside each write, before the file lock.
#[cfg(test)]
#[derive(Default)]
pub(super) struct Seams {
    /// Run in the read at start, after the file's bytes were read.
    pub(super) after_seed_read: Option<Arc<dyn Fn() + Send + Sync>>,
    /// Run in each write before the file lock; an error is the write's.
    pub(super) before_write: Option<Arc<dyn Fn() -> std::io::Result<()> + Send + Sync>>,
}

pub(super) struct UsageCache {
    path: PathBuf,
    io: CredentialIo,
    log: Arc<dyn Fn(&str) + Send + Sync>,
    state: Mutex<State>,
    seeded: tokio::sync::OnceCell<()>,
    /// Whether the save of put readings is running; changed only under the state's lock.
    saving: tokio::sync::watch::Sender<bool>,
    #[cfg(test)]
    pub(super) seams: Mutex<Seams>,
}

impl UsageCache {
    /// The owner of the cache file at `path`: one per path in the process, shared by every service over it.
    pub(super) fn for_path(path: PathBuf, io: CredentialIo, log: Arc<dyn Fn(&str) + Send + Sync>) -> Arc<Self> {
        static OWNERS: std::sync::LazyLock<Mutex<HashMap<PathBuf, Weak<UsageCache>>>> = std::sync::LazyLock::new(Mutex::default);
        let mut owners = OWNERS.lock().unwrap_or_else(PoisonError::into_inner);
        owners.retain(|_, owner| owner.strong_count() > 0);
        if let Some(owner) = owners.get(&path).and_then(Weak::upgrade) {
            return owner;
        }
        let owner = Arc::new(Self {
            path: path.clone(),
            io,
            log,
            state: Mutex::default(),
            seeded: tokio::sync::OnceCell::new(),
            saving: tokio::sync::watch::Sender::new(false),
            #[cfg(test)]
            seams: Mutex::default(),
        });
        owners.insert(path, Arc::downgrade(&owner));
        owner
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The file's routes become the warm-start readings, once. Every lookup and measurement passes here first; an
    /// erase does not wait for it, so the image is taken in as it would stand after the erases made meanwhile, and
    /// never over a reading put meanwhile.
    async fn ready(&self) {
        self.seeded
            .get_or_init(|| async {
                let path = self.path.clone();
                #[cfg(test)]
                let seam = self.seams.lock().unwrap_or_else(PoisonError::into_inner).after_seed_read.clone();
                let read = self
                    .io
                    .read_job(move |_| {
                        let file = read_json_file(&path);
                        #[cfg(test)]
                        if let Some(seam) = seam {
                            seam();
                        }
                        Ok(file)
                    })
                    .await;
                let mut routes = read.ok().flatten().and_then(|file| file.get("routes").and_then(Value::as_object).cloned()).unwrap_or_default();
                let mut state = self.state();
                for edit in std::mem::take(&mut state.early) {
                    edit.apply(&mut routes);
                }
                state.seeded = true;
                for (key, reading) in routes {
                    state.entries.entry(key).or_insert(Entry { reading, live: false });
                }
            })
            .await;
    }

    // serve

    /// The reading a measurement of this route made within the live window, if one is cached.
    pub(super) async fn measured(&self, key: &str, slot: &str) -> Option<Value> {
        self.ready().await;
        self.state().measured(key, slot, now_ms())
    }

    /// Whether the route or its slot measured nothing a short while ago.
    pub(super) async fn measured_nothing(&self, key: &str, slot: &str) -> bool {
        self.ready().await;
        let (state, now) = (self.state(), now_ms());
        [key, slot].iter().any(|key| state.negatives.get(*key).is_some_and(|at| now - at < NEGATIVE_CACHE_TTL_MS))
    }

    /// The reading to display for a route (`readCachedOAuthUsageSnapshot`): a live one of the route, its slot or the
    /// slot's newest model, else any cached one of those within the display window (the longer one with `allow_stale`).
    pub(super) async fn displayed(&self, key: &str, slot: &str, allow_stale: bool) -> Option<Value> {
        self.ready().await;
        let (state, now) = (self.state(), now_ms());
        let live = state.entries.iter().filter(|(_, entry)| entry.live).map(|(key, entry)| (key, &entry.reading));
        let any = |key: &str| state.entries.get(key).map(|entry| &entry.reading);
        let ttl = if allow_stale { STALE_DISK_CACHE_TTL_MS } else { DISK_CACHE_TTL_MS };
        state
            .measured(key, slot, now)
            .or_else(|| newest_provider_snapshot(live, slot, LIVE_CACHE_TTL_MS, now))
            .or_else(|| fresh(any(key), ttl, now))
            .or_else(|| fresh(any(slot), ttl, now))
            .or_else(|| newest_provider_snapshot(state.entries.iter().map(|(key, entry)| (key, &entry.reading)), slot, ttl, now))
    }

    // measurements

    /// The measurement of a route in flight for the current epoch, or the one `start` begins with a ticket for it.
    pub(super) async fn measuring(&self, key: &str, slot: &str, start: impl FnOnce(Ticket) -> BoxFuture<'static, Option<Value>>) -> (Ticket, Measuring) {
        self.ready().await;
        let mut state = self.state();
        if let Some(flight) = state.flights.get(key) {
            return (flight.ticket.clone(), flight.measuring.clone());
        }
        state.tickets += 1;
        let provider = provider_of(slot).to_owned();
        let ticket = Ticket { id: state.tickets, epoch: state.epoch(&provider, slot), provider, slot: slot.to_owned() };
        let measuring = start(ticket.clone()).shared();
        state.flights.insert(key.to_owned(), Flight { ticket: ticket.clone(), measuring: measuring.clone() });
        (ticket, measuring)
    }

    /// A measurement ended: its flight is unlinked, unless the route's flight is by now another one.
    pub(super) fn ended(&self, key: &str, ticket: &Ticket) {
        let mut state = self.state();
        if state.flights.get(key).is_some_and(|flight| flight.ticket.id == ticket.id) {
            state.flights.remove(key);
        }
    }

    /// What a caller that awaited the measurement of `ticket` is given: its answer while the ticket is current, else
    /// whatever reading is live for the route now (none, or a later measurement's).
    pub(super) fn resolved(&self, ticket: &Ticket, answer: Option<Value>, key: &str) -> Option<Value> {
        let state = self.state();
        if state.current(ticket) { answer } else { state.measured(key, &ticket.slot, now_ms()) }
    }

    // mutate

    /// Whether no retirement has overtaken the measurement of `ticket`.
    pub(super) fn current(&self, ticket: &Ticket) -> bool {
        self.state().current(ticket)
    }

    /// Installs a measured reading: all its views (`updates`: the slot's bare key and the model-qualified one) at once.
    /// False when the ticket is no longer current: nothing is installed. The installed reading is the measurement's
    /// end; the file's save goes on by itself ([`Self::save`]).
    pub(super) fn put(self: &Arc<Self>, ticket: &Ticket, updates: Vec<(String, Value)>) -> bool {
        let start = {
            let mut state = self.state();
            if !state.current(ticket) {
                return false;
            }
            for (key, reading) in updates {
                state.negatives.remove(&key);
                state.entries.insert(key.clone(), Entry { reading: reading.clone(), live: true });
                state.owe(FileEdit::Put { key, reading });
            }
            // Decided under the state's lock, as the save's end is: a reading owed after a save's last look starts one.
            self.saving.send_if_modified(|saving| !std::mem::replace(saving, true))
        };
        if start {
            self.save();
        }
        true
    }

    /// The save of put readings, as a task of its own and one at a time for the owner: it writes until nothing was
    /// put during its last write. Best effort: a refused or failed write is said and stays owed.
    fn save(self: &Arc<Self>) {
        /// Ends a save that did not reach its own end, which is decided under the state's lock.
        struct Saving {
            owner: Arc<UsageCache>,
            ended: bool,
        }
        impl Drop for Saving {
            fn drop(&mut self) {
                if !self.ended {
                    self.owner.saving.send_replace(false);
                }
            }
        }
        let mut saving = Saving { owner: Arc::clone(self), ended: false };
        tokio::spawn(async move {
            loop {
                let owner = &saving.owner;
                let seen = owner.state().position;
                if let Err(error) = owner.persist(false).await {
                    (owner.log)(&format!("Usage cache could not be saved: {error}"));
                }
                let done = {
                    let state = owner.state();
                    let done = state.position == seen;
                    if done {
                        owner.saving.send_replace(false);
                    }
                    done
                };
                if done {
                    saving.ended = true;
                    break;
                }
            }
        });
    }

    /// Returns once no save of put readings is running.
    #[cfg(test)]
    pub(super) async fn saved(&self) {
        let _ = self.saving.subscribe().wait_for(|saving| !*saving).await;
    }

    /// Notes that the measurement of `ticket` found nothing, for `keys`; not when the ticket is no longer current. A
    /// reading cached under one of them is no longer a current measurement: it stays for display only.
    pub(super) fn put_negative(&self, ticket: &Ticket, keys: &[&str]) {
        let mut state = self.state();
        if state.current(ticket) {
            let now = now_ms();
            for key in keys {
                if let Some(entry) = state.entries.get_mut(*key) {
                    entry.live = false;
                }
                state.negatives.insert((*key).to_owned(), now);
            }
        }
    }

    /// Removes every reading of `provider`, all its slots and models, and detaches its measurements in flight. The
    /// state change is the effect; the returned task erases them from the file.
    pub(super) fn invalidate_provider(self: &Arc<Self>, provider: &str) -> tokio::task::JoinHandle<()> {
        {
            let mut state = self.state();
            state.entries.retain(|key, _| !of_provider(key, provider));
            state.negatives.retain(|key, _| !of_provider(key, provider));
            *state.provider_epochs.entry(provider.to_owned()).or_default() += 1;
            state.flights.retain(|_, flight| flight.ticket.provider != provider);
            state.owe(FileEdit::EraseProvider(provider.to_owned()));
        }
        self.erasing()
    }

    /// For the measurement of `ticket`, which found that the sign-in `stamp` has no usage: removes the readings of its
    /// slot that sign-in measured, and detaches the slot's measurements in flight. Other slots, other sign-ins'
    /// readings and unstamped ones stay. None when the ticket is no longer current: nothing is removed or detached.
    pub(super) fn retire_stamped(self: &Arc<Self>, ticket: &Ticket, stamp: &str) -> Option<tokio::task::JoinHandle<()>> {
        {
            let mut state = self.state();
            if !state.current(ticket) {
                return None;
            }
            let slot = ticket.slot.as_str();
            state.entries.retain(|key, entry| !(of_slot(key, slot) && stamped(&entry.reading, stamp)));
            *state.slot_epochs.entry(slot.to_owned()).or_default() += 1;
            state.flights.retain(|_, flight| flight.ticket.slot != slot);
            state.owe(FileEdit::EraseStamped { slot: slot.to_owned(), stamp: stamp.to_owned() });
        }
        Some(self.erasing())
    }

    // persist

    /// The write an erase is owed, as a task of its own: it waits for the lane where it must, and whoever asked for
    /// the erase is not held by it.
    fn erasing(self: &Arc<Self>) -> tokio::task::JoinHandle<()> {
        let owner = Arc::clone(self);
        tokio::spawn(async move {
            if let Err(error) = owner.persist(true).await {
                (owner.log)(&format!("Usage cache could not be cleared: {error}"));
            }
        })
    }

    /// One write of the file: a lane job that, under the file's lock, applies every edit owed at that moment to the
    /// file as it is then, and acknowledges them once the write succeeded. The job owns the write: it ends the same
    /// whether or not its requester still waits. `wait`: a full lane is waited out instead of refusing the job.
    async fn persist(self: &Arc<Self>, wait: bool) -> std::io::Result<()> {
        let owner = Arc::clone(self);
        let job = move |lane: &mixdog_rt::InLane<mixdog_rt::DurabilityIo>| owner.write(lane);
        if wait { self.io.write_required(job).await } else { self.io.write_job(job).await }
    }

    fn write(&self, lane: &mixdog_rt::InLane<mixdog_rt::DurabilityIo>) -> std::io::Result<()> {
        #[cfg(test)]
        {
            let seam = self.seams.lock().unwrap_or_else(PoisonError::into_inner).before_write.clone();
            if let Some(seam) = seam {
                seam()?;
            }
        }
        if self.state().owed.is_empty() {
            return Ok(());
        }
        let mut written = 0;
        update_json_atomic(lane, &self.path, |current| {
            let mut routes = current.as_ref().and_then(|c| c.get("routes")).and_then(Value::as_object).cloned().unwrap_or_default();
            // Taken under the file's lock: whichever write holds it next sees every edit owed by then, in order.
            let (owed, position) = {
                let state = self.state();
                (state.owed.clone(), state.position)
            };
            written = position;
            for (_, edit) in &owed {
                edit.apply(&mut routes);
            }
            let mut doc = Obj::new();
            doc.insert("version".into(), Value::from(1));
            doc.insert("updatedAt".into(), Value::from(now_ms()));
            doc.insert("routes".into(), Value::Object(routes));
            Value::Object(doc)
        })?;
        let mut state = self.state();
        state.owed.retain(|(position, _)| *position > written);
        state.acknowledged = state.acknowledged.max(written);
        Ok(())
    }

    /// How far the file has acknowledged the state's changes, and how far the state has changed.
    #[cfg(test)]
    pub(super) fn positions(&self) -> (u64, u64) {
        let state = self.state();
        (state.acknowledged, state.position)
    }

}
