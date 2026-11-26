//! Node's result cache (`cache.mjs`): payloads keyed by `namespace:sha256`, expiry plus
//! entry-count and byte caps, persisted as `cache.local.json`. Locks are held only for map edits.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;
use std::time::Instant;

use mixdog_rt::InLane;
use mixdog_rt::LaneToken;
use mixdog_rt::MaintenanceIo;
use serde_json::Value;
use serde_json::json;
use sha2::Digest;
use sha2::Sha256;
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

const MAX_ENTRIES: usize = 500;
const MAX_BYTES: usize = 8 * 1024 * 1024;
const MAX_MONO_TTL: Duration = Duration::from_secs(86_400 * 365 * 30);

fn monotonic_deadline(now_mono: tokio::time::Instant, duration: Duration) -> tokio::time::Instant {
    now_mono.checked_add(duration.min(MAX_MONO_TTL)).unwrap_or_else(|| now_mono + MAX_MONO_TTL)
}

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
    let cached_at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |since| u64::try_from(since.as_millis()).unwrap_or(0));
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
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |since| u64::try_from(since.as_millis()).unwrap_or(0))
}

/// Node `approxEntryBytes`: the key's length plus the serialized entry's length.
fn approx_entry_bytes(key: &str, json: &str) -> i64 {
    let units = mixdog_js::utf16_len(key) + mixdog_js::utf16_len(json);
    i64::try_from(units).unwrap_or(i64::MAX)
}

/// One cached entry held as compact JSON text (`{ cachedAt, expiresAt, payload }`) rather than a
/// parsed `serde_json::Value` tree; only hits parse it back.
struct CachedEntry {
    seq: u64,
    cached_at: f64,
    expires_at: f64,
    expires_mono: Option<tokio::time::Instant>,
    json: Arc<str>,
    approx_bytes: i64,
}

impl CachedEntry {
    fn from_value(seq: u64, key: &str, entry: &Value, size_gap: usize, expires_mono: Option<tokio::time::Instant>) -> Self {
        let cached_at = entry.get("cachedAt").and_then(Value::as_f64).unwrap_or(0.0);
        let expires_at = entry.get("expiresAt").and_then(Value::as_f64).unwrap_or(0.0);
        let json: Arc<str> = mixdog_js::json_stringify(entry).into();
        let approx_bytes = approx_entry_bytes(key, &json).saturating_add(i64::try_from(size_gap).unwrap_or(0));
        Self { seq, cached_at, expires_at, expires_mono, json, approx_bytes }
    }

    fn from_loaded(seq: u64, key: &str, entry: &Value, now_wall: u64, now_mono: tokio::time::Instant) -> Self {
        let expires_at = entry.get("expiresAt").and_then(Value::as_f64).unwrap_or(0.0);
        let expires_mono = (expires_at.is_finite() && expires_at > 0.0).then(|| {
            let remaining = (expires_at - now_wall as f64).max(0.0);
            let duration = if remaining >= MAX_MONO_TTL.as_millis() as f64 { MAX_MONO_TTL } else { Duration::from_millis(remaining.ceil() as u64) };
            monotonic_deadline(now_mono, duration)
        });
        Self::from_value(seq, key, entry, 0, expires_mono)
    }

    fn is_expired(&self, now_wall: u64, now_mono: tokio::time::Instant) -> bool {
        self.expires_mono.is_some_and(|at| now_mono >= at) || (self.expires_at.is_finite() && self.expires_at != 0.0 && self.expires_at <= now_wall as f64)
    }
}

fn parse_payload(json: &str) -> Option<Value> {
    let mut entry = serde_json::from_str::<Value>(json).ok()?;
    entry.as_object_mut()?.shift_remove("payload")
}

#[derive(Default)]
struct State {
    /// `{ key: { cachedAt, expiresAt, payload } }` indexed for O(1) lookup, with `seq` preserving Node's insertion order.
    entries: HashMap<String, CachedEntry>,
    next_seq: u64,
    /// Node's `__approxBytes`: a running total that is persisted with the entries.
    approx_bytes: Option<i64>,
    expiry_armed: bool,
}

impl State {
    fn next_seq(&mut self) -> u64 {
        let seq = self.next_seq;
        self.next_seq = self.next_seq.wrapping_add(1);
        seq
    }

    fn total(&mut self) -> i64 {
        if let Some(total) = self.approx_bytes {
            return total;
        }
        let total = self.entries.values().map(|entry| entry.approx_bytes).sum();
        self.approx_bytes = Some(total);
        total
    }

