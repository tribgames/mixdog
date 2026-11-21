//! The one authority over which sessions are archived (Node `desktop-session-metadata.ts`: the archive map, changed for a session and
//! its descendants in one operation and persisted by one atomic file replacement, `session-metadata-file.ts`).
//!
//! Its entries are `meta` rows of `state/core.sqlite` under [`ENTRY_PREFIX`], one per session an operation changed: "archived at S"
//! or "explicitly restored at T". A session's archive state resolves as: no entry, the stamp its header carries (`archivedAt`, the
//! state every session had before this authority existed: no header is rewritten for it); an archived entry, archived at its stamp;
//! a restored entry, not archived whatever the header holds. A restore writes its entry and never deletes one. Every change of a
//! tree (a session with its sub-agent sessions) is one transaction, together with the op record of its outcome, so a crash leaves
//! each tree wholly changed or untouched.
//!
//! After a commit the in-memory snapshot is replaced on the state writer, in commit order, before the next write starts; the catalog
//! index then takes the changed rows ([`SqliteStore::project_archive`]), and every index write resolves its row through the same
//! snapshot, so the listings, the search and the row notifications follow the authority.
//!
//! A state database set aside as unusable lost the entries ([`ArchiveStates::mark_lost`]): from then on a state that comes only from
//! a header is not [`Resolved::trusted`], and automatic retention never acts on it (a session the user restored may still carry its
//! stamp in its header).

use std::collections::HashMap;
use std::collections::HashSet;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::OnceLock;
use std::sync::PoisonError;
use std::sync::RwLock;

use mixdog_rt::DurabilityIo;
use mixdog_rt::LaneToken;
use serde_json::Value;
use serde_json::json;

use crate::sqlite::DbError;
use crate::sqlite::SqliteStore;
use crate::state::CoreState;
use crate::state::OpRow;
use crate::state::StateTx;

/// The `meta` key prefix of the entries: `session-archive:<session id>`.
pub const ENTRY_PREFIX: &str = "session-archive:";
/// Set on a state database started in place of one set aside: the entries before it are gone.
pub const LOST_KEY: &str = "session-archive-lost";
/// The op scope of the committed tree operations ([`StateTx::put_op`]).
pub const OP_SCOPE: &str = "session-archive";

/// One session's entry.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ArchiveEntry {
    /// Archived at this stamp.
    Archived(f64),
    /// Explicitly restored at this time: not archived, whatever its header holds. For a session the user restored it is also
    /// the auto-archive exemption (Node's `sessionRetention.restored[id]`): kept out until it is used after this time.
    Restored(f64),
}

impl ArchiveEntry {
    pub fn archived_at(self) -> Option<f64> {
        match self {
            Self::Archived(at) => Some(at),
            Self::Restored(_) => None,
        }
    }

    fn encode(self) -> String {
        match self {
            Self::Archived(at) => json!({ "archivedAt": at }),
            Self::Restored(at) => json!({ "restoredAt": at }),
        }
        .to_string()
    }

    fn decode(key: &str, text: &str) -> Result<Self, DbError> {
        let bad = || DbError::Rebuild(format!("the archive entry {key} is not one: {text}"));
        let value: Value = serde_json::from_str(text).map_err(|_| bad())?;
        let stamp = |name: &str| value.get(name).and_then(Value::as_f64).filter(|at| at.is_finite() && *at > 0.0);
        match (stamp("archivedAt"), stamp("restoredAt")) {
            (Some(at), None) => Ok(Self::Archived(at)),
            (None, Some(at)) => Ok(Self::Restored(at)),
            _ => Err(bad()),
        }
    }
}

/// The stamp a header's `archivedAt` holds, as the sidebar reads it (a positive number).
pub fn header_stamp(value: Option<&Value>) -> Option<f64> {
    value.map(mixdog_js::to_number).filter(|at| *at > 0.0)
}

/// A session's archive state.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Resolved {
    pub archived_at: Option<f64>,
    /// The entry it comes from; none when it comes from the header.
    pub entry: Option<ArchiveEntry>,
    /// The entries were lost (the state database was set aside).
    pub lost: bool,
}

