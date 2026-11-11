//! memory-chunk-quality-handoff: Cycle1 chunking (`memory/cycles/quality.rs`) and the compact handoff
//! (`memory/recall/compact.rs` + `render_entry_lines`), one test per recorded case.
//!
//! Inputs the recording holds only as the recorder's code (`record-memory-chunk-quality-handoff.mjs`) are rebuilt by
//! the same helpers here: `row(id, content, session)`, `answer(indexes, summary)` and each case's scripted classifier
//! reply. Every recorded output is compared whole, with these mappings:
//! - A Cycle1 row (`quality::Row`) holds the fields Cycle1 reads; a member or fragment Node returns is the input row
//!   object itself (`source_turn` included), so a Rust member is compared as the recorded input row with that id, with
//!   every field the Rust row holds taken from the Rust row.
//! - The classifier request: Node passes `{mode: 'cycle1', signal}`; the Rust port (`Cycle1Llm`) is the cycle1
//!   dispatch and gets the cancellation token. `signal` is `{aborted}` read from the token at the call when the run
//!   passes one (the recorder's `useSignal`), else absent as in Node.
//! - `stats.llmMs / verificationMs / totalMs` and `timingFields` are the manifest's normalisation (virtual clock, 0 in
//!   the recording): compared as the recorded 0 on the Node side and left out on the Rust side.
//! - An error a Rust entry returns is a JS `Error` with the error's message (the abort reason of case 17 is the
//!   caller's `Error('cancelled')`; the core's cancellation is `cancelled`).
//! - The pure parser of case 5 ran inside a 1 s vm limit in Node; the Rust parser is called directly.
//! - Quoted rows: the recorder's rows carry a numeric `ts`; Node's database path hands BIGINT over as text
//!   (`cycle1-rows.mjs:195`, `cycle1-window.mjs:31`), which is the only form a core row has, so the recorded prompts
//!   and quoted rows are compared in that form (`db_prompt`, `db_quoted`).
//!
//! Not replayed, reported for a decision on the recording: cases 18, 19 and 20 (test lines 287, 300, 319). Their
//! fragment cuts are made against a token budget that counts the quoted row, so a numeric `ts` (2 characters shorter
//! than Node's database form) moves the cuts and the per-part token counts (case 18's last part: 752 recorded, 753
//! for `"ts":"1000"`); no mapping of the recorded text gives the values Node computes for database rows.

use std::sync::Mutex;

use async_trait::async_trait;
use mixdog_js::token_estimate::estimate_tokens;
use mixdog_testkit::Exact;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use super::{assert_case_count, case, golden, int, object, render_options, rows, same, same_rows, string};
use crate::memory::cycles::quality::{
    Assessment, CYCLE1_INPUT_TOKEN_BUDGET, Generation, InvalidChunk, Parsed, Row, Validity, assess_chunk_quality,
    build_cycle1_chunk_prompt, cycle1_source_budget, generate_cycle1_chunks, make_chunk_quality,
    parse_cycle1_line_format, partition_cycle1_rows, validate_cycle1_grouping,
};
use crate::memory::cycles::{Cycle1Llm, Cycle1Request};
use crate::memory::recall::compact::compact_handoff_rows;
use crate::memory::recall::format::render_entry_lines;
use crate::memory::recall::period::Clock;

const SET: &str = "memory-chunk-quality-handoff";
const REPEATED: &str = "The request and its details are repeated. ";
const TIMING: [&str; 3] = ["llmMs", "verificationMs", "totalMs"];

// ---- the recorder's input helpers

/// `row(id, content, session)`: `{id, ts: id * 1000, source_turn: id, session_id, role, content}`.
fn input(id: i64, content: Option<&str>, session: &str) -> Exact {
    object(vec![
        ("id", int(id)),
        ("ts", int(id * 1000)),
        ("source_turn", int(id)),
        ("session_id", string(session)),
        ("role", string(if id % 2 == 1 { "user" } else { "assistant" })),
        ("content", string(content.map_or_else(|| REPEATED.repeat(5), str::to_owned))),
    ])
}

fn answer(indexes: &str, summary: Option<&str>) -> String {
    format!("{indexes}|request|task|{}", summary.unwrap_or("The request remains pending."))
}

/// A recorded Cycle1 row as the Rust row; `source_turn` is carried by Node and read by no Cycle1 step.
pub(super) fn qrow(value: &Exact) -> Row {
    let mut row = Row { id: 0, ts: 0, role: None, content: String::new(), session_id: None, project_id: None, element: None };
    for (key, v) in value.entries() {
        let text = || match v {
            Exact::String(s) => Some(s.clone()),
            Exact::Null | Exact::Undefined => None,
            other => panic!("{key}: {other:?}"),
        };
        match key.as_str() {
            "id" => row.id = v.as_f64() as i64,
            "ts" => row.ts = v.as_f64() as i64,
            "role" => row.role = text(),
            "content" => row.content = text().unwrap_or_default(),
            "session_id" => row.session_id = text(),
            "project_id" => row.project_id = text(),
            "element" => row.element = text(),
            "source_turn" => {}
            other => panic!("a Cycle1 row key the replay does not map: {other}"),
        }
    }
    row
}

