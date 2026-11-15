//! The earlier daemon's trace database, read for the usage rows it still holds. The database is
//! opened as it was left (a running cluster named by its `postmaster.pid`), in one read-only
//! repeatable-read transaction, and nothing in it is changed or repaired. A cluster that is
//! named but cannot be reached is an error, not absence: importing without it would mark a
//! history complete that is not.

use std::future::Future;
use std::pin::Pin;
use std::task::Poll;
use std::time::Duration;

use serde_json::Map;
use serde_json::Value;
use tokio_postgres::Config;
use tokio_postgres::NoTls;
use tokio_postgres::Row;

use crate::error::LedgerError;
use crate::error::Result;

pub type TraceFuture<'a> = Pin<Box<dyn Future<Output = Result<Vec<Value>>> + Send + 'a>>;

/// Where the `usage_raw` rows older than `until` come from. Each row is shaped like a line of
/// `agent-trace.jsonl`.
pub trait OriginalTrace: Send + Sync + 'static {
    /// `pid_file` is the text of `pgdata/postmaster.pid`.
    fn rows<'a>(&'a self, pid_file: &'a str, until: i64) -> TraceFuture<'a>;
}

/// The cluster the earlier daemon kept under `pgdata`.
pub struct Postgres;

impl OriginalTrace for Postgres {
    fn rows<'a>(&'a self, pid_file: &'a str, until: i64) -> TraceFuture<'a> {
        Box::pin(read_postgres(pid_file, until))
    }
}

const CONNECT_LIMIT: Duration = Duration::from_millis(5_000);

const SELECT_TRACE: &str = "SELECT ts::text, kind::text, model::text, session_id::text,
        input_tokens::float8, output_tokens::float8, cached_tokens::float8, cache_write_tokens::float8,
        duration_ms::float8,
        jsonb_build_object(
            'provider', payload->'provider',
            'requested_model', payload->'requested_model',
            'pricing_model', payload->'pricing_model',
            'uncached_input_tokens', payload->'uncached_input_tokens',
            'response_id', payload->'response_id',
            'service_tier', payload->'service_tier',
            'sourceType', payload->'sourceType',
            'source_type', payload->'source_type'
        )::text
    FROM trace.trace_events WHERE kind='usage_raw' AND ts < $1::bigint ORDER BY ts, id";

fn failed(error: impl std::fmt::Display) -> LedgerError {
    LedgerError::History(error.to_string())
}

/// The port on the fourth line of `postmaster.pid`.
fn port_of(pid_file: &str) -> Result<u16> {
    let field = mixdog_js::js_trim_end(pid_file)
        .split('\n')
        .nth(3)
        .map(|line| line.strip_suffix('\r').unwrap_or(line));
    let port = field.map_or(f64::NAN, mixdog_js::string_to_number);
    if port.fract() == 0.0 && (1.0..=65_535.0).contains(&port) {
        Ok(port as u16)
    } else {
        Err(LedgerError::History("Invalid trace database port".to_owned()))
    }
}

/// Drives `work` while the connection it runs on is polled beside it; a connection that ends
/// first ends the work.
async fn driven<T>(
    connection: impl Future<Output = std::result::Result<(), tokio_postgres::Error>>,
    work: impl Future<Output = std::result::Result<T, tokio_postgres::Error>>,
) -> Result<T> {
    let mut connection = std::pin::pin!(connection);
    let mut work = std::pin::pin!(work);
    std::future::poll_fn(|cx| {
        if let Poll::Ready(done) = work.as_mut().poll(cx) {
            return Poll::Ready(done.map_err(failed));
        }
        match connection.as_mut().poll(cx) {
            Poll::Ready(Err(error)) => Poll::Ready(Err(failed(error))),
            Poll::Ready(Ok(())) => Poll::Ready(Err(LedgerError::History(
                "the trace database closed the connection".to_owned(),
            ))),
            Poll::Pending => Poll::Pending,
        }
    })
    .await
}

fn trace_row(row: &Row) -> Result<Value> {
    let text = |index: usize| row.try_get::<_, Option<String>>(index).map_err(failed);
    let number = |index: usize| {
        row.try_get::<_, Option<f64>>(index)
            .map_err(failed)
            .map(|value| value.map_or(Value::Null, mixdog_js::json_number))
    };
    let string = |value: Option<String>| value.map_or(Value::Null, Value::String);
    let mut out = Map::new();
    out.insert("ts".to_owned(), string(text(0)?));
    out.insert("kind".to_owned(), string(text(1)?));
    out.insert("model".to_owned(), string(text(2)?));
    out.insert("session_id".to_owned(), string(text(3)?));
    out.insert("input_tokens".to_owned(), number(4)?);
    out.insert("output_tokens".to_owned(), number(5)?);
    out.insert("cached_tokens".to_owned(), number(6)?);
    out.insert("cache_write_tokens".to_owned(), number(7)?);
    out.insert("duration_ms".to_owned(), number(8)?);
    let payload = match text(9)? {
        Some(payload) => serde_json::from_str(&payload)?,
        None => Value::Null,
    };
    out.insert("payload".to_owned(), payload);
    Ok(Value::Object(out))
}

async fn read_postgres(pid_file: &str, until: i64) -> Result<Vec<Value>> {
    let port = port_of(pid_file)?;
    let mut config = Config::new();
    config
        .host("127.0.0.1")
        .port(port)
        .user("postgres")
        .dbname("mixdog")
        .application_name("mixdog-usage-import-readonly")
        .options("-c default_transaction_read_only=on -c statement_timeout=30000");
    // The limit covers the whole opening (`connectionTimeoutMillis`), the startup exchange included:
    // a port a stale pid file names may answer the connect and then say nothing.
    let (client, connection) = mixdog_rt::time::timeout(CONNECT_LIMIT, config.connect(NoTls))
        .await
        .map_err(|_| LedgerError::History("Connection terminated due to connection timeout".to_owned()))?
        .map_err(failed)?;
    let work = async {
        client
            .batch_execute("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
            .await?;
        let table = client
            .query_one("SELECT to_regclass('trace.trace_events')::text", &[])
            .await?;
        let rows = if table.get::<_, Option<String>>(0).is_some() {
            client.query(SELECT_TRACE, &[&until]).await?
        } else {
            Vec::new()
        };
        client.batch_execute("COMMIT").await?;
        Ok::<_, tokio_postgres::Error>(rows)
    };
    let rows = driven(connection, work).await?;
    rows.iter().map(trace_row).collect()
}
