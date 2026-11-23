use crate::compact_support;

use compact_support::MapVars;
use compact_support::NoVars;
use compact_support::Rows;
use compact_support::replay_owner;
use mixdog_agent::boundary::ContextReading;
use mixdog_agent::compact::estimate::MediaMeter;
use mixdog_agent::compact::estimate::MessageMeter;
use mixdog_agent::compact::estimate::PartMeter;
use mixdog_agent::compact::pressure::Books;
use mixdog_agent::compact::pressure::COMPACT_NO_WINDOW;
use mixdog_agent::compact::pressure::Header;
use mixdog_agent::compact::pressure::HeaderPatch;
use mixdog_agent::compact::pressure::ImageDescriptor;
use mixdog_agent::compact::pressure::ImageIdentities;
use mixdog_agent::compact::pressure::Inspections;
use mixdog_agent::compact::pressure::Route;
use mixdog_agent::compact::pressure::Settled;
use mixdog_agent::compact::pressure::StatusInput;
use mixdog_agent::compact::pressure::TerminalUsage;
use mixdog_agent::compact::pressure::TranscriptSigner;
use mixdog_agent::compact::pressure::check_change;
use mixdog_agent::compact::pressure::compaction_plan;
use mixdog_agent::compact::pressure::context_status;
use mixdog_agent::compact::pressure::forced_target_budget;
use mixdog_agent::compact::pressure::iteration_metrics;
use mixdog_agent::compact::pressure::pass_change;
use mixdog_agent::compact::pressure::terminal_usage;
use mixdog_agent::compact::pressure::turn_started;
use mixdog_agent::compact::pressure::{settled_change, usage_change, with_prompt_cache_evidence};
use mixdog_agent::compact::tool_schema::RequestTools;
use mixdog_agent::env::CompactPass;
use mixdog_agent::env::CompactTrigger;
use mixdog_agent::env::PassStage;
use mixdog_agent::message::AgentMessage;
use mixdog_agent::message::ToolKind;
use mixdog_ai::registry::keys::Environment;
use mixdog_core_api::domain::provider::ContentPart;
use mixdog_core_api::domain::provider::ToolCall;
use mixdog_core_api::domain::provider::ToolDefinition;
use mixdog_core_api::domain::provider::Usage;
use serde_json::Value;
use serde_json::json;

struct TextOnly;
impl MediaMeter for TextOnly {
    fn part(&self, part: &ContentPart) -> PartMeter {
        panic!("media part in a text-only transcript: {part:?}")
    }
}

struct NoImages;
impl ImageIdentities for NoImages {
    fn images(&self, _: &AgentMessage) -> Vec<ImageDescriptor> {
        Vec::new()
    }
}

static NULL: Value = Value::Null;

macro_rules! books {
    ($meter:ident, $signer:ident) => {
        let owner = replay_owner();
        let $meter = MessageMeter { media: &TextOnly, replay_owner: &owner };
        let $signer = TranscriptSigner { meter: &$meter, images: &NoImages, rows: &Rows };
    };
}

fn header(value: Value) -> Header {
    value.as_object().expect("an object").clone()
}

fn status<'a>(
    session: &'a Header,
    messages: &'a [AgentMessage],
    active: bool,
    tools: &'a [ToolDefinition],
    meter: &'a MessageMeter<'a>,
    signer: &'a TranscriptSigner<'a>,
) -> StatusInput<'a> {
    status_in(&NoVars, session, messages, active, tools, meter, signer)
}

fn status_in<'a>(
    env: &'a dyn Environment,
    session: &'a Header,
    messages: &'a [AgentMessage],
    active: bool,
    tools: &'a [ToolDefinition],
    meter: &'a MessageMeter<'a>,
    signer: &'a TranscriptSigner<'a>,
) -> StatusInput<'a> {
    StatusInput {
        session,
        route: Route { provider: "openai", model: "m", context_window: Value::Null },
        cwd: Value::Null,
        mode: Value::Null,
        messages,
        active,
        request_tools: RequestTools { native: &[], defined: tools },
        session_tools: RequestTools { native: &[], defined: tools },
        tool_breakdown: &NULL,
        agent_mode: false,
        meter,
        signer,
        env,
    }
}

fn applied(header: &Header, patch: Option<HeaderPatch>) -> Header {
    let mut after = header.clone();
    patch.expect("a change").apply(&mut after);
    after
}

fn small_conversation() -> Vec<AgentMessage> {
    vec![AgentMessage::user("fix the parser"), AgentMessage::assistant("done", Vec::new()), AgentMessage::user("thanks, now the docs")]
}

fn big_conversation() -> Vec<AgentMessage> {
    vec![AgentMessage::user("summarize"), AgentMessage::assistant("word ".repeat(80_000), Vec::new()), AgentMessage::user("again")]
}

fn tool() -> ToolDefinition {
    ToolDefinition {
        name: "read".into(),
        description: "Read a file from the workspace".into(),
        input_schema: json!({ "type": "object", "properties": { "path": { "type": "string" } } }),
        defer_loading: false,
        freeform: None,
    }
}

// ---- the gauge --------------------------------------------------------------------------------------------

