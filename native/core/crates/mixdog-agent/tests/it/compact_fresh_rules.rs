//! The rebuilt conversation after a compaction (what is kept, summarised and dropped, and where the cut
//! falls), the handoff summary run, the pressure state across a compaction, the commit record and images,
//! each stated on a small transcript written in the test.

use crate::compact_support;

use std::collections::HashSet;
use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use compact_support::NoAttachments;
use compact_support::NoBlobs;
use compact_support::NoRedaction;
use compact_support::PreviewArchive;
use compact_support::Rows;
use compact_support::replay_owner;
use mixdog_agent::boundary::ContextReading;
use mixdog_agent::compact::compactor::CompactorConfig;
use mixdog_agent::compact::compactor::FreshCompactor;
use mixdog_agent::compact::compactor::FreshParts;
use mixdog_agent::compact::compactor::Handoff;
use mixdog_agent::compact::compactor::HandoffSource;
use mixdog_agent::compact::estimate::MediaMeter;
use mixdog_agent::compact::estimate::MessageMeter;
use mixdog_agent::compact::estimate::PartMeter;
use mixdog_agent::compact::execution_tail::TailContext;
use mixdog_agent::compact::fresh::AttachmentSeam;
use mixdog_agent::compact::fresh::FreshContext;
use mixdog_agent::compact::fresh::FreshError;
use mixdog_agent::compact::fresh::FreshOptions;
use mixdog_agent::compact::fresh::LATEST_TURN_EXCEEDS_CONTEXT;
use mixdog_agent::compact::fresh::SUMMARY_PREFIX;
use mixdog_agent::compact::fresh::fresh_context_compact_messages;
use mixdog_agent::compact::image::CodecError;
use mixdog_agent::compact::image::Encoded;
use mixdog_agent::compact::image::ImageCodec;
use mixdog_agent::compact::image::ImageSize;
use mixdog_agent::compact::image::ToolImageCompactor;
use mixdog_agent::compact::image::superseding_metadata_text;
use mixdog_agent::compact::image::target_dimensions;
use mixdog_agent::compact::pressure::Archived;
use mixdog_agent::compact::pressure::Books;
use mixdog_agent::compact::pressure::CommitInput;
use mixdog_agent::compact::pressure::Header;
use mixdog_agent::compact::pressure::ImageDescriptor;
use mixdog_agent::compact::pressure::ImageIdentities;
use mixdog_agent::compact::pressure::Route;
use mixdog_agent::compact::pressure::StatusInput;
use mixdog_agent::compact::pressure::SummaryFacts;
use mixdog_agent::compact::pressure::TranscriptSigner;
use mixdog_agent::compact::pressure::commit_compaction;
use mixdog_agent::compact::pressure::compaction_plan;
use mixdog_agent::compact::pressure::failed_compaction;
use mixdog_agent::compact::pressure::restore_turn_checkpoint_context_state;
use mixdog_agent::compact::pressure::send_pressure;
use mixdog_agent::compact::pressure::usage_change;
use mixdog_agent::compact::pressure::usage_totals;
use mixdog_agent::compact::summary::COMPACTION_SYSTEM_PROMPT;
use mixdog_agent::compact::summary::build_compaction_prompt;
use mixdog_agent::compact::summary_run::HandoffInput;
use mixdog_agent::compact::summary_run::SummaryCall;
use mixdog_agent::compact::summary_run::SummaryFailure;
use mixdog_agent::compact::summary_run::SummaryResponse;
use mixdog_agent::compact::summary_run::SummarySender;
use mixdog_agent::compact::summary_run::generate_fresh_handoff_summary;
use mixdog_agent::compact::summary_schema::summary_is_schema_valid;
use mixdog_agent::compact::tool_schema::RequestTools;
use mixdog_agent::env::CompactError;
use mixdog_agent::env::CompactRequest;
use mixdog_agent::env::CompactTrigger;
use mixdog_agent::env::Compactor;
use mixdog_agent::message::AgentMessage;
use mixdog_agent::message::Source;
use mixdog_agent::message::ToolKind;
use mixdog_agent::offload::ImageCompactor;
use mixdog_agent::offload::ImageOutcome;
use mixdog_core_api::domain::provider::Role;
use mixdog_core_api::domain::provider::StopReason;
use mixdog_core_api::domain::provider::ToolCall;
use mixdog_core_api::domain::provider::Usage;
use serde_json::Value;
use serde_json::json;

struct TextOnly;
impl MediaMeter for TextOnly {
    fn part(&self, part: &mixdog_core_api::domain::provider::ContentPart) -> PartMeter {
        panic!("media part in a text-only transcript: {part:?}")
    }
}

macro_rules! fresh {
    ($meter:ident, $ctx:ident, $attachments:expr) => {
        let owner = replay_owner();
        let $meter = MessageMeter { media: &TextOnly, replay_owner: &owner };
        let archive = PreviewArchive { session: "s".into() };
        let $ctx = FreshContext {
            tail: TailContext { meter: &$meter, rows: &Rows, archive: &archive, redactor: &NoRedaction, preview: true },
            attachments: $attachments,
        };
    };
}

fn system(text: &str) -> AgentMessage {
    let mut m = AgentMessage::user(text);
    m.message.role = Role::System;
    m
}

fn call(id: &str, name: &str, arguments: Value) -> ToolCall {
    ToolCall { id: id.into(), name: name.into(), arguments, native_type: None }
}

fn group(id: &str, result: &str) -> [AgentMessage; 2] {
    [
        AgentMessage::assistant(String::new(), vec![call(id, "read", json!({ "path": format!("{id}.txt") }))]),
        AgentMessage::tool_text(id, result, ToolKind::Normal),
    ]
}

fn options(handoff: &str) -> FreshOptions {
    FreshOptions { force: true, context_window: 100_000, handoff_text: handoff.to_owned(), ..FreshOptions::default() }
}

fn call_ids(messages: &[AgentMessage]) -> Vec<String> {
    messages.iter().flat_map(|m| m.tool_calls().iter().map(|c| c.id.clone())).collect()
}

fn result_ids(messages: &[AgentMessage]) -> Vec<String> {
    messages.iter().filter(|m| m.role() == Role::Tool).filter_map(|m| m.tool_call_id().map(str::to_owned)).collect()
}

/// Every call has its result and every result its call, the call first.
fn pairs_whole(messages: &[AgentMessage]) -> bool {
    let (calls, results) = (call_ids(messages), result_ids(messages));
    let called: HashSet<&String> = calls.iter().collect();
    let answered: HashSet<&String> = results.iter().collect();
    let first_call = |id: &str| messages.iter().position(|m| m.tool_calls().iter().any(|c| c.id == id));
    let first_result = |id: &str| messages.iter().position(|m| m.role() == Role::Tool && m.tool_call_id() == Some(id));
    called == answered && calls.iter().all(|id| first_call(id) < first_result(id))
}

fn texts(messages: &[AgentMessage]) -> Vec<String> {
    messages.iter().map(AgentMessage::text).collect()
}

fn valid_summary(tag: &str) -> String {
    format!(
        "## Goal\n- {tag}\n\n## Constraints & Preferences\n- (none)\n\n## Progress\n### Done\n- parsed {tag}\n\n### In Progress\n- (none)\n\n### Blocked\n- (none)\n\n## Key Decisions\n- (none)\n\n## Next Steps\n- (none)\n\n## Critical Context\n- (none)\n\n## Relevant Files\n- (none)"
    )
}

fn conversation() -> Vec<AgentMessage> {
    let mut messages = vec![
        system("system rules"),
        AgentMessage::user("old question"),
        AgentMessage::assistant("old answer", Vec::new()),
        AgentMessage::user("second request"),
    ];
    messages.extend(group("c1", "file text"));
    messages.push(AgentMessage::assistant("final text", Vec::new()));
    messages.push(AgentMessage::user("current request"));
    messages
}

// ---- what is kept, summarised and dropped ------------------------------------------------------------------

