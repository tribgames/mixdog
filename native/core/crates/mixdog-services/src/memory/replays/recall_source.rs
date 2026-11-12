//! memory-recall-source: source bodies in recall text.
//!
//! - Cases 4 and 5 render the recorded rows with the recorded options: `renderSessionGroupedLines` ↔
//!   `render_session_grouped_lines` (no session meta, as the recorder passes none), `renderEntryLines` ↔
//!   `render_entry_lines`, and `compactHandoffRows` ↔ `compact_handoff_rows` on the recorded input rows (its projected
//!   rows are compared whole before they are rendered).
//! - Cases 0 to 3 are `handleSearch` calls: here the `memory/recall` request's `Recall::recall` over a private cluster
//!   holding the recorded rows (module `pg`), the returned text compared whole. Node's `searches` / `statements` are the
//!   log of the test file's scripted database (it answers by SQL text), which the core's real database has no
//!   counterpart of; the text is what a client reads.

use mixdog_testkit::Exact;

use super::{assert_case_count, case, golden, object, render_options, rows, same, same_rows, string};
use crate::memory::recall::compact::compact_handoff_rows;
use crate::memory::recall::format::{GroupedOptions, render_entry_lines, render_session_grouped_lines};
use crate::memory::recall::period::Clock;

const SET: &str = "memory-recall-source";

fn clock(g: &Exact) -> Clock {
    Clock { now_ms: g.get("clock").get("dateNowMs").as_f64() as i64, zone: chrono_tz::UTC }
}

fn flag(options: &Exact, key: &str) -> Option<bool> {
    options.try_get(key).map(Exact::as_bool)
}

#[test]
fn the_recording_has_six_cases() {
    assert_case_count(&golden(SET), 6);
}

#[test]
fn grouped_source_rendering_carries_explicit_options_through_flat_multi_session_and_span_layouts() {
    let g = golden(SET);
    let name = "grouped source rendering carries explicit options through flat, multi-session and span layouts (test line 111)";
    let clock = clock(&g);
    for (index, layout) in case(&g, 4, name).get("layouts").as_array().iter().enumerate() {
        let options = layout.get("options");
        for (key, _) in options.entries() {
            assert!(matches!(key.as_str(), "spanHeaders" | "preserveSource"), "layout {index}: option {key}");
        }
        let grouped = GroupedOptions {
            span_headers: flag(options, "spanHeaders").unwrap_or(false),
            preserve_source: flag(options, "preserveSource").unwrap_or(false),
            ..GroupedOptions::default()
        };
        let rows = rows(layout.get("rows")).expect("recorded rows");
        let text = render_session_grouped_lines(&clock, &rows, &[], &grouped);
        same(&format!("{name}: layout {index}"), layout.get("result"), &string(text));
    }
}

#[test]
fn source_opt_in_keeps_the_body_bound_and_does_not_change_compact_summary_raw_projection() {
    let g = golden(SET);
    let name = "source opt-in keeps the body bound and does not change Compact summary/RAW projection (test line 120)";
    let clock = clock(&g);
    let renders = case(&g, 5, name).get("renders").as_array();
    // The recorder's inputs to `compactHandoffRows`: its large raw row (the first render's row) and the raw row.
    let large = renders[0].get("rows");
    assert_eq!(renders[0].get("label").as_str(), "large raw body, preserveSource (bound applies)");
    let raw = Exact::Array(vec![g.get("rows").get("raw").clone()]);
    for render in renders {
        let label = render.get("label").as_str();
        let what = format!("{name}: {label}");
        let recorded = render.get("rows");
        let rows = match label {
            "compact handoff of a large raw row, no bound" | "compact handoff of a raw row" => {
                let input = if label.contains("large") { large } else { &raw };
                let projected =
                    compact_handoff_rows(rows(input).expect("input rows"), 0, &mixdog_js::token_estimate::estimate_tokens);
                same_rows(&format!("{what}: projected rows"), recorded, &projected);
                projected
            }
            _ => rows(recorded).expect("recorded rows"),
        };
        let options = render.try_get("options").unwrap_or(&Exact::Undefined);
        let text = render_entry_lines(&clock, &rows, &render_options(options));
        same(&what, render.get("result"), &string(text));
    }
}

mod pg {
    use super::*;
    use crate::memory::replays::pg::{insert_entries, memory_db, recall};

    /// Each recorded search: the rows its handlers were built over (the shared three, or the search's own), then the
    /// `memory/recall` answer. Searches of one case share a database as the recorder's share handlers; a search with
    /// its own rows gets them alone.
    async fn searches(index: usize, name: &str) {
        let g = golden(SET);
        let case = case(&g, index, name);
        let shared = g.get("rows");
        let shared: Vec<&Exact> = ["root", "member", "raw"].iter().map(|k| shared.get(k)).collect();
        let pg = memory_db().await;
        let recall = recall(&pg.db, clock(&g).now_ms);
        let mut loaded: Option<&Exact> = None;
        for (at, search) in case.get("searches").as_array().iter().enumerate() {
            let own = search.try_get("rows");
            if loaded.is_none() || own.is_some() {
                pg.db.execute("DELETE FROM entries", &[]).await.expect("clear entries");
                match own {
                    Some(rows) => insert_entries(&pg.db, &rows.as_array().iter().collect::<Vec<_>>()).await,
                    None => insert_entries(&pg.db, &shared).await,
                }
                loaded = Some(search);
            }
            let args = search.get("args").to_plain().expect("JSON args");
            let outcome = recall.recall_cancellable(&args, &tokio_util::sync::CancellationToken::new()).await;
            let label = search.try_get("label").map_or_else(|| args.to_string(), |l| l.as_str().to_owned());
            same(&format!("{name}: search {at} ({label})"), search.get("result"), &object(vec![("text", string(outcome.text))]));
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn id_recall_preserves_original_root_member_and_raw_bodies_without_duplicating_named_members() {
        searches(0, "ID recall preserves original root, member and RAW bodies without duplicating named members (test line 72)").await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn explicit_member_search_and_session_expansion_keep_code_urls_and_tables() {
        searches(1, "explicit member search and session expansion keep code, URLs and tables (test line 79)").await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn raw_opt_in_preserves_raw_text_while_the_ordinary_root_result_stays_a_summary() {
        searches(2, "RAW opt-in preserves raw text while the ordinary root result stays a summary (test line 90)").await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn an_in_window_member_hit_cannot_reintroduce_the_original_root_body_from_outside_the_requested_period() {
        searches(
            3,
            "an in-window member hit cannot reintroduce the original root body from outside the requested period (test line 100)",
        )
        .await;
    }
}