#[test]
fn a_thread_with_no_activity_shows_an_empty_gauge_over_its_whole_window() {
    books!(meter, signer);
    let session = header(json!({ "id": "s1", "provider": "openai", "model": "m", "contextWindow": 200_000 }));
    let shown = context_status(&status(&session, &[], false, &[], &meter, &signer));
    assert_eq!(shown["usedTokens"], 0);
    assert_eq!(shown["usedSource"], "empty");
    assert_eq!(shown["contextWindow"], 200_000);
    assert_eq!(shown["freeTokens"], 200_000);
    assert_eq!(shown["measurement"]["source"], "pending");
    assert_eq!(shown["messages"]["count"], 0);
}

#[test]
fn without_a_provider_reading_the_gauge_estimates_the_transcript_plus_the_tool_schemas_at_the_providers_calibration() {
    books!(meter, signer);
    let messages = small_conversation();
    let tools = [tool()];
    let est = meter.messages(&messages);
    for (provider, calibration) in [("openai", 1.0), ("anthropic", 1.4), ("gemini", 1.15)] {
        let session = header(json!({ "id": "s1", "provider": provider, "model": "m", "contextWindow": 200_000 }));
        let shown = context_status(&status(&session, &messages, true, &tools, &meter, &signer));
        let reserve = shown["request"]["reserveTokens"].as_u64().unwrap();
        assert!(reserve > 0, "the tool schema is priced");
        assert_eq!(shown["request"]["toolSchemaTokens"], reserve);
        assert_eq!(shown["messages"]["estimatedTokens"], est);
        assert_eq!(shown["usedSource"], "estimated", "{provider}");
        let want = ((est + reserve) as f64 * calibration).round() as u64;
        assert_eq!(shown["usedTokens"], want, "{provider}");
        assert_eq!(shown["freeTokens"], 200_000 - want, "{provider}");
    }
}

#[test]
fn a_measured_reading_is_shown_while_it_is_live_and_discarded_once_a_compaction_is_newer() {
    books!(meter, signer);
    let messages = small_conversation();
    let live = header(json!({
        "id": "s1", "provider": "openai", "model": "m", "contextWindow": 200_000,
        "lastContextTokens": 50_000, "lastContextTokensUpdatedAt": 1_000,
        "contextPressureUnanchoredAfterRestart": true
    }));
    let shown = context_status(&status(&live, &messages, true, &[], &meter, &signer));
    assert_eq!((shown["usedTokens"].as_u64(), shown["usedSource"].as_str()), (Some(50_000), Some("provider_resume")));
    assert_eq!(shown["lastApiRequestTokens"], 50_000);
    assert_eq!(shown["lastApiRequestStale"], false);
    assert_eq!(shown["measurement"], json!({ "tokens": 50_000, "source": "last_api_request", "updatedAt": 1_000 }));

    let compacted = header(json!({
        "id": "s1", "provider": "openai", "model": "m", "contextWindow": 200_000,
        "lastContextTokens": 50_000, "lastContextTokensUpdatedAt": 1_000,
        "compaction": { "lastCompactAt": 5_000 }
    }));
    let shown = context_status(&status(&compacted, &messages, true, &[], &meter, &signer));
    assert_eq!(shown["lastApiRequestStale"], true, "the reading predates the compaction");
    assert_eq!(shown["usedSource"], "estimated");
    assert_eq!(shown["usedTokens"], meter.messages(&messages));
    assert_eq!(shown["measurement"]["source"], "pending", "no measured figure until the next send");
}

#[test]
fn an_explicit_boundary_below_the_window_is_what_the_gauge_measures_free_space_against() {
    books!(meter, signer);
    let messages = small_conversation();
    let session = header(json!({ "id": "s1", "provider": "openai", "model": "m", "contextWindow": 200_000, "compactBoundaryTokens": 100_000 }));
    let shown = context_status(&status(&session, &messages, true, &[], &meter, &signer));
    let used = shown["usedTokens"].as_u64().unwrap();
    assert_eq!(shown["contextWindow"], 100_000);
    assert_eq!(shown["effectiveContextWindow"], 200_000);
    assert_eq!(shown["freeTokens"], 100_000 - used);
    assert_eq!(shown["compaction"]["boundaryTokens"], 100_000);
}

// ---- the plan of a compaction -------------------------------------------------------------------------------

fn session_with_buffer() -> Header {
    header(json!({ "id": "s1", "provider": "openai", "model": "m", "contextWindow": 100_000, "compaction": { "mainBufferTokens": 30_000 } }))
}

