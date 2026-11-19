//! Rule-only fresh-context compaction equals Node's `freshContextCompactMessages`.

use crate::compact_support;

use compact_support::NoAttachments;
use compact_support::PreviewArchive;
use compact_support::Rows;
use compact_support::node_message;
#[cfg(node_twin)]
use compact_support::node_row;
use compact_support::replay_owner;
use mixdog_agent::compact::estimate::MediaMeter;
use mixdog_agent::compact::estimate::MessageMeter;
use mixdog_agent::compact::estimate::PartMeter;
use mixdog_agent::compact::execution_tail::TailContext;
use mixdog_agent::compact::fresh::FreshContext;
use mixdog_agent::compact::fresh::FreshOptions;
use mixdog_agent::compact::fresh::fresh_context_compact_messages;
use mixdog_core_api::domain::provider::ContentPart;

struct TextOnly;
impl MediaMeter for TextOnly {
    fn part(&self, part: &ContentPart) -> PartMeter {
        panic!("media part in a text-only golden: {part:?}")
    }
}

#[cfg(node_twin)]
struct FixedHandoff(String);

#[tokio::test]
async fn fresh_context_matches_node_for_runtime_shaped_and_marked_requests() {
    use mixdog_agent::message_row::{message_of, row_of};
    use serde_json::json;

    let prefix = "<system-reminder>old runtime state</system-reminder>\n";
    let suffix = "\n<system-reminder>old agent list</system-reminder>";
    let provenance = json!({ "runtimeUserContext": { "prefix": prefix, "suffix": suffix }, "agentListing": ["worker"], "keep": true });
    let envelope = "<system-reminder>human-authored instruction</system-reminder>";
    let rows = vec![
        json!({ "role": "user", "content": format!("{prefix}first request{suffix}"), "meta": provenance }),
        json!({ "role": "user", "content": [
            { "type": "text", "text": prefix },
            { "type": "text", "text": "second request" },
            { "type": "text", "text": suffix }
        ], "meta": provenance }),
        json!({ "role": "user", "content": "stale provenance is not permission to trim", "meta": provenance }),
        json!({ "role": "user", "content": envelope }),
        json!({ "role": "user", "content": envelope, "meta": { "runtimeUserContext": { "prefix": envelope, "suffix": "" } } }),
        json!({ "role": "user", "content": envelope, "meta": { "source": "compact-context", "synthetic": true } }),
        json!({ "role": "user", "content": format!("{envelope}\nordinary instruction") }),
        json!({ "role": "user", "content": format!("{prefix}current request{suffix}"), "meta": provenance }),
    ];
    let messages: Vec<_> = rows.iter().map(|row| message_of(row).unwrap()).collect();
    let owner = replay_owner();
    let meter = MessageMeter { media: &TextOnly, replay_owner: &owner };
    let archive = PreviewArchive { session: "runtime-context".into() };
    let ctx = FreshContext {
        tail: TailContext { meter: &meter, rows: &Rows, archive: &archive, redactor: &compact_support::NoRedaction, preview: true },
        attachments: &NoAttachments,
    };
    let result = fresh_context_compact_messages(
        &ctx,
        &messages,
        100_000,
        &FreshOptions { force: true, context_window: 500_000, ..Default::default() },
    ).await.unwrap();
    let got: Vec<_> = result.messages.iter().map(row_of).collect();
    // Node's freshContextCompactMessages on these exact rows drops all three envelope-only
    // conversation turns; its unmarked mixed-content legacy request remains verbatim.
    assert_eq!(got, vec![
        json!({ "role": "user", "content": "first request", "meta": { "keep": true } }),
        json!({ "role": "user", "content": [{ "type": "text", "text": "second request" }], "meta": { "keep": true } }),
        rows[2].clone(), rows[6].clone(), rows[7].clone(),
    ]);
    assert!(meter.messages(&result.messages) < meter.messages(&messages));
}

#[cfg(node_twin)]
struct SlowHandoff;

