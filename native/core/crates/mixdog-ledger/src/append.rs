//! The append path (`UsageLedger.record`): each record, its route/session interning, its
//! request-log facts and its `daily`/`day_sessions` totals commit in one transaction. The
//! per-session day sums and the revision counters move by trigger, inside the same
//! transaction, for every writer.

use serde::Deserialize;
use serde_json::Value;

use crate::db::Connection;
use crate::db::OptionalExtension;
use crate::db::Transaction;
use crate::db::TransactionBehavior;
use crate::db::params;
use crate::error::LedgerError;
use crate::error::Result;
use crate::measure::NO_USAGE_COST_SOURCE;
use crate::measure::is_conversation_source;
use crate::time::day_number;

/// Largest append transaction (SM §10.1: event batches are ≤ 512 rows).
pub const MAX_APPEND_ROWS: usize = 512;

/// A finished usage record, as `makeUsageRecord` produces it. Numbers and attribution only.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageRecord {
    /// A 64-char lowercase hex digest, or any request id.
    pub id: String,
    pub ts: i64,
    /// Local calendar day, `YYYY-MM-DD`.
    pub day: String,
    pub provider: String,
    pub model: String,
    pub kind: String,
    pub session_id: String,
    #[serde(default)]
    pub owner_session_id: Option<String>,
    pub source_type: String,
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
    pub cache_write: f64,
    pub cost_usd: Option<f64>,
    pub cost_source: String,
    /// The price snapshot as JSON text, serialized once by its producer (its field order is
    /// part of the route signature).
    #[serde(default)]
    pub rates: Option<String>,
    pub origin: String,
    pub duration_ms: f64,
    /// The provider account; a record without one keeps the route it always had.
    #[serde(default)]
    pub account: String,
    /// Empty unless the answering model differs from the one asked for.
    #[serde(default)]
    pub requested_model: String,
    /// Empty unless a route-fallback hop asked another provider.
    #[serde(default)]
    pub requested_provider: String,
    #[serde(default = "completed")]
    pub status: String,
    #[serde(default = "one")]
    pub attempts: u32,
    #[serde(default)]
    pub ttft_ms: Option<f64>,
    #[serde(default)]
    pub elapsed_ms: f64,
}

fn completed() -> String {
    "completed".to_string()
}

fn one() -> u32 {
    1
}

/// The stored form of a record id: a tag byte (`0` hex digest, `1` UTF-8 text) then the
/// identifier in full, so arbitrary request ids stay disjoint from digests.
pub fn encode_usage_id(id: &str) -> Vec<u8> {
    let is_digest = id.len() == 64
        && id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    if is_digest {
        let mut out = vec![0u8];
        out.extend(
            (0..64)
                .step_by(2)
                .map(|i| u8::from_str_radix(&id[i..i + 2], 16).unwrap_or(0)),
        );
        out
    } else {
        let mut out = vec![1u8];
        out.extend(id.as_bytes());
        out
    }
}

/// A request's route signature: `[provider, model, kind, sourceType, costSource, rates,
/// origin, rank, account?]`.
pub fn route_signature(row: &UsageRecord) -> Result<String> {
    let mut parts = vec![
        Value::from(row.provider.as_str()),
        Value::from(row.model.as_str()),
        Value::from(row.kind.as_str()),
        Value::from(row.source_type.as_str()),
        Value::from(row.cost_source.as_str()),
        row.rates.as_deref().map_or(Value::Null, Value::from),
        Value::from(row.origin.as_str()),
        Value::from(rank_of(row)),
    ];
    if !row.account.is_empty() {
        parts.push(Value::from(row.account.as_str()));
    }
    Ok(mixdog_js::json_stringify(&Value::Array(parts)))
}

/// A gateway summary ranks below the detail it summarizes.
fn rank_of(row: &UsageRecord) -> i64 {
    i64::from(row.origin == "gateway")
}

fn validate(row: &UsageRecord) -> Result<()> {
    let day = row.day.as_bytes();
    let calendar = day.len() == 10
        && day.iter().enumerate().all(|(i, b)| match i {
            4 | 7 => *b == b'-',
            _ => b.is_ascii_digit(),
        });
    if calendar {
        Ok(())
    } else {
        Err(LedgerError::Invalid("a calendar day"))
    }
}

fn intern(tx: &Transaction, table: &'static str, column: &'static str, value: &str) -> Result<i64> {
    tx.prepare_cached(&format!(
        "INSERT OR IGNORE INTO {table}({column}) VALUES (?1)"
    ))?
    .execute([value])?;
    Ok(tx
        .prepare_cached(&format!("SELECT id FROM {table} WHERE {column} = ?1"))?
        .query_row([value], |r| r.get(0))?)
}

fn metadata(tx: &Transaction, key: &str) -> Result<Option<String>> {
    Ok(tx
        .prepare_cached("SELECT value FROM metadata WHERE key = ?1")?
        .query_row([key], |r| r.get(0))
        .optional()?)
}