#[test]
fn an_automatic_pass_under_its_trigger_answers_below_threshold_and_changes_nothing() {
    books!(meter, signer);
    let session = session_with_buffer();
    let messages = small_conversation();
    let input = status(&session, &messages, true, &[], &meter, &signer);
    let plan = compaction_plan(&input, true, false).expect("a window exists").expect("three messages are enough");
    // A buffer is never more than a quarter of the boundary, so 30,000 asked is 25,000 kept free.
    assert_eq!((plan.boundary, plan.trigger_tokens, plan.buffer_tokens), (100_000.0, 75_000.0, 25_000.0));
    assert!((plan.buffer_ratio - 0.25).abs() < 1e-9);
    let mut modest = session_with_buffer();
    modest.get_mut("compaction").unwrap()["mainBufferTokens"] = json!(10_000);
    let modest_plan = compaction_plan(&status(&modest, &messages, true, &[], &meter, &signer), true, false).unwrap().unwrap();
    assert_eq!((modest_plan.trigger_tokens, modest_plan.buffer_tokens), (90_000.0, 10_000.0), "a buffer within the cap is kept as asked");
    assert_eq!(plan.budget, 25_000.0, "a quarter of the boundary is what a compacted conversation may take");
    let answer = plan.below_threshold().expect("pressure is under the trigger");
    assert_eq!(answer["changed"], false);
    assert_eq!(answer["reason"], "below threshold");
    assert_eq!(answer["freshContext"], false);
    assert_eq!((answer["beforeMessages"].as_u64(), answer["afterMessages"].as_u64()), (Some(3), Some(3)));
    assert_eq!(answer["beforeMessageTokens"], meter.messages(&messages));
    assert_eq!(answer["afterMessageTokens"], meter.messages(&messages));
    assert_eq!((answer["triggerTokens"].as_u64(), answer["boundaryTokens"].as_u64()), (Some(75_000), Some(100_000)));
    assert_eq!(forced_target_budget(&input), Some(25_000.0));
}

#[test]
fn a_pass_over_its_trigger_goes_on_and_a_manual_pass_always_does() {
    books!(meter, signer);
    let session = session_with_buffer();
    let big = big_conversation();
    let over = status(&session, &big, true, &[], &meter, &signer);
    let plan = compaction_plan(&over, true, false).unwrap().unwrap();
    assert!(plan.pressure_tokens >= plan.trigger_tokens, "{} vs {}", plan.pressure_tokens, plan.trigger_tokens);
    assert!(plan.below_threshold().is_none());

    let small = small_conversation();
    let manual = compaction_plan(&status(&session, &small, true, &[], &meter, &signer), false, true).unwrap().unwrap();
    assert!(manual.force && manual.below_threshold().is_none(), "a manual pass compacts whatever the pressure");
    let skipped = manual.no_token_reduction();
    assert_eq!((skipped["changed"].as_bool(), skipped["skipped"].as_bool(), skipped["reason"].as_str()), (Some(false), Some(true), Some("no_token_reduction")));
}

#[test]
fn a_measured_reading_is_the_before_figure_of_the_plan_while_it_is_live() {
    books!(meter, signer);
    let messages = small_conversation();
    let mut session = session_with_buffer();
    session.insert("lastContextTokens".into(), json!(42_000));
    let plan = compaction_plan(&status(&session, &messages, true, &[], &meter, &signer), true, false).unwrap().unwrap();
    assert_eq!(plan.before_tokens, 42_000.0);
    session.insert("lastContextTokensStaleAfterCompact".into(), json!(true));
    let plan = compaction_plan(&status(&session, &messages, true, &[], &meter, &signer), true, false).unwrap().unwrap();
    assert_ne!(plan.before_tokens, 42_000.0, "a stale reading is not shown as the context before");
    assert!(plan.before_tokens > 0.0);
}

#[test]
fn when_there_is_nothing_to_plan_an_automatic_pass_is_skipped_and_a_manual_one_says_why() {
    books!(meter, signer);
    let messages = small_conversation();
    let no_window = header(json!({ "id": "s1", "provider": "openai", "model": "m" }));
    let input = status(&no_window, &messages, true, &[], &meter, &signer);
    assert!(compaction_plan(&input, true, false).unwrap().is_none());
    assert_eq!(compaction_plan(&input, false, true).err(), Some(COMPACT_NO_WINDOW));
    assert_eq!(forced_target_budget(&input), None);

    let session = session_with_buffer();
    let short = [AgentMessage::user("hi"), AgentMessage::assistant("hello", Vec::new())];
    assert!(
        compaction_plan(&status(&session, &short, true, &[], &meter, &signer), true, false).unwrap().is_none(),
        "two messages are never worth an automatic pass"
    );
    assert!(compaction_plan(&status(&session, &short, true, &[], &meter, &signer), false, true).unwrap().is_some(), "but a manual one runs");

    let off = header(json!({ "id": "s1", "provider": "openai", "model": "m", "contextWindow": 100_000, "compaction": { "auto": false } }));
    assert!(compaction_plan(&status(&off, &messages, true, &[], &meter, &signer), true, false).unwrap().is_none(), "automatic compaction switched off");
    assert!(compaction_plan(&status(&off, &messages, true, &[], &meter, &signer), false, true).unwrap().is_some());
}

// ---- the pass and the usage figures -------------------------------------------------------------------------

fn delta(input: u64, cached: u64, written: u64, output: u64, index: u64) -> Value {
    json!({ "deltaInput": input, "deltaOutput": output, "deltaCachedRead": cached, "deltaCacheWrite": written, "iterationIndex": index })
}