/// Every file an execution dump writes (the dump and a large message's blob).
struct Written(std::sync::Mutex<Vec<String>>);
#[async_trait::async_trait]
impl mixdog_agent::offload::ArtifactStore for Written {
    async fn persist(&self, content: &str) -> Option<mixdog_agent::offload::Artifact> {
        self.0.lock().unwrap().push(content.to_owned());
        self.preview(content).await
    }
    async fn preview(&self, content: &str) -> Option<mixdog_agent::offload::Artifact> {
        let n = self.0.lock().unwrap().len();
        Some(mixdog_agent::offload::Artifact { display_path: format!("/art/{n}.txt"), path: format!("/art/{n}.txt"), lines: content.lines().count(), sha256: "ab".repeat(32) })
    }
}

/// A session that marked `482913` sensitive.
struct MarkedCode;
impl mixdog_agent::compact::dropped::Redactor for MarkedCode {
    fn redact(&self, rows: Vec<serde_json::Value>) -> Vec<serde_json::Value> {
        rows.into_iter()
            .map(|row| serde_json::from_str(&serde_json::to_string(&row).unwrap().replace("482913", "[redacted]")).unwrap())
            .collect()
    }
}

/// The dump and its blobs are written with the session's sensitive values redacted (Node
/// `buildExecutionTail` over `redactSensitiveMessages`); the transcript kept in context is not.
#[tokio::test]
async fn execution_dump_holds_sensitive_values_redacted() {
    use mixdog_agent::compact::execution_tail::{TailOptions, build_execution_tail};
    let owner = replay_owner();
    let meter = MessageMeter { media: &TextOnly, replay_owner: &owner };
    let written = Written(std::sync::Mutex::new(Vec::new()));
    let ctx = TailContext { meter: &meter, rows: &Rows, archive: &written, redactor: &MarkedCode, preview: false };
    let fill = serde_json::json!({ "action": "fill", "input": { "ref": "e1", "text": "482913", "sensitive": true } });
    let messages: Vec<_> = [
        serde_json::json!({ "role": "user", "content": "The portal mailed me 482913." }),
        serde_json::json!({ "role": "assistant", "content": "", "toolCalls": [{ "id": "f", "name": "browser", "arguments": fill }] }),
        serde_json::json!({ "role": "tool", "toolCallId": "f", "content": format!("Filled 482913\n{}", "page line\n".repeat(15_000)) }),
        serde_json::json!({ "role": "assistant", "content": "", "toolCalls": [{ "id": "r", "name": "read", "arguments": { "path": "a" } }] }),
        serde_json::json!({ "role": "tool", "toolCallId": "r", "content": "ok" }),
    ]
    .iter()
    .map(node_message)
    .collect();
    let out = build_execution_tail(&ctx, &messages, &TailOptions { context_window: 40_000, preserve_conversation: false }).await.expect("tail");
    let files = written.0.lock().unwrap().clone();
    assert!(files.len() >= 2, "the dump and the large result's blob: {}", files.len());
    for file in &files {
        assert!(!file.contains("482913"), "{file:.200}");
        assert!(file.contains("[redacted]") || file.contains("archivedMessage"), "{file:.200}");
    }
    assert!(out.messages.iter().any(|m| m.text().contains("482913") || m.tool_calls().iter().any(|c| c.arguments.to_string().contains("482913"))));
}

#[cfg(node_twin)]
#[async_trait::async_trait]
impl mixdog_agent::compact::compactor::HandoffSource for FixedHandoff {
    async fn triggered(&self, _: &[mixdog_agent::message::AgentMessage]) -> bool {
        !self.0.is_empty()
    }
    async fn handoff(
        &self,
        _: &[mixdog_agent::message::AgentMessage],
        _: u64,
    ) -> Result<mixdog_agent::compact::compactor::Handoff, mixdog_agent::env::CompactError> {
        Ok(mixdog_agent::compact::compactor::Handoff { text: self.0.clone(), usage: None, input_excludes_cache: false, summary_ms: 0.0, route: None })
    }
}
#[cfg(node_twin)]
#[async_trait::async_trait]
impl mixdog_agent::compact::compactor::HandoffSource for SlowHandoff {
    async fn triggered(&self, _: &[mixdog_agent::message::AgentMessage]) -> bool {
        true
    }
    async fn handoff(
        &self,
        _: &[mixdog_agent::message::AgentMessage],
        _: u64,
    ) -> Result<mixdog_agent::compact::compactor::Handoff, mixdog_agent::env::CompactError> {
        mixdog_rt::time::sleep(std::time::Duration::from_millis(40)).await;
        Ok(mixdog_agent::compact::compactor::Handoff { text: "handoff".into(), usage: None, input_excludes_cache: false, summary_ms: 33.0, route: None })
    }
}