    fn remove(&mut self, key: &str) {
        if let Some(entry) = self.entries.remove(key)
            && let Some(total) = &mut self.approx_bytes
        {
            *total -= entry.approx_bytes;
        }
    }

    fn insert(&mut self, key: String, entry: CachedEntry) {
        self.remove(&key);
        let weight = entry.approx_bytes;
        self.entries.insert(key, entry);
        if let Some(total) = &mut self.approx_bytes {
            *total += weight;
        }
    }

    /// The first entry (in insertion order) with the oldest `cachedAt` goes (a missing one counts as 0).
    fn evict_oldest(&mut self) -> bool {
        let mut oldest: Option<(&str, f64, u64)> = None;
        for (key, entry) in &self.entries {
            let better = match oldest {
                None => true,
                Some((_, best_at, best_seq)) => entry.cached_at < best_at || (entry.cached_at == best_at && entry.seq < best_seq),
            };
            if better {
                oldest = Some((key.as_str(), entry.cached_at, entry.seq));
            }
        }
        let Some((key, _, _)) = oldest else { return false };
        let key = key.to_owned();
        self.remove(&key);
        true
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

    fn prune_expired(&mut self, now_wall: u64, now_mono: tokio::time::Instant) -> bool {
        let before = self.entries.len();
        let mut removed_bytes: i64 = 0;
        self.entries.retain(|_, entry| {
            if entry.is_expired(now_wall, now_mono) {
                removed_bytes += entry.approx_bytes;
                false
            } else {
                true
            }
        });
        if self.entries.len() == before {
            return false;
        }
        if let Some(total) = &mut self.approx_bytes {
            *total -= removed_bytes;
        }
        if self.entries.is_empty() {
            self.entries.shrink_to_fit();
        }
        true
    }

    fn next_expiry(&self) -> Option<tokio::time::Instant> {
        self.entries.values().filter_map(|entry| entry.expires_mono).min()
    }
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
    expiry_wake: Arc<Notify>,
    now_ms: Arc<dyn Fn() -> u64 + Send + Sync>,
}

impl Drop for NodeCache {
    fn drop(&mut self) {
        self.expiry_wake.notify_one();
    }
}

fn locked<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

impl NodeCache {
    pub fn new(file: Option<CacheFile>) -> Self {
        Self::with_clock(file, Arc::new(now_ms))
    }