/// Inserts one record unless its id is already stored; `false` for a duplicate.
fn insert_event(tx: &Transaction, row: &UsageRecord) -> Result<bool> {
    validate(row)?;
    let id = encode_usage_id(&row.id);
    let known: Option<i64> = tx
        .prepare_cached("SELECT 1 FROM usage_events WHERE id = ?1")?
        .query_row([&id], |r| r.get(0))
        .optional()?;
    if known.is_some() {
        return Ok(false);
    }
    let route = intern(tx, "usage_routes", "signature", &route_signature(row)?)?;
    let session = intern(tx, "usage_sessions", "value", &row.session_id)?;
    if let Some(owner) = row
        .owner_session_id
        .as_deref()
        .filter(|o| !o.is_empty() && *o != row.session_id)
    {
        let owner = intern(tx, "usage_sessions", "value", owner)?;
        tx.prepare_cached("INSERT OR IGNORE INTO usage_session_owners VALUES (?1, ?2)")?
            .execute(params![session, owner])?;
    }
    tx.prepare_cached("INSERT INTO usage_events VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)")?
        .execute(params![
            id,
            row.ts,
            day_number(&row.day)?,
            route,
            session,
            row.input,
            row.output,
            row.cache_read,
            row.cache_write,
            row.cost_usd,
            row.duration_ms,
        ])?;
    // Request-log facts live beside the record; a completed single attempt with nothing
    // else to say needs no row.
    let requested = (!row.requested_model.is_empty()).then_some(row.requested_model.as_str());
    let elapsed = (row.elapsed_ms != 0.0).then_some(row.elapsed_ms);
    if row.status != "completed" || row.attempts > 1 || requested.is_some() || elapsed.is_some() {
        tx.prepare_cached("INSERT INTO usage_requests VALUES (?1,?2,?3,?4,?5,?6,?7)")?
            .execute(params![
                id,
                row.ts,
                requested,
                row.status,
                row.attempts,
                None::<f64>,
                elapsed
            ])?;
    }
    if let Some(ttft) = row.ttft_ms {
        tx.prepare_cached("INSERT INTO usage_request_first_output VALUES (?1, ?2)")?
            .execute(params![id, ttft])?;
    }
    if !row.requested_provider.is_empty() {
        tx.prepare_cached("INSERT INTO usage_request_requested_provider VALUES (?1, ?2)")?
            .execute(params![id, row.requested_provider])?;
    }
    Ok(true)
}

/// The record's contribution to the imported-or-live `daily` and `day_sessions` totals.
pub(crate) fn index_event(tx: &Transaction, row: &UsageRecord, rank: i64) -> Result<()> {
    if row.cost_source == NO_USAGE_COST_SOURCE {
        return Ok(());
    }
    let conversation = is_conversation_source(Some(&row.source_type));
    tx.prepare_cached(
        "INSERT INTO daily VALUES (?1,?2,?3,?4,?5,?6,?7,1,?8,?9,?10,?11,?12,?13,?14)
         ON CONFLICT(day,rank,provider,model,kind,cost_source,conversation) DO UPDATE SET
         turns=turns+excluded.turns, input=input+excluded.input, output=output+excluded.output,
         cache_read=cache_read+excluded.cache_read, cache_write=cache_write+excluded.cache_write,
         cost_usd=cost_usd+excluded.cost_usd, duration_ms=duration_ms+excluded.duration_ms,
         imported=MAX(imported,excluded.imported)",
    )?
    .execute(params![
        row.day,
        rank,
        row.provider,
        row.model,
        row.kind,
        row.cost_source,
        conversation,
        row.input,
        row.output,
        row.cache_read,
        row.cache_write,
        row.cost_usd.unwrap_or(0.0),
        row.duration_ms,
        row.origin != "live",
    ])?;
    if conversation && !row.session_id.is_empty() {
        tx.prepare_cached(
            "INSERT INTO day_sessions VALUES (?1,?2,?3,?4)
             ON CONFLICT(day,rank,session_id) DO UPDATE SET tokens=tokens+excluded.tokens",
        )?
        .execute(params![
            row.day,
            rank,
            row.session_id,
            row.input + row.output + row.cache_read + row.cache_write,
        ])?;
    }
    Ok(())
}

/// Appends `rows` in one transaction; `true` per row that was new. A failure rolls the whole
/// batch back.
fn append_tx(conn: &mut Connection, rows: &[UsageRecord]) -> Result<Vec<bool>> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let mut inserted = Vec::with_capacity(rows.len());
    for row in rows {
        let new = insert_event(&tx, row)?;
        if new {
            index_event(&tx, row, rank_of(row))?;
            if row.origin == "live" && metadata(&tx, "liveSince")?.is_none() {
                tx.prepare_cached("INSERT INTO metadata VALUES ('liveSince', ?1)")?
                    .execute([row.ts.to_string()])?;
            }
        }
        inserted.push(new);
    }
    tx.commit()?;
    Ok(inserted)
}

/// Appends `rows` in one transaction; returns how many were new.
pub fn append_batch(conn: &mut Connection, rows: &[UsageRecord]) -> Result<usize> {
    Ok(append_tx(conn, rows)?
        .into_iter()
        .filter(|new| *new)
        .count())
}

/// What became of one record of an [`append_rows`] batch.
#[derive(Debug)]
pub enum Appended {
    Inserted,
    Duplicate,
    Failed(LedgerError),
}

/// One transaction for the whole batch; if it fails, each row gets its own transaction so a
/// failure is reported only for the row it belongs to.
pub fn append_rows(conn: &mut Connection, rows: &[UsageRecord]) -> Vec<Appended> {
    let outcome = |new: bool| {
        if new {
            Appended::Inserted
        } else {
            Appended::Duplicate
        }
    };
    if let Ok(inserted) = append_tx(conn, rows) {
        return inserted.into_iter().map(outcome).collect();
    }
    rows.iter()
        .map(|row| match append_tx(conn, std::slice::from_ref(row)) {
            Ok(inserted) => outcome(inserted[0]),
            Err(error) => Appended::Failed(error),
        })
        .collect()
}