#[cfg(node_twin)]
#[tokio::test]
async fn fresh_context_equals_node() {
    let golden = golden!("fresh");
    let session = golden["sessionId"].as_str().expect("session").to_owned();
    let owner = replay_owner();
    let meter = MessageMeter { media: &TextOnly, replay_owner: &owner };
    let archive = PreviewArchive { session };
    let ctx = FreshContext {
        tail: TailContext { meter: &meter, rows: &Rows, archive: &archive, redactor: &compact_support::NoRedaction, preview: true },
        attachments: &NoAttachments,
    };
    for scenario in golden["scenarios"].as_array().expect("scenarios") {
        let name = scenario["name"].as_str().expect("name");
        let o = &scenario["options"];
        let messages: Vec<_> = scenario["messages"].as_array().expect("messages").iter().map(node_message).collect();
        let options = FreshOptions {
            max_budget_tokens: o["maxBudgetTokens"].as_u64().unwrap_or(0),
            context_window: o["contextWindow"].as_u64().unwrap_or(0),
            handoff_text: o["handoffText"].as_str().unwrap_or_default().to_owned(),
            active_turn: o["activeTurn"].as_bool().unwrap_or(false),
            force: true,
            ..FreshOptions::default()
        };
        let result = fresh_context_compact_messages(&ctx, &messages, scenario["budget"].as_u64().expect("budget"), &options)
            .await
            .unwrap_or_else(|e| panic!("{name}: {e:?}"));
        let got: Vec<_> = result.messages.iter().map(node_row).collect();
        let want = scenario["result"].as_array().expect("result");
        assert_eq!(got.len(), want.len(), "{name}: message count\n{got:#?}");
        for (index, (g, w)) in got.iter().zip(want).enumerate() {
            assert_eq!(g, w, "{name}: message {index}");
        }
        assert_eq!(result.fresh_context, scenario["freshContext"].as_bool().expect("flag"), "{name}");
    }
}
#[cfg(node_twin)]
/// The loop's `Compactor` produces the same transcripts as the rebuild itself.
#[tokio::test]
async fn compactor_equals_node() {
    use mixdog_agent::compact::compactor::CompactorConfig;
    use mixdog_agent::compact::compactor::FreshCompactor;
    use mixdog_agent::compact::compactor::FreshParts;
    use mixdog_agent::env::CompactRequest;
    use mixdog_agent::env::CompactTrigger;
    use mixdog_agent::env::Compactor;
    use std::sync::Arc;

    let golden = golden!("fresh");
    let session = golden["sessionId"].as_str().expect("session").to_owned();
    for scenario in golden["scenarios"].as_array().expect("scenarios") {
        let name = scenario["name"].as_str().expect("name");
        let o = &scenario["options"];
        let messages: Vec<_> = scenario["messages"].as_array().expect("messages").iter().map(node_message).collect();
        let compactor = FreshCompactor {
            parts: Arc::new(FreshParts {
                media: Arc::new(TextOnly),
                replay_owner: replay_owner(),
                rows: Arc::new(Rows),
                archive: Arc::new(PreviewArchive { session: session.clone() }),
                attachments: Arc::new(NoAttachments),
                redactor: Arc::new(compact_support::NoRedaction),
                blobs: Arc::new(compact_support::NoBlobs),
                skills: None,
            }),
            triggers: None,
            summary: Some(Arc::new(FixedHandoff(o["handoffText"].as_str().unwrap_or_default().to_owned()))),
            config: CompactorConfig {
                max_budget_tokens: o["maxBudgetTokens"].as_u64().unwrap_or(0),
                context_window: o["contextWindow"].as_u64().unwrap_or(0),
                ..CompactorConfig::default()
            },
        };
        let output = compactor
            .compact(CompactRequest {
                messages: &messages,
                budget_tokens: scenario["budget"].as_u64().expect("budget"),
                trigger: CompactTrigger::Auto,
                require_reduction: false,
                reference_latest_attachments: false,
                active_turn: scenario["options"]["activeTurn"].as_bool().unwrap_or(false),
                latest_user_prefix: "",
            })
            .await
            .unwrap_or_else(|e| panic!("{name}: {e:?}"));
        let got: Vec<_> = output.messages.iter().map(node_row).collect();
        assert_eq!(&got, scenario["result"].as_array().expect("result"), "{name}");
    }
}
#[cfg(node_twin)]
/// `pipeline.totalMs` spans the summary decision, the summary and the rebuild (so it covers the summary request), whole
/// milliseconds; `generated.durationMs` is the summary request's own; a pass with no summary reports none and a pipeline of the
/// rebuild alone. Node's values are wall-clock times: the meaning is tested, never equal milliseconds.
#[tokio::test]
async fn the_pipeline_time_spans_the_summary_and_the_summary_time_is_its_own() {
    use mixdog_agent::compact::compactor::CompactorConfig;
    use mixdog_agent::compact::compactor::FreshCompactor;
    use mixdog_agent::compact::compactor::FreshParts;
    use mixdog_agent::env::CompactRequest;
    use mixdog_agent::env::CompactTrigger;
    use mixdog_agent::env::Compactor;
    use std::sync::Arc;

    let golden = golden!("fresh");
    let session = golden["sessionId"].as_str().expect("session").to_owned();
    let scenario = &golden["scenarios"].as_array().expect("scenarios")[0];
    let messages: Vec<_> = scenario["messages"].as_array().expect("messages").iter().map(node_message).collect();
    let o = &scenario["options"];
    for summarize in [true, false] {
        let compactor = FreshCompactor {
            parts: Arc::new(FreshParts {
                media: Arc::new(TextOnly),
                replay_owner: replay_owner(),
                rows: Arc::new(Rows),
                archive: Arc::new(PreviewArchive { session: session.clone() }),
                attachments: Arc::new(NoAttachments),
                redactor: Arc::new(compact_support::NoRedaction),
                blobs: Arc::new(compact_support::NoBlobs),
                skills: None,
            }),
            triggers: None,
            summary: summarize.then(|| Arc::new(SlowHandoff) as Arc<dyn mixdog_agent::compact::compactor::HandoffSource>),
            config: CompactorConfig {
                max_budget_tokens: o["maxBudgetTokens"].as_u64().unwrap_or(0),
                context_window: o["contextWindow"].as_u64().unwrap_or(0),
                ..CompactorConfig::default()
            },
        };
        let output = compactor
            .compact(CompactRequest {
                messages: &messages,
                budget_tokens: scenario["budget"].as_u64().expect("budget"),
                trigger: CompactTrigger::Auto,
                require_reduction: false,
                reference_latest_attachments: false,
                active_turn: scenario["options"]["activeTurn"].as_bool().unwrap_or(false),
                latest_user_prefix: "",
            })
            .await
            .expect("compact");
        assert_eq!(output.pipeline_ms.fract(), 0.0, "whole milliseconds");
        if summarize {
            assert_eq!(output.summary_ms, Some(33.0), "the summary request's own time");
            assert!(output.pipeline_ms >= 40.0, "the pipeline covers the summary request: {}", output.pipeline_ms);
        } else {
            assert_eq!(output.summary_ms, None);
            assert!(output.pipeline_ms < 40.0, "no summary request in the span: {}", output.pipeline_ms);
        }
    }
}

