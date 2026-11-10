//! `memory` `action:"status"` (`maintenance-actions.mjs` `status`): entry counts, the cycle1
//! backlog, the embedding index and the last cycle1 run, one line each.

use serde_json::Value;

use crate::memory::cycles::scheduler::read_last_run;
use crate::memory::error::Result;
use crate::memory::pg::db::Db;
use crate::memory::reply::ToolReply;
use crate::memory::schema::{DIMS_KEY, get_meta, is_bootstrap_complete};

/// `agoText`.
fn ago(ts: f64, now: f64) -> String {
    if ts == 0.0 { "never".to_owned() } else { format!("{}m ago", ((now - ts) / 60_000.0 + 0.5).floor()) }
}

/// `embeddingDims`: a meta read failure is shown, not mistaken for a fresh store.
async fn embedding_dims(db: &Db) -> (f64, Option<String>) {
    match get_meta(db, DIMS_KEY).await {
        Ok(value) => {
            let dims = match value {
                Some(Value::Number(n)) => n.as_f64().unwrap_or(0.0),
                Some(Value::String(s)) => mixdog_js::js_trim(&s).parse::<f64>().unwrap_or(f64::NAN),
                _ => 0.0,
            };
            (if dims.is_finite() { dims } else { 0.0 }, None)
        }
        Err(error) => (0.0, Some(error.message())),
    }
}

fn pairs(rows: &[tokio_postgres::Row], missing: &str) -> String {
    let text = rows
        .iter()
        .map(|row| format!("{}:{}", row.get::<_, Option<String>>(0).as_deref().unwrap_or(missing), row.get::<_, i64>(1)))
        .collect::<Vec<_>>()
        .join(", ");
    if text.is_empty() { "empty".to_owned() } else { text }
}

async fn readout(db: &Db, now: f64) -> Result<String> {
    let counts = db
        .query(
            "SELECT (SELECT COUNT(*) FROM entries), (SELECT COUNT(*) FROM entries WHERE is_root = 1), \
             (SELECT COUNT(*) FROM entries WHERE chunk_root IS NULL), (SELECT COUNT(*) FROM core_entries)",
            &[],
        )
        .await?;
    let row = &counts[0];
    let (total, roots, unchunked, core) = (row.get::<_, i64>(0), row.get::<_, i64>(1), row.get::<_, i64>(2), row.get::<_, i64>(3));
    let by_status = db.query("SELECT status::text, COUNT(*) c FROM entries WHERE is_root = 1 GROUP BY status", &[]).await?;
    let by_category =
        db.query("SELECT category, COUNT(*) c FROM entries WHERE is_root = 1 GROUP BY category ORDER BY c DESC", &[]).await?;
    let last = read_last_run(db).await;
    let (dims, dims_error) = embedding_dims(db).await;
    let bootstrap = if is_bootstrap_complete(db).await { "complete" } else { "incomplete" };
    let dims_error = dims_error.map(|e| format!(" (meta_read_error: {e})")).unwrap_or_default();
    Ok([
        format!("entries: total={total} roots={roots} cycle1_raw={unchunked} (unchunked leaves)"),
        format!("status: {}", pairs(&by_status, "?")),
        format!("categories: {}", pairs(&by_category, "NULL")),
        format!("core_memory: user={core}"),
        format!("embedding_index: ready dims={dims}{dims_error}"),
        format!("bootstrap: {bootstrap}"),
        format!("last_cycle1: {}", ago(last.cycle1, now)),
    ]
    .join("\n"))
}

pub async fn status(db: &Db) -> ToolReply {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0.0, |d| d.as_millis() as f64);
    match readout(db, now).await {
        Ok(text) => ToolReply::ok(text),
        Err(error) => ToolReply::error(format!("status failed: {}", error.message())),
    }
}
