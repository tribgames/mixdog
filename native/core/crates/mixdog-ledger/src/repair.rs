//! Bounded correction of route attribution and price (`usage-ledger-repair.mjs`).
//!
//! A repair may change only a record's route and cost. Everything else about every record is
//! hashed before and after the writes ([`integrity`]); a difference aborts the transaction.
//! Pricing is injected: the catalog lives outside the ledger.

use std::collections::BTreeMap;

use serde::Serialize;
use serde_json::Value;
use sha2::Digest;
use sha2::Sha256;

use crate::append::UsageRecord;
use crate::append::index_event;
use crate::backup::backup_beside;
use crate::backup::database_path;
use crate::db::Connection;
use crate::db::OptionalExtension;
use crate::db::Transaction;
use crate::db::TransactionBehavior;
use crate::db::params;
use crate::error::LedgerError;
use crate::error::Result;
use crate::measure::is_unmeasuring_provider;
use crate::measure::js_number;

/// What the integrity hash covers: everything a repair must leave untouched.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Integrity {
    pub records: u64,
    pub sha256: String,
}

/// Hash of every record except its route and cost, in id order. The text hashed per record is
/// the JSON object `{id(hex),ts,day,session,input,output,cache_read,cache_write,duration_ms}`.
pub fn integrity(conn: &Connection) -> Result<Integrity> {
    let mut hash = Sha256::new();
    let mut records = 0u64;
    let mut stmt = conn.prepare(
        "SELECT id,ts,day,session,input,output,cache_read,cache_write,duration_ms FROM usage_events ORDER BY id",
    )?;
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        let id: Vec<u8> = row.get(0)?;
        let number = |i: usize| -> Result<String> {
            Ok(mixdog_js::json_stringify(&js_number(row.get::<_, f64>(i)?)))
        };
        let text = format!(
            "{{\"id\":\"{}\",\"ts\":{},\"day\":{},\"session\":{},\"input\":{},\"output\":{},\"cache_read\":{},\"cache_write\":{},\"duration_ms\":{}}}",
            id.iter().map(|b| format!("{b:02x}")).collect::<String>(),
            row.get::<_, i64>(1)?,
            row.get::<_, i64>(2)?,
            row.get::<_, i64>(3)?,
            number(4)?,
            number(5)?,
            number(6)?,
            number(7)?,
            number(8)?,
        );
        hash.update(text.as_bytes());
        records += 1;
    }
    Ok(Integrity {
        records,
        sha256: format!("{:x}", hash.finalize()),
    })
}

#[derive(Clone, Debug, Default)]
pub struct RepairOptions {
    pub through_ts: i64,
    pub since_ts: Option<i64>,
    /// `from provider -> to provider`, on operator evidence only.
    pub provider_overrides: BTreeMap<String, String>,
    pub only_unpriced: bool,
    /// Take a `VACUUM INTO` backup before the first write.
    pub backup: bool,
}

impl RepairOptions {
    fn validate(&self) -> Result<()> {
        if self.through_ts <= 0 {
            return Err(LedgerError::Invalid("an explicit timestamp bound"));
        }
        if self
            .provider_overrides
            .iter()
            .any(|(from, to)| from.is_empty() || to.is_empty())
        {
            return Err(LedgerError::Invalid("a provider correction"));
        }
        if self.only_unpriced && !self.provider_overrides.is_empty() {
            return Err(LedgerError::Invalid(
                "automatic repricing that does not change providers",
            ));
        }
        Ok(())
    }
}

/// One price lookup: the record's tokens and the route it is priced under.
#[derive(Clone, Debug)]
pub struct PriceRequest {
    pub provider: String,
    pub model: String,
    pub pricing_model: Option<String>,
    pub requested_model: Option<String>,
    /// `Some(false)` when the provider reported no input usage.
    pub input_tokens_known: Option<bool>,
    pub uncached_input_tokens: f64,
    pub output_tokens: f64,
    pub cache_read_tokens: f64,
    pub cache_write_tokens: f64,
    pub cache_write_1h_tokens: Option<f64>,
    pub request_service_tier: Option<String>,
    pub service_tier: Option<String>,
    pub kind: String,
    pub ts: i64,
    /// Imports are priced at their day, live records at their exact request time.
    pub historical: bool,
}