#[tokio::test]
async fn a_rebuild_with_a_handoff_keeps_the_rules_then_the_summary_then_the_current_request_with_its_work() {
    fresh!(meter, ctx, &NoAttachments);
    let messages = conversation();
    let result = fresh_context_compact_messages(&ctx, &messages, 50_000, &options(&valid_summary("first handoff"))).await.expect("fits");
    assert!(result.fresh_context);
    let out = &result.messages;
    assert_eq!(texts(out)[0], "system rules", "the protected prefix leads");
    assert_eq!(out[1].source, Some(Source::CompactSummary));
    assert_eq!(out[2].source, Some(Source::ContextAck), "a stable acknowledgement closes the injected context turn");
    assert_eq!(out[2].text(), ".");
    let summary = out[1].text();
    assert!(summary.starts_with(SUMMARY_PREFIX), "{summary}");
    assert!(summary.contains("messages=7 ") && summary.contains("roles=user:3, assistant:3, tool:1"), "it names what it replaced: {summary}");
    assert!(summary.ends_with(&valid_summary("first handoff")));
    // The conversation resumes at the request that was in progress: its work, and its text, verbatim.
    let tail = texts(&out[3..]);
    assert_eq!(tail, ["second request", "", "file text", "final text", "current request"]);
    assert_eq!(call_ids(&out[3..]), ["c1"]);
    assert!(!texts(out).iter().any(|t| t == "old question" || t == "old answer"), "older requests are summarised, not carried");
    assert!(pairs_whole(out));
    assert_eq!(meter.messages(&out[..1]), meter.messages(&messages[..1]), "the rules are carried unchanged");
}

#[tokio::test]
async fn a_rebuild_without_a_handoff_keeps_the_previous_summary_and_only_one_summary_ever_exists() {
    fresh!(_meter, ctx, &NoAttachments);
    let first = fresh_context_compact_messages(&ctx, &conversation(), 50_000, &options(&valid_summary("first handoff"))).await.unwrap().messages;
    let mut later = first.clone();
    later.push(AgentMessage::assistant("more text", Vec::new()));
    later.push(AgentMessage::user("third request"));
    // Rule-only: the earlier summary is carried.
    let carried = fresh_context_compact_messages(&ctx, &later, 50_000, &options("")).await.unwrap().messages;
    let summaries = |messages: &[AgentMessage]| messages.iter().filter(|m| m.source == Some(Source::CompactSummary)).count();
    assert_eq!(summaries(&carried), 1);
    assert!(carried.iter().any(|m| m.text().contains("first handoff")));
    // A new handoff replaces it.
    let replaced = fresh_context_compact_messages(&ctx, &later, 50_000, &options(&valid_summary("second handoff"))).await.unwrap().messages;
    assert_eq!(summaries(&replaced), 1);
    assert!(replaced.iter().any(|m| m.text().contains("second handoff")));
    assert!(!replaced.iter().any(|m| m.text().contains("first handoff")), "stale details are not carried");
    assert_eq!(replaced.last().map(AgentMessage::text).as_deref(), Some("third request"));
}

#[tokio::test]
async fn a_transcript_that_already_fits_is_left_alone_unless_the_pass_is_forced() {
    fresh!(_meter, ctx, &NoAttachments);
    let messages = conversation();
    let not_forced = FreshOptions { force: false, ..options("") };
    let same = fresh_context_compact_messages(&ctx, &messages, 50_000, &not_forced).await.unwrap();
    assert!(!same.fresh_context);
    assert_eq!(same.messages, messages);
    let forced = fresh_context_compact_messages(&ctx, &messages, 50_000, &options("")).await.unwrap();
    assert!(forced.fresh_context);
}

#[tokio::test]
async fn older_tool_work_is_cut_as_whole_groups_newest_kept_and_the_cut_is_named_in_a_recovery_note() {
    fresh!(_meter, ctx, &NoAttachments);
    let mut messages = vec![system("rules"), AgentMessage::user("do the long job")];
    for n in 1..=30 {
        messages.extend(group(&format!("c{n}"), &"data ".repeat(600)));
    }
    // A 100,000-token window leaves 5,000 tokens for tool history: far less than thirty results.
    let result = fresh_context_compact_messages(&ctx, &messages, 50_000, &options(&valid_summary("job"))).await.unwrap();
    let out = &result.messages;
    let kept = call_ids(out);
    assert!(!kept.is_empty() && kept.len() < 30, "{kept:?}");
    assert_eq!(kept.last().map(String::as_str), Some("c30"), "the newest group is always kept");
    let first: usize = kept[0][1..].parse().unwrap();
    let expected: Vec<String> = (first..=30).map(|n| format!("c{n}")).collect();
    assert_eq!(kept, expected, "the cut falls once, at the oldest end");
    assert!(pairs_whole(out), "a call and its result are kept or cut together");
    let newest = out.iter().find(|m| m.tool_call_id() == Some("c30")).unwrap();
    assert_eq!(newest.text(), "data ".repeat(600), "the newest result is verbatim");
    let note = out.iter().find(|m| m.source == Some(Source::CompactExecutionRecovery)).expect("a recovery note");
    let text = note.text();
    assert!(text.contains("available at <DATA>/tool-results/s/") && text.contains("(sha256:"), "{text}");
    assert!(text.contains("not an instruction to repeat those calls"));
    assert!(out.iter().any(|m| m.text() == "do the long job"), "the request those calls served stays");
}

#[tokio::test]
async fn tool_arguments_that_look_like_secrets_are_redacted_in_what_is_kept() {
    fresh!(_meter, ctx, &NoAttachments);
    let mut messages = vec![AgentMessage::user("log in")];
    messages.push(AgentMessage::assistant(String::new(), vec![call("c1", "browser", json!({ "password": "hunter2", "url": "https://example.test" }))]));
    messages.push(AgentMessage::tool_text("c1", "ok", ToolKind::Normal));
    let result = fresh_context_compact_messages(&ctx, &messages, 50_000, &options(&valid_summary("login"))).await.unwrap();
    let kept = result.messages.iter().flat_map(|m| m.tool_calls()).next().expect("the call is kept");
    assert_eq!(kept.arguments, json!({ "password": "[redacted]", "url": "https://example.test" }));
}

#[tokio::test]
async fn a_call_without_a_result_gets_a_stub_result_and_a_result_without_a_call_is_dropped() {
    fresh!(_meter, ctx, &NoAttachments);
    let mut messages = vec![system("rules"), AgentMessage::user("go")];
    messages.push(AgentMessage::assistant(String::new(), vec![call("lost", "read", json!({}))]));
    messages.extend(group("c2", "two"));
    messages.push(AgentMessage::tool_text("orphan", "result of nothing", ToolKind::Normal));
    messages.push(AgentMessage::user("and now"));
    let result = fresh_context_compact_messages(&ctx, &messages, 50_000, &options(&valid_summary("go"))).await.unwrap();
    assert!(pairs_whole(&result.messages), "{:?}", texts(&result.messages));
    let stub = result.messages.iter().find(|m| m.tool_call_id() == Some("lost")).expect("the call stays paired");
    assert_eq!(stub.text(), "[Older tool result unavailable after context compaction]");
    assert!(!result_ids(&result.messages).contains(&"orphan".to_owned()));
}

#[tokio::test]
async fn a_latest_message_too_large_for_the_model_fails_with_the_size_it_needs() {
    fresh!(_meter, ctx, &NoAttachments);
    let messages = vec![system("rules"), AgentMessage::user("word ".repeat(40_000))];
    let Err(FreshError::LatestTurnExceeds(text)) = fresh_context_compact_messages(&ctx, &messages, 10_000, &options("")).await else { panic!("not refused") };
    assert!(text.contains(LATEST_TURN_EXCEEDS_CONTEXT), "{text}");
    assert!(text.contains("100,000-token window"), "{text}");
    assert!(text.contains("The latest message and protected session context"), "no attachments to blame: {text}");
}

#[tokio::test]
async fn a_handoff_too_large_for_the_budget_fails_instead_of_dropping_older_context() {
    fresh!(_meter, ctx, &NoAttachments);
    let huge = format!("{}\n{}", valid_summary("big"), "- detail ".repeat(20_000));
    let Err(error) = fresh_context_compact_messages(&ctx, &conversation(), 20_000, &options(&huge)).await else { panic!("accepted") };
    assert!(matches!(error, FreshError::Failed(_)));
    assert!(
        error.message().contains("complete handoff exceeds the compact budget") && error.message().contains("refusing to drop older context"),
        "{}",
        error.message()
    );
}

