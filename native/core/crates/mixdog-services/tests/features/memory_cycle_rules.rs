//! The cycle's rules that need no database, beyond the interval and reply rules of `memory_cycles`: coalescing limits, the plan a config
//! makes, the sql fragments, packing sessions into windows, merging two runs, the prompt and quality record of a chunk, cutting a row
//! that is too long, and the chunk generator against a scripted classifier.

use std::sync::Mutex;

use async_trait::async_trait;
use mixdog_services::memory::cycles::quality::{
    Generation, Row, assess_chunk_quality, build_cycle1_chunk_prompt, chunk_source_text, cycle1_source_budget, generate_cycle1_chunks, make_chunk_quality,
    partition_cycle1_rows, split_cycle1_row,
};
use mixdog_services::memory::cycles::requests::{resolve_coalesce_max_drains_in, resolve_coalesce_max_retries_in, resolve_coalesce_retry_delay_ms_in};
use mixdog_services::memory::cycles::rows::{PlanOptions, cycle1_row_due_sql, cycle1_unchunked_sql, resolve_cycle1_plan, select_root_id};
use mixdog_services::memory::cycles::run::{Cycle1Result, EmbeddingDirty, merge_cycle1_results, pack_cycle1_windows};
use mixdog_services::memory::cycles::{Cycle1Llm, Cycle1Request};
use serde_json::{Map, Value, json};
use tokio_util::sync::CancellationToken;

fn row(id: i64, ts: i64, session: &str, content: &str) -> Row {
    Row { id, ts, role: Some("user".into()), content: content.to_owned(), session_id: Some(session.to_owned()), project_id: None, element: None }
}

fn ids(windows: &[Vec<Row>]) -> Vec<Vec<i64>> {
    windows.iter().map(|w| w.iter().map(|r| r.id).collect()).collect()
}

// ---- coalescing limits ----

#[test]
fn a_coalescing_limit_comes_from_the_key_then_the_nested_key_then_the_environment_then_the_fallback() {
    let no_env = |_: &str| None;
    assert_eq!(resolve_coalesce_max_drains_in(&no_env, &json!({}), 1.0), 1.0);
    assert_eq!(resolve_coalesce_max_drains_in(&no_env, &json!({ "coalesce_max_drains": 3 }), 1.0), 3.0);
    assert_eq!(resolve_coalesce_max_drains_in(&no_env, &json!({ "coalesce": { "max_drains": 5 } }), 1.0), 5.0);
    let env = |name: &str| (name == "MIXDOG_MEMORY_CYCLE_COALESCE_MAX_DRAINS").then(|| "7".to_owned());
    assert_eq!(resolve_coalesce_max_drains_in(&env, &json!({}), 1.0), 7.0);
    assert_eq!(resolve_coalesce_max_drains_in(&env, &json!({ "coalesce": { "max_drains": 5 } }), 1.0), 5.0, "the file outranks the environment");
    assert_eq!(resolve_coalesce_max_drains_in(&env, &json!({ "coalesce_max_drains": 2, "coalesce": { "max_drains": 5 } }), 1.0), 2.0);
    let junk = |_: &str| Some("many".to_owned());
    assert_eq!(resolve_coalesce_max_drains_in(&junk, &json!({ "coalesce_max_drains": "x" }), 4.0), 4.0, "what is not a number is skipped");
}

