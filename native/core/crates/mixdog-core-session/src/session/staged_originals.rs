//! Originals staged ahead of a message (`runtime/attachments/staged-originals.mjs`
//! `stageOriginalAttachment`): a composer that resized an image for the model hands the file as
//! picked over first, and the message that follows claims it. Until claimed, a staged original
//! belongs to no message, so the unclaimed ones are bounded: a two-hour retention and a 256 MiB
//! quota with oldest-first eviction. The index (`prompt-attachments/staged-originals.json`) is
//! shared by every process on the data dir, so a stage is one transaction under the file lock
//! `staged-originals.lock`, reconciled against the disk inside it. An entry is recorded before
//! its blob is published.
//!
//! A message that names staged originals claims them (`claimStagedOriginals`): those still
//! stored leave the staged set, so no eviction or expiry can take them. The claim tries the lock
//! once and never waits. The daemon, the only writer, also expires staged originals on their own
//! deadline ([`StagedOriginals::start_prune`]): one timer at the earliest entry's expiry, re-armed
//! by every write of the index, so an abandoned original does not wait for the next stage.

use std::collections::HashSet;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::PoisonError;
use std::time::Duration;

use mixdog_core_base::support::on_lane;
use mixdog_rt::CancellationToken;
use mixdog_rt::DurabilityIo;
use mixdog_rt::InLane;
use mixdog_rt::TaskClass;
use mixdog_statefile::LockOpts;
use mixdog_statefile::Opts;
use mixdog_statefile::WriteLane;
use mixdog_store::blobs::BlobError;
use mixdog_store::blobs::BlobStore;
use serde_json::Value;
use serde_json::json;
use sha2::Digest as _;
use sha2::Sha256;

pub const STAGED_ORIGINALS_MAX_BYTES: u64 = 256 * 1024 * 1024;
pub const STAGED_ORIGINALS_TTL_MS: i64 = 2 * 60 * 60 * 1000;
const LOCK_TIMEOUT: Duration = Duration::from_millis(3_000);
const LOCK_STALE: Duration = Duration::from_millis(5_000);

/// What a stage is bounded by (`stageOriginalAttachment`'s options).
#[derive(Clone, Copy, Debug)]
pub struct StageLimits {
    pub now_ms: i64,
    pub max_bytes: u64,
    pub ttl_ms: i64,
}


/// The sentence Node's thrown error carries.
pub type StageError = String;