impl Resolved {
    pub fn archived(&self) -> bool {
        self.archived_at.is_some()
    }

    /// Whether automatic retention may act on it: it comes from an entry, or no entry was ever lost.
    pub fn trusted(&self) -> bool {
        self.entry.is_some() || !self.lost
    }

    /// When the user brought it back, if that is its entry.
    pub fn restored_at(&self) -> Option<f64> {
        match self.entry {
            Some(ArchiveEntry::Restored(at)) => Some(at),
            _ => None,
        }
    }
}

/// The committed entries at one moment. Immutable: a commit publishes a new one.
#[derive(Clone, Debug, Default)]
pub struct ArchiveSnapshot {
    entries: HashMap<String, ArchiveEntry>,
    lost: bool,
    /// Moves with every commit that changed an entry.
    version: u64,
}

impl ArchiveSnapshot {
    pub fn entry(&self, id: &str) -> Option<ArchiveEntry> {
        self.entries.get(id).copied()
    }

    /// `id`'s state, its header holding `header_archived_at` (`archivedAt`).
    pub fn resolve(&self, id: &str, header_archived_at: Option<&Value>) -> Resolved {
        let entry = self.entry(id);
        let archived_at = match entry {
            Some(entry) => entry.archived_at(),
            None => header_stamp(header_archived_at),
        };
        Resolved { archived_at, entry, lost: self.lost }
    }

    pub fn lost(&self) -> bool {
        self.lost
    }

    pub fn version(&self) -> u64 {
        self.version
    }

    /// The sessions that have an entry.
    pub fn ids(&self) -> impl Iterator<Item = &String> {
        self.entries.keys()
    }

    /// Every entry.
    pub fn entries(&self) -> impl Iterator<Item = (&String, ArchiveEntry)> {
        self.entries.iter().map(|(id, entry)| (id, *entry))
    }
}

/// The published snapshot, shared with the catalog index.
pub type ArchiveView = Arc<RwLock<Arc<ArchiveSnapshot>>>;

/// The current snapshot of `view`.
pub fn current(view: &ArchiveView) -> Arc<ArchiveSnapshot> {
    view.read().unwrap_or_else(PoisonError::into_inner).clone()
}

/// A commit's answer: what the caller decided, and whether the catalog index took the changed rows. A failure there does not undo
/// the commit: the index resolves every row it writes through the snapshot, and the next start projects every entry again.
#[derive(Debug)]
pub struct Committed<T> {
    pub answer: T,
    /// The sessions whose entry the commit wrote.
    pub changed: Vec<String>,
    pub indexed: Result<(), DbError>,
    /// What is known of the 1.4.5 metadata file ([`ArchiveStates::bind_desktop_mirror`]) at the answer: the changed sessions are
    /// owed to its mirror, which writes them after the commit answered (false: no mirror is bound).
    pub mirror_owed: bool,
}

/// The admissions the commits and the automatic deletes take against each other ([`ArchiveStates::claim_delete`]).
#[derive(Default)]
struct Claims {
    /// Sessions an automatic delete was admitted for, against the entry it judged.
    deleting: HashSet<String>,
    /// Sessions a commit is changing: from its decision until its snapshot is published (or it failed).
    pending: HashMap<String, usize>,
}

impl Claims {
    fn begin_change(&mut self, ids: &[String]) -> Result<(), DbError> {
        if let Some(id) = ids.iter().find(|id| self.deleting.contains(*id)) {
            return Err(DbError::Write(format!("the session {id} is being deleted")));
        }
        for id in ids {
            *self.pending.entry(id.clone()).or_default() += 1;
        }
        Ok(())
    }

    fn end_change(&mut self, ids: &[String]) {
        for id in ids {
            if let Some(count) = self.pending.get_mut(id) {
                *count -= 1;
                if *count == 0 {
                    self.pending.remove(id);
                }
            }
        }
    }
}

/// The sessions one commit registered as changing ([`Claims::begin_change`]): their change ends when this drops.
struct PendingChange {
    claims: Arc<Mutex<Claims>>,
    ids: Mutex<Vec<String>>,
}