#[test]
fn a_calls_usage_adds_to_the_totals_and_sets_the_context_the_same_whether_or_not_the_input_counts_the_cache() {
    let base = header(json!({ "id": "s1" }));
    // The same prompt: 2 fresh + 405,809 cache reads + 1,943 cache writes.
    let excluding = applied(&base, Some(iteration_metrics(&base, &delta(2, 405_809, 1_943, 1_245, 0), true, 1_000.0)));
    let including = applied(&base, Some(iteration_metrics(&base, &delta(407_754, 405_809, 1_943, 1_245, 0), false, 1_000.0)));
    for after in [&excluding, &including] {
        assert_eq!(after["lastContextTokens"], 407_754, "the footprint is the whole prompt");
        assert_eq!(after["lastContextTokensStaleAfterCompact"], false);
        assert_eq!(after["lastContextTokensUpdatedAt"], 1_000);
        assert_eq!(after["totalOutputTokens"], 1_245);
        assert_eq!(after["totalCachedReadTokens"], 405_809);
        assert_eq!(after["totalCacheWriteTokens"], 1_943);
    }
    assert_eq!(
        (excluding["lastUncachedInputTokens"].as_u64(), including["lastUncachedInputTokens"].as_u64()),
        (Some(1_945), Some(2)),
        "uncached input is what neither cache served"
    );
    // A second call adds to the totals and replaces the last reading.
    let second = applied(&excluding, Some(iteration_metrics(&excluding, &delta(5, 400_000, 0, 100, 1), true, 2_000.0)));
    assert_eq!(second["totalOutputTokens"], 1_345);
    assert_eq!(second["totalCachedReadTokens"], 805_809);
    assert_eq!(second["lastContextTokens"], 400_005);
    assert_eq!(second["lastContextTokensUpdatedAt"], 2_000);
}

#[test]
fn a_call_without_a_prompt_count_clears_the_reading_until_the_next_measured_call() {
    let base = header(json!({ "id": "s1", "lastContextTokens": 9_000 }));
    let after = applied(&base, Some(iteration_metrics(&base, &delta(0, 0, 0, 12, 0), false, 3_000.0)));
    assert_eq!(after["lastContextTokens"], Value::Null);
    assert_eq!(after["lastContextTokensStaleAfterCompact"], true);
    assert_eq!(after["totalOutputTokens"], 12, "the output is still counted");
}

#[test]
fn provider_usage_reaches_pressure_status_as_prompt_and_output_evidence() {
    books!(meter, signer);
    for (provider, excludes_cache, reported, prompt, occupancy, output) in [
        (
            "anthropic",
            true,
            Usage {
                input_tokens: 60,
                cache_read_tokens: 30,
                cache_write_tokens: 10,
                raw: Some(json!({ "input_tokens": 60, "cache_read_input_tokens": 30, "cache_creation_input_tokens": 10, "output_tokens": 0 })),
                ..Usage::default()
            },
            json!(100),
            json!(100),
            json!(0),
        ),
        (
            "anthropic",
            true,
            Usage {
                raw: Some(json!({ "input_tokens": 0, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0, "output_tokens": 0 })),
                ..Usage::default()
            },
            json!(0),
            json!(0),
            json!(0),
        ),
        (
            "cursor-api",
            false,
            Usage {
                raw: Some(json!({
                    "input_tokens_known": false, "cache_tokens_known": false,
                    "context_tokens": 0, "completion_tokens": 0,
                })),
                ..Usage::default()
            },
            Value::Null,
            json!(0),
            json!(0),
        ),
        (
            "cursor-api",
            false,
            Usage {
                raw: Some(json!({
                    "input_tokens_known": false, "cache_tokens_known": false,
                    "context_tokens": null, "completion_tokens": 0,
                })),
                ..Usage::default()
            },
            Value::Null,
            Value::Null,
            json!(0),
        ),
        // A turn's counts, summed over its five model calls: the context is the occupancy the service measured.
        (
            "cursor-api",
            false,
            Usage {
                input_tokens: 37_108,
                cache_read_tokens: 19_933,
                raw: Some(json!({
                    "input_tokens_known": true, "cache_tokens_known": true, "input_tokens_scope": "turn",
                    "context_tokens": 9_000, "completion_tokens": 0,
                })),
                ..Usage::default()
            },
            Value::Null,
            json!(9_000),
            json!(0),
        ),
        ("cursor-api", false, Usage::default(), Value::Null, Value::Null, Value::Null),
    ] {
        let base = header(json!({ "id": "s1", "provider": provider, "contextWindow": 200_000 }));
        let mut live = delta(reported.input_tokens, reported.cache_read_tokens, reported.cache_write_tokens, reported.output_tokens, 1);
        live["contextOutputTokens"] = json!(reported.output_tokens);
        live["contextMeasuredTokens"] = json!(mixdog_agent::compact::pressure::measured_context_tokens(&reported));
        let evidence = with_prompt_cache_evidence(&base, &live, &reported);
        let after_call = applied(&base, usage_change(&base, &evidence, &[], &[], None, excludes_cache, 100.0, 200.0));
        let settled = Settled { transcript: &[], usage: &reported, last_turn_usage: &reported, tool_calls_total: 0, send_tools: &[] };
        let after_turn = applied(&after_call, settled_change(&after_call, &settled, true, None, excludes_cache, 300.0));
        for header in [&after_call, &after_turn] {
            let result = context_status(&status(header, &[], true, &[], &meter, &signer));
            assert_eq!(result["usage"]["lastPromptTokens"], prompt, "{provider}");
            assert_eq!(result["usage"]["lastContextTokens"], occupancy, "{provider}");
            assert_eq!(result["usage"]["lastOutputTokens"], output, "{provider}");
            assert_eq!(result["measurement"]["tokens"], occupancy, "{provider}");
        }
    }
}