#[derive(Clone, Debug)]
pub struct Priced {
    pub cost_usd: Option<f64>,
    /// The price snapshot, serialized once (its field order is part of the route signature).
    pub rates: Option<String>,
}

#[derive(Clone, Debug)]
pub struct Candidate {
    pub id: Vec<u8>,
    pub ts: i64,
    pub route: i64,
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
    pub cache_write: f64,
    pub cost_usd: Option<f64>,
    pub signature: String,
}

#[derive(Clone, Debug)]
pub struct Change {
    pub row: Candidate,
    pub encoded: String,
    pub cost: Option<f64>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepairReport {
    pub reattributed: u64,
    pub repriced: u64,
    pub still_unpriced: u64,
    pub changes: BTreeMap<String, u64>,
    pub integrity: Option<Integrity>,
    pub backup_path: Option<String>,
    /// A planned row changed before the plan was applied; nothing was written.
    pub conflict: bool,
}

/// `mixdog-local` is free, `*-oauth` is a subscription, anything else bills by API.
pub fn route_kind(provider: &str) -> &'static str {
    if provider == "mixdog-local" {
        "local"
    } else if provider.ends_with("-oauth") {
        "oauth"
    } else {
        "api"
    }
}

pub fn cost_source(kind: &str, cost: Option<f64>, subscription: bool) -> &'static str {
    if kind == "local" {
        "local"
    } else if cost.is_none() {
        "unpriced"
    } else if subscription {
        "subscription"
    } else {
        "catalog"
    }
}

/// The rows a repair examines, with their route signatures.
pub fn select_candidates(conn: &Connection, options: &RepairOptions) -> Result<Vec<Candidate>> {
    // `+e.ts`: a bound of "now" matches every row, so a scan beats one primary-key search per
    // usage_events_time entry.
    let sql = format!(
        "SELECT e.id,e.ts,e.route,e.input,e.output,e.cache_read,e.cache_write,e.cost_usd,r.signature
         FROM usage_events e JOIN usage_routes r ON r.id=e.route WHERE +e.ts<=?1 {} {}",
        if options.since_ts.is_some() { "AND +e.ts>?2" } else { "" },
        if options.only_unpriced {
            "AND e.cost_usd IS NULL AND json_extract(r.signature,'$[4]')='unpriced'"
        } else {
            ""
        },
    );
    let mut stmt = conn.prepare(&sql)?;
    let map = |row: &rusqlite::Row<'_>| {
        Ok(Candidate {
            id: row.get(0)?,
            ts: row.get(1)?,
            route: row.get(2)?,
            input: row.get(3)?,
            output: row.get(4)?,
            cache_read: row.get(5)?,
            cache_write: row.get(6)?,
            cost_usd: row.get(7)?,
            signature: row.get(8)?,
        })
    };
    let rows = match options.since_ts {
        Some(since) => stmt
            .query_map(params![options.through_ts, since], map)?
            .collect::<std::result::Result<_, _>>()?,
        None => stmt
            .query_map(params![options.through_ts], map)?
            .collect::<std::result::Result<_, _>>()?,
    };
    Ok(rows)
}

fn optional_text(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_string)
}