#[tokio::test]
async fn a_pass_with_no_budget_is_refused() {
    fresh!(_meter, ctx, &NoAttachments);
    let Err(error) = fresh_context_compact_messages(&ctx, &conversation(), 0, &options("")).await else { panic!("accepted") };
    assert!(error.message().contains("budgetTokens must be > 0"));
}

// ---- attachments across a rebuild --------------------------------------------------------------------------

/// A message whose text mentions ATTACHMENT carries a stored attachment worth 7,000 tokens; carried by
/// reference it is one short line.
struct Stored {
    referencable: bool,
}

#[async_trait]
impl AttachmentSeam for Stored {
    async fn reference_media(&self, message: &AgentMessage) -> AgentMessage {
        if !message.text().contains("ATTACHMENT") {
            return message.clone();
        }
        let mut out = message.clone();
        out.message.content = mixdog_core_api::domain::provider::Content::Text("[attachment by reference]".into());
        out
    }
    fn has_referencable_media(&self, message: &AgentMessage) -> bool {
        self.referencable && message.text().contains("ATTACHMENT")
    }
    fn attachment_tokens(&self, message: &AgentMessage) -> u64 {
        if message.text().contains("ATTACHMENT") { 7_000 } else { 0 }
    }
}

#[tokio::test]
async fn earlier_requests_travel_their_attachments_by_reference_and_the_latest_keeps_them_while_it_fits() {
    fresh!(_meter, ctx, &Stored { referencable: true });
    let messages =
        vec![AgentMessage::user("first ATTACHMENT inline"), AgentMessage::assistant("seen", Vec::new()), AgentMessage::user("second ATTACHMENT inline")];
    let kept = options("");
    let result = fresh_context_compact_messages(&ctx, &messages, 50_000, &kept).await.unwrap();
    assert_eq!(texts(&result.messages), ["[attachment by reference]", "seen", "second ATTACHMENT inline"], "only the earlier request is projected");
}

#[tokio::test]
async fn the_latest_requests_attachments_go_by_reference_when_they_are_what_does_not_fit_and_otherwise_the_error_names_them() {
    let latest = format!("ATTACHMENT {}", "word ".repeat(10_000));
    let messages = vec![AgentMessage::user("hello"), AgentMessage::assistant("hi", Vec::new()), AgentMessage::user(latest)];
    {
        fresh!(_meter, ctx, &Stored { referencable: true });
        let result = fresh_context_compact_messages(&ctx, &messages, 5_000, &options("")).await.expect("by reference it fits");
        assert_eq!(result.messages.last().map(AgentMessage::text).as_deref(), Some("[attachment by reference]"));
    }
    {
        fresh!(_meter, ctx, &Stored { referencable: false });
        let Err(FreshError::LatestTurnExceeds(text)) = fresh_context_compact_messages(&ctx, &messages, 5_000, &options("")).await else {
            panic!("not refused")
        };
        assert!(text.contains("Its attachments alone are about 7,000 tokens."), "{text}");
    }
}

// ---- the handoff summary run --------------------------------------------------------------------------------

struct Scripted {
    responses: Vec<String>,
    sent: Mutex<Vec<(String, String, String, Option<u64>)>>,
    stop: Option<StopReason>,
    tool_call: bool,
}

impl Scripted {
    fn answering(responses: Vec<String>) -> Self {
        Self { responses, sent: Mutex::new(Vec::new()), stop: Some(StopReason::EndTurn), tool_call: false }
    }
    fn prompts(&self) -> Vec<String> {
        self.sent.lock().unwrap().iter().map(|s| s.1.clone()).collect()
    }
}

#[async_trait]
impl SummarySender for Scripted {
    async fn send(&self, system: &str, prompt: &str, call: &SummaryCall) -> Result<SummaryResponse, SummaryFailure> {
        let mut sent = self.sent.lock().unwrap();
        let index = sent.len();
        sent.push((system.to_owned(), prompt.to_owned(), call.model.clone(), call.max_output_tokens));
        let text = self.responses.get(index).or(self.responses.last()).cloned().unwrap_or_default();
        Ok(SummaryResponse {
            text,
            tool_call: self.tool_call,
            stop: self.stop.clone(),
            usage: Some(Usage { input_tokens: 10, output_tokens: 5, cache_read_tokens: 1, cache_write_tokens: 2, ..Usage::default() }),
            input_excludes_cache: false,
        })
    }
}

struct Cancelled;
#[async_trait]
impl SummarySender for Cancelled {
    async fn send(&self, _: &str, _: &str, _: &SummaryCall) -> Result<SummaryResponse, SummaryFailure> {
        Err(SummaryFailure::Aborted)
    }
}

fn input<'a>(sender: &'a dyn SummarySender, input_budget_tokens: u64) -> HandoffInput<'a> {
    HandoffInput {
        sender,
        model: "opus",
        provider_name: Some("anthropic"),
        budget_tokens: 100_000,
        reserve_tokens: 0,
        input_budget_tokens,
        max_output_tokens: Some(4_096),
        fast: false,
    }
}

fn dialogue() -> Vec<AgentMessage> {
    vec![AgentMessage::user("fix the parser in src/lib.rs"), AgentMessage::assistant("working on it", Vec::new()), AgentMessage::user("now run the tests")]
}

#[tokio::test]
async fn a_short_conversation_is_summarised_in_one_call_and_a_complete_answer_is_kept_as_written() {
    fresh!(_meter, ctx, &NoAttachments);
    let sender = Scripted::answering(vec![format!("\n{}\n", valid_summary("one"))]);
    let got = generate_fresh_handoff_summary(&ctx, &dialogue(), &input(&sender, 0)).await.expect("summary");
    assert_eq!((got.calls, got.repaired), (1, false));
    assert_eq!(got.summary, valid_summary("one"));
    assert_eq!(got.stop, Some(StopReason::EndTurn));
    let usage = got.usage.expect("usage");
    assert_eq!((usage.input_tokens, usage.output_tokens, usage.cache_read_tokens, usage.cache_write_tokens), (10, 5, 1, 2));
    let sent = sender.sent.lock().unwrap();
    assert_eq!(sent[0].0, COMPACTION_SYSTEM_PROMPT);
    assert_eq!(sent[0].1, build_compaction_prompt(&dialogue(), None), "the whole history, in order, as the prompt");
    assert_eq!((sent[0].2.as_str(), sent[0].3), ("opus", Some(4_096)));
}

#[tokio::test]
async fn an_answer_missing_sections_is_repaired_into_the_required_structure() {
    fresh!(_meter, ctx, &NoAttachments);
    let sender = Scripted::answering(vec!["The parser was fixed in src/lib.rs.".to_owned()]);
    let got = generate_fresh_handoff_summary(&ctx, &dialogue(), &input(&sender, 0)).await.expect("summary");
    assert!(got.repaired);
    assert!(summary_is_schema_valid(&got.summary), "{}", got.summary);
    assert!(got.summary.contains("- The parser was fixed in src/lib.rs."), "what the model said is kept");
    assert!(got.summary.contains("## Goal\n- now run the tests"), "the goal comes from the latest request");
}

#[tokio::test]
async fn a_history_larger_than_one_call_is_summarised_in_batches_each_updating_the_running_summary() {
    fresh!(meter, ctx, &NoAttachments);
    let messages: Vec<AgentMessage> = (0..6)
        .map(|n| {
            if n % 2 == 0 {
                AgentMessage::user(format!("MARKER-{n} {}", "word ".repeat(240)))
            } else {
                AgentMessage::assistant(format!("MARKER-{n} {}", "word ".repeat(240)), Vec::new())
            }
        })
        .collect();
    // Room for the prompt of the first two messages and not of three.
    let mut system_message = AgentMessage::user(COMPACTION_SYSTEM_PROMPT);
    system_message.message.role = Role::System;
    let two = meter.messages(&[system_message, AgentMessage::user(build_compaction_prompt(&messages[..2], None))]);
    let budget = (two as f64 / 0.85).ceil() as u64 + 1;
    let sender = Scripted::answering((0..6).map(|n| valid_summary(&format!("step{n}"))).collect());
    let got = generate_fresh_handoff_summary(&ctx, &messages, &input(&sender, budget)).await.expect("summary");
    let prompts = sender.prompts();
    assert!(prompts.len() >= 3 && prompts.len() <= 6, "{}", prompts.len());
    assert_eq!(u64::from(got.calls), prompts.len() as u64);
    // Every message is summarised once, in order.
    let mut last = None;
    for n in 0..6 {
        let at: Vec<usize> = prompts.iter().enumerate().filter(|(_, p)| p.contains(&format!("MARKER-{n} "))).map(|(i, _)| i).collect();
        assert_eq!(at.len(), 1, "MARKER-{n} in calls {at:?}");
        assert!(last.is_none_or(|l| l <= at[0]));
        last = Some(at[0]);
    }
    // Each later call carries the summary the previous call wrote.
    assert!(!prompts[0].contains("<previous-summary>"));
    for (index, prompt) in prompts.iter().enumerate().skip(1) {
        assert!(prompt.contains(&format!("<previous-summary>\n{}\n</previous-summary>", valid_summary(&format!("step{}", index - 1)))), "call {index}");
    }
    assert_eq!(got.summary, valid_summary(&format!("step{}", prompts.len() - 1)), "the last call's answer is the summary");
    let usage = got.usage.unwrap();
    assert_eq!(usage.output_tokens, 5 * prompts.len() as u64, "every call's usage is summed");
}

