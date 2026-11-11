//! The change marker of stored secrets (`secretChangeTokens`, `publishSecretChange` in
//! `runtime/shared/config.mjs`): `mixdog-secrets-changed.json` beside the config file maps an
//! account to the token of its last change, so a secret saved or forgotten (here or in another
//! process) is something the services that follow the config can see without reading the secret.
//! A deletion drops the account's entry and sets `#deleted`, which also covers a secret the
//! marker never listed.
//!
//! A change is announced on the one signal the config has, [`Config::changes`]; the tokens are
//! read through [`SecretChanges::tokens`]. [`AnnouncingStore`] is the secret store that announces
//! its own writes, as Node's `saveSecret` and `deleteSecret` do.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;

use async_trait::async_trait;
use mixdog_rt::CancellationToken;
use mixdog_rt::LaneToken;
use mixdog_secrets::SecretError;
use mixdog_secrets::SecretStore;
use serde_json::Value;

use super::Config;
use super::on_lane;
use super::read_file;

pub const MARKER_FILE: &str = "mixdog-secrets-changed.json";
pub const DELETED_KEY: &str = "#deleted";

type Tokens = BTreeMap<String, String>;

/// The string entries of a marker document; anything else in it is not a token.
fn tokens_of(marker: Option<Value>) -> Tokens {
    let Some(Value::Object(entries)) = marker else { return Tokens::new() };
    entries.into_iter().filter_map(|(account, token)| token.as_str().map(|t| (account, t.to_owned()))).collect()
}

/// `withSecretChange`.
fn with_change(marker: &Tokens, account: &str, token: &str, deleted: bool) -> Tokens {
    let mut next = marker.clone();
    if deleted {
        next.remove(account);
        next.insert(DELETED_KEY.to_owned(), token.to_owned());
    } else {
        next.insert(account.to_owned(), token.to_owned());
    }
    next
}

pub struct SecretChanges {
    config: Config,
    path: PathBuf,
    /// What this process has applied of the marker (its own writes and other processes').
    seen: Mutex<Tokens>,
    serial: AtomicU64,
}

impl SecretChanges {
    /// Reads the marker as the baseline: what is in it now is not a change.
    pub async fn open(config: Config) -> Arc<Self> {
        let path = config.shared.path.with_file_name(MARKER_FILE);
        let this = Arc::new(Self { config, path, seen: Mutex::default(), serial: AtomicU64::new(0) });
        let marker = this.read_marker().await;
        *this.seen() = marker;
        this
    }

    /// The marker file's name, which the config watcher listens for beside the config file.
    pub fn marker_name() -> &'static str {
        MARKER_FILE
    }

    fn seen(&self) -> std::sync::MutexGuard<'_, Tokens> {
        self.seen.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// `secretChangeTokens()`: account to the token of its last applied change.
    pub fn tokens(&self) -> Tokens {
        self.seen().clone()
    }

    /// `readSecretsMarker`: a missing or unreadable marker reads as empty.
    async fn read_marker(&self) -> Tokens {
        let path = self.path.clone();
        let doc = on_lane(self.config.lanes.read, move |lane| read_file(lane, &path)).await;
        let Ok(Ok(doc)) = doc else { return Tokens::new() };
        tokens_of(Some(Value::Object(doc)))
    }

    /// `syncSecretsMarker`: applies what another process wrote; announces when anything differs.
    /// Answers whether it did.
    pub async fn sync(&self) -> bool {
        let marker = self.read_marker().await;
        {
            let mut seen = self.seen();
            if *seen == marker {
                return false;
            }
            *seen = marker;
        }
        self.config.announce_change();
        true
    }

    /// `publishSecretChange(account, deleted)`. Never fails: the secret itself is already
    /// stored, and a marker that could not be written only delays what other processes see.
    pub async fn announce(&self, account: &str, deleted: bool) {
        // Other processes' changes are applied first, so recording our own token never absorbs
        // theirs unapplied.
        self.sync().await;
        let token = format!("{}:{}:{}", std::process::id(), now_ms(), self.serial.fetch_add(1, Ordering::Relaxed));
        // `updateJsonAtomic(marker, ...)`: read and write under `<marker>.lock`, the lock every
        // process that writes the marker takes (the desktop's too), so no change is lost to a
        // concurrent writer.
        let path = self.path.clone();
        let (entry, entry_token) = (account.to_owned(), token.clone());
        // `submit_wait`, not `submit`: a full or busy write lane (a worker may sit inside the marker
        // lock another process holds) must make this write wait for room, not refuse it at once, or
        // the announcement would be dropped without ever reaching the lock. It wakes when the lane
        // frees a slot; nothing polls.
        let job = LaneToken::submit_wait(self.config.lanes.write, &CancellationToken::new(), move |lane| {
            mixdog_statefile::update_json(
                lane,
                &path,
                |marker| {
                    let next = with_change(&tokens_of(marker), &entry, &entry_token, deleted);
                    Ok::<_, std::convert::Infallible>(Some(Value::Object(next.into_iter().map(|(k, v)| (k, Value::String(v))).collect())))
                },
                &mixdog_statefile::Opts::default(),
            )
        })
        .await;
        if let Ok(job) = job {
            let _ = job.await;
        }
        // This process already holds the new value, so its own change is recorded as applied.
        let applied = with_change(&self.seen(), account, &token, deleted);
        *self.seen() = applied;
        self.config.announce_change();
    }
}

fn now_ms() -> u128 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis())
}

