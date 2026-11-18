//! A scoped operation of the memory stack's owner: the only way product code outside the memory runtime reaches one of its databases. Each call
//! runs its whole body (every statement, the connection it checks out, the wait for the opening) as work of the database's owner: the stop drains it
//! or revokes it, a caller that stops waiting leaves it owned, and a call after the stop began is refused before it touches the database. No raw
//! [`Db`] leaves the memory runtime this way.

use std::future::Future;
use std::time::Duration;

use crate::memory::error::{MemoryError, Result};
use crate::memory::pg::db::Db;

/// What an operation the owner refused or revoked answers.
pub const STOPPING: &str = "memory service stopping";

#[derive(Clone)]
pub struct MemoryAccess {
    db: Db,
}

impl MemoryAccess {
    pub(crate) fn over(db: Db) -> Self {
        Self { db }
    }

    /// Runs `work` over the handle as one owned operation.
    pub async fn run<T, Fut>(&self, name: &'static str, work: impl FnOnce(Db) -> Fut + Send + 'static) -> Result<T>
    where
        T: Send + 'static,
        Fut: Future<Output = Result<T>> + Send + 'static,
    {
        let db = self.db.clone();
        match self.db.scope().spawn(name, async move { work(db).await }) {
            Some(work) => work.await.unwrap_or_else(|| Err(MemoryError::Rejected(STOPPING.to_owned()))),
            None => Err(MemoryError::Rejected(STOPPING.to_owned())),
        }
    }

    /// Waits for the database's opening until `limit` after its launch ([`Db::ready_within`]), as an owned operation.
    pub async fn ready_within(&self, limit: Duration) -> Result<()> {
        self.run("services.memory.ready", move |db| async move { db.ready_within(limit).await }).await
    }
}