/// A provider whose usage is of a whole turn, summed over its model calls (the turn-ended counts of an open run),
/// never anchors the pressure baseline or the meter by that sum, in any shape a turn takes: a turn of several
/// batches, a turn that ends on a tool call with the run going on, and a run cut before its turn ended. Both read the
/// occupancy the provider measured; the totals keep the sum.
#[test]
fn a_turns_summed_usage_never_anchors_the_pressure_baseline_or_the_meter() {
    books!(meter, signer);
    let books = Books { signer: &signer, native: &[], agent_mode: false, env: &NoVars };
    // A batch that handed over a tool call: output only, the checkpoint's occupancy beside it.
    let batch = |occupancy: u64| Usage {
        output_tokens: 134,
        raw: Some(json!({ "input_tokens_known": false, "cache_tokens_known": false, "context_tokens": occupancy, "completion_tokens": 134 })),
        ..Usage::default()
    };
    // The batch that ended the turn: the whole turn's counts, over its five model calls.
    let ended = Usage {
        input_tokens: 37_108,
        cache_read_tokens: 19_933,
        output_tokens: 377,
        raw: Some(json!({
            "input_tokens_known": true, "cache_tokens_known": true, "input_tokens_scope": "turn",
            "context_tokens": 9_000, "completion_tokens": 377,
        })),
        ..Usage::default()
    };
    // One model call's report as the run host records it, the record's own counts as its context fields.
    let call = |header: &Header, reported: &Usage, index: u64| {
        let mut live = delta(reported.input_tokens, reported.cache_read_tokens, reported.cache_write_tokens, reported.output_tokens, index);
        live["source"] = json!("provider_send");
        live["contextInputTokens"] = json!(reported.input_tokens);
        live["contextPromptTokens"] = json!(reported.input_tokens);
        live["contextOutputTokens"] = json!(reported.output_tokens);
        live["contextMeasuredTokens"] = json!(mixdog_agent::compact::pressure::measured_context_tokens(reported));
        let evidence = with_prompt_cache_evidence(header, &live, reported);
        applied(header, usage_change(header, &evidence, &[], &[], Some(&books), false, 100.0, 200.0))
    };
    let settle = |header: &Header, usage: &Usage, last: &Usage| {
        let settled = Settled { transcript: &[], usage, last_turn_usage: last, tool_calls_total: 0, send_tools: &[] };
        applied(header, settled_change(header, &settled, true, Some(&books), false, 300.0))
    };
    let base = header(json!({ "id": "s1", "provider": "cursor-oauth", "contextWindow": 200_000 }));
    let reads = |header: &Header| (header.get("contextPressureBaselineTokens").cloned().unwrap_or_default(), header.get("lastContextTokens").cloned().unwrap_or_default());

    // A turn of several batches: every call, and the settlement, read the occupancy.
    let first = call(&base, &batch(8_000), 1);
    assert_eq!(reads(&first), (json!(8_000), json!(8_000)));
    let last = call(&first, &ended, 2);
    assert_eq!(reads(&last), (json!(9_000), json!(9_000)), "the turn's end");
    let after = settle(&last, &ended, &ended);
    assert_eq!(reads(&after), (json!(9_000), json!(9_000)), "the settled ask");
    assert_eq!(after["totalInputTokens"], json!(37_108), "the totals keep the turn's sum");

    // A turn that ends on a tool call, the run going on: the batch's occupancy.
    let waiting = settle(&call(&base, &batch(8_000), 1), &batch(8_000), &batch(8_000));
    assert_eq!(reads(&waiting), (json!(8_000), json!(8_000)));

    // A run cut before its turn ended reports nothing: the reading of the batch before it stands.
    let cut = call(&first, &Usage::default(), 2);
    assert_eq!(cut["contextPressureBaselineTokens"], json!(8_000));

    // A batch with no prompt count and no checkpoint is the size of nothing: its reply alone anchors no baseline.
    let unmeasured = Usage { raw: Some(json!({ "input_tokens_known": false, "cache_tokens_known": false, "context_tokens": null, "completion_tokens": 134 })), ..batch(0) };
    assert_eq!(call(&base, &unmeasured, 1).get("contextPressureBaselineTokens"), None);
    assert_eq!(settle(&base, &unmeasured, &unmeasured).get("contextPressureBaselineTokens"), None);
}