#[test]
fn a_coalescing_limit_is_rounded_down_and_kept_in_its_range() {
    let no_env = |_: &str| None;
    assert_eq!(resolve_coalesce_max_drains_in(&no_env, &json!({ "coalesce_max_drains": 2.9 }), 1.0), 2.0);
    assert_eq!(resolve_coalesce_max_drains_in(&no_env, &json!({ "coalesce_max_drains": 99 }), 1.0), 10.0);
    assert_eq!(resolve_coalesce_max_drains_in(&no_env, &json!({ "coalesce_max_drains": -4 }), 1.0), 0.0);
    assert_eq!(resolve_coalesce_max_retries_in(&no_env, &json!({ "coalesce_max_retries": 50 }), 3.0), 10.0);
    assert_eq!(resolve_coalesce_max_retries_in(&no_env, &json!({}), 3.0), 3.0);
    assert_eq!(resolve_coalesce_retry_delay_ms_in(&no_env, &json!({ "coalesce_retry_delay_ms": 1 }), 500.0), 50.0);
    assert_eq!(resolve_coalesce_retry_delay_ms_in(&no_env, &json!({ "coalesce_retry_delay_ms": 999999 }), 500.0), 60_000.0);
    assert_eq!(
        resolve_coalesce_retry_delay_ms_in(&no_env, &json!({ "retry_delay_ms": 1 }), 500.0),
        500.0,
        "only the nested spelling is `coalesce.retry_delay_ms`"
    );
}

// ---- the plan and the sql ----

#[test]
fn an_empty_config_plans_the_defaults() {
    let plan = resolve_cycle1_plan(&json!({}), &PlanOptions::default(), None);
    assert_eq!(
        [plan.window_size, plan.max_packets, plan.rows_per_session, plan.min_batch, plan.session_cap, plan.backfill_cap],
        [50.0, 4.0, 100.0, 3.0, 10.0, 3.0]
    );
    assert_eq!(
        [plan.session_quiet_ms, plan.session_force_age_ms, plan.timeout, plan.input_token_budget, plan.concurrency],
        [900_000.0, 7_200_000.0, 180_000.0, 16_000.0, 4.0]
    );
    assert_eq!(plan.only_session_id, "");
    assert_eq!(plan.preset, None);
}

#[test]
fn the_batch_size_sets_the_window_and_the_caps_are_kept_in_range() {
    let plan = resolve_cycle1_plan(&json!({ "batch_size": 20, "max_packets": 9, "session_cap": 2, "cycle1_concurrency": 0 }), &PlanOptions::default(), None);
    assert_eq!((plan.window_size, plan.rows_per_session, plan.max_packets, plan.backfill_cap, plan.concurrency), (20.0, 20.0, 4.0, 1.0, 1.0));
    let camel =
        resolve_cycle1_plan(&json!({ "windowSize": 7, "rowsPerSession": 30, "sessionQuietMs": 0, "sessionId": "  abc " }), &PlanOptions::default(), None);
    assert_eq!((camel.window_size, camel.rows_per_session, camel.session_quiet_ms), (7.0, 30.0, 0.0));
    assert_eq!(camel.only_session_id, "abc");
}

#[test]
fn a_caller_deadline_shortens_the_timeout_but_never_below_five_seconds() {
    let with = |deadline: f64| resolve_cycle1_plan(&json!({}), &PlanOptions { caller_deadline_ms: Some(deadline), ..PlanOptions::default() }, None).timeout;
    assert_eq!(with(60_000.0), 59_000.0);
    assert_eq!(with(3_000.0), 5_000.0);
    assert_eq!(with(900_000.0), 180_000.0, "a long deadline leaves the configured timeout");
}

#[test]
fn the_preset_is_the_runs_then_the_maintenance_default() {
    let (own, default) = (json!({ "provider": "own" }), json!({ "provider": "default" }));
    let options = PlanOptions { preset: Some(own.clone()), ..PlanOptions::default() };
    assert_eq!(resolve_cycle1_plan(&json!({}), &options, Some(default.clone())).preset, Some(own));
    assert_eq!(resolve_cycle1_plan(&json!({}), &PlanOptions::default(), Some(default.clone())).preset, Some(default));
}