/// Regression (#343): a newest group no shrink level fits still compacts, as one reference to its
/// archived lines, written only after the archive; the reference leads back to the original calls and results.
#[tokio::test]
async fn a_wide_latest_group_compacts_to_one_reference_into_the_archive() {
    use mixdog_agent::compact::execution_tail::{TailOptions, build_execution_tail};
    let owner = replay_owner();
    let meter = MessageMeter { media: &TextOnly, replay_owner: &owner };
    let written = Written(std::sync::Mutex::new(Vec::new()));
    let ctx = TailContext { meter: &meter, rows: &Rows, archive: &written, redactor: &compact_support::NoRedaction, preview: false };
    let calls: Vec<_> = (0..40).map(|i| serde_json::json!({ "id": format!("c{i}"), "name": "read", "arguments": { "path": format!("file-{i}") } })).collect();
    let mut rows = vec![
        serde_json::json!({ "role": "user", "content": "go" }),
        serde_json::json!({ "role": "assistant", "content": "reading everything", "toolCalls": calls }),
    ];
    rows.extend((0..40).map(|i| serde_json::json!({ "role": "tool", "toolCallId": format!("c{i}"), "content": format!("result-{i} {}", "x".repeat(400)) })));
    let messages: Vec<_> = rows.iter().map(node_message).collect();
    let options = TailOptions { context_window: 40_000, preserve_conversation: false };
    let out = build_execution_tail(&ctx, &messages, &options).await.expect("a wide latest group must still compact");
    assert_eq!(out.retained_groups, 1);
    assert!(out.messages.iter().all(|m| m.tool_calls().is_empty()), "the stand-in holds no call of its own");
    let reference = out.messages.iter().map(|m| m.text()).find(|t| t.contains("archived without interpretation")).expect("the reference");
    let path = reference.split(" at ").nth(1).unwrap().split(" (sha256").next().unwrap();
    let range = reference.split("lines ").nth(1).unwrap().split('.').next().unwrap();
    let (first, last) = range.split_once('-').unwrap();
    let (first, last): (usize, usize) = (first.parse().unwrap(), last.parse().unwrap());
    let files = written.0.lock().unwrap().clone();
    let dump = &files[path.trim_start_matches("/art/").trim_end_matches(".txt").parse::<usize>().unwrap() - 1];
    let lines: Vec<&str> = dump.lines().collect();
    let group = lines[first - 1..last].join("\n");
    for i in 0..40 {
        assert!(group.contains(&format!("file-{i}")) && group.contains(&format!("result-{i} ")), "call {i} resolves from the reference");
    }
    assert!(group.contains("reading everything"), "the assistant's text is in the archive too");
}