/// A call of several hops bills the sum of its hops. The run's own reading of it and the session's baseline take the
/// same size, the first hop's prompt (with the reply, for the baseline), as the session's context fields state it.
#[test]
fn a_multi_hop_call_reads_the_same_in_the_run_as_in_the_session() {
    books!(meter, signer);
    let books = Books { signer: &signer, native: &[], agent_mode: false, env: &NoVars };
    let hops = Usage {
        input_tokens: 1_000,
        cache_read_tokens: 900,
        output_tokens: 50,
        raw: Some(json!({ "promptTokenCount": 1_000, "initialPromptTokenCount": 300, "initialCachedContentTokenCount": 400 })),
        ..Usage::default()
    };
    let (first_hop, cached) = mixdog_agent::compact::pressure::first_hop(&hops).expect("several hops");
    assert_eq!((first_hop, cached), (300, 300));

    // The session's side: the delta as the run host records it, its context fields the first hop's.
    let base = header(json!({ "id": "s1", "provider": "gemini", "contextWindow": 200_000 }));
    let mut live = delta(hops.input_tokens, hops.cache_read_tokens, 0, hops.output_tokens, 1);
    live["source"] = json!("provider_send");
    live["deltaPrompt"] = json!(1_000);
    live["contextInputTokens"] = json!(first_hop);
    live["contextPromptTokens"] = json!(first_hop);
    live["contextCachedReadTokens"] = json!(cached);
    live["contextOutputTokens"] = json!(hops.output_tokens);
    let evidence = with_prompt_cache_evidence(&base, &live, &hops);
    let session = applied(&base, usage_change(&base, &evidence, &[], &[], Some(&books), false, 100.0, 200.0));
    assert_eq!(session["contextPressureBaselineTokens"], json!(350));
    assert_eq!(session["lastContextTokens"], json!(300));

    // The run's side, from the same record.
    let mut reading = ContextReading::default();
    reading.measure(&hops, false);
    assert_eq!(reading.tokens.map(|tokens| json!(tokens)), Some(session["lastContextTokens"].clone()));
    assert_eq!(mixdog_agent::compact::pressure::context_size(&hops, false), mixdog_agent::compact::pressure::ContextSize::Prompt(300));
    assert_eq!(json!(first_hop + hops.output_tokens), session["contextPressureBaselineTokens"], "the run's baseline is the first hop's prompt and the reply");
}

#[test]
fn the_metrics_epoch_moves_when_the_iteration_counter_goes_back() {
    let base = header(json!({ "id": "s1", "lastIterationIndex": 3, "usageMetricsEpoch": 0 }));
    let after = applied(&base, Some(iteration_metrics(&base, &delta(10, 0, 0, 1, 1), false, 1.0)));
    assert_eq!(after["usageMetricsEpoch"], 1, "the loop restarted its count");
    let forward = applied(&base, Some(iteration_metrics(&base, &delta(10, 0, 0, 1, 4), false, 1.0)));
    assert_eq!(forward["usageMetricsEpoch"], 0);
}

#[test]
fn a_finished_ask_adds_its_usage_once_a_call_by_call_ask_has_already_counted_itself() {
    let base = header(json!({ "id": "s1", "totalInputTokens": 100, "totalOutputTokens": 10 }));
    let usage = json!({ "inputTokens": 30, "outputTokens": 5, "cachedTokens": 0, "cacheWriteTokens": 0 });
    let ask =
        |incremental| TerminalUsage { usage: Some(&usage), last_turn: &usage, tool_calls_total: 2.0, incremental, input_excludes_cache: false, now: 500.0 };
    let whole = applied(&base, Some(terminal_usage(&base, &ask(false))));
    assert_eq!((whole["totalInputTokens"].as_u64(), whole["totalOutputTokens"].as_u64(), whole["totalToolCalls"].as_u64()), (Some(130), Some(15), Some(2)));
    assert_eq!(whole["lastContextTokens"], 30);
    let counted = applied(&base, Some(terminal_usage(&base, &ask(true))));
    assert_eq!(counted["totalInputTokens"], 100, "the calls already added their own");
    assert_eq!(counted["lastContextTokens"], 30, "the last reading is still taken");
}

#[test]
fn every_turn_gets_the_next_turn_id() {
    let first = header(json!({ "id": "s1" }));
    let one = applied(&first, turn_started(&first));
    assert_eq!(one["usageMetricsTurnId"], 1);
    let two = applied(&one, turn_started(&one));
    assert_eq!(two["usageMetricsTurnId"], 2);
}

fn pass(request: &[AgentMessage], stage: PassStage) -> CompactPass {
    CompactPass { request: request.to_vec(), tools: Vec::new(), reactive: false, trigger: CompactTrigger::Auto, stage }
}

