//! The prompt-attachment garbage collection (Node `attachments/store.mjs`
//! `startAttachmentGc` / `runScheduledAttachmentGc`): a mark-and-sweep of the blob store that
//! deletes a blob no stored frame references (`blob_refs`) and no writer pins, once it is older
//! than `min_age`. Run by events, never on a cadence: daemon start and each attachment the
//! intake stores. Each trigger arms one census [`START_DELAY`] later, off the boot path, unless
//! one ran within [`SPACING_MS`] (the stamp survives restarts, as Node's `gc-last-run` file).
//! Node's cross-process claim file has no counterpart: the daemon is the only process that
//! sweeps.

use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::time::Duration;
use std::time::SystemTime;

use mixdog_rt::CancellationToken;
use mixdog_rt::LaneToken;
use mixdog_rt::MaintenanceIo;
use mixdog_store::blobs::BlobStore;
use mixdog_store::schema::bounded::Digest;
use mixdog_store::sqlite::SqliteStore;
use mixdog_store::state::CoreState;

use crate::maintenance::Clock;
use crate::maintenance::ErrorSink;

/// `ATTACHMENT_GC_SPACING_MS`: the least time between two censuses.
pub const SPACING_MS: i64 = 6 * 60 * 60 * 1000;
/// `ATTACHMENT_GC_START_DELAY_MS`.
pub const START_DELAY: Duration = Duration::from_secs(5);
/// `ATTACHMENT_GC_MIN_AGE_MS`' default; the setting is at least a minute.
pub const DEFAULT_MIN_AGE: Duration = Duration::from_secs(7 * 24 * 60 * 60);
const MIN_AGE_FLOOR: Duration = Duration::from_secs(60);
/// The `meta` key of the last finished census (Node's `gc-last-run` stamp).
pub const STAMP_KEY: &str = "job:attachment-gc";

pub struct BlobGc {
    blobs: BlobStore,
    store: SqliteStore,
    state: CoreState,
    lane: MaintenanceIo,
    min_age: Duration,
    armed: AtomicBool,
}

impl BlobGc {
    /// `min_age` is `MIXDOG_ATTACHMENT_GC_MIN_AGE_MS` when set (else [`DEFAULT_MIN_AGE`]),
    /// never under a minute.
    pub fn new(blobs: BlobStore, store: SqliteStore, state: CoreState, lane: MaintenanceIo, min_age: Duration) -> Arc<Self> {
        Arc::new(Self { blobs, store, state, lane, min_age: min_age.max(MIN_AGE_FLOOR), armed: AtomicBool::new(false) })
    }

    /// Time left of the spacing since the last finished census; 0 when none is recorded.
    async fn fresh_for(&self, now_ms: i64) -> Result<i64, String> {
        let stamp = self.state.meta(STAMP_KEY).await.map_err(|e| e.to_string())?;
        let last = stamp.and_then(|text| text.parse::<i64>().ok()).filter(|last| *last > 0);
        Ok(last.map_or(0, |last| (SPACING_MS - (now_ms - last)).max(0)))
    }

    /// One census of the 256 shards; every deleted digest. An error leaves the rest of the
    /// census undone (the stamp is not written, so the next trigger runs it again).
    pub async fn collect(&self, now: SystemTime, cancel: &CancellationToken) -> Result<Vec<Digest>, String> {
        let mut deleted = Vec::new();
        for shard in 0..=u8::MAX {
            let (blobs, store, min_age) = (self.blobs.clone(), self.store.clone(), self.min_age);
            let handle = self
                .lane
                .submit_wait(cancel, move |lane| {
                    blobs.collect_shard(lane, shard, now, min_age, &mut |digest| store.blob_referenced_on_lane(lane, digest))
                })
                .await
                .map_err(|e| format!("{e:?}"))?;
            let found = handle.await.map_err(|e| format!("{e:?}"))?.map_err(|e| e.to_string())?;
            deleted.extend(found);
        }
        Ok(deleted)
    }

    /// The census, unless one finished within the spacing; `None` then. Stamps a finished one.
    pub async fn run_if_due(&self, now_ms: i64, now: SystemTime, cancel: &CancellationToken) -> Result<Option<Vec<Digest>>, String> {
        if self.fresh_for(now_ms).await? > 0 {
            return Ok(None);
        }
        let deleted = self.collect(now, cancel).await?;
        self.state.write(move |tx| tx.put_meta(STAMP_KEY, &now_ms.to_string())).await.map_err(|e| e.to_string())?;
        Ok(Some(deleted))
    }

    /// A trigger (daemon start, an attachment stored): arms one census [`START_DELAY`] from
    /// now unless one is armed or ran within the spacing. `cancel` (the shutdown token) ends the
    /// wait and a census under way, which leaves no stamp so the next start runs it again.
    pub fn schedule(self: &Arc<Self>, clock: Clock, on_error: ErrorSink, cancel: CancellationToken) {
        drop(self.schedule_after(clock, on_error, cancel, || tokio::time::sleep(START_DELAY)));
    }

    /// [`Self::schedule`] over the wait that stands for the start delay, made when the trigger
    /// reaches it: the armed task, `None` when one is armed already.
    pub(crate) fn schedule_after<D, W>(
        self: &Arc<Self>,
        clock: Clock,
        on_error: ErrorSink,
        cancel: CancellationToken,
        delay: D,
    ) -> Option<tokio::task::JoinHandle<()>>
    where
        D: FnOnce() -> W + Send + 'static,
        W: Future<Output = ()> + Send,
    {
        if self.armed.swap(true, Ordering::SeqCst) {
            return None;
        }
        let gc = self.clone();
        Some(mixdog_rt::spawn("blob-gc", mixdog_rt::TaskClass::Work, async move {
            let outcome = async {
                if gc.fresh_for(clock()).await? > 0 {
                    return Ok(());
                }
                tokio::select! {
                    () = cancel.cancelled() => return Ok(()),
                    () = delay() => {}
                }
                gc.armed.store(false, Ordering::SeqCst);
                gc.run_if_due(clock(), SystemTime::now(), &cancel).await.map(drop)
            }
            .await;
            gc.armed.store(false, Ordering::SeqCst);
            if let Err(error) = outcome {
                on_error(&error);
            }
        }))
    }
}