fn wire_of(messages: &[mixdog_agent::message::AgentMessage]) -> serde_json::Value {
    use mixdog_ai::providers::anthropic::{AnthropicCodec, AnthropicConfig, Flavor};
    use mixdog_core_api::domain::provider::{ModelRequest, RequestOptions, WireCodec};
    let codec = AnthropicCodec::new(Flavor::ApiKey, AnthropicConfig::new(std::sync::Arc::new(|_: &str| None)));
    let request = ModelRequest {
        model: "claude-sonnet-4-6".into(),
        messages: messages.iter().map(|m| m.message.clone()).collect(),
        tools: Vec::new(),
        options: RequestOptions::default(),
    };
    serde_json::from_slice(&codec.encode(&request).expect("encodes").body).expect("a JSON body")
}

/// Compacts `rows` with the active-turn continuation, as a running turn's Compact does.
async fn compact_active_turn(rows: &[serde_json::Value], context_window: u64) -> Vec<mixdog_agent::message::AgentMessage> {
    compact_active_turn_with(rows, FreshOptions { context_window, ..Default::default() }).await
}

/// [`compact_active_turn`] with `options` (the stored rows are read as the transcript reads them).
async fn compact_active_turn_with(rows: &[serde_json::Value], options: FreshOptions) -> Vec<mixdog_agent::message::AgentMessage> {
    let messages: Vec<_> = rows.iter().map(|row| mixdog_agent::message_row::message_of(row).unwrap()).collect();
    let owner = replay_owner();
    let meter = MessageMeter { media: &TextOnly, replay_owner: &owner };
    let archive = PreviewArchive { session: "thinking".into() };
    let ctx = FreshContext {
        tail: TailContext { meter: &meter, rows: &Rows, archive: &archive, redactor: &compact_support::NoRedaction, preview: true },
        attachments: &NoAttachments,
    };
    fresh_context_compact_messages(&ctx, &messages, 100_000, &FreshOptions { force: true, active_turn: true, ..options })
        .await
        .unwrap()
        .messages
}