fn qrows(value: &Exact) -> Vec<Row> {
    value.as_array().iter().map(qrow).collect()
}

/// A Rust row as the recorded input row it came from: the template's keys in order, each value the Rust row holds
/// taken from the Rust row.
fn as_recorded(row: &Row, template: &Exact) -> Exact {
    let opt = |v: &Option<String>| v.clone().map_or(Exact::Null, Exact::String);
    Exact::Object(
        template
            .entries()
            .iter()
            .map(|(key, recorded)| {
                let value = match key.as_str() {
                    "id" => int(row.id),
                    "ts" => int(row.ts),
                    "role" => opt(&row.role),
                    "content" => string(row.content.as_str()),
                    "session_id" => opt(&row.session_id),
                    "project_id" => opt(&row.project_id),
                    "element" => opt(&row.element),
                    _ => recorded.clone(),
                };
                (key.clone(), value)
            })
            .collect(),
    )
}

fn by_id<'a>(inputs: &'a Exact, id: i64) -> &'a Exact {
    inputs.as_array().iter().find(|r| r.get("id").as_f64() as i64 == id).unwrap_or_else(|| panic!("no input row {id}"))
}

fn ints(items: impl IntoIterator<Item = i64>) -> Exact {
    Exact::Array(items.into_iter().map(int).collect())
}

fn strings<S: AsRef<str>>(items: impl IntoIterator<Item = S>) -> Exact {
    Exact::Array(items.into_iter().map(|s| string(s.as_ref())).collect())
}

fn ok(value: Exact) -> Exact {
    object(vec![("result", value)])
}

fn error_of(message: String) -> Exact {
    Exact::Error { name: "Error".into(), message, code: None, cause: None, props: Vec::new() }
}

// ---- outputs as Node's values

fn parsed_value(parsed: &Parsed) -> Exact {
    match parsed.parse_error {
        Some(error) => object(vec![("_idxList", ints(parsed.idx_list.clone())), ("_parseError", string(error))]),
        None => object(vec![
            ("_idxList", ints(parsed.idx_list.clone())),
            ("element", string(parsed.element.as_str())),
            ("category", string(parsed.category.as_str())),
            ("summary", string(parsed.summary.as_str())),
        ]),
    }
}

fn parse_value(text: &str) -> Exact {
    parse_cycle1_line_format(text).map_or(Exact::Null, |chunks| Exact::Array(chunks.iter().map(parsed_value).collect()))
}

fn invalid_value(invalid: &InvalidChunk) -> Exact {
    Exact::plain(&invalid.to_json())
}

fn validity_value(validity: &Validity) -> Exact {
    object(vec![
        ("valid", Exact::Bool(validity.valid)),
        ("errors", strings(&validity.errors)),
        ("omitted", ints(validity.omitted.iter().map(|&n| n as i64))),
        ("accepted", Exact::Array(validity.accepted.iter().map(parsed_value).collect())),
        ("invalid", Exact::Array(validity.invalid.iter().map(invalid_value).collect())),
    ])
}

fn validate(text: &str, rows: &[Row]) -> Exact {
    validity_value(&validate_cycle1_grouping(parse_cycle1_line_format(text).as_deref(), rows))
}

pub(super) fn assessment_value(a: &Assessment) -> Exact {
    object(vec![
        ("usable", Exact::Bool(a.usable)),
        ("reasons", strings(&a.reasons)),
        ("provenance", Exact::plain(&a.provenance)),
        ("sourceTokens", int(a.source_tokens as i64)),
        ("summaryTokens", int(a.summary_tokens as i64)),
        ("shorter", Exact::Bool(a.shorter)),
    ])
}

/// The `@n {json}` rows of a prompt, as the recorder's `sourceRows` reads them.
fn source_rows(prompt: &str) -> Vec<Exact> {
    // `/^@\d+ /`
    fn quoted(line: &str) -> Option<&str> {
        let digits = line.strip_prefix('@')?;
        let end = digits.find(|c: char| !c.is_ascii_digit())?;
        (end > 0).then_some(())?;
        digits[end..].strip_prefix(' ')
    }
    prompt
        .split('\n')
        .filter_map(quoted)
        .map(|json| Exact::plain(&serde_json::from_str::<Value>(json).expect("a quoted row is JSON")))
        .collect()
}

