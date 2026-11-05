//! Rollup recompute as maintenance, and `usage` section publication (SPEC R32).
//!
//! A completed day's rollup is cached in `rollup_days`, validated by a fingerprint of the
//! day-revision counters the triggers keep. The append commit that moves a fingerprint
//! schedules [`recompute_rollup_days`] (an event, not a boot scan); when it completes the
//! `usage` section is republished with [`publish_usage`].

use std::collections::BTreeMap;

use bytes::Bytes;
use mixdog_core_api::StatePublisher;
use mixdog_core_api::state::SectionChange;
use mixdog_protocol::INLINE_MAX;
use mixdog_protocol::SectionName;
use serde_json::Map;
use serde_json::Value;

use crate::db::Connection;
use crate::db::TransactionBehavior;
use crate::db::params;
use crate::error::Result;
use crate::rollup::FIRST_DAY;
use crate::rollup::LAST_DAY;
use crate::rollup::RollupQuery;
use crate::rollup::rollup_usage;
use crate::time::day_key;

/// Days one maintenance step recomputes, at most (a row bound, not a measured time).
pub const RECOMPUTE_STEP_DAYS: usize = 8;

/// Every day with any stored rollup input, with its revision fingerprint.
pub fn day_fingerprints(
    conn: &Connection,
    from_day: &str,
    to_day: &str,
) -> Result<BTreeMap<String, String>> {
    let global: i64 = conn.query_row(
        "SELECT COALESCE((SELECT rev FROM day_revisions WHERE day=''),0)",
        [],
        |r| r.get(0),
    )?;
    let revisions: BTreeMap<String, i64> = conn
        .prepare("SELECT day,rev FROM day_revisions WHERE day<>'' AND day BETWEEN ?1 AND ?2")?
        .query_map(params![from_day, to_day], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<std::result::Result<_, _>>()?;
    let days: Vec<String> = conn
        .prepare(
            "SELECT day FROM daily WHERE day BETWEEN ?1 AND ?2 UNION SELECT day FROM day_sessions WHERE day BETWEEN ?1 AND ?2
             UNION SELECT day FROM legacy_days WHERE day BETWEEN ?1 AND ?2",
        )?
        .query_map(params![from_day, to_day], |r| r.get(0))?
        .collect::<std::result::Result<_, _>>()?;
    Ok(days
        .into_iter()
        .map(|day| {
            let rev = revisions.get(&day).copied().unwrap_or(0);
            (day, format!("{global}:{rev}"))
        })
        .collect())
}

fn day_value(conn: &Connection, day: &str) -> Result<Value> {
    let part = rollup_usage(conn, &RollupQuery::days(day, day))?;
    Ok(part.days.get(day).cloned().unwrap_or(Value::Null))
}

/// What one recompute step did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Recompute {
    pub recomputed: usize,
    /// Completed days whose cache is still stale; the caller schedules another step.
    pub remaining: usize,
}

/// Recomputes up to [`RECOMPUTE_STEP_DAYS`] completed days whose cached rollup no longer matches
/// their fingerprint, and drops cache rows of days that have no input left.
pub fn recompute_rollup_days(conn: &mut Connection, now_ms: i64) -> Result<Recompute> {
    let today = day_key(now_ms);
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let fingerprints = day_fingerprints(&tx, FIRST_DAY, LAST_DAY)?;
    let cached: BTreeMap<String, String> = tx
        .prepare("SELECT day,fingerprint FROM rollup_days")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<std::result::Result<_, _>>()?;
    for day in cached.keys().filter(|d| !fingerprints.contains_key(*d)) {
        tx.execute("DELETE FROM rollup_days WHERE day=?1", [day])?;
    }
    let stale: Vec<&String> = fingerprints
        .iter()
        .filter(|(day, fp)| **day < today && cached.get(*day) != Some(*fp))
        .map(|(day, _)| day)
        .collect();
    for day in stale.iter().take(RECOMPUTE_STEP_DAYS) {
        let value = day_value(&tx, day)?;
        tx.execute(
            "INSERT INTO rollup_days VALUES (?1,?2,?3) ON CONFLICT(day) DO UPDATE SET fingerprint=excluded.fingerprint,value=excluded.value",
            params![day, fingerprints[*day], value.to_string()],
        )?;
    }
    let recomputed = stale.len().min(RECOMPUTE_STEP_DAYS);
    let remaining = stale.len() - recomputed;
    tx.commit()?;
    Ok(Recompute {
        recomputed,
        remaining,
    })
}

/// The all-time rollup answered from the day cache: completed days come from `rollup_days`
/// when their fingerprint holds, today and anything stale from the ledger. Equals
/// [`rollup_usage`] for the same range.
pub(crate) fn cached_rollup(conn: &Connection, query: &RollupQuery, now_ms: i64) -> Result<Value> {
    let today = day_key(now_ms);
    let fingerprints = day_fingerprints(conn, &query.from_day, &query.to_day)?;
    let mut cached: BTreeMap<String, (String, String)> = BTreeMap::new();
    let mut stmt =
        conn.prepare("SELECT day,fingerprint,value FROM rollup_days WHERE day BETWEEN ?1 AND ?2")?;
    for row in stmt.query_map(params![query.from_day, query.to_day], |r| {
        Ok((r.get(0)?, r.get(1)?, r.get(2)?))
    })? {
        let (day, fp, value): (String, String, String) = row?;
        cached.insert(day, (fp, value));
    }
    let hourly = query.hourly_day.as_deref();
    let mut days = Map::new();
    for (day, fp) in &fingerprints {
        let value = match cached.get(day) {
            Some((held, value))
                if held == fp && day.as_str() < today.as_str() && Some(day.as_str()) != hourly =>
            {
                serde_json::from_str(value)?
            }
            _ => day_value(conn, day)?,
        };
        if !value.is_null() {
            days.insert(day.clone(), value);
        }
    }
    let mut out = Map::new();
    out.insert("days".into(), Value::Object(days));
    if hourly.is_some() {
        out.insert(
            "hourly".into(),
            rollup_usage(conn, query)?.hourly.unwrap_or(Value::Null),
        );
    }
    Ok(Value::Object(out))
}

/// Publishes the `usage` section for `scope`: the aggregate summary inline when it fits
/// `INLINE_MAX`, else a stub counting its days for the client to page.
pub fn publish_usage(
    conn: &Connection,
    publisher: &dyn StatePublisher,
    scope: &str,
    now_ms: i64,
) -> Result<()> {
    let summary = cached_rollup(conn, &RollupQuery::default(), now_ms)?;
    let bytes = serde_json::to_vec(&summary)?;
    let change = if bytes.len() <= INLINE_MAX {
        SectionChange::Set(Bytes::from(bytes))
    } else {
        let count = summary["days"].as_object().map_or(0, |d| d.len() as u64);
        SectionChange::Stub { count }
    };
    publisher.publish(SectionName::Usage, Some(scope.to_string()), change);
    Ok(())
}

/// The maintenance job the append commit triggers: recompute stale days; once none remain,
/// republish the `usage` section. Returns whether the section was published.
pub fn maintain_usage(
    conn: &mut Connection,
    publisher: &dyn StatePublisher,
    scope: &str,
    now_ms: i64,
) -> Result<bool> {
    let step = recompute_rollup_days(conn, now_ms)?;
    if step.remaining > 0 {
        return Ok(false);
    }
    publish_usage(conn, publisher, scope, now_ms)?;
    Ok(true)
}