/// An Anthropic tool step as the response records it: its thinking only in the provider replay.
fn anthropic_step(id: &str, thinking: bool) -> serde_json::Value {
    let call = serde_json::json!({ "id": id, "name": "read", "arguments": { "path": id } });
    let mut items = Vec::new();
    if thinking {
        items.push(serde_json::json!({ "type": "thinking", "thinking": "t", "signature": "sig" }));
    }
    items.push(serde_json::json!({ "type": "tool_use", "id": id, "name": "read", "input": { "path": id } }));
    serde_json::json!({ "role": "assistant", "content": "", "toolCalls": [call], "providerReplay": { "provider": "anthropic", "items": items } })
}

fn signed_round() -> Vec<serde_json::Value> {
    vec![
        serde_json::json!({ "role": "user", "content": "go" }),
        // Only the earlier step of the open round carries thinking.
        anthropic_step("a", true),
        serde_json::json!({ "role": "tool", "toolCallId": "a", "content": "first" }),
        anthropic_step("b", false),
        serde_json::json!({ "role": "tool", "toolCallId": "b", "content": "second" }),
    ]
}

/// Regression (#371): the Goal context Compact prepends to the latest request comes after the tail is
/// assembled; the signed step after it is still bound to the old text, so the request carries no
/// signature and the round is ended.
#[tokio::test]
async fn a_goal_prefix_on_the_latest_request_rebinds_the_thinking_after_it() {
    let rows = vec![
        serde_json::json!({ "role": "user", "content": "go" }),
        anthropic_step("a", true),
        serde_json::json!({ "role": "tool", "toolCallId": "a", "content": "first" }),
    ];
    let options = FreshOptions { context_window: 500_000, latest_user_prefix: "<system-reminder>\n<goal_state>ship it</goal_state>\n</system-reminder>".into(), ..Default::default() };
    let body = wire_of(&compact_active_turn_with(&rows, options).await);
    assert!(body.to_string().contains("goal_state"), "{body}");
    assert!(!body.to_string().contains("signature"), "{body}");
    let roles: Vec<&str> = body["messages"].as_array().unwrap().iter().map(|m| m["role"].as_str().unwrap()).collect();
    assert_eq!(roles, ["user", "assistant", "user", "assistant", "user"], "{body}");
    assert_eq!(body["messages"][3]["content"], ".", "{body}");
    assert_pairs(&body);
}

/// Regression (#371): Compact drops a closed turn's replay (here a native web search result) without
/// touching its text; the replay reached the wire, so the signed step after it is bound to a changed
/// prefix and the round is ended.
#[tokio::test]
async fn a_closed_turn_that_loses_its_replay_rebinds_the_thinking_after_it() {
    let searched = serde_json::json!({ "role": "assistant", "content": "found", "providerReplay": { "provider": "anthropic", "items": [
        { "type": "server_tool_use", "id": "srvtoolu_1", "name": "web_search", "input": { "query": "x" } },
        { "type": "web_search_tool_result", "tool_use_id": "srvtoolu_1", "content": [] },
        { "type": "text", "text": "found" }
    ] } });
    let rows = vec![
        serde_json::json!({ "role": "user", "content": "search" }),
        searched,
        serde_json::json!({ "role": "user", "content": "go" }),
        anthropic_step("a", true),
        serde_json::json!({ "role": "tool", "toolCallId": "a", "content": "first" }),
    ];
    let body = wire_of(&compact_active_turn(&rows, 500_000).await);
    assert!(!body.to_string().contains("web_search_tool_result"), "the closed turn's replay was dropped: {body}");
    assert!(!body.to_string().contains("signature"), "{body}");
    let sent = body["messages"].as_array().unwrap();
    assert_eq!(sent[sent.len() - 2]["content"], ".", "the round is ended: {body}");
    assert_pairs(&body);
}