impl Drop for PendingChange {
    fn drop(&mut self) {
        let ids = std::mem::take(&mut *self.ids.lock().unwrap_or_else(PoisonError::into_inner));
        self.claims.lock().unwrap_or_else(PoisonError::into_inner).end_change(&ids);
    }
}

/// An automatic delete's hold on a session's entry: no commit changes it while held. Dropped when the delete ends.
pub struct DeleteClaim {
    claims: Arc<Mutex<Claims>>,
    id: String,
}

impl Drop for DeleteClaim {
    fn drop(&mut self) {
        self.claims.lock().unwrap_or_else(PoisonError::into_inner).deleting.remove(&self.id);
    }
}

/// The file a 1.4.5 desktop reads every session's archive state from, in its profile `<P>`: `readSessionMetadata`
/// (`apps/desktop/src/main/session-metadata-file.ts` at 1.4.5) takes `archived` (id → stamp) of a `version: 2` object, and
/// `DesktopSessionMetadata.withArchiveFlags` (`desktop-session-metadata.ts`) marks a listed row archived when its id is there.
/// 1.5.0 reads it only to convert sessions not converted yet (`mixdog-migrate` `desktop_profile/plan.rs`, `!sessions_converted`),
/// so the mirror below is never read back as a source.
pub const DESKTOP_METADATA_FILE: &str = "desktop-session-metadata.json";

