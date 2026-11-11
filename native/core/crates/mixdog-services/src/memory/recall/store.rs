//! Query helpers of the recall read path.

use crate::memory::error::Result;
use crate::memory::pg::db::Db;
use crate::memory::recall::row::{P, Row, refs};

/// Statements of the hybrid read path run inside a transaction so a runaway
/// scan is cut at 30 seconds instead of holding a connection.
pub async fn read_query_pg(db: &Db, sql: &str, params: &[P]) -> Result<Vec<tokio_postgres::Row>> {
    #[cfg(test)]
    observe_read(sql, params);
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
    #[cfg(test)]
    observe(sql, params);
    Ok(db.client().await?.query(sql, &refs(params)).await?.iter().map(Row::from_pg).collect())
}

pub async fn query_pg(db: &Db, sql: &str, params: &[P]) -> Result<Vec<tokio_postgres::Row>> {
    #[cfg(test)]
    observe(sql, params);
    Ok(db.client().await?.query(sql, &refs(params)).await?)
}

#[cfg(test)]
thread_local! {
    /// When set, every recall statement sent on this thread, in order, as Node's `db.query` calls (a read-path statement
    /// is preceded by its `SET LOCAL`).
    pub(crate) static STATEMENTS: std::cell::RefCell<Option<Vec<(String, Vec<P>)>>> = const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
pub(crate) fn observe(sql: &str, params: &[P]) {
    STATEMENTS.with(|log| {
        if let Some(log) = log.borrow_mut().as_mut() {
            log.push((sql.to_owned(), params.to_vec()));
        }
    });
}

#[cfg(test)]
pub(crate) fn observe_read(sql: &str, params: &[P]) {
    observe("SET LOCAL statement_timeout = '30s'", &[]);
    observe(sql, params);
}