#[test]
fn a_row_is_due_when_never_reviewed_or_after_a_cooldown_that_doubles_with_each_miss() {
    let cooldown = "LEAST(2592000000::bigint, 3600000::bigint * (1::bigint << LEAST(GREATEST(COALESCE(error_count, 0) - 1, 0), 10)))";
    assert_eq!(cycle1_row_due_sql("$1", ""), format!("(reviewed_at IS NULL OR reviewed_at < $1::bigint - {cooldown})"));
    assert!(cycle1_row_due_sql("$2", "e").starts_with("(e.reviewed_at IS NULL OR e.reviewed_at < $2::bigint - "));
    assert!(cycle1_row_due_sql("$2", "e").contains("COALESCE(e.error_count, 0)"));
    assert_eq!(cycle1_unchunked_sql(""), "chunk_root IS NULL AND session_id IS NOT NULL AND NULLIF(btrim(session_id), '') IS NOT NULL");
    assert_eq!(cycle1_unchunked_sql("e"), "e.chunk_root IS NULL AND e.session_id IS NOT NULL AND NULLIF(btrim(e.session_id), '') IS NOT NULL");
}

#[test]
fn the_root_of_a_chunk_is_its_earliest_member_with_the_smallest_id_among_equals() {
    assert_eq!(select_root_id(&[row(5, 300, "s", "a"), row(9, 100, "s", "b"), row(7, 100, "s", "c")]), Some(7));
    assert_eq!(select_root_id(&[]), None);
}

// ---- windows ----

fn session(name: &str, first: i64, count: i64) -> (String, Vec<Row>) {
    (name.to_owned(), (first..first + count).map(|id| row(id, id, name, "x")).collect())
}

#[test]
fn sessions_are_packed_into_windows_one_packet_of_each_in_turn_newest_rows_first() {
    let sessions = [session("a", 1, 3), session("b", 11, 3)];
    assert_eq!(ids(&pack_cycle1_windows(&sessions, 2.0, 4.0, 16_000.0).unwrap()), [vec![3, 2], vec![13, 12], vec![1], vec![11]]);
    assert_eq!(ids(&pack_cycle1_windows(&sessions, 2.0, 2.0, 16_000.0).unwrap()), [vec![3, 2], vec![13, 12]], "no more windows than the cap");
    assert_eq!(
        ids(&pack_cycle1_windows(&sessions, f64::NAN, f64::NAN, 16_000.0).unwrap()),
        [vec![3, 2, 1], vec![13, 12, 11]],
        "the defaults are 50 rows and 4 windows"
    );
}

#[test]
fn when_sessions_outnumber_the_windows_the_oldest_keeps_the_last_slot() {
    let sessions = [session("a", 1, 1), session("b", 11, 1), session("c", 21, 1)];
    assert_eq!(ids(&pack_cycle1_windows(&sessions, 50.0, 2.0, 16_000.0).unwrap()), [vec![1], vec![21]]);
    assert_eq!(ids(&pack_cycle1_windows(&sessions, 50.0, 1.0, 16_000.0).unwrap()), [vec![21]]);
}

#[test]
fn a_budget_under_4096_tokens_packs_nothing() {
    let message = pack_cycle1_windows(&[session("a", 1, 1)], 50.0, 4.0, 4095.0).unwrap_err().message();
    assert!(message.ends_with("cycle1 input_token_budget must be at least 4096"), "{message}");
    assert_eq!(cycle1_source_budget(4096.0).unwrap(), 2048.0);
    assert_eq!(cycle1_source_budget(16_000.0).unwrap(), 13_952.0);
    assert!(cycle1_source_budget(f64::NAN).is_err());
}

#[test]
fn rows_are_cut_into_packets_by_count_and_by_the_source_budget() {
    let rows: Vec<Row> = (1..=5).map(|id| row(id, id, "s", "x")).collect();
    assert_eq!(partition_cycle1_rows(&rows, 13_952.0, 2).iter().map(Vec::len).collect::<Vec<_>>(), [2, 2, 1]);
    assert_eq!(partition_cycle1_rows(&rows, 1.0, 50).iter().map(Vec::len).collect::<Vec<_>>(), [1, 1, 1, 1, 1], "a row too big to share a packet goes alone");
    assert!(partition_cycle1_rows(&[], 13_952.0, 50).is_empty());
}