#[tokio::test]
async fn a_refused_filtered_or_tool_call_summary_is_a_failed_compaction_never_a_repaired_summary() {
    fresh!(_meter, ctx, &NoAttachments);
    let complete = valid_summary("done");
    for (text, stop, tool_call, wants) in [
        (complete.clone(), StopReason::Other("content_filter".into()), false, "did not end naturally"),
        (String::new(), StopReason::Other("content_filter".into()), false, "did not end naturally"),
        (complete.clone(), StopReason::EndTurn, true, "the model answered with a tool call"),
        (String::new(), StopReason::EndTurn, false, "returned empty output"),
    ] {
        let sender = Scripted { responses: vec![text], sent: Mutex::new(Vec::new()), stop: Some(stop), tool_call };
        let error = generate_fresh_handoff_summary(&ctx, &dialogue(), &input(&sender, 0)).await.expect_err("rejected");
        assert!(format!("{error:?}").contains(wants), "{error:?}");
    }
}

/// A warm session whose fork answers `stop` with `text`.
struct WarmFork {
    text: String,
    stop: StopReason,
}

#[async_trait]
impl mixdog_agent::compact::summary_run::ForkSource for WarmFork {
    fn warm(&self) -> bool {
        true
    }
    fn request(&self) -> Option<mixdog_agent::compact::summary_run::ForkRequest> {
        Some(mixdog_agent::compact::summary_run::ForkRequest { provider_name: "p".into(), model: "m".into(), prompt_tokens: 10, shared_prefix_messages: 1 })
    }
    async fn send(&self, _: &mixdog_agent::compact::summary_run::SummaryRoute) -> Result<SummaryResponse, SummaryFailure> {
        Ok(SummaryResponse {
            text: self.text.clone(),
            tool_call: false,
            stop: Some(self.stop.clone()),
            usage: Some(Usage { input_tokens: 100, output_tokens: 7, ..Usage::default() }),
            input_excludes_cache: false,
        })
    }
}

struct OwnRoute(Arc<Scripted>);

#[async_trait]
impl mixdog_agent::compact::summary_run::RouteResolver for OwnRoute {
    async fn resolve(
        &self,
        step: mixdog_agent::compact::summary_run::RouteStep,
    ) -> Result<Option<mixdog_agent::compact::summary_run::SummaryRoute>, SummaryFailure> {
        Ok(Some(mixdog_agent::compact::summary_run::SummaryRoute {
            step,
            provider_name: "p".into(),
            model: "m".into(),
            context_window: 200_000,
            calibration: 1.0,
            fast: false,
            effort: None,
            sender: self.0.clone(),
        }))
    }
}

async fn plan_with_fork(
    fork: WarmFork,
    isolated: Arc<Scripted>,
) -> Result<(mixdog_agent::compact::summary_run::RouteStep, mixdog_agent::compact::summary_run::Generated), CompactError> {
    fresh!(_meter, ctx, &NoAttachments);
    let messages = dialogue();
    let resolver = OwnRoute(isolated);
    let cx = mixdog_agent::compact::summary_run::SummarizeContext {
        fresh: &ctx,
        fork: &fork,
        resolver: &resolver,
        reserve_tokens: 0,
        compact_budget_tokens: 100_000,
        hard_budget_tokens: 100_000,
        context_window: 200_000,
        conversation_input: &messages,
        timeout_ms: None,
    };
    mixdog_agent::compact::summary_run::summarize_on_plan(&cx, &[mixdog_agent::compact::summary_run::RouteStep::Session]).await
}

#[tokio::test]
async fn a_warm_fork_that_ends_otherwise_than_naturally_or_by_the_output_limit_still_fails_the_compaction() {
    // Whether the refused fork carried text or none, the denial is final: no isolated retry follows it.
    for text in [valid_summary("fork"), String::new()] {
        let isolated = Arc::new(Scripted::answering(vec![valid_summary("isolated")]));
        let error = plan_with_fork(WarmFork { text, stop: StopReason::Other("content_filter".into()) }, isolated.clone()).await.err().expect("fails");
        assert!(format!("{error:?}").contains("did not end naturally"), "{error:?}");
        assert!(isolated.prompts().is_empty());
    }
}

#[tokio::test]
async fn a_warm_fork_that_ended_naturally_with_no_text_still_falls_back_to_the_isolated_summary() {
    let isolated = Arc::new(Scripted::answering(vec![valid_summary("isolated")]));
    let (_, got) = plan_with_fork(WarmFork { text: String::new(), stop: StopReason::EndTurn }, isolated.clone()).await.expect("falls back");
    assert_eq!((got.mode, got.shared_prefix_fallback), ("isolated", Some("empty")));
    assert_eq!(isolated.prompts().len(), 1);
}

#[tokio::test]
async fn an_isolated_summary_cut_by_the_output_limit_keeps_its_text_repaired_and_its_stop_without_a_retry() {
    fresh!(_meter, ctx, &NoAttachments);
    let sender = Scripted {
        responses: vec!["The parser was fixed in src/lib.rs.".to_owned()],
        sent: Mutex::new(Vec::new()),
        stop: Some(StopReason::MaxTokens),
        tool_call: false,
    };
    let got = generate_fresh_handoff_summary(&ctx, &dialogue(), &input(&sender, 0)).await.expect("the extracted text is accepted");
    assert!(got.repaired);
    assert!(summary_is_schema_valid(&got.summary), "{}", got.summary);
    assert!(got.summary.contains("- The parser was fixed in src/lib.rs."), "{}", got.summary);
    assert_eq!(got.stop, Some(StopReason::MaxTokens), "the actual stop is kept");
    assert_eq!((got.calls, sender.prompts().len()), (1, 1), "a cut answer is not retried");
}

#[tokio::test]
async fn an_isolated_summary_cut_by_the_output_limit_with_no_text_fails_as_empty_output() {
    fresh!(_meter, ctx, &NoAttachments);
    let sender = Scripted { responses: vec![String::new()], sent: Mutex::new(Vec::new()), stop: Some(StopReason::MaxTokens), tool_call: false };
    let error = generate_fresh_handoff_summary(&ctx, &dialogue(), &input(&sender, 0)).await.expect_err("nothing to keep");
    assert!(format!("{error:?}").contains("returned empty output"), "{error:?}");
    assert_eq!(sender.prompts().len(), 1);
}

#[tokio::test]
async fn a_warm_fork_cut_by_the_output_limit_keeps_its_text_repaired_and_its_stop_without_an_isolated_retry() {
    let isolated = Arc::new(Scripted::answering(vec![valid_summary("isolated")]));
    let (_, got) =
        plan_with_fork(WarmFork { text: "The parser was fixed in src/lib.rs.".into(), stop: StopReason::MaxTokens }, isolated.clone()).await.expect("accepted");
    assert_eq!((got.mode, got.shared_prefix_fallback), ("shared-prefix", None));
    assert!(got.repaired);
    assert!(summary_is_schema_valid(&got.summary), "{}", got.summary);
    assert!(got.summary.contains("- The parser was fixed in src/lib.rs."), "{}", got.summary);
    assert_eq!(got.stop, Some(StopReason::MaxTokens));
    assert!(isolated.prompts().is_empty(), "no isolated request follows");
    let usage = got.usage.expect("usage");
    assert_eq!((usage.input_tokens, usage.output_tokens), (100, 7));
}