/// The mirror of the committed entries into [`DESKTOP_METADATA_FILE`]: a projection of the authority for a 1.4.5 build run on the
/// same data afterwards, written by its own task after the commits answered.
struct DesktopMirror {
    /// Woken by every commit that owes it sessions.
    wake: Arc<tokio::sync::Notify>,
    /// Bumped before each wake: the passes the commits asked for.
    asked: Arc<std::sync::atomic::AtomicU64>,
    /// The `asked` count each finished pass started at.
    done: tokio::sync::watch::Receiver<u64>,
    stop: mixdog_rt::CancellationToken,
    task: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

/// What the mirror's task owns: one read-modify-write of the file at a time, each from the snapshot current when it starts.
struct MirrorWork {
    path: PathBuf,
    lane: DurabilityIo,
    view: ArchiveView,
    owed: Arc<Mutex<HashMap<String, u64>>>,
    #[cfg(any(test, feature = "test-support"))]
    hold: MirrorHold,
}

/// The pair of channels a test uses to pause the next mirror pass: it signals arrival, then waits to be released.
#[cfg(any(test, feature = "test-support"))]
type MirrorHold = Arc<Mutex<Option<(tokio::sync::oneshot::Sender<()>, tokio::sync::oneshot::Receiver<()>)>>>;

impl MirrorWork {
    /// One pass: every owed session written as the authority holds it now. A session a commit owed again during the write (a newer
    /// ask) stays owed; a failed write leaves them all owed, carried by the next pass.
    async fn pass(&self) {
        #[cfg(any(test, feature = "test-support"))]
        {
            let held = self.hold.lock().unwrap_or_else(PoisonError::into_inner).take();
            if let Some((arrived, go)) = held {
                let _ = arrived.send(());
                let _ = go.await;
            }
        }
        let taken: Vec<(String, u64)> = self.owed.lock().unwrap_or_else(PoisonError::into_inner).iter().map(|(id, ask)| (id.clone(), *ask)).collect();
        if taken.is_empty() {
            return;
        }
        // Read after the sessions were taken: every commit that owed them had published its snapshot before it did.
        let snapshot = current(&self.view);
        let changes: Vec<(String, Option<f64>)> =
            taken.iter().filter_map(|(id, _)| snapshot.entry(id).map(|entry| (id.clone(), entry.archived_at()))).collect();
        let path = self.path.clone();
        let written = match self.lane.submit(&mixdog_rt::CancellationToken::new(), move |lane| mirror_archived(lane, &path, &changes)) {
            Ok(job) => job.await.map_err(|error| format!("{error:?}")).and_then(|result| result),
            Err(error) => Err(format!("{error:?}")),
        };
        match written {
            Ok(()) => {
                let mut owed = self.owed.lock().unwrap_or_else(PoisonError::into_inner);
                for (id, ask) in taken {
                    if owed.get(&id) == Some(&ask) {
                        owed.remove(&id);
                    }
                }
            }
            Err(error) => mixdog_rt::node_stderr!("[mixdog-session] The 1.4.5 session metadata file did not take the archive state yet: {error}"),
        }
    }
}

/// `archived` of the 1.4.5 metadata file at `path` set as `changes` state (a stamp, or no longer archived), every other field
/// left as stored and the file published as 1.4.5's `writeSessionMetadata` publishes it (`version: 2`, `titles`, `names`, then
/// `archived` when not empty, then the other maps; atomic, owner-only). A missing or unparsable file, or one of another version,
/// is read as 1.4.5 reads it: empty. A missing profile folder has no 1.4.5 to mirror for.
pub fn mirror_archived(lane: &mixdog_rt::InLane<DurabilityIo>, path: &Path, changes: &[(String, Option<f64>)]) -> Result<(), String> {
    if let Some(profile) = path.parent()
        && let Err(error) = mixdog_statefile::metadata(lane, profile)
    {
        return if error.kind() == std::io::ErrorKind::NotFound { Ok(()) } else { Err(error.to_string()) };
    }
    let stored = match mixdog_statefile::read_content(path).map_err(|error| error.to_string())? {
        Some(bytes) => match mixdog_statefile::parse_json_text(&bytes) {
            Ok(Value::Object(map)) => map,
            _ => serde_json::Map::new(),
        },
        None => serde_json::Map::new(),
    };
    let stored = if stored.get("version").and_then(Value::as_f64) == Some(2.0) { stored } else { serde_json::Map::new() };
    let mut archived = match stored.get("archived") {
        Some(Value::Object(map)) => map.clone(),
        _ => serde_json::Map::new(),
    };
    for (id, at) in changes {
        match at {
            Some(at) => archived.insert(id.clone(), mixdog_js::json_number(*at)),
            None => archived.shift_remove(id),
        };
    }
    let mut out = serde_json::Map::new();
    out.insert("version".into(), json!(2));
    for key in ["titles", "names"] {
        out.insert(key.into(), stored.get(key).cloned().unwrap_or_else(|| json!({})));
    }
    if !archived.is_empty() {
        out.insert("archived".into(), Value::Object(archived));
    }
    for (key, value) in &stored {
        if !out.contains_key(key) && key != "archived" {
            out.insert(key.clone(), value.clone());
        }
    }
    let opts = mixdog_statefile::Opts { secret: true, ..mixdog_statefile::Opts::default() };
    mixdog_statefile::write_json(lane, path, &Value::Object(out), &opts).map(drop).map_err(|error| error.to_string())
}

/// The authority: the entries in `state/core.sqlite` and their published snapshot.
pub struct ArchiveStates {
    state: CoreState,
    view: ArchiveView,
    index: OnceLock<SqliteStore>,
    claims: Arc<Mutex<Claims>>,
    mirror: OnceLock<DesktopMirror>,
    /// The background projection of the entries owed at start ([`Self::start_projection`]) and the token that ends it.
    projection: Mutex<Option<tokio::task::JoinHandle<()>>>,
    projection_stop: mixdog_rt::CancellationToken,
    /// The sessions owed to the mirror, each with the ask that owed it last: written (or a failure carried) by its task.
    mirror_owed: Arc<Mutex<HashMap<String, u64>>>,
    /// The next mirror pass a test holds before it reads what is owed.
    #[cfg(any(test, feature = "test-support"))]
    mirror_hold: MirrorHold,
}

impl std::fmt::Debug for ArchiveStates {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ArchiveStates").field("version", &self.snapshot().version).finish()
    }
}