// ---- merging runs ----

fn result(processed: i64, chunks: i64, pending: Option<i64>, failed: &[i64], quality: &[(&str, i64)]) -> Cycle1Result {
    Cycle1Result {
        processed,
        chunks,
        sessions: 1,
        pending_rows: pending,
        failed_row_ids: failed.to_vec(),
        quality: quality.iter().map(|(k, v)| ((*k).to_owned(), json!(v))).collect::<Map<_, _>>(),
        skipped_in_flight: true,
        ..Cycle1Result::default()
    }
}

#[test]
fn two_runs_merge_by_summing_their_counts_and_joining_their_ids_without_repeats() {
    let mut a = result(3, 1, Some(9), &[1, 2], &[("rows_considered", 4), ("failed_rows", 2)]);
    a.embedding_dirty = EmbeddingDirty { deferred: true, attempted: 2, succeeded: 1, failed: 1, failed_ids: vec![5] };
    let mut b = result(4, 2, None, &[2, 3], &[("rows_considered", 5), ("omitted_rows", 1)]);
    b.embedding_dirty = EmbeddingDirty { deferred: true, attempted: 1, succeeded: 1, failed: 0, failed_ids: vec![] };
    let merged = merge_cycle1_results(a, b).to_json();
    assert_eq!((merged["processed"].clone(), merged["chunks"].clone(), merged["sessions"].clone()), (json!(7), json!(3), json!(2)));
    assert_eq!(merged["pendingRows"], json!(9), "the later run's count, else the earlier one's");
    assert_eq!(merged["failed_row_ids"], json!([1, 2, 3]));
    assert_eq!(merged["quality"], json!({ "rows_considered": 9, "failed_rows": 2, "omitted_rows": 1 }));
    assert_eq!(merged["skippedInFlight"], json!(false));
    assert_eq!(merged["embedding_dirty"], json!({ "deferred": true, "attempted": 3, "succeeded": 2, "failed": 1, "failed_ids": [5] }));
}

// ---- the chunk's prompt and quality record ----

#[test]
fn the_source_text_names_each_session_once_per_run_and_numbers_the_rows() {
    assert_eq!(chunk_source_text(&[]), "");
    let mut second = row(2, 1700000000002, "sa", "two");
    second.element = Some("topic".into());
    let mut third = row(3, 1700000000003, "sb", "three");
    third.role = None;
    third.session_id = None;
    let text = chunk_source_text(&[row(1, 1700000000001, "sa", "first \"quoted\" line\nsecond"), second, third]);
    assert_eq!(
        text,
        "# session sa\n@1 {\"ts\":\"1700000000001\",\"role\":\"user\",\"content\":\"first \\\"quoted\\\" line\\nsecond\"}\n\
         @2 {\"ts\":\"1700000000002\",\"role\":\"user\",\"topic\":\"topic\",\"content\":\"two\"}\n\
         # session unknown\n@3 {\"ts\":\"1700000000003\",\"role\":null,\"content\":\"three\"}"
    );
}

#[test]
fn a_prompt_asks_for_a_third_of_the_source_and_a_rewrite_for_half_of_it() {
    let rows = [row(1, 1, "s", &"가".repeat(300))];
    let first = build_cycle1_chunk_prompt(&rows, false);
    assert!(first.starts_with("Length target: about ") && first.contains("roughly one third of the source"), "{first}");
    assert!(first.ends_with(&chunk_source_text(&rows)));
    let again = build_cycle1_chunk_prompt(&rows, true);
    assert!(again.starts_with("Rewrite: the previous summary of these rows was longer than the rows themselves ("), "{again}");
    assert!(again.contains("Keep it under "));
}