#[tokio::test]
async fn a_warm_fork_cut_by_the_output_limit_with_no_text_follows_the_empty_fallback() {
    let isolated = Arc::new(Scripted::answering(vec![valid_summary("isolated")]));
    let (_, got) = plan_with_fork(WarmFork { text: String::new(), stop: StopReason::MaxTokens }, isolated.clone()).await.expect("falls back");
    assert_eq!((got.mode, got.shared_prefix_fallback), ("isolated", Some("empty")));
    assert_eq!(got.summary, valid_summary("isolated"));
    assert_eq!(isolated.prompts().len(), 1);
    let usage = got.usage.expect("usage");
    assert_eq!((usage.input_tokens, usage.output_tokens), (110, 12), "the fork's usage is kept with the isolated call's");
}

#[tokio::test]
async fn a_cancelled_summary_call_is_a_cancellation_not_a_failure_and_an_empty_history_is_refused() {
    fresh!(_meter, ctx, &NoAttachments);
    let error = generate_fresh_handoff_summary(&ctx, &dialogue(), &input(&Cancelled, 0)).await.expect_err("aborted");
    assert!(matches!(error, SummaryFailure::Aborted));
    assert!(matches!(CompactError::from(error), CompactError::Aborted));
    let nothing = generate_fresh_handoff_summary(&ctx, &[system("rules")], &input(&Cancelled, 0)).await.expect_err("nothing to summarise");
    assert!(format!("{nothing:?}").contains("no compactable session history"), "{nothing:?}");
}

// ---- the compactor ---------------------------------------------------------------------------------------

struct Writes {
    text: String,
    delay_ms: u64,
}

#[async_trait]
impl HandoffSource for Writes {
    async fn triggered(&self, _: &[AgentMessage]) -> bool {
        !self.text.is_empty()
    }
    async fn handoff(&self, _: &[AgentMessage], _: u64) -> Result<Handoff, CompactError> {
        mixdog_rt::time::sleep(std::time::Duration::from_millis(self.delay_ms)).await;
        let usage = Usage { input_tokens: 10, output_tokens: 5, ..Usage::default() };
        Ok(Handoff { text: self.text.clone(), usage: Some(usage), input_excludes_cache: false, summary_ms: 33.0, route: None })
    }
}

fn compactor(summary: Option<Writes>) -> FreshCompactor {
    FreshCompactor {
        parts: Arc::new(FreshParts {
            media: Arc::new(TextOnly),
            replay_owner: replay_owner(),
            rows: Arc::new(Rows),
            archive: Arc::new(PreviewArchive { session: "s".into() }),
            attachments: Arc::new(NoAttachments),
            redactor: Arc::new(NoRedaction),
            blobs: Arc::new(NoBlobs),
            skills: None,
        }),
        triggers: None,
        summary: summary.map(|s| Arc::new(s) as Arc<dyn HandoffSource>),
        config: CompactorConfig { context_window: 100_000, ..CompactorConfig::default() },
    }
}

fn request(messages: &[AgentMessage], require_reduction: bool) -> CompactRequest<'_> {
    CompactRequest {
        messages,
        budget_tokens: 50_000,
        trigger: CompactTrigger::Auto,
        require_reduction,
        reference_latest_attachments: false,
        active_turn: false,
        latest_user_prefix: "",
    }
}

#[tokio::test]
async fn compaction_keeps_the_current_used_skill_and_retires_an_unavailable_load() {
    use mixdog_agent::compact::skills::{CurrentSkill, CurrentSkillResult, CurrentSkills};

    struct Skills;
    #[async_trait]
    impl CurrentSkills for Skills {
        async fn resolve(&self, name: &str, _: bool) -> Result<Option<CurrentSkill>, String> {
            Ok((name == "active").then(|| CurrentSkill {
                body: "<skill>\n<name>active</name>\ncurrent instructions\n</skill>".to_owned(),
                tools: Vec::new(),
                result: Some(CurrentSkillResult { summary: "Loaded skill: active".to_owned(), native: None }),
            }))
        }
    }

    let mut compactor = compactor(None);
    Arc::get_mut(&mut compactor.parts).unwrap().skills = Some(Arc::new(Skills));
    let mut unavailable = AgentMessage::tool_text("retired", "Loaded skill: retired", ToolKind::Normal);
    unavailable.message.native_tool_search = Some(json!({"provider": "openai", "toolReferences": ["retired-tool"], "openaiTools": []}));
    let messages = [
        system("Rules"),
        AgentMessage::user("Continue the task."),
        AgentMessage::sourced(Source::Skill, "<skill>\n<name>active</name>\nold instructions\n</skill>"),
        AgentMessage::assistant("", vec![call("retired", "skill_view", json!({"name": "retired"}))]),
        unavailable,
        AgentMessage::sourced(Source::Skill, "<skill>\n<name>retired</name>\nunavailable instructions\n</skill>"),
    ];
    let first = compactor.compact(request(&messages, false)).await.unwrap();
    let bodies = mixdog_agent::skill_update::latest_skill_bodies(&first.messages);
    assert_eq!(bodies.len(), 1);
    assert_eq!(bodies[0].body, "<skill>\n<name>active</name>\ncurrent instructions\n</skill>");
    let result = first.messages.iter().find(|m| m.tool_call_id() == Some("retired")).unwrap();
    assert!(result.text().contains("no longer available"));
    assert!(result.message.native_tool_search.is_none());

    let second = compactor.compact(request(&first.messages, false)).await.unwrap();
    assert!(mixdog_agent::skill_update::latest_skill_bodies(&second.messages).is_empty());
    assert!(second.messages.iter().any(|m| m.source == Some(Source::CompactSkillReload) && m.text().contains("\"active\"")));
}

#[tokio::test]
async fn restored_native_schemas_consume_skill_budget_and_reminders_do_not_activate_tools() {
    use mixdog_agent::compact::skills::{CurrentSkill, CurrentSkillResult, CurrentSkills};
    struct Skills(Mutex<Vec<String>>);
    #[async_trait]
    impl CurrentSkills for Skills {
        async fn resolve(&self, _: &str, _: bool) -> Result<Option<CurrentSkill>, String> {
            Ok(Some(CurrentSkill {
                body: "<skill>\n<name>alpha</name>\nUse the linked tool.\n</skill>".to_owned(),
                tools: vec!["linked".to_owned()],
                result: Some(CurrentSkillResult {
                    summary: "Loaded skill: alpha".to_owned(),
                    native: Some(json!({
                        "provider": "openai", "toolReferences": ["linked"],
                        "openaiTools": [{
                            "name": "linked", "type": "function", "defer_loading": true,
                            "description": "long schema documentation ".repeat(10_000)
                        }]
                    })),
                }),
            }))
        }
        async fn activate(&self, name: &str, _: &str) -> Result<(), String> {
            self.0.lock().unwrap().push(name.to_owned());
            Ok(())
        }
    }
    let skills = Arc::new(Skills(Mutex::new(Vec::new())));
    let mut compactor = compactor(None);
    Arc::get_mut(&mut compactor.parts).unwrap().skills = Some(skills.clone());
    let messages = [
        system("Rules"),
        AgentMessage::user("Continue the task."),
        AgentMessage::sourced(Source::Skill, "<skill>\n<name>alpha</name>\nUse the linked tool.\n</skill>"),
    ];
    let candidate = compactor.compact(request(&messages, true)).await.unwrap();
    assert!(candidate.skipped);
    let output = compactor.compact(request(&messages, false)).await.unwrap();
    assert!(output.messages.iter().any(|m| m.source == Some(Source::CompactSkillReload) && m.text().contains("\"alpha\"")));
    assert!(output.messages.iter().all(|m| m.message.native_tool_search.is_none()));
    compactor.adopted(&output.messages).await;
    assert!(skills.0.lock().unwrap().is_empty());

    // If the loader pair is mandatory, the same definition counts against the whole window.
    let retained = [
        messages[0].clone(),
        messages[1].clone(),
        AgentMessage::assistant("", vec![call("load", "Skill", json!({"name": "alpha"}))]),
        AgentMessage::tool_text("load", "Loaded skill: alpha", ToolKind::Normal),
        messages[2].clone(),
    ];
    let tight = CompactRequest { budget_tokens: 2_000, ..request(&retained, false) };
    assert!(compactor.compact(tight).await.is_err());
    assert!(skills.0.lock().unwrap().is_empty());
}

