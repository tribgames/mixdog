//! [`StoredSessions`] over the thread store: what the session-search backfill reads of the
//! stored sessions (`session-search-ingest.mjs` `backfillSessionSearch` over `loadStoreDeps`).
//!
//! - The ids are the store dir's listing (`sessionIdsOfNames(readdirSync(dir))`): every folder
//!   of `<data>/sessions` named by a session id, in the order the OS lists them. A session
//!   carrying the delete mark is gone, as a deleted record is in Node once its files are removed.
//! - The record stamp combines the next projected frame with the first log file's
//!   filesystem version. The cursor follows appends; a log rewrite replaces the
//!   first file even if no frame positions move. Neither depends on the index generation.
//! - The read is the stored session (`storedSessionSync(dir, id, false)`): its model context,
//!   and `isAgentOnlySession` of its header with its id; `None` for a session absent, deleted or
//!   unreadable (Node's `readSession` null).

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::ids::ThreadId;
use mixdog_rt::CancellationToken;
use mixdog_rt::LaneToken;
use mixdog_services::memory::error::MemoryError;
use mixdog_services::memory::error::Result;
use mixdog_services::memory::session_search::ingest::IngestSession;
use mixdog_services::memory::session_search::ingest::SessionStamp;
use mixdog_services::memory::session_search::ingest::StoredSessions;
use mixdog_store::schema::record::Header;
use mixdog_store::sqlite::lead::LeadRow;

use super::SessionLanes;
use super::delete::is_session_id;
use super::run::read_context;
use super::seams::ThreadStore;
use super::store::StoreThreads;
use super::store::search_session;

/// The session-search backfill's view of the thread store.
pub struct StoredSearchSessions {
    threads: Arc<StoreThreads>,
    lanes: SessionLanes,
}

impl StoredSearchSessions {
    /// Over the core's one thread store (the `SessionDeps.store` instance) and the session lanes.
    pub fn new(threads: Arc<StoreThreads>, lanes: SessionLanes) -> Self {
        Self { threads, lanes }
    }
}

impl StoredSearchSessions {
    /// [`StoreThreads::retention`]: moves when a favorite or archive mark is written.
    pub(super) fn retention(&self) -> u64 {
        self.threads.retention()
    }

    /// Every stored session's catalog row, listed or not (its `favoriteAt`, and its archived flag as the archive authority resolves it) in one
    /// index read, as one observation with the mark projections' state ([`StoreThreads::marked_catalog`]). Node read the sidebar marks from one small file; a
    /// header read per stored session opens that session's record.
    pub(super) async fn catalog_rows(&self) -> Result<Vec<LeadRow>, String> {
        self.threads.marked_catalog().await
    }

    /// The stored header of a session; `None` for one absent, deleted or unreadable (Node's
    /// `loadSession` null).
    pub(super) async fn header(&self, session_id: &str) -> Option<Header> {
        let (reader, thread): (Arc<dyn ThreadStore>, ThreadId) = (self.threads.clone(), ThreadId::from(session_id));
        self.lanes.io.submit_wait(&CancellationToken::new(), move |lane| reader.read_header(lane, &thread)).await.ok()?.await.ok()?.ok()
    }
}

fn failed(what: &str, error: impl std::fmt::Display) -> MemoryError {
    MemoryError::Io(std::io::Error::other(format!("{what}: {error}")))
}

impl StoredSearchSessions {
    /// `<data>/sessions`, the folder [`Self::listed`] reads.
    pub(super) fn sessions_dir(&self) -> &std::path::Path {
        self.threads.sessions_dir()
    }