/// Decides every change without writing. `price` is called only for a record that moves to
/// another provider or is unpriced.
pub fn plan_repair(
    rows: Vec<Candidate>,
    options: &RepairOptions,
    price: &mut dyn FnMut(&PriceRequest) -> Result<Priced>,
) -> Result<(RepairReport, Vec<Change>)> {
    let mut report = RepairReport::default();
    let mut changes = Vec::new();
    for row in rows {
        let mut signature: Vec<Value> = serde_json::from_str(&row.signature)?;
        let text_at =
            |s: &[Value], i: usize| s.get(i).and_then(Value::as_str).unwrap_or("").to_string();
        let original_provider = text_at(&signature, 0);
        let provider = options
            .provider_overrides
            .get(&original_provider)
            .cloned()
            .unwrap_or_else(|| original_provider.clone());
        let moved = provider != original_provider;
        let kind = if moved {
            route_kind(&provider).to_string()
        } else {
            text_at(&signature, 2)
        };
        let model = text_at(&signature, 1);
        let mut cost = row.cost_usd;
        let old_rates: Option<Value> = match signature.get(5).and_then(Value::as_str) {
            Some(rates) => Some(serde_json::from_str(rates)?),
            None => None,
        };
        let rate = |key: &str| old_rates.as_ref().and_then(|r| r.get(key));
        if moved || text_at(&signature, 4) == "unpriced" {
            let unmeasured = rate("inputTokensKnown") == Some(&Value::Bool(false))
                || is_unmeasuring_provider(&provider);
            let priced = if kind == "local" {
                Priced {
                    cost_usd: Some(0.0),
                    rates: None,
                }
            } else {
                let fast_tier =
                    rate("fast").is_some_and(|f| !matches!(f, Value::Null | Value::Bool(false)));
                price(&PriceRequest {
                    provider: provider.clone(),
                    model: model.clone(),
                    pricing_model: old_rates
                        .as_ref()
                        .and_then(|r| optional_text(r, "pricingModel")),
                    requested_model: old_rates
                        .as_ref()
                        .and_then(|r| optional_text(r, "requestedModel")),
                    input_tokens_known: unmeasured.then_some(false),
                    uncached_input_tokens: row.input,
                    output_tokens: row.output,
                    cache_read_tokens: row.cache_read,
                    cache_write_tokens: row.cache_write,
                    cache_write_1h_tokens: rate("cacheWrite1hTokens").and_then(Value::as_f64),
                    request_service_tier: old_rates
                        .as_ref()
                        .and_then(|r| optional_text(r, "requestServiceTier"))
                        .or_else(|| fast_tier.then(|| "fast".to_string())),
                    service_tier: old_rates
                        .as_ref()
                        .and_then(|r| optional_text(r, "serviceTier")),
                    kind: kind.clone(),
                    ts: row.ts,
                    historical: text_at(&signature, 6) != "live",
                })?
            };
            cost = priced.cost_usd;
            if cost.is_some_and(|c| !c.is_finite() || c < 0.0) {
                return Err(LedgerError::RepairPrice);
            }
            let subscription = kind == "oauth" || kind == "quota-api";
            signature[4] = Value::from(cost_source(&kind, cost, subscription));
            signature[5] = priced.rates.map_or(Value::Null, Value::from);
            if row.cost_usd.is_none() && cost.is_some() {
                report.repriced += 1;
            }
        }
        signature[0] = Value::from(provider.as_str());
        signature[2] = Value::from(kind.as_str());
        if moved {
            report.reattributed += 1;
        }
        if cost.is_none() {
            report.still_unpriced += 1;
        }
        let encoded = mixdog_js::json_stringify(&Value::Array(signature));
        if encoded == row.signature && cost == row.cost_usd {
            continue;
        }
        *report
            .changes
            .entry(format!("{original_provider} \u{2192} {provider} / {model}"))
            .or_insert(0) += 1;
        changes.push(Change { row, encoded, cost });
    }
    Ok((report, changes))
}

/// Replaces `daily`/`day_sessions` with what the records say.
pub fn rebuild_indexes(tx: &Transaction) -> Result<()> {
    tx.execute_batch("DELETE FROM daily; DELETE FROM day_sessions;")?;
    let mut stmt = tx.prepare("SELECT * FROM events")?;
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        let rank: i64 = row.get("rank")?;
        let record = UsageRecord {
            id: row.get("id")?,
            ts: row.get("ts")?,
            day: row.get("day")?,
            provider: row.get("provider")?,
            model: row.get("model")?,
            kind: row.get("kind")?,
            session_id: row.get("session_id")?,
            owner_session_id: None,
            source_type: row
                .get::<_, Option<String>>("source_type")?
                .unwrap_or_default(),
            input: row.get("input")?,
            output: row.get("output")?,
            cache_read: row.get("cache_read")?,
            cache_write: row.get("cache_write")?,
            cost_usd: row.get("cost_usd")?,
            cost_source: row.get("cost_source")?,
            rates: None,
            origin: row.get("origin")?,
            duration_ms: row.get("duration_ms")?,
            account: String::new(),
            requested_model: String::new(),
            requested_provider: String::new(),
            status: "completed".to_string(),
            attempts: 1,
            ttft_ms: None,
            elapsed_ms: 0.0,
        };
        index_event(tx, &record, rank)?;
    }
    Ok(())
}