#[tokio::test]
async fn compaction_restores_missing_skill_schemas_once_across_retained_loads() {
    use mixdog_agent::compact::skills::{CurrentSkill, CurrentSkillResult, CurrentSkills};
    let native = json!({"provider": "openai", "toolReferences": ["read"], "openaiTools": [{"name": "read"}]});
    struct Skills(Value);
    #[async_trait]
    impl CurrentSkills for Skills {
        async fn resolve(&self, _: &str, _: bool) -> Result<Option<CurrentSkill>, String> {
            Ok(Some(CurrentSkill {
                body: "<skill>\n<name>alpha</name>\nInstructions.\n</skill>".to_owned(),
                tools: vec!["read".to_owned()],
                result: Some(CurrentSkillResult {
                    summary: "Loaded skill: alpha\nRequired tools unavailable: search".to_owned(),
                    native: Some(self.0.clone()),
                }),
            }))
        }
    }
    let mut compactor = compactor(None);
    Arc::get_mut(&mut compactor.parts).unwrap().skills = Some(Arc::new(Skills(native.clone())));
    let mut result = AgentMessage::tool_text("repeat", "Loaded skill: alpha", ToolKind::Normal);
    result.message.native_tool_search = Some(native.clone());
    let mut tool_load = AgentMessage::tool_text("load-tool", "Loaded read", ToolKind::Normal);
    tool_load.message.native_tool_search = Some(native.clone());
    let messages = [
        system("Rules"),
        AgentMessage::user("Continue the task."),
        AgentMessage::assistant("", vec![call("load", "Skill", json!({"name": "alpha"}))]),
        AgentMessage::tool_text("load", "Loaded skill: alpha", ToolKind::Normal),
        AgentMessage::assistant("", vec![call("repeat", "Skill", json!({"name": "alpha"}))]),
        result,
        AgentMessage::sourced(Source::Skill, "<skill>\n<name>alpha</name>\nInstructions.\n</skill>"),
        AgentMessage::assistant("", vec![call("load-tool", "load_tool", json!({"names": ["read"]}))]),
        tool_load,
    ];
    let output = compactor.compact(request(&messages, false)).await.unwrap();
    let updated = output.messages.iter().find(|m| m.tool_call_id() == Some("load")).unwrap();
    assert!(updated.text().contains("Required tools unavailable: search"));
    assert_eq!(updated.message.native_tool_search.as_ref(), Some(&native));
    let repeat = output.messages.iter().find(|m| m.tool_call_id() == Some("repeat")).unwrap();
    assert!(repeat.text().contains("Required tools unavailable: search"));
    assert!(repeat.message.native_tool_search.is_none(), "only the first retained load carries the schema");
    let explicit = output.messages.iter().find(|m| m.tool_call_id() == Some("load-tool")).unwrap();
    assert_eq!(explicit.text(), "Loaded read");
    assert!(explicit.message.native_tool_search.is_none(), "the restored Skill already provides the identical schema");
}

fn with_ids(messages: Vec<AgentMessage>) -> Vec<AgentMessage> {
    messages
        .into_iter()
        .enumerate()
        .map(|(n, mut m)| {
            m.message_id = Some(format!("m{n}"));
            m
        })
        .collect()
}

#[tokio::test]
async fn a_compaction_reports_the_summarys_usage_and_the_ids_that_left_the_context() {
    let messages = with_ids(conversation());
    let output = compactor(Some(Writes { text: valid_summary("g"), delay_ms: 0 })).compact(request(&messages, false)).await.expect("compacted");
    assert!(!output.skipped);
    assert_eq!(output.usage.map(|u| (u.input_tokens, u.output_tokens)), Some((10, 5)));
    assert_eq!(output.summary_ms, Some(33.0));
    assert_eq!(output.dropped_count, 2);
    let dropped = output.dropped.expect("the transcript showed those rows");
    assert_eq!(dropped.message_ids, ["m1", "m2"], "the old question and its answer left; the rest stayed");
    assert!(dropped.call_ids.is_empty());
}

#[tokio::test]
async fn a_required_reduction_that_the_summary_does_not_deliver_leaves_the_conversation_as_it_was() {
    let messages = vec![AgentMessage::user("hi"), AgentMessage::assistant("hello", Vec::new()), AgentMessage::user("thanks")];
    let output = compactor(Some(Writes { text: valid_summary("g"), delay_ms: 0 })).compact(request(&messages, true)).await.expect("no failure");
    assert!(output.skipped, "the rebuilt conversation is not smaller");
    assert_eq!(output.messages, messages);
    assert_eq!(output.dropped_count, 0);
    assert_eq!(output.usage.map(|u| u.output_tokens), Some(5), "the summary was still paid for");
}

#[tokio::test(start_paused = true)]
async fn the_pipeline_time_spans_the_summary_request_and_the_summary_time_is_the_requests_own() {
    let messages = conversation();
    let with_summary = compactor(Some(Writes { text: valid_summary("g"), delay_ms: 40 })).compact(request(&messages, false)).await.unwrap();
    assert_eq!(with_summary.summary_ms, Some(33.0), "reported by the summary request itself");
    assert_eq!(with_summary.pipeline_ms.fract(), 0.0, "whole milliseconds");
    assert!(with_summary.pipeline_ms >= 40.0, "the pipeline covers the request: {}", with_summary.pipeline_ms);
    let without = compactor(None).compact(request(&messages, false)).await.unwrap();
    assert_eq!(without.summary_ms, None);
    assert!(without.pipeline_ms < 40.0, "{}", without.pipeline_ms);
}

// ---- the pressure state across a compaction -------------------------------------------------------------

struct NoImages;
impl ImageIdentities for NoImages {
    fn images(&self, _: &AgentMessage) -> Vec<ImageDescriptor> {
        Vec::new()
    }
}

fn header(value: Value) -> Header {
    value.as_object().unwrap().clone()
}

#[test]
fn a_providers_reading_describes_only_the_prefix_it_was_taken_for_and_the_route_it_was_taken_on() {
    let owner = replay_owner();
    let meter = MessageMeter { media: &TextOnly, replay_owner: &owner };
    let signer = TranscriptSigner { meter: &meter, images: &NoImages, rows: &Rows };
    let books = Books { signer: &signer, native: &[], agent_mode: false, env: &compact_support::NoVars };
    let sent = [AgentMessage::user("the request")];
    let mut session = header(json!({ "provider": "openai", "model": "m", "contextWindow": 500_000, "compactBoundaryTokens": 500_000 }));
    let call =
        json!({ "source": "provider_send", "deltaInput": 300_000, "deltaOutput": 1_000, "deltaCachedRead": 0, "deltaCacheWrite": 0, "deltaPrompt": 300_000 });
    usage_change(&session, &call, &sent, &[], Some(&books), false, 1.0, 2.0).unwrap().apply(&mut session);
    let grown = [sent[0].clone(), AgentMessage::assistant("answer", Vec::new()), AgentMessage::user("next")];
    let reading = send_pressure(&session, &grown, &[], &books);
    let growth = meter.messages(&grown[1..]);
    let tokens = reading.tokens.expect("the reading prices the grown transcript");
    assert!(tokens >= 300_000 + growth, "the reading plus what was added since: {tokens}");
    assert_eq!(reading.reading, Some(300_000));
    // Another first message is another transcript: the reading no longer describes it.
    let edited = [AgentMessage::user("a different request"), grown[1].clone(), grown[2].clone()];
    assert_eq!(send_pressure(&session, &edited, &[], &books).tokens, None);
    // Another model is another route.
    session.insert("model".into(), json!("other"));
    assert_eq!(send_pressure(&session, &grown, &[], &books).tokens, None);
}

fn signed_checkpoint(signer: &TranscriptSigner<'_>, messages: &[AgentMessage], kind: Option<&str>) -> Value {
    let mut state = json!({
        "version": 1, "provider": "openai", "model": "m", "usedTokens": 80_000, "inputTokens": 79_000, "outputTokens": 1_000,
        "committedPrefixCount": 2, "turnMessageCount": 1,
        "committedPrefixSignature": signer.exact(&messages[..2]),
        "turnPrefixSignature": signer.exact(&messages[2..3]),
        "updatedAt": 5_000,
    });
    if let Some(kind) = kind {
        state["kind"] = json!(kind);
    }
    json!({ "contextState": state })
}

