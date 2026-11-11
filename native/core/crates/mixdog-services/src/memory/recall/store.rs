//! Query helpers of the recall read path.

use crate::memory::error::Result;
use crate::memory::pg::db::Db;
use crate::memory::recall::row::{P, Row, refs};

/// Statements of the hybrid read path run inside a transaction so a runaway
/// scan is cut at 30 seconds instead of holding a connection.
pub async fn read_query_pg(db: &Db, sql: &str, params: &[P]) -> Result<Vec<tokio_postgres::Row>> {
    const TIMEOUT: &str = "SET LOCAL statement_timeout = '30s'";
    let mut client = db.client().await?;
    let tx = client.transaction().await?;
    #[cfg(test)]
    observe(TIMEOUT, &[]);
    tx.batch_execute(TIMEOUT).await?;
    #[cfg(test)]
    observe(sql, params);
    let rows = tx.query(sql, &refs(params)).await?;
    tx.commit().await?;
    #[cfg(test)]
    ANSWERS.with(|answers| {
        if let Some(answers) = answers.borrow_mut().as_mut() {
            answers.push(rows.iter().map(crate::memory::replays::pg::node_pg_row).collect());
        }
    });
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
    /// When set, the rows PostgreSQL answered each read-path statement on this thread with, as node-pg gives them.
    pub(crate) static ANSWERS: std::cell::RefCell<Option<Vec<Vec<mixdog_testkit::Exact>>>> = const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
pub(crate) fn observe(sql: &str, params: &[P]) {
    STATEMENTS.with(|log| {
        if let Some(log) = log.borrow_mut().as_mut() {
            log.push((sql.to_owned(), params.to_vec()));
        }
    });
}
