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
//! is `BIGINT`, `null`/`undefined` is `NULL`. A string or NaN timestamp has no `BIGINT` form and no caller can pass
//! one (the trigger reads `BIGINT` columns): those probes have no `stored`, are named in the manifest's
//! `exclusions.noTriggerArgument`, and are not compared. A score is `REAL`: node-pg parses its text to the shortest
//! double, so both sides compare as the `f32` they are.

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

/// A timestamp as the trigger's `BIGINT` argument.
fn bigint(name: &str, value: &Exact) -> Option<i64> {
    match value {
        Exact::Number(n) if n.fract() == 0.0 => Some(*n as i64),
        Exact::Null | Exact::Undefined => None,
        other => panic!("{name}: {other:?} has no BIGINT form and is not declared in exclusions.noTriggerArgument"),
    }
}

/// The probes the manifest declares unreachable: `(case name, probe index)`.
fn declared_unreachable() -> Vec<(String, usize)> {
    let path = super::fixture(SET, "MANIFEST.json");
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    let manifest: serde_json::Value = serde_json::from_str(&text).expect("MANIFEST.json is JSON");
    let probes = manifest["exclusions"]["noTriggerArgument"]["probes"].as_array().expect("exclusions.noTriggerArgument.probes");
    probes
        .iter()
        .map(|p| (p["case"].as_str().expect("probe case").to_owned(), p["index"].as_u64().expect("probe index") as usize))
        .collect()
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
    super::object(vec![("score", real(stored.get("score")))])
}

mod pg {
    use super::*;
    use crate::memory::replays::pg::memory_db;
    use crate::memory::replays::{case, object, same};

    const DEADLINE: std::time::Duration = std::time::Duration::from_secs(60);

    async fn replay(index: usize, name: &str) {
        let g = golden(SET);
        let c = case(&g, index, name);
        let declared = declared_unreachable();
        let pg = memory_db().await;
        let (mut expected, mut actual) = (Vec::new(), Vec::new());
        for (at, probe) in c.get("scores").as_array().iter().enumerate() {
            let input = probe.get("input");
            let unreachable = declared.iter().any(|(case, index)| case == name && *index == at);
            assert_eq!(
                probe.try_get("stored").is_none(),
                unreachable,
                "{name}: input {at}: a probe has no `stored` exactly when the manifest declares it unreachable"
            );
            if unreachable {
                continue;
            }
            expected.push(object(vec![("input", input.clone()), ("stored", recorded(probe.get("stored")))]));
            let category = text(input.get("category"));
            let (last_seen, now) = (bigint("lastSeenAt", input.get("lastSeenAt")), bigint("nowMs", input.get("nowMs")));
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