/// The recorded prompt as Node writes it for rows read from the database: node-postgres hands `ts` (BIGINT) over as
/// text (`cycle1-rows.mjs:195`, `cycle1-window.mjs:31`), so a quoted row's `"ts":1000` of the recorder's numeric test
/// rows is `"ts":"1000"` there, which is the only form the core's rows have.
fn db_prompt(prompt: &str) -> String {
    prompt
        .split('\n')
        .map(|line| {
            let Some(rest) = line.strip_prefix('@') else { return line.to_owned() };
            let Some(space) = rest.find(' ') else { return line.to_owned() };
            let (n, body) = rest.split_at(space);
            let Some(ts) = body.strip_prefix(" {\"ts\":") else { return line.to_owned() };
            let end = ts.find(',').unwrap_or(0);
            if n.is_empty() || !n.bytes().all(|b| b.is_ascii_digit()) || end == 0 || !ts[..end].bytes().all(|b| b.is_ascii_digit()) {
                return line.to_owned();
            }
            format!("@{n} {{\"ts\":\"{}\"{}", &ts[..end], &ts[end..])
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn db_prompt_value(prompt: &Exact) -> Exact {
    string(db_prompt(prompt.as_str()))
}

/// A recorded quoted row (`sourceRows`) in the database form of `db_prompt`.
fn db_quoted(row: &Exact) -> Exact {
    Exact::Object(
        row.entries()
            .iter()
            .map(|(k, v)| match (k.as_str(), v) {
                ("ts", Exact::Number(n)) => (k.clone(), string((*n as i64).to_string())),
                _ => (k.clone(), v.clone()),
            })
            .collect(),
    )
}

fn db_quoted_rows(rows: &Exact) -> Exact {
    Exact::Array(rows.as_array().iter().map(db_quoted).collect())
}

fn db_calls(calls: &Exact) -> Exact {
    Exact::Array(
        calls
            .as_array()
            .iter()
            .map(|call| {
                Exact::Object(
                    call.entries()
                        .iter()
                        .map(|(k, v)| (k.clone(), if k == "prompt" { db_prompt_value(v) } else { v.clone() }))
                        .collect(),
                )
            })
            .collect(),
    )
}

fn without_timing(value: &Exact) -> Exact {
    Exact::Object(value.entries().iter().filter(|(k, _)| !TIMING.contains(&k.as_str())).cloned().collect())
}

// ---- the scripted classifier

type Reply = Box<dyn Fn(usize, &str, &CancellationToken) -> Result<String, String> + Send + Sync>;

struct Script {
    reply: Reply,
    signal: bool,
    calls: Mutex<Vec<Exact>>,
}

#[async_trait]
impl Cycle1Llm for Script {
    async fn call(&self, _request: &Cycle1Request, cancel: &CancellationToken, prompt: &str) -> Result<String, String> {
        let n = {
            let mut calls = self.calls.lock().expect("calls");
            let mut request = vec![("mode", string("cycle1"))];
            request.push(("signal", if self.signal { object(vec![("aborted", Exact::Bool(cancel.is_cancelled()))]) } else { Exact::Undefined }));
            calls.push(object(vec![("request", object(request)), ("prompt", string(prompt))]));
            calls.len()
        };
        (self.reply)(n, prompt, cancel)
    }
}

/// A generator run compared with the recorded `run`: calls in order, then the result or the error, whole.
async fn generate(what: &str, run: &Exact, now_ms: i64, signal: bool, reply: Reply) -> (Exact, Vec<Exact>) {
    let inputs = run.get("rows");
    let rows = qrows(inputs);
    let budget = match run.get("inputTokenBudget") {
        Exact::Undefined => CYCLE1_INPUT_TOKEN_BUDGET,
        other => other.as_f64(),
    };
    let script = Script { reply, signal, calls: Mutex::new(Vec::new()) };
    let cancel = CancellationToken::new();
    let request = Cycle1Request { preset: None, timeout_ms: 0.0 };
    let now = move || now_ms;
    let ctx = Generation { llm: &script, request: &request, cancel: &cancel, input_token_budget: budget, now: &now };
    let outcome = tokio::time::timeout(std::time::Duration::from_secs(60), generate_cycle1_chunks(&rows, &ctx))
        .await
        .unwrap_or_else(|_| panic!("{what}: the generator did not settle within 60 s"));
    let calls = script.calls.into_inner().expect("calls");
    same(&format!("{what}: calls"), &db_calls(run.get("calls")), &Exact::Array(calls.clone()));
    match outcome {
        Ok(generated) => {
            let chunks = generated
                .chunks
                .iter()
                .map(|chunk| {
                    let members = chunk.members.iter().map(|m| as_recorded(m, by_id(inputs, m.id))).collect();
                    object(vec![
                        ("_idxList", ints(chunk.idx_list.clone())),
                        ("element", string(chunk.element.as_str())),
                        ("category", string(chunk.category.as_str())),
                        ("summary", string(chunk.summary.as_str())),
                        ("members", Exact::Array(members)),
                        ("quality", Exact::plain(&chunk.quality)),
                    ])
                })
                .collect();
            let stats = without_timing(&Exact::plain(&generated.stats.to_json(generated.total_ms)));
            let result = object(vec![
                ("chunks", Exact::Array(chunks)),
                ("rawRowIds", ints(generated.raw_row_ids.clone())),
                ("invalidChunks", Exact::Array(generated.invalid_chunks.iter().map(invalid_value).collect())),
                ("stats", stats),
            ]);
            let recorded = run.get("result");
            let recorded_stats = recorded.get("stats");
            for key in TIMING {
                assert_eq!(recorded_stats.get(key), &int(0), "{what}: the recorded {key} is the virtual clock's 0");
            }
            for key in ["llmMs", "totalMs"] {
                assert_eq!(run.get("timingFields").get(key), &int(0), "{what}: timingFields.{key}");
            }
            let recorded = Exact::Object(
                recorded.entries().iter().map(|(k, v)| (k.clone(), if k == "stats" { without_timing(v) } else { v.clone() })).collect(),
            );
            same(&format!("{what}: result"), &recorded, &result);
        }
        Err(error) => {
            assert!(run.try_get("result").is_none(), "{what}: Node returned a result, Rust failed with {}", error.message());
            same(&format!("{what}: error"), run.get("error"), &error_of(error.message()));
        }
    }
    let prompts = calls.iter().map(|c| c.get("prompt").clone()).collect();
    (Exact::Array(calls), prompts)
}

fn fixed(text: String) -> Reply {
    Box::new(move |_, _, _| Ok(text.clone()))
}

fn now_ms(g: &Exact) -> i64 {
    g.get("clock").get("dateNowMs").as_f64() as i64
}

#[test]
fn the_recording_has_twenty_seven_cases() {
    assert_case_count(&golden(SET), 27);
}

// ---- prompts

#[test]
fn full_quoted_input_retains_code_urls_pipes_and_a_condition_after_character_400() {
    let g = golden(SET);
    let name = "full quoted input retains code, URLs, pipes and a condition after character 400";
    let c = case(&g, 0, name);
    let text = c.get("text").as_str();
    let prompt = build_cycle1_chunk_prompt(&[qrow(&input(1, Some(text), "s"))], false);
    same(name, &db_prompt_value(c.get("prompt")), &string(prompt.as_str()));
    let quoted = source_rows(&prompt);
    same(&format!("{name}: quotedContent"), c.get("quotedContent"), quoted[0].get("content"));
    same(&format!("{name}: quotedEqualsInput"), c.get("quotedEqualsInput"), &Exact::Bool(quoted[0].get("content").as_str() == text));
    let injected = build_cycle1_chunk_prompt(&[qrow(&input(1, Some(c.get("injectedInput").as_str()), "s"))], false);
    same(&format!("{name}: injectedPrompt"), &db_prompt_value(c.get("injectedPrompt")), &string(injected.as_str()));
    same(&format!("{name}: injectedQuotedRows"), &db_quoted_rows(c.get("injectedQuotedRows")), &Exact::Array(source_rows(&injected)));
}

#[test]
fn source_topic_keys_stay_quoted_data_alongside_their_complete_bodies() {
    let g = golden(SET);
    let name = "source topic keys stay quoted data alongside their complete bodies";
    let c = case(&g, 1, name);
    let prompt = build_cycle1_chunk_prompt(&[qrow(c.get("input"))], false);
    same(name, &db_prompt_value(c.get("prompt")), &string(prompt.as_str()));
    same(&format!("{name}: quotedRows"), &db_quoted_rows(c.get("quotedRows")), &Exact::Array(source_rows(&prompt)));
}

#[test]
fn a_request_carries_only_its_own_length_target_and_session_grouped_rows() {
    let g = golden(SET);
    let name = "a request carries only its own length target and session-grouped rows";
    let c = case(&g, 2, name);
    let prompt = build_cycle1_chunk_prompt(&qrows(c.get("rows")), false);
    same(name, &db_prompt_value(c.get("prompt")), &string(prompt.as_str()));
    let lines: Vec<&str> = prompt.split('\n').collect();
    same(&format!("{name}: firstLine"), c.get("firstLine"), &string(lines[0]));
    same(&format!("{name}: sessionHeaders"), c.get("sessionHeaders"), &strings(lines.iter().filter(|l| l.starts_with("# session "))));
    let has_session = source_rows(&prompt).iter().any(|r| r.try_get("session").is_some());
    same(&format!("{name}: anyQuotedRowHasSession"), c.get("anyQuotedRowHasSession"), &Exact::Bool(has_session));
    same(&format!("{name}: containsGroupRowsByTask"), c.get("containsGroupRowsByTask"), &Exact::Bool(prompt.contains("Group rows by task")));
}

// ---- parse and validation

#[test]
fn invalid_indexes_and_malformed_extra_lines_cannot_silently_lose_source_membership() {
    let g = golden(SET);
    let name = "invalid indexes and malformed extra lines cannot silently lose source membership";
    let one = [qrow(&input(1, None, "s"))];
    for (i, probe) in case(&g, 3, name).get("probes").as_array().iter().enumerate() {
        let text = match probe.try_get("indexes") {
            Some(indexes) => answer(indexes.as_str(), None),
            None => probe.get("text").as_str().to_owned(),
        };
        same(&format!("{name}: probe {i} parsed"), probe.get("parsed"), &ok(parse_value(&text)));
        if let Some(validated) = probe.try_get("validated") {
            same(&format!("{name}: probe {i} validated"), validated, &ok(validate(&text, &one)));
        }
    }
}

#[test]
fn ascending_index_ranges_expand_reversed_or_overlapping_ranges_stay_invalid() {
    let g = golden(SET);
    let name = "ascending index ranges expand; reversed or overlapping ranges stay invalid";
    let c = case(&g, 4, name);
    let eight: Vec<Row> = (1..=8).map(|id| qrow(&input(id, None, "s"))).collect();
    let text = c.get("text").as_str();
    same(&format!("{name}: parsed"), c.get("parsed"), &parse_value(text));
    same(&format!("{name}: validated"), c.get("validated"), &ok(validate(text, &eight)));
    for (i, probe) in c.get("probes").as_array().iter().enumerate() {
        let text = probe.get("text").as_str();
        same(&format!("{name}: probe {i} parsed"), probe.get("parsed"), &ok(parse_value(text)));
        same(&format!("{name}: probe {i} validated"), probe.get("validated"), &ok(validate(text, &eight[..3])));
    }
    let overlap = c.get("overlap");
    same(&format!("{name}: overlap"), overlap.get("validated"), &ok(validate(overlap.get("text").as_str(), &eight[..3])));
}

#[test]
fn indexes_past_the_safe_integer_range_are_rejected_without_hanging_the_parser() {
    let g = golden(SET);
    let name = "indexes past the safe-integer range are rejected without hanging the parser";
    let c = case(&g, 5, name);
    let one = [qrow(&input(1, None, "s"))];
    for (i, probe) in c.get("probes").as_array().iter().enumerate() {
        // The recorder writes an index text longer than 40 characters as `1 repeated <n> times`.
        let label = probe.get("indexes").as_str();
        let indexes = match label.strip_prefix("1 repeated ").and_then(|rest| rest.strip_suffix(" times")) {
            Some(n) => "1".repeat(n.parse().expect("count")),
            None => label.to_owned(),
        };
        same(&format!("{name}: probe {i}"), probe.get("validated"), &ok(validate(&answer(&indexes, None), &one)));
    }
    let mixed = c.get("mixed");
    same(&format!("{name}: mixed"), mixed.get("validated"), &ok(validate(mixed.get("text").as_str(), &one)));
}

#[test]
fn any_omission_duplicate_mixed_session_or_incomplete_field_fails_the_entire_partition() {
    let g = golden(SET);
    let name = "any omission, duplicate, mixed session or incomplete field fails the entire partition";
    let c = case(&g, 6, name);
    let ten: Vec<Row> = (1..=c.get("rowCount").as_f64() as i64).map(|id| qrow(&input(id, None, "s"))).collect();
    let probes = c.get("probes").as_array();
    for (i, probe) in probes.iter().enumerate() {
        let text = probe.get("text").as_str();
        // The recorder's fifth probe names its rows; the sixth validates against `[row(1)]`.
        let rows = match (probe.try_get("rows"), i) {
            (Some(rows), _) => qrows(rows),
            (None, 5) => ten[..1].to_vec(),
            (None, _) => ten.clone(),
        };
        same(&format!("{name}: probe {i}"), probe.get("validated"), &ok(validate(text, &rows)));
    }
}

// ---- the generator

#[tokio::test(flavor = "current_thread")]
async fn one_call_keeps_the_good_chunk_and_fills_omitted_rows_from_the_source_without_retry() {
    let g = golden(SET);
    let name = "one call keeps the good chunk and fills omitted rows from the source without retry";
    let c = case(&g, 7, name);
    generate(name, c.get("run"), now_ms(&g), false, fixed(answer("1", None))).await;
    // The recorder generates again with the same reply and assesses the first chunk against `[row(1)]`.
    let rows = vec![qrow(&input(1, None, "s")), qrow(&input(2, None, "s"))];
    let script = Script { reply: fixed(answer("1", None)), signal: false, calls: Mutex::new(Vec::new()) };
    let (cancel, request, now) = (CancellationToken::new(), Cycle1Request { preset: None, timeout_ms: 0.0 }, || now_ms(&g));
    let ctx = Generation { llm: &script, request: &request, cancel: &cancel, input_token_budget: CYCLE1_INPUT_TOKEN_BUDGET, now: &now };
    let generated = generate_cycle1_chunks(&rows, &ctx).await.expect("generated");
    let chunk = &generated.chunks[0];
    let assessed = assess_chunk_quality(&chunk.summary, Some(&chunk.quality), &rows[..1]);
    same(&format!("{name}: reassessed"), c.get("reassessed"), &ok(assessment_value(&assessed)));
}

#[tokio::test(flavor = "current_thread")]
async fn bad_lines_and_duplicate_chunks_do_not_discard_independent_good_chunks() {
    let g = golden(SET);
    let name = "bad lines and duplicate chunks do not discard independent good chunks";
    let reply = format!("{}\nmalformed\n{}\n{}", answer("1,2", None), answer("3,3", None), answer("4", None));
    generate(name, case(&g, 8, name).get("run"), now_ms(&g), false, fixed(reply)).await;
}

#[tokio::test(flavor = "current_thread")]
async fn overlapping_chunks_are_both_rejected_while_unaffected_rows_can_still_be_compressed() {
    let g = golden(SET);
    let name = "overlapping chunks are both rejected while unaffected rows can still be compressed";
    let reply = format!("{}\n{}\n{}", answer("1,2", None), answer("2,3", None), answer("4", None));
    generate(name, case(&g, 9, name).get("run"), now_ms(&g), false, fixed(reply)).await;
}

#[tokio::test(flavor = "current_thread")]
async fn a_source_too_short_to_summarize_stays_raw_without_an_ai_call() {
    let g = golden(SET);
    let name = "a source too short to summarize stays RAW without an AI call";
    generate(name, case(&g, 10, name).get("run"), now_ms(&g), false, Box::new(|_, _, _| Err("unexpected AI call".into()))).await;
}

#[tokio::test(flavor = "current_thread")]
async fn a_shorter_summary_above_half_the_source_is_accepted_in_one_call() {
    let g = golden(SET);
    let name = "a shorter summary above half the source is accepted in one call";
    let c = case(&g, 11, name);
    let summary = c.get("summary").as_str();
    same(&format!("{name}: summaryTokens"), c.get("summaryTokens"), &int(estimate_tokens(summary) as i64));
    let content = c.get("run").get("rows").as_array()[0].get("content").as_str();
    same(&format!("{name}: sourceTokens"), c.get("sourceTokens"), &int(estimate_tokens(content) as i64));
    generate(name, c.get("run"), now_ms(&g), false, fixed(answer("1", Some(summary)))).await;
}

#[tokio::test(flavor = "current_thread")]
async fn an_expanded_summary_gets_one_rewrite_of_its_rows_and_stays_raw_when_still_longer() {
    let g = golden(SET);
    let name = "an expanded summary gets one rewrite of its rows and stays RAW when still longer";
    let summary = "An expanded explanation with invented and unnecessary extra wording. ".repeat(8);
    generate(name, case(&g, 12, name).get("run"), now_ms(&g), false, fixed(answer("1,2", Some(&summary)))).await;
}

#[tokio::test(flavor = "current_thread")]
async fn a_shorter_rewrite_replaces_only_the_expanded_grouping_and_maps_back_to_the_original_rows() {
    let g = golden(SET);
    let name = "a shorter rewrite replaces only the expanded grouping and maps back to the original rows";
    let c = case(&g, 13, name);
    let rows = c.get("run").get("rows").as_array();
    let brief = Exact::Array(vec![rows[2].get("content").clone(), rows[3].get("content").clone()]);
    same(&format!("{name}: brief"), c.get("brief"), &brief);
    let first = format!(
        "{}\n{}",
        answer("1,2", None),
        answer("3,4", Some("A long restatement of the exchange about the omitted marker that ends up longer than the exchange itself."))
    );
    let reply: Reply = Box::new(move |n, _, _| Ok(if n == 1 { first.clone() } else { answer("1,2", Some("Marker hides preview blocks.")) }));
    let (_, prompts) = generate(name, c.get("run"), now_ms(&g), false, reply).await;
    let second: Vec<Exact> = source_rows(prompts[1].as_str()).iter().map(|r| r.get("content").clone()).collect();
    same(&format!("{name}: secondCallSourceContents"), c.get("secondCallSourceContents"), &Exact::Array(second));
}

#[tokio::test(flavor = "current_thread")]
async fn legitimate_isolated_topics_do_not_trigger_a_singleton_quota() {
    let g = golden(SET);
    let name = "legitimate isolated topics do not trigger a singleton quota";
    let reply = (1..=8).map(|i| answer(&i.to_string(), None)).collect::<Vec<_>>().join("\n");
    generate(name, case(&g, 14, name).get("run"), now_ms(&g), false, fixed(reply)).await;
}

#[tokio::test(flavor = "current_thread")]
async fn malformed_responses_keep_source_rows_without_another_ai_call() {
    let g = golden(SET);
    let name = "malformed responses keep source rows without another AI call";
    for run in case(&g, 15, name).get("runs").as_array() {
        let response = run.get("response").as_str().to_owned();
        generate(&format!("{name}: {}", run.get("label").as_str()), run, now_ms(&g), false, fixed(response)).await;
    }
}

#[tokio::test(flavor = "current_thread")]
async fn transport_failure_is_not_a_negative_quality_verdict_or_a_silent_retry() {
    let g = golden(SET);
    let name = "transport failure is not a negative quality verdict or a silent retry";
    let reply: Reply = Box::new(|_, _, _| Err("The usage limit has been reached".into()));
    generate(name, case(&g, 16, name).get("run"), now_ms(&g), false, reply).await;
}

#[tokio::test(flavor = "current_thread")]
async fn cancellation_is_propagated_and_never_converted_to_a_quality_verdict() {
    let g = golden(SET);
    let name = "cancellation is propagated and never converted to a quality verdict";
    let reply: Reply = Box::new(|_, _, cancel| {
        cancel.cancel();
        Ok(answer("1", None))
    });
    generate(name, case(&g, 17, name).get("run"), now_ms(&g), true, reply).await;
}

#[tokio::test(flavor = "current_thread")]
async fn large_multi_row_input_partitions_without_loss_and_maps_local_indexes_back_to_originals() {
    let g = golden(SET);
    let name = "large multi-row input partitions without loss and maps local indexes back to originals";
    let c = case(&g, 21, name);
    let inputs = c.get("run").get("rows");
    let rows = qrows(inputs);
    let packets = partition_cycle1_rows(&rows, cycle1_source_budget(4096.0).expect("budget"), 50);
    let ids = Exact::Array(packets.iter().map(|p| ints(p.iter().map(|r| r.id))).collect());
    same(&format!("{name}: packets"), c.get("packets"), &ids);
    let flat: Vec<Row> = packets.concat();
    same(&format!("{name}: flatEqualsRows"), c.get("flatEqualsRows"), &Exact::Bool(flat == rows));
    let reply: Reply = Box::new(|_, prompt, _| {
        Ok(answer(&(1..=source_rows(prompt).len()).map(|i| i.to_string()).collect::<Vec<_>>().join(","), None))
    });
    generate(name, c.get("run"), now_ms(&g), false, reply).await;
}

// ---- assessments

/// The recorder's quality probes: `(label, root summary, root carries the record, members)`; `None` members are the
/// root's own.
fn assess_probe(summary: &str, quality: Option<&serde_json::Value>, members: &[Row]) -> Exact {
    ok(assessment_value(&assess_chunk_quality(summary, quality, members)))
}

#[test]
fn legacy_chunks_are_reusable_while_expanded_altered_and_incomplete_known_chunks_are_rejected() {
    let g = golden(SET);
    let name = "legacy chunks are reusable while expanded, altered and incomplete known chunks are rejected";
    let c = case(&g, 22, name);
    let members = qrows(c.get("members"));
    let root = c.get("root");
    let summary = root.get("summary").as_str();
    let quality = make_chunk_quality(summary, &members, now_ms(&g));
    same(&format!("{name}: chunk_quality"), root.get("chunk_quality"), &Exact::plain(&quality));
    let changed = vec![qrow(&input(1, Some("changed"), "s")), members[1].clone()];
    let duplicated = vec![members[0].clone(), members[1].clone(), members[0].clone()];
    let expanded = "Expanded. ".repeat(1000);
    let probes: [(&str, &str, Option<&serde_json::Value>, &[Row]); 7] = [
        ("legacy root", summary, None, &members),
        ("known root", summary, Some(&quality), &members),
        ("summary altered", "It succeeded.", Some(&quality), &members),
        ("member list cut", summary, Some(&quality), &members[1..]),
        ("duplicated member", summary, Some(&quality), &duplicated),
        ("member content changed", summary, Some(&quality), &changed),
        ("expanded summary", &expanded, Some(&quality), &members),
    ];
    let steps = c.get("steps").as_array();
    assert_eq!(steps.len(), probes.len(), "{name}: steps");
    for (step, (label, summary, quality, members)) in steps.iter().zip(probes) {
        assert_eq!(step.get("label").as_str(), label, "{name}: step order");
        let mut actual = vec![("label".to_owned(), string(label))];
        if let Exact::Object(entries) = assess_probe(summary, quality, members) {
            actual.extend(entries);
        }
        // The legacy step also records the root's chunk_quality after the assessment: none yet (the Rust assessment
        // borrows the root and cannot write it).
        if step.try_get("chunkQualityAfter").is_some() {
            actual.push(("chunkQualityAfter".into(), Exact::Undefined));
        }
        same(&format!("{name}: {label}"), step, &Exact::Object(actual));
    }
}

// ---- compact handoff

fn handoff(what: &str, h: &Exact, clock: &Clock) {
    let input = rows(h.get("roots")).expect("recorded roots");
    let kept = format!("{input:?}");
    let projected = compact_handoff_rows(input.clone(), 0, &estimate_tokens);
    same_rows(&format!("{what}: projected"), h.get("projected").get("result"), &projected);
    let options = h.try_get("renderOptions").unwrap_or(&Exact::Undefined);
    let rendered = render_entry_lines(clock, &projected, &render_options(options));
    same(&format!("{what}: rendered"), h.get("rendered"), &ok(string(rendered)));
    same(&format!("{what}: rootsUnchanged"), h.get("rootsUnchanged"), &Exact::Bool(format!("{input:?}") == kept));
}

fn clock(g: &Exact) -> Clock {
    Clock { now_ms: now_ms(g), zone: chrono_tz::UTC }
}

#[test]
fn known_stale_summary_fallback_includes_the_original_root_body_code_urls_and_every_unique_member() {
    let g = golden(SET);
    let name = "known stale-summary fallback includes the original root body, code, URLs and every unique member (test line 372)";
    handoff(name, case(&g, 23, name).get("handoff"), &clock(&g));
}

#[test]
fn legacy_compressed_bodies_contain_no_search_metadata_ids_or_role_labels() {
    let g = golden(SET);
    let name = "legacy compressed bodies contain no search metadata, IDs or role labels (test line 393)";
    handoff(name, case(&g, 24, name).get("handoff"), &clock(&g));
}

#[test]
fn overlapping_chunk_memberships_fall_back_to_unique_originals_instead_of_duplicate_summaries() {
    let g = golden(SET);
    let name = "overlapping chunk memberships fall back to unique originals instead of duplicate summaries (test line 406)";
    handoff(name, case(&g, 25, name).get("handoff"), &clock(&g));
}

#[test]
fn further_shapes_beyond_the_test_file() {
    let g = golden(SET);
    let name = "further shapes (beyond the test file)";
    let c = case(&g, 26, name);
    for h in c.get("handoffs").as_array() {
        handoff(&format!("{name}: {}", h.get("label").as_str()), h, &clock(&g));
    }
    // The recorder's roots: `members = [row(1), row(2)]`, the verified root's record made by `makeChunkQuality`.
    let members = vec![qrow(&input(1, None, "s")), qrow(&input(2, None, "s"))];
    let summary = "Pending request.";
    let quality = make_chunk_quality(summary, &members, now_ms(&g));
    let verified_root = case(&g, 25, "overlapping chunk memberships fall back to unique originals instead of duplicate summaries (test line 406)")
        .get("handoff")
        .get("roots")
        .as_array()[0]
        .get("chunk_quality");
    same(&format!("{name}: the verified root's record"), verified_root, &Exact::plain(&quality));
    let changed = vec![qrow(&input(1, Some("changed"), "s")), members[1].clone()];
    let duplicated = vec![members[0].clone(), members[1].clone(), members[0].clone()];
    let expanded = "Expanded. ".repeat(1000);
    let probes: [(&str, &str, Option<&serde_json::Value>, &[Row]); 6] = [
        ("legacy root with members", summary, None, &members),
        ("verified root", summary, Some(&quality), &members),
        ("verified root, member list cut", summary, Some(&quality), &members[1..]),
        ("verified root, duplicated member", summary, Some(&quality), &duplicated),
        ("verified root, member content changed", summary, Some(&quality), &changed),
        ("expanded summary", &expanded, Some(&quality), &members),
    ];
    let recorded = c.get("quality").as_array();
    assert_eq!(recorded.len(), probes.len(), "{name}: quality probes");
    for (probe, (label, summary, quality, members)) in recorded.iter().zip(probes) {
        assert_eq!(probe.get("label").as_str(), label, "{name}: probe order");
        // A probe that names its members records them; they are the members assessed.
        let named;
        let members = match probe.get("expectedMembers") {
            Exact::Undefined => members,
            recorded => {
                named = qrows(recorded);
                named.as_slice()
            }
        };
        let mut actual = vec![("label".to_owned(), string(label)), ("expectedMembers".to_owned(), probe.get("expectedMembers").clone())];
        if let Exact::Object(entries) = assess_probe(summary, quality, members) {
            actual.extend(entries);
        }
        same(&format!("{name}: {label}"), probe, &Exact::Object(actual));
    }
}