fn members() -> Vec<Row> {
    vec![row(10, 1, "s", &"가".repeat(80)), row(9, 2, "s", &"나".repeat(80))]
}

#[test]
fn a_quality_record_names_its_members_sorted_as_text_and_hashes_source_and_summary() {
    let record = make_chunk_quality("  요약  ", &members(), 1_800_000_000_000);
    assert_eq!(record["version"], 1);
    assert_eq!(record["verification"], "structural");
    assert_eq!(record["memberIds"], json!(["10", "9"]), "sorted as strings, as JavaScript sorts them");
    assert_eq!(record["verifiedAt"], 1_800_000_000_000_i64);
    assert_eq!(record["sourceHash"].as_str().unwrap().len(), 64);
    assert_eq!(record["summaryHash"], make_chunk_quality("요약", &members(), 0)["summaryHash"], "the summary is trimmed first");
    assert_eq!(
        record["sourceHash"],
        make_chunk_quality("요약", &[members()[1].clone(), members()[0].clone()], 0)["sourceHash"],
        "the order of the members does not matter"
    );
    let mut changed = members();
    changed[0].content.push('다');
    assert_ne!(record["sourceHash"], make_chunk_quality("요약", &changed, 0)["sourceHash"]);
    assert!(record["sourceTokens"].as_u64().unwrap() > record["summaryTokens"].as_u64().unwrap());
}

#[test]
fn a_root_is_usable_while_its_summary_is_shorter_and_its_record_still_matches_its_source() {
    let record = make_chunk_quality("요약", &members(), 5);
    let ok = assess_chunk_quality("요약", Some(&record), &members());
    assert!(ok.usable && ok.reasons.is_empty() && ok.shorter, "{ok:?}");
    assert_eq!(ok.provenance, "structural");
    let legacy = assess_chunk_quality("요약", None, &members());
    assert!(legacy.usable);
    assert_eq!(legacy.provenance, "legacy");
    assert_eq!(assess_chunk_quality("요약", Some(&Value::Null), &members()).provenance, "legacy");
}

#[test]
fn an_unusable_root_says_why_each_reason_for_itself() {
    let record = make_chunk_quality("요약", &members(), 5);
    assert_eq!(assess_chunk_quality("요약", Some(&record), &[]).reasons, ["missing_source", "not_shorter", "source_changed"]);
    let long = "요".repeat(400);
    assert!(assess_chunk_quality(&long, None, &members()).reasons.contains(&"not_shorter"));
    let mut mixed = members();
    mixed[1].session_id = Some("other".into());
    assert!(assess_chunk_quality("요약", None, &mixed).reasons.contains(&"mixed_sessions"));
    let twice = [members()[0].clone(), members()[0].clone()];
    assert!(assess_chunk_quality("요약", None, &twice).reasons.contains(&"duplicate_members"));
    let mut edited = members();
    edited[0].content.push('다');
    assert_eq!(assess_chunk_quality("요약", Some(&record), &edited).reasons, ["source_changed"]);
    assert_eq!(assess_chunk_quality("다른 요약", Some(&record), &members()).reasons, ["summary_changed"]);
    let mut stale = record.clone();
    stale["version"] = json!(2);
    assert_eq!(assess_chunk_quality("요약", Some(&stale), &members()).reasons, ["invalid_provenance"]);
}

// ---- cutting a long row ----

#[test]
fn a_row_that_fits_stays_whole_and_a_longer_one_is_cut_into_fragments_that_fit_and_rejoin_to_it() {
    let short = row(1, 1, "s", "hello");
    assert_eq!(split_cycle1_row(&short, 13_952.0).unwrap(), [short.clone()]);
    let budget = 300.0;
    let long = row(2, 2, "s", &"가나다라 ".repeat(200));
    let fragments = split_cycle1_row(&long, budget).unwrap();
    assert!(fragments.len() > 1);
    assert_eq!(fragments.iter().map(|f| f.content.as_str()).collect::<String>(), long.content);
    for fragment in &fragments {
        assert!(mixdog_js::token_estimate::estimate_tokens(&chunk_source_text(std::slice::from_ref(fragment))) as f64 <= budget);
        assert_eq!((fragment.id, fragment.ts), (2, 2), "a fragment keeps the row's identity");
    }
}

