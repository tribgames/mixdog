//! Connection pool over one schema of the `mixdog` database. Every pooled
//! connection has its `search_path` pinned to the owning schema, so
//! unqualified table names resolve there; a query that touches another schema
//! qualifies the name.

use std::sync::Arc;
use std::time::Duration;

use futures::future::BoxFuture;
use deadpool_postgres::{Manager, ManagerConfig, Object, Pool, RecyclingMethod, Runtime};
use tokio_postgres::{Config, NoTls, Row, ToStatement, types::ToSql};

use crate::memory::error::{MemoryError, Result};
use crate::memory::lifecycle::Scope;
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

/// Opens a pooled connection whose driver is a slot of the owner's transport group: registered before its pump starts and outstanding until the pump
/// destroyed it, so the owner's local revocation is acknowledged only once no driver of this process can write to the socket any more. The handle
/// deadpool keeps (aborted when the pooled client is dropped or discarded) cuts that one slot when it goes.
struct OwnedConnect {
    transport: Scope,
}

/// Held by the next driver a test arms it for: its drop (the driver's destruction) tells `entered` and blocks until `gate` opens.
#[cfg(test)]
pub(crate) struct DriverDropFence {
    pub entered: std::sync::mpsc::Sender<()>,
    pub gate: std::sync::mpsc::Receiver<()>,
}

#[cfg(test)]
impl Drop for DriverDropFence {
    fn drop(&mut self) {
        let _ = self.entered.send(());
        let _ = self.gate.recv();
    }
}

#[cfg(test)]
pub(crate) static DRIVER_DROP_FENCE: std::sync::Mutex<Option<DriverDropFence>> = std::sync::Mutex::new(None);

/// Cuts its driver slot when deadpool aborts or drops the connection task.
struct CutOnDrop(crate::memory::lifecycle::Owned<()>);

impl Drop for CutOnDrop {
    fn drop(&mut self) {
        self.0.cut();
    }
}

impl deadpool_postgres::Connect for OwnedConnect {
    fn connect(
        &self,
        pg_config: &Config,
    ) -> BoxFuture<'_, std::result::Result<(tokio_postgres::Client, tokio::task::JoinHandle<()>), tokio_postgres::Error>> {
        let pg_config = pg_config.clone();
        Box::pin(async move {
            // The connect itself is the slot's work: the slot is registered before the socket is opened, the connection is established inside it,
            // and the same slot then drives it. A caller that stops waiting (or a revocation) destroys the attempt with the slot, so no connect runs
            // unowned and none outlives the owner's acknowledgement.
            #[cfg(test)]
            let fence = DRIVER_DROP_FENCE.lock().unwrap_or_else(std::sync::PoisonError::into_inner).take();
            let (handed, client) = tokio::sync::oneshot::channel();
            let driver = self.transport.spawn("services.memory.pg-connection", async move {
                #[cfg(test)]
                let _fence = fence;
                #[cfg(test)]
                crate::memory::lifecycle::fences::pass("pg-connect").await;
                match pg_config.connect(NoTls).await {
                    Ok((client, connection)) => {
                        if handed.send(Ok(client)).is_ok() {
                            let _ = connection.await;
                        }
                    }
                    Err(error) => drop(handed.send(Err(error))),
                }
            });
            // Refused (the owner is revoking) or destroyed mid-connect: the pool sees a failed create. `tokio_postgres` has no public constructor
            // for another error kind.
            let Some(driver) = driver else { return Err(tokio_postgres::Error::__private_api_timeout()) };
            let mut held = CutOnDrop(driver);
            let client = match client.await {
                Ok(connected) => connected?,
                Err(_) => return Err(tokio_postgres::Error::__private_api_timeout()),
            };
            let task = mixdog_rt::spawn("services.memory.pg-driver-handle", mixdog_rt::TaskClass::Work, async move {
                let _ = (&mut held.0).await;
            });
            Ok((client, task))
        })
    }
}

