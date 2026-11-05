//! Connection pool over one schema of the `mixdog` database. Every pooled
//! connection has its `search_path` pinned to the owning schema, so
//! unqualified table names resolve there; a query that touches another schema
//! qualifies the name.

use deadpool_postgres::{Manager, ManagerConfig, Object, Pool, RecyclingMethod};
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

fn config(port: u16, database: &str, search_path: Option<&str>) -> Config {
    let mut config = Config::new();
    config.host("127.0.0.1").port(port).user(USER).dbname(database);
    if let Some(path) = search_path {
        config.options(format!("-c search_path={}", path.replace(' ', "\\ ")));
    }
    config
}

fn build_pool(config: Config, size: usize) -> Result<Pool> {
    let manager =
        Manager::from_config(config, NoTls, ManagerConfig { recycling_method: RecyclingMethod::Fast });
    Pool::builder(manager).max_size(size).build().map_err(|error| MemoryError::Pool(error.to_string()))
}

/// A session-scoped advisory lock on a dedicated connection; released by
/// `unlock`. A connection whose unlock failed is dropped, never pooled.
async fn with_cluster_lock<T, F>(pool: &Pool, object: i32, body: F) -> Result<T>
where
    F: AsyncFnOnce(&Object) -> Result<T>,
{
    let client = pool.get().await?;
    client.execute("SELECT pg_advisory_lock($1, $2)", &[&LOCK_CLASS, &object]).await?;
    let result = body(&client).await;
    match client.execute("SELECT pg_advisory_unlock($1, $2)", &[&LOCK_CLASS, &object]).await {
        Ok(_) => {}
        Err(_) => {
            let _ = Object::take(client);
        }
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

/// A bounded pool of connections with the schema's `search_path`.
#[derive(Clone)]
pub struct Db {
    pool: Pool,
    schema: Schema,
}

impl Db {
    /// Opens the schema's pool, creating the database and extension first.
    pub async fn open(cluster: &PgCluster, schema: Schema) -> Result<Self> {
        bootstrap(cluster).await?;
        let path = format!("{}, public", schema.name());
        let pool = build_pool(config(cluster.port(), DATABASE, Some(&path)), POOL_SIZE)?;
        Ok(Self { pool, schema })
    }

    pub fn schema(&self) -> Schema {
        self.schema
    }

    pub async fn client(&self) -> Result<Object> {
        Ok(self.pool.get().await?)
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
        with_cluster_lock(&self.pool, LOCK_SCHEMA_BOOTSTRAP, async |_| self.batch(ddl).await).await
    }

    pub fn close(&self) {
        self.pool.close();
    }
}

impl std::fmt::Debug for Db {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Db").field("schema", &self.schema).finish()
    }
}