#[test]
fn a_restored_checkpoint_anchors_the_reading_only_to_the_transcript_it_was_saved_with() {
    let owner = replay_owner();
    let meter = MessageMeter { media: &TextOnly, replay_owner: &owner };
    let signer = TranscriptSigner { meter: &meter, images: &NoImages, rows: &Rows };
    let messages = [AgentMessage::user("one"), AgentMessage::assistant("two", Vec::new()), AgentMessage::user("three")];
    let session = header(json!({ "provider": "openai", "model": "m", "lastContextTokens": 1_234 }));
    let checkpoint = signed_checkpoint(&signer, &messages, None);
    let restored = restore_turn_checkpoint_context_state(&session, &messages, &checkpoint, &signer, 9_000.0);
    assert!(restored.anchored);
    let mut after = session.clone();
    restored.patch.apply(&mut after);
    assert_eq!(after["contextPressureBaselineTokens"], 80_000);
    assert_eq!(after["contextPressureBaselineMessageCount"], 3);
    assert_eq!(after["lastContextTokens"], 79_000, "the prompt the provider measured");
    assert_eq!(after["contextPressureBaselineSource"], "checkpoint_provider");
    assert_eq!(after["contextPressureBaselineUpdatedAt"], 5_000);

    // A transcript that is not the saved one leaves the retained reading marked unanchored.
    let changed = [messages[0].clone(), messages[1].clone(), AgentMessage::user("something else")];
    let restored = restore_turn_checkpoint_context_state(&session, &changed, &checkpoint, &signer, 9_000.0);
    assert!(!restored.anchored);
    let mut after = session.clone();
    restored.patch.apply(&mut after);
    assert_eq!(after["contextPressureUnanchoredAfterRestart"], true);
    // Another model's checkpoint is not this session's.
    let other = header(json!({ "provider": "openai", "model": "another" }));
    assert!(!restore_turn_checkpoint_context_state(&other, &messages, &checkpoint, &signer, 9_000.0).anchored);
}

#[test]
fn a_checkpoint_taken_right_after_a_compaction_restores_no_measured_prompt_and_keeps_its_snapshot() {
    let owner = replay_owner();
    let meter = MessageMeter { media: &TextOnly, replay_owner: &owner };
    let signer = TranscriptSigner { meter: &meter, images: &NoImages, rows: &Rows };
    let messages = [AgentMessage::user("one"), AgentMessage::assistant("two", Vec::new()), AgentMessage::user("three")];
    let mut checkpoint = signed_checkpoint(&signer, &messages, Some("post_compact"));
    checkpoint["contextState"]["usageSnapshot"] = json!({ "version": 1, "usageMetricsTurnId": "4", "usageMetricsEpoch": 2 });
    let session = header(json!({ "provider": "openai", "model": "m" }));
    let restored = restore_turn_checkpoint_context_state(&session, &messages, &checkpoint, &signer, 9_000.0);
    assert!(restored.anchored);
    let mut after = session.clone();
    restored.patch.apply(&mut after);
    assert_eq!(after["lastContextTokens"], 0, "no provider measured this prompt");
    assert_eq!(after["contextPressureBaselineSource"], "checkpoint_post_compact");
    assert_eq!(after["contextUsageSnapshot"]["usedTokens"], 80_000);
    assert_eq!((after["usageMetricsTurnId"].as_str(), after["usageMetricsEpoch"].as_u64()), (Some("4"), Some(2)));
}

#[test]
fn the_exact_signature_sees_every_change_and_the_shape_signature_survives_the_disk_round_trip() {
    let owner = replay_owner();
    let meter = MessageMeter { media: &TextOnly, replay_owner: &owner };
    let signer = TranscriptSigner { meter: &meter, images: &NoImages, rows: &Rows };
    let plain = [AgentMessage::user("a b"), AgentMessage::tool_text("c1", "out", ToolKind::Normal)];
    let spaced = [AgentMessage::user("a   b\n"), AgentMessage::tool_text("c1", "out", ToolKind::Normal)];
    let stored = [AgentMessage::user("a b [Image omitted from stored history: shot.png]"), AgentMessage::tool_text("c1", "out", ToolKind::Normal)];
    assert_ne!(signer.exact(&plain), signer.exact(&spaced));
    assert_eq!(signer.shape(&plain), signer.shape(&spaced), "whitespace does not survive the round trip");
    assert_ne!(signer.exact(&plain), signer.exact(&stored));
    let other_id = [AgentMessage::user("a b"), AgentMessage::tool_text("c2", "out", ToolKind::Normal)];
    assert_ne!(signer.shape(&plain), signer.shape(&other_id), "the call a result answers is part of it");
    assert_ne!(signer.exact(&plain[..1]), signer.exact(&plain), "a prefix is not the whole");
}

// ---- the commit -------------------------------------------------------------------------------------------

fn rows_of(messages: &[AgentMessage]) -> Vec<Value> {
    use mixdog_agent::compact::execution_tail::MessageRows;
    messages.iter().map(|m| Rows.row(m)).collect()
}

#[test]
fn a_committed_compaction_records_what_changed_and_what_it_cost_and_an_unchanged_one_does_not_count() {
    let owner = replay_owner();
    let meter = MessageMeter { media: &TextOnly, replay_owner: &owner };
    let signer = TranscriptSigner { meter: &meter, images: &NoImages, rows: &Rows };
    let session = header(
        json!({ "id": "s1", "provider": "openai", "model": "m", "contextWindow": 100_000, "compaction": { "mainBufferTokens": 30_000, "compactCount": 2 } }),
    );
    let before = conversation();
    let null = Value::Null;
    let status = StatusInput {
        session: &session,
        route: Route { provider: "openai", model: "m", context_window: Value::Null },
        cwd: Value::Null,
        mode: Value::Null,
        messages: &before,
        active: true,
        request_tools: RequestTools::default(),
        session_tools: RequestTools::default(),
        tool_breakdown: &null,
        agent_mode: false,
        meter: &meter,
        signer: &signer,
        env: &compact_support::NoVars,
    };
    let plan = compaction_plan(&status, false, true).unwrap().unwrap();
    let after = vec![before[0].clone(), AgentMessage::user("summary"), before[7].clone()];
    let appended = [AgentMessage::assistant("late reply", Vec::new())];
    let facts = SummaryFacts {
        fresh_context: true,
        handoff_source: Some("rules".into()),
        usage: Some(json!({ "inputTokens": 10, "outputTokens": 5 })),
        ..SummaryFacts::default()
    };
    let before_rows = rows_of(&before);
    let commit = |compacted_rows: &[Value], compacted: &[AgentMessage], appended: &[AgentMessage]| {
        commit_compaction(&CommitInput {
            status: &status,
            plan: &plan,
            auto_mode: false,
            now: 10_000.0,
            started_at: 9_000.0,
            commit_started_at: 9_900.0,
            committed_at: 10_000.0,
            fresh: &facts,
            before_rows: &before_rows,
            compacted_rows,
            compacted,
            appended,
            after_tools: RequestTools::default(),
            archived: Some(Archived { dropped: 5, identities: Some(json!({ "messageIds": ["m1"], "callIds": [] })) }),
        })
    };
    let changed = commit(&rows_of(&after), &after, &appended);
    assert!(changed.changed);
    assert_eq!(changed.result["changed"], true);
    assert_eq!(
        (changed.result["beforeMessages"].as_u64(), changed.result["afterMessages"].as_u64()),
        (Some(8), Some(4)),
        "late messages are kept after the compacted ones and counted"
    );
    assert_eq!(changed.result["droppedMessages"], 5);
    assert_eq!(changed.result["droppedIdentities"]["messageIds"], json!(["m1"]));
    assert_eq!(changed.result["handoffSource"], "rules");
    assert_eq!(changed.result["usage"]["outputTokens"], 5);
    assert_eq!(changed.after.messages, 4);
    assert_eq!(changed.after.message_tokens as u64, meter.messages(&after) + meter.messages(&appended));
    let record = &changed.compaction;
    assert_eq!(record["compactCount"], 3);
    assert_eq!((record["lastChanged"].as_bool(), record["lastChangedAt"].as_u64(), record["lastCompactAt"].as_u64()), (Some(true), Some(10_000), Some(10_000)));
    assert_eq!((record["lastDurationMs"].as_u64(), record["lastCommitMs"].as_u64()), (Some(1_000), Some(100)));
    assert_eq!(record["lastBeforeMessageTokens"], meter.messages(&before));

    // The same transcript back: nothing changed, nothing is counted and the reason is stated.
    let same = commit(&before_rows, &before, &[]);
    assert!(!same.changed);
    assert_eq!((same.result["changed"].as_bool(), same.result["reason"].as_str()), (Some(false), Some("nothing to compact")));
    assert_eq!(same.result["droppedMessages"], 0, "an unchanged transcript archives nothing");
    assert_eq!(same.compaction["compactCount"], 2);
}