fn build_pool(config: Config, size: usize, scope: &Scope) -> Result<Pool> {
    let manager = Manager::from_connect(
        config,
        OwnedConnect { transport: scope.transport() },
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

/// A pooled connection held for state-changing SQL: a transaction, a session setting or a session-level advisory lock. It is taken before the first
/// such statement and goes back to the pool only through [`Lease::release`], when no transaction it began is still open and its reset statement (if
/// any) succeeded. Dropped any other way (a failed `COMMIT`/`ROLLBACK`/reset, an error path, the future that held it cancelled or revoked by its
/// scope), the connection is discarded: the client is closed, so the abandoned work can issue no further SQL, PostgreSQL ends the open transaction
/// and releases the session's locks with the backend, and nothing open returns to the pool. No rollback is ever spawned on its behalf.
pub struct Lease {
    client: Option<Object>,
    /// A `BEGIN` was sent and no `COMMIT`/`ROLLBACK` has succeeded since.
    open: std::sync::atomic::AtomicBool,
}

impl Lease {
    pub async fn take(db: &Db) -> Result<Self> {
        Ok(Self::over(db.client().await?))
    }

    fn over(client: Object) -> Self {
        Self { client: Some(client), open: std::sync::atomic::AtomicBool::new(false) }
    }

    /// `BEGIN`: from here the lease returns to the pool only after a `COMMIT` or `ROLLBACK` succeeded.
    pub async fn begin(&self) -> std::result::Result<(), tokio_postgres::Error> {
        self.open.store(true, std::sync::atomic::Ordering::Release);
        self.batch_execute("BEGIN").await
    }

    pub async fn commit(&self) -> std::result::Result<(), tokio_postgres::Error> {
        self.end("COMMIT").await
    }

    pub async fn rollback(&self) -> std::result::Result<(), tokio_postgres::Error> {
        self.end("ROLLBACK").await
    }

    async fn end(&self, sql: &str) -> std::result::Result<(), tokio_postgres::Error> {
        self.batch_execute(sql).await?;
        self.open.store(false, std::sync::atomic::Ordering::Release);
        Ok(())
    }

    /// Ends the lease: `reset` undoes the session state it set, then the connection goes back to the pool. A transaction still open or a reset that
    /// failed discards it instead.
    pub async fn release(mut self, reset: Option<&str>) {
        if self.open.load(std::sync::atomic::Ordering::Acquire) {
            return;
        }
        if let Some(sql) = reset
            && self.batch_execute(sql).await.is_err()
        {
            return;
        }
        drop(self.client.take());
    }
}

impl std::ops::Deref for Lease {
    type Target = Object;

    fn deref(&self) -> &Object {
        self.client.as_ref().expect("a lease holds its connection until it ends")
    }
}

impl Drop for Lease {
    fn drop(&mut self) {
        if let Some(client) = self.client.take() {
            drop(Object::take(client));
        }
    }
}

/// A session-scoped advisory lock on a dedicated connection; released by
/// `unlock`. A connection whose unlock failed, or whose holder was cancelled, is discarded, never pooled
/// (PostgreSQL releases the lock with the backend).
async fn with_cluster_lock<T, F>(pool: &Pool, object: i32, body: F) -> Result<T>
where
    F: AsyncFnOnce(&Object) -> Result<T>,
{
    let lease = Lease::over(pool.get().await?);
    // The wait for another process's first-boot DDL is longer than a row-lock wait; the
    // session returns to the pool budget when the lock is released.
    lease
        .batch_execute(&format!(
            "SET lock_timeout = {}",
            BUDGET.cluster_lock.as_millis()
        ))
        .await?;
    lease
        .execute("SELECT pg_advisory_lock($1, $2)", &[&LOCK_CLASS, &object])
        .await?;
    let result = body(&lease).await;
    if lease.execute("SELECT pg_advisory_unlock($1, $2)", &[&LOCK_CLASS, &object]).await.is_ok() {
        lease.release(Some("RESET lock_timeout")).await;
    }
    result
}

/// Runs `work` inside the stores' transaction on one leased connection, with their statement text (`BEGIN`, then
/// `COMMIT`, or `ROLLBACK` when `work` fails: core-memory-store.mjs:154-185). A connection whose transaction did not
/// end (a failed `COMMIT` or `ROLLBACK`, or a call dropped part-way) is discarded, never pooled ([`Lease`]).
pub async fn transaction<T>(db: &Db, work: impl AsyncFnOnce(&Object) -> Result<T>) -> Result<T> {
    let lease = Lease::take(db).await?;
    lease.begin().await?;
    match work(&lease).await {
        Ok(value) => {
            lease.commit().await?;
            lease.release(None).await;
            Ok(value)
        }
        // The failure is the call's, never the rollback's (Node ignores a failed `ROLLBACK`).
        Err(error) => {
            if lease.rollback().await.is_ok() {
                lease.release(None).await;
            }
            Err(error)
        }
    }
}

/// Creates the database and the cluster-wide extension once per call; both
/// statements are idempotent and serialised by cluster advisory locks.
async fn bootstrap(cluster: &PgCluster, scope: &Scope) -> Result<()> {
    let admin = build_pool(config(cluster.port(), "postgres", None), 1, scope)?;
    with_cluster_lock(&admin, LOCK_CREATE_DB, async |client| {
        let exists = client.query_opt("SELECT 1 FROM pg_database WHERE datname = $1", &[&DATABASE]).await?;
        if exists.is_none() {
            client.batch_execute(&format!("CREATE DATABASE {DATABASE}")).await?;
        }
        Ok(())
    })
    .await?;
    admin.close();
    bootstrap_schemas(cluster.port(), DATABASE, scope).await
}

/// The extension and the schemas of `database` (idempotent, serialised by the cluster advisory lock of first-boot DDL).
async fn bootstrap_schemas(port: u16, database: &str, scope: &Scope) -> Result<()> {
    let setup = build_pool(config(port, database, None), 1, scope)?;
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

/// When the opening a deferred [`Db`]'s use waits on was launched (Node's spawn of the memory child, which every request that arrives while it runs shares).
pub type OpeningSince = Arc<dyn Fn() -> Option<tokio::time::Instant> + Send + Sync>;

/// The pool of a [`Db`]: open from the start, or asked of its opener at every use. A deferred handle keeps no pool of its own: its opener (the memory
/// stack's) shares one opening among the uses that arrive while it runs, forgets a failed one, and refuses every use once the stack stops, as Node's
/// pool lookup goes through `ensurePgInstance` (`supervisor.mjs:647-665`).
#[derive(Clone)]
enum PoolSource {
    Open(Pool),
    Deferred(PoolOpener, OpeningSince),
}

/// A bounded pool of connections with the schema's `search_path`, and the lifecycle owner every task working through it registers in
/// ([`Db::scope`]): the memory stack gives all its handles its one scope, so its stop seals, waits for and revokes that work.
#[derive(Clone)]
pub struct Db {
    pool: PoolSource,
    schema: Schema,
    scope: Scope,
}

impl Db {
    /// Opens the schema's pool, creating the database and extension first. The bootstrap connections and every pooled connection's driver are
    /// `scope`'s transport, and the handle's work is `scope`'s.
    pub async fn open(cluster: &PgCluster, schema: Schema, scope: Scope) -> Result<Self> {
        bootstrap(cluster, &scope).await?;
        let path = format!("{}, public", schema.name());
        let pool = build_pool(config(cluster.port(), DATABASE, Some(&path)), POOL_SIZE, &scope)?;
        Ok(Self { pool: PoolSource::Open(pool), schema, scope })
    }

    /// A deferred handle with its work owned by `scope` (an open handle's pool belongs to the scope it was opened with).
    pub fn with_scope(mut self, scope: Scope) -> Self {
        debug_assert!(matches!(self.pool, PoolSource::Deferred(..)), "an open pool's drivers belong to the scope it was opened with");
        self.scope = scope;
        self
    }

    /// The owner of the work done through this handle.
    pub fn scope(&self) -> &Scope {
        &self.scope
    }

    /// A handle over `database` of the cluster on `port`, which already holds the extension and the schemas of a bootstrap
    /// (a database made from the shared test cluster's template): no cluster start, no bootstrap.
    #[cfg(test)]
    pub(crate) fn open_in(port: u16, database: &str, schema: Schema) -> Result<Self> {
        let path = format!("{}, public", schema.name());
        let scope = Scope::new();
        Ok(Self { pool: PoolSource::Open(build_pool(config(port, database, Some(&path)), POOL_SIZE, &scope)?), schema, scope })
    }

    /// What `open` makes of a new cluster's `database`: the extension and the schemas.
    #[cfg(test)]
    pub(crate) async fn bootstrap_database(port: u16, database: &str) -> Result<()> {
        bootstrap_schemas(port, database, &Scope::new()).await
    }

    /// An open handle of `scope` whose pool has not connected (a pool connects at its first use).
    #[cfg(test)]
    pub(crate) fn unconnected(port: u16, schema: Schema, scope: Scope) -> Self {
        Self { pool: PoolSource::Open(build_pool(config(port, DATABASE, None), POOL_SIZE, &scope).expect("pool")), schema, scope }
    }

    /// A handle whose pool `opener` hands over at each use; `since` tells when the opening a use waits on was launched.
    pub fn deferred(schema: Schema, opener: PoolOpener, since: OpeningSince) -> Self {
        Self { pool: PoolSource::Deferred(opener, since), schema, scope: Scope::new() }
    }

    /// The pool of a handle that is already open (what a deferred handle's opener hands over).
    pub(crate) fn opened_pool(&self) -> Pool {
        match &self.pool {
            PoolSource::Open(pool) => pool.clone(),
            PoolSource::Deferred(..) => unreachable!("only an open handle is handed over"),
        }
    }

    async fn pool(&self) -> Result<Pool> {
        match &self.pool {
            PoolSource::Open(pool) => Ok(pool.clone()),
            PoolSource::Deferred(open, _) => open().await,
        }
    }

    /// Waits for the handle's pool until `limit` after the launch of the opening it waits on (opening it when nobody has): `Err` when the opening failed
    /// or was still running then. The opening itself goes on; a later use finds it open.
    pub async fn ready_within(&self, limit: std::time::Duration) -> Result<()> {
        let PoolSource::Deferred(open, since) = &self.pool else { return Ok(()) };
        let mut opening = open();
        // The first poll joins or launches the opening, so its launch time is known after it.
        if let std::task::Poll::Ready(outcome) = futures::poll!(&mut opening) {
            return outcome.map(drop);
        }
        let deadline = since().unwrap_or_else(tokio::time::Instant::now) + limit;
        match mixdog_rt::time::timeout_at(deadline, opening).await {
            Ok(outcome) => outcome.map(drop),
            Err(_) => Err(MemoryError::Runtime(format!("the memory database did not open within {} s of its opening", limit.as_secs()))),
        }
    }

    pub fn schema(&self) -> Schema {
        self.schema
    }

    pub async fn client(&self) -> Result<Object> {
        Ok(self.pool().await?.get().await?)
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
        with_cluster_lock(&self.pool().await?, LOCK_SCHEMA_BOOTSTRAP, async |_| self.batch(ddl).await).await
    }

    /// Closes an open handle's pool; a deferred handle has none of its own (its opener's owner closes the pool it hands over).
    pub fn close(&self) {
        if let PoolSource::Open(pool) = &self.pool {
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
        mixdog_rt::testing::tokens();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let silent = tokio::spawn(async move {
            let mut held = Vec::new();
            while let Ok((socket, _)) = listener.accept().await {
                held.push(socket);
            }
        });
        let pool = build_pool(config(port, DATABASE, Some("memory, public")), 1, &Scope::new()).unwrap();
        let outcome = mixdog_rt::time::timeout(BUDGET.connect * 3, pool.get()).await;
        assert!(
            matches!(outcome, Ok(Err(_))),
            "the budget ends the checkout, the test timeout does not"
        );
        silent.abort();
    }

    /// A use waiting for a deferred opening gets the pool when the opening ends inside the limit counted from its launch, and an error at the limit when
    /// it has not; a use that joins later is held to the same launch.
    #[tokio::test(start_paused = true)]
    async fn a_use_waits_for_the_opening_until_the_limit_after_its_launch() {
        use std::sync::Mutex;
        const LIMIT: Duration = Duration::from_secs(90);
        let launched = tokio::time::Instant::now();
        let gate: Arc<Mutex<Option<tokio::sync::watch::Receiver<bool>>>> = Arc::new(Mutex::new(None));
        let (open_up, opened) = tokio::sync::watch::channel(false);
        *gate.lock().unwrap() = Some(opened);
        let waiting = gate.clone();
        let opener: PoolOpener = Arc::new(move || {
            let mut opened = waiting.lock().unwrap().clone().expect("the gate");
            Box::pin(async move {
                let _ = opened.wait_for(|open| *open).await;
                build_pool(config(1, DATABASE, None), 1, &Scope::new())
            })
        });
        let db = Db::deferred(Schema::Memory, opener, Arc::new(move || Some(launched)));

        // Inside the limit: the opening ends 1 ms before it, the use gets the pool.
        let mut first = Box::pin(db.ready_within(LIMIT));
        assert!(futures::poll!(&mut first).is_pending());
        tokio::time::advance(LIMIT - Duration::from_millis(1)).await;
        assert!(futures::poll!(&mut first).is_pending(), "still within the limit");
        open_up.send(true).unwrap();
        assert!(matches!(futures::poll!(&mut first), std::task::Poll::Ready(Ok(()))), "the opening ended inside the limit");

        // Past the limit of the same launch: a use that arrives now is not given a new 90 s.
        open_up.send(false).unwrap();
        let mut late = Box::pin(db.ready_within(LIMIT));
        assert!(futures::poll!(&mut late).is_pending());
        tokio::time::advance(Duration::from_millis(1)).await;
        match futures::poll!(&mut late) {
            std::task::Poll::Ready(Err(error)) => assert!(error.message().contains("did not open within 90 s"), "{}", error.message()),
            other => panic!("the use is answered at the launch's limit: {:?}", other.map(|outcome| outcome.is_ok())),
        }
    }
}
