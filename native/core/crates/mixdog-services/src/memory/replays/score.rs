//! Replay of `native/core/fixtures/memory-score` (memory-score.test.mjs).
//!
//! Where the product computes the score: in SQL, in Node and in the core alike. Every stored score is written by the
//! row trigger `trg_entry_score_recalc` (core `memory/schema.rs`, Node `memory-schema/entry-triggers.mjs:15`), which
//! calls `compute_entry_score` (core `memory/schema.rs`, Node `memory-schema/score-params.mjs:46`) on each insert and
//! on each update of `category`, `last_seen_at` or `is_root`. Node's JavaScript `computeEntryScore` (the recording's
//! `result`) is only called by the manage actions (`manage-actions.mjs:39,92`), whose UPDATE sets `category` in the
//! same statement, so the trigger replaces that value; it has no core counterpart. The recorder ran Node's own
//! `compute_entry_score` on Node's opened database for every probe (`stored`); the replay runs the core's on a private
//! cluster with the core's installed schema and compares `stored` whole, in recorded order.
//!
//! Arguments are the trigger's types: a category string is `TEXT`, `null`/`undefined` is `NULL`; an integer timestamp
//! is `BIGINT`, `null`/`undefined` is `NULL`. A string or NaN timestamp has no `BIGINT` form: the replay answers
//! `noSqlArgument` with its own text for it, as the recorder did. A score is `REAL`: node-pg parses its text to the
//! shortest double, so both sides compare as the `f32` they are.

use mixdog_testkit::Exact;

use super::{assert_case_count, golden};

const SET: &str = "memory-score";

#[test]
fn every_recorded_case_has_a_replay() {
    assert_case_count(&golden(SET), 2);
}

fn text(value: &Exact) -> Option<String> {
    match value {
        Exact::String(s) => Some(s.clone()),
        Exact::Null | Exact::Undefined => None,
        other => panic!("a recorded category is a string, null or undefined: {other:?}"),
    }
}

/// A timestamp as the trigger's `BIGINT` argument, or why it has none.
fn bigint(name: &str, value: &Exact) -> Result<Option<i64>, String> {
    match value {
        Exact::Number(n) if n.fract() == 0.0 => Ok(Some(*n as i64)),
        Exact::Null | Exact::Undefined => Ok(None),
        Exact::NaN => Err(format!("{name} is NaN")),
        Exact::String(s) => Err(format!("{name} is the string {}", serde_json::to_string(s).expect("JSON string"))),
        other => panic!("{name}: a recorded timestamp shape the replay does not know: {other:?}"),
    }
}

fn real(value: &Exact) -> Exact {
    match value {
        Exact::Number(n) => Exact::Number(f64::from(*n as f32)),
        Exact::Null => Exact::Null,
        other => panic!("a recorded score is a number or null: {other:?}"),
    }
}

/// The recorded `stored`, its score as the `f32` it is.
fn recorded(stored: &Exact) -> Exact {
    match stored.try_get("score") {
        Some(score) => super::object(vec![("score", real(score))]),
        None => stored.clone(),
    }
}

mod pg {
    use super::*;
    use crate::memory::replays::pg::memory_db;
    use crate::memory::replays::{case, object, same};

    const DEADLINE: std::time::Duration = std::time::Duration::from_secs(60);

    async fn replay(index: usize, name: &str) {
        let g = golden(SET);
        let c = case(&g, index, name);
        let pg = memory_db().await;
        let (mut expected, mut actual) = (Vec::new(), Vec::new());
        for (at, probe) in c.get("scores").as_array().iter().enumerate() {
            let input = probe.get("input");
            expected.push(object(vec![("input", input.clone()), ("stored", recorded(probe.get("stored")))]));
            let category = text(input.get("category"));
            let (last_seen, now) = (bigint("lastSeenAt", input.get("lastSeenAt")), bigint("nowMs", input.get("nowMs")));
            let (last_seen, now) = match (last_seen, now) {
                (Ok(last_seen), Ok(now)) => (last_seen, now),
                (last_seen, now) => {
                    let why: Vec<String> = [last_seen.err(), now.err()].into_iter().flatten().collect();
                    let reason = format!("{}: no BIGINT column holds it", why.join("; "));
                    actual.push(object(vec![
                        ("input", input.clone()),
                        ("stored", object(vec![("noSqlArgument", Exact::String(reason))])),
                    ]));
                    continue;
                }
            };
            let row = tokio::time::timeout(
                DEADLINE,
                pg.db.query_opt(
                    "SELECT compute_entry_score($1::text, $2::bigint, $3::bigint)",
                    &[&category, &last_seen, &now],
                ),
            )
            .await
            .unwrap_or_else(|_| panic!("{name}: input {at}: compute_entry_score did not answer within {DEADLINE:?}"))
            .unwrap_or_else(|e| panic!("{name}: input {at}: {}", e.message()));
            // The function selects from category_score_params: an unknown category answers no row, which the
            // trigger stores as NULL.
            let score: Option<f32> = row.and_then(|row| row.get(0));
            let score = score.map_or(Exact::Null, |s| Exact::Number(f64::from(s)));
            actual.push(object(vec![("input", input.clone()), ("stored", object(vec![("score", score)]))]));
        }
        same(name, &Exact::Array(expected), &Exact::Array(actual));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn all_generated_categories_age_uniformly_unknown_is_null() {
        replay(0, "all generated categories age uniformly; unknown is null").await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn case_folding_string_and_non_finite_timestamps_future_last_seen() {
        replay(1, "case folding, string and non-finite timestamps, future last-seen").await;
    }
}