#[test]
fn a_failed_compaction_keeps_the_transcript_and_records_why_under_the_stage_of_its_trigger() {
    let owner = replay_owner();
    let meter = MessageMeter { media: &TextOnly, replay_owner: &owner };
    let signer = TranscriptSigner { meter: &meter, images: &NoImages, rows: &Rows };
    let session = header(json!({ "id": "s1", "provider": "openai", "model": "m", "contextWindow": 100_000 }));
    let messages = conversation();
    let null = Value::Null;
    let status = StatusInput {
        session: &session,
        route: Route { provider: "openai", model: "m", context_window: Value::Null },
        cwd: Value::Null,
        mode: Value::Null,
        messages: &messages,
        active: true,
        request_tools: RequestTools::default(),
        session_tools: RequestTools::default(),
        tool_breakdown: &null,
        agent_mode: false,
        meter: &meter,
        signer: &signer,
        env: &compact_support::NoVars,
    };
    let plan = compaction_plan(&status, false, true).unwrap().unwrap();
    let manual = failed_compaction(&status, &plan, false, 500.0, "summary route unavailable", Some("fresh failed"));
    assert_eq!((manual.result["changed"].as_bool(), manual.result["error"].as_str()), (Some(false), Some("summary route unavailable")));
    assert_eq!(manual.result["afterMessages"], 8, "the transcript is as it was");
    assert_eq!(
        (manual.compaction["lastStage"].as_str(), manual.compaction["lastError"].as_str(), manual.compaction["lastFreshContextError"].as_str()),
        (Some("manual_failed"), Some("summary route unavailable"), Some("fresh failed"))
    );
    let automatic = failed_compaction(&status, &plan, true, 500.0, "x", None);
    assert_eq!(automatic.compaction["lastStage"], "post_turn_failed");
    assert_eq!(automatic.compaction["lastFreshContextError"], Value::Null);
}

#[test]
fn the_summarys_usage_joins_the_sessions_totals_by_the_providers_convention() {
    let session = header(json!({ "totalInputTokens": 100, "totalOutputTokens": 10, "totalCachedReadTokens": 5, "tokensCumulative": 110 }));
    let usage = json!({ "inputTokens": 40, "outputTokens": 6, "cachedTokens": 20, "cacheWriteTokens": 4 });
    let includes = usage_totals(&session, &usage, false);
    assert_eq!(
        (
            includes["totalInputTokens"].as_u64(),
            includes["totalOutputTokens"].as_u64(),
            includes["totalCachedReadTokens"].as_u64(),
            includes["totalCacheWriteTokens"].as_u64()
        ),
        (Some(140), Some(16), Some(25), Some(4))
    );
    assert_eq!(includes["totalUncachedInputTokens"], 16, "40 - 20 read - 4 written");
    assert_eq!(includes["tokensCumulative"], 156);
    let excludes = usage_totals(&session, &usage, true);
    assert_eq!(excludes["totalUncachedInputTokens"], 44, "input beside the cache, plus the writes");
}

// ---- images ----------------------------------------------------------------------------------------------

#[test]
fn an_image_is_shown_to_the_model_inside_a_box_and_a_tiny_one_is_lifted_to_the_floor() {
    assert_eq!(target_dimensions(1000, 800), (1000, 800, false), "a small image is left as it is");
    let (w, h, enlarged) = target_dimensions(3000, 2000);
    assert!(!enlarged && w <= 1568 && h <= 1568);
    assert!(u64::from(w.div_ceil(28)) * u64::from(h.div_ceil(28)) <= 1568, "no more than 1568 patches of 28 pixels: {w}x{h}");
    assert!(w > h, "the aspect is kept");
    assert_eq!(target_dimensions(100, 400), (200, 800, true), "a short edge under 200 is lifted, which allows enlarging");
    assert_eq!(target_dimensions(50, 2000), (39, 1568, false), "unless that would pass the long-edge limit");
}

#[test]
fn the_note_for_a_resized_image_gives_both_sizes_and_the_factor_to_map_coordinates_back() {
    let note = superseding_metadata_text(ImageSize { width: 3000, height: 2000 }, ImageSize { width: 1500, height: 1000 });
    assert!(note.starts_with("[Image: 3000x2000, displayed at 1500x1000. Multiply coordinates by 2.00 to map to the original image.]"), "{note}");
    assert!(note.ends_with("These display dimensions supersede any earlier display-size annotation for the following image."));
}

/// A decoder that accepts the bytes of `good` and rejects every other image.
struct Decodes {
    good: Vec<u8>,
    machine_down: bool,
}

#[async_trait]
impl ImageCodec for Decodes {
    async fn probe(&self, _: &[u8]) -> Result<ImageSize, CodecError> {
        panic!("a small image is never re-encoded")
    }
    async fn jpeg(&self, _: &[u8], _: u32, _: u32, _: bool, _: u8) -> Result<Encoded, CodecError> {
        panic!("a small image is never re-encoded")
    }
    async fn validate(&self, bytes: &[u8], _: &str) -> Result<(), CodecError> {
        if self.machine_down {
            Err(CodecError::Environment(None))
        } else if bytes == self.good {
            Ok(())
        } else {
            Err(CodecError::Invalid)
        }
    }
}

#[tokio::test]
async fn a_small_image_is_kept_whatever_the_decoder_says_of_it_and_never_replaced_by_text() {
    let good = vec![1u8, 2, 3, 4, 5, 6];
    let compactor = ToolImageCompactor::new(Arc::new(Decodes { good: good.clone(), machine_down: false }));
    let ok = STANDARD.encode(&good);
    let broken = STANDARD.encode([9u8, 9, 9]);
    let outcome = |data: &str, mime: &str| {
        let compactor = &compactor;
        let (data, mime) = (data.to_owned(), mime.to_owned());
        async move { compactor.compact(&data, &mime).await }
    };
    assert!(matches!(outcome(&ok, "image/png").await, ImageOutcome::Keep));
    assert!(matches!(outcome(&ok, "image/png; charset=binary").await, ImageOutcome::Keep), "parameters are not part of the type");
    assert!(matches!(outcome(&ok, "").await, ImageOutcome::Keep), "a missing type reads as png");
    // The attachment store judges the picture and a send names a refused one; the compactor drops nothing.
    assert!(matches!(outcome(&broken, "image/jpeg").await, ImageOutcome::Keep));
    assert!(matches!(outcome(&ok, "IMAGE/SVG+XML").await, ImageOutcome::Keep));
    assert!(matches!(outcome("", "image/png").await, ImageOutcome::Keep), "nothing to judge");
    let down = ToolImageCompactor::new(Arc::new(Decodes { good, machine_down: true }));
    assert!(matches!(down.compact(&broken, "image/png").await, ImageOutcome::Keep), "a machine failure says nothing of the image: it stays for a retry");
}

// ---- the display figures ----------------------------------------------------------------------------------

#[test]
fn a_call_that_reports_its_prompt_becomes_the_context_and_one_that_does_not_leaves_it_unknown() {
    let mut reading = ContextReading::default();
    let usage = Usage { input_tokens: 2, cache_read_tokens: 405_809, cache_write_tokens: 1_943, output_tokens: 7, ..Usage::default() };
    reading.measure(&usage, true);
    assert_eq!(reading.tokens, Some(407_754));
    assert_eq!(reading.display_before(1), 407_754);
    reading.measure(&Usage::default(), true);
    assert_eq!(reading.display_before(1), 1);
}