#[test]
fn a_pass_records_its_stages_and_an_adopted_one_restarts_the_metrics_and_voids_the_old_reading() {
    books!(meter, signer);
    let books = Books { signer: &signer, native: &[], agent_mode: false, env: &compact_support::NoVars };
    let before = small_conversation();
    let mut session = header(json!({
        "id": "s1", "provider": "openai", "model": "m", "contextWindow": 100_000,
        "lastContextTokens": 60_000, "lastContextTokensUpdatedAt": 100
    }));
    let go = |session: &mut Header, stage: PassStage, now: f64| {
        let patch = pass_change(session, &pass(&before, stage), &books, now);
        patch.expect("the policy compacts").apply(session);
    };
    go(&mut session, PassStage::Started, 1_000.0);
    assert_eq!((session["compaction"]["lastStage"].as_str(), session["compaction"]["lastTrigger"].as_str()), (Some("compacting"), Some("auto")));

    go(&mut session, PassStage::Failed { message: "summary route unavailable".into(), duration_ms: 40 }, 2_000.0);
    assert_eq!(session["compaction"]["lastStage"], "overflow_failed");
    assert_eq!(session["compaction"]["lastError"], "summary route unavailable");
    assert_eq!(session["compaction"]["compactCount"], 0);

    go(&mut session, PassStage::Skipped, 2_500.0);
    assert_eq!(session["compaction"]["lastError"], Value::Null, "a later pass that has nothing to do clears the error");

    let after = vec![AgentMessage::user("summary"), AgentMessage::user("thanks, now the docs")];
    go(&mut session, PassStage::Done { changed: true, handoff_source: "session-local", after_tokens: 1_234, duration_ms: 77, after: after.clone() }, 3_000.0);
    let record = &session["compaction"];
    assert_eq!((record["lastStage"].as_str(), record["lastChanged"].as_bool(), record["compactCount"].as_u64()), (Some("pre_send"), Some(true), Some(1)));
    assert_eq!((record["lastChangedAt"].as_u64(), record["lastDurationMs"].as_u64(), record["lastAfterTokens"].as_u64()), (Some(3_000), Some(77), Some(1_234)));
    assert_eq!(record["lastHandoffSource"], "session-local");
    assert_eq!(session["usageMetricsEpoch"], 1, "the loop's iteration counter restarts with the new transcript");
    assert_eq!(session["lastContextTokensStaleAfterCompact"], true, "the old transcript's reading no longer describes the context");
    assert_eq!(session["contextUsageSnapshot"]["usedTokens"], 1_234);
    assert!(
        session.get("promptFoldPending").is_none() && session.get("compactionFoldPending").is_none(),
        "the run folds the prompt with its compaction: no fold is left owed to a later turn start"
    );

    // Until the next send, the gauge shows what the pass measured.
    let shown = context_status(&status(&session, &after, true, &[], &meter, &signer));
    assert_eq!((shown["usedTokens"].as_u64(), shown["usedSource"].as_str()), (Some(1_234), Some("post_compact")));
}

// ---- the number the marker shows --------------------------------------------------------------------------

#[test]
fn the_marker_shows_the_live_reading_as_the_context_before_and_the_passes_own_pressure_when_there_is_none() {
    let live = ContextReading { tokens: Some(120_000), stale_after_compact: false };
    assert_eq!(live.display_before(90_000), 120_000, "the provider's figure wins even above the estimate");
    assert_eq!(live.display_before(150_000), 120_000, "and below it");
    let stale = ContextReading { tokens: Some(120_000), stale_after_compact: true };
    assert_eq!(stale.display_before(90_000), 90_000);
    let none = ContextReading { tokens: None, stale_after_compact: false };
    assert_eq!(none.display_before(90_000), 90_000);
    let zero = ContextReading { tokens: Some(0), stale_after_compact: false };
    assert_eq!(zero.display_before(90_000), 90_000, "a zero reading is no reading");
}

// ---- the policy's environment ---------------------------------------------------------------------------

fn budget_with(vars: &MapVars, provider: &str) -> Option<f64> {
    books!(meter, signer);
    let session = header(json!({ "id": "s1", "provider": provider, "model": "m", "contextWindow": 100_000, "compaction": { "mainBufferTokens": 30_000 } }));
    let messages = small_conversation();
    forced_target_budget(&status_in(vars, &session, &messages, true, &[], &meter, &signer))
}

#[test]
fn the_budget_a_summary_is_asked_to_fit_is_the_target_in_the_providers_calibrated_tokens() {
    // Target 25,000 (a quarter of the boundary) divided by the calibration, rounded down.
    let none = MapVars(Vec::new());
    for (provider, want) in [
        ("openai", 25_000.0),
        ("anthropic", 17_857.0),
        ("anthropic-oauth", 17_857.0),
        ("gemini", 21_739.0),
        ("google-vertex", 21_739.0),
        ("Anthropic", 17_857.0),
    ] {
        assert_eq!(budget_with(&none, provider), Some(want), "{provider}");
    }
}

#[test]
fn each_calibration_variable_changes_only_its_providers_budget_and_is_clamped_to_a_quarter_up_to_three() {
    let anthropic = |value| MapVars(vec![("MIXDOG_TOKEN_CALIBRATION_ANTHROPIC", value)]);
    assert_eq!(budget_with(&anthropic("2"), "anthropic"), Some(12_500.0));
    assert_eq!(budget_with(&anthropic("2"), "openai"), Some(25_000.0), "another provider keeps its own");
    assert_eq!(budget_with(&anthropic("10"), "anthropic"), Some(8_333.0), "capped at 3");
    assert_eq!(budget_with(&anthropic("0.1"), "anthropic"), Some(100_000.0), "floored at 0.25, which leaves the boundary as the budget");
    for unusable in ["0", "-1", "abc", ""] {
        assert_eq!(budget_with(&anthropic(unusable), "anthropic"), Some(17_857.0), "{unusable:?} falls back to the default");
    }
    let gemini = MapVars(vec![("MIXDOG_TOKEN_CALIBRATION_GEMINI", "1.5")]);
    assert_eq!(budget_with(&gemini, "gemini"), Some(16_666.0));
    assert_eq!(budget_with(&gemini, "google"), Some(16_666.0), "google reads the gemini variable");
    assert_eq!(budget_with(&gemini, "anthropic"), Some(17_857.0));
    let default = MapVars(vec![("MIXDOG_TOKEN_CALIBRATION_DEFAULT", "1.25")]);
    assert_eq!(budget_with(&default, "openai"), Some(20_000.0));
    assert_eq!(budget_with(&default, "anthropic"), Some(17_857.0), "the default variable is for the other providers");
}

