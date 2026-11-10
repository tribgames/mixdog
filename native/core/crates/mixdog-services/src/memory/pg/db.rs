//! Connection pool over one schema of the `mixdog` database. Every pooled
//! connection has its `search_path` pinned to the owning schema, so
//! unqualified table names resolve there; a query that touches another schema
//! qualifies the name.

use std::sync::Arc;
use std::time::Duration;

use futures::future::BoxFuture;
use tokio::sync::OnceCell;
use deadpool_postgres::{Manager, ManagerConfig, Object, Pool, RecyclingMethod, Runtime};
use tokio_postgres::{Config, NoTls, Row, ToStatement, types::ToSql};

use crate::memory::error::{MemoryError, Result};
use crate::memory::pg::cluster::PgCluster;

pub const DATABASE: &str = "mixdog";
const USER: &str = "postgres";
/// Cluster-global advisory-lock namespace ("midx") for first-boot DDL.
const LOCK_CLASS: i32 = 0x6d69_6478;
const LOCK_CREATE_DB: i32 = 1;
const LOCK_SCHEMA_BOOTSTRAP: i32 = 2;
const POOL_SIZE: usize = 5;

/// Every wait on the memory database is bounded by one budget (hang audit F14).
struct PgBudget {
    /// TCP connect, and the whole of opening one pooled connection: Node `pg.Pool`
    /// `connectionTimeoutMillis` 10_000 (`runtime/memory/lib/pg/adapter.mjs:545`).
    connect: Duration,
    /// Waiting for a free pooled connection. In Node the same `connectionTimeoutMillis`
    /// covers it (`adapter.mjs:545`).
    pool_wait: Duration,
    /// Waiting on a row or table lock: Node `SET LOCAL lock_timeout = '5s'`
    /// (`core-memory-store.mjs:155`).
    lock: Duration,
    /// Waiting for the cluster advisory lock of first-boot DDL: Node's blocking acquire uses
    /// `lock_timeout = '30s'` (`trace-store.mjs:519`).
    cluster_lock: Duration,
    /// One statement. Divergence (decisions.md): Node sets no session-wide limit; its longest
    /// per-statement bound is `statement_timeout = '5min'` (`pg/compact-indexes.mjs:41`).
    statement: Duration,
}

const BUDGET: PgBudget = PgBudget {
    connect: Duration::from_secs(10),
    pool_wait: Duration::from_secs(10),
    lock: Duration::from_secs(5),
    cluster_lock: Duration::from_secs(30),
    statement: Duration::from_secs(300),
};

/// The schemas that share the cluster.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Schema {
    Memory,
    SessionSearch,
}

impl Schema {
    pub fn name(self) -> &'static str {
        match self {
            Self::Memory => "memory",
            Self::SessionSearch => "session_search",
        }
    }
}

pub(super) fn config(port: u16, database: &str, search_path: Option<&str>) -> Config {
    let mut config = Config::new();
    config
        .host("127.0.0.1")
        .port(port)
        .user(USER)
        .dbname(database)
        .connect_timeout(BUDGET.connect);
    let mut options = format!(
        "-c lock_timeout={} -c statement_timeout={}",
        BUDGET.lock.as_millis(),
        BUDGET.statement.as_millis()
    );
    if let Some(path) = search_path {
        options.push_str(&format!(" -c search_path={}", path.replace(' ', "\\ ")));
    }
    config.options(options);
    config
}

fn build_pool(config: Config, size: usize) -> Result<Pool> {
    let manager = Manager::from_config(
        config,
        NoTls,
        ManagerConfig {
            recycling_method: RecyclingMethod::Fast,
        },
    );
    Pool::builder(manager)
        .max_size(size)
        .runtime(Runtime::Tokio1)
        .wait_timeout(Some(BUDGET.pool_wait))
        .create_timeout(Some(BUDGET.connect))
        .recycle_timeout(Some(BUDGET.pool_wait))
        .build()
        .map_err(|error| MemoryError::Pool(error.to_string()))
}