fn is_ref(text: &str) -> bool {
    text.len() == 64 && text.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn ref_of_entry(entry: &Value) -> String {
    entry.get("ref").map(mixdog_js::value_to_string).unwrap_or_default()
}

fn size_of(entry: &Value) -> f64 {
    mixdog_js::to_number_of(entry.get("size"))
}

fn at_of(entry: &Value) -> f64 {
    mixdog_js::to_number_of(entry.get("at"))
}

fn ref_of(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

/// The deadline timer's state (`pruneStarted`, `armGeneration` and the armed expiry).
#[derive(Default)]
struct Deadline {
    started: bool,
    /// Bumped by every arm. Arms from index writes run inside the lock, so they come in write
    /// order; the startup read runs outside it and must not replace an arm made from a newer
    /// index while it was reading.
    generation: u64,
    /// The earliest staged entry's time, `None` while nothing is staged.
    earliest_at: Option<f64>,
}

pub struct StagedOriginals {
    data_dir: PathBuf,
    blobs: BlobStore,
    deadline: Mutex<Deadline>,
    rearmed: tokio::sync::Notify,
    /// Counts the prune task's first arming and each pass it finishes, for the tests to wait on.
    #[cfg(any(test, feature = "test-support"))]
    passes: tokio::sync::watch::Sender<u64>,
}

impl StagedOriginals {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            data_dir: data_dir.to_owned(),
            blobs: BlobStore::new(data_dir), deadline: Mutex::default(),
            rearmed: tokio::sync::Notify::new(),
            #[cfg(any(test, feature = "test-support"))]
            passes: tokio::sync::watch::channel(0).0,
        }
    }

    #[cfg(any(test, feature = "test-support"))]
    #[cfg_attr(not(test), allow(dead_code, reason = "used by this crate's unit tests; compiled for test-support so the hooks around it behave as in a test build"))]
    pub(super) fn passes(&self) -> tokio::sync::watch::Receiver<u64> {
        self.passes.subscribe()
    }

    #[cfg(any(test, feature = "test-support"))]
    #[cfg_attr(not(test), allow(dead_code, reason = "used by this crate's unit tests; compiled for test-support so the hooks around it behave as in a test build"))]
    pub(super) fn earliest_at(&self) -> Option<f64> {
        self.deadline().earliest_at
    }

    fn deadline(&self) -> std::sync::MutexGuard<'_, Deadline> {
        self.deadline.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// `armPruneDeadline`: the timer follows the entries just written. Only a started daemon arms.
    fn arm(&self, entries: &[Value]) {
        let mut deadline = self.deadline();
        if deadline.started {
            Self::arm_locked(&mut deadline, entries);
            self.rearmed.notify_one();
        }
    }

    // An entry with no readable time never expires (see `pruned`), so it sets no deadline.
    fn arm_locked(deadline: &mut Deadline, entries: &[Value]) {
        deadline.generation += 1;
        deadline.earliest_at = entries.iter().map(at_of).filter(|at| at.is_finite()).reduce(f64::min);
    }

    fn root(&self) -> PathBuf {
        self.data_dir.join("prompt-attachments")
    }

    fn blob_path(&self, reference: &str) -> PathBuf {
        self.blobs.root().join(&reference[..2]).join(reference)
    }

    /// `readIndex`: the entries as stored (an entry keeps whatever else it carries) that name a
    /// ref and a positive size; an unreadable index reads as empty.
    fn read_index(&self) -> Vec<Value> {
        let Ok(Some(text)) = mixdog_statefile::read_content(&self.root().join("staged-originals.json")) else { return Vec::new() };
        let Ok(Value::Array(items)) = mixdog_statefile::parse_json_text(&text) else { return Vec::new() };
        items.into_iter().filter(|item| item.get("ref").is_some_and(|r| is_ref(&mixdog_js::value_to_string(r))) && size_of(item) > 0.0).collect()
    }

    fn write_index<L: WriteLane>(&self, lane: &InLane<L>, entries: &[Value]) -> Result<(), StageError> {
        let value = Value::Array(entries.to_vec());
        mixdog_statefile::write_json(lane, &self.root().join("staged-originals.json"), &value, &Opts::default())
            .map(drop)
            .map_err(|error| error.to_string())?;
        self.arm(entries);
        Ok(())
    }
    /// `removeAttachmentBlob`: the blob and the named copies beside it.
    fn remove_blob<L: WriteLane>(&self, lane: &InLane<L>, reference: &str) -> Result<(), StageError> {
        let _ = mixdog_statefile::remove_file(lane, &self.blob_path(reference));
        match mixdog_statefile::remove_dir_all(lane, &self.root().join("files").join(reference)) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error.to_string()),
            _ => Ok(()),
        }
    }

    /// `pruned`: an entry whose blob is gone is dropped, an expired one is deleted with its blob;
    /// `keep` is never expired.
    fn pruned<L: WriteLane>(&self, lane: &InLane<L>, entries: Vec<Value>, now: i64, ttl: i64, keep: &str) -> Result<Vec<Value>, StageError> {
        let mut kept = Vec::new();
        for entry in entries {
            if mixdog_statefile::metadata(lane, &self.blob_path(&ref_of_entry(&entry))).is_err() {
                continue;
            }
            if ref_of_entry(&entry) != keep && now as f64 - at_of(&entry) > ttl as f64 {
                self.remove_blob(lane, &ref_of_entry(&entry))?;
            } else {
                kept.push(entry);
            }
        }
        Ok(kept)
    }

    /// `stageOriginalAttachment`: the staged original's attachment ref. Fails when the bytes are
    /// empty, alone over the quota, or the lock cannot be had in time. Runs in a write-lane job.
    pub fn stage<L: WriteLane>(&self, lane: &InLane<L>, bytes: &[u8], limits: StageLimits) -> Result<String, StageError> {
        if bytes.is_empty() {
            return Err("staged original is empty".into());
        }
        if bytes.len() as u64 > limits.max_bytes {
            return Err("staged original exceeds the staging quota".into());
        }
        let reference = ref_of(bytes);
        let root = self.root();
        mixdog_statefile::create_private_dir_all(lane, &root).map_err(|e| e.to_string())?;
        let opts = LockOpts { timeout: Some(LOCK_TIMEOUT), stale: Some(LOCK_STALE), strict_owner: false };
        mixdog_statefile::with_lock(lane, &root.join("staged-originals"), &opts, || -> Result<String, StageError> {
            let index = self.read_index();
            let tracked = index.iter().any(|e| ref_of_entry(e) == reference);
            let mut entries = self.pruned(lane, index, limits.now_ms, limits.ttl_ms, &reference)?;
            let was_tracked = tracked && entries.iter().any(|e| ref_of_entry(e) == reference);
            // Bytes already stored for a message (or an earlier attach) are theirs, not staged
            // by this call: never tracked here, so never evicted here.
            if mixdog_statefile::metadata(lane, &self.blob_path(&reference)).is_ok() && !was_tracked {
                self.write_index(lane, &entries)?;
                return Ok(reference.clone());
            }
            entries.retain(|e| ref_of_entry(e) != reference);
            let mut total: f64 = entries.iter().map(size_of).sum();
            while total + bytes.len() as f64 > limits.max_bytes as f64 && !entries.is_empty() {
                let oldest = entries.remove(0);
                total -= size_of(&oldest);
                self.remove_blob(lane, &ref_of_entry(&oldest))?;
            }
            // Intent first: the entry is durable before the blob exists.
            entries.push(json!({ "ref": reference, "size": bytes.len(), "at": limits.now_ms }));
            self.write_index(lane, &entries)?;
            if let Err(error) = self.blobs.put(lane, bytes) {
                entries.retain(|e| ref_of_entry(e) != reference);
                self.write_index(lane, &entries)?;
                return Err(match error {
                    BlobError::ItemTooLarge { .. } => "prompt attachment exceeds the 64 MiB input limit".to_owned(),
                    other => other.to_string(),
                });
            }
            Ok(reference.clone())
        })
        .map_err(|error| error.to_string())?
    }

    /// `claimStagedOriginals`: a message is about to name these originals. Those still stored
    /// leave the staged set and are returned; a ref already evicted is not (the message then keeps
    /// only the resized copy). The lock is tried once, never waited for (a stale one is still
    /// reclaimed by that attempt); when someone holds it, or anything fails, nothing is claimed.
    pub fn claim<L: WriteLane>(&self, lane: &InLane<L>, refs: &[String]) -> HashSet<String> {
        let mut wanted: Vec<&String> = Vec::new();
        for reference in refs.iter().filter(|r| is_ref(r)) {
            if !wanted.contains(&reference) {
                wanted.push(reference);
            }
        }
        if wanted.is_empty() {
            return HashSet::new();
        }
        let root = self.root();
        let opts = LockOpts { timeout: Some(Duration::ZERO), stale: Some(LOCK_STALE), strict_owner: false };
        let claimed = mixdog_statefile::create_private_dir_all(lane, &root).map_err(|e| e.to_string()).and_then(|()| {
            mixdog_statefile::with_lock(lane, &root.join("staged-originals"), &opts, || -> Result<HashSet<String>, StageError> {
                let entries = self.read_index();
                let claimed: HashSet<String> =
                    wanted.iter().filter(|r| mixdog_statefile::metadata(lane, &self.blob_path(r)).is_ok()).map(|r| (*r).clone()).collect();
                let rest: Vec<Value> = entries.iter().filter(|e| !claimed.contains(&ref_of_entry(e))).cloned().collect();
                if rest.len() != entries.len() {
                    self.write_index(lane, &rest)?;
                }
                Ok(claimed)
            })
            .map_err(|error| error.to_string())?
        });
        claimed.unwrap_or_default()
    }

    /// `pruneStagedOriginals`: reconcile the staged set now (expiry, entries without a blob), as
    /// every stage does. Returns the entries kept.
    pub fn prune<L: WriteLane>(&self, lane: &InLane<L>, now_ms: i64, ttl_ms: i64) -> Result<Vec<Value>, StageError> {
        let root = self.root();
        mixdog_statefile::create_private_dir_all(lane, &root).map_err(|e| e.to_string())?;
        let opts = LockOpts { timeout: Some(LOCK_TIMEOUT), stale: Some(LOCK_STALE), strict_owner: false };
        mixdog_statefile::with_lock(lane, &root.join("staged-originals"), &opts, || -> Result<Vec<Value>, StageError> {
            let entries = self.pruned(lane, self.read_index(), now_ms, ttl_ms, "")?;
            self.write_index(lane, &entries)?;
            Ok(entries)
        })
        .map_err(|error| error.to_string())?
    }

    /// `startStagedOriginalsPrune`: expire staged originals on their own deadline, for the daemon
    /// (the sole writer). Idempotent. The index is read once to arm the first deadline; each
    /// deadline runs a prune pass on the durability lane, which re-arms from what it kept. A
    /// failed pass (lock contention, disk) leaves the entries for the next stage, claim or daemon
    /// start, each of which prunes and re-arms. Ends with `cancel`.
    pub fn start_prune(self: &Arc<Self>, lane: DurabilityIo, clock: Arc<dyn super::Clock>, cancel: CancellationToken) {
        {
            let mut deadline = self.deadline();
            if deadline.started {
                return;
            }
            deadline.started = true;
        }
        let this = self.clone();
        drop(mixdog_rt::spawn("staged-originals.prune", TaskClass::Work, async move { this.run_prune(lane, clock, cancel).await }));
    }

    async fn run_prune(self: Arc<Self>, lane: DurabilityIo, clock: Arc<dyn super::Clock>, cancel: CancellationToken) {
        let generation = self.deadline().generation;
        let reader = self.clone();
        if let Ok(entries) = on_lane(lane, &cancel, move |_| reader.read_index()).await {
            let mut deadline = self.deadline();
            if deadline.generation == generation {
                Self::arm_locked(&mut deadline, &entries);
            }
        }
        #[cfg(any(test, feature = "test-support"))]
        self.passes.send_modify(|n| *n += 1);
        loop {
            // An entry expires once strictly past the TTL (see `pruned`).
            let wait = self.deadline().earliest_at.map(|at| (at + STAGED_ORIGINALS_TTL_MS as f64 + 1.0 - clock.now_ms() as f64).max(0.0));
            let Some(wait_ms) = wait else {
                tokio::select! {
                    () = cancel.cancelled() => return,
                    () = self.rearmed.notified() => continue,
                }
            };
            tokio::select! {
                () = cancel.cancelled() => return,
                () = self.rearmed.notified() => {}
                () = mixdog_rt::time::sleep(Duration::from_millis(wait_ms as u64)) => {
                    // The timer is spent; the pass re-arms it from the entries it keeps.
                    self.deadline().earliest_at = None;
                    let (pruner, now) = (self.clone(), clock.now_ms());
                    drop(on_lane(lane, &cancel, move |lane| pruner.prune(lane, now, STAGED_ORIGINALS_TTL_MS)).await);
                    #[cfg(any(test, feature = "test-support"))]
                    self.passes.send_modify(|n| *n += 1);
                }
            }
        }
    }
}

/// The refs the originals of a message's pasted images name (`originalRef` of each of
/// `input.options.pastedImages`), in order; an image naming none contributes nothing.
pub fn named_originals(params: &Value) -> Vec<String> {
    pasted_images(params)
        .into_iter()
        .flat_map(|images| images.values())
        .filter_map(|image| image.get("originalRef").and_then(Value::as_str).filter(|r| !r.is_empty()).map(str::to_owned))
        .collect()
}

fn pasted_images(params: &Value) -> Option<&serde_json::Map<String, Value>> {
    params.pointer("/input/options/pastedImages").and_then(Value::as_object)
}

/// A message submitted without an original it named (evicted, or not claimable in time) keeps
/// only the resized copy: the original's ref and media type leave its image.
pub fn drop_lost_originals(params: &mut Value, claimed: &HashSet<String>) {
    let Some(images) = params.pointer_mut("/input/options/pastedImages").and_then(Value::as_object_mut) else { return };
    for image in images.values_mut().filter_map(Value::as_object_mut) {
        let lost = image.get("originalRef").and_then(Value::as_str).is_some_and(|r| !r.is_empty() && !claimed.contains(r));
        if lost {
            image.shift_remove("originalRef");
            image.shift_remove("originalMediaType");
        }
    }
}
