//! Node's result cache (`cache.mjs`): payloads keyed by `namespace:sha256`, expiry plus
//! entry-count and byte caps, persisted as `cache.local.json`. Locks are held only for map edits.

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;
use std::time::Instant;

use mixdog_rt::InLane;
use mixdog_rt::LaneToken;
use mixdog_rt::MaintenanceIo;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;
use tokio_util::sync::CancellationToken;
use sha2::Digest;
use sha2::Sha256;

const MAX_ENTRIES: usize = 500;
const MAX_BYTES: usize = 8 * 1024 * 1024;

/// Node `buildCacheKey`: `namespace:` + the SHA-256 of `JSON.stringify(payload)`.
pub fn node_cache_key(namespace: &str, payload: &Value) -> String {
    let digest = Sha256::digest(mixdog_js::json_stringify(payload).as_bytes());
    let hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    format!("{namespace}:{hex}")
}

#[cfg(test)]
/// Node `approxEntryBytes` without the key: the `JSON.stringify` length (UTF-16 units) of the
/// entry Node stores, `{ cachedAt, expiresAt, payload }`.
pub fn node_entry_size(payload: &Value, ttl: Duration) -> usize {
    let cached_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |since| u64::try_from(since.as_millis()).unwrap_or(0));
    let expires_at = cached_at + u64::try_from(ttl.as_millis()).unwrap_or(0);
    let entry = json!({ "cachedAt": cached_at, "expiresAt": expires_at, "payload": payload });
    mixdog_js::utf16_len(&mixdog_js::json_stringify(&entry))
}

const FLUSH_DELAY: Duration = Duration::from_secs(5);
const WARN_INTERVAL: Duration = Duration::from_secs(60);

/// Where the cache persists: Node's `cache.local.json`, read and written as a state file on
/// the maintenance lane.
#[derive(Clone, Debug)]
pub struct CacheFile {
    pub path: PathBuf,
    pub lane: MaintenanceIo,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |since| u64::try_from(since.as_millis()).unwrap_or(0))
}

/// Node `approxEntryBytes`: the key's length plus the entry's `JSON.stringify` length.
fn approx_entry_bytes(key: &str, entry: &Value) -> i64 {
    let units = mixdog_js::utf16_len(key) + mixdog_js::utf16_len(&mixdog_js::json_stringify(entry));
    i64::try_from(units).unwrap_or(i64::MAX)
}

#[derive(Default)]
struct State {
    /// `{ key: { cachedAt, expiresAt, payload } }` in Node's insertion order.
    entries: Map<String, Value>,
    /// Node's `__approxBytes`: a running total that is persisted with the entries.
    approx_bytes: Option<i64>,
}

impl State {
    fn total(&mut self) -> i64 {
        if let Some(total) = self.approx_bytes {
            return total;
        }
        let total = self.entries.iter().map(|(key, entry)| approx_entry_bytes(key, entry)).sum();
        self.approx_bytes = Some(total);
        total
    }

    fn remove(&mut self, key: &str) {
        if let Some(entry) = self.entries.shift_remove(key)
            && let Some(total) = &mut self.approx_bytes
        {
            *total -= approx_entry_bytes(key, &entry);
        }
    }

    /// The first entry with the oldest `cachedAt` goes (a missing one counts as 0).
    fn evict_oldest(&mut self) -> bool {
        let mut oldest: Option<(String, f64)> = None;
        for (key, entry) in &self.entries {
            let at = entry.get("cachedAt").and_then(Value::as_f64).unwrap_or(0.0);
            if oldest.as_ref().is_none_or(|(_, best)| at < *best) {
                oldest = Some((key.clone(), at));
            }
        }
        match oldest {
            Some((key, _)) => {
                self.remove(&key);
                true
            }
            None => false,
        }
    }

    /// Evicts oldest entries until under both the count and byte caps.
    fn enforce_bounds(&mut self) {
        while self.entries.len() > MAX_ENTRIES {
            if !self.evict_oldest() {
                break;
            }
        }
        while self.total() > i64::try_from(MAX_BYTES).unwrap_or(i64::MAX) && !self.entries.is_empty() {
            if !self.evict_oldest() {
                break;
            }
        }
    }

    fn prune_expired(&mut self, now: u64) -> bool {
        let expired: Vec<String> = self
            .entries
            .iter()
            .filter(|(_, entry)| entry_expired(entry, now))
            .map(|(key, _)| key.clone())
            .collect();
        for key in &expired {
            self.remove(key);
        }
        !expired.is_empty()
    }
}

/// `entry.expiresAt && entry.expiresAt <= now`.
fn entry_expired(entry: &Value, now: u64) -> bool {
    entry
        .get("expiresAt")
        .and_then(Value::as_f64)
        .is_some_and(|at| at != 0.0 && at <= now as f64)
}

#[derive(Default)]
struct Writer {
    dirty: bool,
    timer_armed: bool,
    last_warn: Option<Instant>,
}

/// Node's `cache.mjs` state: one map of payloads shared by search and fetch, loaded from
/// `cache.local.json` on first use, bounded by entry count and size, and written back on a 5 s
/// debounce (and when told to flush).
pub struct NodeCache {
    file: Option<CacheFile>,
    state: Mutex<State>,
    loaded: tokio::sync::OnceCell<()>,
    writer: Mutex<Writer>,
}

fn locked<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