#[test]
fn the_calibration_variable_scales_what_the_gauge_estimates_too() {
    books!(meter, signer);
    let messages = small_conversation();
    let session = header(json!({ "id": "s1", "provider": "anthropic", "model": "m", "contextWindow": 200_000 }));
    let est = meter.messages(&messages);
    let two = MapVars(vec![("MIXDOG_TOKEN_CALIBRATION_ANTHROPIC", "2")]);
    let shown = context_status(&status_in(&two, &session, &messages, true, &[], &meter, &signer));
    assert_eq!(shown["usedTokens"], est * 2);
}

fn checks_under(auto_header: Option<bool>, agent_mode: bool, vars: &MapVars) -> bool {
    books!(meter, signer);
    let books = Books { signer: &signer, native: &[], agent_mode, env: vars };
    let mut session = header(json!({ "id": "s1", "provider": "openai", "model": "m", "contextWindow": 100_000 }));
    if let Some(auto) = auto_header {
        session.insert("compaction".into(), json!({ "auto": auto }));
    }
    check_change(&session, &small_conversation(), &[], false, &books, 1.0).is_some()
}

#[test]
fn automatic_compaction_runs_only_when_neither_the_header_nor_the_switch_variable_turns_it_off() {
    let switch = |value| MapVars(vec![("MIXDOG_AGENT_COMPACT_AUTO", value)]);
    // The header's own setting, with the variable absent.
    assert!(checks_under(None, false, &MapVars(Vec::new())));
    assert!(checks_under(Some(true), false, &MapVars(Vec::new())));
    assert!(!checks_under(Some(false), false, &MapVars(Vec::new())));
    // Off by the variable, whatever spelling and case.
    for off in ["0", "false", "off", "no", "OFF", " False "] {
        assert!(!checks_under(None, false, &switch(off)), "{off:?}");
        assert!(!checks_under(Some(true), false, &switch(off)), "{off:?}");
    }
    // On, or not a switch value at all: the default is on, and the header still decides.
    for on in ["1", "true", "yes", "on", "ON", "junk", ""] {
        assert!(checks_under(None, false, &switch(on)), "{on:?}");
        assert!(!checks_under(Some(false), false, &switch(on)), "{on:?}: the header's off is kept");
    }
}

#[test]
fn an_agent_mode_thread_ignores_the_headers_off_but_not_the_switch_variable() {
    let switch = |value| MapVars(vec![("MIXDOG_AGENT_COMPACT_AUTO", value)]);
    assert!(checks_under(Some(false), true, &MapVars(Vec::new())));
    assert!(checks_under(Some(false), true, &switch("1")));
    assert!(!checks_under(Some(false), true, &switch("0")));
    assert!(!checks_under(None, true, &switch("off")));
}

fn inspected_entries(messages: &[AgentMessage], tools: &[ToolDefinition]) -> Vec<(String, String, String, String)> {
    books!(meter, signer);
    let session = header(json!({ "id": "s1", "provider": "openai", "model": "m" }));
    let input = status(&session, messages, true, tools, &meter, &signer);
    let annotations = |_: &str| mixdog_agent::compact::tool_schema::ToolAnnotations::default();
    let shown = Inspections::new().attach(context_status(&input), &input, &annotations, Some(&json!({ "inspect": true })));
    shown["inspection"]["entries"]
        .as_array()
        .expect("entries")
        .iter()
        .map(|e| {
            let text = |key: &str| e[key].as_str().unwrap_or_default().to_owned();
            (text("id"), text("category"), text("group"), text("label"))
        })
        .collect()
}

fn row(id: &str, category: &str, group: &str, label: &str) -> (String, String, String, String) {
    (id.into(), category.into(), group.into(), label.into())
}

#[test]
fn the_inspector_lists_each_message_numbered_per_role_and_each_tool_result_under_its_tool() {
    let messages = vec![
        AgentMessage::user("fix the parser"),
        AgentMessage::assistant("reading", vec![ToolCall { id: "c1".into(), name: "read".into(), arguments: json!({}), native_type: None }]),
        AgentMessage::tool_text("c1", "file body", ToolKind::Normal),
        AgentMessage::user("thanks"),
    ];
    let entries = inspected_entries(&messages, &[tool()]);
    assert_eq!(
        entries,
        vec![
            row("message:0", "user", "user", "user · 1"),
            row("message:1", "assistant", "assistant", "assistant · 1"),
            row("message:2", "toolResults", "read", "read · 1"),
            row("message:3", "user", "user", "user · 2"),
            row("tool:0", "tools", "active", "read"),
        ]
    );
}

#[test]
fn the_inspector_prices_a_reminder_around_a_message_apart_from_the_message() {
    let messages = vec![AgentMessage::user("<system-reminder>\nCore memory\nprefers tabs\n</system-reminder>\n\nfix the parser")];
    let entries = inspected_entries(&messages, &[]);
    assert_eq!(entries, vec![row("message:0:section:0:injected", "system", "reminder", "System reminder"), row("message:0", "user", "user", "user · 1")]);
}