#[test]
fn a_cut_never_lands_inside_a_surrogate_pair() {
    let long = row(3, 3, "s", &"😀".repeat(300));
    let fragments = split_cycle1_row(&long, 200.0).unwrap();
    assert!(fragments.len() > 1);
    assert_eq!(fragments.iter().map(|f| f.content.as_str()).collect::<String>(), long.content);
    assert!(fragments.iter().all(|f| !f.content.contains('\u{fffd}')));
}

#[test]
fn a_row_whose_metadata_alone_exceeds_the_budget_cannot_be_cut() {
    assert_eq!(split_cycle1_row(&row(1, 1, "s", "text"), 1.0).unwrap_err(), "cycle1 row metadata exceeds source token budget");
}

// ---- the chunk generator ----

struct Scripted {
    replies: Vec<Result<String, String>>,
    prompts: Mutex<Vec<String>>,
}

impl Scripted {
    fn new(replies: &[Result<&str, &str>]) -> Self {
        Self { replies: replies.iter().map(|r| r.map(str::to_owned).map_err(str::to_owned)).collect(), prompts: Mutex::default() }
    }
}

#[async_trait]
impl Cycle1Llm for Scripted {
    async fn call(&self, _: &Cycle1Request, _: &CancellationToken, prompt: &str) -> Result<String, String> {
        let mut prompts = self.prompts.lock().unwrap();
        let reply = self.replies[prompts.len().min(self.replies.len() - 1)].clone();
        prompts.push(prompt.to_owned());
        reply
    }
}

const NOW: i64 = 1_800_000_000_000;

async fn generate(llm: &Scripted, rows: &[Row]) -> mixdog_services::memory::cycles::quality::Generated {
    let request = Cycle1Request { preset: None, timeout_ms: 1000.0 };
    let cancel = CancellationToken::new();
    let now = || NOW;
    generate_cycle1_chunks(rows, &Generation { llm, request: &request, cancel: &cancel, input_token_budget: 16_000.0, now: &now }).await.unwrap()
}

fn source() -> Vec<Row> {
    vec![row(1, 1, "s", &"가".repeat(40)), row(2, 2, "s", &"나".repeat(40))]
}

#[tokio::test]
async fn no_rows_or_too_little_text_is_left_raw_without_asking_the_classifier() {
    let llm = Scripted::new(&[Ok("1|t|fact|x")]);
    assert!(generate(&llm, &[]).await.chunks.is_empty());
    let small = [row(1, 1, "s", "hi")];
    let got = generate(&llm, &small).await;
    assert_eq!((got.chunks.len(), got.raw_row_ids, got.stats.grouping_calls), (0, vec![1], 0));
    assert!(llm.prompts.lock().unwrap().is_empty());
}

#[tokio::test]
async fn an_accepted_grouping_becomes_a_chunk_with_its_members_and_a_record_stamped_by_the_clock() {
    let llm = Scripted::new(&[Ok("1-2|topic|Decision|요약")]);
    let got = generate(&llm, &source()).await;
    assert_eq!(got.chunks.len(), 1);
    let chunk = &got.chunks[0];
    assert_eq!((chunk.element.as_str(), chunk.category.as_str(), chunk.summary.as_str(), chunk.idx_list.clone()), ("topic", "decision", "요약", vec![1, 2]));
    assert_eq!(chunk.members.iter().map(|m| m.id).collect::<Vec<_>>(), [1, 2]);
    assert_eq!(chunk.quality["verifiedAt"], NOW);
    assert!(got.raw_row_ids.is_empty() && got.invalid_chunks.is_empty());
    assert_eq!((got.stats.grouping_calls, got.stats.retries), (1, 0));
    assert_eq!(llm.prompts.lock().unwrap()[0], build_cycle1_chunk_prompt(&source(), false));
}