/// A secret store that announces what it writes (`saveSecretAsync` / `deleteSecretAsync`), so a
/// provider key saved through any holder of this store is a change of the config.
pub struct AnnouncingStore {
    inner: Arc<dyn SecretStore>,
    changes: Arc<SecretChanges>,
}

impl AnnouncingStore {
    pub fn new(inner: Arc<dyn SecretStore>, changes: Arc<SecretChanges>) -> Arc<Self> {
        Arc::new(Self { inner, changes })
    }
}

#[async_trait]
impl SecretStore for AnnouncingStore {
    async fn get(&self, account: &str) -> Result<Option<String>, SecretError> {
        self.inner.get(account).await
    }

    async fn set(&self, account: &str, value: &str) -> Result<(), SecretError> {
        self.inner.set(account, value).await?;
        self.changes.announce(account, false).await;
        Ok(())
    }

    async fn delete(&self, account: &str) -> Result<(), SecretError> {
        self.inner.delete(account).await?;
        self.changes.announce(account, true).await;
        Ok(())
    }

    async fn has(&self, account: &str) -> Result<bool, SecretError> {
        self.inner.has(account).await
    }

    async fn is_fallback(&self, account: &str) -> Result<bool, SecretError> {
        self.inner.is_fallback(account).await
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use mixdog_core_api::mock::MockStatePublisher;
    use mixdog_secrets::MemoryStore;

    use super::*;
    use crate::config::ConfigLanes;

    async fn world() -> (tempfile::TempDir, Config, Arc<SecretChanges>, Arc<AnnouncingStore>) {
        let tokens = mixdog_rt::testing::tokens();
        let lanes = ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
        let dir = tempfile::tempdir().unwrap();
        let (config, _) = Config::open(dir.path().join("mixdog-config.json"), Arc::new(MockStatePublisher::default()), lanes).await.unwrap();
        let changes = SecretChanges::open(config.clone()).await;
        let store = AnnouncingStore::new(Arc::new(MemoryStore::default()), changes.clone());
        (dir, config, changes, store)
    }

    /// A key saved or forgotten through the store moves the account's token and ticks the one
    /// signal; a deletion sets `#deleted`; a failed write announces nothing.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_secret_save_and_delete_are_announced_on_the_config_signal() {
        let (_dir, config, changes, store) = world().await;
        let mut signal = config.changes();
        assert!(changes.tokens().is_empty());

        store.set("agent.openai.apiKey", "k1").await.unwrap();
        assert!(mixdog_rt::time::timeout(Duration::from_secs(5), signal.changed()).await.is_ok());
        let first = changes.tokens()["agent.openai.apiKey"].clone();

        store.set("agent.openai.apiKey", "k2").await.unwrap();
        assert_ne!(changes.tokens()["agent.openai.apiKey"], first, "the same account saved again is a new change");

        store.delete("agent.openai.apiKey").await.unwrap();
        let tokens = changes.tokens();
        assert!(!tokens.contains_key("agent.openai.apiKey"));
        assert!(tokens.contains_key(DELETED_KEY));
        // The next process to start sees the same tokens: the marker is on disk.
        assert_eq!(SecretChanges::open(config.clone()).await.tokens(), tokens);
    }

    /// Another process's write reaches this one through `sync`, once.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_change_another_process_made_is_applied_once() {
        let (_dir, config, changes, _store) = world().await;
        let elsewhere = SecretChanges::open(config.clone()).await;
        elsewhere.announce("agent.demo.apiKey", false).await;
        let mut signal = config.changes();
        signal.borrow_and_update();
        assert!(changes.sync().await, "the foreign token is applied");
        assert!(signal.has_changed().unwrap());
        assert!(!changes.sync().await, "and not announced again");
        assert_eq!(changes.tokens(), elsewhere.tokens());
    }

    /// The marker write waits for the lock another process holds (`<marker>.lock`, the lock
    /// Node's `updateJsonAtomic` takes) and loses nothing once it is released.
    #[tokio::test(flavor = "multi_thread", worker_threads = 3)]
    async fn the_marker_write_waits_for_the_file_lock() {
        let (_dir, config, changes, _store) = world().await;
        let path = changes.path.clone();
        let (release, wait) = std::sync::mpsc::channel::<()>();
        let (held_tx, held) = tokio::sync::oneshot::channel::<()>();
        let holder = tokio::spawn(on_lane(config.lanes.write, move |lane| {
            mixdog_statefile::with_lock(lane, &path, &mixdog_statefile::LockOpts::default(), || {
                let _ = held_tx.send(());
                let _ = wait.recv();
            })
        }));
        held.await.unwrap();
        // Three workers: the test backend runs lane jobs inline, so the holder blocks one worker and the
        // waiting writer another; a third keeps the timer driver running, or the sleep below only ends
        // when the writer's own 2 s lock wait does.
        let writer = {
            let changes = changes.clone();
            tokio::spawn(async move { changes.announce("agent.demo.apiKey", false).await })
        };
        mixdog_rt::time::sleep(Duration::from_millis(300)).await;
        assert!(!writer.is_finished(), "the write went ahead of the held lock");
        release.send(()).unwrap();
        mixdog_rt::time::timeout(Duration::from_secs(10), writer).await.unwrap().unwrap();
        holder.await.unwrap().unwrap().unwrap();
        assert!(changes.tokens().contains_key("agent.demo.apiKey"));
        assert!(SecretChanges::open(config.clone()).await.tokens().contains_key("agent.demo.apiKey"), "and it reached the file");
    }
}