    fn with_clock(file: Option<CacheFile>, now_ms: Arc<dyn Fn() -> u64 + Send + Sync>) -> Self {
        Self {
            file,
            state: Mutex::new(State::default()),
            loaded: tokio::sync::OnceCell::new(),
            writer: Mutex::new(Writer::default()),
            expiry_wake: Arc::new(Notify::new()),
            now_ms,
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
                        on_lane(file.lane, move |lane| mixdog_statefile::read_json(lane, &path, None, &mixdog_statefile::Opts::default()))
                            .await
                            .and_then(|read| read)
                            .ok()
                            .flatten()
                    }
                    None => None,
                };
                let now_wall = (self.now_ms)();
                let now_mono = tokio::time::Instant::now();
                let mut state = State::default();
                if let Some(Value::Object(mut doc)) = stored {
                    if let Some(Value::Object(entries)) = doc.shift_remove("entries") {
                        state.entries.reserve(entries.len());
                        for (key, value) in entries {
                            let seq = state.next_seq();
                            let cached = CachedEntry::from_loaded(seq, &key, &value, now_wall, now_mono);
                            state.entries.insert(key, cached);
                        }
                    }
                    state.approx_bytes = doc.get("__approxBytes").and_then(Value::as_f64).map(|n| n as i64);
                }
                let pruned = state.prune_expired(now_wall, now_mono);
                state.total();
                state.enforce_bounds();
                *locked(&self.state) = state;
                self.arm_expiry();
                if pruned {
                    self.schedule();
                }
            })
            .await;
    }

    /// `getCachedEntry`: the live payload; an expired entry is dropped.
    pub async fn get(self: &Arc<Self>, key: &str) -> Option<Value> {
        self.load().await;
        let now_wall = (self.now_ms)();
        let now_mono = tokio::time::Instant::now();
        let expired;
        let json = {
            let mut state = locked(&self.state);
            let is_exp = state.entries.get(key)?.is_expired(now_wall, now_mono);
            expired = is_exp;
            if is_exp {
                state.remove(key);
                None
            } else {
                state.entries.get(key).map(|entry| Arc::clone(&entry.json))
            }
        };
        if expired {
            self.schedule();
            return None;
        }
        parse_payload(&json?)
    }

    /// `setCachedEntry`. `size_gap` is what the entry weighs in Node beyond what `payload`
    /// weighs here (a lone surrogate that a Rust string cannot hold).
    pub async fn put(self: &Arc<Self>, key: String, payload: Value, ttl: Duration, size_gap: usize) {
        self.load().await;
        let cached_at = (self.now_ms)();
        let now_mono = tokio::time::Instant::now();
        let expires_at = cached_at + u64::try_from(ttl.as_millis()).unwrap_or(0);
        let entry = json!({ "cachedAt": cached_at, "expiresAt": expires_at, "payload": payload });
        let expires_mono = Some(monotonic_deadline(now_mono, ttl));
        {
            let mut state = locked(&self.state);
            let seq = state.next_seq();
            let cached = CachedEntry::from_value(seq, &key, &entry, size_gap, expires_mono);
            state.insert(key, cached);
            state.enforce_bounds();
        }
        self.arm_expiry();
        self.schedule();
    }

    /// Arms a weak-referenced task that evicts entries when their expiry passes instead of
    /// holding them until the next `get` or `put`.
    fn arm_expiry(self: &Arc<Self>) {
        let handle = {
            let mut state = locked(&self.state);
            if state.next_expiry().is_none() {
                return;
            }
            if state.expiry_armed {
                drop(state);
                self.expiry_wake.notify_one();
                return;
            }
            let handle = if self.file.is_some() {
                None
            } else {
                let Ok(handle) = tokio::runtime::Handle::try_current() else { return };
                Some(handle)
            };
            state.expiry_armed = true;
            handle
        };
        let weak = Arc::downgrade(self);
        let wake = Arc::clone(&self.expiry_wake);
        let task = async move {
            loop {
                let Some(cache) = weak.upgrade() else { return };
                let now_wall = (cache.now_ms)();
                let now_mono = tokio::time::Instant::now();
                let (pruned, target) = {
                    let mut state = locked(&cache.state);
                    let pruned = state.prune_expired(now_wall, now_mono);
                    let target = match state.next_expiry() {
                        Some(at) => Some(at),
                        None => {
                            state.expiry_armed = false;
                            None
                        }
                    };
                    (pruned, target)
                };
                if pruned {
                    cache.schedule();
                }
                drop(cache);
                let Some(target) = target else { return };
                tokio::select! {
                    () = mixdog_rt::time::sleep_until(target) => {}
                    () = wake.notified() => {}
                }
            }
        };
        match handle {
            Some(handle) => {
                handle.spawn(task);
            }
            None => {
                mixdog_rt::spawn("web.cache-expiry", mixdog_rt::TaskClass::Work, task);
            }
        }
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
        mixdog_rt::spawn("web.cache-flush", mixdog_rt::TaskClass::Work, async move {
            mixdog_rt::time::sleep(delay).await;
            locked(&cache.writer).timer_armed = false;
            cache.flush().await;
        });
    }

    /// Writes the state when it changed since the last write. A failed write keeps it dirty and
    /// tries again after twice the delay.
    pub async fn flush(self: &Arc<Self>) {
        let Some(file) = &self.file else { return };
        let (mut entries, approx_bytes) = {
            let mut writer = locked(&self.writer);
            if !writer.dirty {
                return;
            }
            writer.dirty = false;
            let state = locked(&self.state);
            let entries: Vec<(u64, String, Arc<str>)> = state.entries.iter().map(|(k, e)| (e.seq, k.clone(), Arc::clone(&e.json))).collect();
            (entries, state.approx_bytes)
        };
        let path = file.path.clone();
        let opts = mixdog_statefile::Opts {
            lock: true,
            fsync_dir: true,
            backup_accepts: Some(mixdog_statefile::is_json_content),
            ..mixdog_statefile::Opts::default()
        };
        let written = on_lane(file.lane, move |lane| {
            entries.sort_unstable_by_key(|(seq, _, _)| *seq);
            let capacity = entries.iter().map(|(_, k, j)| k.len() + j.len() + 8).sum::<usize>() + 64;
            let mut out = String::with_capacity(capacity);
            out.push_str("{\"entries\":{");
            for (idx, (_, key, json)) in entries.iter().enumerate() {
                if idx > 0 {
                    out.push(',');
                }
                let encoded_key = serde_json::to_string(key).map_err(|error| error.to_string())?;
                out.push_str(&encoded_key);
                out.push(':');
                out.push_str(json);
            }
            out.push('}');
            if let Some(total) = approx_bytes {
                out.push_str(",\"__approxBytes\":");
                out.push_str(&total.to_string());
            }
            out.push_str("}\n");
            mixdog_statefile::write_file(lane, &path, out.as_bytes(), &opts).map(|_| ()).map_err(|error| error.to_string())
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

async fn on_lane<T: Send + 'static>(lane: MaintenanceIo, work: impl FnOnce(&InLane<MaintenanceIo>) -> T + Send + 'static) -> Result<T, std::io::Error> {
    let job = lane.submit_wait(&CancellationToken::new(), work).await.map_err(|error| std::io::Error::other(format!("lane job was not queued: {error:?}")))?;
    job.await.map_err(|_| std::io::Error::other("lane job was dropped"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(start_paused = true)]
    async fn expired_entries_are_evicted_on_expiry_and_stored_as_serialized_text() {
        let start = tokio::time::Instant::now();
        let cache = Arc::new(NodeCache::with_clock(None, Arc::new(move || 10_000 + start.elapsed().as_millis() as u64)));
        let payload = json!({ "tool": "web_fetch", "content": "hello world", "nested": { "n": 42 } });
        cache.put("fetch:k1".into(), payload.clone(), Duration::from_millis(30), 0).await;
        {
            let state = locked(&cache.state);
            assert_eq!(state.entries.len(), 1);
            assert!(state.entries.get("fetch:k1").unwrap().json.contains("\"hello world\""));
        }
        assert_eq!(cache.get("fetch:k1").await, Some(payload));

        tokio::task::yield_now().await;
        tokio::time::advance(Duration::from_millis(31)).await;
        for _ in 0..8 {
            tokio::task::yield_now().await;
            if locked(&cache.state).entries.is_empty() {
                break;
            }
        }
        let state = locked(&cache.state);
        assert!(state.entries.is_empty(), "expired entry stayed resident without another access");
        assert_eq!(state.approx_bytes, Some(0));
    }

    #[tokio::test(start_paused = true)]
    async fn monotonic_expiry_survives_frozen_or_backward_wall_clock() {
        let wall = Arc::new(std::sync::atomic::AtomicU64::new(50_000));
        let wall_ref = Arc::clone(&wall);
        let cache = Arc::new(NodeCache::with_clock(None, Arc::new(move || wall_ref.load(std::sync::atomic::Ordering::SeqCst))));
        cache.put("fetch:k1".into(), json!({"v": 1}), Duration::from_millis(30), 0).await;
        // Step wall clock backward before adding a second staggered entry.
        wall.store(40_000, std::sync::atomic::Ordering::SeqCst);
        cache.put("fetch:k2".into(), json!({"v": 2}), Duration::from_millis(80), 0).await;

        tokio::time::advance(Duration::from_millis(30)).await;
        for _ in 0..8 {
            tokio::task::yield_now().await;
            if locked(&cache.state).entries.len() == 1 {
                break;
            }
        }
        assert_eq!(locked(&cache.state).entries.len(), 1);
        assert!(locked(&cache.state).entries.contains_key("fetch:k2"));

        tokio::time::advance(Duration::from_millis(50)).await;
        for _ in 0..8 {
            tokio::task::yield_now().await;
            if locked(&cache.state).entries.is_empty() {
                break;
            }
        }
        let state = locked(&cache.state);
        assert!(state.entries.is_empty(), "second entry must also expire monotonically without premature disarm");
        assert_eq!(state.approx_bytes, Some(0));
    }

    #[tokio::test]
    async fn flush_persists_entries_in_insertion_order_without_reparsing_payloads() {
        let dir = tempfile::tempdir().unwrap();
        let file = CacheFile { path: dir.path().join("cache.local.json"), lane: mixdog_rt::testing::tokens().maintenance_io };
        let cache = Arc::new(NodeCache::new(Some(file.clone())));
        cache.put("ns:\"first\"".into(), json!({"a": 1, "text": "hello \"world\""}), Duration::from_secs(60), 0).await;
        cache.put("ns:second".into(), json!({"b": [1, 2, 3]}), Duration::from_secs(60), 0).await;
        cache.flush().await;

        let raw = std::fs::read_to_string(&file.path).unwrap();
        let doc: Value = serde_json::from_str(&raw).unwrap();
        let keys: Vec<&String> = doc["entries"].as_object().unwrap().keys().collect();
        assert_eq!(keys, vec!["ns:\"first\"", "ns:second"]);
        assert!(doc["__approxBytes"].as_i64().unwrap() > 0);

        let reloaded = Arc::new(NodeCache::new(Some(file)));
        assert_eq!(reloaded.get("ns:\"first\"").await, Some(json!({"a": 1, "text": "hello \"world\""})));
        assert_eq!(reloaded.get("ns:second").await, Some(json!({"b": [1, 2, 3]})));
    }
}