/// A session-scoped advisory lock on a dedicated connection; released by
/// `unlock`. A connection whose unlock failed is dropped, never pooled.
async fn with_cluster_lock<T, F>(pool: &Pool, object: i32, body: F) -> Result<T>
where
    F: AsyncFnOnce(&Object) -> Result<T>,
{
    let client = pool.get().await?;
    // The wait for another process's first-boot DDL is longer than a row-lock wait; the
    // session returns to the pool budget when the lock is released.
    client
        .batch_execute(&format!(
            "SET lock_timeout = {}",
            BUDGET.cluster_lock.as_millis()
        ))
        .await?;
    client
        .execute("SELECT pg_advisory_lock($1, $2)", &[&LOCK_CLASS, &object])
        .await?;
    let result = body(&client).await;
    let released = async {
        client
            .execute("SELECT pg_advisory_unlock($1, $2)", &[&LOCK_CLASS, &object])
            .await?;
        client.batch_execute("RESET lock_timeout").await
    };
    if released.await.is_err() {
        let _ = Object::take(client);
    }
    result
}

/// Creates the database and the cluster-wide extension once per call; both
/// statements are idempotent and serialised by cluster advisory locks.
async fn bootstrap(cluster: &PgCluster) -> Result<()> {
    let admin = build_pool(config(cluster.port(), "postgres", None), 1)?;
    with_cluster_lock(&admin, LOCK_CREATE_DB, async |client| {
        let exists = client.query_opt("SELECT 1 FROM pg_database WHERE datname = $1", &[&DATABASE]).await?;
        if exists.is_none() {
            client.batch_execute(&format!("CREATE DATABASE {DATABASE}")).await?;
        }
        Ok(())
    })
    .await?;
    admin.close();
    let setup = build_pool(config(cluster.port(), DATABASE, None), 1)?;
    with_cluster_lock(&setup, LOCK_SCHEMA_BOOTSTRAP, async |client| {
        client
            .batch_execute(
                "CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;
                 CREATE SCHEMA IF NOT EXISTS memory;
                 CREATE SCHEMA IF NOT EXISTS session_search;",
            )
            .await?;
        Ok(())
    })
    .await?;
    setup.close();
    Ok(())
}

/// What opens a deferred [`Db`]'s pool: the cluster start, and everything that must precede the first query.
pub type PoolOpener = Arc<dyn Fn() -> BoxFuture<'static, Result<Pool>> + Send + Sync>;

/// The pool of a [`Db`]: present from the start, or opened by the first use (Node starts the memory runtime
/// on the first memory call, not at boot).
struct LazyPool {
    cell: OnceCell<Pool>,
    opener: Option<PoolOpener>,
    /// The opening in flight, shared by every use that arrived while it runs: they all see its one outcome, and the next use after a failure opens again
    /// (Node's callers all await the one `initPromise`, `http-router.mjs:34-46`; a bare `OnceCell` would hand a failed opening to the next waiter to run again).
    flight: std::sync::Mutex<Option<Flight>>,
}

type Flight = futures::future::Shared<BoxFuture<'static, std::result::Result<(), String>>>;

impl LazyPool {
    fn new(cell: OnceCell<Pool>, opener: Option<PoolOpener>) -> Arc<Self> {
        Arc::new(Self { cell, opener, flight: std::sync::Mutex::new(None) })
    }

    async fn get(self: &Arc<Self>) -> Result<&Pool> {
        use futures::FutureExt as _;
        if let Some(pool) = self.cell.get() {
            return Ok(pool);
        }
        let flight = {
            let mut slot = self.flight.lock().expect("flight");
            slot.get_or_insert_with(|| {
                let this = self.clone();
                async move {
                    let opened = this
                        .cell
                        .get_or_try_init(|| async {
                            match &this.opener {
                                Some(open) => open().await,
                                None => unreachable!("an eager pool is set at construction"),
                            }
                        })
                        .await
                        .map(drop)
                        .map_err(|error| error.message());
                    this.flight.lock().expect("flight").take();
                    opened
                }
                .boxed()
                .shared()
            })
            .clone()
        };
        flight.await.map_err(MemoryError::Rejected)?;
        self.cell.get().ok_or_else(|| MemoryError::Runtime("the pool did not open".to_owned()))
    }
}