/// Regression (#371): the open round's only signed step is omitted from the tail (its arguments do
/// not fit the budget); the unsigned newest step survives, and the round is still ended.
#[tokio::test]
async fn an_omitted_signed_step_ends_the_open_round() {
    let mut rows = signed_round();
    let wide = "x".repeat(40_000);
    rows[1]["toolCalls"][0]["arguments"]["path"] = serde_json::json!(wide);
    rows[1]["providerReplay"]["items"][1]["input"]["path"] = serde_json::json!(wide);
    let compacted = compact_active_turn(&rows, 40_000).await;
    assert!(compacted.iter().all(|m| m.tool_calls().iter().all(|c| c.id != "a")), "the signed step is omitted");
    let body = wire_of(&compacted);
    assert!(!body.to_string().contains("signature"), "{body}");
    let sent = body["messages"].as_array().unwrap();
    assert_eq!(sent[sent.len() - 2]["content"], ".", "the round is ended: {body}");
    assert_pairs(&body);
}

/// Regression (#343): in a 4,096-token window the recovery reminder and a reference to the latest
/// group do not both fit the tool-history budget; the reminder names the group's archived lines
/// itself, and they lead back to the original calls and results.
#[tokio::test]
async fn a_wide_latest_group_compacts_in_a_window_too_small_for_two_notices() {
    use mixdog_agent::compact::execution_tail::{TailOptions, build_execution_tail, tool_history_budget};
    let owner = replay_owner();
    let meter = MessageMeter { media: &TextOnly, replay_owner: &owner };
    let written = Written(std::sync::Mutex::new(Vec::new()));
    let ctx = TailContext { meter: &meter, rows: &Rows, archive: &written, redactor: &compact_support::NoRedaction, preview: false };
    let calls: Vec<_> = (0..40).map(|i| serde_json::json!({ "id": format!("c{i}"), "name": "read", "arguments": { "path": format!("file-{i}") } })).collect();
    let mut rows = vec![
        serde_json::json!({ "role": "user", "content": "go" }),
        serde_json::json!({ "role": "assistant", "content": "", "toolCalls": calls }),
    ];
    rows.extend((0..40).map(|i| serde_json::json!({ "role": "tool", "toolCallId": format!("c{i}"), "content": format!("result-{i}") })));
    let messages: Vec<_> = rows.iter().map(node_message).collect();
    let out = build_execution_tail(&ctx, &messages, &TailOptions { context_window: 4_096, preserve_conversation: false })
        .await
        .expect("a wide latest group must compact in any window");
    assert!(out.tool_tokens <= tool_history_budget(4_096), "{} tokens", out.tool_tokens);
    assert_eq!(out.retained_groups, 1);
    assert!(out.messages.iter().all(|m| m.tool_calls().is_empty() && m.role() != mixdog_core_api::domain::provider::Role::Tool));
    let reminder = out.messages.iter().map(|m| m.text()).find(|t| t.contains("The latest execution group")).expect("the named range");
    assert!(!out.messages.iter().any(|m| m.text().contains("archived without interpretation")), "one notice only");
    let path = reminder.split("available at ").nth(1).unwrap().split(" (sha256").next().unwrap();
    let range = reminder.split("is on lines ").nth(1).unwrap().split('.').next().unwrap();
    let (first, last) = range.split_once('-').unwrap();
    let (first, last): (usize, usize) = (first.parse().unwrap(), last.parse().unwrap());
    let files = written.0.lock().unwrap().clone();
    let dump = &files[path.trim_start_matches("/art/").trim_end_matches(".txt").parse::<usize>().unwrap() - 1];
    let group: Vec<&str> = dump.lines().collect::<Vec<_>>()[first - 1..last].to_vec();
    for i in 0..40 {
        assert!(group.iter().any(|l| l.contains(&format!("\"file-{i}\""))) && group.iter().any(|l| l.contains(&format!("\"result-{i}\""))), "call {i} resolves");
    }
}