impl ArchiveStates {
    /// Reads every entry. An entry that does not parse, or a read that fails, fails the open: an entry is never taken as absent.
    pub async fn open(state: CoreState) -> Result<Arc<Self>, DbError> {
        let rows = state.meta_prefix(ENTRY_PREFIX).await?;
        let lost = state.meta(LOST_KEY).await?.is_some();
        let mut entries = HashMap::with_capacity(rows.len());
        for (key, text) in rows {
            let entry = ArchiveEntry::decode(&key, &text)?;
            entries.insert(key[ENTRY_PREFIX.len()..].to_owned(), entry);
        }
        Ok(Self::with(state, ArchiveSnapshot { entries, lost, version: 0 }))
    }

    /// Over a state database just created, which has no entries (a test's).
    #[cfg(any(test, feature = "test-support"))]
    pub fn fresh(state: CoreState) -> Arc<Self> {
        Self::with(state, ArchiveSnapshot::default())
    }

    fn with(state: CoreState, snapshot: ArchiveSnapshot) -> Arc<Self> {
        Arc::new(Self {
            state,
            view: Arc::new(RwLock::new(Arc::new(snapshot))),
            index: OnceLock::new(),
            claims: Arc::default(),
            mirror: OnceLock::new(),
            projection: Mutex::new(None),
            projection_stop: mixdog_rt::CancellationToken::new(),
            mirror_owed: Arc::default(),
            #[cfg(any(test, feature = "test-support"))]
            mirror_hold: Arc::default(),
        })
    }

    /// Mirrors every commit from here into the 1.4.5 metadata file of the desktop profile `profile`, and every entry now (what a
    /// stop or a failed write left owed before this start). Returns at once: the mirror's own task writes, after it.
    pub fn bind_desktop_mirror(&self, profile: &Path, lane: DurabilityIo) -> Result<(), String> {
        let (wake, asked, stop) = (Arc::new(tokio::sync::Notify::new()), Arc::new(std::sync::atomic::AtomicU64::new(0)), mixdog_rt::CancellationToken::new());
        let (done_tx, done) = tokio::sync::watch::channel(0u64);
        let work = MirrorWork {
            path: profile.join(DESKTOP_METADATA_FILE),
            lane,
            view: self.view.clone(),
            owed: self.mirror_owed.clone(),
            #[cfg(any(test, feature = "test-support"))]
            hold: self.mirror_hold.clone(),
        };
        let (woken, counted, stopped) = (wake.clone(), asked.clone(), stop.clone());
        let task = mixdog_rt::spawn("session.archive-mirror", mixdog_rt::TaskClass::Work, async move {
            loop {
                let ended = tokio::select! {
                    () = woken.notified() => false,
                    () = stopped.cancelled() => true,
                };
                // What the asks before this pass owed is written by it; a stop still writes what is owed once.
                let at = counted.load(std::sync::atomic::Ordering::SeqCst);
                work.pass().await;
                done_tx.send_modify(|done| *done = (*done).max(at));
                if ended {
                    return;
                }
            }
        });
        let mirror = DesktopMirror { wake, asked, done, stop, task: Mutex::new(Some(task)) };
        self.mirror.set(mirror).map_err(|_| "the desktop mirror is already bound".to_owned())?;
        let ids: Vec<String> = self.snapshot().ids().cloned().collect();
        self.owe_mirror(&ids);
        Ok(())
    }

    /// Owes `ids` to the mirror and wakes its task; false when no mirror is bound.
    fn owe_mirror(&self, ids: &[String]) -> bool {
        let Some(mirror) = self.mirror.get() else { return false };
        let ask = mirror.asked.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
        {
            let mut owed = self.mirror_owed.lock().unwrap_or_else(PoisonError::into_inner);
            for id in ids {
                owed.insert(id.clone(), ask);
            }
        }
        mirror.wake.notify_one();
        true
    }

    /// Whether sessions are still owed to the mirror (not written yet, or their write failed).
    pub fn mirror_owed(&self) -> bool {
        !self.mirror_owed.lock().unwrap_or_else(PoisonError::into_inner).is_empty()
    }

