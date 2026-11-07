//! [`StoredSessions`] over the thread store: what the session-search backfill reads of the
//! stored sessions (`session-search-ingest.mjs` `backfillSessionSearch` over `loadStoreDeps`).
//!
//! - The ids are the store dir's listing (`sessionIdsOfNames(readdirSync(dir))`): every folder
//!   of `<data>/sessions` named by a session id, in the order the OS lists them. A session
//!   carrying the delete mark is gone, as a deleted record is in Node once its files are removed.
//! - The record stamp changes whenever the record does, as Node's file-stat stamp
//!   (`sessionRecordStampOfSync`): here the next frame the index projects of the session's log,
//!   which moves with every record appended and stays put across an index rebuild. It is taken
//!   before the read, and the read sees at least what the stamp covers.
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
use mixdog_services::memory::session_search::ingest::StoredSessions;
use mixdog_store::schema::record::Header;

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
    /// The stored header of a session; `None` for one absent, deleted or unreadable (Node's
    /// `loadSession` null).
    pub(super) async fn header(&self, session_id: &str) -> Option<Header> {
        let (reader, thread): (Arc<dyn ThreadStore>, ThreadId) = (self.threads.clone(), ThreadId::from(session_id));
        self.lanes
            .io
            .submit_wait(&CancellationToken::new(), move |lane| reader.read_header(lane, &thread))
            .await
            .ok()?
            .await
            .ok()?
            .ok()
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
        let mut ids = Vec::new();
        for name in names.into_iter().filter(|name| is_session_id(name)) {
            if self.threads.index().deleted(&name).await.map_err(std::io::Error::other)? != Some(true) {
                ids.push(name);
            }
        }
        Ok(ids)
    }
}

#[async_trait]
impl StoredSessions for StoredSearchSessions {
    async fn session_ids(&self) -> Result<Vec<String>> {
        self.listed().await.map_err(|e| failed("list sessions", e))
    }

    async fn record_stamp(&self, session_id: &str) -> Option<String> {
        let at = self.threads.index().projected(session_id).await.ok()??;
        Some(format!("frame:{}:{}:{}", at.ordinal, at.file_no, at.offset))
    }

    async fn read(&self, session_id: &str) -> Option<IngestSession> {
        let id = ThreadId::from(session_id);
        let store: Arc<dyn ThreadStore> = self.threads.clone();
        let header = self.header(session_id).await?;
        let messages = read_context(&store, &self.lanes, &id).await.ok()?;
        Some(search_session(&id, &header, messages.into_iter().map(|(_, body)| body).collect()))
    }
}

#[cfg(test)]
#[path = "search_backfill_tests.rs"]
pub(crate) mod tests;