fn assert_pairs(body: &serde_json::Value) {
    let sent = body["messages"].as_array().unwrap();
    for (i, message) in sent.iter().enumerate() {
        for block in message["content"].as_array().into_iter().flatten().filter(|b| b["type"] == "tool_use") {
            let next = sent.get(i + 1).unwrap_or_else(|| panic!("a tool use ends the request: {body}"));
            assert!(
                next["content"].as_array().unwrap().iter().any(|b| b["type"] == "tool_result" && b["tool_use_id"] == block["id"]),
                "tool use {} meets its result: {body}",
                block["id"]
            );
        }
    }
}

/// Regression (#371): once Compact rewrites the prefix the signatures were bound to, the request carries no
/// signed thinking and the open round is ended before the user's continuation.
#[tokio::test]
async fn a_compacted_round_with_signed_thinking_is_a_request_anthropic_accepts() {
    let mut rows = signed_round();
    // The earlier step's result is large, so the execution is archived and the prefix is rewritten.
    rows[2]["content"] = serde_json::json!("first ".repeat(20_000));
    let compacted = compact_active_turn(&rows, 40_000).await;
    let body = wire_of(&compacted);
    assert!(!body.to_string().contains("signature"), "{body}");
    let roles: Vec<&str> = body["messages"].as_array().unwrap().iter().map(|m| m["role"].as_str().unwrap()).collect();
    assert_eq!(roles, ["user", "user", "assistant", "user", "assistant", "user", "assistant", "user"], "{body}");
    assert_eq!(body["messages"][6]["content"], ".", "{body}");
    assert_pairs(&body);
}

/// The prefix a compaction leaves as it was keeps its thinking, and nothing is ended or added.
#[tokio::test]
async fn a_compaction_that_keeps_the_prefix_keeps_signed_thinking() {
    let compacted = compact_active_turn(&signed_round(), 500_000).await;
    let body = wire_of(&compacted);
    assert!(body.to_string().contains("\"signature\":\"sig\""), "{body}");
    assert!(!body.to_string().contains("\"content\":\".\""), "no round was ended: {body}");
    assert_pairs(&body);
}

/// Another provider's recorded replay is not Anthropic thinking: it compacts exactly as before.
#[tokio::test]
async fn another_providers_replay_is_left_as_recorded() {
    use mixdog_agent::compact::execution_tail::{TailOptions, build_execution_tail};
    let owner = replay_owner();
    let meter = MessageMeter { media: &TextOnly, replay_owner: &owner };
    let written = Written(std::sync::Mutex::new(Vec::new()));
    let ctx = TailContext { meter: &meter, rows: &Rows, archive: &written, redactor: &compact_support::NoRedaction, preview: true };
    let parts = serde_json::json!({ "items": [{ "functionCall": { "name": "read", "args": { "path": "a" } } }] });
    let messages: Vec<_> = [
        serde_json::json!({ "role": "user", "content": "go" }),
        serde_json::json!({ "role": "assistant", "content": "", "toolCalls": [{ "id": "a", "name": "read", "arguments": { "path": "a" } }], "providerReplay": parts }),
        serde_json::json!({ "role": "tool", "toolCallId": "a", "content": "ok" }),
    ]
    .iter()
    .map(node_message)
    .collect();
    let out = build_execution_tail(&ctx, &messages, &TailOptions { context_window: 200_000, preserve_conversation: false }).await.expect("tail");
    assert_eq!(out.messages.len(), 3, "no ack was added");
    assert_eq!(out.messages[1].message.provider_replay().len(), 1, "the recorded function-call parts stay");
}