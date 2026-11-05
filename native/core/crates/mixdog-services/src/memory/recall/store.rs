//! Query helpers of the recall read path.

use crate::memory::error::Result;
use crate::memory::pg::db::Db;
use crate::memory::recall::row::{P, Row, refs};

/// Statements of the hybrid read path run inside a transaction so a runaway
/// scan is cut at 30 seconds instead of holding a connection.
pub async fn read_query_pg(db: &Db, sql: &str, params: &[P]) -> Result<Vec<tokio_postgres::Row>> {
    let mut client = db.client().await?;
    let tx = client.transaction().await?;
    tx.batch_execute("SET LOCAL statement_timeout = '30s'").await?;
    let rows = tx.query(sql, &refs(params)).await?;
    tx.commit().await?;
    Ok(rows)
}

pub async fn read_query(db: &Db, sql: &str, params: &[P]) -> Result<Vec<Row>> {
    Ok(read_query_pg(db, sql, params).await?.iter().map(Row::from_pg).collect())
}

/// A single statement without the read-path timeout.
pub async fn query(db: &Db, sql: &str, params: &[P]) -> Result<Vec<Row>> {
    Ok(db.client().await?.query(sql, &refs(params)).await?.iter().map(Row::from_pg).collect())
}

pub async fn query_pg(db: &Db, sql: &str, params: &[P]) -> Result<Vec<tokio_postgres::Row>> {
    Ok(db.client().await?.query(sql, &refs(params)).await?)
}