/// Inside the caller's write transaction: every change, the index rebuild, the immutability
/// check, the repair note.
fn apply_planned(
    tx: &Transaction,
    mut report: RepairReport,
    changes: &[Change],
    options: &RepairOptions,
    now_ms: i64,
) -> Result<RepairReport> {
    // Nothing is verified without a write: the whole-ledger hash is only taken around real ones.
    if changes.is_empty() {
        return Ok(report);
    }
    let before = integrity(tx)?;
    if options.backup && database_path(tx)?.is_some() {
        report.backup_path = Some(backup_beside(tx)?.to_string_lossy().into_owned());
    }
    for change in changes {
        tx.prepare_cached("INSERT OR IGNORE INTO usage_routes(signature) VALUES (?1)")?
            .execute([&change.encoded])?;
        let route: i64 = tx
            .prepare_cached("SELECT id FROM usage_routes WHERE signature=?1")?
            .query_row([&change.encoded], |r| r.get(0))?;
        tx.prepare_cached("UPDATE usage_events SET route=?1,cost_usd=?2 WHERE id=?3")?
            .execute(params![route, change.cost, change.row.id])?;
    }
    rebuild_indexes(tx)?;
    let after = integrity(tx)?;
    if before != after {
        return Err(LedgerError::RepairIntegrity);
    }
    let note = serde_json::json!({
        "at": now_ms,
        "throughTs": options.through_ts,
        "providerOverrides": options.provider_overrides,
        "reattributed": report.reattributed,
        "repriced": report.repriced,
        "stillUnpriced": report.still_unpriced,
        "changes": report.changes,
        "backupPath": report.backup_path,
        "integrity": after,
    });
    tx.prepare_cached("INSERT INTO metadata VALUES ('lastUsageRepair', ?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value")?
        .execute([note.to_string()])?;
    report.integrity = Some(after);
    Ok(report)
}

/// Bounded correction in one write transaction. Without changes nothing is written.
pub fn repair_usage_ledger(
    conn: &mut Connection,
    options: &RepairOptions,
    now_ms: i64,
    price: &mut dyn FnMut(&PriceRequest) -> Result<Priced>,
) -> Result<RepairReport> {
    options.validate()?;
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let rows = select_candidates(&tx, options)?;
    let (report, changes) = plan_repair(rows, options, price)?;
    let report = apply_planned(&tx, report, &changes, options, now_ms)?;
    tx.commit()?;
    Ok(report)
}

/// Applies a plan priced outside the write transaction, if every planned row still has the
/// route and cost it was priced from; otherwise writes nothing and reports `conflict`.
pub fn apply_repair_if_unchanged(
    conn: &mut Connection,
    report: RepairReport,
    changes: &[Change],
    options: &RepairOptions,
    now_ms: i64,
) -> Result<RepairReport> {
    options.validate()?;
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    for change in changes {
        let now: Option<(i64, Option<f64>)> = tx
            .prepare_cached("SELECT route,cost_usd FROM usage_events WHERE id=?1")?
            .query_row([&change.row.id], |r| Ok((r.get(0)?, r.get(1)?)))
            .optional()?;
        if now != Some((change.row.route, change.row.cost_usd)) {
            return Ok(RepairReport {
                conflict: true,
                integrity: None,
                ..report
            });
        }
    }
    let report = apply_planned(&tx, report, changes, options, now_ms)?;
    tx.commit()?;
    Ok(report)
}