    /// The listing of the store folder: the session folders not carrying the delete mark. The
    /// error is the folder's own (`readdir`'s) when it cannot be listed.
    pub(super) async fn listed(&self) -> std::io::Result<Vec<String>> {
        let sessions = self.threads.sessions_dir().to_path_buf();
        let names = self
            .lanes
            .io
            .submit_wait(&CancellationToken::new(), move |lane| mixdog_statefile::list_dir(lane, &sessions))
            .await
            .map_err(std::io::Error::other)?
            .await
            .map_err(std::io::Error::other)??;
        let deleted = self.threads.index().deleted_ids().await.map_err(std::io::Error::other)?;
        Ok(names.into_iter().filter(|name| is_session_id(name) && !deleted.contains(name)).collect())
    }
}

#[async_trait]
impl StoredSessions for StoredSearchSessions {
    async fn session_ids(&self) -> Result<Vec<String>> {
        self.listed().await.map_err(|e| failed("list sessions", e))
    }

    async fn record_stamp(&self, session_id: &str) -> Result<Option<String>> {
        Ok(match self.stamp(session_id).await? {
            SessionStamp::At(stamp) => Some(stamp),
            SessionStamp::Busy | SessionStamp::Gone => None,
        })
    }

    /// `Busy` while an operation on the log runs or one ran during the stamp (a write, a sensitive rewrite); `Gone` for a
    /// session the index holds no row of or whose first log file is not there.
    async fn stamp(&self, session_id: &str) -> Result<SessionStamp> {
        let Some(epoch) = mixdog_store::log_epoch::settled(session_id) else { return Ok(SessionStamp::Busy) };
        let Some(at) = self.threads.search_position(session_id).await.map_err(|e| failed("read session stamp", e))? else {
            return Ok(SessionStamp::Gone);
        };
        let first = self.sessions_dir().join(session_id).join(mixdog_store::log::log_name(0));
        let version = self
            .lanes
            .io
            .submit_wait(&CancellationToken::new(), move |_| mixdog_workspace::ident::stat_version(&first))
            .await
            .map_err(|e| failed("schedule session stamp", e))?
            .await
            .map_err(|e| failed("read session stamp", e))?;
        if mixdog_store::log_epoch::settled(session_id) != Some(epoch) {
            return Ok(SessionStamp::Busy);
        }
        let version = match version {
            Ok(version) => version,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(SessionStamp::Gone),
            Err(e) => return Err(failed("stat first session log", e)),
        };
        Ok(SessionStamp::At(format!(
            "frame-v2:{}:{}:{}:{}:{}:{}:{}:{}",
            at.ordinal, at.file_no, at.offset, version.dev, version.ino, version.size, version.mtime_ns, version.ctime_ns
        )))
    }

    async fn read(&self, session_id: &str) -> Option<IngestSession> {
        let id = ThreadId::from(session_id);
        let (threads, shape_id) = (self.threads.clone(), id.clone());
        let shape = self.lanes.io.submit_wait(&CancellationToken::new(), move |lane| threads.search_shape(lane, &shape_id)).await.ok()?.await.ok()?.ok()?;
        if !shape.is_current() {
            return None;
        }
        let store: Arc<dyn ThreadStore> = self.threads.clone();
        let header = self.header(session_id).await?;
        let messages = read_context(&store, &self.lanes, &id).await.ok()?;
        // The context reader can restart between pages; neither a restarted context
        // nor a changed fork base can be paired with an earlier header.
        shape.is_current().then(|| search_session(&id, &header, search_messages(messages)))
    }
}

/// The model context as the search copy takes it: each message names its record's history position, so a hit opens
/// the transcript at it (`thread/search`).
pub(crate) fn search_messages(rows: Vec<(mixdog_core_api::ids::ItemId, serde_json::Value)>) -> Vec<serde_json::Value> {
    rows.into_iter()
        .map(|(iid, mut body)| {
            if let Some(fields) = body.as_object_mut().filter(|_| !iid.as_str().is_empty()) {
                fields.insert(
                    mixdog_services::memory::session_search::db::MESSAGE_POSITION.into(),
                    serde_json::Value::String(super::reads::record_position(iid.as_str())),
                );
            }
            body
        })
        .collect()
}

#[cfg(test)]
#[path = "search_backfill_tests.rs"]
pub(crate) mod tests;