#[tokio::test]
async fn rows_the_reply_does_not_place_stay_raw_and_a_bad_line_is_reported() {
    let llm = Scripted::new(&[Ok("1|topic|fact|요약\nnot a line")]);
    let got = generate(&llm, &source()).await;
    assert_eq!(got.chunks.len(), 1);
    assert_eq!(got.raw_row_ids, [2]);
    assert_eq!(got.invalid_chunks.iter().map(|c| c.reason.as_str()).collect::<Vec<_>>(), ["invalid_line_format"]);
}

#[tokio::test]
async fn an_empty_reply_is_unparseable_and_leaves_every_row_raw() {
    let llm = Scripted::new(&[Ok("")]);
    let got = generate(&llm, &source()).await;
    assert!(got.chunks.is_empty());
    assert_eq!(got.raw_row_ids, [1, 2]);
    let unparseable = got.invalid_chunks.iter().find(|c| c.reason == "unparseable_response").expect("reported");
    assert_eq!(unparseable.member_ids, [1, 2]);
}

#[tokio::test]
async fn a_failed_call_is_recorded_with_its_message_and_the_rows_stay_raw() {
    let llm = Scripted::new(&[Err("provider down")]);
    let got = generate(&llm, &source()).await;
    assert!(got.chunks.is_empty());
    assert_eq!(got.raw_row_ids, [1, 2]);
    assert_eq!((got.invalid_chunks[0].reason.as_str(), got.invalid_chunks[0].error.as_deref()), ("llm_error", Some("provider down")));
}

#[tokio::test]
async fn a_summary_longer_than_its_rows_gets_one_rewrite_and_the_shorter_one_is_kept() {
    let longer = format!("1-2|topic|fact|{}", "다".repeat(200));
    let llm = Scripted::new(&[Ok(&longer), Ok("1-2|topic|fact|짧은 요약")]);
    let got = generate(&llm, &source()).await;
    assert_eq!(got.stats.retries, 1);
    assert_eq!(got.chunks.len(), 1);
    assert_eq!(got.chunks[0].summary, "짧은 요약");
    let prompts = llm.prompts.lock().unwrap();
    assert_eq!(prompts.len(), 2);
    assert!(prompts[1].starts_with("Rewrite: the previous summary"));
}

#[tokio::test]
async fn a_rewrite_that_is_still_longer_leaves_the_rows_raw() {
    let longer = format!("1-2|topic|fact|{}", "다".repeat(200));
    let llm = Scripted::new(&[Ok(&longer)]);
    let got = generate(&llm, &source()).await;
    assert!(got.chunks.is_empty());
    assert_eq!(got.raw_row_ids, [1, 2]);
    assert_eq!(llm.prompts.lock().unwrap().len(), 2, "one rewrite, then stop");
}

#[tokio::test]
async fn a_cancelled_generation_is_cancelled_and_a_budget_under_4096_is_refused() {
    let llm = Scripted::new(&[Ok("1-2|topic|fact|요약")]);
    let request = Cycle1Request { preset: None, timeout_ms: 1000.0 };
    let now = || NOW;
    let cancel = CancellationToken::new();
    cancel.cancel();
    let rows = source();
    assert!(
        generate_cycle1_chunks(&rows, &Generation { llm: &llm, request: &request, cancel: &cancel, input_token_budget: 16_000.0, now: &now }).await.is_err()
    );
    assert!(llm.prompts.lock().unwrap().is_empty(), "nothing is sent once cancelled");
    let live = CancellationToken::new();
    assert!(generate_cycle1_chunks(&rows, &Generation { llm: &llm, request: &request, cancel: &live, input_token_budget: 100.0, now: &now }).await.is_err());
}