    /// Returns once the mirror ran a pass for every commit before this call (written, or failed and kept owed).
    pub async fn mirror_settled(&self) {
        let Some(mirror) = self.mirror.get() else { return };
        let asked = mirror.asked.load(std::sync::atomic::Ordering::SeqCst);
        let mut done = mirror.done.clone();
        let _ = done.wait_for(|done| *done >= asked).await;
    }

    /// The next mirror pass waits, before it reads what is owed, until `.1` lets it go; `.0` tells it arrived (a test's).
    #[cfg(any(test, feature = "test-support"))]
    pub fn hold_mirror(&self) -> (tokio::sync::oneshot::Receiver<()>, tokio::sync::oneshot::Sender<()>) {
        let (arrived_tx, arrived) = tokio::sync::oneshot::channel();
        let (go, go_rx) = tokio::sync::oneshot::channel();
        *self.mirror_hold.lock().unwrap_or_else(PoisonError::into_inner) = Some((arrived_tx, go_rx));
        (arrived, go)
    }

    /// Ends the mirror's task with the store: it writes what is owed once more, then stops (what it could not write is written
    /// again at the next start, which owes every entry).
    pub async fn close_mirror(&self) {
        let Some(mirror) = self.mirror.get() else { return };
        mirror.stop.cancel();
        let task = mirror.task.lock().unwrap_or_else(PoisonError::into_inner).take();
        if let Some(task) = task {
            let _ = task.await;
        }
    }

    /// Admits an automatic delete of `id` against the entry it judged (`judged`, none when it judged a header's stamp): refused
    /// (`None`) when the entry is another now, or a commit changing it is under way; while the claim is held, a commit that would
    /// change it fails whole. Either the delete is admitted first and a later restore of the session fails, or the restore
    /// committed first and the delete is refused.
    pub fn claim_delete(&self, id: &str, judged: Option<ArchiveEntry>) -> Option<DeleteClaim> {
        let mut claims = self.claims.lock().unwrap_or_else(PoisonError::into_inner);
        // Pending is cleared only after its snapshot is published: with none pending the snapshot is the committed state.
        if claims.pending.contains_key(id) || claims.deleting.contains(id) || self.snapshot().entry(id) != judged {
            return None;
        }
        claims.deleting.insert(id.to_owned());
        Some(DeleteClaim { claims: self.claims.clone(), id: id.to_owned() })
    }

    /// On a state database started in place of one set aside (`CoreState::open_or_set_aside`): the entries before it are gone,
    /// recorded before [`Self::open`] reads them.
    pub async fn mark_lost(state: &CoreState) -> Result<(), DbError> {
        state.write(|tx| tx.put_meta(LOST_KEY, "1")).await
    }

    pub fn snapshot(&self) -> Arc<ArchiveSnapshot> {
        current(&self.view)
    }

    /// `id`'s state now, its header holding `header_archived_at`.
    pub fn resolve(&self, id: &str, header_archived_at: Option<&Value>) -> Resolved {
        self.snapshot().resolve(id, header_archived_at)
    }

    /// The catalog index resolves its rows through this authority from here, and takes every entry now (rows it wrote before, or
    /// a projection a stop cut short).
    pub async fn bind_index(&self, index: &SqliteStore) -> Result<(), DbError> {
        index.bind_archive(self.view.clone()).map_err(|why| DbError::Write(why.to_owned()))?;
        let _ = self.index.set(index.clone());
        let ids: Vec<String> = self.snapshot().ids().cloned().collect();
        index.project_archive(ids).await
    }

    /// [`Self::bind_index`] without waiting for the writer: the binding is in place and every entry is owed to the index, so the
    /// recent search settles them before it reads, and the caller's `index.project_archive(Vec::new())` settles them in the background.
    pub fn bind_index_deferred(&self, index: &SqliteStore) -> Result<(), DbError> {
        index.bind_archive(self.view.clone()).map_err(|why| DbError::Write(why.to_owned()))?;
        let _ = self.index.set(index.clone());
        index.owe_archive(self.snapshot().ids().cloned().collect());
        Ok(())
    }