/// A bounded pool of connections with the schema's `search_path`.
#[derive(Clone)]
pub struct Db {
    pool: Arc<LazyPool>,
    schema: Schema,
}

impl Db {
    /// Opens the schema's pool, creating the database and extension first.
    pub async fn open(cluster: &PgCluster, schema: Schema) -> Result<Self> {
        bootstrap(cluster).await?;
        let path = format!("{}, public", schema.name());
        let pool = build_pool(config(cluster.port(), DATABASE, Some(&path)), POOL_SIZE)?;
        Ok(Self { pool: LazyPool::new(OnceCell::new_with(Some(pool)), None), schema })
    }

    /// A handle whose pool `opener` produces at the first use; a failed open is retried by the next use.
    pub fn deferred(schema: Schema, opener: PoolOpener) -> Self {
        Self { pool: LazyPool::new(OnceCell::new(), Some(opener)), schema }
    }

    /// The pool of a handle that is already open (what a deferred handle's opener hands over).
    pub(crate) fn opened_pool(&self) -> Pool {
        self.pool.cell.get().expect("an open handle has its pool").clone()
    }

    pub fn schema(&self) -> Schema {
        self.schema
    }

    pub async fn client(&self) -> Result<Object> {
        Ok(self.pool.get().await?.get().await?)
    }

    pub async fn query<T>(&self, statement: &T, params: &[&(dyn ToSql + Sync)]) -> Result<Vec<Row>>
    where
        T: ?Sized + ToStatement,
    {
        Ok(self.client().await?.query(statement, params).await?)
    }

    pub async fn query_opt<T>(&self, statement: &T, params: &[&(dyn ToSql + Sync)]) -> Result<Option<Row>>
    where
        T: ?Sized + ToStatement,
    {
        Ok(self.client().await?.query_opt(statement, params).await?)
    }

    pub async fn execute<T>(&self, statement: &T, params: &[&(dyn ToSql + Sync)]) -> Result<u64>
    where
        T: ?Sized + ToStatement,
    {
        Ok(self.client().await?.execute(statement, params).await?)
    }

    /// Multi-statement SQL on one connection (DDL).
    pub async fn batch(&self, sql: &str) -> Result<()> {
        Ok(self.client().await?.batch_execute(sql).await?)
    }

    /// Runs `ddl` while holding the cluster-wide schema-bootstrap lock, so
    /// concurrent first-boot processes never race `CREATE TABLE`.
    pub async fn bootstrap_schema(&self, ddl: &str) -> Result<()> {
        with_cluster_lock(self.pool.get().await?, LOCK_SCHEMA_BOOTSTRAP, async |_| self.batch(ddl).await).await
    }

    /// Closes the pool when it was opened; a handle never used has nothing to close.
    pub fn close(&self) {
        if let Some(pool) = self.pool.cell.get() {
            pool.close();
        }
    }
}

impl std::fmt::Debug for Db {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Db").field("schema", &self.schema).finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A postmaster that accepts the TCP connection and never answers the startup packet.
    #[tokio::test(start_paused = true)]
    async fn a_silent_postgres_fails_the_checkout_instead_of_holding_it() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let silent = tokio::spawn(async move {
            let mut held = Vec::new();
            while let Ok((socket, _)) = listener.accept().await {
                held.push(socket);
            }
        });
        let pool = build_pool(config(port, DATABASE, Some("memory, public")), 1).unwrap();
        let outcome = tokio::time::timeout(BUDGET.connect * 3, pool.get()).await;
        assert!(
            matches!(outcome, Ok(Err(_))),
            "the budget ends the checkout, the test timeout does not"
        );
        silent.abort();
    }
}