impl NodeCache {
    pub fn new(file: Option<CacheFile>) -> Self {
        Self {
            file,
            state: Mutex::new(State::default()),
            loaded: tokio::sync::OnceCell::new(),
            writer: Mutex::new(Writer::default()),
        }
    }

    /// `loadCacheState`: read once, then drop what expired and enforce the bounds. A file that
    /// cannot be read leaves the cache empty (Node's tool call would fail instead).
    async fn load(self: &Arc<Self>) {
        self.loaded
            .get_or_init(|| async {
                let stored = match &self.file {
                    Some(file) => {
                        let path = file.path.clone();
                        on_lane(file.lane, move |lane| {
                            mixdog_statefile::read_json(lane, &path, None, &mixdog_statefile::Opts::default())
                        })
                        .await
                        .and_then(|read| read)
                        .ok()
                        .flatten()
                    }
                    None => None,
                };
                let mut state = State::default();
                if let Some(Value::Object(mut doc)) = stored {
                    if let Some(Value::Object(entries)) = doc.shift_remove("entries") {
                        state.entries = entries;
                    }
                    state.approx_bytes = doc.get("__approxBytes").and_then(Value::as_f64).map(|n| n as i64);
                }
                let pruned = state.prune_expired(now_ms());
                state.total();
                state.enforce_bounds();
                *locked(&self.state) = state;
                if pruned {
                    self.schedule();
                }
            })
            .await;
    }

    /// `getCachedEntry`: the live payload; an expired entry is dropped.
    pub async fn get(self: &Arc<Self>, key: &str) -> Option<Value> {
        self.load().await;
        let expired;
        let payload = {
            let mut state = locked(&self.state);
            let entry = state.entries.get(key)?;
            expired = entry_expired(entry, now_ms());
            let payload = entry.get("payload").cloned();
            if expired {
                state.remove(key);
            }
            payload
        };
        if expired {
            self.schedule();
            return None;
        }
        payload
    }

    /// `setCachedEntry`. `size_gap` is what the entry weighs in Node beyond what `payload`
    /// weighs here (a lone surrogate that a Rust string cannot hold).
    pub async fn put(self: &Arc<Self>, key: String, payload: Value, ttl: Duration, size_gap: usize) {
        self.load().await;
        let cached_at = now_ms();
        let expires_at = cached_at + u64::try_from(ttl.as_millis()).unwrap_or(0);
        let entry = json!({ "cachedAt": cached_at, "expiresAt": expires_at, "payload": payload });
        {
            let mut state = locked(&self.state);
            state.remove(&key);
            let weight = approx_entry_bytes(&key, &entry) + i64::try_from(size_gap).unwrap_or(0);
            state.entries.insert(key, entry);
            if let Some(total) = &mut state.approx_bytes {
                *total += weight;
            }
            state.enforce_bounds();
        }
        self.schedule();
    }

    /// Marks the state dirty and arms the flush timer unless one is running.
    fn schedule(self: &Arc<Self>) {
        let mut writer = locked(&self.writer);
        writer.dirty = true;
        if self.file.is_none() || writer.timer_armed {
            return;
        }
        writer.timer_armed = true;
        self.arm(FLUSH_DELAY);
    }

    fn arm(self: &Arc<Self>, delay: Duration) {
        let cache = self.clone();
        tokio::spawn(async move {
            mixdog_rt::time::sleep(delay).await;
            locked(&cache.writer).timer_armed = false;
            cache.flush().await;
        });
    }

    /// Writes the state when it changed since the last write. A failed write keeps it dirty and
    /// tries again after twice the delay.
    pub async fn flush(self: &Arc<Self>) {
        let Some(file) = &self.file else { return };
        let doc = {
            let mut writer = locked(&self.writer);
            if !writer.dirty {
                return;
            }
            writer.dirty = false;
            let state = locked(&self.state);
            let mut doc = Map::new();
            doc.insert("entries".into(), Value::Object(state.entries.clone()));
            if let Some(total) = state.approx_bytes {
                doc.insert("__approxBytes".into(), json!(total));
            }
            Value::Object(doc)
        };
        let path = file.path.clone();
        let opts = mixdog_statefile::Opts { lock: true, fsync_dir: true, ..mixdog_statefile::Opts::default() };
        let written = on_lane(file.lane, move |lane| {
            mixdog_statefile::write_json(lane, &path, &doc, &opts).map(|_| ()).map_err(|error| error.to_string())
        })
        .await;
        let Err(failure) = written.map_err(|error| error.to_string()).and_then(|inner| inner) else {
            return;
        };
        let rearm = {
            let mut writer = locked(&self.writer);
            writer.dirty = true;
            let now = Instant::now();
            if writer.last_warn.is_none_or(|at| now.duration_since(at) > WARN_INTERVAL) {
                writer.last_warn = Some(now);
                mixdog_rt::node_stderr!("[web-search-cache] flush delayed: {failure}");
            }
            !std::mem::replace(&mut writer.timer_armed, true)
        };
        if rearm {
            self.arm(FLUSH_DELAY * 2);
        }
    }
}

async fn on_lane<T: Send + 'static>(
    lane: MaintenanceIo,
    work: impl FnOnce(&InLane<MaintenanceIo>) -> T + Send + 'static,
) -> Result<T, std::io::Error> {
    let job = lane
        .submit_wait(&CancellationToken::new(), work)
        .await
        .map_err(|error| std::io::Error::other(format!("lane job was not queued: {error:?}")))?;
    job.await.map_err(|_| std::io::Error::other("lane job was dropped"))
}