    /// Starts the bulk projection of the entries owed by [`Self::bind_index_deferred`] in the background; the caller does it once
    /// the core serves, so the catalog writer's queue is not held by it before then. Once only; [`Self::close_projection`] ends it.
    pub fn start_projection(&self) {
        let Some(index) = self.index.get().cloned() else { return };
        let mut slot = self.projection.lock().unwrap_or_else(PoisonError::into_inner);
        if slot.is_some() || self.projection_stop.is_cancelled() {
            return;
        }
        let stop = self.projection_stop.clone();
        *slot = Some(mixdog_rt::spawn("session.archive-project", mixdog_rt::TaskClass::Work, async move {
            // Cancelling only keeps it from starting: once the command is sent the writer runs it whatever happens to this future,
            // so the stop waits for its acknowledgement. A failed projection stays owed: the search and the next projection settle it.
            if !stop.is_cancelled() {
                let _ = index.project_archive(Vec::new()).await;
            }
        }));
    }

    /// Ends the background projection with the store: one not yet sent never starts, one sent is awaited to the writer's answer.
    /// What it left owed is projected again by the next start, which owes every entry.
    pub async fn close_projection(&self) {
        self.projection_stop.cancel();
        let task = self.projection.lock().unwrap_or_else(PoisonError::into_inner).take();
        if let Some(task) = task {
            let _ = task.await;
        }
    }

    /// The committed outcome of the tree operation `op_id`, if it committed.
    pub async fn outcome(&self, op_id: &str) -> Result<Option<OpRow>, DbError> {
        self.state.op(OP_SCOPE, op_id).await
    }

    /// One transaction on the state writer, after its queue: `decide` reads the snapshot as committed so far (every earlier commit
    /// is in it) and answers with the entries to write, which go in the same transaction as anything `decide` wrote itself. On
    /// commit the next snapshot is published before any later write starts; on any error nothing was written.
    pub async fn commit<T, D>(&self, decide: D) -> Result<Committed<T>, DbError>
    where
        T: Send + 'static,
        D: FnOnce(&ArchiveSnapshot, &StateTx<'_>) -> Result<(T, Vec<(String, ArchiveEntry)>), DbError> + Send + 'static,
    {
        let (read, publish) = (self.view.clone(), self.view.clone());
        // Held by the writer's job: the sessions it registers are released once the writer is done with it (the snapshot
        // published, or the commit failed or never ran), whether or not this caller still waits for the answer.
        let pending = Arc::new(PendingChange { claims: self.claims.clone(), ids: Mutex::default() });
        let marked = pending.clone();
        let written = self
            .state
            .write_then(
                move |tx| {
                    let snapshot = current(&read);
                    let (answer, changes) = decide(&snapshot, tx)?;
                    let ids: Vec<String> = changes.iter().map(|(id, _)| id.clone()).collect();
                    marked.claims.lock().unwrap_or_else(PoisonError::into_inner).begin_change(&ids)?;
                    marked.ids.lock().unwrap_or_else(PoisonError::into_inner).extend(ids);
                    for (id, entry) in &changes {
                        tx.put_meta(&format!("{ENTRY_PREFIX}{id}"), &entry.encode())?;
                    }
                    Ok((answer, changes))
                },
                move |(_, changes): &(T, Vec<(String, ArchiveEntry)>)| {
                    if !changes.is_empty() {
                        let mut slot = publish.write().unwrap_or_else(PoisonError::into_inner);
                        let mut next = (**slot).clone();
                        for (id, entry) in changes {
                            next.entries.insert(id.clone(), *entry);
                        }
                        next.version += 1;
                        *slot = Arc::new(next);
                    }
                    drop(pending);
                },
            )
            .await;
        let (answer, changes) = written?;
        let changed: Vec<String> = changes.into_iter().map(|(id, _)| id).collect();
        let indexed = match self.index.get() {
            Some(index) if !changed.is_empty() => index.project_archive(changed.clone()).await,
            _ => Ok(()),
        };
        let mirror_owed = !changed.is_empty() && self.owe_mirror(&changed);
        Ok(Committed { answer, changed, indexed, mirror_owed })
    }
}

#[cfg(test)]
#[path = "archive_state_tests.rs"]
mod tests;
