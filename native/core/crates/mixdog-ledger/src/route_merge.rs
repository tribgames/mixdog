//! The v4 data step: routes whose rates held a request's 1-hour cache-write count ([`crate::append::split_cache_1h`])
//! become the route without it, and the count moves to `usage_event_cache_1h`, in the upgrade's transaction.
//!
//! Moving a million records fires five per-row triggers each (session day sums, key and day revisions) and deleting
//! the old routes two more per route; those are dropped for the step and made again from their own `sqlite_master`
//! text, and what they would have done is done once in bulk: the day sums move to the merged route in one statement,
//! and the global day revision and the membership revision move once (every rollup and usage token reads again).

use serde_json::Value;

use crate::append::split_cache_1h;
use crate::db::Transaction;
use crate::db::params;
use crate::error::Result;

/// Triggers a route move would fire per row; dropped for the step and made again from their stored text.
const HELD_TRIGGERS: [&str; 5] =
    ["session_days_update", "key_revision_event_route", "day_rev_events_update", "membership_usage_routes_delete", "day_rev_routes_delete"];

/// The signature without the 1-hour count in its rates and the count, or `None` when the rates hold none.
fn merged_signature(signature: &str) -> Result<Option<(String, Option<f64>)>> {
    let mut parts: Vec<Value> = serde_json::from_str(signature)?;
    let Some(rates) = parts.get(5).and_then(Value::as_str) else { return Ok(None) };
    let (kept, tokens) = split_cache_1h(rates);
    if kept.len() == rates.len() {
        return Ok(None);
    }
    let kept = kept.into_owned();
    parts[5] = Value::from(kept);
    Ok(Some((mixdog_js::json_stringify(&Value::Array(parts)), tokens)))
}

/// Drops the triggers a route move would fire and returns their stored text.
fn hold_triggers(tx: &Transaction) -> Result<Vec<String>> {
    let held: Vec<String> = HELD_TRIGGERS
        .iter()
        .map(|name| tx.query_row("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?1", [name], |row| row.get(0)))
        .collect::<std::result::Result<_, _>>()?;
    for name in HELD_TRIGGERS {
        tx.execute_batch(&format!("DROP TRIGGER {name}"))?;
    }
    Ok(held)
}

/// Fills `temp.route_merge` with each old route, the route it merges into and its count.
fn map_merged_routes(tx: &Transaction, routes: &[(i64, String)]) -> Result<()> {
    tx.execute_batch("CREATE TEMP TABLE route_merge (old INTEGER PRIMARY KEY, new INTEGER NOT NULL, tokens REAL)")?;
    let mut intern = tx.prepare("INSERT OR IGNORE INTO usage_routes(signature) VALUES (?1)")?;
    let mut id_of = tx.prepare("SELECT id FROM usage_routes WHERE signature=?1")?;
    let mut map = tx.prepare("INSERT INTO temp.route_merge VALUES (?1, ?2, ?3)")?;
    for (old, signature) in routes {
        let Some((merged, tokens)) = merged_signature(signature)? else { continue };
        intern.execute([&merged])?;
        let new: i64 = id_of.query_row([&merged], |row| row.get(0))?;
        map.execute(params![old, new, tokens])?;
    }
    Ok(())
}

pub(crate) fn merge_cache_1h_routes(tx: &Transaction) -> Result<()> {
    let routes: Vec<(i64, String)> = tx
        .prepare("SELECT id, signature FROM usage_routes WHERE instr(signature, 'cacheWrite1hTokens') > 0")?
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<std::result::Result<_, _>>()?;
    if routes.is_empty() {
        return Ok(());
    }
    let held = hold_triggers(tx)?;
    map_merged_routes(tx, &routes)?;
    tx.execute_batch(
        "INSERT OR REPLACE INTO usage_event_cache_1h
             SELECT e.id, m.tokens FROM usage_events e JOIN temp.route_merge m ON m.old=e.route
             WHERE m.tokens IS NOT NULL AND m.tokens<>0;
         UPDATE usage_events SET route=(SELECT new FROM temp.route_merge WHERE old=usage_events.route)
             WHERE route IN (SELECT old FROM temp.route_merge);
         INSERT INTO usage_session_days
             SELECT d.session,d.day,m.new,SUM(d.turns),SUM(d.input),SUM(d.output),SUM(d.cache_read),SUM(d.cache_write),
                 SUM(d.cost_usd),SUM(d.duration_ms),SUM(d.speed_output),SUM(d.speed_ms)
             FROM usage_session_days d JOIN temp.route_merge m ON m.old=d.route
             GROUP BY d.session,d.day,m.new
             ON CONFLICT(session,day,route) DO UPDATE SET turns=turns+excluded.turns,input=input+excluded.input,
                 output=output+excluded.output,cache_read=cache_read+excluded.cache_read,
                 cache_write=cache_write+excluded.cache_write,cost_usd=cost_usd+excluded.cost_usd,
                 duration_ms=duration_ms+excluded.duration_ms,speed_output=speed_output+excluded.speed_output,
                 speed_ms=speed_ms+excluded.speed_ms;
         DELETE FROM usage_session_days WHERE route IN (SELECT old FROM temp.route_merge);
         DELETE FROM usage_routes WHERE id IN (SELECT old FROM temp.route_merge);
         INSERT INTO day_revisions(day,rev) VALUES('',1) ON CONFLICT(day) DO UPDATE SET rev=rev+1;
         UPDATE usage_membership_revision SET rev=rev+1;
         DROP TABLE temp.route_merge;",
    )?;
    for sql in held {
        tx.execute_batch(&sql)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_signature_loses_only_the_count() {
        let rates = r#"{"requestedModel":"m","cacheWrite1hTokens":3853,"inputCostPerM":8}"#;
        let signature = mixdog_js::json_stringify(&serde_json::json!(["p", "m", "oauth", "lead", "subscription", rates, "live", 0, "acct"]));
        let (merged, tokens) = merged_signature(&signature).unwrap().unwrap();
        assert_eq!(tokens, Some(3853.0));
        let expected = mixdog_js::json_stringify(&serde_json::json!([
            "p",
            "m",
            "oauth",
            "lead",
            "subscription",
            r#"{"requestedModel":"m","inputCostPerM":8}"#,
            "live",
            0,
            "acct"
        ]));
        assert_eq!(merged, expected);
        assert!(merged_signature(&expected).unwrap().is_none());
    }

    #[test]
    fn the_count_is_cut_wherever_it_stands() {
        assert_eq!(split_cache_1h(r#"{"cacheWrite1hTokens":2,"a":1}"#), (r#"{"a":1}"#.into(), Some(2.0)));
        assert_eq!(split_cache_1h(r#"{"a":1,"cacheWrite1hTokens":2}"#), (r#"{"a":1}"#.into(), Some(2.0)));
        assert_eq!(split_cache_1h(r#"{"a":1,"cacheWrite1hTokens":2.5,"b":3}"#), (r#"{"a":1,"b":3}"#.into(), Some(2.5)));
        assert_eq!(split_cache_1h(r#"{"cacheWrite1hTokens":7}"#), ("{}".into(), Some(7.0)));
        assert_eq!(split_cache_1h(r#"{"a":1}"#), (r#"{"a":1}"#.into(), None));
    }
}
